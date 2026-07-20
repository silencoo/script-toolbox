# Scripts

A collection of standalone proxy utilities, Cloudflare Workers, and browser
userscripts. Each tool lives with its own documentation so scripts can evolve
without crowding the repository root.

## Contents

| Directory | Tools |
| --- | --- |
| [`sub-store/`](./sub-store/) | Sub-Store conversion and iOS compatibility scripts |
| [`quantumult-x/`](./quantumult-x/) | Quantumult X resource parser |
| [`workers/cloudflare-vless/`](./workers/cloudflare-vless/) | VLESS subscription Worker using speed-ranked Cloudflare addresses |
| [`userscripts/e-hentai/`](./userscripts/e-hentai/) | E-Hentai Favorites & H@H browser userscript |

## Raw URL changes

Moving the scripts into categories changes their GitHub raw URLs:

| Previous path | New path |
| --- | --- |
| `convert.js` | `sub-store/convert.js` |
| `convert_v2.js` | `sub-store/convert-v2.js` |
| `substore-ios-adapter.js` | `sub-store/ios-adapter.js` |
| `quanx.js` | `quantumult-x/resource-parser.js` |
| `workers.js` | `workers/cloudflare-vless/worker.js` |

Update any subscriptions or deployments that use the old raw URLs after this
change is merged.

## Validation

JavaScript syntax and the Cloudflare Worker tests run automatically in GitHub
Actions. The Worker tests can also be run locally with:

```sh
node --test workers/cloudflare-vless/worker.test.mjs
```

## License

Original work in this repository is available under the [MIT License](./LICENSE).
Third-party-derived files retain their existing notices; see
[`NOTICE.md`](./NOTICE.md) for details.
