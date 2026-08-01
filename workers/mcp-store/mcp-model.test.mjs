import assert from "node:assert/strict";
import test from "node:test";

import {
  collectSecretDescriptors,
  findMcpVariantConflicts,
  mergeRedactedMcpImport,
  redactMcpSnapshot,
  resolveMcpProfile,
  setMcpServerEnabled
} from "./web/src/lib/mcp-model.js";

function fixture() {
  return {
    schema: 1,
    created_at: "2026-08-01T00:00:00.000Z",
    catalog: {
      schema: 1,
      servers: {
        context7: { transport: "http", url: "https://example.test/context7" },
        "tavily-keyless": {
          transport: "http",
          url: "https://example.test/tavily",
          variant_group: "tavily-auth"
        },
        "tavily-api": {
          transport: "http",
          url: "https://example.test/tavily",
          variant_group: "tavily-auth",
          auth: {
            type: "header",
            header: "Authorization",
            prefix: "Bearer ",
            secret: "tavily_api_key",
            env: "TAVILY_API_KEY",
            required: true
          }
        },
        "tavily-oauth": {
          transport: "http",
          url: "https://example.test/tavily",
          variant_group: "tavily-auth"
        }
      }
    },
    profiles: {
      base: {
        schema: 1,
        name: "base",
        extends: [],
        enable: ["context7", "tavily-keyless"],
        disable: [],
        target_overrides: {}
      },
      research: {
        schema: 1,
        name: "research",
        extends: ["base"],
        enable: [],
        disable: [],
        target_overrides: {}
      }
    },
    secrets: { tavily_api_key: "tvly-test", unrelated: "keep-me" }
  };
}

test("selecting an MCP variant disables inherited siblings", () => {
  const snapshot = fixture();
  setMcpServerEnabled(snapshot, "research", "tavily-api", true);
  assert.deepEqual(
    [...resolveMcpProfile(snapshot, "research")].sort(),
    ["context7", "tavily-api"]
  );
  assert.deepEqual(snapshot.profiles.research.enable, ["tavily-api"]);
  assert.deepEqual(
    snapshot.profiles.research.disable,
    ["tavily-keyless", "tavily-oauth"]
  );
  assert.deepEqual(findMcpVariantConflicts(snapshot), []);
});

test("conflicting hand-written MCP variants are reported", () => {
  const snapshot = fixture();
  snapshot.profiles.base.enable.push("tavily-api");
  assert.deepEqual(findMcpVariantConflicts(snapshot), [{
    profile: "base",
    group: "tavily-auth",
    servers: ["tavily-api", "tavily-keyless"]
  }, {
    profile: "research",
    group: "tavily-auth",
    servers: ["tavily-api", "tavily-keyless"]
  }]);
});

test("secret descriptors are deduplicated and keep required metadata", () => {
  const definition = fixture().catalog.servers["tavily-api"];
  definition.target_overrides = {
    codex: {
      headers: {
        Authorization: {
          secret: "tavily_api_key",
          env: "TAVILY_API_KEY",
          required: false
        }
      }
    }
  };
  assert.deepEqual(collectSecretDescriptors(definition), [{
    secret: "tavily_api_key",
    env: "TAVILY_API_KEY",
    required: true,
    source: "authentication",
    header: "Authorization"
  }]);
});

test("redacted exports omit values and preserve current secrets on import", () => {
  const current = fixture();
  const exported = redactMcpSnapshot(current);
  assert.equal(exported.redactedCount, 2);
  assert.deepEqual(exported.snapshot.secrets, {});
  assert.deepEqual(
    exported.snapshot._toolbox_export.secret_names,
    ["tavily_api_key", "unrelated"]
  );

  exported.snapshot.profiles.research.description = "Imported profile";
  const merged = mergeRedactedMcpImport(exported.snapshot, current);
  assert.equal(merged.redacted, true);
  assert.equal(merged.preservedCount, 2);
  assert.deepEqual(merged.snapshot.secrets, current.secrets);
  assert.equal(merged.snapshot._toolbox_export, undefined);
  assert.equal(merged.snapshot.profiles.research.description, "Imported profile");
});
