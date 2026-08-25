/*
 * NodeBenchmark-QX.js
 * Quantumult X UIAction node benchmark
 *
 * Features
 * - Idle HTTP latency / jitter / request-loss
 * - Adaptive single-stream download
 * - Concurrent multi-stream download
 * - Single / multi-stream upload
 * - Loaded latency (download & upload bufferbloat approximation)
 * - Cloudflare exit IP / ASN / organization / colo / location / HTTP protocol
 * - Quantumult X selected policy-chain lookup when available
 * - Compact Quantumult X-compatible HTML result panel
 *
 * Notes
 * - "Latency" is HTTP request RTT/TTFB-like wall time, not ICMP ping.
 * - "Request loss" is failed HTTP probes, not raw packet loss.
 * - "Multi-stream" means concurrent HTTP requests. Quantumult X may reuse
 *   underlying HTTP/2/TLS connections; this is not guaranteed to be N TCP sockets.
 *
 * [task_local]
 * event-interaction NodeBenchmark-QX.js, tag=Node Benchmark, img-url=bolt.horizontal.circle.fill.system, enabled=true
 *
 * Optional runtime arguments are supported through $argument or URL #fragment:
 * profile=lite|balanced|heavy&streams=4&upload=1
 */

const VERSION = "1.1.0";
const CF = "https://speed.cloudflare.com";
const MiB = 1024 * 1024;
const KiB = 1024;

// Easy local defaults. Runtime args / URL #fragment override these values.
const USER_DEFAULTS = {
  profile: "balanced", // lite | balanced | heavy
  streams: 4,          // 2..8 concurrent HTTP streams
  upload: true         // false = skip upload tests
};

const PROFILES = {
  lite: {
    latencyProbes: 6,
    loadedProbes: 4,
    loadedGapMs: 100,
    probeBytes: 512 * KiB,
    targetMs: 800,
    singleSamples: 1,
    minSingleBytes: 1 * MiB,
    maxSingleBytes: 4 * MiB,
    multiLoadFactor: 1.35,
    maxMultiBytesPerStream: 2 * MiB,
    uploadSingleBytes: 1 * MiB,
    uploadMultiTotalBytes: 2 * MiB,
    requestTimeoutMs: 5000
  },
  balanced: {
    latencyProbes: 8,
    loadedProbes: 5,
    loadedGapMs: 110,
    probeBytes: 1 * MiB,
    targetMs: 1200,
    singleSamples: 2,
    minSingleBytes: 2 * MiB,
    maxSingleBytes: 12 * MiB,
    multiLoadFactor: 1.55,
    maxMultiBytesPerStream: 6 * MiB,
    uploadSingleBytes: 4 * MiB,
    uploadMultiTotalBytes: 6 * MiB,
    requestTimeoutMs: 8000
  },
  heavy: {
    latencyProbes: 10,
    loadedProbes: 7,
    loadedGapMs: 120,
    probeBytes: 2 * MiB,
    targetMs: 1800,
    singleSamples: 2,
    minSingleBytes: 4 * MiB,
    maxSingleBytes: 32 * MiB,
    multiLoadFactor: 1.75,
    maxMultiBytesPerStream: 12 * MiB,
    uploadSingleBytes: 8 * MiB,
    uploadMultiTotalBytes: 16 * MiB,
    requestTimeoutMs: 10000
  }
};

const ARGS = parseArgs();
const requestedProfile = ARGS.profile || USER_DEFAULTS.profile;
const profileName = PROFILES[requestedProfile] ? requestedProfile : "balanced";
const CFG = PROFILES[profileName];
const streams = clampInt(Number(ARGS.streams || USER_DEFAULTS.streams), 2, 8);
const doUpload = ARGS.upload == null ? USER_DEFAULTS.upload : String(ARGS.upload) !== "0";
const policy = String(ARGS.policy || getPolicy() || "").trim();

let estimatedTrafficBytes = 0;
let startedAt = Date.now();

