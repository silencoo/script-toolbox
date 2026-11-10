import { readFile } from "node:fs/promises";
import vm from "node:vm";

function parseArgs(values) {
  return Object.fromEntries(
    values.map((value) => {
      const separator = value.indexOf("=");
      return separator < 0
        ? [value, "true"]
        : [value.slice(0, separator), value.slice(separator + 1)];
    }),
  );
}

const source = await readFile(new URL("./convert-v2.js", import.meta.url), "utf8");
const context = vm.createContext({ $arguments: parseArgs(process.argv.slice(2)) });
vm.runInContext(`${source}\n;globalThis.__convertV2Main = main;`, context);

const proxies = [
  "Japan Node",
  "US Node",
  "TW Node",
  "Singapore Node",
  "Hong Kong Node",
  "[pro] Residential AI",
].map((name, index) => ({
  name: name,
  type: "ss",
  server: "127.0.0.1",
  port: 10001 + index,
  cipher: "aes-128-gcm",
  password: "fixture-password",
  udp: true,
}));

proxies.push({
  name: "Traffic: 100 GB",
  type: "ss",
  server: "127.0.0.1",
  port: 10099,
  cipher: "aes-128-gcm",
  password: "fixture-password",
});

const profile = context.__convertV2Main({ proxies: proxies });
process.stdout.write(`${JSON.stringify(profile, null, 2)}\n`);
