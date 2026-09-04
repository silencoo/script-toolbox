// author=silencoo; profile-patch=codex-5.6 sol extra high
// v2: [pro]-tagged nodes (optionally preceded by a country/location icon) are
// kept out of country auto groups and exposed directly through the AI policy
// group.
// URL-test args: autotestinterval=1800, countrytestinterval=600,
// fallbacktestinterval=300, urltesttolerance=100, urltestlazy=true.
// urltestinterval overrides all three intervals; 0 disables periodic tests.
// Controller args: controllerhost=127.0.0.1, controllerport=9090,
// controllersecret=. Non-loopback controller hosts require a secret.
// DNS args: dnslisten=127.0.0.1:1053.
// Load-balance args: loadbalancestrategy=consistent-hashing.
const PROFILE_FAKE_TOTAL_BYTES = 10 * 1024 * 1024;
const PROFILE_FAKE_EXPIRE_TIMESTAMP = 915148800;
const URL_TEST_URL = "https://www.gstatic.com/generate_204";
const ACCOUNT_INFO_TEST_URL = "http://wifi.vivo.com.cn/generate_204";
const DEFAULT_CONTROLLER_PORT = 9090;
const FULL_CONFIG_CONTROLLER_PORT = 9999;
const DEFAULT_CONTROLLER_HOST = "127.0.0.1";
const DEFAULT_DNS_LISTEN = "127.0.0.1:1053";
const DEFAULT_AUTO_TEST_INTERVAL = 1800;
const DEFAULT_COUNTRY_TEST_INTERVAL = 600;
const DEFAULT_FALLBACK_TEST_INTERVAL = 300;
const MIN_URL_TEST_INTERVAL = 300;
const DEFAULT_URL_TEST_TOLERANCE = 100;
const Z_ICON_BASE =
  "https://raw.githubusercontent.com/silencoo/z-icon/main/icon/";
const DIRECT_DNS_SERVERS = [
  "https://dns.alidns.com/dns-query",
  "https://doh.pub/dns-query",
];
const PROXY_DNS_SERVERS = [
  "https://1.1.1.1/dns-query#Proxies",
  "https://8.8.8.8/dns-query#Proxies",
];
const DEFAULT_DNS_SERVERS = ["223.5.5.5", "119.29.29.29"];
const LOAD_BALANCE_STRATEGIES = new Set([
  "consistent-hashing",
  "round-robin",
  "sticky-sessions",
]);
const PROVIDER_DNS_RULES = [
  {
    domainSuffix: "placudoshai.fun",
    resolver: "https://jeeyio.com/api/dns-query",
  },
];

function zIcon(path) {
  return Z_ICON_BASE + path;
}

function setProfileSubscriptionInfo() {
  if (typeof $options !== "object" || !$options) return;
  if (!$options._res || typeof $options._res !== "object") $options._res = {};
  if (!$options._res.headers || typeof $options._res.headers !== "object") {
    $options._res.headers = {};
  }
  $options._res.headers["subscription-userinfo"] = [
    "upload=0",
    "download=8388608",
    "total=" + PROFILE_FAKE_TOTAL_BYTES,
    "expire=" + PROFILE_FAKE_EXPIRE_TIMESTAMP
  ].join("; ");
  $options._res.headers["profile-web-page-url"] = null;
  $options._res.headers["plan-name"] = null;
}

function parseBool(e) {
  return "boolean" == typeof e
    ? e
    : "string" == typeof e && ("true" === e.toLowerCase() || "1" === e);
}

function parseNumber(e, t = 0) {
  if (null == e) return t;
  const o = parseInt(e, 10);
  return isNaN(o) ? t : o;
}

function parseString(value, fallback = "") {
  if (null == value) return fallback;
  const parsed = String(value).trim();
  return parsed || fallback;
}

function parsePort(value, fallback) {
  const port = parseNumber(value, fallback);
  return port >= 1 && port <= 65535 ? port : fallback;
}

function isLoopbackHost(host) {
  return ["127.0.0.1", "localhost", "::1", "[::1]"].includes(
    String(host).toLowerCase(),
  );
}

function parseControllerHost(value, secret) {
  const requestedHost = parseString(value, DEFAULT_CONTROLLER_HOST);
  return isLoopbackHost(requestedHost) || secret
    ? requestedHost
    : DEFAULT_CONTROLLER_HOST;
}

function formatHostPort(host, port) {
  const normalizedHost = String(host);
  const formattedHost =
    normalizedHost.includes(":") && !normalizedHost.startsWith("[")
      ? `[${normalizedHost}]`
      : normalizedHost;
  return `${formattedHost}:${port}`;
}

function parseLoadBalanceStrategy(value) {
  const strategy = parseString(value, "consistent-hashing").toLowerCase();
  return LOAD_BALANCE_STRATEGIES.has(strategy)
    ? strategy
    : "consistent-hashing";
}

function parseUrlTestInterval(value, fallback) {
  const interval = parseNumber(value, fallback);
  return interval === 0 ? 0 : Math.max(MIN_URL_TEST_INTERVAL, interval);
}

function buildFeatureFlags(e) {
  const t = Object.entries({
    loadbalance: "loadBalance",
    ipv6: "ipv6Enabled",
    full: "fullConfig",
    keepalive: "keepAliveEnabled",
    fakeip: "fakeIPEnabled",
    quic: "quicEnabled",
  }).reduce((t, [o, r]) => ((t[r] = parseBool(e[o]) || !1), t), {});
  const sharedUrlTestInterval =
    null == e.urltestinterval ? null : e.urltestinterval;
  t.countryThreshold = parseNumber(e.threshold, 0);
  t.autoTestInterval = parseUrlTestInterval(
    sharedUrlTestInterval ?? e.autotestinterval,
    DEFAULT_AUTO_TEST_INTERVAL,
  );
  t.countryTestInterval = parseUrlTestInterval(
    sharedUrlTestInterval ?? e.countrytestinterval,
    DEFAULT_COUNTRY_TEST_INTERVAL,
  );
  t.fallbackTestInterval = parseUrlTestInterval(
    sharedUrlTestInterval ?? e.fallbacktestinterval,
    DEFAULT_FALLBACK_TEST_INTERVAL,
  );
  t.urlTestTolerance = Math.max(
    0,
    parseNumber(e.urltesttolerance, DEFAULT_URL_TEST_TOLERANCE),
  );
  t.urlTestLazy = "urltestlazy" in e ? parseBool(e.urltestlazy) : true;
  t.controllerSecret = parseString(e.controllersecret);
  t.controllerHost = parseControllerHost(
    e.controllerhost,
    t.controllerSecret,
  );
  t.controllerPort = parsePort(
    e.controllerport,
    t.fullConfig ? FULL_CONFIG_CONTROLLER_PORT : DEFAULT_CONTROLLER_PORT,
  );
  t.dnsListen = parseString(e.dnslisten, DEFAULT_DNS_LISTEN);
  t.loadBalanceStrategy = parseLoadBalanceStrategy(e.loadbalancestrategy);
  return t;
}

