import "./manager.css";

import { getElement, ICON_PATHS, createIcon, setButtonPending, setHidden } from "./dom";
import { getErrorMessage, sendRequest } from "./runtime";
import { parseUriLines, sanitizeHeaderLines } from "./security";
import {
  flattenSnapshot,
  formatBytes,
  formatDuration,
  formatSpeed,
  getStatusGroup,
  getStatusLabel,
  getTaskEtaSeconds,
  getTaskName,
  getTaskPrimaryUri,
  getTaskProgress,
  taskMatchesQuery
} from "./task-utils";
import { getResolvedTheme, initializeTheme, toggleTheme } from "./theme";
import type {
  AddMetafileRequest,
  AddUriRequest,
  AriaFile,
  AriaTask,
  ConnectionInfo,
  DownloadSnapshot,
  GlobalControlAction,
  PublicSettings,
  TaskControlAction
} from "./types";

type TaskFilter = "active" | "all" | "complete" | "error" | "waiting";

interface ManagerState {
  busyGids: Set<string>;
  connection?: ConnectionInfo;
  confirmAction?: { action: TaskControlAction; gid: string };
  filter: TaskFilter;
  refreshTimer?: number;
  refreshing: boolean;
  search: string;
  snapshot?: DownloadSnapshot;
}

const state: ManagerState = {
  busyGids: new Set(),
  filter: "all",
  refreshing: false,
  search: ""
};

const filterButtons = Array.from(document.querySelectorAll<HTMLButtonElement>("[data-filter]"));
const pageTitle = getElement<HTMLHeadingElement>("page-title");
const pageSummary = getElement<HTMLParagraphElement>("page-summary");
const downloadSpeed = getElement<HTMLElement>("download-speed");
const uploadSpeed = getElement<HTMLElement>("upload-speed");
const activeCount = getElement<HTMLElement>("active-count");
const connectionButton = getElement<HTMLButtonElement>("connection-button");
const connectionIndicator = getElement<HTMLElement>("connection-indicator");
const connectionLabel = getElement<HTMLElement>("connection-label");
const onboarding = getElement<HTMLElement>("onboarding");
const errorBanner = getElement<HTMLElement>("error-banner");
const errorMessage = getElement<HTMLElement>("error-message");
const queueSection = getElement<HTMLElement>("queue-section");
const taskList = getElement<HTMLElement>("task-list");
const emptyState = getElement<HTMLElement>("empty-state");
const emptyTitle = getElement<HTMLElement>("empty-title");
const emptyDescription = getElement<HTMLElement>("empty-description");
const taskSearch = getElement<HTMLInputElement>("task-search");
const addDialog = getElement<HTMLDialogElement>("add-dialog");
const addForm = getElement<HTMLFormElement>("add-form");
const sourceRadios = Array.from(
  document.querySelectorAll<HTMLInputElement>('input[name="add-source"]')
);
const urlSourceFields = getElement<HTMLElement>("url-source-fields");
const fileSourceFields = getElement<HTMLElement>("file-source-fields");
const uriInput = getElement<HTMLTextAreaElement>("download-uris");
const metafileInput = getElement<HTMLInputElement>("metafile-input");
const fileName = getElement<HTMLElement>("file-name");
const directoryInput = getElement<HTMLInputElement>("task-directory");
const outputNameGroup = getElement<HTMLElement>("output-name-group");
const outputNameInput = getElement<HTMLInputElement>("output-name");
const refererInput = getElement<HTMLInputElement>("task-referer");
const headersInput = getElement<HTMLTextAreaElement>("task-headers");
const addPausedInput = getElement<HTMLInputElement>("add-paused");
const addError = getElement<HTMLElement>("add-error");
const submitTask = getElement<HTMLButtonElement>("submit-task");
const detailDialog = getElement<HTMLDialogElement>("detail-dialog");
const detailTitle = getElement<HTMLElement>("detail-title");
const detailContent = getElement<HTMLElement>("detail-content");
const confirmDialog = getElement<HTMLDialogElement>("confirm-dialog");
const confirmTitle = getElement<HTMLElement>("confirm-title");
const confirmDescription = getElement<HTMLElement>("confirm-description");
const confirmAction = getElement<HTMLButtonElement>("confirm-action");
const toastRegion = getElement<HTMLElement>("toast-region");
const themeToggle = getElement<HTMLButtonElement>("theme-toggle");

