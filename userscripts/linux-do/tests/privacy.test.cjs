// Run: PLAYWRIGHT_MODULE=/path/to/playwright node --test tests/privacy.test.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test, before, after } = require('node:test');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const script = fs.readFileSync(path.join(__dirname, '../linuxdo-content-archiver.user.js'), 'utf8');
let browser;
before(async () => {
    browser = await chromium.launch({
        headless: true,
        ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : {}),
    });
});
after(async () => { await browser?.close(); });

async function fixture(t, url = 'https://linux.do/t/privacy-test/1', overrides = {}) {
    const context = await browser.newContext();
    t.after(() => context.close());
    // No requests reach real sites, including WordPress.
    await context.route('**/*', route => route.fulfill({ contentType: 'text/html', body: `
        <!doctype html><html><head><title>Privacy fixture</title></head><body>
        <h1>Fixture topic</h1><div class="post-stream"><div class="topic-post"><div class="cooked">Fixture text</div></div></div>
        </body></html>` }));
    const page = await context.newPage();
    await page.goto(url);
    await page.evaluate(overrides => {
        // GM mocks intentionally use only fake values in an isolated context.
        window.fixtureStore = {
            wp_url: 'https://blog.example.test', wp_user: 'fixture-user',
            wp_password: 'FAKE_PRIVATE_PASSWORD', wp_default_category: '', ...overrides,
        };
        window.fixtureRequests = [];
        window.fixtureTabs = [];
        window.fixtureMenus = [];
        window.GM_getValue = (key, fallback) => window.fixtureStore[key] ?? fallback;
        window.GM_setValue = (key, value) => { window.fixtureStore[key] = value; };
        window.GM_registerMenuCommand = (name, callback) => window.fixtureMenus.push({ name, callback });
        window.GM_openInTab = url => window.fixtureTabs.push(url);
        window.GM_xmlhttpRequest = details => {
            window.fixtureRequests.push({ url: details.url, headers: details.headers, redirect: details.redirect });
            details.onload({ status: 201, responseText: '{"id":1}' });
        };
        window.alert = () => {};
    }, overrides);
    await page.addScriptTag({ content: script });
    return page;
}

async function openForumSettings(page) {
    await page.getByRole('button', { name: '⚙️ Settings' }).click();
}

async function openAdminSettings(page) {
    await page.evaluate(() => window.fixtureMenus[0].callback());
}

test('forum settings never expose credentials or change the credential destination', async t => {
    const page = await fixture(t);
    await openForumSettings(page);
    assert.equal(await page.locator('input[type=password]').count(), 0);
    assert.equal(await page.locator('#ld-wp-user').count(), 0);
    assert.equal((await page.content()).includes('FAKE_PRIVATE_PASSWORD'), false);
    await page.locator('#ld-wp-url').fill('https://another.example.test');
    await page.locator('#ld-btn-save').click();
    const state = await page.evaluate(() => ({ store: fixtureStore, tabs: fixtureTabs, requests: fixtureRequests }));
    assert.equal(state.store.wp_url, 'https://blog.example.test');
    assert.equal(state.store.wp_password, 'FAKE_PRIVATE_PASSWORD');
    assert.deepEqual(state.tabs, ['https://another.example.test/wp-admin/']);
    assert.equal(state.requests.length, 0);
});

test('HTTP and credential-bearing settings URLs are rejected', async t => {
    const page = await fixture(t);
    await openForumSettings(page);
    for (const url of ['http://blog.example.test', 'https://user:pass@blog.example.test',
        'https://blog.example.test/?token=secret', 'https://blog.example.test/#secret']) {
        await page.locator('#ld-wp-url').fill(url);
        await page.locator('#ld-btn-save').click();
        assert.match(await page.locator('#ld-settings-error').innerText(), /HTTPS/);
    }
    assert.equal(await page.evaluate(() => fixtureTabs.length + fixtureRequests.length), 0);
});

