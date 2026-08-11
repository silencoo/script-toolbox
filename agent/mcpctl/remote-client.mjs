#!/usr/bin/env node

import { spawn } from "node:child_process";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  hkdfSync,
  randomBytes
} from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  MCP_REMOTE_PROTOCOL,
  RemoteStoreError,
  getRemoteWebUiSetting,
  setRemoteWebUiEnabled
} from "../remote-store.mjs";

const SCHEMA = 1;
const RECOVERY_PREFIX = "mcpstore1_";
const STORE_ID_PATTERN = /^[a-f0-9]{32}$/;
const VERSION_ID_PATTERN = /^[0-9]{13}-[a-f0-9-]{36}$/;
const SNAPSHOT_CONTENT_TYPE = "application/vnd.mcpctl.snapshot+json";
const SNAPSHOT_INFO = "mcpctl/snapshot-encryption/v1";
const LOCAL_SECRETS_INFO = "mcpctl/local-secrets-encryption/v1";
const AUTH_INFO = "mcpctl/store-authentication/v1";
const FETCH_TIMEOUT_MS = 30_000;
const MAX_STDIN_BYTES = 64 * 1024;
const MAX_SOPS_OUTPUT_BYTES = 10 * 1024 * 1024;
const MAX_API_JSON_BYTES = 1024 * 1024;
const MAX_API_ERROR_BYTES = 64 * 1024;
const MAX_REMOTE_SNAPSHOT_BYTES = 32 * 1024 * 1024;
// Artifact bytes are base64 encoded inside the plaintext snapshot, then the
// encrypted envelope is encoded again. These limits keep the default Worker
// upload below its 5 MiB body limit with room for catalog and profile data.
const MAX_ARTIFACT_BYTES = 2 * 1024 * 1024;
const MAX_ARTIFACT_TOTAL_BYTES = 2560 * 1024;
const ARTIFACT_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/;
const STORE_ARTIFACT_PREFIX = "@mcpctl-store/artifacts/";
const MIN_CREATE_TOKEN_LENGTH = 32;
const MAX_CREATE_TOKEN_LENGTH = 512;

class RemoteError extends Error {
  constructor(message) {
    super(message);
    this.name = "RemoteError";
  }
}

function usage() {
  process.stdout.write(`mcpctl encrypted remote client

Usage:
  remote-client.mjs init --endpoint <url> --remote-config <file>
                         --create-token-stdin [--force]
  remote-client.mjs backup --store <dir> --remote-config <file> [--sops-file <file>]
  remote-client.mjs restore --store <dir> --remote-config <file> [options]
  remote-client.mjs status --remote-config <file>
  remote-client.mjs ui-status --remote-config <file>
  remote-client.mjs ui-enable --remote-config <file>
  remote-client.mjs ui-disable --remote-config <file>
  remote-client.mjs versions --remote-config <file>
  remote-client.mjs recovery --remote-config <file>
  remote-client.mjs secrets --store <dir> --remote-config <file>

Restore options:
  --version <id>       Restore a specific remote version instead of latest.
  --recovery-stdin     Read a recovery code from standard input.
  --force              Overwrite catalog/profile files in an existing store.
`);
}

function parseArguments(argv) {
  const command = argv.shift();
  if (!command || command === "help" || command === "--help" || command === "-h") {
    return { command: "help" };
  }

  const options = {
    command,
    endpoint: "",
    store: "",
    remoteConfig: "",
    sopsFile: "",
    version: "",
    force: false,
    recoveryStdin: false
  };

  while (argv.length > 0) {
    const argument = argv.shift();
    switch (argument) {
      case "--endpoint":
        options.endpoint = takeValue(argv, argument);
        break;
      case "--store":
        options.store = takeValue(argv, argument);
        break;
      case "--remote-config":
        options.remoteConfig = takeValue(argv, argument);
        break;
      case "--sops-file":
        options.sopsFile = takeValue(argv, argument);
        break;
      case "--version":
        options.version = takeValue(argv, argument);
        break;
      case "--force":
        options.force = true;
        break;
      case "--recovery-stdin":
        options.recoveryStdin = true;
        break;
      case "--create-token-stdin":
        options.createTokenStdin = true;
        break;
      default:
        throw new RemoteError(`unknown remote-client argument: ${argument}`);
    }
  }

  return options;
}

function takeValue(argv, option) {
  if (argv.length === 0) throw new RemoteError(`${option} requires a value`);
  return argv.shift();
}

async function main(argv) {
  const options = parseArguments([...argv]);
  if (options.command === "help") {
    usage();
    return;
  }

  if (!options.remoteConfig) {
    throw new RemoteError("--remote-config is required");
  }

  switch (options.command) {
    case "init":
      await initializeRemote(options);
      return;
    case "backup":
      requireStore(options);
      await backupStore(options);
      return;
    case "restore":
      requireStore(options);
      await restoreStore(options);
      return;
    case "status":
      await printStatus(options);
      return;
    case "ui-status":
    case "ui-enable":
    case "ui-disable":
      await printOrUpdateWebUi(options);
      return;
    case "versions":
      await printVersions(options);
      return;
    case "recovery":
      await printRecoveryCode(options);
      return;
    case "secrets":
      requireStore(options);
      await printLocalSecrets(options);
      return;
    default:
      throw new RemoteError(`unknown remote-client command: ${options.command}`);
  }
}

function requireStore(options) {
  if (!options.store) throw new RemoteError("--store is required");
}