void initialize();

async function initialize(): Promise<void> {
  if (import.meta.env.DEV && (typeof chrome === "undefined" || !chrome.runtime?.id)) {
    const { installDevChromeMock } = await import("./dev-mock");
    installDevChromeMock();
  }
  await initializeTheme();
  updateThemeButton();
  bindEvents();
  renderSkeleton();
  await showRecentBackgroundEvent();
  await loadConnection();
}

function bindEvents(): void {
  filterButtons.forEach((button) => {
    button.addEventListener("click", () => {
      state.filter = button.dataset.filter as TaskFilter;
      renderNavigation();
      renderTasks();
    });
  });

  taskSearch.addEventListener("input", () => {
    state.search = taskSearch.value;
    renderTasks();
  });

  getElement<HTMLButtonElement>("add-task").addEventListener("click", openAddDialog);
  getElement<HTMLButtonElement>("empty-add").addEventListener("click", openAddDialog);
  getElement<HTMLButtonElement>("configure-now").addEventListener("click", openSettings);
  getElement<HTMLButtonElement>("retry-connection").addEventListener("click", () => {
    void refreshSnapshot(true);
  });
  getElement<HTMLButtonElement>("refresh-now").addEventListener("click", () => {
    void refreshSnapshot(true);
  });
  getElement<HTMLButtonElement>("pause-all").addEventListener("click", (event) => {
    void controlGlobal("pauseAll", event.currentTarget as HTMLButtonElement);
  });
  getElement<HTMLButtonElement>("resume-all").addEventListener("click", (event) => {
    void controlGlobal("resumeAll", event.currentTarget as HTMLButtonElement);
  });
  getElement<HTMLButtonElement>("open-settings").addEventListener("click", openSettings);
  getElement<HTMLButtonElement>("open-settings-sidebar").addEventListener("click", openSettings);
  connectionButton.addEventListener("click", openSettings);
  getElement<HTMLButtonElement>("open-tab").addEventListener("click", () => {
    void sendRequest<{ tabId?: number }>({ type: "manager:openTab" });
  });

  themeToggle.addEventListener("click", async () => {
    await toggleTheme();
    updateThemeButton();
  });

  sourceRadios.forEach((radio) => radio.addEventListener("change", renderAddSource));
  metafileInput.addEventListener("change", renderSelectedFile);
  uriInput.addEventListener("input", syncOutputNameAvailability);
  addForm.addEventListener("submit", (event) => {
    event.preventDefault();
    void submitAddTask();
  });

  document.querySelectorAll<HTMLButtonElement>(".dialog-close, .dialog-cancel").forEach((button) => {
    button.addEventListener("click", () => {
      button.closest<HTMLDialogElement>("dialog")?.close();
    });
  });

  confirmDialog.querySelector("form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    void runConfirmedAction();
  });

  detailDialog.addEventListener("close", () => detailContent.replaceChildren());

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      void loadConnection();
    } else {
      clearRefreshTimer();
    }
  });

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === "local" && "ariaRelaySettings" in changes) {
      void loadConnection();
    }
  });
}

async function loadConnection(): Promise<void> {
  try {
    state.connection = await sendRequest<ConnectionInfo>({ type: "connection:get" });
  } catch (error) {
    showConnectionError(getErrorMessage(error));
    return;
  }

  if (!state.connection.settings.configured) {
    renderDisconnected();
    return;
  }

  await refreshSnapshot(false);
}

async function refreshSnapshot(userInitiated: boolean): Promise<void> {
  if (state.refreshing || !state.connection?.settings.configured) {
    return;
  }

  state.refreshing = true;
  taskList.setAttribute("aria-busy", "true");
  clearRefreshTimer();

  try {
    state.snapshot = await sendRequest<DownloadSnapshot>({ type: "snapshot:get" });
    renderConnected();
    renderAll();
    if (userInitiated) {
      showToast("任务队列已刷新。", "success");
    }
  } catch (error) {
    showConnectionError(getErrorMessage(error));
  } finally {
    state.refreshing = false;
    taskList.setAttribute("aria-busy", "false");
    scheduleRefresh();
  }
}

