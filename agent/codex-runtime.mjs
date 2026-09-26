import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export class CodexRuntimeError extends Error {}

const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const nonempty = (value) => typeof value === "string" && value.trim().length > 0;

// Explicit JavaScript CLI paths also work on Windows, where CreateProcess
// cannot execute a shebang. Native Codex executables keep their normal argv.
export function spawnCodex(executable, args, options) {
  return /\.[cm]?js$/i.test(executable)
    ? spawn(process.execPath, [executable, ...args], options)
    : spawn(executable, args, options);
}

// Match Codex's local token decoding contract. This does not verify signatures
// or contact OAuth services; a readable snapshot need not be a live credential.
export function chatgptAccountId(value) {
  if (!object(value) || !object(value.tokens)) return null;
  if (value.OPENAI_API_KEY != null && typeof value.OPENAI_API_KEY !== "string") return null;
  const mode = value.auth_mode ?? (value.personal_access_token != null ? "pat"
    : value.bedrock_api_key != null || value.bedrock_access_keys != null ? "bedrock"
    : value.OPENAI_API_KEY != null ? "apikey" : "chatgpt");
  if (mode !== "chatgpt") return null;
  const tokens = value.tokens;
  if (!["access_token", "refresh_token", "id_token"].every((key) => nonempty(tokens[key])) ||
      !nonempty(tokens.account_id) || tokens.account_id.length > 1024) return null;
  if (value.last_refresh != null && (typeof value.last_refresh !== "string" ||
      !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(value.last_refresh) ||
      Number.isNaN(Date.parse(value.last_refresh)))) return null;
  try {
    const [header, payload, signature] = tokens.id_token.split(".");
    if (!header || !payload || !signature || !/^[A-Za-z0-9_-]+$/.test(payload)) return null;
    const bytes = Buffer.from(payload, "base64url");
    if (bytes.toString("base64url") !== payload) return null;
    const claims = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (!object(claims)) return null;
    const optionalStrings = (entry, keys) => keys.every((key) =>
      entry[key] == null || typeof entry[key] === "string");
    if (!optionalStrings(claims, ["email"])) return null;
    const profile = claims["https://api.openai.com/profile"];
    if (profile != null && (!object(profile) || !optionalStrings(profile, ["email"]))) return null;
    const auth = claims["https://api.openai.com/auth"];
    if (auth != null && (!object(auth) || !optionalStrings(auth, [
      "chatgpt_plan_type", "chatgpt_user_id", "user_id", "chatgpt_account_id"
    ]) || (auth.chatgpt_account_is_fedramp !== undefined &&
      typeof auth.chatgpt_account_is_fedramp !== "boolean"))) return null;
    return tokens.account_id;
  } catch {
    return null;
  }
}

