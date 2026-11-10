/*
 * ExitIPCheck-QX.js
 * Quantumult X UIAction for IPPure exit-IP reputation data.
 *
 * Derived from ddgksf2013's server-info-pure.js snapshot dated 2025-12-14.
 * The upstream file did not declare a license; its attribution and applicable
 * terms are retained. Data is supplied by the public IPPure API.
 *
 * Local changes
 * - Validate HTTP and JSON responses and preserve zero-valued scores.
 * - Display residential/data-center and native/announced signals together.
 * - Escape remote values and use a compact Quantumult X-compatible popup.
 *
 * [task_local]
 * event-interaction ExitIPCheck-QX.js, tag=Exit-IP reputation, img-url=checkmark.shield.fill.system, enabled=true
 */

const VERSION = "1.0.0";
const POLICY = getPolicy();

(async () => {
  if (!POLICY) {
    finishError("No node or policy selected", "Run this action from a Quantumult X node or policy menu.");
    return;
  }

  const response = await $task.fetch({
    url: "https://my.ippure.com/v1/info?cb=" + Date.now(),
    method: "GET",
    timeout: 6500,
    opts: { policy: POLICY },
    headers: {
      "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
      "Cache-Control": "no-cache"
    }
  });
  const status = Number(response.statusCode || response.status || 0);
  if (status !== 200) throw new Error("IPPure returned HTTP " + (status || "error"));

  const data = JSON.parse(response.body || "{}");
  if (!data.ip) throw new Error("IPPure response did not include an IP address");
  const chain = await getPolicyChain(POLICY);
  console.log("ExitIPCheck summary: " + JSON.stringify({ policy: POLICY, data }));
  $done({ title: "🔎 Exit-IP reputation", htmlMessage: render(data, chain) });
})().catch(error => {
  console.log("ExitIPCheck error: " + errorText(error));
  finishError("Exit-IP query failed", errorText(error));
});

function render(data, chain) {
  const score = finiteNumber(data.fraudScore) ? Number(data.fraudScore) : null;
  const risk = riskLevel(score);
  const countryCode = String(data.countryCode || "").toUpperCase();
  const location = [flag(countryCode) + (countryCode ? " " + countryCode : ""), data.region, data.city]
    .filter(Boolean).join(" · ") || "—";
  const networkType = data.isResidential === true
    ? "Residential"
    : data.isResidential === false ? "Data center" : "Unknown";
  const allocation = data.isBroadcast === true
    ? "Announced / broadcast"
    : data.isBroadcast === false ? "Native allocation" : "Unknown allocation";
  const asn = data.asn ? "AS" + data.asn : "AS—";
  const isp = data.asOrganization || "—";

  return `<div style="font-family:-apple-system;font-size:15px;line-height:1.6;word-break:break-word;">
    <p style="text-align:center;margin:0;"><b>${escapeHtml(chain || POLICY)}</b></p>
    <hr>
    <p style="margin:0;"><b>Exit IP</b><br>
      ${escapeHtml(data.ip)}<br>
      ${escapeHtml(location)}
    </p>
    <hr>
    <p style="margin:0;"><b>Network</b><br>
      ${escapeHtml(asn + " · " + isp)}<br>
      ${escapeHtml(networkType + " · " + allocation)}
    </p>
    <hr>
    <p style="margin:0;"><b>Fraud score</b><br>
      <b><font color="${risk.color}">${escapeHtml(score == null ? "—" : score + "/100")} · ${escapeHtml(risk.label)}</font></b>
    </p>
    <hr>
    <p style="margin:0;"><font color="#8e8e93">IPPure signals are informational and may differ from individual services. ExitIPCheck-QX v${VERSION}</font></p>
  </div>`;
}

function riskLevel(score) {
  if (score == null) return { label: "Unknown risk", color: "#8e8e93" };
  if (score <= 25) return { label: "Low risk", color: "#16a34a" };
  if (score <= 50) return { label: "Medium risk", color: "#d97706" };
  if (score <= 75) return { label: "High risk", color: "#f97316" };
  return { label: "Very high risk", color: "#d70015" };
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

function flag(countryCode) {
  const code = String(countryCode || "").toUpperCase();
  if (!/^[A-Z]{2}$/.test(code)) return "🌐";
  return String.fromCodePoint(code.charCodeAt(0) + 127397, code.charCodeAt(1) + 127397);
}

function finiteNumber(value) {
  return value !== "" && value != null && isFinite(Number(value));
}

function finishError(title, detail) {
  $done({
    title: "🔎 Exit-IP reputation",
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