function scheduleRefresh(): void {
  clearRefreshTimer();
  if (document.visibilityState !== "visible" || !state.connection?.settings.configured) {
    return;
  }
  state.refreshTimer = window.setTimeout(() => {
    void refreshSnapshot(false);
  }, state.connection.settings.refreshInterval);
}

function clearRefreshTimer(): void {
  if (state.refreshTimer !== undefined) {
    window.clearTimeout(state.refreshTimer);
    delete state.refreshTimer;
  }
}

function renderAll(): void {
  renderNavigation();
  renderMetrics();
  renderTasks();
}

function renderNavigation(): void {
  const tasks = state.snapshot ? flattenSnapshot(state.snapshot) : [];
  const counts = {
    active: tasks.filter((task) => getStatusGroup(task) === "active").length,
    all: tasks.length,
    complete: tasks.filter((task) => getStatusGroup(task) === "complete").length,
    error: tasks.filter((task) => getStatusGroup(task) === "error").length,
    waiting: tasks.filter((task) => getStatusGroup(task) === "waiting").length
  };

  for (const filter of Object.keys(counts) as TaskFilter[]) {
    getElement<HTMLElement>(`count-${filter}`).textContent = String(counts[filter]);
  }

  filterButtons.forEach((button) => {
    const active = button.dataset.filter === state.filter;
    button.classList.toggle("is-active", active);
    if (active) {
      button.setAttribute("aria-current", "page");
    } else {
      button.removeAttribute("aria-current");
    }
  });

  const titles: Record<TaskFilter, string> = {
    active: "正在下载",
    all: "全部任务",
    complete: "已完成",
    error: "错误与已移除",
    waiting: "等待与暂停"
  };
  pageTitle.textContent = titles[state.filter];
}

function renderMetrics(): void {
  const snapshot = state.snapshot;
  downloadSpeed.textContent = formatSpeed(snapshot?.global.downloadSpeed ?? 0);
  uploadSpeed.textContent = formatSpeed(snapshot?.global.uploadSpeed ?? 0);
  activeCount.textContent = snapshot?.global.numActive ?? "0";

  const total = snapshot ? flattenSnapshot(snapshot).length : 0;
  const capturedAt = snapshot
    ? new Intl.DateTimeFormat("zh-CN", {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit"
      }).format(snapshot.capturedAt)
    : "—";
  pageSummary.textContent = `${total} 个任务 · 最近刷新 ${capturedAt}`;
}

function renderTasks(): void {
  const allTasks = state.snapshot ? flattenSnapshot(state.snapshot) : [];
  const visibleTasks = allTasks.filter((task) => {
    const matchesFilter = state.filter === "all" || getStatusGroup(task) === state.filter;
    return matchesFilter && taskMatchesQuery(task, state.search);
  });

  taskList.replaceChildren(...visibleTasks.map(createTaskRow));
  const empty = visibleTasks.length === 0;
  setHidden(emptyState, !empty);
  setHidden(taskList, empty);

  if (empty) {
    const isFiltered = state.search.trim() || state.filter !== "all";
    emptyTitle.textContent = isFiltered ? "没有匹配的任务" : "还没有下载任务";
    emptyDescription.textContent = isFiltered
      ? "尝试更换筛选条件或清除搜索关键词。"
      : "添加链接、Magnet 或 BT 文件后，任务会显示在这里。";
    getElement<HTMLButtonElement>("empty-add").hidden = Boolean(isFiltered);
  }
}

