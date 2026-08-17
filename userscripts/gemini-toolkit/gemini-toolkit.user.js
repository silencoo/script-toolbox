// ==UserScript==
// @name         Gemini Toolkit: Defaults, Images & Conversations
// @namespace    https://gemini.google.com/
// @version      0.7.4
// @description  Keep Gemini defaults, download generated images, export full-size images individually, and safely manage conversations.
// @author       silencoo
// @match        https://gemini.google.com/*
// @run-at       document-start
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      lh3.googleusercontent.com
// @connect      *.googleusercontent.com
// @require      https://raw.githubusercontent.com/silencoo/script-toolbox/main/userscripts/gemini-toolkit/vendor/gargantua-core.js
// @noframes
// ==/UserScript==

(async () => {
  "use strict";

  const RPC = Object.freeze({
    listConversations: "MaZiqc",
    deleteConversation: "GzXR5e",
    getFullSizeImage: "c8o8Fe",
  });
  const PAGE_SIZE = 20;
  const MAX_PAGES_PER_GROUP = 500;
  const HOST_ID = "gemini-toolkit-userscript";
  const FULL_SIZE_BUTTON_SELECTOR =
    'button[aria-label="Download full size image"]';
  const IMAGE_EXPORT_DOWNLOAD_DELAY = 750;
  const IMAGE_EXPORT_MAX_ATTEMPTS = 3;
  const IMAGE_EXPORT_RETRY_DELAY = 900;
  const IMAGE_CAPTURE_DELAY = 80;
  const FULL_SIZE_REDIRECT_HOPS = 10;
  const NATIVE_WATERMARK_INTENT_TTL = 60_000;
  const CORNER_CROP_EDGE = 384;
  const MODE_BUTTON_SELECTOR =
    '[data-test-id="bard-mode-menu-button"]';
  const MODE_MENU_SELECTOR = 'gem-menu[role="menu"]';
  const MODE_ITEM_SELECTOR = 'gem-menu-item[role="menuitem"]';
  const PROMPT_INPUT_SELECTORS = Object.freeze([
    '[data-test-id="textarea-wrapper"] [contenteditable="true"][role="textbox"]',
    'rich-textarea [contenteditable="true"][role="textbox"]',
    'textarea[aria-label]',
  ]);
  const MODE_APPLY_TIMEOUT = 2_500;
  const SETTINGS = Object.freeze({
    model: "gemini-toolkit-default-model",
    thinking: "gemini-toolkit-default-thinking",
    removeWatermark: "gemini-toolkit-remove-image-watermark",
  });

  function normalizeGeneratedImageUrl(value) {
    const raw = String(value || "").trim();
    if (!raw) {
      return "";
    }
    try {
      const parsed = new URL(raw);
      parsed.search = "";
      parsed.hash = "";
      parsed.pathname = parsed.pathname.replace(/=[^/=]+$/u, "");
      return parsed.toString().replace(/\/$/u, "");
    } catch {
      return raw
        .replace(/[?#].*$/u, "")
        .replace(/=[^/=]+$/u, "")
        .replace(/\/$/u, "");
    }
  }

  function rewriteGoogleusercontentGgToRdGg(value) {
    const raw = String(value || "").trim();
    if (!raw || raw.includes("/rd-gg/") || !raw.includes("/gg/")) {
      return "";
    }
    return raw.replace("/gg/", "/rd-gg/");
  }

  function classifyGeminiAssetUrl(value) {
    try {
      const parsed = new URL(String(value || ""));
      if (
        parsed.hostname !== "googleusercontent.com" &&
        !parsed.hostname.endsWith(".googleusercontent.com")
      ) {
        return null;
      }
      const segment = parsed.pathname.split("/").filter(Boolean)[0] || "";
      const transform =
        parsed.pathname.match(/=([^/=]+)$/u)?.[1]
          ?.split("-")
          .map((part) => part.toLocaleLowerCase()) || [];
      const hasDownloadTransform =
        transform.includes("d") &&
        (transform.length === 1 || transform.includes("i"));
      if (segment.startsWith("rd-")) {
        const download = segment.endsWith("-dl") || hasDownloadTransform;
        return { original: download, download };
      }
      if (segment === "gg") {
        return {
          original: hasDownloadTransform,
          download: hasDownloadTransform,
        };
      }
      if (!segment.startsWith("gg-")) return null;
      const variant = segment.slice(3);
      const download =
        variant === "dl" ||
        variant.endsWith("-dl") ||
        hasDownloadTransform;
      return { original: download, download };
    } catch {
      return null;
    }
  }

  function isPageBlobImageUrl(value) {
    try {
      const parsed = new URL(String(value || ""));
      return (
        parsed.protocol === "blob:" &&
        parsed.origin === "https://gemini.google.com"
      );
    } catch {
      return false;
    }
  }

  function geminiAssetIdentity(value) {
    try {
      const parsed = new URL(String(value || ""));
      if (
        parsed.hostname !== "googleusercontent.com" &&
        !parsed.hostname.endsWith(".googleusercontent.com")
      ) {
        return "";
      }
      const segments = parsed.pathname.split("/").filter(Boolean);
      if (!/^(?:gg(?:-|$)|rd-)/u.test(segments[0] || "")) return "";
      return segments.slice(1).join("/").replace(/=[^/=]+$/u, "");
    } catch {
      return "";
    }
  }

  function takeNativeWatermarkIntent(
    intents,
    responseUrl,
    now = Date.now(),
  ) {
    if (!Array.isArray(intents) || intents.length === 0) return null;
    for (let index = intents.length - 1; index >= 0; index -= 1) {
      if (
        now - Number(intents[index]?.createdAt || 0) >
        NATIVE_WATERMARK_INTENT_TTL
      ) {
        intents.splice(index, 1);
      }
    }
    if (intents.length === 0) return null;

    const responseIdentity = geminiAssetIdentity(responseUrl);
    let matchIndex = responseIdentity
      ? intents.findIndex(
          (intent) => intent.assetIdentity === responseIdentity,
        )
      : -1;
    if (
      matchIndex < 0 &&
      classifyGeminiAssetUrl(responseUrl)?.original === true
    ) {
      matchIndex = 0;
    }
    return matchIndex >= 0 ? intents.splice(matchIndex, 1)[0] : null;
  }

  function normalizeOriginalImageUrl(value) {
    if (classifyGeminiAssetUrl(value)?.original !== true) return "";
    try {
      const parsed = new URL(String(value));
      parsed.hash = "";
      parsed.search = "";
      parsed.pathname = `${parsed.pathname.replace(/=[^/=]+$/u, "")}=s0-d-i-rw`;
      parsed.searchParams.set("alr", "yes");
      return parsed.toString();
    } catch {
      return "";
    }
  }

  function decodeEscapedRpcUrl(value) {
    return String(value || "")
      .trim()
      .replace(/\\u003d/giu, "=")
      .replace(/\\u0026/giu, "&")
      .replace(/\\u0025/giu, "%")
      .replace(/\\\\\//gu, "/")
      .replace(/\\\//gu, "/");
  }

  function fullSizeImageUrlsFromRpcText(value) {
    const pattern =
      /https:(?:(?:\\\\\/)|(?:\\\/)|\/){2}[^\s"'\]]*googleusercontent\.com(?:(?:\\\\\/)|(?:\\\/)|\/)[^\s"'\]]+/giu;
    const urls = [];
    for (const match of String(value || "").matchAll(pattern)) {
      const normalized = normalizeOriginalImageUrl(
        decodeEscapedRpcUrl(match[0]),
      );
      if (normalized && !urls.includes(normalized)) urls.push(normalized);
    }
    return urls;
  }

  function buildFullSizeProbeUrls(value) {
    const nativeDownloadUrl = normalizeOriginalImageUrl(value);
    return nativeDownloadUrl ? [nativeDownloadUrl] : [];
  }

  function parseFullSizeImageRefs(value, imageIndex = 0) {
    const jslog = String(value || "").replace(/&quot;/gu, '"');
    const match = jslog.match(
      /\[\["(r_[^"]+)","(c_[^"]+)",null,"(rc_[^"]+)"/u,
    );
    if (!match) return null;
    const index = Math.max(0, Number.parseInt(String(imageIndex), 10) || 0);
    return {
      responseId: match[1],
      conversationId: match[2],
      responseCandidateId: match[3],
      imageId: `http://googleusercontent.com/image_generation_content/${index}`,
    };
  }

  function buildFullSizeImageRpcPayload(refs) {
    return [
      [
        [null, null, null, [null, null, null, null, null, ""]],
        [refs.imageId, 0],
        null,
        [19, ""],
        null,
        null,
        null,
        null,
        null,
        "",
      ],
      [
        refs.responseId,
        refs.responseCandidateId,
        refs.conversationId,
        null,
        "",
      ],
      1,
      0,
      1,
    ];
  }

  function fullSizeImageUrlFromRpc(value) {
    return fullSizeImageUrlsFromRpcText(JSON.stringify(value))[0] || "";
  }

  function extensionForMimeType(value) {
    const type = String(value || "").toLocaleLowerCase();
    if (type.includes("png")) return "png";
    if (type.includes("webp")) return "webp";
    if (type.includes("gif")) return "gif";
    return "jpg";
  }

  class ImageDownloadError extends Error {
    constructor(
      message,
      { retryable = false, status = 0, code = "", cause } = {},
    ) {
      super(message);
      this.name = "ImageDownloadError";
      this.retryable = Boolean(retryable);
      this.status = Number(status) || 0;
      this.code = code;
      if (cause !== undefined) this.cause = cause;
    }
  }

  function isRetryableHttpStatus(status) {
    const value = Number(status) || 0;
    return value === 408 || value === 429 || value >= 500;
  }

  function isRetryableImageExportError(error) {
    if (!error || error.name === "AbortError") return false;
    if (typeof error.retryable === "boolean") return error.retryable;
    if (error instanceof TypeError) return true;
    return isRetryableHttpStatus(error.status);
  }

  function imageRecordAvailability(record) {
    const refs = record?.fullSizeRefs;
    if (
      refs?.responseId &&
      refs?.conversationId &&
      refs?.responseCandidateId &&
      refs?.imageId
    ) {
      return { ready: true, reason: "Original-size metadata available" };
    }
    if (classifyGeminiAssetUrl(record?.sourceUrl)?.original === true) {
      return { ready: true, reason: "Original-size asset available" };
    }
    return {
      ready: false,
      reason: "Original-size metadata is unavailable",
    };
  }

  function stableStringHash(value) {
    let hash = 0x811c9dc5;
    for (const character of String(value || "")) {
      hash ^= character.codePointAt(0);
      hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(16).padStart(8, "0");
  }

  function generatedImageFilenameForRecord(
    record,
    mimeType,
    fallbackConversationId = "",
  ) {
    const refs = record?.fullSizeRefs || {};
    const conversation = String(
      record?.conversationId || refs.conversationId || fallbackConversationId,
    )
      .replace(/^c_/u, "")
      .replace(/[^a-z0-9_-]/giu, "")
      .slice(0, 12) || "conversation";
    const response = String(record?.responseId || refs.responseId || "")
      .replace(/^r_/u, "")
      .replace(/[^a-z0-9_-]/giu, "")
      .slice(0, 10) || "image";
    const candidate = String(refs.responseCandidateId || "")
      .replace(/^rc_/u, "")
      .replace(/[^a-z0-9_-]/giu, "")
      .slice(0, 8) || "candidate";
    const attachmentMatch = String(
      record?.attachmentIndex ?? refs.imageId ?? "",
    ).match(/(\d+)$/u);
    const attachment = String(
      Math.max(0, Number.parseInt(attachmentMatch?.[1] || "0", 10)),
    ).padStart(2, "0");
    const fingerprint = stableStringHash(
      `${record?.sourceUrl || ""}|${refs.responseCandidateId || ""}|${refs.imageId || ""}`,
    ).slice(0, 8);
    return `gemini-${conversation}-${response}-${candidate}-i${attachment}-${fingerprint}.${extensionForMimeType(mimeType)}`;
  }

  function rememberGeneratedImageRecord(registry, record) {
    if (!(registry instanceof Map) || !record?.sourceUrl) return null;
    const existing = registry.get(record.sourceUrl);
    const remembered = {
      sourceUrl: record.sourceUrl,
      responseId: record.responseId || existing?.responseId || "",
      fullSizeRefs: record.fullSizeRefs
        ? { ...record.fullSizeRefs }
        : existing?.fullSizeRefs || null,
      attachmentIndex:
        record.attachmentIndex ?? existing?.attachmentIndex ?? 0,
      conversationId:
        record.conversationId || existing?.conversationId || "",
      pageBlobUrl:
        record.pageBlobUrl || existing?.pageBlobUrl || "",
      discoveryIndex: existing?.discoveryIndex || registry.size + 1,
    };
    registry.set(record.sourceUrl, remembered);
    return remembered;
  }

  async function forEachSequential(items, callback) {
    for (const [index, item] of items.entries()) {
      await callback(item, index);
    }
  }

  async function retryOperation(
    operation,
    {
      attempts = 3,
      shouldRetry = () => true,
      onRetry = () => {},
      wait = async () => {},
    } = {},
  ) {
    const maximumAttempts = Math.max(1, Number(attempts) || 1);
    let lastError;

    for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
      try {
        return await operation(attempt);
      } catch (error) {
        lastError = error;
        if (
          error?.name === "AbortError" ||
          attempt === maximumAttempts ||
          !shouldRetry(error)
        ) {
          throw error;
        }
        onRetry(error, attempt + 1);
        await wait(attempt, error);
      }
    }

    throw lastError;
  }

  function normalizeModeLabel(value) {
    return String(value || "").replace(/\s+/gu, " ").trim();
  }

  function modelLabelMatches(label, preference) {
    const normalized = normalizeModeLabel(label).toLocaleLowerCase();
    if (preference === "keep") {
      return true;
    }
    if (preference === "pro") {
      return /(?:^|\s)pro(?:\s|$)/u.test(normalized);
    }
    if (preference === "flash-lite") {
      return normalized.includes("flash-lite");
    }
    if (preference === "flash") {
      return (
        /(?:^|\s)flash(?:\s|$)/u.test(normalized) &&
        !normalized.includes("flash-lite")
      );
    }
    return false;
  }

  function modeLabelHasExtended(label) {
    return /(?:^|\s)extended(?:\s|$)/iu.test(
      normalizeModeLabel(label),
    );
  }

  function modeFocusRestorePlan(currentFocusKind, canRestorePrevious) {
    if (currentFocusKind !== "neutral" && currentFocusKind !== "mode") {
      return "none";
    }
    return canRestorePrevious ? "previous" : "prompt";
  }

  if (
    typeof document === "undefined" &&
    typeof module === "object" &&
    module?.exports
  ) {
    module.exports = {
      buildFullSizeImageRpcPayload,
      buildFullSizeProbeUrls,
      classifyGeminiAssetUrl,
      decodeEscapedRpcUrl,
      extensionForMimeType,
      forEachSequential,
      fullSizeImageUrlFromRpc,
      fullSizeImageUrlsFromRpcText,
      geminiAssetIdentity,
      generatedImageFilenameForRecord,
      imageRecordAvailability,
      isRetryableHttpStatus,
      isRetryableImageExportError,
      isPageBlobImageUrl,
      modelLabelMatches,
      modeFocusRestorePlan,
      modeLabelHasExtended,
      normalizeModeLabel,
      normalizeGeneratedImageUrl,
      normalizeOriginalImageUrl,
      parseFullSizeImageRefs,
      rememberGeneratedImageRecord,
      retryOperation,
      rewriteGoogleusercontentGgToRdGg,
      takeNativeWatermarkIntent,
    };
    return;
  }

  const pageWindow =
    typeof unsafeWindow === "undefined" ? window : unsafeWindow;
  const generatedImageSourceByBlob = new WeakMap();
  const generatedImageSourceByObjectUrl = new Map();
  const pendingNativeWatermarkDownloads = [];
  let nativeDownloadResponseHookInstalled = false;

  async function maybeRemoveNativeDownloadWatermark(responseUrl, blob) {
    const type = String(blob?.type || "").toLocaleLowerCase();
    if (
      type &&
      !type.startsWith("image/") &&
      type !== "application/octet-stream"
    ) {
      return blob;
    }
    const intent = takeNativeWatermarkIntent(
      pendingNativeWatermarkDownloads,
      responseUrl,
    );
    if (!intent) return blob;

    setImageToast("Removing the watermark from Gemini's full-size image…");
    try {
      const processed = await removeWatermarkFromImageBlob(blob);
      setImageToast(
        processed.removed
          ? "Full-size image downloaded with the watermark removed."
          : "Full-size image downloaded; no supported watermark was detected.",
      );
      return processed.blob;
    } catch (error) {
      console.warn(
        "[Gemini Toolkit] Native full-size watermark removal failed",
        error,
      );
      setImageToast(
        "The full-size image was downloaded, but watermark removal failed.",
        true,
      );
      return blob;
    }
  }

  function installGeneratedImageSourceCapture() {
    // Gemini now fetches generated assets and exposes only blob: URLs in the
    // DOM. Preserve the response-to-object-URL relationship before it is lost.
    const responsePrototype = pageWindow.Response?.prototype;
    const originalResponseBlob = responsePrototype?.blob;
    if (typeof originalResponseBlob === "function") {
      try {
        responsePrototype.blob = async function (...args) {
          const blob = await Reflect.apply(originalResponseBlob, this, args);
          const responseUrl = String(this?.url || "");
          if (classifyGeminiAssetUrl(responseUrl)) {
            generatedImageSourceByBlob.set(blob, responseUrl);
          }
          const downloadBlob = await maybeRemoveNativeDownloadWatermark(
            responseUrl,
            blob,
          );
          if (
            downloadBlob !== blob &&
            classifyGeminiAssetUrl(responseUrl)
          ) {
            generatedImageSourceByBlob.set(downloadBlob, responseUrl);
          }
          return downloadBlob;
        };
        nativeDownloadResponseHookInstalled = true;
      } catch (error) {
        console.warn(
          "[Gemini Toolkit] Could not observe image response blobs",
          error,
        );
      }
    }

    const originalCreateObjectURL = pageWindow.URL?.createObjectURL;
    if (typeof originalCreateObjectURL === "function") {
      try {
        pageWindow.URL.createObjectURL = function (object) {
          const objectUrl = Reflect.apply(
            originalCreateObjectURL,
            this,
            [object],
          );
          const sourceUrl = generatedImageSourceByBlob.get(object);
          if (sourceUrl) {
            generatedImageSourceByObjectUrl.set(objectUrl, sourceUrl);
          }
          return objectUrl;
        };
      } catch (error) {
        console.warn(
          "[Gemini Toolkit] Could not observe image object URLs",
          error,
        );
      }
    }

    const originalRevokeObjectURL = pageWindow.URL?.revokeObjectURL;
    if (typeof originalRevokeObjectURL === "function") {
      try {
        pageWindow.URL.revokeObjectURL = function (objectUrl) {
          generatedImageSourceByObjectUrl.delete(String(objectUrl || ""));
          return Reflect.apply(originalRevokeObjectURL, this, [objectUrl]);
        };
      } catch (error) {
        console.warn(
          "[Gemini Toolkit] Could not observe revoked image URLs",
          error,
        );
      }
    }
  }

  installGeneratedImageSourceCapture();

  if (document.readyState === "loading") {
    await new Promise((resolve) => {
      document.addEventListener("DOMContentLoaded", resolve, { once: true });
    });
  }
  const dateFormatter = new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });

  let requestId = Math.floor(Math.random() * 900_000) + 100_000;
  let modeApplyTimer = 0;
  let applyingModeDefaults = false;
  let manualModeOverride = false;
  let lastLocationKey = `${pageWindow.location.pathname}${pageWindow.location.search}`;

  function readSetting(key, fallback, allowedValues) {
    try {
      const value =
        typeof GM_getValue === "function"
          ? GM_getValue(key, fallback)
          : fallback;
      return allowedValues.includes(value) ? value : fallback;
    } catch {
      return fallback;
    }
  }

  function writeSetting(key, value) {
    try {
      if (typeof GM_setValue === "function") {
        GM_setValue(key, value);
      }
    } catch (error) {
      console.warn("[Gemini Toolkit] Could not save a setting", error);
    }
  }

  const state = {
    conversations: [],
    selectedIds: new Set(),
    loading: false,
    deleting: false,
    exportingImages: false,
    abortController: null,
    imageExportAbortController: null,
    query: "",
    olderThanDays: 0,
    protectCurrent: true,
    protectPinned: true,
    defaultModel: readSetting(SETTINGS.model, "pro", [
      "keep",
      "pro",
      "flash",
      "flash-lite",
    ]),
    defaultThinking: readSetting(SETTINGS.thinking, "extended", [
      "keep",
      "extended",
      "standard",
    ]),
    removeWatermark: readSetting(
      SETTINGS.removeWatermark,
      false,
      [true, false],
    ),
  };

  class RpcError extends Error {
    constructor(message, status = 0) {
      super(message);
      this.name = "RpcError";
      this.status = status;
    }
  }

  function getPageConfig() {
    const data = pageWindow.WIZ_global_data;
    const missing = [];

    if (!data || typeof data.SNlM0e !== "string" || !data.SNlM0e) {
      missing.push("SNlM0e");
    }
    if (!data || typeof data.FdrFJe !== "string" || !data.FdrFJe) {
      missing.push("FdrFJe");
    }
    if (!data || typeof data.cfb2h !== "string" || !data.cfb2h) {
      missing.push("cfb2h");
    }

    if (missing.length > 0) {
      throw new RpcError(
        "Gemini page credentials are not ready. Refresh the page, wait for Gemini to finish loading, and try again.",
      );
    }

    return {
      at: data.SNlM0e,
      sid: data.FdrFJe,
      bl: data.cfb2h,
    };
  }

  function nextRequestId() {
    requestId += Math.floor(Math.random() * 900) + 100;
    return String(requestId);
  }

  function getLocale() {
    return (
      document.documentElement.lang ||
      pageWindow.navigator.language ||
      "en"
    ).split("-")[0];
  }

  function parseRpcResponse(text, rpcId) {
    let unsupportedPayload = false;
    for (const line of text.split(/\r?\n/u)) {
      if (!line.trim().startsWith("[")) {
        continue;
      }

      let frame;
      try {
        frame = JSON.parse(line);
      } catch {
        continue;
      }

      const rows = Array.isArray(frame?.[0]) ? frame : [frame];
      for (const row of rows) {
        if (
          Array.isArray(row) &&
          row[0] === "wrb.fr" &&
          row[1] === rpcId
        ) {
          if (typeof row[2] !== "string") {
            unsupportedPayload = true;
            continue;
          }

          try {
            return JSON.parse(row[2]);
          } catch {
            throw new RpcError(`Could not parse the response from RPC ${rpcId}.`);
          }
        }
      }
    }

    if (unsupportedPayload) {
      throw new RpcError(`RPC ${rpcId} returned an unsupported payload.`);
    }

    throw new RpcError(
      `Gemini did not return a result for RPC ${rpcId}. Its internal interface may have changed.`,
    );
  }

  async function executeRpcText(rpcId, rpcPayload, signal) {
    const config = getPageConfig();
    const query = new URLSearchParams({
      rpcids: rpcId,
      "source-path": pageWindow.location.pathname,
      bl: config.bl,
      "f.sid": config.sid,
      hl: getLocale(),
      _reqid: nextRequestId(),
      rt: "c",
    });
    const request = [[[rpcId, JSON.stringify(rpcPayload), null, "generic"]]];
    const body = new URLSearchParams({
      "f.req": JSON.stringify(request),
      at: config.at,
    });
    const response = await pageFetch(
      `/_/BardChatUi/data/batchexecute?${query.toString()}`,
      {
        method: "POST",
        credentials: "include",
        cache: "no-store",
        headers: {
          "content-type": "application/x-www-form-urlencoded;charset=UTF-8",
          "x-same-domain": "1",
          "x-goog-ext-525001261-jspb":
            "[1,null,null,null,null,null,null,null,[4]]",
          "x-goog-ext-73010989-jspb": "[0]",
        },
        body: body.toString(),
        signal,
      },
    );

    if (!response.ok) {
      throw new RpcError(
        `The Gemini request failed (HTTP ${response.status}).`,
        response.status,
      );
    }

    return response.text();
  }

  async function executeRpc(rpcId, rpcPayload, signal) {
    return parseRpcResponse(
      await executeRpcText(rpcId, rpcPayload, signal),
      rpcId,
    );
  }

  function conversationFromTuple(tuple, pinned) {
    if (!Array.isArray(tuple) || typeof tuple[0] !== "string") {
      return null;
    }

    const id = tuple[0];
    if (!/^c_[0-9a-f]+$/iu.test(id)) {
      return null;
    }

    const timestamp = Array.isArray(tuple[5])
      ? Number(tuple[5][0]) * 1_000 + Number(tuple[5][1] || 0) / 1_000_000
      : 0;

    return {
      id,
      title:
        typeof tuple[1] === "string" && tuple[1].trim()
          ? tuple[1].trim()
          : "Untitled conversation",
      updatedAt: Number.isFinite(timestamp) ? timestamp : 0,
      pinned,
      outcome: "",
    };
  }

  async function fetchConversationGroup(group, pinned, onPage) {
    const conversations = [];
    let pageToken = null;

    for (let page = 0; page < MAX_PAGES_PER_GROUP; page += 1) {
      const result = await executeRpc(
        RPC.listConversations,
        [PAGE_SIZE, pageToken, [group, null, 1]],
        undefined,
      );

      if (!Array.isArray(result) || result.length === 0) {
        break;
      }

      const tuples = Array.isArray(result[2]) ? result[2] : [];
      for (const tuple of tuples) {
        const conversation = conversationFromTuple(tuple, pinned);
        if (conversation) {
          conversations.push(conversation);
        }
      }

      onPage(conversations.length);
      const nextPageToken =
        typeof result[1] === "string" && result[1] ? result[1] : null;
      if (!nextPageToken) {
        break;
      }
      if (nextPageToken === pageToken) {
        throw new RpcError(
          "Gemini returned a repeated page token. Loading has stopped.",
        );
      }
      pageToken = nextPageToken;
    }

    return conversations;
  }

  function getCurrentConversationId() {
    const match = pageWindow.location.pathname.match(
      /\/app\/(?:c_)?([0-9a-f]+)/iu,
    );
    return match ? `c_${match[1]}` : "";
  }

  function isProtected(conversation) {
    return (
      (state.protectCurrent &&
        conversation.id === getCurrentConversationId()) ||
      (state.protectPinned && conversation.pinned)
    );
  }

  function getFilteredConversations() {
    const query = state.query.trim().toLocaleLowerCase();
    const cutoff =
      state.olderThanDays > 0
        ? Date.now() - state.olderThanDays * 24 * 60 * 60 * 1_000
        : 0;

    return state.conversations.filter((conversation) => {
      const matchesQuery =
        !query ||
        conversation.title.toLocaleLowerCase().includes(query) ||
        conversation.id.toLocaleLowerCase().includes(query);
      const matchesAge =
        !cutoff ||
        (conversation.updatedAt > 0 && conversation.updatedAt < cutoff);
      return matchesQuery && matchesAge;
    });
  }

  function formatDate(timestamp) {
    return timestamp > 0
      ? dateFormatter.format(new Date(timestamp))
      : "Date unavailable";
  }

  function sleep(milliseconds, signal) {
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        pageWindow.clearTimeout(timer);
        reject(new pageWindow.DOMException("Cancelled", "AbortError"));
      };
      const timer = pageWindow.setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, milliseconds);
      if (!signal) {
        return;
      }
      if (signal.aborted) {
        onAbort();
        return;
      }

      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  function getModeButton() {
    return document.querySelector(MODE_BUTTON_SELECTOR);
  }

  function getDeepActiveElement() {
    let active = document.activeElement;
    while (active?.shadowRoot?.activeElement) {
      active = active.shadowRoot.activeElement;
    }
    return active;
  }

  function isModeFocus(element) {
    return (
      element instanceof pageWindow.Element &&
      (element.matches(MODE_BUTTON_SELECTOR) ||
        Boolean(element.closest(MODE_MENU_SELECTOR)))
    );
  }

  function getModeFocusKind(element) {
    if (
      !element ||
      element === document.body ||
      element === document.documentElement
    ) {
      return "neutral";
    }
    return isModeFocus(element) ? "mode" : "other";
  }

  function isAvailableFocusTarget(element) {
    return Boolean(
      element instanceof pageWindow.HTMLElement &&
        element.isConnected &&
        typeof element.focus === "function" &&
        !element.matches(":disabled") &&
        element.getAttribute("aria-disabled") !== "true" &&
        element.getAttribute("aria-hidden") !== "true" &&
        !element.closest("[inert]") &&
        element.getClientRects().length > 0,
    );
  }

  function getPromptInput() {
    for (const selector of PROMPT_INPUT_SELECTORS) {
      const input = [...document.querySelectorAll(selector)].find(
        isAvailableFocusTarget,
      );
      if (input) {
        return input;
      }
    }
    return null;
  }

  function restoreFocusAfterModeDefaults(previousFocus) {
    if (getModeMenu()) {
      return;
    }

    const currentFocus = getDeepActiveElement();
    const canRestorePrevious =
      getModeFocusKind(previousFocus) === "other" &&
      isAvailableFocusTarget(previousFocus);
    const plan = modeFocusRestorePlan(
      getModeFocusKind(currentFocus),
      canRestorePrevious,
    );
    const target =
      plan === "previous"
        ? previousFocus
        : plan === "prompt"
          ? getPromptInput()
          : null;
    if (!target || target === currentFocus) {
      return;
    }

    try {
      target.focus({ preventScroll: true });
    } catch {
      target.focus();
    }
  }

  function getModeItemLabel(item) {
    return normalizeModeLabel(
      item.querySelector(".label")?.textContent || item.textContent,
    );
  }

  function getModeItems(menu) {
    return [...menu.querySelectorAll(MODE_ITEM_SELECTOR)];
  }

  function getModeMenu() {
    return [...document.querySelectorAll(MODE_MENU_SELECTOR)].find((menu) =>
      menu.querySelector(`${MODE_ITEM_SELECTOR}[data-mode-id]`),
    );
  }

  function getSelectedModelLabel(menu) {
    const selected = getModeItems(menu).find(
      (item) =>
        item.hasAttribute("data-mode-id") &&
        item.classList.contains("selected"),
    );
    return selected ? getModeItemLabel(selected) : "";
  }

  function getExtendedItem(menu) {
    return getModeItems(menu).find((item) =>
      /^extended thinking$/iu.test(getModeItemLabel(item)),
    );
  }

  async function waitForModeMenu(visible, timeout = MODE_APPLY_TIMEOUT) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeout) {
      const menu = getModeMenu();
      if (Boolean(menu) === visible) {
        return menu;
      }
      await sleep(50);
    }
    return null;
  }

  async function waitForModeLabel(predicate, timeout = MODE_APPLY_TIMEOUT) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeout) {
      const label = normalizeModeLabel(
        getModeButton()?.getAttribute("aria-label"),
      ).replace(/^Open mode picker, currently\s*/iu, "");
      if (label && predicate(label)) {
        return label;
      }
      await sleep(50);
    }
    return "";
  }

  async function openModeMenu() {
    const existing = getModeMenu();
    if (existing) {
      return existing;
    }
    const button = getModeButton();
    if (!button) {
      return null;
    }
    button.click();
    return waitForModeMenu(true);
  }

  async function closeModeMenu() {
    if (!getModeMenu()) {
      return;
    }
    getModeButton()?.click();
    await waitForModeMenu(false, 1_000);
  }

  function setModeStatus(message, error = false) {
    if (!ui?.defaultStatus) {
      return;
    }
    ui.defaultStatus.textContent = message;
    ui.defaultStatus.classList.toggle("error", error);
  }

  async function applyModeDefaults({ force = false } = {}) {
    if (applyingModeDefaults || (!force && manualModeOverride)) {
      return;
    }

    const initialButton = getModeButton();
    if (!initialButton) {
      setModeStatus("Waiting for Gemini's model picker…");
      return;
    }
    if (
      state.defaultModel === "keep" &&
      state.defaultThinking === "keep"
    ) {
      setModeStatus("Gemini controls the model for this chat.");
      return;
    }

    const initialLabel = normalizeModeLabel(
      initialButton.getAttribute("aria-label"),
    ).replace(/^Open mode picker, currently\s*/iu, "");
    const modelMatches = modelLabelMatches(
      initialLabel,
      state.defaultModel,
    );
    const extendedMatches =
      state.defaultThinking === "keep" ||
      modeLabelHasExtended(initialLabel) ===
        (state.defaultThinking === "extended");
    if (modelMatches && extendedMatches) {
      setModeStatus(`Active: ${initialLabel}`);
      return;
    }

    applyingModeDefaults = true;
    const focusBeforeApply = getDeepActiveElement();
    setModeStatus("Applying defaults…");

    try {
      let menu = await openModeMenu();
      if (!menu) {
        throw new Error("Gemini's model menu did not open.");
      }

      if (state.defaultModel !== "keep") {
        const selectedModel = getSelectedModelLabel(menu);
        if (!modelLabelMatches(selectedModel, state.defaultModel)) {
          const modelItem = getModeItems(menu).find(
            (item) =>
              item.hasAttribute("data-mode-id") &&
              modelLabelMatches(getModeItemLabel(item), state.defaultModel),
          );
          if (!modelItem) {
            throw new Error(
              "The preferred model is not available for this account.",
            );
          }
          modelItem.click();
          await waitForModeMenu(false);
          const appliedModel = await waitForModeLabel((label) =>
            modelLabelMatches(label, state.defaultModel),
          );
          if (!appliedModel) {
            throw new Error("Gemini did not activate the preferred model.");
          }
          menu = null;
        }
      }

      if (state.defaultThinking !== "keep") {
        menu ||= await openModeMenu();
        if (!menu) {
          throw new Error("Gemini's thinking-mode menu did not open.");
        }
        const extendedItem = getExtendedItem(menu);
        if (!extendedItem) {
          throw new Error(
            "Extended thinking is not available for this account.",
          );
        }
        const extendedSelected = extendedItem.classList.contains("selected");
        const shouldUseExtended = state.defaultThinking === "extended";
        if (extendedSelected !== shouldUseExtended) {
          extendedItem.click();
          await waitForModeMenu(false);
          const appliedThinking = await waitForModeLabel(
            (label) => modeLabelHasExtended(label) === shouldUseExtended,
          );
          if (!appliedThinking) {
            throw new Error("Gemini did not activate the thinking preference.");
          }
          menu = null;
        }
      }

      await closeModeMenu();
      const currentLabel = normalizeModeLabel(
        getModeButton()?.getAttribute("aria-label"),
      ).replace(/^Open mode picker, currently\s*/iu, "");
      setModeStatus(
        currentLabel ? `Active: ${currentLabel}` : "Defaults applied.",
      );
    } catch (error) {
      console.warn("[Gemini Toolkit] Could not apply mode defaults", error);
      await closeModeMenu();
      setModeStatus(error?.message || "Could not apply model defaults.", true);
    } finally {
      applyingModeDefaults = false;
      await sleep(0);
      restoreFocusAfterModeDefaults(focusBeforeApply);
    }
  }

  function scheduleModeDefaults({ force = false, delay = 350 } = {}) {
    pageWindow.clearTimeout(modeApplyTimer);
    modeApplyTimer = pageWindow.setTimeout(
      () => void applyModeDefaults({ force }),
      delay,
    );
  }

  function isRetryable(error) {
    return (
      error instanceof TypeError ||
      (error instanceof RpcError &&
        (error.status === 0 ||
          error.status === 429 ||
          error.status === 408 ||
          error.status >= 500))
    );
  }

  async function deleteConversation(id, signal) {
    let lastError;

    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await executeRpc(RPC.deleteConversation, [id], signal);
        return;
      } catch (error) {
        if (error?.name === "AbortError") {
          throw error;
        }
        lastError = error;
        if (!isRetryable(error) || attempt === 2) {
          throw error;
        }
        await sleep(600 * 2 ** attempt + Math.random() * 300, signal);
      }
    }

    throw lastError;
  }

  let watermarkEnginePromise = null;
  const capturedGeneratedImages = new Map();
  let capturedImageConversationKey = "";
  let imageCaptureTimer = 0;

  function getResponseHeader(headers, name) {
    const pattern = new RegExp(`^${name}:\\s*(.+)$`, "imu");
    return String(headers || "").match(pattern)?.[1]?.trim() || "";
  }

  function imageMimeTypeFromBytes(buffer, declaredType = "") {
    const bytes = new Uint8Array(buffer);
    const declared = String(declaredType || "").toLocaleLowerCase();
    if (declared.startsWith("image/")) return declared.split(";")[0];
    if (
      bytes.length >= 8 &&
      bytes[0] === 0x89 &&
      bytes[1] === 0x50 &&
      bytes[2] === 0x4e &&
      bytes[3] === 0x47
    ) return "image/png";
    if (
      bytes.length >= 3 &&
      bytes[0] === 0xff &&
      bytes[1] === 0xd8 &&
      bytes[2] === 0xff
    ) return "image/jpeg";
    if (
      bytes.length >= 12 &&
      String.fromCharCode(...bytes.subarray(0, 4)) === "RIFF" &&
      String.fromCharCode(...bytes.subarray(8, 12)) === "WEBP"
    ) return "image/webp";
    if (
      bytes.length >= 6 &&
      String.fromCharCode(...bytes.subarray(0, 3)) === "GIF"
    ) return "image/gif";
    return "";
  }

  function firstHttpUrlInBuffer(buffer) {
    const text = new TextDecoder()
      .decode(buffer)
      .trim()
      .replace(/\\u0026/gu, "&")
      .replace(/\\u003d/gu, "=")
      .replace(/\\\//gu, "/");
    return text.match(/https?:\/\/[^\s"'<>\\]+/iu)?.[0] || "";
  }

  function requestArrayBuffer(url, signal) {
    return new Promise((resolve, reject) => {
      if (typeof GM_xmlhttpRequest !== "function") {
        reject(
          new ImageDownloadError("GM_xmlhttpRequest is unavailable.", {
            code: "manager-api-unavailable",
          }),
        );
        return;
      }

      let settled = false;
      let request;
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener("abort", onAbort);
        callback(value);
      };
      const onAbort = () => {
        const error = new pageWindow.DOMException("Cancelled", "AbortError");
        try {
          request?.abort?.();
        } catch {
          // The promise is still rejected below if a manager throws on abort.
        }
        finish(reject, error);
      };
      request = GM_xmlhttpRequest({
        method: "GET",
        url,
        responseType: "arraybuffer",
        anonymous: false,
        timeout: 120_000,
        headers: {
          Accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
          Referer: "https://gemini.google.com/",
        },
        onload: (response) => finish(resolve, response),
        onerror: () =>
          finish(
            reject,
            new ImageDownloadError("The image request failed.", {
              retryable: true,
              code: "network-error",
            }),
          ),
        ontimeout: () =>
          finish(
            reject,
            new ImageDownloadError("The image request timed out.", {
              retryable: true,
              code: "timeout",
            }),
          ),
        onabort: () =>
          finish(
            reject,
            new pageWindow.DOMException("Cancelled", "AbortError"),
          ),
      });
      if (signal?.aborted) {
        onAbort();
      } else {
        signal?.addEventListener("abort", onAbort, { once: true });
      }
    });
  }

  async function fetchImageBlobFromProbes(probes, signal) {
    let lastError = null;
    let retryableError = null;

    for (const probe of probes) {
      let currentUrl = probe;
      for (let hop = 0; hop < FULL_SIZE_REDIRECT_HOPS; hop += 1) {
        try {
          const response = await requestArrayBuffer(currentUrl, signal);
          if (response.status < 200 || response.status >= 400) {
            throw new ImageDownloadError(
              `Image request returned HTTP ${response.status}.`,
              {
                retryable: isRetryableHttpStatus(response.status),
                status: response.status,
                code: "http-error",
              },
            );
          }
          const buffer = response.response;
          if (!(buffer instanceof ArrayBuffer) || buffer.byteLength === 0) {
            throw new ImageDownloadError(
              "Gemini returned an empty image response.",
              { retryable: true, code: "empty-response" },
            );
          }
          const declaredType = getResponseHeader(
            response.responseHeaders,
            "content-type",
          );
          const imageType = imageMimeTypeFromBytes(buffer, declaredType);
          if (imageType) {
            return new Blob([buffer], { type: imageType });
          }
          const nextUrl = firstHttpUrlInBuffer(buffer);
          if (!nextUrl || nextUrl === currentUrl) {
            throw new ImageDownloadError(
              "Gemini did not return an image URL.",
              { code: "missing-redirect-url" },
            );
          }
          currentUrl = nextUrl;
        } catch (error) {
          if (error?.name === "AbortError") throw error;
          lastError = error;
          if (isRetryableImageExportError(error)) retryableError = error;
          break;
        }
      }
    }

    throw (
      retryableError ||
      lastError ||
      new ImageDownloadError("No full-size image source was found.", {
        code: "missing-source",
      })
    );
  }

  async function fetchFullSizeImageBlob(record, signal) {
    let lastError = null;
    let retryableError = null;
    const rememberFailure = (error) => {
      lastError = error;
      if (isRetryableImageExportError(error)) retryableError = error;
    };

    if (record.fullSizeRefs) {
      try {
        const rpcText = await executeRpcText(
          RPC.getFullSizeImage,
          buildFullSizeImageRpcPayload(record.fullSizeRefs),
          signal,
        );
        const resolvedUrls = fullSizeImageUrlsFromRpcText(rpcText);
        if (resolvedUrls.length === 0) {
          throw new ImageDownloadError(
            "Gemini returned no original-size image URL.",
            { code: "missing-original-url" },
          );
        }
        return await fetchImageBlobFromProbes(
          resolvedUrls.flatMap(buildFullSizeProbeUrls),
          signal,
        );
      } catch (error) {
        if (error?.name === "AbortError") throw error;
        rememberFailure(error);
        console.warn(
          "[Gemini Toolkit] Native full-size image lookup failed",
          error,
        );
      }
    }

    if (classifyGeminiAssetUrl(record.sourceUrl)?.original === true) {
      try {
        return await fetchImageBlobFromProbes(
          buildFullSizeProbeUrls(record.sourceUrl),
          signal,
        );
      } catch (error) {
        if (error?.name === "AbortError") throw error;
        rememberFailure(error);
        console.warn(
          "[Gemini Toolkit] Captured image asset lookup failed",
          error,
        );
      }
    }

    const finalError = retryableError || lastError;
    if (finalError) {
      throw new ImageDownloadError(
        `Could not resolve Gemini's original-size image. ${finalError?.message || ""}`.trim(),
        {
          retryable: isRetryableImageExportError(finalError),
          status: finalError?.status,
          code: finalError?.code || "original-lookup-failed",
          cause: finalError,
        },
      );
    }
    throw new ImageDownloadError(
      "Gemini did not expose an original-size image URL. The preview was not downloaded.",
      { code: "missing-original-metadata" },
    );
  }

  function findImageForDownloadButton(button) {
    let parent = button;
    for (let depth = 0; parent && depth < 7; depth += 1) {
      const image = parent.querySelector?.(
        'img.image, img[data-gwr-stable-source], img[src*="googleusercontent.com"]',
      );
      if (image) return image;
      parent = parent.parentElement;
    }
    return null;
  }

  function imageRecordFromButton(button, index = 0) {
    const image = findImageForDownloadButton(button);
    if (!image) return null;
    const displayedSource = image.currentSrc || image.src || "";
    const sourceUrl =
      image.getAttribute("data-gwr-stable-source") ||
      image.getAttribute("data-gwr-source-url") ||
      image.getAttribute("data-gwr-page-image-source") ||
      generatedImageSourceByObjectUrl.get(displayedSource) ||
      displayedSource ||
      "";
    const normalizedSource = normalizeGeneratedImageUrl(sourceUrl);
    if (!normalizedSource) return null;
    const jslog = button.getAttribute("jslog") || "";
    const attachmentIndex = Math.max(
      0,
      Number.parseInt(
        button
          .closest("single-image")
          ?.getAttribute("data-image-attachment-index") || "0",
        10,
      ) || 0,
    );
    const fullSizeRefs = parseFullSizeImageRefs(jslog, attachmentIndex);
    const responseId = fullSizeRefs?.responseId || "";
    return {
      button,
      image,
      sourceUrl: normalizedSource,
      responseId,
      fullSizeRefs,
      attachmentIndex,
      pageBlobUrl: isPageBlobImageUrl(displayedSource)
        ? displayedSource
        : "",
      conversationId:
        fullSizeRefs?.conversationId || getCurrentConversationId(),
      index,
    };
  }

  function currentImageCaptureConversationKey() {
    return (
      getCurrentConversationId() ||
      `${pageWindow.location.pathname}${pageWindow.location.search}`
    );
  }

  function resetCapturedGeneratedImages() {
    pageWindow.clearTimeout(imageCaptureTimer);
    imageCaptureTimer = 0;
    capturedGeneratedImages.clear();
    pendingNativeWatermarkDownloads.length = 0;
    capturedImageConversationKey = currentImageCaptureConversationKey();
  }

  function queueNativeWatermarkDownload(button) {
    if (!nativeDownloadResponseHookInstalled) {
      setImageToast(
        "Gemini's full-size response could not be processed; downloading the original unchanged.",
        true,
      );
      return;
    }
    const record = imageRecordFromButton(button, 1);
    pendingNativeWatermarkDownloads.push({
      assetIdentity: geminiAssetIdentity(record?.sourceUrl),
      createdAt: Date.now(),
    });
    if (pendingNativeWatermarkDownloads.length > 8) {
      pendingNativeWatermarkDownloads.splice(
        0,
        pendingNativeWatermarkDownloads.length - 8,
      );
    }
    setImageToast(
      "Waiting for Gemini's full-size image before removing the watermark…",
    );
  }

  function captureCurrentGeneratedImages() {
    const liveRecords = [
      ...document.querySelectorAll(FULL_SIZE_BUTTON_SELECTOR),
    ]
      .map((button) => imageRecordFromButton(button))
      .filter(Boolean);
    const inferredConversationId =
      getCurrentConversationId() ||
      [...liveRecords]
        .reverse()
        .find((record) => record.conversationId)?.conversationId ||
      "";
    const conversationKey =
      inferredConversationId || currentImageCaptureConversationKey();
    if (conversationKey !== capturedImageConversationKey) {
      capturedGeneratedImages.clear();
      capturedImageConversationKey = conversationKey;
    }

    for (const record of liveRecords) {
      if (
        inferredConversationId &&
        record.conversationId &&
        record.conversationId !== inferredConversationId
      ) {
        continue;
      }
      rememberGeneratedImageRecord(capturedGeneratedImages, {
        ...record,
        conversationId: record.conversationId || inferredConversationId,
      });
    }
    return capturedGeneratedImages.size;
  }

  function scheduleGeneratedImageCapture({ delay = IMAGE_CAPTURE_DELAY } = {}) {
    if (imageCaptureTimer) return;
    imageCaptureTimer = pageWindow.setTimeout(() => {
      imageCaptureTimer = 0;
      captureCurrentGeneratedImages();
    }, delay);
  }

  function collectGeneratedImageRecords() {
    captureCurrentGeneratedImages();
    return [...capturedGeneratedImages.values()]
      .sort((first, second) => first.discoveryIndex - second.discoveryIndex)
      .map((record, index) => ({
        ...record,
        fullSizeRefs: record.fullSizeRefs
          ? { ...record.fullSizeRefs }
          : null,
        index: index + 1,
      }));
  }

  async function decodeImageBlob(blob) {
    if (typeof createImageBitmap === "function") {
      try {
        return await createImageBitmap(blob);
      } catch {
        // Fall through to HTMLImageElement for browsers that reject the format.
      }
    }
    const objectUrl = URL.createObjectURL(blob);
    try {
      return await new Promise((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve(image);
        image.onerror = () => reject(new Error("Could not decode the image."));
        image.src = objectUrl;
      });
    } finally {
      URL.revokeObjectURL(objectUrl);
    }
  }

  function canvasToBlob(canvas, type, quality) {
    return new Promise((resolve, reject) => {
      canvas.toBlob(
        (blob) =>
          blob
            ? resolve(blob)
            : reject(new Error("Could not encode the processed image.")),
        type,
        quality,
      );
    });
  }

  async function getWatermarkEngine() {
    if (!watermarkEnginePromise) {
      const core = globalThis.__GEMINI_WATERMARK_CORE__;
      if (!core?.WatermarkEngine) {
        throw new Error("The watermark-removal core did not load.");
      }
      watermarkEnginePromise = core.WatermarkEngine.create().catch((error) => {
        watermarkEnginePromise = null;
        throw error;
      });
    }
    return watermarkEnginePromise;
  }

  function releaseCanvas(canvas) {
    if (!canvas || typeof canvas.width !== "number") return;
    canvas.width = 1;
    canvas.height = 1;
  }

  async function removeWatermarkFromImageBlob(blob) {
    const image = await decodeImageBlob(blob);
    let cropCanvas = null;
    let processedCrop = null;
    let output = null;

    try {
      const width = image.naturalWidth || image.width;
      const height = image.naturalHeight || image.height;
      const edge = Math.min(width, height, CORNER_CROP_EDGE);
      const cropX = width - edge;
      const cropY = height - edge;
      cropCanvas = document.createElement("canvas");
      cropCanvas.width = edge;
      cropCanvas.height = edge;
      const cropContext = cropCanvas.getContext("2d", {
        willReadFrequently: true,
      });
      if (!cropContext) {
        throw new Error("Canvas processing is unavailable.");
      }
      cropContext.drawImage(
        image,
        cropX,
        cropY,
        edge,
        edge,
        0,
        0,
        edge,
        edge,
      );

      const engine = await getWatermarkEngine();
      processedCrop = await engine.removeWatermarkFromImage(cropCanvas, {
        adaptiveMode: "always",
      });
      if (processedCrop.__watermarkMeta?.applied !== true) {
        return { blob, removed: false };
      }

      output = document.createElement("canvas");
      output.width = width;
      output.height = height;
      const outputContext = output.getContext("2d");
      if (!outputContext) {
        throw new Error("Canvas export is unavailable.");
      }
      outputContext.drawImage(image, 0, 0);
      outputContext.drawImage(processedCrop, cropX, cropY);
      const outputType = ["image/png", "image/jpeg", "image/webp"].includes(
        blob.type,
      )
        ? blob.type
        : "image/png";
      const processedBlob = await canvasToBlob(output, outputType, 0.92);
      return { blob: processedBlob, removed: true };
    } finally {
      image.close?.();
      image.removeAttribute?.("src");
      releaseCanvas(output);
      if (processedCrop !== cropCanvas) releaseCanvas(processedCrop);
      releaseCanvas(cropCanvas);
    }
  }

  function generatedImageFilename(record, mimeType) {
    return generatedImageFilenameForRecord(
      record,
      mimeType,
      getCurrentConversationId(),
    );
  }

  function saveBlob(blob, filename, revokeDelay = 60_000) {
    const objectUrl = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = objectUrl;
    anchor.download = filename;
    anchor.hidden = true;
    document.documentElement.append(anchor);
    anchor.click();
    anchor.remove();
    pageWindow.setTimeout(() => URL.revokeObjectURL(objectUrl), revokeDelay);
  }

  function createInterface() {
    if (document.getElementById(HOST_ID)) {
      return null;
    }

    const host = document.createElement("div");
    host.id = HOST_ID;
    document.documentElement.append(host);
    const shadow = host.attachShadow({ mode: "open" });

    const stylesheet = document.createElement("style");
    stylesheet.textContent = `
        :host {
          color-scheme: light dark;
          --background: #f2f2f2;
          --surface: #ffffff;
          --surface-muted: #f5f5f5;
          --text: #111111;
          --muted: #666666;
          --border: #d0d0d0;
          --strong: #111111;
          --strong-text: #ffffff;
          --overlay: rgba(0, 0, 0, .58);
          font-family: Arial, "Helvetica Neue", system-ui, sans-serif;
        }
        :host(.header-docked) {
          position: fixed;
          z-index: 2147483645;
          display: inline-flex;
          align-items: center;
          margin: 0;
        }
        * { box-sizing: border-box; }
        button, input, select { font: inherit; }
        input[type="checkbox"] { accent-color: var(--strong); }
        button { cursor: pointer; }
        button:disabled { cursor: not-allowed; opacity: .5; }
        button:focus-visible,
        input:focus-visible,
        select:focus-visible,
        a:focus-visible {
          outline: 2px solid var(--text);
          outline-offset: 3px;
        }
        .launchers {
          position: fixed;
          z-index: 2147483645;
          top: 50%;
          right: 16px;
          transform: translateY(-50%);
          visibility: hidden;
          pointer-events: none;
        }
        :host(.header-docked) .launchers {
          position: static;
          top: auto;
          right: auto;
          transform: none;
          visibility: visible;
          pointer-events: auto;
        }
        .launcher-menu {
          position: absolute;
          right: 0;
          bottom: calc(100% + 8px);
          display: grid;
          gap: 6px;
          min-width: 218px;
          padding: 7px;
          color: var(--text);
          background: var(--surface);
          border: 1px solid var(--border);
          border-radius: 10px;
          box-shadow: 0 10px 30px rgba(0, 0, 0, .2);
        }
        :host(.header-docked) .launcher-menu {
          top: calc(100% + 8px);
          bottom: auto;
        }
        .launcher {
          border: 1px solid var(--strong);
          border-radius: 7px;
          padding: 11px 16px;
          color: var(--strong-text);
          background: var(--strong);
          box-shadow: 0 6px 18px rgba(0, 0, 0, .18);
          font-weight: 700;
          letter-spacing: .01em;
        }
        .launcher-toggle {
          min-width: 84px;
          padding: 9px 12px;
        }
        .launcher-menu .launcher {
          width: 100%;
          padding: 10px 12px;
          box-shadow: none;
          text-align: left;
          white-space: nowrap;
        }
        .launcher.secondary {
          color: var(--text);
          background: var(--surface);
        }
        .overlay {
          position: fixed;
          z-index: 2147483646;
          inset: 0;
          display: grid;
          place-items: center;
          padding: 24px;
          background: var(--overlay);
        }
        .hidden { display: none !important; }
        .panel {
          width: min(940px, 100%);
          height: min(760px, calc(100vh - 48px));
          display: grid;
          grid-template-rows: auto auto auto auto minmax(0, 1fr) auto;
          overflow: hidden;
          color: var(--text);
          background: var(--background);
          border: 1px solid var(--border);
          border-radius: 12px;
          box-shadow: 0 24px 70px rgba(0, 0, 0, .28);
        }
        .export-panel {
          width: min(520px, 100%);
          max-height: calc(100vh - 48px);
          display: grid;
          grid-template-rows: auto minmax(0, 1fr) auto;
          overflow: hidden;
          color: var(--text);
          background: var(--background);
          border: 1px solid var(--border);
          border-radius: 12px;
          box-shadow: 0 24px 70px rgba(0, 0, 0, .28);
        }
        .export-body {
          display: grid;
          gap: 14px;
          overflow: auto;
          padding: 20px;
          color: var(--muted);
          font-size: 14px;
          line-height: 1.5;
        }
        .export-body p { margin: 0; }
        .export-inventory {
          max-height: 190px;
          overflow: auto;
          color: var(--text);
          background: var(--surface);
          border: 1px solid var(--border);
          border-radius: 7px;
        }
        .export-inventory ol {
          display: grid;
          gap: 0;
          margin: 0;
          padding: 0;
          list-style: none;
          counter-reset: export-image;
        }
        .export-inventory li {
          counter-increment: export-image;
          display: grid;
          grid-template-columns: auto minmax(0, 1fr) auto;
          align-items: center;
          gap: 8px;
          min-height: 34px;
          padding: 7px 10px;
          border-bottom: 1px solid var(--border);
          font-size: 12px;
        }
        .export-inventory li:last-child { border-bottom: 0; }
        .export-inventory li::before {
          content: counter(export-image) ".";
          color: var(--muted);
          font-variant-numeric: tabular-nums;
        }
        .export-filename {
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        }
        .export-readiness {
          padding: 1px 6px;
          border: 1px solid var(--border);
          border-radius: 999px;
          color: var(--muted);
          white-space: nowrap;
        }
        .export-readiness.unavailable {
          color: var(--text);
          border-style: dashed;
          font-weight: 700;
        }
        .export-failures {
          max-height: 150px;
          overflow: auto;
          padding: 10px 12px;
          color: var(--text);
          background: var(--surface-muted);
          border: 1px solid var(--border);
          border-radius: 7px;
          font-size: 12px;
        }
        .export-failures summary { cursor: pointer; font-weight: 700; }
        .export-failures ul {
          display: grid;
          gap: 6px;
          margin: 10px 0 0;
          padding-left: 20px;
          overflow-wrap: anywhere;
        }
        .export-actions {
          display: flex;
          align-items: center;
          justify-content: flex-end;
          gap: 10px;
          padding: 14px 20px;
          border-top: 1px solid var(--border);
          background: var(--surface);
        }
        .export-progress {
          margin-right: auto;
          color: var(--muted);
          font-size: 13px;
        }
        .toast {
          position: fixed;
          z-index: 2147483647;
          right: 16px;
          bottom: 24px;
          max-width: min(420px, calc(100vw - 32px));
          padding: 10px 13px;
          color: var(--strong-text);
          background: var(--strong);
          border-radius: 7px;
          box-shadow: 0 8px 24px rgba(0, 0, 0, .24);
          font-size: 13px;
        }
        .header, .defaults, .toolbar, .selection, .footer {
          display: flex;
          align-items: center;
          gap: 10px;
          padding: 14px 18px;
        }
        .header {
          justify-content: space-between;
          border-bottom: 1px solid var(--border);
        }
        .title {
          margin: 0;
          font-size: 18px;
          font-weight: 700;
          letter-spacing: -.01em;
        }
        .subtitle { margin-top: 4px; color: var(--muted); font-size: 12px; }
        .defaults {
          flex-wrap: wrap;
          background: var(--surface);
          border-bottom: 1px solid var(--border);
        }
        .defaults-title {
          margin-right: 4px;
          font-size: 13px;
          font-weight: 700;
        }
        .field-group {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          color: var(--muted);
          font-size: 12px;
        }
        .default-status {
          min-width: 180px;
          flex: 1;
          color: var(--muted);
          font-size: 12px;
          text-align: right;
        }
        .default-status.error { color: var(--text); font-weight: 700; }
        .icon-button {
          width: 34px;
          height: 34px;
          border: 0;
          border-radius: 50%;
          color: inherit;
          background: transparent;
          font-size: 22px;
        }
        .icon-button:hover { background: var(--surface-muted); }
        .toolbar {
          flex-wrap: wrap;
          border-bottom: 1px solid var(--border);
        }
        .search {
          min-width: 220px;
          flex: 1;
        }
        input[type="search"], select {
          min-height: 38px;
          padding: 7px 10px;
          color: inherit;
          background: var(--surface);
          border: 1px solid var(--border);
          border-radius: 6px;
        }
        .check-label {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          white-space: nowrap;
          color: var(--muted);
          font-size: 13px;
        }
        .selection {
          flex-wrap: wrap;
          min-height: 52px;
          background: var(--surface-muted);
          border-bottom: 1px solid var(--border);
        }
        .status {
          margin-right: auto;
          color: var(--muted);
          font-size: 13px;
        }
        .status.error { color: var(--text); font-weight: 700; }
        .button {
          min-height: 36px;
          padding: 7px 12px;
          border: 1px solid var(--text);
          border-radius: 6px;
          color: var(--text);
          background: var(--surface);
          font-weight: 600;
        }
        .button:hover:not(:disabled) { background: var(--surface-muted); }
        .button.primary,
        .button.danger {
          color: var(--strong-text);
          border-color: var(--strong);
          background: var(--strong);
        }
        .list {
          overflow: auto;
          padding: 8px 10px 18px;
        }
        .row {
          display: grid;
          grid-template-columns: auto minmax(0, 1fr) auto;
          align-items: center;
          gap: 12px;
          margin: 4px 0;
          padding: 10px 12px;
          border: 1px solid transparent;
          border-radius: 7px;
          background: var(--surface);
        }
        .row:hover { border-color: var(--border); }
        .row.protected { opacity: .63; }
        .row.success {
          background: var(--surface-muted);
          border-color: var(--text);
        }
        .row.failed {
          background: var(--surface-muted);
          border-color: var(--text);
          border-style: dashed;
        }
        .row-title {
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          font-weight: 620;
        }
        .row-meta {
          display: flex;
          gap: 8px;
          margin-top: 3px;
          color: var(--muted);
          font-size: 12px;
        }
        .badge {
          padding: 1px 6px;
          border-radius: 999px;
          color: var(--text);
          background: var(--surface-muted);
          border: 1px solid var(--border);
        }
        .open-link {
          color: var(--text);
          text-decoration: underline;
          text-underline-offset: 3px;
          font-size: 13px;
        }
        .empty {
          display: grid;
          min-height: 230px;
          place-items: center;
          padding: 30px;
          color: var(--muted);
          text-align: center;
        }
        .footer {
          flex-wrap: wrap;
          padding-bottom: max(14px, env(safe-area-inset-bottom));
          border-top: 1px solid var(--border);
          background: var(--surface);
        }
        .progress {
          min-width: 220px;
          flex: 1;
          color: var(--muted);
          font-size: 13px;
        }
        .concurrency {
          min-height: 36px;
          width: auto;
        }
        @media (max-width: 680px) {
          .overlay { padding: 0; }
          .panel {
            width: 100%;
            height: 100dvh;
            border: 0;
            border-radius: 0;
          }
          .export-panel {
            width: 100%;
            max-height: 100dvh;
            border: 0;
            border-radius: 0;
          }
          .export-body { padding: 16px; }
          .export-actions { flex-wrap: wrap; padding: 12px 16px; }
          .export-progress { min-width: 100%; }
          .launchers {
            right: 12px;
            max-width: calc(100vw - 28px);
          }
          .launcher-menu { min-width: min(218px, calc(100vw - 24px)); }
          .launcher { padding: 10px 12px; }
          .launcher-toggle { min-width: 76px; }
          .toast {
            top: 14px;
            right: 12px;
            bottom: auto;
          }
          .search { min-width: 100%; }
          .field-group { flex: 1 1 180px; }
          .field-group select { flex: 1; }
          .default-status { min-width: 100%; text-align: left; }
          .row { grid-template-columns: auto minmax(0, 1fr); }
          .open-link { grid-column: 2; }
        }
        @media (prefers-color-scheme: dark) {
          :host {
            --background: #111111;
            --surface: #181818;
            --surface-muted: #242424;
            --text: #f5f5f5;
            --muted: #ababab;
            --border: #444444;
            --strong: #f5f5f5;
            --strong-text: #111111;
            --overlay: rgba(0, 0, 0, .72);
          }
        }
    `;

    const addElement = (
      parent,
      tagName,
      {
        id = "",
        className = "",
        text = undefined,
        attributes = {},
        properties = {},
      } = {},
    ) => {
      const element = document.createElement(tagName);
      if (id) {
        element.id = id;
      }
      if (className) {
        element.className = className;
      }
      if (text !== undefined) {
        element.textContent = text;
      }
      for (const [name, value] of Object.entries(attributes)) {
        element.setAttribute(name, value);
      }
      Object.assign(element, properties);
      parent.append(element);
      return element;
    };
    const addButton = (
      parent,
      id,
      className,
      text,
      disabled = false,
    ) =>
      addElement(parent, "button", {
        id,
        className,
        text,
        properties: { type: "button", disabled },
      });
    const addOptions = (select, options, selectedValue = "") => {
      for (const [value, text] of options) {
        addElement(select, "option", {
          text,
          properties: { value, selected: value === selectedValue },
        });
      }
    };

    shadow.append(stylesheet);

    const launchers = addElement(shadow, "div", {
      className: "launchers",
    });
    const launcherToggle = addButton(
      launchers,
      "launcher-toggle",
      "launcher launcher-toggle",
      "Toolkit",
    );
    launcherToggle.setAttribute("aria-controls", "launcher-menu");
    launcherToggle.setAttribute("aria-expanded", "false");
    launcherToggle.setAttribute("aria-haspopup", "menu");
    const launcherMenu = addElement(launchers, "div", {
      id: "launcher-menu",
      className: "launcher-menu hidden",
      attributes: { role: "menu" },
    });
    const launcher = addButton(
      launcherMenu,
      "launcher",
      "launcher",
      "Manage conversations",
    );
    launcher.setAttribute("role", "menuitem");
    const exportLauncher = addButton(
      launcherMenu,
      "export-launcher",
      "launcher secondary",
      "Export full-size images",
    );
    exportLauncher.setAttribute("role", "menuitem");
    const overlay = addElement(shadow, "div", {
      id: "overlay",
      className: "overlay hidden",
    });
    const panel = addElement(overlay, "section", {
      className: "panel",
      attributes: {
        role: "dialog",
        "aria-modal": "true",
        "aria-labelledby": "dialog-title",
        "aria-describedby": "dialog-description",
      },
    });

    const header = addElement(panel, "header", { className: "header" });
    const headingGroup = addElement(header, "div");
    addElement(headingGroup, "h2", {
      id: "dialog-title",
      className: "title",
      text: "Gemini Toolkit",
    });
    addElement(headingGroup, "div", {
      id: "dialog-description",
      className: "subtitle",
      text: "Requests are sent only to the current gemini.google.com session.",
    });
    const close = addButton(header, "close", "icon-button", "×");
    close.setAttribute("aria-label", "Close");

    const defaults = addElement(panel, "section", {
      className: "defaults",
      attributes: { "aria-label": "Gemini Toolkit defaults" },
    });
    addElement(defaults, "span", {
      className: "defaults-title",
      text: "Toolkit defaults",
    });
    const defaultModelLabel = addElement(defaults, "label", {
      className: "field-group",
    });
    defaultModelLabel.append("Model");
    const defaultModel = addElement(defaultModelLabel, "select", {
      id: "default-model",
      attributes: { "aria-label": "Preferred Gemini model" },
    });
    addOptions(
      defaultModel,
      [
        ["pro", "Latest Pro"],
        ["flash", "Standard Flash"],
        ["flash-lite", "Flash-Lite"],
        ["keep", "Keep Gemini choice"],
      ],
      state.defaultModel,
    );
    const defaultThinkingLabel = addElement(defaults, "label", {
      className: "field-group",
    });
    defaultThinkingLabel.append("Thinking");
    const defaultThinking = addElement(defaultThinkingLabel, "select", {
      id: "default-thinking",
      attributes: { "aria-label": "Preferred Gemini thinking mode" },
    });
    addOptions(
      defaultThinking,
      [
        ["extended", "Extended on"],
        ["standard", "Extended off"],
        ["keep", "Keep Gemini choice"],
      ],
      state.defaultThinking,
    );
    const applyDefaults = addButton(
      defaults,
      "apply-defaults",
      "button",
      "Apply now",
    );
    const removeWatermarkLabel = addElement(defaults, "label", {
      className: "check-label",
    });
    const removeWatermark = addElement(removeWatermarkLabel, "input", {
      id: "remove-watermark",
      attributes: {
        "aria-label":
          "Remove watermark from full-size Gemini downloads and toolkit exports",
      },
      properties: {
        type: "checkbox",
        checked: state.removeWatermark,
      },
    });
    removeWatermarkLabel.append("Remove image watermark");
    const defaultStatus = addElement(defaults, "span", {
      id: "default-status",
      className: "default-status",
      text: "Waiting for Gemini's model picker…",
      attributes: {
        role: "status",
        "aria-live": "polite",
        "aria-atomic": "true",
      },
    });

    const toolbar = addElement(panel, "div", { className: "toolbar" });
    const scan = addButton(
      toolbar,
      "scan",
      "button primary",
      "Load conversations",
    );
    const search = addElement(toolbar, "input", {
      id: "search",
      className: "search",
      attributes: { "aria-label": "Filter by title or conversation ID" },
      properties: {
        type: "search",
        placeholder: "Filter by title or conversation ID",
        disabled: true,
      },
    });
    const age = addElement(toolbar, "select", {
      id: "age",
      attributes: { "aria-label": "Filter by age" },
      properties: { disabled: true },
    });
    addOptions(age, [
      ["0", "Any date"],
      ["7", "Older than 7 days"],
      ["30", "Older than 30 days"],
      ["90", "Older than 90 days"],
      ["180", "Older than 180 days"],
      ["365", "Older than 1 year"],
    ]);

    const protectCurrentLabel = addElement(toolbar, "label", {
      className: "check-label",
    });
    const protectCurrent = addElement(protectCurrentLabel, "input", {
      id: "protect-current",
      properties: { type: "checkbox", checked: true },
    });
    protectCurrentLabel.append("Protect current");

    const protectPinnedLabel = addElement(toolbar, "label", {
      className: "check-label",
    });
    const protectPinned = addElement(protectPinnedLabel, "input", {
      id: "protect-pinned",
      properties: { type: "checkbox", checked: true },
    });
    protectPinnedLabel.append("Protect pinned");

    const selection = addElement(panel, "div", {
      className: "selection",
    });
    const status = addElement(selection, "span", {
      id: "status",
      className: "status",
      text: "No conversations loaded.",
      attributes: {
        role: "status",
        "aria-live": "polite",
        "aria-atomic": "true",
      },
    });
    const selectFiltered = addButton(
      selection,
      "select-filtered",
      "button",
      "Select filtered",
      true,
    );
    const clearSelection = addButton(
      selection,
      "clear-selection",
      "button",
      "Clear selection",
      true,
    );

    const list = addElement(panel, "div", {
      id: "list",
      className: "list",
      attributes: { role: "list" },
    });
    const initialEmpty = addElement(list, "div", { className: "empty" });
    initialEmpty.append(
      "Load conversations, then select the items you want to delete.",
      document.createElement("br"),
      "Nothing is selected by default.",
    );

    const footer = addElement(panel, "footer", { className: "footer" });
    const progress = addElement(footer, "span", {
      id: "progress",
      className: "progress",
      text: "Deleted conversations cannot be recovered.",
    });
    const concurrencyLabel = addElement(footer, "label", {
      className: "check-label",
    });
    concurrencyLabel.append("Concurrency");
    const concurrency = addElement(concurrencyLabel, "select", {
      id: "concurrency",
      className: "concurrency",
    });
    addOptions(
      concurrency,
      [
        ["1", "1 — Conservative"],
        ["2", "2 — Recommended"],
        ["3", "3 — Faster"],
      ],
      "2",
    );
    const cancel = addButton(
      footer,
      "cancel",
      "button hidden",
      "Stop",
    );
    const deleteSelected = addButton(
      footer,
      "delete",
      "button danger",
      "Delete selected",
      true,
    );

    const exportOverlay = addElement(shadow, "div", {
      id: "export-overlay",
      className: "overlay hidden",
    });
    const exportPanel = addElement(exportOverlay, "section", {
      className: "export-panel",
      attributes: {
        role: "dialog",
        "aria-modal": "true",
        "aria-labelledby": "export-title",
        "aria-describedby": "export-description",
      },
    });
    const exportHeader = addElement(exportPanel, "header", {
      className: "header",
    });
    addElement(exportHeader, "h2", {
      id: "export-title",
      className: "title",
      text: "Export all full-size images",
    });
    const closeExport = addButton(
      exportHeader,
      "close-export",
      "icon-button",
      "×",
    );
    closeExport.setAttribute("aria-label", "Close export confirmation");
    const exportBody = addElement(exportPanel, "div", {
      className: "export-body",
    });
    const exportDescription = addElement(exportBody, "p", {
      id: "export-description",
      text: "Scanning generated images in the current conversation…",
    });
    const exportInventory = addElement(exportBody, "div", {
      className: "export-inventory hidden",
      attributes: { "aria-label": "Detected image export list" },
    });
    const exportWatermarkLabel = addElement(exportBody, "label", {
      className: "check-label",
    });
    const exportRemoveWatermark = addElement(
      exportWatermarkLabel,
      "input",
      {
        id: "export-remove-watermark",
        properties: {
          type: "checkbox",
          checked: state.removeWatermark,
        },
      },
    );
    exportWatermarkLabel.append("Remove watermark before export");
    addElement(exportBody, "p", {
      text: "Images are fetched and downloaded one at a time without creating a ZIP file. Keep this tab open and allow multiple downloads if your browser asks.",
    });
    const exportFailures = addElement(exportBody, "details", {
      className: "export-failures hidden",
    });
    const exportActions = addElement(exportPanel, "footer", {
      className: "export-actions",
    });
    const exportProgress = addElement(exportActions, "span", {
      className: "export-progress",
      text: "Ready.",
      attributes: { role: "status", "aria-live": "polite" },
    });
    const cancelExport = addButton(
      exportActions,
      "cancel-export",
      "button",
      "Cancel",
    );
    const confirmExport = addButton(
      exportActions,
      "confirm-export",
      "button primary",
      "Download images",
    );
    const toast = addElement(shadow, "div", {
      id: "image-toast",
      className: "toast hidden",
      attributes: { role: "status", "aria-live": "polite" },
    });

    return {
      host,
      shadow,
      launchers,
      launcherToggle,
      launcherMenu,
      launcher,
      exportLauncher,
      overlay,
      close,
      defaultModel,
      defaultThinking,
      removeWatermark,
      applyDefaults,
      defaultStatus,
      scan,
      search,
      age,
      protectCurrent,
      protectPinned,
      status,
      selectFiltered,
      clearSelection,
      list,
      progress,
      concurrency,
      cancel,
      deleteSelected,
      exportOverlay,
      closeExport,
      exportDescription,
      exportInventory,
      exportRemoveWatermark,
      exportFailures,
      exportProgress,
      cancelExport,
      confirmExport,
      toast,
    };
  }

  const ui = createInterface();
  if (!ui) {
    return;
  }

  let imageToastTimer = 0;
  let pendingImageRecords = [];
  let imageExportSession = null;

  function mountLauncherNearConversationActions() {
    const conversationActions = document.querySelector(
      "conversation-actions-icon",
    );
    const nativeButton =
      conversationActions?.querySelector("button") ||
      document.querySelector(
        'button[aria-label="Open menu for conversation actions."]',
      );
    const anchor =
      conversationActions ||
      nativeButton?.closest("gem-icon-button") ||
      nativeButton;
    const anchorRect = anchor?.getBoundingClientRect();
    if (anchor && anchorRect?.width > 0 && anchorRect.height > 0) {
      if (ui.host.parentElement !== document.documentElement) {
        document.documentElement.append(ui.host);
      }
      const launcherRect = ui.launcherToggle.getBoundingClientRect();
      const launcherWidth = launcherRect.width || 84;
      const launcherHeight = launcherRect.height || anchorRect.height;
      ui.host.style.left = `${Math.max(8, anchorRect.left - launcherWidth - 6)}px`;
      ui.host.style.top = `${Math.max(
        8,
        anchorRect.top + (anchorRect.height - launcherHeight) / 2,
      )}px`;
      ui.host.classList.add("header-docked");
      return;
    }
    if (!ui.host.isConnected) {
      document.documentElement.append(ui.host);
    }
    ui.host.classList.remove("header-docked");
    ui.host.style.removeProperty("left");
    ui.host.style.removeProperty("top");
  }

  function setLauncherMenuOpen(open) {
    ui.launcherMenu.classList.toggle("hidden", !open);
    ui.launcherToggle.setAttribute("aria-expanded", String(open));
  }

  function setImageToast(message, error = false) {
    pageWindow.clearTimeout(imageToastTimer);
    ui.toast.textContent = message;
    ui.toast.classList.remove("hidden");
    ui.toast.style.outline = error ? "2px solid currentColor" : "";
    imageToastTimer = pageWindow.setTimeout(
      () => ui.toast.classList.add("hidden"),
      error ? 7_000 : 4_000,
    );
  }

  function persistWatermarkSetting(value) {
    state.removeWatermark = Boolean(value);
    ui.removeWatermark.checked = state.removeWatermark;
    ui.exportRemoveWatermark.checked = state.removeWatermark;
    writeSetting(SETTINGS.removeWatermark, state.removeWatermark);
  }

  async function prepareDownloadedImage(record, removeWatermark, signal) {
    const originalBlob = await fetchFullSizeImageBlob(record, signal);
    if (!removeWatermark) {
      return { blob: originalBlob, removed: false, watermarkError: null };
    }
    try {
      const processed = await removeWatermarkFromImageBlob(originalBlob);
      return { ...processed, watermarkError: null };
    } catch (error) {
      console.warn("[Gemini Toolkit] Watermark removal failed", error);
      return { blob: originalBlob, removed: false, watermarkError: error };
    }
  }

  function renderImageExportInventory(records) {
    ui.exportInventory.replaceChildren();
    ui.exportInventory.classList.toggle("hidden", records.length === 0);
    if (records.length === 0) return;

    const list = document.createElement("ol");
    for (const record of records) {
      const availability = imageRecordAvailability(record);
      const item = document.createElement("li");
      const filename = document.createElement("span");
      filename.className = "export-filename";
      filename.textContent = generatedImageFilename(
        record,
        "image/jpeg",
      ).replace(/\.jpg$/u, ".{format}");
      filename.title = filename.textContent;
      const readiness = document.createElement("span");
      readiness.className = `export-readiness${availability.ready ? "" : " unavailable"}`;
      readiness.textContent = availability.ready ? "Ready" : "Missing metadata";
      readiness.title = availability.reason;
      item.append(filename, readiness);
      list.append(item);
    }
    ui.exportInventory.append(list);
  }

  function openExportDialog() {
    const records = collectGeneratedImageRecords();
    const readyRecords = records.filter(
      (record) => imageRecordAvailability(record).ready,
    );
    pendingImageRecords = readyRecords;
    const count = records.length;
    const unavailable = count - readyRecords.length;
    imageExportSession = {
      records,
      downloaded: new Set(),
      watermarkFallbacks: new Set(),
      failures: new Map(),
    };
    for (const record of records) {
      const availability = imageRecordAvailability(record);
      if (availability.ready) continue;
      imageExportSession.failures.set(imageExportRecordKey(record), {
        record,
        message: availability.reason,
        retryable: false,
        attempts: 0,
      });
    }
    ui.exportDescription.textContent = count
      ? `Captured ${count} generated image${count === 1 ? "" : "s"} while this conversation was loaded: ${readyRecords.length} ready${unavailable > 0 ? `, ${unavailable} missing original-size metadata` : ""}.`
      : "No generated images with a full-size download button were found in the loaded conversation.";
    ui.exportProgress.textContent = count
      ? `Ready ${readyRecords.length} · Unavailable ${unavailable}`
      : "Nothing to export.";
    renderImageExportInventory(records);
    ui.exportFailures.replaceChildren();
    ui.exportFailures.classList.add("hidden");
    ui.confirmExport.classList.remove("hidden");
    ui.confirmExport.textContent = `Download images (${readyRecords.length})`;
    ui.cancelExport.textContent = "Cancel";
    ui.confirmExport.disabled = readyRecords.length === 0;
    ui.exportRemoveWatermark.checked = state.removeWatermark;
    ui.exportOverlay.classList.remove("hidden");
    ui.exportLauncher.disabled = true;
    ui.launcher.disabled = true;
    (readyRecords.length > 0 ? ui.confirmExport : ui.closeExport).focus();
  }

  function closeExportDialog() {
    if (state.exportingImages) return;
    ui.exportOverlay.classList.add("hidden");
    ui.exportLauncher.disabled = false;
    ui.launcher.disabled = false;
    pendingImageRecords = [];
    imageExportSession = null;
    ui.exportLauncher.focus();
  }

  function setExportBusy(busy) {
    state.exportingImages = busy;
    ui.confirmExport.disabled = busy || pendingImageRecords.length === 0;
    ui.closeExport.disabled = busy;
    ui.exportRemoveWatermark.disabled = busy;
    if (busy) ui.cancelExport.textContent = "Stop";
  }

  function imageExportRecordKey(record) {
    return record.sourceUrl || String(record.index);
  }

  function imageExportSummary(session) {
    const downloaded = session?.downloaded.size || 0;
    const failed = session?.failures.size || 0;
    const total = session?.records.length || 0;
    const skipped = Math.max(0, total - downloaded - failed);
    const watermarkFallbacks = session?.watermarkFallbacks.size || 0;
    const parts = [
      `Downloaded ${downloaded}`,
      `Failed ${failed}`,
      `Not processed ${skipped}`,
    ];
    if (watermarkFallbacks > 0) {
      parts.push(`Watermark kept ${watermarkFallbacks}`);
    }
    return parts.join(" · ");
  }

  function renderImageExportFailures(session) {
    ui.exportFailures.replaceChildren();
    const failures = [...session.failures.values()];
    ui.exportFailures.classList.toggle("hidden", failures.length === 0);
    if (failures.length === 0) return;

    const summary = document.createElement("summary");
    summary.textContent = `${failures.length} image${failures.length === 1 ? "" : "s"} could not be exported`;
    const list = document.createElement("ul");
    for (const { record, message, attempts = 0 } of failures) {
      const item = document.createElement("li");
      const attemptLabel = attempts > 0
        ? ` (${attempts} attempt${attempts === 1 ? "" : "s"})`
        : "";
      item.textContent = `${generatedImageFilename(record, "image/jpeg")}${attemptLabel}: ${message}`;
      list.append(item);
    }
    ui.exportFailures.append(summary, list);
  }

  function prepareImageExportFollowUp(session, { cancelled = false } = {}) {
    pendingImageRecords = session.records.filter(
      (record) => {
        const recordKey = imageExportRecordKey(record);
        const failure = session.failures.get(recordKey);
        return (
          !session.downloaded.has(recordKey) &&
          imageRecordAvailability(record).ready &&
          failure?.retryable !== false
        );
      },
    );
    const failed = session.failures.size;
    const remaining = pendingImageRecords.length;
    ui.exportProgress.textContent = imageExportSummary(session);
    renderImageExportFailures(session);

    if (remaining === 0) {
      ui.exportDescription.textContent =
        failed === 0
          ? "Export complete. Every detected full-size image was downloaded."
          : `Export finished. ${failed} image${failed === 1 ? "" : "s"} could not be exported and cannot be retried.`;
      ui.confirmExport.classList.add("hidden");
      ui.cancelExport.textContent = "Close";
      return;
    }

    ui.exportDescription.textContent = cancelled
      ? "Export stopped. You can resume the images that were not downloaded."
      : `${failed} image${failed === 1 ? "" : "s"} could not be downloaded. ${remaining} transient failure${remaining === 1 ? "" : "s"} can be retried.`;
    ui.confirmExport.classList.remove("hidden");
    ui.confirmExport.textContent = cancelled
      ? `Resume remaining (${remaining})`
      : `Retry failed (${remaining})`;
    ui.confirmExport.disabled = false;
    ui.cancelExport.textContent = "Close";
  }

  async function exportAllGeneratedImages() {
    if (state.exportingImages || pendingImageRecords.length === 0) return;

    persistWatermarkSetting(ui.exportRemoveWatermark.checked);
    const session = imageExportSession;
    if (!session) return;
    const records = [...pendingImageRecords];
    const controller = new pageWindow.AbortController();
    state.imageExportAbortController = controller;
    setExportBusy(true);

    try {
      await forEachSequential(records, async (record, index) => {
        if (controller.signal.aborted) {
          throw new pageWindow.DOMException("Cancelled", "AbortError");
        }
        const recordKey = imageExportRecordKey(record);
        let attemptsMade = 0;
        ui.exportProgress.textContent =
          `Downloading ${index + 1}/${records.length}…`;
        try {
          const result = await retryOperation(
            (attempt) => {
              attemptsMade = attempt;
              return prepareDownloadedImage(
                record,
                state.removeWatermark,
                controller.signal,
              );
            },
            {
              attempts: IMAGE_EXPORT_MAX_ATTEMPTS,
              shouldRetry: isRetryableImageExportError,
              onRetry: (_error, nextAttempt) => {
                ui.exportProgress.textContent =
                  `Retrying ${index + 1}/${records.length} · Attempt ${nextAttempt}/${IMAGE_EXPORT_MAX_ATTEMPTS}…`;
              },
              wait: (attempt) =>
                sleep(
                  IMAGE_EXPORT_RETRY_DELAY * 2 ** (attempt - 1),
                  controller.signal,
                ),
            },
          );
          if (controller.signal.aborted) {
            throw new pageWindow.DOMException("Cancelled", "AbortError");
          }
          saveBlob(
            result.blob,
            generatedImageFilename(record, result.blob.type),
            3_000,
          );
          session.downloaded.add(recordKey);
          session.failures.delete(recordKey);
          if (result.watermarkError) {
            session.watermarkFallbacks.add(recordKey);
          } else {
            session.watermarkFallbacks.delete(recordKey);
          }
        } catch (error) {
          if (error?.name === "AbortError") throw error;
          const message = error?.message || "Download failed";
          session.failures.set(recordKey, {
            record,
            message,
            retryable: isRetryableImageExportError(error),
            attempts: attemptsMade,
          });
          console.warn(
            `[Gemini Toolkit] ${generatedImageFilename(record, "image/jpeg")}: ${message}`,
            error,
          );
        }
        ui.exportProgress.textContent =
          `Processed ${index + 1}/${records.length} · ${imageExportSummary(session)}`;
        if (index + 1 < records.length) {
          await sleep(IMAGE_EXPORT_DOWNLOAD_DELAY, controller.signal);
        }
      });
      setExportBusy(false);
      prepareImageExportFollowUp(session);
      setImageToast(
        `${imageExportSummary(session)}.`,
        session.failures.size > 0 || session.watermarkFallbacks.size > 0,
      );
    } catch (error) {
      const cancelled = error?.name === "AbortError";
      if (cancelled) {
        setExportBusy(false);
        prepareImageExportFollowUp(session, { cancelled: true });
        setImageToast(`Image export stopped. ${imageExportSummary(session)}.`);
      } else {
        ui.exportProgress.textContent = error?.message || "Export failed.";
        ui.cancelExport.textContent = "Close";
        setImageToast(ui.exportProgress.textContent, true);
      }
    } finally {
      state.imageExportAbortController = null;
      setExportBusy(false);
    }
  }

  function setStatus(message, error = false) {
    ui.status.textContent = message;
    ui.status.classList.toggle("error", error);
  }

  function updateControls() {
    const hasConversations = state.conversations.length > 0;
    const hasSelection = state.selectedIds.size > 0;

    ui.scan.disabled = state.loading || state.deleting;
    ui.search.disabled = !hasConversations || state.deleting;
    ui.age.disabled = !hasConversations || state.deleting;
    ui.protectCurrent.disabled = state.deleting;
    ui.protectPinned.disabled = state.deleting;
    ui.selectFiltered.disabled =
      !hasConversations || state.loading || state.deleting;
    ui.clearSelection.disabled = !hasSelection || state.deleting;
    ui.deleteSelected.disabled =
      !hasSelection || state.loading || state.deleting;
    ui.concurrency.disabled = state.deleting;
    ui.close.disabled = state.deleting;
    ui.cancel.classList.toggle("hidden", !state.deleting);
    ui.deleteSelected.textContent = hasSelection
      ? `Delete selected (${state.selectedIds.size})`
      : "Delete selected";
    if (
      !state.loading &&
      !state.deleting &&
      state.conversations.length > 0
    ) {
      ui.progress.textContent = hasSelection
        ? `${state.selectedIds.size} conversation${state.selectedIds.size === 1 ? "" : "s"} selected. A confirmation phrase is required.`
        : "Nothing is selected. Deleted conversations cannot be recovered.";
    }
  }

  function updateStatusSummary() {
    if (state.loading || state.deleting) {
      return;
    }
    const visible = getFilteredConversations().length;
    setStatus(
      `Loaded ${state.conversations.length} · Filtered ${visible} · Selected ${state.selectedIds.size}`,
    );
  }

  function createConversationRow(conversation) {
    const row = document.createElement("div");
    row.className = "row";
    row.dataset.id = conversation.id;
    row.setAttribute("role", "listitem");
    const protectedConversation = isProtected(conversation);
    row.classList.toggle("protected", protectedConversation);
    row.classList.toggle("success", conversation.outcome === "success");
    row.classList.toggle("failed", conversation.outcome === "failed");

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.setAttribute(
      "aria-label",
      `Select conversation: ${conversation.title}`,
    );
    checkbox.checked = state.selectedIds.has(conversation.id);
    checkbox.disabled =
      protectedConversation ||
      state.deleting ||
      conversation.outcome === "success";
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) {
        state.selectedIds.add(conversation.id);
      } else {
        state.selectedIds.delete(conversation.id);
      }
      updateStatusSummary();
      updateControls();
    });

    const body = document.createElement("div");
    const title = document.createElement("div");
    title.className = "row-title";
    title.textContent = conversation.title;
    title.title = conversation.title;
    const meta = document.createElement("div");
    meta.className = "row-meta";

    const date = document.createElement("span");
    date.textContent = formatDate(conversation.updatedAt);
    meta.append(date);

    if (conversation.pinned) {
      const badge = document.createElement("span");
      badge.className = "badge";
      badge.textContent = "Pinned";
      meta.append(badge);
    }
    if (
      state.protectCurrent &&
      conversation.id === getCurrentConversationId()
    ) {
      const badge = document.createElement("span");
      badge.className = "badge";
      badge.textContent = "Current";
      meta.append(badge);
    }
    if (conversation.outcome === "success") {
      const badge = document.createElement("span");
      badge.className = "badge";
      badge.textContent = "Deleted";
      meta.append(badge);
    } else if (conversation.outcome === "failed") {
      const badge = document.createElement("span");
      badge.className = "badge";
      badge.textContent = "Failed";
      meta.append(badge);
    }

    body.append(title, meta);

    const open = document.createElement("a");
    open.className = "open-link";
    open.href = `/app/${conversation.id.replace(/^c_/u, "")}`;
    open.target = "_blank";
    open.rel = "noopener noreferrer";
    open.textContent = "Open";
    open.addEventListener("click", (event) => event.stopPropagation());

    row.append(checkbox, body, open);
    return row;
  }

  function renderList() {
    const visible = getFilteredConversations();
    const previousScrollTop = ui.list.scrollTop;
    ui.list.replaceChildren();

    if (visible.length === 0) {
      const empty = document.createElement("div");
      empty.className = "empty";
      empty.textContent =
        state.conversations.length === 0
          ? "No conversations were returned."
          : "No conversations match the current filters.";
      ui.list.append(empty);
    } else {
      const fragment = document.createDocumentFragment();
      for (const conversation of visible) {
        fragment.append(createConversationRow(conversation));
      }
      ui.list.append(fragment);
    }
    ui.list.scrollTop = previousScrollTop;

    updateStatusSummary();
    updateControls();
  }

  function removeProtectedSelections() {
    for (const conversation of state.conversations) {
      if (isProtected(conversation)) {
        state.selectedIds.delete(conversation.id);
      }
    }
  }

  async function scanConversations() {
    if (state.loading || state.deleting) {
      return;
    }

    state.loading = true;
    state.selectedIds.clear();
    ui.scan.textContent = "Loading…";
    ui.progress.textContent = "Loading pinned and standard conversations…";
    setStatus("Loading pinned conversations…");
    updateControls();
    let failureMessage = "";

    try {
      const pinned = await fetchConversationGroup(1, true, (count) => {
        setStatus(`Loading pinned conversations… ${count}`);
      });
      setStatus("Loading standard conversations…");
      const recent = await fetchConversationGroup(0, false, (count) => {
        setStatus(`Loading standard conversations… ${count}`);
      });

      const merged = new Map();
      for (const conversation of [...recent, ...pinned]) {
        const existing = merged.get(conversation.id);
        merged.set(
          conversation.id,
          existing
            ? { ...existing, pinned: existing.pinned || conversation.pinned }
            : conversation,
        );
      }
      state.conversations = [...merged.values()].sort(
        (left, right) =>
          Number(right.pinned) - Number(left.pinned) ||
          right.updatedAt - left.updatedAt,
      );
      removeProtectedSelections();
      ui.progress.textContent =
        "Nothing is selected by default. A confirmation phrase is required before deletion.";
    } catch (error) {
      console.error("[Gemini Toolkit] Load failed", error);
      failureMessage = error?.message || "Could not load conversations.";
      ui.progress.textContent =
        "If you just signed in or the page has been open for a while, refresh Gemini and try again.";
    } finally {
      state.loading = false;
      ui.scan.textContent = "Reload";
      renderList();
      if (failureMessage) {
        setStatus(failureMessage, true);
      }
    }
  }

  async function runDeletion() {
    if (state.deleting || state.selectedIds.size === 0) {
      return;
    }

    removeProtectedSelections();
    const targets = state.conversations.filter((conversation) =>
      state.selectedIds.has(conversation.id),
    );
    if (targets.length === 0) {
      renderList();
      return;
    }

    const phrase = `DELETE ${targets.length}`;
    const entered = pageWindow.prompt(
      `You are about to permanently delete ${targets.length} Gemini conversations. This cannot be undone.\n\nEnter ${phrase} to continue:`,
      "",
    );
    if (entered !== phrase) {
      ui.progress.textContent =
        "The confirmation phrase did not match. Nothing was deleted.";
      return;
    }

    state.deleting = true;
    state.abortController = new pageWindow.AbortController();
    const { signal } = state.abortController;
    const concurrency = Math.max(
      1,
      Math.min(3, Number(ui.concurrency.value) || 2),
    );
    let cursor = 0;
    let completed = 0;
    let succeeded = 0;
    let failed = 0;

    setStatus(`Deleting 0 of ${targets.length}…`);
    ui.progress.textContent =
      "Keep this page open. Select Stop to cancel requests that have not started.";
    updateControls();
    renderList();

    const worker = async () => {
      while (!signal.aborted) {
        const index = cursor;
        cursor += 1;
        if (index >= targets.length) {
          return;
        }

        const conversation = targets[index];
        try {
          await deleteConversation(conversation.id, signal);
          conversation.outcome = "success";
          state.selectedIds.delete(conversation.id);
          succeeded += 1;
        } catch (error) {
          if (error?.name === "AbortError") {
            return;
          }
          console.error(
            `[Gemini Toolkit] Failed to delete ${conversation.id}`,
            error,
          );
          conversation.outcome = "failed";
          failed += 1;
        } finally {
          completed += 1;
          setStatus(
            `Deleting ${completed} of ${targets.length} · Succeeded ${succeeded} · Failed ${failed}`,
            failed > 0,
          );
          renderList();
        }

        if (!signal.aborted) {
          try {
            await sleep(220 + Math.random() * 180, signal);
          } catch {
            return;
          }
        }
      }
    };

    try {
      await Promise.all(
        Array.from({ length: Math.min(concurrency, targets.length) }, worker),
      );
    } finally {
      const stopped = signal.aborted;
      state.deleting = false;
      state.abortController = null;
      renderList();
      setStatus(
        `${stopped ? "Stopped" : "Complete"} · Succeeded ${succeeded} · Failed ${failed}`,
        failed > 0,
      );
      ui.progress.textContent =
        stopped
          ? "No further requests will be sent. Reload the list to verify any items that were in progress."
          : failed > 0
          ? "Failed items remain in the list and can be selected again. Reload to verify the server state."
          : "Deletion is complete. Reload the list to verify the server state.";
    }
  }

  function openDialog() {
    ui.overlay.classList.remove("hidden");
    ui.launcher.disabled = true;
    ui.exportLauncher.disabled = true;
    ui.close.focus();
    if (state.conversations.length === 0 && !state.loading) {
      void scanConversations();
    }
  }

  function closeDialog() {
    if (!state.deleting) {
      ui.overlay.classList.add("hidden");
      ui.launcher.disabled = false;
      ui.exportLauncher.disabled = false;
      ui.launcher.focus();
    }
  }

  function keepFocusInsideDialog(event) {
    if (event.key !== "Tab") {
      return;
    }

    const dialogSelector = !ui.exportOverlay.classList.contains("hidden")
      ? ".export-panel"
      : !ui.overlay.classList.contains("hidden")
      ? ".panel"
      : "";
    if (!dialogSelector) return;

    const focusable = [...ui.shadow.querySelectorAll(
      `${dialogSelector} button:not(:disabled), ${dialogSelector} input:not(:disabled), ${dialogSelector} select:not(:disabled), ${dialogSelector} a[href], ${dialogSelector} summary`,
    )].filter((element) => element.getClientRects().length > 0);
    if (focusable.length === 0) {
      return;
    }

    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = ui.shadow.activeElement;
    if (event.shiftKey && active === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    } else if (!focusable.includes(active)) {
      event.preventDefault();
      first.focus();
    }
  }

  function persistModeDefaults() {
    writeSetting(SETTINGS.model, state.defaultModel);
    writeSetting(SETTINGS.thinking, state.defaultThinking);
  }

  ui.defaultModel.addEventListener("change", () => {
    state.defaultModel = ui.defaultModel.value;
    persistModeDefaults();
    manualModeOverride = false;
    scheduleModeDefaults({ force: true, delay: 0 });
  });
  ui.defaultThinking.addEventListener("change", () => {
    state.defaultThinking = ui.defaultThinking.value;
    persistModeDefaults();
    manualModeOverride = false;
    scheduleModeDefaults({ force: true, delay: 0 });
  });
  ui.removeWatermark.addEventListener("change", () => {
    persistWatermarkSetting(ui.removeWatermark.checked);
  });
  ui.applyDefaults.addEventListener("click", () => {
    manualModeOverride = false;
    scheduleModeDefaults({ force: true, delay: 0 });
  });

  ui.launcherToggle.addEventListener("click", () => {
    setLauncherMenuOpen(ui.launcherMenu.classList.contains("hidden"));
  });
  ui.launcher.addEventListener("click", () => {
    setLauncherMenuOpen(false);
    openDialog();
  });
  ui.exportLauncher.addEventListener("click", () => {
    setLauncherMenuOpen(false);
    openExportDialog();
  });
  ui.closeExport.addEventListener("click", closeExportDialog);
  ui.exportRemoveWatermark.addEventListener("change", () => {
    persistWatermarkSetting(ui.exportRemoveWatermark.checked);
  });
  ui.confirmExport.addEventListener(
    "click",
    () => void exportAllGeneratedImages(),
  );
  ui.cancelExport.addEventListener("click", () => {
    if (state.exportingImages) {
      state.imageExportAbortController?.abort();
    } else {
      closeExportDialog();
    }
  });
  ui.exportOverlay.addEventListener("click", (event) => {
    if (event.target === ui.exportOverlay) {
      closeExportDialog();
    }
  });
  ui.close.addEventListener("click", closeDialog);
  ui.overlay.addEventListener("click", (event) => {
    if (event.target === ui.overlay) {
      closeDialog();
    }
  });
  ui.scan.addEventListener("click", () => void scanConversations());
  ui.search.addEventListener("input", () => {
    state.query = ui.search.value;
    renderList();
  });
  ui.age.addEventListener("change", () => {
    state.olderThanDays = Number(ui.age.value) || 0;
    renderList();
  });
  ui.protectCurrent.addEventListener("change", () => {
    state.protectCurrent = ui.protectCurrent.checked;
    removeProtectedSelections();
    renderList();
  });
  ui.protectPinned.addEventListener("change", () => {
    state.protectPinned = ui.protectPinned.checked;
    removeProtectedSelections();
    renderList();
  });
  ui.selectFiltered.addEventListener("click", () => {
    for (const conversation of getFilteredConversations()) {
      if (!isProtected(conversation) && conversation.outcome !== "success") {
        state.selectedIds.add(conversation.id);
      }
    }
    renderList();
  });
  ui.clearSelection.addEventListener("click", () => {
    state.selectedIds.clear();
    renderList();
  });
  ui.deleteSelected.addEventListener("click", () => void runDeletion());
  ui.cancel.addEventListener("click", () => state.abortController?.abort());
  pageWindow.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !ui.launcherMenu.classList.contains("hidden")) {
      setLauncherMenuOpen(false);
      ui.launcherToggle.focus();
      return;
    }
    if (
      event.key === "Escape" &&
      !ui.exportOverlay.classList.contains("hidden")
    ) {
      closeExportDialog();
      return;
    }
    if (event.key === "Escape" && !ui.overlay.classList.contains("hidden")) {
      closeDialog();
      return;
    }
    keepFocusInsideDialog(event);
  });
  pageWindow.addEventListener("click", (event) => {
    if (!event.composedPath().includes(ui.host)) {
      setLauncherMenuOpen(false);
    }
  });
  pageWindow.addEventListener("resize", mountLauncherNearConversationActions);
  pageWindow.addEventListener("beforeunload", (event) => {
    if (state.deleting || state.exportingImages) {
      event.preventDefault();
      event.returnValue = "";
    }
  });

  document.addEventListener(
    "click",
    (event) => {
      if (!event.isTrusted || !(event.target instanceof pageWindow.Element)) {
        return;
      }
      const target = event.target;
      const fullSizeButton = target.closest(FULL_SIZE_BUTTON_SELECTOR);
      if (fullSizeButton && state.removeWatermark) {
        // Keep Gemini's native resolver and downloader. The response-blob hook
        // above processes the full-resolution bytes immediately before save.
        queueNativeWatermarkDownload(fullSizeButton);
      }
      if (
        target.closest(MODE_BUTTON_SELECTOR) ||
        target.closest(MODE_ITEM_SELECTOR)
      ) {
        manualModeOverride = true;
        pageWindow.clearTimeout(modeApplyTimer);
        setModeStatus(
          "Manual control for this chat; a new chat will re-apply defaults.",
        );
        return;
      }
      if (target.closest('a[href="/app"], a[href="/"]')) {
        manualModeOverride = false;
        resetCapturedGeneratedImages();
        scheduleGeneratedImageCapture();
        scheduleModeDefaults({ delay: 600 });
      }
      // Gemini's full-size click is never cancelled or propagation-stopped.
    },
    true,
  );

  const modeObserver = new pageWindow.MutationObserver((mutations) => {
    mountLauncherNearConversationActions();
    if (manualModeOverride || !getModeButton()) {
      return;
    }
    const modeSurfaceChanged = mutations.some(
      (mutation) => {
        if (
          mutation.type === "attributes" &&
          mutation.target.matches?.(MODE_BUTTON_SELECTOR)
        ) {
          return true;
        }
        if (mutation.type !== "childList") {
          return false;
        }
        return [...mutation.addedNodes].some(
          (node) =>
            node instanceof pageWindow.Element &&
            (node.matches(MODE_BUTTON_SELECTOR) ||
              node.matches(MODE_MENU_SELECTOR) ||
              node.querySelector(MODE_BUTTON_SELECTOR) ||
              node.querySelector(MODE_MENU_SELECTOR)),
        );
      },
    );
    if (modeSurfaceChanged) {
      scheduleModeDefaults();
    }
  });
  modeObserver.observe(document.documentElement, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ["aria-label"],
  });

  const imageObserver = new pageWindow.MutationObserver(() => {
    scheduleGeneratedImageCapture();
  });
  imageObserver.observe(document.documentElement, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: [
      "aria-label",
      "src",
      "jslog",
      "data-gwr-stable-source",
      "data-gwr-source-url",
      "data-gwr-page-image-source",
      "data-image-attachment-index",
    ],
  });

  pageWindow.setInterval(() => {
    const locationKey = `${pageWindow.location.pathname}${pageWindow.location.search}`;
    if (locationKey === lastLocationKey) {
      return;
    }
    lastLocationKey = locationKey;
    manualModeOverride = false;
    resetCapturedGeneratedImages();
    scheduleGeneratedImageCapture();
    scheduleModeDefaults({ delay: 500 });
  }, 500);

  mountLauncherNearConversationActions();
  resetCapturedGeneratedImages();
  captureCurrentGeneratedImages();
  scheduleModeDefaults({ delay: 250 });
})();
