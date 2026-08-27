# Browser Extensions

Browser extensions in this directory are standalone projects. Each extension owns its build tooling, lockfile, tests, documentation, and generated output policy.

| Extension | Description |
| --- | --- |
| [Cookie Exporter](./cookie-exporter/) | Privacy-first, per-site Cookie export for Chromium in JSON, Netscape, request-header, and CSV formats |
| [UA Switcher & Manager](./user-agent-manager/) | Manifest V3 User-Agent and Client Hints switcher with custom profiles and per-site rules |
| [SingleFile MV3](./singlefile-mv3/) | Loadable upstream SingleFile MV3 snapshot, updated through a reviewed synchronization pull request |

The SingleFile source tree is an automatically managed third-party mirror. See
[its synchronization policy](./SINGLEFILE_SYNC.md) before changing or updating
files in that directory.