function createTaskRow(task: AriaTask): HTMLElement {
  const row = document.createElement("article");
  row.className = "task-row";
  row.dataset.status = getStatusGroup(task);

  const fileMark = document.createElement("div");
  fileMark.className = "task-file-mark";
  fileMark.append(createIcon(task.infoHash ? ICON_PATHS.magnet : ICON_PATHS.file));

  const body = document.createElement("div");
  body.className = "task-body";

  const heading = document.createElement("div");
  heading.className = "task-heading";
  const name = document.createElement("button");
  name.className = "task-name";
  name.type = "button";
  name.textContent = getTaskName(task);
  name.title = getTaskName(task);
  name.addEventListener("click", () => void openTaskDetail(task.gid));
  const status = document.createElement("span");
  status.className = "task-status";
  status.textContent = getStatusLabel(task.status);
  heading.append(name, status);

  const progress = getTaskProgress(task);
  const progressShell = document.createElement("div");
  progressShell.className = "task-progress-shell";
  const progressTrack = document.createElement("div");
  progressTrack.className = "task-progress-track";
  progressTrack.setAttribute("role", "progressbar");
  progressTrack.setAttribute("aria-label", `${getTaskName(task)} 下载进度`);
  progressTrack.setAttribute("aria-valuemin", "0");
  progressTrack.setAttribute("aria-valuemax", "100");
  progressTrack.setAttribute("aria-valuenow", String(Math.round(progress)));
  const progressValue = document.createElement("span");
  progressValue.style.width = `${progress}%`;
  progressTrack.append(progressValue);
  const progressText = document.createElement("span");
  progressText.className = "task-progress-value";
  progressText.textContent = `${progress.toFixed(progress >= 10 ? 0 : 1)}%`;
  progressShell.append(progressTrack, progressText);

  const meta = document.createElement("div");
  meta.className = "task-meta";
  meta.append(
    createMeta(`${formatBytes(task.completedLength)} / ${formatBytes(task.totalLength)}`),
    createMeta(task.status === "active" ? formatSpeed(task.downloadSpeed) : getTaskSourceLabel(task)),
    createMeta(task.status === "active" ? `剩余 ${formatDuration(getTaskEtaSeconds(task))}` : task.gid)
  );

  body.append(heading, progressShell, meta);

  const actions = document.createElement("div");
  actions.className = "task-actions";
  const isBusy = state.busyGids.has(task.gid);
  if (task.status === "active") {
    actions.append(createTaskAction("暂停", ICON_PATHS.pause, () => void controlTask(task.gid, "pause"), isBusy));
  } else if (task.status === "paused" || task.status === "waiting") {
    actions.append(createTaskAction("继续", ICON_PATHS.play, () => void controlTask(task.gid, "resume"), isBusy));
  } else if (task.status === "error") {
    actions.append(createTaskAction("重试", ICON_PATHS.refresh, () => void controlTask(task.gid, "retry"), isBusy));
  }
  actions.append(
    createTaskAction("详情", ICON_PATHS.chevron, () => void openTaskDetail(task.gid), isBusy),
    createTaskAction(
      task.status === "active" || task.status === "waiting" || task.status === "paused" ? "移除" : "清除记录",
      ICON_PATHS.trash,
      () => openRemoveConfirmation(task),
      isBusy,
      true
    )
  );

  row.append(fileMark, body, actions);
  return row;
}

function createMeta(text: string): HTMLElement {
  const item = document.createElement("span");
  item.textContent = text;
  item.title = text;
  return item;
}

function createTaskAction(
  label: string,
  path: string,
  handler: () => void,
  disabled: boolean,
  destructive = false
): HTMLButtonElement {
  const button = document.createElement("button");
  button.className = destructive ? "row-action is-destructive" : "row-action";
  button.type = "button";
  button.disabled = disabled;
  button.setAttribute("aria-label", label);
  button.title = label;
  button.append(createIcon(path));
  button.addEventListener("click", handler);
  return button;
}

async function controlTask(gid: string, action: TaskControlAction): Promise<void> {
  if (state.busyGids.has(gid)) {
    return;
  }
  state.busyGids.add(gid);
  renderTasks();

  try {
    await sendRequest<string>({ action, gid, type: "task:control" });
    showToast(getTaskActionSuccess(action), "success");
    await refreshSnapshot(false);
  } catch (error) {
    showToast(getErrorMessage(error), "error");
  } finally {
    state.busyGids.delete(gid);
    renderTasks();
  }
}

async function controlGlobal(
  action: GlobalControlAction,
  button: HTMLButtonElement
): Promise<void> {
  setButtonPending(button, true);
  try {
    await sendRequest<string>({ action, type: "global:control" });
    showToast(action === "pauseAll" ? "已请求暂停全部任务。" : "已请求继续全部任务。", "success");
    await refreshSnapshot(false);
  } catch (error) {
    showToast(getErrorMessage(error), "error");
  } finally {
    setButtonPending(button, false);
  }
}

function openRemoveConfirmation(task: AriaTask): void {
  const isRunning = ["active", "waiting", "paused"].includes(task.status);
  state.confirmAction = {
    action: isRunning ? "remove" : "forget",
    gid: task.gid
  };
  confirmTitle.textContent = isRunning ? "从队列移除任务？" : "清除任务记录？";
  confirmDescription.textContent = isRunning
    ? `“${getTaskName(task)}”将停止并从队列移除，已下载文件不会被删除。`
    : `“${getTaskName(task)}”将从 aria2 历史记录清除，磁盘文件不会被删除。`;
  confirmAction.textContent = isRunning ? "确认移除" : "清除记录";
  confirmDialog.showModal();
}

