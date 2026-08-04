# Quantumult X scripts

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
