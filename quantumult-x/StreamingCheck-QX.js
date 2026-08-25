/*
 * StreamingCheck-QX.js
 * Compact Quantumult X UIAction availability check.
 *
 * Derived from KOP-XIAO/QuantumultX streaming-ui-check.js at commit
 * 4254bd76d366bfbd0c03e96c375ffe4032f7ee51. The upstream file did not
 * declare a license; its author attribution and applicable terms are retained.
 *
 * Local changes
 * - Await every service check and call $done exactly once.
 * - Replace the obsolete chat.openai.com probe with chatgpt.com.
 * - Treat unknown responses as errors instead of false unlock results.
 * - Use a narrow, linear htmlMessage that Quantumult X renders reliably.
 *
 * [task_local]
 * event-interaction StreamingCheck-QX.js, tag=Streaming availability, img-url=arrowtriangle.right.square.system, enabled=true
 */

const VERSION = "1.0.0";
const POLICY = getPolicy();
const UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
const DISNEY_AUTH = "ZGlzbmV5JmJyb3dzZXImMS4wLjA.Cu56AgSfBTDag5NiRA81oLHkDZfu5L3CKadnefEAY84";

(async () => {
  if (!POLICY) {
    finishError("No node or policy selected", "Run this action from a Quantumult X node or policy menu.");
    return;
  }

  const chainPromise = getPolicyChain(POLICY);
  const checks = await Promise.all([
    safeCheck("Netflix", checkNetflix),
    safeCheck("YouTube Premium", checkYouTube),
    safeCheck("Disney+", checkDisney),
    safeCheck("DAZN", checkDazn),
    safeCheck("Paramount+", checkParamount),
    safeCheck("Discovery+", checkDiscovery),
    safeCheck("ChatGPT", checkChatGPT)
  ]);
  const chain = await chainPromise;

  console.log("StreamingCheck summary: " + JSON.stringify({ policy: POLICY, checks }));
  $done({ title: "📺 Streaming availability", htmlMessage: render(checks, chain) });
})().catch(error => {
  console.log("StreamingCheck error: " + errorText(error));
  finishError("Availability check failed", errorText(error));
});

async function safeCheck(name, check) {
  try {
    const result = await check();
    return Object.assign({ name }, result || {});
  } catch (error) {
    console.log(name + " check failed: " + errorText(error));
    return { name, state: "error", detail: "Check failed" };
  }
}

async function checkNetflix() {
  const response = await qxFetch({
    url: "https://www.netflix.com/title/81280792?cb=" + Date.now(),
    method: "GET",
    timeout: 6500,
    headers: { "User-Agent": UA, "Cache-Control": "no-cache" }
  });
  const status = statusCode(response);
  if (status === 200) {
    const origin = header(response.headers, "x-originating-url");
    const region = parseNetflixRegion(origin);
    return { state: "available", detail: "Full catalogue", region };
  }
  if (status === 404) return { state: "limited", detail: "Originals only" };
  if (status === 403 || status === 451) return { state: "blocked", detail: "Unavailable" };
  return { state: "error", detail: "HTTP " + (status || "error") };
}

async function checkYouTube() {
  const response = await qxFetch({
    url: "https://www.youtube.com/premium?cb=" + Date.now(),
    method: "GET",
    timeout: 6500,
    headers: { "User-Agent": UA, "Accept-Language": "en-US,en;q=0.9", "Cache-Control": "no-cache" }
  });
  const status = statusCode(response);
  const body = String(response.body || "");
  if (status !== 200) return { state: "error", detail: "HTTP " + (status || "error") };
  if (/Premium is not available in your country/i.test(body)) {
    return { state: "blocked", detail: "Premium unavailable" };
  }
  const match = body.match(/"GL"\s*:\s*"([A-Z]{2})"/i)
    || body.match(/"countryCode"\s*:\s*"([A-Z]{2})"/i);
  return { state: "available", detail: "Premium available", region: match ? match[1].toUpperCase() : "" };
}

