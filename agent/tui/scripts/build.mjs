import { chmod, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = resolve(packageRoot, "dist", "toolbox-tui.mjs");

await mkdir(dirname(output), { recursive: true });
await build({
  entryPoints: [resolve(packageRoot, "src", "toolbox-tui.jsx")],
  outfile: output,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  packages: "bundle",
  alias: {
    "react-devtools-core": resolve(packageRoot, "scripts", "react-devtools-stub.mjs")
  },
  define: {
    "process.env.DEV": '"false"',
    "process.env.NODE_ENV": '"production"'
  },
  sourcemap: false,
  legalComments: "none",
  banner: {
    js: '#!/usr/bin/env node\nimport {createRequire as __createRequire} from "node:module";\nconst require = __createRequire(import.meta.url);'
  }
});
await chmod(output, 0o755);

const lock = JSON.parse(await readFile(resolve(packageRoot, "package-lock.json"), "utf8"));
const notices = [
  "Third-party licenses for the bundled script-toolbox agent TUI",
  "Generated from package-lock.json; development-only packages are excluded."
];
const licenseFallbacks = {
  "yoga-layout": `MIT License

Copyright (c) Meta Platforms, Inc. and affiliates.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`
};
for (const [packagePath, metadata] of Object.entries(lock.packages || {})) {
  if (!packagePath || metadata.dev) continue;
  const directory = resolve(packageRoot, packagePath);
  const manifest = JSON.parse(await readFile(resolve(directory, "package.json"), "utf8"));
  const licenseFiles = (await readdir(directory))
    .filter((name) => /^licen[cs]e(?:\.|-|$)/i.test(name))
    .sort();
  notices.push("", "=".repeat(78), `${manifest.name}@${manifest.version} (${metadata.license || manifest.license || "see license text"})`);
  if (licenseFiles.length === 0) {
    notices.push(licenseFallbacks[manifest.name] || "No license file was included in the installed package.");
  } else {
    for (const name of licenseFiles) {
      notices.push("", `--- ${name} ---`, await readFile(resolve(directory, name), "utf8"));
    }
  }
}
await writeFile(
  resolve(packageRoot, "dist", "THIRD_PARTY_LICENSES.txt"),
  `${notices.join("\n").trimEnd()}\n`,
  "utf8"
);
