import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const moduleDir = resolve(root, 'src/modules');
const names = (await readdir(moduleDir)).filter(name => name.endsWith('.js'));
const modules = Object.fromEntries(await Promise.all(names.map(async name => [name, await readFile(resolve(moduleDir, name), 'utf8')])));
const allSource = Object.values(modules).join('\n');

test('toolbar remembers groups, supports compact mode, and exposes counts', () => {
  const toolbar = modules['20-thread-toolbar.js'];
  assert.match(toolbar, /toolbarGroupState/);
  assert.match(toolbar, /toolbarCompactMode/);
  assert.match(toolbar, /function updateToolbarCounts/);
  assert.match(toolbar, /cloudTaskQueue\.subscribe/);
});

test('blocking browser dialogs and direct network calls are removed', () => {
  assert.doesNotMatch(allSource, /\b(?:alert|confirm|prompt)\s*\(/);
  const outsideInfrastructure = Object.entries(modules)
    .filter(([name]) => name !== '05-infrastructure.js')
    .map(([, source]) => source).join('\n');
  assert.doesNotMatch(outsideInfrastructure, /GM_xmlhttpRequest\s*\(/);
  assert.doesNotMatch(outsideInfrastructure, /\bfetch\s*\(/);
});

test('credential controls and diagnostic export are present', () => {
  const settings = modules['25-settings-ui.js'];
  assert.match(settings, /attachSensitiveFieldControls/);
  assert.match(settings, /testCloudProviderConnection\('pan115'/);
  assert.match(settings, /testCloudProviderConnection\('pan123'/);
  assert.match(settings, /credentialsSessionOnly/);
  assert.match(settings, /exportDiagnosticReport/);
});

test('large toolbar and 123Pan sources remain split into focused modules', () => {
  for (const [name, source] of Object.entries(modules)) {
    assert.ok(source.split('\n').length < 1500, `${name} should stay below 1,500 lines`);
  }
  for (const expected of ['20-thread-toolbar.js', '25-settings-ui.js', '85-pan123-client.js', '90-cloud-folder-ui.js', '92-pan123-tasks.js']) {
    assert.ok(names.includes(expected), `${expected} is missing`);
  }
});
