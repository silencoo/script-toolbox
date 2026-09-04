import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function isMainModule(moduleUrl, argument = process.argv[1]) {
  if (!argument) return false;
  try {
    return realpathSync(fileURLToPath(moduleUrl)) === realpathSync(resolve(argument));
  } catch {
    return false;
  }
}
