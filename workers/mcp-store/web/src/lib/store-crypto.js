const encoder = new TextEncoder();
const decoder = new TextDecoder();

const PROTOCOLS = {
  mcp: Object.freeze({
    id: "mcpctl",
    prefix: "mcpstore1_",
    authInfo: "mcpctl/store-authentication/v1",
    snapshotInfo: "mcpctl/snapshot-encryption/v1",
    envelopeKind: "mcpctl-snapshot",
    contentType: "application/vnd.mcpctl.snapshot+json",
    baseHeader: "X-MCPCTL-Base-Version"
  }),
  skills: Object.freeze({
    id: "skillsctl",
    prefix: "skillstore1_",
    authInfo: "skillsctl/store-authentication/v1",
    snapshotInfo: "skillsctl/snapshot-encryption/v1",
    envelopeKind: "skillsctl-snapshot",
    contentType: "application/vnd.skillsctl.snapshot+json",
    baseHeader: "X-Toolbox-Base-Version"
  }),
  prompts: Object.freeze({
    id: "promptctl",
    prefix: "promptstore1_",
    authInfo: "promptctl/store-authentication/v1",
    snapshotInfo: "promptctl/snapshot-encryption/v1",
    envelopeKind: "promptctl-snapshot",
    contentType: "application/vnd.promptctl.snapshot+json",
    baseHeader: "X-Toolbox-Base-Version"
  }),
  workspace: Object.freeze({
    id: "agentctl-workspace",
    prefix: "toolbox1_",
    authInfo: "agentctl/workspace-authentication/v1",
    snapshotInfo: "agentctl/workspace-encryption/v1",
    envelopeKind: "agentctl-workspace-snapshot",
    contentType: "application/vnd.agentctl.workspace+json",
    baseHeader: "X-Toolbox-Base-Version"
  })
};

function parseRecoveryCode(code) {
  const protocol = Object.values(PROTOCOLS).find((candidate) => code.startsWith(candidate.prefix));
  if (!protocol) {
    throw new Error(
      "Recovery code must start with toolbox1_, mcpstore1_, skillstore1_, or promptstore1_."
    );
  }
  const payload = decodeBase64Url(code.slice(protocol.prefix.length));
  if (payload.byteLength > 64 * 1024) throw new Error("Recovery code is too large.");
  let config;
  try {
    config = JSON.parse(decoder.decode(payload));
  } catch {
    throw new Error("Recovery code payload is invalid.");
  }
  return { protocol, config: validateRemoteConfig(config) };
}

function validateRemoteConfig(config) {
  if (config?.schema !== 1 || !/^[a-f0-9]{32}$/.test(config.store_id || "") ||
      typeof config.root_key !== "string") {
    throw new Error("Recovery code has an invalid schema.");
  }
  if (decodeBase64Url(config.root_key).byteLength !== 32) {
    throw new Error("Recovery key is invalid.");
  }
  let endpoint;
  try {
    endpoint = new URL(config.endpoint);
  } catch {
    throw new Error("Recovery endpoint is invalid.");
  }
  const localHttp = endpoint.protocol === "http:" &&
    ["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname);
  if (endpoint.protocol !== "https:" && !localHttp) {
    throw new Error("Recovery endpoint must use HTTPS.");
  }
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new Error("Recovery endpoint contains unsupported components.");
  }
  endpoint.pathname = endpoint.pathname.replace(/\/+$/, "");
  return {
    schema: 1,
    endpoint: endpoint.toString().replace(/\/$/, ""),
    store_id: config.store_id,
    root_key: config.root_key
  };
}

async function importRootKey(config) {
  return crypto.subtle.importKey(
    "raw",
    decodeBase64Url(config.root_key),
    "HKDF",
    false,
    ["deriveBits", "deriveKey"]
  );
}

function hkdfParameters(config, info) {
  return {
    name: "HKDF",
    hash: "SHA-256",
    salt: encoder.encode(config.store_id),
    info: encoder.encode(info)
  };
}

async function deriveAuthenticationToken(config, protocol) {
  const token = await crypto.subtle.deriveBits(
    hkdfParameters(config, protocol.authInfo),
    await importRootKey(config),
    256
  );
  return encodeBase64Url(new Uint8Array(token));
}

async function deriveEncryptionKey(config, info) {
  return crypto.subtle.deriveKey(
    hkdfParameters(config, info),
    await importRootKey(config),
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

async function decryptEnvelope(config, protocol, envelope) {
  if (envelope?.schema !== 1 || envelope.kind !== protocol.envelopeKind ||
      envelope.encryption?.algorithm !== "AES-256-GCM" ||
      envelope.encryption?.kdf !== "HKDF-SHA256" ||
      typeof envelope.encryption.iv !== "string" ||
      typeof envelope.encryption.tag !== "string" ||
      typeof envelope.ciphertext !== "string") {
    throw new Error("Encrypted backup envelope is invalid.");
  }
  const ciphertext = decodeBase64Url(envelope.ciphertext);
  const tag = decodeBase64Url(envelope.encryption.tag);
  if (tag.byteLength !== 16 || decodeBase64Url(envelope.encryption.iv).byteLength !== 12) {
    throw new Error("Encrypted backup envelope is invalid.");
  }
  const combined = new Uint8Array(ciphertext.byteLength + tag.byteLength);
  combined.set(ciphertext);
  combined.set(tag, ciphertext.byteLength);
  let plaintext;
  try {
    plaintext = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: decodeBase64Url(envelope.encryption.iv),
        additionalData: encoder.encode(
          `${envelope.kind}:schema=1:store=${config.store_id}`
        ),
        tagLength: 128
      },
      await deriveEncryptionKey(config, protocol.snapshotInfo),
      combined
    );
  } catch {
    throw new Error("Could not decrypt this backup with the supplied recovery code.");
  }
  try {
    return JSON.parse(decoder.decode(plaintext));
  } catch {
    throw new Error("Decrypted backup is not valid JSON.");
  }
}

async function encryptEnvelope(config, protocol, snapshot) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = new Uint8Array(await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv,
      additionalData: encoder.encode(
        `${protocol.envelopeKind}:schema=1:store=${config.store_id}`
      ),
      tagLength: 128
    },
    await deriveEncryptionKey(config, protocol.snapshotInfo),
    encoder.encode(JSON.stringify(snapshot))
  ));
  return {
    schema: 1,
    kind: protocol.envelopeKind,
    encryption: {
      algorithm: "AES-256-GCM",
      kdf: "HKDF-SHA256",
      iv: encodeBase64Url(iv),
      tag: encodeBase64Url(encrypted.slice(-16))
    },
    ciphertext: encodeBase64Url(encrypted.slice(0, -16))
  };
}

function encodeBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function decodeBase64Url(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error("Base64 data is invalid.");
  }
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") +
    "=".repeat((4 - value.length % 4) % 4);
  let binary;
  try {
    binary = atob(padded);
  } catch {
    throw new Error("Base64 data is invalid.");
  }
  const decoded = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  if (encodeBase64Url(decoded) !== value) throw new Error("Base64 data is invalid.");
  return decoded;
}

export {
  PROTOCOLS,
  decryptEnvelope,
  deriveAuthenticationToken,
  encryptEnvelope,
  parseRecoveryCode,
  validateRemoteConfig
};
