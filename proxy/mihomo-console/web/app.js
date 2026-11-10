"use strict";

const messages = {
  en: {
    accessToken: "Access token", logIn: "Log in", logOut: "Log out", loggingIn: "Logging in…",
    subscriptions: "Subscriptions", settings: "Settings", checkingService: "Checking Mihomo…",
    running: "Mihomo running", stopped: "Mihomo offline", unknownService: "Mihomo unavailable",
    refresh: "Refresh", retry: "Retry", updateSelected: "Update selected", addSubscription: "Add subscription",
    editSubscription: "Edit subscription", loadingSubscriptions: "Loading subscriptions…",
    noSubscriptions: "No subscriptions yet", emptyHelp: "Add a Clash/Mihomo subscription URL to get started.",
    automaticUpdates: "Automatic updates", change: "Change", recentResults: "Recent results", noResults: "No updates yet.",
    enableAutomatic: "Enable automatic updates", updateInterval: "Update interval", saveSchedule: "Save schedule",
    intervalHelp: "For example: 30m, 6h, or 1d. Between 1 minute and 30 days.", appearance: "Appearance",
    theme: "Theme", system: "System", light: "Light", dark: "Dark", language: "Language", session: "Session",
    close: "Close", name: "Name", subscriptionUrl: "Subscription URL",
    urlHelp: "Use a URL that returns a complete Clash/Mihomo YAML configuration.",
    editUrlHelp: "Leave blank to keep the saved URL, or enter a replacement.",
    downloadOptions: "Download options", userAgent: "User-Agent", downloadProxy: "Download proxy (optional)",
    removeDownloadProxy: "Remove saved download proxy", cancel: "Cancel", saveOnly: "Save only", saveAndApply: "Save & apply",
    deleteSubscription: "Delete subscription", delete: "Delete", apply: "Apply", validate: "Validate",
    selected: "Selected", useForAutoUpdate: "Use for auto-update", editNamed: "Edit {name}", moreNamed: "More actions for {name}",
    removeDescription: "Delete “{name}” from subscriptions? The running Mihomo configuration stays in place.",
    neverUpdated: "Not applied yet", lastUpdated: "Last applied {date}", noRecord: "Not checked", validated: "Validation passed",
    updated: "Updated", unchanged: "Already up to date", failed: "Failed", restored: "Restored", rolledBack: "Failed · rolled back",
    every: "Every {interval}", disabled: "Disabled", autoSource: "Selected: {name}", noSelected: "No subscription selected.",
    nextUpdate: "Next update: {date}", selectionHelp: "Updates apply to “{name}”.", selectionNeeded: "Select a subscription before enabling automatic updates.",
    applying: "Updating “{name}”…", validating: "Validating “{name}”…", applied: "Update completed for “{name}”.",
    validationPassed: "Validation passed for “{name}”.", operationFailed: "Could not complete the operation for “{name}”.",
    saved: "Subscription saved.", removed: "Subscription deleted.", selectionSaved: "Selected for automatic updates.",
    scheduleSaved: "Update schedule saved.", networkError: "Cannot reach the console. Check the connection and try again.",
    expired: "Your session has expired. Log in again.", savePending: "Saving…", requestFailed: "The request failed. Try again.",
  },
  zh: {
    accessToken: "访问令牌", logIn: "登录", logOut: "退出登录", loggingIn: "正在登录…",
    subscriptions: "订阅", settings: "设置", checkingService: "正在检查 Mihomo…",
    running: "Mihomo 运行中", stopped: "Mihomo 未运行", unknownService: "Mihomo 状态不可用",
    refresh: "刷新", retry: "重试", updateSelected: "更新当前订阅", addSubscription: "添加订阅",
    editSubscription: "编辑订阅", loadingSubscriptions: "正在加载订阅…",
    noSubscriptions: "暂无订阅", emptyHelp: "添加完整 Clash/Mihomo 配置的订阅地址，即可开始使用。",
    automaticUpdates: "自动更新", change: "修改", recentResults: "最近结果", noResults: "暂无更新记录。",
    enableAutomatic: "启用自动更新", updateInterval: "更新间隔", saveSchedule: "保存计划",
    intervalHelp: "例如：30m、6h 或 1d。支持 1 分钟至 30 天。", appearance: "外观",
    theme: "主题", system: "跟随系统", light: "浅色", dark: "深色", language: "语言", session: "会话",
    close: "关闭", name: "名称", subscriptionUrl: "订阅地址",
    urlHelp: "请使用返回完整 Clash/Mihomo YAML 配置的订阅地址。", editUrlHelp: "留空保留已保存的地址，或输入新地址替换。",
    downloadOptions: "下载选项", userAgent: "User-Agent", downloadProxy: "下载代理（可选）",
    removeDownloadProxy: "移除已保存的下载代理", cancel: "取消", saveOnly: "仅保存", saveAndApply: "保存并应用",
    deleteSubscription: "删除订阅", delete: "删除", apply: "应用", validate: "校验",
    selected: "当前订阅", useForAutoUpdate: "用于自动更新", editNamed: "编辑 {name}", moreNamed: "{name} 的更多操作",
    removeDescription: "从订阅列表删除“{name}”？正在运行的 Mihomo 配置仍会保留。",
    neverUpdated: "尚未应用", lastUpdated: "上次应用 {date}", noRecord: "尚未检查", validated: "校验通过",
    updated: "更新成功", unchanged: "已是最新", failed: "失败", restored: "已恢复", rolledBack: "失败 · 已回滚",
    every: "每 {interval}", disabled: "已停用", autoSource: "当前订阅：{name}", noSelected: "尚未选择订阅。",
    nextUpdate: "下次更新：{date}", selectionHelp: "自动更新将应用“{name}”。", selectionNeeded: "启用自动更新前，请先选择一个订阅。",
    applying: "正在更新“{name}”…", validating: "正在校验“{name}”…", applied: "“{name}”更新完成。",
    validationPassed: "“{name}”校验通过。", operationFailed: "“{name}”操作未能完成。",
    saved: "订阅已保存。", removed: "订阅已删除。", selectionSaved: "已选择自动更新订阅。",
    scheduleSaved: "更新计划已保存。", networkError: "无法连接控制台，请检查连接后重试。",
    expired: "会话已过期，请重新登录。", savePending: "正在保存…", requestFailed: "请求失败，请重试。",
  },
};

