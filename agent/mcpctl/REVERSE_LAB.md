# Reverse-engineering MCP lab

`mcpctl` keeps the agent-side configuration portable. It does not download
licensed products, accept third-party licences, install debugger plugins, or
start a GUI application on a host. Those host prerequisites remain explicit so
restoring the Store cannot silently execute privileged installers.

## Choose a runtime pack

| Profile | Intended host | Display requirement |
| --- | --- | --- |
| `reverse-headless` | Linux static/dynamic analysis host | None |
| `reverse-debian-headless` | Debian lab with licensed IDA Pro | None |
| `reverse-gui` | Linux GUI analysis host | `DISPLAY`, normally Xvfb |
| `reverse-mobile` | Android analysis host and attached device/emulator | JADX needs `DISPLAY`; Frida does not |
| `reverse-windows` | Windows VM or Windows VPS | Virtual Windows desktop for x64dbg |
| `reverse-ghidra-headless` | Linux Ghidra automation host | None |
| `reverse-cutter` | Linux Cutter/Rizin host | `DISPLAY` |
| `browser-headless` | Linux browser automation host | None |
| `reverse-js*` | JavaScript/browser reverse host | Headed Chrome or Xvfb |
| `web-capture` | Anything Analyzer host | Desktop/Xvfb |
| `web-reverse-full` | Complete web protocol lab | Desktop/Xvfb |

The packs are composable. Start with the smallest one that contains the tools
needed for the current task so the agent is not given several overlapping
debugger and decompiler schemas at once.

After upgrading this repository, merge missing bundled definitions into an
existing personal Store and inspect the resulting plan:

```bash
mcpctl sync
mcpctl plan --target codex --profile reverse-headless
mcpctl apply --target codex --profile reverse-headless
```

Use the larger licensed Debian pack only on a host where IDA Pro and IDALib are
already installed and activated:

```bash
mcpctl apply --target codex --profile reverse-debian-headless
```

The same profiles can target `claude` or `opencode`.

## Pure Headless Debian host

`reverse-headless` enables Radare2, GDB, LLDB, PyGhidra, Frida, and isolated
Headless Playwright. Configure the host software before starting the MCP
client:

```bash
export GHIDRA_INSTALL_DIR=/opt/ghidra
export GHIDRA_MCP_PROJECT_PATH=/srv/reverse/ghidra-projects
```

`GHIDRA_MCP_PROJECT_PATH` must be absolute and writable by the unprivileged
account running the agent. PyGhidra and Playwright use stdio and require no
listening port or `DISPLAY` variable.

For the licensed IDA variant, activate IDALib using the vendor-supported
procedure, install `ida-pro-mcp`, and confirm this works as the same user that
runs the client:

```bash
idalib-mcp --stdio
```

The catalog deliberately uses IDALib instead of automating IDA's GUI. Current
`ida-pro-mcp` releases recommend the headless supervisor for new automation.

Frida's local tooling can also run without a display. Android instrumentation
additionally needs `adb` and a `frida-server` version compatible with the host
Frida installation. Attaching to a process and loading a script can alter the
target process, so keep tool approval enabled for untrusted samples.

## Linux GUI host with Xvfb

`reverse-gui` enables the Ghidra GUI bridge, Cutter/Rizin, JADX's GUI plugin,
and Burp's official MCP bridge. These integrations connect MCP stdio adapters
to applications that are already running in a graphical session.

A minimal Debian virtual display can be prepared with:

```bash
sudo apt install xvfb xauth dbus-x11 xpra
Xvfb :99 -screen 0 1920x1080x24 &
export DISPLAY=:99
```

Start the GUI applications from the same environment. Use xpra or VNC only
when a human needs to inspect the session; no physical display is required.

Configure the adapters as needed:

```bash
export GHIDRA_MCP_DIR=/opt/ghidra-mcp
export CUTTER_MCP_DIR=/opt/CutterMCP-plus
export BURP_MCP_PROXY_JAR=/opt/burp/mcp-proxy-all.jar
```

The preferred Ghidra 6.x bridge can instead be installed as the
`bridge-mcp-ghidra` command, in which case `GHIDRA_MCP_DIR` is unnecessary.
The expected application-side endpoints are:

- Ghidra: `http://127.0.0.1:8089/`
- Cutter: `http://127.0.0.1:8000`
- Burp: `http://127.0.0.1:9876`

Override Ghidra or Burp only with `GHIDRA_MCP_URL` or `BURP_MCP_URL`. Keep the
endpoint on loopback unless it is placed behind a separately authenticated
private tunnel.

JADX itself has a fully Headless CLI, but the selected `jadx-ai-mcp`
integration is a live GUI plugin. For unattended APK extraction, use the
`apktool` MCP or run JADX CLI outside MCP rather than pretending the GUI bridge
is Headless.

