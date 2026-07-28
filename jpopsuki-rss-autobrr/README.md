# JPopSuki RSS + Autobrr Manager

A browser-only userscript for creating JPopSuki notification feeds and safely
managing their Autobrr indexers, feeds, filters, and qBittorrent actions. No
Python runtime, local environment file, or command line is required.

## Features

The same
[`jpopsuki-batch-rss-manager.user.js`](userscript/jpopsuki-batch-rss-manager.user.js)
runs in two deliberate page modes:

| Page/view | Capabilities |
| --- | --- |
| JPopSuki — **Create RSS** | Preview and batch-create notification filters, skip duplicate labels, discover RSS links, stage them temporarily, and optionally export private RSS JSON |
| Autobrr — **Autobrr** | Enter the API token on the self-hosted Autobrr page, discover qBittorrent clients, configure paths and intervals, preview `CREATE`/`UPDATE`/`REUSE`/`SKIP`, and apply |
| Autobrr — **Managed** | Search managed labels with literal text or regex, plan cleanup, delete complete bundles, and import/export browser state |

Imports are idempotent and journaled after each remote object. An interrupted
browser session can resume without automatically creating duplicates.

## Requirements

- Tampermonkey or Violentmonkey with privileged userscript APIs
- A current browser with Web Crypto support
- Autobrr with an existing qBittorrent download client
- An Autobrr API key from **Settings → API Keys**

Autobrr's official API accepts the key through the recommended
`X-API-Token` header. See the [Autobrr API documentation](https://autobrr.com/api).

## Installation

Install the
[`userscript/jpopsuki-batch-rss-manager.user.js`](https://raw.githubusercontent.com/silencoo/script-toolbox/main/jpopsuki-rss-autobrr/userscript/jpopsuki-batch-rss-manager.user.js)
raw file in the userscript manager, then open:

```text
https://jpopsuki.eu/user.php?action=notify
```

The **JPopSuki RSS** button appears in the bottom-right corner.

The distributed script is allowed to connect only to the current matched page
and the default local Autobrr hosts:

```text
self
localhost
127.0.0.1
```

This covers the default Autobrr installation. If Autobrr uses a remote HTTPS
hostname, add its exact page include to the metadata block:

```javascript
// @include      https://autobrr.example.com/*
```

`@connect self` authorizes API access only while the script is running on that
Autobrr origin. Do not replace it with `@connect *`.

## Normal workflow

### 1. Create JPopSuki RSS notifications

In **Create RSS**:

1. Enter the artist.
2. Select categories such as Album, Single, or TV-Music.
3. Choose **Create Filters**.
4. Review the confirmation list.
5. Let the page refresh so the new RSS links appear.
6. Enter the Autobrr URL and choose **Stage & Open Autobrr**.

Requests are sent sequentially with progress reporting. Existing labels are
skipped. The private RSS rows are timestamped in userscript storage so the
Autobrr page can resume after a refresh. Records older than 24 hours are
discarded the next time Autobrr opens, and a fully successful Apply clears them
immediately.

### 2. Connect Autobrr

On the Autobrr page, open **JPopSuki Autobrr** and configure:

| Field | Typical value |
| --- | --- |
| Autobrr base URL | `http://localhost:7474` |
| API token | API key created in Autobrr |
| qBittorrent client | Selected from Autobrr automatically |
| Save base | `/downloads/jpopsuki` or `D:/Downloads/JPopSuki` |
| Interval start | `600` |

The API token is never loaded on the JPopSuki page. On Autobrr it is held only
for the current page by default. **Remember token** stores it in private
userscript storage for convenience; that storage is not an encrypted password
vault.

Choose **Connect / Load clients** to verify the token and populate the
qBittorrent selector.

### 3. Plan and apply

Choose **Plan** first. Every RSS subscription is shown with its intended
Autobrr operations:

```text
Label                  Indexer  Feed    Filter  Save path
Example Artist Album   CREATE   CREATE  CREATE  /downloads/jpopsuki/Example Artist/Album
Example Artist Single  REUSE    SKIP    UPDATE  /downloads/jpopsuki/Example Artist/Single
```

When the plan is correct, choose **Apply** and type:

```text
APPLY
```

For each subscription the manager reconciles:

```text
RSS indexer
├── enabled RSS feed
└── enabled filter
    └── qBittorrent action
```

The managed state is saved after each indexer, feed, and filter ID. Mutation
requests are never automatically retried.

## Existing Autobrr objects

Same-name objects not recorded in managed state are rejected by default.
After verifying that unique same-name objects belong to this toolkit, enable
**Adopt unique existing same-name objects**, run **Plan**, and then apply.

Multiple same-name objects and managed IDs whose current name has changed are
always rejected.

## Cleanup and uninstall

The **Managed** view lists only objects recorded by this userscript.

### Cleanup

**Plan cleanup** finds:

- managed filters with no bound indexers;
- managed feeds whose enabled value is exactly `false`.

**Apply cleanup** rechecks the plan and requires typing `DELETE`.

### Remove artists or categories

Search labels using literal text or enable **Regex search**, select the
matching rows, and choose **Delete selected bundles**.

Each selected bundle is verified against live Autobrr names and deleted in
dependency order:

```text
filter → feed → indexer
```

The manager never deletes downloaded files, torrent data, or unmanaged
Autobrr objects.

## Managed-state backup and migration

Managed state contains only labels, URL SHA-256 fingerprints, stable intervals,
remote IDs, and completion flags. It never contains RSS URLs or the Autobrr
API token.

Use **Export state** before changing browsers or userscript managers. Restore
with **Import state**, which validates the schema and requires typing `IMPORT`
before replacing browser state.

If an earlier version created `data/managed-state.json`, import that file once
from the **Managed** view. Its schema remains compatible. After verification,
the old local file is no longer needed.

## Private RSS export

Normal Autobrr import reads RSS URLs from the temporary browser staging record,
so no local subscription file is needed. Use **Clear staged RSS** to remove
that record manually; a successful Apply removes it automatically.

**Export private RSS JSON** remains available for backup or inspection. The
download contains account credentials and must not be shared, committed,
uploaded, or left in an unprotected directory. Its format is shown in
[`data/subscriptions.example.json`](data/subscriptions.example.json).

## Security model

- The API token is entered only on the Autobrr origin, never on JPopSuki.
- The UI is rendered inside a closed Shadow DOM.
- The API token is never included in URLs, page logs, or managed state.
- Cross-origin requests use the API token and do not send browser cookies.
- RSS staging older than 24 hours is rejected and cleared on Autobrr startup.
- A successful Apply clears staged RSS immediately.
- Plans are read-only; apply requires an explicit confirmation.
- POST, PATCH, and DELETE requests are not retried.
- Every destructive action verifies both managed ID and current name.
- A corrupt managed-state record blocks planning and all remote mutations
  until a valid backup is imported.
- Plain HTTP Autobrr URLs are accepted only for loopback hosts.

## Tests

Run the offline browser-core tests:

```sh
node --test tests/userscript.test.cjs
node --check userscript/jpopsuki-batch-rss-manager.user.js
```

The tests cover RSS validation, secret redaction, save paths, stable intervals,
managed ownership, reconciliation drift, cleanup, and deletion scope. They do
not connect to JPopSuki or Autobrr.

See [`docs/WORKFLOW.md`](docs/WORKFLOW.md) for the browser architecture and API
sequence.
