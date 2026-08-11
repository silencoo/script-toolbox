import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
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
    await mkdir(join(source, ".claude", "keysmith"), { recursive: true });
    await writeFile(
      join(source, ".claude", "CLAUDE.md"),
      "Header\n\n<!-- claude-keysmith:start name=personal-rules -->\n" +
        "@keysmith/personal-rules.md\n" +
        "<!-- claude-keysmith:end name=personal-rules -->\n",
      "utf8"
    );
    await writeFile(
      join(source, ".claude", "keysmith", "personal-rules.md"),
      "# Legacy Claude rules\n\nUse the narrowest safe change.\n",
      "utf8"
    );
    await mkdir(
      join(source, ".local", "share", "script-toolbox", "snippets"),
      { recursive: true }
    );
    await writeFile(
      join(source, ".local", "share", "script-toolbox", "snippets", "review-code.md"),
      "Review the selected files and list concrete risks.\n",
      "utf8"
    );

    const snapshot = await collectSnapshot(source);
    assert.equal(snapshot.kind, "promptctl-store");
    assert.deepEqual(
      Object.keys(snapshot.profiles).sort(),
      ["backend", "personal", "personal-rules"]
    );
    assert.deepEqual(
      Object.keys(snapshot.profiles.personal.documents).sort(),
      ["claude", "codex"]
    );
    assert.equal(snapshot.profiles.backend.documents.claude, undefined);
    assert.deepEqual(
      Object.keys(snapshot.profiles["personal-rules"].documents),
      ["claude"]
    );
    assert.deepEqual(Object.keys(snapshot.snippets), ["review-code"]);
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
    assert.equal(
      await readFile(
        join(target, ".claude", "instructions", "personal-rules.md"),
        "utf8"
      ),
      "# Legacy Claude rules\n\nUse the narrowest safe change.\n"
    );
    assert.equal(
      await readFile(
        join(target, ".local", "share", "script-toolbox", "snippets", "review-code.md"),
        "utf8"
      ),
      "Review the selected files and list concrete risks.\n"
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

    await writeFile(
      join(target, ".local", "share", "script-toolbox", "snippets", "review-code.md"),
      "Local snippet edit\n",
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
    const changedSnippet = structuredClone(snapshot);
    changedSnippet.snippets["review-code"].content += "tampered";
    assert.throws(() => validateSnapshot(changedSnippet), /digest does not match/);

    const legacy = structuredClone(snapshot);
    delete legacy.snippets;
    assert.equal(validateSnapshot(legacy), legacy);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Claude Keysmith discovery fails closed on unsafe or ambiguous sources", async () => {
  const root = await mkdtemp(join(tmpdir(), "prompt-keysmith-safety-test-"));
  const home = join(root, "home");
  try {
    await mkdir(join(home, ".claude", "keysmith"), { recursive: true });
    await writeFile(
      join(home, ".claude", "CLAUDE.md"),
      "<!-- claude-keysmith:start name=rules -->\n" +
        "@keysmith/../private.md\n" +
        "<!-- claude-keysmith:end name=rules -->\n",
      "utf8"
    );
    await assert.rejects(
      collectSnapshot(home),
      /must reference @keysmith\/rules\.md/
    );

    await writeFile(
      join(home, ".claude", "CLAUDE.md"),
      "<!-- claude-keysmith:start name=rules -->\n" +
        "@keysmith/rules.md\n" +
        "<!-- claude-keysmith:end name=rules -->\n",
      "utf8"
    );
    await writeFile(join(root, "outside.md"), "outside\n", "utf8");
    await symlink(join(root, "outside.md"), join(home, ".claude", "keysmith", "rules.md"));
    await assert.rejects(
      collectSnapshot(home),
      /document must be a regular file/
    );

    await rm(join(home, ".claude", "keysmith", "rules.md"));
    await writeFile(join(home, ".claude", "keysmith", "rules.md"), "legacy\n", "utf8");
    await mkdir(join(home, ".claude", "instructions"), { recursive: true });
    await writeFile(join(home, ".claude", "instructions", "rules.md"), "managed\n", "utf8");
    await assert.rejects(
      collectSnapshot(home),
      /conflicting claude document sources/
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("orphaned user-level Keysmith documents remain recoverable after migration", async () => {
  const root = await mkdtemp(join(tmpdir(), "prompt-keysmith-orphan-test-"));
  try {
    await mkdir(join(root, ".claude", "keysmith"), { recursive: true });
    await writeFile(join(root, ".claude", "CLAUDE.md"), "No legacy block remains.\n", "utf8");
    await writeFile(
      join(root, ".claude", "keysmith", "archived-rules.md"),
      "# Archived rules\n",
      "utf8"
    );
    const snapshot = await collectSnapshot(root);
    assert.deepEqual(Object.keys(snapshot.profiles), ["archived-rules"]);
    assert.deepEqual(Object.keys(snapshot.profiles["archived-rules"].documents), ["claude"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
