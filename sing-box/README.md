# sing-box AnyTLS Node Toolkit

This folder contains a simple two-step workflow:

1. Deploy one AnyTLS server node and export its single-node link.
2. Compose multiple single-node links into simple and grouped sing-box client configs.

## Files

- `install-node.sh`: deploys one sing-box AnyTLS server node.
- `generate-client-config.py`: builds multi-node sing-box client configs from single-node links.
- `nodes.example.txt`: example input file for `generate-client-config.py`.

## Deploy One Node

Run this on a Linux VPS as root:

```bash
chmod +x install-node.sh
./install-node.sh
```

Non-interactive example:

```bash
./install-node.sh -y --name de-1 --host 1.2.3.4
```

Useful options:

```bash
./install-node.sh \
  --name de-1 \
  --host 1.2.3.4 \
  --port 443 \
  --sni www.apple.com
```

The script writes:

- `/etc/sing-box/config.json`: server config.
- `/root/sing-box-node.txt`: single-node `anytls://` link.
- `/root/sing-box-client.json`: client config for this one node.

Before writing the sing-box configuration, the installer checks the active TCP
congestion control. If the kernel supports BBR, it enables `bbr` with the `fq`
queue discipline immediately and persists both settings in
`/etc/sysctl.d/99-sing-box-bbr.conf`. An unsupported kernel or a restricted
container produces a warning but does not abort the node installation. Use
`--skip-bbr` to leave the host network settings untouched.

The single-node link is also printed to the console.

## Compose Multiple Nodes

Create `nodes.txt` with one single-node link per line:

```text
anytls://pass1@1.1.1.1:443?sni=www.apple.com&insecure=1#de-1
anytls://pass2@2.2.2.2:443?sni=www.apple.com&insecure=1#jp-1
anytls://pass3@hk.example.com:443?sni=www.apple.com&insecure=1#hk-1
```

Then generate multi-node client configs:

```bash
python3 generate-client-config.py --nodes nodes.txt
```

By default this writes two files:

- `sing-box-client.json`: simple proxy config.
- `sing-box-client-grouped.json`: grouped policy config.

### Simple Config

The simple config includes:

- one `anytls` outbound per node.
- one `urltest` outbound named `auto`.
- one `selector` outbound named `proxy`.
- `route.final = proxy`.
- CN/private IP routing through `direct`.
- non-CN traffic through the selected proxy node.

Generate only this config:

```bash
python3 generate-client-config.py \
  --nodes nodes.txt \
  --emit simple \
  --simple-out sing-box-client.json
```

### Grouped Config

The grouped config follows the grouping idea from the Sub-Store conversion script, without the `[pro]` group.

It includes base groups:

- `Proxies`: manual selector, default `Auto`.
- `Auto`: URL test over all nodes.
- `Fallback`: spare selector for fallback-style switching.
- `Bypass`: default `direct`, with `Proxies` as fallback.
- `Final`: final catch-all selector.

It creates region URL test groups when matching nodes exist:

- `Hong Kong`
- `Japan`
- `Taiwan`
- `United States`
- `Singapore`

Region detection is based on node names, for example `hk-1`, `Hong Kong`, `jp-1`, `Japan`, `us-1`, `United States`, `sg-1`, `Singapore`, `tw-1`, or `Taiwan`.

It also creates service selectors:

- `AI`
- `Telegram`
- `Google`
- `YouTube`
- `Meta`
- `Netflix`
- `Spotify`
- `Bilibili`
- `Steam`
- `TikTok`
- `PikPak`
- `Crypto`
- `CDN`
- `SSH(port 22)`

Generate only this config:

```bash
python3 generate-client-config.py \
  --nodes nodes.txt \
  --emit grouped \
  --grouped-out sing-box-client-grouped.json
```

Use explicit paths for both outputs:

```bash
python3 generate-client-config.py \
  --nodes nodes.txt \
  --simple-out sing-box-client-simple.json \
  --grouped-out sing-box-client-grouped.json
```

Default local proxy listener:

```text
127.0.0.1:2080
```

Change it if needed:

```bash
python3 generate-client-config.py \
  --nodes nodes.txt \
  --simple-out sing-box-client.json \
  --grouped-out sing-box-client-grouped.json \
  --listen 127.0.0.1 \
  --listen-port 2081
```

For the simple config, if you only want automatic selection and do not need a manual selector:

```bash
python3 generate-client-config.py --nodes nodes.txt --emit simple --simple-out sing-box-client.json --no-selector
```

## Input Rules

`generate-client-config.py` expects one `anytls://` link per line.

Supported:

```text
# full-line comments

anytls://password@1.2.3.4:443?sni=www.apple.com&insecure=1#de-1
```

Not supported:

```text
anytls://password@1.2.3.4:443?sni=www.apple.com&insecure=1#de-1 # inline comment
```

Inline comments are not supported because `#` is already used by the node name fragment.

## Validate Config

On a machine with sing-box installed:

```bash
sing-box check -c sing-box-client.json
sing-box check -c sing-box-client-grouped.json
```

Then run it as a client:

```bash
sing-box run -c sing-box-client.json
# or
sing-box run -c sing-box-client-grouped.json
```
