# Proxy routing rules

This directory keeps Gemini separate from OpenAI, Claude, Perplexity,
Microsoft Copilot, and xAI Grok. A private profile can assign different exits
to those policies without sending unrelated Google or Drive traffic through an
expensive residential node.

## Design

- `sources/*.rules` are the canonical, client-neutral rules.
- `rules/quantumultx/*.list` contains generated Quantumult X outputs.
- `templates/quantumult-x.conf` is a reusable profile with one subscription URL
  placeholder and dynamic node discovery.
- Quantumult X and `convert-v2.js` policy icons come from the repository owner's
  `z-icon` collection. They use 108 px Homarr/SelfHst assets where available,
  plus exact flags and proxy-client icons from the general catalog.
- Mihomo/Clash profile generation remains in `../sub-store/convert-v2.js` instead
  of duplicating a second client implementation here.
- GOODBYEADS domain and allow outputs are merged with Cats-Team AdRules' native
  Quantumult X output by `scripts/update-ads.mjs`. The result is normalized,
  deduplicated, and filtered so GOODBYEADS allow rules take precedence over
  both block sources.
- Blackmatrix7's PrivateTracker rules are consumed by `scripts/update-pt.mjs`;
  broad keyword rules and fixed IP addresses are excluded from the generated
  Quantumult X `PT.list`.
- ByteDance and TikTok use local generated lists. Domestic ByteDance domains
  are matched first through the direct-first `WeChat` policy; TikTok follows
  with the international rules curated by Blackmatrix7. The shared
  `snssdk.com` suffix stays in ByteDance only so mainland Douyin traffic is not
  sent through the TikTok proxy policy.
- Civitai and Hugging Face use the independent proxy-first `AI Models` policy.
  Its local source covers Civitai's current and legacy first-party frontends,
  its image and model-download subdomains, and Hugging Face Hub/LFS/Xet/CDN
  endpoints. It is matched before generic CDN rules so large model downloads
  can use a cheaper high-bandwidth route.
- GitHub and Docker use small local generated lists and independent proxy-first
  policies. Their client-neutral sources are also consumed directly by
  `convert-v2.js`, avoiding duplicated Clash rule definitions.
- Exact hosts are preferred for shared Google infrastructure.
- Broad shared suffixes such as `google.com`, `googleapis.com`,
  `googleusercontent.com`, `gstatic.com`, `amazonaws.com`, and `cloudflare.com`
  are deliberately excluded.
- Google's exact Gemini App firewall hosts are routed through `Gemini`. Several
  are shared with YouTube, Maps, Google images, analytics, or ads; Quantumult X
  domain rules cannot distinguish a Gemini-initiated request from the same host
  opened elsewhere.
- YouTube uses a dedicated proxy-first policy so high-bandwidth video traffic
  can use a cheaper node instead of the general `Global Media` selection. The
  Gemini resource stays first, so its shared exact hosts keep the Gemini exit;
  remaining YouTube hosts, including video CDNs, use the YouTube policy.
- Speedtest and Ookla endpoints use a dedicated proxy-first policy instead of
  the old explicit `direct` override, so measurements can target the selected
  proxy route.
- Shared static hosts `t3.gstatic.com`, `www.gstatic.com`, and
  `ssl.gstatic.com` use the cheaper `Gemini` policy, not the more expensive
  general `AI` policy and not `reject`.

Run:

```sh
npm run build
npm run update:external
npm run check
```

## Quantumult X integration

The easiest route from a clone is:

```sh
cp proxy-rules/templates/quantumult-x.conf \
  proxy-rules/templates/quantumult-x.local.conf
```

Replace `REPLACE_WITH_YOUR_SUBSCRIPTION_URL` in the `.local.conf` copy, then
import it into Quantumult X. The local filename is ignored by Git because
subscription URLs commonly contain account credentials. When downloading the
template without cloning, make the same replacement in a private copy.

For an existing profile, add the individual resources directly:

```ini
https://raw.githubusercontent.com/silencoo/script-toolbox/main/proxy-rules/rules/quantumultx/gemini.list, tag=Gemini, update-interval=172800, opt-parser=false, enabled=true
https://raw.githubusercontent.com/silencoo/script-toolbox/main/proxy-rules/rules/quantumultx/OpenAI.list, tag=OpenAI, update-interval=172800, opt-parser=false, enabled=true
https://raw.githubusercontent.com/silencoo/script-toolbox/main/proxy-rules/rules/quantumultx/Claude.list, tag=Claude, update-interval=172800, opt-parser=false, enabled=true
https://raw.githubusercontent.com/silencoo/script-toolbox/main/proxy-rules/rules/quantumultx/OtherAI.list, tag=Other AI, update-interval=172800, opt-parser=false, enabled=true
https://raw.githubusercontent.com/silencoo/script-toolbox/main/proxy-rules/rules/quantumultx/PT.list, tag=Private Trackers, update-interval=172800, opt-parser=false, enabled=true
https://raw.githubusercontent.com/blackmatrix7/ios_rule_script/master/rule/QuantumultX/YouTube/YouTube.list, tag=YouTube, force-policy=YouTube, update-interval=172800, opt-parser=false, enabled=true
https://raw.githubusercontent.com/blackmatrix7/ios_rule_script/master/rule/QuantumultX/Speedtest/Speedtest.list, tag=Speedtest, force-policy=Speedtest, update-interval=172800, opt-parser=false, enabled=true
https://raw.githubusercontent.com/silencoo/script-toolbox/main/proxy-rules/rules/quantumultx/AIModels.list, tag=AI Models, update-interval=172800, opt-parser=false, enabled=true
https://raw.githubusercontent.com/silencoo/script-toolbox/main/proxy-rules/rules/quantumultx/ByteDance.list, tag=ByteDance, update-interval=172800, opt-parser=false, enabled=true
https://raw.githubusercontent.com/silencoo/script-toolbox/main/proxy-rules/rules/quantumultx/TikTok.list, tag=TikTok, update-interval=172800, opt-parser=false, enabled=true
https://raw.githubusercontent.com/silencoo/script-toolbox/main/proxy-rules/rules/quantumultx/GitHub.list, tag=GitHub, update-interval=172800, opt-parser=false, enabled=true
https://raw.githubusercontent.com/silencoo/script-toolbox/main/proxy-rules/rules/quantumultx/Docker.list, tag=Docker, update-interval=172800, opt-parser=false, enabled=true
```

