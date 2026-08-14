import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cp,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { bashScriptCommand } from "../platform-command.mjs";

import {
  backupStore,
  collectCatalogSecretReferences,
  collectSnapshot,
  decryptValue,
  encryptValue,
  initializeRemote,
  makeRecoveryCode,
  parseRecoveryCode,
  readEncryptedLocalSecrets,
  restoreStore,
  SNAPSHOT_INFO
} from "./remote-client.mjs";
import worker from "../../workers/toolbox-store/worker.js";
import { MemoryR2Bucket } from "../../workers/toolbox-store/test-memory-r2.mjs";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(TEST_DIR, "../..");
const REMOTE_CLIENT = join(TEST_DIR, "remote-client.mjs");
const MCPCTL = join(TEST_DIR, "mcpctl");
const TEMPLATE_STORE = join(TEST_DIR, "template-store");
const CREATE_TOKEN = "remote-test-create-token".padEnd(48, "C");

async function run(command, arguments_, options = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const invocation = command === MCPCTL
      ? bashScriptCommand(command, arguments_)
      : { executable: command, args: arguments_ };
    const requestedHome = options.env?.HOME;
    const child = spawn(invocation.executable, invocation.args, {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        ...options.env,
        ...(process.platform === "win32" && requestedHome
          ? { HOME: requestedHome.replaceAll("\\", "/"), USERPROFILE: requestedHome }
          : {})
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
    TOOLBOX_STORE: new MemoryR2Bucket(),
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

test("backup discovers imported Secret references in base and target overrides", () => {
  const references = collectCatalogSecretReferences({
    schema: 1,
    servers: {
      local: {
        transport: "stdio",
        command: [
          "node",
          "server.mjs",
          "--token",
          {
            secret: "command_token",
            env: "COMMAND_TOKEN",
            required: true
          }
        ],
        environment: {
          API_TOKEN: {
            secret: "local_api_token",
            env: "LOCAL_API_TOKEN",
            required: true
          }
        },
        target_overrides: {
          codex: {
            headers: {
              Authorization: {
                secret: "codex_header_token",
                env: "CODEX_HEADER_TOKEN",
                prefix: "Bearer ",
                required: true
              }
            }
          }
        }
      }
    }
  });
  assert.deepEqual(references, [
    { secret: "command_token", env: "COMMAND_TOKEN" },
    { secret: "local_api_token", env: "LOCAL_API_TOKEN" },
    { secret: "codex_header_token", env: "CODEX_HEADER_TOKEN" }
  ]);
});

test("snapshot collection captures environment values for imported references", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "mcpctl-import-snapshot-"));
  const profiles = join(testRoot, "profiles");
  const environmentName = "MCPCTL_TEST_IMPORTED_TOKEN";
  const previous = process.env[environmentName];
  try {
    await mkdir(profiles, { recursive: true });
    await writeFile(join(testRoot, "catalog.json"), JSON.stringify({
      schema: 1,
      servers: {
        imported: {
          transport: "stdio",
          command: ["node", "server.mjs"],
          environment: {
            API_TOKEN: {
              secret: "imported_api_token",
              env: environmentName,
              required: true
            }
          }
        }
      }
    }));
    await writeFile(join(profiles, "off.json"), JSON.stringify({
      schema: 1,
      name: "off",
      extends: [],
      enable: [],
      disable: [],
      target_overrides: {}
    }));
    process.env[environmentName] = "captured-imported-token";
    const snapshot = await collectSnapshot(
      testRoot,
      {
        schema: 1,
        endpoint: "https://backup.example",
        store_id: "0123456789abcdef0123456789abcdef",
        root_key: Buffer.alloc(32, 8).toString("base64url")
      },
      join(testRoot, "missing-sops.json")
    );
    assert.equal(
      snapshot.secrets.imported_api_token,
      "captured-imported-token"
    );
  } finally {
    if (previous === undefined) delete process.env[environmentName];
    else process.env[environmentName] = previous;
    await rm(testRoot, { recursive: true, force: true });
  }
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
    const artifactBytes = Buffer.from("portable-wheel-test-payload\n");
    const artifactName = "private_mcp-1.0.0-py3-none-any.whl";
    const artifactSha256 = createHash("sha256").update(artifactBytes).digest("hex");
    await mkdir(join(sourceStore, "artifacts"), { recursive: true });
    await writeFile(join(sourceStore, "artifacts", artifactName), artifactBytes, {
      mode: 0o600
    });
    const sourceCatalogPath = join(sourceStore, "catalog.json");
    const sourceCatalog = JSON.parse(await readFile(sourceCatalogPath, "utf8"));
    sourceCatalog.servers["private-wheel"] = {
      transport: "stdio",
      command: [
        "@mcpctl/adapters/mcp-package",
        "uv",
        "private-wheel",
        `@mcpctl-store/artifacts/${artifactName}`,
        "private-mcp",
        "with:mcp<2",
        `sha256:${artifactSha256}`,
        "--"
      ],
      host: {
        lifecycle: "client",
        install: {
          type: "uv",
          package: `@mcpctl-store/artifacts/${artifactName}`,
          bin: "private-mcp",
          with: ["mcp<2"],
          sha256: artifactSha256
        }
      },
      supported_targets: ["claude", "codex"]
    };
    await writeFile(sourceCatalogPath, `${JSON.stringify(sourceCatalog, null, 2)}\n`);
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

    const storedCiphertext = [...service.env.TOOLBOX_STORE.records.entries()]
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
    if (process.platform === "win32") {
      assert.equal((await stat(restoredConfig)).isFile(), true);
      assert.equal((await stat(join(restoredStore, "secrets.remote.enc"))).isFile(), true);
    } else {
      assert.equal((await stat(restoredConfig)).mode & 0o777, 0o600);
      assert.equal(
        (await stat(join(restoredStore, "secrets.remote.enc"))).mode & 0o777,
        0o600
      );
    }
    assert.deepEqual(
      await readFile(join(restoredStore, "artifacts", artifactName)),
      artifactBytes
    );
    if (process.platform === "win32") {
      assert.equal((await stat(join(restoredStore, "artifacts", artifactName))).isFile(), true);
    } else {
      assert.equal(
        (await stat(join(restoredStore, "artifacts", artifactName))).mode & 0o777,
        0o600
      );
    }

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

    // A forced restore swaps an exact managed snapshot into place. It removes
    // stale managed files while preserving unrelated local store metadata.
    await writeFile(
      join(restoredStore, "profiles", "stale.json"),
      "{}\n"
    );
    await writeFile(join(restoredStore, "artifacts", "stale.bin"), "stale\n");
    await writeFile(join(restoredStore, "local-note.txt"), "keep me\n");
    await restoreStore({
      store: restoredStore,
      remoteConfig: restoredConfig,
      recoveryStdin: false,
      version: "",
      force: true,
      quiet: true
    });
    await assert.rejects(
      readFile(join(restoredStore, "profiles", "stale.json")),
      { code: "ENOENT" }
    );
    await assert.rejects(
      readFile(join(restoredStore, "artifacts", "stale.bin")),
      { code: "ENOENT" }
    );
    assert.equal(
      await readFile(join(restoredStore, "local-note.txt"), "utf8"),
      "keep me\n"
    );

    await run(MCPCTL, [
      "apply",
      "--target", "claude",
      "--profile", "daily-search",
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
