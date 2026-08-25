# Quantumult X scripts

## Node diagnostics

Four standalone UIActions provide complementary checks from a selected node or
policy. Their result HTML intentionally uses a narrow, linear layout because
Quantumult X does not reliably render browser-style flex, card, and table CSS in
its native popup.

| Script | Purpose | Raw URL |
| --- | --- | --- |
| [`StreamingCheck-QX.js`](./StreamingCheck-QX.js) | Streaming and ChatGPT reachability/region signals | `https://raw.githubusercontent.com/silencoo/script-toolbox/main/quantumult-x/StreamingCheck-QX.js` |
| [`ExitIPCheck-QX.js`](./ExitIPCheck-QX.js) | IPPure exit-IP network type and fraud score | `https://raw.githubusercontent.com/silencoo/script-toolbox/main/quantumult-x/ExitIPCheck-QX.js` |
| [`GoogleLocation-QX.js`](./GoogleLocation-QX.js) | Non-destructive Google redirect-to-China heuristic | `https://raw.githubusercontent.com/silencoo/script-toolbox/main/quantumult-x/GoogleLocation-QX.js` |
| [`NodeBenchmark-QX.js`](./NodeBenchmark-QX.js) | Latency, jitter, request loss, loaded latency, and throughput | `https://raw.githubusercontent.com/silencoo/script-toolbox/main/quantumult-x/NodeBenchmark-QX.js` |

Copy the ready-to-use entries from the `[task_local]` section of
[`../proxy-rules/templates/quantumult-x.conf`](../proxy-rules/templates/quantumult-x.conf).
`GoogleLocation-QX.js` only reports the selected route and never switches a
policy automatically. Third-party attribution and licensing notes are recorded
in the script headers and [`../NOTICE.md`](../NOTICE.md).

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