const rawArgs = "undefined" != typeof $arguments ? $arguments : {},
  {
    loadBalance: loadBalance,
    ipv6Enabled: ipv6Enabled,
    fullConfig: fullConfig,
    keepAliveEnabled: keepAliveEnabled,
    fakeIPEnabled: fakeIPEnabled,
    quicEnabled: quicEnabled,
    countryThreshold: countryThreshold,
    autoTestInterval: autoTestInterval,
    countryTestInterval: countryTestInterval,
    fallbackTestInterval: fallbackTestInterval,
    urlTestTolerance: urlTestTolerance,
    urlTestLazy: urlTestLazy,
    controllerSecret: controllerSecret,
    controllerHost: controllerHost,
    controllerPort: controllerPort,
    dnsListen: dnsListen,
    loadBalanceStrategy: loadBalanceStrategy,
  } = buildFeatureFlags(rawArgs);
function getCountryGroupNames(e, t) {
  return e.filter((e) => e.count >= t).map((e) => e.country);
}

const PROXY_GROUPS = {
  ACCOUNT: "Account Info",
  MANUAL: "Proxies",
  AUTO: "Auto",
  FALLBACK: "Fallback",
  DIRECT: "Direct",
  CDN: "CDN",
};

const TRAFFIC_INFO_PATTERNS = [
  /(建议|重置|官方网站|官网|套餐|流量|剩余|到期|防丢|导航|更新)/i,
  /\b(?:expire|expiry|traffic|usage)\b/i,
  /\b(?:used|total|remaining|reset)\b(?=\s*[:：=]?\s*(?:\d|never|unlimited))/i,
  /(?:^|[\s:：=])\d+(?:\.\d+)?\s*(?:KB|MB|GB|TB)\b/i,
];
// 白名单：包含以下字符的依然视为普通节点
const WHITELIST_KEYWORDS = /(赞助|Node|节点)/i;

function isTrafficInfoProxy(proxy) {
  const name = String(proxy?.name || "");
  return (
    TRAFFIC_INFO_PATTERNS.some((pattern) => pattern.test(name)) &&
    !WHITELIST_KEYWORDS.test(name)
  );
}

function buildTrafficInfoProxy(proxy) {
  return {
    name: proxy.name,
    type: "direct",
    udp: true,
  };
}

const LEADING_LOCATION_ICON_PATTERN =
  /^(?:(?:(?:[\uD83C][\uDDE6-\uDDFF]){2}|🌐)\s*)*/;

function uniqueList(items) {
  return [...new Set(items.filter(Boolean))];
}

function normalizeServerHostname(server) {
  return String(server || "")
    .trim()
    .toLowerCase()
    .replace(/\.$/, "");
}

function serverMatchesDomainSuffix(server, domainSuffix) {
  const hostname = normalizeServerHostname(server);
  const suffix = normalizeServerHostname(domainSuffix);
  return hostname === suffix || hostname.endsWith(`.${suffix}`);
}

function buildProviderDnsPolicy(proxies) {
  return Object.fromEntries(
    PROVIDER_DNS_RULES.filter(({ domainSuffix }) =>
      proxies.some((proxy) =>
        serverMatchesDomainSuffix(proxy?.server, domainSuffix),
      ),
    ).map(({ domainSuffix, resolver }) => [`+.${domainSuffix}`, resolver]),
  );
}

function isProProxyName(name) {
  const nameWithoutLocationIcon = String(name).replace(
    LEADING_LOCATION_ICON_PATTERN,
    "",
  );
  return /^\[pro\]/i.test(nameWithoutLocationIcon);
}

function isResidentialProxyName(name) {
  return isProProxyName(name);
}

function isStandardProxyName(name) {
  return !isProProxyName(name);
}

function buildBaseLists({
  countryGroupNames: o,
  hasAutoGroup: hasAutoGroup,
  standardProxyNames: standardProxyNames,
}) {
  const autoGroups = hasAutoGroup ? [PROXY_GROUPS.AUTO] : [];
  const defaultProxies = uniqueList([
    ...autoGroups,
    ...o,
    ...standardProxyNames,
    PROXY_GROUPS.DIRECT,
  ]);

  return {
    defaultProxies: defaultProxies,
    defaultProxiesDirect: uniqueList([PROXY_GROUPS.DIRECT, ...defaultProxies]),
    defaultServiceProxies: uniqueList([
      PROXY_GROUPS.MANUAL,
      ...autoGroups,
      ...o,
      PROXY_GROUPS.FALLBACK,
      PROXY_GROUPS.DIRECT,
    ]),
    defaultFallback: uniqueList([
      ...autoGroups,
      ...o,
      PROXY_GROUPS.MANUAL,
      PROXY_GROUPS.DIRECT,
    ]),
  };
}

