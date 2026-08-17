# Gemini Toolkit

A Tampermonkey or Violentmonkey userscript for keeping preferred Gemini model
defaults, downloading generated images without Gemini's global download lock,
exporting a conversation's full-size images, and safely managing conversations.

## Features

- Loads pinned and standard conversations from the current Gemini account
- Defaults new chats to the latest available Pro model with Extended thinking
- Can independently combine Pro, standard Flash, or Flash-Lite with Extended
  on, off, or Gemini's own choice
- Re-applies defaults after Gemini navigation without overriding a manual
  model change in the current chat
- Tracks Gemini's generated-image source before the current frontend converts
  it into a page-local `blob:` URL, so different images can download
  concurrently instead of disabling every image button
- Recognizes current tiered `gg-*-dl` and `rd-*` original-image routes and
  probes the original route before using Gemini's own blob-backed image data
  when the legacy full-size lookup no longer returns a URL
- Remembers generated images as they appear while a conversation is scrolled,
  even after Gemini removes their virtualized DOM elements
- Shows the ordered export manifest and flags images that are missing
  original-size metadata before downloading
- Exports captured images as separate downloads, fetching and saving only one
  image at a time with stable response-, attachment-, and asset-based filenames
- Retries only transient image failures up to three times, keeps a persistent
  result summary, and lets you retry only eligible failures
- Provides one persistent, independently controlled watermark-removal switch
  for both single-image and bulk downloads
- Uses web2gem-plus's bottom-right crop strategy and its vendored GargantuaX
  adaptive watermark core, including newer 36/48/96-pixel variants, while
  releasing image and canvas memory after every file
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
   [raw userscript](https://raw.githubusercontent.com/silencoo/script-toolbox/main/userscripts/gemini-toolkit/gemini-toolkit.user.js).
3. Confirm the installation in your userscript manager.
4. Sign in at [Gemini](https://gemini.google.com/).

## Usage

### Model defaults and conversation management

1. Open Gemini, select **Toolkit** immediately to the left of Gemini's
   conversation-actions menu, then choose **Manage conversations**.
2. Choose the **Model** and **Thinking** defaults. The initial configuration is
   **Latest Pro** with **Extended on**.
3. Select **Apply now** to correct the current chat immediately. If you change
   Gemini's model picker manually afterward, the script leaves that chat alone
   and applies the preference again on the next chat.
4. Select **Load conversations** to use the conversation manager.
5. Search or choose an age filter, then select conversations individually or
   use **Select filtered**.
6. Keep **Protect current** and **Protect pinned** enabled unless you
   intentionally want those conversations to be selectable.
7. Select **Delete selected**, enter the displayed confirmation phrase exactly,
   and keep the page open while deletion runs.

Use **Stop** to cancel requests that have not started. Conversations already
deleted before cancellation cannot be restored.

### Full-size image downloads

- Select Gemini's existing **Download full size image** button on any generated
  image. The userscript handles that request independently, so another image's
  button remains available while the first request is running.
- Turn on **Remove image watermark** in **Gemini Toolkit** when single-image and
  bulk downloads should be processed. It is off by default and persists until
  changed.
- Open **Toolkit** and select **Export full-size images**, review the ordered
  file list, readiness status, and watermark setting, then select
  **Download images**. Each image is fetched and downloaded separately before
  the next one starts; allow multiple downloads if the browser prompts you.

The exporter remembers generated images seen since the userscript loaded the
current conversation. For an unusually long virtualized conversation, scroll
through it from top to bottom once before opening the export confirmation;
images remain in the manifest even after Gemini unloads their message elements.

## Privacy and compatibility

The script stores model and watermark preferences in userscript-manager
storage. Conversation and full-size image lookup requests stay on
`gemini.google.com`; resolved image downloads go directly to Googleusercontent
asset URLs. It does not send conversation data, prompts, images, or preferences
to an analytics service. Userscript dependencies are downloaded from jsDelivr
and this repository's raw GitHub URL when the userscript manager installs or
updates the script.

Gemini's conversation endpoints, image URL transforms, page bootstrap data,
model-picker test IDs, and menu structure are internal, undocumented
interfaces. The script may need updating if Gemini changes them.

## Development

The userscript is a build-free JavaScript file. After making changes, update its
metadata version and run:

```sh
node --check userscripts/gemini-toolkit/gemini-toolkit.user.js
node --check userscripts/gemini-toolkit/vendor/gargantua-core.js
node --test userscripts/gemini-toolkit/tests/*.test.cjs
```

## License

Original repository code is covered by [MIT](../../LICENSE). The vendored
GargantuaX watermark core retains its upstream MIT notice in
[`vendor/LICENSE.gargantua`](./vendor/LICENSE.gargantua).
