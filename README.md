# Script Toolbox

A collection of standalone proxy utilities, Cloudflare Workers, browser
extensions and userscripts, and AI agent setup scripts. Each tool lives with its own
documentation so scripts can evolve without crowding the repository root.

## Contents

| Directory | Tools |
| --- | --- |
| [`sub-store/`](./sub-store/) | Sub-Store conversion and iOS compatibility scripts |
| [`quantumult-x/`](./quantumult-x/) | Quantumult X resource parser and node diagnostic UIActions |
| [`proxy-rules/`](./proxy-rules/) | Reusable Quantumult X profile plus generated AI and ad rules |
| [`resources/`](./resources/) | Navigable network rule sets and database diagnostic references |
| [`extensions/cookie-exporter/`](./extensions/cookie-exporter/) | Per-site Chromium Cookie export in JSON, Netscape, request-header, and CSV formats |
| [`workers/cloudflare-vless/`](./workers/cloudflare-vless/) | VLESS subscription Worker using speed-ranked Cloudflare addresses |
| [`jpopsuki-rss-autobrr/`](./jpopsuki-rss-autobrr/) | Browser-only JPopSuki RSS creation and Autobrr management userscript |
| [`userscripts/123pan-fastlink/`](./userscripts/123pan-fastlink/) | Generate and save instant-transfer links for 123pan |
| [`userscripts/codex-quota-compass/`](./userscripts/codex-quota-compass/) | Visual Codex quota, credit, value, turn, and daily usage dashboard |
| [`userscripts/e-hentai/`](./userscripts/e-hentai/) | E-Hentai Favorites & H@H browser userscript |
| [`userscripts/gemini-toolkit/`](./userscripts/gemini-toolkit/) | Keep Gemini defaults, concurrently download/export full-size images, and safely manage conversations |
| [`userscripts/linux-do/`](./userscripts/linux-do/) | Archive Linux.do topics locally or publish them to WordPress |
| [`userscripts/netease-music-toolkit/`](./userscripts/netease-music-toolkit/) | Third-party NetEase Music download, cloud-transfer, metadata, and playback toolkit |
| [`userscripts/pt-daily-opener/`](./userscripts/pt-daily-opener/) | Scheduled daily opener for Private Tracker sites |
| [`userscripts/rar-attachment-extractor/`](./userscripts/rar-attachment-extractor/) | In-browser RAR attachment extraction and preview userscript |
| [`userscripts/sht-helper/`](./userscripts/sht-helper/) | Comprehensive Sehuatang attachment, link, cloud-download, and search helper |
| [`userscripts/xsijishe-enhancer/`](./userscripts/xsijishe-enhancer/) | Responsive layout, navigation, visibility, and image controls for XSijishe |
| [`agent/`](./agent/) | Provider setup, MCP profiles, portable skill packs, and persistent-instruction management for Claude Code, Codex CLI, OpenCode, and Pi |
| [`workers/toolbox-store/`](./workers/toolbox-store/) | End-to-end encrypted Toolbox Workspace/Web UI for Provider profiles, MCP profiles, skill packs, persistent prompts, snippets, and development presets |
| [`debian-ai-workstation/`](./debian-ai-workstation/) | Debian 13 GPU development and AI workstation setup |
| [`dujiaoka-epusdt/`](./dujiaoka-epusdt/) | Dujiaoka and EPUSDT deployment stack |
| [`sing-box/`](./sing-box/) | AnyTLS node installer and client configuration generator |
| [`mihomo-subscription-manager/`](./mihomo-subscription-manager/) | Safe switching and automatic updates for complete Mihomo subscription profiles |
| [`linux-server-toolkit/`](./linux-server-toolkit/) | All-in-one Debian/Ubuntu server setup and operations toolkit |
| [`docker-sandboxes/`](./docker-sandboxes/) | Install, configure, diagnose, and launch Docker Sandboxes on macOS, Windows, and Linux |
| [`windows-dev-setup/`](./windows-dev-setup/) | Bootstrap a Windows 10/11 development workstation and manage WSL 2 |
| [`sunshine-vdd-setup/`](./sunshine-vdd-setup/SKILL.md) | Plan, configure, troubleshoot, and verify Sunshine + Moonlight setups using MTT VDD |
| [`workstation-utils/`](./workstation-utils/) | Install and explicitly uninstall profile-based everyday utilities on Windows and macOS |
| [`ghostty/`](./ghostty/) | Install Ghostty on macOS/Linux and configure SSH-safe shell integration |
| [`cf-turnstile-autoclick/`](./cf-turnstile-autoclick/) | CDP-based Chrome extension that auto-clicks Cloudflare Turnstile checkboxes |

