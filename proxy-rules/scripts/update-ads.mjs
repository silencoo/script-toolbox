import { isIP } from "node:net";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { domainToASCII, fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const goodbyeAdsRoot =
  "https://raw.githubusercontent.com/8680/GOODBYEADS/master/data/rules";

const sources = {
  goodbyeAdsBlock: `${goodbyeAdsRoot}/ad-domain.txt`,
  goodbyeAdsAllow: `${goodbyeAdsRoot}/allow.txt`,
  catsTeamBlock:
    "https://raw.githubusercontent.com/Cats-Team/AdRules/main/qx.conf",
};

async function download(url) {
  const response = await fetch(url, {
    headers: { "user-agent": "isolated-ai-routing-rules updater" },
  });
  if (!response.ok) {
    throw new Error(`Failed to download ${url}: HTTP ${response.status}`);
  }
  return response.text();
}

export function normalizeDomain(input) {
  let domain = input.trim().toLowerCase();
  while (domain.startsWith("*.")) domain = domain.slice(2);
  domain = domain.replace(/^\.+|\.+$/g, "");

  // domainToASCII uses URL host parsing and silently turns values such as
  // "amazon.com/path" into "amazon.com". Reject URL and filter syntax before
  // conversion so path-scoped upstream rules cannot become broad suffix rules.
  if (!domain || isIP(domain)) return null;
  if (domain.length > 253 || /[\s/\\?#@*:$|%^]/.test(domain)) return null;

  domain = domainToASCII(domain);
  if (!domain || isIP(domain) || domain.length > 253) return null;

  const labels = domain.split(".");
  if (labels.length < 2) return null;
  if (
    labels.some(
      (label) =>
        !label ||
        label.length > 63 ||
        label.startsWith("-") ||
        label.endsWith("-") ||
        !/^[a-z0-9_-]+$/.test(label),
    )
  ) {
    return null;
  }

  return domain;
}

function parsePlainBlockDomains(text) {
  const domains = new Set();
  let skipped = 0;

  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const domain = normalizeDomain(trimmed);
    if (domain) domains.add(domain);
    else skipped += 1;
  }

  if (domains.size < 50_000) {
    throw new Error(`Upstream block list is unexpectedly small: ${domains.size}`);
  }
  return { domains, skipped };
}

function parseQuantumultXBlockDomains(text) {
  const domains = new Set();
  let skipped = 0;

  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const fields = trimmed.split(",").map((field) => field.trim());
    if (fields[0]?.toUpperCase() !== "HOST-SUFFIX") {
      skipped += 1;
      continue;
    }

    const domain = normalizeDomain(fields[1] ?? "");
    if (domain) domains.add(domain);
    else skipped += 1;
  }

  if (domains.size < 100_000) {
    throw new Error(`Cats-Team block list is unexpectedly small: ${domains.size}`);
  }
  return { domains, skipped };
}

function parseAllowDomains(text) {
  const domains = new Set();
  for (const line of text.split(/\r?\n/)) {
    const match = line.trim().match(/^@@\|\|([^/^$*|]+)\^$/);
    if (!match) continue;
    const domain = normalizeDomain(match[1]);
    if (domain) domains.add(domain);
  }
  return domains;
}

function header(name, total) {
  return [
    `# NAME: ${name}`,
    "# GENERATED: scripts/update-ads.mjs; do not edit manually",
    `# UPSTREAM-BLOCK: ${sources.goodbyeAdsBlock}`,
    `# UPSTREAM-BLOCK: ${sources.catsTeamBlock}`,
    `# UPSTREAM-ALLOW: ${sources.goodbyeAdsAllow}`,
    "# LICENSE: generated data retains applicable upstream terms; see NOTICE.md",
    `# TOTAL: ${total}`,
  ];
}

function quantumultXOutput(blockDomains, allowDomains) {
  return [
    ...header("Ads", blockDomains.length + allowDomains.length),
    "# Allow rules must remain before block rules. Do not use force-policy.",
    ...allowDomains.map((domain) => `HOST-SUFFIX,${domain},direct`),
    ...blockDomains.map((domain) => `HOST-SUFFIX,${domain},Ad Blocking`),
    "",
  ].join("\n");
}

async function emit(relativePath, content) {
  const path = resolve(root, relativePath);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}

async function main() {
  const [goodbyeAdsBlockText, goodbyeAdsAllowText, catsTeamBlockText] =
    await Promise.all([
      download(sources.goodbyeAdsBlock),
      download(sources.goodbyeAdsAllow),
      download(sources.catsTeamBlock),
    ]);

  const goodbyeAds = parsePlainBlockDomains(goodbyeAdsBlockText);
  const catsTeam = parseQuantumultXBlockDomains(catsTeamBlockText);
  const allowSet = parseAllowDomains(goodbyeAdsAllowText);
  const overlap = [...catsTeam.domains].filter((domain) =>
    goodbyeAds.domains.has(domain),
  ).length;
  const mergedBlockSet = new Set([...goodbyeAds.domains, ...catsTeam.domains]);
  let removedByAllow = 0;

  for (const domain of [...mergedBlockSet]) {
    let candidate = domain;
    while (candidate.includes(".")) {
      if (allowSet.has(candidate)) {
        mergedBlockSet.delete(domain);
        removedByAllow += 1;
        break;
      }
      candidate = candidate.slice(candidate.indexOf(".") + 1);
    }
  }

  if (mergedBlockSet.size < 150_000) {
    throw new Error(
      `Merged block list is unexpectedly small: ${mergedBlockSet.size}`,
    );
  }

  const blockDomains = [...mergedBlockSet].sort();
  const allowDomains = [...allowSet].sort();

  await Promise.all([
    emit(
      "rules/quantumultx/Ads.list",
      quantumultXOutput(blockDomains, allowDomains),
    ),
  ]);

  console.log(
    `Generated ${blockDomains.length} merged block domains and ${allowDomains.length} allow domains; ` +
      `${goodbyeAds.domains.size} GOODBYEADS, ${catsTeam.domains.size} Cats-Team, ` +
      `${overlap} overlap, ${removedByAllow} removed by allow rules, ` +
      `${goodbyeAds.skipped + catsTeam.skipped} invalid or unsupported entries skipped.`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
