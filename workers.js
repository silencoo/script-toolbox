function formatIpHost(value) {
  const candidate = value.trim();
  const ipv4Parts = candidate.split(".");

  if (
    ipv4Parts.length === 4 &&
    ipv4Parts.every(
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

function parseApiResponse(text) {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length === 0) return [];

  const entries = [];

  for (const line of lines) {
    const separatorIndex = line.indexOf("#");
    if (separatorIndex <= 0) return [];

    const ip = formatIpHost(line.slice(0, separatorIndex));
    const name = line.slice(separatorIndex + 1).trim();
    if (!ip || !name) return [];

    entries.push({ ip, name });
  }

  return entries;
}

export default {
  async fetch(request) {
    const requestUrl = new URL(request.url);
    const raw = decodeURIComponent(requestUrl.pathname.slice(1));

    if (!raw.startsWith("vless://")) {
      return new Response("invalid vless url", { status: 400 });
    }

    /* Control parameters */
    const baseName = requestUrl.searchParams.get("name") || "base";
    const remark = requestUrl.searchParams.get("remark") || "";
    const prefix = remark ? `[${remark}] ` : "";

    /* Parse VLESS manually because URL does not support this scheme reliably. */
    const match = raw.match(
      /^vless:\/\/([^@]+)@([^:/?#]+)(?::(\d+))?(\?[^#]*)?$/
    );
    if (!match) return new Response("bad vless format", { status: 400 });

    const [, uuid, host, port = "443", vlessQuery = ""] = match;

    /* Merge the VLESS and Worker query parameters. */
    const merged = new URLSearchParams(
      vlessQuery.startsWith("?") ? vlessQuery.slice(1) : ""
    );

    for (const [key, value] of requestUrl.searchParams.entries()) {
      if (key === "name" || key === "remark") continue;
      merged.set(key, value);
    }

    const finalQuery = merged.toString() ? `?${merged.toString()}` : "";
    const nodes = [];

    /* Always retain the original node. */
    nodes.push(
      `vless://${uuid}@${host}:${port}${finalQuery}#${encodeURIComponent(prefix + baseName)}`
    );

    /* Sources that provide one IP#name entry per line. */
    const apis = ["https://cf.001315.xyz/ip.164746.xyz"];
    const seen = new Set();

    for (const api of apis) {
      try {
        const response = await fetch(api, {
          headers: { accept: "text/plain" },
        });
        if (!response.ok) continue;

        const entries = parseApiResponse(await response.text());

        for (const { ip, name } of entries) {
          if (seen.has(ip)) continue;
          seen.add(ip);

          nodes.push(
            `vless://${uuid}@${ip}:${port}${finalQuery}#${encodeURIComponent(prefix + name)}`
          );
        }
      } catch {
        // Ignore unavailable sources and retain the nodes already collected.
      }
    }

    return new Response(nodes.join("\n"), {
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  },
};
