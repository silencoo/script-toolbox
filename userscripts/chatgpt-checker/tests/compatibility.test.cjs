const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '../chatgpt-checker-next.user.js'), 'utf8');
function functionSource(name) {
    const start = source.search(new RegExp(`    (?:async )?function ${name}\\(`));
    assert.notEqual(start, -1, name);
    const end = start + source.slice(start).search(/\n    }\r?\n/) + '\n    }'.length;
    return source.slice(start, end);
}
function context(globals, names) {
    const ctx = vm.createContext({ URL, RegExp, console, Response, ...globals });
    for (const name of names) vm.runInContext(functionSource(name), ctx);
    return ctx;
}
const location = { href: 'https://chatgpt.com/', origin: 'https://chatgpt.com' };

test('display preferences default to white and migrate only known boolean visibility values', () => {
    const ctx = context({}, ['normalizeCheckerSettings']);
    vm.runInContext(source.match(/    const CHECKER_DISPLAY_ITEMS = \[[\s\S]*?\n    \];/)[0], ctx);
    const defaults = ctx.normalizeCheckerSettings(null);
    assert.equal(defaults.theme, 'light');
    assert.ok(Object.values(defaults.visible).every(value => value === true));
    const migrated = ctx.normalizeCheckerSettings({ theme: 'invalid', visible: { codex: false, daily: 'false', unknown: true } });
    assert.equal(migrated.theme, 'light');
    assert.equal(migrated.visible.codex, false);
    assert.equal(migrated.visible.daily, true);
    assert.equal(Object.hasOwn(migrated.visible, 'unknown'), false);
    assert.equal(ctx.normalizeCheckerSettings({ theme: 'system' }).theme, 'system');
});

test('subscription data respects workspace selection and distinguishes explicit false from absent fields', () => {
    const ctx = context({}, ['checkerDate', 'parseCheckerSubscription']);
    const accounts = { accounts: {
        a: { account: { account_id: 'a', plan_type: 'plus' }, entitlement: { subscription_plan: 'chatgptplus', has_active_subscription: false, expires_at: 'invalid' } },
        b: { account: { account_id: 'b', plan_type: 'team' }, entitlement: {} },
    } };
    assert.equal(ctx.parseCheckerSubscription(accounts, null).rows.length, 0);
    assert.equal(ctx.parseCheckerSubscription(accounts, 'missing').rows.length, 0);
    const rows = ctx.parseCheckerSubscription(accounts, 'a').rows;
    assert.ok(rows.some(([key, value]) => key === '付费订阅' && value === '未启用'));
    assert.ok(!rows.some(([key]) => key === '到期时间'));
    assert.ok(!ctx.parseCheckerSubscription(accounts, 'b').rows.some(([key]) => key === '付费订阅'));
    assert.equal(ctx.parseCheckerSubscription(null, null).rows.length, 0);
});

test('storage and daily parsers retain real zeros without inventing values for missing or malformed metrics', () => {
    const ctx = context({}, ['checkerNumber', 'parseCheckerStorage', 'parseCheckerDaily']);
    assert.equal(ctx.parseCheckerStorage({ allowed_bytes: 1024, remaining_bytes: 1024 }).used, 0);
    assert.equal(ctx.parseCheckerStorage({ allowed_bytes: 0 }).allowed, 0);
    assert.equal(ctx.parseCheckerStorage({ allowed_bytes: '1000', remaining_bytes: 20 }).used, null);
    assert.equal(ctx.parseCheckerStorage({ allowed_bytes: 10, remaining_bytes: 20 }).used, null);
    assert.equal(ctx.parseCheckerStorage(null).used, null);
    const result = ctx.parseCheckerDaily({ data: [{ date: '2026-09-05', totals: { credits: 0 } }, { date: '2026-09-04', totals: { turns: 4 } }] });
    assert.equal(result[0].credits, 0);
    assert.equal(result[0].turns, null);
    assert.equal(result[1].credits, null);
    assert.equal(ctx.parseCheckerDaily({}), null);
    assert.equal(ctx.parseCheckerDaily({ data: [{ date: '2026-09-05' }, { date: '2026-09-05' }] }), null);
});

