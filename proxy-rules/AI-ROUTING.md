# AI routing and CDN precedence

`sub-store/convert-v2.js` consumes `sources/openai.rules` and
`sources/claude.rules` as classical Clash rule providers. `scripts/build.mjs`
converts those same sources to `rules/quantumultx/OpenAI.list` and `Claude.list`,
with the `AI` policy embedded in every rule. Change the canonical sources and
run `npm run build` from `proxy-rules/`; do not maintain separate domain copies
in the converter or edit generated lists by hand.

## Quantumult X resource order

The template starts `[filter_remote]` with **Gemini, OpenAI, Claude**, before
Ads, other service resources, Unbreak and the broad regional/media resources.
Gemini retains its existing precedence for shared Google hosts. The AI lists
must precede broad remote allow rules as well as block/CDN rules: a `direct`
exception inside the mixed Ads resource is still a routing decision, not just
an instruction to skip blocking and continue matching.

This template does not currently load Clash's `StaticResources`, `CDNResources`
or `AdditionalCDNResources` providers. Adding a generic CDN resource to a private
profile requires placing it below these AI resources; adding domain coverage
alone does not correct an earlier competing match. Do not set `force-policy`
on the AI resources to another policy. Never set it on Ads, which intentionally
mixes `direct` and `Ad Blocking` rules.

Local filters and resource insertion settings are separate from remote-resource
ordering. This change does not alter `[filter_local]` or `inserted-resource`.
Check for local overrides or other high-priority resources when adapting an
existing profile; the file order is not a complete model of the app's rule engine.
See the [official Quantumult X sample](https://github.com/crossutility/Quantumult-X/blob/master/sample.conf)
for resource options.

## Scope of the OpenAI additions

The feature/asset domain `oaistatsig.com`, exact `cdn.openaimerge.com` host,
Cloudflare challenge endpoint and exact WorkOS login/asset endpoints are taken
from [OpenAI's network recommendations](https://help.openai.com/en/articles/9247338-network-recommendations-for-chatgpt-errors-on-web-and-apps).
They now use the same canonical source in both clients.

Shared service providers remain **exact-host exceptions**, not catch-all suffixes
for `cloudflare.com`, `workos.com`, `workoscdn.com` or `imgix.net`. Requests from
other sites to those exact shared hosts also use `AI`: hostname-only routing
cannot identify the referring application. Their other tenants keep their own
routes. The provider's firewall allowlist is not copied wholesale into a proxy
policy; generic Intercom, SendGrid, Stripe and telemetry providers are not added.

The existing Azure, Imgix, Arkose and LiveKit entries are retained unchanged.
`openaiapi-site.azureedge.net` and
`openaicom-api-bdcpf8c6d2e9atf6.z01.azurefd.net` were already present in both the
source and Quantumult X output. Keep future additions evidence-based rather
than guessing CDN domain names from a service name. `sora.chatgpt.com` is already
covered by `chatgpt.com`.

## Apply to an existing profile

Refresh the OpenAI and Claude remote rule resources **and** move their existing
entries directly after Gemini in `[filter_remote]`, before Ads and any generic
CDN resources. Updating the downloaded list does not reorder a private profile.
Keep the existing main-branch URLs, subscription credentials, node selection,
policy regexes and DNS settings. Do not replace a private profile wholesale with
the public template. A Clash client should refresh its OpenAI/Claude providers;
its existing early provider ordering is unchanged by this update.

## Regression checks

```sh
cd proxy-rules
npm run build
node --test scripts/ai-routing.test.mjs
npm run check
```

The tests verify exact source/output parity for OpenAI and Claude, representative
API/asset/session hosts, exact shared endpoints, lookalike and unrelated tenant
exclusions, enabled resource configuration, and precedence against synthetic
remote allow/block/CDN overlaps. The normal `npm test` / repository validation
workflow includes this suite. These are offline rule tests, not a live Quantumult
X traffic trace or a guarantee that a selected exit is accepted by a service.
