# Reverse-engineering MCP lab

`mcpctl` keeps agent-side configuration portable. It does not install licensed
products, debugger plugins, GUI applications, or privileged host dependencies.
Prepare those explicitly on the analysis host.

## Task profiles

| Profile | Intended work | Main servers |
| --- | --- | --- |
| `reverse-web` | JavaScript and browser analysis | Daily browser suite plus `js-reverse` |
| `reverse-native` | Local native binaries | Ghidra, IDALib, Radare2, Frida |
| `reverse-mobile` | Android applications | JADX, Apktool, Frida |
| `reverse-headless` | Display-free Linux analysis | PyGhidra, GDB, LLDB, Radare2, Headless Playwright |
| `reverse-windows` | Windows VM analysis | x64dbg and Frida |

The profile list stays task-oriented. Cutter, Burp, Anything Analyzer, alternate
JS runtimes, and other catalog servers can be enabled for one session instead
of creating another permanent profile:

```bash
mcpctl --target codex --profile reverse-native --enable cutter
mcpctl --target codex --profile reverse-web --enable burp
mcpctl --target codex --profile reverse-web --enable anything-analyzer
mcpctl --target codex --profile reverse-web --enable js-reverse-isolated
```

Servers in the same variant group replace one another. For example, enabling
`js-reverse-isolated` replaces the persistent `js-reverse` runtime inherited
by `reverse-web`.

After upgrading the toolbox, inspect a profile before applying it:

```bash
mcpctl sync
mcpctl plan --target codex --profile reverse-headless
mcpctl apply --target codex --profile reverse-headless
```

## Headless Linux

`reverse-headless` requires no display server. Configure Ghidra before starting
the MCP client:

```bash
export GHIDRA_INSTALL_DIR=/opt/ghidra
export GHIDRA_MCP_PROJECT_PATH=/srv/reverse/ghidra-projects
```

The project path must be absolute and writable by the unprivileged user running
the agent. IDALib is intentionally part of `reverse-native`, not the portable
headless preset, because it requires an activated licensed IDA Pro installation.
Enable it explicitly on a licensed headless host if needed.

## Web and JavaScript analysis

`reverse-web` inherits both daily browser entries: CloakBrowser is the default
isolated development browser, while standard Chrome DevTools can control the
user's real Chrome session. It adds persistent `js-reverse` debugging.

Restrict JS Reverse file access to a dedicated artifact directory:

```bash
export JS_REVERSE_ALLOWED_ROOT=/srv/reverse/js-artifacts
mcpctl apply --target codex --profile reverse-web
```

Anything Analyzer and Burp are powerful optional bridges. Keep their endpoints
on loopback. Anything Analyzer should retain authentication on port `23816`:

```bash
export ANYTHING_ANALYZER_MCP_TOKEN='token-copied-from-the-app'
mcpctl --target codex --profile reverse-web --enable anything-analyzer
```

Do not install an interception CA into a general-purpose browser profile.

## Android and Windows

Android instrumentation additionally needs `adb` and a `frida-server` version
compatible with the host Frida installation. JADX provides the readable-code
view; Apktool handles resource/smali decode and rebuild operations.

Run `reverse-windows` inside the Windows VM that hosts x64dbg:

```bash
export X64DBG_MCP_SCRIPT='C:/tools/x64dbgMCP/src/x64dbg.py'
export X64DBG_MCP_URL='http://127.0.0.1:8888'
```

Use Git Bash, MSYS2, or another Bash environment whose Python process can reach
the Windows loopback service.

## Isolation

Prefer stdio servers. GUI bridge ports grant access to debuggers, browser
sessions, proxy traffic, and loaded files, so never publish them directly on a
public interface. Bind to `127.0.0.1` and use an authenticated SSH tunnel or
private network when remote access is required.

Run analysis under an unprivileged account, keep original samples read-only
where practical, and do not auto-approve arbitrary debugger commands or Frida
scripts. Browser profiles, proxy captures, and project files belong outside the
portable MCP Store and its backup.