function detailContext(overrides = {}) {
    return context({
        isGrokMode: false, Headers, URLSearchParams, AbortController, setTimeout, clearTimeout,
        pageWindow: { location }, checkerAccountId: null, checkerAccountEpoch: 0, checkerRequestSequence: 0,
        checkerFreshness: new Map(), checkerDetails: Object.fromEntries(['subscription', 'storage', 'daily', 'quota'].map(key => [key, { status: 'idle', value: null, sequence: 0 }])),
        renderCheckerDetails: () => {}, getCheckerAccessToken: () => 'synthetic-test-token',
        updateCodexInfo: () => {}, getCodexUsageWindows: () => [], updateCodexCredits: () => {}, updateCodexResetCredits: () => {},
        ...overrides,
        checkerSettings: { analytics: { usdPer1000: 40, historyDays: 30 }, ...(overrides.checkerSettings || { visible: { subscription: true, storage: false, daily: true } }) },
    }, ['checkerNumber', 'checkerDate', 'parseCheckerSubscription', 'parseCheckerStorage', 'parseCheckerDaily', 'parseCheckerQuotaUsage', 'checkerDetailEnabled', 'checkerRequestKind', 'captureCheckerRequest', 'observeCheckerResponse', 'refreshCheckerDetails']);
}

function estimateFixture() {
    const now = Date.parse('2026-09-05T12:00:00Z');
    return {
        now,
        quota: { status: 'ready', updated: now, value: { usedPercent: 25, startAt: Date.parse('2026-09-01T12:00:00Z'), resetAt: Date.parse('2026-09-08T12:00:00Z') } },
        daily: { status: 'ready', updated: now, range: { start: '2026-08-07', end: '2026-09-06' }, value: [
            { date: '2026-08-31', credits: 999 },
            { date: '2026-09-01', credits: 30 },
            { date: '2026-09-04', credits: 10 },
            { date: '2026-09-05', credits: 10 },
            { date: '2026-09-06', credits: 999 },
        ] },
    };
}

test('analytics configuration migrates old display settings, preserves zero rates, and validates numeric inputs', () => {
    const ctx = context({}, ['normalizeCheckerSettings', 'parseCheckerAnalyticsInputs']);
    vm.runInContext(source.match(/    const CHECKER_DISPLAY_ITEMS = \[[\s\S]*?\n    \];/)[0], ctx);
    const migrated = ctx.normalizeCheckerSettings({ theme: 'dark', visible: { daily: false } });
    assert.equal(migrated.theme, 'dark');
    assert.equal(migrated.visible.daily, false);
    assert.equal(migrated.analytics.usdPer1000, 40);
    assert.equal(migrated.analytics.historyDays, 30);
    assert.equal(ctx.normalizeCheckerSettings({ analytics: { usdPer1000: 0, historyDays: 1 } }).analytics.usdPer1000, 0);
    assert.equal(ctx.normalizeCheckerSettings({ analytics: { usdPer1000: Infinity, historyDays: 366 } }).analytics.historyDays, 30);
    assert.equal(ctx.parseCheckerAnalyticsInputs('20', '90').value.usdPer1000, 20);
    for (const [rate, days] of [['', '30'], ['-1', '30'], ['Infinity', '30'], ['40', '0'], ['40', '1.5'], ['40', '366']]) {
        assert.ok(ctx.parseCheckerAnalyticsInputs(rate, days).error, `${rate}/${days}`);
    }
});

