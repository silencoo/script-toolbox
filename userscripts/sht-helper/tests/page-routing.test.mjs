import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const toolbarSource = await readFile(resolve(root, 'src/modules/20-thread-toolbar.js'), 'utf8');
const lifecycleSource = await readFile(resolve(root, 'src/modules/70-forum-lifecycle.js'), 'utf8');
const navigationSource = await readFile(resolve(root, 'src/modules/99-navigation-search.js'), 'utf8');
const classifyStart = toolbarSource.indexOf('    function classifyPage(href)');
const classifyEnd = toolbarSource.indexOf('    const { isSearchPage', classifyStart);
const classifyPage = vm.runInNewContext(`(() => {${toolbarSource.slice(classifyStart, classifyEnd)}; return classifyPage;})()`, { URL });

test('page routing is independent of query parameter order', () => {
  assert.deepEqual({ ...classifyPage('https://sehuatang.org/') }, {
    isSearchPage: false, isThreadPage: false, isForumListPage: false, isForumHomePage: true
  });
  assert.equal(classifyPage('https://sehuatang.org/forum.php?tid=9&mod=viewthread').isThreadPage, true);
  assert.equal(classifyPage('https://sehuatang.org/forum.php?fid=2&mod=forumdisplay').isForumListPage, true);
  assert.equal(classifyPage('https://sehuatang.org/search.php?keyword=x&mod=forum').isSearchPage, true);
  assert.equal(classifyPage('https://sehuatang.org/forum.php?mod=redirect&goto=findpost').isThreadPage, false);
});

test('thread-only UI and observers do not run on home or list pages', () => {
  assert.match(toolbarSource, /const agg = isThreadPage \? ensureAggregator\(\) : null/);
  assert.match(lifecycleSource, /if \(isThreadPage\) \{\s*threadContentObserver = new MutationObserver/);
  assert.doesNotMatch(lifecycleSource, /new MutationObserver[\s\S]*?\n\s*threadContentObserver\.observe[\s\S]*?\n\s*\/\/ ========== 115/);
  assert.match(navigationSource, /if \(isThreadPage \|\| isForumListPage \|\| isSearchPage\)/);
});

test('thread mutations use one candidate scan and one combined link scan', async () => {
  assert.match(lifecycleSource, /scanThreadContent\(Array\.from\(addedRoots\)\)/);
  const attachments = await readFile(resolve(root, 'src/modules/30-attachments.js'), 'utf8');
  const links = await readFile(resolve(root, 'src/modules/50-download-links.js'), 'utf8');
  assert.match(attachments, /function scanThreadContent\(roots/);
  assert.match(links, /function collectAllDownloadLinks\(\)/);
  assert.match(links, /function scheduleCombinedLinkScan\(\)/);
  assert.match(links, /linkScopeCache = new WeakMap\(\)/);
  assert.match(links, /dirtyLinkScopes = new WeakSet\(\)/);
});
