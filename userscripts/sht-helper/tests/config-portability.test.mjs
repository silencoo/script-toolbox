import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const source = await readFile(resolve(import.meta.dirname, '../src/modules/10-config-ui.js'), 'utf8');
const start = source.indexOf('    function cloneJson(value)');
const end = source.indexOf('    // 导出配置；敏感凭据默认不包含。', start);
assert.ok(start >= 0 && end > start);

function createHelpers() {
  const store = new Map([['sht_sorter_config', JSON.stringify({ sortBy: 'views', sortDir: 'desc' })]]);
  const context = {
    JSON, Date, Number, Object, Array,
    console,
    CFG: {
      blockImages: true,
      pan115Cookie: 'secret-115',
      pan115UserAgent: 'secret-agent',
      pan123Token: 'secret-token',
      pan123LoginUuid: 'secret-uuid',
      pan123Cookie: 'secret-cookie',
      historyItems: [{ tid: 1 }]
    },
    DEFAULT_CONFIG: { blockImages: true, maxAutoBytes: 10, keywordFilters: [], pan115Cookie: '' },
    SEARCH_CONFIG_KEY: 'sht_sorter_config',
    CONFIG_EXPORT_VERSION: '3.2.0',
    SENSITIVE_CONFIG_KEYS: ['pan115Cookie', 'pan115UserAgent', 'pan123Token', 'pan123LoginUuid', 'pan123Cookie'],
    GM_getValue: key => store.get(key)
  };
  return vm.runInNewContext(`(() => {${source.slice(start, end)}; return { createConfigExport, sanitizeImportedObject, sanitizeImportedSearchConfig };})()`, context);
}

test('configuration exports redact credentials by default and include search state', () => {
  const { createConfigExport } = createHelpers();
  const safe = createConfigExport(false);
  assert.equal(safe.version, '3.2.0');
  assert.equal(safe.config.pan115Cookie, undefined);
  assert.equal(safe.config.pan123Token, undefined);
  assert.equal(safe.config.historyItems, undefined);
  assert.equal(safe.searchConfig.sortBy, 'views');
  const complete = createConfigExport(true);
  assert.equal(complete.config.pan115Cookie, 'secret-115');
  assert.equal(complete.includesSensitiveCredentials, true);
});

test('configuration has schema migration and volatile credential storage', () => {
  assert.match(source, /const CONFIG_SCHEMA_VERSION = 3/);
  assert.match(source, /function migrateConfig\(input\)/);
  assert.match(source, /credentialsSessionOnly/);
  assert.match(source, /const volatileCredentialVault = \{\}/);
  assert.doesNotMatch(source, /sessionStorage\.setItem/);
});

test('configuration imports keep only known, correctly typed fields', () => {
  const { sanitizeImportedObject, sanitizeImportedSearchConfig } = createHelpers();
  const main = sanitizeImportedObject({ blockImages: false, maxAutoBytes: 20, unknown: 'drop' },
    { blockImages: true, maxAutoBytes: 10 }, 'config');
  assert.deepEqual({ ...main }, { blockImages: false, maxAutoBytes: 20 });
  assert.throws(() => sanitizeImportedObject({ maxAutoBytes: '20' }, { maxAutoBytes: 10 }, 'config'));
  const search = sanitizeImportedSearchConfig({ sortBy: 'quota', secondarySort: 'views', onlyQuota: true });
  assert.equal(search.sortBy, 'quota');
  assert.equal(search.onlyQuota, true);
  assert.throws(() => sanitizeImportedSearchConfig({ sortBy: 'unknown' }));
});