test('cycle and outside-cycle history stay separate and a short history preference does not truncate cycle data', () => {
    const ctx = context({}, ['getCheckerUsagePeriods']);
    const { daily, quota, now } = estimateFixture();
    const periods = ctx.getCheckerUsagePeriods(daily, quota, 7, now);
    assert.deepEqual(Array.from(periods.cycle, row => row.date), ['2026-09-01', '2026-09-04', '2026-09-05']);
    assert.deepEqual(Array.from(periods.history, row => row.date), ['2026-08-31']);
    const short = ctx.getCheckerUsagePeriods(daily, quota, 1, now);
    assert.equal(short.recent.length, 1);
    assert.equal(short.cycle.length, 3);
    assert.equal(short.history.length, 0);
    quota.status = 'error';
    assert.equal(ctx.getCheckerUsagePeriods(daily, quota, 7, now).cycle, null);
    quota.status = 'ready'; quota.value.resetAt = now;
    assert.equal(ctx.getCheckerUsagePeriods(daily, quota, 7, now).cycle, null);
});

test('credit, turn and USD totals retain partial-data uncertainty and identify latest activity', () => {
    const ctx = context({}, ['checkerNumber', 'summarizeCheckerUsage']);
    const rows = [{ date: '2026-09-04', credits: 1.25, turns: 1 }, { date: '2026-09-05', credits: 2.5, turns: 2 }];
    const result = ctx.summarizeCheckerUsage(rows, 40);
    assert.equal(result.credits, 3.75);
    assert.equal(result.turns, 3);
    assert.equal(result.usd, 0.15);
    assert.equal(result.latestActivity, '2026-09-05');
    assert.equal(ctx.summarizeCheckerUsage(rows, 0).usd, 0);
    rows[1].credits = null;
    assert.equal(ctx.summarizeCheckerUsage(rows, 40).credits, null);
    assert.equal(ctx.summarizeCheckerUsage(rows, 40).usd, null);
    assert.equal(ctx.summarizeCheckerUsage([], 40).credits, null);
    assert.equal(ctx.summarizeCheckerUsage([{ date: '2026-09-05', credits: 0, turns: 0 }], 40).credits, 0);
});

test('daily-only analytics requests configurable history plus weekly scope, retaining eight UTC days for short histories', async () => {
    for (const historyDays of [1, 90]) {
        const calls = [];
        const ctx = detailContext({
            checkerSettings: { analytics: { usdPer1000: 40, historyDays }, visible: { daily: true, estimate: false } },
            originalFetch: async url => { calls.push(url); return new Response(JSON.stringify(url.includes('analytics') ? { data: [] } : {})); },
        });
        await ctx.refreshCheckerDetails(false);
        assert.equal(calls.length, 2);
        const query = new URL(calls.find(url => url.includes('analytics')), location.origin).searchParams;
        assert.equal((Date.parse(query.get('end_date')) - Date.parse(query.get('start_date'))) / 86400000, Math.max(historyDays, 8));
        assert.ok(calls.includes('/backend-api/wham/usage'));
    }
});

test('weekly estimation uses only the active cycle, exposes the partial first day, and calculates total and remaining', () => {
    const ctx = context({}, ['checkerNumber', 'evaluateCheckerQuotaEstimate']);
    const { quota, daily, now } = estimateFixture();
    const result = ctx.evaluateCheckerQuotaEstimate(quota, daily, now);
    assert.equal(result.kind, 'provisional');
    assert.equal(result.cycleCredits, 50);
    assert.equal(result.total, 200);
    assert.equal(result.remaining, 150);
    assert.equal(result.boundaryPartial, true);
    quota.value.usedPercent = 100;
    assert.equal(ctx.evaluateCheckerQuotaEstimate(quota, daily, now).remaining, 0);
    quota.value.startAt = Date.parse('2026-09-01T00:00:00Z');
    assert.equal(ctx.evaluateCheckerQuotaEstimate(quota, daily, now).boundaryPartial, false);
});

test('weekly parser never substitutes a five-hour or Spark limit and supports relative reset times', () => {
    const ctx = context({}, ['checkerNumber', 'parseCheckerQuotaUsage']);
    const short = { used_percent: 70, limit_window_seconds: 18000, reset_at: 1800000000 };
    const weekly = { used_percent: 25, limit_window_seconds: 604800, reset_after_seconds: 3600 };
    assert.equal(ctx.parseCheckerQuotaUsage({ rate_limit: { primary_window: short }, additional_rate_limits: [{ rate_limit: { secondary_window: weekly } }] }), null);
    const result = ctx.parseCheckerQuotaUsage({ rate_limit: { primary_window: short, secondary_window: weekly } }, 1000000);
    assert.equal(result.usedPercent, 25);
    assert.equal(result.resetAt, 4600000);
    assert.equal(result.startAt, 4600000 - 604800000);
    assert.equal(ctx.parseCheckerQuotaUsage({ rate_limit: { primary_window: { ...weekly, reset_at: 12345 } } }, 0).resetAt, 12345000);
});

