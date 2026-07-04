// v2: tag-aware profile. [pro]/AI/residential nodes are kept out of country
// auto groups and exposed directly through the AI policy group.
const NODE_SUFFIX = "";

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

function buildFeatureFlags(e) {
  const t = Object.entries({
    loadbalance: "loadBalance",
    ipv6: "ipv6Enabled",
    full: "fullConfig",
    keepalive: "keepAliveEnabled",
    fakeip: "fakeIPEnabled",
    quic: "quicEnabled",
  }).reduce((t, [o, r]) => ((t[r] = parseBool(e[o]) || !1), t), {});
  return ((t.countryThreshold = parseNumber(e.threshold, 0)), t);
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

// 流量信息关键词：增加 “防丢”、“官方网站”
const TRAFFIC_KEYWORDS =
  /(建议|重置|官方网站|官网|套餐|流量|剩余|到期|防丢|GB|导航|更新|Expire|Usage|Traffic|Standard|Used|Total)/i;
// 白名单：包含以下字符的依然视为普通节点
const WHITELIST_KEYWORDS = /(赞助|Node|节点)/i;

const AI_TAGS = ["ai", "openai", "chatgpt", "claude", "gemini", "copilot"];
const PREMIUM_TAGS = ["pro"];
const RESIDENTIAL_TAGS = ["res", "home", "isp", "residential", "家宽"];

const AI_NODE_KEYWORDS =
  /\b(AI|OpenAI|ChatGPT|Claude|Gemini|Copilot|Perplexity)\b|人工智能|智算/i;
const RESIDENTIAL_NODE_KEYWORDS =
  /(家宽|家庭宽带|住宅|原生|Residential|Resident|ISP|Home)/i;

function uniqueList(items) {
  return [...new Set(items.filter(Boolean))];
}

function getNodeTags(name) {
  return Array.from(String(name).matchAll(/\[([^\]]+)\]/g), (match) =>
    match[1].trim().toLowerCase(),
  ).filter(Boolean);
}

function hasNodeTag(name, tags) {
  const tagSet = new Set(getNodeTags(name));
  return tags.some((tag) => tagSet.has(tag.toLowerCase()));
}

function isProProxyName(name) {
  return hasNodeTag(name, ["pro"]);
}

function isAIProxyName(name) {
  return hasNodeTag(name, AI_TAGS) || AI_NODE_KEYWORDS.test(name);
}

function isPremiumProxyName(name) {
  return hasNodeTag(name, PREMIUM_TAGS);
}

function isResidentialProxyName(name) {
  return (
    hasNodeTag(name, RESIDENTIAL_TAGS) || RESIDENTIAL_NODE_KEYWORDS.test(name)
  );
}

