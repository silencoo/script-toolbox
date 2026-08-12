import { homedir } from "node:os";
import { join } from "node:path";

export function platformConfigHome({
  platform = process.platform,
  environment = process.env,
  home = homedir()
} = {}) {
  if (platform === "win32") {
    return environment.APPDATA || join(home, "AppData", "Roaming");
  }
  return environment.XDG_CONFIG_HOME || join(home, ".config");
}

export function platformStateHome({
  platform = process.platform,
  environment = process.env,
  home = homedir()
} = {}) {
  if (platform === "win32") {
    return environment.LOCALAPPDATA || environment.APPDATA || join(home, "AppData", "Local");
  }
  return environment.XDG_STATE_HOME || join(home, ".local", "state");
}

export function platformDataHome({
  platform = process.platform,
  environment = process.env,
  home = homedir()
} = {}) {
  if (platform === "win32") {
    return environment.LOCALAPPDATA || environment.APPDATA || join(home, "AppData", "Local");
  }
  return environment.XDG_DATA_HOME || join(home, ".local", "share");
}