test('weekly estimate withholds missing, zero, malformed, expired, partial-range and asynchronous inputs', () => {
    const ctx = context({}, ['checkerNumber', 'evaluateCheckerQuotaEstimate']);
    const changes = [
        ({ quota }) => { quota.value.usedPercent = 0; },
        ({ quota }) => { quota.value.usedPercent = 101; },
        ({ quota }) => { quota.value.usedPercent = null; },
        ({ quota }) => { quota.value.resetAt = null; },
        ({ quota, now }) => { quota.value.resetAt = now; },
        ({ quota, now }) => { quota.value.startAt = now + 1000; },
        ({ daily }) => { daily.value = daily.value.filter(row => row.date !== '2026-09-05'); },
        ({ daily }) => { daily.value.find(row => row.date === '2026-09-05').credits = 0; },
        ({ daily }) => { daily.value.find(row => row.date === '2026-09-05').credits = null; },
        ({ daily }) => { daily.value.find(row => row.date === '2026-09-04').credits = null; },
        ({ daily }) => { daily.range.start = '2026-09-02'; },
        ({ daily }) => { daily.range.end = '2026-09-05'; },
        ({ daily }) => { daily.range = null; },
        ({ daily }) => { daily.updated -= 61000; },
        ({ quota }) => { quota.status = 'loading'; },
        ({ daily }) => { daily.status = 'error'; daily.error = 'HTTP 403'; },
    ];
    for (const change of changes) {
        const fixture = estimateFixture();
        change(fixture);
        const result = ctx.evaluateCheckerQuotaEstimate(fixture.quota, fixture.daily, fixture.now);
        assert.equal(result.total, null, String(change));
        assert.equal(result.remaining, null);
        assert.ok(result.message);
    }
});

test('estimate-only display fetches one shared daily request plus weekly usage and stops when disabled', async () => {
    const calls = [];
    let quotaUpdates = 0;
    const ctx = detailContext({
        checkerSettings: { visible: { estimate: true, daily: false } },
        updateCodexInfo: () => { quotaUpdates++; },
        originalFetch: async url => {
            calls.push(url);
            return new Response(JSON.stringify(url.includes('analytics') ? { data: [] } : {}));
        },
    });
    await Promise.all([ctx.refreshCheckerDetails(false), ctx.refreshCheckerDetails(false)]);
    assert.equal(calls.length, 2);
    assert.equal(calls.filter(url => url.includes('analytics')).length, 1);
    assert.equal(calls.filter(url => url === '/backend-api/wham/usage').length, 1);
    assert.equal(quotaUpdates, 1);
    assert.ok(ctx.checkerDetails.daily.range.start);
    assert.ok(ctx.checkerDetails.daily.range.end);
    ctx.checkerSettings.visible.estimate = false;
    await ctx.refreshCheckerDetails(true);
    assert.equal(calls.length, 2);
});

test('detail capture accepts only same-origin data, honors Request header overrides, and clears stale workspace data', () => {
    const ctx = detailContext();
    assert.equal(ctx.captureCheckerRequest('https://other.invalid/backend-api/me'), null);
    assert.equal(ctx.captureCheckerRequest('/backend-api/conversation/private'), null);
    assert.equal(ctx.captureCheckerRequest('/backend-api/wham/analytics/daily-workspace-usage-counts?group_by=day&workspace_user=someone'), null);
    ctx.checkerDetails.storage.value = { used: 123 };
    ctx.checkerFreshness.set('storage', { updated: 1 });
    const request = ctx.captureCheckerRequest({ url: '/backend-api/files/library/storage/usage', headers: { 'ChatGPT-Account-Id': 'old' } }, { headers: { 'ChatGPT-Account-Id': 'new' } });
    assert.equal(request.kind, 'storage');
    assert.equal(ctx.checkerAccountId, 'new');
    assert.equal(ctx.checkerDetails.storage.value, null);
    assert.equal(ctx.checkerFreshness.size, 0);
});

