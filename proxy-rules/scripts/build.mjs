import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const checkOnly = process.argv.includes("--check");

const ruleSets = [
  { source: "gemini.rules", name: "Gemini", file: "gemini", policy: "Gemini" },
  { source: "openai.rules", name: "OpenAI", policy: "AI" },
  { source: "claude.rules", name: "Claude", policy: "AI" },
  { source: "other-ai.rules", name: "OtherAI", policy: "AI" },
  {
    source: "ai-models.rules",
    name: "AI Models",
    file: "AIModels",
    policy: "AI Models",
    notices: [
      "# SOURCES: live Civitai services; Hugging Face Hub download docs",
      "# LICENSE: GPL-2.0; see proxy-rules/LICENSE.GPL-2.0",
      "# CURATED: 2026-08-05; first-party model hub and download domains",
    ],
  },
  {
    source: "bytedance.rules",
    name: "ByteDance",
    policy: "WeChat",
    notices: [
      "# SOURCE: fmz200/wool_scripts ByteDance.list",
      "# LICENSE: GPL-3.0-only; see proxy-rules/LICENSE.GPL-3.0",
      "# MODIFIED: 2026-08-05; normalized and separated from TikTok",
    ],
  },
  {
    source: "tiktok.rules",
    name: "TikTok",
    policy: "TikTok",
    notices: [
      "# SOURCE: blackmatrix7/ios_rule_script TikTok.list",
      "# LICENSE: GPL-2.0; see proxy-rules/LICENSE.GPL-2.0",
      "# MODIFIED: 2026-08-05; normalized client-neutral source",
    ],
  },
  {
    source: "github.rules",
    name: "GitHub",
    policy: "GitHub",
    notices: [
      "# SOURCE: blackmatrix7/ios_rule_script GitHub.list",
      "# LICENSE: GPL-2.0; see proxy-rules/LICENSE.GPL-2.0",
      "# MODIFIED: 2026-08-05; normalized client-neutral source",
    ],
  },
  {
    source: "docker.rules",
    name: "Docker",
    policy: "Docker",
    notices: [
      "# SOURCE: blackmatrix7/ios_rule_script Docker.list",
      "# LICENSE: GPL-2.0; see proxy-rules/LICENSE.GPL-2.0",
      "# MODIFIED: 2026-08-05; normalized client-neutral source",
    ],
  },
];

const qxType = new Map([
  ["DOMAIN", "HOST"],
  ["DOMAIN-SUFFIX", "HOST-SUFFIX"],
  ["DOMAIN-KEYWORD", "HOST-KEYWORD"],
  ["IP-CIDR", "IP-CIDR"],
  ["IP-CIDR6", "IP-CIDR6"],
  ["IP-ASN", "IP-ASN"],
  ["USER-AGENT", "USER-AGENT"],
]);

function parseRules(text, source) {
  const rules = [];
  const seen = new Set();

  for (const [index, rawLine] of text.split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const fields = line.split(",").map((field) => field.trim());
    if (fields.length !== 2 || !qxType.has(fields[0])) {
      throw new Error(`${source}:${index + 1}: invalid rule: ${rawLine}`);
    }

    const normalized = fields.join(",");
    if (seen.has(normalized)) {
      throw new Error(`${source}:${index + 1}: duplicate rule: ${normalized}`);
    }
    seen.add(normalized);
    rules.push(fields);
  }

  return rules;
}

function quantumultXOutput(name, policy, rules, notices = []) {
  return [
    `# NAME: ${name}`,
    "# GENERATED: scripts/build.mjs; edit sources/*.rules instead",
    ...notices,
    `# TOTAL: ${rules.length}`,
    ...rules.map(([type, value]) => `${qxType.get(type)},${value},${policy}`),
    "",
  ].join("\n");
}

async function emit(relativePath, expected) {
  const path = resolve(root, relativePath);
  if (checkOnly) {
    let actual;
    try {
      actual = await readFile(path, "utf8");
    } catch {
      throw new Error(`${relativePath} is missing; run npm run build`);
    }
    if (actual !== expected) {
      throw new Error(`${relativePath} is stale; run npm run build`);
    }
    return;
  }

  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, expected);
}

for (const ruleSet of ruleSets) {
  const sourceText = await readFile(resolve(root, "sources", ruleSet.source), "utf8");
  const rules = parseRules(sourceText, ruleSet.source);
  await emit(
    `rules/quantumultx/${ruleSet.file ?? ruleSet.name}.list`,
    quantumultXOutput(ruleSet.name, ruleSet.policy, rules, ruleSet.notices),
  );
}

console.log(checkOnly ? "Generated rules are current." : "Generated rule files.");
