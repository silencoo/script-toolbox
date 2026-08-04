import { isIP } from "node:net";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { domainToASCII, fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const upstream =
  "https://raw.githubusercontent.com/blackmatrix7/ios_rule_script/master/rule/QuantumultX/PrivateTracker/PrivateTracker.list";
const allowedTypes = new Set(["HOST", "HOST-SUFFIX"]);

function normalizeDomain(input) {
  const domain = domainToASCII(input.trim().toLowerCase().replace(/^\.+|\.+$/g, ""));
  if (!domain || isIP(domain) || domain.length > 253 || /[\s/*:$|]/.test(domain)) {
    return null;
  }

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

const response = await fetch(upstream, {
  headers: { "user-agent": "script-toolbox PT rule updater" },
});
if (!response.ok) {
  throw new Error(`Failed to download ${upstream}: HTTP ${response.status}`);
}

const rules = new Map();
let excludedBroadOrIp = 0;
let invalid = 0;

for (const rawLine of (await response.text()).split(/\r?\n/)) {
  const line = rawLine.trim();
  if (!line || line.startsWith("#")) continue;

  const fields = line.split(",").map((field) => field.trim());
  const type = fields[0];
  if (!allowedTypes.has(type)) {
    excludedBroadOrIp += 1;
    continue;
  }

  const domain = normalizeDomain(fields[1] ?? "");
  if (!domain) {
    invalid += 1;
    continue;
  }
  rules.set(`${type},${domain}`, { type, domain });
}

const entries = [...rules.values()].sort((a, b) =>
  a.type === b.type ? a.domain.localeCompare(b.domain) : a.type.localeCompare(b.type),
);
if (entries.length < 200) {
  throw new Error(`Filtered PT list is unexpectedly small: ${entries.length}`);
}

const output = [
  "# NAME: PT",
  "# GENERATED: scripts/update-pt.mjs; do not edit manually",
  `# UPSTREAM: ${upstream}`,
  "# FILTER: exact HOST and HOST-SUFFIX only; keyword and IP rules excluded",
  `# TOTAL: ${entries.length}`,
  ...entries.map(({ type, domain }) => `${type},${domain},PT`),
  "",
].join("\n");

const path = resolve(root, "rules/quantumultx/PT.list");
await mkdir(dirname(path), { recursive: true });
await writeFile(path, output);

console.log(
  `Generated ${entries.length} PT rules; excluded ${excludedBroadOrIp} keyword/IP rules and ${invalid} invalid entries.`,
);