(async () => {
  if (!policy) {
    finishError("未获得节点/策略名称", "请从 Quantumult X 节点或策略组的 UI Action 中运行此脚本。");
    return;
  }

  // Start low-cost metadata/policy lookups in parallel.
  const metaPromise = getMeta(policy);
  const chainPromise = getPolicyChain(policy);

  // Warm connection; excluded from latency stats.
  await latencyOnce(policy, 2500).catch(() => null);

  const idle = await latencySeries(policy, CFG.latencyProbes, 55, 2800);

  // Small bandwidth probe for adaptive sizing.
  const probe = await downloadGroup(policy, 1, CFG.probeBytes, Math.min(CFG.requestTimeoutMs, 6000));
  estimatedTrafficBytes += probe.okCount * CFG.probeBytes;

  const seedBps = probe.bps > 0 ? probe.bps : 20 * 1000 * 1000;
  const rawSingleBytes = (seedBps / 8) * (CFG.targetMs / 1000);
  const singleBytes = roundBytes(clamp(rawSingleBytes, CFG.minSingleBytes, CFG.maxSingleBytes));

  const singleRuns = [];
  for (let i = 0; i < CFG.singleSamples; i++) {
    const r = await downloadGroup(policy, 1, singleBytes, CFG.requestTimeoutMs);
    singleRuns.push(r);
    estimatedTrafficBytes += r.okCount * singleBytes;
  }
  const singleDownload = reduceRuns(singleRuns);

  const multiPerStream = roundBytes(
    clamp(
      (singleBytes * CFG.multiLoadFactor) / streams,
      512 * KiB,
      CFG.maxMultiBytesPerStream
    )
  );

  // Multi-stream download and latency probes overlap to approximate loaded latency.
  const downLoadStart = Date.now();
  const downGroupPromise = downloadGroup(policy, streams, multiPerStream, CFG.requestTimeoutMs);
  const downLoadedLatencyPromise = latencySeries(policy, CFG.loadedProbes, CFG.loadedGapMs, 3000);
  const downPair = await Promise.all([downGroupPromise, downLoadedLatencyPromise]);
  const multiDownload = downPair[0];
  const downLoaded = downPair[1];
  const downLoadWindowMs = Date.now() - downLoadStart;
  estimatedTrafficBytes += multiDownload.okCount * multiPerStream;

  let singleUpload = null;
  let multiUpload = null;
  let upLoaded = null;

  if (doUpload) {
    const upSingleBytes = CFG.uploadSingleBytes;
    const payloadSingle = makePayload(upSingleBytes);
    singleUpload = await uploadGroup(policy, 1, payloadSingle, CFG.requestTimeoutMs);
    estimatedTrafficBytes += singleUpload.okCount * upSingleBytes;

    const upPerStream = roundBytes(
      clamp(CFG.uploadMultiTotalBytes / streams, 256 * KiB, 4 * MiB)
    );
    const payloadMulti = makePayload(upPerStream);

    const upGroupPromise = uploadGroup(policy, streams, payloadMulti, CFG.requestTimeoutMs);
    const upLoadedPromise = latencySeries(policy, CFG.loadedProbes, CFG.loadedGapMs, 3000);
    const upPair = await Promise.all([upGroupPromise, upLoadedPromise]);
    multiUpload = upPair[0];
    upLoaded = upPair[1];
    estimatedTrafficBytes += multiUpload.okCount * upPerStream;
  }

  const meta = await metaPromise;
  const chain = await chainPromise;

  const result = {
    policy,
    chain,
    profileName,
    streams,
    idle,
    probe,
    singleBytes,
    singleDownload,
    multiPerStream,
    multiDownload,
    downLoaded,
    downLoadWindowMs,
    singleUpload,
    multiUpload,
    upLoaded,
    meta,
    elapsedMs: Date.now() - startedAt,
    estimatedTrafficBytes
  };

  console.log("NodeBenchmark summary: " + JSON.stringify({
    policy: result.policy, profile: result.profileName, streams: result.streams,
    latencyMs: result.idle.median, jitterMs: result.idle.jitter, requestLossPct: result.idle.lossPct,
    download1Mbps: result.singleDownload.bps / 1000000,
    downloadMultiMbps: result.multiDownload.bps / 1000000,
    upload1Mbps: result.singleUpload ? result.singleUpload.bps / 1000000 : null,
    uploadMultiMbps: result.multiUpload ? result.multiUpload.bps / 1000000 : null,
    exitIp: result.meta && result.meta.clientIp, colo: result.meta && result.meta.colo
  }));

  const html = renderPanel(result);
  $done({ title: "⚡ Node Benchmark", htmlMessage: html });
})().catch(err => {
  console.log("NodeBenchmark error: " + (err && err.stack ? err.stack : err));
  finishError("测速异常", escapeHtml(String(err && err.message ? err.message : err)));
});

