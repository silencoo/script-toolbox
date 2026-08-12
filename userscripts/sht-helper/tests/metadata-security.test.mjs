import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { createHash } from 'node:crypto';

const root = resolve(import.meta.dirname, '..');
const metadata = await readFile(resolve(root, 'src/metadata.user.js'), 'utf8');
const runtime = await readFile(resolve(root, 'sht-helper.user.js'), 'utf8');
const infrastructureSource = await readFile(resolve(root, 'src/modules/05-infrastructure.js'), 'utf8');
const rarSource = await readFile(resolve(root, 'src/modules/07-rar-runtime.js'), 'utf8');

test('userscript permissions are scoped to SHT and required service hosts', () => {
  assert.match(metadata, /@match\s+\*:\/\/sehuatang\.org\/\*/);
  assert.match(metadata, /@match\s+\*:\/\/\*\.sehuatang\.org\/\*/);
  assert.doesNotMatch(metadata, /@match\s+https?:\/\/\*\//);
  assert.doesNotMatch(metadata, /@connect\s+\*/);
  assert.doesNotMatch(metadata, /@require\s+/);
  for (const host of ['self', 'cdn.jsdelivr.net', 'raw.githubusercontent.com', '115.com', 'my.115.com', 'webapi.115.com', 'www.123pan.com']) {
    assert.match(metadata, new RegExp(`@connect\\s+${host.replaceAll('.', '\\.')}(?:\\s|$)`));
  }
});

test('heavy text/archive libraries are pinned and loaded on demand', () => {
  assert.match(runtime, /silencoo\/script-toolbox\/main\/userscripts\/sht-helper\/vendor\/zip-2\.7\.53\.min\.js/);
  assert.match(runtime, /c239c5a4914692dc41bb58027395c99ce7f1b93ab97059dc4035822303ea45d3/);
  assert.match(runtime, /jschardet@3\.0\.0/);
  assert.match(rarSource, /silencoo\/libunrar-js\/b49a41a6855374c0119283a2120d2a88a0d3811e\/libunrar\.js/);
  assert.match(rarSource, /fd17b6d83dcf5fbe2d43dc3ebf05e44760d7228d8ea74113bf6bbedc0f997bea/);
  assert.match(runtime, /assertSha256\(jsCode/);
  assert.match(runtime, /loadOptionalLibrary\('zip'\)/);
  assert.match(runtime, /loadOptionalLibrary\('jschardet'/);
  assert.match(runtime, /fetchAndShow\(\{ enhancedDecoding: false \}\)/);
  assert.match(runtime, /仅自动预览小型纯文本/);
});

test('optional library loader caches a successful request', async () => {
  const start = infrastructureSource.indexOf('    const OPTIONAL_LIBRARIES');
  const end = infrastructureSource.indexOf('    function ensureToastRegion', start);
  let requests = 0;
  const context = vm.createContext({
    Map, Promise, Error, Object,
    shtRequest: async () => {
      requests += 1;
      return { status: 200, responseText: 'globalThis.zip = { ready: true };' };
    },
    assertSha256: async () => {},
  });
  const load = vm.runInContext(`(() => {${infrastructureSource.slice(start, end)}; return loadOptionalLibrary;})()`, context);
  const first = await load('zip');
  const second = await load('zip');
  assert.equal(first.ready, true);
  assert.equal(second, first);
  assert.equal(requests, 1);
});

test('vendored zip runtime matches the enforced digest', async () => {
  const bytes = await readFile(resolve(root, 'vendor/zip-2.7.53.min.js'));
  assert.equal(createHash('sha256').update(bytes).digest('hex'), 'c239c5a4914692dc41bb58027395c99ce7f1b93ab97059dc4035822303ea45d3');
});

test('rating requests stay on the current forum origin', () => {
  assert.match(runtime, /new URL\('\/forum\.php\?mod=misc&action=rate[^']+', location\.origin\)/);
  assert.doesNotMatch(runtime, /fetch\('https:\/\/sehuatang\.org\/forum\.php\?mod=misc&action=rate/);
  assert.doesNotMatch(runtime, /'Origin': 'https:\/\/sehuatang\.org'/);
});
