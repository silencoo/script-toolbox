import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseHTML } from 'linkedom';
import { webcrypto } from 'node:crypto';

const root = resolve(import.meta.dirname, '..');
const fixture = name => readFile(resolve(root, 'tests/fixtures', name), 'utf8');
const toolbarSource = await readFile(resolve(root, 'src/modules/20-thread-toolbar.js'), 'utf8');
const linkSource = await readFile(resolve(root, 'src/modules/50-download-links.js'), 'utf8');
const runtime = await readFile(resolve(root, 'sht-helper.user.js'), 'utf8');

const classifyStart = toolbarSource.indexOf('    function classifyPage(href)');
const classifyEnd = toolbarSource.indexOf('    const { isSearchPage', classifyStart);
const classifyPage = vm.runInNewContext(`(() => {${toolbarSource.slice(classifyStart, classifyEnd)}; return classifyPage;})()`, { URL });

test('page fixtures map to the expected lifecycle without thread controls on home/search', async () => {
  const home = parseHTML(await fixture('home.html')).document;
  const search = parseHTML(await fixture('search.html')).document;
  const thread = parseHTML(await fixture('thread.html')).document;
  assert.equal(classifyPage('https://sehuatang.org/').isForumHomePage, true);
  assert.equal(classifyPage('https://sehuatang.org/search.php?keyword=x&mod=forum').isSearchPage, true);
  assert.equal(classifyPage('https://sehuatang.org/forum.php?tid=1&mod=viewthread').isThreadPage, true);
  assert.equal(home.querySelector('[id^="postmessage_"]'), null);
  assert.equal(search.querySelectorAll('li.pbw').length, 2);
  assert.equal(thread.querySelectorAll('[id^="postmessage_"]').length, 2);
});

test('the complete generated userscript does not create thread UI or observers on the home fixture', async () => {
  const { window } = parseHTML(await fixture('home.html'));
  const pageUrl = new URL('https://sehuatang.org/');
  let observerCount = 0;
  class MutationObserverStub {
    constructor() { observerCount += 1; }
    observe() {}
    disconnect() {}
  }
  const context = {
    window,
    document: window.document,
    location: pageUrl,
    navigator: { userAgent: 'SHT fixture test' },
    Element: window.Element,
    Node: window.Node,
    NodeFilter: { SHOW_TEXT: 4 },
    MutationObserver: MutationObserverStub,
    IntersectionObserver: class { observe() {} unobserve() {} disconnect() {} },
    URL,
    URLSearchParams,
    Blob,
    TextEncoder,
    TextDecoder,
    Uint8Array,
    ArrayBuffer,
    DataView,
    Map,
    Set,
    WeakMap,
    WeakSet,
    Promise,
    crypto: webcrypto,
    DOMException,
    console,
    setTimeout,
    clearTimeout,
    GM_getValue: () => undefined,
    GM_setValue: () => {},
    GM_deleteValue: () => {},
    GM_setClipboard: () => {},
    GM_addStyle: () => {},
    GM_xmlhttpRequest: () => { throw new Error('home fixture must not make a request'); },
  };
  vm.runInNewContext(runtime, context);
  assert.equal(observerCount, 0);
  assert.equal(window.document.querySelector('#sht-aggregator'), null);
});

test('incremental link index only refreshes the changed post fixture', async () => {
  const { document, Element } = parseHTML(await fixture('thread.html'));
  const start = linkSource.indexOf('    const ED2K_REGEX');
  const end = linkSource.indexOf('    const collectAllED2K', start);
  const helpers = vm.runInNewContext(`(() => {${linkSource.slice(start, end)}; return { collectAllDownloadLinks, markDownloadLinkScopes };})()`, {
    document,
    Element,
    NodeFilter: { SHOW_TEXT: 4 },
    CFG: { ed2kFileNameReplaceEnabled: false },
    processEd2kLink: value => value,
    diagnosticLog: () => {},
    Set,
    WeakMap,
    WeakSet,
  });

  const initial = helpers.collectAllDownloadLinks();
  assert.equal(initial.ed2k.length, 1);
  assert.equal(initial.magnets.length, 3, 'two magnets plus one torrent attachment');

  const secondPost = document.querySelector('#postmessage_102');
  const added = document.createElement('p');
  added.textContent = '新增 magnet:?xt=urn:btih:CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC';
  secondPost.append(added);
  assert.equal(helpers.collectAllDownloadLinks().magnets.length, 3, 'cached post remains unchanged before invalidation');
  helpers.markDownloadLinkScopes([added]);
  assert.equal(helpers.collectAllDownloadLinks().magnets.length, 4, 'only the changed post is re-indexed');
});