test('detail observer ignores old requests, preserves original responses and labels retained results after failure', async () => {
    const ctx = detailContext();
    const response = new Response(JSON.stringify({ allowed_bytes: 100, remaining_bytes: 30 }));
    await ctx.observeCheckerResponse({ kind: 'storage', epoch: 0, sequence: 2 }, response);
    assert.equal(ctx.checkerDetails.storage.value.used, 70);
    assert.equal(response.bodyUsed, false);
    await ctx.observeCheckerResponse({ kind: 'storage', epoch: 0, sequence: 1 }, new Response('{}'));
    assert.equal(ctx.checkerDetails.storage.value.used, 70);
    await ctx.observeCheckerResponse({ kind: 'storage', epoch: 0, sequence: 3 }, new Response('{}', { status: 403 }));
    assert.equal(ctx.checkerDetails.storage.status, 'error');
    assert.equal(ctx.checkerDetails.storage.error, 'HTTP 403');
    assert.equal(ctx.checkerDetails.storage.value.used, 70);
    await ctx.observeCheckerResponse({ kind: 'storage', epoch: -1, sequence: 4 }, new Response('{}'));
    assert.equal(ctx.checkerDetails.storage.status, 'error');
});

test('detail refresh requests only enabled idle items, deduplicates loads, and allows explicit retry', async () => {
    const calls = [];
    const ctx = detailContext({ originalFetch: async (url, options) => {
        calls.push({ url, options });
        return new Response(JSON.stringify(url.includes('analytics') ? { data: [] } : { accounts: {} }));
    } });
    await Promise.all([ctx.refreshCheckerDetails(false), ctx.refreshCheckerDetails(false)]);
    assert.equal(calls.length, 3);
    assert.ok(calls.every(call => call.options.method === 'GET' && call.options.credentials === 'same-origin'));
    assert.ok(!calls.some(call => call.url.includes('/files/')));
    assert.ok(calls.some(call => call.url.includes('group_by=day')));
    await ctx.refreshCheckerDetails(false);
    assert.equal(calls.length, 3);
    await ctx.refreshCheckerDetails(true);
    assert.equal(calls.length, 6);
    ctx.getCheckerAccessToken = () => null;
    await ctx.refreshCheckerDetails(true);
    assert.equal(calls.length, 6);
    assert.match(ctx.checkerDetails.daily.error, /登录状态/);
});

test('discovers current modulepreload assets when bootstrap resource list is absent or malformed', () => {
    for (const bootstrap of [null, '{}', '{broken']) {
        const ctx = context({
            pageWindow: { location, performance: { getEntriesByType: () => [{ name: 'https://chatgpt.com/cdn/assets/conversation-small-current.js' }] } },
            document: {
                getElementById: () => bootstrap === null ? null : { textContent: bootstrap },
                querySelectorAll: () => [{ href: '/cdn/assets/4813494d-current.js' }, { src: '/cdn/assets/entry.client-current.js' }],
            },
        }, ['collectChatgptAssetUrls']);
        assert.deepEqual(Array.from(ctx.collectChatgptAssetUrls()), [
            'https://chatgpt.com/cdn/assets/4813494d-current.js',
            'https://chatgpt.com/cdn/assets/entry.client-current.js',
            'https://chatgpt.com/cdn/assets/conversation-small-current.js',
        ]);
    }
});

