# Online RAR Extractor

A Userscript that adds "Extract & Preview" capabilities to RAR file links on any webpage, allowing you to view contents without downloading the archive to your device.

## Features

- **In-Browser Extraction**: Uses `libunrar-js` (WebAssembly) to extract RAR files directly in the browser.
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
- **Caching**: Caches the WASM module to reduce bandwidth usage.
- **Security**: All processing happens locally in your browser memory; no files are uploaded to any server.

## Configuration

- **Enable/Disable Auto-Preview**: Toggle via Userscript menu.
- **Password Dictionary**: Edit the list of commonly used passwords via the "设置密码字典" menu command.

## Usage

1. Find a link to a `.rar` file on a webpage.
2. Look for the "RAR 解压助手" panel that appears near the link.
3. Click "解压预览" (Extract Preview).
4. Browse the file list, read text files, or download extracted items.