async function initializeRemote(options) {
  if (!options.endpoint) throw new RemoteError("--endpoint is required");
  const createToken = validateCreateToken(
    typeof options.createToken === "string"
      ? options.createToken
      : options.createTokenStdin
        ? (await readStandardInput(MAX_STDIN_BYTES)).trim()
        : ""
  );
  const remoteConfigPath = resolve(options.remoteConfig);
  if (await pathExists(remoteConfigPath)) {
    await assertRegularPrivateFile(remoteConfigPath, "remote configuration");
    if (!options.force) {
      throw new RemoteError(
        `remote configuration already exists: ${remoteConfigPath} (use --force to replace it)`
      );
    }
  }

  const config = validateRemoteConfig({
    schema: SCHEMA,
    endpoint: normalizeEndpoint(options.endpoint),
    store_id: randomBytes(16).toString("hex"),
    root_key: encodeBase64Url(randomBytes(32))
  });

  const response = await authenticatedFetch(config, storeApiPath(config), {
    method: "PUT",
    headers: {
      "X-Toolbox-Store-Create-Token": createToken
    }
  });
  const created = await readApiJson(response, [201]);
  if (created?.schema !== SCHEMA || created?.store_id !== config.store_id) {
    throw new RemoteError("remote service returned invalid store-creation metadata");
  }

  await writeJsonAtomic(remoteConfigPath, config);
  if (!options.quiet) {
    process.stdout.write(
      "Remote store created. Keep this recovery code offline; anyone with it can decrypt and update the store.\n"
    );
    process.stdout.write(`${makeRecoveryCode(config)}\n`);
  }
}

function validateCreateToken(value) {
  if (typeof value !== "string" ||
      value.length < MIN_CREATE_TOKEN_LENGTH ||
      value.length > MAX_CREATE_TOKEN_LENGTH ||
      /[\u0000-\u001f\u007f]/.test(value)) {
    throw new RemoteError(
      `store creation token must contain ${MIN_CREATE_TOKEN_LENGTH}-${MAX_CREATE_TOKEN_LENGTH} printable characters`
    );
  }
  return value;
}

async function backupStore(options) {
  const storePath = resolve(options.store);
  const config = await readRemoteConfig(options.remoteConfig);
  const statusResponse = await authenticatedFetch(config, storeApiPath(config));
  const status = await readApiJson(statusResponse, [200]);
  const baseVersion = status.latest === null ? "none" : status.latest?.version;
  if (typeof baseVersion !== "string" ||
      (baseVersion !== "none" && !VERSION_ID_PATTERN.test(baseVersion))) {
    throw new RemoteError("remote service returned invalid latest-version metadata");
  }

  const snapshot = await collectSnapshot(
    storePath,
    config,
    options.sopsFile ? resolve(options.sopsFile) : join(storePath, "secrets.sops.json")
  );
  const envelope = encryptValue(
    "mcpctl-snapshot",
    SNAPSHOT_INFO,
    config,
    snapshot
  );
  const body = JSON.stringify(envelope);

  const response = await authenticatedFetch(
    config,
    `${storeApiPath(config)}/versions`,
    {
      method: "PUT",
      headers: {
        "Content-Type": SNAPSHOT_CONTENT_TYPE,
        "X-Toolbox-Base-Version": baseVersion
      },
      body
    }
  );
  const result = await readApiJson(response, [201]);
  if (!VERSION_ID_PATTERN.test(result.version || "")) {
    throw new RemoteError("remote service returned an invalid backup version");
  }

  if (!options.quiet) {
    process.stdout.write(
      `Backed up ${Object.keys(snapshot.profiles).length} profiles and ` +
      `${Object.keys(snapshot.secrets).length} secrets with ` +
      `${Object.keys(snapshot.artifacts).length} portable artifacts as ${result.version}.\n`
    );
  }
}

async function collectSnapshot(storePath, config, sopsFile) {
  const catalogPath = join(storePath, "catalog.json");
  await assertRegularFile(catalogPath, "MCP catalog");
  const catalog = parseJson(
    await readFile(catalogPath, "utf8"),
    `invalid MCP catalog: ${catalogPath}`
  );
  validateCatalog(catalog);

  const profilesPath = join(storePath, "profiles");
  await assertDirectory(profilesPath, "profiles directory");
  const entries = await readdir(profilesPath, { withFileTypes: true });
  const profiles = Object.create(null);

  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.name.endsWith(".json")) continue;
    if (!entry.isFile()) {
      throw new RemoteError(`profile must be a regular file: ${join(profilesPath, entry.name)}`);
    }
    const profileName = entry.name.slice(0, -".json".length);
    validateProfileName(profileName);
    const profilePath = join(profilesPath, entry.name);
    const profile = parseJson(
      await readFile(profilePath, "utf8"),
      `invalid profile JSON: ${profilePath}`
    );
    validateProfile(profileName, profile);
    profiles[profileName] = profile;
  }

  if (Object.keys(profiles).length === 0) {
    throw new RemoteError("the store contains no profiles");
  }

  const secrets = Object.create(null);
  const localSecretsPath = join(storePath, "secrets.remote.enc");
  if (await pathExists(localSecretsPath)) {
    Object.assign(
      secrets,
      await readEncryptedLocalSecrets(localSecretsPath, config)
    );
  }

  if (await pathExists(sopsFile)) {
    Object.assign(secrets, await decryptSopsSecrets(sopsFile));
  }

  for (const reference of collectCatalogSecretReferences(catalog)) {
    if (!reference.env) continue;
    const value = process.env[reference.env];
    if (typeof value === "string" && value.length > 0) {
      secrets[reference.secret] = value;
    }
  }
  validateSecrets(secrets);
  const artifacts = await collectStoreArtifacts(storePath, catalog);

  return {
    schema: SCHEMA,
    created_at: new Date().toISOString(),
    catalog,
    profiles,
    secrets,
    artifacts
  };
}

