import "./styles.css";

import {
  getActiveTabSite,
  readCookiesForTarget,
  type ActiveTabSite
} from "./browser-api";
import { copyTextToClipboard } from "./clipboard";
import {
  applyCookieEditDraft,
  cloneCookieRecord,
  cookieRecordsEqual,
  cookieToEditDraft,
  findMatchingCookieIndices,
  paginateCookieIndices,
  type CookieEditDraft,
  type CookieSearchField
} from "./cookie-workbench";
import { downloadTextFile } from "./download";
import {
  EXPORT_FORMATS,
  getExportFormat,
  serializeCookies,
  type ExportFormatId
} from "./exporters";
import type { CookieRecord } from "./model";
import {
  getCookiePermissionPatterns,
  makeExportFilename,
  normalizeSiteTarget,
  TargetValidationError,
  type CookieScope,
  type SiteTarget
} from "./target";

type SourceMode = "current" | "specified";
type Phase = "idle" | "loading" | "ready" | "empty" | "error";
type CopyPhase = "idle" | "copying" | "copied";

const COOKIE_PAGE_SIZE = 10;

interface AppState {
  activeTabSite?: ActiveTabSite;
  cookies: CookieRecord[];
  copyPhase: CopyPhase;
  editingCookieIndex?: number;
  loadedScope?: CookieScope;
  loadedTarget?: SiteTarget;
  mode: SourceMode;
  modifiedCookieIndices: Set<number>;
  originalCookies: CookieRecord[];
  phase: Phase;
  previewPage: number;
  searchField: CookieSearchField;
  searchQuery: string;
  scope: CookieScope;
  showValues: boolean;
}

const state: AppState = {
  cookies: [],
  copyPhase: "idle",
  mode: "current",
  modifiedCookieIndices: new Set(),
  originalCookies: [],
  phase: "idle",
  previewPage: 1,
  searchField: "all",
  searchQuery: "",
  scope: "url",
  showValues: false
};

const sourceRadios = Array.from(
  document.querySelectorAll<HTMLInputElement>('input[name="source"]')
);
const scopeRadios = Array.from(
  document.querySelectorAll<HTMLInputElement>('input[name="scope"]')
);
const currentSource = getElement<HTMLDivElement>("current-source");
const specifiedSource = getElement<HTMLDivElement>("specified-source");
const currentSite = getElement<HTMLParagraphElement>("current-site");
const currentSiteHelp = getElement<HTMLParagraphElement>("current-site-help");
const siteIndicator = document.querySelector<HTMLElement>(".site-indicator");
const siteUrlInput = getElement<HTMLInputElement>("site-url");
const siteUrlError = getElement<HTMLParagraphElement>("site-url-error");
const scopeDescription = getElement<HTMLParagraphElement>("scope-description");
const permissionSummary = getElement<HTMLParagraphElement>("permission-summary");
const formatSelect = getElement<HTMLSelectElement>("export-format");
const formatDescription = getElement<HTMLParagraphElement>("format-description");
const revokePermission = getElement<HTMLInputElement>("revoke-permission");
const readButton = getElement<HTMLButtonElement>("read-cookies");
const copyButton = getElement<HTMLButtonElement>("copy-cookies");
const exportButton = getElement<HTMLButtonElement>("export-cookies");
const showValues = getElement<HTMLInputElement>("show-values");
const errorPanel = getElement<HTMLDivElement>("error-panel");
const errorMessage = getElement<HTMLParagraphElement>("error-message");
const previewPanel = document.querySelector<HTMLElement>(".preview-panel");
const cookieTools = getElement<HTMLDivElement>("cookie-tools");
const cookieSearchField = getElement<HTMLSelectElement>("cookie-search-field");
const cookieSearch = getElement<HTMLInputElement>("cookie-search");
const cookieFilterSummary = getElement<HTMLParagraphElement>("cookie-filter-summary");
const cookieEditor = getElement<HTMLDivElement>("cookie-editor");
const cookieEditForm = getElement<HTMLFormElement>("cookie-edit-form");
const cookieEditorHeading = getElement<HTMLHeadingElement>("cookie-editor-heading");
const cookieEditorIndex = getElement<HTMLSpanElement>("cookie-editor-index");
const editCookieName = getElement<HTMLInputElement>("edit-cookie-name");
const editCookieValue = getElement<HTMLTextAreaElement>("edit-cookie-value");
const editCookieDomain = getElement<HTMLInputElement>("edit-cookie-domain");
const editCookiePath = getElement<HTMLInputElement>("edit-cookie-path");
const editCookieSameSite = getElement<HTMLSelectElement>("edit-cookie-same-site");
const editCookieExpiration = getElement<HTMLInputElement>("edit-cookie-expiration");
const editCookieSecure = getElement<HTMLInputElement>("edit-cookie-secure");
const editCookieHttpOnly = getElement<HTMLInputElement>("edit-cookie-http-only");
const editCookieSession = getElement<HTMLInputElement>("edit-cookie-session");
const editCookieHostOnly = getElement<HTMLInputElement>("edit-cookie-host-only");
const editCookieStoreId = getElement<HTMLInputElement>("edit-cookie-store-id");
const editCookiePartitionSite = getElement<HTMLInputElement>(
  "edit-cookie-partition-site"
);
const editCookiePartitionCrossSite = getElement<HTMLSelectElement>(
  "edit-cookie-partition-cross-site"
);
const cookieEditError = getElement<HTMLParagraphElement>("cookie-edit-error");
const resetCookieEdit = getElement<HTMLButtonElement>("reset-cookie-edit");
const cancelCookieEdit = getElement<HTMLButtonElement>("cancel-cookie-edit");
const previewContent = getElement<HTMLDivElement>("preview-content");
const statusMessage = getElement<HTMLParagraphElement>("status-message");

