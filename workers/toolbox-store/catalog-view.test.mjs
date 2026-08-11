import assert from "node:assert/strict";
import test from "node:test";

import {
  catalogEntriesForView,
  collectionOptionLabel,
} from "./web/src/lib/catalog-view.js";
import { resolvePack } from "./web/src/lib/skill-model.js";

const entries = [
  ["zeta", { description: "disabled server" }],
  ["alpha", { description: "enabled server" }],
  ["beta", { description: "enabled search" }],
];
const enabled = new Set(["alpha", "beta"]);

test("catalog view defaults to enabled items and keeps them alphabetical", () => {
  assert.deepEqual(
    catalogEntriesForView(entries, enabled).map(([name]) => name),
    ["alpha", "beta"],
  );
});

test("all-items view pins enabled entries before disabled entries", () => {
  assert.deepEqual(
    catalogEntriesForView(entries, enabled, "", "all").map(([name]) => name),
    ["alpha", "beta", "zeta"],
  );
  assert.deepEqual(
    catalogEntriesForView(entries, enabled, "search", "all").map(([name]) => name),
    ["beta"],
  );
});

test("profile option labels expose resolved enabled counts", () => {
  assert.equal(collectionOptionLabel("ccs-current", 9), "ccs-current · 9 enabled");
  assert.equal(
    collectionOptionLabel("ccs-current", 9, "Codex"),
    "ccs-current · 9 enabled · Codex",
  );
});

test("Skill packs resolve target overrides after inherited shared selections", () => {
  const snapshot = {
    packs: {
      base: {
        extends: [],
        enable: ["docs"],
        disable: [],
        target_overrides: {},
      },
      work: {
        extends: ["base"],
        enable: ["browser"],
        disable: [],
        target_overrides: {
          claude: { enable: ["ios"], disable: ["browser"] },
        },
      },
    },
  };
  assert.deepEqual([...resolvePack(snapshot, "work")].sort(), ["browser", "docs"]);
  assert.deepEqual([...resolvePack(snapshot, "work", "claude")].sort(), ["docs", "ios"]);
});
