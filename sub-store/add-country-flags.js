// Sub-Store script operator: add or normalize country flags from node names.

const COUNTRY_FLAG_PATTERN = /(?:[\uD83C][\uDDE6-\uDDFF]){2}/g;

const COUNTRY_RULES = [
  {
    flag: "🇹🇼",
    patterns: [
      /台湾|台灣|臺灣|台北|新北|台中|臺中|高雄|彰化/i,
      /(?:^|[^a-z])(?:tw|twn|taiwan|cht|hinet)(?=$|[^a-z])/i,
    ],
  },
  {
    flag: "🇸🇬",
    patterns: [
      /新加坡|狮城|獅城/i,
      /(?:^|[^a-z])(?:sg|sgp|singapore)(?=$|[^a-z])/i,
    ],
  },
  {
    flag: "🇯🇵",
    patterns: [
      /日本|东京|東京|大阪|埼玉/i,
      /(?:^|[^a-z])(?:jp|jpn|japan|tokyo|osaka)(?=$|[^a-z])/i,
    ],
  },
  {
    flag: "🇺🇸",
    patterns: [
      /美国|美國|纽约|紐約|洛杉矶|洛杉磯|西雅图|西雅圖|硅谷|矽谷/i,
      /(?:^|[^a-z])(?:us|usa|united[\s_-]*states|america|new[\s_-]*york|los[\s_-]*angeles|seattle|dallas)(?=$|[^a-z])/i,
    ],
  },
  {
    flag: "🇰🇷",
    patterns: [
      /韩国|韓國|首尔|首爾|春川/i,
      /(?:^|[^a-z])(?:kr|kor|korea|seoul)(?=$|[^a-z])/i,
    ],
  },
  {
    flag: "🇩🇪",
    patterns: [
      /德国|德國|法兰克福|法蘭克福/i,
      /(?:^|[^a-z])(?:de|deu|germany|german|deutschland|frankfurt)(?=$|[^a-z])/i,
    ],
  },
  {
    flag: "🇬🇧",
    patterns: [
      /英国|英國|伦敦|倫敦/i,
      /(?:^|[^a-z])(?:uk|gb|gbr|united[\s_-]*kingdom|britain|england|london)(?=$|[^a-z])/i,
    ],
  },
  {
    flag: "🇭🇰",
    patterns: [
      /香港|九龙|九龍/i,
      /(?:^|[^a-z])(?:hk|hkg|hong[\s_-]*kong|hongkong|kowloon)(?=$|[^a-z])/i,
    ],
  },
  {
    flag: "🇨🇳",
    patterns: [
      /中国|中國|大陆|大陸|回国|回國|北京|上海|广州|廣州|深圳|杭州/i,
      /(?:^|[^a-z])(?:cn|chn|china|mainland)(?=$|[^a-z])/i,
    ],
  },
  {
    flag: "🇲🇴",
    patterns: [
      /澳门|澳門/i,
      /(?:^|[^a-z])(?:mo|mac|macao|macau)(?=$|[^a-z])/i,
    ],
  },
  {
    flag: "🇦🇺",
    patterns: [
      /澳大利亚|澳大利亞|澳洲|悉尼|墨尔本|墨爾本/i,
      /(?:^|[^a-z])(?:au|aus|australia|sydney|melbourne)(?=$|[^a-z])/i,
    ],
  },
  {
    flag: "🇨🇦",
    patterns: [
      /加拿大|温哥华|溫哥華|多伦多|多倫多|蒙特利尔|蒙特利爾/i,
      /(?:^|[^a-z])(?:ca|can|canada|vancouver|toronto|montreal)(?=$|[^a-z])/i,
    ],
  },
  {
    flag: "🇫🇷",
    patterns: [
      /法国|法國|巴黎|马赛|馬賽/i,
      /(?:^|[^a-z])(?:fr|fra|france|paris|marseille)(?=$|[^a-z])/i,
    ],
  },
  {
    flag: "🇳🇱",
    patterns: [
      /荷兰|荷蘭|阿姆斯特丹/i,
      /(?:^|[^a-z])(?:nl|nld|netherlands|holland|amsterdam)(?=$|[^a-z])/i,
    ],
  },
  {
    flag: "🇷🇺",
    patterns: [
      /俄罗斯|俄羅斯|莫斯科|圣彼得堡|聖彼得堡|西伯利亚|西伯利亞/i,
      /(?:^|[^a-z])(?:ru|rus|russia|moscow|saint[\s_-]*petersburg)(?=$|[^a-z])/i,
    ],
  },
  {
    flag: "🇮🇳",
    patterns: [
      /印度|孟买|孟買|班加罗尔|班加羅爾/i,
      /(?:^|[^a-z])(?:in|ind|india|mumbai|bangalore)(?=$|[^a-z])/i,
    ],
  },
  {
    flag: "🇮🇩",
    patterns: [
      /印度尼西亚|印度尼西亞|印尼|雅加达|雅加達/i,
      /(?:^|[^a-z])(?:id|idn|indonesia|jakarta)(?=$|[^a-z])/i,
    ],
  },
  {
    flag: "🇲🇾",
    patterns: [
      /马来西亚|馬來西亞|吉隆坡/i,
      /(?:^|[^a-z])(?:my|mys|malaysia|kuala[\s_-]*lumpur)(?=$|[^a-z])/i,
    ],
  },
  {
    flag: "🇹🇭",
    patterns: [
      /泰国|泰國|曼谷/i,
      /(?:^|[^a-z])(?:th|tha|thailand|bangkok)(?=$|[^a-z])/i,
    ],
  },
  {
    flag: "🇻🇳",
    patterns: [
      /越南|河内|河內|胡志明/i,
      /(?:^|[^a-z])(?:vn|vnm|vietnam|hanoi|ho[\s_-]*chi[\s_-]*minh)(?=$|[^a-z])/i,
    ],
  },
  {
    flag: "🇵🇭",
    patterns: [
      /菲律宾|菲律賓|马尼拉|馬尼拉/i,
      /(?:^|[^a-z])(?:ph|phl|philippines|manila)(?=$|[^a-z])/i,
    ],
  },
  {
    flag: "🇦🇪",
    patterns: [
      /阿联酋|阿聯酋|迪拜|阿布扎比/i,
      /(?:^|[^a-z])(?:ae|are|uae|united[\s_-]*arab[\s_-]*emirates|dubai|abu[\s_-]*dhabi)(?=$|[^a-z])/i,
    ],
  },
  {
    flag: "🇮🇹",
    patterns: [
      /意大利|義大利|米兰|米蘭|罗马|羅馬/i,
      /(?:^|[^a-z])(?:it|ita|italy|milan|rome)(?=$|[^a-z])/i,
    ],
  },
  {
    flag: "🇪🇸",
    patterns: [
      /西班牙|马德里|馬德里|巴塞罗那|巴塞羅那/i,
      /(?:^|[^a-z])(?:es|esp|spain|madrid|barcelona)(?=$|[^a-z])/i,
    ],
  },
  {
    flag: "🇨🇭",
    patterns: [
      /瑞士|苏黎世|蘇黎世|日内瓦|日內瓦/i,
      /(?:^|[^a-z])(?:ch|che|switzerland|zurich|geneva)(?=$|[^a-z])/i,
    ],
  },
  {
    flag: "🇸🇪",
    patterns: [
      /瑞典|斯德哥尔摩|斯德哥爾摩/i,
      /(?:^|[^a-z])(?:se|swe|sweden|stockholm)(?=$|[^a-z])/i,
    ],
  },
  {
    flag: "🇫🇮",
    patterns: [
      /芬兰|芬蘭|赫尔辛基|赫爾辛基/i,
      /(?:^|[^a-z])(?:fi|fin|finland|helsinki)(?=$|[^a-z])/i,
    ],
  },
  {
    flag: "🇵🇱",
    patterns: [
      /波兰|波蘭|华沙|華沙/i,
      /(?:^|[^a-z])(?:pl|pol|poland|warsaw)(?=$|[^a-z])/i,
    ],
  },
  {
    flag: "🇳🇴",
    patterns: [
      /挪威|奥斯陆|奧斯陸/i,
      /(?:^|[^a-z])(?:no|nor|norway|oslo)(?=$|[^a-z])/i,
    ],
  },
  {
    flag: "🇮🇪",
    patterns: [
      /爱尔兰|愛爾蘭|都柏林/i,
      /(?:^|[^a-z])(?:ie|irl|ireland|dublin)(?=$|[^a-z])/i,
    ],
  },
];

