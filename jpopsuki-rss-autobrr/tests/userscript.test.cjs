'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');

const userscriptPath = require.resolve(
  '../userscript/jpopsuki-batch-rss-manager.user.js'
);
const Core = require(userscriptPath);

function rssUrl(token = 'one') {
  return (
    'https://jpopsuki.eu/feeds.php' +
    `?feed=torrents_notify_1_${token}` +
    '&user=1&auth=private-auth&passkey=private-passkey' +
    '&authkey=private-authkey&name=Example+Artist+Album'
  );
}

async function subscription(label = 'Example Artist Album', token = 'one') {
  return (
    await Core.validateSubscriptions([{ label, url: rssUrl(token) }])
  )[0];
}

test('userscript metadata limits default page and network access', () => {
  const source = fs.readFileSync(userscriptPath, 'utf8');

  assert.match(
    source,
    /@match\s+https:\/\/jpopsuki\.eu\/user\.php\?action=notify\*/
  );
  assert.match(source, /@include\s+http:\/\/localhost:7474\/\*/);
  assert.match(source, /@connect\s+self/);
  assert.match(source, /@connect\s+localhost/);
  assert.doesNotMatch(source, /@connect\s+\*/);
  assert.match(source, /@sandbox\s+DOM/);
});

test('validates, normalizes, and deduplicates RSS subscriptions', async () => {
  const result = await Core.validateSubscriptions([
    { label: ' Example   Artist Album ', url: rssUrl() },
    { label: 'Example Artist Album', url: rssUrl() },
  ]);

  assert.equal(result.length, 1);
  assert.equal(result[0].label, 'Example Artist Album');
  assert.equal(result[0].artist, 'Example Artist');
  assert.equal(result[0].category, 'Album');
  assert.match(result[0].key, /^[a-f0-9]{24}$/);
  assert.match(result[0].url_fingerprint, /^[a-f0-9]{64}$/);
});

test('rejects conflicting labels and unsafe RSS URLs', async () => {
  await assert.rejects(
    Core.validateSubscriptions([
      { label: 'Example Artist Album', url: rssUrl('one') },
      { label: 'Example Artist Album', url: rssUrl('two') },
    ]),
    /different RSS URLs/
  );
  await assert.rejects(
    Core.validateSubscriptions([
      {
        label: 'Example Artist Album',
        url: rssUrl().replace('jpopsuki.eu', 'example.com'),
      },
    ]),
    /expected JPopSuki/
  );
  await assert.rejects(
    Core.validateSubscriptions([
      {
        label: 'Example Artist Album',
        url: rssUrl().replace('https:', 'http:'),
      },
    ]),
    /expected JPopSuki/
  );
});

test('redacts account and API credentials', () => {
  const input = JSON.stringify({
    api_token: 'api-secret',
    password: 'password-secret',
    url: rssUrl(),
  });
  const redacted = Core.redactText(input);

  for (const secret of [
    'api-secret',
    'password-secret',
    'private-auth',
    'private-passkey',
    'private-authkey',
    'torrents_notify_1_one',
  ]) {
    assert.equal(redacted.includes(secret), false);
  }
  assert.match(redacted, /<redacted>/);
});

test('validates localhost transport and POSIX or Windows save bases', async () => {
  const item = await subscription('Artist/Name TV-Music');

  assert.equal(
    Core.normalizeBaseUrl('http://localhost:7474/'),
    'http://localhost:7474'
  );
  assert.throws(
    () => Core.normalizeBaseUrl('http://autobrr.example.test'),
    /Plain HTTP/
  );
  assert.equal(
    Core.buildSavePath('/downloads/jpopsuki', item),
    '/downloads/jpopsuki/Artist_Name/TV-Music'
  );
  assert.equal(
    Core.buildSavePath('D:\\Downloads', item),
    'D:/Downloads/Artist_Name/TV-Music'
  );
  assert.equal(Core.normalizeSaveBase('D:\\'), 'D:/');
  assert.throws(() => Core.normalizeSaveBase('relative/path'), /absolute/);
});

test('managed state contains fingerprints and ids but never RSS URLs', async () => {
  const item = await subscription();
  const state = Core.emptyState();
  const { entry } = Core.stateEntryFor(state, item);
  entry.indexer_id = 11;
  entry.feed_id = 22;
  entry.filter_id = 33;
  entry.interval = 601;
  entry.complete = true;

  const validated = Core.validateManagedState(state);
  const serialized = JSON.stringify(validated);

  assert.equal(serialized.includes('feeds.php'), false);
  assert.equal(serialized.includes('private-auth'), false);
  assert.equal(entry.url_fingerprint, item.url_fingerprint);
  assert.throws(
    () =>
      Core.validateManagedState({
        schema_version: 1,
        items: { unsafe: { label: 'Example' } },
      }),
    /entry unsafe/
  );
  assert.throws(
    () =>
      Core.validateManagedState({
        schema_version: 1,
        items: {
          aaaaaaaaaaaaaaaaaaaaaaaa: { label: 'Example Artist' },
          bbbbbbbbbbbbbbbbbbbbbbbb: { label: 'example artist' },
        },
      }),
    /duplicate label/
  );
});

test('prime intervals remain stable across reruns', async () => {
  const first = await subscription('First Artist Album', 'first');
  const second = await subscription('Second Artist Album', 'second');
  const state = Core.emptyState();
  Core.stateEntryFor(state, first).entry.interval = 607;

  const allocated = Core.allocateIntervals([first, second], state, 600);

  assert.equal(allocated[first.key], 607);
  assert.equal(allocated[second.key], 601);
});