## Raw URL changes

Moving the scripts into categories changes their GitHub raw URLs:

| Previous path | New path |
| --- | --- |
| `convert_v2.js` | `sub-store/convert-v2.js` |
| `substore-ios-adapter.js` | `sub-store/ios-adapter.js` |
| `quanx.js` | `quantumult-x/resource-parser.js` |
| `workers.js` | `workers/cloudflare-vless/worker.js` |
| `windows-wsl2/setup.ps1` | `windows-dev-setup/wsl.ps1` |
| `debian-13/setup.sh` | `debian-ai-workstation/setup.sh` |

Update any subscriptions or deployments that use the old raw URLs after this
change is merged.

The legacy `convert.js` script has been removed. Migrate existing Sub-Store
operators to `sub-store/convert-v2.js`.

## agent

Interactive setup scripts for AI coding agents. Each installer offers
protocol-compatible mainstream providers, current model presets, a custom
provider URL/key/model flow, and non-interactive flags. The same folders also
ship optional Brave Search, Exa, Context7, GitHub, and CloakBrowser-backed
Chrome DevTools MCP configuration.

From a clone, the four independent controllers are:

```bash
./agent/agentctl/agentctl
./agent/mcpctl/mcpctl
./agent/promptctl/promptctl
./agent/skillsctl/skillsctl
```

With Node.js 22+, each no-argument command opens one shared Ink 7 / React 19
dashboard on its relevant section. It shows redacted live status across the
four controller domains and provides remote-first, selective Workspace actions;
the explicit subcommands remain available for scripts and automation.

Install a minimal standalone controller runtime and expose the four commands on
`PATH` with reversible links:

```bash
./agent/install-commands.sh --prefix "$HOME/.local/bin"
./agent/install-commands.sh --prefix "$HOME/.local/bin" --yes
agentctl status all
agentctl workspace status
```

Windows PowerShell users can install the same standalone controller runtime
with native `.cmd` shims (Git for Windows/MSYS2 Bash remains the execution
backend). The installer provisions its own checksum-verified `jq.exe`:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\agent\install-commands.ps1
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\agent\install-commands.ps1 `
  -Yes -AddToPath
agentctl status all
```

The Bash installer copies the runtime to
`~/.local/share/script-toolbox/agent`; PowerShell defaults to
`%LOCALAPPDATA%\script-toolbox\agent`. Both exclude the rest of this repository
and keep working if the checkout is removed. Update the shared runtime through
any controller:

```bash
agentctl update --check
skillsctl update --yes
```

Use `./agent/install-commands.sh --link --yes` only when repository-backed
development links are preferred.

See [`agent/`](./agent/) for the per-agent convention and the full list of
agents. Today:

- [`agent/agentctl/`](./agent/agentctl/) — shared client/provider/model setup entrypoint.
- [`agent/claude-code/`](./agent/claude-code/) — Anthropic, DeepSeek, OpenRouter, MiniMax, or custom Anthropic-compatible endpoint.
- [`agent/codex/`](./agent/codex/) — OpenAI, OpenRouter, or a custom Responses-compatible endpoint.
- [`agent/opencode/`](./agent/opencode/) — Anthropic, OpenAI, Gemini, DeepSeek, OpenRouter, MiniMax, or a custom provider.
- [`agent/pi/`](./agent/pi/) — Anthropic, OpenAI, Gemini, DeepSeek, OpenRouter, MiniMax, or a custom provider through Pi's native API adapters.
- [`agent/promptctl/`](./agent/promptctl/) — persistent-instruction setup for Claude Code and Codex with direct and Agent-guided entrypoints.
- [`agent/skillsctl/`](./agent/skillsctl/) — portable skills, inherited
  frontend/backend/fullstack packs, safe target links, and encrypted recovery.