function findCountryFlag(name) {
  const textWithoutFlags = name.replace(COUNTRY_FLAG_PATTERN, "");
  const matchedRule = COUNTRY_RULES.find(({ patterns }) =>
    patterns.some((pattern) => pattern.test(textWithoutFlags)),
  );
  if (matchedRule) return matchedRule.flag;

  // Preserve a supported existing flag when the remaining name has no
  // recognizable country text, for example "🇹🇼 01".
  const existingRule = COUNTRY_RULES.find(({ flag }) => name.includes(flag));
  return existingRule ? existingRule.flag : null;
}

function addCountryFlagToName(value) {
  const name = String(value == null ? "" : value).trim();
  if (!name) return name;

  const flag = findCountryFlag(name);
  if (!flag) return name;

  const nameWithoutFlags = name
    .replace(COUNTRY_FLAG_PATTERN, "")
    .replace(/\s{2,}/g, " ")
    .trim();
  return nameWithoutFlags ? `${flag} ${nameWithoutFlags}` : flag;
}

function addCountryFlag(proxy) {
  if (!proxy || typeof proxy !== "object") return proxy;
  const name = addCountryFlagToName(proxy.name);
  return name === proxy.name ? proxy : Object.assign({}, proxy, { name });
}

function operator(proxies = [], targetPlatform, context) {
  const input = Array.isArray(proxies) ? proxies : [];
  let changed = 0;
  const output = input.map((proxy) => {
    const result = addCountryFlag(proxy);
    if (result !== proxy) changed += 1;
    return result;
  });

  if (
    typeof $substore === "object" &&
    $substore &&
    typeof $substore.info === "function"
  ) {
    $substore.info(
      `Country flags: input=${input.length}, changed=${changed}, unchanged=${input.length - changed}`,
    );
  }
  return output;
}

// Also support Sub-Store's single-node shortcut-script execution mode.
if (typeof $server !== "undefined" && $server && $server.name != null) {
  $server.name = addCountryFlagToName($server.name);
}
