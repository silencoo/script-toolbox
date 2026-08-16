import "./settings.css";

import { getElement, setButtonPending } from "./dom";
import { getErrorMessage, sendRequest } from "./runtime";
import { normalizeEndpoint } from "./security";
import { initializeTheme, setTheme, type ThemePreference } from "./theme";
import type { AriaVersion, ConnectionInfo, PublicSettings } from "./types";

const form = getElement<HTMLFormElement>("settings-form");
const endpointInput = getElement<HTMLInputElement>("rpc-endpoint");
const secretInput = getElement<HTMLInputElement>("rpc-secret");
const toggleSecret = getElement<HTMLButtonElement>("toggle-secret");
const rememberSecret = getElement<HTMLInputElement>("remember-secret");
const secretStatus = getElement<HTMLElement>("secret-status");
const permissionSummary = getElement<HTMLElement>("origin-permission");
const endpointWarning = getElement<HTMLElement>("endpoint-warning");
const settingsError = getElement<HTMLElement>("settings-error");
const connectionState = getElement<HTMLElement>("connection-state");
const testAndSave = getElement<HTMLButtonElement>("test-and-save");
const saveOnly = getElement<HTMLButtonElement>("save-only");
const defaultDirectory = getElement<HTMLInputElement>("default-directory");
const refreshInterval = getElement<HTMLSelectElement>("refresh-interval");
const maxResults = getElement<HTMLInputElement>("max-results");
const defaultPaused = getElement<HTMLInputElement>("default-paused");
const notificationsEnabled = getElement<HTMLInputElement>("notifications-enabled");
const themePreference = getElement<HTMLSelectElement>("theme-preference");
const savePreferences = getElement<HTMLButtonElement>("save-preferences");
const saveStatus = getElement<HTMLElement>("save-status");
const resetDialog = getElement<HTMLDialogElement>("reset-dialog");
const confirmReset = getElement<HTMLButtonElement>("confirm-reset");

let connectionInfo: ConnectionInfo | undefined;
let currentPermissionPattern = "";

void initialize();

async function initialize(): Promise<void> {
  if (import.meta.env.DEV && (typeof chrome === "undefined" || !chrome.runtime?.id)) {
    const { installDevChromeMock } = await import("./dev-mock");
    installDevChromeMock();
  }
  const theme = await initializeTheme();
  themePreference.value = theme;
  bindEvents();

  try {
    connectionInfo = await sendRequest<ConnectionInfo>({ type: "connection:get" });
    populateForm(connectionInfo);
  } catch (error) {
    showError(getErrorMessage(error));
  }
}

function bindEvents(): void {
  endpointInput.addEventListener("input", renderEndpointPermission);

  toggleSecret.addEventListener("click", () => {
    const reveal = secretInput.type === "password";
    secretInput.type = reveal ? "text" : "password";
    toggleSecret.textContent = reveal ? "隐藏" : "显示";
    toggleSecret.setAttribute("aria-label", reveal ? "隐藏密钥" : "显示密钥");
  });

  themePreference.addEventListener("change", () => {
    void setTheme(themePreference.value as ThemePreference);
  });

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    void saveSettings(true, testAndSave);
  });

  saveOnly.addEventListener("click", () => {
    void saveSettings(false, saveOnly);
  });

  savePreferences.addEventListener("click", () => {
    void savePreferencesOnly();
  });

  getElement<HTMLButtonElement>("reset-connection").addEventListener("click", () => {
    resetDialog.showModal();
  });

  getElement<HTMLButtonElement>("confirm-reset").addEventListener("click", (event) => {
    event.preventDefault();
    void resetAllSettings();
  });

  document.querySelectorAll<HTMLButtonElement>("[data-close-dialog]").forEach((button) => {
    button.addEventListener("click", () => button.closest<HTMLDialogElement>("dialog")?.close());
  });
}

function populateForm(info: ConnectionInfo): void {
  const { settings } = info;
  endpointInput.value = settings.endpoint;
  rememberSecret.checked = settings.rememberSecret;
  defaultDirectory.value = settings.defaultDirectory;
  refreshInterval.value = String(settings.refreshInterval);
  maxResults.value = String(settings.maxResults);
  defaultPaused.checked = settings.addPaused;
  notificationsEnabled.checked = settings.notifications;
  secretStatus.textContent = getSecretStatusLabel(info.secretStatus);
  secretStatus.dataset.state = info.secretStatus;
  connectionState.textContent = settings.configured ? "已保存" : "未配置";
  connectionState.dataset.state = settings.configured ? "saved" : "idle";
  try {
    currentPermissionPattern = normalizeEndpoint(settings.endpoint).permissionPattern;
  } catch {
    currentPermissionPattern = "";
  }
  renderEndpointPermission();
}

function renderEndpointPermission(): void {
  try {
    const normalized = normalizeEndpoint(endpointInput.value);
    permissionSummary.textContent = `将申请：${normalized.permissionPattern}`;
    endpointWarning.hidden = normalized.isLoopback || normalized.usesTls;
    endpointInput.removeAttribute("aria-invalid");
  } catch (error) {
    permissionSummary.textContent = getErrorMessage(error);
    endpointWarning.hidden = true;
    endpointInput.setAttribute("aria-invalid", "true");
  }
}