Rizin is represented through Cutter because the selected maintained MCP is a
Cutter plugin backed by Rizin. The Store does not advertise an unverified
standalone `rizin-mcp` command.

## Web and JavaScript protocol analysis

`reverse-js`, `reverse-js-isolated`, and `reverse-js-cloak` are mutually
exclusive runtime variants of `js-reverse-mcp`. They all provide JavaScript
source search, breakpoints, call-frame evaluation, network inspection, and
WebSocket analysis. The default variant preserves Chrome state; the isolated
variant deletes it at exit; the Cloak variant uses the optional browser binary.

Set a dedicated artifact directory before starting the client so the adapter
passes the upstream `--allowedRoots` restriction:

```bash
export JS_REVERSE_ALLOWED_ROOT=/srv/reverse/js-artifacts
mcpctl apply --target codex --profile reverse-js-isolated
```

Anything Analyzer is a GUI capture application with an embedded browser, MITM
proxy, JS hooks, and a Streamable HTTP MCP server. In its settings, enable MCP
Server authentication, retain port `23816`, copy the generated token, and then
apply the narrow capture profile:

```bash
export ANYTHING_ANALYZER_MCP_TOKEN='token-copied-from-the-app'
mcpctl apply --target codex --profile web-capture
```

The token can instead live in the encrypted
`anything_analyzer_mcp_token` Secret. The catalog URL is fixed to
`http://127.0.0.1:23816/mcp`. The current upstream implementation starts its
HTTP listener without an explicit host argument, so also deny inbound port
`23816` with the host firewall even though the MCP client uses loopback. Do not
install the Analyzer CA into a general-purpose browser profile or machine that
does not need interception.

`web-reverse-full` explicitly combines Anything Analyzer, Burp, Cloak-backed
DevTools, and JS Reverse MCP. It exposes overlapping browser and traffic tools,
so prefer a narrow profile unless one agent session really needs the whole lab.

## Command-line tools behind the MCPs

| Host CLI | Role in the lab | MCP exposure |
| --- | --- | --- |
| JADX | Dex/APK decompilation to readable Java | The selected MCP is a JADX GUI plugin |
| Apktool | Decode/rebuild resources and smali | `apktool` adapter |
| `adb` | Device transport, install, shell, and forwarding | Frida/JADX prerequisite; not a fake standalone MCP |
| `apksigner` | Verify and sign rebuilt APKs | Host build-tool prerequisite |
| Frida | Runtime instrumentation and hooks | `frida` MCP |
| Radare2 | Scriptable static/dynamic binary analysis | `radare2` MCP through `r2mcp` |

JADX is a decompiler, not the component that recompiles edited smali. A typical
authorized APK workflow is Apktool decode, edit resources/smali, Apktool
rebuild, `apksigner` sign, and `adb install`; JADX remains the readable-code
analysis view.

## Windows VM for x64dbg

Run `reverse-windows` inside a Windows VM or VPS that can start x64dbg. Install
the x64dbgMCP plugin, start its local server, install the Python bridge
dependencies, and expose the bridge script to the shell that launches the MCP
client:

```bash
export X64DBG_MCP_SCRIPT='C:/tools/x64dbgMCP/src/x64dbg.py'
export X64DBG_MCP_URL='http://127.0.0.1:8888'
```

The adapter is a Bash script, so on Windows use the toolbox and MCP client from
Git Bash, MSYS2, or another Bash environment whose Python process can reach the
Windows loopback service. A local Windows desktop, RDP session, or virtual
console is enough; a physical monitor is not needed.

Do not use Wine as the production boundary for Windows debugging. If the main
agent runs on macOS or Debian, keep x64dbg and its MCP client-side process in
the Windows VM and reach that machine through an authenticated private channel.

## Network and sample isolation

Prefer stdio servers. GUI bridge ports grant powerful access to debuggers,
browser sessions, proxy traffic, and loaded files, so they must not be directly
published with `0.0.0.0`, Docker `-p PORT:PORT`, or a public cloud firewall
rule.

When remote access is required, bind the tool to `127.0.0.1` and use an SSH
tunnel or a private Tailscale network. For example, a client-side SSH tunnel to
a Ghidra host can map a different local port without opening the remote port:

```bash
ssh -N -L 18089:127.0.0.1:8089 analyst@reverse-host
```

Run analysis under an unprivileged account, keep samples separate from the
toolbox and credentials, mount original inputs read-only where practical, and
do not auto-approve arbitrary debugger commands or Frida scripts. Burp project
files and browser profiles may contain credentials and captured traffic; keep
them outside the portable MCP Store and its backup.
