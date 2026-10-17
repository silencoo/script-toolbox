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
| [`extensions/user-agent-manager/`](./extensions/user-agent-manager/) | Chromium User-Agent and Client Hints switcher with custom profiles and per-site rules |
| [`extensions/singlefile-mv3/`](./extensions/singlefile-mv3/) | Reviewed mirror of the upstream AGPL-licensed SingleFile Manifest V3 extension |
| [`workers/cloudflare-vless/`](./workers/cloudflare-vless/) | VLESS subscription Worker using speed-ranked Cloudflare addresses |
| [`jpopsuki-rss-autobrr/`](./jpopsuki-rss-autobrr/) | Browser-only JPopSuki RSS creation and Autobrr management userscript |
| [`userscripts/123pan-fastlink/`](./userscripts/123pan-fastlink/) | Generate and save instant-transfer links for 123pan |
| [`userscripts/chatgpt-checker/`](./userscripts/chatgpt-checker/) | All-in-one ChatGPT/Codex information panel with themes, display settings, quota estimates, credit values, and cycle/history analytics |
| [`userscripts/codex-quota-compass/`](./userscripts/codex-quota-compass/) | Standalone Codex analytics; its data features are integrated into ChatGPT Checker Next |
| [`userscripts/e-hentai/`](./userscripts/e-hentai/) | E-Hentai Favorites & H@H browser userscript |
| [`userscripts/gemini-toolkit/`](./userscripts/gemini-toolkit/) | Keep Gemini defaults, concurrently download/export full-size images, and safely manage conversations |
| [`userscripts/linux-do/`](./userscripts/linux-do/) | Archive Linux.do topics locally or publish them to WordPress |
| [`userscripts/netease-music/`](./userscripts/netease-music/) | Third-party NetEase Music download, cloud-transfer, metadata, and playback toolkit |
| [`userscripts/pt-daily-opener/`](./userscripts/pt-daily-opener/) | Scheduled daily opener for Private Tracker sites |
| [`userscripts/rar-attachment-extractor/`](./userscripts/rar-attachment-extractor/) | In-browser RAR attachment extraction and preview userscript |
| [`userscripts/sht-helper/`](./userscripts/sht-helper/) | Comprehensive Sehuatang attachment, link, cloud-download, and search helper |
| [`userscripts/xsijishe-enhancer/`](./userscripts/xsijishe-enhancer/) | Responsive layout, navigation, visibility, and image controls for XSijishe |
| [`agent/`](./agent/) | Provider setup, MCP profiles, portable skill packs, and persistent-instruction management for Claude Code, Codex CLI, OpenCode, and Pi |
| [`workers/toolbox-store/`](./workers/toolbox-store/) | End-to-end encrypted Toolbox Workspace/Web UI for Provider profiles, MCP profiles, skill packs, persistent prompts, snippets, and development presets |
| [`debian-ai-workstation/`](./debian-ai-workstation/) | Debian 13 GPU development and AI workstation setup |
| [`dujiaoka-epusdt/`](./dujiaoka-epusdt/) | Dujiaoka and EPUSDT deployment stack |
| [`sing-box/`](./sing-box/) | AnyTLS node installer and client configuration generator |
| [`mihomo-console/`](./mihomo-console/) | TUI, diagnostics, backups, safe automatic updates, and Docker/NAS deployment for complete Mihomo profiles |
| [`server-toolkit/`](./server-toolkit/) | All-in-one Debian/Ubuntu server setup and operations toolkit |
| [`docker-sandboxes/`](./docker-sandboxes/) | Install, configure, diagnose, and launch Docker Sandboxes on macOS, Windows, and Linux |
| [`sunshine-vdd/`](./sunshine-vdd/SKILL.md) | Plan, configure, troubleshoot, and verify Sunshine + Moonlight setups using MTT VDD |
| [`workstation/`](./workstation/) | Set up desktop applications and utilities on Debian 13, Windows, and macOS; Windows developer/WSL menu, macOS profile menu and Zsh/Ghostty setup, and utility uninstall menus |
| [`turnstile-autoclick/`](./turnstile-autoclick/) | CDP-based Chrome extension that auto-clicks Cloudflare Turnstile checkboxes |

## Raw URL changes

Moving the scripts into categories changes their GitHub raw URLs:

