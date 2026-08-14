# Versioned pricing catalog

`agentctl pricing` keeps price provenance separate from Provider profiles and
from local Secrets. Every rate names its source, effective instant, exact model
ID, processing tier, context interval, and optional provider-profile scope.
The repository includes one explicitly versioned OpenAI GPT-5.6 snapshot; it is
never treated as a silently updating or permanently current price feed.

```bash
# The bundled snapshot covers only current GPT-5.6 Sol/Terra/Luna.
agentctl pricing init --preset openai-gpt-5.6 --yes

# Or create a fully operator-managed catalog.
agentctl pricing init --version 2026.08 --currency USD --yes

agentctl pricing set gateway-model \
  --profile work-gateway \
  --model vendor-model-2026 \
  --service-tier standard \
  --context-min-tokens 0 --context-max-tokens 272000 \
  --input 3 \
  --output 15 \
  --cache-read 0.3 \
  --cache-write 3.75 \
  --multiplier 1 \
  --effective-at 2026-08-01T00:00:00Z \
  --source "vendor price page captured 2026-08-01" \
  --yes

agentctl pricing calculate work-gateway vendor-model-2026 \
  --service-tier standard \
  --input-tokens 1000000 --output-tokens 250000 --json
```

Rates can use profile `*` as a fallback. An active exact-profile rate wins over
the wildcard; within the same scope the most recent active `effective_at`
wins. Tier matching is exact after normalizing `auto`/`default` to `standard`
and `priority` to `fast`. Context bands use total prompt tokens:

```text
context_tokens = input_tokens + cache_read_tokens + cache_write_tokens
cost = multiplier × (
  input_tokens × input_rate
  + cache_read_tokens × cache_read_rate
  + cache_write_tokens × cache_write_rate
  + output_tokens × output_rate
) / 1,000,000
```

For the bundled GPT-5.6 snapshot, 272,000 tokens is still short context and
272,001 or more selects long-context rates for the full request. Model matching
is exact and never guesses from words such as `sol`, `terra`, `luna`, or `gpt`.

Prices and multipliers are bounded decimal strings. Negative values, signs,
scientific notation, and numeric JSON values are rejected. Cost calculation
uses scaled `BigInt` fixed-point arithmetic and reports each component, total,
currency, catalog version/timestamps, rate ID, and source. Results remain
estimates because catalog provenance cannot prove a provider's final invoice.

The default catalog is `~/.config/agentctl/pricing.json` on Unix-like systems
and `%APPDATA%\agentctl\pricing.json` on Windows. It contains no credentials.
Changing it does not modify Provider profiles or generated agent config.