function collectCatalogArtifactReferences(catalog) {
  return [...collectCatalogArtifactSpecifications(catalog).keys()];
}

function collectCatalogArtifactSpecifications(catalog) {
  const references = new Map();
  for (const definition of Object.values(catalog.servers)) {
    if (!definition || typeof definition !== "object" || Array.isArray(definition)) {
      continue;
    }
    const candidates = [definition];
    if (definition.target_overrides &&
        typeof definition.target_overrides === "object" &&
        !Array.isArray(definition.target_overrides)) {
      candidates.push(...Object.values(definition.target_overrides));
    }
    for (const candidate of candidates) {
      const packageReference = candidate?.host?.install?.package;
      if (typeof packageReference !== "string" ||
          !packageReference.startsWith("@mcpctl-store/")) {
        continue;
      }
      if (!packageReference.startsWith(STORE_ARTIFACT_PREFIX)) {
        throw new RemoteError(`unsupported portable Store reference: ${packageReference}`);
      }
      const name = packageReference.slice(STORE_ARTIFACT_PREFIX.length);
      validateArtifactName(name);
      const sha256 = candidate?.host?.install?.sha256;
      if (typeof sha256 !== "string" || !/^[A-Fa-f0-9]{64}$/.test(sha256)) {
        throw new RemoteError(`MCP artifact '${name}' is missing a valid catalog SHA-256`);
      }
      const normalizedSha256 = sha256.toLowerCase();
      if (references.has(name) && references.get(name) !== normalizedSha256) {
        throw new RemoteError(`MCP artifact '${name}' has conflicting catalog digests`);
      }
      references.set(name, normalizedSha256);
    }
  }
  return new Map([...references].sort(([left], [right]) => left.localeCompare(right)));
}

async function collectStoreArtifacts(storePath, catalog) {
  const artifacts = Object.create(null);
  let totalBytes = 0;
  for (const [name, expectedSha256] of collectCatalogArtifactSpecifications(catalog)) {
    const artifactPath = join(storePath, "artifacts", name);
    const details = await assertRegularFile(artifactPath, `MCP artifact '${name}'`);
    if (details.size > MAX_ARTIFACT_BYTES) {
      throw new RemoteError(`MCP artifact '${name}' exceeds the safe size limit`);
    }
    totalBytes += details.size;
    if (totalBytes > MAX_ARTIFACT_TOTAL_BYTES) {
      throw new RemoteError("MCP artifacts exceed the safe total size limit");
    }
    const bytes = await readFile(artifactPath);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (sha256 !== expectedSha256) {
      throw new RemoteError(`MCP artifact '${name}' does not match its catalog SHA-256`);
    }
    artifacts[name] = {
      encoding: "base64",
      sha256,
      data: bytes.toString("base64")
    };
  }
  return artifacts;
}

function validateArtifactName(name) {
  if (typeof name !== "string" || !ARTIFACT_NAME_PATTERN.test(name) ||
      name === "." || name === "..") {
    throw new RemoteError("MCP artifact name is invalid");
  }
}

function decodeArtifact(name, artifact) {
  validateArtifactName(name);
  if (!artifact || typeof artifact !== "object" || Array.isArray(artifact) ||
      artifact.encoding !== "base64" ||
      typeof artifact.data !== "string" ||
      !/^[A-Fa-f0-9]{64}$/.test(artifact.sha256 || "")) {
    throw new RemoteError(`MCP artifact '${name}' is invalid`);
  }
  const bytes = Buffer.from(artifact.data, "base64");
  if (bytes.length > MAX_ARTIFACT_BYTES || bytes.toString("base64") !== artifact.data) {
    throw new RemoteError(`MCP artifact '${name}' has invalid base64 or size`);
  }
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== artifact.sha256.toLowerCase()) {
    throw new RemoteError(`MCP artifact '${name}' failed SHA-256 verification`);
  }
  return bytes;
}

function validateArtifacts(catalog, artifacts) {
  const normalized = artifacts === undefined ? {} : artifacts;
  if (!normalized || typeof normalized !== "object" || Array.isArray(normalized)) {
    throw new RemoteError("MCP artifacts must be an object");
  }
  let totalBytes = 0;
  for (const [name, artifact] of Object.entries(normalized)) {
    totalBytes += decodeArtifact(name, artifact).length;
    if (totalBytes > MAX_ARTIFACT_TOTAL_BYTES) {
      throw new RemoteError("MCP artifacts exceed the safe total size limit");
    }
  }
  for (const [name, expectedSha256] of collectCatalogArtifactSpecifications(catalog)) {
    if (!Object.hasOwn(normalized, name)) {
      throw new RemoteError(`MCP catalog references missing artifact '${name}'`);
    }
    if (normalized[name].sha256.toLowerCase() !== expectedSha256) {
      throw new RemoteError(`MCP artifact '${name}' does not match its catalog SHA-256`);
    }
  }
}