async function checkDisney() {
  const response = await qxFetch({
    url: "https://disney.api.edge.bamgrid.com/graph/v1/device/graphql",
    method: "POST",
    timeout: 7000,
    headers: {
      "Accept-Language": "en-US,en;q=0.9",
      "Authorization": DISNEY_AUTH,
      "Content-Type": "application/json",
      "User-Agent": UA
    },
    body: JSON.stringify({
      query: "mutation registerDevice($input: RegisterDeviceInput!) { registerDevice(registerDevice: $input) { grant { grantType assertion } } }",
      variables: {
        input: {
          applicationRuntime: "chrome",
          attributes: {
            browserName: "chrome",
            browserVersion: "120.0",
            manufacturer: "apple",
            model: null,
            operatingSystem: "macintosh",
            operatingSystemVersion: "14.0",
            osDeviceIds: []
          },
          deviceFamily: "browser",
          deviceLanguage: "en",
          deviceProfile: "macosx"
        }
      }
    })
  });
  const status = statusCode(response);
  if (status === 403 || status === 451) return { state: "blocked", detail: "Unavailable" };
  if (status !== 200) return { state: "error", detail: "HTTP " + (status || "error") };
  const data = parseJson(response.body);
  const sdk = data && data.extensions && data.extensions.sdk;
  const session = sdk && sdk.session;
  if (!session || !session.location) return { state: "error", detail: "Unexpected response" };
  const region = String(session.location.countryCode || "").toUpperCase();
  const supported = session.inSupportedLocation === true || session.inSupportedLocation === "true";
  return supported
    ? { state: "available", detail: "Available", region }
    : { state: "limited", detail: "Coming soon / unsupported", region };
}

async function checkDazn() {
  const response = await qxFetch({
    url: "https://startup.core.indazn.com/misl/v5/Startup",
    method: "POST",
    timeout: 6500,
    headers: { "Content-Type": "application/json", "User-Agent": UA },
    body: JSON.stringify({
      LandingPageKey: "generic",
      Platform: "web",
      PlatformAttributes: {},
      Manufacturer: "",
      PromoCode: "",
      Version: "2"
    })
  });
  const status = statusCode(response);
  if (status === 403 || status === 451) return { state: "blocked", detail: "Unavailable" };
  if (status !== 200) return { state: "error", detail: "HTTP " + (status || "error") };
  const match = String(response.body || "").match(/"GeolocatedCountry"\s*:\s*"([A-Z]{2})"/i);
  if (!match) return { state: "blocked", detail: "Unsupported region" };
  return { state: "available", detail: "Available", region: match[1].toUpperCase() };
}

async function checkParamount() {
  const response = await qxFetch({
    url: "https://www.paramountplus.com/?cb=" + Date.now(),
    method: "GET",
    timeout: 6500,
    opts: { redirection: false },
    headers: { "User-Agent": UA, "Accept-Language": "en-US,en;q=0.9", "Cache-Control": "no-cache" }
  });
  const status = statusCode(response);
  if (status === 200) return { state: "available", detail: "Available" };
  if (status >= 300 && status < 400) return { state: "limited", detail: "Regional redirect" };
  if (status === 403 || status === 451) return { state: "blocked", detail: "Unavailable" };
  return { state: "error", detail: "HTTP " + (status || "error") };
}

async function checkDiscovery() {
  const tokenResponse = await qxFetch({
    url: "https://us1-prod-direct.discoveryplus.com/token?deviceId=d1a4a5d25212400d1e6985984604d740&realm=go&shortlived=true",
    method: "GET",
    timeout: 6500,
    headers: { "User-Agent": UA }
  });
  const tokenStatus = statusCode(tokenResponse);
  if (tokenStatus === 403 || tokenStatus === 451) return { state: "blocked", detail: "Unavailable" };
  if (tokenStatus !== 200) return { state: "error", detail: "HTTP " + (tokenStatus || "error") };
  const tokenData = parseJson(tokenResponse.body);
  const token = tokenData && tokenData.data && tokenData.data.attributes && tokenData.data.attributes.token;
  if (!token) return { state: "error", detail: "Token unavailable" };

  const response = await qxFetch({
    url: "https://us1-prod-direct.discoveryplus.com/users/me",
    method: "GET",
    timeout: 6500,
    headers: { "User-Agent": UA, "Cookie": "st=" + token }
  });
  if (statusCode(response) !== 200) return { state: "error", detail: "Session unavailable" };
  const data = parseJson(response.body);
  const region = data && data.data && data.data.attributes && data.data.attributes.currentLocationTerritory;
  if (!region) return { state: "error", detail: "Unexpected response" };
  const code = String(region).toUpperCase();
  return code === "US"
    ? { state: "available", detail: "Available", region: code }
    : { state: "blocked", detail: "US catalogue unavailable", region: code };
}

