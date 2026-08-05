# Sub-Store scripts

Standalone scripts intended for use with Sub-Store.

| Script | Purpose | Raw file |
| --- | --- | --- |
| [`convert-v2.js`](./convert-v2.js) | Tag-aware profile conversion | [raw](https://raw.githubusercontent.com/silencoo/script-toolbox/main/sub-store/convert-v2.js) |
| [`ios-adapter.js`](./ios-adapter.js) | iOS compatibility operator | [raw](https://raw.githubusercontent.com/silencoo/script-toolbox/main/sub-store/ios-adapter.js) |

Use the raw URL required by your Sub-Store configuration. Review each script's
header and settings before enabling it.

`convert-v2.js` preserves subscription traffic and expiry labels in the
`Account Info` group, but converts those display-only entries to named Mihomo
`direct` outbounds. Manual delay checks use the local controller endpoint
(`127.0.0.1:9090`, or `9999` with `full=true`), so they complete without proxy
traffic or an external connectivity request.

The legacy `convert.js` operator was removed. Existing configurations should
migrate to `convert-v2.js`.