test('keeps legacy bootstrap support, deduplicates, and excludes unrelated or foreign assets', () => {
    const ctx = context({
        pageWindow: { location },
        document: {
            getElementById: () => ({ textContent: JSON.stringify({ pageLoadResourceHrefs: [
                '/cdn/assets/valid.js', '/cdn/assets/valid.js', null, {},
                'https://example.com/cdn/assets/evil.js', 'javascript:alert(1)',
                'https://user:pass@chatgpt.com/cdn/assets/credential.js', '/backend-api/private.js',
            ] }) }),
            querySelectorAll: () => [],
        },
    }, ['collectChatgptAssetUrls', 'isChatgptCachedAssetUrl']);
    assert.deepEqual(Array.from(ctx.collectChatgptAssetUrls()), ['https://chatgpt.com/cdn/assets/valid.js']);
    assert.equal(ctx.isChatgptCachedAssetUrl('https://example.com/cdn/assets/evil.js'), false);
    assert.equal(ctx.isChatgptCachedAssetUrl('https://chatgpt.com/cdn/assets/valid.js'), true);
});

function ageContext() {
    const elements = {};
    const ctx = context({
        isChatgptMode: true,
        chatgptAgeVerificationSettingFetched: false,
        chatgptAgeVerificationSettingDisplayValue: null,
        chatgptAgeVerificationSettingWasModified: false,
        chatgptAgeVerificationSettingError: null,
        chatgptAgeVerificationSettingEnabled: false,
        document: { getElementById: id => elements[id] || null },
    }, ['updateChatgptAgeVerificationSettingStatus', 'recreateResponseText']);
    function mount() {
        for (const id of ['status', 'toggle', 'tooltip-box']) elements[`chatgpt-age-verification-${id}`] = { style: {} };
        ctx.updateChatgptAgeVerificationSettingStatus();
        return elements;
    }
    return { ctx, mount, elements };
}

test('retains responses received before the panel mounts and distinguishes missing from false', () => {
    for (const [value, expected] of [[false, '服务端隐藏'], [true, '服务端显示'], [undefined, '未提供此字段'], [null, '未提供此字段'], ['false', '未提供此字段']]) {
        const { ctx, mount } = ageContext();
        ctx.updateChatgptAgeVerificationSettingStatus(value);
        const elements = mount();
        assert.equal(elements['chatgpt-age-verification-status'].textContent, expected);
        assert.equal(elements['chatgpt-age-verification-toggle'].disabled, typeof value !== 'boolean');
    }
});

test('labels local display changes separately from server state and exposes errors', () => {
    const { ctx, mount } = ageContext();
    const elements = mount();
    assert.equal(elements['chatgpt-age-verification-status'].textContent, '未读取');
    ctx.updateChatgptAgeVerificationSettingStatus(false, true);
    assert.equal(elements['chatgpt-age-verification-status'].textContent, '本地显示');
    assert.equal(ctx.chatgptAgeVerificationSettingDisplayValue, false);
    ctx.updateChatgptAgeVerificationSettingStatus(undefined, false, 'HTTP 404');
    assert.equal(elements['chatgpt-age-verification-status'].textContent, '读取失败');
    assert.match(elements['chatgpt-age-verification-tooltip-box'].textContent, /HTTP 404/);
});

test('fetch hook preserves missing age fields and only overrides an explicit false when enabled', async () => {
    const hook = source.slice(source.indexOf('    const originalFetch ='), source.lastIndexOf('\n    if (isChatgptMode && isChatgptImportPatchEnabled())'));
    for (const [body, enabled, expected] of [
        [{}, true, {}], [null, true, null],
        [{ show_age_verification_setting: 'false' }, true, { show_age_verification_setting: 'false' }],
        [{ show_age_verification_setting: false }, false, { show_age_verification_setting: false }],
        [{ show_age_verification_setting: false, is_adult: false }, true, { show_age_verification_setting: true, is_adult: false }],
    ]) {
        const { ctx } = ageContext();
        ctx.chatgptAgeVerificationSettingEnabled = enabled;
        const original = new Response(JSON.stringify(body));
        ctx.pageWindow = { Response, fetch: async () => original };
        ctx.captureCheckerRequest = () => null;
        ctx.observeCheckerResponse = async () => {};
        vm.runInContext(hook, ctx);
        const result = await ctx.pageWindow.fetch('/backend-api/settings/is_adult');
        assert.deepEqual(await result.json(), expected);
        if (body?.show_age_verification_setting !== false || !enabled) assert.equal(result, original);
    }
});

