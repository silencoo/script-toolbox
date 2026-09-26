#!/usr/bin/env node
// Offline Codex process fixture: exercise the RPC lifecycle without an account.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

export function serveConfig() {
  const lines = createInterface({ input: process.stdin });
  lines.on("line", (line) => {
    const request = JSON.parse(line);
    let result;
    if (request.method === "initialize") result = { userAgent: "fake-codex" };
    else if (request.method === "config/read") {
      let mode = "file";
      for (const name of ["config.toml", "requirements.toml"]) {
        let text = "";
        try { text = readFileSync(join(process.env.CODEX_HOME, name), "utf8"); } catch {}
        mode = /cli_auth_credentials_store\s*=\s*["']([^"']+)["']/.exec(text)?.[1] || mode;
      }
      result = { config: { cli_auth_credentials_store: mode } };
    } else return;
    process.stdout.write(`${JSON.stringify({ id: request.id, result })}\n`);
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.includes("app-server")) serveConfig();
  else if (process.argv.includes("--version")) process.stdout.write("codex test-version\n");
  else if (process.argv.includes("login") && process.argv.includes("status")) {
    process.exitCode = process.env.FAKE_CODEX_REJECT_SNAPSHOT ? 1 : 0;
  }
  else process.exitCode = 1;
}
