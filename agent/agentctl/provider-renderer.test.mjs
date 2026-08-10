import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  backendArguments,
  renderProviderPlan,
  proxyCompatibilityIssue,
  targetPaths
} from "./provider-renderer.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLIENT = join(HERE, "provider-client.mjs");
const AGENT_ROOT = resolve(HERE, "..");

function storeArgs(root) {
  return [
    "--store", join(root, "portable", "providers.json"),
    "--secrets", join(root, "portable", "provider-secrets.json"),
    "--state", join(root, "state", "providers.json")
  ];
}

function run(root, args, {
  status = 0,
  home = join(root, "home"),
  agentRoot = AGENT_ROOT,
  path = process.env.PATH
} = {}) {
  const result = spawnSync(process.execPath, [CLIENT, ...args, ...storeArgs(root)], {
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: home,
      AGENTCTL_AGENT_ROOT: agentRoot,
      PATH: path,
      NO_COLOR: "1"
    }
  });
  assert.equal(
    result.status,
    status,
    `command status mismatch\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`
  );
  return result;
}

async function fakeAgentBins(root) {
  const bin = join(root, "bin");
  await mkdir(bin, { recursive: true });
  for (const command of ["claude", "codex", "opencode", "pi"]) {
    const path = join(bin, command);
    await writeFile(path, "#!/usr/bin/env sh\nprintf 'test-version\\n'\n", { mode: 0o700 });
    await chmod(path, 0o700);
  }
  return `${bin}:${process.env.PATH}`;
}

async function createSharedProfile(root, secretFile) {
  run(root, ["init", "--yes"]);
  run(root, [
    "create", "universal",
    "--protocol", "openai_responses",
    "--base-url", "https://responses.example.com/v1",
    "--model", "daily",
    "--alias", "daily=vendor-model",
    "--auth-mode", "bearer",
    "--secret", "shared_key",
    "--yes"
  ]);
  run(root, [
    "target", "universal", "claude",
    "--protocol", "anthropic_messages",
    "--base-url", "https://anthropic.example.com",
    "--auth-mode", "x-api-key",
    "--yes"
  ]);
  run(root, [
    "target", "universal", "pi",
    "--protocol", "google_generative",
    "--base-url", "https://generativelanguage.example.com/v1beta",
    "--auth-mode", "x-goog-api-key",
    "--yes"
  ]);
  run(root, [
    "secret", "set", "shared_key", "--secret-file", secretFile, "--yes"
  ]);
}

test("target renderer exposes native paths and never places a Secret value in argv", () => {
  const resolved = {
    profile: "lab",
    target: "claude",
    platform: "darwin",
    enabled: true,
    protocol: "anthropic_messages",
    endpoint: "https://api.example.com",
    auth: { mode: "x-api-key", secret: "lab_key" },
    requested_model: "daily",
    outbound_model: "model-a"
  };
  const plan = renderProviderPlan(resolved, {
    secretPresent: true,
    home: "/Users/test",
    agentRoot: "/opt/agent"
  });
  assert.equal(plan.ready, true);
  assert.equal(plan.config_files[0], "/Users/test/.claude/settings.json");
  const args = backendArguments(plan, { keyFile: "/tmp/private.key" });
  assert.deepEqual(args.slice(0, 6), [
    "--provider", "custom", "--base-url", "https://api.example.com", "--model", "model-a"
  ]);
  assert.equal(args.includes("lab_key"), false);
  assert.equal(args.includes("--no-statusline"), true);
});

test("direct compatibility is explicit instead of inferred from endpoint names", () => {
  const base = {
    profile: "lab",
    platform: "linux",
    enabled: true,
    endpoint: "https://gateway.example.com/v1",
    auth: { mode: "bearer", secret: "lab_key" },
    requested_model: "model-a",
    outbound_model: "model-a"
  };
  const codexChat = renderProviderPlan({
    ...base,
    target: "codex",
    protocol: "openai_chat"
  }, { secretPresent: true });
  assert.equal(codexChat.ready, false);
  assert.match(codexChat.issue, /requires openai_responses/);

  const claudeResponses = renderProviderPlan({
    ...base,
    target: "claude",
    protocol: "openai_responses"
  }, { secretPresent: true });
  assert.equal(claudeResponses.ready, false);
  assert.match(claudeResponses.issue, /requires anthropic_messages/);
  assert.equal(proxyCompatibilityIssue("codex", "openai_responses"), "");
  assert.match(proxyCompatibilityIssue("codex", "openai_chat"), /Responses proxy/);
  assert.equal(proxyCompatibilityIssue("pi", "google_generative"), "");

  const piLocal = renderProviderPlan({
    ...base,
    target: "pi",
    protocol: "openai_chat",
    endpoint: "http://127.0.0.1:11434/v1",
    auth: { mode: "none" }
  });
  assert.equal(piLocal.ready, true);
  assert.equal(piLocal.auth.synthetic, true);
});

