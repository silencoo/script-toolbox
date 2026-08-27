import {
  DEFAULT_SETTINGS,
  STORAGE_KEY,
  USER_SCRIPT_ID,
  buildDynamicRules,
  buildNavigatorScript,
  loadSettings,
  normalizeSettings,
  type ExtensionSettings,
  type RuntimeStatus
} from "./core";

const STATUS_KEY = "userAgentManagerRuntimeStatus";
let syncQueue: Promise<RuntimeStatus> = Promise.resolve({
  headerRulesActive: false,
  javascriptOverrideAvailable: false,
  javascriptOverrideActive: false,
  lastError: null
});

async function replaceUserScript(source: string | null): Promise<{ available: boolean; active: boolean }> {
  if (!chrome.userScripts) return { available: false, active: false };
  try {
    const existing = await chrome.userScripts.getScripts({ ids: [USER_SCRIPT_ID] });
    if (existing.length > 0) {
      await chrome.userScripts.unregister({ ids: [USER_SCRIPT_ID] });
    }
    if (!source) return { available: true, active: false };
    await chrome.userScripts.register([
      {
        id: USER_SCRIPT_ID,
        matches: ["http://*/*", "https://*/*"],
        allFrames: true,
        runAt: "document_start",
        world: "MAIN",
        js: [{ code: source }]
      }
    ]);
    return { available: true, active: true };
  } catch {
    return { available: false, active: false };
  }
}

async function updateBadge(settings: ExtensionSettings, activeRuleCount: number): Promise<void> {
  if (!settings.enabled) {
    await chrome.action.setBadgeText({ text: "OFF" });
    await chrome.action.setBadgeBackgroundColor({ color: "#64748b" });
    await chrome.action.setTitle({ title: "UA Switcher 已暂停" });
    return;
  }
  await chrome.action.setBadgeText({ text: activeRuleCount > 0 ? "ON" : "" });
  await chrome.action.setBadgeBackgroundColor({ color: "#0f766e" });
  await chrome.action.setTitle({
    title: activeRuleCount > 0 ? "UA Switcher 正在应用身份规则" : "UA Switcher 使用浏览器默认身份"
  });
}

async function synchronizeNow(): Promise<RuntimeStatus> {
  const settings = await loadSettings();
  const dynamicRules = buildDynamicRules(settings);
  let headerRulesActive = false;
  let lastError: string | null = null;

  try {
    const existing = await chrome.declarativeNetRequest.getDynamicRules();
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: existing.map((rule) => rule.id),
      addRules: dynamicRules
    });
    headerRulesActive = dynamicRules.length > 0;
  } catch (error) {
    lastError = error instanceof Error ? error.message : String(error);
  }

  const scriptStatus = await replaceUserScript(buildNavigatorScript(settings));
  const status: RuntimeStatus = {
    headerRulesActive,
    javascriptOverrideAvailable: scriptStatus.available,
    javascriptOverrideActive: scriptStatus.active,
    lastError
  };
  await Promise.all([
    chrome.storage.session.set({ [STATUS_KEY]: status }),
    updateBadge(settings, dynamicRules.length)
  ]);
  return status;
}

function queueSynchronization(): Promise<RuntimeStatus> {
  syncQueue = syncQueue.then(synchronizeNow, synchronizeNow);
  return syncQueue;
}

chrome.runtime.onInstalled.addListener(() => {
  void (async () => {
    const stored = await chrome.storage.local.get(STORAGE_KEY);
    if (!stored[STORAGE_KEY]) {
      await chrome.storage.local.set({ [STORAGE_KEY]: DEFAULT_SETTINGS });
    } else {
      await chrome.storage.local.set({ [STORAGE_KEY]: normalizeSettings(stored[STORAGE_KEY]) });
    }
    await queueSynchronization();
  })();
});

chrome.runtime.onStartup.addListener(() => {
  void queueSynchronization();
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === "local" && changes[STORAGE_KEY]) {
    void queueSynchronization();
  }
});

chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  const type =
    message && typeof message === "object" && "type" in message
      ? (message as { type?: unknown }).type
      : null;
  if (type === "getRuntimeStatus") {
    void (async () => {
      const stored = await chrome.storage.session.get(STATUS_KEY);
      const status = stored[STATUS_KEY] as RuntimeStatus | undefined;
      sendResponse(status ?? (await queueSynchronization()));
    })();
    return true;
  }
  if (type === "syncNow") {
    void queueSynchronization().then(sendResponse);
    return true;
  }
  return false;
});

void queueSynchronization();