Keep the Gemini resource above Ads and YouTube. This preserves a consistent
Gemini exit for shared exact Google hosts while routing the bulk YouTube video
traffic independently.

Do not enable the old all-in-one AI resource at the same time. Its broad Google
suffixes would overlap these isolated policies.

The public template keeps `Gemini` limited to the built-in `proxy` and
`direct` choices. A single `Residential` child policy uses narrow resource and
server tag regexes aligned with `sub-store/convert-v2.js`; it reads only the
`Primary Subscription` resource and includes residential, home, ISP,
original-route, or Chinese home-broadband nodes. `AI` references that child
policy instead of listing those nodes again. It never uses
`server-tag-regex=^.*`.

The `Residential` server regex uses
`EXCLUDE_KEYWORD1|EXCLUDE_KEYWORD2` as an exclusion example. Replace both
placeholders with real keywords and append more using `|`; a node is excluded
when its name contains any listed keyword, regardless of position. Its
positive side already recognizes residential node names. Escape regex
characters such as `[`, `]`, and `.` when they should be treated literally.
The policy also includes the built-in `proxy` choice as a normal-proxy
fallback.

Every other routing policy combines negative and positive placeholders:

```ini
server-tag-regex=(?i)^(?!.*(?:EXCLUDE_KEYWORD1|EXCLUDE_KEYWORD2)).*(?:INCLUDE_KEYWORD1|INCLUDE_KEYWORD2)
```

Replace the `EXCLUDE_` alternatives with unwanted node keywords and the
`INCLUDE_` alternatives with wanted ones. A node is added only when it contains
an include keyword and contains no exclude keyword. Leaving the placeholders
unchanged normally adds nothing. `Ad Blocking` intentionally has no server
regex because selecting a proxy node there would disable blocking.

Quantumult X policy regexes filter candidates but do not semantically
deduplicate identical endpoints across subscription resources. If a dedicated
residential subscription should take priority, change the `Residential`
policy's `resource-tag-regex` to that resource tag. Duplicates already present
inside one converted subscription must be removed by Sub-Store before import.

For the generated Quantumult X ad rules, omit `force-policy` because the file
contains both `direct` allow rules and switchable `Ad Blocking` rules:

```ini
https://raw.githubusercontent.com/silencoo/script-toolbox/main/proxy-rules/rules/quantumultx/Ads.list, tag=Ad Blocking, update-interval=172800, opt-parser=false, enabled=true
```

The repository checks both block sources every 12 hours, while the suggested
device-side interval is 48 hours to avoid repeatedly downloading the merged
list.
Use this resource instead of another full ad-domain subscription, not alongside
one, to avoid duplicate rules and unnecessary memory use.

The scheduled workflow runs every 12 hours and commits only changed generated
outputs. It deliberately avoids GOODBYEADS' force-push and workflow-history
deletion behavior.

## Upstream research

Initial coverage was compared against:

- `blackmatrix7/ios_rule_script` Gemini, OpenAI, Claude, Google, and GoogleDrive
  rules (GPL-2.0).
- `blackmatrix7/ios_rule_script` TikTok, GitHub, and Docker rules (GPL-2.0).
- Google Workspace Help's "Gemini App firewall settings" exact-host list
  (CC BY 4.0).
- Civitai's live `.com`, `.red`, `.green`, and `.tech` services, including the
  model-download redirect to `b2.civitai.com`.
- Hugging Face Hub's official download documentation, which recommends the
  `huggingface.co` and `hf.co` suffixes for Hub, LFS, Xet, and CDN traffic.
- `ddgksf2013/Filter` and the separately hosted `Ai.yaml` resource.
- `8680/GOODBYEADS` domain and allowlist outputs (MIT repository; constituent
  upstream lists retain their own licenses).
- `Cats-Team/AdRules` Quantumult X output. Its generated `main`-branch artifacts
  retain the licenses of their constituent upstream lists; see Cats-Team's
  `Source.md` and this repository's `NOTICE.md`.
- `fmz200/wool_scripts` ByteDance rules (GPL-3.0), normalized and separated
  from the local TikTok list; the long client metadata banner and policy fields
  are not copied into the generated runtime list.
- Domains observed in Quantumult X while reproducing the Gemini IP mismatch.

Review upstream licensing and retain attribution before publishing derived rule
content.

Except for the ByteDance source and generated list, original code and curated
rule material in this directory use GPL-2.0 to remain compatible with the
Blackmatrix7 source used during initial curation. See `LICENSE.GPL-2.0`.
`sources/bytedance.rules` and generated `ByteDance.list` are GPL-3.0-only; see
`LICENSE.GPL-3.0`. Generated `Ads.list` data retains applicable terms from its
GOODBYEADS and Cats-Team constituent sources. The repository-level MIT license
continues to cover unrelated original tools.