const ruleProviders = {
  ADBlock: {
    type: "http",
    behavior: "domain",
    format: "mrs",
    interval: 86400,
    url: "https://adrules.top/adrules-mihomo.mrs",
    path: "./ruleset/ADBlock.mrs",
  },
  SogouInput: {
    type: "http",
    behavior: "classical",
    format: "text",
    interval: 86400,
    url: "https://ruleset.skk.moe/Clash/non_ip/sogouinput.txt",
    path: "./ruleset/SogouInput.txt",
  },
  StaticResources: {
    type: "http",
    behavior: "domain",
    format: "text",
    interval: 86400,
    url: "https://ruleset.skk.moe/Clash/domainset/cdn.txt",
    path: "./ruleset/StaticResources.txt",
  },
  CDNResources: {
    type: "http",
    behavior: "classical",
    format: "text",
    interval: 86400,
    url: "https://ruleset.skk.moe/Clash/non_ip/cdn.txt",
    path: "./ruleset/CDNResources.txt",
  },
  ByteDance: {
    type: "http",
    behavior: "classical",
    format: "text",
    interval: 86400,
    url: "https://raw.githubusercontent.com/silencoo/script-toolbox/main/proxy-rules/sources/bytedance.rules",
    path: "./ruleset/ByteDance.list",
  },
  TikTok: {
    type: "http",
    behavior: "classical",
    format: "text",
    interval: 86400,
    url: "https://raw.githubusercontent.com/blackmatrix7/ios_rule_script/master/rule/Clash/TikTok/TikTok.list",
    path: "./ruleset/TikTok.list",
  },
  EHentai: {
    type: "http",
    behavior: "classical",
    format: "text",
    interval: 86400,
    url: "https://gcore.jsdelivr.net/gh/powerfullz/override-rules@master/ruleset/EHentai.list",
    path: "./ruleset/EHentai.list",
  },
  SteamFix: {
    type: "http",
    behavior: "classical",
    format: "text",
    interval: 86400,
    url: "https://gcore.jsdelivr.net/gh/powerfullz/override-rules@master/ruleset/SteamFix.list",
    path: "./ruleset/SteamFix.list",
  },
  GoogleFCM: {
    type: "http",
    behavior: "classical",
    format: "text",
    interval: 86400,
    url: "https://gcore.jsdelivr.net/gh/powerfullz/override-rules@master/ruleset/FirebaseCloudMessaging.list",
    path: "./ruleset/FirebaseCloudMessaging.list",
  },
  AdditionalFilter: {
    type: "http",
    behavior: "classical",
    format: "text",
    interval: 86400,
    url: "https://gcore.jsdelivr.net/gh/powerfullz/override-rules@master/ruleset/AdditionalFilter.list",
    path: "./ruleset/AdditionalFilter.list",
  },
  AdditionalCDNResources: {
    type: "http",
    behavior: "classical",
    format: "text",
    interval: 86400,
    url: "https://gcore.jsdelivr.net/gh/powerfullz/override-rules@master/ruleset/AdditionalCDNResources.list",
    path: "./ruleset/AdditionalCDNResources.list",
  },
  Crypto: {
    type: "http",
    behavior: "classical",
    format: "text",
    interval: 86400,
    url: "https://gcore.jsdelivr.net/gh/powerfullz/override-rules@master/ruleset/Crypto.list",
    path: "./ruleset/Crypto.list",
  },
  PrivateTracker: {
    type: "http",
    behavior: "classical",
    format: "text",
    interval: 86400,
    url: "https://raw.githubusercontent.com/blackmatrix7/ios_rule_script/master/rule/Clash/PrivateTracker/PrivateTracker.list",
    path: "./ruleset/PrivateTracker.list",
  },
  Speedtest: {
    type: "http",
    behavior: "classical",
    format: "text",
    interval: 86400,
    url: "https://raw.githubusercontent.com/blackmatrix7/ios_rule_script/master/rule/Clash/Speedtest/Speedtest.list",
    path: "./ruleset/Speedtest.list",
  },
  AIModels: {
    type: "http",
    behavior: "classical",
    format: "text",
    interval: 86400,
    url: "https://raw.githubusercontent.com/silencoo/script-toolbox/main/proxy-rules/sources/ai-models.rules",
    path: "./ruleset/AIModels.list",
  },
  GitHub: {
    type: "http",
    behavior: "classical",
    format: "text",
    interval: 86400,
    url: "https://raw.githubusercontent.com/silencoo/script-toolbox/main/proxy-rules/sources/github.rules",
    path: "./ruleset/GitHub.list",
  },
  Docker: {
    type: "http",
    behavior: "classical",
    format: "text",
    interval: 86400,
    url: "https://raw.githubusercontent.com/silencoo/script-toolbox/main/proxy-rules/sources/docker.rules",
    path: "./ruleset/Docker.list",
  },
};

// Exact Gemini App hosts published by Google Workspace Help. These rules must
// precede ad, YouTube, and broad Google rules because several hosts are shared
// with those services. Keep broad Google suffixes out of this policy so Drive
// and unrelated Google downloads can continue using the normal Google route.
const GEMINI_OFFICIAL_HOSTS = [
  "lh5.googleusercontent.com",
  "www.googleapis.com",
  "ssl.gstatic.com",
  "fonts.googleapis.com",
  "play.google.com",
  "ogs.google.com",
  "www.google.com",
  "apis.google.com",
  "jnn-pa.googleapis.com",
  "waa-pa.clients6.google.com",
  "i.ytimg.com",
  "yt3.ggpht.com",
  "lh3.googleusercontent.com",
  "maps.gstatic.com",
  "lh3.google.com",
  "ogads-pa.clients6.google.com",
  "csp.withgoogle.com",
  "www.googletagmanager.com",
  "www.youtube.com",
  "fonts.gstatic.com",
  "maps.googleapis.com",
  "static.doubleclick.net",
  "www.gstatic.com",
  "gemini.google.com",
  "td.doubleclick.net",
  "googleads.g.doubleclick.net",
  "www.google-analytics.com",
  "optimizationguide-pa.googleapis.com",
  "encrypted-tbn0.gstatic.com",
  "encrypted-tbn1.gstatic.com",
  "encrypted-tbn2.gstatic.com",
  "encrypted-tbn3.gstatic.com",
  "streetviewpixels-pa.googleapis.com",
  "content-autofill.googleapis.com",
];

// Exact Gemini backends observed in live web sessions but not included in the
// published Workspace firewall list. Keep these exact to avoid routing every
// googleapis.com request, including unrelated Drive traffic, through Gemini.
const GEMINI_OBSERVED_HOSTS = [
  "robinfrontend-pa.googleapis.com",
  "signaler-pa.googleapis.com",
];

const GEMINI_RULES = [
  ...GEMINI_OFFICIAL_HOSTS.map((host) => `DOMAIN,${host},Gemini`),
  ...GEMINI_OBSERVED_HOSTS.map((host) => `DOMAIN,${host},Gemini`),
  "DOMAIN,bard.google.com,Gemini",
  "DOMAIN,ai.google.dev,Gemini",
  "DOMAIN,aistudio.google.com,Gemini",
  "DOMAIN,makersuite.google.com,Gemini",
  "DOMAIN,alkalimakersuite-pa.clients6.google.com,Gemini",
  "DOMAIN,generativelanguage.googleapis.com,Gemini",
  "DOMAIN,proactivebackend-pa.googleapis.com,Gemini",
  "DOMAIN-SUFFIX,generativeai.google,Gemini",
  "DOMAIN,notebooklm.google.com,Gemini",
  "DOMAIN-SUFFIX,notebooklm.google,Gemini",
  "DOMAIN,accounts.google.com,Gemini",
  "DOMAIN,t3.gstatic.com,Gemini",
];

