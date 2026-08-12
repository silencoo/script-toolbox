import assert from "node:assert/strict";
import test from "node:test";

import {
  platformConfigHome,
  platformDataHome,
  platformStateHome
} from "./platform-paths.mjs";

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