async function saveSettings(testConnection: boolean, button: HTMLButtonElement): Promise<void> {
  clearMessages();
  let settings: PublicSettings;
  let normalized: ReturnType<typeof normalizeEndpoint>;

  try {
    settings = readFormSettings();
    normalized = normalizeEndpoint(settings.endpoint);
  } catch (error) {
    showError(getErrorMessage(error));
    return;
  }

  setButtonPending(button, true, testConnection ? "正在测试…" : "正在保存…");

  try {
    const permissions: chrome.permissions.Permissions = {
      origins: [normalized.permissionPattern]
    };
    if (settings.notifications) {
      permissions.permissions = ["notifications"];
    }

    const granted = await chrome.permissions.request(permissions);
    if (!granted) {
      throw new Error("未获得 RPC 主机授权，设置没有保存。");
    }

    if (testConnection) {
      const request = {
        endpoint: normalized.endpoint,
        type: "connection:test" as const,
        useStoredSecret: secretInput.value.trim() === ""
      };
      const version = await sendRequest<AriaVersion>(
        secretInput.value.trim()
          ? { ...request, secret: secretInput.value.trim() }
          : request
      );
      connectionState.textContent = `aria2 ${version.version}`;
      connectionState.dataset.state = "connected";
    }

    const previousPattern = currentPermissionPattern;
    const saveRequest = {
      settings: { ...settings, configured: true, endpoint: normalized.endpoint },
      type: "connection:save" as const,
      useStoredSecret: secretInput.value.trim() === ""
    };
    connectionInfo = await sendRequest<ConnectionInfo>(
      secretInput.value.trim()
        ? { ...saveRequest, secret: secretInput.value.trim() }
        : saveRequest
    );
    currentPermissionPattern = normalized.permissionPattern;

    if (previousPattern && previousPattern !== currentPermissionPattern) {
      await chrome.permissions.remove({ origins: [previousPattern] });
    }

    await setTheme(themePreference.value as ThemePreference);
    secretInput.value = "";
    populateForm(connectionInfo);
    if (testConnection) {
      connectionState.textContent = "连接正常";
      connectionState.dataset.state = "connected";
    }
    showSaved(testConnection ? "连接测试成功，设置已保存。" : "设置已保存，稍后可在管理器中验证连接。");
  } catch (error) {
    connectionState.textContent = "连接失败";
    connectionState.dataset.state = "error";
    showError(getErrorMessage(error));
  } finally {
    setButtonPending(button, false);
  }
}

async function savePreferencesOnly(): Promise<void> {
  clearMessages();
  if (!connectionInfo) {
    showError("设置尚未加载，请稍后重试。");
    return;
  }

  setButtonPending(savePreferences, true, "正在保存…");
  try {
    const settings = readFormSettings();
    if (settings.notifications) {
      const granted = await chrome.permissions.request({ permissions: ["notifications"] });
      if (!granted) {
        settings.notifications = false;
        notificationsEnabled.checked = false;
      }
    } else {
      await chrome.permissions.remove({ permissions: ["notifications"] });
    }

    const request = {
      settings: { ...settings, configured: connectionInfo.settings.configured },
      type: "connection:save" as const,
      useStoredSecret: true
    };
    connectionInfo = await sendRequest<ConnectionInfo>(request);
    await setTheme(themePreference.value as ThemePreference);
    populateForm(connectionInfo);
    showSaved("任务偏好已保存。");
  } catch (error) {
    showError(getErrorMessage(error));
  } finally {
    setButtonPending(savePreferences, false);
  }
}

function readFormSettings(): PublicSettings {
  const normalized = normalizeEndpoint(endpointInput.value);
  const max = Number(maxResults.value);
  if (!Number.isFinite(max) || max < 20 || max > 1_000) {
    throw new Error("历史任务上限必须在 20 到 1000 之间。");
  }

  const interval = Number(refreshInterval.value);
  if (![1_000, 2_000, 5_000, 10_000, 30_000].includes(interval)) {
    throw new Error("请选择有效的刷新频率。");
  }

  return {
    addPaused: defaultPaused.checked,
    configured: connectionInfo?.settings.configured ?? false,
    defaultDirectory: defaultDirectory.value.trim(),
    endpoint: normalized.endpoint,
    maxResults: Math.round(max),
    notifications: notificationsEnabled.checked,
    refreshInterval: interval,
    rememberSecret: rememberSecret.checked
  };
}

async function resetAllSettings(): Promise<void> {
  setButtonPending(confirmReset, true, "正在清除…");
  try {
    let permissionPattern = currentPermissionPattern;
    if (!permissionPattern) {
      try {
        permissionPattern = normalizeEndpoint(endpointInput.value).permissionPattern;
      } catch {
        permissionPattern = "";
      }
    }

    connectionInfo = await sendRequest<ConnectionInfo>({ type: "connection:reset" });
    const removal: chrome.permissions.Permissions = { permissions: ["notifications"] };
    if (permissionPattern) {
      removal.origins = [permissionPattern];
    }
    await chrome.permissions.remove(removal);
    await setTheme("system");
    themePreference.value = "system";
    secretInput.value = "";
    currentPermissionPattern = "";
    populateForm(connectionInfo);
    resetDialog.close();
    showSaved("本机配置与可选权限已清除。");
  } catch (error) {
    showError(getErrorMessage(error));
  } finally {
    setButtonPending(confirmReset, false);
  }
}

function clearMessages(): void {
  settingsError.hidden = true;
  saveStatus.hidden = true;
}

function showError(message: string): void {
  settingsError.textContent = message;
  settingsError.hidden = false;
  settingsError.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function showSaved(message: string): void {
  settingsError.hidden = true;
  saveStatus.textContent = message;
  saveStatus.hidden = false;
  window.setTimeout(() => {
    saveStatus.hidden = true;
  }, 4_000);
}

function getSecretStatusLabel(status: ConnectionInfo["secretStatus"]): string {
  const labels: Record<ConnectionInfo["secretStatus"], string> = {
    missing: "未保存",
    persistent: "已持久保存在本机",
    session: "仅本次浏览器会话"
  };
  return labels[status];
}