function collectCatalogSecretReferences(catalog) {
  const references = new Map();
  for (const definition of Object.values(catalog.servers)) {
    if (!definition || typeof definition !== "object" || Array.isArray(definition)) {
      continue;
    }
    const candidates = [definition];
    if (definition.target_overrides &&
        typeof definition.target_overrides === "object" &&
        !Array.isArray(definition.target_overrides)) {
      candidates.push(...Object.values(definition.target_overrides));
    }

    for (const candidate of candidates) {
      if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
        continue;
      }
      const descriptors = [];
      if (candidate.auth &&
          typeof candidate.auth === "object" &&
          !Array.isArray(candidate.auth)) {
        descriptors.push(candidate.auth);
      }
      if (Array.isArray(candidate.command)) {
        for (const descriptor of candidate.command) {
          if (descriptor &&
              typeof descriptor === "object" &&
              !Array.isArray(descriptor)) {
            descriptors.push(descriptor);
          }
        }
      }
      for (const field of ["environment", "headers"]) {
        const values = candidate[field];
        if (!values || typeof values !== "object" || Array.isArray(values)) continue;
        for (const descriptor of Object.values(values)) {
          if (descriptor &&
              typeof descriptor === "object" &&
              !Array.isArray(descriptor)) {
            descriptors.push(descriptor);
          }
        }
      }

      for (const descriptor of descriptors) {
        if (typeof descriptor.secret !== "string" ||
            descriptor.secret.length === 0) {
          throw new RemoteError("catalog contains an invalid Secret reference");
        }
        if (descriptor.env !== undefined &&
            (typeof descriptor.env !== "string" ||
             (descriptor.env.length > 0 &&
              !/^[A-Za-z_][A-Za-z0-9_]*$/.test(descriptor.env)))) {
          throw new RemoteError("catalog contains an invalid Secret environment reference");
        }
        const previous = references.get(descriptor.secret);
        if (previous && previous.env && descriptor.env &&
            previous.env !== descriptor.env) {
          throw new RemoteError(
            `catalog Secret '${descriptor.secret}' has conflicting environment references`
          );
        }
        references.set(descriptor.secret, {
          secret: descriptor.secret,
          env: descriptor.env || previous?.env || ""
        });
      }
    }
  }
  return [...references.values()];
}

async function decryptSopsSecrets(sopsFile) {
  await assertRegularFile(sopsFile, "SOPS secret file");
  const sopsBinary = process.env.MCPCTL_SOPS_BIN || "sops";
  const output = await runCommand(
    sopsBinary,
    ["decrypt", "--output-type", "json", sopsFile],
    MAX_SOPS_OUTPUT_BYTES
  );
  const document = parseJson(output, `SOPS returned invalid JSON for ${sopsFile}`);
  if (!document || document.schema !== SCHEMA ||
      !document.secrets || typeof document.secrets !== "object" ||
      Array.isArray(document.secrets)) {
    throw new RemoteError(`decrypted ${sopsFile} must contain a schema-1 secrets object`);
  }
  validateSecrets(document.secrets);
  return document.secrets;
}

async function runCommand(command, arguments_, maxOutputBytes) {
  return new Promise((resolvePromise, rejectPromise) => {
    let stdout = Buffer.alloc(0);
    let stderrBytes = 0;
    let failedForSize = false;
    const child = spawn(command, arguments_, {
      env: process.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"]
    });

    child.stdout.on("data", (chunk) => {
      if (failedForSize) return;
      if (stdout.length + chunk.length > maxOutputBytes) {
        failedForSize = true;
        child.kill();
        return;
      }
      stdout = Buffer.concat([stdout, chunk]);
    });
    child.stderr.on("data", (chunk) => {
      stderrBytes += chunk.length;
      if (stderrBytes > maxOutputBytes) child.kill();
    });
    child.on("error", () => {
      rejectPromise(new RemoteError(`could not run ${command}`));
    });
    child.on("close", (code) => {
      if (failedForSize) {
        rejectPromise(new RemoteError(`${command} output exceeded the safe size limit`));
      } else if (code !== 0) {
        rejectPromise(new RemoteError(`${command} failed while decrypting the secret file`));
      } else {
        resolvePromise(stdout.toString("utf8"));
      }
    });
  });
}

async function restoreStore(options) {
  const storePath = resolve(options.store);
  const remoteConfigPath = resolve(options.remoteConfig);
  const { config, writeConfig } = await configForRestore(options, remoteConfigPath);
  const remotePath = options.version
    ? `${storeApiPath(config)}/versions/${validateVersionId(options.version)}`
    : `${storeApiPath(config)}/latest`;

  const response = await authenticatedFetch(config, remotePath);
  await requireApiSuccess(response, [200]);
  const restoredVersionHeader = response.headers.get("X-Toolbox-Store-Version");
  if (restoredVersionHeader !== null &&
      !VERSION_ID_PATTERN.test(restoredVersionHeader)) {
    throw new RemoteError("remote service returned an invalid restored-version header");
  }
  const restoredVersion = restoredVersionHeader || "latest";
  const envelopeText = await readResponseTextLimited(
    response,
    MAX_REMOTE_SNAPSHOT_BYTES,
    "remote snapshot"
  );
  const envelope = parseJson(envelopeText, "remote snapshot envelope is not valid JSON");
  const snapshot = decryptValue(
    "mcpctl-snapshot",
    SNAPSHOT_INFO,
    config,
    envelope
  );
  validateSnapshot(snapshot);

  await writeRestoredStore(storePath, config, snapshot, options.force);
  if (writeConfig) await writeJsonAtomic(remoteConfigPath, config);

  if (!options.quiet) {
    process.stdout.write(
      `Restored ${Object.keys(snapshot.profiles).length} profiles and ` +
      `${Object.keys(snapshot.secrets).length} encrypted secrets with ` +
      `${Object.keys(snapshot.artifacts || {}).length} portable artifacts from ${restoredVersion}.\n`
    );
  }
}

