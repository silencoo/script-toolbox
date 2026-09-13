// author=codex-5.6 sol extra high
// Optional ordering: #noCache&countryorder=jp,us,hk,sg,nl,de,in.
// Supports 60 locations, ISO codes and English names; see README.md.

// BEGIN COUNTRY ORDER: keep this standalone block identical in both scripts.
// [ISO code, English name, aliases/cities, Chinese name/city pattern].
// Sorting recognizes more locations than convert-v2's automatic country groups.
const SORT_COUNTRIES = [
  ["jp", "Japan", "jpn|tokyo|osaka", "日本|东京|東京|大阪|埼玉"],
  ["us", "United States", "usa|america|new york|los angeles|seattle|dallas|san jose|ashburn", "美国|美國|纽约|紐約|洛杉矶|洛杉磯|西雅图|西雅圖|圣何塞|阿什本|硅谷|矽谷"],
  ["tw", "Taiwan", "twn|cht|hinet|taipei", "台湾|台灣|臺灣|台北|臺北|新北|台中|臺中|高雄|彰化"],
  ["sg", "Singapore", "sgp", "新加坡|狮城|獅城"],
  ["hk", "Hong Kong", "hkg|hongkong|kowloon", "香港|九龙|九龍"],
  ["kr", "South Korea", "kor|korea|seoul", "韩国|韓國|首尔|首爾|春川"],
  ["de", "Germany", "deu|german|deutschland|frankfurt|berlin", "德国|德國|法兰克福|法蘭克福|(?:^|[^都])柏林"],
  ["gb", "United Kingdom", "uk|gbr|britain|england|london", "英国|英國|伦敦|倫敦"],
  ["cn", "China", "chn|mainland", "中国|中國|大陆|大陸|回国|回國|北京|上海|广州|廣州|深圳|杭州"],
  ["mo", "Macau", "mac|macao", "澳门|澳門"],
  ["au", "Australia", "aus|sydney|melbourne", "澳大利亚|澳大利亞|澳洲|悉尼|墨尔本|墨爾本"],
  ["ca", "Canada", "can|vancouver|toronto|montreal", "加拿大|温哥华|溫哥華|多伦多|多倫多|蒙特利尔|蒙特利爾"],
  ["fr", "France", "fra|paris|marseille", "法国|法國|巴黎|马赛|馬賽"],
  ["nl", "Netherlands", "nld|holland|amsterdam", "荷兰|荷蘭|阿姆斯特丹"],
  ["ru", "Russia", "rus|moscow|saint petersburg", "俄罗斯|俄羅斯|莫斯科|圣彼得堡|聖彼得堡|西伯利亚|西伯利亞"],
  ["in", "India", "ind|mumbai|bangalore", "印度(?!尼)|孟买|孟買|班加罗尔|班加羅爾"],
  ["id", "Indonesia", "idn|jakarta", "印度尼西亚|印度尼西亞|印尼|雅加达|雅加達"],
  ["my", "Malaysia", "mys|kuala lumpur", "马来西亚|馬來西亞|吉隆坡"],
  ["th", "Thailand", "tha|bangkok", "泰国|泰國|曼谷"],
  ["vn", "Vietnam", "vnm|hanoi|ho chi minh", "越南|河内|河內|胡志明"],
  ["ph", "Philippines", "phl|manila", "菲律宾|菲律賓|马尼拉|馬尼拉"],
  ["ae", "United Arab Emirates", "are|uae|dubai|abu dhabi", "阿联酋|阿聯酋|迪拜|阿布扎比"],
  ["it", "Italy", "ita|milan|rome", "意大利|義大利|米兰|米蘭|罗马(?!尼)|羅馬(?!尼)"],
  ["es", "Spain", "esp|madrid|barcelona", "西班牙|马德里|馬德里|巴塞罗那|巴塞羅那"],
  ["ch", "Switzerland", "che|zurich|geneva", "瑞士|苏黎世|蘇黎世|日内瓦|日內瓦"],
  ["se", "Sweden", "swe|stockholm", "瑞典|斯德哥尔摩|斯德哥爾摩"],
  ["fi", "Finland", "fin|helsinki", "芬兰|芬蘭|赫尔辛基|赫爾辛基"],
  ["pl", "Poland", "pol|warsaw", "波兰|波蘭|华沙|華沙"],
  ["no", "Norway", "nor|oslo", "挪威|奥斯陆|奧斯陸"],
  ["ie", "Ireland", "irl|dublin", "爱尔兰|愛爾蘭|都柏林"],
  ["nz", "New Zealand", "nzl|auckland", "新西兰|新西蘭|纽西兰|紐西蘭|奥克兰|奧克蘭"],
  ["br", "Brazil", "bra|sao paulo", "巴西|圣保罗|聖保羅"],
  ["ar", "Argentina", "arg|buenos aires", "阿根廷|布宜诺斯艾利斯"],
  ["cl", "Chile", "chl|santiago", "智利|圣地亚哥|聖地亞哥"],
  ["mx", "Mexico", "mex", "墨西哥"],
  ["at", "Austria", "aut|vienna", "奥地利|奧地利|维也纳|維也納"],
  ["be", "Belgium", "bel|brussels", "比利时|比利時|布鲁塞尔|布魯塞爾"],
  ["dk", "Denmark", "dnk|copenhagen", "丹麦|丹麥|哥本哈根"],
  ["pt", "Portugal", "prt|lisbon", "葡萄牙|里斯本"],
  ["cz", "Czechia", "cze|czech republic|prague", "捷克|布拉格"],
  ["hu", "Hungary", "hun|budapest", "匈牙利|布达佩斯|布達佩斯"],
  ["ro", "Romania", "rou|bucharest", "罗马尼亚|羅馬尼亞|布加勒斯特"],
  ["bg", "Bulgaria", "bgr|sofia", "保加利亚|保加利亞|索非亚|索非亞"],
  ["gr", "Greece", "grc|athens", "希腊|希臘|雅典"],
  ["tr", "Turkey", "tur|turkiye|türkiye|istanbul", "土耳其|伊斯坦布尔|伊斯坦布爾"],
  ["il", "Israel", "isr|tel aviv", "以色列|特拉维夫|特拉維夫"],
  ["sa", "Saudi Arabia", "sau|riyadh", "沙特|沙烏地|利雅得"],
  ["za", "South Africa", "zaf|johannesburg", "南非|约翰内斯堡|約翰內斯堡"],
  ["ua", "Ukraine", "ukr|kyiv|kiev", "乌克兰|烏克蘭|基辅|基輔"],
  ["lu", "Luxembourg", "lux", "卢森堡|盧森堡"],
  ["is", "Iceland", "isl|reykjavik", "冰岛|冰島|雷克雅未克"],
  ["ee", "Estonia", "est|tallinn", "爱沙尼亚|愛沙尼亞|塔林"],
  ["lv", "Latvia", "lva|riga", "拉脱维亚|拉脫維亞|里加"],
  ["lt", "Lithuania", "ltu|vilnius", "立陶宛|维尔纽斯|維爾紐斯"],
  ["pk", "Pakistan", "pak|karachi", "巴基斯坦|卡拉奇"],
  ["bd", "Bangladesh", "bgd|dhaka", "孟加拉|达卡|達卡"],
  ["np", "Nepal", "npl|kathmandu", "尼泊尔|尼泊爾|加德满都|加德滿都"],
  ["kh", "Cambodia", "khm|phnom penh", "柬埔寨|金边|金邊"],
  ["lk", "Sri Lanka", "lka|colombo", "斯里兰卡|斯里蘭卡|科伦坡|科倫坡"],
  ["kz", "Kazakhstan", "kaz|almaty", "哈萨克斯坦|哈薩克斯坦|阿拉木图|阿拉木圖"],
];

