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
 * the upstream redirect-to-mainland-China heuristic.
 *
 * [task_local]
 * event-interaction GoogleLocation-QX.js, tag=Google location, img-url=globe.asia.australia.fill.system, enabled=true
 */

const VERSION = "1.0.0";
const POLICY = getPolicy();

(async () => {
  if (!POLICY) {
    finishError("No node or policy selected", "Run this action from a Quantumult X node or policy menu.");
    return;
  }

  const startedAt = Date.now();
  const chainPromise = getPolicyChain(POLICY);
  const response = await $task.fetch({
    url: "https://www.google.com/maps/timeline?cb=" + Date.now(),
    method: "GET",
    timeout: 6500,
    opts: { policy: POLICY },
    headers: {
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
      "Cache-Control": "no-cache",
      "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"
    }
  });
  const status = Number(response.statusCode || response.status || 0);
  const chain = await chainPromise;
  const elapsedMs = Date.now() - startedAt;

  console.log("GoogleLocation summary: " + JSON.stringify({ policy: POLICY, status, elapsedMs }));
  $done({ title: "🌏 Google location", htmlMessage: render(status, elapsedMs, chain) });
})().catch(error => {
  console.log("GoogleLocation error: " + errorText(error));
  finishError("Google location check failed", errorText(error));
});

function render(status, elapsedMs, chain) {
  let color = "#8e8e93";
  let headline = "Inconclusive";
  let detail = "Google returned HTTP " + (status || "error") + ".";

  if (status === 400) {
    color = "#d70015";
    headline = "Likely redirected to mainland China";
    detail = "Google Maps Timeline returned the redirect-to-China signal.";
  } else if (status >= 200 && status < 400) {
    color = "#16a34a";
    headline = "No redirect-to-China signal";
    detail = "Google Maps Timeline remained reachable on this route.";
  }

  return `<div style="font-family:-apple-system;font-size:15px;line-height:1.6;word-break:break-word;">
    <p style="text-align:center;margin:0;"><b>${escapeHtml(chain || POLICY)}</b></p>
    <hr>
    <p style="text-align:center;margin:0;"><b><font color="${color}">${escapeHtml(headline)}</font></b><br>${escapeHtml(detail)}</p>
    <hr>
    <p style="margin:0;"><font color="#8e8e93">HTTP ${escapeHtml(status || "—")} · ${escapeHtml(formatMs(elapsedMs))}<br>This is a Google endpoint heuristic, not an IP geolocation database. No policy was changed. GoogleLocation-QX v${VERSION}</font></p>
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
