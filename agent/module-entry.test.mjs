import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { isMainModule } from "./module-entry.mjs";

test("main-module detection recognizes direct execution", () => {
  assert.equal(isMainModule(import.meta.url, fileURLToPath(import.meta.url)), true);
  assert.equal(isMainModule(import.meta.url, ""), false);
});

test("main-module detection resolves aliased parent paths", {
  skip: process.platform === "win32" ? "directory symlink fixture is covered by Unix CI" : false
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "module-entry-"));
  const realDirectory = join(root, "real");
  const aliasDirectory = join(root, "alias");
  const script = join(realDirectory, "cli.mjs");
  try {
    await mkdir(realDirectory);
    await writeFile(script, "// fixture\n");
    await symlink(realDirectory, aliasDirectory, "dir");
    assert.equal(
      isMainModule(pathToFileURL(script).href, join(aliasDirectory, "cli.mjs")),
      true
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