function getPolicy() {
  try {
    if (typeof $environment !== "undefined" && $environment.params) return $environment.params;
  } catch (_) {}
  return "";
}

function parseArgs() {
  const out = {};
  const chunks = [];
  try {
    if (typeof $argument !== "undefined" && $argument) chunks.push(String($argument));
  } catch (_) {}
  try {
    if (typeof $environment !== "undefined" && $environment.sourcePath) {
      const p = String($environment.sourcePath);
      const i = p.indexOf("#");
      if (i >= 0 && i + 1 < p.length) chunks.push(p.slice(i + 1));
    }
  } catch (_) {}
  chunks.join("&").split("&").forEach(pair => {
    if (!pair) return;
    const idx = pair.indexOf("=");
    const k = decodeURIComponent(idx >= 0 ? pair.slice(0, idx) : pair).trim();
    const v = decodeURIComponent(idx >= 0 ? pair.slice(idx + 1) : "1").trim();
    if (k) out[k] = v;
  });
  return out;
}

async function qxFetch(req) {
  const r = Object.assign({}, req);
  r.opts = Object.assign({}, r.opts || {}, { policy });
  return await $task.fetch(r);
}

async function timedFetch(req) {
  const t0 = Date.now();
  try {
    const res = await qxFetch(req);
    const elapsedMs = Math.max(1, Date.now() - t0);
    const status = Number(res.statusCode || res.status || 0);
    const ok = status >= 200 && status < 400;
    return { ok, status, elapsedMs, headers: res.headers || {} };
  } catch (e) {
    return { ok: false, status: 0, elapsedMs: Math.max(1, Date.now() - t0), error: String(e) };
  }
}

async function latencyOnce(policyName, timeoutMs) {
  const t0 = Date.now();
  try {
    const res = await $task.fetch({
      url: CF + "/__down?bytes=0&measId=" + Date.now() + "-" + Math.random(),
      method: "GET",
      timeout: timeoutMs,
      opts: { policy: policyName },
      headers: { "Cache-Control": "no-cache" }
    });
    const status = Number(res.statusCode || res.status || 0);
    if (!(status >= 200 && status < 400)) return null;
    return Math.max(1, Date.now() - t0);
  } catch (_) {
    return null;
  }
}

async function latencySeries(policyName, count, gapMs, timeoutMs) {
  const values = [];
  let failed = 0;
  for (let i = 0; i < count; i++) {
    const v = await latencyOnce(policyName, timeoutMs);
    if (v == null) failed++;
    else values.push(v);
    if (i !== count - 1 && gapMs > 0) await sleep(gapMs);
  }
  return summarizeLatency(values, count, failed);
}

function summarizeLatency(values, attempted, failed) {
  const sorted = values.slice().sort((a, b) => a - b);
  const med = percentile(sorted, 0.5);
  const p95 = percentile(sorted, 0.95);
  let jitter = null;
  if (values.length >= 2) {
    let sum = 0;
    for (let i = 1; i < values.length; i++) sum += Math.abs(values[i] - values[i - 1]);
    jitter = sum / (values.length - 1);
  }
  return {
    values,
    attempted,
    failed,
    lossPct: attempted ? failed * 100 / attempted : 100,
    min: sorted.length ? sorted[0] : null,
    median: med,
    p95,
    max: sorted.length ? sorted[sorted.length - 1] : null,
    jitter
  };
}

async function downloadGroup(policyName, n, bytes, timeoutMs) {
  const groupStart = Date.now();
  const jobs = [];
  for (let i = 0; i < n; i++) {
    jobs.push(timedFetch({
      url: CF + "/__down?bytes=" + bytes + "&measId=" + Date.now() + "-d-" + i + "-" + Math.random(),
      method: "GET",
      timeout: timeoutMs,
      opts: { policy: policyName },
      headers: { "Cache-Control": "no-cache" }
    }));
  }
  const rows = await Promise.all(jobs);
  const elapsedMs = Math.max(1, Date.now() - groupStart);
  const okRows = rows.filter(x => x.ok);
  const okCount = okRows.length;
  const totalBytes = okCount * bytes;
  const bps = okCount ? totalBytes * 8 * 1000 / elapsedMs : 0;
  return {
    streams: n,
    bytesPerStream: bytes,
    okCount,
    failedCount: n - okCount,
    elapsedMs,
    bps,
    rows
  };
}

