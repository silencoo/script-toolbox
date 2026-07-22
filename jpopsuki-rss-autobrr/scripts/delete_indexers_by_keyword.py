#!/usr/bin/env python3
import os
import sys
import re
from typing import Any, Dict, List

import requests

"""
Delete feeds (indexers) whose name matches keywords listed in keyword.txt.

Env vars:
- AUTO_BRR_BASE    (default: http://localhost:7474)
- AUTO_BRR_COOKIE  (required, including for DRY_RUN reads)
- KEYWORD_FILE     (default: data/keywords.txt) file with one keyword per line
- REGEX            (default: false) if true, interpret each line as regex
- DRY_RUN          (default: false) print only, no deletions
"""


def make_session(base_url: str, cookie_header: str) -> requests.Session:
    s = requests.Session()
    s.headers.update({
        'Accept': '*/*',
        'Content-Type': 'application/json',
        'x-requested-with': 'XMLHttpRequest',
        'User-Agent': 'autobrr-delete-indexers/1.0',
        'Cookie': cookie_header,
    })
    s.base_url = base_url.rstrip('/')
    return s


def get_indexers(s: requests.Session) -> List[Dict[str, Any]]:
    url = s.base_url + '/api/indexer'
    r = s.get(url)
    print(r.text)
    r.raise_for_status()
    return r.json()


def delete_indexer(s: requests.Session, indexer_id: int, dry_run: bool) -> None:
    url = s.base_url + f'/api/indexer/{indexer_id}'
    if dry_run:
        print(f'[DRY RUN] DELETE {url}')
        return
    r = s.delete(url)
    r.raise_for_status()


def main() -> None:
    base_url = os.environ.get('AUTO_BRR_BASE', 'http://localhost:7474')
    cookie_header = os.environ.get('AUTO_BRR_COOKIE', '').strip()
    keyword_file = os.environ.get('KEYWORD_FILE', os.path.join(os.path.dirname(os.path.dirname(__file__)), 'data', 'keywords.txt'))
    use_regex = os.environ.get('REGEX', 'false').lower() in ('1', 'true', 'yes')
    dry_run = os.environ.get('DRY_RUN', 'false').lower() in ('1', 'true', 'yes')

    try:
        with open(keyword_file, 'r', encoding='utf-8') as f:
            keywords = [line.strip() for line in f if line.strip()]
    except Exception as e:
        print(f'ERROR: Failed to read keyword file: {keyword_file}: {e}')
        sys.exit(1)

    if not keywords:
        print('ERROR: No keywords found in keyword file.')
        sys.exit(1)
    if not cookie_header:
        print('ERROR: AUTO_BRR_COOKIE is required, including for DRY_RUN reads.')
        sys.exit(1)

    session = make_session(base_url, cookie_header)
    print(f'Config: BASE={base_url} KEYWORD_FILE={keyword_file} count={len(keywords)} REGEX={use_regex} DRY_RUN={dry_run}')

    try:
        feeds = get_indexers(session)
    except Exception as e:
        print(f'ERROR fetching indexers: {e}')
        sys.exit(1)

    to_delete = []
    if use_regex:
        patterns = [re.compile(pat, flags=re.IGNORECASE) for pat in keywords]
        for f in feeds:
            name = str(f.get('name', ''))
            if any(p.search(name) for p in patterns):
                to_delete.append(int(f.get('id', 0)))
    else:
        lowers = [kw.lower() for kw in keywords]
        for f in feeds:
            name = str(f.get('name', ''))
            lname = name.lower()
            if any(kw in lname for kw in lowers):
                to_delete.append(int(f.get('id', 0)))

    print(f'Found {len(to_delete)} indexers to delete.')
    for iid in to_delete:
        print(f'- Deleting id={iid}')
        try:
            delete_indexer(session, iid, dry_run)
        except Exception as e:
            print(f'  FAILED to delete indexer {iid}: {e}')


if __name__ == '__main__':
    main()
