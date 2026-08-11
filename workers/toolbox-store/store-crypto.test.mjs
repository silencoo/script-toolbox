import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";

import {
  MCP_REMOTE_PROTOCOL,
  PROMPT_REMOTE_PROTOCOL,
  SKILLS_REMOTE_PROTOCOL,
  WORKSPACE_REMOTE_PROTOCOL,
  decryptSnapshot,
  deriveAuthenticationToken as deriveNodeToken,
  encryptSnapshot,
  makeRecoveryCode
} from "../../agent/remote-store.mjs";
import {
  PROTOCOLS,
  decryptEnvelope,
  deriveAuthenticationToken,
  encryptEnvelope,
  parseRecoveryCode
} from "./web/src/lib/store-crypto.js";

const config = {
  schema: 1,
  endpoint: "https://store.example",
  store_id: randomBytes(16).toString("hex"),
  root_key: randomBytes(32).toString("base64url")
};

for (const [name, nodeProtocol, browserProtocol] of [
  ["MCP", MCP_REMOTE_PROTOCOL, PROTOCOLS.mcp],
  ["skills", SKILLS_REMOTE_PROTOCOL, PROTOCOLS.skills],
  ["prompts", PROMPT_REMOTE_PROTOCOL, PROTOCOLS.prompts],
  ["Workspace", WORKSPACE_REMOTE_PROTOCOL, PROTOCOLS.workspace]
]) {
  test(`${name} browser crypto is byte-compatible with the CLI protocol`, async () => {
    const recovery = makeRecoveryCode(config, nodeProtocol);
    const parsed = parseRecoveryCode(recovery);
    assert.deepEqual(parsed.config, config);
    assert.equal(parsed.protocol, browserProtocol);
    assert.equal(
      await deriveAuthenticationToken(config, browserProtocol),
      deriveNodeToken(config, nodeProtocol)
    );

    const snapshot = {
      schema: 1,
      kind: `${name.toLowerCase()}-test`,
      values: ["profiles", "packs", "日本語"],
      created_at: new Date().toISOString()
    };
    const nodeEnvelope = encryptSnapshot(config, nodeProtocol, snapshot);
    assert.deepEqual(
      await decryptEnvelope(config, browserProtocol, nodeEnvelope),
      snapshot
    );

    const browserEnvelope = await encryptEnvelope(config, browserProtocol, snapshot);
    assert.deepEqual(decryptSnapshot(config, nodeProtocol, browserEnvelope), snapshot);
  });
}
