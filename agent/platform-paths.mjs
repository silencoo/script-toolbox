import { homedir } from "node:os";
import { posix, win32 } from "node:path";

function pathApi(platform) {
  return platform === "win32" ? win32 : posix;
}

export function platformConfigHome({
  platform = process.platform,
  environment = process.env,
  home = homedir()
} = {}) {
  if (platform === "win32") {
    return environment.APPDATA || pathApi(platform).join(home, "AppData", "Roaming");
  }
  return environment.XDG_CONFIG_HOME || pathApi(platform).join(home, ".config");
}

export function platformStateHome({
  platform = process.platform,
  environment = process.env,
  home = homedir()
} = {}) {
  if (platform === "win32") {
    return environment.LOCALAPPDATA || environment.APPDATA ||
      pathApi(platform).join(home, "AppData", "Local");
  }
  return environment.XDG_STATE_HOME || pathApi(platform).join(home, ".local", "state");
}

export function platformDataHome({
  platform = process.platform,
  environment = process.env,
  home = homedir()
} = {}) {
  if (platform === "win32") {
    return environment.LOCALAPPDATA || environment.APPDATA ||
      pathApi(platform).join(home, "AppData", "Local");
  }
  return environment.XDG_DATA_HOME || pathApi(platform).join(home, ".local", "share");
}
