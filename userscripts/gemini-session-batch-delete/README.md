# Gemini Conversation Manager

A Tampermonkey or Violentmonkey userscript for reviewing and permanently
deleting multiple Gemini conversations from one panel.

## Features

- Loads pinned and standard conversations from the current Gemini account
- Filters conversations by title, ID, or age
- Selects all conversations matching the current filters
- Protects the current and pinned conversations by default
- Opens individual conversations for review before deletion
- Deletes with configurable concurrency, retry handling, and progress reporting
- Requires a typed confirmation phrase before any deletion begins

Nothing is selected automatically. Deletion is permanent and cannot be undone,
so review the selection carefully before confirming it.

## Installation

1. Install [Tampermonkey](https://www.tampermonkey.net/) or
   [Violentmonkey](https://violentmonkey.github.io/).
2. Open the
   [raw userscript](https://raw.githubusercontent.com/silencoo/script-toolbox/main/userscripts/gemini-session-batch-delete/gemini-session-batch-delete.user.js).
3. Confirm the installation in your userscript manager.
4. Sign in at [Gemini](https://gemini.google.com/).

## Usage

1. Open Gemini and select **Manage Conversations** in the lower-right corner.
2. Select **Load conversations**.
3. Search or choose an age filter, then select conversations individually or
   use **Select filtered**.
4. Keep **Protect current** and **Protect pinned** enabled unless you
   intentionally want those conversations to be selectable.
5. Select **Delete selected**, enter the displayed confirmation phrase exactly,
   and keep the page open while deletion runs.

Use **Stop** to cancel requests that have not started. Conversations already
deleted before cancellation cannot be restored.

## Privacy and compatibility

The script uses credentials already present in the signed-in Gemini page and
sends same-origin requests only to `gemini.google.com`. It does not send
conversation data to a third-party service.

Gemini's conversation endpoints and page bootstrap data are internal,
undocumented interfaces. The script may need updating if Gemini changes them.

## Development

The userscript is a build-free JavaScript file. After making changes, update its
metadata version and run:

```sh
node --check userscripts/gemini-session-batch-delete/gemini-session-batch-delete.user.js
```

## License

[MIT](../../LICENSE)
