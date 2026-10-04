# Quantumult X scripts

## Node diagnostics

Four standalone UIActions provide complementary checks from a selected node or
policy. NodeBenchmark uses Quantumult X's native message rendering for reliable
light/dark appearance; the other results use narrow, linear HTML without
browser-style flex, card, or table layouts.

| Script | Purpose | Raw URL |
| --- | --- | --- |
| [`StreamingCheck-QX.js`](./StreamingCheck-QX.js) | Streaming and ChatGPT reachability/region signals | `https://raw.githubusercontent.com/silencoo/script-toolbox/main/quantumult-x/StreamingCheck-QX.js` |
| [`ExitIPCheck-QX.js`](./ExitIPCheck-QX.js) | IPPure exit-IP network type and fraud score | `https://raw.githubusercontent.com/silencoo/script-toolbox/main/quantumult-x/ExitIPCheck-QX.js` |
| [`GoogleLocation-QX.js`](./GoogleLocation-QX.js) | Google Maps and YouTube China-region signals | `https://raw.githubusercontent.com/silencoo/script-toolbox/main/quantumult-x/GoogleLocation-QX.js` |
| [`NodeBenchmark-QX.js`](./NodeBenchmark-QX.js) | Latency, jitter, request loss, loaded latency, and throughput | `https://raw.githubusercontent.com/silencoo/script-toolbox/main/quantumult-x/NodeBenchmark-QX.js` |

Copy the ready-to-use entries from the `[task_local]` section of
[`../proxy-rules/templates/quantumult-x.conf`](../proxy-rules/templates/quantumult-x.conf).
`GoogleLocation-QX.js` only reports the selected route and never switches a
policy automatically. Third-party attribution and licensing notes are recorded
in the script headers and [`../NOTICE.md`](../NOTICE.md).

### Google / YouTube China detection

`GoogleLocation-QX.js` checks Maps Timeline and YouTube Premium independently,
in parallel, through the selected policy. A reachable Maps endpoint cannot
clear a YouTube China signal, and a failed probe does not erase the other
probe's result. Each endpoint's evidence is shown separately.

Both location and streaming actions read YouTube's `GL`, then `countryCode`.
When neither is present, they retain the upstream `www.google.cn` fallback for
`CN`. Explicit country fields take precedence over incidental links. A `CN`
result is displayed as **YouTube marked as China**, not Premium available.
Premium unavailability alone does **not** imply China. Missing region evidence,
consent/unknown pages and failed requests remain inconclusive/errors rather
than defaulting to the US or reporting success.

These are endpoint heuristics, not an IP-geolocation database or a guarantee
about video playback. Maps' HTTP 400 heuristic and YouTube's region can differ.

### Tests

Run the offline UIAction tests with Node.js 22:

```sh
node --test quantumult-x/tests/*.test.mjs
```

The YouTube regression corpus runs against both standalone scripts so their
embedded parsers cannot silently diverge. The dedicated Quantumult X workflow
runs this suite on relevant pushes and pull requests.

## Resource parser

[`resource-parser.js`](./resource-parser.js) is a customized Quantumult X
resource parser derived from the KOP-XIAO/Shawn script identified in its source
header.

Raw URL:

```text
https://raw.githubusercontent.com/silencoo/script-toolbox/main/quantumult-x/resource-parser.js
```

The source file retains its upstream attribution. See the repository
[`NOTICE.md`](../NOTICE.md) before redistributing it.

## Reusable profile

[`../proxy-rules/templates/quantumult-x.conf`](../proxy-rules/templates/quantumult-x.conf)
is an English profile template that discovers subscription nodes dynamically.
Copy it, replace the single subscription URL placeholder, and keep the edited
copy private because subscription URLs often contain credentials.
