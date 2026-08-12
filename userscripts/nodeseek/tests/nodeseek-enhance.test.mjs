import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const scriptUrl = new URL('../nodeseek-enhance.user.js', import.meta.url);
const source = await readFile(scriptUrl, 'utf8');

let helpers;
const context = vm.createContext({
    URL,
    structuredClone,
    setTimeout,
    clearTimeout,
    process,
    __NSX_TEST_HOOK__: exported => {
        helpers = exported;
    }
});
vm.runInContext(source, context, { filename: 'nodeseek-enhance.user.js' });

test('测试钩子导出核心纯函数', () => {
    assert.ok(helpers);
    assert.equal(typeof helpers.mergeKnownConfig, 'function');
});

test('配置合并保留已知字段、补齐默认值并丢弃未知字段', () => {
    const defaults = {
        enabled: true,
        count: 3,
        nested: { label: 'default', visible: false },
        list: []
    };
    const merged = helpers.mergeKnownConfig({
        enabled: false,
        count: '8',
        nested: { label: 'custom', unknown: true },
        list: ['x'],
        unknown: 'drop-me'
    }, defaults);

    assert.deepEqual(structuredClone(merged), {
        enabled: false,
        count: 8,
        nested: { label: 'custom', visible: false },
        list: ['x']
    });
});

test('配置路径读写不会依赖重复存储读取', () => {
    const config = {};
    helpers.setPathValue(config, 'typography.title.enabled', true);
    assert.equal(helpers.getPathValue(config, 'typography.title.enabled'), true);
    assert.equal(helpers.getPathValue(config, 'missing.path'), undefined);
});

test('损坏的本地 JSON 会安全回退', () => {
    assert.deepEqual(structuredClone(helpers.safeJsonParse('{broken', [])), []);
    assert.deepEqual(structuredClone(helpers.safeJsonParse('[1,2]', [])), [1, 2]);
});

test('异步限流器限制并发数量', async () => {
    const limit = helpers.createAsyncLimiter(2);
    let active = 0;
    let peak = 0;
    const jobs = Array.from({ length: 6 }, (_, value) => limit(async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise(resolve => setTimeout(resolve, 2));
        active -= 1;
        return value;
    }));
    assert.deepEqual(await Promise.all(jobs), [0, 1, 2, 3, 4, 5]);
    assert.equal(peak, 2);
});

test('HTML 属性转义覆盖引号和尖括号', () => {
    assert.equal(
        helpers.escapeHtmlAttribute('" onfocus="alert(1)" <x>'),
        '&quot; onfocus=&quot;alert(1)&quot; &lt;x&gt;'
    );
});

test('关键词规则解析会校验正则并规范 flags', () => {
    const rules = helpers.parseRuleInput('VPS\n/(server)+/ggi\n/[invalid/\n/' + 'a'.repeat(201) + '/i');
    assert.deepEqual(structuredClone(rules), [
        { type: 'text', value: 'VPS' },
        { type: 'regex', value: '(server)+', flags: 'gi'.replace('g', '') }
    ]);
});

test('旧版字符串和旧字段中的关键词会迁移到当前数组结构', () => {
    assert.deepEqual(structuredClone(helpers.normalizeKeywordCollection('VPS\n/server/i')), [
        { type: 'text', value: 'VPS' },
        { type: 'regex', value: 'server', flags: 'i' }
    ]);
    const migrated = helpers.migrateLegacyKeywordSettings({
        block_post_keywords: '广告\n/^出/i',
        right_panel_keywords: ['测评']
    });
    assert.deepEqual(structuredClone(migrated.block_posts.keywords), [
        { type: 'text', value: '广告' },
        { type: 'regex', value: '^出', flags: 'i' }
    ]);
    assert.deepEqual(structuredClone(migrated.right_panel_highlight.keywords), ['测评']);
});

test('帖子 URL 统一到第一页并去掉查询参数', () => {
    assert.equal(
        helpers.normalizePostUrl('/post-123-9?foo=bar#comment', 'https://www.nodeseek.com/'),
        'https://www.nodeseek.com/post-123-1'
    );
    assert.equal(helpers.normalizePostUrl('/categories/1', 'https://www.nodeseek.com/'), null);
});

test('外链和图片 URL 只允许安全协议及受支持的数据图片', () => {
    assert.equal(helpers.normalizeHttpUrl('', 'https://www.nodeseek.com/'), null);
    assert.equal(helpers.normalizeHttpUrl('javascript:alert(1)', 'https://www.nodeseek.com/'), null);
    assert.equal(
        helpers.normalizeHttpUrl('/post-1-1', 'https://www.nodeseek.com/'),
        'https://www.nodeseek.com/post-1-1'
    );
    assert.equal(helpers.sanitizeImageUrl('data:image/svg+xml,<svg/>', 'https://www.nodeseek.com/'), null);
    assert.equal(
        helpers.sanitizeImageUrl('data:image/png;base64,AAAA', 'https://www.nodeseek.com/'),
        'data:image/png;base64,AAAA'
    );
});

test('CSS 配置拒绝声明注入并规范背景枚举', () => {
    assert.equal(helpers.sanitizeCssValue('color', 'red; display:none', 'fallback'), 'fallback');
    const config = helpers.normalizeBackgroundConfig({
        url: 'https://example.com/background.png',
        repeat: 'invalid',
        position: 'center',
        size: 'cover',
        attachment: 'invalid'
    }, 'https://www.nodeseek.com/');
    assert.deepEqual(structuredClone(config), {
        url: 'https://example.com/background.png',
        repeat: 'repeat',
        position: 'center',
        size: 'cover',
        attachment: 'scroll'
    });
});

test('脚本不再声明未使用的高权限 API，且作用域外无残留设置处理器', () => {
    assert.doesNotMatch(source, /^\/\/ @grant\s+GM_xmlhttpRequest$/m);
    assert.doesNotMatch(source, /^\/\/ @grant\s+GM_deleteValue$/m);
    assert.match(source.trimEnd(), /\}\)\(\);$/);
});

test('紧凑模式搜索框保持定位上下文，避免搜索图标跑到主题按钮上', () => {
    assert.match(source, /html\.nsx-compact-mode #nsk-head \.search-box\s*\{[\s\S]*?position: relative !important;/);
    assert.doesNotMatch(source, /html\.nsx-compact-mode #nsk-head \.search-box\s*\{\s*position: static !important;/);
});