initializeFormatOptions();
bindEvents();
renderControls();
void initializeCurrentTab();

function initializeFormatOptions(): void {
  const options = EXPORT_FORMATS.map((format) => {
    const option = document.createElement("option");
    option.value = format.id;
    option.textContent = format.label;
    return option;
  });

  formatSelect.replaceChildren(...options);
  updateFormatDescription();
}

function bindEvents(): void {
  sourceRadios.forEach((radio) => {
    radio.addEventListener("change", () => {
      if (!radio.checked) {
        return;
      }

      state.mode = radio.value as SourceMode;
      clearLoadedCookies();
      clearError();
      clearUrlError();
      renderControls();
      renderPreview();
    });
  });

  siteUrlInput.addEventListener("input", () => {
    clearUrlError();
    clearError();
    clearLoadedCookies();
    renderControls();
    renderPreview();
  });

  scopeRadios.forEach((radio) => {
    radio.addEventListener("change", () => {
      if (!radio.checked) {
        return;
      }

      state.scope = radio.value as CookieScope;
      clearLoadedCookies();
      clearError();
      syncFormatAvailability();
      renderControls();
      renderPreview();
    });
  });

  formatSelect.addEventListener("change", () => {
    state.copyPhase = "idle";
    updateFormatDescription();
    renderControls();
  });

  cookieSearch.addEventListener("input", handleCookieSearchChange);
  cookieSearch.addEventListener("search", handleCookieSearchChange);

  cookieSearchField.addEventListener("change", () => {
    state.searchField = cookieSearchField.value as CookieSearchField;
    state.previewPage = 1;
    renderPreview();
  });

  showValues.addEventListener("change", () => {
    state.showValues = showValues.checked;
    renderPreview();
  });

  readButton.addEventListener("click", () => {
    void handleReadCookies();
  });

  copyButton.addEventListener("click", () => {
    void handleCopy();
  });

  exportButton.addEventListener("click", handleExport);

  cookieEditForm.addEventListener("submit", handleCookieEditSubmit);
  cancelCookieEdit.addEventListener("click", closeCookieEditor);
  resetCookieEdit.addEventListener("click", handleResetCookieEdit);
  editCookieSession.addEventListener("change", syncExpirationInput);
  cookieEditForm.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      closeCookieEditor();
    }
  });
}

function handleCookieSearchChange(): void {
  state.searchQuery = cookieSearch.value;
  state.previewPage = 1;
  renderPreview();
}