function isStandardProxyName(name) {
  return (
    !isProProxyName(name) &&
    !isAIProxyName(name) &&
    !isPremiumProxyName(name) &&
    !isResidentialProxyName(name)
  );
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
  TikTok: {
    type: "http",
    behavior: "classical",
    format: "text",
    interval: 86400,
    url: "https://gcore.jsdelivr.net/gh/powerfullz/override-rules@master/ruleset/TikTok.list",
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
};

// 静态规则列表 (来自 clash-2.yaml)
const staticRules = [
  // 广告拦截
  "RULE-SET,ADBlock,AdBlock",
  "RULE-SET,AdditionalFilter,AdBlock",
  `RULE-SET,SogouInput,${PROXY_GROUPS.DIRECT}`,

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

  // YouTube 静态规则（置于 Google 之前，避免被 Google 规则抢先匹配）
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

  // Google 静态规则（不含 YouTube 重叠域名）
  "DOMAIN,www.google.com,Google",
  "DOMAIN,www.google.com.hk,Google",
  "DOMAIN,www.google.co.jp,Google",
  "DOMAIN,www.google.com.sg,Google",
  "DOMAIN,www.google.co.uk,Google",
  "DOMAIN,www.google.com.tw,Google",
  "DOMAIN,www.google.com.au,Google",
  "DOMAIN,www.google.ca,Google",
  "DOMAIN,apis.google.com,Google",
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

  // TikTok
  "RULE-SET,TikTok,TikTok",

  // 其他
  `RULE-SET,SteamFix,${PROXY_GROUPS.DIRECT}`,
  `RULE-SET,GoogleFCM,${PROXY_GROUPS.DIRECT}`,
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

// 精简版国家列表：只保留 HK, TW, US, SG, JP
const countriesMeta = {
  "Hong Kong": {
    pattern: "(?i)(香港|HK|Hong Kong|HongKong|hongkong|🇭🇰)",
    icon: "https://fastly.jsdelivr.net/gh/Koolson/Qure@master/IconSet/Color/Hong_Kong.png",
  },
  Japan: {
    pattern: "(?i)(日本|JP|Japan|东京|大阪|埼玉|🇯🇵)",
    icon: "https://fastly.jsdelivr.net/gh/Koolson/Qure@master/IconSet/Color/Japan.png",
  },
  Taiwan: {
    pattern: "(?i)(台湾|TW|Taiwan|新北|彰化|🇹🇼)",
    icon: "https://fastly.jsdelivr.net/gh/Koolson/Qure@master/IconSet/Color/Taiwan.png",
  },
  "United States": {
    pattern: "(?i)(美国|US|United States|USA|🇺🇸|圣何塞|洛杉矶|阿什本)",
    icon: "https://fastly.jsdelivr.net/gh/Koolson/Qure@master/IconSet/Color/United_States.png",
  },
  Singapore: {
    pattern: "(?i)(新加坡|SG|Singapore|狮城|🇸🇬)",
    icon: "https://fastly.jsdelivr.net/gh/Koolson/Qure@master/IconSet/Color/Singapore.png",
  },
};

function parseCountries(realProxyNames) {
  const r = Object.create(null);
  const countryOrder = Object.keys(countriesMeta);
  const n = {};
  for (const e of countryOrder) n[e] = getCountryRegex(e);

  for (const t of realProxyNames) {
    for (const e of countryOrder) {
      if (n[e].test(t)) {
        r[e] = (r[e] || 0) + 1;
        break;
      }
    }
  }
  return Object.entries(r).map(([e, t]) => ({ country: e, count: t }));
}

function getCountryRegex(country) {
  const meta = countriesMeta[country];
  if (!meta) return null;
  return new RegExp(meta.pattern.replace(/^\(\?i\)/, ""), "i");
}

function matchesCountry(name, country) {
  const regex = getCountryRegex(country);
  return regex ? regex.test(name) : false;
}

function buildHealthCheckedGroup({
  name: name,
  icon: icon,
  type: type,
  proxies: proxies,
  interval: interval = 180,
}) {
  return {
    name: name,
    icon: icon,
    type: type,
    url: "https://cp.cloudflare.com/generate_204",
    proxies: uniqueList(proxies),
    interval: interval,
    tolerance: 20,
    lazy: false,
  };
}

function buildCountryProxyGroups({
  countries: e,
  loadBalance: o,
  standardProxyNames: standardProxyNames,
}) {
  const r = [],
    s = o ? "load-balance" : "url-test";
  for (const l of e) {
    const e = countriesMeta[l];
    if (!e) continue;
    const countryProxies = standardProxyNames.filter((name) =>
      matchesCountry(name, l),
    );
    if (countryProxies.length <= 0) continue;
    const i = {
      name: l,
      icon: e.icon,
      proxies: countryProxies,
      type: s,
    };
    o ||
      Object.assign(i, {
        url: "https://cp.cloudflare.com/generate_204",
        interval: 60,
        tolerance: 20,
        lazy: !1,
      });
    r.push(i);
  }
  return r;
}

function buildProxyGroups({
  countries: t,
  countryProxyGroups: o,
  defaultProxies: n,
  defaultProxiesDirect: s,
  defaultServiceProxies: serviceProxies,
  defaultFallback: i,
  trafficNodes: trafficNodes,
  realProxyNames: realProxyNames,
  standardProxyNames: standardProxyNames = [],
  nodePools: nodePools = {},
}) {
  const hasTW = t.includes("Taiwan"),
    hasHK = t.includes("Hong Kong");

  const pools = Object.assign({ ai: [], residential: [] }, nodePools);
  const autoRefs = standardProxyNames.length > 0 ? [PROXY_GROUPS.AUTO] : [];
  const countryRefs = [
    "Hong Kong",
    "Taiwan",
    "Japan",
    "United States",
    "Singapore",
  ].filter((country) => t.includes(country));

  const groups = [
    {
      name: PROXY_GROUPS.MANUAL,
      icon: "https://fastly.jsdelivr.net/gh/shindgewongxj/WHATSINStash@master/icon/select.png",
      type: "select",
      proxies: n,
    },
  ];

  if (trafficNodes.length > 0) {
    groups.push({
      name: PROXY_GROUPS.ACCOUNT,
      // 已更换为指定的 TestFlight 图标
      icon: "https://fastly.jsdelivr.net/gh/Koolson/Qure@master/IconSet/Color/TestFlight.png",
      type: "select",
      proxies: trafficNodes,
    });
  }

  if (standardProxyNames.length > 0) {
    groups.push(
      buildHealthCheckedGroup({
        name: PROXY_GROUPS.AUTO,
        icon: "https://fastly.jsdelivr.net/gh/Koolson/Qure@master/IconSet/Color/Auto.png",
        type: "url-test",
        proxies: standardProxyNames,
        interval: 60,
      }),
    );
  }

  groups.push(
    buildHealthCheckedGroup({
      name: PROXY_GROUPS.FALLBACK,
      icon: "https://fastly.jsdelivr.net/gh/Koolson/Qure@master/IconSet/Color/Bypass.png",
      type: "fallback",
      proxies: i,
    }),
  );

  const aiNodeCandidates = uniqueList([...pools.ai, ...pools.residential]);
  const aiDefaultProxies = uniqueList([
    ...aiNodeCandidates,
    PROXY_GROUPS.FALLBACK,
    PROXY_GROUPS.MANUAL,
    PROXY_GROUPS.DIRECT,
  ]);

  const commonGroups = [
    {
      name: "CDN",
      icon: "https://fastly.jsdelivr.net/gh/Koolson/Qure@master/IconSet/Color/Cloudflare.png",
      type: "select",
      proxies: serviceProxies,
    },
    {
      name: "AI",
      icon: "https://fastly.jsdelivr.net/gh/powerfullz/override-rules@master/icons/chatgpt.png",
      type: "select",
      proxies: aiDefaultProxies,
    },
    {
      name: "Telegram",
      icon: "https://fastly.jsdelivr.net/gh/Koolson/Qure@master/IconSet/Color/Telegram.png",
      type: "select",
      proxies: serviceProxies,
    },
    {
      name: "Google",
      icon: "https://fastly.jsdelivr.net/gh/Koolson/Qure@master/IconSet/Color/Google.png",
      type: "select",
      proxies: serviceProxies,
    },
    {
      name: "YouTube",
      icon: "https://fastly.jsdelivr.net/gh/Koolson/Qure@master/IconSet/Color/YouTube.png",
      type: "select",
      proxies: serviceProxies,
    },
    {
      name: "Bilibili",
      icon: "https://fastly.jsdelivr.net/gh/Koolson/Qure@master/IconSet/Color/bilibili.png",
      type: "select",
      proxies:
        hasTW && hasHK
          ? [PROXY_GROUPS.DIRECT, "Taiwan", "Hong Kong", PROXY_GROUPS.FALLBACK]
          : s,
    },
    {
      name: "Netflix",
      icon: "https://fastly.jsdelivr.net/gh/Koolson/Qure@master/IconSet/Color/Netflix.png",
      type: "select",
      proxies: serviceProxies,
    },
    {
      name: "Spotify",
      icon: "https://fastly.jsdelivr.net/gh/Koolson/Qure@master/IconSet/Color/Spotify.png",
      type: "select",
      proxies: serviceProxies,
    },
    {
      name: "Steam",
      icon: "https://fastly.jsdelivr.net/gh/Koolson/Qure@master/IconSet/Color/Steam.png",
      type: "select",
      proxies: serviceProxies,
    },
    {
      name: "TikTok",
      icon: "https://fastly.jsdelivr.net/gh/Koolson/Qure@master/IconSet/Color/TikTok.png",
      type: "select",
      proxies: serviceProxies,
    },
    {
      name: "PikPak",
      icon: "https://fastly.jsdelivr.net/gh/powerfullz/override-rules@master/icons/PikPak.png",
      type: "select",
      proxies: serviceProxies,
    },
    {
      name: "Crypto",
      icon: "https://fastly.jsdelivr.net/gh/Koolson/Qure@master/IconSet/Color/Cryptocurrency_3.png",
      type: "select",
      proxies: serviceProxies,
    },
    {
      name: "SSH(port 22)",
      icon: "https://fastly.jsdelivr.net/gh/Koolson/Qure@master/IconSet/Color/Server.png",
      type: "select",
      proxies: serviceProxies,
    },
    {
      name: PROXY_GROUPS.DIRECT,
      icon: "https://fastly.jsdelivr.net/gh/Koolson/Qure@master/IconSet/Color/Direct.png",
      type: "select",
      proxies: ["DIRECT"],
    },
    {
      name: "AdBlock",
      icon: "https://fastly.jsdelivr.net/gh/Koolson/Qure@master/IconSet/Color/AdBlack.png",
      type: "select",
      proxies: ["REJECT", "REJECT-DROP", PROXY_GROUPS.DIRECT],
    },
  ];

  return [...groups, ...commonGroups, ...o].filter(Boolean);
}

/**
 * 去重函数：重复节点 name 自动加序号
 */
function deduplicateProxies(proxies) {
  const nameCount = new Map();

  return proxies.map((proxy) => {
    const name = proxy.name;

    if (nameCount.has(name)) {
      const count = nameCount.get(name) + 1;
      nameCount.set(name, count);
      proxy.name = `${name}-${count}`;
    } else {
      nameCount.set(name, 1);
    }

    return proxy;
  });
}

function main(e) {
  let proxies = e.proxies || [];

  // 去重处理：重复节点 name 自动加序号
  proxies = deduplicateProxies(proxies);

  // 识别逻辑：包含关键词 且 不包含赞助白名单
  const trafficNodes = proxies
    .filter(
      (p) => TRAFFIC_KEYWORDS.test(p.name) && !WHITELIST_KEYWORDS.test(p.name),
    )
    .map((p) => p.name);

  // 识别真实代理
  const realProxyNames = proxies
    .filter(
      (p) => !TRAFFIC_KEYWORDS.test(p.name) || WHITELIST_KEYWORDS.test(p.name),
    )
    .map((p) => p.name);

  const nodePools = {
    ai: realProxyNames.filter(
      (name) => isAIProxyName(name) || isPremiumProxyName(name),
    ),
    residential: realProxyNames.filter(isResidentialProxyName),
  };

  // 地区自动组只使用普通节点，避免 [pro]/AI/家宽专用节点被自动选中。
  const standardProxyNames = realProxyNames.filter(isStandardProxyName);

  const t = { proxies: proxies };
  const o = parseCountries(standardProxyNames);
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
    standardProxyNames: standardProxyNames,
  });
  const u = buildProxyGroups({
    countries: n,
    countryProxyGroups: p,
    defaultProxies: l,
    defaultProxiesDirect: i,
    defaultServiceProxies: serviceProxies,
    defaultFallback: c,
    trafficNodes: trafficNodes,
    realProxyNames: realProxyNames,
    standardProxyNames: standardProxyNames,
    nodePools: nodePools,
  });

  const groupNames = u.map((e) => e.name);
  u.push({
    name: "GLOBAL",
    icon: "https://fastly.jsdelivr.net/gh/Koolson/Qure@master/IconSet/Color/Global.png",
    "include-all": !0,
    type: "select",
    proxies: groupNames,
  });

  const g = buildRules({ quicEnabled: quicEnabled, countries: n });

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
    "external-controller": "0.0.0.0:9090",
    "clash-for-android": {
      "append-system-dns": false,
    },
    profile: {
      tracing: true,
    },
    experimental: {
      "sniff-tls-sni": true,
    },
    "tcp-concurrent": true,
    "global-client-fingerprint": "chrome",
  });

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

  if (fullConfig) {
    Object.assign(t, {
      "external-controller": ":9999",
      profile: Object.assign(t.profile || {}, { "store-selected": true }),
    });
  }

  // DNS 配置
  const dnsConfig = {
    enable: true,
    ipv6: ipv6Enabled,
    "fake-ip": "fakeip" in rawArgs ? fakeIPEnabled : true,
    listen: "0.0.0.0:53",
    "fake-ip-filter": [
      "*.lan",
      "*.srv.nintendo.net",
      "*.stun.playstation.net",
      "xbox.*.microsoft.com",
      "*.xboxlive.com",
      "*.teafone.com",
      "*.sktswe.net",
      "rtc.goodfone.co.kr",
      "*.chattti.com",
    ],
    nameserver: [
      "119.29.29.29",
      "223.5.5.5",
      "tls://223.5.5.5:853",
      "tls://223.6.6.6:853",
      "tls://120.53.53.53",
      "tls://1.12.12.12",
    ],
  };

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