test('a cached patch waits for an early nonce and disconnects its observer after installation', () => {
    let callback;
    let disconnected = false;
    let ready = false;
    let installs = 0;
    const listeners = new Map();
    const ctx = context({
        chatgptImportMapObserver: undefined,
        chatgptImportMapInserted: false,
        isChatgptImportPatchEnabled: () => true,
        installCachedChatgptImportMapPatch: () => { installs++; },
        updateChatgptInjectionStatus: () => {},
        MutationObserver: class { constructor(fn) { callback = fn; } observe() {} disconnect() { disconnected = true; } },
        document: {
            readyState: 'loading', head: {}, querySelector: () => ready ? {} : null,
            addEventListener: (name, fn) => listeners.set(name, fn),
            removeEventListener: name => listeners.delete(name),
        },
    }, ['waitForChatgptImportMapTarget']);
    ctx.waitForChatgptImportMapTarget();
    callback();
    assert.equal(installs, 0);
    ready = true;
    callback();
    assert.equal(installs, 1);
    assert.equal(disconnected, true);
    assert.equal(listeners.size, 0);
});

test('nonce observer stops at DOMContentLoaded instead of waiting forever', () => {
    let finish;
    let disconnected = false;
    const ctx = context({
        chatgptImportMapObserver: undefined, chatgptImportMapInserted: false,
        isChatgptImportPatchEnabled: () => true, updateChatgptInjectionStatus: () => {},
        MutationObserver: class { observe() {} disconnect() { disconnected = true; } },
        document: { readyState: 'loading', addEventListener: (_name, fn) => { finish = fn; }, removeEventListener() {} },
    }, ['waitForChatgptImportMapTarget']);
    ctx.waitForChatgptImportMapTarget();
    finish();
    assert.equal(disconnected, true);
    assert.match(ctx.chatgptImportPatchFailure, /未及时提供/);
});

// Optional integration check against the exact public assets captured from a
// real page. Keep those multi-megabyte vendor bundles outside the repository.
test('current ChatGPT shared and conversation modules still match the upstream transforms', {
    skip: !process.env.CHECKER_ASSET_DIR,
}, () => {
    const ctx = context({}, ['extractChatgptFakePlanCatalog', 'patchChatgptRuntimeModelAssetSource', 'patchChatgptRuntimeModelConversationAssetSource', 'resolveChatgptNativeExports']);
    const dir = process.env.CHECKER_ASSET_DIR;
    const read = prefix => fs.readFileSync(path.join(dir, fs.readdirSync(dir).find(name => name.startsWith(prefix))), 'utf8');
    const shared = read('4813494d-');
    const conversation = read('conversation-small-');
    assert.ok(ctx.extractChatgptFakePlanCatalog(shared)?.options.length);
    assert.match(ctx.patchChatgptRuntimeModelAssetSource(shared), /__checkerNextRuntimeModelBridge=/);
    assert.match(ctx.patchChatgptRuntimeModelConversationAssetSource(conversation), /__checkerNextImportMapInstalled=!0/);
    assert.equal(Object.keys(ctx.resolveChatgptNativeExports(shared, ctx.patchChatgptRuntimeModelAssetSource(shared, true))).length, 7);
    assert.equal(Object.keys(ctx.resolveChatgptNativeExports(conversation, ctx.patchChatgptRuntimeModelConversationAssetSource(conversation, true))).length, 3);
});

test('native export mapping fails closed when a required symbol is missing', () => {
    const ctx = context({}, ['resolveChatgptNativeExports']);
    assert.equal(ctx.resolveChatgptNativeExports('export{a as x}', { getModel: 'missing' }), null);
    assert.equal(ctx.resolveChatgptNativeExports('export{a as x} export{b as y}', { getModel: 'a' }), null);
    assert.equal(ctx.resolveChatgptNativeExports('export{a as x}', { getModel: 'a' }).getModel, 'x');
});