async function initializeCurrentTab(): Promise<void> {
  try {
    state.activeTabSite = await getActiveTabSite();
    currentSite.textContent = state.activeTabSite.target.href;
    currentSite.title = state.activeTabSite.target.href;
    currentSiteHelp.textContent =
      "默认包含会发送到该 URL 的父域 Cookie；可在下方切换范围。";
    siteIndicator?.removeAttribute("data-state");
  } catch (error) {
    currentSite.textContent = "当前标签页不可读取";
    currentSiteHelp.textContent = getErrorMessage(error);
    siteIndicator?.setAttribute("data-state", "error");
  }

  renderControls();
}

async function handleReadCookies(): Promise<void> {
  let target: SiteTarget;

  try {
    target = resolveSelectedTarget();
  } catch (error) {
    const message = getErrorMessage(error);

    if (state.mode === "specified") {
      showUrlError(message);
      siteUrlInput.focus();
    } else {
      showError(message);
    }

    return;
  }

  clearError();
  clearUrlError();
  state.cookies = [];
  state.copyPhase = "idle";
  delete state.editingCookieIndex;
  delete state.loadedScope;
  delete state.loadedTarget;
  state.modifiedCookieIndices.clear();
  state.originalCookies = [];
  state.phase = "loading";
  state.previewPage = 1;
  state.searchField = "all";
  state.searchQuery = "";
  cookieSearch.value = "";
  cookieSearchField.value = "all";
  state.showValues = false;
  showValues.checked = false;
  renderControls();
  renderPreview();

  const tabId = state.mode === "current" ? state.activeTabSite?.tabId : undefined;
  const scope = state.scope;

  try {
    const result = await readCookiesForTarget(target, {
      revokePermissionAfterRead: revokePermission.checked,
      scope,
      ...(tabId === undefined ? {} : { tabId })
    });

    state.cookies = result.cookies.map(cloneCookieRecord);
    state.originalCookies = result.cookies.map(cloneCookieRecord);
    state.loadedScope = scope;
    state.loadedTarget = target;
    state.phase = result.cookies.length > 0 ? "ready" : "empty";

    const httpOnlyCount = result.cookies.filter((cookie) => cookie.httpOnly).length;
    const permissionText = revokePermission.checked
      ? result.permissionRemoved
        ? "本次申请的站点权限已移除。"
        : "浏览器未确认权限已移除，请在扩展设置中检查。"
      : "站点权限已保留。";
    const httpOnlyText = httpOnlyCount > 0 ? "其中 " + httpOnlyCount + " 条为 HttpOnly。" : "";

    const rangeText = scope === "url" ? "当前 URL" : target.siteDomain + " 站点域";
    statusMessage.textContent =
      "已按“" + rangeText + "”范围读取 " + result.cookies.length + " 条 Cookie。" +
      httpOnlyText + permissionText;
  } catch (error) {
    state.phase = "error";
    showError(getErrorMessage(error));
    statusMessage.textContent = "读取失败，没有保存或导出任何 Cookie。";
  } finally {
    renderControls();
    renderPreview();
  }
}

function handleExport(): void {
  if (!state.loadedTarget || !state.loadedScope || state.cookies.length === 0) {
    return;
  }

  const { content, exportedAt, format } = createExportPayload();
  const filename = makeExportFilename(
    state.loadedScope === "site"
      ? state.loadedTarget.siteDomain
      : state.loadedTarget.hostname,
    format.id,
    format.extension,
    exportedAt
  );

  downloadTextFile(content, filename, format.mimeType);
  statusMessage.textContent =
    "已生成 " + filename + "。请将文件视为登录凭据并妥善保管。";
}

async function handleCopy(): Promise<void> {
  if (!state.loadedTarget || !state.loadedScope || state.cookies.length === 0) {
    return;
  }

  clearError();
  const { content, format } = createExportPayload();
  state.copyPhase = "copying";
  renderControls();

  try {
    await copyTextToClipboard(content);
    state.copyPhase = "copied";
    statusMessage.textContent =
      "已复制 " +
      state.cookies.length +
      " 条 Cookie 的“" +
      format.label +
      "”内容。剪贴板内容属于登录凭据。";
  } catch (error) {
    state.copyPhase = "idle";
    showError(getErrorMessage(error));
    statusMessage.textContent = "复制失败，剪贴板内容没有更新。";
  } finally {
    renderControls();
  }
}

