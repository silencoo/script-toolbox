import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

async function loadConverter(args = {}) {
  const source = await readFile(new URL("./convert-v2.js", import.meta.url), "utf8");
  const context = vm.createContext({ $arguments: args });
  vm.runInContext(`${source}\n;globalThis.__convertV2Main = main;`, context);
  return context.__convertV2Main;
}

const officialGeminiHosts = [
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

test("keeps Quantumult X and convert-v2 official Gemini hosts aligned", async () => {
  const source = await readFile(
    new URL("../proxy-rules/sources/gemini.rules", import.meta.url),
    "utf8",
  );
  const sourceRules = new Set(
    source
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean),
  );

  for (const host of officialGeminiHosts) {
    assert.ok(sourceRules.has(`DOMAIN,${host}`));
  }
});

test("keeps Gemini isolated while general Google traffic stays normal", async () => {
  const convert = await loadConverter();
  const profile = convert({
    proxies: [
      { name: "[grok] Residential AI", type: "ss" },
      { name: "Japan Node", type: "ss" },
      { name: "Singapore Node", type: "ss" },
      { name: "United States Node", type: "ss" },
      { name: "Taiwan Node", type: "ss" },
      { name: "Hong Kong Node", type: "ss" },
    ],
  });

  const groups = new Map(
    profile["proxy-groups"].map((group) => [group.name, group]),
  );
  assert.ok(groups.has("AI"));
  assert.ok(groups.has("Gemini"));
  assert.ok(groups.get("AI").proxies.includes("[grok] Residential AI"));
  assert.deepEqual(Array.from(groups.get("Gemini").proxies), [
    "Proxies",
    "Auto",
    "Japan",
    "Singapore",
    "United States",
    "Taiwan",
    "Fallback",
    "Direct",
  ]);
  assert.ok(!groups.get("Gemini").proxies.includes("Hong Kong"));
  assert.ok(!groups.get("Gemini").proxies.includes("[grok] Residential AI"));

  for (const name of [
    "Japan",
    "Singapore",
    "United States",
    "Taiwan",
    "Hong Kong",
  ]) {
    const group = groups.get(name);
    assert.equal(group.url, "https://www.gstatic.com/generate_204");
    assert.equal(group.interval, 600);
    assert.equal(group.tolerance, 100);
    assert.equal(group.lazy, true);
    assert.equal(group.timeout, 5000);
    assert.equal(group["max-failed-times"], 3);
    assert.equal(group["expected-status"], 204);
  }

  assert.equal(groups.get("Auto").interval, 1800);
  assert.equal(groups.get("Fallback").interval, 300);
  for (const name of ["Auto", "Fallback"]) {
    const group = groups.get(name);
    assert.equal(group.url, "https://www.gstatic.com/generate_204");
    assert.equal(group.tolerance, 100);
    assert.equal(group.lazy, true);
    assert.equal(group.timeout, 5000);
    assert.equal(group["max-failed-times"], 3);
    assert.equal(group["expected-status"], 204);
  }

  const gemini = profile.rules.indexOf("DOMAIN,gemini.google.com,Gemini");
  const google = profile.rules.indexOf("DOMAIN-SUFFIX,google.com,Google");
  const staticGemini = profile.rules.indexOf("DOMAIN,t3.gstatic.com,Gemini");
  const staticGoogle = profile.rules.indexOf("DOMAIN-SUFFIX,gstatic.com,Google");
  const geminiYouTube = profile.rules.indexOf("DOMAIN,www.youtube.com,Gemini");
  const generalYouTube = profile.rules.indexOf(
    "DOMAIN-SUFFIX,youtube.com,YouTube",
  );
  const adRules = profile.rules.indexOf("RULE-SET,ADBlock,AdBlock");

  assert.ok(gemini >= 0 && gemini < google);
  assert.ok(staticGemini >= 0 && staticGemini < staticGoogle);
  assert.ok(geminiYouTube >= 0 && geminiYouTube < generalYouTube);
  assert.ok(gemini >= 0 && gemini < adRules);
  for (const host of officialGeminiHosts) {
    assert.ok(profile.rules.includes(`DOMAIN,${host},Gemini`));
  }
  assert.ok(profile.rules.includes("DOMAIN-SUFFIX,perplexity.ai,AI"));
  assert.ok(profile.rules.includes("DOMAIN,copilot.microsoft.com,AI"));
  assert.ok(profile.rules.includes("DOMAIN-SUFFIX,grok.com,AI"));
  assert.ok(profile.rules.includes("GEOSITE,CATEGORY-AI-!CN,AI"));
  assert.equal(profile["rule-providers"].PrivateTracker.behavior, "classical");
  assert.ok(profile.rules.includes("RULE-SET,PrivateTracker,Direct"));
});

test("allows periodic URL tests to be tuned or disabled", async () => {
  const convert = await loadConverter({
    urltestinterval: "0",
    urltesttolerance: "50",
    urltestlazy: "false",
  });
  const profile = convert({
    proxies: [{ name: "Japan Node", type: "ss" }],
  });
  const groups = new Map(
    profile["proxy-groups"].map((group) => [group.name, group]),
  );

  for (const name of ["Auto", "Fallback", "Japan"]) {
    assert.equal(groups.get(name).interval, 0);
    assert.equal(groups.get(name).tolerance, 50);
    assert.equal(groups.get(name).lazy, false);
  }
});

test("allows each URL-test group class to use its own interval", async () => {
  const convert = await loadConverter({
    autotestinterval: "2400",
    countrytestinterval: "900",
    fallbacktestinterval: "600",
  });
  const profile = convert({
    proxies: [{ name: "Japan Node", type: "ss" }],
  });
  const groups = new Map(
    profile["proxy-groups"].map((group) => [group.name, group]),
  );

  assert.equal(groups.get("Auto").interval, 2400);
  assert.equal(groups.get("Japan").interval, 900);
  assert.equal(groups.get("Fallback").interval, 600);
});
