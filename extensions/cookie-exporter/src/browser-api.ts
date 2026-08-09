import { normalizeChromeCookie, type CookieRecord } from "./model";
import {
  getCookiePermissionPatterns,
  normalizeSiteTarget,
  type CookieScope,
  type SiteTarget
} from "./target";

export interface ActiveTabSite {
  tabId: number;
  target: SiteTarget;
}

export interface ReadCookieOptions {
  revokePermissionAfterRead: boolean;
  scope: CookieScope;
  tabId?: number;
}

export interface ReadCookieResult {
  cookies: CookieRecord[];
  permissionRemoved: boolean;
  storeId?: string;
}

export class BrowserApiUnavailableError extends Error {
  constructor() {
    super("当前页面无法使用扩展 API。请从已安装扩展的工具栏弹窗中打开。");
    this.name = "BrowserApiUnavailableError";
  }
}

export class PermissionDeniedError extends Error {
  constructor() {
    super("未获得该网站的读取权限。你可以重新点击读取并在浏览器提示中允许访问。");
    this.name = "PermissionDeniedError";
  }
}

export async function getActiveTabSite(): Promise<ActiveTabSite> {
  ensureBrowserApi();

  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const activeTab = tabs[0];

  if (activeTab?.id === undefined || !activeTab.url) {
    throw new Error("无法读取当前标签页网址。请刷新页面后重试，或改用“指定网址”。");
  }

  return {
    tabId: activeTab.id,
    target: normalizeSiteTarget(activeTab.url)
  };
}

export async function readCookiesForTarget(
  target: SiteTarget,
  options: ReadCookieOptions
): Promise<ReadCookieResult> {
  ensureBrowserApi();

  const permissionPatterns = getCookiePermissionPatterns(target, options.scope);

  let permissionGranted: boolean;

  try {
    permissionGranted = await chrome.permissions.request({
      origins: permissionPatterns
    });
  } catch (error) {
    throw new Error(
      error instanceof Error
        ? "浏览器未能发起站点授权：" + error.message
        : "浏览器未能发起站点授权。"
    );
  }

  if (!permissionGranted) {
    throw new PermissionDeniedError();
  }

  let permissionRemoved = false;
  let storeId: string | undefined;
  let cookies: CookieRecord[] = [];

  try {
    if (options.tabId !== undefined) {
      storeId = await findCookieStoreForTab(options.tabId);
    }

    const query: chrome.cookies.GetAllDetails =
      options.scope === "url" ? { url: target.href } : { domain: target.siteDomain };

    if (storeId !== undefined) {
      query.storeId = storeId;
    }

    const browserCookies = await chrome.cookies.getAll(query);
    cookies = browserCookies.map(normalizeChromeCookie);
  } finally {
    if (options.revokePermissionAfterRead) {
      try {
        permissionRemoved = await chrome.permissions.remove({
          origins: permissionPatterns
        });
      } catch {
        permissionRemoved = false;
      }
    }
  }

  const result: ReadCookieResult = {
    cookies,
    permissionRemoved
  };

  if (storeId !== undefined) {
    result.storeId = storeId;
  }

  return result;
}

async function findCookieStoreForTab(tabId: number): Promise<string | undefined> {
  const stores = await chrome.cookies.getAllCookieStores();
  return stores.find((store) => store.tabIds.includes(tabId))?.id;
}

function ensureBrowserApi(): void {
  if (
    typeof chrome === "undefined" ||
    !chrome.tabs ||
    !chrome.cookies ||
    !chrome.permissions
  ) {
    throw new BrowserApiUnavailableError();
  }
}