// 静态规则列表 (来自 clash-2.yaml)
const staticRules = [
  // Gemini must remain first to keep one exit IP across its shared Google
  // session endpoints.
  ...GEMINI_RULES,

  // 广告拦截
  "RULE-SET,ADBlock,AdBlock",
  "RULE-SET,AdditionalFilter,AdBlock",
  `RULE-SET,SogouInput,${PROXY_GROUPS.DIRECT}`,

  // Speed tests must stay above CDN, Netflix, and generic direct fallbacks.
  "RULE-SET,Speedtest,Speedtest",

  // Model hubs and their large downloads must stay above generic CDN rules.
  "RULE-SET,AIModels,AI Models",

  // Developer downloads and registries stay independently selectable.
  "RULE-SET,GitHub,GitHub",
  "RULE-SET,Docker,Docker",

  // CDN 资源
  "RULE-SET,StaticResources,CDN",
  "RULE-SET,CDNResources,CDN",
  "RULE-SET,AdditionalCDNResources,CDN",

  // Telegram 静态规则
  "DOMAIN,api.imem.app,Telegram",
  "DOMAIN,api.swiftgram.app,Telegram",
  "DOMAIN-SUFFIX,cdn-telegram.org,Telegram",
  "DOMAIN-SUFFIX,t.me,Telegram",
  "DOMAIN-SUFFIX,telegram.org,Telegram",
  "DOMAIN-SUFFIX,telegram.me,Telegram",
  "DOMAIN-SUFFIX,telegram.dog,Telegram",
  "DOMAIN-SUFFIX,telegramdownload.com,Telegram",
  "DOMAIN-SUFFIX,tg.dev,Telegram",
  "DOMAIN-SUFFIX,tx.me,Telegram",
  "DOMAIN-KEYWORD,nicegram,Telegram",
  "IP-CIDR,149.154.160.0/20,Telegram,no-resolve",
  "IP-CIDR,91.108.0.0/16,Telegram,no-resolve",
  "IP-CIDR,5.28.192.0/18,Telegram,no-resolve",

  // Remaining YouTube traffic stays before the broad Google rules below.
  "DOMAIN-SUFFIX,ggpht.cn,YouTube",
  "DOMAIN-SUFFIX,ggpht.com,YouTube",
  "DOMAIN-SUFFIX,googlevideo.com,YouTube",
  "DOMAIN-SUFFIX,gvt1.com,YouTube",
  "DOMAIN-SUFFIX,gvt2.com,YouTube",
  "DOMAIN-SUFFIX,youtube.com,YouTube",
  "DOMAIN-SUFFIX,youtube-nocookie.com,YouTube",
  "DOMAIN-SUFFIX,youtu.be,YouTube",
  "DOMAIN-SUFFIX,ytimg.com,YouTube",
  "DOMAIN-KEYWORD,youtube,YouTube",
  "IP-CIDR,172.110.32.0/21,YouTube,no-resolve",
  "IP-CIDR,216.73.80.0/20,YouTube,no-resolve",

  // Netflix 静态规则
  "DOMAIN-SUFFIX,netflix.com,Netflix",
  "DOMAIN-SUFFIX,netflix.net,Netflix",
  "DOMAIN-SUFFIX,nflxext.com,Netflix",
  "DOMAIN-SUFFIX,nflximg.com,Netflix",
  "DOMAIN-SUFFIX,nflximg.net,Netflix",
  "DOMAIN-SUFFIX,nflxso.net,Netflix",
  "DOMAIN-SUFFIX,nflxvideo.net,Netflix",
  "DOMAIN-SUFFIX,fast.com,Netflix",
  "DOMAIN-KEYWORD,netflixdnstest,Netflix",
  "DOMAIN-KEYWORD,apiproxy-device-prod-nlb-,Netflix",
  "IP-CIDR,23.246.0.0/18,Netflix,no-resolve",
  "IP-CIDR,37.77.184.0/21,Netflix,no-resolve",
  "IP-CIDR,45.57.0.0/17,Netflix,no-resolve",
  "IP-CIDR,64.120.128.0/17,Netflix,no-resolve",
  "IP-CIDR,66.197.128.0/17,Netflix,no-resolve",
  "IP-CIDR,108.175.32.0/20,Netflix,no-resolve",
  "IP-CIDR,198.38.96.0/19,Netflix,no-resolve",
  "IP-CIDR,198.45.48.0/20,Netflix,no-resolve",
  "IP-CIDR,203.75.84.0/24,Netflix,no-resolve",
  "IP-CIDR,203.116.0.0/16,Netflix,no-resolve",
  "IP-CIDR,203.198.0.0/20,Netflix,no-resolve",
  "IP-CIDR,207.45.72.0/22,Netflix,no-resolve",
  "IP-CIDR,208.75.76.0/22,Netflix,no-resolve",

  // Spotify 静态规则
  "DOMAIN-SUFFIX,spotify.com,Spotify",
  "DOMAIN-SUFFIX,scdn.co,Spotify",
  "DOMAIN-SUFFIX,spoti.fi,Spotify",
  "DOMAIN-SUFFIX,spotifycdn.com,Spotify",
  "DOMAIN-SUFFIX,spotifycdn.net,Spotify",
  "DOMAIN-SUFFIX,pscdn.co,Spotify",
  "DOMAIN-KEYWORD,spotify,Spotify",

  // Bilibili 静态规则
  "DOMAIN-SUFFIX,bilibili.com,Bilibili",
  "DOMAIN-SUFFIX,bilibili.tv,Bilibili",
  "DOMAIN-SUFFIX,bili2233.cn,Bilibili",
  "DOMAIN-SUFFIX,biliapi.com,Bilibili",
  "DOMAIN-SUFFIX,biliapi.net,Bilibili",
  "DOMAIN-SUFFIX,bilicdn1.com,Bilibili",
  "DOMAIN-SUFFIX,bilivideo.cn,Bilibili",
  "DOMAIN-SUFFIX,bilivideo.com,Bilibili",
  "DOMAIN-SUFFIX,hdslb.com,Bilibili",
  "DOMAIN-SUFFIX,smtcdns.net,Bilibili",
  "DOMAIN,b23.tv,Bilibili",

  // Perplexity, Microsoft Copilot, and xAI Grok stay in the general AI group.
  "DOMAIN,pplx-res.cloudinary.com,AI",
  "DOMAIN-SUFFIX,perplexity.ai,AI",
  "DOMAIN-SUFFIX,perplexity.com,AI",
  "DOMAIN-SUFFIX,pplx.ai,AI",
  "DOMAIN,api.msn.com,AI",
  "DOMAIN,assets.msn.com,AI",
  "DOMAIN,copilot.microsoft.com,AI",
  "DOMAIN,gateway.bingviz.microsoft.net,AI",
  "DOMAIN,gateway.bingviz.microsoftapp.net,AI",
  "DOMAIN,in.appcenter.ms,AI",
  "DOMAIN,location.microsoft.com,AI",
  "DOMAIN,odc.officeapps.live.com,AI",
  "DOMAIN,r.bing.com,AI",
  "DOMAIN,self.events.data.microsoft.com,AI",
  "DOMAIN,services.bingapis.com,AI",
  "DOMAIN,sydney.bing.com,AI",
  "DOMAIN,www.bing.com,AI",
  "DOMAIN-SUFFIX,api.microsoftapp.net,AI",
  "DOMAIN-SUFFIX,bing-shopping.microsoft-falcon.io,AI",
  "DOMAIN-SUFFIX,edgeservices.bing.com,AI",
  "DOMAIN-SUFFIX,grok.com,AI",
  "DOMAIN-SUFFIX,x.ai,AI",

  // General Google rules (excluding YouTube overlaps).
  "DOMAIN,www.google.com,Google",
  "DOMAIN,www.google.com.hk,Google",
  "DOMAIN,www.google.co.jp,Google",
  "DOMAIN,www.google.com.sg,Google",
  "DOMAIN,www.google.co.uk,Google",
  "DOMAIN,www.google.com.tw,Google",
  "DOMAIN,www.google.com.au,Google",
  "DOMAIN,www.google.ca,Google",
  "DOMAIN,google.com,Google",
  "DOMAIN-SUFFIX,google.com,Google",
  "DOMAIN-SUFFIX,google.com.hk,Google",
  "DOMAIN-SUFFIX,google.com.tw,Google",
  "DOMAIN-SUFFIX,google.co.jp,Google",
  "DOMAIN-SUFFIX,google.co.uk,Google",
  "DOMAIN-SUFFIX,google.com.sg,Google",
  "DOMAIN-SUFFIX,google.com.au,Google",
  "DOMAIN-SUFFIX,google.com.br,Google",
  "DOMAIN-SUFFIX,google.ca,Google",
  "DOMAIN-SUFFIX,google.de,Google",
  "DOMAIN-SUFFIX,google.fr,Google",
  "DOMAIN-SUFFIX,google.es,Google",
  "DOMAIN-SUFFIX,google.it,Google",
  "DOMAIN-SUFFIX,google.ru,Google",
  "DOMAIN-SUFFIX,google.com.tr,Google",
  "DOMAIN-SUFFIX,google.com.mx,Google",
  "DOMAIN-SUFFIX,google.com.vn,Google",
  "DOMAIN-SUFFIX,google.co.th,Google",
  "DOMAIN-SUFFIX,google.co.id,Google",
  "DOMAIN-SUFFIX,google.co.in,Google",
  "DOMAIN-SUFFIX,google.com.ph,Google",
  "DOMAIN-SUFFIX,google.com.my,Google",
  "DOMAIN-SUFFIX,googleadservices.com,Google",
  "DOMAIN-SUFFIX,googleapis.com,Google",
  "DOMAIN-SUFFIX,googlesyndication.com,Google",
  "DOMAIN-SUFFIX,googleusercontent.com,Google",
  "DOMAIN-SUFFIX,gstatic.com,Google",
  "DOMAIN-SUFFIX,google.co.kr,Google",
  "DOMAIN-SUFFIX,blogspot.com,Google",
  "DOMAIN-SUFFIX,googlesource.com,Google",
  "DOMAIN-SUFFIX,google.dev,Google",
  "DOMAIN-SUFFIX,chrome.com,Google",
  "DOMAIN-SUFFIX,chromium.org,Google",
  "DOMAIN-SUFFIX,android.com,Google",
  "DOMAIN-SUFFIX,firebase.google.com,Google",
  "DOMAIN-SUFFIX,googletagmanager.com,Google",
  "DOMAIN-SUFFIX,googletagservices.com,Google",
  "DOMAIN-KEYWORD,google,Google",
  "DOMAIN-KEYWORD,googlesyndication,Google",

  // Steam 静态规则
  "DOMAIN-SUFFIX,steamcommunity.com,Steam",
  "DOMAIN-SUFFIX,steampowered.com,Steam",
  "DOMAIN-SUFFIX,steamstatic.com,Steam",
  "DOMAIN-SUFFIX,steam.tv,Steam",
  "DOMAIN-SUFFIX,s.team,Steam",
  "DOMAIN-SUFFIX,steamgames.com,Steam",
  "DOMAIN-SUFFIX,valvesoftware.com,Steam",
  "DOMAIN-SUFFIX,steamdeck.com,Steam",
  "DOMAIN-KEYWORD,steamstore,Steam",
  "DOMAIN-KEYWORD,steambroadcast,Steam",

  // 加密货币
  "RULE-SET,Crypto,Crypto",

  // snssdk.com is shared with mainland Douyin, so domestic ByteDance rules
  // must win before the upstream TikTok provider.
  `RULE-SET,ByteDance,${PROXY_GROUPS.DIRECT}`,
  "RULE-SET,TikTok,TikTok",

  // 其他
  `RULE-SET,SteamFix,${PROXY_GROUPS.DIRECT}`,
  `RULE-SET,GoogleFCM,${PROXY_GROUPS.DIRECT}`,
  `RULE-SET,PrivateTracker,${PROXY_GROUPS.DIRECT}`,
  `DOMAIN,services.googleapis.cn,${PROXY_GROUPS.MANUAL}`,
  "GEOSITE,GOOGLE-PLAY@CN,Direct",
  "GEOSITE,CATEGORY-AI-!CN,AI",
  "GEOSITE,PIKPAK,PikPak",
  `GEOSITE,GFW,${PROXY_GROUPS.MANUAL}`,
  `GEOSITE,CN,${PROXY_GROUPS.DIRECT}`,
  `GEOSITE,PRIVATE,${PROXY_GROUPS.DIRECT}`,
  "GEOIP,TELEGRAM,Telegram,no-resolve",
  `GEOIP,CN,${PROXY_GROUPS.DIRECT}`,
  `GEOIP,PRIVATE,${PROXY_GROUPS.DIRECT}`,
  "DST-PORT,22,SSH(port 22)",
  `MATCH,${PROXY_GROUPS.MANUAL}`,
];

