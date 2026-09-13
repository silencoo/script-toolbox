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
including nodes whose provider supplied another country flag. Leading bracketed
tags stay before the flag, for example `[kitty]🇹🇼Taiwan 03`.

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

See [custom country ordering](#custom-country-ordering) below to sort nodes in
`ios-adapter.js` or `convert-v2.js` without changing their names.

Add `add-country-flags.js` as a script operation on the individual subscription
that needs renaming. It recognizes 30 common locations across Asia, Europe, the
Americas, and Oceania from common Chinese names, English names, abbreviations,
and major city names. Existing flags are normalized rather than duplicated, and
unrecognized node names receive the neutral `🌐` icon. Existing flags for
locations outside the built-in mapping are preserved. Leading bracketed tags
stay before the icon, matching `convert-v2.js`; untagged names use `🇹🇼 Taiwan 03`.
Both batch operators update `dialer-proxy` references when renaming their targets.

## Custom country ordering

Both `ios-adapter.js` and `convert-v2.js` accept `countryorder` through
Sub-Store's script URL fragment. Set the URL in the **script operation**, keep
one `#`, and join parameters with `&`:

```text
https://raw.githubusercontent.com/silencoo/script-toolbox/refs/heads/main/sub-store/ios-adapter.js#noCache&countryorder=jp,us,hk,sg,nl,de,in
https://raw.githubusercontent.com/silencoo/script-toolbox/refs/heads/main/sub-store/convert-v2.js#noCache&countryorder=jp,us,hk,sg,nl,de,in
```

These URLs require the updated scripts to be published to `main`. To try local
changes before publishing, paste the script into Sub-Store's inline script
operation and set its arguments to `{"countryorder":"jp,us,hk,sg,nl,de,in"}`.

The example prioritizes Japan, United States, Hong Kong, Singapore, Netherlands,
Germany, then India. Codes and English names can be mixed, case-insensitively:
`countryorder=JP,us,hk,sg,Netherlands,Germany,India`. Separate entries with commas
(recommended) or `>`; spaces around entries are ignored. For multiword names
in a URL, use `%20` or underscores, e.g. `United%20States` or `United_States`.
Aliases such as `uk`, `usa`, `uae`, and `Czech Republic` are also accepted.

- Nodes are identified from their names: recognized flags take precedence,
  followed by Chinese/English names, standalone codes, and common city names.
  No GeoIP lookup or server connection is performed.
- Nodes from the same location retain their original order. Unlisted and
  unrecognized locations follow the requested ones, retaining their original
  relative order. Duplicate preferences and unknown values are ignored.
- Omit `countryorder`, leave it empty, or use `countryorder=off` to preserve the
  script's previous ordering behavior.
- The iOS adapter sorts its real output nodes and leaves its two replacement
  account-information nodes at the end. Client-side sorting or later Sub-Store
  operations can override that output order; the adapter does not edit client
  policy groups.
- The converter sorts its output nodes (including the manual, Auto, and AI
  node lists) and reorders its existing country groups and country references.
  Fixed policy entries such as Auto, Proxies, Direct, and Fallback keep their
  positions within each list. This applies to special groups too: for example,
  putting `jp` first makes Japan the first Gemini country choice. Saved client
  selections may still take precedence. URL-test groups still select by latency.
- Sorting does not change group membership or create additional country groups:
  v2's automatic country groups remain Japan, United States, Taiwan, Singapore,
  and Hong Kong. Netherlands/Germany/India and the other locations are sorted
  wherever their actual nodes appear. Dedicated `[pro]` nodes remain outside
  ordinary automatic groups.

The ordering recognizer supports these **60 countries and regions** (the
separate flag-renaming operator above still has its own 30-location mapping):

| Region | Accepted codes and English names |
| --- | --- |
| East Asia | `jp` Japan, `tw` Taiwan, `hk` Hong Kong, `kr` South Korea, `cn` China, `mo` Macau |
| Southeast Asia | `sg` Singapore, `id` Indonesia, `my` Malaysia, `th` Thailand, `vn` Vietnam, `ph` Philippines, `kh` Cambodia |
| South/Central Asia | `in` India, `pk` Pakistan, `bd` Bangladesh, `np` Nepal, `lk` Sri Lanka, `kz` Kazakhstan |
| Middle East | `ae` United Arab Emirates, `tr` Turkey, `il` Israel, `sa` Saudi Arabia |
| Europe | `de` Germany, `gb` United Kingdom, `fr` France, `nl` Netherlands, `ru` Russia, `it` Italy, `es` Spain, `ch` Switzerland, `se` Sweden, `fi` Finland, `pl` Poland, `no` Norway, `ie` Ireland, `at` Austria, `be` Belgium, `dk` Denmark, `pt` Portugal, `cz` Czechia, `hu` Hungary, `ro` Romania, `bg` Bulgaria, `gr` Greece, `ua` Ukraine, `lu` Luxembourg, `is` Iceland, `ee` Estonia, `lv` Latvia, `lt` Lithuania |
| Americas | `us` United States, `ca` Canada, `br` Brazil, `ar` Argentina, `cl` Chile, `mx` Mexico |
| Oceania | `au` Australia, `nz` New Zealand |
| Africa | `za` South Africa |

Sub-Store parses the fragment into `$arguments` before loading the script; see
the upstream [script loader](https://github.com/sub-store-org/Sub-Store/blob/master/backend/src/core/proxy-utils/index.js).
