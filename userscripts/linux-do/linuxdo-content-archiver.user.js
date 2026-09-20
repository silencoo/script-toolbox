// ==UserScript==
// @name         Linux.do Content Archiver & WordPress Poster
// @namespace    http://tampermonkey.net/
// @version      1.7
// @description  Embeds a toolbar at the top of linux.do posts to save content locally or publish to WordPress directly. Supports image uploading, category auto-creation, and status selection.
// @author       You
// @match        https://linux.do/t/*
// @match        https://*/wp-admin/*
// @match        https://*/*/wp-admin/*
// @noframes
// @sandbox      DOM
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_xmlhttpRequest
// @grant        GM_registerMenuCommand
// @grant        GM_openInTab
// @connect      *
// ==/UserScript==

(function () {
    'use strict';

    // Configuration Keys
    const KEY_WP_URL = 'wp_url';
    const KEY_WP_USER = 'wp_user';
    const KEY_WP_PASS = 'wp_password';
    const KEY_DEF_CAT = 'wp_default_category';
    const KEY_DEF_STAT = 'wp_default_status';

    function normalizeWpUrl(value) {
        const url = new URL(value);
        if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
            throw new Error('WordPress 地址必须使用 HTTPS，且不能包含账号、查询参数或片段。');
        }
        return url.href.replace(/\/+$/, '');
    }

    // Credential controls exist only on the WordPress site's own HTTPS admin origin.
    // Never use an editable forum-page field as the destination for saved credentials.
    const adminPath = window.location.pathname.match(/^(.*?)\/wp-admin(?:\/|$)/);
    const adminBase = window.location.protocol === 'https:' &&
        window.location.hostname !== 'linux.do' && adminPath
        ? normalizeWpUrl(window.location.origin + adminPath[1]) : '';
    let settingsDialog;
    let settingsFocus;

    // Styles
    const style = document.createElement('style');
    style.innerHTML = `
        #ld-archiver-toolbar {
            background: #f0f0f0; padding: 10px; margin-bottom: 15px; border-radius: 5px;
            display: flex; gap: 10px; align-items: center; font-family: Arial, sans-serif;
            border: 1px solid #ddd;
        }
        .dark-citation #ld-archiver-toolbar { background: #333; border-color: #444; color: #fff; }
        #ld-archiver-toolbar button {
            cursor: pointer; padding: 5px 10px; border: 1px solid #ccc;
            background: #fff; border-radius: 3px; font-size: 14px;
        }
        #ld-archiver-toolbar button:hover { background: #e0e0e0; }
        #ld-archiver-status { margin-left: auto; font-size: 12px; color: #666; }

        #ld-settings-modal {
            padding: 0; border: none; border-radius: 8px;
            max-width: min(440px, calc(100vw - 32px)); max-height: calc(100vh - 32px);
        }
        #ld-settings-modal::backdrop { background-color: rgba(0,0,0,0.4); }
        #ld-settings-content {
            background-color: #fefefe; padding: 20px;
            box-sizing: border-box; width: 100%; border-radius: 8px;
            font-family: Arial, sans-serif; box-shadow: 0 4px 6px rgba(0,0,0,0.1);
        }
        .dark-citation #ld-settings-content { background-color: #222; color: #eee; border-color: #444; }
        .ld-form-group { margin-bottom: 15px; }
        .ld-form-group label { display: block; margin-bottom: 5px; font-weight: bold; font-size: 13px; }
        .ld-form-group input, .ld-form-group select { width: 100%; padding: 8px; box-sizing: border-box; border: 1px solid #ccc; border-radius: 4px; }
        #ld-settings-error { color: #b42318; overflow-wrap: anywhere; }
        .dark-citation .ld-form-group input, .dark-citation .ld-form-group select { background-color: #333; color: #fff; border-color: #555; }
        .ld-modal-footer { text-align: right; margin-top: 20px; }
        .ld-modal-footer button { padding: 8px 15px; margin-left: 10px; cursor: pointer; border: none; border-radius: 4px; }
    `;
    document.head.appendChild(style);

    function init() {
        const topicBody = document.querySelector('.post-stream .topic-post:first-child .cooked');
        if (!topicBody || document.getElementById('ld-archiver-toolbar')) return;

        const container = document.createElement('div');
        container.id = 'ld-archiver-toolbar';

        const btnSave = document.createElement('button'); btnSave.textContent = '📥 Save HTML'; btnSave.onclick = saveToLocal;
        const btnWP = document.createElement('button'); btnWP.textContent = '🚀 Post to WordPress';
        btnWP.onclick = async event => {
            if (!event.isTrusted || btnWP.disabled) return;
            btnWP.disabled = true;
            try { await postToWordPress(true); }
            finally { btnWP.disabled = false; }
        };
        const btnSettings = document.createElement('button'); btnSettings.textContent = '⚙️ Settings'; btnSettings.onclick = openSettings;

        // Status Selection
        const statusSelect = document.createElement('select');
        statusSelect.id = 'ld-post-status';
        statusSelect.innerHTML = `<option value="draft">Draft (草稿)</option><option value="publish">Publish (发布)</option>`;
        statusSelect.value = GM_getValue(KEY_DEF_STAT, 'draft');

        // Category Input
        const catInput = document.createElement('input');
        catInput.id = 'ld-post-category';
        catInput.type = 'text';
        catInput.placeholder = 'Category (分类)';
        catInput.style.cssText = 'width:80px; padding:4px 8px; border-radius:3px; border:1px solid #ccc; font-size:12px;';
        catInput.value = GM_getValue(KEY_DEF_CAT, 'archive');

        const statusLabel = document.createElement('span');
        statusLabel.id = 'ld-archiver-status';

        container.appendChild(btnSave);
        container.appendChild(btnWP);
        container.appendChild(new Text(' '));
        container.appendChild(statusSelect);
        container.appendChild(new Text(' '));
        container.appendChild(catInput);
        container.appendChild(new Text(' '));
        container.appendChild(btnSettings);
        container.appendChild(statusLabel);

        topicBody.parentElement.insertBefore(container, topicBody);
        createSettingsModal();
    }

    function createSettingsModal() {
        if (document.getElementById('ld-settings-modal')) return;
        const modal = document.createElement('dialog');
        modal.id = 'ld-settings-modal';
        modal.setAttribute('aria-labelledby', 'ld-settings-title');
        modal.innerHTML = `
            <div id="ld-settings-content">
                <h2 id="ld-settings-title">WP Settings (v1.7)</h2>
                <p>${adminBase ? '凭证只在本站后台设置；密码留空可保留同一站点、同一账号的已存密码。' :
                    '请前往自己的 WordPress 后台，从用户脚本菜单选择“配置本站 WordPress 发布”。不要在论坛页面输入密码。'}</p>
                <div class="ld-form-group"><label for="ld-wp-url">WP Site URL</label><input type="url" id="ld-wp-url" placeholder="https://mysite.com" ${adminBase ? 'readonly' : ''}></div>
                ${adminBase ? `<div class="ld-form-group"><label for="ld-wp-user">Username</label><input type="text" id="ld-wp-user" autocomplete="off"></div>
                <div class="ld-form-group"><label for="ld-wp-pass">Application Password</label><input type="password" id="ld-wp-pass" autocomplete="new-password" placeholder="留空保留已存密码"></div>` : ''}
                <div class="ld-form-group"><label for="ld-wp-def-cat">Default Category</label><input type="text" id="ld-wp-def-cat"></div>
                <div class="ld-form-group"><label>Default Status</label>
                    <select id="ld-wp-def-stat" aria-label="Default Status">
                        <option value="draft">Draft</option>
                        <option value="publish">Publish</option>
                    </select>
                </div>
                <p id="ld-settings-error" role="alert"></p>
                <div class="ld-modal-footer">
                    <button id="ld-btn-cancel" style="background:#ccc;">Cancel</button>
                    <button id="ld-btn-save" style="background:#007bff;color:white;">${adminBase ? 'Save' : '保存偏好并前往 WP 后台'}</button>
                </div>
            </div>
        `;
        document.body.appendChild(modal);
        settingsDialog = modal;
        modal.addEventListener('close', () => {
            const password = document.getElementById('ld-wp-pass');
            if (password) password.value = '';
            settingsFocus?.focus();
        });
        document.getElementById('ld-btn-cancel').onclick = () => modal.close();
        document.getElementById('ld-btn-save').onclick = saveSettings;
    }

    function openSettings() {
        createSettingsModal();
        settingsFocus = document.activeElement;
        document.getElementById('ld-wp-url').value = adminBase || GM_getValue(KEY_WP_URL, '');
        if (adminBase) {
            document.getElementById('ld-wp-user').value = GM_getValue(KEY_WP_URL, '') === adminBase
                ? GM_getValue(KEY_WP_USER, '') : '';
            document.getElementById('ld-wp-pass').value = '';
        }
        document.getElementById('ld-wp-def-cat').value = GM_getValue(KEY_DEF_CAT, 'archive');
        document.getElementById('ld-wp-def-stat').value = GM_getValue(KEY_DEF_STAT, 'draft');
        document.getElementById('ld-settings-error').textContent = '';
        settingsDialog.showModal();
    }

    function saveSettings() {
        try {
            const destination = normalizeWpUrl(adminBase || document.getElementById('ld-wp-url').value.trim());
            if (adminBase) {
                const user = document.getElementById('ld-wp-user').value.trim();
                let password = document.getElementById('ld-wp-pass').value.replace(/\s/g, '');
                if (!password && GM_getValue(KEY_WP_URL, '') === adminBase && GM_getValue(KEY_WP_USER, '') === user) {
                    password = GM_getValue(KEY_WP_PASS, '');
                }
                if (!user || !password) throw new Error('请填写本站账号和应用密码。');
                GM_setValue(KEY_WP_URL, adminBase);
                GM_setValue(KEY_WP_USER, user);
                GM_setValue(KEY_WP_PASS, password);
            }
            GM_setValue(KEY_DEF_CAT, document.getElementById('ld-wp-def-cat').value.trim());
            GM_setValue(KEY_DEF_STAT, document.getElementById('ld-wp-def-stat').value);
            if (!adminBase) GM_openInTab(destination + '/wp-admin/', { active: true, insert: true });
            settingsDialog.close();
        } catch (error) {
            document.getElementById('ld-settings-error').textContent = error.message;
        }
    }

    function gmRequest(details) {
        return new Promise((resolve, reject) => {
            if (details.headers?.Authorization) {
                const base = normalizeWpUrl(GM_getValue(KEY_WP_URL, ''));
                const target = new URL(details.url);
                if (!target.href.startsWith(base + '/wp-json/') || target.protocol !== 'https:' || target.username || target.password) {
                    return reject(new Error('拒绝向未配置的 WordPress API 发送凭证。'));
                }
                // Tampermonkey 5.0+: do not forward credentials through redirects.
                details.redirect = 'error';
            }
            details.onload = res => resolve(res);
            // Do not retain/log the privileged request object (it can contain headers).
            details.onerror = () => reject(new Error('Network request failed'));
            GM_xmlhttpRequest(details);
        });
    }

    function getErrorMessage(response) {
        let msg = response.statusText || 'Unknown Error';
        try {
            const json = JSON.parse(response.responseText);
            if (json.message) {
                const tempDiv = document.createElement('div');
                tempDiv.innerHTML = json.message;
                msg = tempDiv.textContent || tempDiv.innerText || msg;
            }
        } catch (e) { }
        return msg;
    }

    async function getOrCreateCategory(name, wpApiBase, authHeader) {
        if (!name) return null;
        try {
            // 1. Search existing
            const searchRes = await gmRequest({
                method: "GET",
                url: `${wpApiBase}/wp/v2/categories?search=${encodeURIComponent(name)}`,
                headers: { "Authorization": authHeader },
                anonymous: true
            });
            const categories = JSON.parse(searchRes.responseText);
            const exactMatch = categories.find(c => c.name.toLowerCase() === name.toLowerCase());
            if (exactMatch) return exactMatch.id;

            // 2. Create new if missing
            const createRes = await gmRequest({
                method: "POST",
                url: `${wpApiBase}/wp/v2/categories`,
                headers: { "Authorization": authHeader, "Content-Type": "application/json" },
                data: JSON.stringify({ name: name }),
                anonymous: true
            });
            if (createRes.status === 201) {
                return JSON.parse(createRes.responseText).id;
            }
        } catch (e) { console.error('Category error', e); }
        return null;
    }

    async function uploadImage(imgUrl, wpApiBase, authHeader) {
        try {
            const fetchRes = await gmRequest({ method: "GET", url: imgUrl, responseType: 'blob' });
            if (fetchRes.status !== 200) return null;
            const blob = fetchRes.response;
            const filename = `ld_img_${Date.now()}.png`;

            const uploadRes = await gmRequest({
                method: "POST",
                url: `${wpApiBase}/wp/v2/media`,
                headers: {
                    "Authorization": authHeader,
                    "Content-Disposition": `attachment; filename="${filename}"`,
                    "Content-Type": blob.type || "image/png",
                    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Requests",
                    "Referer": ""
                },
                data: blob,
                anonymous: true
            });

            if (uploadRes.status === 201) {
                return JSON.parse(uploadRes.responseText).source_url;
            } else {
                console.error(`Media Upload Error [${uploadRes.status}]: ${getErrorMessage(uploadRes)}`);
                return null;
            }
        } catch (e) { return null; }
    }

    async function postToWordPress(uploadImages = true) {
        let wpUrl;
        try { wpUrl = normalizeWpUrl(GM_getValue(KEY_WP_URL, '')); }
        catch { return openSettings(); }
        const wpUser = GM_getValue(KEY_WP_USER);
        const wpPass = GM_getValue(KEY_WP_PASS);
        if (!wpUrl || !wpUser || !wpPass) return openSettings();

        const statusEl = document.getElementById('ld-archiver-status');
        const postStatus = document.getElementById('ld-post-status').value;
        const postCategoryName = document.getElementById('ld-post-category').value.trim();

        statusEl.textContent = 'Preparing...';
        const authHeader = `Basic ${btoa(`${wpUser}:${wpPass}`)}`;
        let wpApiBase = wpUrl.replace(/\/$/, '') + '/wp-json';

        // Get Category ID
        let categoryId = null;
        if (postCategoryName) {
            statusEl.textContent = 'Checking category...';
            categoryId = await getOrCreateCategory(postCategoryName, wpApiBase, authHeader);
        }

        // Get and Clone Content
        const title = (document.querySelector('.fancy-title') || document.querySelector('h1'))?.innerText.trim() || 'Untitled';
        const contentDiv = document.querySelector('.post-stream .topic-post:first-child .cooked');
        const clone = contentDiv.cloneNode(true);

        if (uploadImages) {
            const imgs = clone.querySelectorAll('img');
            for (let i = 0; i < imgs.length; i++) {
                if (imgs[i].src.includes('/images/emoji/')) continue;
                statusEl.textContent = `Uploading image ${i + 1}/${imgs.length}...`;
                const newUrl = await uploadImage(imgs[i].src, wpApiBase, authHeader);
                if (newUrl) {
                    imgs[i].src = newUrl;
                    const parent = imgs[i].closest('a.lightbox');
                    if (parent) parent.href = newUrl;
                    imgs[i].removeAttribute('srcset');
                }
            }
        }

        statusEl.textContent = 'Publishing Post...';
        const finalHtml = clone.innerHTML + `<hr><p>Source: <a href="${window.location.href}">${document.title}</a></p>`;

        const postPayload = {
            title,
            content: finalHtml,
            status: postStatus
        };
        if (categoryId) {
            postPayload.categories = [categoryId];
        }

        try {
            const response = await gmRequest({
                method: "POST",
                url: `${wpApiBase}/wp/v2/posts`,
                headers: {
                    "Authorization": authHeader,
                    "Content-Type": "application/json",
                    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Requests",
                    "Referer": ""
                },
                data: JSON.stringify(postPayload),
                anonymous: true
            });

            if (response.status === 201) {
                statusEl.textContent = '✅ Success!';
                alert(`Success! Post ${postStatus === 'publish' ? 'published' : 'saved as draft'}.`);
            } else {
                statusEl.textContent = `❌ Error: ${response.status}`;
                alert(`Error [${response.status}]:\n${getErrorMessage(response)}`);
            }
        } catch (err) { statusEl.textContent = '❌ Network Error'; }
    }

    function saveToLocal() {
        const title = (document.querySelector('.fancy-title') || document.querySelector('h1'))?.innerText.trim() || 'Untitled';
        const contentDiv = document.querySelector('.post-stream .topic-post:first-child .cooked');
        const clone = contentDiv.cloneNode(true);
        const credit = document.createElement('div');
        credit.innerHTML = `<hr><p>Source: <a href="${window.location.href}">${document.title}</a></p>`;
        clone.appendChild(credit);

        const fullHtml = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${title}</title></head><body><h1>${title}</h1>${clone.innerHTML}</body></html>`;
        const blob = new Blob([fullHtml], { type: 'text/html' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${title.replace(/[\\/:*?"<>|]/g, '_')}.html`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }

    if (adminBase) {
        GM_registerMenuCommand('配置本站 WordPress 发布', openSettings);
        return;
    }

    const observer = new MutationObserver(() => {
        if (document.querySelector('.post-stream') && !document.getElementById('ld-archiver-toolbar')) init();
    });
    observer.observe(document.body, { childList: true, subtree: true });
    setTimeout(init, 2000);
})();
