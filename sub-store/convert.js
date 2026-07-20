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

const clientFingerprint = (() => {
  if (!("fingerprint" in rawArgs)) return "chrome";
  const e = String(rawArgs.fingerprint || "").trim();
  return /^(|0|false|none|off)$/i.test(e) ? "" : e;
})();

function getCountryGroupNames(e, t) {
  return e.filter((e) => e.count >= t).map((e) => e.country);
}

const PROXY_GROUPS = {
  ACCOUNT: "Account Info",
  MANUAL: "Proxies",
  FALLBACK: "Fallback",
  DIRECT: "Bypass",
  CDN: "CDN",
};

// 流量信息关键词：避免用裸 GB 误伤 1Gbps 之类的真实节点名
const TRAFFIC_KEYWORDS =
  /(建议|重置|官方网站|更新|官网|套餐|流量|剩余|到期|防丢|导航|Expire|Usage|Traffic|Standard|Used|Total)/i;
const TRAFFIC_USAGE_PATTERN =
  /(?:^|[^A-Za-z0-9])[0-9]+(?:\.[0-9]+)?\s*(?:[KMGT]B|KiB|MiB|GiB|TiB)(?:$|[^A-Za-z0-9])/i;
const TRAFFIC_EXCLUDE_PATTERN = `(?i)(${TRAFFIC_KEYWORDS.source}|${TRAFFIC_USAGE_PATTERN.source})`;
// 白名单：包含以下字符的依然视为普通节点
const WHITELIST_KEYWORDS = /(赞助|Node|节点)/i;

function isTrafficNodeName(name) {
  return (
    !WHITELIST_KEYWORDS.test(name) &&
    (TRAFFIC_KEYWORDS.test(name) || TRAFFIC_USAGE_PATTERN.test(name))
  );
}

function uniqueList(items) {
  return [...new Set(items.filter(Boolean))];
}

function buildBaseLists({ countryGroupNames: o }) {
  return {
    defaultProxies: [PROXY_GROUPS.MANUAL, ...o, PROXY_GROUPS.DIRECT],
    defaultProxiesDirect: [PROXY_GROUPS.DIRECT, ...o, PROXY_GROUPS.MANUAL],
    defaultFallback: [...o, PROXY_GROUPS.MANUAL, PROXY_GROUPS.DIRECT],
  };
}

function metaGeositeProvider(source, pathName = source) {
  return {
    type: "http",
    behavior: "domain",
    format: "mrs",
    interval: 86400,
    url: `https://gcore.jsdelivr.net/gh/MetaCubeX/meta-rules-dat@meta/geo/geosite/${source}.mrs`,
    path: `./ruleset/${pathName}.mrs`,
  };
}

