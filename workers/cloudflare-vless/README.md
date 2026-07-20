# Cloudflare VLESS node Worker

This Worker accepts a VLESS URL in the request path, queries several public
Cloudflare address-ranking services, validates their results, removes duplicate
addresses, and emits a plain-text VLESS subscription ordered primarily by
reported speed.

## Deploy

The easiest upgrade for an existing Worker is to replace its module code with
[`worker.js`](./worker.js) and deploy it. With Wrangler installed, you can also
deploy this directory directly:

```sh
npx wrangler deploy
```

Raw source:

```text
https://raw.githubusercontent.com/silencoo/script/main/workers/cloudflare-vless/worker.js
```

## Request format

Put a URL-encoded or literal `vless://...` URL after the Worker hostname. The
Worker preserves VLESS query parameters and adds its generated node names.

Optional Worker query parameters:

- `carrier=all|cm|cu|ct|cn` filters carrier-specific measurements.
- `limit=50` sets the maximum preferred nodes, capped at 100.
- `minspeed=100` excludes measured results below 100 Mbps and unmeasured results.
- `name=base` sets the original node name.
- `remark=CF` prefixes every node name with `[CF]`.

The ranking services measure from their own networks. Test the resulting nodes
from your connection before relying on them.

## Test

```sh
node --test worker.test.mjs
```
