# agentproxyd

`agentproxyd` is agentctl's optional, dependency-free local forwarding process.
It is deliberately separate from the short-lived controller and never starts
or takes over an agent merely because agentctl or the TUI opens.

Use the public controller rather than invoking the daemon directly:

```bash
agentctl proxy plan work-gateway --target codex
agentctl proxy start work-gateway --target codex --yes
agentctl proxy status
agentctl proxy stop --yes
```

The current phase is native pass-through only:

| Store protocol | Local API route |
| --- | --- |
| `anthropic_messages` | `/v1/messages` |
| `openai_responses` | `/v1/responses` |
| `openai_chat` | `/v1/chat/completions` |
| `google_generative` | `/v1beta/models/:model:generateContent` and streaming variant |

The selected target must already support that protocol/authentication pair.
Protocol conversion and automatic target attachment are intentionally absent
until their independent test suites exist.

## Security boundary

- The generated config accepts only `127.0.0.1` or `::1`; no public bind option
  exists.
- Every request needs a 256-bit local capability. Its value is kept in an
  owner-only device-local file and never printed by status, plan, or token
  commands.
- The daemon removes the local capability from every supported authentication
  header and injects the real upstream Secret from the owner-only Provider
  Secret Store in memory.
- Incoming routes are allowlisted per selected protocol. The proxy is not a
  general URL forwarder.
- Request and response bodies and headers are never written to logs. JSONL
  metadata contains route, protocol, status, timing, and byte counts only.
- Provider endpoints cannot embed credentials in URL userinfo or common secret
  query parameters.
- State, config, capability, metadata, lifecycle logs, and locks are exact
  device-local paths; none belong in the portable Provider Store.

The client capability can be rotated only while the daemon is stopped:

```bash
agentctl proxy token status
agentctl proxy token rotate
agentctl proxy token rotate --yes
```

`stop` sends `SIGTERM` only after the authenticated health endpoint proves that
the PID and instance ID match. A live but unverifiable process is never killed.
Dead state and lock files can be previewed and cleaned with the same stop
command. No automatic `SIGKILL` fallback is used.

## Timeout and size controls

```bash
agentctl proxy start work-gateway --target codex \
  --first-byte-timeout-ms 30000 \
  --stream-idle-timeout-ms 120000 \
  --request-timeout-ms 300000 \
  --request-bytes 16777216 \
  --log-bytes 5242880 \
  --yes
```

The first-byte timer covers upstream response headers. SSE responses clear the
non-streaming total timer after headers and then use a separately reset idle
timer. Request-size checks use `Content-Length` when available and enforce the
same limit while streaming an unknown-length body.

Metadata rotates to one owner-only `.1` file at the configured byte threshold.
The later analytics phase may add bounded structured retention, but it will not
add content logging.
