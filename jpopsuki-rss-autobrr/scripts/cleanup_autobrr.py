#!/usr/bin/env python3
import os
import sys
import json
from typing import Any, Dict, List

import requests

"""
Cleanup script for autobrr:
- Delete filters whose indexers array is empty
- Delete indexers (feeds) that are disabled (enabled == false)

Environment variables:
- AUTO_BRR_BASE    (default: http://localhost:7474)
- AUTO_BRR_COOKIE  (required; Cookie header string)
- DRY_RUN          (default: false) if true, only prints planned deletions

Endpoints used:
- GET  /api/filters         -> list filters
- DELETE /api/filters/{id}  -> delete filter
- GET  /api/feeds           -> list indexers (feeds)
- DELETE /api/feeds/{id}    -> delete indexer
"""


def make_session(base_url: str, cookie_header: str) -> requests.Session:
    s = requests.Session()
    s.headers.update({
        'Accept': '*/*',
        'Content-Type': 'application/json',
        'x-requested-with': 'XMLHttpRequest',
        'User-Agent': 'autobrr-cleanup-script/1.0',
        'Cookie': cookie_header,
    })
    s.base_url = base_url.rstrip('/')
    return s


def get_filters(s: requests.Session) -> List[Dict[str, Any]]:
    url = s.base_url + '/api/filters'
    r = s.get(url)
    r.raise_for_status()
    return r.json()


def get_indexers(s: requests.Session) -> List[Dict[str, Any]]:
    url = s.base_url + '/api/feeds'
    r = s.get(url)
    r.raise_for_status()
    return r.json()


def delete_filter(s: requests.Session, filter_id: int, dry_run: bool) -> None:
    url = s.base_url + f'/api/filters/{filter_id}'
    if dry_run:
        print(f'[DRY RUN] DELETE {url}')
        return
    r = s.delete(url)
    r.raise_for_status()


def delete_indexer(s: requests.Session, indexer_id: int, dry_run: bool) -> None:
    url = s.base_url + f'/api/feeds/{indexer_id}'
    if dry_run:
        print(f'[DRY RUN] DELETE {url}')
        return
    r = s.delete(url)
    r.raise_for_status()


def main() -> None:
    base_url = os.environ.get('AUTO_BRR_BASE', 'http://localhost:7474')
    cookie_header = os.environ.get('AUTO_BRR_COOKIE', '').strip()
    dry_run = os.environ.get('DRY_RUN', 'false').lower() in ('1', 'true', 'yes')

    if not cookie_header:
        print('ERROR: AUTO_BRR_COOKIE is required, including for DRY_RUN reads.')
        sys.exit(1)

    session = make_session(base_url, cookie_header)

    # 1) Filters: delete those with empty indexers
    try:
        filters = get_filters(session)
    except Exception as e:
        print(f'ERROR fetching filters: {e}')
        sys.exit(1)

    to_delete_filters: List[int] = []
    for f in filters:
        idxs = f.get('indexers', [])
        if isinstance(idxs, list) and len(idxs) == 0:
            to_delete_filters.append(int(f.get('id', 0)))

    print(f'Found {len(to_delete_filters)} filters with empty indexers.')
    for fid in to_delete_filters:
        print(f'- Deleting filter id={fid}')
        try:
            delete_filter(session, fid, dry_run)
        except Exception as e:
            print(f'  FAILED to delete filter {fid}: {e}')

    # 2) Indexers: delete those disabled
    try:
        indexers = get_indexers(session)
    except Exception as e:
        print(f'ERROR fetching indexers: {e}')
        sys.exit(1)

    to_delete_indexers: List[int] = []
    for idx in indexers:
        enabled = bool(idx.get('enabled', False))
        if not enabled:
            to_delete_indexers.append(int(idx.get('id', 0)))

    print(f'Found {len(to_delete_indexers)} disabled indexers to delete.')
    for iid in to_delete_indexers:
        print(f'- Deleting indexer id={iid}')
        try:
            delete_indexer(session, iid, dry_run)
        except Exception as e:
            print(f'  FAILED to delete indexer {iid}: {e}')


if __name__ == '__main__':
    # Do not execute here; user will run locally.
    main()