const $ = (selector) => document.querySelector(selector);
let locale = preference("language", "en");
let theme = preference("theme", "system");
if (!messages[locale]) locale = "en";
if (!["system", "light", "dark"].includes(theme)) theme = "system";
let csrf = null;
let state = null;
let pollTimer;
let fetchController;
let stateVersion = 0;
let renderedSubscriptions = "";
let editing = null;
let removing = null;
let scheduleDirty = false;
let mutationPending = false;
let toastTimer;
const systemTheme = window.matchMedia("(prefers-color-scheme: dark)");

function preference(key, fallback) {
  try { return localStorage.getItem(`mihomo-console-${key}`) || fallback; } catch { return fallback; }
}
function savePreference(key, value) {
  try { localStorage.setItem(`mihomo-console-${key}`, value); } catch { /* Preferences remain usable in memory. */ }
}
function t(key, values = {}) {
  return (messages[locale][key] || messages.en[key] || key).replace(/\{(\w+)\}/g, (_, name) => String(values[name] ?? ""));
}
function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function icon(name) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.classList.add("icon");
  svg.setAttribute("aria-hidden", "true");
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  use.setAttribute("href", `#i-${name}`);
  svg.append(use);
  return svg;
}
function date(value) {
  if (!value || Number.isNaN(new Date(value).getTime())) return "—";
  return new Intl.DateTimeFormat(locale === "zh" ? "zh-CN" : "en", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}
function setError(selector, message) {
  const target = $(selector);
  target.textContent = message || "";
  target.hidden = !message;
}
function pageError(message) {
  $("#page-error-text").textContent = message || "";
  $("#page-error").hidden = !message;
}
function toast(message) {
  clearTimeout(toastTimer);
  $("#toast").textContent = message;
  $("#toast").hidden = false;
  toastTimer = setTimeout(() => { $("#toast").hidden = true; }, 5000);
}
function applyTheme() {
  document.documentElement.dataset.theme = theme === "system" ? (systemTheme.matches ? "dark" : "light") : theme;
}
function translate() {
  document.documentElement.lang = locale === "zh" ? "zh-CN" : "en";
  document.querySelectorAll("[data-i18n]").forEach((node) => { node.textContent = t(node.dataset.i18n); });
  document.querySelectorAll("[data-i18n-label]").forEach((node) => { node.setAttribute("aria-label", t(node.dataset.i18nLabel)); });
  $("#theme").value = theme;
  $("#language").value = locale;
  if (state) { renderedSubscriptions = ""; render(); }
}

async function api(path, data, options = {}) {
  let response;
  try {
    response = await fetch(`/api/${path}`, {
      method: data === undefined ? "GET" : "POST", credentials: "same-origin", cache: "no-store",
      headers: data === undefined ? {} : { "Content-Type": "application/json", "X-CSRF-Token": csrf || "" },
      body: data === undefined ? undefined : JSON.stringify(data), signal: options.signal,
    });
  } catch (error) {
    if (error.name === "AbortError") throw error;
    throw new Error(t("networkError"));
  }
  let result;
  try { result = await response.json(); } catch { throw new Error(t("requestFailed")); }
  if (!response.ok) {
    const error = new Error(result.error || t("requestFailed"));
    error.status = response.status;
    if (response.status === 401 && !["login", "session"].includes(path)) showLogin(t("expired"));
    throw error;
  }
  return result;
}

function showLogin(message = "") {
  csrf = null;
  state = null;
  scheduleDirty = false;
  clearTimeout(pollTimer);
  fetchController?.abort();
  stateVersion += 1;
  renderedSubscriptions = "";
  document.querySelectorAll("dialog[open]").forEach((dialog) => dialog.close());
  $("#subscription-form").reset();
  $("#subscription-list").replaceChildren();
  $("#history-list").replaceChildren();
  $("#toast").hidden = true;
  $("#app-view").hidden = true;
  $("#login-view").hidden = false;
  $("#access-token").value = "";
  $("#access-token").setAttribute("aria-invalid", message ? "true" : "false");
  setError("#login-error", message);
  $("#access-token").focus();
}
function showApp() {
  $("#login-view").hidden = true;
  $("#app-view").hidden = false;
  $("#access-token").value = "";
  $("#loading").hidden = false;
  $("#empty").hidden = true;
  showPage("subscriptions");
  refresh();
}
function showPage(page, focus = false) {
  document.querySelectorAll("[data-page]").forEach((tab) => {
    const selected = tab.dataset.page === page;
    tab.setAttribute("aria-selected", String(selected));
    tab.tabIndex = selected ? 0 : -1;
    if (selected && focus) tab.focus();
  });
  $("#subscriptions-panel").hidden = page !== "subscriptions";
  $("#settings-panel").hidden = page !== "settings";
}
function busy() { return mutationPending || Boolean(state?.jobs.some((job) => job.status === "running")); }

async function refresh() {
  if (!csrf) return;
  clearTimeout(pollTimer);
  fetchController?.abort();
  fetchController = new AbortController();
  const version = ++stateVersion;
  try {
    const next = await api("state", undefined, { signal: fetchController.signal });
    if (version !== stateVersion || !csrf) return;
    state = next;
    $("#loading").hidden = true;
    pageError("");
    render();
  } catch (error) {
    if (error.name !== "AbortError" && csrf && version === stateVersion) {
      $("#loading").hidden = true;
      pageError(error.message);
    }
  } finally {
    if (csrf && version === stateVersion) pollTimer = setTimeout(refresh, busy() ? 1500 : 15000);
  }
}

function actionButton(label, action, className = "button", iconName) {
  const button = element("button", className);
  button.type = "button";
  if (iconName) button.append(icon(iconName));
  button.append(element("span", "", label));
  button.disabled = busy();
  button.addEventListener("click", action);
  return button;
}

function renderSubscriptions() {
  const signature = JSON.stringify([state.subscriptions, busy(), locale]);
  if (signature === renderedSubscriptions) return;
  renderedSubscriptions = signature;
  $("#empty").hidden = state.subscriptions.length !== 0;
  const cards = state.subscriptions.map((subscription) => {
    const card = element("article", `subscription-card${subscription.selected ? " selected" : ""}`);
    const heading = element("div", "subscription-heading");
    const identity = element("div", "subscription-identity");
    identity.append(element("h2", "subscription-name", subscription.name), element("p", "subscription-source", subscription.source));
    heading.append(identity);
    if (subscription.selected) {
      const selected = element("span", "selected-label");
      selected.append(icon("check"), element("span", "", t("selected")));
      heading.append(selected);
    }
    card.append(heading);
    const result = element("p", "subscription-result");
    result.append(element("span", "", t(subscription.last_result === "no-record" ? "noRecord" : subscription.last_result)));
    result.append(element("span", "", subscription.last_success ? t("lastUpdated", { date: date(subscription.last_success) }) : t("neverUpdated")));
    card.append(result);
    if (subscription.last_error) card.append(element("p", "subscription-error", subscription.last_error));
    const actions = element("div", "subscription-actions");
    actions.append(actionButton(t("apply"), () => perform(subscription.name, "update"), "button apply-button", "refresh"));
    actions.append(actionButton(t("validate"), () => perform(subscription.name, "validate"), "button", "check"));
    const edit = actionButton("", () => openSubscription(subscription), "icon-button", "edit");
    edit.setAttribute("aria-label", t("editNamed", { name: subscription.name }));
    actions.append(edit);
    const menu = element("details", "more-menu");
    const summary = element("summary", "");
    summary.setAttribute("aria-label", t("moreNamed", { name: subscription.name }));
    summary.append(icon("more"));
    const content = element("div", "menu-content");
    const select = actionButton(t("useForAutoUpdate"), () => { menu.open = false; perform(subscription.name, "select"); }, "");
    select.disabled = subscription.selected || busy();
    const remove = actionButton(t("deleteSubscription"), () => { menu.open = false; openRemove(subscription); }, "delete-action");
    content.append(select, remove);
    menu.append(summary, content);
    actions.append(menu);
    card.append(actions);
    return card;
  });
  $("#subscription-list").replaceChildren(...cards);
}

function render() {
  const running = state.service === "active";
  $("#service-state").classList.toggle("running", running);
  $("#service-state span:last-child").textContent = t(running ? "running" : state.service === "unknown" ? "unknownService" : "stopped");
  renderSubscriptions();
  $("#update-selected").disabled = busy() || !state.active;
  $("#add-subscription").disabled = busy();
  $("#empty-add").disabled = busy();
  $("#schedule-form button[type=submit]").disabled = busy();
  $("#schedule-summary").textContent = t(state.schedule.enabled ? "every" : "disabled", { interval: state.schedule.interval });
  $("#schedule-source").textContent = state.active ? t("autoSource", { name: state.active }) : t("noSelected");
  $("#schedule-next").textContent = state.schedule.enabled && state.schedule.next_update ? t("nextUpdate", { date: date(state.schedule.next_update) }) : "";
  $("#schedule-selected").textContent = state.active ? t("selectionHelp", { name: state.active }) : t("selectionNeeded");
  if (!scheduleDirty) {
    $("#schedule-enabled").checked = state.schedule.enabled;
    $("#schedule-interval").value = state.schedule.interval;
  }
  const job = state.jobs[0];
  const notice = $("#operation-notice");
  notice.hidden = !job;
  notice.classList.toggle("failed", job?.status === "failed");
  if (job) {
    const message = job.status === "running" ? t(job.action === "validate" ? "validating" : "applying", { name: job.name })
      : job.status === "failed" ? `${t("operationFailed", { name: job.name })} ${job.error || ""}`
        : t(job.action === "validate" ? "validationPassed" : "applied", { name: job.name });
    notice.replaceChildren();
    if (job.status === "running") notice.append(element("span", "spinner"));
    else notice.append(icon(job.status === "failed" ? "alert" : "check"));
    notice.append(element("span", "", message));
  }
  $("#no-history").hidden = state.history.length > 0;
  const history = state.history.map((entry) => {
    const row = element("li", "");
    row.append(element("p", "history-name", entry.name));
    const description = element("p", `history-description${entry.status === "failed" ? " failed" : ""}`);
    description.append(icon(entry.status === "failed" ? "alert" : "check"), element("span", "", t(entry.rolled_back ? "rolledBack" : entry.status)));
    row.append(description, element("p", "history-time", date(entry.finished_at)));
    if (entry.error) row.append(element("p", "history-error", entry.error));
    return row;
  });
  $("#history-list").replaceChildren(...history);
}

async function perform(name, action) {
  if (busy()) return;
  mutationPending = true;
  if (state) render();
  try {
    const result = await api("subscriptions/action", { name, action });
    if (result.job && state) state.jobs.unshift(result.job);
    if (action === "select") toast(t("selectionSaved"));
    if (action === "remove") toast(t("removed"));
  } catch (error) { if (csrf) pageError(error.message); }
  finally { mutationPending = false; if (csrf) await refresh(); }
}

function openSubscription(subscription = null) {
  if (busy()) return;
  editing = subscription;
  const form = $("#subscription-form");
  form.reset();
  setError("#subscription-error", "");
  $("#subscription-dialog-title").textContent = t(subscription ? "editSubscription" : "addSubscription");
  $("#subscription-name").value = subscription?.name || "";
  $("#subscription-name").readOnly = Boolean(subscription);
  $("#subscription-url").required = !subscription;
  $("#url-help").textContent = t(subscription ? "editUrlHelp" : "urlHelp");
  $("#user-agent").value = subscription?.user_agent || "clash.meta";
  $("#clear-proxy-field").hidden = !subscription?.has_download_proxy;
  $("#subscription-dialog details").open = false;
  $("#subscription-dialog").showModal();
  $(subscription ? "#subscription-url" : "#subscription-name").focus();
}
function openRemove(subscription) {
  removing = subscription;
  setError("#remove-error", "");
  $("#remove-description").textContent = t("removeDescription", { name: subscription.name });
  $("#remove-dialog").showModal();
  $("#remove-dialog .dialog-close").focus();
}
function pendingForm(form, pending) {
  form.dataset.pending = String(pending);
  form.querySelectorAll("button, input").forEach((control) => { control.disabled = pending; });
}

$("#login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  if (form.dataset.pending === "true") return;
  pendingForm(form, true);
  $("#login-form button").textContent = t("loggingIn");
  setError("#login-error", "");
  try {
    const result = await api("login", { token: $("#access-token").value });
    csrf = result.csrf;
    showApp();
  } catch (error) {
    setError("#login-error", error.message);
    $("#access-token").setAttribute("aria-invalid", "true");
  } finally {
    pendingForm(form, false);
    $("#login-form button").textContent = t("logIn");
    if (!csrf) $("#access-token").focus();
  }
});
$("#subscription-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  if (form.dataset.pending === "true" || busy()) return;
  const data = { name: $("#subscription-name").value.trim(), editing: Boolean(editing), user_agent: $("#user-agent").value.trim() || "clash.meta" };
  const url = $("#subscription-url").value.trim();
  const proxy = $("#download-proxy").value.trim();
  if (url || !editing) data.url = url;
  if (proxy || !editing || $("#clear-proxy").checked) data.download_proxy = proxy;
  const apply = event.submitter?.value !== "only";
  pendingForm(form, true);
  mutationPending = true;
  setError("#subscription-error", "");
  let saved = false;
  try {
    await api("subscriptions", data);
    saved = true;
    $("#subscription-dialog").close();
    form.reset();
    toast(t("saved"));
    if (apply) {
      const result = await api("subscriptions/action", { name: data.name, action: "update" });
      if (state) state.jobs.unshift(result.job);
    }
  } catch (error) {
    if (csrf) { if (saved) pageError(error.message); else setError("#subscription-error", error.message); }
  } finally {
    pendingForm(form, false);
    mutationPending = false;
    if (csrf) await refresh();
  }
});
$("#remove-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  if (form.dataset.pending === "true" || busy()) return;
  pendingForm(form, true);
  mutationPending = true;
  try {
    await api("subscriptions/action", { name: removing.name, action: "remove" });
    $("#remove-dialog").close();
    toast(t("removed"));
  } catch (error) { if (csrf) setError("#remove-error", error.message); }
  finally { pendingForm(form, false); mutationPending = false; if (csrf) await refresh(); }
});
$("#schedule-form").addEventListener("input", () => { scheduleDirty = true; });
$("#schedule-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (busy()) return;
  const button = $("#schedule-form button[type=submit]");
  button.disabled = true;
  mutationPending = true;
  setError("#schedule-error", "");
  try {
    await api("schedule", { interval: $("#schedule-interval").value.trim(), enabled: $("#schedule-enabled").checked });
    scheduleDirty = false;
    toast(t("scheduleSaved"));
  } catch (error) { if (csrf) setError("#schedule-error", error.message); }
  finally { mutationPending = false; button.disabled = false; if (csrf) await refresh(); }
});

