const SOURCE_TIMEOUT_MS = 6000;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

const TEXT_SOURCES = [
  { url: "https://cf.001315.xyz/cfxyz", name: "CFXYZ", carrier: "ALL" },
  { url: "https://cf.001315.xyz/ct", name: "ADDAPI", carrier: "CT" },
  { url: "https://cf.001315.xyz/cu", name: "ADDAPI", carrier: "CU" },
  { url: "https://cf.001315.xyz/cmcc", name: "ADDAPI", carrier: "CM" },
  {
    url: "https://cf.001315.xyz/ip.164746.xyz",
    name: "ADDAPI",
    carrier: "ALL",
  },
];

const WETEST_URL =
  "https://www.wetest.vip/api/cf2dns/get_cloudflare_ip?key=o1zrmHAF&type=v4";
const HOSTMONIT_URL = "https://api.hostmonit.com/get_optimization_ip";

function normalizeIp(value) {
  const candidate = String(value || "").trim();
  const parts = candidate.split(".");

  if (
    parts.length === 4 &&
    parts.every(
      (part) => /^\d{1,3}$/.test(part) && Number(part) <= 255
    )
  ) {
    return candidate;
  }

  if (!candidate.includes(":") || !/^[0-9a-f:]+$/i.test(candidate)) {
    return null;
  }

  try {
    const hostname = new URL(`http://[${candidate}]/`).hostname;
    const normalized = hostname.replace(/^\[|\]$/g, "");
    return normalized.includes(":") ? `[${normalized}]` : null;
  } catch {
    return null;
  }
}

function toFiniteNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function parseSpeedLabel(label) {
  const match = String(label).match(/(\d+(?:\.\d+)?)\s*(MB\/s|Mbps)/i);
  if (!match) return null;

  const value = Number(match[1]);
  return match[2].toLowerCase() === "mb/s" ? value * 8 : value;
}

function parseTextSource(text, source) {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length === 0) return [];

  const candidates = [];

  for (const line of lines) {
    const separator = line.indexOf("#");
    if (separator <= 0) return [];

    const ip = normalizeIp(line.slice(0, separator));
    const sourceLabel = line.slice(separator + 1).trim();
    if (!ip || !sourceLabel) return [];

    candidates.push({
      ip,
      source: source.name,
      carrier: source.carrier,
      speedMbps: parseSpeedLabel(sourceLabel),
      latencyMs: null,
      lossRate: null,
    });
  }

  return candidates;
}

function parseJsonSource(payload, sourceName, carrierFilter) {
  if (!payload || payload.code !== 200 || !payload.info) return [];

  const groups = Array.isArray(payload.info)
    ? [["ALL", payload.info]]
    : Object.entries(payload.info);
  const candidates = [];

  for (const [rawCarrier, entries] of groups) {
    const carrier = String(rawCarrier).toUpperCase();
    if (!Array.isArray(entries)) return [];
    if (carrierFilter !== "ALL" && carrier !== carrierFilter) continue;

    for (const entry of entries) {
      const ip = normalizeIp(entry?.ip);
      if (!ip) return [];

      candidates.push({
        ip,
        source: sourceName,
        carrier,
        colo: String(entry.colo || "").toUpperCase(),
        speedMbps: toFiniteNumber(entry.speed),
        latencyMs: toFiniteNumber(entry.rtt_avg ?? entry.latency),
        lossRate: toFiniteNumber(entry.loss_rate ?? entry.loss),
      });
    }
  }

  return candidates;
}

async function fetchWithTimeout(url, init = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SOURCE_TIMEOUT_MS);

  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function loadTextSource(source, carrierFilter) {
  if (carrierFilter !== "ALL" && !["ALL", carrierFilter].includes(source.carrier)) {
    return [];
  }

  try {
    const response = await fetchWithTimeout(source.url, {
      headers: { accept: "text/plain" },
    });
    if (!response.ok) return [];
    return parseTextSource(await response.text(), source);
  } catch {
    return [];
  }
}

async function loadJsonSource(url, sourceName, carrierFilter, init) {
  try {
    const response = await fetchWithTimeout(url, init);
    if (!response.ok) return [];
    return parseJsonSource(await response.json(), sourceName, carrierFilter);
  } catch {
    return [];
  }
}

function qualityTuple(candidate) {
  return [
    candidate.speedMbps === null ? 0 : 1,
    candidate.speedMbps ?? -1,
    candidate.latencyMs === null ? 0 : 1,
    -(candidate.latencyMs ?? Number.MAX_SAFE_INTEGER),
    -(candidate.lossRate ?? Number.MAX_SAFE_INTEGER),
  ];
}

function compareCandidates(left, right) {
  const a = qualityTuple(left);
  const b = qualityTuple(right);

  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return b[index] - a[index];
  }

  return left.ip.localeCompare(right.ip);
}

function isBetter(candidate, current) {
  return compareCandidates(candidate, current) < 0;
}

