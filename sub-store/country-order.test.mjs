import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const sources = Object.fromEntries(await Promise.all(
  ["ios-adapter", "convert-v2"].map(async (name) => [name,
    await readFile(new URL(`./${name}.js`, import.meta.url), "utf8")]),
));
const locations = [
  ["jp", "Japan", "東京"], ["us", "United States", "洛杉矶"],
  ["tw", "Taiwan", "台北"], ["sg", "Singapore", "狮城"],
  ["hk", "Hong Kong", "香港"], ["kr", "South Korea", "首尔"],
  ["de", "Germany", "法兰克福"], ["gb", "United Kingdom", "伦敦"],
  ["cn", "China", "上海"], ["mo", "Macau", "澳门"],
  ["au", "Australia", "悉尼"], ["ca", "Canada", "多伦多"],
  ["fr", "France", "巴黎"], ["nl", "Netherlands", "阿姆斯特丹"],
  ["ru", "Russia", "莫斯科"], ["in", "India", "印度"],
  ["id", "Indonesia", "印度尼西亚"], ["my", "Malaysia", "吉隆坡"],
  ["th", "Thailand", "曼谷"], ["vn", "Vietnam", "河内"],
  ["ph", "Philippines", "马尼拉"], ["ae", "United Arab Emirates", "迪拜"],
  ["it", "Italy", "罗马"], ["es", "Spain", "马德里"],
  ["ch", "Switzerland", "苏黎世"], ["se", "Sweden", "斯德哥尔摩"],
  ["fi", "Finland", "赫尔辛基"], ["pl", "Poland", "华沙"],
  ["no", "Norway", "奥斯陆"], ["ie", "Ireland", "都柏林"],
  ["nz", "New Zealand", "奥克兰"], ["br", "Brazil", "圣保罗"],
  ["ar", "Argentina", "阿根廷"], ["cl", "Chile", "智利"],
  ["mx", "Mexico", "墨西哥"], ["at", "Austria", "维也纳"],
  ["be", "Belgium", "比利时"], ["dk", "Denmark", "哥本哈根"],
  ["pt", "Portugal", "里斯本"], ["cz", "Czechia", "捷克"],
  ["hu", "Hungary", "布达佩斯"], ["ro", "Romania", "罗马尼亚"],
  ["bg", "Bulgaria", "保加利亚"], ["gr", "Greece", "雅典"],
  ["tr", "Turkey", "土耳其"], ["il", "Israel", "以色列"],
  ["sa", "Saudi Arabia", "沙特"], ["za", "South Africa", "南非"],
  ["ua", "Ukraine", "基辅"], ["lu", "Luxembourg", "卢森堡"],
  ["is", "Iceland", "冰岛"], ["ee", "Estonia", "塔林"],
  ["lv", "Latvia", "里加"], ["lt", "Lithuania", "立陶宛"],
  ["pk", "Pakistan", "巴基斯坦"], ["bd", "Bangladesh", "孟加拉"],
  ["np", "Nepal", "加德满都"], ["kh", "Cambodia", "金边"],
  ["lk", "Sri Lanka", "斯里兰卡"], ["kz", "Kazakhstan", "哈萨克斯坦"],
];

function load(name, args) {
  const context = vm.createContext(args === undefined ? {} : { $arguments: args });
  vm.runInContext(sources[name], context);
  return {
    run: (proxies) => name === "ios-adapter"
      ? { proxies: context.operator(proxies) }
      : context.main({ proxies }),
    context,
  };
}
const nodes = (names) => names.map((name, index) => ({ name, type: "ss", port: 10000 + index }));
const names = (proxies) => Array.from(proxies, (proxy) => proxy.name);
const realNames = (profile) => names(profile.proxies).filter((name) =>
  !name.startsWith("剩余流量：") && !name.startsWith("到期时间："));
const withoutFlags = (value) => value.replace(/[\u{1F1E6}-\u{1F1FF}]/gu, "").trim();

test("standalone scripts keep the same country ordering implementation", () => {
  const block = (source) => source.match(/\/\/ BEGIN COUNTRY ORDER[\s\S]*?\/\/ END COUNTRY ORDER/)[0];
  assert.equal(block(sources["ios-adapter"]), block(sources["convert-v2"]));
});

