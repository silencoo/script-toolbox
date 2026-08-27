import {
  BUILT_IN_PROFILES,
  DEFAULT_SETTINGS,
  SYSTEM_PROFILE_ID,
  allProfiles,
  createId,
  findProfile,
  loadSettings,
  makeCustomHints,
  normalizeHostname,
  normalizeSettings,
  profileCategoryLabel,
  saveSettings,
  type BrandVersion,
  type ExtensionSettings,
  type ProfileCategory,
  type RuntimeStatus,
  type UAProfile
} from "./core";

const required = <T extends Element>(selector: string): T => {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing element: ${selector}`);
  return element;
};

const profileDialog = required<HTMLDialogElement>("#profile-dialog");
const profileForm = required<HTMLFormElement>("#profile-form");
const confirmDialog = required<HTMLDialogElement>("#confirm-dialog");
const saveStatus = required<HTMLElement>("#save-status");
const feedback = required<HTMLElement>("#manager-feedback");
let settings: ExtensionSettings;
let confirmCallback: (() => Promise<void> | void) | null = null;
let toastTimer: number | undefined;

function option(value: string, label: string): HTMLOptionElement {
  const item = document.createElement("option");
  item.value = value;
  item.textContent = label;
  return item;
}

function showToast(message: string, kind: "success" | "error" = "success"): void {
  window.clearTimeout(toastTimer);
  feedback.textContent = message;
  feedback.dataset.kind = kind;
  feedback.classList.add("visible");
  toastTimer = window.setTimeout(() => feedback.classList.remove("visible"), 2800);
}

async function persist(message = "已保存"): Promise<void> {
  saveStatus.textContent = "正在保存…";
  settings = await saveSettings(settings);
  const status = (await chrome.runtime.sendMessage({ type: "syncNow" })) as RuntimeStatus;
  if (status.lastError) {
    saveStatus.textContent = "保存失败";
    showToast(status.lastError, "error");
    return;
  }
  saveStatus.textContent = message;
}

function showConfirm(title: string, description: string, actionLabel: string, callback: () => Promise<void> | void): void {
  required<HTMLElement>("#confirm-title").textContent = title;
  required<HTMLElement>("#confirm-description").textContent = description;
  required<HTMLButtonElement>("#confirm-action").textContent = actionLabel;
  confirmCallback = callback;
  confirmDialog.showModal();
}

function profileSubtitle(profile: UAProfile): string {
  const engine = profile.clientHints ? "Chromium Client Hints" : "移除 Chromium Client Hints";
  return `${profileCategoryLabel(profile.category)} · ${profile.platform} · ${engine}`;
}

function createActionButton(label: string, className = "button ghost"): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = className;
  button.textContent = label;
  return button;
}

function renderProfileList(): void {
  const container = required<HTMLElement>("#manager-profile-list");
  container.replaceChildren();
  for (const profile of allProfiles(settings)) {
    const row = document.createElement("article");
    row.className = "manager-row";
    const content = document.createElement("div");
    content.className = "manager-row-copy";
    const heading = document.createElement("div");
    heading.className = "row-heading";
    const title = document.createElement("h3");
    title.textContent = profile.name;
    const type = document.createElement("span");
    type.className = "tag";
    type.textContent = profile.builtin ? "内置" : "自定义";
    heading.append(title, type);
    const meta = document.createElement("p");
    meta.textContent = profileSubtitle(profile);
    const ua = document.createElement("code");
    ua.textContent = profile.userAgent;
    content.append(heading, meta, ua);

    const actions = document.createElement("div");
    actions.className = "row-actions";
    const duplicate = createActionButton("复制");
    duplicate.addEventListener("click", () => openProfileDialog(profile, true));
    actions.append(duplicate);
    if (!profile.builtin) {
      const edit = createActionButton("编辑");
      edit.addEventListener("click", () => openProfileDialog(profile, false));
      const remove = createActionButton("删除", "button ghost danger-text");
      remove.addEventListener("click", () => {
        showConfirm(
          "删除自定义配置？",
          `“${profile.name}”及引用它的网站规则会被删除，无法撤销。`,
          "删除",
          async () => {
            settings.customProfiles = settings.customProfiles.filter((item) => item.id !== profile.id);
            settings.siteRules = settings.siteRules.filter((rule) => rule.profileId !== profile.id);
            if (settings.globalProfileId === profile.id) settings.globalProfileId = null;
            await persist();
            renderAll();
          }
        );
      });
      actions.append(edit, remove);
    }
    row.append(content, actions);
    container.append(row);
  }
}

function refillProfileSelects(): void {
  const selects = [
    required<HTMLSelectElement>("#site-profile"),
    required<HTMLSelectElement>("#global-profile")
  ];
  for (const select of selects) {
    const current = select.id === "global-profile" ? settings.globalProfileId ?? SYSTEM_PROFILE_ID : select.value;
    select.replaceChildren(option(SYSTEM_PROFILE_ID, "浏览器默认"));
    for (const profile of allProfiles(settings)) select.append(option(profile.id, profile.name));
    select.value = current;
  }
}

function renderSiteRules(): void {
  const container = required<HTMLElement>("#site-rule-list");
  const empty = required<HTMLElement>("#site-empty");
  container.replaceChildren();
  empty.classList.toggle("hidden", settings.siteRules.length > 0);
  const sorted = [...settings.siteRules].sort((left, right) => left.hostname.localeCompare(right.hostname));
  for (const rule of sorted) {
    const row = document.createElement("article");
    row.className = "manager-row compact";
    const copy = document.createElement("div");
    copy.className = "manager-row-copy";
    const title = document.createElement("h3");
    title.textContent = rule.hostname;
    const meta = document.createElement("p");
    meta.textContent =
      rule.profileId === SYSTEM_PROFILE_ID
        ? "浏览器默认（绕过全局身份）"
        : findProfile(settings, rule.profileId)?.name ?? "配置已不存在";
    copy.append(title, meta);
    const actions = document.createElement("div");
    actions.className = "row-actions";
    const toggleLabel = document.createElement("label");
    toggleLabel.className = "switch";
    const toggle = document.createElement("input");
    toggle.type = "checkbox";
    toggle.checked = rule.enabled;
    toggle.setAttribute("aria-label", `${rule.hostname} 规则`);
    const track = document.createElement("span");
    track.className = "switch-track";
    track.setAttribute("aria-hidden", "true");
    toggleLabel.append(toggle, track);
    toggle.addEventListener("change", () => {
      void (async () => {
        rule.enabled = toggle.checked;
        await persist();
      })();
    });
    const remove = createActionButton("删除", "button ghost danger-text");
    remove.addEventListener("click", () => {
      void (async () => {
        settings.siteRules = settings.siteRules.filter((item) => item.id !== rule.id);
        await persist();
        renderSiteRules();
      })();
    });
    actions.append(toggleLabel, remove);
    row.append(copy, actions);
    container.append(row);
  }
}

function renderAll(): void {
  renderProfileList();
  refillProfileSelects();
  renderSiteRules();
  required<HTMLSelectElement>("#global-profile").value = settings.globalProfileId ?? SYSTEM_PROFILE_ID;
  required<HTMLInputElement>("#js-override").checked = settings.javascriptOverride;
}

function parseBrands(value: string): BrandVersion[] | null {
  if (!value.trim()) return [];
  const entries = value.split(",").map((item) => item.trim()).filter(Boolean);
  const result: BrandVersion[] = [];
  for (const entry of entries) {
    const separator = entry.lastIndexOf("=");
    if (separator < 1 || separator === entry.length - 1) return null;
    const brand = entry.slice(0, separator).trim();
    const version = entry.slice(separator + 1).trim();
    if (!brand || !/^\d+(?:\.\d+){0,3}$/.test(version)) return null;
    result.push({ brand, version });
  }
  return result;
}

function openProfileDialog(profile?: UAProfile, duplicate = false): void {
  profileForm.reset();
  for (const error of profileForm.querySelectorAll<HTMLElement>(".field-error")) error.textContent = "";
  required<HTMLElement>("#profile-form-error").classList.add("hidden");
  required<HTMLElement>("#profile-dialog-title").textContent = profile && !duplicate ? "编辑身份配置" : "新建身份配置";
  required<HTMLInputElement>("#profile-id").value = profile && !duplicate ? profile.id : "";
  if (profile) {
    required<HTMLInputElement>("#profile-name").value = duplicate ? `${profile.name} 副本` : profile.name;
    required<HTMLInputElement>("#profile-platform").value = profile.platform;
    required<HTMLTextAreaElement>("#profile-ua").value = profile.userAgent;
    required<HTMLInputElement>("#profile-vendor").value = profile.vendor;
    required<HTMLSelectElement>("#profile-category").value = profile.category;
    required<HTMLInputElement>("#profile-brands").value =
      profile.clientHints?.brands.map((brand) => `${brand.brand}=${brand.version}`).join(", ") ?? "";
    required<HTMLInputElement>("#profile-mobile").checked = profile.clientHints?.mobile ?? profile.category === "mobile";
  }
  profileDialog.showModal();
  required<HTMLInputElement>("#profile-name").focus();
}

profileForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const data = new FormData(profileForm);
  const name = String(data.get("name") ?? "").trim();
  const platform = String(data.get("platform") ?? "").trim();
  const userAgent = String(data.get("userAgent") ?? "").trim();
  const vendor = String(data.get("vendor") ?? "").trim();
  const category = String(data.get("category") ?? "custom") as ProfileCategory;
  const brands = parseBrands(String(data.get("brands") ?? ""));
  const errors = {
    name: name ? "" : "请输入名称。",
    platform: platform ? "" : "请输入 navigator.platform。",
    userAgent: userAgent ? "" : "请输入 User-Agent。",
    brands: brands === null ? "请使用“品牌=版本”，多个项目用逗号分隔。" : ""
  };
  for (const [key, value] of Object.entries(errors)) {
    const target = profileForm.querySelector<HTMLElement>(`[data-error-for="${key}"]`);
    if (target) target.textContent = value;
  }
  const firstInvalid = Object.entries(errors).find(([, value]) => value);
  if (firstInvalid || !brands) {
    const input = profileForm.elements.namedItem(firstInvalid?.[0] ?? "brands");
    if (input instanceof HTMLElement) input.focus();
    return;
  }
  const existingId = String(data.get("id") ?? "");
  const profile: UAProfile = {
    id: existingId || createId("profile"),
    name,
    category,
    userAgent,
    platform,
    vendor,
    clientHints: makeCustomHints(brands, platform, data.get("mobile") === "on"),
    builtin: false
  };
  const index = settings.customProfiles.findIndex((item) => item.id === profile.id);
  if (index >= 0) settings.customProfiles[index] = profile;
  else settings.customProfiles.push(profile);
  void (async () => {
    await persist();
    profileDialog.close();
    renderAll();
    showToast("身份配置已保存");
  })();
});

required<HTMLFormElement>("#site-rule-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const hostnameInput = required<HTMLInputElement>("#site-hostname");
  const hostname = normalizeHostname(hostnameInput.value);
  const error = required<HTMLElement>("#site-error");
  if (!hostname) {
    error.textContent = "请输入有效域名，例如 example.com。";
    hostnameInput.focus();
    return;
  }
  error.textContent = "";
  const profileId = required<HTMLSelectElement>("#site-profile").value;
  const existing = settings.siteRules.find((rule) => rule.hostname === hostname);
  if (existing) {
    existing.profileId = profileId;
    existing.enabled = true;
  } else {
    settings.siteRules.push({ id: createId("site"), hostname, profileId, enabled: true });
  }
  void (async () => {
    await persist();
    hostnameInput.value = "";
    renderSiteRules();
  })();
});

required<HTMLSelectElement>("#global-profile").addEventListener("change", (event) => {
  const value = (event.currentTarget as HTMLSelectElement).value;
  settings.globalProfileId = value === SYSTEM_PROFILE_ID ? null : value;
  void persist();
});

required<HTMLInputElement>("#js-override").addEventListener("change", (event) => {
  settings.javascriptOverride = (event.currentTarget as HTMLInputElement).checked;
  void (async () => {
    await persist();
    await renderUserScriptsStatus();
  })();
});

async function renderUserScriptsStatus(): Promise<void> {
  const status = (await chrome.runtime.sendMessage({ type: "getRuntimeStatus" })) as RuntimeStatus;
  const target = required<HTMLElement>("#user-scripts-status");
  if (!settings.javascriptOverride) {
    target.className = "notice compact";
    target.textContent = "页面 JavaScript 同步已关闭；请求头规则不受影响。";
  } else if (!status.javascriptOverrideAvailable) {
    target.className = "notice compact warning";
    target.textContent = "请在 chrome://extensions 的扩展详情中开启“允许用户脚本”，然后重新加载本页。";
  } else {
    target.className = "notice compact success";
    target.textContent = "User Scripts 可用；启用的身份会在 document_start 同步到页面。";
  }
}

required<HTMLButtonElement>("#export-settings").addEventListener("click", () => {
  const blob = new Blob([JSON.stringify(settings, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `ua-switcher-backup-${new Date().toISOString().slice(0, 10)}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
  showToast("备份已导出");
});