const baseRules = staticRules;

function buildAppRules({ countries }) {
  const hasTW = countries.includes("Taiwan");
  const hasUS = countries.includes("United States");
  const manual = PROXY_GROUPS.MANUAL;
  const bahamutTarget = hasTW ? "Taiwan" : manual;
  const truthSocialTarget = hasUS ? "United States" : manual;

  return [
    `RULE-SET,EHentai,${manual}`,
    `DOMAIN-SUFFIX,truthsocial.com,${truthSocialTarget}`,
    `DOMAIN-SUFFIX,bahamut.com.tw,${bahamutTarget}`,
    `DOMAIN-SUFFIX,bahamut.akamaized.net,${bahamutTarget}`,
    `DOMAIN-SUFFIX,gamer.com.tw,${bahamutTarget}`,
    `DOMAIN-SUFFIX,hinet.net,${bahamutTarget}`,
  ];
}

function buildRules({ quicEnabled: e, countries: o }) {
  const t = [...baseRules];
  const r = t.findIndex((e) => e.startsWith("RULE-SET,TikTok"));
  t.splice(r >= 0 ? r : t.length, 0, ...buildAppRules({ countries: o }));
  return (e || t.unshift("AND,((DST-PORT,443),(NETWORK,UDP)),REJECT"), t);
}

