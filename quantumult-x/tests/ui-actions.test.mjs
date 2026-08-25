import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";

const ROOT = path.resolve(import.meta.dirname, "../..");
const SCRIPT_DIR = path.join(ROOT, "quantumult-x");

const SCRIPT_FILES = [
  "StreamingCheck-QX.js",
  "ExitIPCheck-QX.js",
  "GoogleLocation-QX.js",
  "NodeBenchmark-QX.js"
];

test("all Quantumult X UIActions parse as JavaScript", async () => {
  for (const file of SCRIPT_FILES) {
    const source = await readFile(path.join(SCRIPT_DIR, file), "utf8");
    assert.doesNotThrow(() => new vm.Script(source, { filename: file }), file);
  }
});

test("UIActions finish once and emit native-popup-safe linear HTML", async () => {
  for (const file of SCRIPT_FILES) {
    const result = await runUiAction(file);
    assert.equal(result.doneCount, 1, `${file} called $done more than once`);
    assert.equal(typeof result.output.htmlMessage, "string", `${file} did not emit htmlMessage`);
    assert.match(result.output.htmlMessage, /<p\b/i, `${file} did not emit readable paragraphs`);
    assert.doesNotMatch(result.output.htmlMessage, /<table\b/i, `${file} uses a fragile table layout`);
    assert.doesNotMatch(result.output.htmlMessage, /display\s*:\s*flex/i, `${file} uses unsupported flex layout`);
    assert.doesNotMatch(result.output.htmlMessage, /background\s*:/i, `${file} uses popup background cards`);
  }
});

test("profile template exposes the four repository-owned raw UIAction URLs", async () => {
  const profile = await readFile(path.join(ROOT, "proxy-rules/templates/quantumult-x.conf"), "utf8");
  const taskLocal = profile.split("[task_local]")[1].split("[http_backend]")[0];
  const actionLines = taskLocal.split("\n").filter(line => line.startsWith("event-interaction "));

  assert.equal(actionLines.length, 4);
  for (const file of SCRIPT_FILES) {
    assert.match(taskLocal, new RegExp("raw\\.githubusercontent\\.com/silencoo/script-toolbox/main/quantumult-x/" + file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.doesNotMatch(taskLocal, /KOP-XIAO|ddgksf2013\.top|net-lsp-x/);
});

async function runUiAction(file) {
  const source = await readFile(path.join(SCRIPT_DIR, file), "utf8");
  let doneCount = 0;
  let output;
  let resolveDone;
  const donePromise = new Promise(resolve => { resolveDone = resolve; });

  const context = vm.createContext({
    console: { log() {}, error() {}, warn() {} },
    $environment: {
      params: "Test Policy",
      executeType: 1,
      sourcePath: "https://example.invalid/" + file
    },
    $task: { fetch: mockFetch },
    $configuration: { sendMessage: mockConfiguration },
    $done(value = {}) {
      doneCount += 1;
      output = value;
      resolveDone();
    },
    setTimeout(callback) {
      queueMicrotask(callback);
      return 1;
    },
    clearTimeout() {},
    Promise,
    JSON,
    Math,
    Date,
    Number,
    String,
    Object,
    Array,
    RegExp,
    Error,
    isFinite,
    decodeURIComponent,
    encodeURIComponent
  });

  new vm.Script(source, { filename: file }).runInContext(context);
  await Promise.race([
    donePromise,
    new Promise((_, reject) => globalThis.setTimeout(() => reject(new Error(`${file} timed out`)), 3000))
  ]);
  await new Promise(resolve => globalThis.setTimeout(resolve, 10));
  return { doneCount, output };
}

async function mockConfiguration(message) {
  if (message.action === "get_policy_state") {
    return { ret: { "Test Policy": ["Test Node"] } };
  }
  return { ret: {} };
}

async function mockFetch(request) {
  const url = String(request.url || "");

  if (url.includes("speed.cloudflare.com/meta")) {
    return response(200, JSON.stringify({
      clientIp: "203.0.113.10",
      asn: 64500,
      asOrganization: "Example Network",
      colo: "SIN",
      country: "SG",
      city: "Singapore",
      region: "Singapore",
      httpProtocol: "HTTP/2"
    }));
  }
  if (url.includes("speed.cloudflare.com/cdn-cgi/trace")) {
    return response(200, "ip=203.0.113.10\nloc=SG\ncolo=SIN\nhttp=h2\n");
  }
  if (url.includes("speed.cloudflare.com/__down") || url.includes("speed.cloudflare.com/__up")) {
    return response(200, "ok");
  }
  if (url.includes("my.ippure.com")) {
    return response(200, JSON.stringify({
      ip: "203.0.113.10",
      asn: 64500,
      asOrganization: "Example Network",
      countryCode: "SG",
      region: "Singapore",
      city: "Singapore",
      fraudScore: 9,
      isResidential: true,
      isBroadcast: false
    }));
  }
  if (url.includes("netflix.com/title")) {
    return response(200, "", { "X-Originating-URL": "https://www.netflix.com/sg-en/title/81280792" });
  }
  if (url.includes("youtube.com/premium")) return response(200, '{"GL":"SG"}');
  if (url.includes("disney.api.edge.bamgrid.com")) {
    return response(200, JSON.stringify({
      extensions: { sdk: { session: { inSupportedLocation: true, location: { countryCode: "SG" } } } }
    }));
  }
  if (url.includes("startup.core.indazn.com")) return response(200, '{"GeolocatedCountry":"SG"}');
  if (url.includes("paramountplus.com")) return response(200, "ok");
  if (url.includes("discoveryplus.com/token")) {
    return response(200, JSON.stringify({ data: { attributes: { token: "test-token" } } }));
  }
  if (url.includes("discoveryplus.com/users/me")) {
    return response(200, JSON.stringify({ data: { attributes: { currentLocationTerritory: "us" } } }));
  }
  if (url.includes("chatgpt.com/cdn-cgi/trace")) return response(200, "loc=SG\n");
  if (url.includes("google.com/maps/timeline")) return response(200, "ok");

  throw new Error("Unexpected mock URL: " + url);
}

function response(statusCode, body, headers = {}) {
  return { statusCode, status: statusCode, body, headers };
}
