# Scripts

A collection of standalone proxy utilities and browser userscripts.

## Proxy utilities

| Script | Purpose |
| --- | --- |
| [`convert.js`](./convert.js) | Sub-Store profile conversion script |
| [`convert-v2.js`](./convert-v2.js) | Tag-aware Sub-Store profile conversion script |
| [`ios-adapter.js`](./ios-adapter.js) | Sub-Store iOS compatibility operator |
| [`resource-parser.js`](./resource-parser.js) | Quantumult X resource parser |
| [`workers.js`](./workers.js) | Cloudflare Worker that expands a VLESS URL with preferred Cloudflare IPs |

These files remain at the repository root so their raw GitHub URLs stay short.

### Cloudflare node Worker

`workers.js` combines speed- and latency-ranked IPs from multiple optimization
services, removes duplicates, and keeps the best measurement found for each IP.
Pass an encoded VLESS URL in the Worker request path.

Optional Worker query parameters:

- `carrier=all|cm|cu|ct|cn` filters carrier-specific measurements.
- `limit=50` controls the maximum number of generated preferred nodes (up to 100).
- `minspeed=100` keeps only sources reporting at least that many Mbps.
- `name` and `remark` control generated node names.

Remote rankings describe the source's test network, so the final nodes should
still be latency-tested from the connection where they will be used.

## Browser userscripts

- [E-Hentai Favorites & H@H Toolkit](./userscripts/e-hentai/README.md)
