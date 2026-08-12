import assert from "node:assert/strict";
import test from "node:test";

import { bashScriptCommand } from "./platform-command.mjs";

test("Unix launches controller scripts through their shebang", () => {
  assert.deepEqual(
    bashScriptCommand("/opt/toolbox/skillsctl", ["list", "--json"], { platform: "linux" }),
    {
      executable: "/opt/toolbox/skillsctl",
      args: ["list", "--json"]
    }
  );
});

test("Windows uses Bash without flattening paths or arguments", () => {
  assert.deepEqual(
    bashScriptCommand(
      "C:\\Users\\Test User\\工具\\mcpctl",
      ["apply", "--profile", "daily work", "--key-file", "D:\\Temp Files\\private.key"],
      { platform: "win32", bash: "C:\\Program Files\\Git\\bin\\bash.exe" }
    ),
    {
      executable: "C:\\Program Files\\Git\\bin\\bash.exe",
      args: [
        "C:/Users/Test User/工具/mcpctl",
        "apply",
        "--profile",
        "daily work",
        "--key-file",
        "D:/Temp Files/private.key"
      ]
    }
  );
});

test("controller invocation rejects ambiguous non-string argv", () => {
  assert.throws(() => bashScriptCommand("", []), /script path/i);
  assert.throws(() => bashScriptCommand("tool", ["ok", 1]), /array of strings/i);
});
