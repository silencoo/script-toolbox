# Script Toolbox

A collection of standalone proxy utilities, Cloudflare Workers, browser
userscripts, and AI agent setup scripts. Each tool lives with its own
documentation so scripts can evolve without crowding the repository root.

## Contents

| Directory | Tools |
| --- | --- |
| [`sub-store/`](./sub-store/) | Sub-Store conversion and iOS compatibility scripts |
| [`quantumult-x/`](./quantumult-x/) | Quantumult X resource parser |
| [`workers/cloudflare-vless/`](./workers/cloudflare-vless/) | VLESS subscription Worker using speed-ranked Cloudflare addresses |
| [`jpopsuki-rss-autobrr/`](./jpopsuki-rss-autobrr/) | Browser-only JPopSuki RSS creation and Autobrr management userscript |
| [`userscripts/123pan-fastlink/`](./userscripts/123pan-fastlink/) | Generate and save instant-transfer links for 123pan |
| [`userscripts/codex-quota-compass/`](./userscripts/codex-quota-compass/) | Visual Codex quota, credit, value, turn, and daily usage dashboard |
| [`userscripts/e-hentai/`](./userscripts/e-hentai/) | E-Hentai Favorites & H@H browser userscript |
| [`userscripts/gemini-session-batch-delete/`](./userscripts/gemini-session-batch-delete/) | Review, filter, and permanently delete multiple Gemini conversations |
| [`userscripts/pt-daily-opener/`](./userscripts/pt-daily-opener/) | Scheduled daily opener for Private Tracker sites |
| [`userscripts/rar-attachment-extractor/`](./userscripts/rar-attachment-extractor/) | In-browser RAR attachment extraction and preview userscript |
| [`userscripts/sht-helper/`](./userscripts/sht-helper/) | Comprehensive Sehuatang attachment, link, cloud-download, and search helper |
| [`userscripts/sehuatang-search-sorter/`](./userscripts/sehuatang-search-sorter/) | Client-side sorting and filtering for Sehuatang search results |
| [`userscripts/xsijishe-enhancer/`](./userscripts/xsijishe-enhancer/) | Responsive layout, navigation, visibility, and image controls for XSijishe |
| [`agent/`](./agent/) | Provider setup, MCP profiles, portable skill packs, and persistent-instruction management for Claude Code, Codex CLI, OpenCode, and Pi |
| [`workers/mcp-store/`](./workers/mcp-store/) | End-to-end encrypted Toolbox Workspace/Web UI for MCP profiles, skill packs, persistent prompts, and development presets |
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
| `convert.js` | `sub-store/convert.js` |
| `convert_v2.js` | `sub-store/convert-v2.js` |
| `substore-ios-adapter.js` | `sub-store/ios-adapter.js` |
| `quanx.js` | `quantumult-x/resource-parser.js` |
| `workers.js` | `workers/cloudflare-vless/worker.js` |
| `windows-wsl2/setup.ps1` | `windows-dev-setup/wsl.ps1` |
| `debian-13/setup.sh` | `debian-ai-workstation/setup.sh` |

Update any subscriptions or deployments that use the old raw URLs after this
change is merged.

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

Optionally expose those names on `PATH` with reversible repository-backed
symlinks:

```bash
./agent/install-commands.sh --prefix "$HOME/.local/bin"
./agent/install-commands.sh --prefix "$HOME/.local/bin" --yes
agentctl status all
agentctl workspace status
```

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

Shell scripts under `agent/` can be syntax-checked with:

```sh
./agent/test.sh
```

The standalone deployment scripts can be checked with:

```sh
bash -n debian-ai-workstation/setup.sh dujiaoka-epusdt/install.sh sing-box/install-node.sh linux-server-toolkit/server-toolkit.sh docker-sandboxes/sbx-manager.sh ghostty/setup.sh ghostty/ssh-terminfo.sh workstation-utils/macos/setup.sh mihomo-subscription-manager/setup.sh
./linux-server-toolkit/tests/test_init_safety.sh
./ghostty/tests/setup-test.sh
./ghostty/tests/ssh-terminfo-test.sh
./workstation-utils/tests/macos-test.sh
python3 mihomo-subscription-manager/test_manager.py
python3 sing-box/generate-client-config.py --help
node --test jpopsuki-rss-autobrr/tests/userscript.test.cjs
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
