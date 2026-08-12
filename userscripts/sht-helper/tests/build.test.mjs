import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');

test('generated userscript matches the ordered source modules', async () => {
  const metadata = await readFile(join(root, 'src', 'metadata.user.js'), 'utf8');
  const names = (await readdir(join(root, 'src', 'modules')))
    .filter(name => name.endsWith('.js'))
    .sort((a, b) => a.localeCompare(b, 'en'));
  assert.ok(names.length >= 10, 'runtime should remain split into focused source modules');
  const parts = [metadata];
  for (const name of names) parts.push(await readFile(join(root, 'src', 'modules', name), 'utf8'));
  const expected = parts.map(part => part.trimEnd()).join('\n\n') + '\n';
  assert.equal(await readFile(join(root, 'sht-helper.user.js'), 'utf8'), expected);
});
