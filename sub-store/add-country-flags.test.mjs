import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(
  new URL("./add-country-flags.js", import.meta.url),
  "utf8",
);

function loadOperator(contextValues = {}) {
  const context = vm.createContext(contextValues);
  vm.runInContext(`${source}\n;globalThis.__operator = operator;`, context);
  return { context, operator: context.__operator };
}

test("adds flags to the supported country names in one subscription", () => {
  const { operator } = loadOperator();
  const cases = [
    ["台湾 01", "🇹🇼"],
    ["SG-02", "🇸🇬"],
    ["Japan Tokyo", "🇯🇵"],
    ["United States 04", "🇺🇸"],
    ["韩国-05", "🇰🇷"],
    ["DE_Frankfurt_06", "🇩🇪"],
    ["United_Kingdom_07", "🇬🇧"],
    ["Hong Kong 08", "🇭🇰"],
    ["中国 上海 09", "🇨🇳"],
    ["Macau 10", "🇲🇴"],
    ["Australia Sydney 11", "🇦🇺"],
    ["Canada Toronto 12", "🇨🇦"],
    ["France Paris 13", "🇫🇷"],
    ["Netherlands Amsterdam 14", "🇳🇱"],
    ["Russia Moscow 15", "🇷🇺"],
    ["India Mumbai 16", "🇮🇳"],
    ["Indonesia Jakarta 17", "🇮🇩"],
    ["Malaysia 18", "🇲🇾"],
    ["Thailand Bangkok 19", "🇹🇭"],
    ["Vietnam Hanoi 20", "🇻🇳"],
    ["Philippines Manila 21", "🇵🇭"],
    ["UAE Dubai 22", "🇦🇪"],
    ["Italy Milan 23", "🇮🇹"],
    ["Spain Madrid 24", "🇪🇸"],
    ["Switzerland Zurich 25", "🇨🇭"],
    ["Sweden Stockholm 26", "🇸🇪"],
    ["Finland Helsinki 27", "🇫🇮"],
    ["Poland Warsaw 28", "🇵🇱"],
    ["Norway Oslo 29", "🇳🇴"],
    ["Ireland Dublin 30", "🇮🇪"],
  ];
  const proxies = cases.map(([name]) => ({ name, type: "ss" }));

  assert.deepEqual(
    Array.from(operator(proxies), (proxy) => proxy.name),
    cases.map(([name, flag]) => `${flag} ${name}`),
  );
});

test("normalizes existing flags without duplicating them", () => {
  const { operator } = loadOperator();
  const output = operator([
    { name: "🇹🇼 台湾 01", type: "ss" },
    { name: "🇯🇵 台湾 02", type: "ss" },
    { name: "🇹🇼 🇹🇼 Taiwan 03", type: "ss" },
    { name: "🇹🇼 04", type: "ss" },
  ]);

  assert.deepEqual(
    Array.from(output, (proxy) => proxy.name),
    ["🇹🇼 台湾 01", "🇹🇼 台湾 02", "🇹🇼 Taiwan 03", "🇹🇼 04"],
  );
});

test("leaves unknown nodes and their other fields unchanged", () => {
  const { operator } = loadOperator();
  const unknown = {
    name: "Premium Node 01",
    type: "vless",
    server: "node.example.com",
    port: 443,
  };
  const output = operator([unknown]);

  assert.equal(output[0], unknown);
  assert.deepEqual(JSON.parse(JSON.stringify(output[0])), unknown);
});

test("does not treat country-code substrings as standalone regions", () => {
  const { operator } = loadOperator();
  const names = [
    "Campus Premium",
    "Music Server",
    "Business Line",
    "English Node",
    "Canadair Test",
  ];
  const output = operator(names.map((name) => ({ name, type: "ss" })));

  assert.deepEqual(
    Array.from(output, (proxy) => proxy.name),
    names,
  );
});

test("supports Sub-Store single-node shortcut-script mode", () => {
  const server = { name: "日本 01", type: "ss" };
  loadOperator({ $server: server });
  assert.equal(server.name, "🇯🇵 日本 01");
});
