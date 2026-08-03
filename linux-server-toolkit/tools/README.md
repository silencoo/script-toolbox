# Companion tools

These focused tools complement `server-toolkit.sh` without being added to its
interactive menu. They keep independent command lines and are safe to inspect
or run on their own.

## Cloudflare IPv4 DDNS

`cloudflare-ddns-ipv4.sh` updates one existing Cloudflare A record. It requires
`bash`, `curl`, and `jq`; local-interface detection also uses `ip` when
available. Configuration comes from environment variables instead of values
stored in the script:

```bash
CF_RECORD_NAME=home.example.com \
IP_OVERRIDE=8.8.8.8 \
./cloudflare-ddns-ipv4.sh --dry-run

CF_API_TOKEN='...' \
CF_ZONE_ID='...' \
CF_RECORD_NAME=home.example.com \
./cloudflare-ddns-ipv4.sh
```

The API token needs DNS Write permission for the target zone. `CF_TTL=1`
selects Cloudflare's automatic TTL; otherwise use a supported numeric TTL.
`ALLOWED_PREFIXES` accepts a comma-separated allowlist such as
`198.51.,203.0.113.`.

## vnStat traffic threshold

`vnstat-traffic-firewall.sh` reports the current calendar-month usage by
default:

```bash
./vnstat-traffic-firewall.sh --limit-gb 1024 --check sum
```

`--enforce` requires root and manages only the dedicated
`TOOLBOX_VNSTAT_LIMIT` iptables chain. It preserves existing built-in policies
and unrelated rules. Preview those commands first:

```bash
sudo ./vnstat-traffic-firewall.sh \
  --limit-gb 1024 --check sum --enforce --dry-run
```

Unlike the former Gist, this tool never deletes the vnStat database or flushes
the host's firewall. A report-only run exits with status `2` when the threshold
is exceeded, making the result usable from monitoring jobs.

## User-Agent capture server

Install Flask in a virtual environment, then run the capture service on
loopback:

```bash
python3 -m venv .venv
. .venv/bin/activate
python -m pip install Flask
python user-agent-capture-server.py
```

The capture endpoints are `/test`, `/api`, and `/download/<filename>`. The
dashboard is `/`. Common credential-bearing headers are redacted before being
stored, and logs remain bounded in memory.

Listening beyond loopback requires a dashboard password:

```bash
UA_CAPTURE_ADMIN_TOKEN='use-a-long-random-value' \
python user-agent-capture-server.py --host 0.0.0.0
```

The built-in Flask server is intended for temporary diagnostics, not as a
permanent public service.