test("one portable profile applies native configs to Claude, Codex, OpenCode, and Pi", async () => {
  const root = await mkdtemp(join(tmpdir(), "provider-render-apply-"));
  const home = join(root, "home");
  try {
    await mkdir(home, { recursive: true });
    const secretFile = join(root, "shared-key");
    await writeFile(secretFile, "NATIVE-CONFIG-SECRET\n", { mode: 0o600 });
    await chmod(secretFile, 0o600);
    await createSharedProfile(root, secretFile);
    const path = await fakeAgentBins(root);

    for (const target of ["claude", "codex", "opencode", "pi"]) {
      const result = run(root, [
        "apply", "universal", "--target", target,
        "--skip-validate", "--yes", "--json"
      ], { home, path });
      const output = JSON.parse(result.stdout);
      assert.deepEqual(output.applied, [target]);
      assert.equal(result.stdout.includes("NATIVE-CONFIG-SECRET"), false);
      assert.equal(result.stderr.includes("NATIVE-CONFIG-SECRET"), false);
    }

    const claude = JSON.parse(await readFile(join(home, ".claude", "settings.json"), "utf8"));
    assert.equal(claude.env.ANTHROPIC_BASE_URL, "https://anthropic.example.com");
    assert.equal(claude.env.ANTHROPIC_API_KEY, "NATIVE-CONFIG-SECRET");
    assert.equal(claude.model, "vendor-model");
    await assert.rejects(
      () => readFile(join(home, ".claude", ".script-toolbox-statusline.json")),
      { code: "ENOENT" }
    );

    const codex = await readFile(join(home, ".codex", "config.toml"), "utf8");
    assert.match(codex, /model = "vendor-model"/);
    assert.match(codex, /base_url = "https:\/\/responses\.example\.com\/v1"/);
    assert.equal(
      (await readFile(join(home, ".codex", "provider-keys", "script_toolbox_custom.key"), "utf8")).trim(),
      "NATIVE-CONFIG-SECRET"
    );

    const opencode = JSON.parse(await readFile(
      join(home, ".config", "opencode", "opencode.json"), "utf8"
    ));
    assert.equal(opencode.model, "script-toolbox-custom/vendor-model");
    assert.equal(
      opencode.provider["script-toolbox-custom"].options.baseURL,
      "https://responses.example.com/v1"
    );

    const piModels = JSON.parse(await readFile(join(home, ".pi", "agent", "models.json"), "utf8"));
    assert.equal(piModels.providers["script-toolbox-custom"].api, "google-generative-ai");
    assert.equal(
      piModels.providers["script-toolbox-custom"].baseUrl,
      "https://generativelanguage.example.com/v1beta"
    );

    const current = JSON.parse(run(root, ["current", "--json"], { home, path }).stdout);
    assert.deepEqual(Object.keys(current.current).sort(), ["claude", "codex", "opencode", "pi"]);
    for (const record of Object.values(current.current)) {
      assert.equal(Object.hasOwn(record, "secret"), false);
      assert.equal(record.profile, "universal");
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("non-native platform overlays can be planned but cannot be applied", async () => {
  if (process.platform === "win32") return;
  const root = await mkdtemp(join(tmpdir(), "provider-platform-guard-"));
  try {
    const secretFile = join(root, "shared-key");
    await writeFile(secretFile, "secret\n", { mode: 0o600 });
    await chmod(secretFile, 0o600);
    await createSharedProfile(root, secretFile);
    const plan = JSON.parse(run(root, [
      "plan", "universal", "--target", "codex", "--platform", "windows", "--json"
    ]).stdout);
    assert.equal(plan.platform, "windows");
    assert.equal(plan.ready, true);
    assert.match(run(root, [
      "apply", "universal", "--target", "codex", "--platform", "windows",
      "--yes", "--json"
    ], { status: 1 }).stderr, /cannot apply the windows overlay/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("portable restore imports the catalog and applies only the current platform target", async () => {
  const root = await mkdtemp(join(tmpdir(), "provider-portable-restore-"));
  const source = join(root, "source");
  const destination = join(root, "destination");
  const destinationHome = join(destination, "home");
  try {
    await mkdir(source, { recursive: true });
    await mkdir(destinationHome, { recursive: true });
    const sourceSecret = join(source, "shared-key");
    await writeFile(sourceSecret, "SOURCE-SECRET-NOT-EXPORTED\n", { mode: 0o600 });
    await chmod(sourceSecret, 0o600);
    await createSharedProfile(source, sourceSecret);
    const portable = join(root, "portable-profiles.json");
    run(source, ["export", "--output", portable, "--yes"]);
    assert.equal((await readFile(portable, "utf8")).includes("SOURCE-SECRET-NOT-EXPORTED"), false);

    run(destination, ["init", "--yes"], { home: destinationHome });
    const destinationSecret = join(destination, "shared-key");
    await writeFile(destinationSecret, "DESTINATION-SECRET\n", { mode: 0o600 });
    await chmod(destinationSecret, 0o600);
    run(destination, [
      "secret", "set", "shared_key", "--secret-file", destinationSecret, "--yes"
    ], { home: destinationHome });
    const path = await fakeAgentBins(destination);
    const restored = JSON.parse(run(destination, [
      "restore", "universal", "--input", portable,
      "--target", "codex", "--skip-validate", "--yes", "--json"
    ], { home: destinationHome, path }).stdout);
    assert.deepEqual(restored.applied, ["codex"]);
    assert.equal(restored.catalog_mode, "merge");
    assert.equal(restored.secret_values, "local Secret Store");

    const profiles = JSON.parse(await readFile(
      join(destination, "portable", "providers.json"), "utf8"
    ));
    assert.ok(profiles.profiles.universal);
    const key = await readFile(
      join(destinationHome, ".codex", "provider-keys", "script_toolbox_custom.key"),
      "utf8"
    );
    assert.equal(key.trim(), "DESTINATION-SECRET");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("multi-target apply restores earlier client files when a later backend fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "provider-rollback-"));
  const home = join(root, "home");
  const backendRoot = join(root, "backends");
  try {
    await mkdir(join(home, ".claude"), { recursive: true });
    await writeFile(
      join(home, ".claude", "settings.json"),
      "{\"original\":true}\n",
      { mode: 0o600 }
    );
    const secretFile = join(root, "shared-key");
    await writeFile(secretFile, "ROLLBACK-SECRET\n", { mode: 0o600 });
    await chmod(secretFile, 0o600);

    run(root, ["init", "--yes"], { home });
    run(root, [
      "create", "rollback",
      "--protocol", "anthropic_messages",
      "--base-url", "https://anthropic.example.com",
      "--model", "model-a", "--auth-mode", "x-api-key",
      "--secret", "shared_key", "--yes"
    ], { home });
    run(root, [
      "target", "rollback", "codex", "--protocol", "openai_responses",
      "--base-url", "https://responses.example.com/v1",
      "--auth-mode", "bearer", "--yes"
    ], { home });
    run(root, ["target", "rollback", "opencode", "--disable", "--yes"], { home });
    run(root, ["target", "rollback", "pi", "--disable", "--yes"], { home });
    run(root, [
      "secret", "set", "shared_key", "--secret-file", secretFile, "--yes"
    ], { home });

    for (const target of ["claude-code", "codex"]) {
      await mkdir(join(backendRoot, target), { recursive: true });
    }
    const claudeBackend = join(backendRoot, "claude-code", "setup.sh");
    await writeFile(claudeBackend, [
      "#!/usr/bin/env sh",
      "printf '{\"changed\":true}\\n' > \"$HOME/.claude/settings.json\"",
      "exit 0",
      ""
    ].join("\n"), { mode: 0o700 });
    await chmod(claudeBackend, 0o700);
    const codexBackend = join(backendRoot, "codex", "setup.sh");
    await writeFile(codexBackend, "#!/usr/bin/env sh\nexit 7\n", { mode: 0o700 });
    await chmod(codexBackend, 0o700);

    const failure = run(root, [
      "apply", "rollback", "--target", "all", "--skip-validate", "--yes", "--json"
    ], { status: 1, home, agentRoot: backendRoot });
    assert.match(failure.stderr, /previous managed files will be restored/);
    assert.equal(failure.stderr.includes("ROLLBACK-SECRET"), false);
    assert.deepEqual(
      JSON.parse(await readFile(join(home, ".claude", "settings.json"), "utf8")),
      { original: true }
    );
    const current = JSON.parse(run(root, ["current", "--json"], { home }).stdout);
    assert.deepEqual(current.current, {});
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("target path projection uses the user home on every supported platform", () => {
  const home = process.platform === "win32" ? "C:\\Users\\Test" : "/home/test";
  assert.equal(targetPaths("codex", { home }).config_files[0], join(home, ".codex", "config.toml"));
  assert.equal(
    targetPaths("opencode", { home }).config_files[0],
    join(home, ".config", "opencode", "opencode.json")
  );
  assert.equal(targetPaths("pi", { home }).config_files[0], join(home, ".pi", "agent", "models.json"));
});