async function uploadGroup(policyName, n, payload, timeoutMs) {
  const bytes = payload.length;
  const groupStart = Date.now();
  const jobs = [];
  for (let i = 0; i < n; i++) {
    jobs.push(timedFetch({
      url: CF + "/__up?measId=" + Date.now() + "-u-" + i + "-" + Math.random(),
      method: "POST",
      timeout: timeoutMs,
      opts: { policy: policyName },
      headers: {
        "Content-Type": "application/octet-stream",
        "Cache-Control": "no-cache"
      },
      body: payload
    }));
  }
  const rows = await Promise.all(jobs);
  const elapsedMs = Math.max(1, Date.now() - groupStart);
  const okRows = rows.filter(x => x.ok);
  const okCount = okRows.length;
  const totalBytes = okCount * bytes;
  const bps = okCount ? totalBytes * 8 * 1000 / elapsedMs : 0;
  return {
    streams: n,
    bytesPerStream: bytes,
    okCount,
    failedCount: n - okCount,
    elapsedMs,
    bps,
    rows
  };
}

function reduceRuns(runs) {
  const good = runs.filter(x => x && x.bps > 0);
  if (!good.length) return { bps: 0, elapsedMs: 0, okCount: 0, runs };
  const speeds = good.map(x => x.bps).sort((a, b) => a - b);
  const durations = good.map(x => x.elapsedMs).sort((a, b) => a - b);
  return {
    bps: percentile(speeds, 0.5),
    elapsedMs: percentile(durations, 0.5),
    okCount: good.length,
    runs
  };
}

async function getMeta(policyName) {
  try {
    const res = await $task.fetch({
      url: CF + "/meta?cb=" + Date.now(),
      timeout: 3500,
      opts: { policy: policyName },
      headers: { "Cache-Control": "no-cache" }
    });
    if (Number(res.statusCode || res.status || 0) >= 400) throw new Error("meta http error");
    const x = JSON.parse(res.body || "{}");
    return {
      clientIp: x.clientIp || "",
      asn: x.asn || "",
      asOrganization: x.asOrganization || "",
      colo: x.colo || "",
      country: x.country || "",
      city: x.city || "",
      region: x.region || "",
      httpProtocol: x.httpProtocol || ""
    };
  } catch (e) {
    try {
      const res = await $task.fetch({
        url: CF + "/cdn-cgi/trace?cb=" + Date.now(),
        timeout: 3500,
        opts: { policy: policyName },
        headers: { "Cache-Control": "no-cache" }
      });
      const trace = {};
      String(res.body || "").split("\n").forEach(line => {
        const p = line.indexOf("=");
        if (p > 0) trace[line.slice(0, p)] = line.slice(p + 1);
      });
      return {
        clientIp: trace.ip || "",
        asn: "",
        asOrganization: "",
        colo: trace.colo || "",
        country: trace.loc || "",
        city: "",
        region: "",
        httpProtocol: trace.http || ""
      };
    } catch (_) {
      return {};
    }
  }
}

async function getPolicyChain(policyName) {
  try {
    if (typeof $configuration === "undefined" || !$configuration.sendMessage) return policyName;
    const msg = { action: "get_policy_state", content: policyName };
    const res = await $configuration.sendMessage(msg);
    if (!res || res.error || !res.ret) return policyName;
    const v = res.ret[policyName];
    if (Array.isArray(v) && v.length) return [policyName].concat(v).join(" → ");
    if (v != null && String(v)) return policyName + " → " + String(v);
    return policyName;
  } catch (_) {
    return policyName;
  }
}