function normalizeCountryAlias(value) {
  return value.trim().toLowerCase().replace(/[\s_-]+/g, "");
}

const SORT_COUNTRY_ALIASES = new Map();
const SORT_COUNTRY_MATCHERS = SORT_COUNTRIES.map(([code, name, aliases, local]) => {
  const words = [code, name, ...aliases.split("|")];
  const flag = Array.from(code.toUpperCase(), (letter) =>
    String.fromCodePoint(letter.charCodeAt(0) + 127397)).join("");
  for (const alias of [...words, flag]) {
    SORT_COUNTRY_ALIASES.set(normalizeCountryAlias(alias), name);
  }
  // These patterns come only from the built-in table, never URL arguments.
  const latin = words.join("|").replace(/ /g, "[\\s_-]*");
  return { name, flag, regex: new RegExp(local + "|(?:^|[^a-z])(?:" + latin + ")(?=$|[^a-z])", "i") };
});
const requestedCountryOrder = parseCountryOrder(
  typeof $arguments === "object" && $arguments ? $arguments.countryorder : undefined,
);

function parseCountryOrder(value) {
  if (typeof value !== "string") return [];
  // Commas or > delimit entries; spaces remain valid inside English names.
  const aliases = value.split(/[,>]/).map(normalizeCountryAlias);
  return [...new Set(aliases.map((alias) => SORT_COUNTRY_ALIASES.get(alias)).filter(Boolean))];
}

