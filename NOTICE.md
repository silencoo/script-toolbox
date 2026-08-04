# Third-party notices

The repository-level MIT license covers original work contributed to this
repository. It does not replace notices or licensing terms already attached to
third-party-derived files.

- `quantumult-x/resource-parser.js` retains its upstream attribution to
  KOP-XIAO/Shawn. Use and redistribution of that file remain subject to any
  applicable upstream terms.
- `proxy-rules/` contains curated rule content derived in part from
  `blackmatrix7/ios_rule_script` and is distributed under GPL-2.0 as documented
  in `proxy-rules/LICENSE.GPL-2.0`. Its generated ad-domain output combines
  `8680/GOODBYEADS` with `Cats-Team/AdRules`. GOODBYEADS is MIT licensed and
  aggregates constituent upstream lists that may retain separate terms.
  Cats-Team's `script` branch is 0BSD, while its generated `main`-branch rules
  explicitly retain the licenses of their constituent sources, including the
  terms catalogued in Cats-Team's `Source.md`. The generated `Ads.list` remains
  subject to those applicable upstream terms. Generated PT rules and the
  Sub-Store PT provider derive from Blackmatrix7's GPL-2.0 PrivateTracker list.
- Files under `userscripts/e-hentai/` were imported from `silencoo/hh_script`.
  Their source headers identify their author and mark them as MIT licensed.
- Files under `userscripts/123pan-fastlink/` were imported from a local mirror
  of Bao-qing's `123FastLink`. The userscript retains its original author
  attribution, and its GreasyFork distribution identifies it as MIT licensed.
- Files under `userscripts/sht-helper/` were imported from
  `silencoo/sht-helper`. The upstream documentation identifies the userscript
  as MIT licensed.
- `userscripts/netease-music-toolkit/netease-music-toolkit.user.js` is a
  snapshot of Cinvin's `myuserscripts` NetEase Music userscript. Its source
  header identifies Cinvin as the author and declares the MIT license.
- `userscripts/gemini-toolkit/vendor/gargantua-core.js` is a
  browser-only image-pipeline extract from GargantuaX's
  `gemini-watermark-remover`, as vendored and adapted by `silencoo/web2gem-plus`.
  The upstream MIT attribution is retained beside it in
  `vendor/LICENSE.gargantua`.
- `resources/network/adobe-blocking/` was migrated from a local Gist. The Adobe
  hosts list did not include complete upstream provenance or license metadata,
  so the repository-level MIT license does not assert rights over that list.
- Files under `agent/promptctl/advanced/claude/` were copied from
  `silencoo/claude-keysmith`. They retain their bundled MIT license and
  attribution.
- Files under `agent/promptctl/advanced/codex/` were copied from
  a local `Jia-Ethan/codex-keysmith` working tree based on source version
  `v0.1.2` (`c3f229c`), then adapted for this repository's multi-client
  Promptctl layout and explicit-`--file` prompt model. They retain their bundled
  MIT license and attribution.
- `agent/tui/dist/toolbox-tui.mjs` bundles Ink, React, Yoga, and their runtime
  dependencies. Their package names, versions, copyright notices, and license
  texts are retained in `agent/tui/dist/THIRD_PARTY_LICENSES.txt`.

External services queried by `workers/cloudflare-vless/worker.js` are operated
by their respective providers. The MIT license does not grant rights to those
services or their data.
