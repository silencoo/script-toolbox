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

For an official ChatGPT-subscription Codex session, use the reserved
observation profile and explicit attachment lifecycle:

```bash
agentctl proxy start passthrough --target codex --yes
agentctl proxy attach --yes
agentctl proxy detach --yes
agentctl proxy stop --yes
```

Passthrough uses the built-in Codex `openai` provider with a loopback
`openai_base_url`; HTTP and WebSocket Responses are both relayed, and the default second hop is still the official
`https://chatgpt.com/backend-api/codex` endpoint. The bearer token,
`ChatGPT-Account-ID`, model, request bytes, and response bytes are not replaced
or rewritten. Provider Secrets, aliases, failover, circuits, and replay are
disabled. HTTP `Accept-Encoding` is forwarded unchanged and compressed response
bytes are relayed unchanged; a streaming decompressor feeds only a bounded
in-memory usage observer. WebSocket extension compression is not negotiated so
the bounded frame observer can read completion usage. Frames and content are
never written to logs.

Observed token counts and the effective OpenAI `service_tier` are taken from
the official response. `priority` means Fast and `auto`/`default` mean Standard. The
response wins over the requested tier because OpenAI can downgrade ramp-limited
Fast traffic and charge Standard rates. Optional pricing catalog results remain
estimates against catalog rates; they are not a ChatGPT-subscription invoice or
quota reading.

The proxy is native pass-through only:

| Store protocol | Local API route |
| --- | --- |
| `anthropic_messages` | `/v1/messages` |
| `openai_responses` | `/v1/responses`; `/v1/responses/compact` only for a fully native-capable route |
| `openai_chat` | `/v1/chat/completions` |
| `google_generative` | `/v1beta/models/:model:generateContent` and streaming variant |

The selected target must already support that native protocol. Upstream
authentication belongs to each resolved Provider backend and can differ among
backends. Protocol conversion and automatic target attachment are absent.

Provider Store schema 2 declares compaction separately from protocol. The
proxy's generated schema 5 config opens the compact route only when every
selected backend resolves to `responses_v1` or `responses_v2` under an
`auto`/`remote` policy for Codex. A mixed or unverified failover route stays on
client-local compaction. Anthropic `anthropic-beta` and `context_management`
data pass through `/v1/messages` unchanged; the daemon never translates them
into an OpenAI request.

## Ordered failover

Create portable ordered routes with the public controller and opt into one at
proxy start:

```bash
agentctl failover init --yes
agentctl failover create daily-route \
  --profile primary --profile backup --yes
agentctl proxy start primary --target codex --route daily-route --yes
```

All profiles in a route must resolve to the same native protocol for the
selected target/platform. The default `next_request` policy does not replay a
current POST: a configured failure is returned, its circuit state is updated,
and a later request skips open backends. `--same-request-retry` is an explicit
route-creation choice and may duplicate both execution and billing.

Closed, Open, and HalfOpen state is stored in an owner-only device-local file,
survives daemon restarts, and expires by policy. Portable route exports contain
only profile names and policy. Health/status reports backend names and circuit
state, never endpoints or Secrets.

## Security boundary

- The generated config accepts only `127.0.0.1` or `::1`; no public bind option
  exists.
- Provider-mode requests need a 256-bit local capability. Its value is kept in an
  owner-only device-local file and never printed by status, plan, or token
  commands.
- The daemon removes the local capability from every supported authentication
  header and injects the real upstream Secret from the owner-only Provider
  Secret Store in memory.
- OpenAI subscription passthrough instead requires Codex's bearer on data
  routes and forwards it unchanged with the account header. The hidden
  capability remains isolated to health/control. The listener is still
  loopback-only and returns no CORS permission.
- Incoming routes are allowlisted per selected protocol. The proxy is not a
  general URL forwarder.
- Request and response bodies and headers are never written to logs. JSONL
  request metadata contains route, protocol, status, timing, and byte counts
  only. A separate usage JSONL contains exact model identities, normalized
  token counts, and estimated cost only.
- Request model aliases are exact. Anthropic/OpenAI JSON model fields and the
  Google route model component are rewritten in bounded memory; similarly
  named models are never inferred or changed.
- Subscription passthrough performs no model mapping and permits only one
  Responses backend with no retry or failover.
- Provider endpoints cannot embed credentials in URL userinfo or common secret
  query parameters.
- State, circuit counters, config, capability, metadata, lifecycle logs, and locks are exact
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

Codex attachment is never automatic. Attach writes an owner-only exact backup
and a hash-bound state file before changing only the marked top-level
`model_provider` and `openai_base_url` settings. Detach restores the prior bytes
and file mode exactly. A changed config or backup causes a safe refusal, and a
proxy with an active attachment cannot be stopped.

## Timeout and size controls

```bash
agentctl proxy start work-gateway --target codex \
  --first-byte-timeout-ms 30000 \
  --stream-idle-timeout-ms 120000 \
  --request-timeout-ms 300000 \
  --request-bytes 16777216 \
  --log-bytes 5242880 \
  --usage-log-bytes 5242880 \
  --usage-capture-bytes 2097152 \
  --retention-files 5 \
  --retention-days 30 \
  --yes
```

The first-byte timer covers upstream response headers. SSE responses clear the
non-streaming total timer after headers and then use a separately reset idle
timer. Request-size checks use `Content-Length` when available and enforce the
same limit while reading an unknown-length body. Native JSON requests are held
only within that bound so the exact model field can be rewritten, then sent
upstream; compressed request bodies are rejected.

Request and usage metadata rotate independently at their configured byte
thresholds. Active plus rotated file count and rotated-file age are both
bounded; every retained file remains owner-only.

## Usage and pricing

The bounded response collector recognizes Anthropic Messages, OpenAI
Responses, OpenAI Chat Completions, and Google Generative JSON/SSE usage. Cache
semantics remain separate: OpenAI and Google cached tokens are subtracted from
their reported total input before pricing, while Anthropic's non-cached input,
cache-read, and cache-creation counts remain distinct.

```bash
agentctl pricing status
agentctl pricing init --preset openai-gpt-5.6 --yes
agentctl proxy plan work-gateway --target codex \
  --pricing-source response
agentctl proxy usage --last 20
agentctl proxy usage --summary
agentctl proxy usage --summary --last 100 --json
```

`response` pricing uses the returned model ID when an exact active rate exists,
then falls back to the outbound request model with an explicit reason. `request`
always anchors pricing to the outbound model. Every usage row preserves
requested, outbound, response, and priced model identities plus catalog/rate
provenance. For OpenAI it also records requested, response, normalized pricing
tier, and whether the response or a fallback selected that tier. Total context
is the sum of uncached input, cache reads, and cache writes; the selected
context interval applies to the full request. A missing catalog or rate never blocks forwarding; the row records
why pricing is unavailable. Prompt and response content are not retained by
the collector or either log.

`agentctl proxy usage` reads the active owner-only usage JSONL and retained
rotation files without requiring the daemon to be running. The default view
shows the latest 20 safe projected records; `--last` accepts 1–1000.
`--summary` aggregates all retained rows unless combined with `--last`, and
reports exact token totals, priced/unpriced request counts, fixed-decimal costs
by currency, plus per-model and per-service-tier breakdowns. It also counts
requested Fast calls, effectively Fast responses, response-confirmed
downgrades, and canonical tier transitions. Unknown JSON fields are never
echoed; malformed/non-regular/symlinked or non-owner-only logs
are rejected, and total input is bounded before parsing.