$("#add-subscription").addEventListener("click", () => openSubscription());
$("#empty-add").addEventListener("click", () => openSubscription());
$("#update-selected").addEventListener("click", () => { if (state?.active) perform(state.active, "update"); });
$("#refresh").addEventListener("click", refresh);
$("#retry").addEventListener("click", refresh);
$("#change-schedule").addEventListener("click", () => { showPage("settings"); $("#schedule-interval").focus(); });
document.querySelectorAll("[data-page]").forEach((tab) => {
  tab.addEventListener("click", () => showPage(tab.dataset.page));
  tab.addEventListener("keydown", (event) => {
    if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      showPage(event.key === "Home" ? "subscriptions" : event.key === "End" ? "settings" : tab.dataset.page === "settings" ? "subscriptions" : "settings", true);
    }
  });
});
document.querySelectorAll(".dialog-close").forEach((button) => {
  button.addEventListener("click", () => button.closest("dialog").close());
});
document.querySelectorAll("dialog").forEach((dialog) => {
  dialog.addEventListener("cancel", (event) => { if (dialog.querySelector("form").dataset.pending === "true") event.preventDefault(); });
  dialog.addEventListener("close", () => {
    if (dialog.id === "subscription-dialog") {
      $("#subscription-url").value = "";
      $("#download-proxy").value = "";
    }
  });
});
document.addEventListener("click", (event) => {
  document.querySelectorAll(".more-menu[open]").forEach((menu) => { if (!menu.contains(event.target)) menu.open = false; });
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") document.querySelectorAll(".more-menu[open]").forEach((menu) => { menu.open = false; menu.querySelector("summary").focus(); });
});
$("#theme").addEventListener("change", (event) => { theme = event.target.value; savePreference("theme", theme); applyTheme(); });
systemTheme.addEventListener("change", applyTheme);
$("#language").addEventListener("change", (event) => { locale = event.target.value; savePreference("language", locale); translate(); });
$("#logout").addEventListener("click", async () => {
  const button = $("#logout");
  button.disabled = true;
  try { await api("logout", {}); scheduleDirty = false; showLogin(); }
  catch (error) { if (csrf) pageError(error.message); }
  finally { button.disabled = false; }
});
window.addEventListener("pageshow", (event) => { if (event.persisted) location.reload(); });
applyTheme();
translate();
(async () => {
  try { const result = await api("session"); csrf = result.csrf; showApp(); }
  catch (error) { showLogin(error.status === 401 ? "" : error.message); }
})();