function renderPanel(r) {
  const idleMs = r.idle.median;
  const jitter = r.idle.jitter;
  const loss = r.idle.lossPct;
  const dlLoadedMs = r.downLoaded.median;
  const dlBloat = (dlLoadedMs != null && idleMs != null) ? Math.max(0, dlLoadedMs - idleMs) : null;
  const upLoadedMs = r.upLoaded ? r.upLoaded.median : null;
  const upBloat = (upLoadedMs != null && idleMs != null) ? Math.max(0, upLoadedMs - idleMs) : null;

  const singleDown = r.singleDownload.bps;
  const multiDown = r.multiDownload.bps;
  const downGain = singleDown > 0 ? (multiDown / singleDown - 1) * 100 : null;
  const singleUp = r.singleUpload ? r.singleUpload.bps : 0;
  const multiUp = r.multiUpload ? r.multiUpload.bps : 0;
  const upGain = singleUp > 0 ? (multiUp / singleUp - 1) * 100 : null;

  const meta = r.meta || {};
  const loc = [meta.city, meta.region, meta.country].filter(Boolean).join(", ") || "—";
  const asText = meta.asn ? ("AS" + meta.asn + (meta.asOrganization ? " · " + meta.asOrganization : "")) : (meta.asOrganization || "—");

  const titleColor = qualityColor(idleMs, jitter, loss, dlBloat);
  const quality = qualityLabel(idleMs, jitter, loss, dlBloat);
  const compactMeta = [
    r.profileName.toUpperCase(),
    r.streams + " streams",
    meta.colo ? "CF " + meta.colo : "CF",
    meta.httpProtocol || "HTTP"
  ].join(" · ");
  const downloadLine = speedInline("Download", singleDown, multiDown, r.streams, downGain);
  const uploadLine = r.singleUpload
    ? speedInline("Upload", singleUp, multiUp, r.streams, upGain)
    : "";
  const downloadDetail = "1× " + fmtBytes(r.singleBytes) + "/" + fmtMs(r.singleDownload.elapsedMs)
    + " · " + r.streams + "× " + fmtBytes(r.multiPerStream * r.streams) + "/" + fmtMs(r.multiDownload.elapsedMs);
  const uploadDetail = r.singleUpload
    ? "1× " + fmtBytes(r.singleUpload.bytesPerStream) + "/" + fmtMs(r.singleUpload.elapsedMs)
      + " · " + r.streams + "× " + fmtBytes(r.multiUpload.bytesPerStream * r.streams) + "/" + fmtMs(r.multiUpload.elapsedMs)
    : "";
  const loadedUp = r.upLoaded
    ? " · ↑ " + colored(fmtMs(upLoadedMs), metricColorBloat(upBloat)) + " (+" + escapeHtml(fmtMs(upBloat)) + ")"
    : "";
  const precisionWarning = r.multiDownload.elapsedMs < 450
    ? "<br><font color=\"#d97706\">Fast sample; use the heavy profile for a steadier high-speed result.</font>"
    : "";

  // Quantumult X's htmlMessage renderer only implements a small HTML/CSS
  // subset. Keep the panel linear: tables, flexbox, cards, and backgrounds are
  // intentionally avoided because they become detached white text boxes in
  // the native popup.
  return `<div style="font-family:-apple-system;font-size:15px;line-height:1.55;word-break:break-word;">
    <p style="text-align:center;margin:0;"><b>${escapeHtml(r.chain || r.policy)}</b><br><font color="#8e8e93">${escapeHtml(compactMeta)}</font></p>
    <hr>
    <p style="margin:0;"><b>Latency / quality</b><br>
      Idle ${colored(fmtMs(idleMs), metricColorLatency(idleMs))} · p95 ${escapeHtml(fmtMs(r.idle.p95))}<br>
      Jitter ${colored(fmtMs(jitter), metricColorJitter(jitter))} · loss ${colored(fmtPct(loss), metricColorLoss(loss))}<br>
      Loaded ↓ ${colored(fmtMs(dlLoadedMs), metricColorBloat(dlBloat))} (+${escapeHtml(fmtMs(dlBloat))})${loadedUp}
    </p>
    <hr>
    <p style="margin:0;"><b>Throughput</b><br>
      ${downloadLine}<br><font color="#8e8e93">${escapeHtml(downloadDetail)}</font>${precisionWarning}
      ${r.singleUpload ? `<br>${uploadLine}<br><font color="#8e8e93">${escapeHtml(uploadDetail)}</font>` : ""}
    </p>
    <hr>
    <p style="margin:0;"><b>Exit / edge</b><br>
      ${escapeHtml(meta.clientIp || "—")} · ${escapeHtml(loc)} · CF ${escapeHtml(meta.colo || "—")}<br>
      ${escapeHtml(asText)}
    </p>
    <hr>
    <p style="margin:0;"><b><font color="${titleColor}">${escapeHtml(quality)}</font></b> · ${escapeHtml(fmtSec(r.elapsedMs))} · ${escapeHtml(fmtBytes(r.estimatedTrafficBytes))}<br>
      <font color="#8e8e93">HTTP latency/loss are not ICMP or UDP measurements. NodeBenchmark-QX v${VERSION}</font>
    </p>
  </div>`;
}

