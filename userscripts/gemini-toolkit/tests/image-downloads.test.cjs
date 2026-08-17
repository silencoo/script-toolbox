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
  generatedImageFilenameForRecord,
  imageRecordAvailability,
  isPageBlobImageUrl,
  isRetryableHttpStatus,
  isRetryableImageExportError,
  normalizeGeneratedImageUrl,
  normalizeOriginalImageUrl,
  parseFullSizeImageRefs,
  rememberGeneratedImageRecord,
  retryOperation,
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

test("recognizes Gemini's blob-backed image URLs", () => {
  assert.equal(
    isPageBlobImageUrl(
      "blob:https://gemini.google.com/0830f4bb-63a4-4af8-95f7-b3251d12248a",
    ),
    true,
  );
  assert.equal(
    isPageBlobImageUrl("https://lh3.googleusercontent.com/gg/asset"),
    false,
  );
  assert.equal(isPageBlobImageUrl("blob:https://example.com/image"), false);
});

test("builds only Gemini's native probe for a verified download route", () => {
  assert.deepEqual(
    buildFullSizeProbeUrls(
      "https://lh3.googleusercontent.com/gg/asset-token=s1024-rj",
    ),
    [],
  );
  assert.deepEqual(
    buildFullSizeProbeUrls(
      "https://lh3.googleusercontent.com/gg-premium-dl/asset-token=s1024-rj",
    ),
    [
      "https://lh3.googleusercontent.com/gg-premium-dl/asset-token=s0-d-i-rw?alr=yes",
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
    { original: false, download: false },
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
    "https://lh3.googleusercontent.com/gg-premium-dl/asset=s0-d-i-rw?alr=yes",
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
    "https://lh3.googleusercontent.com/gg-premium-dl/full=s0-d-i-rw?alr=yes",
  );
  assert.equal(fullSizeImageUrlFromRpc(["not-a-url"]), "");
});

test("extracts escaped original URLs from the current RPC response shape", () => {
  const rpcText = String.raw`[["wrb.fr","c8o8Fe",null,null,["https:\/\/lh3.googleusercontent.com\/gg-premium\/preview=s1024-rj",["https:\/\/lh3.googleusercontent.com\/gg-premium-dl\/original=s1024-rj"]]]]`;
  assert.deepEqual(
    fullSizeImageUrlsFromRpcText(rpcText),
    [
      "https://lh3.googleusercontent.com/gg-premium-dl/original=s0-d-i-rw?alr=yes",
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

test("classifies image records before an export begins", () => {
  const refs = {
    responseId: "r_reply",
    conversationId: "c_chat",
    responseCandidateId: "rc_candidate",
    imageId: "http://googleusercontent.com/image_generation_content/0",
  };
  assert.equal(imageRecordAvailability({ fullSizeRefs: refs }).ready, true);
  assert.equal(
    imageRecordAvailability({
      sourceUrl: "https://lh3.googleusercontent.com/gg-premium-dl/original",
    }).ready,
    true,
  );
  assert.deepEqual(
    imageRecordAvailability({
      sourceUrl: "https://lh3.googleusercontent.com/gg/preview",
    }),
    {
      ready: false,
      reason: "Original-size metadata is unavailable",
    },
  );
  assert.deepEqual(
    imageRecordAvailability({
      sourceUrl:
        "blob:https://gemini.google.com/0830f4bb-63a4-4af8-95f7-b3251d12248a",
    }),
    {
      ready: false,
      reason: "Original-size metadata is unavailable",
    },
  );
});

test("builds stable unique filenames from image metadata", () => {
  const record = {
    index: 7,
    attachmentIndex: 2,
    sourceUrl: "https://lh3.googleusercontent.com/gg/asset-one",
    responseId: "r_reply123456789",
    conversationId: "c_abcdef123456789",
    fullSizeRefs: {
      responseCandidateId: "rc_candidate",
      imageId: "http://googleusercontent.com/image_generation_content/2",
    },
  };
  const filename = generatedImageFilenameForRecord(record, "image/png");
  assert.match(
    filename,
    /^gemini-abcdef123456-reply12345-candidat-i02-[0-9a-f]{8}\.png$/u,
  );
  assert.equal(
    generatedImageFilenameForRecord(record, "image/png"),
    filename,
  );
  assert.equal(
    generatedImageFilenameForRecord({ ...record, index: 99 }, "image/png"),
    filename,
  );
  assert.notEqual(
    generatedImageFilenameForRecord(
      { ...record, attachmentIndex: 3, sourceUrl: `${record.sourceUrl}-two` },
      "image/png",
    ),
    filename,
  );
});

test("retains image metadata after virtualized DOM records are replaced", () => {
  const registry = new Map();
  rememberGeneratedImageRecord(registry, {
    sourceUrl: "https://lh3.googleusercontent.com/gg/captured-image",
    responseId: "",
    attachmentIndex: 1,
    conversationId: "c_chat",
    pageBlobUrl: "blob:https://gemini.google.com/captured-image",
  });
  rememberGeneratedImageRecord(registry, {
    sourceUrl: "https://lh3.googleusercontent.com/gg/captured-image",
    responseId: "r_reply",
    fullSizeRefs: {
      responseId: "r_reply",
      conversationId: "c_chat",
      responseCandidateId: "rc_candidate",
      imageId: "http://googleusercontent.com/image_generation_content/1",
    },
  });
  rememberGeneratedImageRecord(registry, {
    sourceUrl: "https://lh3.googleusercontent.com/gg/later-image",
    responseId: "r_later",
  });

  assert.equal(registry.size, 2);
  assert.equal(
    registry.get("https://lh3.googleusercontent.com/gg/captured-image")
      .discoveryIndex,
    1,
  );
  assert.equal(
    registry.get("https://lh3.googleusercontent.com/gg/captured-image")
      .fullSizeRefs.responseId,
    "r_reply",
  );
  assert.equal(
    registry.get("https://lh3.googleusercontent.com/gg/captured-image")
      .pageBlobUrl,
    "blob:https://gemini.google.com/captured-image",
  );
  assert.equal(
    registry.get("https://lh3.googleusercontent.com/gg/later-image")
      .discoveryIndex,
    2,
  );
});

test("retries only transient image failures", async () => {
  assert.equal(isRetryableHttpStatus(408), true);
  assert.equal(isRetryableHttpStatus(429), true);
  assert.equal(isRetryableHttpStatus(503), true);
  assert.equal(isRetryableHttpStatus(404), false);
  assert.equal(isRetryableImageExportError({ retryable: true }), true);
  assert.equal(isRetryableImageExportError({ retryable: false }), false);

  let attempts = 0;
  await assert.rejects(
    retryOperation(
      async () => {
        attempts += 1;
        const error = new Error("Missing metadata");
        error.retryable = false;
        throw error;
      },
      { attempts: 3, shouldRetry: isRetryableImageExportError },
    ),
    /Missing metadata/u,
  );
  assert.equal(attempts, 1);
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

test("retries a failed image operation before succeeding", async () => {
  let attempts = 0;
  const retries = [];
  const waits = [];

  const result = await retryOperation(
    async () => {
      attempts += 1;
      if (attempts < 3) throw new Error("Temporary image failure");
      return "downloaded";
    },
    {
      attempts: 3,
      onRetry: (_error, nextAttempt) => retries.push(nextAttempt),
      wait: (attempt) => waits.push(attempt),
    },
  );

  assert.equal(result, "downloaded");
  assert.equal(attempts, 3);
  assert.deepEqual(retries, [2, 3]);
  assert.deepEqual(waits, [1, 2]);
});

test("reports an image failure after the retry limit", async () => {
  let attempts = 0;

  await assert.rejects(
    retryOperation(
      async () => {
        attempts += 1;
        throw new Error("Still unavailable");
      },
      { attempts: 3 },
    ),
    /Still unavailable/u,
  );
  assert.equal(attempts, 3);
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