function createExportPayload() {
  if (!state.loadedTarget || !state.loadedScope || state.cookies.length === 0) {
    throw new Error("没有可导出或复制的 Cookie。");
  }

  const formatId = formatSelect.value as ExportFormatId;
  const format = getExportFormat(formatId);
  const exportedAt = new Date();
  const content = serializeCookies(formatId, state.cookies, {
    exportedAt,
    modifiedCookieCount: state.modifiedCookieIndices.size,
    scope: state.loadedScope,
    siteDomain: state.loadedTarget.siteDomain,
    sourceUrl: state.loadedTarget.href
  });

  return { content, exportedAt, format };
}

function resolveSelectedTarget(): SiteTarget {
  if (state.mode === "current") {
    if (!state.activeTabSite) {
      throw new Error("当前标签页不可读取，请改用“指定网址”。");
    }

    return state.activeTabSite.target;
  }

  return normalizeSiteTarget(siteUrlInput.value);
}

function clearLoadedCookies(): void {
  state.cookies = [];
  state.copyPhase = "idle";
  delete state.editingCookieIndex;
  delete state.loadedScope;
  delete state.loadedTarget;
  state.modifiedCookieIndices.clear();
  state.originalCookies = [];
  state.phase = "idle";
  state.previewPage = 1;
  state.searchField = "all";
  state.searchQuery = "";
  cookieSearch.value = "";
  cookieSearchField.value = "all";
  state.showValues = false;
  showValues.checked = false;
  statusMessage.textContent = "Cookie 值默认隐藏，也不会写入扩展存储。";
}

function renderControls(): void {
  const isLoading = state.phase === "loading";
  const isCopying = state.copyPhase === "copying";
  const isBusy = isLoading || isCopying;
  const isEditing = state.editingCookieIndex !== undefined;
  const lockOuterControls = isBusy || isEditing;
  const hasCookies =
    state.cookies.length > 0 &&
    state.loadedTarget !== undefined &&
    state.loadedScope !== undefined;
  const currentUnavailable = state.mode === "current" && !state.activeTabSite;

  currentSource.hidden = state.mode !== "current";
  specifiedSource.hidden = state.mode !== "specified";
  cookieTools.hidden = !hasCookies || isEditing;
  cookieEditor.hidden = !isEditing;
  previewContent.hidden = isEditing;
  cookieSearch.disabled = isBusy;
  cookieSearchField.disabled = isBusy;
  siteUrlInput.disabled = lockOuterControls;
  formatSelect.disabled = lockOuterControls;
  revokePermission.disabled = lockOuterControls;
  sourceRadios.forEach((radio) => {
    radio.disabled = lockOuterControls;
  });
  scopeRadios.forEach((radio) => {
    radio.disabled = lockOuterControls;
  });
  syncFormatAvailability();
  updateScopeGuidance();
  readButton.disabled = lockOuterControls || currentUnavailable;
  readButton.classList.toggle("is-loading", isLoading);
  readButton.classList.toggle("button-primary", !hasCookies);
  readButton.classList.toggle("button-secondary", hasCookies);
  readButton.textContent = isLoading
    ? "正在读取 Cookie…"
    : hasCookies
      ? "重新读取 Cookie"
      : "授权并读取 Cookie";
  copyButton.disabled = !hasCookies || lockOuterControls;
  copyButton.textContent =
    state.copyPhase === "copying"
      ? "复制中…"
      : state.copyPhase === "copied"
        ? "已复制"
        : "复制";
  exportButton.disabled = !hasCookies || lockOuterControls;
  exportButton.textContent = hasCookies ? "导出 " + state.cookies.length + " 条" : "导出文件";
  showValues.disabled = !hasCookies || lockOuterControls;

  if (isEditing) {
    resetCookieEdit.disabled = !state.modifiedCookieIndices.has(
      state.editingCookieIndex!
    );
  }
}

