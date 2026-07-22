#!/usr/bin/env python3
import json
import os
import re
import sys
from typing import Any, Dict, List, Tuple

import requests


"""
Batch import indexers, feeds, and filters into autobrr using a private
subscriptions.json file.

Correct workflow:
1. POST /api/indexer -> create indexer, get indexer_id
2. POST /api/feeds -> create feed using indexer_id, get feed_id, set prime interval (601, 607, ...)
3. PATCH /api/feeds/{feed_id}/enabled -> enable feed
4. POST /api/filters -> create filter
5. PUT /api/filters/{filter_id} -> bind indexer_id to filter

Input file: data/subscriptions.json (array of { label: str, url: str })

Environment configuration:
- AUTO_BRR_BASE           (default: http://localhost:7474)
- AUTO_BRR_COOKIE         (required: authenticated Autobrr Cookie header value)
- AUTO_BRR_QBIT_ID        (default: 1)
- SAVE_BASE               (default: /downloads/jpopsuki)
- INTERVAL_START          (default: 600) base for prime sequence
- DRY_RUN                 (default: false)  # if true, only print planned requests
"""


SENSITIVE_QUERY_PARAM_RE = re.compile(
    r'([?&](?:feed|user|auth|authkey|passkey)=)[^&\s"\\]+',
    flags=re.IGNORECASE,
)


def redact_for_log(value: Any) -> Any:
    """Return a log-safe copy with account-bound RSS parameters hidden."""
    if isinstance(value, dict):
        return {key: redact_for_log(item) for key, item in value.items()}
    if isinstance(value, list):
        return [redact_for_log(item) for item in value]
    if isinstance(value, tuple):
        return tuple(redact_for_log(item) for item in value)
    if isinstance(value, str):
        return SENSITIVE_QUERY_PARAM_RE.sub(r'\1<redacted>', value)
    return value


def read_subscriptions(path: str) -> List[Dict[str, str]]:
    with open(path, 'r', encoding='utf-8') as f:
        return json.load(f)


def split_label(label: str) -> Tuple[str, str]:
    # Split by the last space into (artist, category)
    # E.g. "ITZY TV-Music" -> ("ITZY", "TV-Music")
    # Handles artists that contain spaces or parentheses.
    parts = label.rsplit(' ', 1)
    if len(parts) == 2:
        return parts[0], parts[1]
    # Fallback: no space found; treat whole as artist, unknown category
    return label, 'Misc'


def build_save_path(base: str, label: str) -> str:
    artist, category = split_label(label)
    return f"{base.rstrip('/')}/{artist}/{category}"


def is_prime(n: int) -> bool:
    if n < 2:
        return False
    if n == 2:
        return True
    if n % 2 == 0:
        return False
    i = 3
    while i * i <= n:
        if n % i == 0:
            return False
        i += 2
    return True


def generate_prime_intervals(start: int, count: int) -> List[int]:
    """Generate count consecutive primes starting from first prime >= start.

    Each feed will use a different prime number as its interval to avoid
    synchronized RSS polling requests.
    """
    primes = []
    n = start
    while len(primes) < count:
        if is_prime(n):
            primes.append(n)
        n += 1
        # Safety limit to avoid infinite loop
        if n > start + count * 100:
            raise RuntimeError(f'Failed to generate {count} primes starting from {start}')
    return primes


def make_session(base_url: str, cookie_header: str) -> requests.Session:
    s = requests.Session()
    s.headers.update({
        'Accept': '*/*',
        'Content-Type': 'application/json',
        'x-requested-with': 'XMLHttpRequest',
        'User-Agent': 'autobrr-import-script/1.0',
        'Cookie': cookie_header,
    })
    # Ensure base_url has no trailing slash
    s.base_url = base_url.rstrip('/')
    return s


def post_indexer_v2(s: requests.Session, payload: Dict[str, Any], dry_run: bool) -> Dict[str, Any]:
    # POST /api/indexer -> create indexer template
    url = s.base_url + '/api/indexer'
    if dry_run:
        print('[DRY RUN] POST', url)
        print(json.dumps(redact_for_log(payload), ensure_ascii=False))
        return {'id': 0, 'name': payload.get('name', '')}
    resp = s.post(url, data=json.dumps(payload))
    if not resp.ok:
        print(f'[ERROR] POST {url} status={resp.status_code}')
        try:
            print(redact_for_log(resp.text))
        except Exception:
            pass
        resp.raise_for_status()
    try:
        return resp.json()
    except Exception:
        print('[ERROR] Failed to parse indexer creation response as JSON:')
        print(redact_for_log(resp.text))
        raise


