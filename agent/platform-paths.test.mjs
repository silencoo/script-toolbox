import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  codexHome,
  platformConfigHome,
  platformDataHome,
  platformStateHome
} from "./platform-paths.mjs";

test("Codex home uses native paths by default", () => {
  const home = resolve("test-home");
  const alternate = join(home, "Codex Home");
  assert.equal(codexHome({ home, environment: {} }), join(home, ".codex"));
  assert.equal(codexHome({ home, environment: { CODEX_HOME: alternate } }), alternate);
});

for (const platform of ["linux", "darwin"]) {
  test(`Codex home honors explicit roots on ${platform}`, () => {
    assert.equal(codexHome({ platform, home: "/h", environment: {} }), "/h/.codex");
    assert.equal(codexHome({ platform, home: "/h",
      environment: { CODEX_HOME: "/other/codex" } }), "/other/codex");
  });
}

for (const platform of ["win32", "windows"]) {
  test(`Codex home honors explicit roots on ${platform}`, () => {
    assert.equal(codexHome({ platform, home: "C:\\Users\\T", environment: {} }), "C:\\Users\\T\\.codex");
    assert.equal(codexHome({ platform, home: "C:\\Users\\T",
      environment: { CODEX_HOME: "D:\\Codex Home" } }), "D:\\Codex Home");
  });
}

test("Linux honors XDG roots", () => {
  const options = {
    platform: "linux",
    home: "/home/test",
    environment: {
      XDG_CONFIG_HOME: "/cfg",
      XDG_STATE_HOME: "/state",
      XDG_DATA_HOME: "/data"
    }
  };
  assert.equal(platformConfigHome(options), "/cfg");
  assert.equal(platformStateHome(options), "/state");
  assert.equal(platformDataHome(options), "/data");
});

test("Windows uses roaming config and local state/data", () => {
  const options = {
    platform: "win32",
    home: "C:\\Users\\Test",
    environment: {
      APPDATA: "C:\\Users\\Test\\AppData\\Roaming",
      LOCALAPPDATA: "C:\\Users\\Test\\AppData\\Local",
      XDG_CONFIG_HOME: "/must-not-leak"
    }
  };
  assert.equal(platformConfigHome(options), options.environment.APPDATA);
  assert.equal(platformStateHome(options), options.environment.LOCALAPPDATA);
  assert.equal(platformDataHome(options), options.environment.LOCALAPPDATA);
});

test("platform roots have deterministic home fallbacks", () => {
  assert.equal(platformConfigHome({ platform: "linux", home: "/h", environment: {} }), "/h/.config");
  assert.equal(platformStateHome({ platform: "linux", home: "/h", environment: {} }), "/h/.local/state");
  assert.equal(platformDataHome({ platform: "linux", home: "/h", environment: {} }), "/h/.local/share");
  assert.match(
    platformConfigHome({ platform: "win32", home: "C:\\Users\\T", environment: {} }),
    /AppData[\\/]Roaming$/
  );
});
