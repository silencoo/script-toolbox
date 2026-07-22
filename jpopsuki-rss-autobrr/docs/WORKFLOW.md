# Autobrr Batch Import Workflow

This document describes the API sequence implemented by
`scripts/import_autobrr.py`. Run the importer with `DRY_RUN=true` first because
Autobrr API behavior can differ between versions.

## Inputs

The importer reads a private JSON array from `data/subscriptions.json` by
default:

```json
[
  {
    "label": "Example Artist Album",
    "url": "https://jpopsuki.eu/feeds.php?feed=torrents_notify_YOUR_USER_ID_YOUR_FEED_TOKEN&user=YOUR_USER_ID&auth=YOUR_AUTH&passkey=YOUR_PASSKEY&authkey=YOUR_AUTHKEY"
  }
]
```

Real JPopSuki RSS URLs contain account credentials. The real file is ignored
by Git; `data/subscriptions.example.json` is safe to commit.

Required runtime configuration:

| Variable | Default | Description |
| --- | --- | --- |
| `AUTO_BRR_BASE` | `http://localhost:7474` | Autobrr base URL |
| `AUTO_BRR_COOKIE` | none | Cookie header value from an authenticated Autobrr session |
| `AUTO_BRR_QBIT_ID` | `1` | Existing qBittorrent client id in Autobrr |
| `SAVE_BASE` | `/downloads/jpopsuki` | Root path for generated qBittorrent save paths |
| `INTERVAL_START` | `600` | Starting point for per-feed prime intervals |
| `SUB_FILE` | `data/subscriptions.json` | Subscription JSON path |
| `DRY_RUN` | `false` | Print planned writes without changing Autobrr |

## Per-subscription sequence

For each `{label, url}` entry, the importer performs the following steps.

### 1. Create an RSS indexer template

`POST /api/indexer`

```json
{
  "enabled": true,
  "identifier": "rss",
  "implementation": "rss",
  "name": "Example Artist Album",
  "irc": {},
  "settings": {},
  "feed": {
    "url": "https://jpopsuki.eu/feeds.php?...",
    "settings": {"download_type": "TORRENT"}
  }
}
```

The returned `id` becomes `indexer_template_id`.

### 2. Create the feed

`POST /api/feeds`

```json
{
  "name": "Example Artist Album",
  "enabled": false,
  "type": "RSS",
  "url": "https://jpopsuki.eu/feeds.php?...",
  "interval": 601,
  "timeout": 60,
  "indexer_id": 199,
  "settings": {"download_type": "TORRENT"}
}
```

`indexer_id` is the id returned by step 1. The script generates a different
prime interval for each feed—601, 607, 613, and so on when
`INTERVAL_START=600`.

If Autobrr returns a different interval, the importer sends
`PUT /api/feeds/{feed_id}` with the requested prime interval.

### 3. Enable the feed

`PATCH /api/feeds/{feed_id}/enabled`

```json
{"enabled": true}
```

### 4. Create a disabled filter

`POST /api/filters`

```json
{
  "name": "Example Artist Album",
  "enabled": false,
  "resolutions": [],
  "codecs": [],
  "sources": [],
  "containers": [],
  "origins": []
}
```

The returned `id` becomes `filter_id`.

### 5. Bind the indexer and qBittorrent action

The importer first reads `GET /api/filters/{filter_id}` to preserve an existing
action id when present, then sends `PUT /api/filters/{filter_id}`.

Important fields:

```json
{
  "id": 2195,
  "name": "Example Artist Album",
  "enabled": true,
  "indexers": [
    {"id": 199, "name": "Example Artist Album"}
  ],
  "actions": [
    {
      "id": 0,
      "name": "new action",
      "type": "QBITTORRENT",
      "enabled": true,
      "tags": "Example Artist Album",
      "save_path": "/downloads/jpopsuki/Example Artist/Album",
      "client_id": 1,
      "reannounce_interval": 7,
      "reannounce_max_attempts": 25
    }
  ]
}
```

The `indexers` entry uses `indexer_template_id` from step 1. The qBittorrent
`client_id` comes from `AUTO_BRR_QBIT_ID`.

## Save-path generation

The label is split on its final space:

```text
Example Artist Album -> /downloads/jpopsuki/Example Artist/Album
Example Artist TV-Music -> /downloads/jpopsuki/Example Artist/TV-Music
```

Labels without a space use `Misc` as the category.

## Safe execution

1. Confirm `data/subscriptions.json` is ignored by Git.
2. Load `AUTO_BRR_COOKIE` from the local `.env` file.
3. Run `DRY_RUN=true python scripts/import_autobrr.py`.
4. Review every label, save path, client id, and interval.
5. Test a small real batch before importing the complete list.

Dry-run logs mask `feed`, `user`, `auth`, `authkey`, and `passkey` URL values.
Avoid sharing raw Autobrr response bodies or the private subscription JSON.