def post_feed(s: requests.Session, payload: Dict[str, Any], dry_run: bool) -> Dict[str, Any]:
    # POST /api/feeds -> create feed using indexer_id
    url = s.base_url + '/api/feeds'
    if dry_run:
        print('[DRY RUN] POST', url)
        print(json.dumps(redact_for_log(payload), ensure_ascii=False))
        return {'id': 0, 'name': payload.get('name', '')}
    resp = s.post(url, data=json.dumps(payload))
    if not resp.ok:
        print(f'[ERROR] POST {url} status={resp.status_code}')
        try:
            print(redact_for_log(resp.text))
        except Exception:
            pass
        resp.raise_for_status()
    try:
        return resp.json()
    except Exception:
        print('[ERROR] Failed to parse feed creation response as JSON:')
        print(redact_for_log(resp.text))
        raise


def put_feed(s: requests.Session, feed_id: int, payload: Dict[str, Any], dry_run: bool) -> Dict[str, Any]:
    # PUT /api/feeds/{feed_id} -> update feed (used to enforce interval)
    url = s.base_url + f'/api/feeds/{feed_id}'
    if dry_run:
        print(f'[DRY RUN] PUT {url}')
        print(json.dumps(redact_for_log(payload), ensure_ascii=False))
        return {'id': feed_id, **payload}
    resp = s.put(url, data=json.dumps(payload))
    if not resp.ok:
        print(f'[ERROR] PUT {url} status={resp.status_code}')
        try:
            print(redact_for_log(resp.text))
        except Exception:
            pass
        resp.raise_for_status()
    try:
        return resp.json()
    except Exception:
        print('[ERROR] Failed to parse feed update response as JSON:')
        print(redact_for_log(resp.text))
        raise


def patch_feed_enabled(s: requests.Session, feed_id: int, enabled: bool, dry_run: bool) -> None:
    # PATCH /api/feeds/{feed_id}/enabled -> enable/disable feed
    url = s.base_url + f'/api/feeds/{feed_id}/enabled'
    if dry_run:
        print(f'[DRY RUN] PATCH {url} enabled={enabled}')
        return
    resp = s.patch(url, data=json.dumps({'enabled': enabled}))
    if not resp.ok:
        print(f'[ERROR] PATCH {url} status={resp.status_code}')
        try:
            print(redact_for_log(resp.text))
        except Exception:
            pass
        resp.raise_for_status()


def post_filter(s: requests.Session, payload: Dict[str, Any], dry_run: bool) -> Dict[str, Any]:
    url = s.base_url + '/api/filters'
    if dry_run:
        print('[DRY RUN] POST', url)
        print(json.dumps(redact_for_log(payload), ensure_ascii=False))
        return {'id': 0, 'name': payload.get('name', '')}
    resp = s.post(url, data=json.dumps(payload))
    if not resp.ok:
        print(f'[ERROR] POST {url} status={resp.status_code}')
        try:
            print(redact_for_log(resp.text))
        except Exception:
            pass
        resp.raise_for_status()
    try:
        return resp.json()
    except Exception:
        print('[ERROR] Failed to parse filter creation response as JSON:')
        print(redact_for_log(resp.text))
        raise


def put_filter(s: requests.Session, filter_id: int, payload: Dict[str, Any], dry_run: bool) -> Dict[str, Any]:
    url = s.base_url + f'/api/filters/{filter_id}'
    if dry_run:
        print('[DRY RUN] PUT', url)
        print(json.dumps(redact_for_log(payload), ensure_ascii=False))
        return {'id': filter_id}
    resp = s.put(url, data=json.dumps(payload))
    if not resp.ok:
        print(f'[ERROR] PUT {url} status={resp.status_code}')
        try:
            print(redact_for_log(resp.text))
        except Exception:
            pass
        resp.raise_for_status()
    try:
        return resp.json()
    except Exception:
        print('[ERROR] Failed to parse filter save response as JSON:')
        print(redact_for_log(resp.text))
        raise