const ruleProviders = {
  AI: metaGeositeProvider("category-ai-!cn", "AI"),
  Telegram: metaGeositeProvider("telegram", "Telegram"),
  YouTube: metaGeositeProvider("youtube", "YouTube"),
  Netflix: metaGeositeProvider("netflix", "Netflix"),
  Spotify: metaGeositeProvider("spotify", "Spotify"),
  Bilibili: metaGeositeProvider("bilibili", "Bilibili"),
  Google: metaGeositeProvider("google", "Google"),
  Steam: metaGeositeProvider("steam", "Steam"),
  TikTok: metaGeositeProvider("tiktok", "TikTok"),
  MetaFacebook: metaGeositeProvider("facebook", "MetaFacebook"),
  MetaInstagram: metaGeositeProvider("instagram", "MetaInstagram"),
  MetaWhatsApp: metaGeositeProvider("whatsapp", "MetaWhatsApp"),
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

const cryptoFallbackRules = [
  // Crypto.com / Cronos
  "DOMAIN-SUFFIX,crypto.com,Crypto",
  "DOMAIN-SUFFIX,crypto.org,Crypto",
  "DOMAIN-SUFFIX,cronos.org,Crypto",
  "DOMAIN-SUFFIX,cronoscan.com,Crypto",
  "DOMAIN-SUFFIX,cronoslabs.org,Crypto",

  // Crypto cards
  "DOMAIN-SUFFIX,redotpay.com,Crypto",
  "DOMAIN,redot.onelink.me,Crypto",
  "DOMAIN-SUFFIX,cypherhq.io,Crypto",

  // Extra exchanges and wallets that are commonly missing from small lists
  "DOMAIN-SUFFIX,bitget.com,Crypto",
  "DOMAIN-SUFFIX,bitgetapi.com,Crypto",
  "DOMAIN-SUFFIX,bitgetimg.com,Crypto",
  "DOMAIN-SUFFIX,bitmart.com,Crypto",
  "DOMAIN-SUFFIX,bingx.com,Crypto",
  "DOMAIN-SUFFIX,coinex.com,Crypto",
  "DOMAIN-SUFFIX,lbank.com,Crypto",
  "DOMAIN-SUFFIX,phemex.com,Crypto",
  "DOMAIN-SUFFIX,backpack.exchange,Crypto",
  "DOMAIN-SUFFIX,hyperliquid.xyz,Crypto",
  "DOMAIN-SUFFIX,aevo.xyz,Crypto",
  "DOMAIN-SUFFIX,paradex.trade,Crypto",
  "DOMAIN-SUFFIX,rabby.io,Crypto",
  "DOMAIN-SUFFIX,zerion.io,Crypto",
  "DOMAIN-SUFFIX,zapper.xyz,Crypto",
];

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
  "RULE-SET,Telegram,Telegram",
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
  "RULE-SET,YouTube,YouTube",
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

  // Meta / Facebook / Instagram / WhatsApp
  "RULE-SET,MetaFacebook,Meta",
  "RULE-SET,MetaInstagram,Meta",
  "RULE-SET,MetaWhatsApp,Meta",
  "DOMAIN-SUFFIX,meta.com,Meta",
  "DOMAIN-SUFFIX,messenger.com,Meta",
  "DOMAIN-SUFFIX,threads.net,Meta",
  "DOMAIN-SUFFIX,threads.com,Meta",

  // Netflix 静态规则
  "RULE-SET,Netflix,Netflix",
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
  "RULE-SET,Spotify,Spotify",
  "DOMAIN-SUFFIX,spotify.com,Spotify",
  "DOMAIN-SUFFIX,scdn.co,Spotify",
  "DOMAIN-SUFFIX,spoti.fi,Spotify",
  "DOMAIN-SUFFIX,spotifycdn.com,Spotify",
  "DOMAIN-SUFFIX,spotifycdn.net,Spotify",
  "DOMAIN-SUFFIX,pscdn.co,Spotify",
  "DOMAIN-KEYWORD,spotify,Spotify",

  // Bilibili 静态规则
  "RULE-SET,Bilibili,Bilibili",
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
  `RULE-SET,GoogleFCM,${PROXY_GROUPS.DIRECT}`,
  `DOMAIN,services.googleapis.cn,${PROXY_GROUPS.MANUAL}`,
  "RULE-SET,AI,AI",
  `GEOSITE,GOOGLE-PLAY@CN,${PROXY_GROUPS.DIRECT}`,
  "GEOSITE,CATEGORY-AI-!CN,AI",
  "RULE-SET,Google,Google",
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
  `RULE-SET,SteamFix,${PROXY_GROUPS.DIRECT}`,
  "RULE-SET,Steam,Steam",
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
  ...cryptoFallbackRules,
  "RULE-SET,Crypto,Crypto",

  // TikTok
  "RULE-SET,TikTok,TikTok",

  // 其他
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
  let t = [...baseRules];
  t = moveRulesBeforeGoogle(t, [
    "RULE-SET,AI,AI",
    `GEOSITE,GOOGLE-PLAY@CN,${PROXY_GROUPS.DIRECT}`,
    "GEOSITE,CATEGORY-AI-!CN,AI",
  ]);
  const r = t.findIndex((e) => e.startsWith("RULE-SET,TikTok"));
  t.splice(r >= 0 ? r : t.length, 0, ...buildAppRules({ countries: o }));
  return (e || t.unshift("AND,((DST-PORT,443),(NETWORK,UDP)),REJECT"), t);
}

function moveRulesBeforeGoogle(rules, rulesToMove) {
  const selected = new Set(rulesToMove);
  const moving = [];
  const rest = [];
  for (const rule of rules) {
    if (selected.has(rule)) moving.push(rule);
    else rest.push(rule);
  }
  if (!moving.length) return rest;
  const googleIndex = rest.findIndex((rule) => /,Google(?:,|$)/.test(rule));
  rest.splice(googleIndex >= 0 ? googleIndex : rest.length, 0, ...moving);
  return rest;
}