required<HTMLInputElement>("#import-settings").addEventListener("change", (event) => {
  const input = event.currentTarget as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  void (async () => {
    try {
      const parsed = JSON.parse(await file.text()) as unknown;
      if (!parsed || typeof parsed !== "object" || (parsed as { schemaVersion?: unknown }).schemaVersion !== 1) {
        throw new Error("这不是受支持的 UA Switcher 备份文件。");
      }
      const imported = normalizeSettings(parsed);
      showConfirm(
        "导入备份？",
        `将导入 ${imported.customProfiles.length} 个自定义配置和 ${imported.siteRules.length} 条网站规则，并替换当前设置。`,
        "导入并替换",
        async () => {
          settings = imported;
          await persist();
          renderAll();
          await renderUserScriptsStatus();
          showToast("备份已导入");
        }
      );
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), "error");
    } finally {
      input.value = "";
    }
  })();
});

required<HTMLButtonElement>("#reset-settings").addEventListener("click", () => {
  showConfirm("重置全部设置？", "自定义配置和网站规则将被删除，无法撤销。", "重置全部", async () => {
    settings = structuredClone(DEFAULT_SETTINGS);
    await persist();
    renderAll();
    await renderUserScriptsStatus();
    showToast("已恢复初始配置");
  });
});

required<HTMLButtonElement>("#new-profile").addEventListener("click", () => openProfileDialog());

