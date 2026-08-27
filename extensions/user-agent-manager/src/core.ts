export type ProfileCategory = "desktop" | "mobile" | "bot" | "custom";

export interface BrandVersion {
  brand: string;
  version: string;
}

export interface ClientHints {
  brands: BrandVersion[];
  fullVersionList: BrandVersion[];
  mobile: boolean;
  platform: string;
  platformVersion: string;
  architecture: string;
  bitness: string;
  model: string;
  wow64: boolean;
}

export interface UAProfile {
  id: string;
  name: string;
  category: ProfileCategory;
  userAgent: string;
  platform: string;
  vendor: string;
  clientHints: ClientHints | null;
  builtin: boolean;
}

export interface SiteRule {
  id: string;
  hostname: string;
  profileId: string;
  enabled: boolean;
}

export interface ExtensionSettings {
  schemaVersion: 1;
  enabled: boolean;
  globalProfileId: string | null;
  javascriptOverride: boolean;
  customProfiles: UAProfile[];
  siteRules: SiteRule[];
}

export interface RuntimeStatus {
  headerRulesActive: boolean;
  javascriptOverrideAvailable: boolean;
  javascriptOverrideActive: boolean;
  lastError: string | null;
}

export const STORAGE_KEY = "userAgentManagerSettings";
export const SYSTEM_PROFILE_ID = "system";
export const USER_SCRIPT_ID = "uam-navigator-identity";

function chromiumHints(
  product: "chrome" | "edge",
  version: string,
  platform: string,
  platformVersion: string,
  mobile = false,
  model = ""
): ClientHints {
  const browserBrand = product === "edge" ? "Microsoft Edge" : "Google Chrome";
  const major = version.split(".")[0] ?? version;
  return {
    brands: [
      { brand: "Not_A Brand", version: "99" },
      { brand: "Chromium", version: major },
      { brand: browserBrand, version: major }
    ],
    fullVersionList: [
      { brand: "Not_A Brand", version: "99.0.0.0" },
      { brand: "Chromium", version },
      { brand: browserBrand, version }
    ],
    mobile,
    platform,
    platformVersion,
    architecture: mobile ? "arm" : "x86",
    bitness: "64",
    model,
    wow64: false
  };
}

export const BUILT_IN_PROFILES: readonly UAProfile[] = [
  {
    id: "chrome-windows",
    name: "Chrome · Windows",
    category: "desktop",
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    platform: "Win32",
    vendor: "Google Inc.",
    clientHints: chromiumHints("chrome", "131.0.6778.86", "Windows", "10.0.0"),
    builtin: true
  },
  {
    id: "edge-windows",
    name: "Edge · Windows",
    category: "desktop",
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.2903.70",
    platform: "Win32",
    vendor: "Google Inc.",
    clientHints: chromiumHints("edge", "131.0.2903.70", "Windows", "10.0.0"),
    builtin: true
  },
  {
    id: "firefox-windows",
    name: "Firefox · Windows",
    category: "desktop",
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0",
    platform: "Win32",
    vendor: "",
    clientHints: null,
    builtin: true
  },
  {
    id: "safari-macos",
    name: "Safari · macOS",
    category: "desktop",
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15",
    platform: "MacIntel",
    vendor: "Apple Computer, Inc.",
    clientHints: null,
    builtin: true
  },
  {
    id: "chrome-android",
    name: "Chrome · Android",
    category: "mobile",
    userAgent:
      "Mozilla/5.0 (Linux; Android 15; Pixel 9 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36",
    platform: "Linux armv81",
    vendor: "Google Inc.",
    clientHints: chromiumHints("chrome", "131.0.6778.81", "Android", "15.0.0", true, "Pixel 9 Pro"),
    builtin: true
  },
  {
    id: "safari-iphone",
    name: "Safari · iPhone",
    category: "mobile",
    userAgent:
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1",
    platform: "iPhone",
    vendor: "Apple Computer, Inc.",
    clientHints: null,
    builtin: true
  },
  {
    id: "googlebot-mobile",
    name: "Googlebot · Smartphone",
    category: "bot",
    userAgent:
      "Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X Build/MMB29P) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
    platform: "Linux armv81",
    vendor: "Google Inc.",
    clientHints: null,
    builtin: true
  }
];

export const DEFAULT_SETTINGS: ExtensionSettings = {
  schemaVersion: 1,
  enabled: true,
  globalProfileId: null,
  javascriptOverride: true,
  customProfiles: [],
  siteRules: []
};