function renderPreview(): void {
  previewPanel?.setAttribute("aria-busy", String(state.phase === "loading"));

  if (state.editingCookieIndex !== undefined) {
    return;
  }

  if (state.phase === "loading") {
    const loadingList = document.createElement("div");
    loadingList.className = "loading-list";

    for (let index = 0; index < 3; index += 1) {
      const row = document.createElement("div");
      row.className = "loading-row";
      row.setAttribute("aria-hidden", "true");
      loadingList.append(row);
    }

    const loadingLabel = document.createElement("p");
    loadingLabel.className = "sr-only";
    loadingLabel.textContent = "正在读取 Cookie";
    previewContent.replaceChildren(loadingLabel, loadingList);
    return;
  }

  if (state.phase === "empty") {
    previewContent.replaceChildren(
      createEmptyState(
        (state.loadedScope ?? state.scope) === "url"
          ? "没有找到会随这个 URL 发送的 Cookie。可以检查网址路径后重试。"
          : "这个站点域下没有找到可读取的 Cookie。"
      )
    );
    return;
  }

  if (state.cookies.length === 0) {
    previewContent.replaceChildren(
      createEmptyState(
        state.phase === "error"
          ? "读取未完成。修正上方错误后可以再次尝试。"
          : "读取后可在这里确认 Cookie 名称与属性。"
      )
    );
    return;
  }

  const matchingIndices = findMatchingCookieIndices(
    state.cookies,
    state.searchQuery,
    state.searchField
  );
  const modifiedText =
    state.modifiedCookieIndices.size > 0
      ? " · 已修改 " + state.modifiedCookieIndices.size + " 条"
      : "";
  const resultText = state.searchQuery.trim()
    ? "匹配 " + matchingIndices.length + " / " + state.cookies.length + " 条"
    : "共 " + state.cookies.length + " 条";
  const pageSizeText =
    matchingIndices.length > COOKIE_PAGE_SIZE ? " · 每页 " + COOKIE_PAGE_SIZE + " 条" : "";
  cookieFilterSummary.textContent =
    resultText +
    pageSizeText +
    " · 搜索只影响分页预览" +
    modifiedText;

  if (matchingIndices.length === 0) {
    previewContent.replaceChildren(
      createEmptyState("没有匹配的 Cookie。可以更换字段或缩短关键词。")
    );
    return;
  }

  const page = paginateCookieIndices(
    matchingIndices,
    state.previewPage,
    COOKIE_PAGE_SIZE
  );
  state.previewPage = page.page;

  const summary = document.createElement("div");
  summary.className = "cookie-summary";

  const count = document.createElement("strong");
  count.textContent = state.searchQuery.trim()
    ? "找到 " + matchingIndices.length + " / " + state.cookies.length + " 条"
    : state.cookies.length + " 条 Cookie";

  const secureCount = document.createElement("span");
  const protectedCount = matchingIndices.filter((index) => {
    const cookie = state.cookies[index];
    return cookie?.secure || cookie?.httpOnly;
  }).length;
  secureCount.textContent = protectedCount + " 条带安全属性";
  summary.append(count, secureCount);

  const list = document.createElement("div");
  list.className = "cookie-list";
  list.setAttribute("role", "list");

  for (const index of page.indices) {
    const cookie = state.cookies[index];

    if (cookie) {
      list.append(createCookieRow(cookie, index));
    }
  }

  const children: Node[] = [summary];

  if (page.pageCount > 1) {
    children.push(createCookiePagination(page, matchingIndices.length));
  }

  children.push(list);

  previewContent.replaceChildren(...children);
}

