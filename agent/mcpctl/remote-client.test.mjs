import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cp, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  backupStore,
  decryptValue,
  encryptValue,
  initializeRemote,
  makeRecoveryCode,
  parseRecoveryCode,
  readEncryptedLocalSecrets,
  restoreStore,
  SNAPSHOT_INFO
} from "./remote-client.mjs";
import worker from "../../workers/mcp-store/worker.js";
import { MemoryR2Bucket } from "../../workers/mcp-store/test-memory-r2.mjs";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(TEST_DIR, "../..");
const REMOTE_CLIENT = join(TEST_DIR, "remote-client.mjs");
const MCPCTL = join(TEST_DIR, "mcpctl");
const TEMPLATE_STORE = join(TEST_DIR, "template-store");
const CREATE_TOKEN = "remote-test-create-token".padEnd(48, "C");

async function run(command, arguments_, options = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, arguments_, {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        ...options.env
      },
      shell: false,
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", rejectPromise);
    child.on("close", (code) => {
      if (code === 0) {
        resolvePromise({ stdout, stderr });
      } else {
        rejectPromise(new Error(
          `${command} exited ${code}\nstdout:\n${stdout}\nstderr:\n${stderr}`
        ));
      }
    });
    child.stdin.end(options.input || "");
  });
}

function installWorkerFetch() {
  const env = {
    MCP_STORE: new MemoryR2Bucket(),
    MAX_BLOB_BYTES: "5242880",
    CREATE_TOKEN
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, options) => {
    const request = input instanceof Request
      ? new Request(input, options)
      : new Request(String(input), options);
    return worker.fetch(request, env);
  };
  return {
    endpoint: "http://localhost",
    env,
    close: () => { globalThis.fetch = originalFetch; }
  };
}

test("recovery codes round-trip the endpoint, store ID, and root key", () => {
  const config = {
    schema: 1,
    endpoint: "https://backup.example",
    store_id: "0123456789abcdef0123456789abcdef",
    root_key: Buffer.alloc(32, 7).toString("base64url")
  };
  const code = makeRecoveryCode(config);
  assert.match(code, /^mcpstore1_[A-Za-z0-9_-]+$/);
  assert.deepEqual(parseRecoveryCode(code), config);
  assert.throws(() => parseRecoveryCode("mcpstore1_not-valid-json"));
});

test("snapshot authentication rejects tampering and cross-store replay", () => {
  const config = {
    schema: 1,
    endpoint: "https://backup.example",
    store_id: "0123456789abcdef0123456789abcdef",
    root_key: Buffer.alloc(32, 9).toString("base64url")
  };
  const envelope = encryptValue(
    "mcpctl-snapshot",
    SNAPSHOT_INFO,
    config,
    { schema: 1, secret: "not-plaintext-on-disk" }
  );
  const replacement = envelope.ciphertext.startsWith("A") ? "B" : "A";
  const tampered = {
    ...envelope,
    ciphertext: `${replacement}${envelope.ciphertext.slice(1)}`
  };
  assert.throws(
    () => decryptValue("mcpctl-snapshot", SNAPSHOT_INFO, config, tampered),
    /authentication failed/
  );
  assert.throws(
    () => decryptValue(
      "mcpctl-snapshot",
      SNAPSHOT_INFO,
      { ...config, store_id: "fedcba9876543210fedcba9876543210" },
      envelope
    ),
    /authentication failed/
  );
});

test("backs up ciphertext, restores on a fresh machine, and applies cached secrets", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "mcpctl-remote-test-"));
  const sourceStore = join(testRoot, "source-store");
  const restoredStore = join(testRoot, "restored-store");
  const sourceConfig = join(testRoot, "source-remote.json");
  const restoredConfig = join(testRoot, "restored-remote.json");
  const testHome = join(testRoot, "home");
  const claudeConfig = join(testHome, ".claude", "settings.json");
  const service = installWorkerFetch();

  try {
    await cp(TEMPLATE_STORE, sourceStore, { recursive: true });
    const secretEnvironment = {
      BRAVE_API_KEY: "remote-test-brave-secret",
      EXA_API_KEY: "remote-test-exa-secret",
      CONTEXT7_API_KEY: "remote-test-context7-secret"
    };

    await initializeRemote({
      endpoint: service.endpoint,
      remoteConfig: sourceConfig,
      force: false,
      createToken: CREATE_TOKEN,
      quiet: true
    });
    const sourceConfiguration = JSON.parse(await readFile(sourceConfig, "utf8"));
    const recoveryCode = makeRecoveryCode(sourceConfiguration);

    const originalEnvironment = {
      BRAVE_API_KEY: process.env.BRAVE_API_KEY,
      EXA_API_KEY: process.env.EXA_API_KEY,
      CONTEXT7_API_KEY: process.env.CONTEXT7_API_KEY
    };
    Object.assign(process.env, secretEnvironment);
    try {
      await backupStore({
        store: sourceStore,
        remoteConfig: sourceConfig,
        sopsFile: "",
        quiet: true
      });
    } finally {
      for (const [name, value] of Object.entries(originalEnvironment)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }

    const storedCiphertext = [...service.env.MCP_STORE.records.entries()]
      .filter(([key]) => key.includes("/versions/"))
      .map(([, record]) => new TextDecoder().decode(record.bytes))
      .join("\n");
    assert.equal(storedCiphertext.includes("remote-test-brave-secret"), false);
    assert.equal(storedCiphertext.includes("remote-test-exa-secret"), false);

    await restoreStore({
      store: restoredStore,
      remoteConfig: restoredConfig,
      recoveryStdin: true,
      recoveryCode,
      version: "",
      force: false,
      quiet: true
    });

    const localCiphertext = await readFile(
      join(restoredStore, "secrets.remote.enc"),
      "utf8"
    );
    assert.equal(localCiphertext.includes("remote-test-brave-secret"), false);
    assert.equal(localCiphertext.includes("remote-test-exa-secret"), false);
    assert.equal((await stat(restoredConfig)).mode & 0o777, 0o600);
    assert.equal(
      (await stat(join(restoredStore, "secrets.remote.enc"))).mode & 0o777,
      0o600
    );

    const restoredConfiguration = JSON.parse(
      await readFile(restoredConfig, "utf8")
    );
    const decryptedSecrets = await readEncryptedLocalSecrets(
      join(restoredStore, "secrets.remote.enc"),
      restoredConfiguration
    );
    assert.deepEqual(decryptedSecrets, {
      brave_api_key: "remote-test-brave-secret",
      context7_api_key: "remote-test-context7-secret",
      exa_api_key: "remote-test-exa-secret"
    });

    await run(MCPCTL, [
      "apply",
      "--target", "claude",
      "--profile", "frontend",
      "--store", restoredStore,
      "--remote-config", restoredConfig
    ], {
      env: {
        HOME: testHome,
        MCPCTL_CLAUDE_CONFIG: claudeConfig,
        BRAVE_API_KEY: "",
        EXA_API_KEY: "",
        CONTEXT7_API_KEY: ""
      }
    });
    const claude = JSON.parse(await readFile(claudeConfig, "utf8"));
    assert.equal(
      claude.mcpServers.brave.headers["X-Subscription-Token"],
      "remote-test-brave-secret"
    );
    assert.equal(
      claude.mcpServers.context7.headers.Authorization,
      "Bearer remote-test-context7-secret"
    );
  } finally {
    service.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});