export async function validateCodexSnapshot(bytes, { codexBin, environment = process.env }) {
  const temporary = await mkdtemp(join(tmpdir(), "agentctl-codex-auth-"));
  try {
    await writeFile(join(temporary, "auth.json"), bytes, { mode: 0o600 });
    const env = { ...environment, CODEX_HOME: temporary };
    for (const name of ["OPENAI_API_KEY", "CODEX_ACCESS_TOKEN", "CODEX_API_KEY",
      "OPENAI_FEDERATION_RULE_ID", "OPENAI_IDENTITY_TOKEN_FILE", "OPENAI_WORKLOAD_IDENTITY_CONTEXT"
    ]) delete env[name];
    await new Promise((resolveValidation, reject) => {
      const child = spawnCodex(codexBin, ["-c", 'cli_auth_credentials_store="file"', "login", "status"], {
        env, stdio: "ignore", windowsHide: true
      });
      const timer = setTimeout(() => child.kill("SIGKILL"), 10000);
      child.once("error", () => {
        clearTimeout(timer);
        reject(new CodexRuntimeError("cannot run Codex to validate the account snapshot"));
      });
      child.once("exit", (code) => {
        clearTimeout(timer);
        if (code === 0) resolveValidation();
        else reject(new CodexRuntimeError("Codex could not load the account snapshot; live account preserved"));
      });
    });
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

// Read the effective config through Codex, including managed requirements and
// system layers. A regex over the user TOML cannot establish the active store.
export async function readCodexCredentialStore(options) {
  if (basename(options.authFile) !== "auth.json") {
    throw new CodexRuntimeError("the live Codex auth path must end in auth.json");
  }
  try {
    const details = await stat(dirname(options.authFile));
    if (!details.isDirectory()) throw new CodexRuntimeError("Codex home must be a directory");
    return await readCredentialStoreRpc(options);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  // An absent home has no user layer. Read system/managed configuration in an
  // empty temporary home without creating the user's live directory in preview.
  const temporary = await mkdtemp(join(tmpdir(), "agentctl-codex-config-"));
  try { return await readCredentialStoreRpc({ ...options, authFile: join(temporary, "auth.json") }); }
  finally { await rm(temporary, { recursive: true, force: true }); }
}

function readCredentialStoreRpc({
  authFile,
  codexBin = process.env.AGENTCTL_CODEX_BIN || "codex",
  environment = process.env,
  cwd = process.cwd(),
  strictConfig = false,
  timeoutMs = 10000
}) {
  if (basename(authFile) !== "auth.json") {
    throw new CodexRuntimeError("the live Codex auth path must end in auth.json");
  }
  return new Promise((resolveStore, reject) => {
    let finished = false;
    let pending = "";
    let bytes = 0;
    const child = spawnCodex(codexBin, ["app-server", "--listen", "stdio://",
      ...(strictConfig ? ["--strict-config"] : [])], {
      env: { ...environment, CODEX_HOME: dirname(resolve(authFile)) },
      stdio: ["pipe", "pipe", "ignore"],
      windowsHide: true
    });
    const finish = (error, mode) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      child.stdin.destroy();
      child.stdout.destroy();
      child.kill();
      if (error) reject(new CodexRuntimeError(error));
      else resolveStore(mode);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish("Codex config read timed out; no account files were changed");
    }, timeoutMs);
    const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
    child.on("error", () => finish("cannot run Codex to read its effective credential store"));
    child.stdin.on("error", () => finish("Codex config connection closed"));
    child.on("exit", () => finish("Codex did not return its effective credential store"));
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > 8 * 1024 * 1024) return finish("Codex config response exceeded the size limit");
      pending += chunk;
      while (!finished && pending.includes("\n")) {
        const index = pending.indexOf("\n");
        const line = pending.slice(0, index);
        pending = pending.slice(index + 1);
        let message;
        try { message = JSON.parse(line); }
        catch { return finish("Codex returned an invalid config response"); }
        if (![1, 2].includes(message.id)) continue;
        if (message.error) return finish("Codex could not resolve its effective configuration");
        if (message.id === 1) {
          send({ method: "initialized" });
          send({ id: 2, method: "config/read", params: { includeLayers: false, cwd } });
        } else {
          if (!object(message.result?.config)) return finish("Codex config response is missing config");
          const mode = message.result.config.cli_auth_credentials_store ?? "file";
          if (!["file", "keyring", "auto", "ephemeral"].includes(mode)) {
            return finish("Codex returned an unknown credential store");
          }
          finish(null, mode);
        }
      }
    });
    send({ id: 1, method: "initialize", params: {
      clientInfo: { name: "agentctl-account", version: "1" }
    } });
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const authFile = process.argv[2];
  try {
    const mode = await readCodexCredentialStore({ authFile });
    let value = null;
    if (mode === "file") {
      try { value = JSON.parse(await readFile(authFile, "utf8")); } catch {}
    }
    process.stdout.write(`${JSON.stringify({ credential_store: mode,
      official_login: Boolean(chatgptAccountId(value)) })}\n`);
  } catch {
    process.stdout.write('{"credential_store":"unknown","official_login":false}\n');
  }
}