// 精简版国家列表：只保留 HK, TW, US, SG, JP
const countriesMeta = {
  "Hong Kong": {
    pattern:
      "(?i)(香港|Hong\\s*Kong|HongKong|🇭🇰|(?:^|[^A-Za-z0-9])HK(?:$|[^A-Za-z0-9]))",
    icon: "https://fastly.jsdelivr.net/gh/Koolson/Qure@master/IconSet/Color/Hong_Kong.png",
  },
  Japan: {
    pattern:
      "(?i)(日本|东京|東京|大阪|埼玉|Japan|🇯🇵|(?:^|[^A-Za-z0-9])JP(?:$|[^A-Za-z0-9]))",
    icon: "https://fastly.jsdelivr.net/gh/Koolson/Qure@master/IconSet/Color/Japan.png",
  },
  Taiwan: {
    pattern:
      "(?i)(台湾|台灣|新北|彰化|Taiwan|🇹🇼|(?:^|[^A-Za-z0-9])TW(?:$|[^A-Za-z0-9]))",
    icon: "https://fastly.jsdelivr.net/gh/Koolson/Qure@master/IconSet/Color/Taiwan.png",
  },
  "United States": {
    pattern:
      "(?i)(美国|美國|圣何塞|聖何塞|洛杉矶|洛杉磯|阿什本|United\\s*States|USA|U\\.S\\.A|🇺🇸|(?:^|[^A-Za-z0-9])US(?:$|[^A-Za-z0-9]))",
    icon: "https://fastly.jsdelivr.net/gh/Koolson/Qure@master/IconSet/Color/United_States.png",
  },
  Singapore: {
    pattern:
      "(?i)(新加坡|狮城|獅城|Singapore|🇸🇬|(?:^|[^A-Za-z0-9])SG(?:$|[^A-Za-z0-9]))",
    icon: "https://fastly.jsdelivr.net/gh/Koolson/Qure@master/IconSet/Color/Singapore.png",
  },
};

