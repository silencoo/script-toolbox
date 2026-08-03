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
- Replaces the native full-size image click handler so different images can
  download concurrently instead of disabling every image button
- Exports all generated images currently loaded in a conversation as one ZIP,
  with up to three full-size requests in parallel
- Provides one persistent, independently controlled watermark-removal switch
  for both single-image downloads and ZIP exports
- Uses web2gem-plus's bottom-right crop strategy and its vendored GargantuaX
  adaptive watermark core, including newer 36/48/96-pixel variants
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

1. Open Gemini, select the compact **Toolkit** dock, then choose
   **Manage conversations**.
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
- Open the **Toolkit** dock and select **Export full-size images**, review the
  detected image count and watermark setting, then select **Export ZIP**. The
  browser receives one ZIP download after all available images are fetched.

The exporter sees generated images whose full-size buttons are present in the
loaded conversation DOM. If Gemini virtualizes an unusually long conversation,
scroll through it once before opening the export confirmation.

## Privacy and compatibility

The script stores model and watermark preferences in userscript-manager
storage. Conversation requests stay on `gemini.google.com`; image downloads go
directly to the Googleusercontent asset URLs already embedded by Gemini. It
does not send conversation data, prompts, images, or preferences to an
analytics service. Userscript dependencies are downloaded from jsDelivr and
this repository's raw GitHub URL when the userscript manager installs or
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