for (const button of document.querySelectorAll<HTMLButtonElement>("[data-close-dialog]")) {
  button.addEventListener("click", () => required<HTMLDialogElement>(`#${button.dataset.closeDialog}`).close());
}

required<HTMLButtonElement>("#confirm-cancel").addEventListener("click", () => confirmDialog.close());
required<HTMLButtonElement>("#confirm-action").addEventListener("click", () => {
  const callback = confirmCallback;
  confirmCallback = null;
  confirmDialog.close();
  if (callback) void callback();
});

const tabs = [...document.querySelectorAll<HTMLButtonElement>("[data-tab]")];
function activateTab(name: string): void {
  for (const tab of tabs) {
    const active = tab.dataset.tab === name;
    tab.setAttribute("aria-selected", String(active));
    required<HTMLElement>(`#${tab.dataset.tab}-panel`).classList.toggle("hidden", !active);
  }
  history.replaceState(null, "", `#${name}`);
}
for (const [index, tab] of tabs.entries()) {
  tab.addEventListener("click", () => activateTab(tab.dataset.tab ?? "profiles"));
  tab.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const offset = event.key === "ArrowRight" ? 1 : -1;
    const next = tabs[(index + offset + tabs.length) % tabs.length];
    next?.focus();
    if (next?.dataset.tab) activateTab(next.dataset.tab);
  });
}

const themeKey = "uam-theme";
function applyTheme(theme: "light" | "dark"): void {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem(themeKey, theme);
}
required<HTMLButtonElement>("#theme-toggle").addEventListener("click", () => {
  applyTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark");
});

async function initialize(): Promise<void> {
  const storedTheme = localStorage.getItem(themeKey);
  applyTheme(
    storedTheme === "light" || storedTheme === "dark"
      ? storedTheme
      : matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light"
  );
  settings = await loadSettings();
  renderAll();
  await renderUserScriptsStatus();
  const initialTab = location.hash.slice(1);
  if (tabs.some((tab) => tab.dataset.tab === initialTab)) activateTab(initialTab);
}

void initialize().catch((error: unknown) => {
  showToast(error instanceof Error ? error.message : String(error), "error");
});
