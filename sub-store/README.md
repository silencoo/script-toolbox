# Sub-Store scripts

Standalone scripts intended for use with Sub-Store.

| Script | Purpose | Raw file |
| --- | --- | --- |
| [`convert-v2.js`](./convert-v2.js) | Tag-aware profile conversion | [raw](https://raw.githubusercontent.com/silencoo/script-toolbox/main/sub-store/convert-v2.js) |
| [`ios-adapter.js`](./ios-adapter.js) | iOS compatibility operator | [raw](https://raw.githubusercontent.com/silencoo/script-toolbox/main/sub-store/ios-adapter.js) |
| [`add-country-flags.js`](./add-country-flags.js) | Add or normalize flags on one subscription's nodes | [raw](https://raw.githubusercontent.com/silencoo/script-toolbox/main/sub-store/add-country-flags.js) |

Use the raw URL required by your Sub-Store configuration. Review each script's
header and settings before enabling it.

`convert-v2.js` preserves subscription traffic and expiry labels in the
`Account Info` group, but converts those display-only entries to named Mihomo
`direct` outbounds. Manual delay checks use Vivo's mainland China connectivity
endpoint (`http://wifi.vivo.com.cn/generate_204`), which returns an empty 204
response without consuming proxy subscription traffic.

The generated DNS block uses Mihomo's `enhanced-mode` setting. Fake IP mode is
enabled by default; pass `fakeip=false` to switch it to `redir-host`. Private
names use the system resolver, domestic names use mainland encrypted resolvers,
and other names use encrypted resolvers through the `Proxies` policy. The DNS
listener defaults to `127.0.0.1:1053`; use `dnslisten=<address>:<port>` only
when another device must query this Mihomo instance.

The REST controller listens on `127.0.0.1:9090` by default (`127.0.0.1:9999`
with `full=true`). `controllerhost`, `controllerport`, and `controllersecret`
can override it. A non-loopback `controllerhost` is accepted only when
`controllersecret` is non-empty.

Country groups use URL tests by default. Pass `loadbalance=true` to use
health-checked load balancing and optionally set `loadbalancestrategy` to
`consistent-hashing`, `round-robin`, or `sticky-sessions`. URL-test intervals
can be controlled with `autotestinterval`, `countrytestinterval`, and
`fallbacktestinterval`, or together with `urltestinterval`; zero disables
periodic checks.

Generated node names are made unique and kept distinct from policy-group and
Mihomo built-in outbound names. Each ordinary node is assigned to at most one
country group. Recognized Taiwan nodes are normalized to a single `🇹🇼` flag,
including nodes whose provider supplied another country flag.

Repository validation generates both URL-test and load-balance fixtures and
checks them with the latest stable official Mihomo binary.

When a subscription contains a node server under `placudoshai.fun`, the script
automatically adds a domain-scoped Mihomo DNS policy using the provider's
`https://jeeyio.com/api/dns-query` endpoint. Other node domains continue using
the normal resolvers; the provider-specific resolver is omitted entirely for
unrelated subscriptions.

The legacy `convert.js` operator was removed. Existing configurations should
migrate to `convert-v2.js`.

## Country flags for one subscription

Add `add-country-flags.js` as a script operation on the individual subscription
that needs renaming. It recognizes 30 common locations across Asia, Europe, the
Americas, and Oceania from common Chinese names, English names, abbreviations,
and major city names. Existing flags are normalized rather than duplicated, and
unrecognized node names receive the neutral `🌐` icon. Existing flags for
locations outside the built-in mapping are preserved.
