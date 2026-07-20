# Scripts

A collection of standalone proxy utilities, Cloudflare Workers, browser
userscripts, and AI agent setup scripts. Each tool lives with its own
documentation so scripts can evolve without crowding the repository root.

## Contents

| Directory | Tools |
| --- | --- |
| [`sub-store/`](./sub-store/) | Sub-Store conversion and iOS compatibility scripts |
| [`quantumult-x/`](./quantumult-x/) | Quantumult X resource parser |
| [`workers/cloudflare-vless/`](./workers/cloudflare-vless/) | VLESS subscription Worker using speed-ranked Cloudflare addresses |
| [`userscripts/e-hentai/`](./userscripts/e-hentai/) | E-Hentai Favorites & H@H browser userscript |
| [`agent/`](./agent/) | Setup scripts for AI coding agents that lose built-in tools when routed through third-party providers (e.g. Claude Code via MiniMax) |
| [`debian-13/`](./debian-13/) | Debian 13 development and AI workstation setup |
| [`dujiaoka-epusdt/`](./dujiaoka-epusdt/) | Dujiaoka and EPUSDT deployment stack |
| [`sing-box/`](./sing-box/) | AnyTLS node installer and client configuration generator |
| [`linux-server-toolkit/`](./linux-server-toolkit/) | All-in-one Debian/Ubuntu server setup and operations toolkit |

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

## agent

Setup scripts for AI coding agents that lose built-in tools when routed
through a third-party provider. The first entry covers Claude Code pointed
at [MiniMax](https://minimaxi.com) — Anthropic's hosted `WebSearch`,
`WebFetch`, and docs-aware retrieval no-op when you swap the base URL, so
this folder ships the equivalent MCP servers (Brave Search, Exa,
Context7) along with the routing installer.

See [`agent/`](./agent/) for the per-agent convention and the full list of
agents. Today:

- [`agent/claude-code/`](./agent/claude-code/) — Claude Code + MiniMax (China) + web/docs MCP servers.
- [`agent/codex/`](./agent/codex/) — OpenAI Codex CLI + MiniMax (China) + web/docs MCP servers.
- [`agent/opencode/`](./agent/opencode/) — OpenCode + MiniMax (China) + web/docs MCP servers.

## Validation

JavaScript syntax and the Cloudflare Worker tests run automatically in GitHub
Actions. The Worker tests can also be run locally with:

```sh
node --test workers/cloudflare-vless/worker.test.mjs
```

Shell scripts under `agent/` can be syntax-checked with:

```sh
./agent/test.sh
```

The standalone deployment scripts can be checked with:

```sh
bash -n debian-13/setup.sh dujiaoka-epusdt/install.sh sing-box/install-node.sh linux-server-toolkit/server-toolkit.sh
python3 sing-box/generate-client-config.py --help
```

## License

Original work in this repository is available under the [MIT License](./LICENSE).
Third-party-derived files retain their existing notices; see
[`NOTICE.md`](./NOTICE.md) for details.