test('native conversation discovery reads only active composer ancestry and context', () => {
    const conversation = { id: 'current', serverId$: () => null };
    const composer = { '__reactFiber$test': { memoizedProps: {}, return: {
        dependencies: { firstContext: { memoizedValue: { conversation } } },
    } } };
    const ctx = context({ document: { getElementById: id => id === 'prompt-textarea' ? composer : null } }, ['findChatgptNativeConversation']);
    assert.equal(ctx.findChatgptNativeConversation(), conversation);
    composer.__reactFiber$test.return = { memoizedProps: { conversation: { id: 'unrelated' } } };
    assert.equal(ctx.findChatgptNativeConversation(), null);
});

test('native bridge reports real state, calls native setters, respects disable, and disposes listeners', async () => {
    const conversation = { id: 'active', model: 'model-a', effort: 'high', origin: 'chat' };
    const pageWindow = new EventTarget();
    pageWindow.CustomEvent = CustomEvent;
    const states = [];
    pageWindow.addEventListener('state', event => states.push(event.detail));
    const shared = {
        switchSurface: ({ nextMode }) => { conversation.origin = nextMode; },
        surfaceMode: { Chat: 'chat', TPP: 'work' },
        getOrigin: value => value.origin,
        originEnum: { TPP: 'work' },
        getThread: () => ({}),
        threadSelectors: { getConversationTurns: () => [{ messages: [] }] },
        getMessageText: () => 'body',
    };
    const models = {
        getModel: value => ({ id: value.model, configurableThinkingEffort: true }),
        setModel: (value, model) => { value.model = model; },
        thinkingStore: value => ({
            conversationThinkingEffort$: () => value.effort,
            setThinkingEffort: effort => { value.effort = effort; },
        }),
    };
    const exports = object => Object.fromEntries(Object.keys(object).map(key => [key, key]));
    let enabled = true;
    const ctx = context({
        pageWindow, CustomEvent, setTimeout, clearTimeout,
        document: new EventTarget(), chatgptNativeBridge: undefined,
        patchChatgptRuntimeModelAssetSource: () => exports(shared),
        patchChatgptRuntimeModelConversationAssetSource: () => exports(models),
        findChatgptNativeConversation: () => conversation,
        isChatgptImportPatchEnabled: () => enabled,
        loadModule: async index => [shared, models][index],
        updateChatgptInjectionStatus: () => {},
        CHATGPT_RUNTIME_MODEL_STATE_EVENT: 'state',
        CHATGPT_RUNTIME_MODEL_REQUEST_EVENT: 'request',
        CHATGPT_RUNTIME_MODEL_SET_EVENT: 'set',
    }, ['resolveChatgptNativeExports']);
    // Replace only the ESM I/O boundary with in-memory exports.
    vm.runInContext(functionSource('connectChatgptNativeModules').replace('import(target.assetUrl)', 'loadModule(target.assetUrl)'), ctx);
    const sourceFor = object => `export{${Object.keys(object).join(',')}}`;
    await ctx.connectChatgptNativeModules([{ assetUrl: 0 }, { assetUrl: 1 }], [sourceFor(shared), sourceFor(models)]);
    assert.equal(states.at(-1).model, 'model-a');
    assert.equal(states.at(-1).thinkingEffort, 'high');
    pageWindow.dispatchEvent(new CustomEvent('set', { detail: { model: 'model-b', thinkingEffort: 'low', origin: 'work' } }));
    assert.equal(states.at(-1).model, 'model-b');
    assert.equal(states.at(-1).thinkingEffort, 'low');
    assert.equal(states.at(-1).origin, 'work');
    assert.equal(ctx.chatgptNativeBridge.getTurns().length, 1);
    enabled = false;
    pageWindow.dispatchEvent(new CustomEvent('set', { detail: { model: 'ignored' } }));
    assert.equal(conversation.model, 'model-b');
    ctx.chatgptNativeBridge.dispose();
    enabled = true;
    pageWindow.dispatchEvent(new CustomEvent('set', { detail: { model: 'disposed' } }));
    assert.equal(conversation.model, 'model-b');
});