function createCookiePagination(
  page: ReturnType<typeof paginateCookieIndices>,
  matchingCount: number
): HTMLElement {
  const block = document.createElement("div");
  block.className = "pagination-block";

  const navigation = document.createElement("nav");
  navigation.className = "cookie-pagination";
  navigation.setAttribute("aria-label", "Cookie 预览分页");

  const previous = createPaginationButton("上一页", "previous", page.page === 1);
  previous.addEventListener("click", () => {
    changePreviewPage(page.page - 1, "previous");
  });

  const pageStatus = document.createElement("p");
  pageStatus.className = "pagination-status";

  const pageNumber = document.createElement("strong");
  pageNumber.textContent = "第 " + page.page + " / " + page.pageCount + " 页";

  const itemRange = document.createElement("span");
  itemRange.textContent =
    page.startOrdinal + "–" + page.endOrdinal + " / " + matchingCount + " 条";
  pageStatus.append(pageNumber, itemRange);

  const next = createPaginationButton(
    "下一页",
    "next",
    page.page === page.pageCount
  );
  next.addEventListener("click", () => {
    changePreviewPage(page.page + 1, "next");
  });

  navigation.append(previous, pageStatus, next);

  const note = document.createElement("p");
  note.className = "pagination-note";
  note.textContent = "搜索只影响分页结果；复制和导出始终包含全部 Cookie。";
  block.append(navigation, note);
  return block;
}

function createPaginationButton(
  label: string,
  action: "previous" | "next",
  disabled: boolean
): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "pagination-button";
  button.dataset.paginationAction = action;
  button.disabled = disabled;
  button.textContent = label;
  return button;
}

function changePreviewPage(
  nextPage: number,
  preferredFocus: "previous" | "next"
): void {
  state.previewPage = nextPage;
  renderPreview();

  const preferredButton = document.querySelector<HTMLButtonElement>(
    '[data-pagination-action="' + preferredFocus + '"]'
  );
  const fallbackAction = preferredFocus === "next" ? "previous" : "next";
  const fallbackButton = document.querySelector<HTMLButtonElement>(
    '[data-pagination-action="' + fallbackAction + '"]'
  );

  if (preferredButton && !preferredButton.disabled) {
    preferredButton.focus();
  } else {
    fallbackButton?.focus();
  }
}

function createCookieRow(cookie: CookieRecord, cookieIndex: number): HTMLElement {
  const row = document.createElement("article");
  row.className = "cookie-row";
  row.setAttribute("role", "listitem");

  const top = document.createElement("div");
  top.className = "cookie-row-top";

  const name = document.createElement("code");
  name.className = "cookie-name";
  name.textContent = cookie.name || "(空名称)";
  name.title = cookie.name;

  const flags = document.createElement("div");
  flags.className = "cookie-flags";

  if (state.modifiedCookieIndices.has(cookieIndex)) {
    flags.append(createFlag("已编辑", false, true));
  }

  if (cookie.httpOnly) {
    flags.append(createFlag("HttpOnly", true));
  }

  if (cookie.secure) {
    flags.append(createFlag("Secure", false));
  }

  if (cookie.session) {
    flags.append(createFlag("Session", false));
  }

  const actions = document.createElement("div");
  actions.className = "cookie-row-actions";

  const editButton = document.createElement("button");
  editButton.type = "button";
  editButton.className = "cookie-edit-button";
  editButton.dataset.cookieIndex = String(cookieIndex);
  editButton.textContent = "编辑";
  editButton.setAttribute("aria-label", "编辑 Cookie " + (cookie.name || "空名称"));
  editButton.addEventListener("click", () => openCookieEditor(cookieIndex));

  actions.append(flags, editButton);
  top.append(name, actions);

  const scope = document.createElement("p");
  scope.className = "cookie-scope";
  scope.textContent = cookie.domain + cookie.path;
  scope.title = cookie.domain + cookie.path;

  const value = document.createElement("p");
  value.className = "cookie-value";

  if (state.showValues) {
    value.textContent = cookie.value || "(空值)";
  } else {
    value.classList.add("is-hidden");
    value.textContent = "值已隐藏";
  }

  row.append(top, scope, value);
  return row;
}

function createFlag(
  label: string,
  sensitive: boolean,
  modified = false
): HTMLElement {
  const flag = document.createElement("span");
  flag.className = modified
    ? "flag flag-modified"
    : sensitive
      ? "flag flag-sensitive"
      : "flag";
  flag.textContent = label;
  return flag;
}

