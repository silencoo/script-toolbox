import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  collectSnapshot,
  validateSnapshot,
  writeSnapshot
} from "./prompt-remote.mjs";

test("Prompt Store snapshots preserve per-client editable Markdown safely", async () => {
  const root = await mkdtemp(join(tmpdir(), "prompt-remote-test-"));
  const source = join(root, "source");
  const target = join(root, "target");
  try {
    await mkdir(join(source, ".claude", "instructions"), { recursive: true });
    await mkdir(join(source, ".codex", "instructions"), { recursive: true });
    await writeFile(
      join(source, ".claude", "instructions", "personal.md"),
      "# Claude rules\n\nPrefer concise plans.\n",
      "utf8"
    );
    await writeFile(
      join(source, ".codex", "instructions", "personal.md"),
      "# Codex rules\n\nRun focused tests.\n",
      "utf8"
    );
    await writeFile(
      join(source, ".codex", "instructions", "backend.md"),
      "# Backend\n",
      "utf8"
    );

    const snapshot = await collectSnapshot(source);
    assert.equal(snapshot.kind, "promptctl-store");
    assert.deepEqual(Object.keys(snapshot.profiles).sort(), ["backend", "personal"]);
    assert.deepEqual(
      Object.keys(snapshot.profiles.personal.documents).sort(),
      ["claude", "codex"]
    );
    assert.equal(snapshot.profiles.backend.documents.claude, undefined);
    assert.equal(validateSnapshot(snapshot), snapshot);

    await writeSnapshot(target, snapshot, false);
    assert.equal(
      await readFile(join(target, ".claude", "instructions", "personal.md"), "utf8"),
      "# Claude rules\n\nPrefer concise plans.\n"
    );
    assert.equal(
      await readFile(join(target, ".codex", "instructions", "backend.md"), "utf8"),
      "# Backend\n"
    );

    await writeFile(
      join(target, ".codex", "instructions", "personal.md"),
      "# Local edit\n",
      "utf8"
    );
    await assert.rejects(
      writeSnapshot(target, snapshot, false),
      /local document differs/
    );
    await writeSnapshot(target, snapshot, true);

    const changed = structuredClone(snapshot);
    changed.profiles.personal.documents.codex.content += "tampered";
    assert.throws(() => validateSnapshot(changed), /digest does not match/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
