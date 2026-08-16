# Codex Quota Compass

A Tampermonkey or Violentmonkey userscript that adds an on-page quota dashboard to the ChatGPT Codex analytics settings page.

## Features

- Displays the current rate-limit percentage
- Summarizes reported credits, estimated dollar value, and turns for the active quota cycle
- Shows the quota formula, live inputs, data sources, and accuracy caveats in the panel
- Withholds the quota estimate when today's daily row is missing or zero instead of treating delayed data as zero usage
- Labels quota and dollar results as provisional because the source endpoints can refresh at different times
- Shows daily usage for the current cycle and up to 30 days of recent history
- Places a compact quota analytics control in the Codex page header, with a floating fallback if the header markup changes
- Provides a responsive panel that works on desktop and narrow screens

The provisional quota formula is:

```text
reported cycle credits / (used percent / 100)
```

`used percent` comes from the Codex usage endpoint, while credits come from the daily analytics endpoint. Because those endpoints can update at different times, the script does not calculate a quota estimate when today's daily row is missing or still zero. Even when an estimate is shown, it remains provisional. Daily calendar buckets can also be imperfect at a mid-day quota-cycle boundary.

The dollar estimate uses the script's configurable default of `$40 / 1,000 credits`. It is a convenience estimate, not billing data.

## Installation

1. Install [Tampermonkey](https://www.tampermonkey.net/) or [Violentmonkey](https://violentmonkey.github.io/).
2. Open the [raw userscript](https://raw.githubusercontent.com/silencoo/script-toolbox/main/userscripts/codex-quota-compass/codex-quota-compass.user.js).
3. Confirm the installation in your userscript manager.
4. Sign in to ChatGPT and visit the [Codex analytics settings page](https://chatgpt.com/codex/cloud/settings/analytics).
5. Select **Quota Analytics** in the Codex page header.

## How it works

The script parses ChatGPT's page bootstrap data and reads the session access-token field, then sends same-origin requests to ChatGPT's Codex usage and daily analytics endpoints. The token and returned usage data stay in the current page and are not sent to any third-party service.

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
