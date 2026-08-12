import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const source = await readFile(resolve(import.meta.dirname, '../src/modules/99-navigation-search.js'), 'utf8');
const start = source.indexOf('        function parseSizeMB(text)');
const end = source.indexOf('        function isQiuPian(li)', start);
const helpers = vm.runInNewContext(`(() => {
  const toHalf = s => (s || '').replace(/[０-９]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFF10 + 0x30));
  const numNorm = s => toHalf(s).replace(/,/g, '');
  ${source.slice(start, end)}
  return { parseSizeMB, parseQuota };
})()`);

test('search parser handles CJK digits and storage units', () => {
  assert.equal(helpers.parseSizeMB('影片容量：1.5TB'), 1.5 * 1024 * 1024);
  assert.equal(helpers.parseSizeMB('容量: 2GB'), 2048);
  assert.equal(helpers.parseQuota('示例 20配额 / ５０配額'), 50);
  assert.equal(helpers.parseQuota('无配额数字'), 0);
});

test('search module retains multi-sort, filtering, and highlighting', () => {
  assert.match(source, /function multiSort\(arr\)/);
  assert.match(source, /secondarySort/);
  assert.match(source, /onlyQuota/);
  assert.match(source, /filterQiuPian/);
  assert.match(source, /function updateHighlights\(\)/);
});