async function configForRestore(options, remoteConfigPath) {
  if (options.recoveryStdin) {
    const recoveryCode = typeof options.recoveryCode === "string"
      ? options.recoveryCode.trim()
      : (await readStandardInput(MAX_STDIN_BYTES)).trim();
    const config = parseRecoveryCode(recoveryCode);
    if (await pathExists(remoteConfigPath)) {
      const existing = await readRemoteConfig(remoteConfigPath);
      if (!sameRemoteConfig(existing, config) && !options.force) {
        throw new RemoteError(
          `recovery code differs from ${remoteConfigPath} (use --force to replace it)`
        );
      }
      return { config, writeConfig: !sameRemoteConfig(existing, config) };
    }
    return { config, writeConfig: true };
  }

  return {
    config: await readRemoteConfig(remoteConfigPath),
    writeConfig: false
  };
}

async function writeRestoredStore(storePath, config, snapshot, force) {
  if (await pathExists(storePath)) {
    const details = await lstat(storePath);
    if (details.isSymbolicLink() || !details.isDirectory()) {
      throw new RemoteError(`store path must be a real directory: ${storePath}`);
    }
  }

  const catalogPath = join(storePath, "catalog.json");
  if (await pathExists(catalogPath) && !force) {
    throw new RemoteError(
      `store already contains ${catalogPath} (use --force to restore over it)`
    );
  }

  const profilesPath = join(storePath, "profiles");
  if (await pathExists(profilesPath)) {
    const details = await lstat(profilesPath);
    if (details.isSymbolicLink() || !details.isDirectory()) {
      throw new RemoteError(`profiles path must be a real directory: ${profilesPath}`);
    }
  }
  const artifactsPath = join(storePath, "artifacts");
  if (await pathExists(artifactsPath)) {
    const details = await lstat(artifactsPath);
    if (details.isSymbolicLink() || !details.isDirectory()) {
      throw new RemoteError(`artifacts path must be a real directory: ${artifactsPath}`);
    }
  }

  await mkdir(storePath, { recursive: true, mode: 0o700 });
  await mkdir(profilesPath, { recursive: true, mode: 0o700 });
  await mkdir(artifactsPath, { recursive: true, mode: 0o700 });
  await chmod(storePath, 0o700);
  await chmod(profilesPath, 0o700);
  await chmod(artifactsPath, 0o700);

  await writeJsonAtomic(catalogPath, snapshot.catalog);
  for (const [profileName, profile] of Object.entries(snapshot.profiles)) {
    await writeJsonAtomic(join(profilesPath, `${profileName}.json`), profile);
  }
  for (const [name, artifact] of Object.entries(snapshot.artifacts || {})) {
    await writeBinaryAtomic(join(artifactsPath, name), decodeArtifact(name, artifact));
  }

  const localSecretsEnvelope = encryptValue(
    "mcpctl-local-secrets",
    LOCAL_SECRETS_INFO,
    config,
    {
      schema: SCHEMA,
      secrets: snapshot.secrets
    }
  );
  await writeJsonAtomic(
    join(storePath, "secrets.remote.enc"),
    localSecretsEnvelope
  );
}

async function printStatus(options) {
  const config = await readRemoteConfig(options.remoteConfig);
  const response = await authenticatedFetch(config, storeApiPath(config));
  const status = await readApiJson(response, [200]);
  process.stdout.write(`Endpoint: ${config.endpoint}\n`);
  process.stdout.write(`Store:    ${config.store_id}\n`);
  if (status.latest === null) {
    process.stdout.write("Latest:   (no backups)\n");
  } else {
    validateVersionMetadata(status.latest);
    process.stdout.write(`Latest:   ${status.latest.version}\n`);
    process.stdout.write(`Created:  ${status.latest.created_at}\n`);
    process.stdout.write(`Size:     ${status.latest.size} bytes\n`);
  }
}

async function printOrUpdateWebUi(options) {
  const config = await readRemoteConfig(options.remoteConfig);
  const setting = options.command === "ui-status"
    ? await getRemoteWebUiSetting(config, MCP_REMOTE_PROTOCOL)
    : await setRemoteWebUiEnabled(
      config,
      MCP_REMOTE_PROTOCOL,
      options.command === "ui-enable"
    );
  process.stdout.write(
    `Web UI: ${setting.web_ui_enabled ? "enabled" : "disabled"}\n` +
    `URL:    ${config.endpoint}/\n`
  );
}

async function printVersions(options) {
  const config = await readRemoteConfig(options.remoteConfig);
  let cursor = null;
  let pageCount = 0;
  let printed = false;

  while (pageCount < 10) {
    const query = new URLSearchParams({ limit: "100" });
    if (cursor) query.set("cursor", cursor);
    const response = await authenticatedFetch(
      config,
      `${storeApiPath(config)}/versions?${query.toString()}`
    );
    const page = await readApiJson(response, [200]);
    if (!Array.isArray(page.versions)) {
      throw new RemoteError("remote service returned an invalid version list");
    }

    for (const version of page.versions) {
      validateVersionMetadata(version);
      process.stdout.write(
        `${version.version}\t${version.created_at}\t${version.size} bytes\n`
      );
      printed = true;
    }

    cursor = typeof page.cursor === "string" && page.cursor.length > 0
      ? page.cursor
      : null;
    pageCount += 1;
    if (!cursor) break;
  }

  if (!printed) process.stdout.write("(no backups)\n");
  if (cursor) {
    process.stdout.write("(version output limited to the newest 1000 entries)\n");
  }
}

async function printRecoveryCode(options) {
  const config = await readRemoteConfig(options.remoteConfig);
  process.stdout.write(
    "Anyone with this recovery code can decrypt and update the remote store:\n"
  );
  process.stdout.write(`${makeRecoveryCode(config)}\n`);
}

