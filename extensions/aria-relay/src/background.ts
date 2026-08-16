import { Aria2Client, Aria2RpcError } from "./aria2-client";
import {
  getConnectionInfo,
  getSecret,
  getSettings,
  protectStorageAccess,
  resetConnection,
  saveConnection
} from "./config";
import { normalizeEndpoint } from "./security";
import type {
  AddUriRequest,
  ExtensionFailure,
  ExtensionRequest,
  ExtensionResponse,
  ExtensionSuccess,
  PublicSettings
} from "./types";

const MENU_ADD_RESOURCE = "aria-relay-add-resource";
const MENU_ADD_PAGE = "aria-relay-add-page";

void initializeRuntime().catch(() => undefined);

chrome.runtime.onInstalled.addListener(() => {
  void Promise.allSettled([initializeRuntime(), createContextMenus()]);
});

chrome.runtime.onStartup.addListener(() => {
  void initializeRuntime().catch(() => undefined);
});

chrome.runtime.onMessage.addListener(
  (message: unknown, _sender, sendResponse: (response: ExtensionResponse) => void) => {
    if (!isExtensionRequest(message)) {
      sendResponse(failure("INVALID_MESSAGE", "扩展收到了一条无效请求。"));
      return false;
    }

    void handleRequest(message)
      .then(sendResponse)
      .catch((error: unknown) => sendResponse(toFailure(error)));
    return true;
  }
);

chrome.contextMenus.onClicked.addListener((info) => {
  if (info.menuItemId !== MENU_ADD_RESOURCE && info.menuItemId !== MENU_ADD_PAGE) {
    return;
  }
  void handleContextMenu(info);
});

async function initializeRuntime(): Promise<void> {
  await protectStorageAccess();
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
}

async function createContextMenus(): Promise<void> {
  await chrome.contextMenus.removeAll();
  chrome.contextMenus.create({
    contexts: ["link", "image", "video", "audio"],
    id: MENU_ADD_RESOURCE,
    title: "发送到 Aria Relay"
  });
  chrome.contextMenus.create({
    contexts: ["page"],
    id: MENU_ADD_PAGE,
    title: "用 Aria Relay 下载当前页面"
  });
}

async function handleRequest(request: ExtensionRequest): Promise<ExtensionResponse> {
  switch (request.type) {
    case "connection:get":
      return success(await getConnectionInfo());
    case "connection:test": {
      const normalized = normalizeEndpoint(request.endpoint);
      const secret = request.secret?.trim() || (request.useStoredSecret ? await getSecret() : "");
      const client = new Aria2Client(normalized.endpoint, secret);
      return success(await client.getVersion());
    }
    case "connection:save": {
      const normalized = normalizeEndpoint(request.settings.endpoint);
      const settings: PublicSettings = { ...request.settings, endpoint: normalized.endpoint };
      return success(
        await saveConnection(settings, request.secret, request.useStoredSecret)
      );
    }
    case "connection:reset":
      await clearBadge();
      return success(await resetConnection());
    case "snapshot:get": {
      const { client, settings } = await getConfiguredClient();
      const snapshot = await client.getSnapshot(settings.maxResults);
      await updateBadge(snapshot.active.length);
      return success(snapshot);
    }
    case "task:get": {
      const { client } = await getConfiguredClient();
      return success(await client.getTask(request.gid));
    }
    case "task:addUris": {
      const { client } = await getConfiguredClient();
      return success(await client.addUris(request.request));
    }
    case "task:addMetafile": {
      const { client } = await getConfiguredClient();
      return success(await client.addMetafile(request.request));
    }
    case "task:control": {
      const { client } = await getConfiguredClient();
      return success(await client.controlTask(request.gid, request.action));
    }
    case "global:control": {
      const { client } = await getConfiguredClient();
      return success(await client.controlGlobal(request.action));
    }
    case "manager:openTab": {
      const tab = await chrome.tabs.create({ url: chrome.runtime.getURL("manager.html") });
      return success({ tabId: tab.id });
    }
  }
}

async function getConfiguredClient(): Promise<{ client: Aria2Client; settings: PublicSettings }> {
  const [settings, secret] = await Promise.all([getSettings(), getSecret()]);
  if (!settings.configured) {
    throw new Aria2RpcError("请先配置 aria2 RPC 连接。", "NOT_CONFIGURED");
  }
  return { client: new Aria2Client(settings.endpoint, secret), settings };
}

async function handleContextMenu(info: chrome.contextMenus.OnClickData): Promise<void> {
  const uri = getContextMenuUri(info);
  if (!uri) {
    await reportBackgroundEvent("没有找到可发送的下载地址。", true);
    return;
  }

  try {
    const { client, settings } = await getConfiguredClient();
    const request: AddUriRequest = {
      ...(settings.defaultDirectory ? { directory: settings.defaultDirectory } : {}),
      pause: settings.addPaused,
      ...(info.pageUrl ? { referer: info.pageUrl } : {}),
      uris: [uri]
    };
    await client.addUris(request);
    await reportBackgroundEvent("任务已发送到 aria2。", false);
  } catch (error) {
    await reportBackgroundEvent(toFailure(error).message, true);
    if (toFailure(error).code === "NOT_CONFIGURED") {
      await chrome.runtime.openOptionsPage();
    }
  }
}

function getContextMenuUri(info: chrome.contextMenus.OnClickData): string {
  return info.linkUrl ?? info.srcUrl ?? info.pageUrl ?? "";
}

async function reportBackgroundEvent(message: string, isError: boolean): Promise<void> {
  await chrome.storage.session.set({
    ariaRelayLastEvent: { isError, message, timestamp: Date.now() }
  });

  const settings = await getSettings();
  const notificationAllowed =
    settings.notifications &&
    (await chrome.permissions.contains({ permissions: ["notifications"] }));

  if (notificationAllowed) {
    await chrome.notifications.create({
      iconUrl: chrome.runtime.getURL("icons/icon-128.png"),
      message,
      title: "Aria Relay",
      type: "basic"
    });
  } else if (isError) {
    await chrome.action.setBadgeBackgroundColor({ color: "#C4473D" });
    await chrome.action.setBadgeText({ text: "!" });
  }
}

async function updateBadge(activeCount: number): Promise<void> {
  await chrome.action.setBadgeBackgroundColor({ color: "#176B5B" });
  await chrome.action.setBadgeText({ text: activeCount > 0 ? String(Math.min(activeCount, 99)) : "" });
}

async function clearBadge(): Promise<void> {
  await chrome.action.setBadgeText({ text: "" });
}

function success<T>(data: T): ExtensionSuccess<T> {
  return { data, ok: true };
}

function failure(code: string, message: string): ExtensionFailure {
  return { code, message, ok: false };
}

function toFailure(error: unknown): ExtensionFailure {
  if (error instanceof Aria2RpcError) {
    return failure(String(error.code), error.message);
  }
  if (error instanceof Error) {
    return failure(error.name || "ERROR", error.message);
  }
  return failure("UNKNOWN_ERROR", "发生了未知错误。");
}

function isExtensionRequest(value: unknown): value is ExtensionRequest {
  if (typeof value !== "object" || value === null || !("type" in value)) {
    return false;
  }
  return typeof value.type === "string";
}