function openCookieEditor(cookieIndex: number): void {
  const cookie = state.cookies[cookieIndex];

  if (!cookie) {
    return;
  }

  state.editingCookieIndex = cookieIndex;
  const draft = cookieToEditDraft(cookie);

  cookieEditorHeading.textContent = "编辑 " + (cookie.name || "(空名称)");
  cookieEditorIndex.textContent =
    "#" + (cookieIndex + 1) + " · " + cookie.domain + cookie.path;
  editCookieName.value = draft.name;
  editCookieValue.value = draft.value;
  editCookieDomain.value = draft.domain;
  editCookiePath.value = draft.path;
  editCookieSameSite.value = draft.sameSite;
  editCookieExpiration.value = draft.expirationDate;
  editCookieSecure.checked = draft.secure;
  editCookieHttpOnly.checked = draft.httpOnly;
  editCookieSession.checked = draft.session;
  editCookieHostOnly.checked = draft.hostOnly;
  editCookieStoreId.value = draft.storeId;
  editCookiePartitionSite.value = draft.partitionTopLevelSite;
  editCookiePartitionCrossSite.value = draft.partitionHasCrossSiteAncestor;
  clearCookieEditError();
  syncExpirationInput();

  const advanced = cookieEditor.querySelector<HTMLDetailsElement>(".editor-advanced");

  if (advanced) {
    advanced.open = cookie.partitionKey !== undefined;
  }

  renderControls();
  renderPreview();
  editCookieName.focus();
}

function handleCookieEditSubmit(event: SubmitEvent): void {
  event.preventDefault();

  const cookieIndex = state.editingCookieIndex;

  if (cookieIndex === undefined) {
    return;
  }

  try {
    const editedCookie = applyCookieEditDraft(readCookieEditDraft());
    const originalCookie = state.originalCookies[cookieIndex];
    state.cookies[cookieIndex] = editedCookie;

    if (originalCookie && cookieRecordsEqual(originalCookie, editedCookie)) {
      state.modifiedCookieIndices.delete(cookieIndex);
    } else {
      state.modifiedCookieIndices.add(cookieIndex);
    }

    state.copyPhase = "idle";
    clearCookieEditError();
    const name = editedCookie.name || "(空名称)";
    finishCookieEditor(cookieIndex);
    statusMessage.textContent =
      "已更新 “" + name + "” 的导出快照；浏览器 Cookie 未被修改。";
  } catch (error) {
    showCookieEditError(getErrorMessage(error));
  }
}

function readCookieEditDraft(): CookieEditDraft {
  return {
    domain: editCookieDomain.value,
    expirationDate: editCookieExpiration.value,
    hostOnly: editCookieHostOnly.checked,
    httpOnly: editCookieHttpOnly.checked,
    name: editCookieName.value,
    partitionHasCrossSiteAncestor: editCookiePartitionCrossSite.value as
      | "unset"
      | "true"
      | "false",
    partitionTopLevelSite: editCookiePartitionSite.value,
    path: editCookiePath.value,
    sameSite: editCookieSameSite.value,
    secure: editCookieSecure.checked,
    session: editCookieSession.checked,
    storeId: editCookieStoreId.value,
    value: editCookieValue.value
  };
}

function handleResetCookieEdit(): void {
  const cookieIndex = state.editingCookieIndex;

  if (cookieIndex === undefined) {
    return;
  }

  const originalCookie = state.originalCookies[cookieIndex];

  if (!originalCookie) {
    return;
  }

  state.cookies[cookieIndex] = cloneCookieRecord(originalCookie);
  state.modifiedCookieIndices.delete(cookieIndex);
  state.copyPhase = "idle";
  const name = originalCookie.name || "(空名称)";
  finishCookieEditor(cookieIndex);
  statusMessage.textContent = "已将 “" + name + "” 恢复为本次读取时的值。";
}

function closeCookieEditor(): void {
  const cookieIndex = state.editingCookieIndex;

  if (cookieIndex === undefined) {
    return;
  }

  finishCookieEditor(cookieIndex);
}

function finishCookieEditor(cookieIndex: number): void {
  delete state.editingCookieIndex;
  clearCookieEditError();
  renderControls();
  renderPreview();

  const editButton = document.querySelector<HTMLButtonElement>(
    '[data-cookie-index="' + cookieIndex + '"]'
  );
  (editButton ?? cookieSearch).focus();
}

