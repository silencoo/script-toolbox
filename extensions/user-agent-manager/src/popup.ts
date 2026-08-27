import {
  SYSTEM_PROFILE_ID,
  allProfiles,
  findProfile,
  loadSettings,
  profileCategoryLabel,
  resolveProfileId,
  saveSettings,
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

const enabledToggle = required<HTMLInputElement>("#enabled-toggle");
const siteLabel = required<HTMLElement>("#site-label");
const profileSearch = required<HTMLInputElement>("#profile-search");
const profileList = required<HTMLElement>("#profile-list");
const emptySearch = required<HTMLElement>("#empty-search");
const activeSummary = required<HTMLElement>("#active-summary");
const applyButton = required<HTMLButtonElement>("#apply-profile");
const feedback = required<HTMLElement>("#popup-feedback");
const permissionNotice = required<HTMLElement>("#permission-notice");

let settings: ExtensionSettings;
let activeTab: chrome.tabs.Tab | null = null;
let currentHost: string | null = null;
let selectedProfileId = SYSTEM_PROFILE_ID;

function createCategoryIcon(category: ProfileCategory | "system"): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  const paths: Record<ProfileCategory | "system", string> = {
    system: "M5 5h14v10H5zM9 19h6M12 15v4",
    desktop: "M4 5h16v11H4zM9 20h6M12 16v4",
    mobile: "M8 2h8v20H8zM11 18h2",
    bot: "M7 8h10v10H7zM9 12h.01M15 12h.01M9 15h6M12 8V5M10 3h4",
    custom: "M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7ZM19 12a7 7 0 0 1-.16 1.5l2 1.55-2 3.45-2.45-1a7 7 0 0 1-2.6 1.5L13.5 22h-4l-.3-3a7 7 0 0 1-2.6-1.5l-2.45 1-2-3.45 2-1.55A7 7 0 0 1 4 12c0-.52.06-1.02.16-1.5l-2-1.55 2-3.45 2.45 1A7 7 0 0 1 9.2 5L9.5 2h4l.3 3a7 7 0 0 1 2.6 1.5l2.45-1 2 3.45-2 1.55c.1.48.15.98.15 1.5Z"
  };
  path.setAttribute("d", paths[category]);
  svg.append(path);
  return svg;
}

function scope(): "site" | "global" {
  return required<HTMLInputElement>('input[name="scope"]:checked').value === "global" ? "global" : "site";
}

function selectedForScope(): string {
  if (scope() === "global") return settings.globalProfileId ?? SYSTEM_PROFILE_ID;
  return currentHost ? resolveProfileId(settings, currentHost) ?? SYSTEM_PROFILE_ID : SYSTEM_PROFILE_ID;
}

function profileDetail(profile: UAProfile | null): string {
  if (!profile) return "浏览器原始身份";
  return `${profileCategoryLabel(profile.category)} · ${profile.platform}`;
}

function renderProfiles(): void {
  profileList.replaceChildren();
  const query = profileSearch.value.trim().toLocaleLowerCase();
  const options: Array<UAProfile | null> = [null, ...allProfiles(settings)];
  const visible = options.filter((profile) => {
    const haystack = profile
      ? `${profile.name} ${profile.platform} ${profile.category}`
      : "浏览器默认 system default";
    return haystack.toLocaleLowerCase().includes(query);
  });
  emptySearch.classList.toggle("hidden", visible.length > 0);

  for (const profile of visible) {
    const id = profile?.id ?? SYSTEM_PROFILE_ID;
    const label = document.createElement("label");
    label.className = "profile-option";
    const input = document.createElement("input");
    input.type = "radio";
    input.name = "profile";
    input.value = id;
    input.checked = id === selectedProfileId;
    input.addEventListener("change", () => {
      selectedProfileId = id;
      activeSummary.textContent = profile?.name ?? "浏览器默认";
    });
    const icon = document.createElement("span");
    icon.className = "profile-icon";
    icon.append(createCategoryIcon(profile?.category ?? "system"));
    const copy = document.createElement("span");
    copy.className = "profile-copy";
    const name = document.createElement("strong");
    name.textContent = profile?.name ?? "浏览器默认";
    const detail = document.createElement("small");
    detail.textContent = profileDetail(profile);
    copy.append(name, detail);
    const check = document.createElement("span");
    check.className = "profile-check";
    check.setAttribute("aria-hidden", "true");
    label.append(input, icon, copy, check);
    profileList.append(label);
  }
  activeSummary.textContent = findProfile(settings, selectedProfileId)?.name ?? "浏览器默认";
}

