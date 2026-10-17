// Discover new shell/Node regressions automatically; keep this portable to Bash 3.2.
import { readdirSync } from "node:fs";
import { dirname, join, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = dirname(fileURLToPath(import.meta.url));
function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (["node_modules", "dist", ".venv", "__pycache__"].includes(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(path);
    else if (entry.isFile()) yield path;
  }
}
let failed = false;
for (const path of walk(root)) {
  const name = basename(path);
  let command;
  if (name.endsWith(".test.mjs") || name === "test.mjs") command = [process.execPath, "--test", path];
  else if ((name.endsWith("-test.sh") || name === "test.sh") && path !== join(root, "test.sh")) command = ["bash", path];
  else continue;
  console.log(`Testing ${path.slice(root.length + 1)}`);
  const result = spawnSync(command[0], command.slice(1), { stdio: "inherit" });
  if (result.status !== 0) failed = true;
}
process.exitCode = failed ? 1 : 0;