function speedInline(label, singleBps, multiBps, streamCount, gain) {
  const singleText = speedText(singleBps);
  const multiText = speedText(multiBps);
  const gainText = gain == null ? "" : " (" + signedPct(gain) + ")";
  return `<b>${escapeHtml(label)}</b> · 1× ${colored(singleText, speedColor(singleBps / 1000000))}`
    + ` · ${streamCount}× ${colored(multiText, speedColor(multiBps / 1000000))}${escapeHtml(gainText)}`;
}

function speedText(bps) {
  if (!(bps > 0)) return "FAILED";
  const mbps = bps / 1000000;
  return fmtNum(mbps, mbps >= 100 ? 0 : 1) + " Mbps";
}

function colored(text, color) {
  return `<b><font color="${color}">${escapeHtml(text)}</font></b>`;
}

function finishError(title, body) {
  $done({
    title: "⚡ Node Benchmark",
    htmlMessage: `<p style="font-family:-apple-system;text-align:center;font-size:15px;line-height:1.55;"><b><font color="#d70015">${escapeHtml(title)}</font></b><br>${escapeHtml(body)}</p>`
  });
}

function makePayload(bytes) {
  // ASCII is intentional: predictable byte count for Quantumult X string request body.
  const chunk = "0123456789abcdef".repeat(4096); // 64 KiB
  let s = "";
  while (s.length + chunk.length <= bytes) s += chunk;
  if (s.length < bytes) s += chunk.slice(0, bytes - s.length);
  return s;
}

function percentile(sorted, p) {
  if (!sorted || !sorted.length) return null;
  if (sorted.length === 1) return sorted[0];
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function clampInt(v, lo, hi) { return Math.max(lo, Math.min(hi, Math.round(v || lo))); }
function roundBytes(v) { return Math.max(256 * KiB, Math.round(v / (256 * KiB)) * 256 * KiB); }

function fmtMs(v) {
  if (v == null || !isFinite(v)) return "—";
  return fmtNum(v, v < 100 ? 1 : 0) + " ms";
}
function fmtSec(ms) { return fmtNum(ms / 1000, 1) + " s"; }
function fmtPct(v) { return v == null ? "—" : fmtNum(v, v < 10 ? 1 : 0) + "%"; }
function signedPct(v) { return (v >= 0 ? "+" : "") + fmtNum(v, 0) + "%"; }
function fmtNum(v, d) { return Number(v || 0).toFixed(d); }
function fmtBytes(bytes) {
  if (!bytes || bytes < 0) return "0 B";
  if (bytes >= MiB) return fmtNum(bytes / MiB, bytes >= 10 * MiB ? 0 : 1) + " MiB";
  if (bytes >= KiB) return fmtNum(bytes / KiB, 0) + " KiB";
  return bytes + " B";
}

function metricColorLatency(ms) {
  if (ms == null) return "#d70015";
  if (ms <= 60) return "#16a34a";
  if (ms <= 120) return "#d97706";
  return "#d70015";
}
function metricColorJitter(ms) {
  if (ms == null) return "#d70015";
  if (ms <= 10) return "#16a34a";
  if (ms <= 30) return "#d97706";
  return "#d70015";
}
function metricColorLoss(pct) {
  if (pct == null) return "#d70015";
  if (pct === 0) return "#16a34a";
  if (pct <= 5) return "#d97706";
  return "#d70015";
}
function metricColorBloat(ms) {
  if (ms == null) return "#8e8e93";
  if (ms <= 30) return "#16a34a";
  if (ms <= 100) return "#d97706";
  return "#d70015";
}
function speedColor(mbps) {
  if (mbps >= 100) return "#16a34a";
  if (mbps >= 30) return "#007aff";
  if (mbps >= 10) return "#d97706";
  return "#d70015";
}
function qualityColor(latency, jitter, loss, bloat) {
  if (latency == null || loss > 5) return "#d70015";
  if (latency <= 80 && (jitter == null || jitter <= 15) && loss === 0 && (bloat == null || bloat <= 50)) return "#16a34a";
  return "#d97706";
}
function qualityLabel(latency, jitter, loss, bloat) {
  if (latency == null || loss > 5) return "Poor connection";
  if (latency <= 80 && (jitter == null || jitter <= 15) && loss === 0 && (bloat == null || bloat <= 50)) return "Good connection";
  return "Fair connection";
}
function escapeHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