function setFeedback(message: string, kind: "success" | "error" | "pending" = "success"): void {
  feedback.textContent = message;
  feedback.dataset.kind = kind;
}

async function getRuntimeStatus(): Promise<RuntimeStatus> {
  return (await chrome.runtime.sendMessage({ type: "getRuntimeStatus" })) as RuntimeStatus;
}

async function initialize(): Promise<void> {
  [settings] = await Promise.all([loadSettings()]);
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  activeTab = tab ?? null;
  try {
    const url = activeTab?.url ? new URL(activeTab.url) : null;
    currentHost = url && (url.protocol === "http:" || url.protocol === "https:") ? url.hostname : null;
  } catch {
    currentHost = null;
  }
  siteLabel.textContent = currentHost ?? "此页面不支持站点级切换";
  const siteScope = required<HTMLInputElement>('input[name="scope"][value="site"]');
  siteScope.disabled = !currentHost;
  if (!currentHost) required<HTMLInputElement>('input[name="scope"][value="global"]').checked = true;
  enabledToggle.checked = settings.enabled;
  document.body.classList.toggle("is-paused", !settings.enabled);
  selectedProfileId = selectedForScope();
  renderProfiles();

  const status = await getRuntimeStatus();
  permissionNotice.classList.toggle(
    "hidden",
    !settings.javascriptOverride || status.javascriptOverrideAvailable
  );
  if (status.lastError) setFeedback(`规则错误：${status.lastError}`, "error");
}

enabledToggle.addEventListener("change", () => {
  void (async () => {
    settings.enabled = enabledToggle.checked;
    document.body.classList.toggle("is-paused", !settings.enabled);
    settings = await saveSettings(settings);
    await chrome.runtime.sendMessage({ type: "syncNow" });
    setFeedback(settings.enabled ? "UA 切换已启用" : "UA 切换已暂停");
  })();
});

profileSearch.addEventListener("input", renderProfiles);

for (const radio of document.querySelectorAll<HTMLInputElement>('input[name="scope"]')) {
  radio.addEventListener("change", () => {
    selectedProfileId = selectedForScope();
    renderProfiles();
  });
}

applyButton.addEventListener("click", () => {
  void (async () => {
    applyButton.disabled = true;
    setFeedback("正在更新规则…", "pending");
    if (scope() === "global") {
      settings.globalProfileId = selectedProfileId === SYSTEM_PROFILE_ID ? null : selectedProfileId;
    } else if (currentHost) {
      const existing = settings.siteRules.find((rule) => rule.hostname === currentHost);
      if (existing) {
        existing.profileId = selectedProfileId;
        existing.enabled = true;
      } else {
        settings.siteRules.push({
          id: `site-${crypto.randomUUID()}`,
          hostname: currentHost,
          profileId: selectedProfileId,
          enabled: true
        });
      }
    } else {
      setFeedback("当前页面不能创建网站规则。", "error");
      applyButton.disabled = false;
      return;
    }
    settings = await saveSettings(settings);
    const status = (await chrome.runtime.sendMessage({ type: "syncNow" })) as RuntimeStatus;
    if (status.lastError) {
      setFeedback(`应用失败：${status.lastError}`, "error");
    } else {
      setFeedback("已应用；正在刷新页面。");
      if (activeTab?.id && currentHost) await chrome.tabs.reload(activeTab.id);
    }
    applyButton.disabled = false;
  })();
});

required<HTMLButtonElement>("#open-manager").addEventListener("click", () => {
  void chrome.runtime.openOptionsPage();
});

void initialize().catch((error: unknown) => {
  setFeedback(error instanceof Error ? error.message : String(error), "error");
});