function syncExpirationInput(): void {
  editCookieExpiration.disabled = editCookieSession.checked;
  editCookieExpiration.title = editCookieSession.checked
    ? "Session Cookie 不包含 expirationDate"
    : "填写 Unix 时间戳（秒）";
}

function showCookieEditError(message: string): void {
  cookieEditError.textContent = message;
  cookieEditError.hidden = false;
}

function clearCookieEditError(): void {
  cookieEditError.textContent = "";
  cookieEditError.hidden = true;
}

function createEmptyState(message: string): HTMLElement {
  const empty = document.createElement("div");
  empty.className = "empty-state";

  const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  icon.setAttribute("viewBox", "0 0 32 32");
  icon.setAttribute("aria-hidden", "true");

  const filePath = document.createElementNS("http://www.w3.org/2000/svg", "path");
  filePath.setAttribute("d", "M8 5.5h11l5 5V26H8z");
  const foldPath = document.createElementNS("http://www.w3.org/2000/svg", "path");
  foldPath.setAttribute("d", "M19 5.5v5h5M11.5 16h9M11.5 20h7");
  icon.append(filePath, foldPath);

  const copy = document.createElement("p");
  copy.textContent = message;
  empty.append(icon, copy);
  return empty;
}

function updateFormatDescription(): void {
  const format = getExportFormat(formatSelect.value as ExportFormatId);
  formatDescription.textContent = format.description;
}

function syncFormatAvailability(): void {
  const headerOption = Array.from(formatSelect.options).find(
    (option) => option.value === "header"
  );

  if (headerOption) {
    headerOption.disabled = state.scope === "site";
  }

  if (state.scope === "site" && formatSelect.value === "header") {
    formatSelect.value = "json";
  }

  updateFormatDescription();
}

function updateScopeGuidance(): void {
  const target = getGuidanceTarget();

  if (state.scope === "url") {
    scopeDescription.textContent =
      "只导出会发送给完整 URL 的 Cookie；路径规则生效，并包含合法父域 Cookie。";
  } else if (target?.hasRegistrableDomain) {
    scopeDescription.textContent =
      "导出 " + target.siteDomain + " 及其全部子域、所有路径的 Cookie。";
  } else if (target) {
    scopeDescription.textContent =
      "导出 " + target.hostname + " 的所有路径 Cookie；该地址没有可扩展站点域。";
  } else {
    scopeDescription.textContent = "导出站点域及其全部子域、所有路径的 Cookie。";
  }

  if (!target) {
    permissionSummary.textContent = "识别网址后会在这里显示申请的主机范围。";
    return;
  }

  const hosts = getCookiePermissionPatterns(target, state.scope)
    .filter((pattern) => pattern.startsWith("https://"))
    .map((pattern) => pattern.slice("https://".length, -"/*".length));

  permissionSummary.textContent =
    (state.scope === "url" ? "精确主机权限：" : "站点域权限：") +
    hosts.join("、") +
    "（HTTP/HTTPS）。" +
    (state.scope === "url" ? "不会授权其他子域。" : "");
}

function getGuidanceTarget(): SiteTarget | undefined {
  if (state.mode === "current") {
    return state.activeTabSite?.target;
  }

  try {
    return normalizeSiteTarget(siteUrlInput.value);
  } catch {
    return undefined;
  }
}

function showUrlError(message: string): void {
  siteUrlInput.setAttribute("aria-invalid", "true");
  siteUrlError.textContent = message;
  siteUrlError.hidden = false;
}

function clearUrlError(): void {
  siteUrlInput.removeAttribute("aria-invalid");
  siteUrlError.textContent = "";
  siteUrlError.hidden = true;
}

function showError(message: string): void {
  errorMessage.textContent = message;
  errorPanel.hidden = false;
}

function clearError(): void {
  errorMessage.textContent = "";
  errorPanel.hidden = true;
}

function getErrorMessage(error: unknown): string {
  if (error instanceof TargetValidationError || error instanceof Error) {
    return error.message;
  }

  return "发生未知错误，请重试。";
}

function getElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);

  if (!element) {
    throw new Error("Missing popup element: " + id);
  }

  return element as T;
}
