# Browser Reconciliation Workflow

The toolkit runs through one privileged userscript in two page modes. There is
no local service or command-line component.

```text
JPopSuki page
├── notification-filter creation
└── private RSS discovery
        │
        │ timestamped userscript staging (24-hour validity)
        ▼
Autobrr page
└── userscript plan/apply engine
    ├── browser-local managed state
    └── authenticated Autobrr API client
        │
        ▼
Autobrr
├── RSS indexer
├── RSS feed
└── filter + qBittorrent action
```

## Privileged browser APIs

The script uses:

- `GM_xmlhttpRequest` for authenticated JPopSuki form submission and explicit
  Autobrr API requests;
- `GM_getValue`, `GM_setValue`, and `GM_deleteValue` for configuration and
  managed state;
- `GM_openInTab` to open the configured Autobrr page after RSS staging.

Only localhost port 7474 and `127.0.0.1` port 7474 are included as Autobrr
pages. `@connect self` permits requests only to the page where the script is
currently running; localhost and `127.0.0.1` are also listed explicitly. A
remote Autobrr deployment therefore needs only an exact `@include`, while the
same-origin API-base check prevents it from targeting another host.

The UI is attached through a closed Shadow DOM. The JPopSuki mode never reads
the Autobrr API token or managed state. It only stages RSS rows and the target
Autobrr URL. Token entry, API access, managed state, and deletion exist only in
Autobrr mode.

## Input discovery and validation

RSS subscriptions are extracted from `feeds.php?feed=torrents_notify_...`
links already present in the notification-page DOM. Before staging, the
manager verifies:

- normalized, bounded labels without control bytes;
- HTTPS JPopSuki `/feeds.php` URLs;
- required feed and account credential parameters;
- duplicate-label and duplicate-URL conflicts;
- absolute POSIX or Windows save paths without traversal segments;
- positive interval and qBittorrent client IDs.

The browser computes SHA-256 label keys and URL fingerprints with Web Crypto.
Raw RSS URLs are written only to a timestamped userscript staging record. A
record older than 24 hours is rejected and removed the next time Autobrr mode
starts. It can also be manually cleared and is removed immediately after a
fully successful Apply. Raw URLs are never written to managed state.

## Authentication and transport

Autobrr API calls originate from the Autobrr page and send the configured API
key in `X-API-Token`. The configured API base must have the same origin as the
current Autobrr page. Requests use a 30-second timeout and anonymous mode so
browser cookies are not sent.

JPopSuki filter-creation requests are separate same-site form submissions and
use the current authenticated JPopSuki session. The Autobrr API token is not
available in that page mode.

Plain HTTP is restricted to `localhost` and `127.0.0.1`. A remote Autobrr
instance must use HTTPS.

API failures redact RSS query credentials and credential-like JSON fields.
There are no automatic retries, especially for mutation requests where a
timeout does not prove the server rejected the write.

## Managed state

The browser storage record uses schema version 1:

```json
{
  "schema_version": 1,
  "items": {
    "24-character-label-hash": {
      "label": "Example Artist Album",
      "url_fingerprint": "64-character-sha256",
      "interval": 601,
      "indexer_id": 11,
      "feed_id": 22,
      "filter_id": 33,
      "complete": true
    }
  }
}
```

The state contains no RSS URL or API token. It is written after each remote ID
is known, allowing a later page load to resume safely.

For each object type, lookup follows these rules:

1. Prefer the managed ID and verify its current Autobrr name.
2. If the ID is missing, look for an exact unique name.
3. Require **Adopt existing** before taking ownership of that name match.
4. Reject duplicate names and renamed/reused IDs.

## Read-only plan

The manager reads:

```text
GET /api/download_clients
GET /api/indexer
GET /api/feeds
GET /api/filters
GET /api/filters/{id}
```

It verifies the selected download client is a live qBittorrent client and
computes a row containing indexer, feed, and filter operations plus the final
save path. Planning never writes managed state or Autobrr.

## Apply sequence

For each subscription:

1. Reuse or create the RSS indexer with `POST /api/indexer`.
2. Save `indexer_id` to browser state.
3. Reuse, create, or update the feed through `POST /api/feeds` or
   `PUT /api/feeds/{id}`.
4. Save `feed_id`; enable it with `PATCH /api/feeds/{id}/enabled`.
5. Reuse or create the filter with `POST /api/filters`.
6. Save `filter_id`.
7. Read the full filter and reconcile its indexer and qBittorrent action with
   `PATCH /api/filters/{id}`, falling back to `PUT` only for a server that
   rejects PATCH with 404 or 405.
8. Mark the browser-state entry complete.

Known filter rules and non-qBittorrent actions are preserved. Feed intervals
remain stable across future runs by reusing each managed interval.

Independent subscriptions continue after an item failure. The next Plan shows
the remaining drift.

## Cleanup and deletion

Cleanup considers only managed:

- filters whose `indexers` array is empty;
- feeds whose `enabled` value is boolean `false`.

Full bundle deletion uses literal or regex label search in the browser UI,
then verifies all live ID/name pairs and removes:

```text
filter → feed → indexer
```

After each successful deletion the corresponding state ID is removed. Missing
remote objects are reported and their stale IDs are cleared only as part of a
confirmed full-bundle deletion.

Neither workflow touches filesystem data or objects outside managed state.

## Backup and recovery

**Export state** downloads the schema above. **Import state** accepts only
validated schema-version-1 records and requires an `IMPORT` confirmation before
replacing browser state.

A corrupt browser record blocks Plan, Apply, cleanup, deletion, and state
export. This prevents an implicit empty-state fallback from creating or
claiming objects.