for (const script of Object.keys(sources)) {
  test(`${script}: sorts all 60 locations using codes, names, flags and local names`, () => {
    for (const [code, english, local] of locations) {
      const flag = String.fromCodePoint(...Array.from(code.toUpperCase(), (c) => c.charCodeAt(0) + 127397));
      const samples = [`${code.toUpperCase()}-02`, `${english} 01`, `${flag} 03`, `${local} 04`];
      for (const preference of [code, english]) {
        const { run } = load(script, { countryorder: preference });
        const result = realNames(run(nodes(["Unknown 01", ...samples]))).map(withoutFlags);
        assert.deepEqual(result, [...samples, "Unknown 01"].map(withoutFlags), `${script}: ${preference}`);
      }
    }
  });

  test(`${script}: mixed aliases sort stably with unlisted nodes last`, () => {
    const inputNames = ["Unknown 01", "India 02", "Germany 02", "Netherlands 02",
      "JP-02", "DE-01", "🇭🇰 01", "US-01", "SG-01", "JP-01", "IN-01", "FR-01"];
    const input = nodes(inputNames);
    const before = structuredClone(input);
    const { run } = load(script, { countryorder: " JP,us,hk,sg,Netherlands, GERMANY ,India,jp,invalid," });
    assert.deepEqual(realNames(run(input)), ["JP-02", "JP-01", "US-01", "🇭🇰 01", "SG-01",
      "Netherlands 02", "Germany 02", "DE-01", "India 02", "IN-01", "Unknown 01", "FR-01"]);
    assert.deepEqual(input, before);
  });

  test(`${script}: omitted, empty and invalid orders preserve existing node order`, () => {
    const input = nodes(["SG-02", "DE-01", "Unknown 01", "JP-01"]);
    for (const args of [undefined, {}, { countryorder: "" }, { countryorder: true },
      { countryorder: "__proto__,constructor,invalid" }, { countryorder: "off" }]) {
      assert.deepEqual(realNames(load(script, args).run(input)), names(input));
    }
  });

  test(`${script}: does not confuse country substrings or overlapping Chinese names`, () => {
    const input = nodes(["Premium", "inside", "standard", "印度尼西亚 01", "罗马尼亚 01",
      "India 01", "Italy 01", "🇳🇱 Germany 01"]);
    const { run } = load(script, { countryorder: "in,it,nl,ro,id" });
    assert.deepEqual(realNames(run(input)), ["India 01", "Italy 01", "🇳🇱 Germany 01",
      "罗马尼亚 01", "印度尼西亚 01", "Premium", "inside", "standard"]);
  });

  test(`${script}: accepts full names with spaces and common aliases`, () => {
    const { run } = load(script, { countryorder: "UK>United States>South_Korea>UAE>Czech Republic" });
    assert.deepEqual(realNames(run(nodes(["Czechia 01", "🇦🇪 01", "KR-01", "US-01", "GB-01"]))),
      ["GB-01", "US-01", "KR-01", "🇦🇪 01", "Czechia 01"]);
  });
}

test("v2 orders country references while keeping policy slots, filters and node pools", () => {
  const { run } = load("convert-v2", { countryorder: "jp,us,hk,sg,nl,de,in" });
  const profile = run(nodes(["SG-01", "DE-01", "JP-02", "HK-01", "US-01", "JP-01", "TW-01",
    "[pro] Germany 01", "[pro] Netherlands 01", "[pro] India 01", "NL-01", "IN-01", "剩余流量：1 GB"]));
  const groups = new Map(profile["proxy-groups"].map((group) => [group.name, group]));
  assert.deepEqual(Array.from(groups.get("Proxies").proxies.slice(0, 6)),
    ["Auto", "Japan", "United States", "Hong Kong", "Singapore", "Taiwan"]);
  assert.deepEqual(Array.from(groups.get("Auto").proxies).map(withoutFlags),
    ["JP-02", "JP-01", "US-01", "HK-01", "SG-01", "NL-01", "DE-01", "IN-01", "TW-01"]);
  assert.deepEqual(Array.from(groups.get("AI").proxies.slice(0, 3)),
    ["[pro] Netherlands 01", "[pro] Germany 01", "[pro] India 01"]);
  assert.deepEqual(Array.from(groups.get("Gemini").proxies),
    ["Japan", "Proxies", "Auto", "United States", "Singapore", "Taiwan", "Fallback", "Direct"]);
  assert.deepEqual(Array.from(groups.get("Bilibili").proxies), ["Direct", "Hong Kong", "Taiwan", "Fallback"]);
  assert.deepEqual(Array.from(groups.get("Account Info").proxies), ["剩余流量：1 GB"]);
  assert.ok(!groups.has("Netherlands")); // Sorting does not introduce new routing groups.
  const validRefs = new Set([...names(profile.proxies), ...groups.keys(), "DIRECT", "REJECT", "REJECT-DROP"]);
  for (const group of groups.values()) {
    for (const ref of group.proxies) assert.ok(validRefs.has(ref), `${group.name}: ${ref}`);
  }
});

test("iOS keeps replacement account nodes last and subscription headers intact", () => {
  const { run, context } = load("ios-adapter", { countryorder: "de,nl,in" });
  context.$options = {};
  const result = run(nodes(["India 01", "剩余流量：1 GB", "Netherlands 01", "Germany 01"]));
  assert.deepEqual(names(result.proxies), ["Germany 01", "Netherlands 01", "India 01",
    "剩余流量：10 MB", "到期时间：1999-01-01"]);
  assert.match(context.$options._res.headers["subscription-userinfo"], /total=10485760/);
});

test("v2 preference changes preserve country membership and load-balance configuration", () => {
  const input = nodes(["US to Japan", "US-01", "HK-01", "SG-01", "DE-01", "NL-01"]);
  for (const loadbalance of [false, true]) {
    const profile = load("convert-v2", { countryorder: "sg,hk,us,jp,de,nl", loadbalance }).run(input);
    const groups = new Map(profile["proxy-groups"].map((group) => [group.name, group]));
    assert.deepEqual(Array.from(groups.get("Japan").proxies), ["US to Japan"]);
    assert.deepEqual(Array.from(groups.get("United States").proxies), ["US-01"]);
    assert.deepEqual(Array.from(groups.get("Auto").proxies),
      ["SG-01", "HK-01", "US-01", "US to Japan", "DE-01", "NL-01"]);
    assert.equal(groups.get("Japan").type, loadbalance ? "load-balance" : "url-test");
    if (loadbalance) assert.equal(groups.get("Japan").strategy, "consistent-hashing");
  }
});
