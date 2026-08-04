import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

async function loadConverter() {
  const source = await readFile(new URL("./convert-v2.js", import.meta.url), "utf8");
  const context = vm.createContext({ $arguments: {} });
  vm.runInContext(`${source}\n;globalThis.__convertV2Main = main;`, context);
  return context.__convertV2Main;
}

test("keeps Google AI isolated while general Google traffic stays normal", async () => {
  const convert = await loadConverter();
  const profile = convert({
    proxies: [
      { name: "[grok] Residential AI", type: "ss" },
      { name: "Japan Standard", type: "ss" },
    ],
  });

  const groups = new Map(profile["proxy-groups"].map((group) => [group.name, group]));
  assert.ok(groups.has("AI"));
  assert.ok(groups.has("Google AI"));
  assert.ok(groups.get("AI").proxies.includes("[grok] Residential AI"));
  assert.ok(groups.get("Google AI").proxies.includes("[grok] Residential AI"));

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