test('admin keeps passwords blank, retains saved credentials and clears cancelled input', async t => {
    const page = await fixture(t, 'https://blog.example.test/wp-admin/');
    await openAdminSettings(page);
    assert.equal(await page.locator('#ld-wp-pass').inputValue(), '');
    assert.equal(await page.locator('#ld-wp-user').inputValue(), 'fixture-user');
    await page.locator('#ld-btn-save').click();
    assert.equal(await page.evaluate(() => fixtureStore.wp_password), 'FAKE_PRIVATE_PASSWORD');
    await openAdminSettings(page);
    await page.locator('#ld-wp-pass').fill('FAKE_UNSAVED');
    await page.locator('#ld-btn-cancel').click();
    await page.waitForFunction(() => document.getElementById('ld-wp-pass').value === '');
    await openAdminSettings(page);
    await page.locator('#ld-wp-pass').fill('FAKE_UNSAVED');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => document.getElementById('ld-wp-pass').value === '');
    assert.equal(await page.evaluate(() => fixtureStore.wp_password), 'FAKE_PRIVATE_PASSWORD');
});

test('another admin origin cannot inherit credentials and binds new ones to its own site', async t => {
    const page = await fixture(t, 'https://other.example.test/blog/wp-admin/');
    await openAdminSettings(page);
    assert.equal(await page.locator('#ld-wp-user').inputValue(), '');
    assert.equal(await page.locator('#ld-wp-pass').inputValue(), '');
    await page.locator('#ld-wp-user').fill('fixture-user');
    await page.locator('#ld-btn-save').click();
    assert.match(await page.locator('#ld-settings-error').innerText(), /应用密码/);
    assert.equal(await page.evaluate(() => fixtureStore.wp_url), 'https://blog.example.test');
    await page.locator('#ld-wp-pass').fill('NEW FAKE PASSWORD');
    await page.evaluate(() => { document.getElementById('ld-wp-url').value = 'https://attacker.example.test'; });
    await page.locator('#ld-btn-save').click();
    assert.equal(await page.evaluate(() => fixtureStore.wp_url), 'https://other.example.test/blog');
    assert.equal(await page.evaluate(() => fixtureStore.wp_password), 'NEWFAKEPASSWORD');
    await page.waitForFunction(() => document.getElementById('ld-wp-pass').value === '');
});

test('publishing targets configured HTTPS API with redirects disabled', async t => {
    const page = await fixture(t);
    await page.getByRole('button', { name: '🚀 Post to WordPress' }).click();
    await page.waitForFunction(() => fixtureRequests.length === 1);
    const [request] = await page.evaluate(() => fixtureRequests);
    assert.equal(request.url, 'https://blog.example.test/wp-json/wp/v2/posts');
    assert.equal(request.redirect, 'error');
    assert.equal(request.headers.Authorization,
        'Basic ' + Buffer.from('fixture-user:FAKE_PRIVATE_PASSWORD').toString('base64'));
});

test('forum scripts cannot trigger publishing with a synthetic click', async t => {
    const page = await fixture(t);
    const button = page.getByRole('button', { name: '🚀 Post to WordPress' });
    await button.waitFor();
    await button.evaluate(element => element.click());
    assert.equal(await page.evaluate(() => fixtureRequests.length), 0);
});

test('legacy HTTP configuration prompts for settings without sending credentials', async t => {
    const page = await fixture(t, undefined, { wp_url: 'http://blog.example.test' });
    await page.getByRole('button', { name: '🚀 Post to WordPress' }).click();
    assert.equal(await page.locator('dialog:modal').count(), 1);
    assert.equal(await page.evaluate(() => fixtureRequests.length), 0);
});

test('settings fit narrow/wide viewports and retain keyboard dismissal', async t => {
    for (const url of ['https://linux.do/t/privacy-test/1', 'https://blog.example.test/wp-admin/']) {
        const page = await fixture(t, url);
        for (const width of [390, 1280]) {
            await page.setViewportSize({ width, height: 844 });
            if (url.includes('linux.do')) await openForumSettings(page);
            else await openAdminSettings(page);
            const box = await page.locator('dialog').boundingBox();
            assert.ok(box.x >= 0 && box.x + box.width <= width);
            assert.equal(await page.locator('dialog').evaluate(element => element.scrollWidth <= element.clientWidth), true);
            if (process.env.SCREENSHOT_DIR) {
                await page.screenshot({ path: path.join(process.env.SCREENSHOT_DIR,
                    `${url.includes('linux.do') ? 'forum' : 'admin'}-${width}.png`) });
            }
            await page.keyboard.press('Escape');
            assert.equal(await page.locator('dialog:modal').count(), 0);
        }
    }
});
