# Changelog — agent/

## 2026-07-20 — `agent/` folder created

- New top-level folder hosting per-agent bash installers.
- Established convention (see `README.md`) for future agents: every agent
  ships `setup.sh` + `mcp.sh` + `uninstall.sh` + `README.md` + `CHANGELOG.md`.
- First agent: [`claude-code/`](./claude-code/README.md).
- Added `test.sh` — `bash -n` walker for every `*.sh` under `agent/`.