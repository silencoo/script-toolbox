# Third-party notices

The repository-level MIT license covers original work contributed to this
repository. It does not replace notices or licensing terms already attached to
third-party-derived files.

- `quantumult-x/resource-parser.js` retains its upstream attribution to
  KOP-XIAO/Shawn. Use and redistribution of that file remain subject to any
  applicable upstream terms.
- Files under `userscripts/e-hentai/` were imported from `silencoo/hh_script`.
  Their source headers identify their author and mark them as MIT licensed.
- Files under `userscripts/123pan-fastlink/` were imported from a local mirror
  of Bao-qing's `123FastLink`. The userscript retains its original author
  attribution, and its GreasyFork distribution identifies it as MIT licensed.
- Files under `userscripts/sht-helper/` were imported from
  `silencoo/sht-helper`. The upstream documentation identifies the userscript
  as MIT licensed.
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
