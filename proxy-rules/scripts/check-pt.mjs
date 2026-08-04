import { isIP } from "node:net";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const path = resolve(root, "rules/quantumultx/PT.list");
const text = await readFile(path, "utf8");
const seen = new Set();
const counts = { HOST: 0, "HOST-SUFFIX": 0 };

for (const [index, rawLine] of text.split(/\r?\n/).entries()) {
  const line = rawLine.trim();
  if (!line || line.startsWith("#")) continue;

  const match = line.match(/^(HOST|HOST-SUFFIX),([^,]+),PT$/);
  if (!match) throw new Error(`${path}:${index + 1}: invalid PT rule: ${rawLine}`);

  const [, type, domain] = match;
  if (domain.includes("*") || isIP(domain)) {
    throw new Error(`${path}:${index + 1}: invalid PT domain: ${domain}`);
  }
  if (seen.has(line)) throw new Error(`${path}:${index + 1}: duplicate PT rule`);
  seen.add(line);
  counts[type] += 1;
}

const total = counts.HOST + counts["HOST-SUFFIX"];
if (total < 200 || counts.HOST === 0 || counts["HOST-SUFFIX"] === 0) {
  throw new Error(`PT list coverage is unexpectedly small: ${JSON.stringify(counts)}`);
}

console.log(
  `Validated ${total} PT rules (${counts.HOST} hosts, ${counts["HOST-SUFFIX"]} suffixes).`,
);