| Previous path | New path |
| --- | --- |
| `convert_v2.js` | `sub-store/convert-v2.js` |
| `substore-ios-adapter.js` | `sub-store/ios-adapter.js` |
| `quanx.js` | `quantumult-x/resource-parser.js` |
| `workers.js` | `workers/cloudflare-vless/worker.js` |
| `windows-wsl2/setup.ps1` | `workstation/windows/wsl.ps1` |
| `windows-dev-setup/setup.ps1` | `workstation/windows/developer.ps1` (or the unified `windows/setup.ps1` menu) |
| `windows-dev-setup/wsl.ps1` | `workstation/windows/wsl.ps1` |
| `debian-13/setup.sh` | `debian-ai-workstation/setup.sh` |
| `ghostty/setup.sh` | `workstation/shared/ghostty-setup.sh` |
| `ghostty/ssh-terminfo.sh` | `workstation/shared/ghostty-ssh-terminfo.sh` |
| `cf-turnstile-autoclick/` | `turnstile-autoclick/` |
| `workstation-utils/` | `workstation/` |
| `linux-server-toolkit/` | `server-toolkit/` |
| `sunshine-vdd-setup/` | `sunshine-vdd/` |
| `userscripts/chatgpt-checker-next/` | `userscripts/chatgpt-checker/` |
| `userscripts/netease-music-toolkit/` | `userscripts/netease-music/` |

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

Applying the installer also initializes the private local Provider, Failover,
Pricing, MCP, and Skills Stores. The same idempotent setup runs when the TUI
starts, or can be requested explicitly with `agentctl bootstrap --yes`. It
does not select a Provider, enable MCP/Skills, write Agent configuration, or
create a remote Workspace; local Store data is retained if the commands are
uninstalled.

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

CI and local checks use the same component runner. Each validation workflow has
path filters; a server-toolkit change runs its Linux suite, while agent and
workstation changes retain their platform checks. Superseded runs are cancelled.
No workflow is dispatched by the local commands below.

```sh
python3 scripts/validate.py --help
python3 scripts/validate.py server-toolkit --install
python3 scripts/validate.py agent --install
python3 scripts/validate.py proxy-rules --install
```

`--install` runs `npm ci` and installs the component's Python test dependencies
into the active Python environment. Use a virtual environment for local Python
packages. Omit it once dependencies are installed. Requirements: Python 3.10+,
Node.js 22+, npm; Bash 4+ for server-toolkit; jq for agent tests; zsh for server,
workstation and Docker sandbox shell tests. Put your newer Bash first in `PATH`
on macOS; agent tests continue to support the system Bash 3.2.

| Component | Checks |
| --- | --- |
| `server-toolkit` | All `test*.py` unit tests, `test_*.sh` and `*-test.sh` safety suites, shell syntax |
| `agent` | TUI build, discovered shell/Node tests, Promptctl Python tests; Windows installer/Git Bash checks on Windows |
| `docker-sandboxes` | Discovered Bash/Zsh or PowerShell tests for the current platform |
| `workstation` | Shell/Python tests on Unix; PowerShell 5.1 and 7 tests on Windows |
| `extensions` | Cookie Exporter, Aria Relay and User Agent Manager validation; SingleFile unit tests |
| `userscripts` | Userscripts, JPopSuki, Turnstile and ChatGPT checker tests; SHT Helper build check |
| `linux-do` | Playwright privacy tests; `--install` also installs Chromium |
| `proxy-rules` | Quantumult X UIActions, generated rules, ad safety and routing order |
| `sub-store` | Node syntax and discovered conversion tests |
| `mihomo-console` | Python suite; add `--containers` for Docker Compose checks |
| `sing-box` | Shell syntax and discovered Python tests |
| `cloudflare-vless`, `toolbox-store` | Worker tests and local build validation; no deployment |
| `sunshine-vdd` | PowerShell tests on Windows |
| `misc` | Standalone installer syntax and validation-runner regressions |

Node discovery includes `*.test.mjs`, `*.test.cjs`, `*.test.js` and `test.mjs`,
excluding dependencies/build output. Package test commands discover TypeScript
tests. SingleFile's browser E2E suite remains an explicit optional check; see its
README. Linux.do browser tests have a separate path-filtered workflow. CI additionally downloads a checksum-verified Mihomo test binary for
Sub-Store/config integration. Locally, set `MIHOMO_TEST_BINARY` to an installed
Mihomo executable to enable the Console's live-core tests.

Path filters reduce CI cost; they do not make `main` a tested-release channel.
Raw URLs and agent updates still consume `main`. A `[skip ci]` commit bypasses
validation and should include its local verification in the commit description.

## License

Original work in this repository is available under the [MIT License](./LICENSE).
Third-party-derived files retain their existing notices; see
[`NOTICE.md`](./NOTICE.md) for details.