async function runConfirmedAction(): Promise<void> {
  const action = state.confirmAction;
  if (!action) {
    confirmDialog.close();
    return;
  }
  setButtonPending(confirmAction, true);
  try {
    await controlTask(action.gid, action.action);
    confirmDialog.close();
  } finally {
    setButtonPending(confirmAction, false);
    delete state.confirmAction;
  }
}

async function openTaskDetail(gid: string): Promise<void> {
  detailTitle.textContent = "正在读取…";
  detailContent.replaceChildren(createDetailSkeleton());
  detailDialog.showModal();

  try {
    const task = await sendRequest<AriaTask>({ gid, type: "task:get" });
    detailTitle.textContent = getTaskName(task);
    detailContent.replaceChildren(createTaskDetail(task));
  } catch (error) {
    const paragraph = document.createElement("p");
    paragraph.className = "form-error";
    paragraph.textContent = getErrorMessage(error);
    detailContent.replaceChildren(paragraph);
  }
}

function createTaskDetail(task: AriaTask): HTMLElement {
  const wrapper = document.createElement("div");
  const progress = getTaskProgress(task);

  const hero = document.createElement("div");
  hero.className = "detail-hero";
  const heroValue = document.createElement("strong");
  heroValue.textContent = `${progress.toFixed(progress >= 10 ? 0 : 1)}%`;
  const heroCopy = document.createElement("div");
  const heroStatus = document.createElement("span");
  heroStatus.className = "task-status";
  heroStatus.dataset.status = getStatusGroup(task);
  heroStatus.textContent = getStatusLabel(task.status);
  const heroMeta = document.createElement("p");
  heroMeta.textContent = `${formatBytes(task.completedLength)} / ${formatBytes(task.totalLength)} · ${formatSpeed(task.downloadSpeed)}`;
  heroCopy.append(heroStatus, heroMeta);
  hero.append(heroValue, heroCopy);

  const facts = document.createElement("dl");
  facts.className = "detail-facts";
  appendFact(facts, "GID", task.gid, true);
  appendFact(facts, "保存目录", task.dir || "由 aria2 决定", true);
  const primaryUri = getTaskPrimaryUri(task);
  appendFact(facts, "来源", primaryUri || "BT 元数据 / 未提供", true);
  if (task.infoHash) {
    appendFact(facts, "Info hash", task.infoHash, true);
  }
  if (task.errorMessage) {
    appendFact(facts, "错误", `${task.errorCode ?? ""} ${task.errorMessage}`.trim(), false);
  }

  const tools = document.createElement("div");
  tools.className = "detail-tools";
  if (primaryUri) {
    const copy = document.createElement("button");
    copy.className = "button button-secondary";
    copy.type = "button";
    copy.append(createIcon(ICON_PATHS.copy), document.createTextNode("复制来源地址"));
    copy.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(primaryUri);
        showToast("来源地址已复制。", "success");
      } catch {
        showToast("无法写入剪贴板。", "error");
      }
    });
    tools.append(copy);
  }

  const filesHeading = document.createElement("div");
  filesHeading.className = "detail-section-heading";
  const filesTitle = document.createElement("h3");
  filesTitle.textContent = `文件 (${task.files.length})`;
  filesHeading.append(filesTitle);
  const files = document.createElement("div");
  files.className = "detail-files";
  if (task.files.length === 0) {
    const empty = document.createElement("p");
    empty.className = "field-help";
    empty.textContent = "aria2 尚未返回文件列表。";
    files.append(empty);
  } else {
    files.append(...task.files.map(createFileRow));
  }

  wrapper.append(hero, facts, tools, filesHeading, files);
  return wrapper;
}

function appendFact(list: HTMLDListElement, label: string, value: string, monospace: boolean): void {
  const group = document.createElement("div");
  const term = document.createElement("dt");
  const definition = document.createElement("dd");
  term.textContent = label;
  definition.textContent = value;
  definition.title = value;
  if (monospace) {
    definition.classList.add("monospace");
  }
  group.append(term, definition);
  list.append(group);
}

