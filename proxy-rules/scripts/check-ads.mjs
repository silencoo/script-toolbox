import { normalizeDomain } from "./update-ads.mjs";
import { assertSafeBlocks, assertRoutingOrder, compactSuffixes } from "./ads-safety.mjs";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const path = resolve(root, "rules/quantumultx/Ads.list");
const text = await readFile(path, "utf8");
const expectedUpstreams = [
  "8680/GOODBYEADS/master/data/rules/ad-domain.txt",
  "Cats-Team/AdRules/main/qx.conf",
];
for (const upstream of expectedUpstreams) {
  if (!text.includes(upstream)) {
    throw new Error(`${path}: missing upstream attribution: ${upstream}`);
  }
}

const declaredTotal = Number(text.match(/^# TOTAL: (\d+)$/m)?.[1]);
if (!Number.isInteger(declaredTotal)) {
  throw new Error(`${path}: missing or invalid TOTAL header`);
}

const seenDomains = new Set();
const allowDomains = new Set();
const blockDomains = new Set();
let allowCount = 0;
let blockCount = 0;
let reachedBlocks = false;

for (const [index, rawLine] of text.split(/\r?\n/).entries()) {
  const line = rawLine.trim();
  if (!line || line.startsWith("#")) continue;

  const match = line.match(/^HOST-SUFFIX,([^,]+),(direct|Ad Blocking)$/);
  if (!match) throw new Error(`${path}:${index + 1}: invalid rule: ${rawLine}`);

  const [, domain, policy] = match;
  if (normalizeDomain(domain) !== domain) {
    throw new Error(`${path}:${index + 1}: invalid domain: ${domain}`);
  }
  if (seenDomains.has(domain)) {
    throw new Error(`${path}:${index + 1}: duplicate domain: ${domain}`);
  }
  seenDomains.add(domain);

  if (policy === "Ad Blocking") {
    let candidate = domain;
    while (candidate.includes(".")) {
      if (allowDomains.has(candidate)) {
        throw new Error(
          `${path}:${index + 1}: block domain is covered by allow rule: ${domain}`,
        );
      }
      candidate = candidate.slice(candidate.indexOf(".") + 1);
    }
    blockDomains.add(domain);
    reachedBlocks = true;
    blockCount += 1;
  } else {
    if (reachedBlocks) {
      throw new Error(`${path}:${index + 1}: allow rule appears after block rules`);
    }
    allowDomains.add(domain);
    allowCount += 1;
  }
}

if (blockCount < 150_000) throw new Error(`Ads list is too small: ${blockCount}`);
if (declaredTotal !== blockCount + allowCount) {
  throw new Error(
    `${path}: TOTAL header is ${declaredTotal}, counted ${blockCount + allowCount}`,
  );
}
console.log(`Validated ${blockCount} block rules and ${allowCount} allow rules.`);

assertSafeBlocks(blockDomains);
if (compactSuffixes(blockDomains).size !== blockDomains.size ||
    compactSuffixes(allowDomains).size !== allowDomains.size) {
  throw new Error("Redundant suffix rules: run npm run compact:ads");
}
const template = await readFile(resolve(root, "templates/quantumult-x.conf"), "utf8");
const remoteSection = template.split("[filter_remote]")[1]?.split(/\n\[/)[0] ?? "";
const resources = [];
for (const line of remoteSection.split(/\r?\n/)) {
  if (line.trim().startsWith("#") || /enabled=false/.test(line)) continue;
  const name = line.match(/\/rules\/quantumultx\/([^/,]+\.list),/)?.[1];
  if (name) resources.push({ name, text: name === "Ads.list" ? "" :
    await readFile(resolve(root, "rules/quantumultx", name), "utf8") });
}
assertRoutingOrder(blockDomains, resources);
