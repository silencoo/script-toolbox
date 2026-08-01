// ==UserScript==
// @name         Gemini Conversation Manager
// @namespace    https://gemini.google.com/
// @version      0.2.0
// @description  Review, filter, select, and permanently delete multiple Gemini conversations.
// @author       silencoo
// @match        https://gemini.google.com/*
// @run-at       document-idle
// @grant        unsafeWindow
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
  const state = {
    conversations: [],
    selectedIds: new Set(),
    loading: false,
    deleting: false,
    abortController: null,
    query: "",
    olderThanDays: 0,
    protectCurrent: true,
    protectPinned: true,
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
        .launcher {
          position: fixed;
          z-index: 2147483645;
          right: 24px;
          bottom: 24px;
          border: 1px solid var(--strong);
          border-radius: 7px;
          padding: 11px 16px;
          color: var(--strong-text);
          background: var(--strong);
          box-shadow: 0 6px 18px rgba(0, 0, 0, .18);
          font-weight: 700;
          letter-spacing: .01em;
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
          grid-template-rows: auto auto auto minmax(0, 1fr) auto;
          overflow: hidden;
          color: var(--text);
          background: var(--background);
          border: 1px solid var(--border);
          border-radius: 12px;
          box-shadow: 0 24px 70px rgba(0, 0, 0, .28);
        }
        .header, .toolbar, .selection, .footer {
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
          .launcher { right: 14px; bottom: 14px; }
          .search { min-width: 100%; }
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

    const launcher = addButton(
      shadow,
      "launcher",
      "launcher",
      "Manage Conversations",
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
      text: "Gemini Conversation Manager",
    });
    addElement(headingGroup, "div", {
      id: "dialog-description",
      className: "subtitle",
      text: "Requests are sent only to the current gemini.google.com session.",
    });
    const close = addButton(header, "close", "icon-button", "×");
    close.setAttribute("aria-label", "Close");

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

    return {
      host,
      shadow,
      launcher,
      overlay,
      close,
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
    };
  }

  const ui = createInterface();
  if (!ui) {
    return;
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
      console.error("[Gemini Conversation Manager] Load failed", error);
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
            `[Gemini Conversation Manager] Failed to delete ${conversation.id}`,
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
    ui.close.focus();
    if (state.conversations.length === 0 && !state.loading) {
      void scanConversations();
    }
  }

  function closeDialog() {
    if (!state.deleting) {
      ui.overlay.classList.add("hidden");
      ui.launcher.disabled = false;
      ui.launcher.focus();
    }
  }

  function keepFocusInsideDialog(event) {
    if (
      event.key !== "Tab" ||
      ui.overlay.classList.contains("hidden")
    ) {
      return;
    }

    const focusable = [...ui.shadow.querySelectorAll(
      ".panel button:not(:disabled), .panel input:not(:disabled), .panel select:not(:disabled), .panel a[href]",
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

  ui.launcher.addEventListener("click", openDialog);
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
    if (event.key === "Escape" && !ui.overlay.classList.contains("hidden")) {
      closeDialog();
      return;
    }
    keepFocusInsideDialog(event);
  });
  pageWindow.addEventListener("beforeunload", (event) => {
    if (state.deleting) {
      event.preventDefault();
      event.returnValue = "";
    }
  });
})();