const categories = new Set<ProfileCategory>(["desktop", "mobile", "bot", "custom"]);
const profileIds = new Set(BUILT_IN_PROFILES.map((profile) => profile.id));

export function createId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

function cleanText(value: unknown, maximum: number): string {
  return typeof value === "string" ? value.trim().slice(0, maximum) : "";
}

function cleanBrands(value: unknown): BrandVersion[] {
  if (!Array.isArray(value)) return [];
  return value
    .slice(0, 8)
    .map((entry) => {
      if (!entry || typeof entry !== "object") return null;
      const record = entry as Record<string, unknown>;
      const brand = cleanText(record.brand, 64);
      const version = cleanText(record.version, 32);
      return brand && version ? { brand, version } : null;
    })
    .filter((entry): entry is BrandVersion => entry !== null);
}

function cleanClientHints(value: unknown): ClientHints | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const brands = cleanBrands(record.brands);
  if (brands.length === 0) return null;
  const fullVersionList = cleanBrands(record.fullVersionList);
  return {
    brands,
    fullVersionList: fullVersionList.length > 0 ? fullVersionList : brands,
    mobile: record.mobile === true,
    platform: cleanText(record.platform, 64),
    platformVersion: cleanText(record.platformVersion, 32),
    architecture: cleanText(record.architecture, 32),
    bitness: cleanText(record.bitness, 8),
    model: cleanText(record.model, 128),
    wow64: record.wow64 === true
  };
}

function cleanProfile(value: unknown): UAProfile | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const id = cleanText(record.id, 100);
  const name = cleanText(record.name, 60);
  const userAgent = cleanText(record.userAgent, 1024);
  const platform = cleanText(record.platform, 128);
  const category = categories.has(record.category as ProfileCategory)
    ? (record.category as ProfileCategory)
    : "custom";
  if (!id || profileIds.has(id) || !name || !userAgent || !platform) return null;
  return {
    id,
    name,
    category,
    userAgent,
    platform,
    vendor: cleanText(record.vendor, 128),
    clientHints: cleanClientHints(record.clientHints),
    builtin: false
  };
}

