import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const GOOGLE = "GoogleLocation-QX.js";
const STREAMING = "StreamingCheck-QX.js";
const FILES = [GOOGLE, STREAMING];
const CHINA_PAGE = '<script src="https://www.google.cn/ads/ga-audiences"></script>';
const POLICY = "Test <Policy> & route";

function response(body, statusCode = 200) {
  return { statusCode, body, headers: {} };
}

// Run the actual standalone UIAction, including request routing, rendering and
// $done. Unrelated streaming services fail deterministically without network IO.
async function startAction(file, options = {}) {
  const source = await readFile(new URL("../" + file, import.meta.url), "utf8");
  const requests = [];
  const messages = [];
  const outputs = [];
  const logs = [];
  let resolveDone;
  const done = new Promise(resolve => { resolveDone = resolve; });
  const context = vm.createContext({
    console: { log(value) { logs.push(String(value)); } },
    $environment: { params: options.policy ?? POLICY },
    $task: {
      async fetch(request) {
        requests.push(request);
        if (request.url.includes("youtube.com/premium")) {
          const value = Object.hasOwn(options, "youtube") ? options.youtube : response('{"GL":"SG"}');
          if (value instanceof Error) throw value;
          return await value;
        }
        if (request.url.includes("google.com/maps/timeline")) {
          const value = Object.hasOwn(options, "maps") ? options.maps : response("ok");
          if (value instanceof Error) throw value;
          return await value;
        }
        return response("Unrelated service", 503);
      }
    },
    $configuration: {
      async sendMessage(message) {
        messages.push(message);
        if (options.configurationError) throw new Error("Policy lookup failed");
        return { ret: { [POLICY]: ["Test Node"] } };
      }
    },
    $done(value) {
      outputs.push(value);
      resolveDone();
    }
  });
  new vm.Script(source, { filename: file }).runInContext(context);
  return {
    requests, messages, outputs,
    async finish() {
      let timer;
      try {
        await Promise.race([
          done,
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error(`${file} did not finish`)), 2000);
          })
        ]);
        await new Promise(resolve => setImmediate(resolve));
      } finally {
        clearTimeout(timer);
      }
      assert.equal(outputs.length, 1, `${file} must call $done exactly once`);
      const summaryLog = logs.find(line => line.includes(" summary: "));
      const summary = summaryLog ? JSON.parse(summaryLog.split(" summary: ")[1]) : {};
      return { html: outputs[0].htmlMessage, summary, requests, messages };
    }
  };
}

async function runAction(file, options) {
  return await (await startAction(file, options)).finish();
}

function youtubeResult(result) {
  const check = (result.summary.checks || []).find(value => /^YouTube/.test(value.name));
  assert.ok(check, "summary must include the YouTube probe");
  return check;
}

test("Streaming restores the upstream google.cn China marker", async () => {
  const result = await runAction(STREAMING, { youtube: response(CHINA_PAGE) });
  assert.match(result.html, /YouTube marked as China/);
  assert.equal(youtubeResult(result).region, "CN");
  assert.equal(youtubeResult(result).state, "blocked");
  assert.doesNotMatch(result.html, /Premium available/);
});

test("Google detects YouTube China even when Maps returns HTTP 200", async () => {
  const result = await runAction(GOOGLE, { youtube: response(CHINA_PAGE) });
  assert.match(result.html, /YouTube marked as China/);
  assert.doesNotMatch(result.html, /No China signal detected|No redirect-to-China signal/);
  assert.equal(youtubeResult(result).region, "CN");
});

const fixtures = [
  ["explicit GL CN", response('{"GL":"CN"}'), "blocked", "CN"],
  ["countryCode fallback", response('{"countryCode" : "cn"}'), "blocked", "CN"],
  ["escaped JSON country", response(String.raw`{\"GL\":\"CN\"}`), "blocked", "CN"],
  ["google.cn fallback", response(CHINA_PAGE), "blocked", "CN"],
  ["case-insensitive marker", response('src="https://WWW.GOOGLE.CN/ads/"'), "blocked", "CN"],
  ["escaped marker URL", response(String.raw`"https:\/\/www.google.cn\/ads/"`), "blocked", "CN"],
  ["GL takes precedence over marker", response('{"GL":"SG"}' + CHINA_PAGE), "available", "SG"],
  ["countryCode takes precedence over marker", response('{"countryCode":"JP"}' + CHINA_PAGE), "available", "JP"],
  ["GL takes precedence over countryCode", response('{"countryCode":"CN","GL":"JP"}'), "available", "JP"],
  ["CN GL takes precedence over countryCode", response('{"countryCode":"US","GL":"CN"}'), "blocked", "CN"],
  ["Hong Kong is not mainland China", response('{"GL":"HK"}'), "available", "HK"],
  ["Taiwan is not mainland China", response('{"GL":"TW"}'), "available", "TW"],
  ["unavailable retains CN", response('{"GL":"CN"} Premium is not available in your country'), "blocked", "CN"],
  ["unavailable retains non-CN region", response('{"GL":"RU"} Premium is not available in your country'), "blocked", "RU"],
  ["unavailable alone is not China", response("Premium is not available in your country"), "blocked", ""],
  ["empty page is unknown", response(""), "error", ""],
  ["consent page is unknown", response("<html>Before you continue to YouTube</html>"), "error", ""],
  ["malformed country is unknown", response('{"GL":"CHINA"}'), "error", ""],
  ["hostname suffix is not a China marker", response('src="https://www.google.cn.example/"'), "error", ""],
  ["hostname prefix is not a China marker", response('src="https://notwww.google.cn/"'), "error", ""],
  ["HTTP 403 is not a country signal", response(CHINA_PAGE, 403), "error", ""],
  ["HTTP 429 is not a country signal", response('{"GL":"CN"}', 429), "error", ""],
  ["HTTP 500 is not a country signal", response(CHINA_PAGE, 500), "error", ""],
  ["status alias", { status: "200", body: '{"GL":"CN"}' }, "blocked", "CN"],
  ["missing status", { body: CHINA_PAGE }, "error", ""],
  ["missing response", undefined, "error", ""],
  ["request rejection", new Error("Network timed out"), "error", ""]
];