// 精简版国家列表。香港节点的服务解锁能力较弱，因此在通用国家组中垫底。
const COUNTRY_PRIORITY = [
  "Japan",
  "United States",
  "Taiwan",
  "Singapore",
  "Hong Kong",
];

const countriesMeta = {
  Japan: {
    pattern: "(?i)(日本|东京|大阪|埼玉|🇯🇵|(?:^|[^a-z])(?:JP|Japan)(?=$|[^a-z]))",
    icon: zIcon("flag/108/Japan.png"),
  },
  "United States": {
    pattern:
      "(?i)(美国|🇺🇸|圣何塞|洛杉矶|阿什本|(?:^|[^a-z])(?:US|USA|United[\\s_-]*States)(?=$|[^a-z]))",
    icon: zIcon("flag/108/UnitedStatesofAmerica.png"),
  },
  Taiwan: {
    pattern:
      "(?i)(台湾|台灣|臺灣|台北|新北|台中|臺中|高雄|彰化|🇹🇼|(?:^|[^a-z])(?:TW|Taiwan)(?=$|[^a-z]))",
    icon: zIcon("flag/108/Taiwan.png"),
  },
  Singapore: {
    pattern:
      "(?i)(新加坡|狮城|🇸🇬|(?:^|[^a-z])(?:SG|Singapore)(?=$|[^a-z]))",
    icon: zIcon("flag/108/Singapore.png"),
  },
  "Hong Kong": {
    pattern:
      "(?i)(香港|🇭🇰|(?:^|[^a-z])(?:HK|Hong[\\s_-]*Kong)(?=$|[^a-z]))",
    icon: zIcon("flag/108/HongKong.png"),
  },
};

const GENERATED_PROXY_GROUP_NAMES = uniqueList([
  ...Object.values(PROXY_GROUPS),
  ...COUNTRY_PRIORITY,
  "AI",
  "Gemini",
  "Telegram",
  "Google",
  "YouTube",
  "Speedtest",
  "AI Models",
  "GitHub",
  "Docker",
  "Bilibili",
  "Netflix",
  "Spotify",
  "Steam",
  "TikTok",
  "PikPak",
  "Crypto",
  "SSH(port 22)",
  "AdBlock",
  "GLOBAL",
]);
const RESERVED_OUTBOUND_NAMES = new Set([
  ...GENERATED_PROXY_GROUP_NAMES,
  "DIRECT",
  "REJECT",
  "REJECT-DROP",
  "PASS",
  "PASS-RULE",
  "COMPATIBLE",
]);

const COUNTRY_REGEXES = Object.fromEntries(
  COUNTRY_PRIORITY.map((country) => [
    country,
    new RegExp(countriesMeta[country].pattern.replace(/^\(\?i\)/, ""), "i"),
  ]),
);

function getCountryRegex(country) {
  return COUNTRY_REGEXES[country] || null;
}

function matchesCountry(name, country) {
  const regex = getCountryRegex(country);
  return regex ? regex.test(name) : false;
}

function classifyCountry(name) {
  return (
    COUNTRY_PRIORITY.find((country) => matchesCountry(name, country)) || null
  );
}

function classifyCountryProxies(proxyNames) {
  const proxiesByCountry = Object.fromEntries(
    COUNTRY_PRIORITY.map((country) => [country, []]),
  );

  for (const name of proxyNames) {
    const country = classifyCountry(name);
    if (country) proxiesByCountry[country].push(name);
  }

  return proxiesByCountry;
}

function parseCountries(proxiesByCountry) {
  return COUNTRY_PRIORITY.map((country) => ({
    country: country,
    count: proxiesByCountry[country].length,
  })).filter(({ count }) => count > 0);
}

const COUNTRY_FLAG_PATTERN = /(?:[\uD83C][\uDDE6-\uDDFF]){2}/g;

function normalizeTaiwanProxyFlag(proxy) {
  if (!proxy || typeof proxy !== "object") return proxy;

  const name = String(proxy.name == null ? "" : proxy.name).trim();
  if (!name || !matchesCountry(name, "Taiwan")) return proxy;

  const normalizedName = name
    .replace(COUNTRY_FLAG_PATTERN, "")
    .split("🌐")
    .join("")
    .replace(/\s{2,}/g, " ")
    .trim();
  const nameWithTaiwanFlag = normalizedName
    ? `🇹🇼 ${normalizedName}`
    : "🇹🇼";

  return nameWithTaiwanFlag === proxy.name
    ? proxy
    : Object.assign({}, proxy, { name: nameWithTaiwanFlag });
}

function buildHealthCheckedGroup({
  name: name,
  icon: icon,
  type: type,
  proxies: proxies,
  interval: interval,
}) {
  return {
    name: name,
    icon: icon,
    type: type,
    url: URL_TEST_URL,
    proxies: uniqueList(proxies),
    interval: interval,
    tolerance: urlTestTolerance,
    lazy: urlTestLazy,
    timeout: 5000,
    "max-failed-times": 3,
    "expected-status": 204,
  };
}

function buildCountryProxyGroups({
  countries: countries,
  loadBalance: loadBalance,
  loadBalanceStrategy: loadBalanceStrategy,
  proxiesByCountry: proxiesByCountry,
}) {
  const groups = [];
  const type = loadBalance ? "load-balance" : "url-test";

  for (const country of countries) {
    const meta = countriesMeta[country];
    if (!meta) continue;
    const countryProxies = proxiesByCountry[country] || [];
    if (countryProxies.length <= 0) continue;

    const group = buildHealthCheckedGroup({
      name: country,
      icon: meta.icon,
      type: type,
      proxies: countryProxies,
      interval: countryTestInterval,
    });
    if (loadBalance) group.strategy = loadBalanceStrategy;
    groups.push(group);
  }
  return groups;
}

