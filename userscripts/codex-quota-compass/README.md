# Codex Quota Compass

A Tampermonkey or Violentmonkey userscript that adds an on-page quota dashboard to the ChatGPT Codex analytics settings page.

## Features

- Displays the current rate-limit percentage
- Summarizes credits, estimated dollar value, and turns for the active quota cycle
- Estimates the total cycle quota from the reported usage percentage
- Shows daily usage for the current cycle and up to 30 days of recent history
- Provides a responsive panel that works on desktop and narrow screens

The dollar estimate uses the script's configurable default of `$40 / 1,000 credits`. It is a convenience estimate, not billing data.

## Installation

1. Install [Tampermonkey](https://www.tampermonkey.net/) or [Violentmonkey](https://violentmonkey.github.io/).
2. Open the [raw userscript](https://raw.githubusercontent.com/silencoo/script-toolbox/main/userscripts/codex-quota-compass/codex-quota-compass.user.js).
3. Confirm the installation in your userscript manager.
4. Sign in to ChatGPT and visit the [Codex analytics settings page](https://chatgpt.com/codex/cloud/settings/analytics).
5. Select **Run Analytics** in the lower-right corner.

## How it works

The script reads the access token already embedded in ChatGPT's page bootstrap data, then sends same-origin requests to ChatGPT's Codex usage and daily analytics endpoints. The token and returned usage data stay in the current page and are not sent to any third-party service.

The script depends on internal ChatGPT endpoints and page data. It may need updating if ChatGPT changes them.

## Configuration

Edit `CONFIG` near the top of the script to change:

- `USD_PER_CREDIT`: estimated value of one credit
- `HISTORY_DAYS`: number of recent days requested from the daily analytics endpoint

## Development

The userscript is a build-free JavaScript file. After making changes, update its metadata version and run:

```sh
node --check userscripts/codex-quota-compass/codex-quota-compass.user.js
```

## License

[MIT](../../LICENSE)
