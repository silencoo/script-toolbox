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

test("keeps Google AI isolated while general Google traffic stays normal", async () => {
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
  assert.ok(groups.has("Google AI"));
  assert.ok(groups.get("AI").proxies.includes("[grok] Residential AI"));
  assert.deepEqual(Array.from(groups.get("Google AI").proxies), [
    "Proxies",
    "Auto",
    "Japan",
    "Singapore",
    "United States",
    "Taiwan",
    "Fallback",
    "Direct",
  ]);
  assert.ok(!groups.get("Google AI").proxies.includes("Hong Kong"));
  assert.ok(
    !groups.get("Google AI").proxies.includes("[grok] Residential AI"),
  );

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

  const gemini = profile.rules.indexOf("DOMAIN-SUFFIX,gemini.google.com,Google AI");
  const google = profile.rules.indexOf("DOMAIN-SUFFIX,google.com,Google");
  const staticGoogleAI = profile.rules.indexOf("DOMAIN,t3.gstatic.com,Google AI");
  const staticGoogle = profile.rules.indexOf("DOMAIN-SUFFIX,gstatic.com,Google");

  assert.ok(gemini >= 0 && gemini < google);
  assert.ok(staticGoogleAI >= 0 && staticGoogleAI < staticGoogle);
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
