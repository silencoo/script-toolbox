import { isIP } from "node:net";
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
let allowCount = 0;
let blockCount = 0;
let reachedBlocks = false;

for (const [index, rawLine] of text.split(/\r?\n/).entries()) {
  const line = rawLine.trim();
  if (!line || line.startsWith("#")) continue;

  const match = line.match(/^HOST-SUFFIX,([^,]+),(direct|Ad Blocking)$/);
  if (!match) throw new Error(`${path}:${index + 1}: invalid rule: ${rawLine}`);

  const [, domain, policy] = match;
  if (domain.includes("*") || isIP(domain)) {
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
