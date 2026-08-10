# Versioned pricing catalog

`agentctl pricing` keeps price provenance separate from Provider profiles and
from local Secrets. The repository intentionally ships no supposedly-current
vendor prices: every rate must name its source, effective instant, exact model
ID, and optional provider-profile scope.

```bash
agentctl pricing init --version 2026.08 --currency USD --yes

agentctl pricing set gateway-model \
  --profile work-gateway \
  --model vendor-model-2026 \
  --input 3 \
  --output 15 \
  --cache-read 0.3 \
  --cache-write 3.75 \
  --multiplier 1 \
  --effective-at 2026-08-01T00:00:00Z \
  --source "vendor price page captured 2026-08-01" \
  --yes

agentctl pricing calculate work-gateway vendor-model-2026 \
  --input-tokens 1000000 --output-tokens 250000 --json
```

Rates can use profile `*` as a fallback. An active exact-profile rate wins over
the wildcard; within the same scope the most recent active `effective_at`
wins. Model matching is exact and never guesses from words such as `sonnet`,
`opus`, or `gpt`.

Prices and multipliers are bounded decimal strings. Negative values, signs,
scientific notation, and numeric JSON values are rejected. Cost calculation
uses scaled `BigInt` fixed-point arithmetic and reports each component, total,
currency, catalog version/timestamps, rate ID, and source. Results remain
estimates because catalog provenance cannot prove a provider's final invoice.

The default catalog is `~/.config/agentctl/pricing.json` on Unix-like systems
and `%APPDATA%\agentctl\pricing.json` on Windows. It contains no credentials.
Changing it does not modify Provider profiles or generated agent config.