## Agent controllers

The controller entrypoints share a reversible PATH installer:

- [`agentctl`](./agent/agentctl/) installs supported clients and configures
  providers, models, and owned credentials. It also provides redacted
  human/JSON status, transactional MCP/Skills/Prompt development presets, a
  unified doctor, mutation-free provider previews, and an optional master
  Workspace recovery layer for the three encrypted content Stores.
- [`mcpctl`](./agent/mcpctl/) manages task-oriented MCP profiles.
- [`promptctl`](./agent/promptctl/) manages persistent instructions and their
  user-editable Markdown files.
- [`skillsctl`](./agent/skillsctl/) manages portable skills and focused packs
  across supported agent skill directories.

An agent can perform the Promptctl workflow by following
[`AGENT_SETUP.md`](./agent/promptctl/AGENT_SETUP.md); direct and Agent-guided
routes create the same files and owned links.

Advanced Claude and Codex deployers are kept under
[`agent/promptctl/advanced/`](./agent/promptctl/advanced/) for fixed-source
deployment, migration, hook isolation, and recovery. Promptctl belongs to the
`agent/` product family while retaining an install and uninstall lifecycle
independent from provider credentials and MCP configuration.

## Validation

JavaScript syntax and the Cloudflare Worker tests run automatically in GitHub
Actions. The Worker tests can also be run locally with:

```sh
node --test workers/cloudflare-vless/worker.test.mjs
```

Generated proxy rules can be checked with:

```sh
npm run check --prefix proxy-rules
```

The Cookie Exporter extension can be type-checked, tested, and built with:

```sh
npm ci --prefix extensions/cookie-exporter
npm run validate --prefix extensions/cookie-exporter
```

Shell scripts under `agent/` can be syntax-checked with:

```sh
./agent/test.sh
```

The standalone deployment scripts can be checked with:

```sh
bash -n debian-ai-workstation/setup.sh dujiaoka-epusdt/install.sh sing-box/install-node.sh linux-server-toolkit/server-toolkit.sh linux-server-toolkit/tools/cloudflare-ddns-ipv4.sh linux-server-toolkit/tools/vnstat-traffic-firewall.sh docker-sandboxes/sbx-manager.sh ghostty/setup.sh ghostty/ssh-terminfo.sh workstation-utils/macos/setup.sh mihomo-subscription-manager/setup.sh
./linux-server-toolkit/tests/test_init_safety.sh
./linux-server-toolkit/tests/cloudflare-ddns-test.sh
./linux-server-toolkit/tests/vnstat-traffic-firewall-test.sh
./ghostty/tests/setup-test.sh
./ghostty/tests/ssh-terminfo-test.sh
./workstation-utils/tests/macos-test.sh
python3 mihomo-subscription-manager/test_manager.py
python3 -m py_compile linux-server-toolkit/tools/user-agent-capture-server.py
python3 sing-box/generate-client-config.py --help
node --test jpopsuki-rss-autobrr/tests/userscript.test.cjs
node --test userscripts/gemini-toolkit/tests/*.test.cjs
python3 -m pytest -p no:cacheprovider -q agent/promptctl/tests
node agent/agentctl/orchestrator-client.test.mjs
python3 -m pytest agent/promptctl/advanced/claude/tests
python3 -m pytest -p no:cacheprovider -q agent/promptctl/advanced/codex/tests
```

On Windows, validate the PowerShell tools with:

```powershell
.\docker-sandboxes\tests\sbx-manager-test.ps1
.\workstation-utils\tests\windows-test.ps1
.\windows-dev-setup\tests\windows-dev-setup-test.ps1
.\windows-dev-setup\tests\wsl-test.ps1
```

## License

Original work in this repository is available under the [MIT License](./LICENSE).
Third-party-derived files retain their existing notices; see
[`NOTICE.md`](./NOTICE.md) for details.