async function printLocalSecrets(options) {
  const storePath = resolve(options.store);
  const config = await readRemoteConfig(options.remoteConfig);
  const secrets = await readEncryptedLocalSecrets(
    join(storePath, "secrets.remote.enc"),
    config
  );
  process.stdout.write(`${JSON.stringify({ schema: SCHEMA, secrets })}\n`);
}

async function readEncryptedLocalSecrets(filePath, config) {
  await assertRegularPrivateFile(filePath, "encrypted local secret cache");
  const envelope = parseJson(
    await readFile(filePath, "utf8"),
    `invalid encrypted local secret cache: ${filePath}`
  );
  const document = decryptValue(
    "mcpctl-local-secrets",
    LOCAL_SECRETS_INFO,
    config,
    envelope
  );
  if (!document || document.schema !== SCHEMA ||
      !document.secrets || typeof document.secrets !== "object" ||
      Array.isArray(document.secrets)) {
    throw new RemoteError("encrypted local secret cache has an invalid schema");
  }
  validateSecrets(document.secrets);
  return document.secrets;
}

function encryptValue(kind, info, config, value) {
  const plaintext = Buffer.from(JSON.stringify(value), "utf8");
  const key = deriveKey(config, info);
  const iv = randomBytes(12);
  const aad = associatedData(kind, config.store_id);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(aad, { plaintextLength: plaintext.length });
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  plaintext.fill(0);
  key.fill(0);

  return {
    schema: SCHEMA,
    kind,
    encryption: {
      algorithm: "AES-256-GCM",
      kdf: "HKDF-SHA256",
      iv: encodeBase64Url(iv),
      tag: encodeBase64Url(tag)
    },
    ciphertext: encodeBase64Url(ciphertext)
  };
}

function decryptValue(kind, info, config, envelope) {
  if (!envelope || envelope.schema !== SCHEMA || envelope.kind !== kind ||
      envelope.encryption?.algorithm !== "AES-256-GCM" ||
      envelope.encryption?.kdf !== "HKDF-SHA256" ||
      typeof envelope.encryption.iv !== "string" ||
      typeof envelope.encryption.tag !== "string" ||
      typeof envelope.ciphertext !== "string") {
    throw new RemoteError(`invalid ${kind} envelope`);
  }

  const iv = decodeBase64Url(envelope.encryption.iv, 12, "encryption IV");
  const tag = decodeBase64Url(envelope.encryption.tag, 16, "authentication tag");
  const ciphertext = decodeBase64Url(
    envelope.ciphertext,
    null,
    "encrypted payload"
  );
  const key = deriveKey(config, info);
  let plaintext;

  try {
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAAD(associatedData(kind, config.store_id));
    decipher.setAuthTag(tag);
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    throw new RemoteError(
      "snapshot authentication failed; the recovery code is wrong or the ciphertext was changed"
    );
  } finally {
    key.fill(0);
  }

  try {
    return JSON.parse(plaintext.toString("utf8"));
  } catch {
    throw new RemoteError(`decrypted ${kind} payload is invalid JSON`);
  } finally {
    plaintext.fill(0);
  }
}

function deriveKey(config, info) {
  const root = decodeBase64Url(config.root_key, 32, "root key");
  const derived = Buffer.from(hkdfSync(
    "sha256",
    root,
    Buffer.from(config.store_id, "ascii"),
    Buffer.from(info, "utf8"),
    32
  ));
  root.fill(0);
  return derived;
}

function deriveAuthenticationToken(config) {
  const key = deriveKey(config, AUTH_INFO);
  const token = encodeBase64Url(key);
  key.fill(0);
  return token;
}

function associatedData(kind, storeId) {
  return Buffer.from(`${kind}:schema=${SCHEMA}:store=${storeId}`, "utf8");
}

function makeRecoveryCode(config) {
  const validated = validateRemoteConfig(config);
  const payload = Buffer.from(JSON.stringify({
    schema: SCHEMA,
    endpoint: validated.endpoint,
    store_id: validated.store_id,
    root_key: validated.root_key
  }), "utf8");
  return `${RECOVERY_PREFIX}${encodeBase64Url(payload)}`;
}

function parseRecoveryCode(code) {
  if (typeof code !== "string" || !code.startsWith(RECOVERY_PREFIX)) {
    throw new RemoteError("recovery code has an invalid prefix");
  }
  const encoded = code.slice(RECOVERY_PREFIX.length);
  const payload = decodeBase64Url(encoded, null, "recovery code");
  if (payload.length > MAX_STDIN_BYTES) {
    throw new RemoteError("recovery code is too large");
  }
  return validateRemoteConfig(
    parseJson(payload.toString("utf8"), "recovery code payload is invalid")
  );
}

function validateRemoteConfig(value) {
  if (!value || value.schema !== SCHEMA ||
      typeof value.endpoint !== "string" ||
      typeof value.store_id !== "string" ||
      !STORE_ID_PATTERN.test(value.store_id) ||
      typeof value.root_key !== "string") {
    throw new RemoteError("remote configuration has an invalid schema");
  }
  decodeBase64Url(value.root_key, 32, "root key");
  return {
    schema: SCHEMA,
    endpoint: normalizeEndpoint(value.endpoint),
    store_id: value.store_id,
    root_key: value.root_key
  };
}

function sameRemoteConfig(left, right) {
  return left.schema === right.schema &&
    left.endpoint === right.endpoint &&
    left.store_id === right.store_id &&
    left.root_key === right.root_key;
}