function parseCountries(realProxyNames) {
  const r = Object.create(null);
  const countryOrder = Object.keys(countriesMeta);
  const n = {};
  for (const e of countryOrder)
    n[e] = new RegExp(countriesMeta[e].pattern.replace(/^\(\?i\)/, ""), "i");

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

function buildCountryProxyGroups({ countries: e, loadBalance: o }) {
  const r = [],
    s = o ? "load-balance" : "url-test";
  for (const l of e) {
    const e = countriesMeta[l];
    if (!e) continue;
    const i = {
      name: l,
      icon: e.icon,
      "include-all": !0,
      filter: e.pattern,
      "exclude-filter": TRAFFIC_EXCLUDE_PATTERN,
      type: s,
      url: "https://cp.cloudflare.com/generate_204",
      interval: 180,
      lazy: !1,
    };
    if (o) {
      Object.assign(i, {
        strategy: "consistent-hashing",
      });
    } else {
      Object.assign(i, {
        interval: 60,
        tolerance: 20,
      });
    }
    r.push(i);
  }
  return r;
}

function buildProxyGroups({
  countries: t,
  countryProxyGroups: o,
  defaultProxies: n,
  defaultProxiesDirect: s,
  defaultFallback: i,
  trafficNodes: trafficNodes,
  realProxyNames: realProxyNames,
}) {
  const hasTW = t.includes("Taiwan"),
    hasHK = t.includes("Hong Kong");

  // AI 分组默认使用 Proxies，可根据需要添加家宽节点
  const aiSpecificProxies = realProxyNames.filter((name) =>
    /(residential|resident|家宽)/i.test(name),
  );
  const aiRegions = [
    "United States",
    "Japan",
    "Singapore",
    "Taiwan",
    "Hong Kong",
  ].filter((name) => t.includes(name));
  // AI 分组默认选择: 家宽节点优先，其次是常用区域，Proxies 保留为手动 fallback
  const aiDefaultProxies = uniqueList([
    ...aiSpecificProxies,
    ...aiRegions,
    PROXY_GROUPS.MANUAL,
  ]);
  const manualProxies = realProxyNames.length ? realProxyNames : ["DIRECT"];

  const groups = [
    {
      name: PROXY_GROUPS.MANUAL,
      icon: "https://fastly.jsdelivr.net/gh/shindgewongxj/WHATSINStash@master/icon/select.png",
      type: "select",
      proxies: manualProxies,
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

  groups.push({
    name: PROXY_GROUPS.FALLBACK,
    icon: "https://fastly.jsdelivr.net/gh/Koolson/Qure@master/IconSet/Color/Bypass.png",
    type: "fallback",
    url: "https://cp.cloudflare.com/generate_204",
    proxies: i,
    interval: 180,
    tolerance: 20,
    lazy: !1,
  });

  const commonGroups = [
    {
      name: "CDN",
      icon: "https://fastly.jsdelivr.net/gh/Koolson/Qure@master/IconSet/Color/Cloudflare.png",
      type: "select",
      proxies: n,
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
      proxies: n,
    },
    {
      name: "Meta",
      icon: "https://fastly.jsdelivr.net/gh/Koolson/Qure@master/IconSet/Color/Facebook.png",
      type: "select",
      proxies: n,
    },
    {
      name: "Google",
      icon: "https://fastly.jsdelivr.net/gh/Koolson/Qure@master/IconSet/Color/Google.png",
      type: "select",
      proxies: n,
    },
    {
      name: "YouTube",
      icon: "https://fastly.jsdelivr.net/gh/Koolson/Qure@master/IconSet/Color/YouTube.png",
      type: "select",
      proxies: n,
    },
    {
      name: "Bilibili",
      icon: "https://fastly.jsdelivr.net/gh/Koolson/Qure@master/IconSet/Color/bilibili.png",
      type: "select",
      proxies:
        hasTW && hasHK ? [PROXY_GROUPS.DIRECT, "Taiwan", "Hong Kong"] : s,
    },
    {
      name: "Netflix",
      icon: "https://fastly.jsdelivr.net/gh/Koolson/Qure@master/IconSet/Color/Netflix.png",
      type: "select",
      proxies: n,
    },
    {
      name: "Spotify",
      icon: "https://fastly.jsdelivr.net/gh/Koolson/Qure@master/IconSet/Color/Spotify.png",
      type: "select",
      proxies: n,
    },
    {
      name: "Steam",
      icon: "https://fastly.jsdelivr.net/gh/Koolson/Qure@master/IconSet/Color/Steam.png",
      type: "select",
      proxies: n,
    },
    {
      name: "TikTok",
      icon: "https://fastly.jsdelivr.net/gh/Koolson/Qure@master/IconSet/Color/TikTok.png",
      type: "select",
      proxies: n,
    },
    {
      name: "PikPak",
      icon: "https://fastly.jsdelivr.net/gh/powerfullz/override-rules@master/icons/PikPak.png",
      type: "select",
      proxies: n,
    },
    {
      name: "Crypto",
      icon: "https://fastly.jsdelivr.net/gh/Koolson/Qure@master/IconSet/Color/Cryptocurrency_3.png",
      type: "select",
      proxies: n,
    },
    {
      name: "SSH(port 22)",
      icon: "https://fastly.jsdelivr.net/gh/Koolson/Qure@master/IconSet/Color/Server.png",
      type: "select",
      proxies: n,
    },
  ];

  const utilityGroups = [
    {
      name: PROXY_GROUPS.DIRECT,
      icon: "https://fastly.jsdelivr.net/gh/Koolson/Qure@master/IconSet/Color/Direct.png",
      type: "select",
      proxies: ["DIRECT", PROXY_GROUPS.MANUAL],
    },
    {
      name: "AdBlock",
      icon: "https://fastly.jsdelivr.net/gh/Koolson/Qure@master/IconSet/Color/AdBlack.png",
      type: "select",
      proxies: ["REJECT", "REJECT-DROP", PROXY_GROUPS.DIRECT],
    },
  ];

  return [...groups, ...commonGroups, ...o, ...utilityGroups].filter(Boolean);
}

/**
 * 去重函数：重复节点 name 自动加序号
 */
function deduplicateProxies(proxies) {
  const nameCount = new Map();

  return proxies.map((proxy) => {
    const next = Object.assign({}, proxy);
    const name = next.name || "Proxy";

    if (nameCount.has(name)) {
      const count = nameCount.get(name) + 1;
      nameCount.set(name, count);
      next.name = `${name}-${count}`;
    } else {
      nameCount.set(name, 1);
      next.name = name;
    }

    return next;
  });
}

const TLS_PROXY_TYPES =
  /^(vmess|vless|trojan|hysteria|hysteria2|tuic|juicity|anytls)$/i;

function applyClientFingerprint(proxy) {
  if (
    !clientFingerprint ||
    proxy["client-fingerprint"] ||
    !(
      proxy.tls === true ||
      proxy.sni ||
      proxy.servername ||
      TLS_PROXY_TYPES.test(String(proxy.type || ""))
    )
  )
    return proxy;

  return Object.assign({}, proxy, { "client-fingerprint": clientFingerprint });
}

function normalizeProxies(proxies) {
  return deduplicateProxies(proxies).map(applyClientFingerprint);
}

function main(e = {}) {
  let proxies = e.proxies || [];

  // 去重处理：重复节点 name 自动加序号
  proxies = normalizeProxies(proxies);

  // 识别逻辑：包含关键词 且 不包含赞助白名单
  const trafficNodes = proxies
    .filter((p) => isTrafficNodeName(p.name))
    .map((p) => p.name);

  // 识别真实代理
  const realProxyNames = proxies
    .filter((p) => !isTrafficNodeName(p.name))
    .map((p) => p.name);

  const t = Object.assign({}, e, { proxies: proxies });
  const o = parseCountries(realProxyNames);
  const n = getCountryGroupNames(o, countryThreshold);

  const {
    defaultProxies: l,
    defaultProxiesDirect: i,
    defaultFallback: c,
  } = buildBaseLists({ countryGroupNames: n });
  const p = buildCountryProxyGroups({ countries: n, loadBalance: loadBalance });
  const u = buildProxyGroups({
    countries: n,
    countryProxyGroups: p,
    defaultProxies: l,
    defaultProxiesDirect: i,
    defaultFallback: c,
    trafficNodes: trafficNodes,
    realProxyNames: realProxyNames,
  });

  const groupNames = u
    .map((e) => e.name)
    .filter((name) => ![PROXY_GROUPS.ACCOUNT, "AdBlock"].includes(name));
  u.push({
    name: "GLOBAL",
    icon: "https://fastly.jsdelivr.net/gh/Koolson/Qure@master/IconSet/Color/Global.png",
    "include-all": !0,
    type: "select",
    proxies: groupNames,
  });

  const g = buildRules({ quicEnabled: quicEnabled, countries: n });
  const controllerAddress =
    rawArgs.controller || rawArgs["external-controller"] || "127.0.0.1:9090";
  const controllerSecret = rawArgs.secret == null ? "" : String(rawArgs.secret);
  const useFakeIP = "fakeip" in rawArgs ? fakeIPEnabled : true;

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
    "external-controller": controllerAddress,
    "clash-for-android": {
      "append-system-dns": false,
    },
    profile: {
      tracing: true,
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
        TLS: {
          ports: [443, 8443],
        },
        QUIC: {
          ports: [443, 8443],
        },
      },
      "skip-domain": ["Mijia Cloud", "dlg.io.mi.com"],
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

  if (fullConfig) {
    Object.assign(t, {
      "external-controller":
        rawArgs.controller ||
        rawArgs["external-controller"] ||
        "127.0.0.1:9999",
      profile: Object.assign(t.profile || {}, { "store-selected": true }),
    });
  }

  // DNS 配置
  const dnsConfig = {
    enable: true,
    ipv6: ipv6Enabled,
    listen: "127.0.0.1:53",
    "enhanced-mode": useFakeIP ? "fake-ip" : "redir-host",
    "default-nameserver": ["119.29.29.29", "223.5.5.5"],
    "proxy-server-nameserver": ["119.29.29.29", "223.5.5.5"],
    nameserver: [
      "https://doh.pub/dns-query",
      "https://dns.alidns.com/dns-query",
      "tls://223.5.5.5:853",
      "tls://223.6.6.6:853",
    ],
  };

  if (useFakeIP) {
    Object.assign(dnsConfig, {
      "fake-ip-range": "198.18.0.1/16",
      "fake-ip-filter-mode": "blacklist",
      "fake-ip-filter": [
        "*.lan",
        "*.local",
        "*.localhost",
        "*.srv.nintendo.net",
        "*.stun.playstation.net",
        "xbox.*.microsoft.com",
        "*.xboxlive.com",
        "*.teafone.com",
        "*.sktswe.net",
        "rtc.goodfone.co.kr",
        "*.chattti.com",
        "Mijia Cloud",
        "dlg.io.mi.com",
      ],
    });
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

function operator(proxies = []) {
  return normalizeProxies(proxies);
}
