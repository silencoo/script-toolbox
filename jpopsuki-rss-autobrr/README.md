# JPopSuki RSS + Autobrr Toolkit

Tools for creating JPopSuki notification RSS feeds and importing them into
[Autobrr](https://autobrr.com/). The project keeps account-bound RSS URLs and
Autobrr session cookies out of Git by default.

## What is included

| Path | Purpose |
| --- | --- |
| [`userscript/jpopsuki-batch-rss-manager.user.js`](userscript/jpopsuki-batch-rss-manager.user.js) | Create notification filters on JPopSuki and export their RSS URLs as JSON |
| [`scripts/import_autobrr.py`](scripts/import_autobrr.py) | Create Autobrr indexers, feeds, filters, and qBittorrent actions in bulk |
| [`scripts/cleanup_autobrr.py`](scripts/cleanup_autobrr.py) | Delete filters with no indexers and disabled feeds |
| [`scripts/delete_indexers_by_keyword.py`](scripts/delete_indexers_by_keyword.py) | Delete feeds whose names match a keyword list |
| [`scripts/original_autobrr.py`](scripts/original_autobrr.py) | Sanitized legacy importer retained for comparison only |
| [`config_examples/`](config_examples/) | Sanitized HTTP request references for Autobrr/JPopSuki APIs |
| [`docs/WORKFLOW.md`](docs/WORKFLOW.md) | Detailed Autobrr API sequence and payload notes |

## Security model

JPopSuki RSS URLs contain account-bound values such as `feed`, `user`, `auth`,
`authkey`, and `passkey`. Autobrr's web session cookie also grants access to
its API. Treat both as secrets.

- `data/subscriptions.json` is the local RSS export and is ignored by Git.
- `data/keywords.txt` is local operator input and is ignored by Git.
- `AUTO_BRR_COOKIE` has no default value and must be supplied at runtime.
- Importer log output masks account-bound RSS query parameters.
- Files under `config_examples/` contain placeholders only.

The original source files contained live-looking RSS credentials and Autobrr
session cookies. Rotate/revoke those values before using this toolkit, even
though they have been removed from the version intended for this repository.

## Requirements

- A userscript manager such as Tampermonkey or Violentmonkey
- Python 3.9 or newer
- Autobrr with an existing qBittorrent client configuration
- Python package `requests`

Create an isolated Python environment:

```sh
cd jpopsuki-rss-autobrr
python3 -m venv .venv
. .venv/bin/activate
python -m pip install -r requirements.txt
```

## 1. Export RSS subscriptions from JPopSuki

1. Install [`jpopsuki-batch-rss-manager.user.js`](userscript/jpopsuki-batch-rss-manager.user.js)
   in your userscript manager.
2. Sign in to JPopSuki and open `user.php?action=notify`.
3. Open **Batch RSS Creator**, enter an artist, select categories, and create
   the notification filters.
4. Use **Extract** and **Copy JSON** after the page refreshes.
5. Save the copied JSON as `data/subscriptions.json`.

Start from the safe template if needed:

```sh
cp data/subscriptions.example.json data/subscriptions.json
chmod 600 data/subscriptions.json
```

Do not post the exported JSON in issues, logs, chat messages, or screenshots.
The full URLs can be used by anyone who obtains them.

## 2. Configure Autobrr access

Copy the environment template:

```sh
cp .env.example .env
chmod 600 .env
```

Edit `.env`, then load it into the current shell:

```sh
set -a
. ./.env
set +a
```

Get `AUTO_BRR_COOKIE` from the Cookie request header in an authenticated
Autobrr browser session. Do not include the `Cookie:` header name itself.
Because `.env` contains a live session, never commit it.

## 3. Preview and import

Preview the generated requests first:

```sh
DRY_RUN=true python scripts/import_autobrr.py
```

When the paths, qBittorrent client id, labels, and feed URLs look correct:

```sh
DRY_RUN=false python scripts/import_autobrr.py
```

The importer assigns a different prime-number polling interval to each feed,
starting at the first prime greater than or equal to `INTERVAL_START`.

## Maintenance commands

Preview cleanup of empty filters and disabled feeds:

```sh
DRY_RUN=true python scripts/cleanup_autobrr.py
```

Run the cleanup after reviewing the output:

```sh
DRY_RUN=false python scripts/cleanup_autobrr.py
```

Delete feeds by keyword:

```sh
cp data/keywords.example.txt data/keywords.txt
DRY_RUN=true python scripts/delete_indexers_by_keyword.py
DRY_RUN=false python scripts/delete_indexers_by_keyword.py
```

Set `REGEX=true` only when every line in `data/keywords.txt` should be treated
as a regular expression.

## Environment variables

| Variable | Default | Used by |
| --- | --- | --- |
| `AUTO_BRR_BASE` | `http://localhost:7474` | All Python tools |
| `AUTO_BRR_COOKIE` | none; required | All Python tools |
| `AUTO_BRR_QBIT_ID` | `1` | Importers |
| `SAVE_BASE` | `/downloads/jpopsuki` | Importers |
| `INTERVAL_START` | `600` | Importers |
| `SUB_FILE` | `data/subscriptions.json` | Importers |
| `KEYWORD_FILE` | `data/keywords.txt` | Keyword deletion tool |
| `REGEX` | `false` | Keyword deletion tool |
| `DRY_RUN` | `false` | All Python tools |

`DRY_RUN` prevents writes, but cleanup tools still authenticate and read from
Autobrr to calculate what they would delete. A valid cookie is therefore
required in dry-run mode too.

## Safety notes

- Always run destructive tools with `DRY_RUN=true` first.
- Use a short-lived Autobrr session where possible and revoke it after use.
- Keep Autobrr bound to localhost or a protected private network.
- For HTTPS with a private CA, set `REQUESTS_CA_BUNDLE` to the CA bundle path;
  do not disable certificate verification.
- Review `SAVE_BASE` and `AUTO_BRR_QBIT_ID` before a real import.
- JPopSuki page/API changes may break the userscript; verify a small batch
  before creating many filters.

See [`docs/WORKFLOW.md`](docs/WORKFLOW.md) for the API-level import sequence.