async function checkChatGPT() {
  const response = await qxFetch({
    url: "https://chatgpt.com/cdn-cgi/trace?cb=" + Date.now(),
    method: "GET",
    timeout: 6500,
    headers: { "User-Agent": UA, "Cache-Control": "no-cache" }
  });
  const status = statusCode(response);
  if (status === 451) return { state: "blocked", detail: "Region blocked" };
  if (status !== 200) return { state: "error", detail: "HTTP " + (status || "error") };
  const trace = parseTrace(response.body);
  return { state: "available", detail: "Reachable", region: String(trace.loc || "").toUpperCase() };
}

async function qxFetch(request) {
  const value = Object.assign({}, request);
  value.opts = Object.assign({}, request.opts || {}, { policy: POLICY });
  return await $task.fetch(value);
}

async function getPolicyChain(policy) {
  try {
    if (typeof $configuration === "undefined" || !$configuration.sendMessage) return policy;
    const response = await $configuration.sendMessage({ action: "get_policy_state", content: policy });
    const selected = response && response.ret && response.ret[policy];
    if (Array.isArray(selected) && selected.length) return [policy].concat(selected).join(" → ");
    if (selected != null && String(selected)) return policy + " → " + selected;
  } catch (error) {
    console.log("Policy-chain lookup failed: " + errorText(error));
  }
  return policy;
}

function render(checks, chain) {
  const lines = checks.map(resultLine).join("<br>");
  return `<div style="font-family:-apple-system;font-size:15px;line-height:1.65;word-break:break-word;">
    <p style="text-align:center;margin:0;"><b>${escapeHtml(chain || POLICY)}</b></p>
    <hr>
    <p style="margin:0;">${lines}</p>
    <hr>
    <p style="margin:0;"><font color="#8e8e93">Service APIs change frequently; an error is not treated as blocked. StreamingCheck-QX v${VERSION}</font></p>
  </div>`;
}

function resultLine(result) {
  const colors = { available: "#16a34a", limited: "#d97706", blocked: "#d70015", error: "#8e8e93" };
  const labels = { available: "Available", limited: "Limited", blocked: "Blocked", error: "Error" };
  const state = colors[result.state] ? result.state : "error";
  const region = result.region ? " · " + flag(result.region) + " " + result.region : "";
  const detail = result.detail ? " · " + result.detail : "";
  return `<b>${escapeHtml(result.name)}</b> · <b><font color="${colors[state]}">${labels[state]}</font></b>${escapeHtml(region + detail)}`;
}

function getPolicy() {
  try {
    return typeof $environment !== "undefined" && $environment.params
      ? String($environment.params).trim()
      : "";
  } catch (_) {
    return "";
  }
}

function parseNetflixRegion(value) {
  const match = String(value || "").match(/netflix\.com\/([a-z]{2})(?:-[a-z]{2})?\//i);
  return match ? match[1].toUpperCase() : "";
}

function statusCode(response) {
  return Number(response && (response.statusCode || response.status) || 0);
}

function header(headers, name) {
  const source = headers || {};
  const wanted = String(name).toLowerCase();
  for (const key in source) {
    if (String(key).toLowerCase() === wanted) return source[key];
  }
  return "";
}

function parseJson(body) {
  try { return JSON.parse(body || "{}"); } catch (_) { return null; }
}

function parseTrace(body) {
  const output = {};
  String(body || "").split("\n").forEach(line => {
    const index = line.indexOf("=");
    if (index > 0) output[line.slice(0, index)] = line.slice(index + 1).trim();
  });
  return output;
}

function flag(countryCode) {
  const code = String(countryCode || "").toUpperCase();
  if (!/^[A-Z]{2}$/.test(code)) return "🌐";
  return String.fromCodePoint(code.charCodeAt(0) + 127397, code.charCodeAt(1) + 127397);
}

function finishError(title, detail) {
  $done({
    title: "📺 Streaming availability",
    htmlMessage: `<p style="font-family:-apple-system;text-align:center;font-size:15px;line-height:1.55;"><b><font color="#d70015">${escapeHtml(title)}</font></b><br>${escapeHtml(detail)}</p>`
  });
}

function errorText(error) {
  return String(error && error.message ? error.message : error || "Unknown error");
}

function escapeHtml(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