function normalizeEndpoint(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new RemoteError("remote endpoint must be a valid URL");
  }

  const localHttp = url.protocol === "http:" &&
    ["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !localHttp) {
    throw new RemoteError("remote endpoint must use HTTPS (HTTP is allowed only for localhost)");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new RemoteError("remote endpoint must not contain credentials, a query, or a fragment");
  }

  const path = url.pathname.replace(/\/+$/, "");
  url.pathname = path;
  return url.toString().replace(/\/$/, "");
}

function storeApiPath(config) {
  return `/v1/stores/${config.store_id}`;
}

function apiUrl(config, path) {
  return `${config.endpoint}${path}`;
}

async function authenticatedFetch(config, path, options = {}) {
  const token = deriveAuthenticationToken(config);
  const headers = new Headers(options.headers);
  headers.set("Authorization", `Bearer ${token}`);
  headers.set("Accept", "application/json");
  tokenBufferWipeHint(token);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(apiUrl(config, path), {
      ...options,
      headers,
      redirect: "error",
      signal: controller.signal
    });
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new RemoteError("remote request timed out");
    }
    throw new RemoteError("could not reach the remote MCP store");
  } finally {
    clearTimeout(timer);
  }
}

// JavaScript strings cannot be reliably zeroed. Keeping this operation in one
// small function makes that limitation explicit and prevents accidental logs.
function tokenBufferWipeHint(_token) {}

async function requireApiSuccess(response, expectedStatuses) {
  if (expectedStatuses.includes(response.status)) return;
  await throwApiError(response);
}

async function readApiJson(response, expectedStatuses) {
  await requireApiSuccess(response, expectedStatuses);
  const text = await readResponseTextLimited(
    response,
    MAX_API_JSON_BYTES,
    "remote JSON response"
  );
  return parseJson(text, "remote service returned invalid JSON");
}

async function throwApiError(response) {
  let code = "remote_error";
  let message = `remote service returned HTTP ${response.status}`;
  try {
    const body = JSON.parse(await readResponseTextLimited(
      response,
      MAX_API_ERROR_BYTES,
      "remote error response"
    ));
    if (typeof body?.error?.code === "string" &&
        /^[a-z0-9_-]{1,64}$/.test(body.error.code)) {
      code = body.error.code;
    }
    if (typeof body?.error?.message === "string") {
      message = sanitizeRemoteMessage(body.error.message);
    }
  } catch {
    // Keep the generic status message. Never echo an arbitrary response body.
  }
  throw new RemoteError(`${code}: ${message}`);
}

async function readResponseTextLimited(response, maxBytes, label) {
  const contentLength = response.headers.get("Content-Length");
  if (contentLength !== null &&
      (/^[0-9]+$/.test(contentLength) === false ||
       Number(contentLength) > maxBytes)) {
    throw new RemoteError(`${label} exceeds the safe size limit`);
  }
  if (response.body === null) return "";

  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  const deadline = Date.now() + FETCH_TIMEOUT_MS;
  try {
    while (true) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        await reader.cancel();
        throw new RemoteError(`${label} timed out`);
      }
      let timer;
      const read = reader.read();
      const timeout = new Promise((_, rejectPromise) => {
        timer = setTimeout(
          () => rejectPromise(new RemoteError(`${label} timed out`)),
          remaining
        );
      });
      let result;
      try {
        result = await Promise.race([read, timeout]);
      } catch (error) {
        await reader.cancel().catch(() => {});
        throw error;
      } finally {
        clearTimeout(timer);
      }
      const { done, value } = result;
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new RemoteError(`${label} exceeds the safe size limit`);
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total).toString("utf8");
}

function sanitizeRemoteMessage(value) {
  const sanitized = value
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
  return sanitized || "remote request failed";
}

function validateVersionId(version) {
  if (!VERSION_ID_PATTERN.test(version)) {
    throw new RemoteError("invalid remote version identifier");
  }
  return version;
}

function validateVersionMetadata(version) {
  if (!version || !VERSION_ID_PATTERN.test(version.version || "") ||
      typeof version.created_at !== "string" ||
      !/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+Z$/.test(version.created_at) ||
      Number.isNaN(Date.parse(version.created_at)) ||
      !Number.isSafeInteger(version.size) ||
      version.size < 1) {
    throw new RemoteError("remote service returned invalid version metadata");
  }
}

function validateCatalog(catalog) {
  if (!catalog || catalog.schema !== SCHEMA ||
      !catalog.servers || typeof catalog.servers !== "object" ||
      Array.isArray(catalog.servers)) {
    throw new RemoteError("MCP catalog must contain a schema-1 servers object");
  }
}

function validateProfileName(name) {
  if (!/^[A-Za-z0-9._-]+$/.test(name)) {
    throw new RemoteError(`invalid profile filename: ${name}`);
  }
}

function validateProfile(name, profile) {
  if (!profile || (profile.schema ?? SCHEMA) !== SCHEMA || profile.name !== name) {
    throw new RemoteError(`profile ${name} has an invalid schema or name`);
  }
}

function validateSecrets(secrets) {
  if (!secrets || typeof secrets !== "object" || Array.isArray(secrets)) {
    throw new RemoteError("secrets must be an object");
  }
  for (const [name, value] of Object.entries(secrets)) {
    if (typeof name !== "string" || name.length === 0 || typeof value !== "string") {
      throw new RemoteError("every secret must have a non-empty name and string value");
    }
  }
}