test('managed lookup refuses renamed ids and requires explicit adoption', () => {
  const entry = { label: 'Example Artist Album', indexer_id: 11 };

  assert.throws(
    () =>
      Core.findManagedEntity(
        [{ id: 11, name: 'Different Name' }],
        entry,
        'indexer_id',
        entry.label,
        false,
        'indexer'
      ),
    /now named/
  );
  assert.throws(
    () =>
      Core.findManagedEntity(
        [{ id: 12, name: entry.label }],
        {},
        'indexer_id',
        entry.label,
        false,
        'indexer'
      ),
    /Adopt existing/
  );
  assert.equal(
    Core.findManagedEntity(
      [{ id: 12, name: entry.label }],
      {},
      'indexer_id',
      entry.label,
      true,
      'indexer'
    ).id,
    12
  );
});

test('feed and filter reconciliation detects drift and preserves other actions', async () => {
  const item = await subscription();
  const feed = {
    id: 22,
    name: item.label,
    enabled: true,
    type: 'RSS',
    url: item.url,
    interval: 601,
    timeout: 60,
    indexer_id: 11,
    settings: { download_type: 'TORRENT' },
  };
  assert.equal(Core.feedNeedsUpdate(feed, item, 11, 601), false);
  assert.equal(Core.feedNeedsUpdate({ ...feed, interval: 607 }, item, 11, 601), true);

  const existingFilter = {
    id: 33,
    name: item.label,
    enabled: false,
    years: '2020-2030',
    indexers: [],
    actions: [
      { id: 90, name: 'notification', type: 'WEBHOOK', enabled: true },
    ],
  };
  const payload = Core.buildFilterUpdatePayload(
    existingFilter,
    item,
    11,
    7,
    '/downloads/jpopsuki/Example Artist/Album'
  );

  assert.equal(payload.years, '2020-2030');
  assert.equal(payload.actions[0].type, 'WEBHOOK');
  assert.equal(payload.actions[1].type, 'QBITTORRENT');
  assert.equal(payload.actions[1].client_id, 7);
  assert.equal(
    Core.filterNeedsUpdate(payload, 11, 7, payload.actions[1].save_path, item.label),
    false
  );
});

test('cleanup and bundle deletion only select ids authorized by managed state', async () => {
  const item = await subscription();
  const state = Core.emptyState();
  const { key, entry } = Core.stateEntryFor(state, item);
  Object.assign(entry, {
    indexer_id: 11,
    feed_id: 22,
    filter_id: 33,
    interval: 601,
  });

  const cleanup = Core.discoverCleanupCandidates(
    state,
    [
      { id: 22, name: item.label, enabled: false },
      { id: 222, name: 'Unmanaged', enabled: false },
    ],
    [
      { id: 33, name: item.label, indexers: [] },
      { id: 333, name: 'Unmanaged', indexers: [] },
    ]
  );
  assert.deepEqual(
    cleanup.candidates.map((candidate) => [candidate.kind, candidate.id]),
    [
      ['filter', 33],
      ['feed', 22],
    ]
  );

  const bundles = Core.discoverBundles(
    state,
    [
      { id: 11, name: item.label },
      { id: 111, name: 'Unmanaged' },
    ],
    [{ id: 22, name: item.label }],
    [{ id: 33, name: item.label }],
    [key]
  );
  assert.equal(bundles.bundles.length, 1);
  assert.deepEqual(
    [
      bundles.bundles[0].filterId,
      bundles.bundles[0].feedId,
      bundles.bundles[0].indexerId,
    ],
    [33, 22, 11]
  );
});

test('browser API client sends the token only in a header', async (context) => {
  let captured;
  global.GM_xmlhttpRequest = (details) => {
    captured = details;
    queueMicrotask(() =>
      details.onload({ status: 200, responseText: '[]' })
    );
  };
  context.after(() => {
    delete global.GM_xmlhttpRequest;
  });

  const client = new Core.AutobrrClient('http://localhost:7474', 'api-secret');
  const clients = await client.listDownloadClients();

  assert.deepEqual(clients, []);
  assert.equal(captured.method, 'GET');
  assert.equal(captured.url, 'http://localhost:7474/api/download_clients');
  assert.equal(captured.url.includes('api-secret'), false);
  assert.equal(captured.headers['X-API-Token'], 'api-secret');
  assert.equal(captured.anonymous, true);
  assert.equal(captured.timeout, 30000);
});

test('filter update falls back from PATCH to PUT only for compatibility errors', async (context) => {
  const methods = [];
  global.GM_xmlhttpRequest = (details) => {
    methods.push(details.method);
    queueMicrotask(() => {
      if (details.method === 'PATCH') {
        details.onload({ status: 405, responseText: 'method not allowed' });
      } else {
        details.onload({
          status: 200,
          responseText: JSON.stringify({ id: 33, name: 'Example' }),
        });
      }
    });
  };
  context.after(() => {
    delete global.GM_xmlhttpRequest;
  });

  const client = new Core.AutobrrClient('http://localhost:7474', 'api-secret');
  const updated = await client.updateFilter(33, { name: 'Example' });

  assert.deepEqual(methods, ['PATCH', 'PUT']);
  assert.equal(updated.id, 33);
});

test('mutation network failures are not automatically replayed', async (context) => {
  let requests = 0;
  global.GM_xmlhttpRequest = (details) => {
    requests += 1;
    queueMicrotask(() => details.onerror());
  };
  context.after(() => {
    delete global.GM_xmlhttpRequest;
  });

  const client = new Core.AutobrrClient('http://localhost:7474', 'api-secret');
  await assert.rejects(
    client.createFeed({ name: 'Example' }),
    /network request failed/
  );
  assert.equal(requests, 1);
});