function createFileRow(file: AriaFile): HTMLElement {
  const row = document.createElement("div");
  row.className = "detail-file-row";
  const icon = createIcon(ICON_PATHS.file);
  const copy = document.createElement("div");
  copy.className = "detail-file-copy";
  const name = document.createElement("strong");
  name.textContent = file.path.split(/[\\/]/u).filter(Boolean).at(-1) ?? `文件 ${file.index}`;
  name.title = file.path;
  const meta = document.createElement("span");
  meta.textContent = `${formatBytes(file.completedLength)} / ${formatBytes(file.length)}${file.selected === "false" ? " · 未选择" : ""}`;
  copy.append(name, meta);
  row.append(icon, copy);
  return row;
}

function createDetailSkeleton(): HTMLElement {
  const skeleton = document.createElement("div");
  skeleton.className = "detail-skeleton";
  skeleton.setAttribute("aria-label", "正在读取任务详情");
  for (let index = 0; index < 5; index += 1) {
    const line = document.createElement("span");
    skeleton.append(line);
  }
  return skeleton;
}

function openAddDialog(): void {
  addForm.reset();
  addError.hidden = true;
  directoryInput.value = state.connection?.settings.defaultDirectory ?? "";
  addPausedInput.checked = state.connection?.settings.addPaused ?? false;
  fileName.textContent = "选择 BT 或 Metalink 文件";
  renderAddSource();
  addDialog.showModal();
  window.setTimeout(() => uriInput.focus(), 0);
}

function renderAddSource(): void {
  const source = getSelectedAddSource();
  setHidden(urlSourceFields, source !== "url");
  setHidden(fileSourceFields, source !== "file");
  setHidden(outputNameGroup, source !== "url");
  getElement<HTMLDetailsElement>("advanced-options").hidden = source !== "url";
  addError.hidden = true;
}

function renderSelectedFile(): void {
  const file = metafileInput.files?.[0];
  fileName.textContent = file?.name ?? "选择 BT 或 Metalink 文件";
}

function syncOutputNameAvailability(): void {
  const lines = uriInput.value.split(/\r?\n/u).filter((value) => value.trim());
  outputNameInput.disabled = lines.length > 1;
  outputNameInput.placeholder = lines.length > 1 ? "批量任务不可指定" : "由服务器决定";
  if (lines.length > 1) {
    outputNameInput.value = "";
  }
}

async function submitAddTask(): Promise<void> {
  addError.hidden = true;
  setButtonPending(submitTask, true, "正在添加…");

  try {
    const source = getSelectedAddSource();
    let count = 0;
    if (source === "url") {
      const uris = parseUriLines(uriInput.value);
      const headers = sanitizeHeaderLines(headersInput.value);
      const referer = validateOptionalHttpUrl(refererInput.value);
      const request: AddUriRequest = {
        ...(directoryInput.value.trim() ? { directory: directoryInput.value.trim() } : {}),
        ...(headers.length ? { headers } : {}),
        ...(outputNameInput.value.trim() ? { out: outputNameInput.value.trim() } : {}),
        pause: addPausedInput.checked,
        ...(referer ? { referer } : {}),
        uris
      };
      const gids = await sendRequest<string[]>({ request, type: "task:addUris" });
      count = gids.length;
    } else {
      const file = metafileInput.files?.[0];
      if (!file) {
        throw new Error("请选择一个 BT 或 Metalink 文件。");
      }
      if (file.size > 48 * 1024 * 1024) {
        throw new Error("文件超过 48 MiB 限制。");
      }
      const request: AddMetafileRequest = {
        base64: arrayBufferToBase64(await file.arrayBuffer()),
        ...(directoryInput.value.trim() ? { directory: directoryInput.value.trim() } : {}),
        fileName: file.name,
        pause: addPausedInput.checked
      };
      const gids = await sendRequest<string[]>({ request, type: "task:addMetafile" });
      count = gids.length;
    }

    addDialog.close();
    showToast(`已添加 ${count} 个下载任务。`, "success");
    await refreshSnapshot(false);
  } catch (error) {
    addError.textContent = getErrorMessage(error);
    addError.hidden = false;
  } finally {
    setButtonPending(submitTask, false);
  }
}