function buildProxyGroups({
  countries: t,
  countryProxyGroups: o,
  defaultProxies: n,
  defaultProxiesDirect: s,
  defaultServiceProxies: serviceProxies,
  defaultFallback: i,
  trafficNodes: trafficNodes,
  standardProxyNames: standardProxyNames = [],
  nodePools: nodePools = {},
}) {
  const hasTW = t.includes("Taiwan"),
    hasHK = t.includes("Hong Kong");

  const pools = Object.assign({ ai: [], residential: [] }, nodePools);
  const autoRefs = standardProxyNames.length > 0 ? [PROXY_GROUPS.AUTO] : [];
  const geminiCountryRefs = ["Japan", "Taiwan", "Singapore"].filter(
    (country) => t.includes(country),
  );
  const geminiProxies = uniqueList([
    ...(t.includes("United States") ? ["United States"] : []),
    PROXY_GROUPS.MANUAL,
    ...autoRefs,
    ...geminiCountryRefs,
    PROXY_GROUPS.FALLBACK,
    PROXY_GROUPS.DIRECT,
  ]);

  const groups = [
    {
      name: PROXY_GROUPS.MANUAL,
      icon: zIcon("proxy-logo/mihomo.png"),
      type: "select",
      proxies: n,
    },
  ];

  if (trafficNodes.length > 0) {
    groups.push({
      name: PROXY_GROUPS.ACCOUNT,
      icon: zIcon("apps-cn/testflight.png"),
      type: "select",
      proxies: trafficNodes,
      url: ACCOUNT_INFO_TEST_URL,
      interval: 0,
      lazy: true,
      timeout: 1000,
      "expected-status": 204,
    });
  }

  if (standardProxyNames.length > 0) {
    groups.push(
      buildHealthCheckedGroup({
        name: PROXY_GROUPS.AUTO,
        icon: zIcon("selfhst/108/speedtest-tracker.png"),
        type: "url-test",
        proxies: standardProxyNames,
        interval: autoTestInterval,
      }),
    );
  }

  groups.push(
    buildHealthCheckedGroup({
      name: PROXY_GROUPS.FALLBACK,
      icon: zIcon("homarr/108/haproxy.png"),
      type: "fallback",
      proxies: i,
      interval: fallbackTestInterval,
    }),
  );

  const aiNodeCandidates = uniqueList([...pools.ai, ...pools.residential]);
  const aiDefaultProxies = uniqueList([
    ...aiNodeCandidates,
    PROXY_GROUPS.MANUAL,
    PROXY_GROUPS.FALLBACK,
    PROXY_GROUPS.DIRECT,
  ]);

  const commonGroups = [
    {
      name: "CDN",
      icon: zIcon("homarr/108/cloudflare.png"),
      type: "select",
      proxies: serviceProxies,
    },
    {
      name: "AI",
      icon: zIcon("apps-proxy/chatgpt-v2.png"),
      type: "select",
      proxies: aiDefaultProxies,
    },
    {
      name: "Gemini",
      icon: zIcon("homarr/108/google-gemini.png"),
      type: "select",
      proxies: geminiProxies,
    },
    {
      name: "Telegram",
      icon: zIcon("homarr/108/telegram.png"),
      type: "select",
      proxies: serviceProxies,
    },
    {
      name: "Google",
      icon: zIcon("homarr/108/google.png"),
      type: "select",
      proxies: serviceProxies,
    },
    {
      name: "YouTube",
      icon: zIcon("homarr/108/youtube.png"),
      type: "select",
      proxies: serviceProxies,
    },
    {
      name: "Speedtest",
      icon: zIcon("homarr/108/ookla-speedtest.png"),
      type: "select",
      proxies: serviceProxies,
    },
    {
      name: "AI Models",
      icon: zIcon("homarr/108/hugging-face.png"),
      type: "select",
      proxies: serviceProxies,
    },
    {
      name: "GitHub",
      icon: zIcon("selfhst/108/git.png"),
      type: "select",
      proxies: serviceProxies,
    },
    {
      name: "Docker",
      icon: zIcon("homarr/108/docker.png"),
      type: "select",
      proxies: serviceProxies,
    },
    {
      name: "Bilibili",
      icon: zIcon("homarr/108/bilibili.png"),
      type: "select",
      proxies:
        hasTW && hasHK
          ? [PROXY_GROUPS.DIRECT, "Taiwan", "Hong Kong", PROXY_GROUPS.FALLBACK]
          : s,
    },
    {
      name: "Netflix",
      icon: zIcon("homarr/108/netflix.png"),
      type: "select",
      proxies: serviceProxies,
    },
    {
      name: "Spotify",
      icon: zIcon("homarr/108/spotify.png"),
      type: "select",
      proxies: serviceProxies,
    },
    {
      name: "Steam",
      icon: zIcon("homarr/108/steam.png"),
      type: "select",
      proxies: serviceProxies,
    },
    {
      name: "TikTok",
      icon: zIcon("homarr/108/tiktok.png"),
      type: "select",
      proxies: serviceProxies,
    },
    {
      name: "PikPak",
      icon: zIcon("apps-cn/pikpak.png"),
      type: "select",
      proxies: serviceProxies,
    },
    {
      name: "Crypto",
      icon: zIcon("homarr/108/bitcoin.png"),
      type: "select",
      proxies: serviceProxies,
    },
    {
      name: "SSH(port 22)",
      icon: zIcon("selfhst/108/openssh.png"),
      type: "select",
      proxies: serviceProxies,
    },
    {
      name: PROXY_GROUPS.DIRECT,
      icon: zIcon("selfhst/108/networking-toolbox.png"),
      type: "select",
      proxies: ["DIRECT"],
    },
    {
      name: "AdBlock",
      icon: zIcon("homarr/108/adguard-home.png"),
      type: "select",
      proxies: ["REJECT", "REJECT-DROP", PROXY_GROUPS.DIRECT],
    },
  ];

  return [...groups, ...commonGroups, ...o].filter(Boolean);
}

/**
 * 保证节点名称唯一，并避开 Mihomo 内置出站及本脚本生成的策略组名称。
 */
function deduplicateProxies(proxies) {
  const originalNames = proxies.map((proxy) => {
    const name = String(proxy?.name == null ? "" : proxy.name).trim();
    return name || "Proxy";
  });
  const occupiedOriginalNames = new Set(originalNames);
  const usedNames = new Set(RESERVED_OUTBOUND_NAMES);
  const nextSuffix = new Map();
  const firstResolvedName = new Map();

  const renamed = proxies.map((proxy, index) => {
    if (!proxy || typeof proxy !== "object") return proxy;

    const originalName = originalNames[index];
    let resolvedName = originalName;
    if (usedNames.has(resolvedName)) {
      let suffix = nextSuffix.get(originalName) || 2;
      do {
        resolvedName = `${originalName}-${suffix}`;
        suffix += 1;
      } while (
        usedNames.has(resolvedName) || occupiedOriginalNames.has(resolvedName)
      );
      nextSuffix.set(originalName, suffix);
    }

    usedNames.add(resolvedName);
    if (!firstResolvedName.has(originalName)) {
      firstResolvedName.set(originalName, resolvedName);
    }
    return resolvedName === proxy.name
      ? proxy
      : Object.assign({}, proxy, { name: resolvedName });
  });

  return renamed.map((proxy) => {
    if (!proxy || typeof proxy !== "object" || !proxy["dialer-proxy"]) {
      return proxy;
    }
    const resolvedDialer = firstResolvedName.get(String(proxy["dialer-proxy"]));
    return resolvedDialer && resolvedDialer !== proxy["dialer-proxy"]
      ? Object.assign({}, proxy, { "dialer-proxy": resolvedDialer })
      : proxy;
  });
}