function formatMetric(value, digits = 0) {
  return Number(value.toFixed(digits)).toString();
}

function buildCandidateName(candidate) {
  const isGenericPreferredSource = candidate.source === "ADDAPI";
  const parts = isGenericPreferredSource ? [] : [candidate.source];
  if (candidate.carrier && candidate.carrier !== "ALL") {
    parts.push(candidate.carrier);
  }
  if (isGenericPreferredSource) parts.push("Preferred");
  if (candidate.colo && candidate.colo !== "DEFAULT") parts.push(candidate.colo);
  if (candidate.speedMbps !== null) {
    parts.push(`${formatMetric(candidate.speedMbps, 1)} Mbps`);
  }
  if (candidate.latencyMs !== null) {
    parts.push(`${formatMetric(candidate.latencyMs, 1)} ms`);
  }
  if (candidate.lossRate !== null && candidate.lossRate > 0) {
    parts.push(`${formatMetric(candidate.lossRate * 100, 1)}% loss`);
  }
  if (parts.length === 1) parts.push(candidate.ip);
  return parts.join(" ");
}

function parseInteger(value, fallback, minimum, maximum) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed)
    ? Math.min(maximum, Math.max(minimum, parsed))
    : fallback;
}

function parseCarrier(value) {
  const carrier = String(value || "ALL").toUpperCase();
  return ["ALL", "CM", "CU", "CT", "CN"].includes(carrier)
    ? carrier
    : "ALL";
}

function parseVless(raw) {
  const match = raw.match(
    /^vless:\/\/([^@/?#]+)@(\[[^\]]+\]|[^:/?#]+)(?::(\d+))?(\?[^#]*)?(?:#.*)?$/i
  );
  if (!match) return null;

  const [, uuid, host, rawPort = "443", query = ""] = match;
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(uuid)) {
    return null;
  }

  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;

  return { uuid, host, port: String(port), query };
}

export default {
  async fetch(request) {
    const requestUrl = new URL(request.url);
    let raw;

    try {
      raw = decodeURIComponent(requestUrl.pathname.slice(1));
    } catch {
      return new Response("invalid encoded VLESS URL", { status: 400 });
    }

    const input = parseVless(raw);
    if (!input) {
      return new Response("invalid VLESS URL or UUID", { status: 400 });
    }

    const baseName = requestUrl.searchParams.get("name") || "base";
    const remark = requestUrl.searchParams.get("remark") || "";
    const prefix = remark ? `[${remark}] ` : "";
    const limit = parseInteger(
      requestUrl.searchParams.get("limit"),
      DEFAULT_LIMIT,
      1,
      MAX_LIMIT
    );
    const carrier = parseCarrier(requestUrl.searchParams.get("carrier"));
    const minimumSpeed = Math.max(
      0,
      toFiniteNumber(requestUrl.searchParams.get("minspeed")) ?? 0
    );

    const merged = new URLSearchParams(
      input.query.startsWith("?") ? input.query.slice(1) : ""
    );
    const controls = new Set(["name", "remark", "limit", "carrier", "minspeed"]);

    for (const [key, value] of requestUrl.searchParams.entries()) {
      if (!controls.has(key)) merged.set(key, value);
    }

    const finalQuery = merged.size > 0 ? `?${merged.toString()}` : "";
    const originalName = encodeURIComponent(prefix + baseName);
    const nodes = [
      `vless://${input.uuid}@${input.host}:${input.port}${finalQuery}#${originalName}`,
    ];

    const tasks = TEXT_SOURCES.map((source) =>
      loadTextSource(source, carrier)
    );
    tasks.push(loadJsonSource(WETEST_URL, "WeTest", carrier));
    tasks.push(
      loadJsonSource(HOSTMONIT_URL, "HostMonit", carrier, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key: "o1zrmHAF", type: "v4" }),
      })
    );

    const sourceResults = await Promise.all(tasks);
    const candidatesByIp = new Map();

    for (const candidate of sourceResults.flat()) {
      if (candidate.speedMbps !== null && candidate.speedMbps < minimumSpeed) {
        continue;
      }
      if (minimumSpeed > 0 && candidate.speedMbps === null) continue;

      const current = candidatesByIp.get(candidate.ip);
      if (!current || isBetter(candidate, current)) {
        candidatesByIp.set(candidate.ip, candidate);
      }
    }

    const originalIp = normalizeIp(input.host.replace(/^\[|\]$/g, ""));
    const ranked = [...candidatesByIp.values()]
      .filter((candidate) => candidate.ip !== originalIp)
      .sort(compareCandidates)
      .slice(0, limit);

    for (const candidate of ranked) {
      const name = encodeURIComponent(prefix + buildCandidateName(candidate));
      nodes.push(
        `vless://${input.uuid}@${candidate.ip}:${input.port}${finalQuery}#${name}`
      );
    }

    return new Response(nodes.join("\n"), {
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "cache-control": "no-store",
      },
    });
  },
};