def get_indexers(s: requests.Session) -> List[Dict[str, Any]]:
    url = s.base_url + '/api/feeds'
    r = s.get(url)
    r.raise_for_status()
    try:
        return r.json()
    except Exception:
        print('[ERROR] Failed to parse indexers list response as JSON:')
        print(redact_for_log(r.text))
        raise


def get_filters(s: requests.Session) -> List[Dict[str, Any]]:
    url = s.base_url + '/api/filters'
    r = s.get(url)
    r.raise_for_status()
    try:
        return r.json()
    except Exception:
        print('[ERROR] Failed to parse filters list response as JSON:')
        print(redact_for_log(r.text))
        raise


def get_filter_by_id(s: requests.Session, filter_id: int) -> Dict[str, Any]:
    url = s.base_url + f'/api/filters/{filter_id}'
    r = s.get(url)
    r.raise_for_status()
    try:
        return r.json()
    except Exception:
        print('[ERROR] Failed to parse filter response as JSON:')
        print(redact_for_log(r.text))
        raise


def main() -> None:
    base_url = os.environ.get('AUTO_BRR_BASE', 'http://localhost:7474')
    cookie_header = os.environ.get('AUTO_BRR_COOKIE', '').strip()
    qbittorrent_client_id = int(os.environ.get('AUTO_BRR_QBIT_ID', '1'))
    save_base = os.environ.get('SAVE_BASE', '/downloads/jpopsuki')
    interval_start = int(os.environ.get('INTERVAL_START', '600'))
    dry_run = os.environ.get('DRY_RUN', 'false').lower() in ('1', 'true', 'yes')

    if not cookie_header:
        print('ERROR: AUTO_BRR_COOKIE is required (copy the Cookie header from your browser/session).')
        sys.exit(1)

    sub_path = os.environ.get(
        'SUB_FILE',
        os.path.join(os.path.dirname(os.path.dirname(__file__)), 'data', 'subscriptions.json'),
    )
    try:
        items = read_subscriptions(sub_path)
    except Exception as e:
        print(f'ERROR: Failed to read {sub_path}: {e}')
        sys.exit(1)

    # Filter valid items and generate prime intervals
    valid_items = [item for item in items if item.get('label', '').strip() and item.get('url', '').strip()]
    intervals = generate_prime_intervals(interval_start, len(valid_items))
    # print(f'Generated {len(intervals)} prime intervals starting from {interval_start}: {intervals[:10]}...')

    session = make_session(base_url, cookie_header)
    # print(f'Config: DRY_RUN={dry_run} BASE={base_url} INTERVAL_START={interval_start} QBIT_ID={qbittorrent_client_id}')

    # Get baseline feeds list ONCE before loop (to avoid API cache/pagination issues)
    baseline_feeds = []
    baseline_feed_names = set()
    baseline_feed_ids = set()
    if not dry_run:
        try:
            baseline_feeds = get_indexers(session)
            baseline_feed_names = {str(f.get('name', '')).strip() for f in baseline_feeds if f.get('name')}
            baseline_feed_ids = {int(f.get('id', 0)) for f in baseline_feeds if f.get('id')}
            print(f'[BASELINE] Initial feeds count: {len(baseline_feeds)}')
            print(f'[BASELINE] Initial feed names (first 10): {sorted(baseline_feed_names)[:10]}')
        except Exception as e:
            print(f'[WARN] Could not get baseline feeds: {e}')

    for idx, item in enumerate(valid_items):
        label = item.get('label', '').strip()
        rss_url = item.get('url', '').strip()
        artist, category = split_label(label)
        save_path = build_save_path(save_base, label)
        interval = intervals[idx]  # Each feed uses a different prime number as interval

        # print(f'\n=== Processing {idx+1}/{len(valid_items)}: {label} ===')
        # print(f'Using prime interval: {interval} (prime #{idx+1} starting from {interval_start})')

        # Use baseline as reference (don't query API again to avoid cache issues)
        print(f'[MONITOR] Processing label: {label}')
        print(f'[MONITOR] Baseline feeds count: {len(baseline_feeds)}')

        # Step 1: Create indexer template (POST /api/indexer)
        indexer_payload = {
            'enabled': True,
            'identifier': 'rss',
            'implementation': 'rss',
            'name': label,
            'irc': {},
            'settings': {},
            'feed': {
                'url': rss_url,
                'settings': {
                    'download_type': 'TORRENT'
                }
            }
        }
        if dry_run:
            print('[DRY RUN] Step 1: Would create indexer (/api/indexer):')
            print(json.dumps(redact_for_log(indexer_payload), ensure_ascii=False))
            indexer_template_id = 199  # mock
        else:
            idx_resp = post_indexer_v2(session, indexer_payload, dry_run=False)
            print(f'Step 1: Indexer creation response: {redact_for_log(idx_resp)}')
            indexer_template_id = int(idx_resp.get('id', 0) or 0)
            print(indexer_template_id)
            if indexer_template_id <= 0:
                print(f'[ERROR] Failed to get indexer template id for label="{label}"')
                continue
            print(f'Step 1: Indexer template created: id={indexer_template_id}')

            # Check if POST /api/indexer created any NEW feeds (matching our label)
            try:
                all_feeds_after_step1 = get_indexers(session)
                feed_names_after_step1 = {str(f.get('name', '')).strip() for f in all_feeds_after_step1 if f.get('name')}
                feed_ids_after_step1 = {int(f.get('id', 0)) for f in all_feeds_after_step1 if f.get('id')}

                # Only count feeds that are NEW (not in baseline) AND match our expected label
                truly_new_feeds = feed_ids_after_step1 - baseline_feed_ids
                new_feeds_for_this_label = [f for f in all_feeds_after_step1 if int(f.get('id', 0)) in truly_new_feeds and str(f.get('name', '')).strip() == label]

                if new_feeds_for_this_label:
                    print(f'[ALERT] Step 1 created {len(new_feeds_for_this_label)} feed(s) with name="{label}"!')
                elif len(truly_new_feeds) > 0:
                    # There are new feeds, but not matching our label - investigate
                    new_names = [str(f.get('name', '')).strip() for f in all_feeds_after_step1 if int(f.get('id', 0)) in truly_new_feeds]
                    print(f'[WARN] Step 1 created {len(truly_new_feeds)} new feed(s), but none match label="{label}"')
                    print(f'[WARN] New feed names: {sorted(set(new_names))[:5]}...')
                else:
                    print(f'[MONITOR] Step 1 did not create new feeds.')
            except Exception as e:
                print(f'[WARN] Could not check feeds after Step 1: {e}')

        # Step 2: Create feed using indexer_template_id (POST /api/feeds)
        # IMPORTANT: Each feed must use a prime number interval to avoid synchronized requests
        feed_payload = {
            'name': label,
            'enabled': False,  # will enable in next step
            'type': 'RSS',
            'url': rss_url,
            'interval': interval,  # prime number (601, 607, 613, ...)
            'timeout': 60,
            'indexer_id': indexer_template_id,
            'settings': {
                'download_type': 'TORRENT'
            }
        }
        # print(f'Step 2: Creating feed with prime interval={interval} (index {idx}, feed #{idx+1})')
        if dry_run:
            # print(f'[DRY RUN] Step 2: Would create feed (/api/feeds) with interval={interval}:')
            # print(json.dumps(redact_for_log(feed_payload), ensure_ascii=False))
            feed_id = 1468  # mock
        else:
            feed_resp = post_feed(session, feed_payload, dry_run=False)
            print(redact_for_log(feed_resp))
            # print(f'Step 2: Feed creation response: {redact_for_log(feed_resp)}')
            feed_id = int(feed_resp.get('id', 0) or 0)
            if feed_id <= 0:
                print(f'[ERROR] Failed to get feed id for label="{label}"')
                continue
            # Verify interval was set correctly in response
            actual_interval = feed_resp.get('interval', 0)
            if actual_interval != interval:
                print(f'[WARN] Feed interval mismatch! Requested={interval} but got={actual_interval}, correcting...')
                # PUT update requires full feed object, not just creation payload
                # Build complete payload from response and update only interval
                update_payload = dict(feed_resp)  # Start with full response
                update_payload['interval'] = interval  # Update interval to prime
                # Ensure indexer object is present (required by PUT)
                if 'indexer' not in update_payload or not update_payload.get('indexer'):
                    # If missing, construct from indexer_template_id
                    update_payload['indexer'] = {
                        'id': indexer_template_id,
                        'name': label,
                        'identifier': f'rss-{label.lower().replace(" ", "-")}',
                        'identifier_external': label
                    }
                try:
                    corrected_resp = put_feed(session, feed_id, update_payload, dry_run=False)
                    corrected_interval = corrected_resp.get('interval', actual_interval)
                    if corrected_interval == interval:
                        print(f'[INFO] Feed interval corrected via PUT: {corrected_interval}')
                        feed_resp = corrected_resp
                    else:
                        print(f'[WARN] Interval still {corrected_interval} after PUT; please adjust manually.')
                except Exception as e:
                    print(f'[ERROR] Failed to correct feed interval via PUT: {e}')
            else:
                print(f'Step 2: Feed created: id={feed_id} interval={interval} ✓')
                # Update baseline to include this newly created feed
                baseline_feed_ids.add(feed_id)

            # Check feeds count after Step 2 (should create exactly 1 feed with our label)
            try:
                all_feeds_after_step2 = get_indexers(session)
                feed_ids_after_step2 = {int(f.get('id', 0)) for f in all_feeds_after_step2 if f.get('id')}

                # Only count feeds that are NEW (not in baseline) AND match our expected label
                truly_new_feeds = feed_ids_after_step2 - baseline_feed_ids
                new_feeds_for_this_label = [f for f in all_feeds_after_step2 if int(f.get('id', 0)) in truly_new_feeds and str(f.get('name', '')).strip() == label]

                if len(new_feeds_for_this_label) == 1:
                    print(f'[MONITOR] Step 2 created 1 feed as expected: "{label}" (id={new_feeds_for_this_label[0].get("id")})')
                elif len(new_feeds_for_this_label) > 1:
                    print(f'[ALERT] Step 2 created {len(new_feeds_for_this_label)} feeds with name="{label}" instead of 1!')
                else:
                    # Check if feed was created but name doesn't match
                    if feed_id in truly_new_feeds:
                        actual_name = next((str(f.get('name', '')).strip() for f in all_feeds_after_step2 if int(f.get('id', 0)) == feed_id), 'unknown')
                        print(f'[WARN] Step 2 created feed id={feed_id} but name="{actual_name}" != "{label}"')
                    else:
                        print(f'[WARN] Step 2 reported feed id={feed_id} but it was not found in new feeds')
                    if len(truly_new_feeds) > 0:
                        new_names = [str(f.get('name', '')).strip() for f in all_feeds_after_step2 if int(f.get('id', 0)) in truly_new_feeds]
                        print(f'[WARN] All new feed names: {sorted(set(new_names))[:5]}...')
            except Exception as e:
                print(f'[WARN] Could not check feeds after Step 2: {e}')

        # Step 3: Enable feed (PATCH /api/feeds/{feed_id}/enabled)
        if dry_run:
            print(f'[DRY RUN] Step 3: Would enable feed id={feed_id}')
        else:
            patch_feed_enabled(session, feed_id, True, dry_run=False)
            # print(f'Step 3: Feed enabled: id={feed_id}')

            # Check feeds count after Step 3 (enable should not create new feeds)
            try:
                all_feeds_after_step3 = get_indexers(session)
                feed_ids_after_step3 = {int(f.get('id', 0)) for f in all_feeds_after_step3 if f.get('id')}

                # Only count feeds that are NEW (not in baseline)
                truly_new_feeds = feed_ids_after_step3 - baseline_feed_ids

                # Exclude the feed we just created in Step 2 (expected)
                expected_new_feeds = {feed_id}
                unexpected_new_feeds = truly_new_feeds - expected_new_feeds

                if unexpected_new_feeds:
                    unexpected_names = [str(f.get('name', '')).strip() for f in all_feeds_after_step3 if int(f.get('id', 0)) in unexpected_new_feeds]
                    print(f'[ALERT] Step 3 created {len(unexpected_new_feeds)} unexpected feed(s)!')
                    print(f'[ALERT] Unexpected feed names: {sorted(set(unexpected_names))[:5]}...')
                else:
                    print(f'[MONITOR] Step 3 did not create unexpected feeds.')
            except Exception as e:
                print(f'[WARN] Could not check feeds after Step 3: {e}')

        # Step 4: Create filter (POST /api/filters)
        filter_payload = {
            'name': label,
            'enabled': False,  # will enable after binding
            'resolutions': [],
            'codecs': [],
            'sources': [],
            'containers': [],
            'origins': [],
        }
        if dry_run:
            print('[DRY RUN] Step 4: Would create filter:')
            print(json.dumps(redact_for_log(filter_payload), ensure_ascii=False))
            filter_id = 2195  # mock
        else:
            filt_resp = post_filter(session, filter_payload, dry_run=False)
            filter_id = int(filt_resp.get('id', 0) or 0)
            if filter_id <= 0:
                print(f'[ERROR] Failed to get filter id for label="{label}"')
                continue
            # print(f'Step 4: Filter created: id={filter_id}')

        # Step 5: Bind indexer_template_id to filter and configure action (PUT /api/filters/{filter_id})
        # Validate indexer_template_id before binding
        if indexer_template_id <= 0:
            print(f'[ERROR] Cannot bind: invalid indexer_template_id={indexer_template_id} for label="{label}"')
            continue
        if filter_id <= 0:
            print(f'[ERROR] Cannot bind: invalid filter_id={filter_id} for label="{label}"')
            continue

        # Get existing filter data to preserve structure and get action id if exists
        existing_filter = None
        if not dry_run:
            try:
                existing_filter = get_filter_by_id(session, filter_id)
                # print(f'Step 5: Retrieved existing filter data: {json.dumps(existing_filter, ensure_ascii=False, indent=2)[:500]}...')
            except Exception as e:
                print(f'[WARN] Could not retrieve existing filter: {e}, proceeding with defaults')

        # Get action id if action exists, otherwise use 0 (new action)
        action_id = 0
        if existing_filter and existing_filter.get('actions') and len(existing_filter['actions']) > 0:
            action_id = int(existing_filter['actions'][0].get('id', 0) or 0)
            # print(f'Step 5: Using existing action id={action_id}')

        link_indexers = [{'id': indexer_template_id, 'name': label}]
        # print(f'Step 5: Binding indexer_template_id={indexer_template_id} to filter_id={filter_id}')
        put_payload = {
            'id': filter_id,
            'name': label,
            'enabled': True,
            'announce_types': ['NEW'],
            'priority': 0,
            'use_regex': False,
            'resolutions': [],
            'sources': [],
            'codecs': [],
            'containers': [],
            'match_hdr': [],
            'except_hdr': [],
            'match_other': [],
            'except_other': [],
            'smart_episode': False,
            'match_language': [],
            'except_language': [],
            'formats': [],
            'quality': [],
            'media': [],
            'match_release_types': [],
            'origins': [],
            'except_origins': [],
            'indexers': link_indexers,
            'actions': [
                {
                    'id': action_id,
                    'name': 'new action',
                    'type': 'QBITTORRENT',
                    'enabled': True,
                    'tags': label,
                    'save_path': save_path,
                    'reannounce_interval': 7,
                    'reannounce_max_attempts': 25,
                    'client_id': qbittorrent_client_id,
                    'webhook_method': '',
                    'webhook_type': '',
                }
            ],
            'external': [],
        }
        if dry_run:
            print('[DRY RUN] Step 5: Would save filter (PUT) with indexer_template_id bound:')
            print(json.dumps(redact_for_log(put_payload), ensure_ascii=False, indent=2))
            print(f'[DRY RUN] indexers field: {link_indexers}')
        else:
            resp = put_filter(session, filter_id, put_payload, dry_run=False)
            # print(f'Step 5: Filter saved response: {redact_for_log(resp)}')
            # print(f'Step 5: Filter saved and bound: filter_id={filter_id} indexer_template_id={indexer_template_id} indexers={link_indexers}')


if __name__ == '__main__':
    # Do not run automatically in this environment.
    # Leave execution to the user in their own environment.
    main()