function getSelectedAddSource(): "file" | "url" {
  return sourceRadios.find((radio) => radio.checked)?.value === "file" ? "file" : "url";
}

function validateOptionalHttpUrl(input: string): string {
  const value = input.trim();
  if (!value) {
    return "";
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Referer 地址格式无效。");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Referer 只支持 HTTP 或 HTTPS 地址。");
  }
  return url.toString();
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const chunks: string[] = [];
  const chunkSize = 0x8_000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + chunkSize)));
  }
  return btoa(chunks.join(""));
}

function renderConnected(): void {
  connectionIndicator.dataset.state = "connected";
  connectionLabel.textContent = "aria2 已连接";
  connectionButton.title = state.connection?.settings.endpoint ?? "";
  setHidden(onboarding, true);
  setHidden(errorBanner, true);
  setHidden(queueSection, false);
}

function renderDisconnected(): void {
  delete state.snapshot;
  clearRefreshTimer();
  connectionIndicator.dataset.state = "disconnected";
  connectionLabel.textContent = "尚未配置";
  pageSummary.textContent = "连接后即可管理 aria2 下载队列";
  setHidden(onboarding, false);
  setHidden(errorBanner, true);
  setHidden(queueSection, true);
  renderNavigation();
  renderMetrics();
}

function showConnectionError(message: string): void {
  connectionIndicator.dataset.state = "error";
  connectionLabel.textContent = "连接异常";
  errorMessage.textContent = message;
  setHidden(onboarding, true);
  setHidden(errorBanner, false);
  setHidden(queueSection, state.snapshot === undefined);
  if (!state.snapshot) {
    taskList.replaceChildren();
  }
}

function renderSkeleton(): void {
  const rows: HTMLElement[] = [];
  for (let index = 0; index < 4; index += 1) {
    const row = document.createElement("div");
    row.className = "task-skeleton";
    for (let part = 0; part < 4; part += 1) {
      row.append(document.createElement("span"));
    }
    rows.push(row);
  }
  taskList.replaceChildren(...rows);
}

function getTaskSourceLabel(task: AriaTask): string {
  if (task.infoHash) {
    return task.seeder === "true" ? `做种 · ↑ ${formatSpeed(task.uploadSpeed)}` : "BitTorrent";
  }
  const uri = getTaskPrimaryUri(task);
  if (!uri) {
    return "无来源信息";
  }
  try {
    return new URL(uri).hostname;
  } catch {
    return "Magnet";
  }
}

function getTaskActionSuccess(action: TaskControlAction): string {
  const labels: Record<TaskControlAction, string> = {
    forget: "任务记录已清除。",
    pause: "任务已暂停。",
    remove: "任务已从队列移除。",
    resume: "任务已继续。",
    retry: "任务已重新提交。"
  };
  return labels[action];
}

function openSettings(): void {
  void chrome.runtime.openOptionsPage();
}

function showToast(message: string, type: "error" | "success"): void {
  const toast = document.createElement("div");
  toast.className = `toast toast-${type}`;
  toast.append(createIcon(type === "success" ? ICON_PATHS.check : ICON_PATHS.warning));
  const copy = document.createElement("span");
  copy.textContent = message;
  toast.append(copy);
  toastRegion.replaceChildren(toast);
  window.setTimeout(() => {
    if (toastRegion.contains(toast)) {
      toast.remove();
    }
  }, 4_000);
}

async function showRecentBackgroundEvent(): Promise<void> {
  const result = await chrome.storage.session.get("ariaRelayLastEvent");
  const event = result.ariaRelayLastEvent as
    | { isError?: unknown; message?: unknown; timestamp?: unknown }
    | undefined;
  if (
    event &&
    typeof event.message === "string" &&
    typeof event.timestamp === "number" &&
    Date.now() - event.timestamp < 30_000
  ) {
    showToast(event.message, event.isError ? "error" : "success");
  }
  await chrome.storage.session.remove("ariaRelayLastEvent");
}

function updateThemeButton(): void {
  const isDark = getResolvedTheme() === "dark";
  const path = themeToggle.querySelector("path");
  path?.setAttribute("d", isDark ? ICON_PATHS.sun : ICON_PATHS.moon);
  themeToggle.setAttribute("aria-label", isDark ? "切换到浅色主题" : "切换到深色主题");
  themeToggle.title = isDark ? "切换到浅色主题" : "切换到深色主题";
}
