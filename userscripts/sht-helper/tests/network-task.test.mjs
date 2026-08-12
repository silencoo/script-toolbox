import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const source = await readFile(resolve(root, 'src/modules/05-infrastructure.js'), 'utf8');
const providerSource = await readFile(resolve(root, 'src/modules/15-cloud-providers.js'), 'utf8');

function requestHelpers(mock) {
  const start = source.indexOf('    const REQUEST_DEFAULT_TIMEOUT');
  const end = source.indexOf('    async function sha256Hex', start);
  return vm.runInNewContext(`(() => {${source.slice(start, end)}; return { shtRequest, ShtRequestError, redactDiagnosticValue };})()`, {
    URL,
    location: { href: 'https://sehuatang.org/forum.php', origin: 'https://sehuatang.org' },
    CFG: { debugMode: false },
    GM_xmlhttpRequest: mock,
    DOMException,
    Date,
    Map,
    Set,
    Promise,
    Error,
    Object,
    Array,
    Number,
    String,
    console,
    setTimeout,
    clearTimeout,
  });
}

test('unified request retries transient GET failures and redacts diagnostics', async () => {
  let attempts = 0;
  const helpers = requestHelpers(options => {
    attempts += 1;
    if (attempts === 1) options.onerror({ message: 'offline' });
    else options.onload({ status: 200, responseText: 'ok' });
    return { abort() {} };
  });
  const response = await helpers.shtRequest({ url: 'https://example.test/file', retryDelayMs: 1 });
  assert.equal(response.responseText, 'ok');
  assert.equal(attempts, 2);
  assert.equal(helpers.redactDiagnosticValue('Authorization: Bearer abc.def Cookie=secret'), 'Authorization=[REDACTED] Cookie=[REDACTED]');
});

test('unified request aborts an active GM request', async () => {
  let aborted = false;
  const helpers = requestHelpers(() => ({ abort() { aborted = true; } }));
  const controller = new AbortController();
  const pending = helpers.shtRequest({ url: 'https://example.test/slow', signal: controller.signal, retries: 0 });
  controller.abort();
  await assert.rejects(pending, error => error.name === 'AbortError');
  assert.equal(aborted, true);
});

test('cloud provider layer and task queue expose bounded, cancellable execution', async () => {
  assert.match(providerSource, /const CLOUD_PROVIDERS/);
  assert.match(providerSource, /pan115/);
  assert.match(providerSource, /pan123/);
  const start = source.indexOf('    class ShtTaskQueue');
  const end = source.indexOf('    const cloudTaskQueue', start);
  const ShtTaskQueue = vm.runInNewContext(`(() => {${source.slice(start, end)}; return ShtTaskQueue;})()`, {
    DOMException, Promise, Math, setTimeout, clearTimeout,
    waitWithSignal: ms => new Promise(resolve => setTimeout(resolve, ms))
  });
  const queue = new ShtTaskQueue(() => 2);
  let active = 0;
  let maximum = 0;
  const jobs = Array.from({ length: 5 }, (_, index) => queue.add(async () => {
    active += 1;
    maximum = Math.max(maximum, active);
    await new Promise(resolve => setTimeout(resolve, 5));
    active -= 1;
    return index;
  }));
  assert.deepEqual(await Promise.all(jobs), [0, 1, 2, 3, 4]);
  assert.equal(maximum, 2);

  const serialQueue = new ShtTaskQueue(() => 1);
  let releaseFirst;
  const first = serialQueue.add(() => new Promise(resolve => { releaseFirst = resolve; }));
  const pending = serialQueue.add(async () => 'should-not-run');
  serialQueue.cancelPending('test cancellation');
  await assert.rejects(pending, error => error.name === 'AbortError');
  releaseFirst('done');
  assert.equal(await first, 'done');
});
