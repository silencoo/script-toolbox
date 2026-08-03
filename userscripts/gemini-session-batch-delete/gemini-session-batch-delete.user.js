// ==UserScript==
// @name         Gemini Toolkit: Defaults, Images & Conversations
// @namespace    https://gemini.google.com/
// @version      0.4.0
// @description  Keep Gemini defaults, download generated images concurrently, export full-size images, and safely manage conversations.
// @author       silencoo
// @match        https://gemini.google.com/*
// @run-at       document-idle
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      lh3.googleusercontent.com
// @connect      *.googleusercontent.com
// @require      https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js
// @require      https://raw.githubusercontent.com/silencoo/script-toolbox/main/userscripts/gemini-session-batch-delete/vendor/gargantua-core.js
// @noframes
// ==/UserScript==

(() => {
  "use strict";

  const RPC = Object.freeze({
    listConversations: "MaZiqc",
    deleteConversation: "GzXR5e",
  });
  const PAGE_SIZE = 20;
  const MAX_PAGES_PER_GROUP = 500;
  const HOST_ID = "gemini-batch-delete-userscript";
  const FULL_SIZE_BUTTON_SELECTOR =
    'button[aria-label="Download full size image"]';
  const IMAGE_DOWNLOAD_CONCURRENCY = 3;
  const FULL_SIZE_REDIRECT_HOPS = 4;
  const CORNER_CROP_EDGE = 384;
  const MODE_BUTTON_SELECTOR =
    '[data-test-id="bard-mode-menu-button"]';
  const MODE_MENU_SELECTOR = 'gem-menu[role="menu"]';
  const MODE_ITEM_SELECTOR = 'gem-menu-item[role="menuitem"]';
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

  function buildFullSizeProbeUrls(value) {
    const base = normalizeGeneratedImageUrl(value);
    if (!base) {
      return [];
    }
    const candidates = [];
    const add = (candidate) => {
      if (candidate && !candidates.includes(candidate)) {
        candidates.push(candidate);
      }
    };
    const addForBase = (candidateBase) => {
      add(`${candidateBase}=s0-d-I?alr=yes`);
      add(`${candidateBase}=d-I?alr=yes`);
      add(`${candidateBase}?alr=yes`);
    };
    addForBase(base);
    const rdGg = rewriteGoogleusercontentGgToRdGg(base);
    if (rdGg) {
      addForBase(rdGg);
    }
    return candidates;
  }

  function extensionForMimeType(value) {
    const type = String(value || "").toLocaleLowerCase();
    if (type.includes("png")) return "png";
    if (type.includes("webp")) return "webp";
    if (type.includes("gif")) return "gif";
    return "jpg";
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

  if (
    typeof document === "undefined" &&
    typeof module === "object" &&
    module?.exports
  ) {
    module.exports = {
      buildFullSizeProbeUrls,
      extensionForMimeType,
      modelLabelMatches,
      modeLabelHasExtended,
      normalizeModeLabel,
      normalizeGeneratedImageUrl,
      rewriteGoogleusercontentGgToRdGg,
    };
    return;
  }

  const pageWindow =
    typeof unsafeWindow === "undefined" ? window : unsafeWindow;
  const pageFetch = pageWindow.fetch.bind(pageWindow);
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
            throw new RpcError(`RPC ${rpcId} returned an unsupported payload.`);
          }

          try {
            return JSON.parse(row[2]);
          } catch {
            throw new RpcError(`Could not parse the response from RPC ${rpcId}.`);
          }
        }
      }
    }

    throw new RpcError(
      `Gemini did not return a result for RPC ${rpcId}. Its internal interface may have changed.`,
    );
  }

  async function executeRpc(rpcId, rpcPayload, signal) {
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

    return parseRpcResponse(await response.text(), rpcId);
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

  const activeImageDownloads = new WeakSet();
  let watermarkEnginePromise = null;

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
        reject(new Error("GM_xmlhttpRequest is unavailable."));
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
        onerror: () => finish(reject, new Error("The image request failed.")),
        ontimeout: () => finish(reject, new Error("The image request timed out.")),
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

  async function fetchFullSizeImageBlob(sourceUrl, signal) {
    const probes = buildFullSizeProbeUrls(sourceUrl);
    let lastError = null;

    for (const probe of probes) {
      let currentUrl = probe;
      for (let hop = 0; hop < FULL_SIZE_REDIRECT_HOPS; hop += 1) {
        try {
          const response = await requestArrayBuffer(currentUrl, signal);
          if (response.status < 200 || response.status >= 400) {
            throw new Error(`Image request returned HTTP ${response.status}.`);
          }
          const buffer = response.response;
          if (!(buffer instanceof ArrayBuffer) || buffer.byteLength === 0) {
            throw new Error("Gemini returned an empty image response.");
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
            throw new Error("Gemini did not return an image URL.");
          }
          currentUrl = nextUrl;
        } catch (error) {
          if (error?.name === "AbortError") throw error;
          lastError = error;
          break;
        }
      }
    }

    throw lastError || new Error("No full-size image source was found.");
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
    const sourceUrl =
      image.getAttribute("data-gwr-stable-source") ||
      image.getAttribute("data-gwr-source-url") ||
      image.getAttribute("data-gwr-page-image-source") ||
      image.currentSrc ||
      image.src ||
      "";
    const normalizedSource = normalizeGeneratedImageUrl(sourceUrl);
    if (!normalizedSource) return null;
    const jslog = button.getAttribute("jslog") || "";
    const responseId = jslog.match(/\[\["(r_[^"]+)"/u)?.[1] || "";
    return {
      button,
      image,
      sourceUrl: normalizedSource,
      responseId,
      index,
    };
  }

  function collectGeneratedImageRecords() {
    const records = [];
    const seen = new Set();
    for (const button of document.querySelectorAll(FULL_SIZE_BUTTON_SELECTOR)) {
      const record = imageRecordFromButton(button, records.length + 1);
      if (!record || seen.has(record.sourceUrl)) continue;
      seen.add(record.sourceUrl);
      records.push(record);
    }
    return records;
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

  async function removeWatermarkFromImageBlob(blob) {
    const image = await decodeImageBlob(blob);
    const width = image.naturalWidth || image.width;
    const height = image.naturalHeight || image.height;
    const edge = Math.min(width, height, CORNER_CROP_EDGE);
    const cropX = width - edge;
    const cropY = height - edge;
    const cropCanvas = document.createElement("canvas");
    cropCanvas.width = edge;
    cropCanvas.height = edge;
    const cropContext = cropCanvas.getContext("2d", {
      willReadFrequently: true,
    });
    if (!cropContext) {
      image.close?.();
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
    const processedCrop = await engine.removeWatermarkFromImage(cropCanvas, {
      adaptiveMode: "always",
    });
    if (processedCrop.__watermarkMeta?.applied !== true) {
      image.close?.();
      return { blob, removed: false };
    }

    const output = document.createElement("canvas");
    output.width = width;
    output.height = height;
    const outputContext = output.getContext("2d");
    if (!outputContext) {
      image.close?.();
      throw new Error("Canvas export is unavailable.");
    }
    outputContext.drawImage(image, 0, 0);
    outputContext.drawImage(processedCrop, cropX, cropY);
    image.close?.();
    const outputType = ["image/png", "image/jpeg", "image/webp"].includes(
      blob.type,
    )
      ? blob.type
      : "image/png";
    return {
      blob: await canvasToBlob(output, outputType, 0.92),
      removed: true,
    };
  }

  function generatedImageFilename(record, mimeType) {
    const conversation =
      getCurrentConversationId().replace(/^c_/u, "") || "conversation";
    const response = record.responseId.replace(/^r_/u, "").slice(0, 10);
    const suffix = response ? `-${response}` : "";
    return `gemini-${conversation.slice(0, 12)}-${String(record.index).padStart(3, "0")}${suffix}.${extensionForMimeType(mimeType)}`;
  }

  function saveBlob(blob, filename) {
    const objectUrl = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = objectUrl;
    anchor.download = filename;
    anchor.hidden = true;
    document.documentElement.append(anchor);
    anchor.click();
    anchor.remove();
    pageWindow.setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
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
          right: 24px;
          bottom: 24px;
          display: flex;
          align-items: center;
          gap: 8px;
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
          padding: 20px;
          color: var(--muted);
          font-size: 14px;
          line-height: 1.5;
        }
        .export-body p { margin: 0; }
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
          right: 24px;
          bottom: 78px;
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
          .launchers {
            right: 14px;
            bottom: 14px;
            max-width: calc(100vw - 28px);
            flex-wrap: wrap;
            justify-content: flex-end;
          }
          .launcher { padding: 10px 12px; }
          .toast { right: 14px; bottom: 112px; }
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
    const exportLauncher = addButton(
      launchers,
      "export-launcher",
      "launcher secondary",
      "Export all full-size images",
    );
    const launcher = addButton(
      launchers,
      "launcher",
      "launcher",
      "Gemini Toolkit",
    );
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
        "aria-label": "Remove watermark from downloaded Gemini images",
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
      text: "Images are fetched with up to three concurrent requests and saved in one ZIP file. Keep this tab open until the archive is ready.",
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
      "Export ZIP",
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
      exportRemoveWatermark,
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
    const originalBlob = await fetchFullSizeImageBlob(record.sourceUrl, signal);
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

  async function downloadSingleGeneratedImage(button) {
    if (activeImageDownloads.has(button)) {
      setImageToast("This image download is already running.");
      return;
    }
    const allRecords = collectGeneratedImageRecords();
    const record =
      allRecords.find((candidate) => candidate.button === button) ||
      imageRecordFromButton(button, 1);
    if (!record) {
      setImageToast("Could not locate the full-size source for this image.", true);
      return;
    }

    activeImageDownloads.add(button);
    button.setAttribute("aria-busy", "true");
    button.dataset.geminiToolkitDownload = "active";
    setImageToast(
      state.removeWatermark
        ? "Downloading full-size image and removing watermark…"
        : "Downloading full-size image…",
    );
    try {
      const result = await prepareDownloadedImage(
        record,
        state.removeWatermark,
      );
      saveBlob(
        result.blob,
        generatedImageFilename(record, result.blob.type),
      );
      if (result.watermarkError) {
        setImageToast(
          "The original image was downloaded, but watermark removal failed.",
          true,
        );
      } else {
        setImageToast(
          result.removed
            ? "Full-size image downloaded without the detected watermark."
            : "Full-size image downloaded.",
        );
      }
    } catch (error) {
      console.warn("[Gemini Toolkit] Full-size download failed", error);
      setImageToast(
        error?.name === "AbortError"
          ? "Image download cancelled."
          : error?.message || "Full-size image download failed.",
        true,
      );
    } finally {
      activeImageDownloads.delete(button);
      button.removeAttribute("aria-busy");
      delete button.dataset.geminiToolkitDownload;
    }
  }

  function openExportDialog() {
    pendingImageRecords = collectGeneratedImageRecords();
    const count = pendingImageRecords.length;
    ui.exportDescription.textContent = count
      ? `Found ${count} generated image${count === 1 ? "" : "s"} in the current conversation. Confirm to fetch every full-size image.`
      : "No generated images with a full-size download button were found in the loaded conversation.";
    ui.exportProgress.textContent = count ? "Ready." : "Nothing to export.";
    ui.confirmExport.disabled = count === 0;
    ui.exportRemoveWatermark.checked = state.removeWatermark;
    ui.exportOverlay.classList.remove("hidden");
    ui.exportLauncher.disabled = true;
    ui.launcher.disabled = true;
    (count ? ui.confirmExport : ui.closeExport).focus();
  }

  function closeExportDialog() {
    if (state.exportingImages) return;
    ui.exportOverlay.classList.add("hidden");
    ui.exportLauncher.disabled = false;
    ui.launcher.disabled = false;
    ui.exportLauncher.focus();
  }

  function setExportBusy(busy) {
    state.exportingImages = busy;
    ui.confirmExport.disabled = busy || pendingImageRecords.length === 0;
    ui.closeExport.disabled = busy;
    ui.exportRemoveWatermark.disabled = busy;
    ui.cancelExport.textContent = busy ? "Stop" : "Cancel";
  }

  async function exportAllGeneratedImages() {
    if (state.exportingImages || pendingImageRecords.length === 0) return;
    const Zip = globalThis.JSZip;
    if (typeof Zip !== "function") {
      ui.exportProgress.textContent = "ZIP support did not load.";
      setImageToast("ZIP support did not load. Reinstall the userscript.", true);
      return;
    }

    persistWatermarkSetting(ui.exportRemoveWatermark.checked);
    const controller = new pageWindow.AbortController();
    state.imageExportAbortController = controller;
    setExportBusy(true);
    const zip = new Zip();
    const errors = [];
    let nextIndex = 0;
    let completed = 0;
    let exported = 0;
    let watermarkFallbacks = 0;

    const worker = async () => {
      while (!controller.signal.aborted) {
        const index = nextIndex;
        nextIndex += 1;
        if (index >= pendingImageRecords.length) return;
        const record = pendingImageRecords[index];
        ui.exportProgress.textContent =
          `Fetching ${completed + 1}/${pendingImageRecords.length}…`;
        try {
          const result = await prepareDownloadedImage(
            record,
            state.removeWatermark,
            controller.signal,
          );
          zip.file(
            generatedImageFilename(record, result.blob.type),
            result.blob,
          );
          exported += 1;
          if (result.watermarkError) watermarkFallbacks += 1;
        } catch (error) {
          if (error?.name === "AbortError") return;
          errors.push(
            `${generatedImageFilename(record, "image/jpeg")}: ${error?.message || "Download failed"}`,
          );
        } finally {
          completed += 1;
          ui.exportProgress.textContent =
            `Fetched ${completed}/${pendingImageRecords.length} · Saved ${exported}`;
        }
      }
    };

    try {
      await Promise.all(
        Array.from(
          {
            length: Math.min(
              IMAGE_DOWNLOAD_CONCURRENCY,
              pendingImageRecords.length,
            ),
          },
          worker,
        ),
      );
      if (controller.signal.aborted) {
        throw new pageWindow.DOMException("Cancelled", "AbortError");
      }
      if (exported === 0) {
        throw new Error(errors[0] || "No images could be exported.");
      }
      if (errors.length > 0 || watermarkFallbacks > 0) {
        zip.file(
          "export-report.txt",
          [
            `Exported: ${exported}`,
            `Download failures: ${errors.length}`,
            `Watermark-removal fallbacks: ${watermarkFallbacks}`,
            "",
            ...errors,
          ].join("\n"),
        );
      }
      ui.exportProgress.textContent = "Building ZIP…";
      const archive = await zip.generateAsync(
        { type: "blob", compression: "STORE" },
        ({ percent }) => {
          ui.exportProgress.textContent = `Building ZIP ${Math.round(percent)}%…`;
        },
      );
      const conversation =
        getCurrentConversationId().replace(/^c_/u, "") || "conversation";
      saveBlob(
        archive,
        `gemini-${conversation.slice(0, 12)}-full-size-images.zip`,
      );
      setImageToast(
        `Exported ${exported} full-size image${exported === 1 ? "" : "s"} as a ZIP.`,
        errors.length > 0 || watermarkFallbacks > 0,
      );
      setExportBusy(false);
      closeExportDialog();
    } catch (error) {
      const cancelled = error?.name === "AbortError";
      ui.exportProgress.textContent = cancelled
        ? "Export stopped."
        : error?.message || "Export failed.";
      setImageToast(
        cancelled ? "Image export stopped." : ui.exportProgress.textContent,
        !cancelled,
      );
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
      `${dialogSelector} button:not(:disabled), ${dialogSelector} input:not(:disabled), ${dialogSelector} select:not(:disabled), ${dialogSelector} a[href]`,
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

  ui.launcher.addEventListener("click", openDialog);
  ui.exportLauncher.addEventListener("click", openExportDialog);
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
      if (fullSizeButton) {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        void downloadSingleGeneratedImage(fullSizeButton);
        return;
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
        scheduleModeDefaults({ delay: 600 });
      }
    },
    true,
  );

  const modeObserver = new pageWindow.MutationObserver((mutations) => {
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

  pageWindow.setInterval(() => {
    const locationKey = `${pageWindow.location.pathname}${pageWindow.location.search}`;
    if (locationKey === lastLocationKey) {
      return;
    }
    lastLocationKey = locationKey;
    manualModeOverride = false;
    scheduleModeDefaults({ delay: 500 });
  }, 500);

  scheduleModeDefaults({ delay: 250 });
})();
