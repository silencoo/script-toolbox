import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");
const ruleLines = (text) => text.split(/\r?\n/).map((line) => line.trim())
  .filter((line) => line && !/^(?:#|;|\/\/)/.test(line));
const template = await read("templates/quantumult-x.conf");
const remoteSection = template.split("[filter_remote]")[1].split("[rewrite_remote]")[0];
const remotes = ruleLines(remoteSection).map((line) => {
  const [url, ...fields] = line.split(",").map((field) => field.trim());
  const options = Object.fromEntries(fields.map((field) => {
    const index = field.indexOf("=");
    return [field.slice(0, index), field.slice(index + 1)];
  }));
  return { url, options };
}).filter(({ options }) => options.enabled !== "false");

// Deliberately small host-rule evaluator for offline regression fixtures, not
// an implementation of Quantumult X's IP/DNS or local/inserted-resource engine.
function firstHostRule(rules, host) {
  return rules.find(([type, value]) => type === "HOST" ? host === value :
    type === "HOST-SUFFIX" && (host === value || host.endsWith(`.${value}`)));
}

// Exact shared endpoints from OpenAI's network recommendations. A hostname
// match necessarily applies to other sites using that same endpoint too.
const sharedEndpoints = [
  "challenges.cloudflare.com",
  "cdn.workos.com",
  "forwarder.workos.com",
  "frontend-apps-multi-region.workos.com",
  "setup.workos.com",
  "images.workoscdn.com",
  "workos.imgix.net",
];
const services = [
  {
    name: "OpenAI",
    source: "openai.rules",
    hosts: [
      "api.openai.com", "auth.openai.com", "chatgpt.com", "ws.chatgpt.com",
      "sora.chatgpt.com", "cdn.oaistatic.com", "persistent.oaistatic.com",
      "files.oaiusercontent.com", "web-sandbox.oaiusercontent.com",
      "oaistatsig.com", "ab.chatgpt.oaistatsig.com", "cdn.openaimerge.com",
      "chat.openai.com.cdn.cloudflare.net", "openai-api.arkoselabs.com",
      "openaicom-api-bdcpf8c6d2e9atf6.z01.azurefd.net",
      "openaicomproductionae4b.blob.core.windows.net",
      "production-openaicom-storage.azureedge.net",
      "openaiapi-site.azureedge.net", "openaicom.imgix.net",
      "chatgpt.livekit.cloud", ...sharedEndpoints,
    ],
  },
  {
    name: "Claude",
    source: "claude.rules",
    hosts: [
      "anthropic.com", "api.anthropic.com", "a-cdn.anthropic.com",
      "s-cdn.anthropic.com", "www-cdn.anthropic.com", "assets-proxy.anthropic.com",
      "claude.ai", "claude.com", "platform.claude.com",
      "claudeusercontent.com", "example.frame.claudeusercontent.com",
    ],
  },
];
const serviceRules = new Map();

for (const { name, source, hosts } of services) {
  const canonical = ruleLines(await read(`sources/${source}`));
  const output = await read(`rules/quantumultx/${name}.list`);
  const lines = ruleLines(output);
  const rules = lines.map((line) => line.split(","));
  serviceRules.set(name, rules);

  test(`${name}: Quantumult X exactly mirrors the shared Clash source`, () => {
    const typeMap = { DOMAIN: "HOST", "DOMAIN-SUFFIX": "HOST-SUFFIX" };
    const expected = canonical.map((line) => {
      const fields = line.split(",");
      assert.equal(fields.length, 2, line);
      const [type, value] = fields;
      assert.ok(typeMap[type], `Unsupported rule type: ${type}`);
      return `${typeMap[type]},${value},AI`;
    });
    assert.deepEqual(lines, expected);
    assert.equal(new Set(lines).size, lines.length, "Duplicate rules");
    assert.match(output, new RegExp(`^# TOTAL: ${lines.length}$`, "m"));
  });

  test(`${name}: assets, APIs and session endpoints route to AI`, () => {
    for (const host of hosts) {
      assert.equal(firstHostRule(rules, host)?.[2], "AI", host);
    }
  });

  test(`${name}: excludes unrelated tenants and lookalike hostnames`, () => {
    for (const host of [
      "unrelated.cloudflare.com", "unrelated.cloudflare.net",
      "unrelated.azureedge.net", "unrelated.azurefd.net",
      "unrelated.blob.core.windows.net", "unrelated.imgix.net",
      "unrelated.workos.com", "unrelated.workoscdn.com",
      "unrelated.arkoselabs.com", "unrelated.livekit.cloud",
      "unrelated.amazonaws.com", "unrelated.stripe.com", "unrelated.sentry.io",
      "events.statsigapi.net", "events.launchdarkly.com", "featuregates.org",
      "sora-cdn.com", "sorausercontent.com",
      ...hosts.map((host) => `${host}.example.org`),
      ...canonical.filter((line) => line.startsWith("DOMAIN-SUFFIX,"))
        .map((line) => `not${line.split(",")[1]}`),
    ]) {
      assert.equal(firstHostRule(rules, host), undefined, host);
    }
  });

  test(`${name}: one enabled native resource before broad remote fallbacks`, () => {
    const matches = remotes.filter(({ options }) => options.tag === name);
    assert.equal(matches.length, 1);
    const entry = matches[0];
    assert.equal(entry.url,
      `https://raw.githubusercontent.com/silencoo/script-toolbox/main/proxy-rules/rules/quantumultx/${name}.list`);
    assert.equal(entry.options.enabled, "true");
    assert.equal(entry.options["opt-parser"], "false");
    assert.equal(entry.options["force-policy"], undefined, "Keep the embedded AI policy");
    assert.equal(entry.options["inserted-resource"], undefined,
      "Do not silently override local filter priority");
    const index = remotes.indexOf(entry);
    assert.ok(index > remotes.findIndex(({ options }) => options.tag === "Gemini"));
    for (const tag of ["Ad Blocking", "YouTube", "AI Models", "GitHub", "Docker",
      "Rule Fixes", "Apple Services", "China Sites", "Global Media"]) {
      assert.ok(remotes.findIndex(({ options }) => options.tag === tag) > index, tag);
    }
  });
}

test("new shared service exceptions are exact hosts, not provider-wide suffixes", () => {
  const rules = serviceRules.get("OpenAI");
  for (const host of ["cdn.openaimerge.com", ...sharedEndpoints]) {
    assert.deepEqual(firstHostRule(rules, host), ["HOST", host, "AI"]);
    assert.equal(firstHostRule(rules, `child.${host}`), undefined, host);
  }
});

test("Gemini stays first and Ads retains mixed policies without force-policy", () => {
  assert.equal(remotes[0].options.tag, "Gemini");
  const ads = remotes.find(({ options }) => options.tag === "Ad Blocking");
  assert.ok(ads);
  assert.equal(ads.options["force-policy"], undefined);
  assert.equal(ads.options["opt-parser"], "false");
});

test("AI hosts win modeled remote overlaps while unrelated CDN traffic keeps its fallback", () => {
  // Simulate a future upstream allow/block or CDN overlap using the template's
  // actual order and the actual generated AI resources. No network dependency.
  for (const fallbackPolicy of ["direct", "Ad Blocking", "CDN"]) {
    const fallbacks = ["openai.com", "oaistatic.com", "oaiusercontent.com",
      "oaistatsig.com", "openaimerge.com", "anthropic.com", "claude.com",
      "claudeusercontent.com", "cloudflare.com", "workos.com", "workoscdn.com",
      "azureedge.net", "azurefd.net", "imgix.net"]
      .map((domain) => ["HOST-SUFFIX", domain, fallbackPolicy]);
    const orderedRules = remotes.flatMap(({ options }) =>
      serviceRules.get(options.tag) || (options.tag === "Ad Blocking" ? fallbacks : []));
    for (const { hosts } of services) {
      for (const host of hosts) {
        assert.equal(firstHostRule(orderedRules, host)?.[2], "AI", `${host}: ${fallbackPolicy}`);
      }
    }
    for (const host of ["unrelated.cloudflare.com", "unrelated.workos.com",
      "unrelated.azureedge.net", "unrelated.imgix.net"]) {
      assert.equal(firstHostRule(orderedRules, host)?.[2], fallbackPolicy, host);
    }
  }
});