function validateSnapshot(snapshot) {
  if (!snapshot || snapshot.schema !== SCHEMA ||
      typeof snapshot.created_at !== "string" ||
      !snapshot.profiles || typeof snapshot.profiles !== "object" ||
      Array.isArray(snapshot.profiles)) {
    throw new RemoteError("decrypted snapshot has an invalid schema");
  }
  validateCatalog(snapshot.catalog);
  validateArtifacts(snapshot.catalog, snapshot.artifacts);
  for (const [name, profile] of Object.entries(snapshot.profiles)) {
    validateProfileName(name);
    validateProfile(name, profile);
  }
  if (Object.keys(snapshot.profiles).length === 0) {
    throw new RemoteError("decrypted snapshot contains no profiles");
  }
  validateSecrets(snapshot.secrets);
}

async function readRemoteConfig(filePath) {
  const resolvedPath = resolve(filePath);
  await assertRegularPrivateFile(resolvedPath, "remote configuration");
  return validateRemoteConfig(
    parseJson(
      await readFile(resolvedPath, "utf8"),
      `invalid remote configuration: ${resolvedPath}`
    )
  );
}

async function assertRegularPrivateFile(filePath, label) {
  const details = await assertRegularFile(filePath, label);
  if (process.platform !== "win32" && (details.mode & 0o077) !== 0) {
    throw new RemoteError(`${label} permissions must not allow group or other access: ${filePath}`);
  }
  return details;
}

async function assertRegularFile(filePath, label) {
  let details;
  try {
    details = await lstat(filePath);
  } catch {
    throw new RemoteError(`${label} not found: ${filePath}`);
  }
  if (details.isSymbolicLink() || !details.isFile()) {
    throw new RemoteError(`${label} must be a regular file: ${filePath}`);
  }
  return details;
}

async function assertDirectory(directoryPath, label) {
  let details;
  try {
    details = await lstat(directoryPath);
  } catch {
    throw new RemoteError(`${label} not found: ${directoryPath}`);
  }
  if (details.isSymbolicLink() || !details.isDirectory()) {
    throw new RemoteError(`${label} must be a real directory: ${directoryPath}`);
  }
}

async function pathExists(filePath) {
  try {
    await lstat(filePath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function writeJsonAtomic(filePath, value) {
  const targetPath = resolve(filePath);
  const parentPath = dirname(targetPath);
  if (await pathExists(targetPath)) {
    const details = await lstat(targetPath);
    if (details.isSymbolicLink() || !details.isFile()) {
      throw new RemoteError(`refusing to replace non-regular file: ${targetPath}`);
    }
  }

  await mkdir(parentPath, { recursive: true, mode: 0o700 });
  const temporaryPath = join(
    parentPath,
    `.${targetPath.slice(parentPath.length + 1)}.tmp-${process.pid}-${randomBytes(8).toString("hex")}`
  );
  let handle;
  try {
    handle = await open(temporaryPath, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, targetPath);
    await chmod(targetPath, 0o600);
  } finally {
    if (handle) await handle.close().catch(() => {});
    await rm(temporaryPath, { force: true }).catch(() => {});
  }
}

async function writeBinaryAtomic(filePath, value) {
  const targetPath = resolve(filePath);
  const parentPath = dirname(targetPath);
  if (await pathExists(targetPath)) {
    const details = await lstat(targetPath);
    if (details.isSymbolicLink() || !details.isFile()) {
      throw new RemoteError(`refusing to replace non-regular file: ${targetPath}`);
    }
  }

  await mkdir(parentPath, { recursive: true, mode: 0o700 });
  const temporaryPath = join(
    parentPath,
    `.${targetPath.slice(parentPath.length + 1)}.tmp-${process.pid}-${randomBytes(8).toString("hex")}`
  );
  let handle;
  try {
    handle = await open(temporaryPath, "wx", 0o600);
    await handle.writeFile(value);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, targetPath);
    await chmod(targetPath, 0o600);
  } finally {
    if (handle) await handle.close().catch(() => {});
    await rm(temporaryPath, { force: true }).catch(() => {});
  }
}

async function readStandardInput(maxBytes) {
  const chunks = [];
  let total = 0;
  for await (const chunk of process.stdin) {
    total += chunk.length;
    if (total > maxBytes) throw new RemoteError("standard input exceeded the safe size limit");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function parseJson(text, errorMessage) {
  try {
    return JSON.parse(text);
  } catch {
    throw new RemoteError(errorMessage);
  }
}

function encodeBase64Url(value) {
  return Buffer.from(value).toString("base64url");
}

function decodeBase64Url(value, expectedLength, label) {
  if (typeof value !== "string" ||
      value.length === 0 ||
      !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new RemoteError(`${label} is not valid base64url`);
  }
  const decoded = Buffer.from(value, "base64url");
  if (encodeBase64Url(decoded) !== value) {
    throw new RemoteError(`${label} is not canonical base64url`);
  }
  if (expectedLength !== null && decoded.length !== expectedLength) {
    throw new RemoteError(`${label} has an invalid length`);
  }
  return decoded;
}

export {
  AUTH_INFO,
  LOCAL_SECRETS_INFO,
  RECOVERY_PREFIX,
  SNAPSHOT_INFO,
  collectCatalogArtifactReferences,
  collectCatalogSecretReferences,
  collectSnapshot,
  decryptValue,
  deriveAuthenticationToken,
  encryptValue,
  initializeRemote,
  makeRecoveryCode,
  parseRecoveryCode,
  readEncryptedLocalSecrets,
  restoreStore,
  backupStore,
  validateRemoteConfig
};

if (process.argv[1] &&
    import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((error) => {
    const message = error instanceof RemoteError || error instanceof RemoteStoreError
      ? error.message
      : "unexpected remote-client failure";
    process.stderr.write(`✗ ${message}\n`);
    process.exitCode = 1;
  });
}