function classifySortCountry(value) {
  const name = String(value == null ? "" : value);
  // Prefer an explicit flag; otherwise use a fixed classification order.
  const flagged = SORT_COUNTRY_MATCHERS.find((entry) => name.includes(entry.flag));
  if (flagged) return flagged.name;
  const matched = SORT_COUNTRY_MATCHERS.find((entry) => entry.regex.test(name));
  return matched ? matched.name : null;
}

function sortByCountry(items, getCountry) {
  if (!requestedCountryOrder.length) return items.slice();
  return items
    .map((item, index) => {
      const rank = requestedCountryOrder.indexOf(getCountry(item));
      return { item, index, rank: rank < 0 ? requestedCountryOrder.length : rank };
    })
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map(({ item }) => item);
}
// END COUNTRY ORDER

const FAKE_REMAINING_BYTES = 10 * 1024 * 1024;
const FAKE_EXPIRE_TIMESTAMP = 915148800;
const TRAFFIC_NODE_PATTERN = /(剩余流量|流量剩余|套餐流量|已用流量|流量重置|重置日|到期时间|套餐到期|过期时间|订阅到期|更新订阅|订阅更新|官方网站|官网|防丢|下次重置|\b(?:traffic|usage|expire[sd]?|remaining|used|total)\b\s*[:：])/i;
const FAKE_ACCOUNT_NODES = [
  {
    name: "剩余流量：10 MB",
    type: "http",
    server: "127.0.0.1",
    port: 1,
    udp: false
  },
  {
    name: "到期时间：1999-01-01",
    type: "http",
    server: "127.0.0.1",
    port: 2,
    udp: false
  }
];

function setFakeSubscriptionInfo() {
  if (typeof $options !== "object" || !$options) return;
  if (!$options._res || typeof $options._res !== "object") $options._res = {};
  if (!$options._res.headers || typeof $options._res.headers !== "object") {
    $options._res.headers = {};
  }
  $options._res.headers["subscription-userinfo"] = [
    "upload=0",
    "download=8388608",
    "total=" + FAKE_REMAINING_BYTES,
    "expire=" + FAKE_EXPIRE_TIMESTAMP
  ].join("; ");
  $options._res.headers["profile-web-page-url"] = null;
  $options._res.headers["plan-name"] = null;
}

function operator(proxies = [], targetPlatform, context) {
  setFakeSubscriptionInfo();
  const input = Array.isArray(proxies) ? proxies : [];
  const realNodes = input.filter((proxy) => {
    const name = proxy && proxy.name != null ? String(proxy.name) : "";
    return !TRAFFIC_NODE_PATTERN.test(name);
  });
  const output = sortByCountry(realNodes, (proxy) =>
    classifySortCountry(proxy && proxy.name != null ? String(proxy.name) : "")
  ).concat(
    FAKE_ACCOUNT_NODES.map((proxy) => Object.assign({}, proxy))
  );
  if (typeof $substore === "object" && $substore && typeof $substore.info === "function") {
    $substore.info(
      "iOS adapter: input=" + input.length +
      ", output=" + output.length +
      ", removed=" + (input.length - realNodes.length) +
      ", fake-account-nodes=" + FAKE_ACCOUNT_NODES.length
    );
  }
  return output;
}