export function normalizeHostname(input: string): string | null {
  const candidate = input.trim().toLowerCase().replace(/^\*\./, "");
  if (!candidate || candidate.length > 253 || /[\s/?#]/.test(candidate)) return null;
  try {
    const hostname = new URL(`https://${candidate}`).hostname.replace(/\.$/, "");
    if (hostname === "localhost") return hostname;
    if (hostname.includes(":")) return null;
    const labels = hostname.split(".");
    if (labels.some((label) => !label || label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label))) {
      return null;
    }
    return hostname;
  } catch {
    return null;
  }
}

export function allProfiles(settings: ExtensionSettings): UAProfile[] {
  return [...BUILT_IN_PROFILES, ...settings.customProfiles];
}

export function findProfile(settings: ExtensionSettings, id: string | null): UAProfile | null {
  if (!id || id === SYSTEM_PROFILE_ID) return null;
  return allProfiles(settings).find((profile) => profile.id === id) ?? null;
}

export function normalizeSettings(value: unknown): ExtensionSettings {
  if (!value || typeof value !== "object") return structuredClone(DEFAULT_SETTINGS);
  const record = value as Record<string, unknown>;
  const customProfiles = Array.isArray(record.customProfiles)
    ? record.customProfiles.map(cleanProfile).filter((profile): profile is UAProfile => profile !== null).slice(0, 200)
    : [];
  const validIds = new Set([...BUILT_IN_PROFILES.map((profile) => profile.id), ...customProfiles.map((profile) => profile.id)]);
  const globalCandidate = cleanText(record.globalProfileId, 100);
  const globalProfileId = validIds.has(globalCandidate) ? globalCandidate : null;
  const seenHosts = new Set<string>();
  const siteRules: SiteRule[] = [];
  if (Array.isArray(record.siteRules)) {
    for (const value of record.siteRules.slice(0, 400)) {
      if (!value || typeof value !== "object") continue;
      const rule = value as Record<string, unknown>;
      const hostname = normalizeHostname(cleanText(rule.hostname, 253));
      const selectedId = cleanText(rule.profileId, 100);
      if (!hostname || seenHosts.has(hostname) || (selectedId !== SYSTEM_PROFILE_ID && !validIds.has(selectedId))) continue;
      seenHosts.add(hostname);
      siteRules.push({
        id: cleanText(rule.id, 100) || createId("site"),
        hostname,
        profileId: selectedId,
        enabled: rule.enabled !== false
      });
    }
  }
  return {
    schemaVersion: 1,
    enabled: record.enabled !== false,
    globalProfileId,
    javascriptOverride: record.javascriptOverride !== false,
    customProfiles,
    siteRules
  };
}

export async function loadSettings(): Promise<ExtensionSettings> {
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  return normalizeSettings(stored[STORAGE_KEY]);
}

export async function saveSettings(settings: ExtensionSettings): Promise<ExtensionSettings> {
  const normalized = normalizeSettings(settings);
  await chrome.storage.local.set({ [STORAGE_KEY]: normalized });
  return normalized;
}

export function resolveProfileId(settings: ExtensionSettings, hostname: string): string | null {
  if (!settings.enabled) return null;
  const normalized = normalizeHostname(hostname);
  if (!normalized) return settings.globalProfileId;
  const match = settings.siteRules
    .filter((rule) => rule.enabled && (normalized === rule.hostname || normalized.endsWith(`.${rule.hostname}`)))
    .sort((left, right) => right.hostname.length - left.hostname.length)[0];
  if (match) return match.profileId === SYSTEM_PROFILE_ID ? null : match.profileId;
  return settings.globalProfileId;
}

const clientHintHeaders = [
  "sec-ch-ua",
  "sec-ch-ua-mobile",
  "sec-ch-ua-platform",
  "sec-ch-ua-full-version-list",
  "sec-ch-ua-full-version",
  "sec-ch-ua-platform-version",
  "sec-ch-ua-arch",
  "sec-ch-ua-bitness",
  "sec-ch-ua-model",
  "sec-ch-ua-wow64"
] as const;

function quoteHint(value: string): string {
  return `"${value.replace(/[\\"]/g, "\\$&")}"`;
}

function brandHeader(brands: BrandVersion[]): string {
  return brands.map((brand) => `${quoteHint(brand.brand)};v=${quoteHint(brand.version)}`).join(", ");
}

function hintValues(hints: ClientHints): ReadonlyArray<readonly [string, string]> {
  const chromeFullVersion = hints.fullVersionList.find((brand) => brand.brand !== "Not_A Brand")?.version ?? "";
  return [
    ["sec-ch-ua", brandHeader(hints.brands)],
    ["sec-ch-ua-mobile", hints.mobile ? "?1" : "?0"],
    ["sec-ch-ua-platform", quoteHint(hints.platform)],
    ["sec-ch-ua-full-version-list", brandHeader(hints.fullVersionList)],
    ["sec-ch-ua-full-version", quoteHint(chromeFullVersion)],
    ["sec-ch-ua-platform-version", quoteHint(hints.platformVersion)],
    ["sec-ch-ua-arch", quoteHint(hints.architecture)],
    ["sec-ch-ua-bitness", quoteHint(hints.bitness)],
    ["sec-ch-ua-model", quoteHint(hints.model)],
    ["sec-ch-ua-wow64", hints.wow64 ? "?1" : "?0"]
  ];
}

type RuleCondition = chrome.declarativeNetRequest.RuleCondition;
type Rule = chrome.declarativeNetRequest.Rule;

export function buildDynamicRules(settings: ExtensionSettings): Rule[] {
  if (!settings.enabled) return [];
  const rules: Rule[] = [];
  let nextId = 1;

  const addProfileRules = (profile: UAProfile, priority: number, condition: RuleCondition): void => {
    const baseHeaders: chrome.declarativeNetRequest.ModifyHeaderInfo[] = [
      { header: "user-agent", operation: "set", value: profile.userAgent }
    ];
    if (!profile.clientHints) {
      baseHeaders.push(...clientHintHeaders.map((header) => ({ header, operation: "remove" as const })));
    }
    rules.push({
      id: nextId++,
      priority,
      action: { type: "modifyHeaders", requestHeaders: baseHeaders },
      condition
    });
    if (profile.clientHints) {
      for (const [header, value] of hintValues(profile.clientHints)) {
        rules.push({
          id: nextId++,
          priority,
          action: { type: "modifyHeaders", requestHeaders: [{ header, operation: "set", value }] },
          condition: {
            ...condition,
            requestHeaders: [{ header }]
          } as RuleCondition
        });
      }
    }
  };

  const globalProfile = findProfile(settings, settings.globalProfileId);
  if (globalProfile) {
    addProfileRules(globalProfile, 1, { regexFilter: "^https?://" });
  }

  const activeSiteRules = settings.siteRules
    .filter((rule) => rule.enabled)
    .sort((left, right) => left.hostname.localeCompare(right.hostname));
  for (const siteRule of activeSiteRules) {
    const priority = 10_000 + siteRule.hostname.split(".").length * 100 + Math.min(siteRule.hostname.length, 99);
    const condition: RuleCondition = { requestDomains: [siteRule.hostname] };
    if (siteRule.profileId === SYSTEM_PROFILE_ID) {
      rules.push({ id: nextId++, priority, action: { type: "allow" }, condition });
      continue;
    }
    const profile = findProfile(settings, siteRule.profileId);
    if (profile) addProfileRules(profile, priority, condition);
  }
  return rules;
}

interface ScriptProfile {
  id: string;
  userAgent: string;
  platform: string;
  vendor: string;
  clientHints: ClientHints | null;
}

export function buildNavigatorScript(settings: ExtensionSettings): string | null {
  if (!settings.enabled || !settings.javascriptOverride) return null;
  const usedIds = new Set(
    [settings.globalProfileId, ...settings.siteRules.filter((rule) => rule.enabled).map((rule) => rule.profileId)]
      .filter((id): id is string => Boolean(id && id !== SYSTEM_PROFILE_ID))
  );
  if (usedIds.size === 0) return null;
  const profiles: ScriptProfile[] = allProfiles(settings)
    .filter((profile) => usedIds.has(profile.id))
    .map(({ id, userAgent, platform, vendor, clientHints }) => ({ id, userAgent, platform, vendor, clientHints }));
  const payload = JSON.stringify({
    globalProfileId: settings.globalProfileId,
    siteRules: settings.siteRules.filter((rule) => rule.enabled).map(({ hostname, profileId }) => ({ hostname, profileId })),
    profiles
  }).replace(/</g, "\\u003c");

  return `(() => {
    "use strict";
    const config = ${payload};
    const hostname = location.hostname.toLowerCase();
    const matching = config.siteRules
      .filter((rule) => hostname === rule.hostname || hostname.endsWith("." + rule.hostname))
      .sort((a, b) => b.hostname.length - a.hostname.length)[0];
    const profileId = matching ? (matching.profileId === "${SYSTEM_PROFILE_ID}" ? null : matching.profileId) : config.globalProfileId;
    const profile = config.profiles.find((item) => item.id === profileId);
    if (!profile || typeof Navigator === "undefined") return;
    const define = (key, getter) => {
      try { Object.defineProperty(Navigator.prototype, key, { configurable: true, get: getter }); } catch {}
    };
    define("userAgent", () => profile.userAgent);
    define("appVersion", () => profile.userAgent.replace(/^Mozilla\//, ""));
    define("platform", () => profile.platform);
    define("vendor", () => profile.vendor);
    if (!profile.clientHints) {
      define("userAgentData", () => undefined);
      return;
    }
    const source = profile.clientHints;
    const low = Object.freeze({ brands: source.brands.map(Object.freeze), mobile: source.mobile, platform: source.platform });
    const data = Object.freeze({
      ...low,
      getHighEntropyValues: async (hints) => {
        const values = { ...low };
        for (const hint of hints) {
          if (hint === "fullVersionList") values.fullVersionList = source.fullVersionList.map(Object.freeze);
          else if (hint === "uaFullVersion") values.uaFullVersion = source.fullVersionList.find((brand) => brand.brand !== "Not_A Brand")?.version || "";
          else if (hint in source) values[hint] = source[hint];
        }
        return values;
      },
      toJSON: () => low
    });
    define("userAgentData", () => data);
  })();`;
}

export function profileCategoryLabel(category: ProfileCategory): string {
  return { desktop: "桌面", mobile: "移动设备", bot: "爬虫", custom: "自定义" }[category];
}

export function makeCustomHints(
  brands: BrandVersion[],
  platform: string,
  mobile: boolean
): ClientHints | null {
  if (brands.length === 0) return null;
  const mappedPlatform = mobile ? "Android" : platform.toLowerCase().includes("mac") ? "macOS" : "Windows";
  return {
    brands,
    fullVersionList: brands.map((brand) => ({
      brand: brand.brand,
      version: brand.version.includes(".") ? brand.version : `${brand.version}.0.0.0`
    })),
    mobile,
    platform: mappedPlatform,
    platformVersion: "",
    architecture: mobile ? "arm" : "x86",
    bitness: "64",
    model: "",
    wow64: false
  };
}
