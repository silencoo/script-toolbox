/**
 * Build an invocation for one of the repository's Bash controller scripts.
 *
 * Unix can execute the shebang directly. Windows cannot, so the supported
 * native-host contract is Git for Windows/MSYS2 Bash. Keeping the script path
 * as a distinct argv item also preserves spaces and non-ASCII user paths.
 */
export function bashScriptCommand(script, args = [], {
  platform = process.platform,
  bash = process.env.SCRIPT_TOOLBOX_BASH || "bash"
} = {}) {
  if (typeof script !== "string" || script.length === 0) {
    throw new TypeError("Bash script path is required");
  }
  if (!Array.isArray(args) || args.some((argument) => typeof argument !== "string")) {
    throw new TypeError("Bash script arguments must be an array of strings");
  }
  const bashScript = platform === "win32" ? script.replaceAll("\\", "/") : script;
  return platform === "win32"
    ? { executable: bash, args: [bashScript, ...args] }
    : { executable: script, args: [...args] };
}