// Exercise the same corpus against both standalone copies to prevent drift.
for (const [name, youtube, state, region] of fixtures) {
  test(`YouTube parsing agrees across UIActions: ${name}`, async () => {
    for (const file of FILES) {
      const result = await runAction(file, { youtube });
      const actual = youtubeResult(result);
      assert.equal(actual.state, state, file);
      assert.equal(actual.region || "", region, file);
      if (region === "CN") assert.match(result.html, /YouTube marked as China/, file);
      else assert.doesNotMatch(result.html, /YouTube marked as China/, file);
      if (file === GOOGLE && !region) {
        assert.match(result.html, /Inconclusive/);
        assert.doesNotMatch(result.html, /No China signal detected/);
      }
    }
  });
}

test("Google preserves each endpoint's evidence when the other probe fails", async () => {
  const cases = [
    { maps: new Error("Maps timeout"), youtube: response(CHINA_PAGE), headline: /YouTube marked as China/ },
    { maps: response("bad request", 400), youtube: new Error("YouTube timeout"), headline: /Google Maps China signal/ },
    { maps: response("bad request", 400), youtube: response('{"GL":"SG"}'), headline: /Google Maps China signal/ },
    { maps: response("unavailable", 500), youtube: response('{"GL":"SG"}'), headline: /Inconclusive/ },
    { maps: new Error("Maps timeout"), youtube: new Error("YouTube timeout"), headline: /Inconclusive/ }
  ];
  for (const { headline, ...options } of cases) {
    const result = await runAction(GOOGLE, options);
    assert.match(result.html, headline);
    assert.doesNotMatch(result.html, /No China signal detected/);
  }
});

test("Google reports no China signal only with a recognized non-CN YouTube region", async () => {
  for (const status of [200, 204, 302]) {
    const result = await runAction(GOOGLE, { maps: response("", status) });
    assert.match(result.html, /No China signal detected/);
    assert.match(result.html, /YouTube.*SG/);
  }
});

test("Google starts both probes together and waits for both before finishing", async () => {
  let resolveMaps, resolveYouTube;
  const maps = new Promise(resolve => { resolveMaps = resolve; });
  const youtube = new Promise(resolve => { resolveYouTube = resolve; });
  const action = await startAction(GOOGLE, { maps, youtube });
  assert.equal(action.requests.length, 2);
  assert.equal(action.outputs.length, 0);
  resolveYouTube(response(CHINA_PAGE));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(action.outputs.length, 0);
  resolveMaps(response("ok"));
  const result = await action.finish();
  assert.match(result.html, /YouTube marked as China/);
});

test("both UIActions use the selected policy and never change policy state", async () => {
  const youtubeRequests = [];
  for (const file of FILES) {
    const result = await runAction(file);
    assert.ok(result.requests.length > 0);
    for (const request of result.requests) assert.equal(request.opts.policy, POLICY);
    assert.ok(result.messages.every(message => message.action === "get_policy_state"));
    const request = result.requests.find(value => value.url.includes("youtube.com/premium"));
    assert.ok(request);
    assert.equal(request.method, "GET");
    assert.doesNotMatch(request.url, /[?&]gl=/i, "do not force the region being measured");
    youtubeRequests.push(request);
    assert.match(result.html, /Test &lt;Policy&gt; &amp; route/);
    assert.doesNotMatch(result.html, /<Policy>/);
    assert.doesNotMatch(result.html, /<table\b|display\s*:\s*flex/i);
  }
  assert.equal(youtubeRequests[0].headers["User-Agent"], youtubeRequests[1].headers["User-Agent"]);
  assert.equal(youtubeRequests[0].headers["Accept-Language"], youtubeRequests[1].headers["Accept-Language"]);
});

test("missing policy finishes once without sending any probes", async () => {
  for (const file of FILES) {
    const result = await runAction(file, { policy: "" });
    assert.equal(result.requests.length, 0);
    assert.equal(result.messages.length, 0);
    assert.match(result.html, /No node or policy selected/);
  }
});

test("policy-chain lookup failure does not discard a YouTube China result", async () => {
  for (const file of FILES) {
    const result = await runAction(file, { configurationError: true, youtube: response(CHINA_PAGE) });
    assert.match(result.html, /YouTube marked as China/);
  }
});