function main(e) {
  setProfileSubscriptionInfo();
  let proxies = (e.proxies || []).map(normalizeTaiwanProxyFlag);

  // 去重处理：重复节点 name 自动加序号
  proxies = deduplicateProxies(proxies);
  const providerDnsPolicy = buildProviderDnsPolicy(proxies);

  // 信息伪节点只负责展示名称。改为本地直连出站后，Clash 内测速无需
  // 连接机场提供的无效 server，也不会消耗订阅流量。
  const trafficInfoProxies = proxies.filter(isTrafficInfoProxy);
  const trafficNodes = trafficInfoProxies.map((p) => p.name);
  proxies = proxies.map((p) =>
    isTrafficInfoProxy(p) ? buildTrafficInfoProxy(p) : p,
  );

  // 识别真实代理
  const realProxyNames = proxies
    .filter((p) => !isTrafficInfoProxy(p))
    .map((p) => p.name);

  const nodePools = {
    // AI follows the Residential pool, matching the Quantumult X template.
    residential: realProxyNames.filter(isResidentialProxyName),
  };

  // 地区自动组只使用普通节点，避免 [pro] 专用节点被自动选中。
  const standardProxyNames = realProxyNames.filter(isStandardProxyName);
  const proxiesByCountry = classifyCountryProxies(standardProxyNames);

  const t = { proxies: proxies };
  const o = parseCountries(proxiesByCountry);
  const n = getCountryGroupNames(o, countryThreshold);

  const {
    defaultProxies: l,
    defaultProxiesDirect: i,
    defaultServiceProxies: serviceProxies,
    defaultFallback: c,
  } = buildBaseLists({
    countryGroupNames: n,
    hasAutoGroup: standardProxyNames.length > 0,
    standardProxyNames: standardProxyNames,
  });
  const p = buildCountryProxyGroups({
    countries: n,
    loadBalance: loadBalance,
    loadBalanceStrategy: loadBalanceStrategy,
    proxiesByCountry: proxiesByCountry,
  });
  const u = buildProxyGroups({
    countries: n,
    countryProxyGroups: p,
    defaultProxies: l,
    defaultProxiesDirect: i,
    defaultServiceProxies: serviceProxies,
    defaultFallback: c,
    trafficNodes: trafficNodes,
    standardProxyNames: standardProxyNames,
    nodePools: nodePools,
  });

  const groupNames = u.map((e) => e.name);
  u.push({
    name: "GLOBAL",
    icon: zIcon("selfhst/108/world-monitor.png"),
    "include-all": !0,
    type: "select",
    proxies: groupNames,
  });

  const g = buildRules({ quicEnabled: quicEnabled, countries: n });
  const enhancedMode =
    "fakeip" in rawArgs && !fakeIPEnabled ? "redir-host" : "fake-ip";

  // 基础配置始终包含
  Object.assign(t, {
    port: 7890,
    "socks-port": 7891,
    "redir-port": 7892,
    "mixed-port": 7893,
    "allow-lan": false,
    "unified-delay": true,
    mode: "rule",
    "log-level": "info",
    ipv6: ipv6Enabled,
    "external-controller": formatHostPort(controllerHost, controllerPort),
    profile: {
      "store-selected": true,
      "store-fake-ip": enhancedMode === "fake-ip",
    },
    sniffer: {
      enable: true,
      "force-dns-mapping": true,
      "parse-pure-ip": true,
      "override-destination": false,
      sniff: {
        HTTP: {
          ports: [80, "8080-8880"],
          "override-destination": true,
        },
        TLS: { ports: [443, 8443] },
        QUIC: { ports: [443, 8443] },
      },
      "skip-domain": ["Mijia Cloud", "+.push.apple.com"],
    },
    "tcp-concurrent": true,
  });

  if (controllerSecret) t.secret = controllerSecret;

  if ("keepalive" in rawArgs) {
    if (keepAliveEnabled) {
      Object.assign(t, {
        "disable-keep-alive": false,
        "keep-alive-idle": 600,
        "keep-alive-interval": 30,
      });
    } else {
      Object.assign(t, { "disable-keep-alive": true });
    }
  }

  // DNS 配置
  const nameserverPolicy = Object.assign(
    {
      "geosite:private": "system",
      "geosite:cn": DIRECT_DNS_SERVERS,
      "geosite:gfw": PROXY_DNS_SERVERS,
    },
    providerDnsPolicy,
  );
  const dnsConfig = {
    enable: true,
    ipv6: ipv6Enabled,
    listen: dnsListen,
    "enhanced-mode": enhancedMode,
    "fake-ip-range": "198.18.0.1/16",
    "fake-ip-range6": "fdfe:dcba:9876::1/64",
    "fake-ip-filter": [
      "+.lan",
      "+.srv.nintendo.net",
      "+.stun.playstation.net",
      "xbox.*.microsoft.com",
      "+.xboxlive.com",
      "+.teafone.com",
      "+.sktswe.net",
      "rtc.goodfone.co.kr",
      "+.chattti.com",
    ],
    "default-nameserver": DEFAULT_DNS_SERVERS,
    nameserver: PROXY_DNS_SERVERS,
    "nameserver-policy": nameserverPolicy,
    "proxy-server-nameserver": DIRECT_DNS_SERVERS,
    "direct-nameserver": DIRECT_DNS_SERVERS,
    "direct-nameserver-follow-policy": true,
  };

  if (Object.keys(providerDnsPolicy).length > 0) {
    // 仅在订阅确实包含对应节点域名时启用机场专用 DNS。
    // 其他节点仍使用默认解析器，避免将所有机场域名暴露给单一服务商。
    dnsConfig["proxy-server-nameserver-policy"] = providerDnsPolicy;
  }

  return (
    Object.assign(t, {
      "proxy-groups": u,
      "rule-providers": ruleProviders,
      rules: g,
      dns: dnsConfig,
    }),
    t
  );
}
