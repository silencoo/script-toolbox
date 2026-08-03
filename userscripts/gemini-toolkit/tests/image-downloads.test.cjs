const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildFullSizeProbeUrls,
  extensionForMimeType,
  normalizeGeneratedImageUrl,
  rewriteGoogleusercontentGgToRdGg,
} = require("../gemini-toolkit.user.js");

test("normalizes Gemini preview transforms to an asset URL", () => {
  assert.equal(
    normalizeGeneratedImageUrl(
      "https://lh3.googleusercontent.com/gg/asset-token=s1024-rj?ignored=yes",
    ),
    "https://lh3.googleusercontent.com/gg/asset-token",
  );
});

test("builds live and legacy full-size probes for gg and rd-gg", () => {
  assert.deepEqual(
    buildFullSizeProbeUrls(
      "https://lh3.googleusercontent.com/gg/asset-token=s1024-rj",
    ),
    [
      "https://lh3.googleusercontent.com/gg/asset-token=s0-d-I?alr=yes",
      "https://lh3.googleusercontent.com/gg/asset-token=d-I?alr=yes",
      "https://lh3.googleusercontent.com/gg/asset-token?alr=yes",
      "https://lh3.googleusercontent.com/rd-gg/asset-token=s0-d-I?alr=yes",
      "https://lh3.googleusercontent.com/rd-gg/asset-token=d-I?alr=yes",
      "https://lh3.googleusercontent.com/rd-gg/asset-token?alr=yes",
    ],
  );
});

test("does not rewrite an existing rd-gg URL", () => {
  assert.equal(
    rewriteGoogleusercontentGgToRdGg(
      "https://lh3.googleusercontent.com/rd-gg/asset-token",
    ),
    "",
  );
});

test("maps supported image MIME types to stable extensions", () => {
  assert.equal(extensionForMimeType("image/png"), "png");
  assert.equal(extensionForMimeType("image/webp"), "webp");
  assert.equal(extensionForMimeType("image/jpeg"), "jpg");
});

test("vendored Gargantua core exposes adaptive watermark maps", async () => {
  delete globalThis.__GEMINI_WATERMARK_CORE__;
  require("../vendor/gargantua-core.js");
  const core = globalThis.__GEMINI_WATERMARK_CORE__;
  assert.equal(typeof core?.WatermarkEngine, "function");
  const engine = await core.WatermarkEngine.create();
  assert.equal((await engine.getAlphaMap(48)).length, 48 * 48);
  assert.equal((await engine.getAlphaMap("96-20260520")).length, 96 * 96);
});
