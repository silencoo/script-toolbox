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
`direct` outbounds. Manual delay checks use Vivo's mainland China connectivity
endpoint (`http://wifi.vivo.com.cn/generate_204`), which returns an empty 204
response without consuming proxy subscription traffic.

The legacy `convert.js` operator was removed. Existing configurations should
migrate to `convert-v2.js`.
