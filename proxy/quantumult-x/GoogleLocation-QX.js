/*
 * GoogleLocation-QX.js
 * Non-destructive Quantumult X UIAction for the Google "sent to China" signal.
 *
 * Detection is derived from KOP-XIAO/QuantumultX switch-check-google.js at
 * commit fb3ddcd16af66b286bc5f38534dbce09ef16ba13. The upstream file did not
 * declare a license; its author attribution and applicable terms are retained.
 *
 * Unlike the upstream switcher, this version checks only the selected route
 * and never changes policy state. HTTP 400 from Google Maps Timeline is kept as
 * the upstream redirect-to-mainland-China heuristic. YouTube region detection
 * also follows streaming-ui-check.js at commit
 * 4254bd76d366bfbd0c03e96c375ffe4032f7ee51, including its google.cn fallback.
 * Maps and YouTube are independent signals; one cannot clear the other.
 *
 * [task_local]
 * event-interaction GoogleLocation-QX.js, tag=Google location, img-url=globe.asia.australia.fill.system, enabled=true
 */

const VERSION = "1.1.0";
const POLICY = getPolicy();
const UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";

(async () => {
  if (!POLICY) {
    finishError("No node or policy selected", "Run this action from a Quantumult X node or policy menu.");
    return;
  }

  const startedAt = Date.now();
  const chainPromise = getPolicyChain(POLICY);
  const checks = await Promise.all([
    safeCheck("Google Maps", checkMapsTimeline),
    safeCheck("YouTube", checkYouTube)
  ]);
  const chain = await chainPromise;
  const elapsedMs = Date.now() - startedAt;

  console.log("GoogleLocation summary: " + JSON.stringify({ policy: POLICY, checks, elapsedMs }));
  $done({ title: "🌏 Google location", htmlMessage: render(checks, elapsedMs, chain) });
})().catch(error => {
  console.log("GoogleLocation error: " + errorText(error));
  finishError("Google location check failed", errorText(error));
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

async function checkMapsTimeline() {
  const response = await qxFetch({
    url: "https://www.google.com/maps/timeline?cb=" + Date.now(),
    method: "GET",
    timeout: 6500,
    headers: {
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
      "Cache-Control": "no-cache",
      "User-Agent": UA
    }
  });
  const status = statusCode(response);
  if (status === 400) return { state: "blocked", detail: "HTTP 400 · China redirect heuristic" };
  if (status >= 200 && status < 400) return { state: "available", detail: "HTTP " + status + " · No Maps China signal" };
  return { state: "error", detail: "HTTP " + (status || "error") };
}

async function checkYouTube() {
  const response = await qxFetch({
    url: "https://www.youtube.com/premium?cb=" + Date.now(),
    method: "GET",
    timeout: 6500,
    headers: { "User-Agent": UA, "Accept-Language": "en-US,en;q=0.9", "Cache-Control": "no-cache" }
  });
  return parseYouTubeResponse(response);
}

// Keep this parser in sync with the other standalone YouTube UIAction.
// tests/youtube-region.test.mjs runs the same response corpus against both.
function parseYouTubeResponse(response) {
  const status = statusCode(response);
  if (status !== 200) return { state: "error", detail: "HTTP " + (status || "error") };
  const body = String(response.body || "").replace(/\\"/g, '"');
  const match = body.match(/"GL"\s*:\s*"([A-Z]{2})"/i)
    || body.match(/"countryCode"\s*:\s*"([A-Z]{2})"/i);
  // Upstream uses google.cn when YouTube omits GL. Explicit region fields
  // take precedence; an incidental link must not override a reported region.
  const chinaMarker = /(?:^|[^a-z0-9.-])www\.google\.cn(?=$|[^a-z0-9.-])/i.test(body);
  const region = match ? match[1].toUpperCase() : chinaMarker ? "CN" : "";
  if (region === "CN") return { state: "blocked", detail: "YouTube marked as China", region };
  if (/Premium\s+is\s+not\s+available\s+in\s+your\s+country/i.test(body)) {
    return { state: "blocked", detail: "Premium unavailable", region };
  }
  // HTTP 200 alone can be a consent, challenge or otherwise unknown page.
  // Neither invent a US region nor report Premium available without evidence.
  if (!region) return { state: "error", detail: "Region unavailable" };
  return { state: "available", detail: "Premium available", region };
}

async function qxFetch(request) {
  const value = Object.assign({}, request);
  value.opts = Object.assign({}, request.opts || {}, { policy: POLICY });
  return await $task.fetch(value);
}

function statusCode(response) {
  return Number(response && (response.statusCode || response.status) || 0);
}

function render(checks, elapsedMs, chain) {
  const maps = checks[0];
  const youtube = checks[1];
  let color = "#8e8e93";
  let headline = "Inconclusive";

  if (youtube.region === "CN") {
    color = "#d70015";
    headline = "YouTube marked as China";
  } else if (maps.state === "blocked") {
    color = "#d70015";
    headline = "Google Maps China signal";
  } else if (maps.state === "available" && youtube.region) {
    color = "#16a34a";
    headline = "No China signal detected";
  }

  const colors = { available: "#16a34a", blocked: "#d70015", error: "#8e8e93" };
  const lines = checks.map(result => {
    const region = result.region ? " · " + result.region : "";
    return `<b>${escapeHtml(result.name)}</b><font color="${colors[result.state] || colors.error}">${escapeHtml(region + " · " + result.detail)}</font>`;
  }).join("<br>");

  return `<div style="font-family:-apple-system;font-size:15px;line-height:1.6;word-break:break-word;">
    <p style="text-align:center;margin:0;"><b>${escapeHtml(chain || POLICY)}</b></p>
    <hr>
    <p style="text-align:center;margin:0;"><b><font color="${color}">${escapeHtml(headline)}</font></b></p>
    <p style="margin:0;">${lines}</p>
    <hr>
    <p style="margin:0;"><font color="#8e8e93">${escapeHtml(formatMs(elapsedMs))} · GoogleLocation-QX v${VERSION}<br>Endpoint signals, not IP geolocation. No policy was changed.</font></p>
  </div>`;
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

function getPolicy() {
  try {
    return typeof $environment !== "undefined" && $environment.params
      ? String($environment.params).trim()
      : "";
  } catch (_) {
    return "";
  }
}

function formatMs(value) {
  return Math.max(0, Number(value) || 0) + " ms";
}

function finishError(title, detail) {
  $done({
    title: "🌏 Google location",
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
