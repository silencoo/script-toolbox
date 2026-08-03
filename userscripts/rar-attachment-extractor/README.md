# Online RAR Extractor

A Userscript that adds "Extract & Preview" capabilities to RAR file links on any webpage, allowing you to view contents without downloading the archive to your device.

## Features

- **In-Browser Extraction**: Uses `libunrar-js` to extract RAR files directly in the browser.
- **Instant Preview**:
  - **Text Files**: View content of `.txt`, `.nfo`, `.log`, `.json`, etc., directly in the page.
  - **Copy**: One-click copy for text content.
- **Download Individual Files**: Extract and download specific files from the archive instead of the whole package.
- **Password Support**:
  - **Auto-Try**: Configurable dictionary of common passwords.
  - **Manual Input**: Prompts for password if auto-try fails.
- **Smart Detection**: Automatically detects valid RAR links and adds a helper panel.
- **Auto-Preview**: Option to automatically attempt extraction for small files.

## Technical Details

- **Core**: Powered by [libunrar-js](https://github.com/wcchoi/libunrar-js).
- **Isolation**: Runs the extraction adapter inside a generated Web Worker.
- **Caching**: Downloads and caches the upstream `libunrar.js` and memory file.
- **Security boundary**: Archive processing stays in the browser, but the
  userscript fetches executable code from the pinned upstream URL at runtime.
  Review the configured source before installation.

## Configuration

- **Enable/Disable Auto-Preview**: Toggle via Userscript menu.
- **Password Dictionary**: Edit the list of commonly used passwords via the "设置密码字典" menu command.

## Usage

1. Find a link to a `.rar` file on a webpage.
2. Look for the "RAR 解压助手" panel that appears near the link.
3. Click "解压预览" (Extract Preview).
4. Browse the file list, read text files, or download extracted items.

## Legacy migration

Version `0.2.1` incorporates the corrected result harvesting and Worker-based
extraction path from the former Gist. The old wrapper, generated `libunrar.js`,
RPC helper, Worker helper, and basic userscript are intentionally not vendored
here because they were incomplete as a standalone bundle.
