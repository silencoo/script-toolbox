const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildFullSizeImageRpcPayload,
  buildFullSizeProbeUrls,
  classifyGeminiAssetUrl,
  decodeEscapedRpcUrl,
  extensionForMimeType,
  forEachSequential,
  fullSizeImageUrlFromRpc,
  fullSizeImageUrlsFromRpcText,
  normalizeGeneratedImageUrl,
  normalizeOriginalImageUrl,
  parseFullSizeImageRefs,
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

test("recognizes current tiered Gemini original download routes", () => {
  assert.deepEqual(
    classifyGeminiAssetUrl(
      "https://lh3.googleusercontent.com/gg-premium-dl/asset=s1024-rj",
    ),
    { original: true, download: true },
  );
  assert.deepEqual(
    classifyGeminiAssetUrl(
      "https://lh3.googleusercontent.com/rd-gg-premium/asset=s1024-rj",
    ),
    { original: true, download: false },
  );
  assert.deepEqual(
    classifyGeminiAssetUrl(
      "https://lh3.googleusercontent.com/gg-premium/asset=s1024-rj",
    ),
    { original: false, download: false },
  );
});

test("normalizes original routes without turning previews into originals", () => {
  assert.equal(
    normalizeOriginalImageUrl(
      "https://lh3.googleusercontent.com/gg-premium-dl/asset=s1024-rj",
    ),
    "https://lh3.googleusercontent.com/gg-premium-dl/asset=s0-rj",
  );
  assert.equal(
    normalizeOriginalImageUrl(
      "https://lh3.googleusercontent.com/gg-premium/asset=s1024-rj",
    ),
    "",
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

test("extracts native full-size RPC references from Gemini button metadata", () => {
  assert.deepEqual(
    parseFullSizeImageRefs(
      '185865;BardVeMetadataKey:[["r_reply","c_chat",null,"rc_candidate"]]',
      "2",
    ),
    {
      responseId: "r_reply",
      conversationId: "c_chat",
      responseCandidateId: "rc_candidate",
      imageId: "http://googleusercontent.com/image_generation_content/2",
    },
  );
});

test("builds Gemini's mode-19 full-size image RPC payload", () => {
  const refs = {
    responseId: "r_reply",
    conversationId: "c_chat",
    responseCandidateId: "rc_candidate",
    imageId: "http://googleusercontent.com/image_generation_content/0",
  };
  const payload = buildFullSizeImageRpcPayload(refs);
  assert.deepEqual(payload[0][1], [refs.imageId, 0]);
  assert.deepEqual(payload[0][3], [19, ""]);
  assert.deepEqual(payload[1], [
    "r_reply",
    "rc_candidate",
    "c_chat",
    null,
    "",
  ]);
});

test("extracts only an HTTP URL from the full-size RPC response", () => {
  assert.equal(
    fullSizeImageUrlFromRpc([
      null,
      ["https://lh3.googleusercontent.com/gg-premium-dl/full=s1024-rj"],
    ]),
    "https://lh3.googleusercontent.com/gg-premium-dl/full=s0-rj",
  );
  assert.equal(fullSizeImageUrlFromRpc(["not-a-url"]), "");
});

test("extracts escaped original URLs from the current RPC response shape", () => {
  const rpcText = String.raw`[["wrb.fr","c8o8Fe",null,null,["https:\/\/lh3.googleusercontent.com\/gg-premium\/preview=s1024-rj",["https:\/\/lh3.googleusercontent.com\/gg-premium-dl\/original=s1024-rj"]]]]`;
  assert.deepEqual(
    fullSizeImageUrlsFromRpcText(rpcText),
    [
      "https://lh3.googleusercontent.com/gg-premium-dl/original=s0-rj",
    ],
  );
  assert.equal(
    decodeEscapedRpcUrl(String.raw`https:\/\/example.com\/image\u003ds0`),
    "https://example.com/image=s0",
  );
});

test("maps supported image MIME types to stable extensions", () => {
  assert.equal(extensionForMimeType("image/png"), "png");
  assert.equal(extensionForMimeType("image/webp"), "webp");
  assert.equal(extensionForMimeType("image/jpeg"), "jpg");
});

test("processes bulk image downloads strictly one at a time", async () => {
  let active = 0;
  let maximumActive = 0;
  const completed = [];

  await forEachSequential(["first", "second", "third"], async (item) => {
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    await new Promise((resolve) => setTimeout(resolve, 2));
    completed.push(item);
    active -= 1;
  });

  assert.equal(maximumActive, 1);
  assert.deepEqual(completed, ["first", "second", "third"]);
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
