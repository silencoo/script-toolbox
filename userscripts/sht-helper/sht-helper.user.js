// ==UserScript==
// @name         SHT Helper - 附件、链接与搜索增强
// @namespace    https://github.com/silencoo/script-toolbox
// @version      3.2.0
// @description  为色花堂提供附件文本预览、ZIP/RAR 解压、ED2K/磁力链接聚合、图片控制、离线下载与搜索结果排序、高亮和过滤。
// @author       silencoo
// @license      MIT
// @homepageURL  https://github.com/silencoo/script-toolbox/tree/main/userscripts/sht-helper
// @supportURL   https://github.com/silencoo/script-toolbox/issues
// @downloadURL  https://raw.githubusercontent.com/silencoo/script-toolbox/main/userscripts/sht-helper/sht-helper.user.js
// @updateURL    https://raw.githubusercontent.com/silencoo/script-toolbox/main/userscripts/sht-helper/sht-helper.user.js
// @match        *://sehuatang.org/*
// @match        *://*.sehuatang.org/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setClipboard
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_addStyle
// @connect      self
// @connect      cdn.jsdelivr.net
// @connect      raw.githubusercontent.com
// @connect      115.com
// @connect      my.115.com
// @connect      webapi.115.com
// @connect      www.123pan.com
// @run-at       document-idle
// ==/UserScript==

// Generated from src/ by scripts/build.mjs. Edit source modules, not the bundled file.
(function () {
    'use strict';

    const SCRIPT_VERSION = '3.2.0';

    /*********************** 请求、完整性、通知与诊断 ***********************/
    const REQUEST_DEFAULT_TIMEOUT = 30_000;
    const DIAGNOSTIC_LIMIT = 250;
    const diagnosticEvents = [];

    class ShtRequestError extends Error {
        constructor(message, { kind = 'network', status = 0, url = '', cause = null } = {}) {
            super(message);
            this.name = 'ShtRequestError';
            this.kind = kind;
            this.status = status;
            this.url = url;
            this.cause = cause;
        }
    }

    function sanitizedRequestTarget(url) {
        try {
            const parsed = new URL(url, location.href);
            return `${parsed.origin}${parsed.pathname}`;
        } catch {
            return '(invalid-url)';
        }
    }

    function redactDiagnosticValue(value, depth = 0) {
        if (depth > 3) return '[truncated]';
        if (typeof value === 'string') {
            return value
                .replace(/(authorization)\s*[:=]\s*(?:Bearer\s+)?[^;\s,]+/gi, '$1=[REDACTED]')
                .replace(/(cookie|token|loginuuid|usersessionid|seid|cid|uid)\s*[:=]\s*[^;\s,]+/gi, '$1=[REDACTED]')
                .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
                .replace(/magnet:\?[^\s]+/gi, 'magnet:[REDACTED]')
                .slice(0, 500);
        }
        if (Array.isArray(value)) return value.slice(0, 20).map(item => redactDiagnosticValue(item, depth + 1));
        if (value && typeof value === 'object') {
            const out = {};
            Object.entries(value).slice(0, 40).forEach(([key, item]) => {
                out[key] = /cookie|token|authorization|loginuuid|useragent/i.test(key)
                    ? '[REDACTED]'
                    : redactDiagnosticValue(item, depth + 1);
            });
            return out;
        }
        return value;
    }

    function diagnosticLog(level, scope, message, details = null) {
        let debugEnabled = false;
        try { debugEnabled = Boolean(CFG?.debugMode); } catch { }
        const entry = {
            time: new Date().toISOString(),
            level,
            scope,
            message: redactDiagnosticValue(String(message || '')),
            details: details == null ? null : redactDiagnosticValue(details)
        };
        if (level !== 'debug' || debugEnabled) {
            diagnosticEvents.push(entry);
            if (diagnosticEvents.length > DIAGNOSTIC_LIMIT) diagnosticEvents.shift();
        }
        if (debugEnabled) {
            const method = level === 'error' ? 'error' : level === 'warning' ? 'warn' : 'debug';
            console[method](`[SHT:${scope}] ${entry.message}`, entry.details || '');
        }
        return entry;
    }

    const waitWithSignal = (ms, signal) => new Promise((resolve, reject) => {
        if (signal?.aborted) {
            reject(new DOMException('请求已取消', 'AbortError'));
            return;
        }
        const timer = setTimeout(resolve, ms);
        signal?.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(new DOMException('请求已取消', 'AbortError'));
        }, { once: true });
    });

    function runGmRequest(options) {
        const {
            method = 'GET', url, headers = {}, data, responseType = 'text',
            timeout = REQUEST_DEFAULT_TIMEOUT, signal, onProgress
        } = options;
        return new Promise((resolve, reject) => {
            if (signal?.aborted) {
                reject(new DOMException('请求已取消', 'AbortError'));
                return;
            }
            let settled = false;
            const finish = callback => value => {
                if (settled) return;
                settled = true;
                signal?.removeEventListener('abort', abortRequest);
                callback(value);
            };
            const request = GM_xmlhttpRequest({
                method,
                url,
                headers,
                data,
                responseType,
                timeout,
                anonymous: false,
                onprogress: event => {
                    if (typeof onProgress === 'function') {
                        onProgress({ loaded: event.loaded || 0, total: event.lengthComputable ? event.total : 0 });
                    }
                },
                onload: finish(response => {
                    if (response.status >= 200 && response.status < 300) {
                        resolve(response);
                    } else {
                        reject(new ShtRequestError(`HTTP ${response.status}`, {
                            kind: 'http', status: response.status, url
                        }));
                    }
                }),
                onerror: finish(error => reject(new ShtRequestError('网络请求失败', {
                    kind: 'network', url, cause: error
                }))),
                ontimeout: finish(() => reject(new ShtRequestError('请求超时', {
                    kind: 'timeout', url
                }))),
                onabort: finish(() => reject(new DOMException('请求已取消', 'AbortError')))
            });
            function abortRequest() {
                try { request?.abort?.(); } catch { }
                finish(reject)(new DOMException('请求已取消', 'AbortError'));
            }
            signal?.addEventListener('abort', abortRequest, { once: true });
        });
    }

    async function shtRequest(options) {
        const method = (options.method || 'GET').toUpperCase();
        const retries = Math.max(0, Number(options.retries ?? (method === 'GET' ? 1 : 0)) || 0);
        const target = sanitizedRequestTarget(options.url);
        let attempt = 0;
        while (true) {
            try {
                diagnosticLog('debug', options.scope || 'request', `${method} ${target}`, { attempt: attempt + 1 });
                const response = await runGmRequest({ ...options, method });
                diagnosticLog('debug', options.scope || 'request', `${method} 请求成功`, {
                    target, status: response.status, attempt: attempt + 1
                });
                return response;
            } catch (error) {
                const retryable = error?.name !== 'AbortError' && (
                    error?.kind === 'network' || error?.kind === 'timeout' ||
                    [408, 429, 500, 502, 503, 504].includes(error?.status)
                );
                diagnosticLog(retryable ? 'warning' : 'error', options.scope || 'request', `${method} 请求失败`, {
                    target, kind: error?.kind || error?.name, status: error?.status || 0, attempt: attempt + 1
                });
                if (!retryable || attempt >= retries) throw error;
                attempt += 1;
                await waitWithSignal((options.retryDelayMs || 500) * (2 ** (attempt - 1)), options.signal);
            }
        }
    }

    async function responseJson(response, label = '响应') {
        if (response.response && typeof response.response === 'object') return response.response;
        const text = response.responseText || response.response || '';
        try {
            return JSON.parse(text);
        } catch (error) {
            throw new ShtRequestError(`${label}不是有效 JSON`, { kind: 'parse', status: response.status, cause: error });
        }
    }

    async function sha256Hex(value) {
        const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : new Uint8Array(value);
        const digest = await crypto.subtle.digest('SHA-256', bytes);
        return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
    }

    async function assertSha256(value, expected, label) {
        const actual = await sha256Hex(value);
        if (actual !== expected) {
            diagnosticLog('error', 'integrity', `${label} 完整性校验失败`, { expected, actual });
            throw new Error(`${label} 完整性校验失败，已拒绝执行`);
        }
        diagnosticLog('debug', 'integrity', `${label} 完整性校验通过`, { sha256: actual });
    }

    const OPTIONAL_LIBRARIES = Object.freeze({
        zip: {
            url: 'https://raw.githubusercontent.com/silencoo/script-toolbox/main/userscripts/sht-helper/vendor/zip-2.7.53.min.js',
            sha256: 'c239c5a4914692dc41bb58027395c99ce7f1b93ab97059dc4035822303ea45d3',
            globalName: 'zip'
        },
        jschardet: {
            url: 'https://cdn.jsdelivr.net/npm/jschardet@3.0.0/dist/jschardet.min.js',
            sha256: 'be115e6d895d30f6d96f3644a4880a7a656b60239ef20391a2dd6f3dd9608664',
            globalName: 'jschardet'
        }
    });
    const optionalLibraryPromises = new Map();

    function loadOptionalLibrary(name, { signal } = {}) {
        const spec = OPTIONAL_LIBRARIES[name];
        if (!spec) return Promise.reject(new Error(`未知的可选依赖: ${name}`));
        if (globalThis[spec.globalName]) return Promise.resolve(globalThis[spec.globalName]);
        if (optionalLibraryPromises.has(name)) return optionalLibraryPromises.get(name);

        const promise = (async () => {
            const response = await shtRequest({
                method: 'GET', url: spec.url, responseType: 'text', timeout: 30_000,
                signal, retries: 1, scope: `dependency:${name}`
            });
            const source = response.responseText || response.response || '';
            await assertSha256(source, spec.sha256, name);
            // 固定版本且通过 SHA-256 校验的资源，仅在用户触发对应功能时执行。
            Function(`${source}\n//# sourceURL=${spec.url}`)();
            const loaded = globalThis[spec.globalName];
            if (!loaded) throw new Error(`${spec.globalName} 未注册`);
            return loaded;
        })().catch(error => {
            optionalLibraryPromises.delete(name);
            throw error;
        });

        optionalLibraryPromises.set(name, promise);
        return promise;
    }

    function ensureToastRegion() {
        let region = document.querySelector('#sht-toast-region');
        if (region) return region;
        region = document.createElement('div');
        region.id = 'sht-toast-region';
        region.setAttribute('aria-live', 'polite');
        region.style.cssText = 'position:fixed;right:16px;top:16px;z-index:2147483647;display:grid;gap:8px;width:min(380px,calc(100vw - 32px));pointer-events:none;';
        document.body.appendChild(region);
        return region;
    }

    function showToast(message, type = 'info', duration = 3000) {
        if (!document.body) return null;
        const colors = {
            info: ['#e8f4fd', '#0b5f91'], success: ['#eaf7ed', '#1e6b34'],
            warning: ['#fff6dd', '#7a5600'], error: ['#fdecec', '#9b1c1c']
        };
        const [background, color] = colors[type] || colors.info;
        const toast = document.createElement('div');
        toast.setAttribute('role', type === 'error' ? 'alert' : 'status');
        toast.style.cssText = `pointer-events:auto;padding:10px 12px;border:1px solid ${color}33;border-radius:7px;background:${background};color:${color};box-shadow:0 4px 18px rgba(0,0,0,.18);font-size:13px;line-height:1.45;white-space:pre-wrap;`;
        toast.textContent = String(message);
        ensureToastRegion().appendChild(toast);
        const close = () => toast.remove();
        toast.addEventListener('click', close);
        if (duration > 0) setTimeout(close, duration);
        return { element: toast, close };
    }

    function showActionDialog({ title = '请确认', message = '', confirmText = '确定', cancelText = '取消', danger = false, input = null } = {}) {
        return new Promise(resolve => {
            const previouslyFocused = document.activeElement;
            const backdrop = document.createElement('div');
            backdrop.style.cssText = 'position:fixed;inset:0;z-index:2147483646;background:rgba(0,0,0,.5);display:grid;place-items:center;padding:16px;';
            const dialog = document.createElement('div');
            dialog.setAttribute('role', 'dialog');
            dialog.setAttribute('aria-modal', 'true');
            dialog.style.cssText = 'width:min(520px,100%);max-height:80vh;overflow:auto;background:#fff;border-radius:9px;padding:18px;box-shadow:0 12px 36px rgba(0,0,0,.3);color:#222;';
            const heading = document.createElement('h3');
            heading.id = `sht-action-title-${Date.now()}`;
            heading.textContent = title;
            heading.style.cssText = 'margin:0 0 10px;font-size:17px;';
            const body = document.createElement('div');
            body.textContent = message;
            body.style.cssText = 'white-space:pre-wrap;font-size:13px;line-height:1.55;';
            let field = null;
            if (input) {
                field = input.multiline ? document.createElement('textarea') : document.createElement('input');
                if (!input.multiline) field.type = input.type || 'text';
                field.value = input.value || '';
                field.placeholder = input.placeholder || '';
                field.style.cssText = 'width:100%;box-sizing:border-box;margin-top:12px;padding:8px;border:1px solid #bbb;border-radius:5px;';
            }
            const actions = document.createElement('div');
            actions.style.cssText = 'display:flex;justify-content:flex-end;gap:8px;margin-top:16px;';
            const cancel = document.createElement('button');
            cancel.type = 'button'; cancel.textContent = cancelText;
            const confirmButton = document.createElement('button');
            confirmButton.type = 'button'; confirmButton.textContent = confirmText;
            confirmButton.style.cssText = `padding:6px 14px;border:0;border-radius:5px;background:${danger ? '#c62828' : '#0677b8'};color:white;cursor:pointer;`;
            cancel.style.cssText = 'padding:6px 14px;border:1px solid #bbb;border-radius:5px;background:#fff;cursor:pointer;';
            dialog.setAttribute('aria-labelledby', heading.id);
            const finish = value => {
                backdrop.remove();
                if (previouslyFocused?.isConnected) previouslyFocused.focus?.();
                resolve(value);
            };
            cancel.addEventListener('click', () => finish(input ? null : false));
            confirmButton.addEventListener('click', () => finish(input ? field.value : true));
            backdrop.addEventListener('click', event => { if (event.target === backdrop) finish(input ? null : false); });
            backdrop.addEventListener('keydown', event => {
                if (event.key === 'Escape') finish(input ? null : false);
                if (event.key === 'Enter' && !input?.multiline) finish(input ? field.value : true);
                if (event.key === 'Tab') {
                    const focusable = [field, cancel, confirmButton].filter(Boolean);
                    const current = focusable.indexOf(document.activeElement);
                    const next = event.shiftKey
                        ? (current <= 0 ? focusable.length - 1 : current - 1)
                        : (current >= focusable.length - 1 ? 0 : current + 1);
                    event.preventDefault();
                    focusable[next].focus();
                }
            });
            actions.append(cancel, confirmButton);
            dialog.append(heading, body);
            if (field) dialog.append(field);
            dialog.append(actions);
            backdrop.append(dialog);
            document.body.append(backdrop);
            (field || confirmButton).focus();
        });
    }

    const confirmAction = (message, options = {}) => showActionDialog({ ...options, message });
    const promptText = (message, options = {}) => showActionDialog({ ...options, message, input: {
        value: options.value || '', placeholder: options.placeholder || '', multiline: Boolean(options.multiline)
    } });

    function describeRequestError(error) {
        if (error?.name === 'AbortError') return '操作已取消';
        if (error?.kind === 'timeout') return '请求超时，请稍后重试';
        if (error?.kind === 'network') return '网络连接失败';
        if (error?.kind === 'parse') return '服务返回了无法识别的数据';
        if (error?.status === 401 || error?.status === 403) return '登录已失效或权限不足';
        if (error?.status === 404) return '请求的资源不存在';
        if (error?.status === 429) return '请求过于频繁，请稍后重试';
        if (error?.status >= 500) return '服务暂时不可用';
        return error?.message || '未知错误';
    }

    function exportDiagnosticReport() {
        const report = {
            format: 'sht-helper-diagnostics',
            version: SCRIPT_VERSION,
            exportedAt: new Date().toISOString(),
            page: {
                origin: location.origin,
                pathname: location.pathname,
                type: typeof isThreadPage !== 'undefined' && isThreadPage ? 'thread'
                    : typeof isSearchPage !== 'undefined' && isSearchPage ? 'search'
                        : typeof isForumListPage !== 'undefined' && isForumListPage ? 'forum-list' : 'other'
            },
            capabilities: {
                zipLoaded: Boolean(globalThis.zip),
                charsetLoaded: Boolean(globalThis.jschardet),
                rarWorkerReady: Boolean(gWorker),
                pan115Enabled: Boolean(CFG.pan115Enabled),
                pan123Enabled: Boolean(CFG.pan123Enabled)
            },
            events: diagnosticEvents.map(event => redactDiagnosticValue(event))
        };
        const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = `sht-diagnostics-${new Date().toISOString().slice(0, 10)}.json`;
        anchor.click();
        setTimeout(() => URL.revokeObjectURL(url), 0);
        showToast('已导出脱敏诊断报告', 'success');
    }

    class ShtTaskQueue {
        constructor(getConcurrency) {
            this.getConcurrency = getConcurrency;
            this.pending = [];
            this.active = new Map();
            this.listeners = new Set();
            this.sequence = 0;
        }
        add(run, { label = '任务', retries = 0, signal = null } = {}) {
            const id = ++this.sequence;
            return new Promise((resolve, reject) => {
                this.pending.push({ id, run, label, retries, signal, resolve, reject });
                this.emit();
                this.drain();
            });
        }
        cancelPending(reason = '队列已取消') {
            const pending = this.pending.splice(0);
            pending.forEach(task => task.reject(new DOMException(reason, 'AbortError')));
            this.emit();
        }
        subscribe(listener) {
            this.listeners.add(listener);
            listener(this.snapshot());
            return () => this.listeners.delete(listener);
        }
        snapshot() {
            return {
                active: Array.from(this.active.values(), task => ({ id: task.id, label: task.label })),
                pending: this.pending.map(task => ({ id: task.id, label: task.label }))
            };
        }
        emit() { this.listeners.forEach(listener => listener(this.snapshot())); }
        async execute(task) {
            let attempt = 0;
            while (true) {
                if (task.signal?.aborted) throw new DOMException('任务已取消', 'AbortError');
                try { return await task.run({ signal: task.signal, attempt }); }
                catch (error) {
                    if (error?.name === 'AbortError' || attempt >= task.retries) throw error;
                    attempt += 1;
                    await waitWithSignal(500 * (2 ** (attempt - 1)), task.signal);
                }
            }
        }
        drain() {
            const concurrency = Math.max(1, Number(this.getConcurrency()) || 1);
            while (this.active.size < concurrency && this.pending.length) {
                const task = this.pending.shift();
                this.active.set(task.id, task);
                this.emit();
                this.execute(task).then(task.resolve, task.reject).finally(() => {
                    this.active.delete(task.id);
                    this.emit();
                    this.drain();
                });
            }
        }
    }

    const cloudTaskQueue = new ShtTaskQueue(() => CFG.cloudTaskConcurrency);

    // RAR 解压功能 - 使用 Web Worker 实现
    let gWorker = null;
    let gWorkerReady = null;

    const LIB_SOURCES = [{
        name: 'silencoo/libunrar-js@b49a41a',
        js: 'https://raw.githubusercontent.com/silencoo/libunrar-js/b49a41a6855374c0119283a2120d2a88a0d3811e/libunrar.js',
        jsSha256: 'fd17b6d83dcf5fbe2d43dc3ebf05e44760d7228d8ea74113bf6bbedc0f997bea',
        mem: 'https://raw.githubusercontent.com/silencoo/libunrar-js/b49a41a6855374c0119283a2120d2a88a0d3811e/libunrar.js.mem',
        memSha256: '5c1cf97aebdc1413d64cc852b8e7ac6d415c0a312b06d21c2484ad80d4d00299',
    }];

    // 工具函数
    function toU8(data) {
        try {
            if (!data) return null;
            if (data instanceof Uint8Array) return data;
            if (data instanceof ArrayBuffer) return new Uint8Array(data);
            if (ArrayBuffer.isView(data) && data.buffer) return new Uint8Array(data.buffer, data.byteOffset || 0, data.byteLength);
            if (typeof Blob !== 'undefined' && data instanceof Blob) return null;
            if (typeof data === 'string') return new TextEncoder().encode(data);
            if (Array.isArray(data)) {
                // 检查是否为序列化后的 Uint8Array（通过 postMessage 传递）
                const u8 = new Uint8Array(data.length);
                for (let i = 0; i < data.length; i++) {
                    const val = data[i];
                    if (typeof val === 'number' && val >= 0 && val <= 255) {
                        u8[i] = val;
                    } else {
                        console.log(`[数据转换] 警告：数组元素不是有效字节值:`, val, 'at index', i);
                        return null;
                    }
                }
                return u8;
            }
            if (data && typeof data === 'object') {
                if (data.data) return toU8(data.data);
                if (data.bytes) return toU8(data.bytes);
            }
        } catch (error) {
            console.log(`[数据转换] toU8 转换失败:`, error, 'data type:', typeof data, 'isArray:', Array.isArray(data));
        }
        return null;
    }

    function objBytesToU8(obj) {
        if (!obj) return null;
        if (obj instanceof Uint8Array) return obj;
        if (Array.isArray(obj)) {
            // 检查是否为序列化后的 Uint8Array
            const u8 = new Uint8Array(obj.length);
            for (let i = 0; i < obj.length; i++) {
                const val = obj[i];
                if (typeof val === 'number' && val >= 0 && val <= 255) {
                    u8[i] = val;
                } else {
                    console.log(`[数据转换] objBytesToU8 警告：数组元素不是有效字节值:`, val, 'at index', i);
                    return null;
                }
            }
            return u8;
        }
        if (typeof obj === 'object') {
            const keys = Object.keys(obj).sort((a, b) => Number(a) - Number(b));
            const out = new Uint8Array(keys.length);
            for (let i = 0; i < keys.length; i++) {
                const val = obj[keys[i]];
                if (typeof val === 'number' && val >= 0 && val <= 255) {
                    out[i] = val;
                } else {
                    console.log(`[数据转换] objBytesToU8 警告：对象值不是有效字节:`, val, 'at key', keys[i]);
                    return null;
                }
            }
            return out;
        }
        return null;
    }

    // 递归把 result.ls 的目录树收集为 {name, size, data}[]
    function collectEntriesFromResult(result) {
        const entries = [];

        function walkLS(ls, prefix = "") {
            if (!ls || typeof ls !== 'object') return;
            for (const [name, node] of Object.entries(ls)) {
                const niceName = (node.fullFileName || (prefix ? (prefix + '/' + name) : name));
                if (node?.type === 'file') {
                    // 优先各种字段；fileContent 是对象形式的字节
                    let u8 = toU8(node.fileContent) || toU8(node.content) || toU8(node.data) || objBytesToU8(node.fileContent);
                    if (!u8 && node.bytes) u8 = toU8(node.bytes);
                    if (u8) {
                        entries.push({ name: niceName, size: node.fileSize ?? u8.byteLength, data: u8 });
                    } else {
                    }
                } else if (node?.type === 'dir') {
                    walkLS(node.ls, niceName);
                }
            }
        }

        // 1) 支持你现在的 { type:'dir', ls:{...} }
        if (result?.type === 'dir' && result?.ls) {
            walkLS(result.ls, "");
        }

        // 2) 兼容某些版本的 { ls:{...} }（无顶层 type）
        if (entries.length === 0 && result?.ls && typeof result.ls === 'object') {
            walkLS(result.ls, "");
        }

        // 3) 仍然兼容已有的 files/contents 逻辑（以防库换版本）
        if (entries.length === 0 && Array.isArray(result?.files)) {
            for (const f of result.files) {
                const name = f.name || f.fileName || (f.fileHeader && (f.fileHeader.name || f.fileHeader.fileNameUTF8)) || 'file.bin';
                const raw = toU8(f.content ?? f.extraction ?? f.data ?? f.bytes);
                if (raw) entries.push({ name, size: raw.byteLength, data: raw });
            }
        }
        if (entries.length === 0 && result?.contents && typeof result.contents === 'object') {
            for (const [name, val] of Object.entries(result.contents)) {
                const raw = toU8(val) || objBytesToU8(val);
                if (raw) entries.push({ name: name || 'file.bin', size: raw.byteLength, data: raw });
            }
        }

        return entries;
    }

    // 网络请求函数
    async function fetchBinary(url, timeout = 30_000, options = {}) {
        const response = await shtRequest({
            url, method: 'GET', responseType: 'arraybuffer', timeout,
            headers: { 'Accept': '*/*', 'Referer': location.href },
            signal: options.signal, onProgress: options.onProgress,
            retries: 1, scope: options.scope || 'binary-download'
        });
        return response.response;
    }

    async function fetchText(url, timeout = 20_000, options = {}) {
        const response = await shtRequest({
            url, method: 'GET', responseType: 'text', timeout,
            headers: { 'Accept': 'text/plain,*/*;q=0.8', 'Referer': location.href },
            signal: options.signal, onProgress: options.onProgress,
            retries: 1, scope: options.scope || 'text-download'
        });
        return response.responseText || response.response || '';
    }

    // libunrar 加载
    async function ensureLibReady() {
        if (gWorker && gWorkerReady) return gWorkerReady;

        // 拉 gh-pages 的 js / mem
        const source = LIB_SOURCES[0];
        const JS_URL = source.js;
        const MEM_URL = source.mem;

        const [jsCode, memBuf] = await Promise.all([
            fetchText(JS_URL, 30_000, { scope: 'dependency:rar-js' }),
            fetchBinary(MEM_URL, 30_000, { scope: 'dependency:rar-mem' })
        ]);
        await Promise.all([
            assertSha256(jsCode, source.jsSha256, 'libunrar.js'),
            assertSha256(memBuf, source.memSha256, 'libunrar.js.mem')
        ]);

        // 用 blob: 提供 .mem
        const memBlob = new Blob([new Uint8Array(memBuf)], { type: 'application/octet-stream' });
        const memURL = URL.createObjectURL(memBlob);

        // ====== Worker：关键修复都在这里 ======
        const workerSource = `
    const tick = (ms)=>new Promise(r=>setTimeout(r,ms));
    const bname = (p)=>{ if(!p) return ''; const i=p.lastIndexOf('/'); return i>=0?p.slice(i+1):p; };
    const toU8  = (v)=> v instanceof Uint8Array ? v : new Uint8Array(v);

    let __logs = [];
    self.Module = {
        noInitialRun: true,
        noExitRuntime: true,
        locateFile: p => (p && p.endsWith('.mem')) ? ${JSON.stringify(memURL)} : p,
        print: s => {
            const msg = String(s);
            __logs.push(msg);
            postMessage({ type:'log', msg });
            const m = msg.match(/^\\s*filename:\\s*(.+)\\s*$/i);
            if (m) self.__lastFileName = m[1].trim();
        },
        printErr: s => postMessage({ type:'err', msg: String(s) }),
    };

    ${jsCode}

    function fsList(dir='/', prefix='') {
        const out = [];
        if (typeof FS === 'undefined' || !FS.readdir) return out;
        let list = [];
        try { list = FS.readdir(dir).filter(n=>n!=='.' && n!=='..'); } catch(_) { return out; }
        for (const name of list) {
            const full = dir==='/' ? '/'+name : dir+'/'+name;
            let st; try { st = FS.stat(full); } catch(_) { continue; }
            if (FS.isFile(st.mode)) {
                try { out.push({ path: full, name: (prefix?prefix+'/':'')+name, size: st.size }); } catch(_) {}
            } else if (FS.isDir(st.mode)) {
                out.push(...fsList(full, (prefix?prefix+'/':'')+name));
            }
        }
        return out;
    }

    function tryReadPaths(paths) {
        for (const p of paths) {
            try { const data = FS.readFile(p); return { name: bname(p)||'file.bin', content: data }; } catch(_){}
        }
        return null;
    }

    function byLikelyTextFirst(a,b){
        const tx = (n)=>/\\.(txt|nfo|log|md|json|srt|ini|xml)$/i.test(n||'');
        if (tx(a.name) && !tx(b.name)) return -1;
        if (!tx(a.name) && tx(b.name)) return 1;
        return (b.size|0) - (a.size|0);
    }

    async function harvestAllFiles(hintName, excludeNames=new Set(), tries=6, wait=120){
        // 轮询几次等底层写入完成
        let best = [];
        for (let i=0;i<tries;i++){
            const all = fsList('/').filter(f => !excludeNames.has(bname(f.path)));
            if (all.length) { best = all.slice().sort(byLikelyTextFirst); break; }
            await tick(wait);
        }
        // 如果仍然空，再多等两拍
        if (!best.length){
            await tick(wait); best = fsList('/').sort(byLikelyTextFirst);
            if (!best.length){ await tick(wait); best = fsList('/').sort(byLikelyTextFirst); }
        }

        const out = [];
        // 先按 hintName/日志猜测读取
        const hints = new Set();
        if (hintName) hints.add(hintName);
        if (self.__lastFileName) hints.add(self.__lastFileName);
        for (const h of hints){
            const bn = bname(h);
            const candidates = [
                h, '/'+h, bn, '/'+bn,
                ...(best.filter(f=>f.name===h || f.name===bn || bname(f.path)===bn).map(f=>f.path))
            ];
            const hit = tryReadPaths(candidates);
            if (hit) out.push(hit);
        }

        // 再把剩余的都读出来（避免只返回一个名字）
        for (const f of best){
            try {
                const data = FS.readFile(f.path);
                out.push({ name: f.name, content: data });
            } catch(_){}
        }

        // 去重（按 name+size）
        const seen = new Set();
        const dedup = [];
        for (const f of out){
            if (!f || !f.content) continue;
            const key = f.name + ':' + (f.content.byteLength||0);
            if (seen.has(key)) continue;
            seen.add(key); dedup.push(f);
        }
        return dedup;
    }

    async function extractByUNRAR(bytes, password){
        try{
            const cands = [self.libunrar,self.UNRAR,self.Unrar,self.Module?.libunrar,self.Module];
            let api = null; for (const c of cands) if (c && typeof c.createExtractorFromData==='function'){ api=c; break; }
            if (!api) return null;
            const ex = await api.createExtractorFromData({ data: toU8(bytes), password: String(password||'') });
            const list = ex.getFileList();
            const names = (list?.fileHeaders||[]).filter(h=>!(h.flags?.directory)).map(h=>h.name||h.fileName||h.fileNameUTF8).filter(Boolean);
            const files = [];
            if (names.length){
                const res = ex.extract({ files: names });
                for (const f of (res?.files||[])){
                    const raw = f.extraction||f.content||f.data||f.bytes;
                    const name = f.fileName||f.name||f.fileHeader?.name||'file.bin';
                    if (raw) files.push({ name, content: toU8(raw) });
                }
            }
            return files.length ? files : null;
        }catch(e){ postMessage({type:'err', msg:'[UNRAR] '+String(e)}); return null; }
    }

    self.onmessage = async (e) => {
        const { id, parts, password } = e.data || {};

        function ok(result) { postMessage({ id, type:'ok', result }); }
        function fail(error) { postMessage({ id, type:'fail', error: String(error) }); }

        try {
            if (typeof readRARContent !== 'function') {
                fail('readRARContent 未定义（脚本未正确初始化）');
                return;
            }

            // 1) 优先：不带回调的调用方式 —— 直接"拿返回值"
            // 有些构建里 readRARContent(files, password) 会直接返回结构化结果（含 files/contents）
            try {
                const ret = readRARContent(parts, password || '');
                if (ret && typeof ret === 'object') {
                    ok(ret);
                    return;
                }
            } catch (_) {
                // 忽略，改用回调式
            }

            // 2) 回调式：我们自己累积内容，最后一次性返回
            // 有些版本会在回调里多次给出条目（文件名或 {name, content} 等对象）
            const acc = { files: [] };
            const seenNames = new Set();

            const onUpdate = (item) => {
                // 可能只是字符串（文件名或日志）
                if (typeof item === 'string') {
                    // 把它当成进度日志，不中断
                    postMessage({ type: 'log', msg: item });
                    return;
                }
                // 也可能是一个对象（尝试抓 name + 内容）
                if (item && typeof item === 'object') {
                    const name = item.fileName || item.name || (item.fileHeader && (item.fileHeader.name || item.fileHeader.fileNameUTF8));
                    const data = item.content || item.data || item.bytes;

                    // 如果有内容就存起来（ArrayBuffer/TypedArray 都接受）
                    if (name && data) {
                        // 统一转成 Uint8Array
                        let u8 = null;
                        if (data instanceof Uint8Array) u8 = data;
                        else if (data instanceof ArrayBuffer) u8 = new Uint8Array(data);
                        else if (ArrayBuffer.isView(data)) u8 = new Uint8Array(data.buffer, data.byteOffset||0, data.byteLength);
                        else if (Array.isArray(data)) u8 = new Uint8Array(data);
                        if (u8) {
                            console.log('[Worker] 收集文件:', name, '数据类型:', u8.constructor.name, '长度:', u8.length, '前5字节:', Array.from(u8.slice(0, 5)));
                            acc.files.push({ name, content: u8 });
                            seenNames.add(name);
                        }
                    }

                    // 有些版本会在最后一次把完整结构丢给回调（比如 { files:[...] , contents:{...} }）
                    if (item.files || item.contents || item.fileHeaders) {
                        ok(item);
                        return;
                    }
                }
            };

            // 调用回调式；若库会同步返回一个最终对象，也拿一下
            const maybeRet = readRARContent(parts, password || '', onUpdate);
            if (maybeRet && typeof maybeRet === 'object' && (maybeRet.files || maybeRet.contents || maybeRet.fileHeaders)) {
                ok(maybeRet);
                return;
            }

            // 如果前面回调累积到了内容，也算成功
            if (acc.files.length > 0) {
                ok(acc);
                return;
            }

            // 到这里还没有结果，算失败
            fail('未拿到任何结构化结果（回调仅返回日志/文件名）。请检查密码或更换库构建。');
        } catch (err) {
            fail(err);
        }
    };

    postMessage({ type:'ready' });
    `;

        const workerBlob = new Blob([workerSource], { type: 'application/javascript' });
        const workerURL = URL.createObjectURL(workerBlob);

        gWorker = new Worker(workerURL);
        gWorkerReady = new Promise((resolve, reject) => {
            const t = setTimeout(() => reject(new Error('Worker 初始化超时')), 5000);
            gWorker.onmessage = (ev) => {
                if (ev.data && ev.data.type === 'ready') {
                    clearTimeout(t);
                    resolve();
                } else if (ev.data && ev.data.type === 'log') {
                    console.log('[rar-helper][worker]', ev.data.msg);
                } else if (ev.data && ev.data.type === 'err') {
                    console.warn('[rar-helper][worker-err]', ev.data.msg);
                }
            };
            gWorker.onerror = (e) => { clearTimeout(t); reject(new Error('Worker 脚本错误: ' + (e.message || e.filename))); };
        });

        return gWorkerReady;
    }

    // 调用 Worker 抽取
    let _taskSeq = 1;
    function callWorkerExtract(archiveBuf, password, partsMeta) {
        return new Promise(async (resolve, reject) => {
            await ensureLibReady();
            const id = _taskSeq++;
            const u8 = archiveBuf instanceof Uint8Array ? archiveBuf : new Uint8Array(archiveBuf);

            const parts = partsMeta && Array.isArray(partsMeta) && partsMeta.length
                ? partsMeta.map(p => ({ name: p.name, content: p.content }))
                : [{ name: 'archive.rar', content: u8 }];

            const onMsg = (ev) => {
                const d = ev.data || {};
                if (d.type === 'log') { console.log('[rar-helper][worker]', d.msg); return; }
                if (d.type === 'err') { console.warn('[rar-helper][worker-err]', d.msg); return; }
                if (d.id !== id) return;
                gWorker.removeEventListener('message', onMsg);
                if (d.type === 'ok') return resolve(d.result);
                if (d.type === 'fail') return reject(new Error(d.error || 'worker 失败'));
                return reject(new Error('未知 worker 返回'));
            };
            gWorker.addEventListener('message', onMsg);
            gWorker.postMessage({ id, parts, password: password || '' });
        });
    }

    // RAR 文件检测函数
    function isRARFile(buffer) {
        if (buffer.length < 8) return false;
        const header1 = Array.from(buffer.slice(0, 4)).join(', ');
        const header2 = Array.from(buffer.slice(0, 7)).join(', ');
        const header3 = Array.from(buffer.slice(0, 8)).join(', ');
        const rar_header1 = '82, 69, 126, 94'; // old
        const rar_header2 = '82, 97, 114, 33, 26, 7, 0'; // 1.5 to 4.0
        const rar_header3 = '82, 97, 114, 33, 26, 7, 1, 0'; // 5.0
        return (header1 === rar_header1 || header2 === rar_header2 || header3 === rar_header3);
    }

    // 解压逻辑（主线程）
    async function tryExtractWithPassword(buffer, password) {
        console.log('[rar-helper] tryExtractWithPassword: password =', password);
        try {
            const result = await callWorkerExtract(buffer, password);
            console.debug('[rar-helper] worker result keys:', Object.keys(result || {}));
            // 统一从各种可能的返回结构里收集
            const outEntries = collectEntriesFromResult(result);
            console.log('[rar-helper] collected entries:', outEntries.map(e => `${e.name} (${e.size})`));
            if (outEntries.length) return { ok: true, entries: outEntries };

            const s = JSON.stringify(result || {});
            if (/password|wrong\s*password|encrypted\s*headers/i.test(s)) {
                return { ok: false, wrongPassword: true };
            }
            return { ok: false, error: '未成功解出任何文件' };
        } catch (err) {
            const s = String(err || '');
            if (/password|wrong\s*password|encrypted\s*headers/i.test(s)) {
                return { ok: false, wrongPassword: true };
            }
            return { ok: false, error: err?.message || s };
        }
    }

    // 兼容原有的 API
    window.readRARFileNames = function (rarFiles, password) {
        console.log('readRARFileNames 已弃用，请使用新的 RAR 解压功能');
        return {};
    };

    window.readRARContent = function (rarFiles, password, filename, callback) {
        console.log('readRARContent 已弃用，请使用新的 RAR 解压功能');
        if (callback) callback(null, new Error('readRARContent 已弃用'));
    };

    /*********************** 配置 ***********************/
    const CONFIG_SCHEMA_VERSION = 3;
    const volatileCredentialVault = {};
    const DEFAULT_CONFIG = {
        schemaVersion: CONFIG_SCHEMA_VERSION,
        maxAutoBytes: 2 * 1024 * 1024,
        autoHoistToTop: true,
        textExts: ['txt', 'nfo', 'log', 'json', 'ini', 'md', 'csv'],
        maxEntryBytes: 3 * 1024 * 1024,
        passwordCandidates: ['', 'www.98T.la', '98T.la', '98t', 'sehuatang', 'sht', 'sht123', '123456', 'www.sehuatang.org'],
        wrapAtTop: true,
        toolbarCompactMode: false,
        toolbarGroupState: { quick: true, attachments: false, cloud: false, more: false },

        blockImages: true,
        imageAllowDomains: [],
        imagePlaceholderShowMeta: false,
        imageMinBlockSizePx: 40,
        imageProcessBatch: 50,
        mutationDebounceMs: 300,

        autoCollectED2K: true,
        ed2kDebounceMs: 500,

        autoCollectMagnet: true,
        magnetDebounceMs: 500,

        // 历史记录功能
        enableHistory: true,
        maxHistoryItems: 1000,
        historyItems: [],

        // 只看楼主功能
        authorOnlyMode: false,

        // 一键评分功能
        enableQuickRate: true,
        defaultRateScore: 2, // 默认评分分数
        defaultRateReason: '很给力!', // 默认评分理由

        // 排版优化功能
        hideReplyColumn: false,
        hideLastReplyColumn: false,
        hideAuthorColumn: false,
        hideStickyThreads: false,

        // 分页和过滤功能
        hidePagination: false,
        enableKeywordFilter: false,
        keywordFilters: [],
        enhanceTitles: false,

        // 历史访问帖子处理
        historyPostAction: 'none', // 'none', 'hide', 'blue', 'strikethrough'
        historyPostColor: '#0066cc',

        // 帖子详情标题处理
        enableThreadTitleEnhance: false,
        titleReplaceRules: [
            { pattern: '\\[\\d+\\.\\d+G/\\d+V/\\d+配额\\]', replacement: '' }
        ],
        hideTypeLabels: ['情色分享', '图文故事', '视频分享'],

        // 帖子列表页标题处理
        enableListTitleEnhance: false,
        listTitleReplaceRules: [
            { pattern: '\\[\\d+\\.\\d+G/\\d+V/\\d+配额\\]', replacement: '' },
            { pattern: '\\[情色分享\\]', replacement: '' },
            { pattern: '\\[图文故事\\]', replacement: '' }
        ],

        // 论坛模块屏蔽
        enableModuleFilter: false,
        hiddenModules: [],

        // 123Pan 离线下载配置
        // 115 离线下载配置
        pan115Enabled: false,
        pan115Cookie: '',
        pan115UserAgent: '',
        pan115UploadDir: '',
        pan115FolderNames: {},
        pan115CurrentThreadFolder: '',
        pan115ThreadFolders: {},

        // 123Pan 离线下载配置
        pan123Enabled: false,
        pan123Token: '',
        pan123LoginUuid: '',
        pan123Cookie: '',
        pan123UploadDir: '',
        pan123MinSize: '10MB',
        pan123MaxSize: '1000GB',
        pan123IncludeExt: 'mp4,avi,mkv,wmv,flv,mov',
        pan123ExcludeExt: 'txt,nfo,srt,sub,url,mht,jpg,jpeg,png,gif,bmp,webp,ico,svg',
        pan123VideoMinSize: '100MB',
        pan123PickLargest: false,

        // 秒离线处理配置
        pan123InstantOfflineAction: 'auto_cancel', // 'auto_cancel', 'ask_user', 'keep_task'
        pan123InstantOfflineCheckDelay: 2000, // 检查延迟时间(毫秒)
        pan123BatchSendInterval: 2000, // 批量发送间隔时间(毫秒)
        pan123CurrentThreadFolder: '', // 当前帖子的文件夹ID
        pan123ThreadFolders: {}, // 帖子URL到文件夹ID的映射

        // 任务、凭据和诊断
        cloudTaskConcurrency: 2,
        credentialsSessionOnly: false,
        debugMode: false,

        // ED2K文件名处理配置
        ed2kFileNameReplaceEnabled: false,
        ed2kFileNameReplaceRules: [
            { pattern: '\\[\\d+\\.\\d+G/\\d+V/\\d+配额\\]', replacement: '' },
            { pattern: '\\[情色分享\\]', replacement: '' },
            { pattern: '\\[图文故事\\]', replacement: '' },
            { pattern: '\\[视频分享\\]', replacement: '' }
        ]
    };
    const MAIN_CONFIG_KEY = 'sht_cfg_v2';
    const SEARCH_CONFIG_KEY = 'sht_sorter_config';
    const CONFIG_EXPORT_VERSION = SCRIPT_VERSION;
    const SENSITIVE_CONFIG_KEYS = Object.freeze([
        'pan115Cookie',
        'pan115UserAgent',
        'pan123Token',
        'pan123LoginUuid',
        'pan123Cookie'
    ]);
    let CFG = loadConfig();

    function readSessionCredentials() {
        return { ...volatileCredentialVault };
    }

    function migrateConfig(input) {
        const migrated = input && typeof input === 'object' && !Array.isArray(input) ? { ...input } : {};
        const fromVersion = Number(migrated.schemaVersion || 1);
        if (fromVersion < 2 && migrated.toolbarCollapsed != null) {
            migrated.toolbarCompactMode = Boolean(migrated.toolbarCollapsed);
            delete migrated.toolbarCollapsed;
        }
        if (fromVersion < 3) {
            if (migrated.toolbarGroupState) {
                migrated.toolbarGroupState = { ...DEFAULT_CONFIG.toolbarGroupState, ...migrated.toolbarGroupState };
            }
            if (migrated.cloudTaskConcurrency != null) {
                migrated.cloudTaskConcurrency = Math.max(1, Math.min(4, Number(migrated.cloudTaskConcurrency) || 2));
            }
        }
        migrated.schemaVersion = CONFIG_SCHEMA_VERSION;
        return migrated;
    }

    function saveConfig() {
        const storedConfig = cloneJson(CFG);
        storedConfig.schemaVersion = CONFIG_SCHEMA_VERSION;
        if (storedConfig.credentialsSessionOnly) {
            SENSITIVE_CONFIG_KEYS.forEach(key => {
                volatileCredentialVault[key] = storedConfig[key] || '';
                storedConfig[key] = '';
            });
        } else {
            SENSITIVE_CONFIG_KEYS.forEach(key => delete volatileCredentialVault[key]);
        }
        const configString = JSON.stringify(storedConfig);
        GM_setValue(MAIN_CONFIG_KEY, configString);
        diagnosticLog('debug', 'config', '配置已保存', {
            schemaVersion: CONFIG_SCHEMA_VERSION,
            credentialsSessionOnly: storedConfig.credentialsSessionOnly
        });
    }
    function loadConfig() {
        try {
            const raw = GM_getValue(MAIN_CONFIG_KEY);
            if (raw) {
                const parsed = migrateConfig(JSON.parse(raw));
                const config = {
                    ...DEFAULT_CONFIG,
                    ...parsed,
                    toolbarGroupState: { ...DEFAULT_CONFIG.toolbarGroupState, ...(parsed.toolbarGroupState || {}) }
                };
                if (config.credentialsSessionOnly) Object.assign(config, readSessionCredentials());
                return config;
            }
        } catch (e) {
            diagnosticLog('warning', 'config', '配置加载失败，已回退默认值', { message: e?.message });
        }
        return cloneJson(DEFAULT_CONFIG);
    }

    /*********************** 图标与控件 ***********************/
    const SVG_NS = 'http://www.w3.org/2000/svg';
    const ICON_DEFINITIONS = Object.freeze({
        arrowDown: [['path', { d: 'M12 5v14m0 0 6-6m-6 6-6-6' }]],
        arrowUp: [['path', { d: 'M12 19V5m0 0 6 6m-6-6-6 6' }]],
        bolt: [['path', { d: 'm13 2-9 12h7l-1 8 9-12h-7l1-8Z' }]],
        chart: [
            ['path', { d: 'M4 19V9m6 10V5m6 14v-7m4 7H2' }]
        ],
        checkCircle: [
            ['circle', { cx: '12', cy: '12', r: '9' }],
            ['path', { d: 'm8 12 2.5 2.5L16 9' }]
        ],
        clipboard: [
            ['rect', { x: '6', y: '5', width: '12', height: '16', rx: '2' }],
            ['path', { d: 'M9 5V3h6v2M9 10h6m-6 4h6' }]
        ],
        close: [
            ['path', { d: 'm6 6 12 12M18 6 6 18' }]
        ],
        cloud: [
            ['path', { d: 'M7 18h10a4 4 0 0 0 .6-7.95A6 6 0 0 0 6.2 8.2 4.5 4.5 0 0 0 7 18Z' }]
        ],
        database: [
            ['ellipse', { cx: '12', cy: '5', rx: '8', ry: '3' }],
            ['path', { d: 'M4 5v6c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 11v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6' }]
        ],
        download: [
            ['path', { d: 'M12 3v12m0 0 5-5m-5 5-5-5M5 21h14' }]
        ],
        errorCircle: [
            ['circle', { cx: '12', cy: '12', r: '9' }],
            ['path', { d: 'm9 9 6 6m0-6-6 6' }]
        ],
        eye: [
            ['path', { d: 'M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z' }],
            ['circle', { cx: '12', cy: '12', r: '2.5' }]
        ],
        filter: [
            ['path', { d: 'M3 5h18l-7 8v6l-4 2v-8L3 5Z' }]
        ],
        folder: [
            ['path', { d: 'M3 6.5h7l2 2h9v9.5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6.5Z' }]
        ],
        history: [
            ['path', { d: 'M3 12a9 9 0 1 0 3-6.7L3 8m0 0V3m0 5h5' }],
            ['path', { d: 'M12 7v5l3 2' }]
        ],
        image: [
            ['rect', { x: '3', y: '4', width: '18', height: '16', rx: '2' }],
            ['circle', { cx: '8.5', cy: '9', r: '1.5' }],
            ['path', { d: 'm4 17 5-5 4 4 2-2 5 5' }]
        ],
        import: [
            ['path', { d: 'M12 3v12m0 0 5-5m-5 5-5-5M5 21h14' }]
        ],
        refresh: [
            ['path', { d: 'M20 7v5h-5M4 17v-5h5' }],
            ['path', { d: 'M6.1 8A7 7 0 0 1 18.5 7M17.9 16A7 7 0 0 1 5.5 17' }]
        ],
        search: [
            ['circle', { cx: '11', cy: '11', r: '7' }],
            ['path', { d: 'm16 16 5 5' }]
        ],
        settings: [
            ['circle', { cx: '12', cy: '12', r: '3' }],
            ['path', { d: 'M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H2.8v-4H3a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1a1.7 1.7 0 0 0 1.9.3A1.7 1.7 0 0 0 10 3V2.8h4V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v4H21a1.7 1.7 0 0 0-1.6 1Z' }]
        ],
        trash: [
            ['path', { d: 'M4 7h16M9 3h6l1 4H8l1-4Zm-3 4 1 14h10l1-14M10 11v6m4-6v6' }]
        ],
        upload: [
            ['path', { d: 'M12 15V3m0 0 5 5m-5-5-5 5M5 21h14' }]
        ],
        user: [
            ['circle', { cx: '12', cy: '8', r: '4' }],
            ['path', { d: 'M4 21a8 8 0 0 1 16 0' }]
        ],
        warning: [
            ['path', { d: 'M12 3 2.5 20h19L12 3Z' }],
            ['path', { d: 'M12 9v4m0 3h.01' }]
        ],
        wrench: [
            ['path', { d: 'M14.5 6.5a4 4 0 0 0-5-5L7 4l3 3-3 3-3-3-2.5 2.5a4 4 0 0 0 5 5L15 23l4-4-8.5-8.5' }]
        ]
    });

    function createIcon(name, size = 16) {
        const definition = ICON_DEFINITIONS[name];
        if (!definition) throw new Error(`未知图标: ${name}`);

        const svg = document.createElementNS(SVG_NS, 'svg');
        svg.setAttribute('viewBox', '0 0 24 24');
        svg.setAttribute('width', String(size));
        svg.setAttribute('height', String(size));
        svg.setAttribute('fill', 'none');
        svg.setAttribute('stroke', 'currentColor');
        svg.setAttribute('stroke-width', '1.8');
        svg.setAttribute('stroke-linecap', 'round');
        svg.setAttribute('stroke-linejoin', 'round');
        svg.setAttribute('aria-hidden', 'true');
        svg.setAttribute('focusable', 'false');
        svg.style.flex = '0 0 auto';

        definition.forEach(([tag, attributes]) => {
            const node = document.createElementNS(SVG_NS, tag);
            Object.entries(attributes).forEach(([key, value]) => node.setAttribute(key, value));
            svg.appendChild(node);
        });
        return svg;
    }

    function setIconLabel(element, iconName, label = '', size = 16) {
        element.replaceChildren(createIcon(iconName, size));
        if (label) element.appendChild(document.createTextNode(label));
        if (element instanceof HTMLButtonElement) {
            element.type = 'button';
            element.style.display = 'inline-flex';
            element.style.alignItems = 'center';
            element.style.justifyContent = 'center';
            element.style.gap = '5px';
        }
        return element;
    }

    /*********************** 工具函数 ***********************/
    const extOf = (n = '') => (n.toLowerCase().match(/\.([a-z0-9]+)(?:\?|$)/) || [])[1] || '';
    const isTextLike = n => CFG.textExts.includes(extOf(n));
    const isZip = n => extOf(n) === 'zip';
    const isRar = n => extOf(n) === 'rar';
    const absoluteUrl = href => { try { return new URL(href, location.origin).toString(); } catch { return href; } };
    const hostnameOf = url => { try { return new URL(url, location.origin).hostname; } catch { return ''; } };
    function analyzeDecodedText(str) {
        const stats = {
            length: str.length,
            replacement: 0,
            nulls: 0,
            controls: 0,
            whitespace: 0,
            letters: 0,
            vowels: 0,
            digits: 0,
            cjk: 0,
            hiragana: 0,
            katakana: 0,
            hangul: 0,
            punctuation: 0,
            asciiPrintable: 0,
            otherPrintable: 0,
            unique: new Set(),
        };
        for (const ch of str) {
            const code = ch.charCodeAt(0);
            stats.unique.add(ch);
            if (code === 0) { stats.nulls++; continue; }
            if (code === 0xFFFD) stats.replacement++;
            if (code < 0x20) {
                if (code === 0x09 || code === 0x0A || code === 0x0D) stats.whitespace++;
                else stats.controls++;
                continue;
            }
            if (code === 0x20 || code === 0xA0) {
                stats.whitespace++;
                continue;
            }
            if ((code >= 0x41 && code <= 0x5A) || (code >= 0x61 && code <= 0x7A)) {
                stats.letters++;
                if ('AEIOUaeiou'.includes(ch)) stats.vowels++;
            }
            if (code >= 0x30 && code <= 0x39) stats.digits++;
            if ((code >= 0x4E00 && code <= 0x9FFF) || (code >= 0x3400 && code <= 0x4DBF)) stats.cjk++;
            if (code >= 0x3040 && code <= 0x309F) stats.hiragana++;
            if (code >= 0x30A0 && code <= 0x30FF) stats.katakana++;
            if (code >= 0xAC00 && code <= 0xD7A3) stats.hangul++;
            if ((code >= 0x21 && code <= 0x2F) || (code >= 0x3A && code <= 0x40) || (code >= 0x5B && code <= 0x60) || (code >= 0x7B && code <= 0x7E)) {
                stats.punctuation++;
            }
            if (code >= 0x20 && code <= 0x7E) stats.asciiPrintable++;
            else stats.otherPrintable++;
        }
        stats.uniqueCount = stats.unique.size;
        stats.uniqueRatio = stats.uniqueCount / Math.max(1, stats.length);
        stats.asciiPrintableRatio = stats.asciiPrintable / Math.max(1, stats.length);
        stats.cjkRatio = stats.cjk / Math.max(1, stats.length);
        stats.letterRatio = stats.letters / Math.max(1, stats.length);
        stats.whitespaceRatio = stats.whitespace / Math.max(1, stats.length);
        stats.vowelRatio = stats.vowels / Math.max(1, stats.length);
        return stats;
    }

    function scoreDecodedStats(stats, encoding, extra = 0) {
        if (!stats || stats.length === 0) return -Infinity;
        if (stats.replacement > 0 || stats.nulls > 0 || stats.controls > Math.max(1, stats.length * 0.02)) {
            return -Infinity;
        }
        let score = extra;
        score += stats.cjk * 4.0;
        score += (stats.hiragana + stats.katakana + stats.hangul) * 3.5;
        score += stats.letters * 3.0;
        score += stats.digits * 1.6;
        score += stats.whitespace * 0.8;
        score += stats.punctuation * 0.1;
        score += stats.asciiPrintable * 0.1;
        score += stats.otherPrintable * 0.6;
        score += stats.uniqueCount * 0.2;
        score += stats.vowels * 0.4;
        if (encoding.startsWith('utf-16')) score += 1.0;
        if (encoding === 'utf-8') score += 0.5;
        if (stats.uniqueRatio < 0.05 && stats.length > 20) score -= 5;
        return score;
    }

    function computePairSimilarity(buf) {
        const even = new Array(256).fill(0);
        const odd = new Array(256).fill(0);
        let pairs = 0;
        for (let i = 0; i + 1 < buf.length; i += 2) {
            even[buf[i]]++;
            odd[buf[i + 1]]++;
            pairs++;
        }
        if (!pairs) return 1;
        let dot = 0, evenNorm = 0, oddNorm = 0;
        for (let i = 0; i < 256; i++) {
            dot += even[i] * odd[i];
            evenNorm += even[i] * even[i];
            oddNorm += odd[i] * odd[i];
        }
        if (!evenNorm || !oddNorm) return 1;
        return dot / Math.sqrt(evenNorm * oddNorm);
    }

    function computeUtf16Heuristics(buf) {
        let zeroEven = 0;
        let zeroOdd = 0;
        let pairs = 0;
        for (let i = 0; i + 1 < buf.length; i += 2) {
            if (buf[i] === 0) zeroEven++;
            if (buf[i + 1] === 0) zeroOdd++;
            pairs++;
        }
        const similarity = computePairSimilarity(buf);
        return { pairs, zeroEven, zeroOdd, similarity };
    }

    function decodeBest(buf, debugName = '') {
        const data = buf instanceof Uint8Array
            ? buf
            : buf instanceof ArrayBuffer
                ? new Uint8Array(buf)
                : toU8(buf);
        if (!data || !data.length) {
            console.log(`[编码检测] ${debugName} 无有效字节输入`);
            return '';
        }

        // 1. 优先检测 BOM（最可靠）
        if (data.length >= 3) {
            if (data[0] === 0xEF && data[1] === 0xBB && data[2] === 0xBF) {
                try {
                    const bomDecoded = new TextDecoder('utf-8').decode(data.slice(3));
                    console.log(`[编码检测] ${debugName} 使用 UTF-8 BOM 解码`);
                    return bomDecoded;
                } catch { }
            }
            if (data[0] === 0xFF && data[1] === 0xFE) {
                try {
                    const bomDecoded = new TextDecoder('utf-16le').decode(data.slice(2));
                    console.log(`[编码检测] ${debugName} 使用 UTF-16LE BOM 解码`);
                    return bomDecoded;
                } catch { }
            }
            if (data[0] === 0xFE && data[1] === 0xFF) {
                try {
                    const bomDecoded = new TextDecoder('utf-16be').decode(data.slice(2));
                    console.log(`[编码检测] ${debugName} 使用 UTF-16BE BOM 解码`);
                    return bomDecoded;
                } catch { }
            }
        }

        const candidates = [];
        const utf16Heur = computeUtf16Heuristics(data);
        const pairs = utf16Heur.pairs;
        const ratioEvenZero = pairs ? utf16Heur.zeroEven / pairs : 0;
        const ratioOddZero = pairs ? utf16Heur.zeroOdd / pairs : 0;
        const utf16Similarity = utf16Heur.similarity;
        const suspectUtf16 = data.length >= 4 && data.length % 2 === 0 &&
            (utf16Similarity < 0.2 || ratioEvenZero > 0.4 || ratioOddZero > 0.4);
        console.log(`[编码检测] ${debugName} UTF-16 启发式`, {
            length: data.length,
            pairs,
            zeroEven: utf16Heur.zeroEven,
            zeroOdd: utf16Heur.zeroOdd,
            ratioEvenZero,
            ratioOddZero,
            similarity: utf16Similarity,
            suspectUtf16
        });

        function addCandidateFromDecoded(decoded, encoding, extra = 0) {
            const stats = analyzeDecodedText(decoded);
            const score = scoreDecodedStats(stats, encoding, extra);
            if (score === -Infinity) return;
            candidates.push({ encoding, decoded, stats, score });
            console.log(`[编码检测] ${debugName} 候选 ${encoding} 分数:`, score, stats);
        }

        function tryAdd(encoding, extra = 0, decoderOptions) {
            let adjustedExtra = extra;
            if (suspectUtf16 && !encoding.startsWith('utf-16')) {
                adjustedExtra -= encoding === 'utf-8' ? 5 : 25;
            }
            try {
                const decoded = new TextDecoder(encoding, decoderOptions).decode(data);
                addCandidateFromDecoded(decoded, encoding, adjustedExtra);
            } catch (error) {
                console.log(`[编码检测] ${debugName} 尝试 ${encoding} 解码失败:`, error);
            }
        }

        // 2. 优先尝试 UTF-8（兼容 ASCII，Web 标准）
        tryAdd('utf-8');

        // 3. 使用 jschardet 检测（作为参考）
        function detectEncoding(buffer) {
            try {
                if (typeof jschardet !== 'undefined' && jschardet.detect) {
                    const result = jschardet.detect(buffer);
                    console.log(`[编码检测] ${debugName} jschardet 结果:`, result);
                    if (result && result.encoding) {
                        return { encoding: String(result.encoding).toLowerCase(), confidence: result.confidence ?? 0 };
                    }
                }
            } catch (error) {
                console.log(`[编码检测] ${debugName} jschardet 失败:`, error);
            }
            return null;
        }

        const detected = detectEncoding(data);
        if (detected && detected.encoding && detected.encoding !== 'utf-8') {
            const normalized = detected.encoding.replace(/[^a-z0-9\-]/g, '');
            if (normalized) {
                const extraScore = detected.confidence ? detected.confidence * 20 : 0;
                tryAdd(normalized, extraScore);
            }
        }

        // 3.b 根据字节分布启发式尝试 UTF-16
        if (suspectUtf16) {
            const similarityBoost = Math.max(0, (0.2 - utf16Similarity) * 80);
            const leBias = Math.max(0, ratioOddZero - ratioEvenZero) * 40;
            const beBias = Math.max(0, ratioEvenZero - ratioOddZero) * 40;
            tryAdd('utf-16le', similarityBoost + leBias);
            tryAdd('utf-16be', similarityBoost + beBias);
        }

        // 4. 尝试常见中文编码
        const chineseEncodings = ['gbk', 'gb18030', 'big5'];
        for (const encoding of chineseEncodings) {
            tryAdd(encoding);
        }

        // 5. 尝试其他编码
        const otherEncodings = ['shift_jis', 'euc-jp', 'iso-8859-1'];
        for (const encoding of otherEncodings) {
            tryAdd(encoding);
        }

        if (candidates.length > 0) {
            candidates.sort((a, b) => b.score - a.score);
            const utf8Candidate = candidates.find(c => c.encoding === 'utf-8');
            const bestUtf16Candidate = candidates.find(c => c.encoding.startsWith('utf-16'));
            let best = candidates[0];
            if (suspectUtf16 && bestUtf16Candidate && !best.encoding.startsWith('utf-16')) {
                const diff = bestUtf16Candidate.score - best.score;
                if (diff >= -40) {
                    console.log(`[编码检测] ${debugName} 启发式选择 UTF-16 候选，分差:`, diff);
                    best = bestUtf16Candidate;
                }
            }
            if (utf8Candidate && best.encoding !== 'utf-8') {
                const diff = best.score - utf8Candidate.score;
                if (diff < 12 && utf8Candidate.stats.letterRatio >= 0.2 && utf8Candidate.stats.asciiPrintableRatio >= 0.7) {
                    console.log(`[编码检测] ${debugName} 采用 UTF-8 候选，得分差 ${diff}`);
                    best = utf8Candidate;
                }
            }
            console.log(`[编码检测] ${debugName} 最终选用编码:`, best.encoding, '得分:', best.score);
            return best.decoded;
        }

        // 6. 最后降级：使用 UTF-8 即使有乱码
        try {
            const fallbackDecoded = new TextDecoder('utf-8').decode(data);
            console.log(`[编码检测] ${debugName} 使用 UTF-8 降级解码（可能有乱码）`);
            return fallbackDecoded;
        } catch {
            // 兜底：返回原始字节的字符串表示
            console.log(`[编码检测] ${debugName} 所有编码尝试失败，使用原始字节`);
            return String.fromCharCode(...data.slice(0, 1000));
        }
    }
    function formatBytes(n) { if (n < 1024) return n + ' B'; if (n < 1024 ** 2) return (n / 1024).toFixed(2) + ' KB'; if (n < 1024 ** 3) return (n / 1024 ** 2).toFixed(2) + ' MB'; return (n / 1024 ** 3).toFixed(2) + ' GB'; }
    function parseSizeBytesFromSpan(span) {
        const em = span?.querySelector?.('em.xg1'); if (!em) return null; const t = em.textContent || '';
        const b = t.match(/([\d,.]+)\s*Bytes/i); if (b) return Math.floor(Number(b[1].replace(/[,.\s]/g, '')));
        const u = t.match(/([\d.]+)\s*(KB|MB|GB)/i); if (u) { const n = parseFloat(u[1]); const mul = u[2].toUpperCase() === 'KB' ? 1024 : u[2].toUpperCase() === 'MB' ? 1024 ** 2 : 1024 ** 3; return Math.floor(n * mul); }
        return null;
    }

    /*********************** 自定义Modal组件 ***********************/
    // 创建自定义Modal
    function createModal(title, message, type = 'info', { showConfirm = true } = {}) {
        // 移除已存在的modal
        const existingModal = document.querySelector('#sht-modal');
        if (existingModal) {
            existingModal.remove();
        }

        const modal = document.createElement('div');
        modal.id = 'sht-modal';
        modal.setAttribute('role', 'dialog');
        modal.setAttribute('aria-modal', 'true');
        modal.setAttribute('aria-labelledby', 'sht-modal-title');
        modal.style.cssText = `
    position: fixed;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    background: rgba(0, 0, 0, 0.5);
    display: flex;
    justify-content: center;
    align-items: center;
    z-index: 10000;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  `;

        const modalContent = document.createElement('div');
        modalContent.className = 'modal-content';
        modalContent.style.cssText = `
    background: white;
    border-radius: 8px;
    padding: 24px;
    max-width: 400px;
    width: 90%;
    box-shadow: 0 10px 25px rgba(0, 0, 0, 0.2);
    text-align: center;
    position: relative;
  `;

        // 标题
        const titleEl = document.createElement('h3');
        titleEl.id = 'sht-modal-title';
        titleEl.textContent = title;
        titleEl.style.cssText = `
    margin: 0 0 16px 0;
    font-size: 18px;
    font-weight: 600;
    color: #333;
  `;

        // 消息内容
        const messageEl = document.createElement('div');
        messageEl.textContent = message;
        messageEl.style.cssText = `
    margin: 0 0 24px 0;
    font-size: 14px;
    line-height: 1.5;
    color: #666;
    white-space: pre-line;
  `;

        // 按钮容器
        const buttonContainer = document.createElement('div');
        buttonContainer.style.cssText = `
    display: flex;
    gap: 12px;
    justify-content: center;
  `;

        // 确定按钮
        const confirmBtn = document.createElement('button');
        confirmBtn.textContent = '确定';
        confirmBtn.style.cssText = `
    padding: 8px 24px;
    border: none;
    border-radius: 4px;
    font-size: 14px;
    cursor: pointer;
    transition: background-color 0.2s;
  `;

        // 根据类型设置颜色
        if (type === 'success') {
            confirmBtn.style.background = '#28a745';
            confirmBtn.style.color = 'white';
        } else if (type === 'error') {
            confirmBtn.style.background = '#dc3545';
            confirmBtn.style.color = 'white';
        } else if (type === 'warning') {
            confirmBtn.style.background = '#ffc107';
            confirmBtn.style.color = '#212529';
        } else {
            confirmBtn.style.background = '#007bff';
            confirmBtn.style.color = 'white';
        }

        confirmBtn.addEventListener('mouseenter', () => {
            confirmBtn.style.opacity = '0.9';
        });
        confirmBtn.addEventListener('mouseleave', () => {
            confirmBtn.style.opacity = '1';
        });

        const previouslyFocused = document.activeElement;
        let closed = false;

        // 关闭modal
        const closeModal = () => {
            if (closed) return;
            closed = true;
            document.removeEventListener('keydown', handleKeyDown);
            modal.remove();
            if (previouslyFocused instanceof HTMLElement && previouslyFocused.isConnected) {
                previouslyFocused.focus();
            }
        };

        confirmBtn.addEventListener('click', closeModal);
        modal.addEventListener('click', (e) => {
            if (e.target === modal) {
                closeModal();
            }
        });

        // ESC键关闭
        const handleKeyDown = (e) => {
            if (e.key === 'Escape') {
                closeModal();
            } else if (e.key === 'Tab') {
                const focusable = [...modal.querySelectorAll('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href]')];
                if (!focusable.length) return;
                const first = focusable[0];
                const last = focusable[focusable.length - 1];
                if (e.shiftKey && document.activeElement === first) {
                    e.preventDefault();
                    last.focus();
                } else if (!e.shiftKey && document.activeElement === last) {
                    e.preventDefault();
                    first.focus();
                }
            }
        };
        document.addEventListener('keydown', handleKeyDown);

        modalContent.appendChild(titleEl);
        modalContent.appendChild(messageEl);
        if (showConfirm) {
            buttonContainer.appendChild(confirmBtn);
            modalContent.appendChild(buttonContainer);
        }
        modal.appendChild(modalContent);
        document.body.appendChild(modal);

        if (showConfirm) {
            confirmBtn.focus();
        } else {
            modalContent.tabIndex = -1;
            modalContent.focus();
        }

        modal.closeSht = closeModal;
        return modal;
    }

    // 显示成功消息
    function showSuccessModal(message) {
        return createModal('操作成功', message, 'success');
    }

    // 显示错误消息
    function showErrorModal(message) {
        return createModal('操作失败', message, 'error');
    }

    // 显示警告消息
    function showWarningModal(message) {
        return createModal('警告', message, 'warning');
    }

    // 显示信息消息
    function showInfoModal(message) {
        return createModal('提示', message, 'info');
    }

    function cloneJson(value) {
        return JSON.parse(JSON.stringify(value));
    }

    function readSearchConfig() {
        try {
            const raw = GM_getValue(SEARCH_CONFIG_KEY);
            if (!raw) return null;
            return typeof raw === 'string' ? JSON.parse(raw) : cloneJson(raw);
        } catch (error) {
            console.warn('[SHT] 搜索配置读取失败:', error);
            return null;
        }
    }

    function createConfigExport(includeSensitive = false) {
        const mainConfig = cloneJson(CFG);
        // 历史记录有单独导出入口，避免配置文件无限膨胀。
        delete mainConfig.historyItems;
        if (!includeSensitive) {
            SENSITIVE_CONFIG_KEYS.forEach(key => delete mainConfig[key]);
        }

        return {
            format: 'sht-helper-config',
            version: CONFIG_EXPORT_VERSION,
            exportTime: new Date().toISOString(),
            includesSensitiveCredentials: includeSensitive,
            config: mainConfig,
            searchConfig: readSearchConfig()
        };
    }

    function sanitizeImportedObject(input, defaults, label) {
        if (!input || typeof input !== 'object' || Array.isArray(input)) {
            throw new Error(`${label}不是有效对象`);
        }

        const output = {};
        for (const [key, defaultValue] of Object.entries(defaults)) {
            if (!Object.prototype.hasOwnProperty.call(input, key)) continue;
            const value = input[key];
            if (Array.isArray(defaultValue)) {
                if (!Array.isArray(value)) throw new Error(`${label}.${key} 类型无效`);
                output[key] = cloneJson(value.slice(0, 5000));
            } else if (defaultValue && typeof defaultValue === 'object') {
                if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label}.${key} 类型无效`);
                output[key] = cloneJson(value);
            } else if (typeof defaultValue === 'number') {
                if (!Number.isFinite(value)) throw new Error(`${label}.${key} 必须是有限数字`);
                output[key] = value;
            } else if (typeof value === typeof defaultValue) {
                output[key] = value;
            } else {
                throw new Error(`${label}.${key} 类型无效`);
            }
        }
        return output;
    }

    function sanitizeImportedSearchConfig(input) {
        if (input == null) return null;
        if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('searchConfig 不是有效对象');
        const defaults = {
            sortBy: null,
            sortDir: 'desc',
            secondarySort: null,
            secondaryDir: 'desc',
            onlyQuota: false,
            filterQiuPian: false,
            highlightEnabled: false,
            highlightThreshold: 'auto',
            lastUsed: 0
        };
        const sortKeys = [null, 'quota', 'fileSize', 'replies', 'views', 'postDate'];
        const sanitized = { ...defaults };
        if (!sortKeys.includes(input.sortBy ?? null) || !sortKeys.includes(input.secondarySort ?? null)) {
            throw new Error('searchConfig 排序字段无效');
        }
        if (input.sortDir != null && !['asc', 'desc'].includes(input.sortDir)) throw new Error('searchConfig.sortDir 无效');
        if (input.secondaryDir != null && !['asc', 'desc'].includes(input.secondaryDir)) throw new Error('searchConfig.secondaryDir 无效');
        if (input.highlightThreshold != null && !['auto', 'low', 'medium', 'high'].includes(input.highlightThreshold)) {
            throw new Error('searchConfig.highlightThreshold 无效');
        }
        sanitized.sortBy = input.sortBy ?? null;
        sanitized.secondarySort = input.secondarySort ?? null;
        if (input.sortDir != null) sanitized.sortDir = input.sortDir;
        if (input.secondaryDir != null) sanitized.secondaryDir = input.secondaryDir;
        if (input.highlightThreshold != null) sanitized.highlightThreshold = input.highlightThreshold;
        ['onlyQuota', 'filterQiuPian', 'highlightEnabled'].forEach(key => {
            if (input[key] != null) {
                if (typeof input[key] !== 'boolean') throw new Error(`searchConfig.${key} 类型无效`);
                sanitized[key] = input[key];
            }
        });
        if (input.lastUsed != null) {
            if (!Number.isFinite(input.lastUsed)) throw new Error('searchConfig.lastUsed 必须是有限数字');
            sanitized.lastUsed = input.lastUsed;
        }
        return sanitized;
    }

    function buildConfigDiffPreview(mainConfig, searchConfig) {
        const changed = [];
        Object.entries(mainConfig).forEach(([key, value]) => {
            if (JSON.stringify(CFG[key]) === JSON.stringify(value)) return;
            changed.push(SENSITIVE_CONFIG_KEYS.includes(key) ? `${key}: [敏感值已隐藏]` : `${key}: 将更新`);
        });
        if (searchConfig) changed.push('searchConfig: 将更新搜索排序、筛选和高亮设置');
        const visible = changed.slice(0, 30);
        if (changed.length > visible.length) visible.push(`……另有 ${changed.length - visible.length} 项`);
        return visible.length ? visible.join('\n') : '没有检测到配置差异。';
    }

    // 导出配置；敏感凭据默认不包含。
    function exportConfig(includeSensitive = false) {
        try {
            const configToExport = createConfigExport(includeSensitive);
            const blob = new Blob([JSON.stringify(configToExport, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `sht_config_${new Date().toISOString().slice(0, 10)}.json`;
            a.click();
            URL.revokeObjectURL(url);

            showSuccessModal(`配置导出成功！\n\n${includeSensitive ? '已包含网盘凭据，请妥善保管。' : '未包含网盘 Cookie、Token 等敏感凭据。'}`);
        } catch (error) {
            console.error('导出配置失败:', error);
            showErrorModal('导出配置失败: ' + error.message);
        }
    }

    // 导入配置
    function importConfig() {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.json';
        input.style.display = 'none';

        input.addEventListener('change', (e) => {
            const file = e.target.files[0];

            // 清理input元素
            if (input.parentNode) {
                input.parentNode.removeChild(input);
            }

            if (!file) {
                console.log('用户取消了文件选择');
                return;
            }
            if (file.size > 2 * 1024 * 1024) {
                showErrorModal('配置文件过大，最大支持 2 MB。历史记录请使用独立导入/导出功能。');
                return;
            }

            const reader = new FileReader();
            reader.onload = async (e) => {
                try {
                    const importedData = JSON.parse(e.target.result);

                    // 兼容旧版导出，但只接受白名单字段和匹配的基础类型。
                    if (!importedData || !importedData.config || !importedData.version) {
                        throw new Error('无效的配置文件格式');
                    }

                    const mainConfig = migrateConfig(sanitizeImportedObject(importedData.config, DEFAULT_CONFIG, 'config'));
                    const searchConfig = sanitizeImportedSearchConfig(importedData.searchConfig);
                    const importsCredentials = SENSITIVE_CONFIG_KEYS.some(key =>
                        Object.prototype.hasOwnProperty.call(mainConfig, key) && Boolean(mainConfig[key])
                    );

                    const confirmMessage = `版本: ${importedData.version}\n导出时间: ${importedData.exportTime || '未知'}\n敏感凭据: ${importsCredentials ? '包含' : '不包含（保留本机现有凭据）'}\n\n变更预览：\n${buildConfigDiffPreview(mainConfig, searchConfig)}\n\n只会覆盖文件中包含的有效设置。`;
                    if (!await confirmAction(confirmMessage, { title: '导入配置预览', confirmText: '确认导入' })) return;

                    Object.assign(CFG, mainConfig);
                    saveConfig();
                    if (searchConfig) GM_setValue(SEARCH_CONFIG_KEY, JSON.stringify(searchConfig));

                    if (CFG.credentialsSessionOnly) {
                        showSuccessModal('配置导入成功！\n\n临时凭据已在当前页面内存中生效，刷新或离开页面即清除。');
                    } else {
                        showSuccessModal('配置导入成功！\n\n页面将自动刷新以应用新设置。未包含的敏感凭据已保留。');
                        setTimeout(() => location.reload(), 2000);
                    }

                } catch (error) {
                    console.error('导入配置失败:', error);
                    showErrorModal('导入配置失败: ' + error.message);
                }
            };

            reader.readAsText(file);
        });

        // 添加取消事件监听器
        input.addEventListener('cancel', () => {
            console.log('用户取消了文件选择');
            if (input.parentNode) {
                input.parentNode.removeChild(input);
            }
        });

        document.body.appendChild(input);
        input.click();
    }

    // 重置配置
    async function resetConfig() {
        if (!await confirmAction('这将清除所有自定义设置，包括历史记录和会话凭据。', {
            title: '重置全部配置', confirmText: '确认重置', danger: true
        })) return;

        try {
            // 重置为默认配置
            Object.keys(CFG).forEach(key => delete CFG[key]);
            Object.assign(CFG, cloneJson(DEFAULT_CONFIG));

            // 清空历史记录
            CFG.historyItems = [];
            SENSITIVE_CONFIG_KEYS.forEach(key => delete volatileCredentialVault[key]);

            // 保存配置
            saveConfig();

            showSuccessModal('配置已重置为默认值！\n\n页面将自动刷新以应用新设置。');

            // 延迟刷新页面
            setTimeout(() => {
                location.reload();
            }, 2000);

        } catch (error) {
            console.error('重置配置失败:', error);
            showErrorModal('重置配置失败: ' + error.message);
        }
    }

    // ED2K文件名正则替换处理
    function processEd2kFileName(fileName) {
        if (!CFG.ed2kFileNameReplaceEnabled || !CFG.ed2kFileNameReplaceRules || CFG.ed2kFileNameReplaceRules.length === 0) {
            return fileName;
        }

        let processedName = fileName;

        try {
            for (let i = 0; i < CFG.ed2kFileNameReplaceRules.length; i++) {
                const rule = CFG.ed2kFileNameReplaceRules[i];
                if (rule.pattern && rule.replacement !== undefined) {
                    const regex = new RegExp(rule.pattern, 'g');
                    processedName = processedName.replace(regex, rule.replacement);
                }
            }

            // 清理多余的空格
            processedName = processedName.replace(/\s+/g, ' ').trim();
            return processedName;
        } catch (error) {
            console.error('ED2K文件名正则替换失败:', error);
            return fileName; // 出错时返回原文件名
        }
    }

    // 处理ED2K链接中的文件名
    function processEd2kLink(ed2kLink) {
        if (!CFG.ed2kFileNameReplaceEnabled || !CFG.ed2kFileNameReplaceRules || CFG.ed2kFileNameReplaceRules.length === 0) {
            return ed2kLink;
        }

        try {
            // ED2K链接格式: ed2k://|file|filename|filesize|hash|/
            const ed2kRegex = /^(ed2k:\/\/\|file\|)([^|]+)(\|[^|]+\|[^|]+\|.*)$/;
            const match = ed2kLink.match(ed2kRegex);

            if (match) {
                const prefix = match[1];
                const originalFileName = match[2];
                const suffix = match[3];

                const processedFileName = processEd2kFileName(originalFileName);
                return prefix + processedFileName + suffix;
            }

            return ed2kLink; // 如果格式不匹配，返回原链接
        } catch (error) {
            console.error('ED2K链接处理失败:', error);
            return ed2kLink; // 出错时返回原链接
        }
    }

    /*********************** 网盘提供方适配层 ***********************/
    const CLOUD_PROVIDERS = Object.freeze({
        pan115: {
            id: 'pan115',
            label: '115',
            isEnabled: () => Boolean(CFG.pan115Enabled),
            isConfigured: () => Boolean(CFG.pan115Cookie?.trim()),
            testConnection: credentials => testPan115Connection(credentials),
            submitBatch: (items, options = {}) => pan115AddTasks(items, { signal: options.signal })
        },
        pan123: {
            id: 'pan123',
            label: '123Pan',
            isEnabled: () => Boolean(CFG.pan123Enabled),
            isConfigured: () => Boolean(CFG.pan123Token && CFG.pan123LoginUuid && CFG.pan123Cookie),
            testConnection: credentials => testPan123Connection(credentials),
            submitOne: (item, options = {}) => processSingleMagnetOffline(item, item, { signal: options.signal })
        }
    });

    function getCloudProvider(id) {
        const provider = CLOUD_PROVIDERS[id];
        if (!provider) throw new Error(`未知网盘提供方: ${id}`);
        return provider;
    }

    async function testCloudProviderConnection(id, credentials) {
        const provider = getCloudProvider(id);
        diagnosticLog('debug', 'cloud-provider', `开始测试 ${provider.label} 连接`);
        const result = await provider.testConnection(credentials);
        diagnosticLog('debug', 'cloud-provider', `${provider.label} 连接测试成功`);
        return result;
    }

    function queueCloudProviderTask(id, run, options = {}) {
        const provider = getCloudProvider(id);
        return cloudTaskQueue.add(run, {
            label: options.label || `${provider.label} 任务`,
            retries: options.retries ?? 1,
            signal: options.signal || null
        });
    }

    /*********************** 页面类型与顶部聚合区 ***********************/
    function classifyPage(href) {
        const url = new URL(href);
        const mod = url.searchParams.get('mod');
        const isForumScript = /\/forum\.php$/i.test(url.pathname);
        return {
            isSearchPage: /\/search\.php$/i.test(url.pathname) && mod === 'forum',
            isThreadPage: isForumScript && mod === 'viewthread',
            isForumListPage: isForumScript && mod === 'forumdisplay',
            isForumHomePage: (isForumScript && !mod) ||
                (url.pathname === '/' && /(^|\.)sehuatang\.org$/i.test(url.hostname))
        };
    }
    const { isSearchPage, isThreadPage, isForumListPage, isForumHomePage } = classifyPage(location.href);

    // 帖子专用工具只能在帖子详情页创建，避免首页、版块页和跳转页出现空工具栏。
    const agg = isThreadPage ? ensureAggregator() : null;
    function ensureAggregator() {
        const c = document.createElement('div');
        c.id = 'sht-aggregator';
        c.style.cssText = 'border:1px solid #ddd;border-radius:8px;padding:10px;margin:10px 0;background:#fafafa;box-shadow:0 1px 3px rgba(0,0,0,.04)';
        const title = document.createElement('div'); title.style.cssText = 'display:flex;align-items:center;gap:8px;flex-wrap:wrap;';
        const h = document.createElement('strong'); h.textContent = '附件文本汇总 / 实用工具'; h.style.fontSize = '16px';
        const btn = (label, icon, fn, type = 'default') => {
            const b = document.createElement('button');
            b.type = 'button';
            setIconLabel(b, icon, label);

            // 根据按钮类型设置不同的样式
            let baseStyle, hoverStyle, normalStyle;

            switch (type) {
                case 'primary':
                    baseStyle = 'background: linear-gradient(135deg, #007cba 0%, #005a87 100%); color: white; border: 1px solid #005a87;';
                    hoverStyle = 'background: linear-gradient(135deg, #005a87 0%, #004066 100%); border-color: #004066;';
                    normalStyle = 'background: linear-gradient(135deg, #007cba 0%, #005a87 100%); border-color: #005a87;';
                    break;
                case 'success':
                    baseStyle = 'background: linear-gradient(135deg, #28a745 0%, #1e7e34 100%); color: white; border: 1px solid #1e7e34;';
                    hoverStyle = 'background: linear-gradient(135deg, #1e7e34 0%, #155724 100%); border-color: #155724;';
                    normalStyle = 'background: linear-gradient(135deg, #28a745 0%, #1e7e34 100%); border-color: #1e7e34;';
                    break;
                case 'warning':
                    baseStyle = 'background: linear-gradient(135deg, #ffc107 0%, #e0a800 100%); color: #212529; border: 1px solid #e0a800;';
                    hoverStyle = 'background: linear-gradient(135deg, #e0a800 0%, #d39e00 100%); border-color: #d39e00;';
                    normalStyle = 'background: linear-gradient(135deg, #ffc107 0%, #e0a800 100%); border-color: #e0a800;';
                    break;
                case 'info':
                    baseStyle = 'background: linear-gradient(135deg, #17a2b8 0%, #138496 100%); color: white; border: 1px solid #138496;';
                    hoverStyle = 'background: linear-gradient(135deg, #138496 0%, #0f6674 100%); border-color: #0f6674;';
                    normalStyle = 'background: linear-gradient(135deg, #17a2b8 0%, #138496 100%); border-color: #138496;';
                    break;
                default:
                    baseStyle = 'background: linear-gradient(135deg, #f8f9fa 0%, #e9ecef 100%); color: #495057; border: 1px solid #ddd;';
                    hoverStyle = 'background: linear-gradient(135deg, #e9ecef 0%, #dee2e6 100%); border-color: #adb5bd;';
                    normalStyle = 'background: linear-gradient(135deg, #f8f9fa 0%, #e9ecef 100%); border-color: #ddd;';
            }

            b.style.cssText = `
        padding: 6px 12px;
        margin: 2px;
        border-radius: 4px;
        cursor: pointer;
        font-size: 12px;
        font-weight: 500;
        transition: all 0.2s ease;
        box-shadow: 0 1px 3px rgba(0,0,0,0.1);
        display: inline-flex;
        align-items: center;
        gap: 4px;
        ${baseStyle}
      `;

            b.addEventListener('mouseenter', () => {
                b.style.cssText = b.style.cssText.replace(normalStyle, hoverStyle);
                b.style.transform = 'translateY(-1px)';
                b.style.boxShadow = '0 2px 6px rgba(0,0,0,0.15)';
            });
            b.addEventListener('mouseleave', () => {
                b.style.cssText = b.style.cssText.replace(hoverStyle, normalStyle);
                b.style.transform = 'translateY(0)';
                b.style.boxShadow = '0 1px 3px rgba(0,0,0,0.1)';
            });
            b.addEventListener('click', fn);
            return b;
        };
        const toggle = (label, init, fn) => { const w = document.createElement('label'); w.style.cssText = 'display:inline-flex;align-items:center;gap:4px;cursor:pointer'; const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = !!init; cb.addEventListener('change', () => fn(cb.checked)); w.append(cb, document.createTextNode(label)); return w; };
        const btnCopyAll = btn('复制全部文本', 'clipboard', copyAllText, 'success');
        const btnWrap = toggle('软换行', CFG.wrapAtTop, on => { CFG.wrapAtTop = on; saveConfig(); updateWrapMode(); });
        const btnSearch = btn('过滤', 'filter', filterPrompt, 'info');
        const btnConf = btn('设置', 'settings', openSettings, 'primary');
        const btnImgToggle = btn(CFG.blockImages ? '屏蔽图片：开' : '屏蔽图片：关', 'image', () => {
            CFG.blockImages = !CFG.blockImages;
            saveConfig();
            setIconLabel(btnImgToggle, 'image', CFG.blockImages ? '屏蔽图片：开' : '屏蔽图片：关');
            if (CFG.blockImages) applyImageBlocking(true, { forceRebuild: true }); else resetImageState();
        }, 'warning');
        const btnED2K = btn('刷新 ED2K', 'refresh', () => queueED2KScan(true), 'info');
        const btnMagnet = btn('刷新磁力', 'refresh', () => queueMagnetScan(true), 'info');
        const btnAuthorOnly = btn('只看楼主', 'user', () => toggleAuthorOnly(), 'default');
        const btnHistory = btn('历史', 'history', () => openHistory(), 'default');
        const btnExport = btn('导出', 'upload', () => exportAll(), 'default');
        const btnCompact = btn(CFG.toolbarCompactMode ? '展开工具' : '极简模式', 'eye', () => {
            CFG.toolbarCompactMode = !CFG.toolbarCompactMode;
            saveConfig();
            applyCompactMode();
        }, 'default');
        let btnCreateFolder123 = null;
        if (CFG.pan123Enabled) {
            btnCreateFolder123 = btn('123 新建', 'folder', () => showCreateFolderDialog(), 'success');
            btnCreateFolder123.id = 'sht-create-folder-btn';
        }
        let btnCreateFolder115 = null;
        let btn115OneClick = null;
        if (CFG.pan115Enabled) {
            btnCreateFolder115 = btn('115 新建', 'folder', () => showCreate115FolderDialog(), 'warning');
            btnCreateFolder115.id = 'sht-create-folder-115-btn';
            btn115OneClick = btn('115 新建并离线', 'bolt', () => create115FolderAndSend(btn115OneClick), 'warning');
        }

        // 查找并移动论坛原有的收藏和评分按钮
        const originalFavBtn = document.querySelector('#k_favorite') || document.querySelector('a[href*="favorite"]') || document.querySelector('a[onclick*="favorite"]');
        const originalRateBtn = document.querySelector('#ak_rate') || document.querySelector('a[href*="rate"]') || document.querySelector('a[onclick*="rate"]');

        let favClone = null;
        if (originalFavBtn) {
            // 克隆按钮以避免移动原按钮
            favClone = originalFavBtn.cloneNode(true);
            favClone.style.cssText = 'padding:2px 8px;cursor:pointer;text-decoration:none;display:inline-block;margin:0 4px;';
        }

        let rateClone = null;
        if (originalRateBtn) {
            // 克隆按钮以避免移动原按钮
            rateClone = originalRateBtn.cloneNode(true);
            rateClone.style.cssText = 'padding:2px 8px;cursor:pointer;text-decoration:none;display:inline-block;margin:0 4px;';

            // 如果启用一键评分，替换点击事件
            if (CFG.enableQuickRate) {
                rateClone.onclick = (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    quickRate(originalRateBtn);
                };
            }
        }

        const toolbarGroups = {};
        const createToolbarGroup = (key, label, controls, defaultOpen = false) => {
            const details = document.createElement('details');
            details.open = CFG.toolbarGroupState?.[key] ?? defaultOpen;
            details.style.cssText = 'display:inline-block;border:1px solid #ddd;border-radius:5px;background:#fff;padding:2px 5px;';
            const summary = document.createElement('summary');
            summary.style.cssText = 'cursor:pointer;font-size:12px;font-weight:600;user-select:none;';
            const labelNode = document.createElement('span');
            labelNode.textContent = label;
            const badge = document.createElement('span');
            badge.style.cssText = 'display:none;margin-left:4px;padding:0 5px;border-radius:999px;background:#e6f2fa;color:#075f8f;font-size:11px;';
            summary.append(labelNode, badge);
            const body = document.createElement('span');
            body.style.cssText = 'display:inline-flex;align-items:center;gap:4px;flex-wrap:wrap;margin-left:5px;';
            body.append(...controls.filter(Boolean));
            details.addEventListener('toggle', () => {
                CFG.toolbarGroupState = { ...(CFG.toolbarGroupState || {}), [key]: details.open };
                saveConfig();
            });
            details.append(summary, body);
            toolbarGroups[key] = { details, badge };
            return details;
        };

        const tip = document.createElement('span');
        tip.className = 'sht-toolbar-tip';
        tip.style.cssText = 'font-size:12px;opacity:.7;flex-basis:100%';
        tip.textContent = '（附件依赖按需加载；网盘按钮仅在启用后显示）';
        const quickGroup = createToolbarGroup('quick', '常用', [btnCopyAll, btnWrap, btnSearch, btnConf, btnCompact], true);
        const attachmentGroup = createToolbarGroup('attachments', '附件与链接', [btnImgToggle, btnED2K, btnMagnet]);
        const cloudControls = [btnCreateFolder123, btnCreateFolder115, btn115OneClick].filter(Boolean);
        const moreGroup = createToolbarGroup('more', '更多', [btnAuthorOnly, btnHistory, btnExport, favClone, rateClone]);
        title.append(h, quickGroup, attachmentGroup);
        const cloudGroup = cloudControls.length ? createToolbarGroup('cloud', '网盘', cloudControls) : null;
        if (cloudGroup) title.append(cloudGroup);
        title.append(moreGroup, tip);
        const list = document.createElement('div'); list.id = 'sht-agg-list'; list.style.cssText = 'margin-top:8px;display:grid;gap:8px';
        const ed2kBox = document.createElement('div'); ed2kBox.id = 'sht-agg-ed2k'; ed2kBox.style.marginTop = '8px';
        const magnetBox = document.createElement('div'); magnetBox.id = 'sht-agg-magnet'; magnetBox.style.marginTop = '8px';
        c.append(title, list, ed2kBox, magnetBox);

        function applyCompactMode() {
            [attachmentGroup, cloudGroup, moreGroup].filter(Boolean).forEach(group => {
                group.style.display = CFG.toolbarCompactMode ? 'none' : 'inline-block';
            });
            setIconLabel(btnCompact, 'eye', CFG.toolbarCompactMode ? '展开工具' : '极简模式');
        }

        function updateToolbarCounts({ attachments, ed2k, magnets } = {}) {
            const setBadge = (key, value) => {
                const badge = toolbarGroups[key]?.badge;
                if (!badge || value == null) return;
                badge.textContent = String(value);
                badge.style.display = value > 0 ? 'inline-block' : 'none';
            };
            setBadge('attachments', (attachments ?? list.querySelectorAll('.sht-agg-item').length) + (ed2k ?? Number(ed2kBox.querySelector('textarea')?.dataset.count || 0)) + (magnets ?? Number(magnetBox.querySelector('textarea')?.dataset.count || 0)));
            setBadge('cloud', cloudTaskQueue.snapshot().active.length + cloudTaskQueue.snapshot().pending.length);
        }
        applyCompactMode();
        const unsubscribeTaskQueue = cloudTaskQueue.subscribe(() => updateToolbarCounts({}));
        window.addEventListener('pagehide', unsubscribeTaskQueue, { once: true });

        // 检查当前帖子对应的文件夹
        checkCurrentThreadFolder();
        if (CFG.pan115Enabled) {
            checkCurrentThreadFolder115();
        }

        // 初始化创建文件夹按钮显示
        if (CFG.pan123Enabled) updateCreateFolderButton();
        if (CFG.pan115Enabled) {
            updateCreateFolderButton115();
            refreshPan115FolderInfo();
        }
        const threadTitle = document.querySelector('#thread_subject')?.parentElement;
        (threadTitle ? threadTitle : document.body).insertAdjacentElement(threadTitle ? 'afterend' : 'afterbegin', c);

        function updateWrapMode() { c.querySelectorAll('.sht-agg-item textarea, #sht-agg-ed2k textarea, #sht-agg-magnet textarea').forEach(el => { if (CFG.wrapAtTop) { el.style.whiteSpace = 'pre-wrap'; el.style.wordBreak = 'break-word'; } else { el.style.whiteSpace = 'pre'; el.style.wordBreak = 'normal'; } }); }
        function copyAllText() {
            const chunks = [...list.querySelectorAll('.sht-agg-item textarea')].map(t => `【${t.dataset.title || '附件'}】\n${t.value}`);
            const edTa = ed2kBox.querySelector('textarea'); if (edTa && edTa.value.trim()) chunks.unshift(`【ED2K(${edTa.dataset.count || 0})】\n${edTa.value}`);
            const mgTa = magnetBox.querySelector('textarea'); if (mgTa && mgTa.value.trim()) chunks.unshift(`【磁力(${mgTa.dataset.count || 0})】\n${mgTa.value}`);
            GM_setClipboard(chunks.join('\n\n' + '-'.repeat(40) + '\n\n'));
            showToast('已复制全部文本（含 ED2K/磁力）', 'success');
        }
        async function filterPrompt() {
            const keyword = await promptText('留空即可恢复显示全部附件。', { title: '过滤聚合内容', placeholder: '输入关键词' });
            if (keyword === null) return;
            const items = list.querySelectorAll('.sht-agg-item');
            const normalizedKeyword = keyword.trim().toLowerCase();
            items.forEach(item => {
                const text = (item.textContent || '').toLowerCase();
                item.style.display = !normalizedKeyword || text.includes(normalizedKeyword) ? '' : 'none';
            });
        }
        c.updateWrapMode = updateWrapMode; c.updateToolbarCounts = updateToolbarCounts; c.list = list; c.ed2kBox = ed2kBox; c.magnetBox = magnetBox;
        c.addItem = (title, text) => {
            // 检查是否为种子文件
            const isTorrentFile = /\.torrent$/i.test(title) || text.includes('forum.php?mod=attachment') && text.includes('.torrent');

            // 检查是否为图片文件
            const isImageFile = /\.(jpg|jpeg|png|gif|webp|bmp|svg|ico)$/i.test(title);

            // 如果是图片文件，不添加到聚合区域
            if (isImageFile) {
                console.log('跳过图片文件添加到聚合区域:', title);
                return;
            }

            const card = document.createElement('div'); card.className = 'sht-agg-item'; card.style.cssText = 'border:1px solid #e6e6e6;border-radius:6px;padding:6px;background:#fff';
            const head = document.createElement('div'); head.style.cssText = 'display:flex;align-items:center;gap:8px;justify-content:space-between';
            const name = document.createElement('span'); name.textContent = title; name.style.fontWeight = '600';
            const actions = document.createElement('div'); actions.style.cssText = 'display:inline-flex;gap:6px';

            if (isTorrentFile) {
                // 种子文件特殊处理：显示下载和123Pan按钮
                const bDownload = document.createElement('button'); bDownload.textContent = '下载'; bDownload.style.cssText = 'padding:2px 8px;cursor:pointer;background:#28a745;color:white;border:none;border-radius:3px';
                const b123Pan = document.createElement('button'); b123Pan.textContent = '发送到123Pan'; b123Pan.style.cssText = 'padding:2px 8px;cursor:pointer;background:#007cba;color:white;border:none;border-radius:3px';

                bDownload.addEventListener('click', () => { window.open(text, '_blank'); });
                b123Pan.addEventListener('click', async () => {
                    await sendTorrentAttachmentToPan123(b123Pan, text, title.replace(/\.torrent$/i, ''));
                });

                actions.append(bDownload, b123Pan);
                head.append(name, actions);
                card.append(head);
            } else {
                // 普通文件处理：显示复制和折叠按钮
                const bCopy = document.createElement('button'); bCopy.textContent = '复制'; bCopy.style.cssText = 'padding:2px 8px;cursor:pointer';
                const bCol = document.createElement('button'); bCol.textContent = '折叠'; bCol.style.cssText = 'padding:2px 8px;cursor:pointer';
                const body = document.createElement('div'); const ta = document.createElement('textarea'); ta.value = text; ta.rows = Math.min(16, Math.max(6, text.split('\n').length)); ta.style.cssText = 'width:100%;box-sizing:border-box;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px'; ta.dataset.title = title;
                bCopy.addEventListener('click', () => { GM_setClipboard(ta.value); bCopy.textContent = '已复制'; setTimeout(() => bCopy.textContent = '复制', 1200); });
                bCol.addEventListener('click', () => { body.style.display = body.style.display === 'none' ? '' : 'none'; });
                actions.append(bCopy, bCol); head.append(name, actions); body.append(ta); card.append(head, body);
            }

            list.append(card); c.updateWrapMode(); c.updateToolbarCounts({}); queueED2KScan(true); queueMagnetScan(true); return card;
        };

        // 只看楼主功能 - 使用论坛自带的只看该作者功能
        let authorOnlyMode = CFG.authorOnlyMode || false;
        let threadAuthorId = null;
        let currentTid = null;

        // 初始化按钮状态
        function initAuthorOnlyButton() {
            setIconLabel(btnAuthorOnly, 'user', authorOnlyMode ? '显示全部' : '只看楼主');
            btnAuthorOnly.style.background = authorOnlyMode ? '#ff6b6b' : '';
            btnAuthorOnly.style.color = authorOnlyMode ? 'white' : '';
        }

        // 获取楼主UID
        function getThreadAuthorId() {
            const tid = getThreadId();
            if (!tid) return null;

            // 如果当前帖子的UID已经获取过，直接返回
            if (threadAuthorId && currentTid === tid) {
                return threadAuthorId;
            }

            // 如果是新帖子，清空缓存
            if (currentTid !== tid) {
                threadAuthorId = null;
                currentTid = tid;
            }

            // 尝试多种方式获取楼主UID
            const selectors = [
                // 方式1：从第一个帖子的作者信息区域
                '[id^="post_"] .authi a.xw1[href*="uid="]',
                // 方式2：从用户信息区域
                '[id^="post_"] .xw1 a[href*="uid="]',
                // 方式3：从作者链接
                '[id^="post_"] a[href*="home.php?mod=space"][href*="uid="]',
                // 方式4：从用户头像区域
                '[id^="post_"] .avatar a[href*="uid="]'
            ];

            for (const selector of selectors) {
                try {
                    const authorLink = document.querySelector(selector);
                    if (authorLink && authorLink.href) {
                        const match = authorLink.href.match(/uid=(\d+)/);
                        if (match) {
                            threadAuthorId = match[1];
                            // console.log('找到楼主UID:', threadAuthorId, '通过选择器:', selector);
                            return threadAuthorId;
                        }
                    }
                } catch (e) {
                    // 忽略选择器错误，继续尝试下一个
                }
            }

            // 方式5：从帖子标题区域获取
            try {
                const titleElement = document.querySelector('#thread_subject');
                if (titleElement && titleElement.parentElement) {
                    const titleAuthorLink = titleElement.parentElement.querySelector('a[href*="uid="]');
                    if (titleAuthorLink) {
                        const match = titleAuthorLink.href.match(/uid=(\d+)/);
                        if (match) {
                            threadAuthorId = match[1];
                            // console.log('从标题区域找到楼主UID:', threadAuthorId);
                            return threadAuthorId;
                        }
                    }
                }
            } catch (e) {
                // console.log('从标题区域获取UID失败:', e);
            }

            // 如果所有方式都失败，尝试从页面中查找所有包含uid的链接
            const allLinks = document.querySelectorAll('a[href*="uid="]');
            // console.log('页面中找到的所有UID链接:', allLinks.length);

            for (const link of allLinks) {
                const match = link.href.match(/uid=(\d+)/);
                if (match) {
                    // 检查这个链接是否在第一个帖子中
                    const firstPost = document.querySelector('[id^="post_"]');
                    if (firstPost && firstPost.contains(link)) {
                        threadAuthorId = match[1];
                        // console.log('通过遍历找到楼主UID:', threadAuthorId, '链接:', link.href);
                        return threadAuthorId;
                    }
                }
            }

            // 最后尝试：直接查找第一个帖子中的所有链接
            const firstPost = document.querySelector('[id^="post_"]');
            if (firstPost) {
                const firstPostLinks = firstPost.querySelectorAll('a[href*="uid="]');
                // console.log('第一个帖子中的UID链接:', firstPostLinks.length);
                for (const link of firstPostLinks) {
                    const match = link.href.match(/uid=(\d+)/);
                    if (match) {
                        threadAuthorId = match[1];
                        // console.log('从第一个帖子中找到楼主UID:', threadAuthorId, '链接:', link.href);
                        return threadAuthorId;
                    }
                }
            }

            // console.log('无法找到楼主UID，尝试的选择器:', selectors);
            // console.log('当前页面URL:', location.href);
            // console.log('当前帖子TID:', tid);
            return null;
        }

        // 检查当前是否在只看该作者模式
        function isInAuthorOnlyMode() {
            return location.href.includes('authorid=');
        }

        function toggleAuthorOnly() {
            const authorId = getThreadAuthorId();
            if (!authorId) {
                showToast('无法识别楼主，请稍后再试', 'warning');
                return;
            }

            if (isInAuthorOnlyMode()) {
                // 当前在只看楼主模式，切换到显示全部
                authorOnlyMode = false;
                CFG.authorOnlyMode = false;
                saveConfig();
                initAuthorOnlyButton();

                // 跳转到原始URL（去掉authorid参数）
                const baseUrl = location.href.split('&authorid=')[0].split('?authorid=')[0];
                window.location.href = baseUrl;
            } else {
                // 当前在显示全部模式，切换到只看楼主
                authorOnlyMode = true;
                CFG.authorOnlyMode = true;
                saveConfig();
                initAuthorOnlyButton();

                // 跳转到只看该作者模式
                const tid = getThreadId();
                if (tid) {
                    const authorOnlyUrl = `forum.php?mod=viewthread&tid=${tid}&page=1&authorid=${authorId}`;
                    window.location.href = authorOnlyUrl;
                }
            }
        }

        function updateTipText(text) {
            const tip = document.querySelector('#sht-aggregator .sht-toolbar-tip');
            if (tip) {
                tip.textContent = text;
            }
        }

        // 页面加载时检查状态
        function checkAuthorOnlyStatus() {
            const isAuthorOnly = isInAuthorOnlyMode();
            if (isAuthorOnly !== authorOnlyMode) {
                authorOnlyMode = isAuthorOnly;
                CFG.authorOnlyMode = authorOnlyMode;
                saveConfig();
            }

            // 清空缓存，确保每次进入新页面都重新获取UID
            threadAuthorId = null;
            currentTid = null;

            initAuthorOnlyButton();

            if (isAuthorOnly) {
                updateTipText('（当前为只看楼主模式）');
            } else {
                updateTipText('（聚合文本/ED2K/磁力；图片屏蔽可切换）');
            }
        }

        // 初始化
        checkAuthorOnlyStatus();

        c.toggleAuthorOnly = toggleAuthorOnly;

        // 历史记录功能
        function openHistory() {
            const dialog = document.createElement('div');
            dialog.style.cssText = `
      position: fixed; top: 0; left: 0; width: 100%; height: 100%;
      background: rgba(0,0,0,0.5); z-index: 10001; display: flex;
      align-items: center; justify-content: center; font-family: Arial, sans-serif;
    `;

            const panel = document.createElement('div');
            panel.style.cssText = `
      background: white; border-radius: 8px; padding: 20px; max-width: 800px;
      max-height: 80vh; overflow-y: auto; box-shadow: 0 4px 20px rgba(0,0,0,0.3);
    `;

            const title = document.createElement('h3');
            title.textContent = '访问历史记录';
            title.style.cssText = 'margin: 0 0 20px 0; color: #333; border-bottom: 2px solid #eee; padding-bottom: 10px;';

            const controls = document.createElement('div');
            controls.style.cssText = 'display: flex; gap: 10px; margin-bottom: 15px; flex-wrap: wrap;';

            const clearAllBtn = document.createElement('button');
            setIconLabel(clearAllBtn, 'trash', '清空全部');
            clearAllBtn.style.cssText = `
      padding: 6px 12px;
      background: linear-gradient(135deg, #dc3545 0%, #c82333 100%);
      color: white;
      border: 1px solid #c82333;
      border-radius: 4px;
      cursor: pointer;
      font-size: 12px;
      font-weight: 500;
      transition: all 0.2s ease;
      box-shadow: 0 1px 3px rgba(0,0,0,0.1);
      display: inline-flex;
      align-items: center;
      gap: 4px;
    `;
            clearAllBtn.addEventListener('mouseenter', () => {
                clearAllBtn.style.background = 'linear-gradient(135deg, #c82333 0%, #bd2130 100%)';
                clearAllBtn.style.transform = 'translateY(-1px)';
                clearAllBtn.style.boxShadow = '0 2px 6px rgba(0,0,0,0.15)';
            });
            clearAllBtn.addEventListener('mouseleave', () => {
                clearAllBtn.style.background = 'linear-gradient(135deg, #dc3545 0%, #c82333 100%)';
                clearAllBtn.style.transform = 'translateY(0)';
                clearAllBtn.style.boxShadow = '0 1px 3px rgba(0,0,0,0.1)';
            });
            clearAllBtn.onclick = async () => {
                if (await confirmAction('清空后无法恢复。', { title: '清空全部历史记录', confirmText: '确认清空', danger: true })) {
                    CFG.historyItems = [];
                    saveConfig();
                    dialog.remove();
                    openHistory();
                }
            };

            const exportBtn = document.createElement('button');
            setIconLabel(exportBtn, 'upload', '导出历史');
            exportBtn.style.cssText = `
      padding: 6px 12px;
      background: linear-gradient(135deg, #007cba 0%, #005a87 100%);
      color: white;
      border: 1px solid #005a87;
      border-radius: 4px;
      cursor: pointer;
      font-size: 12px;
      font-weight: 500;
      transition: all 0.2s ease;
      box-shadow: 0 1px 3px rgba(0,0,0,0.1);
      display: inline-flex;
      align-items: center;
      gap: 4px;
    `;
            exportBtn.addEventListener('mouseenter', () => {
                exportBtn.style.background = 'linear-gradient(135deg, #005a87 0%, #004066 100%)';
                exportBtn.style.transform = 'translateY(-1px)';
                exportBtn.style.boxShadow = '0 2px 6px rgba(0,0,0,0.15)';
            });
            exportBtn.addEventListener('mouseleave', () => {
                exportBtn.style.background = 'linear-gradient(135deg, #007cba 0%, #005a87 100%)';
                exportBtn.style.transform = 'translateY(0)';
                exportBtn.style.boxShadow = '0 1px 3px rgba(0,0,0,0.1)';
            });
            exportBtn.onclick = () => exportHistory();

            controls.append(clearAllBtn, exportBtn);

            // 分页设置
            const itemsPerPage = 20;
            let currentPage = 1;
            const totalPages = Math.ceil(CFG.historyItems.length / itemsPerPage);

            const list = document.createElement('div');
            list.style.cssText = 'max-height: 400px; overflow-y: auto; border: 1px solid #eee; border-radius: 4px;';

            // 分页控件
            const pagination = document.createElement('div');
            pagination.style.cssText = 'display: flex; justify-content: center; align-items: center; gap: 10px; margin: 10px 0;';

            const prevBtn = document.createElement('button');
            prevBtn.textContent = '上一页';
            prevBtn.style.cssText = 'padding: 4px 8px; background: #f5f5f5; border: 1px solid #ddd; border-radius: 3px; cursor: pointer; font-size: 12px;';
            prevBtn.disabled = currentPage <= 1;

            const pageInfo = document.createElement('span');
            pageInfo.style.cssText = 'font-size: 12px; color: #666;';

            const nextBtn = document.createElement('button');
            nextBtn.textContent = '下一页';
            nextBtn.style.cssText = 'padding: 4px 8px; background: #f5f5f5; border: 1px solid #ddd; border-radius: 3px; cursor: pointer; font-size: 12px;';
            nextBtn.disabled = currentPage >= totalPages;

            function updatePagination() {
                pageInfo.textContent = `第 ${currentPage} 页，共 ${totalPages} 页 (${CFG.historyItems.length} 条记录)`;
                prevBtn.disabled = currentPage <= 1;
                nextBtn.disabled = currentPage >= totalPages;
            }

            function renderHistoryItems() {
                list.innerHTML = '';

                if (CFG.historyItems.length === 0) {
                    const empty = document.createElement('div');
                    empty.textContent = '暂无访问历史';
                    empty.style.cssText = 'text-align: center; padding: 40px; color: #666;';
                    list.appendChild(empty);
                    return;
                }

                const startIndex = (currentPage - 1) * itemsPerPage;
                const endIndex = Math.min(startIndex + itemsPerPage, CFG.historyItems.length);
                const pageItems = CFG.historyItems.slice(startIndex, endIndex);

                pageItems.forEach((item, index) => {
                    const actualIndex = startIndex + index;
                    const itemDiv = document.createElement('div');
                    itemDiv.style.cssText = 'padding: 10px; border-bottom: 1px solid #f0f0f0; display: flex; justify-content: space-between; align-items: center;';

                    const info = document.createElement('div');
                    info.style.cssText = 'flex: 1; min-width: 0;';

                    const titleEl = document.createElement('div');
                    titleEl.textContent = item.title || '未知标题';
                    titleEl.style.cssText = 'font-weight: bold; margin-bottom: 4px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;';

                    const meta = document.createElement('div');
                    meta.style.cssText = 'font-size: 12px; color: #666;';
                    meta.textContent = `作者: ${item.author || '未知'} | TID: ${item.tid} | 访问时间: ${new Date(item.timestamp).toLocaleString()}`;

                    const actions = document.createElement('div');
                    actions.style.cssText = 'display: flex; gap: 5px;';

                    const openBtn = document.createElement('button');
                    openBtn.textContent = '打开';
                    openBtn.style.cssText = 'padding: 4px 8px; background: #007cba; color: white; border: none; border-radius: 3px; cursor: pointer; font-size: 12px;';
                    openBtn.onclick = () => window.open(item.url, '_blank');

                    const deleteBtn = document.createElement('button');
                    deleteBtn.textContent = '删除';
                    deleteBtn.style.cssText = 'padding: 4px 8px; background: #ff6b6b; color: white; border: none; border-radius: 3px; cursor: pointer; font-size: 12px;';
                    deleteBtn.onclick = () => {
                        CFG.historyItems.splice(actualIndex, 1);
                        saveConfig();
                        dialog.remove();
                        openHistory();
                    };

                    actions.append(openBtn, deleteBtn);
                    info.append(titleEl, meta);
                    itemDiv.append(info, actions);
                    list.appendChild(itemDiv);
                });
            }

            prevBtn.onclick = () => {
                if (currentPage > 1) {
                    currentPage--;
                    updatePagination();
                    renderHistoryItems();
                }
            };

            nextBtn.onclick = () => {
                if (currentPage < totalPages) {
                    currentPage++;
                    updatePagination();
                    renderHistoryItems();
                }
            };

            pagination.append(prevBtn, pageInfo, nextBtn);
            updatePagination();
            renderHistoryItems();

            const closeBtn = document.createElement('button');
            setIconLabel(closeBtn, 'close', '关闭');
            closeBtn.style.cssText = `
      padding: 8px 16px;
      background: linear-gradient(135deg, #f8f9fa 0%, #e9ecef 100%);
      color: #495057;
      border: 1px solid #ddd;
      border-radius: 4px;
      cursor: pointer;
      margin-top: 15px;
      font-size: 12px;
      font-weight: 500;
      transition: all 0.2s ease;
      box-shadow: 0 1px 3px rgba(0,0,0,0.1);
      display: inline-flex;
      align-items: center;
      gap: 4px;
    `;
            closeBtn.addEventListener('mouseenter', () => {
                closeBtn.style.background = 'linear-gradient(135deg, #e9ecef 0%, #dee2e6 100%)';
                closeBtn.style.borderColor = '#adb5bd';
                closeBtn.style.transform = 'translateY(-1px)';
                closeBtn.style.boxShadow = '0 2px 6px rgba(0,0,0,0.15)';
            });
            closeBtn.addEventListener('mouseleave', () => {
                closeBtn.style.background = 'linear-gradient(135deg, #f8f9fa 0%, #e9ecef 100%)';
                closeBtn.style.borderColor = '#ddd';
                closeBtn.style.transform = 'translateY(0)';
                closeBtn.style.boxShadow = '0 1px 3px rgba(0,0,0,0.1)';
            });
            closeBtn.onclick = () => dialog.remove();

            panel.append(title, controls, pagination, list, closeBtn);
            dialog.appendChild(panel);
            document.body.appendChild(dialog);

            dialog.onclick = (e) => { if (e.target === dialog) dialog.remove(); };
        }

        // 导出所有内容功能
        function exportAll() {
            const threadInfo = getThreadInfo();
            const tid = getThreadId();
            if (!tid) return;

            // 收集所有数据
            const exportData = {
                threadInfo: {
                    title: threadInfo.title,
                    author: threadInfo.author,
                    tid: tid,
                    url: location.href,
                    exportTime: new Date().toISOString()
                },
                texts: [],
                ed2kLinks: [],
                magnetLinks: [],
                passwords: CFG.passwordCandidates,
                attachments: []
            };

            // 收集文本内容
            list.querySelectorAll('.sht-agg-item').forEach(item => {
                const title = item.querySelector('span[style*="font-weight"]')?.textContent || '未知';
                const content = item.querySelector('textarea')?.value || '';
                if (content.trim()) {
                    exportData.texts.push({ title, content });
                }
            });

            // 收集ED2K链接
            const ed2kTextarea = ed2kBox.querySelector('textarea');
            if (ed2kTextarea && ed2kTextarea.value.trim()) {
                exportData.ed2kLinks = ed2kTextarea.value.split('\n').filter(line => line.trim());
            }

            // 收集磁力链接
            const magnetTextarea = magnetBox.querySelector('textarea');
            if (magnetTextarea && magnetTextarea.value.trim()) {
                exportData.magnetLinks = magnetTextarea.value.split('\n').filter(line => line.trim());
            }

            // 收集附件信息
            document.querySelectorAll('a[href*="forum.php?mod=attachment"]').forEach(link => {
                const name = link.textContent?.trim() || '';
                const url = link.href;
                if (name && url) {
                    exportData.attachments.push({ name, url });
                }
            });

            // 创建下载
            const filename = `${threadInfo.title || '未知标题'}_${threadInfo.author || '未知作者'}_${tid}.json`;
            const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);

            const a = document.createElement('a');
            a.href = url;
            a.download = filename;
            a.click();

            URL.revokeObjectURL(url);
            showToast('帖子数据导出完成', 'success');
        }

        // 导出历史记录
        function exportHistory() {
            const blob = new Blob([JSON.stringify(CFG.historyItems, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);

            const a = document.createElement('a');
            a.href = url;
            a.download = `sht_history_${new Date().toISOString().split('T')[0]}.json`;
            a.click();

            URL.revokeObjectURL(url);
            showToast('历史记录导出完成', 'success');
        }


        // 获取帖子信息
        function getThreadInfo() {
            const title = document.querySelector('#thread_subject')?.textContent?.trim() || '未知标题';
            const author = document.querySelector('[id^="post_"] .xw1 a, [id^="post_"] .xw1 strong a')?.textContent?.trim() || '未知作者';
            return { title, author };
        }

        // 获取帖子ID
        function getThreadId() {
            const match = location.href.match(/tid=(\d+)/);
            return match ? match[1] : null;
        }

        // 记录访问历史
        function recordHistory() {
            if (!CFG.enableHistory) return;

            const tid = getThreadId();
            if (!tid) return;

            const threadInfo = getThreadInfo();
            const existingIndex = CFG.historyItems.findIndex(item => item.tid === tid);

            const historyItem = {
                tid,
                title: threadInfo.title,
                author: threadInfo.author,
                url: location.href,
                timestamp: Date.now()
            };

            if (existingIndex >= 0) {
                CFG.historyItems[existingIndex] = historyItem;
            } else {
                CFG.historyItems.unshift(historyItem);
                if (CFG.historyItems.length > CFG.maxHistoryItems) {
                    CFG.historyItems = CFG.historyItems.slice(0, CFG.maxHistoryItems);
                }
            }

            saveConfig();
        }

        // 初始化时记录历史
        recordHistory();

        return c;
    }

    function openSettings() {
        // 创建设置对话框
        const dialog = document.createElement('div');
        dialog.style.cssText = `
    position: fixed; top: 0; left: 0; width: 100%; height: 100%;
    background: rgba(0,0,0,0.5); z-index: 10000; display: flex;
    align-items: center; justify-content: center; font-family: Arial, sans-serif;
  `;

        const panel = document.createElement('div');
        panel.style.cssText = `
    background: white; border-radius: 8px; padding: 0; max-width: 800px;
    max-height: 85vh; overflow: hidden; box-shadow: 0 4px 20px rgba(0,0,0,0.3);
    display: flex; flex-direction: column;
  `;

        const title = document.createElement('h3');
        title.textContent = 'SHT 脚本设置';
        title.style.cssText = 'margin: 0; padding: 20px 20px 10px 20px; color: #333; border-bottom: 2px solid #eee;';

        // 创建标签页导航
        const tabNav = document.createElement('div');
        tabNav.style.cssText = 'display: flex; border-bottom: 1px solid #ddd; background: #f8f9fa;';

        const tabs = [
            { id: 'basic', name: '基础设置', icon: 'settings' },
            { id: 'display', name: '显示设置', icon: 'eye' },
            { id: 'collection', name: '收集设置', icon: 'download' },
            { id: 'pan115', name: '115 离线', icon: 'database' },
            { id: 'pan123', name: '123 离线', icon: 'cloud' },
            { id: 'advanced', name: '高级设置', icon: 'wrench' }
        ];

        const tabButtons = [];
        tabs.forEach((tab, index) => {
            const tabBtn = document.createElement('button');
            setIconLabel(tabBtn, tab.icon, tab.name);
            tabBtn.style.cssText = `
      flex: 1; padding: 12px 16px; border: none; background: transparent;
      cursor: pointer; font-size: 14px; border-bottom: 3px solid transparent;
      transition: all 0.2s ease;
    `;
            tabBtn.dataset.tab = tab.id;

            if (index === 0) {
                tabBtn.style.background = 'white';
                tabBtn.style.borderBottomColor = '#007cba';
                tabBtn.style.color = '#007cba';
            }

            tabBtn.addEventListener('click', () => switchTab(tab.id));
            tabNav.appendChild(tabBtn);
            tabButtons.push(tabBtn);
        });

        // 创建内容区域
        const contentArea = document.createElement('div');
        contentArea.style.cssText = 'flex: 1; overflow-y: auto; padding: 20px;';

        // 创建各个标签页内容
        const tabContents = {};

        // 基础设置标签页
        const basicTab = document.createElement('div');
        basicTab.id = 'tab-basic';
        basicTab.style.cssText = 'display: block;';
        tabContents.basic = basicTab;

        // 显示设置标签页
        const displayTab = document.createElement('div');
        displayTab.id = 'tab-display';
        displayTab.style.cssText = 'display: none;';
        tabContents.display = displayTab;

        // 收集设置标签页
        const collectionTab = document.createElement('div');
        collectionTab.id = 'tab-collection';
        collectionTab.style.cssText = 'display: none;';
        tabContents.collection = collectionTab;

        // 115 离线标签页
        const pan115Tab = document.createElement('div');
        pan115Tab.id = 'tab-pan115';
        pan115Tab.style.cssText = 'display: none;';
        tabContents.pan115 = pan115Tab;

        // 123Pan 设置标签页
        const pan123Tab = document.createElement('div');
        pan123Tab.id = 'tab-pan123';
        pan123Tab.style.cssText = 'display: none;';
        tabContents.pan123 = pan123Tab;

        // 高级设置标签页
        const advancedTab = document.createElement('div');
        advancedTab.id = 'tab-advanced';
        advancedTab.style.cssText = 'display: none;';
        tabContents.advanced = advancedTab;

        // 标签页切换函数
        function switchTab(tabId) {
            // 隐藏所有标签页
            Object.values(tabContents).forEach(tab => {
                tab.style.display = 'none';
            });

            // 重置所有按钮样式
            tabButtons.forEach(btn => {
                btn.style.background = 'transparent';
                btn.style.borderBottomColor = 'transparent';
                btn.style.color = '#333';
            });

            // 显示选中的标签页
            tabContents[tabId].style.display = 'block';

            // 高亮选中的按钮
            const activeBtn = tabButtons.find(btn => btn.dataset.tab === tabId);
            activeBtn.style.background = 'white';
            activeBtn.style.borderBottomColor = '#007cba';
            activeBtn.style.color = '#007cba';
        }

        // 基础设置内容
        const basicForm = document.createElement('form');
        basicForm.style.cssText = 'display: grid; gap: 15px;';

        // ===== 基础设置 =====
        // 密码候选设置
        const pwdGroup = createSettingGroup('密码候选', '压缩包解压时尝试的密码列表（每行一个密码）');
        const pwdInput = document.createElement('textarea');
        pwdInput.value = CFG.passwordCandidates.join('\n');
        pwdInput.rows = 6;
        pwdInput.style.cssText = 'width: 100%; padding: 8px; border: 1px solid #ddd; border-radius: 4px; font-family: monospace;';
        pwdGroup.appendChild(pwdInput);
        basicForm.appendChild(pwdGroup);

        // 自动加载阈值
        const autoGroup = createSettingGroup('自动加载阈值', '文件大小超过此值时需要手动点击加载（字节）');
        const autoInput = document.createElement('input');
        autoInput.type = 'number';
        autoInput.value = CFG.maxAutoBytes;
        autoInput.style.cssText = 'width: 100%; padding: 8px; border: 1px solid #ddd; border-radius: 4px;';
        autoGroup.appendChild(autoInput);
        basicForm.appendChild(autoGroup);

        // 压缩包内文件大小限制
        const entryGroup = createSettingGroup('压缩包内文件大小限制', '压缩包内单个文件超过此大小时不显示（字节）');
        const entryInput = document.createElement('input');
        entryInput.type = 'number';
        entryInput.value = CFG.maxEntryBytes;
        entryInput.style.cssText = 'width: 100%; padding: 8px; border: 1px solid #ddd; border-radius: 4px;';
        entryGroup.appendChild(entryInput);
        basicForm.appendChild(entryGroup);

        // 自动上顶
        const hoistGroup = createSettingGroup('自动上顶', '解析文本后自动添加到顶部聚合区');
        const hoistCheckbox = document.createElement('input');
        hoistCheckbox.type = 'checkbox';
        hoistCheckbox.checked = CFG.autoHoistToTop;
        hoistCheckbox.style.marginRight = '8px';
        hoistGroup.appendChild(hoistCheckbox);
        hoistGroup.appendChild(document.createTextNode('启用自动上顶'));
        basicForm.appendChild(hoistGroup);

        basicTab.appendChild(basicForm);

        // ===== 显示设置 =====
        const displayForm = document.createElement('form');
        displayForm.style.cssText = 'display: grid; gap: 15px;';

        // 图片屏蔽
        const imgGroup = createSettingGroup('图片屏蔽', '默认屏蔽帖子中的图片');
        const imgCheckbox = document.createElement('input');
        imgCheckbox.type = 'checkbox';
        imgCheckbox.checked = CFG.blockImages;
        imgCheckbox.style.marginRight = '8px';
        imgGroup.appendChild(imgCheckbox);
        imgGroup.appendChild(document.createTextNode('启用图片屏蔽'));
        displayForm.appendChild(imgGroup);

        // 图片白名单
        const whiteGroup = createSettingGroup('图片白名单', '不屏蔽这些域名的图片（逗号分隔）');
        const whiteInput = document.createElement('input');
        whiteInput.type = 'text';
        whiteInput.value = CFG.imageAllowDomains.join(', ');
        whiteInput.placeholder = '例如: example.com, imgur.com';
        whiteInput.style.cssText = 'width: 100%; padding: 8px; border: 1px solid #ddd; border-radius: 4px;';
        whiteGroup.appendChild(whiteInput);
        displayForm.appendChild(whiteGroup);

        // 占位显示元信息
        const metaGroup = createSettingGroup('占位显示元信息', '图片被屏蔽时是否显示域名和文件名');
        const metaCheckbox = document.createElement('input');
        metaCheckbox.type = 'checkbox';
        metaCheckbox.checked = CFG.imagePlaceholderShowMeta;
        metaCheckbox.style.marginRight = '8px';
        metaGroup.appendChild(metaCheckbox);
        metaGroup.appendChild(document.createTextNode('显示元信息'));
        displayForm.appendChild(metaGroup);

        // ===== 收集设置 =====
        const collectionForm = document.createElement('form');
        collectionForm.style.cssText = 'display: grid; gap: 15px;';

        // ED2K收集
        const ed2kGroup = createSettingGroup('ED2K收集', '自动收集并聚合页面中的ED2K链接');
        const ed2kCheckbox = document.createElement('input');
        ed2kCheckbox.type = 'checkbox';
        ed2kCheckbox.checked = CFG.autoCollectED2K;
        ed2kCheckbox.style.marginRight = '8px';
        ed2kGroup.appendChild(ed2kCheckbox);

        // ED2K文件名替换
        const ed2kReplaceGroup = createSettingGroup('ED2K文件名替换', '使用正则表达式替换ED2K链接中的文件名');
        const ed2kReplaceCheckbox = document.createElement('input');
        ed2kReplaceCheckbox.type = 'checkbox';
        ed2kReplaceCheckbox.checked = CFG.ed2kFileNameReplaceEnabled;
        ed2kReplaceCheckbox.style.marginRight = '8px';
        ed2kReplaceGroup.appendChild(ed2kReplaceCheckbox);

        // 替换规则容器
        const ed2kRulesContainer = document.createElement('div');
        ed2kRulesContainer.id = 'ed2k-rules-container';
        ed2kRulesContainer.style.cssText = 'margin-top: 10px; display: none;';
        ed2kReplaceGroup.appendChild(ed2kRulesContainer);

        // 添加规则按钮
        const addRuleBtn = document.createElement('button');
        addRuleBtn.type = 'button';
        addRuleBtn.textContent = '添加替换规则';
        addRuleBtn.style.cssText = 'padding: 4px 8px; margin: 5px 0; background: #007bff; color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 12px;';
        ed2kRulesContainer.appendChild(addRuleBtn);

        // 规则列表
        const rulesList = document.createElement('div');
        rulesList.id = 'ed2k-rules-list';
        rulesList.style.cssText = 'margin-top: 10px;';
        ed2kRulesContainer.appendChild(rulesList);

        // 显示/隐藏规则容器
        ed2kReplaceCheckbox.addEventListener('change', () => {
            ed2kRulesContainer.style.display = ed2kReplaceCheckbox.checked ? 'block' : 'none';
        });
        if (CFG.ed2kFileNameReplaceEnabled) {
            ed2kRulesContainer.style.display = 'block';
        }

        // 添加规则功能
        function addEd2kRule(rule = { pattern: '', replacement: '' }) {
            const ruleDiv = document.createElement('div');
            ruleDiv.style.cssText = 'display: flex; gap: 8px; margin: 5px 0; align-items: center;';

            const patternInput = document.createElement('input');
            patternInput.type = 'text';
            patternInput.placeholder = '正则表达式模式';
            patternInput.value = rule.pattern || '';
            patternInput.style.cssText = 'flex: 1; padding: 4px 8px; border: 1px solid #ddd; border-radius: 4px; font-size: 12px;';

            const replacementInput = document.createElement('input');
            replacementInput.type = 'text';
            replacementInput.placeholder = '替换为';
            replacementInput.value = rule.replacement || '';
            replacementInput.style.cssText = 'flex: 1; padding: 4px 8px; border: 1px solid #ddd; border-radius: 4px; font-size: 12px;';

            const deleteBtn = document.createElement('button');
            deleteBtn.type = 'button';
            deleteBtn.textContent = '删除';
            deleteBtn.style.cssText = 'padding: 4px 8px; background: #dc3545; color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 12px;';
            deleteBtn.addEventListener('click', () => {
                ruleDiv.remove();
            });

            ruleDiv.appendChild(patternInput);
            ruleDiv.appendChild(replacementInput);
            ruleDiv.appendChild(deleteBtn);
            rulesList.appendChild(ruleDiv);
        }

        // 添加规则按钮事件
        addRuleBtn.addEventListener('click', () => {
            addEd2kRule();
        });

        // 初始化现有规则
        if (CFG.ed2kFileNameReplaceRules && CFG.ed2kFileNameReplaceRules.length > 0) {
            CFG.ed2kFileNameReplaceRules.forEach(rule => {
                addEd2kRule(rule);
            });
        } else {
            // 添加默认规则
            addEd2kRule({ pattern: '\\[\\d+\\.\\d+G/\\d+V/\\d+配额\\]', replacement: '' });
        }
        ed2kGroup.appendChild(document.createTextNode('启用ED2K收集'));
        collectionForm.appendChild(ed2kGroup);
        collectionForm.appendChild(ed2kReplaceGroup);

        // 磁力收集
        const magnetGroup = createSettingGroup('磁力收集', '自动收集并聚合页面中的磁力链接');
        const magnetCheckbox = document.createElement('input');
        magnetCheckbox.type = 'checkbox';
        magnetCheckbox.checked = CFG.autoCollectMagnet;
        magnetCheckbox.style.marginRight = '8px';
        magnetGroup.appendChild(magnetCheckbox);
        magnetGroup.appendChild(document.createTextNode('启用磁力收集'));
        collectionForm.appendChild(magnetGroup);

        // 只看楼主
        const authorOnlyGroup = createSettingGroup('只看楼主', '默认只显示楼主的帖子');
        const authorOnlyCheckbox = document.createElement('input');
        authorOnlyCheckbox.type = 'checkbox';
        authorOnlyCheckbox.checked = CFG.authorOnlyMode;
        authorOnlyCheckbox.style.marginRight = '8px';
        authorOnlyGroup.appendChild(authorOnlyCheckbox);
        authorOnlyGroup.appendChild(document.createTextNode('启用只看楼主模式'));
        collectionForm.appendChild(authorOnlyGroup);

        // 历史记录
        const historyGroup = createSettingGroup('历史记录', '记录访问过的帖子历史');
        const historyCheckbox = document.createElement('input');
        historyCheckbox.type = 'checkbox';
        historyCheckbox.checked = CFG.enableHistory;
        historyCheckbox.style.marginRight = '8px';
        historyGroup.appendChild(historyCheckbox);
        historyGroup.appendChild(document.createTextNode('启用历史记录'));

        const historyLimitGroup = document.createElement('div');
        historyLimitGroup.style.cssText = 'margin-top: 10px; display: flex; align-items: center; gap: 8px;';
        historyLimitGroup.appendChild(document.createTextNode('最大记录数:'));
        const historyLimitInput = document.createElement('input');
        historyLimitInput.type = 'number';
        historyLimitInput.value = CFG.maxHistoryItems;
        historyLimitInput.min = '10';
        historyLimitInput.max = '10000';
        historyLimitInput.style.cssText = 'width: 100px; padding: 4px; border: 1px solid #ddd; border-radius: 4px;';
        historyLimitGroup.appendChild(historyLimitInput);
        historyGroup.appendChild(historyLimitGroup);
        collectionForm.appendChild(historyGroup);

        // 一键评分
        const quickRateGroup = createSettingGroup('一键评分', '点击评分按钮直接给出评分，无需弹窗');
        const quickRateCheckbox = document.createElement('input');
        quickRateCheckbox.type = 'checkbox';
        quickRateCheckbox.checked = CFG.enableQuickRate;
        quickRateCheckbox.style.marginRight = '8px';
        quickRateGroup.appendChild(quickRateCheckbox);
        quickRateGroup.appendChild(document.createTextNode('启用一键评分'));

        const rateScoreGroup = document.createElement('div');
        rateScoreGroup.style.cssText = 'margin-top: 10px; display: flex; align-items: center; gap: 8px;';
        rateScoreGroup.appendChild(document.createTextNode('默认评分:'));
        const rateScoreInput = document.createElement('input');
        rateScoreInput.type = 'number';
        rateScoreInput.value = CFG.defaultRateScore;
        rateScoreInput.min = '1';
        rateScoreInput.max = '10';
        rateScoreInput.style.cssText = 'width: 80px; padding: 4px; border: 1px solid #ddd; border-radius: 4px;';
        rateScoreGroup.appendChild(rateScoreInput);
        rateScoreGroup.appendChild(document.createTextNode('分'));
        quickRateGroup.appendChild(rateScoreGroup);


        // 评分理由设置
        const reasonGroup = document.createElement('div');
        reasonGroup.style.cssText = 'margin-top: 8px; display: flex; align-items: center; gap: 8px;';
        reasonGroup.appendChild(document.createTextNode('评分理由:'));
        const reasonInput = document.createElement('input');
        reasonInput.type = 'text';
        reasonInput.value = CFG.defaultRateReason;
        reasonInput.placeholder = '输入评分理由';
        reasonInput.style.cssText = 'flex: 1; padding: 4px; border: 1px solid #ddd; border-radius: 4px;';
        reasonGroup.appendChild(reasonInput);
        quickRateGroup.appendChild(reasonGroup);
        collectionForm.appendChild(quickRateGroup);

        collectionTab.appendChild(collectionForm);

        // 排版优化 - 添加到显示设置
        const layoutGroup = createSettingGroup('排版优化', '在帖子列表页面隐藏特定列和置顶帖');

        const hideReplyGroup = document.createElement('div');
        hideReplyGroup.style.cssText = 'margin: 8px 0; display: flex; align-items: center;';
        const hideReplyCheckbox = document.createElement('input');
        hideReplyCheckbox.type = 'checkbox';
        hideReplyCheckbox.checked = CFG.hideReplyColumn;
        hideReplyCheckbox.style.marginRight = '8px';
        hideReplyGroup.appendChild(hideReplyCheckbox);
        hideReplyGroup.appendChild(document.createTextNode('隐藏回复/查看列'));
        layoutGroup.appendChild(hideReplyGroup);

        const hideLastReplyGroup = document.createElement('div');
        hideLastReplyGroup.style.cssText = 'margin: 8px 0; display: flex; align-items: center;';
        const hideLastReplyCheckbox = document.createElement('input');
        hideLastReplyCheckbox.type = 'checkbox';
        hideLastReplyCheckbox.checked = CFG.hideLastReplyColumn;
        hideLastReplyCheckbox.style.marginRight = '8px';
        hideLastReplyGroup.appendChild(hideLastReplyCheckbox);
        hideLastReplyGroup.appendChild(document.createTextNode('隐藏最后回复列'));
        layoutGroup.appendChild(hideLastReplyGroup);

        const hideAuthorGroup = document.createElement('div');
        hideAuthorGroup.style.cssText = 'margin: 8px 0; display: flex; align-items: center;';
        const hideAuthorCheckbox = document.createElement('input');
        hideAuthorCheckbox.type = 'checkbox';
        hideAuthorCheckbox.checked = CFG.hideAuthorColumn;
        hideAuthorCheckbox.style.marginRight = '8px';
        hideAuthorGroup.appendChild(hideAuthorCheckbox);
        hideAuthorGroup.appendChild(document.createTextNode('隐藏作者列'));
        layoutGroup.appendChild(hideAuthorGroup);

        const hideStickyGroup = document.createElement('div');
        hideStickyGroup.style.cssText = 'margin: 8px 0; display: flex; align-items: center;';
        const hideStickyCheckbox = document.createElement('input');
        hideStickyCheckbox.type = 'checkbox';
        hideStickyCheckbox.checked = CFG.hideStickyThreads;
        hideStickyCheckbox.style.marginRight = '8px';
        hideStickyGroup.appendChild(hideStickyCheckbox);
        hideStickyGroup.appendChild(document.createTextNode('隐藏置顶帖'));
        layoutGroup.appendChild(hideStickyGroup);
        displayForm.appendChild(layoutGroup);

        displayTab.appendChild(displayForm);

        // ===== 高级设置 =====
        const advancedForm = document.createElement('form');
        advancedForm.style.cssText = 'display: grid; gap: 15px;';

        // 分页和过滤功能
        const filterGroup = createSettingGroup('分页和过滤', '隐藏分页、关键词过滤和标题增强功能');

        const hidePaginationGroup = document.createElement('div');
        hidePaginationGroup.style.cssText = 'margin: 8px 0; display: flex; align-items: center;';
        const hidePaginationCheckbox = document.createElement('input');
        hidePaginationCheckbox.type = 'checkbox';
        hidePaginationCheckbox.checked = CFG.hidePagination;
        hidePaginationCheckbox.style.marginRight = '8px';
        hidePaginationGroup.appendChild(hidePaginationCheckbox);
        hidePaginationGroup.appendChild(document.createTextNode('隐藏分页'));
        filterGroup.appendChild(hidePaginationGroup);

        const enhanceTitlesGroup = document.createElement('div');
        enhanceTitlesGroup.style.cssText = 'margin: 8px 0; display: flex; align-items: center;';
        const enhanceTitlesCheckbox = document.createElement('input');
        enhanceTitlesCheckbox.type = 'checkbox';
        enhanceTitlesCheckbox.checked = CFG.enhanceTitles;
        enhanceTitlesCheckbox.style.marginRight = '8px';
        enhanceTitlesGroup.appendChild(enhanceTitlesCheckbox);
        enhanceTitlesGroup.appendChild(document.createTextNode('标题增强（【】→[]）'));
        filterGroup.appendChild(enhanceTitlesGroup);

        // 列表页标题正则替换
        const listTitleGroup = document.createElement('div');
        listTitleGroup.style.cssText = 'margin: 8px 0; display: flex; flex-direction: column;';
        const listTitleLabel = document.createElement('label');
        listTitleLabel.textContent = '列表页标题正则替换:';
        listTitleLabel.style.cssText = 'margin-bottom: 4px; font-size: 12px; color: #666;';
        listTitleGroup.appendChild(listTitleLabel);

        const listTitleCheckbox = document.createElement('input');
        listTitleCheckbox.type = 'checkbox';
        listTitleCheckbox.checked = CFG.enableListTitleEnhance;
        listTitleCheckbox.style.marginRight = '8px';
        const listTitleCheckboxGroup = document.createElement('div');
        listTitleCheckboxGroup.style.cssText = 'margin: 8px 0; display: flex; align-items: center;';
        listTitleCheckboxGroup.appendChild(listTitleCheckbox);
        listTitleCheckboxGroup.appendChild(document.createTextNode('启用列表页标题正则替换'));
        listTitleGroup.appendChild(listTitleCheckboxGroup);

        // 列表页替换规则
        const listRulesLabel = document.createElement('label');
        listRulesLabel.textContent = '替换规则（每行一个，格式：正则表达式|替换内容）:';
        listRulesLabel.style.cssText = 'margin-bottom: 4px; font-size: 12px; color: #666;';
        listTitleGroup.appendChild(listRulesLabel);

        const listRulesTextarea = document.createElement('textarea');
        listRulesTextarea.value = CFG.listTitleReplaceRules.map(rule => `${rule.pattern}|${rule.replacement}`).join('\n');
        listRulesTextarea.placeholder = '例如：\n\\[\\d+\\.\\d+G/\\d+V/\\d+配额\\]|\n\\[情色分享\\]|\n\\[图文故事\\]|';
        listRulesTextarea.style.cssText = 'width: 100%; height: 80px; padding: 8px; border: 1px solid #ddd; border-radius: 4px; font-size: 12px; resize: vertical; font-family: monospace;';
        listTitleGroup.appendChild(listRulesTextarea);

        filterGroup.appendChild(listTitleGroup);

        const keywordFilterGroup = document.createElement('div');
        keywordFilterGroup.style.cssText = 'margin: 8px 0; display: flex; align-items: center;';
        const keywordFilterCheckbox = document.createElement('input');
        keywordFilterCheckbox.type = 'checkbox';
        keywordFilterCheckbox.checked = CFG.enableKeywordFilter;
        keywordFilterCheckbox.style.marginRight = '8px';
        keywordFilterGroup.appendChild(keywordFilterCheckbox);
        keywordFilterGroup.appendChild(document.createTextNode('启用关键词过滤'));
        filterGroup.appendChild(keywordFilterGroup);

        // 关键词输入区域
        const keywordInputGroup = document.createElement('div');
        keywordInputGroup.style.cssText = 'margin: 8px 0; display: flex; flex-direction: column;';
        const keywordLabel = document.createElement('label');
        keywordLabel.textContent = '关键词过滤（每行一个，支持正则表达式，匹配标题和类型）:';
        keywordLabel.style.cssText = 'margin-bottom: 4px; font-size: 12px; color: #666;';
        keywordInputGroup.appendChild(keywordLabel);

        const keywordTextarea = document.createElement('textarea');
        keywordTextarea.value = CFG.keywordFilters.join('\n');
        keywordTextarea.placeholder = '例如：\n测试\n.*广告.*\n^【.*】\n图文故事\n.*故事.*';
        keywordTextarea.style.cssText = 'width: 100%; height: 80px; padding: 8px; border: 1px solid #ddd; border-radius: 4px; font-size: 12px; resize: vertical;';
        keywordInputGroup.appendChild(keywordTextarea);
        filterGroup.appendChild(keywordInputGroup);

        // 历史访问帖子处理
        const historyPostGroup = document.createElement('div');
        historyPostGroup.style.cssText = 'margin: 8px 0; display: flex; flex-direction: column;';
        const historyPostLabel = document.createElement('label');
        historyPostLabel.textContent = '历史访问帖子处理:';
        historyPostLabel.style.cssText = 'margin-bottom: 4px; font-size: 12px; color: #666;';
        historyPostGroup.appendChild(historyPostLabel);

        const historyPostSelect = document.createElement('select');
        historyPostSelect.style.cssText = 'width: 100%; padding: 8px; border: 1px solid #ddd; border-radius: 4px; font-size: 12px;';
        historyPostSelect.innerHTML = `
    <option value="none">不处理</option>
    <option value="hide">隐藏已访问帖子</option>
    <option value="blue">标记为蓝色</option>
    <option value="strikethrough">添加删除线</option>
  `;
        historyPostSelect.value = CFG.historyPostAction;
        historyPostGroup.appendChild(historyPostSelect);

        // 颜色选择器（仅在选择蓝色时显示）
        const colorGroup = document.createElement('div');
        colorGroup.style.cssText = 'margin-top: 8px; display: flex; align-items: center; gap: 8px;';
        const colorLabel = document.createElement('label');
        colorLabel.textContent = '颜色:';
        colorLabel.style.cssText = 'font-size: 12px; color: #666;';
        colorGroup.appendChild(colorLabel);

        const colorInput = document.createElement('input');
        colorInput.type = 'color';
        colorInput.value = CFG.historyPostColor;
        colorInput.style.cssText = 'width: 40px; height: 30px; border: 1px solid #ddd; border-radius: 4px;';
        colorGroup.appendChild(colorInput);

        // 根据当前选择显示/隐藏颜色选择器
        const updateColorVisibility = () => {
            colorGroup.style.display = historyPostSelect.value === 'blue' ? 'flex' : 'none';
        };
        updateColorVisibility();
        historyPostSelect.addEventListener('change', updateColorVisibility);

        historyPostGroup.appendChild(colorGroup);
        filterGroup.appendChild(historyPostGroup);

        // 帖子详情标题处理
        const threadTitleGroup = document.createElement('div');
        threadTitleGroup.style.cssText = 'margin: 8px 0; display: flex; flex-direction: column;';
        const threadTitleLabel = document.createElement('label');
        threadTitleLabel.textContent = '标题正则替换（详情页+列表页）:';
        threadTitleLabel.style.cssText = 'margin-bottom: 4px; font-size: 12px; color: #666;';
        threadTitleGroup.appendChild(threadTitleLabel);

        const threadTitleCheckbox = document.createElement('input');
        threadTitleCheckbox.type = 'checkbox';
        threadTitleCheckbox.checked = CFG.enableThreadTitleEnhance;
        threadTitleCheckbox.style.marginRight = '8px';
        const threadTitleCheckboxGroup = document.createElement('div');
        threadTitleCheckboxGroup.style.cssText = 'margin: 8px 0; display: flex; align-items: center;';
        threadTitleCheckboxGroup.appendChild(threadTitleCheckbox);
        threadTitleCheckboxGroup.appendChild(document.createTextNode('启用标题正则替换'));
        threadTitleGroup.appendChild(threadTitleCheckboxGroup);

        // 类型标签隐藏选项
        const hideTypeCheckbox = document.createElement('input');
        hideTypeCheckbox.type = 'checkbox';
        hideTypeCheckbox.checked = CFG.hideTypeLabels && CFG.hideTypeLabels.length > 0;
        hideTypeCheckbox.style.marginRight = '8px';
        const hideTypeCheckboxGroup = document.createElement('div');
        hideTypeCheckboxGroup.style.cssText = 'margin: 8px 0; display: flex; align-items: center;';
        hideTypeCheckboxGroup.appendChild(hideTypeCheckbox);
        hideTypeCheckboxGroup.appendChild(document.createTextNode('隐藏类型标签（如：情色分享、图文故事等）'));
        threadTitleGroup.appendChild(hideTypeCheckboxGroup);

        // 替换规则输入区域
        const rulesLabel = document.createElement('label');
        rulesLabel.textContent = '替换规则（每行一个，格式：pattern|replacement）:';
        rulesLabel.style.cssText = 'margin-bottom: 4px; font-size: 12px; color: #666;';
        threadTitleGroup.appendChild(rulesLabel);

        const rulesTextarea = document.createElement('textarea');
        rulesTextarea.value = CFG.titleReplaceRules.map(rule => `${rule.pattern}|${rule.replacement}`).join('\n');
        rulesTextarea.placeholder = '例如：\n\\[\\d+\\.\\d+G/\\d+V/\\d+配额\\]|\n\\[.*?\\]|\\[\\1\\]';
        rulesTextarea.style.cssText = 'width: 100%; height: 80px; padding: 8px; border: 1px solid #ddd; border-radius: 4px; font-size: 12px; resize: vertical; font-family: monospace;';
        threadTitleGroup.appendChild(rulesTextarea);

        filterGroup.appendChild(threadTitleGroup);

        // 论坛模块屏蔽
        const moduleFilterGroup = document.createElement('div');
        moduleFilterGroup.style.cssText = 'margin: 8px 0; display: flex; flex-direction: column;';
        const moduleFilterLabel = document.createElement('label');
        moduleFilterLabel.textContent = '论坛模块屏蔽:';
        moduleFilterLabel.style.cssText = 'margin-bottom: 4px; font-size: 12px; color: #666;';
        moduleFilterGroup.appendChild(moduleFilterLabel);

        const moduleFilterCheckbox = document.createElement('input');
        moduleFilterCheckbox.type = 'checkbox';
        moduleFilterCheckbox.checked = CFG.enableModuleFilter;
        moduleFilterCheckbox.style.marginRight = '8px';
        const moduleFilterCheckboxGroup = document.createElement('div');
        moduleFilterCheckboxGroup.style.cssText = 'margin: 8px 0; display: flex; align-items: center;';
        moduleFilterCheckboxGroup.appendChild(moduleFilterCheckbox);
        moduleFilterCheckboxGroup.appendChild(document.createTextNode('启用论坛模块屏蔽'));
        moduleFilterGroup.appendChild(moduleFilterCheckboxGroup);

        // 模块选择区域
        const moduleSelectGroup = document.createElement('div');
        moduleSelectGroup.style.cssText = 'margin: 8px 0; display: flex; flex-direction: column;';
        const moduleSelectLabel = document.createElement('label');
        moduleSelectLabel.textContent = '选择要屏蔽的模块（每行一个）:';
        moduleSelectLabel.style.cssText = 'margin-bottom: 4px; font-size: 12px; color: #666;';
        moduleSelectGroup.appendChild(moduleSelectLabel);

        const moduleTextarea = document.createElement('textarea');
        moduleTextarea.value = CFG.hiddenModules.join('\n');
        moduleTextarea.placeholder = '例如：\n色花文学（大模块）\n投稿送邀请码（小模块）\n综合讨论区（大模块）\nAI专区（小模块）\n国产原创（小模块）\n原创自拍区（小模块）';
        moduleTextarea.style.cssText = 'width: 100%; height: 80px; padding: 8px; border: 1px solid #ddd; border-radius: 4px; font-size: 12px; resize: vertical;';
        moduleSelectGroup.appendChild(moduleTextarea);

        moduleFilterGroup.appendChild(moduleSelectGroup);
        filterGroup.appendChild(moduleFilterGroup);

        // 配置导入导出功能
        const configGroup = createSettingGroup('配置管理', '导出和导入脚本配置');

        const configButtonsGroup = document.createElement('div');
        configButtonsGroup.style.cssText = 'margin: 8px 0; display: flex; gap: 10px; flex-wrap: wrap;';

        const sensitiveExportLabel = document.createElement('label');
        sensitiveExportLabel.style.cssText = 'display:flex;align-items:flex-start;gap:8px;margin:8px 0;padding:8px;border:1px solid #f0c36d;border-radius:4px;background:#fff8e5;font-size:12px;';
        const sensitiveExportCheckbox = document.createElement('input');
        sensitiveExportCheckbox.type = 'checkbox';
        sensitiveExportCheckbox.checked = false;
        sensitiveExportCheckbox.setAttribute('aria-describedby', 'sht-sensitive-export-help');
        const sensitiveExportText = document.createElement('span');
        sensitiveExportText.id = 'sht-sensitive-export-help';
        sensitiveExportText.textContent = '在导出文件中包含 115/123Pan Cookie、Token 和 User-Agent（默认关闭；文件包含账号凭据，请仅保存在可信设备）。';
        sensitiveExportLabel.append(sensitiveExportCheckbox, sensitiveExportText);

        const exportConfigBtn = document.createElement('button');
        setIconLabel(exportConfigBtn, 'upload', '导出配置');
        exportConfigBtn.style.cssText = `
    padding: 8px 16px;
    background: linear-gradient(135deg, #28a745 0%, #1e7e34 100%);
    color: white;
    border: 1px solid #1e7e34;
    border-radius: 4px;
    cursor: pointer;
    font-size: 12px;
    font-weight: 500;
    transition: all 0.2s ease;
    box-shadow: 0 1px 3px rgba(0,0,0,0.1);
    display: inline-flex;
    align-items: center;
    gap: 4px;
  `;
        exportConfigBtn.addEventListener('mouseenter', () => {
            exportConfigBtn.style.background = 'linear-gradient(135deg, #1e7e34 0%, #155724 100%)';
            exportConfigBtn.style.transform = 'translateY(-1px)';
            exportConfigBtn.style.boxShadow = '0 2px 6px rgba(0,0,0,0.15)';
        });
        exportConfigBtn.addEventListener('mouseleave', () => {
            exportConfigBtn.style.background = 'linear-gradient(135deg, #28a745 0%, #1e7e34 100%)';
            exportConfigBtn.style.transform = 'translateY(0)';
            exportConfigBtn.style.boxShadow = '0 1px 3px rgba(0,0,0,0.1)';
        });
        exportConfigBtn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            exportConfig(sensitiveExportCheckbox.checked);
        });

        const importConfigBtn = document.createElement('button');
        setIconLabel(importConfigBtn, 'download', '导入配置');
        importConfigBtn.style.cssText = `
    padding: 8px 16px;
    background: linear-gradient(135deg, #007cba 0%, #005a87 100%);
    color: white;
    border: 1px solid #005a87;
    border-radius: 4px;
    cursor: pointer;
    font-size: 12px;
    font-weight: 500;
    transition: all 0.2s ease;
    box-shadow: 0 1px 3px rgba(0,0,0,0.1);
    display: inline-flex;
    align-items: center;
    gap: 4px;
  `;
        importConfigBtn.addEventListener('mouseenter', () => {
            importConfigBtn.style.background = 'linear-gradient(135deg, #005a87 0%, #004066 100%)';
            importConfigBtn.style.transform = 'translateY(-1px)';
            importConfigBtn.style.boxShadow = '0 2px 6px rgba(0,0,0,0.15)';
        });
        importConfigBtn.addEventListener('mouseleave', () => {
            importConfigBtn.style.background = 'linear-gradient(135deg, #007cba 0%, #005a87 100%)';
            importConfigBtn.style.transform = 'translateY(0)';
            importConfigBtn.style.boxShadow = '0 1px 3px rgba(0,0,0,0.1)';
        });
        importConfigBtn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            importConfig();
        });

        const resetConfigBtn = document.createElement('button');
        setIconLabel(resetConfigBtn, 'refresh', '重置配置');
        resetConfigBtn.style.cssText = `
    padding: 8px 16px;
    background: linear-gradient(135deg, #ffc107 0%, #e0a800 100%);
    color: #212529;
    border: 1px solid #e0a800;
    border-radius: 4px;
    cursor: pointer;
    font-size: 12px;
    font-weight: 500;
    transition: all 0.2s ease;
    box-shadow: 0 1px 3px rgba(0,0,0,0.1);
    display: inline-flex;
    align-items: center;
    gap: 4px;
  `;
        resetConfigBtn.addEventListener('mouseenter', () => {
            resetConfigBtn.style.background = 'linear-gradient(135deg, #e0a800 0%, #d39e00 100%)';
            resetConfigBtn.style.transform = 'translateY(-1px)';
            resetConfigBtn.style.boxShadow = '0 2px 6px rgba(0,0,0,0.15)';
        });
        resetConfigBtn.addEventListener('mouseleave', () => {
            resetConfigBtn.style.background = 'linear-gradient(135deg, #ffc107 0%, #e0a800 100%)';
            resetConfigBtn.style.transform = 'translateY(0)';
            resetConfigBtn.style.boxShadow = '0 1px 3px rgba(0,0,0,0.1)';
        });
        resetConfigBtn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            resetConfig();
        });

        configButtonsGroup.appendChild(exportConfigBtn);
        configButtonsGroup.appendChild(importConfigBtn);
        configButtonsGroup.appendChild(resetConfigBtn);
        configGroup.appendChild(sensitiveExportLabel);
        configGroup.appendChild(configButtonsGroup);

        const runtimeGroup = createSettingGroup('运行与诊断', '工具栏显示、任务并发、会话凭据与脱敏诊断报告');
        const makeRuntimeToggle = (labelText, checked) => {
            const label = document.createElement('label');
            label.style.cssText = 'display:flex;align-items:center;gap:8px;margin:7px 0;font-size:12px;';
            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox'; checkbox.checked = checked;
            label.append(checkbox, document.createTextNode(labelText));
            runtimeGroup.appendChild(label);
            return checkbox;
        };
        const compactModeCheckbox = makeRuntimeToggle('启用帖子工具栏极简模式', CFG.toolbarCompactMode);
        const sessionCredentialsCheckbox = makeRuntimeToggle('网盘凭据仅保留在当前页面内存中（刷新或离开即清除）', CFG.credentialsSessionOnly);
        const debugModeCheckbox = makeRuntimeToggle('启用调试诊断日志（日志会自动脱敏）', CFG.debugMode);
        const concurrencyRow = document.createElement('label');
        concurrencyRow.style.cssText = 'display:flex;align-items:center;gap:8px;margin:7px 0;font-size:12px;';
        concurrencyRow.append(document.createTextNode('网盘任务并发数：'));
        const cloudConcurrencyInput = document.createElement('input');
        cloudConcurrencyInput.type = 'number'; cloudConcurrencyInput.min = '1'; cloudConcurrencyInput.max = '4';
        cloudConcurrencyInput.value = String(CFG.cloudTaskConcurrency || 2);
        cloudConcurrencyInput.style.width = '64px';
        concurrencyRow.append(cloudConcurrencyInput);
        runtimeGroup.appendChild(concurrencyRow);
        const diagnosticExportButton = document.createElement('button');
        diagnosticExportButton.type = 'button';
        setIconLabel(diagnosticExportButton, 'download', '导出脱敏诊断报告');
        diagnosticExportButton.style.cssText = 'padding:7px 12px;border:1px solid #777;border-radius:4px;background:#fff;cursor:pointer;margin-top:6px;';
        diagnosticExportButton.addEventListener('click', exportDiagnosticReport);
        runtimeGroup.appendChild(diagnosticExportButton);

        // 将 filterGroup 和 configGroup 添加到高级设置标签页
        advancedForm.appendChild(filterGroup);
        advancedForm.appendChild(runtimeGroup);
        advancedForm.appendChild(configGroup);
        advancedTab.appendChild(advancedForm);

        // ===== 115 离线下载配置 =====
        const pan115Form = document.createElement('form');
        pan115Form.style.cssText = 'display: grid; gap: 15px;';

        const pan115Group = document.createElement('div');
        pan115Group.style.cssText = 'margin: 8px 0; display: flex; flex-direction: column;';
        const pan115Label = document.createElement('label');
        pan115Label.textContent = '115 离线下载:';
        pan115Label.style.cssText = 'margin-bottom: 4px; font-size: 12px; color: #666;';
        pan115Group.appendChild(pan115Label);

        const pan115EnabledGroup = document.createElement('div');
        pan115EnabledGroup.style.cssText = 'margin: 8px 0; display: flex; align-items: center;';
        const pan115EnabledCheckbox = document.createElement('input');
        pan115EnabledCheckbox.type = 'checkbox';
        pan115EnabledCheckbox.checked = CFG.pan115Enabled;
        pan115EnabledCheckbox.style.marginRight = '8px';
        pan115EnabledGroup.appendChild(pan115EnabledCheckbox);
        pan115EnabledGroup.appendChild(document.createTextNode('启用 115 离线下载功能'));
        pan115Group.appendChild(pan115EnabledGroup);

        const pan115CookieGroup = createSettingGroup('Cookie', '115 网盘完整 Cookie（USERSESSIONID、UID、CID 等参数），通过浏览器开发者工具复制。');
        const pan115CookieInput = document.createElement('textarea');
        pan115CookieInput.value = CFG.pan115Cookie;
        pan115CookieInput.rows = 4;
        pan115CookieInput.placeholder = 'USERSESSIONID=...; UID=...; CID=...; SEID=...';
        pan115CookieInput.style.cssText = 'width: 100%; padding: 8px; border: 1px solid #ddd; border-radius: 4px; font-family: monospace;';
        pan115CookieGroup.appendChild(pan115CookieInput);
        attachSensitiveFieldControls(pan115CookieGroup, pan115CookieInput);
        pan115Group.appendChild(pan115CookieGroup);

        const pan115UserAgentGroup = createSettingGroup('User-Agent (可选)', '默认使用当前浏览器 UA，如需仿真 115 浏览器可在此自定义。');
        const pan115UserAgentInput = document.createElement('input');
        pan115UserAgentInput.type = 'text';
        pan115UserAgentInput.value = CFG.pan115UserAgent || '';
        pan115UserAgentInput.placeholder = navigator.userAgent;
        pan115UserAgentInput.style.cssText = 'width: 100%; padding: 8px; border: 1px solid #ddd; border-radius: 4px; font-family: monospace;';
        pan115UserAgentGroup.appendChild(pan115UserAgentInput);
        pan115Group.appendChild(pan115UserAgentGroup);

        const pan115CredentialActions = document.createElement('div');
        pan115CredentialActions.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap;margin:4px 0 10px;';
        const pan115TestButton = document.createElement('button');
        pan115TestButton.type = 'button'; pan115TestButton.textContent = '测试 115 连接';
        const pan115ClearButton = document.createElement('button');
        pan115ClearButton.type = 'button'; pan115ClearButton.textContent = '清除 115 凭据';
        [pan115TestButton, pan115ClearButton].forEach(button => { button.style.cssText = 'padding:6px 10px;border:1px solid #999;border-radius:4px;background:#fff;cursor:pointer;'; });
        pan115TestButton.addEventListener('click', async () => {
            pan115TestButton.disabled = true; pan115TestButton.textContent = '测试中…';
            try {
                const result = await testCloudProviderConnection('pan115', { cookie: pan115CookieInput.value, userAgent: pan115UserAgentInput.value });
                showToast(`115 连接成功（UID: ${result.uid}）`, 'success');
            } catch (error) { showToast(`115 连接失败：${describeRequestError(error)}`, 'error', 5000); }
            finally { pan115TestButton.disabled = false; pan115TestButton.textContent = '测试 115 连接'; }
        });
        pan115ClearButton.addEventListener('click', () => {
            pan115CookieInput.value = ''; pan115UserAgentInput.value = '';
            showToast('115 凭据输入框已清空，保存设置后生效', 'info');
        });
        pan115CredentialActions.append(pan115TestButton, pan115ClearButton);
        pan115Group.appendChild(pan115CredentialActions);

        const pan115UploadDirGroup = createSettingGroup('保存目录 ID (可选)', '填写 115 网盘目标目录 ID (wp_path_id)。留空则使用默认离线目录。');
        const pan115UploadDirInput = document.createElement('input');
        pan115UploadDirInput.type = 'text';
        pan115UploadDirInput.value = CFG.pan115UploadDir || '';
        pan115UploadDirInput.placeholder = '例如：3139826240074917796';
        pan115UploadDirInput.style.cssText = 'width: 100%; padding: 8px; border: 1px solid #ddd; border-radius: 4px;';
        pan115UploadDirGroup.appendChild(pan115UploadDirInput);
        pan115Group.appendChild(pan115UploadDirGroup);

        const pan115Hint = document.createElement('div');
        pan115Hint.style.cssText = 'font-size: 12px; color: #888; line-height: 1.5;';
        pan115Hint.innerHTML = '• 115 支持 ED2K、磁力链接离线下载<br>• 提交任务前脚本会自动获取 sign/time/uid<br>• 请确保 Cookie 信息最新，必要时在 115 官方网站重新复制';
        pan115Group.appendChild(pan115Hint);

        const pan115FolderGroup = createSettingGroup('文件夹管理', '为 115 离线创建或管理专用文件夹');
        const pan115FolderInfo = document.createElement('div');
        pan115FolderInfo.id = 'sht-pan115-folder-info';
        pan115FolderInfo.style.cssText = 'font-size: 12px; color: #666; margin-bottom: 10px; line-height: 1.5;';
        pan115FolderGroup.appendChild(pan115FolderInfo);

        const pan115FolderButtons = document.createElement('div');
        pan115FolderButtons.style.cssText = 'display: flex; gap: 10px; flex-wrap: wrap;';

        const pan115CreateFolderBtn = document.createElement('button');
        pan115CreateFolderBtn.type = 'button';
        setIconLabel(pan115CreateFolderBtn, 'folder', '新建 115 文件夹');
        pan115CreateFolderBtn.style.cssText = `
    padding: 8px 16px;
    background: linear-gradient(135deg, #f6c343 0%, #f49f0a 100%);
    color: #3b2f09;
    border: none;
    border-radius: 4px;
    cursor: pointer;
    font-weight: bold;
    display: flex;
    align-items: center;
    gap: 4px;
  `;
        pan115CreateFolderBtn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            showCreate115FolderDialog();
        });

        pan115FolderButtons.appendChild(pan115CreateFolderBtn);
        pan115FolderGroup.appendChild(pan115FolderButtons);
        pan115Group.appendChild(pan115FolderGroup);

        pan115Form.appendChild(pan115Group);
        pan115Tab.appendChild(pan115Form);
        refreshPan115FolderInfo();

        // ===== 123Pan 离线下载配置 =====
        const pan123Group = document.createElement('div');
        pan123Group.style.cssText = 'margin: 8px 0; display: flex; flex-direction: column;';
        const pan123Label = document.createElement('label');
        pan123Label.textContent = '123Pan 离线下载:';
        pan123Label.style.cssText = 'margin-bottom: 4px; font-size: 12px; color: #666;';
        pan123Group.appendChild(pan123Label);

        // 启用 123Pan
        const pan123EnabledCheckbox = document.createElement('input');
        pan123EnabledCheckbox.type = 'checkbox';
        pan123EnabledCheckbox.checked = CFG.pan123Enabled;
        pan123EnabledCheckbox.style.marginRight = '8px';
        const pan123EnabledGroup = document.createElement('div');
        pan123EnabledGroup.style.cssText = 'margin: 8px 0; display: flex; align-items: center;';
        pan123EnabledGroup.appendChild(pan123EnabledCheckbox);
        pan123EnabledGroup.appendChild(document.createTextNode('启用 123Pan 离线下载功能'));
        pan123Group.appendChild(pan123EnabledGroup);

        // Token 配置
        const pan123TokenGroup = createSettingGroup('Token', '123Pan API Token (Bearer 开头)');
        const pan123TokenInput = document.createElement('input');
        pan123TokenInput.type = 'text';
        pan123TokenInput.value = CFG.pan123Token;
        pan123TokenInput.placeholder = 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...';
        pan123TokenInput.style.cssText = 'width: 100%; padding: 8px; border: 1px solid #ddd; border-radius: 4px; font-family: monospace;';
        pan123TokenGroup.appendChild(pan123TokenInput);
        attachSensitiveFieldControls(pan123TokenGroup, pan123TokenInput);
        pan123Group.appendChild(pan123TokenGroup);

        // Login UUID 配置
        const pan123LoginUuidGroup = createSettingGroup('Login UUID', '123Pan 登录 UUID');
        const pan123LoginUuidInput = document.createElement('input');
        pan123LoginUuidInput.type = 'text';
        pan123LoginUuidInput.value = CFG.pan123LoginUuid;
        pan123LoginUuidInput.placeholder = '7ab2526ea059412c87f7ff866ff5c2ac...';
        pan123LoginUuidInput.style.cssText = 'width: 100%; padding: 8px; border: 1px solid #ddd; border-radius: 4px; font-family: monospace;';
        pan123LoginUuidGroup.appendChild(pan123LoginUuidInput);
        attachSensitiveFieldControls(pan123LoginUuidGroup, pan123LoginUuidInput);
        pan123Group.appendChild(pan123LoginUuidGroup);

        // Cookie 配置
        const pan123CookieGroup = createSettingGroup('Cookie', '123Pan Cookie');
        const pan123CookieInput = document.createElement('textarea');
        pan123CookieInput.value = CFG.pan123Cookie;
        pan123CookieInput.rows = 3;
        pan123CookieInput.placeholder = 'cna=xxx; HMACCOUNT=xxx; ...';
        pan123CookieInput.style.cssText = 'width: 100%; padding: 8px; border: 1px solid #ddd; border-radius: 4px; font-family: monospace;';
        pan123CookieGroup.appendChild(pan123CookieInput);
        attachSensitiveFieldControls(pan123CookieGroup, pan123CookieInput);
        pan123Group.appendChild(pan123CookieGroup);

        const pan123CredentialActions = document.createElement('div');
        pan123CredentialActions.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap;margin:4px 0 10px;';
        const pan123TestButton = document.createElement('button');
        pan123TestButton.type = 'button'; pan123TestButton.textContent = '测试 123Pan 连接';
        const pan123ClearButton = document.createElement('button');
        pan123ClearButton.type = 'button'; pan123ClearButton.textContent = '清除 123Pan 凭据';
        [pan123TestButton, pan123ClearButton].forEach(button => { button.style.cssText = 'padding:6px 10px;border:1px solid #999;border-radius:4px;background:#fff;cursor:pointer;'; });
        pan123TestButton.addEventListener('click', async () => {
            pan123TestButton.disabled = true; pan123TestButton.textContent = '测试中…';
            try {
                await testCloudProviderConnection('pan123', {
                    token: pan123TokenInput.value, loginUuid: pan123LoginUuidInput.value, cookie: pan123CookieInput.value
                });
                showToast('123Pan 连接成功', 'success');
            } catch (error) { showToast(`123Pan 连接失败：${describeRequestError(error)}`, 'error', 5000); }
            finally { pan123TestButton.disabled = false; pan123TestButton.textContent = '测试 123Pan 连接'; }
        });
        pan123ClearButton.addEventListener('click', () => {
            pan123TokenInput.value = ''; pan123LoginUuidInput.value = ''; pan123CookieInput.value = '';
            showToast('123Pan 凭据输入框已清空，保存设置后生效', 'info');
        });
        pan123CredentialActions.append(pan123TestButton, pan123ClearButton);
        pan123Group.appendChild(pan123CredentialActions);

        // 上传目录配置
        const pan123UploadDirGroup = createSettingGroup('上传目录 ID', '123Pan 上传目录 ID (可选)');
        const pan123UploadDirInput = document.createElement('input');
        pan123UploadDirInput.type = 'text';
        pan123UploadDirInput.value = CFG.pan123UploadDir;
        pan123UploadDirInput.placeholder = '123456';
        pan123UploadDirInput.style.cssText = 'width: 100%; padding: 8px; border: 1px solid #ddd; border-radius: 4px;';
        pan123UploadDirGroup.appendChild(pan123UploadDirInput);
        pan123Group.appendChild(pan123UploadDirGroup);

        // 文件过滤配置
        const pan123FilterGroup = document.createElement('div');
        pan123FilterGroup.style.cssText = 'margin: 8px 0; display: flex; flex-direction: column;';
        const pan123FilterLabel = document.createElement('label');
        pan123FilterLabel.textContent = '文件过滤配置:';
        pan123FilterLabel.style.cssText = 'margin-bottom: 4px; font-size: 12px; color: #666;';
        pan123FilterGroup.appendChild(pan123FilterLabel);

        // 最小文件大小
        const pan123MinSizeGroup = createSettingGroup('最小文件大小', '例如: 10MB');
        const pan123MinSizeInput = document.createElement('input');
        pan123MinSizeInput.type = 'text';
        pan123MinSizeInput.value = CFG.pan123MinSize;
        pan123MinSizeInput.placeholder = '10MB';
        pan123MinSizeInput.style.cssText = 'width: 100%; padding: 8px; border: 1px solid #ddd; border-radius: 4px;';
        pan123MinSizeGroup.appendChild(pan123MinSizeInput);
        pan123FilterGroup.appendChild(pan123MinSizeGroup);

        // 最大文件大小
        const pan123MaxSizeGroup = createSettingGroup('最大文件大小', '例如: 1000GB');
        const pan123MaxSizeInput = document.createElement('input');
        pan123MaxSizeInput.type = 'text';
        pan123MaxSizeInput.value = CFG.pan123MaxSize;
        pan123MaxSizeInput.placeholder = '1000GB';
        pan123MaxSizeInput.style.cssText = 'width: 100%; padding: 8px; border: 1px solid #ddd; border-radius: 4px;';
        pan123MaxSizeGroup.appendChild(pan123MaxSizeInput);
        pan123FilterGroup.appendChild(pan123MaxSizeGroup);

        // 包含扩展名
        const pan123IncludeExtGroup = createSettingGroup('包含扩展名', '逗号分隔，例如: mp4,avi,mkv');
        const pan123IncludeExtInput = document.createElement('input');
        pan123IncludeExtInput.type = 'text';
        pan123IncludeExtInput.value = CFG.pan123IncludeExt;
        pan123IncludeExtInput.placeholder = 'mp4,avi,mkv,wmv,flv,mov';
        pan123IncludeExtInput.style.cssText = 'width: 100%; padding: 8px; border: 1px solid #ddd; border-radius: 4px;';
        pan123IncludeExtGroup.appendChild(pan123IncludeExtInput);
        pan123FilterGroup.appendChild(pan123IncludeExtGroup);

        // 排除扩展名
        const pan123ExcludeExtGroup = createSettingGroup('排除扩展名', '逗号分隔，例如: txt,nfo,jpg,png');
        const pan123ExcludeExtInput = document.createElement('input');
        pan123ExcludeExtInput.type = 'text';
        pan123ExcludeExtInput.value = CFG.pan123ExcludeExt;
        pan123ExcludeExtInput.placeholder = 'txt,nfo,srt,sub,url,mht,jpg,jpeg,png,gif,bmp,webp,ico,svg';
        pan123ExcludeExtInput.style.cssText = 'width: 100%; padding: 8px; border: 1px solid #ddd; border-radius: 4px;';
        pan123ExcludeExtGroup.appendChild(pan123ExcludeExtInput);
        pan123FilterGroup.appendChild(pan123ExcludeExtGroup);

        // 视频文件最小大小
        const pan123VideoMinSizeGroup = createSettingGroup('视频文件最小大小', '例如: 100MB');
        const pan123VideoMinSizeInput = document.createElement('input');
        pan123VideoMinSizeInput.type = 'text';
        pan123VideoMinSizeInput.value = CFG.pan123VideoMinSize;
        pan123VideoMinSizeInput.placeholder = '100MB';
        pan123VideoMinSizeInput.style.cssText = 'width: 100%; padding: 8px; border: 1px solid #ddd; border-radius: 4px;';
        pan123VideoMinSizeGroup.appendChild(pan123VideoMinSizeInput);
        pan123FilterGroup.appendChild(pan123VideoMinSizeGroup);

        // 选择最大文件
        const pan123PickLargestCheckbox = document.createElement('input');
        pan123PickLargestCheckbox.type = 'checkbox';
        pan123PickLargestCheckbox.checked = CFG.pan123PickLargest;
        pan123PickLargestCheckbox.style.marginRight = '8px';
        const pan123PickLargestGroup = document.createElement('div');
        pan123PickLargestGroup.style.cssText = 'margin: 8px 0; display: flex; align-items: center;';
        pan123PickLargestGroup.appendChild(pan123PickLargestCheckbox);
        pan123PickLargestGroup.appendChild(document.createTextNode('只选择最大的文件'));
        pan123FilterGroup.appendChild(pan123PickLargestGroup);

        pan123Group.appendChild(pan123FilterGroup);

        // 秒离线处理配置
        const pan123InstantGroup = document.createElement('div');
        pan123InstantGroup.style.cssText = 'margin: 8px 0; display: flex; flex-direction: column;';
        const pan123InstantLabel = document.createElement('label');
        pan123InstantLabel.textContent = '秒离线处理:';
        pan123InstantLabel.style.cssText = 'margin-bottom: 4px; font-size: 12px; color: #666;';
        pan123InstantGroup.appendChild(pan123InstantLabel);

        // 秒离线处理方式选择
        const pan123InstantActionGroup = document.createElement('div');
        pan123InstantActionGroup.style.cssText = 'margin: 8px 0; display: flex; flex-direction: column; gap: 8px;';

        const pan123InstantActionLabel = document.createElement('label');
        pan123InstantActionLabel.textContent = '秒离线失败时的处理方式:';
        pan123InstantActionLabel.style.cssText = 'font-size: 12px; color: #333;';
        pan123InstantActionGroup.appendChild(pan123InstantActionLabel);

        const pan123InstantActionSelect = document.createElement('select');
        pan123InstantActionSelect.style.cssText = 'padding: 4px 8px; border: 1px solid #ddd; border-radius: 4px; font-size: 12px;';
        pan123InstantActionSelect.innerHTML = `
    <option value="auto_cancel">自动取消任务</option>
    <option value="ask_user">询问用户是否取消</option>
    <option value="keep_task">保留任务</option>
  `;
        pan123InstantActionSelect.value = CFG.pan123InstantOfflineAction || 'auto_cancel';
        pan123InstantActionGroup.appendChild(pan123InstantActionSelect);

        // 检查延迟时间
        const pan123DelayGroup = document.createElement('div');
        pan123DelayGroup.style.cssText = 'margin: 8px 0; display: flex; align-items: center; gap: 8px;';

        const pan123DelayLabel = document.createElement('label');
        pan123DelayLabel.textContent = '检查延迟时间(毫秒):';
        pan123DelayLabel.style.cssText = 'font-size: 12px; color: #333; min-width: 120px;';
        pan123DelayGroup.appendChild(pan123DelayLabel);

        const pan123DelayInput = document.createElement('input');
        pan123DelayInput.type = 'number';
        pan123DelayInput.value = CFG.pan123InstantOfflineCheckDelay || 2000;
        pan123DelayInput.min = '1000';
        pan123DelayInput.max = '10000';
        pan123DelayInput.step = '500';
        pan123DelayInput.style.cssText = 'padding: 4px 8px; border: 1px solid #ddd; border-radius: 4px; font-size: 12px; width: 100px;';
        pan123DelayGroup.appendChild(pan123DelayInput);

        // 批量发送间隔时间
        const pan123BatchIntervalGroup = document.createElement('div');
        pan123BatchIntervalGroup.style.cssText = 'margin: 8px 0; display: flex; align-items: center; gap: 8px;';

        const pan123BatchIntervalLabel = document.createElement('label');
        pan123BatchIntervalLabel.textContent = '批量发送间隔(毫秒):';
        pan123BatchIntervalLabel.style.cssText = 'font-size: 12px; color: #333; min-width: 120px;';
        pan123BatchIntervalGroup.appendChild(pan123BatchIntervalLabel);

        const pan123BatchIntervalInput = document.createElement('input');
        pan123BatchIntervalInput.type = 'number';
        pan123BatchIntervalInput.value = CFG.pan123BatchSendInterval || 2000;
        pan123BatchIntervalInput.min = '100';
        pan123BatchIntervalInput.max = '60000';
        pan123BatchIntervalInput.step = '100';
        pan123BatchIntervalInput.style.cssText = 'padding: 4px 8px; border: 1px solid #ddd; border-radius: 4px; font-size: 12px; width: 100px;';
        pan123BatchIntervalGroup.appendChild(pan123BatchIntervalInput);

        pan123InstantGroup.appendChild(pan123InstantActionGroup);
        pan123InstantGroup.appendChild(pan123DelayGroup);
        pan123InstantGroup.appendChild(pan123BatchIntervalGroup);
        pan123Group.appendChild(pan123InstantGroup);

        // 123Pan文件夹管理
        const folderGroup = createSettingGroup('文件夹管理', '123Pan文件夹操作');
        const pan123FolderInfo = document.createElement('div');
        pan123FolderInfo.id = 'sht-pan123-folder-info';
        pan123FolderInfo.style.cssText = 'font-size: 12px; color: #666; margin-bottom: 10px; line-height: 1.5;';
        folderGroup.appendChild(pan123FolderInfo);
        const folderButtonsGroup = document.createElement('div');
        folderButtonsGroup.style.cssText = 'margin: 8px 0; display: flex; gap: 10px; flex-wrap: wrap;';

        const createFolderBtn = document.createElement('button');
        setIconLabel(createFolderBtn, 'folder', '123 新建');
        createFolderBtn.style.cssText = `
    padding: 8px 16px;
    background: linear-gradient(135deg, #28a745 0%, #1e7e34 100%);
    color: white;
    border: none;
    border-radius: 4px;
    cursor: pointer;
    font-weight: bold;
    display: flex;
    align-items: center;
    gap: 4px;
  `;
        createFolderBtn.addEventListener('mouseenter', () => {
            createFolderBtn.style.background = 'linear-gradient(135deg, #1e7e34 0%, #155724 100%)';
            createFolderBtn.style.transform = 'translateY(-1px)';
            createFolderBtn.style.boxShadow = '0 2px 6px rgba(0,0,0,0.15)';
        });
        createFolderBtn.addEventListener('mouseleave', () => {
            createFolderBtn.style.background = 'linear-gradient(135deg, #28a745 0%, #1e7e34 100%)';
            createFolderBtn.style.transform = 'translateY(0)';
            createFolderBtn.style.boxShadow = '0 1px 3px rgba(0,0,0,0.1)';
        });
        createFolderBtn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            showCreateFolderDialog();
        });

        folderButtonsGroup.appendChild(createFolderBtn);
        folderGroup.appendChild(folderButtonsGroup);

        // 将 123Pan 设置添加到 123Pan 标签页
        const pan123Form = document.createElement('form');
        pan123Form.style.cssText = 'display: grid; gap: 15px;';
        pan123Form.appendChild(pan123Group);
        pan123Form.appendChild(folderGroup);
        pan123Tab.appendChild(pan123Form);
        refreshPan123FolderInfo();

        // 将所有标签页添加到内容区域
        contentArea.appendChild(basicTab);
        contentArea.appendChild(displayTab);
        contentArea.appendChild(collectionTab);
        contentArea.appendChild(pan115Tab);
        contentArea.appendChild(pan123Tab);
        contentArea.appendChild(advancedTab);

        // 按钮区域
        const buttonArea = document.createElement('div');
        buttonArea.style.cssText = 'padding: 15px 20px; border-top: 1px solid #eee; background: #f8f9fa;';

        const buttonGroup = document.createElement('div');
        buttonGroup.style.cssText = 'display: flex; gap: 10px; justify-content: flex-end;';

        const cancelBtn = document.createElement('button');
        cancelBtn.textContent = '取消';
        cancelBtn.type = 'button';
        cancelBtn.style.cssText = 'padding: 8px 16px; border: 1px solid #ddd; background: #f5f5f5; border-radius: 4px; cursor: pointer;';
        cancelBtn.onclick = () => dialog.remove();

        const saveBtn = document.createElement('button');
        saveBtn.textContent = '保存设置';
        saveBtn.type = 'button';
        saveBtn.style.cssText = 'padding: 8px 16px; border: none; background: #007cba; color: white; border-radius: 4px; cursor: pointer;';
        saveBtn.onclick = () => {
            // 保存设置
            CFG.passwordCandidates = pwdInput.value.split('\n').map(s => s.trim()).filter(Boolean);
            CFG.maxAutoBytes = parseInt(autoInput.value) || 2 * 1024 * 1024;
            CFG.maxEntryBytes = parseInt(entryInput.value) || 3 * 1024 * 1024;
            CFG.autoHoistToTop = hoistCheckbox.checked;
            CFG.blockImages = imgCheckbox.checked;
            CFG.imageAllowDomains = whiteInput.value.split(',').map(s => s.trim()).filter(Boolean);
            CFG.imagePlaceholderShowMeta = metaCheckbox.checked;
            CFG.autoCollectED2K = ed2kCheckbox.checked;
            CFG.autoCollectMagnet = magnetCheckbox.checked;

            // ED2K文件名替换设置
            CFG.ed2kFileNameReplaceEnabled = ed2kReplaceCheckbox.checked;

            // 收集替换规则
            const ed2kRules = [];
            const ruleDivs = rulesList.querySelectorAll('div');
            ruleDivs.forEach(ruleDiv => {
                const inputs = ruleDiv.querySelectorAll('input');
                if (inputs.length >= 2) {
                    const pattern = inputs[0].value.trim();
                    const replacement = inputs[1].value.trim();
                    if (pattern) {
                        ed2kRules.push({ pattern, replacement });
                    }
                }
            });
            CFG.ed2kFileNameReplaceRules = ed2kRules;
            CFG.authorOnlyMode = authorOnlyCheckbox.checked;
            CFG.enableHistory = historyCheckbox.checked;
            CFG.maxHistoryItems = parseInt(historyLimitInput.value) || 1000;

            // 排版优化设置
            CFG.hideReplyColumn = hideReplyCheckbox.checked;
            CFG.hideLastReplyColumn = hideLastReplyCheckbox.checked;
            CFG.hideAuthorColumn = hideAuthorCheckbox.checked;
            CFG.hideStickyThreads = hideStickyCheckbox.checked;

            // 分页和过滤设置
            CFG.hidePagination = hidePaginationCheckbox.checked;
            CFG.enhanceTitles = enhanceTitlesCheckbox.checked;
            CFG.enableKeywordFilter = keywordFilterCheckbox.checked;
            CFG.keywordFilters = keywordTextarea.value.split('\n').filter(line => line.trim() !== '');

            // 列表页标题正则替换设置
            CFG.enableListTitleEnhance = listTitleCheckbox.checked;
            const listRulesText = listRulesTextarea.value.split('\n').filter(line => line.trim() !== '');
            CFG.listTitleReplaceRules = listRulesText.map(line => {
                const parts = line.split('|');
                return {
                    pattern: parts[0] || '',
                    replacement: parts[1] || ''
                };
            });

            // 历史访问帖子处理设置
            CFG.historyPostAction = historyPostSelect.value;
            CFG.historyPostColor = colorInput.value;

            // 帖子详情标题处理设置
            CFG.enableThreadTitleEnhance = threadTitleCheckbox.checked;
            const rulesText = rulesTextarea.value.split('\n').filter(line => line.trim() !== '');
            CFG.titleReplaceRules = rulesText.map(line => {
                const parts = line.split('|');
                return {
                    pattern: parts[0] || '',
                    replacement: parts[1] || ''
                };
            });
            CFG.hideTypeLabels = hideTypeCheckbox.checked ? ['情色分享', '图文故事', '视频分享'] : [];

            // 论坛模块屏蔽
            CFG.enableModuleFilter = moduleFilterCheckbox.checked;
            CFG.hiddenModules = moduleTextarea.value.split('\n').filter(s => s.trim());

            // 一键评分设置
            CFG.enableQuickRate = quickRateCheckbox.checked;
            CFG.defaultRateScore = parseInt(rateScoreInput.value) || 2;
            CFG.defaultRateReason = reasonInput.value.trim() || '很给力!';

            CFG.toolbarCompactMode = compactModeCheckbox.checked;
            CFG.credentialsSessionOnly = sessionCredentialsCheckbox.checked;
            CFG.debugMode = debugModeCheckbox.checked;
            CFG.cloudTaskConcurrency = Math.max(1, Math.min(4, parseInt(cloudConcurrencyInput.value, 10) || 2));

            // 115 离线设置
            CFG.pan115Enabled = pan115EnabledCheckbox.checked;
            CFG.pan115Cookie = pan115CookieInput.value.trim();
            CFG.pan115UserAgent = pan115UserAgentInput.value.trim();
            CFG.pan115UploadDir = pan115UploadDirInput.value.trim();

            // 123Pan 设置
            CFG.pan123Enabled = pan123EnabledCheckbox.checked;
            CFG.pan123Token = pan123TokenInput.value.trim();
            CFG.pan123LoginUuid = pan123LoginUuidInput.value.trim();
            CFG.pan123Cookie = pan123CookieInput.value.trim();
            CFG.pan123UploadDir = pan123UploadDirInput.value.trim();
            CFG.pan123MinSize = pan123MinSizeInput.value.trim();
            CFG.pan123MaxSize = pan123MaxSizeInput.value.trim();
            CFG.pan123IncludeExt = pan123IncludeExtInput.value.trim();
            CFG.pan123ExcludeExt = pan123ExcludeExtInput.value.trim();
            CFG.pan123VideoMinSize = pan123VideoMinSizeInput.value.trim();
            CFG.pan123PickLargest = pan123PickLargestCheckbox.checked;
            CFG.pan123InstantOfflineAction = pan123InstantActionSelect.value;
            CFG.pan123InstantOfflineCheckDelay = parseInt(pan123DelayInput.value) || 2000;
            CFG.pan123BatchSendInterval = parseInt(pan123BatchIntervalInput.value) || 2000;

            saveConfig();
            dialog.remove();

            // 应用设置
            if (CFG.blockImages) applyImageBlocking(true, { forceRebuild: true }); else resetImageState();
            queueED2KScan(true); queueMagnetScan(true);

            // 应用排版设置
            applyLayoutSettings();

            // 应用论坛模块屏蔽
            if (isForumListPage || isForumHomePage) {
                applyModuleFilter();
            }

            if (CFG.credentialsSessionOnly) {
                showToast('设置已保存；临时凭据已在当前页面生效，刷新或离开页面即清除', 'success', 5000);
            } else {
                showToast('设置已保存，页面将刷新以应用新设置', 'success');
                setTimeout(() => location.reload(), 1000);
            }
        };

        buttonGroup.appendChild(cancelBtn);
        buttonGroup.appendChild(saveBtn);
        buttonArea.appendChild(buttonGroup);

        // 组装对话框
        panel.appendChild(title);
        panel.appendChild(tabNav);
        panel.appendChild(contentArea);
        panel.appendChild(buttonArea);
        dialog.appendChild(panel);
        document.body.appendChild(dialog);

        // 点击背景关闭
        dialog.onclick = (e) => { if (e.target === dialog) dialog.remove(); };
    }

    function createSettingGroup(title, description) {
        const group = document.createElement('div');
        group.style.cssText = 'border: 1px solid #eee; border-radius: 6px; padding: 15px; background: #fafafa;';

        const titleEl = document.createElement('div');
        titleEl.textContent = title;
        titleEl.style.cssText = 'font-weight: bold; margin-bottom: 5px; color: #333;';

        const descEl = document.createElement('div');
        descEl.textContent = description;
        descEl.style.cssText = 'font-size: 12px; color: #666; margin-bottom: 10px;';

        const inputContainer = document.createElement('div');

        group.appendChild(titleEl);
        group.appendChild(descEl);
        group.appendChild(inputContainer);

        // 返回输入容器，用于添加输入控件
        group.inputContainer = inputContainer;
        group.appendChild = (child) => inputContainer.appendChild(child);

        return group;
    }

    function attachSensitiveFieldControls(group, field) {
        let revealed = false;
        const applyMask = () => {
            if (field.tagName === 'INPUT') field.type = revealed ? 'text' : 'password';
            else field.style.webkitTextSecurity = revealed ? 'none' : 'disc';
        };
        applyMask();
        field.autocomplete = 'off';
        field.spellcheck = false;
        const actions = document.createElement('div');
        actions.style.cssText = 'display:flex;gap:8px;margin-top:6px;';
        const reveal = document.createElement('button');
        reveal.type = 'button'; reveal.textContent = '显示';
        const clear = document.createElement('button');
        clear.type = 'button'; clear.textContent = '清空';
        [reveal, clear].forEach(button => { button.style.cssText = 'padding:3px 8px;border:1px solid #aaa;border-radius:4px;background:#fff;cursor:pointer;font-size:12px;'; });
        reveal.addEventListener('click', () => {
            revealed = !revealed;
            applyMask();
            reveal.textContent = revealed ? '隐藏' : '显示';
        });
        clear.addEventListener('click', () => { field.value = ''; });
        actions.append(reveal, clear);
        group.appendChild(actions);
    }

    /*********************** 附件预览（同前） ***********************/
    const SELECTOR_ATTACH_ANCHOR = 'a[href*="forum.php?mod=attachment"][href*="aid="]';
    function queryWithin(root, selector) {
        const found = [];
        if (root instanceof Element && root.matches(selector)) found.push(root);
        root.querySelectorAll?.(selector).forEach(node => found.push(node));
        return found;
    }

    function enhanceAttachmentAnchor(anchor) {
        if (anchor.dataset._shtEnhanced) return;
        anchor.dataset._shtEnhanced = '1';
        const name = (anchor.textContent || '').trim();
        const span = anchor.closest('span[id^="attach_"]');
        buildInlineUI(anchor, name, parseSizeBytesFromSpan(span));
    }

    function scanThreadContent(roots, { forceImages = false, forceLinks = false } = {}) {
        if (!isThreadPage) return;
        const imageCandidates = new Set();
        let contentMayContainLinks = forceLinks;

        markDownloadLinkScopes(roots);

        roots.forEach(root => {
            if (!(root instanceof Element) && root !== document) return;
            if (root instanceof Element && root.closest('[class^="sht-"], [id^="sht-"]')) return;

            queryWithin(root, SELECTOR_ATTACH_ANCHOR).forEach(enhanceAttachmentAnchor);
            queryWithin(root, '[id^="postmessage_"] img').forEach(img => imageCandidates.add(img));
            if (root === document ||
                (root instanceof Element && (root.matches('[id^="postmessage_"]') || root.closest('[id^="postmessage_"]') || root.querySelector?.('[id^="postmessage_"]')))) {
                contentMayContainLinks = true;
            }
        });

        if (CFG.blockImages && imageCandidates.size) {
            applyImageBlocking(true, { forceRebuild: forceImages, candidates: imageCandidates });
        }
        if (contentMayContainLinks) {
            queueED2KScan(forceLinks);
            queueMagnetScan(forceLinks);
        }
    }

    function buildInlineUI(a, filename, bytes) {
        const wrap = document.createElement('div'); wrap.className = 'sht-inline'; wrap.style.cssText = 'margin:6px 0 12px 0';
        const bar = document.createElement('div'); bar.style.cssText = 'display:inline-flex;gap:6px;flex-wrap:wrap;align-items:center';
        const mkBtn = (t, fn) => { const b = document.createElement('button'); b.textContent = t; b.style.cssText = 'padding:2px 8px;cursor:pointer'; b.addEventListener('click', fn); return b; };

        const rawName = (filename || '').trim();
        const resolvedName = guessAttachmentName(a, rawName);
        const effectiveName = resolvedName || rawName || '附件';
        const info = document.createElement('span'); info.textContent = effectiveName + (bytes ? `  ·  ${formatBytes(bytes)}` : ''); info.style.cssText = 'font-size:12px;opacity:.75';

        const torrentPattern = /\.torrent(?:$|\?)/i;
        const imagePattern = /\.(?:jpg|jpeg|png|gif|webp|bmp|svg|ico)(?:$|\?)/i;
        const hrefVal = a?.href || '';
        const isTorrentFile = torrentPattern.test(resolvedName || '') || torrentPattern.test(rawName) || torrentPattern.test(hrefVal);
        const isImageFile = imagePattern.test(resolvedName || '') || imagePattern.test(rawName) || imagePattern.test(hrefVal);

        if (isTorrentFile) {
            const btnDownload = mkBtn('下载', () => {
                window.open(a.href, '_blank');
            });

            const btn123Pan = mkBtn('发送到123Pan', async () => {
                const title = (resolvedName || rawName || '').replace(/\.torrent$/i, '') || effectiveName;
                await sendTorrentAttachmentToPan123(btn123Pan, a.href, title);
            });

            bar.append(btnDownload, btn123Pan, info);
            wrap.append(bar);
            a.parentElement.insertAdjacentElement('afterend', wrap);

            agg?.addItem(effectiveName, a.href);
            return;
        }

        if (isImageFile) {
            const btnDownload = mkBtn('下载', () => {
                window.open(a.href, '_blank');
            });

            bar.append(btnDownload, info);
            wrap.append(bar);
            a.parentElement.insertAdjacentElement('afterend', wrap);
            return;
        }

        let activeController = null;
        const btnFetch = mkBtn('加载预览', () => {
            if (activeController) activeController.abort();
            else fetchAndShow({ enhancedDecoding: true });
        }); const btnCopy = mkBtn('复制', () => copyCurrent()); btnCopy.disabled = true;
        const btnHoist = mkBtn('上顶聚合', () => { if (ta.value) agg?.addItem(effectiveName, ta.value); }); const btnPw = mkBtn('设密码', () => openSettings());
        const ta = document.createElement('textarea'); ta.placeholder = '（附件内容将显示在这里）'; ta.rows = 8; ta.style.cssText = 'width:min(900px,100%);max-width:100%;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px;line-height:1.5;padding:6px;box-sizing:border-box;border-radius:6px;border:1px solid #ddd'; ta.readOnly = true;
        bar.append(btnFetch, btnCopy, btnHoist, btnPw, info); wrap.append(bar, ta); a.parentElement.insertAdjacentElement('afterend', wrap);
        // 仅自动预览小型纯文本；压缩包必须由用户点击，避免页面加载时下载解压依赖。
        if (isTextLike(effectiveName) && (!bytes || bytes <= CFG.maxAutoBytes)) fetchAndShow({ enhancedDecoding: false });

        function setLoading(loading, text = '加载中…') {
            btnFetch.disabled = false;
            btnFetch.textContent = loading ? `${text}（点击取消）` : '重新加载';
        }
        function copyCurrent() { GM_setClipboard(ta.value || ''); btnCopy.textContent = '已复制'; setTimeout(() => btnCopy.textContent = '复制', 1200); }
        async function fetchAndShow({ enhancedDecoding = true } = {}) {
            if (activeController) return;
            const controller = new AbortController();
            activeController = controller;
            try {
                setLoading(true); ta.value = ''; btnCopy.disabled = true;
                if (enhancedDecoding) {
                    setLoading(true, '加载编码组件…');
                    await loadOptionalLibrary('jschardet', { signal: controller.signal });
                }
                if (isZip(effectiveName)) {
                    setLoading(true, '加载 ZIP 组件…');
                    await loadOptionalLibrary('zip', { signal: controller.signal });
                }
                const url = absoluteUrl(a.href);
                setLoading(true, '下载附件…');
                const buf = await httpGetArrayBuffer(url, {
                    signal: controller.signal,
                    onProgress: ({ loaded, total }) => {
                        const progress = total > 0 ? ` ${Math.round((loaded / total) * 100)}%` : ` ${formatBytes(loaded)}`;
                        setLoading(true, `下载附件${progress}`);
                    }
                });
                const bin = new Uint8Array(buf);
                if (isImageBuffer(bin)) {
                    ta.value = '（图片文件，跳过预览）';
                    return;
                }
                if (isTextLike(effectiveName)) { const text = decodeBest(buf, effectiveName); showText(text, '(文本)'); }
                else if (isZip(effectiveName)) {
                    setLoading(true, '正在解压 ZIP…');
                    const out = await tryExtractZipTexts(buf, CFG.passwordCandidates, CFG.maxEntryBytes);
                    showArchiveTexts(out);
                }
                else if (isRar(effectiveName)) {
                    setLoading(true, '正在解压 RAR…');
                    const out = await tryExtractRarTexts(buf, CFG.passwordCandidates, CFG.maxEntryBytes);
                    showArchiveTexts(out);
                }
                else {
                    const text = decodeBest(buf, effectiveName);
                    if (text && /[\u0009\u000A\u000D\u0020-\u007E\u00A0-\uFFFF]/.test(text.slice(0, 200))) showText(text, '(猜测文本)');
                    else ta.value = '（不支持的附件类型，或内容非文本）';
                }
            } catch (error) {
                ta.value = `（${describeRequestError(error)}）`;
                diagnosticLog(error?.name === 'AbortError' ? 'debug' : 'warning', 'attachment', '附件预览未完成', {
                    filename: effectiveName, reason: describeRequestError(error)
                });
            } finally {
                if (activeController === controller) activeController = null;
                setLoading(false);
            }
        }
        function showText(text, note = '') {
            // 确保文本正确显示，处理可能的编码问题
            const cleanText = text ? text.replace(/\uFFFD/g, '') : '';
            ta.value = cleanText || '（空内容）';
            ta.readOnly = false;
            btnCopy.disabled = !cleanText;
            if (cleanText && CFG.autoHoistToTop) agg?.addItem(`${effectiveName} ${note}`, cleanText);
        }
        function showArchiveTexts(list) {
            if (!list.length) { ta.value = '（压缩包内未找到可展示的文本，或密码错误）'; return; }
            const join = list.map(x => `【${x.name}${x.pwd ? ` · 密码:${x.pwd}` : ''} · ${formatBytes(x.size)}】\n${x.text}`).join('\n\n' + '-'.repeat(40) + '\n\n'); showText(join, '(解包)');
        }
    }

    function guessAttachmentName(anchor, fallback = '') {
        try {
            if (anchor?.download) {
                const dl = anchor.download.trim();
                if (dl) return dl;
            }
            if (anchor?.title) {
                const title = anchor.title.trim();
                if (title) return title;
            }
            let candidate = fallback || '';
            const href = anchor?.getAttribute?.('href') || anchor?.href || '';
            if (href) {
                const url = new URL(href, location.href);
                const params = ['filename', 'file', 'name', 'attname', 'downfilename'];
                for (const key of params) {
                    const val = url.searchParams.get(key);
                    if (val) {
                        candidate = decodeURIComponent(val.replace(/\+/g, ' '));
                        break;
                    }
                }
                if (!candidate && url.pathname) {
                    const match = url.pathname.match(/\/([^/]+)$/);
                    if (match && match[1]) {
                        candidate = decodeURIComponent(match[1]);
                    }
                }
            }
            if (candidate) return candidate;
        } catch (err) {
            console.warn('guessAttachmentName error:', err);
        }
        return fallback || '';
    }

    function isImageBuffer(u8) {
        if (!(u8 instanceof Uint8Array)) return false;
        if (u8.length >= 2 && u8[0] === 0xff && u8[1] === 0xd8) return true; // JPEG
        if (u8.length >= 8 && u8[0] === 0x89 && u8[1] === 0x50 && u8[2] === 0x4e && u8[3] === 0x47) return true; // PNG
        if (u8.length >= 6 && u8[0] === 0x47 && u8[1] === 0x49 && u8[2] === 0x46 && u8[3] === 0x38) return true; // GIF
        if (u8.length >= 2 && u8[0] === 0x42 && u8[1] === 0x4d) return true; // BMP
        if (u8.length >= 12 && u8[0] === 0x52 && u8[1] === 0x49 && u8[2] === 0x46 && u8[3] === 0x46 && u8[8] === 0x57 && u8[9] === 0x45 && u8[10] === 0x42 && u8[11] === 0x50) return true; // WEBP
        if (u8.length >= 4 && u8[0] === 0x00 && u8[1] === 0x00 && (u8[2] === 0x01 || u8[2] === 0x02) && u8[3] === 0x00) return true; // ICO/CUR
        if (u8.length >= 4 && u8[0] === 0x49 && u8[1] === 0x49 && u8[2] === 0x2a && u8[3] === 0x00) return true; // TIFF (little-endian)
        if (u8.length >= 4 && u8[0] === 0x4d && u8[1] === 0x4d && u8[2] === 0x00 && u8[3] === 0x2a) return true; // TIFF (big-endian)
        return false;
    }

    /*********************** 图片屏蔽（候选集 + 解绑 + 防抖 + 强力隐藏兜底） ***********************/
    const style = document.createElement('style');
    style.textContent = `[id^="postmessage_"] img.sht-img-hidden{display:none!important}.sht-img-ph{display:inline-flex;align-items:center;gap:8px;padding:6px 8px;margin:4px 0;border:1px dashed #bbb;border-radius:6px;background:#fffef8}`;
    document.head.appendChild(style);

    let processedImg = new WeakSet();
    let placeholderMade = new WeakSet();
    let io = null;
    let pendingImgs = new Set();
    let pendingTimer = null;

    function resetImageState() {
        document.querySelectorAll('[id^="postmessage_"] img.sht-img-hidden').forEach(img => {
            img.classList.remove('sht-img-hidden');
            img.style.removeProperty('display');
            const ph = img.previousElementSibling;
            if (ph && ph.classList.contains('sht-img-ph')) ph.remove();
        });
        processedImg = new WeakSet();
        placeholderMade = new WeakSet();
        if (io) { io.disconnect(); io = null; }
        pendingImgs.clear(); if (pendingTimer) { clearTimeout(pendingTimer); pendingTimer = null; }
    }

    function shouldBypassByWhitelist(url) {
        if (!CFG.imageAllowDomains?.length) return false;
        const host = hostnameOf(url);
        return CFG.imageAllowDomains.some(d => host.endsWith(d));
    }
    function getImgSource(img) {
        const cand = [img.getAttribute('src'), img.getAttribute('file'), img.getAttribute('zoomfile'), img.dataset?.src, img.dataset?.original];
        return cand.find(x => x && !x.startsWith('data:')) || '';
    }
    function isSmallOrUIImg(img) {
        const cls = (img.className || '').toLowerCase();
        if (/(avatar|smilie|emoji|vm|icons?)/.test(cls)) return true;
        const w = img.naturalWidth || parseInt(img.getAttribute('width') || 0, 10);
        const h = img.naturalHeight || parseInt(img.getAttribute('height') || 0, 10);
        const m = Math.min(w || 0, h || 0);
        return m > 0 && m <= CFG.imageMinBlockSizePx;
    }
    function makePlaceholder(img, src) {
        const ph = document.createElement('div'); ph.className = 'sht-img-ph';
        if (CFG.imagePlaceholderShowMeta) {
            const meta = document.createElement('span'); meta.style.cssText = 'font-size:12px;opacity:.8';
            const host = hostnameOf(src); const name = (img.getAttribute('alt') || '').trim() || src.split('/').pop();
            meta.textContent = `图片已屏蔽 · ${host || '未知域'} · ${name}`; ph.append(meta);
        }
        const btn = document.createElement('button'); btn.textContent = '加载此图'; btn.style.cssText = 'padding:2px 8px;cursor:pointer';
        const link = document.createElement('a'); link.textContent = '新开'; link.href = src; link.target = '_blank'; link.rel = 'noreferrer noopener'; link.style.fontSize = '12px';
        btn.addEventListener('click', () => {
            img.classList.remove('sht-img-hidden');
            img.style.removeProperty('display');
            ph.remove();
            if (io) io.unobserve(img);
        });
        ph.append(btn, link);
        return ph;
    }
    function observeImg(img) {
        if (processedImg.has(img)) return;
        processedImg.add(img);

        const src = getImgSource(img);
        if (!src || shouldBypassByWhitelist(src) || isSmallOrUIImg(img)) return;

        img.classList.add('sht-img-hidden');
        img.style.setProperty('display', 'none', 'important');

        if (!io) {
            io = new IntersectionObserver(entries => {
                const vis = entries.filter(e => e.isIntersecting).map(e => e.target);
                if (!vis.length) return;
                for (let i = 0; i < vis.length; i += CFG.imageProcessBatch) {
                    const slice = vis.slice(i, i + CFG.imageProcessBatch);
                    (window.requestIdleCallback || window.setTimeout)(() => slice.forEach(buildPlaceholderAndUnobserve), 0);
                }
            }, { root: null, rootMargin: '200px 0px', threshold: 0.01 });
        }
        io.observe(img);
    }
    function buildPlaceholderAndUnobserve(img) {
        if (placeholderMade.has(img)) { if (io) io.unobserve(img); return; }
        placeholderMade.add(img);
        const src = getImgSource(img); if (!src) { if (io) io.unobserve(img); return; }
        const ph = makePlaceholder(img, src);
        img.insertAdjacentElement('beforebegin', ph);
        if (io) io.unobserve(img);
    }

    function applyImageBlocking(shouldBlock, { forceRebuild = false, candidates = null } = {}) {
        if (!shouldBlock) { resetImageState(); return; }
        if (forceRebuild) { resetImageState(); }
        const imgs = candidates && candidates.size ? Array.from(candidates) : Array.from(document.querySelectorAll('[id^="postmessage_"] img'));
        if (!imgs.length) return;
        imgs.forEach(img => pendingImgs.add(img));
        if (pendingTimer) return;
        const drainPendingImages = () => {
            pendingTimer = null;
            const limit = CFG.imageProcessBatch * 4;
            const batch = Array.from(pendingImgs).slice(0, limit);
            batch.forEach(img => pendingImgs.delete(img));
            batch.forEach(observeImg);
            if (pendingImgs.size) pendingTimer = setTimeout(drainPendingImages, 0);
        };
        pendingTimer = setTimeout(drainPendingImages, CFG.mutationDebounceMs);
    }

    /*********************** ED2K & 磁力 聚合 ***********************/
    // ED2K：文件名可含空格/中文，结尾以 /；可带 |h=...|p=...|
    const ED2K_REGEX = /ed2k:\/\/\|file\|.+?\|\d+\|[A-F0-9]{32}(?:\|[^|\r\n<>]*)*?\/(?=$|\s)/gi;
    // MAGNET：捕获直到空白/行尾/标签边界；支持任意参数
    const MAGNET_REGEX = /magnet:\?[^\s<>"']+/gi;

    // 去除链接尾部常见分隔符
    const trimTail = s => s.replace(/[，。；、\s)]+$/, '').replace(/&amp;/g, '&');

    function extractED2K(text) {
        if (!text) return [];
        const out = []; let m;
        while ((m = ED2K_REGEX.exec(text)) !== null) {
            let ed2kLink = trimTail(m[0]);

            // 应用文件名替换
            if (CFG.ed2kFileNameReplaceEnabled) {
                ed2kLink = processEd2kLink(ed2kLink);
            }

            out.push(ed2kLink);
        }
        return out;
    }
    function extractMagnet(text) {
        if (!text) return [];
        const out = []; let m;
        while ((m = MAGNET_REGEX.exec(text)) !== null) out.push(trimTail(m[0]));
        return out;
    }

    let linkScanTimer = null;
    const pendingLinkScan = { ed2k: false, magnet: false, forceEd2k: false, forceMagnet: false };
    let linkScopeCache = new WeakMap();
    let dirtyLinkScopes = new WeakSet();

    function postScopesWithin(root) {
        const scopes = new Set();
        if (root === document) {
            document.querySelectorAll('[id^="postmessage_"]').forEach(scope => scopes.add(scope));
            return scopes;
        }
        if (!(root instanceof Element)) return scopes;
        const closest = root.closest('[id^="postmessage_"]');
        if (closest) scopes.add(closest);
        if (root.matches('[id^="postmessage_"]')) scopes.add(root);
        root.querySelectorAll?.('[id^="postmessage_"]').forEach(scope => scopes.add(scope));
        return scopes;
    }

    function markDownloadLinkScopes(roots) {
        roots.forEach(root => postScopesWithin(root).forEach(scope => dirtyLinkScopes.add(scope)));
    }

    function collectLinksFromNode(node) {
        const ed2k = [], magnets = [];
        // 1) blockcode li
        node.querySelectorAll('.blockcode ol li').forEach(li => {
            const t = li.textContent || '';
            extractED2K(t).forEach(u => ed2k.push(u));
            extractMagnet(t).forEach(u => magnets.push(u));
        });
        // 2) 其他正文文本节点
        const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT, null);
        let n; while (n = walker.nextNode()) {
            const txt = n.nodeValue || '';
            if (txt.includes('ed2k://')) extractED2K(txt).forEach(u => ed2k.push(u));
            if (txt.includes('magnet:?')) extractMagnet(txt).forEach(u => magnets.push(u));
        }
        node.querySelectorAll('a[href*="forum.php?mod=attachment"][href*=".torrent"]').forEach(link => {
            if ((link.textContent || '').trim()) magnets.push(link.href);
        });
        return { ed2k: Array.from(new Set(ed2k)), magnets: Array.from(new Set(magnets)) };
    }

    function collectAllDownloadLinks() {
        const ed2kSet = new Set();
        const magnetSet = new Set();
        const scopes = [...document.querySelectorAll('[id^="postmessage_"]')];
        scopes.forEach(scope => {
            let links = linkScopeCache.get(scope);
            if (!links || dirtyLinkScopes.has(scope)) {
                links = collectLinksFromNode(scope);
                linkScopeCache.set(scope, links);
                dirtyLinkScopes.delete(scope);
                diagnosticLog('debug', 'link-index', '已更新楼层链接索引', {
                    scope: scope.id || '(anonymous)', ed2k: links.ed2k.length, magnets: links.magnets.length
                });
            }
            links.ed2k.forEach(url => ed2kSet.add(url));
            links.magnets.forEach(url => magnetSet.add(url));
        });

        document.querySelectorAll('.sht-agg-item textarea').forEach(ta => {
            extractED2K(ta.value).forEach(url => ed2kSet.add(url));
            extractMagnet(ta.value).forEach(url => magnetSet.add(url));
        });

        return { ed2k: Array.from(ed2kSet), magnets: Array.from(magnetSet) };
    }

    const collectAllED2K = () => collectAllDownloadLinks().ed2k;
    const collectAllMagnets = () => collectAllDownloadLinks().magnets;

    function formatPan115ResultItems(details, originalUrls) {
        const out = [];
        const list = Array.from(originalUrls || []);
        const arr = Array.from(details || []);
        const max = Math.max(arr.length, list.length);
        for (let i = 0; i < max; i++) {
            const entry = arr[i] || {};
            let display = entry.response?.name || entry.name || entry.title || entry.url || list[i] || `任务${i + 1}`;
            const rawUrl = entry.url || list[i] || '';
            try {
                if (display.startsWith('magnet:') || (rawUrl && rawUrl.startsWith('magnet:'))) {
                    const magnet = display.startsWith('magnet:') ? display : rawUrl;
                    const match = magnet.match(/dn=([^&]+)/i);
                    if (match) display = decodeURIComponent(match[1]);
                } else if (display.startsWith('ed2k://') || (rawUrl && rawUrl.startsWith('ed2k://'))) {
                    const ed2k = display.startsWith('ed2k://') ? display : rawUrl;
                    const parts = ed2k.split('|');
                    if (parts.length > 2) display = decodeURIComponent(parts[2]);
                }
            } catch { }
            if (display.length > 80) display = display.slice(0, 80) + '...';
            out.push({
                title: display,
                success: entry.success === undefined ? true : !!entry.success,
                error: entry.error || entry.message || ''
            });
        }
        return out;
    }

    function renderBox(container, titleText, links) {
        container.innerHTML = '';
        const card = document.createElement('div'); card.style.cssText = 'border:1px solid #e6e6e6;border-radius:6px;padding:6px;background:#fff';
        const head = document.createElement('div'); head.style.cssText = 'display:flex;align-items:center;justify-content:space-between';
        const title = document.createElement('span'); title.style.fontWeight = '600'; title.textContent = `${titleText}（${links.length}）`;
        const act = document.createElement('div'); act.style.cssText = 'display:inline-flex;gap:6px';
        const b = document.createElement('button'); b.textContent = '复制全部'; b.style.cssText = 'padding:2px 8px;cursor:pointer';
        const body = document.createElement('div');

        const ta = document.createElement('textarea'); ta.rows = Math.min(12, Math.max(4, links.length)); ta.style.cssText = 'width:100%;box-sizing:border-box;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px'; ta.value = links.join('\n'); ta.dataset.count = String(links.length);
        b.addEventListener('click', () => { GM_setClipboard(ta.value); b.textContent = '已复制'; setTimeout(() => b.textContent = '复制全部', 1200); });
        body.appendChild(ta);

        const pan115Available = CFG.pan115Enabled && CFG.pan115Cookie && CFG.pan115Cookie.trim();
        const createPan115Button = (label, targetUrls) => {
            const btn115 = document.createElement('button');
            btn115.textContent = label;
            btn115.style.cssText = [
                'padding:4px 10px',
                'cursor:pointer',
                'background:linear-gradient(135deg,#f6c343 0%,#f49f0a 100%)',
                'color:#3b2f09',
                'border:1px solid #d48806',
                'border-radius:4px',
                'font-weight:600',
                'box-shadow:0 1px 3px rgba(0,0,0,0.15)',
                'transition:all 0.2s ease'
            ].join(';');
            btn115.addEventListener('mouseenter', () => {
                btn115.style.boxShadow = '0 2px 6px rgba(0,0,0,0.25)';
                btn115.style.transform = 'translateY(-1px)';
            });
            btn115.addEventListener('mouseleave', () => {
                btn115.style.boxShadow = '0 1px 3px rgba(0,0,0,0.15)';
                btn115.style.transform = 'translateY(0)';
            });
            btn115.addEventListener('click', async () => {
                if (!pan115Available) {
                    showWarningModal('请先在设置中启用 115 离线功能并填写 Cookie');
                    return;
                }

                if (!Array.isArray(targetUrls) || targetUrls.length === 0) {
                    showWarningModal('没有可发送的链接');
                    return;
                }

                const originalText = btn115.textContent;
                btn115.disabled = true;
                btn115.textContent = '115 离线发送中...';

                try {
                    const summary = await queueCloudProviderTask('pan115',
                        ({ signal }) => pan115AddTasks(targetUrls, { signal }),
                        { label: `115 批量任务（${targetUrls.length}）`, retries: 0 }
                    );
                    const { successCount, failCount, details } = summary;
                    const total = summary.total || targetUrls.length;
                    const modalResults = formatPan115ResultItems(details, targetUrls);
                    showBatchResultModal(modalResults, successCount, failCount, total);
                } catch (error) {
                    console.error('发送到115失败:', error);
                    showErrorModal(`发送到115失败: ${error.message}`);
                } finally {
                    btn115.disabled = false;
                    btn115.textContent = originalText;
                }
            });
            return btn115;
        };

        // 为磁力链接添加123Pan离线下载按钮
        if (titleText === '磁力链接' && CFG.pan123Enabled && links.length > 0) {
            const magnetUrls = ta.value.split('\n').filter(line => line.trim() && line.startsWith('magnet:'));

            if (magnetUrls.length === 1) {
                // 单个磁力链接：显示"发送到123Pan"
                const singleBtn = document.createElement('button');
                singleBtn.textContent = '发送到123Pan';
                singleBtn.style.cssText = 'padding:2px 8px;cursor:pointer;background:#007cba;color:white;border:none;border-radius:3px';
                singleBtn.addEventListener('click', async () => {
                    if (!CFG.pan123Token || !CFG.pan123LoginUuid || !CFG.pan123Cookie) {
                        showWarningModal('请先在设置中配置 123Pan 认证信息');
                        return;
                    }

                    singleBtn.textContent = '发送中...';
                    singleBtn.disabled = true;

                    try {
                        const magnetLink = magnetUrls[0];
                        await processMagnetOffline(magnetLink, magnetLink);
                    } catch (error) {
                        console.error('发送到123Pan失败:', error);
                        showErrorModal(`发送失败: ${error.message}`);
                    } finally {
                        singleBtn.textContent = '发送到123Pan';
                        singleBtn.disabled = false;
                    }
                });
                act.append(singleBtn);
            } else if (magnetUrls.length > 1) {
                // 多个磁力链接：显示"批量发送到123Pan"和"123Pan部分发送"
                const batchBtn = document.createElement('button');
                batchBtn.textContent = '批量发送到123Pan';
                batchBtn.style.cssText = 'padding:2px 8px;cursor:pointer;background:#007cba;color:white;border:none;border-radius:3px';
                batchBtn.addEventListener('click', async () => {
                    if (!CFG.pan123Token || !CFG.pan123LoginUuid || !CFG.pan123Cookie) {
                        showWarningModal('请先在设置中配置 123Pan 认证信息');
                        return;
                    }

                    batchBtn.textContent = '批量发送中...';
                    batchBtn.disabled = true;

                    try {
                        await processBatchMagnetOffline(magnetUrls);
                    } catch (error) {
                        console.error('批量发送失败:', error);
                        showErrorModal(`批量发送失败: ${error.message}`);
                    } finally {
                        batchBtn.textContent = '批量发送到123Pan';
                        batchBtn.disabled = false;
                    }
                });

                const partialBtn = document.createElement('button');
                partialBtn.textContent = '123Pan部分发送';
                partialBtn.style.cssText = 'padding:2px 8px;cursor:pointer;background:#28a745;color:white;border:none;border-radius:3px;margin-left:4px';
                partialBtn.addEventListener('click', () => {
                    showMagnetSelectionDialog(magnetUrls);
                });

                act.append(batchBtn);
                act.append(partialBtn);
            }
        }

        // 为磁力链接添加 115 离线下载按钮
        if (titleText === '磁力链接' && pan115Available && links.length > 0) {
            const magnetUrls = ta.value.split('\n').filter(line => line.trim() && line.startsWith('magnet:'));
            if (magnetUrls.length > 0) {
                act.append(createPan115Button(`115离线(${magnetUrls.length})`, magnetUrls));
            }
        }

        // 为 ED2K 链接添加 115 离线下载按钮
        if (titleText === 'ED2K 链接' && pan115Available && links.length > 0) {
            const ed2kUrls = ta.value.split('\n').filter(line => line.trim() && line.startsWith('ed2k://'));
            if (ed2kUrls.length > 0) {
                act.append(createPan115Button(`115离线(${ed2kUrls.length})`, ed2kUrls));
            }
        }

        act.append(b); head.append(title, act); card.append(head, body); container.append(card); agg?.updateWrapMode();
        agg?.updateToolbarCounts?.({
            ed2k: titleText === 'ED2K 链接' ? links.length : undefined,
            magnets: titleText === '磁力链接' ? links.length : undefined
        });
    }

    function queueED2KScan(force = false) {
        if (!agg) return;
        if (!CFG.autoCollectED2K && !force) return;
        pendingLinkScan.ed2k = true;
        pendingLinkScan.forceEd2k ||= force;
        scheduleCombinedLinkScan();
    }
    function queueMagnetScan(force = false) {
        if (!agg) return;
        if (!CFG.autoCollectMagnet && !force) return;
        pendingLinkScan.magnet = true;
        pendingLinkScan.forceMagnet ||= force;
        scheduleCombinedLinkScan();
    }
    function scheduleCombinedLinkScan() {
        if (linkScanTimer) clearTimeout(linkScanTimer);
        const delay = Math.min(CFG.ed2kDebounceMs, CFG.magnetDebounceMs);
        linkScanTimer = setTimeout(() => {
            linkScanTimer = null;
            const requested = { ...pendingLinkScan };
            pendingLinkScan.ed2k = false;
            pendingLinkScan.magnet = false;
            pendingLinkScan.forceEd2k = false;
            pendingLinkScan.forceMagnet = false;
            const links = collectAllDownloadLinks();
            if (requested.ed2k && (CFG.autoCollectED2K || requested.forceEd2k)) {
                renderBox(agg.ed2kBox, 'ED2K 链接', links.ed2k);
            }
            if (requested.magnet && (CFG.autoCollectMagnet || requested.forceMagnet)) {
                renderBox(agg.magnetBox, '磁力链接', links.magnets);
            }
        }, delay);
    }

    /*********************** 网络与解压（同前） ***********************/
    async function httpGetArrayBuffer(url, options = {}) {
        const response = await shtRequest({
            method: 'GET', url, responseType: 'arraybuffer', timeout: 30_000,
            signal: options.signal, onProgress: options.onProgress, retries: 1,
            scope: 'attachment',
            headers: {
                'Referer': location.href,
                'Accept': 'text/plain, text/html, application/octet-stream, */*',
                'Accept-Charset': 'utf-8, gbk, gb2312, shift_jis, euc-jp, big5, iso-8859-1',
                'Accept-Encoding': 'identity'
            }
        });
        return response.response;
    }
    async function tryExtractZipTexts(buf, pwds, maxEntryBytes) {
        await loadOptionalLibrary('zip');
        const blob = new Blob([buf]); const results = []; const tries = ['', ...pwds.filter(p => p && p.trim() !== '')];
        for (const pwd of tries) {
            try {
                const zr = new zip.ZipReader(new zip.BlobReader(blob), { password: pwd || undefined }); const entries = await zr.getEntries();
                for (const e of entries) {
                    if (e.directory) continue; if (!isTextLike(e.filename)) continue;
                    // 额外检查是否为图片文件或种子文件，避免处理压缩包中的图片和种子
                    const isImageFile = /\.(jpg|jpeg|png|gif|webp|bmp|svg|ico)$/i.test(e.filename);
                    const isTorrentFile = /\.torrent$/i.test(e.filename);
                    if (isImageFile || isTorrentFile) continue;
                    if (typeof e.uncompressedSize === 'number' && e.uncompressedSize > maxEntryBytes) continue;
                    const u8 = await e.getData(new zip.Uint8ArrayWriter()); const text = decodeBest(u8);
                    if (text) results.push({ name: e.filename, text: text.replace(/\uFFFD/g, ''), size: u8.byteLength, pwd });
                } await zr.close(); if (results.length) break;
            } catch { }
        }
        return dedupeByName(results);
    }
    // RAR 文件检测函数
    function isRarFile(array_buffer) {
        if (array_buffer.byteLength < 8) {
            return false;
        }

        const header1 = Array.from(new Uint8Array(array_buffer).slice(0, 4)).join(', ');
        const header2 = Array.from(new Uint8Array(array_buffer).slice(0, 7)).join(', ');
        const header3 = Array.from(new Uint8Array(array_buffer).slice(0, 8)).join(', ');

        const rar_header1 = '82, 69, 126, 94'; // old
        const rar_header2 = '82, 97, 114, 33, 26, 7, 0'; // 1.5 to 4.0
        const rar_header3 = '82, 97, 114, 33, 26, 7, 1, 0'; // 5.0

        return (header1 === rar_header1 || header2 === rar_header2 || header3 === rar_header3);
    }

    async function tryExtractRarTexts(buf, pwds, maxEntryBytes) {
        const results = [];
        const tries = ['', ...pwds.filter(p => p && p.trim() !== '')];

        for (const pwd of tries) {
            try {
                const result = await tryExtractWithPassword(buf, pwd);

                if (result.ok && result.entries) {
                    for (const entry of result.entries) {
                        const name = entry.name;

                        if (!isTextLike(name)) continue;

                        // 额外检查是否为图片文件或种子文件，避免处理压缩包中的图片和种子
                        const isImageFile = /\.(jpg|jpeg|png|gif|webp|bmp|svg|ico)$/i.test(name);
                        const isTorrentFile = /\.torrent$/i.test(name);
                        if (isImageFile || isTorrentFile) continue;

                        const size = entry.size || 0;
                        if (size && size > maxEntryBytes) continue;

                        // 解码文本内容 - 改进编码检测
                        let text = null;
                        try {
                            // 调试数据格式
                            console.log('[RAR] 处理文件:', name, '原始数据类型:', typeof entry.data, 'isArray:', Array.isArray(entry.data), 'length:', entry.data?.length);

                            // 确保数据是 Uint8Array 格式
                            const data = toU8(entry.data);
                            if (!data) {
                                console.log('[RAR] 无法转换文件数据:', name, '原始数据:', entry.data);
                                continue;
                            }

                            console.log('[RAR] 数据转换成功:', name, '转换后类型:', data.constructor.name, '长度:', data.length, '前10字节:', Array.from(data.slice(0, 10)));

                            // 使用改进的编码检测
                            text = decodeBest(data, name);

                            // 如果解码结果包含大量乱码字符，尝试其他编码
                            if (text && /[\uFFFD\uFFFE\uFFFF]/.test(text) && text.length > 10) {
                                console.log('[RAR] 检测到乱码，尝试其他编码:', name);

                                // 尝试常见的中文编码
                                const chineseEncodings = ['gbk', 'gb18030', 'big5', 'utf-8'];
                                for (const encoding of chineseEncodings) {
                                    try {
                                        const testText = new TextDecoder(encoding).decode(data);
                                        if (!/[\uFFFD\uFFFE\uFFFF]/.test(testText) || testText.length > text.length) {
                                            text = testText;
                                            console.log('[RAR] 使用编码', encoding, '成功:', name);
                                            break;
                                        }
                                    } catch (e) {
                                        // 忽略编码错误
                                    }
                                }
                            }

                            if (text) {
                                results.push({
                                    name,
                                    text: text.replace(/\uFFFD/g, ''),
                                    size: size,
                                    pwd
                                });
                            }
                        } catch (error) {
                            console.log('[RAR] 文本解码失败:', name, error);
                        }
                    }
                }

                if (results.length) break;
            } catch (error) {
                console.log('RAR 解压失败:', error);
            }
        }

        return dedupeByName(results);
    }
    function dedupeByName(arr) { const map = new Map(); for (const x of arr) if (!map.has(x.name)) map.set(x.name, x); return Array.from(map.values()); }

    // 一键评分功能
    async function quickRate(originalRateBtn) {
        try {
            console.log('原始评分按钮:', originalRateBtn);
            console.log('按钮href:', originalRateBtn.href);
            console.log('按钮onclick:', originalRateBtn.onclick);

            // 尝试从href或onclick中提取评分URL
            let rateUrl = originalRateBtn.href;

            // 如果没有href，尝试从onclick中提取
            if (!rateUrl && originalRateBtn.onclick) {
                const onclickStr = originalRateBtn.onclick.toString();
                console.log('onclick字符串:', onclickStr);

                // 查找showWindow调用中的URL
                const showWindowMatch = onclickStr.match(/showWindow\([^,]+,\s*['"]([^'"]+)['"]/);
                if (showWindowMatch) {
                    rateUrl = showWindowMatch[1];
                    console.log('从onclick提取的URL:', rateUrl);
                }
            }

            if (!rateUrl || !rateUrl.includes('rate')) {
                console.log('无法获取评分URL，尝试从页面URL提取参数');

                // 从当前页面URL中提取tid
                const currentUrl = new URL(location.href);
                const tid = currentUrl.searchParams.get('tid');

                if (!tid) {
                    console.log('无法从页面URL获取tid');
                    return;
                }

                // 尝试从页面中查找pid
                const pidMatch = document.querySelector('input[name="pid"]') ||
                    document.querySelector('[name="pid"]') ||
                    document.querySelector('#pid') ||
                    document.querySelector('[id*="pid"]');

                let pid = null;
                if (pidMatch) {
                    pid = pidMatch.value || pidMatch.id?.replace(/[^\d]/g, '');
                }

                if (!pid) {
                    // 尝试从页面内容中查找pid
                    const pidRegex = /pid(\d+)/;
                    const pageContent = document.documentElement.innerHTML;
                    const pidMatch2 = pageContent.match(pidRegex);
                    if (pidMatch2) {
                        pid = pidMatch2[1];
                    }
                }

                if (!pid) {
                    console.log('无法获取pid');
                    return;
                }

                console.log('使用页面参数 - tid:', tid, 'pid:', pid);

                // 直接使用提取的参数
                await submitRating(tid, pid);
                return;
            }

            // 从URL中提取tid和pid
            const urlParams = new URLSearchParams(rateUrl.split('?')[1]);
            const tid = urlParams.get('tid');
            const pid = urlParams.get('pid');

            if (!tid || !pid) {
                console.log('无法获取tid或pid');
                return;
            }

            await submitRating(tid, pid);
        } catch (error) {
            console.error('评分过程中出错:', error);
            showToast('评分过程中出错: ' + describeRequestError(error), 'error', 5000);
        }
    }

    // 提交评分的独立函数
    async function submitRating(tid, pid) {
        try {
            console.log('开始提交评分 - tid:', tid, 'pid:', pid);

            // 获取formhash
            const formhashInput = document.querySelector('input[name="formhash"]');
            const formhash = formhashInput ? formhashInput.value : '';

            if (!formhash) {
                console.log('无法获取formhash');
                showToast('无法获取安全令牌，请刷新页面后重试', 'warning', 5000);
                return;
            }

            // 构建评分请求数据 - 根据实际 curl 请求格式
            const rateData = new URLSearchParams();
            rateData.append('formhash', formhash);
            rateData.append('tid', tid);
            rateData.append('pid', pid);
            rateData.append('referer', location.href);
            rateData.append('handlekey', 'rate');
            rateData.append('score8', CFG.defaultRateScore.toString());
            rateData.append('reason', CFG.defaultRateReason); // 添加评分理由

            // 始终向当前论坛来源发送评分，兼容官方子域名与同源镜像。
            const rateEndpoint = new URL('/forum.php?mod=misc&action=rate&ratesubmit=yes&infloat=yes&inajax=1', location.origin);
            const response = await shtRequest({
                method: 'POST',
                url: rateEndpoint.toString(),
                responseType: 'text',
                timeout: 20_000,
                retries: 0,
                scope: 'rating',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'X-Requested-With': 'XMLHttpRequest',
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
                    'Accept-Language': 'en-GB,en-US;q=0.9,en;q=0.8,zh-CN;q=0.7,zh;q=0.6',
                    'Cache-Control': 'max-age=0',
                    'Sec-Fetch-Dest': 'iframe',
                    'Sec-Fetch-Mode': 'navigate',
                    'Sec-Fetch-Site': 'same-origin',
                    'Sec-Fetch-User': '?1',
                    'Upgrade-Insecure-Requests': '1'
                },
                data: rateData.toString()
            });

            console.log('评分响应状态:', response.status);

            if (response.status >= 200 && response.status < 300) {
                const result = response.responseText || response.response || '';
                console.log('评分响应内容:', result);

                // 检查是否包含成功标识
                const isSuccess = result.includes('succeedhandle_rate') ||
                    result.includes('成功') ||
                    result.includes('success') ||
                    result.includes('评分成功') ||
                    result.includes('评分完成') ||
                    result.includes('操作成功');

                if (isSuccess) {
                    // 尝试提取成功消息
                    let successMessage = `评分成功！已给出${CFG.defaultRateScore}分`;
                    const successMatch = result.match(/succeedhandle_rate\([^,]+,\s*['"]([^'"]+)['"]/);
                    if (successMatch) {
                        successMessage = successMatch[1]; // 使用服务器返回的消息
                    }

                    // 评分成功，更新按钮状态
                    const rateClone = document.querySelector('#ak_rate');
                    if (rateClone) {
                        rateClone.style.background = '#4CAF50';
                        rateClone.style.color = 'white';
                        rateClone.textContent = `已评分(${CFG.defaultRateScore}分)`;
                        rateClone.onclick = null; // 禁用再次点击
                    }
                    console.log(`评分成功: ${CFG.defaultRateScore}分 - ${successMessage}`);
                    showToast(successMessage, 'success');
                } else {
                    console.log('评分失败:', result);
                    showToast('评分失败，请检查登录状态或权限', 'error', 5000);
                }
            } else {
                console.log('评分请求失败:', response.status);
                showToast('评分请求失败，状态码: ' + response.status, 'error', 5000);
            }
        } catch (error) {
            console.error('评分过程中出错:', error);
            showToast('评分过程中出错: ' + describeRequestError(error), 'error', 5000);
        }
    }

    /*********************** 帖子列表页面功能 ***********************/
    function addAuthorOnlyToForumList() {
        // 检查当前是否在只看楼主模式
        const isInAuthorOnlyMode = location.href.includes('authorid=');

        if (isInAuthorOnlyMode) {
            // 如果已经在只看楼主模式，显示"显示全部"按钮
            addShowAllButton();
        } else {
            // 如果不在只看楼主模式，修改所有帖子链接为只看该作者模式
            modifyThreadLinksToAuthorOnly();
            addAuthorOnlyToggle();
        }

        // 自动应用已保存的排版设置
        applyLayoutSettings();
    }


    function applyLayoutSettings() {
        // 重新加载配置以确保使用最新值
        const currentCFG = loadConfig();
        // console.log('应用排版设置:', currentCFG);

        // 直接修改表格的 table-layout 属性
        const table = document.querySelector('table#threadlisttableid');
        if (table) {
            table.style.tableLayout = 'auto';
            // console.log('已设置表格 table-layout 为 auto');
        }

        // 隐藏回复/查看列
        if (currentCFG.hideReplyColumn) {
            const replyCells = document.querySelectorAll('td.num');
            // console.log('找到回复/查看列:', replyCells.length);
            replyCells.forEach(cell => {
                cell.style.display = 'none';
            });
        }

        // 隐藏最后回复列 - 修正选择器
        if (currentCFG.hideLastReplyColumn) {
            // 更精确的选择器：选择包含最后回复信息的td.by列
            const lastReplyCells = document.querySelectorAll('tbody tr td.by cite a[href*="username="]');
            // console.log('找到最后回复列:', lastReplyCells.length);
            lastReplyCells.forEach(link => {
                // 隐藏包含最后回复链接的td元素
                const td = link.closest('td.by');
                if (td) {
                    td.style.display = 'none';
                }
            });
        }

        // 隐藏作者列 - 修正选择器
        if (currentCFG.hideAuthorColumn) {
            // 更精确的选择器：选择包含作者链接的td.by列
            const authorCells = document.querySelectorAll('tbody tr td.by cite a[href*="uid="]');
            // console.log('找到作者列:', authorCells.length);
            authorCells.forEach(link => {
                // 隐藏包含作者链接的td元素
                const td = link.closest('td.by');
                if (td) {
                    td.style.display = 'none';
                }
            });
        }

        // 隐藏置顶帖
        if (currentCFG.hideStickyThreads) {
            const stickyThreads = document.querySelectorAll('tbody[id^="stickthread_"]');
            // console.log('找到置顶帖:', stickyThreads.length);
            stickyThreads.forEach(thread => {
                thread.style.display = 'none';
            });
        }

        // 隐藏分页
        if (currentCFG.hidePagination) {
            const pagination = document.querySelectorAll('span.tps');
            // console.log('找到分页:', pagination.length);
            pagination.forEach(pagination => {
                pagination.style.display = 'none';
            });
        }

        // 关键词过滤
        if (currentCFG.enableKeywordFilter && currentCFG.keywordFilters.length > 0) {
            const threadRows = document.querySelectorAll('tbody[id^="normalthread_"], tbody[id^="stickthread_"]');
            // console.log('开始关键词过滤，检查帖子数:', threadRows.length);

            threadRows.forEach(row => {
                const titleLink = row.querySelector('th a.s.xst');
                const typeLink = row.querySelector('th em a');
                let shouldHide = false;

                // 获取标题文本
                const title = titleLink ? (titleLink.textContent || titleLink.innerText) : '';

                // 获取类型文本
                const type = typeLink ? (typeLink.textContent || typeLink.innerText) : '';

                // 合并标题和类型进行匹配
                const fullText = `${title} ${type}`.trim();

                // console.log('检查帖子:', { title, type, fullText });

                for (const filter of currentCFG.keywordFilters) {
                    try {
                        const regex = new RegExp(filter, 'i');
                        if (regex.test(fullText)) {
                            // console.log('匹配到关键词:', filter, '内容:', fullText);
                            shouldHide = true;
                            break;
                        }
                    } catch (e) {
                        // 如果正则表达式无效，则使用普通字符串匹配
                        if (fullText.toLowerCase().includes(filter.toLowerCase())) {
                            // console.log('匹配到关键词:', filter, '内容:', fullText);
                            shouldHide = true;
                            break;
                        }
                    }
                }

                if (shouldHide) {
                    row.style.display = 'none';
                    // console.log('隐藏帖子:', fullText);
                }
            });
        }

        // 标题增强 - 替换中文【】为[] 和 应用列表页专用替换规则
        if (currentCFG.enhanceTitles || currentCFG.enableListTitleEnhance) {
            const titleLinks = document.querySelectorAll('th a.s.xst');
            // console.log('开始标题增强，处理标题数:', titleLinks.length);
            // console.log('当前配置 - enhanceTitles:', currentCFG.enhanceTitles, 'enableListTitleEnhance:', currentCFG.enableListTitleEnhance);

            titleLinks.forEach(link => {
                let title = link.textContent || link.innerText;
                if (title) {
                    const originalTitle = title;

                    // 应用列表页专用替换规则
                    if (currentCFG.enableListTitleEnhance && currentCFG.listTitleReplaceRules && currentCFG.listTitleReplaceRules.length > 0) {
                        for (const rule of currentCFG.listTitleReplaceRules) {
                            try {
                                const regex = new RegExp(rule.pattern, 'g');
                                title = title.replace(regex, rule.replacement);
                            } catch (e) {
                                // 如果正则表达式无效，则使用普通字符串替换
                                const escapedPattern = rule.pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                                const regex = new RegExp(escapedPattern, 'g');
                                title = title.replace(regex, rule.replacement);
                            }
                        }
                    }

                    // 替换中文【】为[]
                    if (currentCFG.enhanceTitles) {
                        title = title.replace(/【/g, '[').replace(/】/g, ']');
                    }

                    // 清理多余空格
                    title = title.replace(/\s+/g, ' ').trim();

                    if (originalTitle !== title) {
                        link.textContent = title;
                        // console.log('标题增强:', originalTitle, '->', title);
                    }
                }
            });
        }

        // 历史访问帖子处理
        if (currentCFG.historyPostAction !== 'none' && currentCFG.enableHistory) {
            const historyTids = currentCFG.historyItems.map(item => item.tid);
            // console.log('历史访问的帖子TID:', historyTids);

            const threadRows = document.querySelectorAll('tbody[id^="normalthread_"], tbody[id^="stickthread_"]');
            // console.log('开始处理历史访问帖子，检查帖子数:', threadRows.length);

            threadRows.forEach(row => {
                const titleLink = row.querySelector('th a.s.xst');
                if (titleLink) {
                    // 从链接中提取TID
                    const href = titleLink.getAttribute('href') || titleLink.getAttribute('data-original-href') || '';
                    const tidMatch = href.match(/[?&]tid=(\d+)/);

                    if (tidMatch) {
                        const tid = tidMatch[1];
                        const isVisited = historyTids.includes(tid);

                        if (isVisited) {
                            // console.log('发现已访问帖子，TID:', tid, '动作:', currentCFG.historyPostAction);

                            switch (currentCFG.historyPostAction) {
                                case 'hide':
                                    row.style.display = 'none';
                                    // console.log('隐藏已访问帖子:', tid);
                                    break;

                                case 'blue':
                                    titleLink.style.color = currentCFG.historyPostColor;
                                    titleLink.style.fontWeight = 'bold';
                                    // console.log('标记已访问帖子为蓝色:', tid);
                                    break;

                                case 'strikethrough':
                                    titleLink.style.textDecoration = 'line-through';
                                    titleLink.style.opacity = '0.6';
                                    // console.log('标记已访问帖子为删除线:', tid);
                                    break;
                            }
                        }
                    }
                }
            });
        }

        // 调整标题列宽度 - 让标题占据更多空间
        if (currentCFG.hideReplyColumn || currentCFG.hideLastReplyColumn || currentCFG.hideAuthorColumn) {
            // 移除之前的样式
            const existingStyle = document.querySelector('#sht-layout-style');
            if (existingStyle) {
                existingStyle.remove();
            }

            // 计算隐藏的列数
            let hiddenColumns = 0;
            if (currentCFG.hideAuthorColumn) hiddenColumns++;
            if (currentCFG.hideReplyColumn) hiddenColumns++;
            if (currentCFG.hideLastReplyColumn) hiddenColumns++;

            // console.log('隐藏的列数:', hiddenColumns);

            // 创建新的样式
            const style = document.createElement('style');
            style.id = 'sht-layout-style';

            if (hiddenColumns > 0) {
                // 根据隐藏的列数动态调整列宽
                const iconWidth = '40px';
                const otherColumnsWidth = hiddenColumns > 0 ? `${hiddenColumns * 80}px` : '0px';
                const titleWidth = `calc(100% - ${iconWidth} - ${otherColumnsWidth})`;

                style.textContent = `
        /* 强制覆盖表格布局 - 直接覆盖 .tl table 样式 */
        .tl table {
          table-layout: auto !important;
          width: 100% !important;
        }

        /* 更具体的选择器确保覆盖 */
        .bm .tl table#threadlisttableid {
          table-layout: auto !important;
          width: 100% !important;
        }

        /* 图标列固定宽度 */
        .bm .tl table#threadlisttableid tbody tr td.icn {
          width: ${iconWidth} !important;
          min-width: ${iconWidth} !important;
          max-width: ${iconWidth} !important;
          padding: 5px 0 !important;
        }

        /* 标题列占据剩余空间 - 让浏览器自动计算宽度 */
        .bm .tl table#threadlisttableid tbody tr th,
        .bm .tl table#threadlisttableid tbody tr th.fn {
          width: auto !important;
          min-width: 200px !important;
          max-width: none !important;
          word-wrap: break-word !important;
          word-break: break-word !important;
          padding: 5px 0 !important;
          padding-right: 1.5em !important;
        }

        /* 隐藏的列完全不显示 - 使用更具体的选择器 */
        .bm .tl table#threadlisttableid tbody tr td.by[style*="display: none"],
        .bm .tl table#threadlisttableid tbody tr td.by[style*="display: none"] cite,
        .bm .tl table#threadlisttableid tbody tr td.by[style*="display: none"] em {
          display: none !important;
          width: 0 !important;
          min-width: 0 !important;
          max-width: 0 !important;
          padding: 0 !important;
          margin: 0 !important;
          border: none !important;
          font-size: 0 !important;
          line-height: 0 !important;
        }

        .bm .tl table#threadlisttableid tbody tr td.num[style*="display: none"],
        .bm .tl table#threadlisttableid tbody tr td.num[style*="display: none"] a,
        .bm .tl table#threadlisttableid tbody tr td.num[style*="display: none"] em {
          display: none !important;
          width: 0 !important;
          min-width: 0 !important;
          max-width: 0 !important;
          padding: 0 !important;
          margin: 0 !important;
          border: none !important;
          font-size: 0 !important;
          line-height: 0 !important;
        }

        /* 确保表格行不会因为隐藏列而变形 */
        .bm .tl table#threadlisttableid tbody tr {
          display: table-row !important;
        }

        /* 强制表格单元格布局 */
        .bm .tl table#threadlisttableid tbody tr td,
        .bm .tl table#threadlisttableid tbody tr th {
          display: table-cell !important;
          vertical-align: top !important;
        }
      `;
            }

            document.head.appendChild(style);
            // console.log('布局样式已应用');
        }
    }

    function modifyThreadLinksToAuthorOnly() {
        const threadRows = document.querySelectorAll('tbody[id^="normalthread_"], tbody[id^="stickthread_"]');

        threadRows.forEach(row => {
            const tid = row.id.replace(/^(normal|stick)thread_/, '');
            const authorLink = row.querySelector('td.by cite a[href*="uid="]');
            const threadTitleLink = row.querySelector('th a.s.xst');

            if (authorLink && threadTitleLink) {
                const uidMatch = authorLink.href.match(/uid=(\d+)/);
                if (uidMatch) {
                    const uid = uidMatch[1];

                    // 修改帖子标题链接为只看该作者模式
                    const originalHref = threadTitleLink.href;
                    const authorOnlyHref = `forum.php?mod=viewthread&tid=${tid}&page=1&authorid=${uid}`;

                    // 保存原始链接
                    threadTitleLink.dataset.originalHref = originalHref;
                    threadTitleLink.href = authorOnlyHref;

                    // 添加视觉提示
                    threadTitleLink.style.color = '#ff6b6b';
                    threadTitleLink.title = '点击进入只看该作者模式';
                }
            }
        });
    }

    function addShowAllButton() {
        // 检查是否已经存在按钮
        if (document.querySelector('#sht-show-all-btn')) return;

        const showAllBtn = document.createElement('button');
        showAllBtn.id = 'sht-show-all-btn';
        showAllBtn.textContent = '显示全部';
        showAllBtn.style.cssText = `
    position: fixed;
    top: 20px;
    right: 20px;
    z-index: 10000;
    padding: 8px 16px;
    background: #28a745;
    color: white;
    border: none;
    border-radius: 4px;
    cursor: pointer;
    font-size: 14px;
    box-shadow: 0 2px 8px rgba(0,0,0,0.2);
  `;

        showAllBtn.addEventListener('click', () => {
            // 跳转到正常模式（去掉authorid参数）
            const currentUrl = new URL(location.href);
            currentUrl.searchParams.delete('authorid');
            window.location.href = currentUrl.toString();
        });

        document.body.appendChild(showAllBtn);
    }

    function addAuthorOnlyToggle() {
        // 检查是否已经存在按钮
        if (document.querySelector('#sht-author-only-toggle')) return;

        const toggleBtn = document.createElement('button');
        toggleBtn.id = 'sht-author-only-toggle';
        toggleBtn.textContent = '只看楼主模式';
        toggleBtn.style.cssText = `
    position: fixed;
    top: 20px;
    right: 20px;
    z-index: 10000;
    padding: 8px 16px;
    background: #007cba;
    color: white;
    border: none;
    border-radius: 4px;
    cursor: pointer;
    font-size: 14px;
    box-shadow: 0 2px 8px rgba(0,0,0,0.2);
  `;

        toggleBtn.addEventListener('click', () => {
            // 跳转到当前页面的只看该作者模式（使用第一个帖子的作者UID）
            const firstAuthorLink = document.querySelector('td.by cite a[href*="uid="]');
            if (firstAuthorLink) {
                const uidMatch = firstAuthorLink.href.match(/uid=(\d+)/);
                if (uidMatch) {
                    const currentUrl = new URL(location.href);
                    currentUrl.searchParams.set('authorid', uidMatch[1]);
                    window.location.href = currentUrl.toString();
                }
            }
        });

        document.body.appendChild(toggleBtn);
    }


    /*********************** 启动与监听 ***********************/

    // 确保配置加载完成后再执行功能
    // console.log('当前配置:', CFG);

    if (isForumListPage) {
        // 在帖子列表页面添加"只看楼主"功能
        addAuthorOnlyToForumList();
        // 应用论坛模块屏蔽
        applyModuleFilter();
        // 应用布局设置（包括标题增强）
        applyLayoutSettings();
    } else if (isForumHomePage) {
        // 在论坛首页应用论坛模块屏蔽
        applyModuleFilter();
    } else if (isThreadPage) {
        // 附件、图片和下载链接在同一次初始扫描中收集。
        scanThreadContent([document], { forceImages: CFG.blockImages, forceLinks: true });

        // 处理帖子详情标题
        enhanceThreadTitle();

        // 延迟再次处理，确保页面完全加载
        setTimeout(() => {
            enhanceThreadTitle();
        }, 1000);
    }

    // 论坛模块屏蔽功能
    function applyModuleFilter() {
        if (!CFG.enableModuleFilter || !CFG.hiddenModules.length) return;

        // console.log('应用论坛模块屏蔽:', CFG.hiddenModules);

        // 查找所有论坛模块（大模块）
        const modules = document.querySelectorAll('.bm.bmw.flg.cl');
        // console.log('找到论坛模块数:', modules.length);

        modules.forEach(module => {
            const titleElement = module.querySelector('h2 span');
            if (titleElement) {
                const moduleName = titleElement.textContent.trim();
                // console.log('检查大模块:', moduleName);

                // 检查大模块是否在隐藏列表中
                const shouldHideModule = CFG.hiddenModules.some(hiddenName => {
                    return moduleName.includes(hiddenName) || hiddenName.includes(moduleName);
                });

                if (shouldHideModule) {
                    // console.log('隐藏大模块:', moduleName);
                    module.style.display = 'none';
                } else {
                    // 检查大模块下面的小模块
                    const subModules = module.querySelectorAll('.fl_g');
                    subModules.forEach(subModule => {
                        const subTitleElement = subModule.querySelector('dt a');
                        if (subTitleElement) {
                            const subModuleName = subTitleElement.textContent.trim();
                            // console.log('检查小模块:', subModuleName);

                            // 检查小模块是否在隐藏列表中
                            const shouldHideSubModule = CFG.hiddenModules.some(hiddenName => {
                                return subModuleName.includes(hiddenName) || hiddenName.includes(subModuleName);
                            });

                            if (shouldHideSubModule) {
                                // console.log('隐藏小模块:', subModuleName);
                                subModule.style.display = 'none';
                            }
                        }
                    });
                }
            }
        });
    }

    // 帖子详情标题处理函数
    function enhanceThreadTitle() {
        if (!CFG.enableThreadTitleEnhance) return;

        // 处理主标题
        const titleElement = document.querySelector('#thread_subject');
        if (titleElement) {
            let title = titleElement.textContent || titleElement.innerText;
            if (title) {
                const originalTitle = title;
                // console.log('当前配置的替换规则:', CFG.titleReplaceRules);
                // console.log('处理主标题:', originalTitle);

                // 应用自定义替换规则
                if (CFG.titleReplaceRules && CFG.titleReplaceRules.length > 0) {
                    for (const rule of CFG.titleReplaceRules) {
                        try {
                            // 直接使用字符串作为正则表达式，因为配置中已经转义了
                            const regex = new RegExp(rule.pattern, 'g');
                            title = title.replace(regex, rule.replacement);
                            // console.log('应用替换规则:', rule.pattern, '->', rule.replacement, '结果:', title);
                        } catch (e) {
                            // 如果正则表达式无效，则使用普通字符串替换
                            const escapedPattern = rule.pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                            title = title.replace(new RegExp(escapedPattern, 'g'), rule.replacement);
                            // console.log('使用字符串替换:', rule.pattern, '->', rule.replacement, '结果:', title);
                        }
                    }
                }

                // 替换中文【】为[]
                title = title.replace(/【/g, '[').replace(/】/g, ']');

                // 清理多余的空格
                title = title.replace(/\s+/g, ' ').trim();

                // 如果标题有变化，更新显示
                if (title !== originalTitle) {
                    // console.log('主标题有变化，准备更新DOM');
                    // console.log('原始标题:', originalTitle);
                    // console.log('处理后标题:', title);

                    // 创建可点击的标题元素
                    const clickableTitle = document.createElement('span');
                    clickableTitle.textContent = title;
                    clickableTitle.style.cssText = 'cursor: pointer; color: #0066cc; text-decoration: underline; user-select: none;';
                    clickableTitle.title = '点击复制标题';

                    // 添加点击事件
                    clickableTitle.addEventListener('click', () => {
                        GM_setClipboard(title);
                        const originalColor = clickableTitle.style.color;
                        clickableTitle.style.color = '#28a745';
                        clickableTitle.textContent = '已复制!';
                        showToast('标题已复制', 'success');
                        setTimeout(() => {
                            clickableTitle.style.color = originalColor;
                            clickableTitle.textContent = title;
                        }, 1000);
                    });

                    // 替换原元素内容
                    titleElement.innerHTML = '';
                    titleElement.appendChild(clickableTitle);

                    // console.log('DOM更新完成，当前元素内容:', titleElement.textContent);
                    // console.log('帖子标题增强:', originalTitle, '->', title);
                } else {
                    // console.log('主标题无变化，跳过更新');
                }
            }
        }

        // 处理类型标签链接
        const typeLink = document.querySelector('h1.ts a[href*="typeid="]');
        if (typeLink) {
            const typeText = typeLink.textContent || typeLink.innerText;
            // console.log('处理类型标签:', typeText);

            // 检查是否需要隐藏类型标签
            const shouldHideType = CFG.hideTypeLabels && CFG.hideTypeLabels.some(label => {
                return typeText.includes(label);
            });

            if (shouldHideType) {
                console.log('隐藏类型标签:', typeText);
                typeLink.style.display = 'none';
            }
        }
    }

    // 仅帖子详情页需要观察异步插入的楼层内容；其他页面完全不创建 Observer。
    let threadContentObserver = null;
    if (isThreadPage) {
        threadContentObserver = new MutationObserver(mutations => {
            const addedRoots = new Set();
            for (const mutation of mutations) {
                if (mutation.type !== 'childList') continue;
                let hasRelevantAddition = false;
                mutation.addedNodes.forEach(node => {
                    if (node.nodeType === Node.TEXT_NODE && node.nodeValue?.trim()) {
                        hasRelevantAddition = true;
                        return;
                    }
                    if (!(node instanceof Element)) return;
                    if (node.matches('[class^="sht-"], [id^="sht-"]') || node.closest('[class^="sht-"], [id^="sht-"]')) return;
                    hasRelevantAddition = true;
                    addedRoots.add(node);
                });
                if (hasRelevantAddition && mutation.target instanceof Element) addedRoots.add(mutation.target);
            }
            if (addedRoots.size) scanThreadContent(Array.from(addedRoots));
        });
        threadContentObserver.observe(document.body, { childList: true, subtree: true });
    }

    // ========== 115 离线下载功能 ==========
    const PAN115_REQUEST_TIMEOUT = 20000;
    let pan115UidCache = { value: null, ts: 0 };

    function ensurePan115Config() {
        if (!CFG.pan115Enabled) {
            throw new Error('115 离线功能未启用');
        }
        if (!CFG.pan115Cookie || !CFG.pan115Cookie.trim()) {
            throw new Error('115 Cookie 未配置，请在设置中填写');
        }
    }

    function makePan115Headers(extra = {}) {
        const base = {
            'Accept': 'application/json, text/javascript, */*; q=0.01',
            'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
            'X-Requested-With': 'XMLHttpRequest',
            'User-Agent': CFG.pan115UserAgent?.trim() || navigator.userAgent,
            'Cookie': CFG.pan115Cookie.trim(),
            'Origin': 'https://115.com',
            'Referer': 'https://115.com/?tab=offline&mode=wangpan',
            'Sec-Fetch-Mode': 'cors',
            'Sec-Fetch-Site': 'same-origin',
            'Sec-Fetch-Dest': 'empty'
        };
        return { ...base, ...extra };
    }

    async function pan115Request({ method = 'GET', url, data, headers = {}, responseType = 'json', signal = null, retries = 0 }) {
        ensurePan115Config();
        const response = await shtRequest({
            method, url, data, headers: makePan115Headers(headers), responseType,
            timeout: PAN115_REQUEST_TIMEOUT, signal, retries, scope: 'pan115'
        });
        return responseType === 'json' ? responseJson(response, '115 响应') : (response.response ?? response.responseText);
    }

    async function testPan115Connection({ cookie, userAgent }) {
        if (!cookie?.trim()) throw new Error('请先填写 115 Cookie');
        const response = await shtRequest({
            method: 'GET', url: 'https://my.115.com/?ct=ajax&ac=get_user_aq', responseType: 'json',
            timeout: PAN115_REQUEST_TIMEOUT, retries: 0, scope: 'pan115-test',
            headers: {
                ...makePan115Headers(),
                'Cookie': cookie.trim(),
                'User-Agent': userAgent?.trim() || navigator.userAgent
            }
        });
        const result = await responseJson(response, '115 测试响应');
        const uid = result?.data?.uid || result?.uid;
        if (!uid) throw new Error(result?.error_msg || '未获取到 UID，Cookie 可能已失效');
        return { uid };
    }

    async function pan115FetchUid(signal = null) {
        ensurePan115Config();
        const now = Date.now();
        if (pan115UidCache.value && now - pan115UidCache.ts < 10 * 60 * 1000) {
            return pan115UidCache.value;
        }
        const result = await pan115Request({
            method: 'GET',
            url: 'https://my.115.com/?ct=ajax&ac=get_user_aq',
            responseType: 'json', signal
        });
        const uid = result?.data?.uid || result?.uid;
        if (!uid) {
            throw new Error('无法获取 115 UID，请检查 Cookie 是否有效');
        }
        pan115UidCache = { value: uid, ts: now };
        return uid;
    }

    async function pan115FetchSignTime(signal = null) {
        const result = await pan115Request({
            method: 'GET',
            url: 'https://115.com/?ct=offline&ac=space',
            responseType: 'json',
            signal,
            headers: { 'Accept-Encoding': 'text/html' }
        });
        if (!result) {
            throw new Error('115 返回空响应');
        }
        if (result.state === false) {
            throw new Error(result.error_msg || '获取 115 离线签名失败');
        }
        if (!result.sign || !result.time) {
            throw new Error('115 响应缺少 sign/time 字段');
        }
        return { sign: result.sign, time: result.time };
    }

    async function pan115AddTasks(urls, options = {}) {
        ensurePan115Config();
        const uniqueUrls = Array.from(new Set((urls || []).map(u => u && u.trim()).filter(Boolean)));
        if (uniqueUrls.length === 0) {
            throw new Error('没有可发送的链接');
        }

        const uid = await pan115FetchUid(options.signal);
        let signTime = await pan115FetchSignTime(options.signal);

        const targetDir = (CFG.pan115CurrentThreadFolder && String(CFG.pan115CurrentThreadFolder).trim())
            || (CFG.pan115UploadDir && String(CFG.pan115UploadDir).trim())
            || '';

        const results = [];
        let successCount = 0;

        if (targetDir && !options.__fallbackUsed) {
            const valid = await pan115ValidateDirectory(targetDir);
            if (!valid) {
                console.warn('[115 离线] 目录已失效:', targetDir);
                clearPan115FolderReference(targetDir);
                showWarningModal('115 离线目录不存在或已删除，已清除缓存，请重新创建或选择新目录。');
                return pan115AddTasks(urls, { __fallbackUsed: true, signal: options.signal });
            }
        }

        const encodeUrlFor115 = (url) => {
            try {
                return encodeURIComponent(url).replace(/%20/g, '+');
            } catch {
                return url;
            }
        };

        const batchParams = new URLSearchParams();
        if (targetDir) batchParams.set('wp_path_id', targetDir);
        batchParams.set('uid', uid);
        batchParams.set('sign', signTime.sign);
        batchParams.set('time', signTime.time);
        uniqueUrls.forEach((url, idx) => {
            batchParams.set(`url[${idx}]`, encodeUrlFor115(url));
        });

        try {
            const response = await pan115Request({
                method: 'POST',
                url: 'https://115.com/web/lixian/?ct=lixian&ac=add_task_urls',
                data: batchParams.toString(),
                headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
                responseType: 'json', signal: options.signal
            });

            const respList = response?.result || [];
            const dirRemovedKeywords = ['不存在', '删除', '无效'];
            let directoryInvalid = false;
            for (let i = 0; i < uniqueUrls.length; i++) {
                const url = uniqueUrls[i];
                const entry = respList[i];
                let success = false;
                let message = '提交成功';
                let errorMsg = undefined;

                if (entry && entry.info_hash && !entry.error_msg) {
                    success = true;
                } else if (entry) {
                    message = entry.error_msg || entry.error || entry.errno || '提交失败';
                    errorMsg = message;
                } else {
                    message = '提交失败（未返回结果）';
                    errorMsg = message;
                }

                if (success) successCount++;
                results.push({
                    url,
                    success,
                    response: entry ?? null,
                    message,
                    error: errorMsg
                });

                if (!success && errorMsg && dirRemovedKeywords.some(k => errorMsg.includes(k))) {
                    directoryInvalid = true;
                }
            }
            if (directoryInvalid && targetDir) {
                console.warn('[115 离线] 目标目录失效，清除缓存:', targetDir);
                clearPan115FolderReference(targetDir);
                showWarningModal('115 离线目录已失效（可能已删除或无权限）。目录缓存已清除，请重新创建或选择目录后再试。');
            }
            if (response?.state === false && response?.error && targetDir) {
                if (dirRemovedKeywords.some(k => response.error.includes(k))) {
                    clearPan115FolderReference(targetDir);
                    showWarningModal('115 离线目录已失效（可能已删除或无权限）。目录缓存已清除，请重新创建或选择目录后再试。');
                }
            }
        } catch (error) {
            const errMessage = error instanceof Error ? error.message : String(error);
            uniqueUrls.forEach((url) => {
                results.push({ url, success: false, error: errMessage, message: errMessage });
            });
        }

        return {
            successCount,
            failCount: results.length - successCount,
            total: results.length,
            details: results
        };
    }

    async function create115FolderAndSend(triggerButton) {
        try {
            ensurePan115Config();
        } catch (error) {
            showWarningModal(error.message || '请先在设置中配置 115 离线认证信息');
            return;
        }

        const button = triggerButton || null;
        const originalText = button?.textContent;
        if (button) {
            button.disabled = true;
            button.textContent = '115 创建中...';
        }

        try {
            const folderName = cleanTitleForFolder(getCurrentThreadTitle()) || `离线_${Date.now()}`;
            const createResult = await api115CreateFolder(folderName);
            if (!createResult?.state) {
                clearPan115FolderReference(CFG.pan115CurrentThreadFolder);
                throw new Error(createResult?.error || createResult?.errno || '创建 115 文件夹失败');
            }

            const folderId = (createResult.cid || createResult.file_id || createResult.folder_id || '').toString();
            const realName = createResult.cname || createResult.file_name || folderName;
            if (!folderId) {
                clearPan115FolderReference(CFG.pan115CurrentThreadFolder);
                throw new Error('未获取到新文件夹 ID');
            }

            if (!CFG.pan115FolderNames || typeof CFG.pan115FolderNames !== 'object') CFG.pan115FolderNames = {};
            CFG.pan115FolderNames[folderId] = realName;

            saveCurrentThreadFolder115(folderId);
            updateCreateFolderButton115();
            refreshPan115FolderInfo();

            const ed2kLinks = collectAllED2K();
            const magnetLinks = collectAllMagnets();
            const allLinks = Array.from(new Set([...ed2kLinks, ...magnetLinks]));

            if (!allLinks.length) {
                showInfoModal(`已创建目录：${realName} (${folderId})，但未收集到可离线的 ED2K 或磁力链接。`);
                return;
            }

            if (button) {
                button.textContent = '115 离线发送中...';
            }

            const summary = await queueCloudProviderTask('pan115',
                ({ signal }) => pan115AddTasks(allLinks, { signal }),
                { label: `115 批量任务（${allLinks.length}）`, retries: 0 }
            );
            const { successCount, failCount, details } = summary;
            const total = summary.total || allLinks.length;
            const modalResults = formatPan115ResultItems(details, allLinks);
            showBatchResultModal(modalResults, successCount, failCount, total);
            if (failCount > 0 && Array.isArray(details)) {
                console.warn('[115 离线] 以下任务提交失败:');
                details.forEach((item, idx) => {
                    if (!item || item.success) return;
                    console.warn(`[#${idx + 1}]`, item.url || '未知链接', '| 错误:', item.error || item.message || '未知原因', '| 响应:', item.response);
                });
            }
        } catch (error) {
            clearPan115FolderReference(CFG.pan115CurrentThreadFolder);
            console.error('115 一键创建+离线失败:', error);
            const errMsg = error instanceof Error ? (error.message || '') : String(error);
            if (errMsg && errMsg.includes('目录不存在或已删除')) {
                showWarningModal('115 离线目录不存在或已删除，缓存已清除，请重新创建或选择目录后再试。');
            } else {
                showErrorModal(`115 一键创建+离线失败: ${errMsg || error}`);
            }
        } finally {
            if (button) {
                button.disabled = false;
                setIconLabel(button, 'bolt', originalText || '115 新建并离线');
            }
        }
    }

    // ========== 123Pan 离线下载功能 ==========

    // 123Pan API 基础函数
    function makePan123Session(overrides = {}) {
        const token = overrides.token ?? CFG.pan123Token;
        const loginUuid = overrides.loginUuid ?? CFG.pan123LoginUuid;
        const cookie = overrides.cookie ?? CFG.pan123Cookie;
        if (!token || !loginUuid || !cookie) {
            throw new Error('123Pan 认证信息不完整，请检查配置');
        }

        return {
            headers: {
                'Accept': 'application/json, text/plain, */*',
                'App-Version': '3',
                'Authorization': token,
                'Origin': 'https://www.123pan.com',
                'Referer': 'https://www.123pan.com/',
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X) AppleWebKit/537.36 (KHTML, like Gecko) Chrome Safari',
                'platform': 'web',
                'LoginUuid': loginUuid,
                'Cookie': cookie
            }
        };
    }

    // 生成随机查询参数
    function generateRandomQuery() {
        return `${Math.floor(Math.random() * 10000000000)}=${Math.floor(Math.random() * 10000000000)}-${Math.floor(Math.random() * 1000000)}-${Math.floor(Math.random() * 10000000000)}`;
    }

    async function pan123RequestJson({ method = 'GET', url, body, headers = {}, sessionOverrides = {}, signal = null, retries = 0 }) {
        const session = makePan123Session(sessionOverrides);
        const isFormData = typeof FormData !== 'undefined' && body instanceof FormData;
        const response = await shtRequest({
            method, url, signal, retries, timeout: 30_000, responseType: 'json', scope: 'pan123',
            headers: {
                ...session.headers,
                ...(body != null && !isFormData ? { 'Content-Type': 'application/json;charset=UTF-8' } : {}),
                ...headers
            },
            data: body == null || isFormData ? body : JSON.stringify(body)
        });
        return responseJson(response, '123Pan 响应');
    }

    async function testPan123Connection({ token, loginUuid, cookie }) {
        const url = `https://www.123pan.com/b/api/offline_download/task/list?${generateRandomQuery()}`;
        const result = await pan123RequestJson({
            method: 'POST', url, sessionOverrides: { token, loginUuid, cookie },
            body: { current_page: 1, page_size: 1, status_arr: [0, 1, 3, 4] }
        });
        if (result?.code !== 0) throw new Error(result?.message || '123Pan 凭据验证失败');
        return result;
    }

    // 使用GM_xmlhttpRequest下载文件（绕过CORS）
    async function downloadFileWithGM(url, options = {}) {
        const response = await shtRequest({
            method: 'GET', url, responseType: 'arraybuffer', timeout: 30_000,
            signal: options.signal, onProgress: options.onProgress, retries: 1, scope: 'torrent-download',
            headers: {
                'Cookie': document.cookie,
                'User-Agent': navigator.userAgent,
                'Referer': window.location.href
            }
        });
        return new Blob([response.response]);
    }

    const torrentSendControllers = new WeakMap();
    async function sendTorrentAttachmentToPan123(button, url, title) {
        const running = torrentSendControllers.get(button);
        if (running) {
            running.abort();
            return;
        }
        if (!CFG.pan123Enabled || !CFG.pan123Token || !CFG.pan123LoginUuid || !CFG.pan123Cookie) {
            showToast('请先在设置中启用 123Pan 并配置认证信息', 'warning');
            return;
        }
        const controller = new AbortController();
        torrentSendControllers.set(button, controller);
        try {
            button.textContent = '准备中…（点击取消）';
            const torrentBlob = await downloadFileWithGM(url, {
                signal: controller.signal,
                onProgress: ({ loaded, total }) => {
                    const value = total ? `${Math.round((loaded / total) * 100)}%` : formatBytes(loaded);
                    button.textContent = `下载 ${value}（点击取消）`;
                }
            });
            button.textContent = '提交中…（点击取消）';
            await processTorrentOffline(torrentBlob, title, { signal: controller.signal });
            showToast('种子任务已发送到 123Pan', 'success');
        } catch (error) {
            showToast(describeRequestError(error), error?.name === 'AbortError' ? 'info' : 'error', 5000);
        } finally {
            torrentSendControllers.delete(button);
            button.textContent = '发送到123Pan';
        }
    }

    // 上传 torrent 文件到 123Pan
    async function apiUploadTorrent(torrentBlob, filename, options = {}) {
        const url = `https://www.123pan.com/b/api/offline_download/upload/seed?${generateRandomQuery()}`;

        const formData = new FormData();
        formData.append('upload-torrent', torrentBlob, filename);
        return pan123RequestJson({ method: 'POST', url, body: formData, signal: options.signal });
    }

    // 解析资源（通过infohash）
    async function apiResolve(infohash, options = {}) {
        const url = `https://www.123pan.com/b/api/v2/offline_download/task/resolve?${generateRandomQuery()}`;
        return pan123RequestJson({ method: 'POST', url, body: { info_hash: infohash.toLowerCase() }, signal: options.signal });
    }

    // 解析磁力链接
    async function apiResolveMagnet(magnetUrl, options = {}) {
        const url = `https://www.123pan.com/b/api/v2/offline_download/task/resolve?${generateRandomQuery()}`;
        return pan123RequestJson({ method: 'POST', url, body: { urls: magnetUrl }, signal: options.signal });
    }

    // 提交离线任务
    async function apiSubmit(resourceId, fileIds, options = {}) {
        const url = `https://www.123pan.com/b/api/v2/offline_download/task/submit?${generateRandomQuery()}`;

        const payload = {
            resource_list: [{
                resource_id: resourceId,
                select_file_id: fileIds
            }]
        };

        // 优先使用当前帖子的文件夹，否则使用默认文件夹
        const uploadDir = CFG.pan123CurrentThreadFolder || CFG.pan123UploadDir;
        if (uploadDir) {
            payload.upload_dir = parseInt(uploadDir);
        }

        return pan123RequestJson({ method: 'POST', url, body: payload, signal: options.signal });
    }

    // 获取离线任务列表
    async function apiGetOfflineTasks(options = {}) {
        const url = `https://www.123pan.com/b/api/offline_download/task/list?${generateRandomQuery()}`;

        const data = {
            current_page: 1,
            page_size: 15,
            status_arr: [0, 1, 3, 4] // 0: pending, 1: downloading, 3: completed, 4: failed
        };

        return pan123RequestJson({ method: 'POST', url, body: data, signal: options.signal });
    }

    // 取消离线任务
    async function apiCancelOfflineTask(taskId, options = {}) {
        const url = `https://www.123pan.com/b/api/offline_download/task/abort?${generateRandomQuery()}`;

        const data = {
            all: false,
            is_abort: true,
            task_ids: [parseInt(taskId)]
        };

        return pan123RequestJson({ method: 'POST', url, body: data, signal: options.signal });
    }

    // 创建文件夹
    async function apiCreateFolder(folderName, parentFileId = 0) {
        const url = `https://www.123pan.com/b/api/file/upload_request?${generateRandomQuery()}`;

        const data = {
            driveId: 0,
            etag: '',
            fileName: folderName,
            parentFileId: parentFileId,
            size: 0,
            type: 1, // 1表示文件夹
            duplicate: 1, // 允许重复名称
            NotReuse: true,
            event: 'newCreateFolder',
            operateType: 1,
            RequestSource: null
        };

        return pan123RequestJson({ method: 'POST', url, body: data });
    }

    // 获取文件夹信息（通过文件ID）
    async function apiGetFileInfo(fileId) {
        const url = `https://www.123pan.com/b/api/file/info?${generateRandomQuery()}&fileId=${fileId}`;

        try {
            const result = await pan123RequestJson({ method: 'GET', url, retries: 1 });

            if (result.code === 0 && result.data) {
                return result.data;
            }

            return null;
        } catch (error) {
            console.error('获取文件信息失败:', error);
            throw error;
        }
    }

    // 获取文件夹名称（通过ID）
    async function getFolderNameById(folderId) {
        if (!folderId || folderId === '0') return '根目录';

        try {
            const folder = await apiGetFileInfo(folderId);
            return folder ? folder.FileName : `文件夹_${folderId}`;
        } catch (error) {
            console.error('获取文件夹名称失败:', error);
            return `文件夹_${folderId}`;
        }
    }

    // 清理标题用于文件夹名称
    function cleanTitleForFolder(title) {
        if (!title) return `文件夹_${new Date().toISOString().slice(0, 10)}`;

        return title
            .replace(/[<>:"/\\|?*]/g, '')  // 移除Windows不允许的字符
            .replace(/[\r\n\t]/g, ' ')     // 替换换行符和制表符为空格
            .replace(/\s+/g, ' ')          // 合并多个空格
            .trim()                        // 去除首尾空格
            .substring(0, 100);            // 限制长度
    }

    // 获取当前帖子标题
    function getCurrentThreadTitle() {
        const titleElement = document.querySelector('#thread_subject');
        if (titleElement) {
            return titleElement.textContent?.trim() || '';
        }

        // 备用方案：从页面标题获取
        const pageTitle = document.title;
        if (pageTitle && pageTitle !== '色花堂') {
            return pageTitle.replace(' - 色花堂', '').trim();
        }

        return '';
    }

    // 获取当前帖子URL
    function getCurrentThreadUrl() {
        return window.location.href;
    }

    // 检查当前帖子是否有对应的文件夹
    function checkCurrentThreadFolder() {
        const currentUrl = getCurrentThreadUrl();
        const folderId = CFG.pan123ThreadFolders[currentUrl];

        if (folderId) {
            CFG.pan123CurrentThreadFolder = folderId;
            return true;
        }

        CFG.pan123CurrentThreadFolder = '';
        return false;
    }

    // 保存当前帖子的文件夹映射
    function saveCurrentThreadFolder(folderId) {
        const currentUrl = getCurrentThreadUrl();
        CFG.pan123ThreadFolders[currentUrl] = folderId;
        CFG.pan123CurrentThreadFolder = folderId;
        refreshPan123FolderInfo();
        saveConfig();
    }

    // 显示创建文件夹对话框
    function showCreateFolderDialog() {
        if (!CFG.pan123Enabled || !CFG.pan123Token || !CFG.pan123LoginUuid || !CFG.pan123Cookie) {
            showWarningModal('请先在设置中配置 123Pan 认证信息');
            return;
        }

        const currentTitle = getCurrentThreadTitle();
        const cleanTitle = cleanTitleForFolder(currentTitle);

        const modal = createModal('创建123Pan文件夹', '', 'info', { showConfirm: false });
        const content = document.createElement('div');
        content.style.cssText = 'padding: 20px; text-align: left;';

        // 标题说明
        const titleLabel = document.createElement('div');
        titleLabel.textContent = '文件夹名称：';
        titleLabel.style.cssText = 'margin-bottom: 8px; font-weight: bold; color: #333;';
        content.appendChild(titleLabel);

        // 输入框
        const input = document.createElement('input');
        input.type = 'text';
        input.value = cleanTitle;
        input.placeholder = '请输入文件夹名称';
        input.style.cssText = 'width: 100%; padding: 10px; border: 1px solid #ddd; border-radius: 4px; font-size: 14px; margin-bottom: 15px;';
        content.appendChild(input);

        // 选项组
        const optionsGroup = document.createElement('div');
        optionsGroup.style.cssText = 'margin-bottom: 15px;';

        const optionsLabel = document.createElement('div');
        optionsLabel.textContent = '创建后操作：';
        optionsLabel.style.cssText = 'margin-bottom: 8px; font-weight: bold; color: #333;';
        optionsGroup.appendChild(optionsLabel);

        const setAsDefaultOption = document.createElement('label');
        setAsDefaultOption.style.cssText = 'display: block; margin-bottom: 8px; cursor: pointer;';
        const setAsDefaultCheckbox = document.createElement('input');
        setAsDefaultCheckbox.type = 'checkbox';
        setAsDefaultCheckbox.checked = false;
        setAsDefaultCheckbox.style.cssText = 'margin-right: 8px;';
        setAsDefaultOption.appendChild(setAsDefaultCheckbox);
        setAsDefaultOption.appendChild(document.createTextNode('设为默认文件夹（影响所有新帖子）'));
        optionsGroup.appendChild(setAsDefaultOption);

        const setAsCurrentOption = document.createElement('label');
        setAsCurrentOption.style.cssText = 'display: block; margin-bottom: 8px; cursor: pointer;';
        const setAsCurrentCheckbox = document.createElement('input');
        setAsCurrentCheckbox.type = 'checkbox';
        setAsCurrentCheckbox.checked = true;
        setAsCurrentCheckbox.style.cssText = 'margin-right: 8px;';
        setAsCurrentOption.appendChild(setAsCurrentCheckbox);
        setAsCurrentOption.appendChild(document.createTextNode('设为本次离线文件夹（仅影响当前帖子）'));
        optionsGroup.appendChild(setAsCurrentOption);

        content.appendChild(optionsGroup);

        // 说明文字
        const helpText = document.createElement('div');
        helpText.style.cssText = 'font-size: 12px; color: #666; margin-bottom: 15px; line-height: 1.4;';
        helpText.innerHTML = `
    <div>• 默认使用当前帖子标题作为文件夹名称</div>
    <div>• 已自动清理特殊字符，您可以根据需要修改</div>
    <div>• 建议选择"设为本次离线文件夹"避免嵌套问题</div>
  `;
        content.appendChild(helpText);

        // 按钮组
        const buttonGroup = document.createElement('div');
        buttonGroup.style.cssText = 'display: flex; gap: 10px; justify-content: flex-end;';

        const cancelBtn = document.createElement('button');
        cancelBtn.textContent = '取消';
        cancelBtn.style.cssText = 'padding: 8px 16px; background: #6c757d; color: white; border: none; border-radius: 4px; cursor: pointer;';
        cancelBtn.onclick = () => modal.closeSht();

        const createBtn = document.createElement('button');
        setIconLabel(createBtn, 'folder', '创建文件夹');
        createBtn.style.cssText = 'padding: 8px 16px; background: linear-gradient(135deg, #007cba 0%, #005a87 100%); color: white; border: none; border-radius: 4px; cursor: pointer; font-weight: bold;';

        createBtn.onclick = async () => {
            const folderName = input.value.trim();
            if (!folderName) {
                showErrorModal('请输入文件夹名称');
                return;
            }

            createBtn.disabled = true;
            createBtn.textContent = '创建中...';

            try {
                const result = await apiCreateFolder(folderName);

                if (result.code === 0 && result.data?.Info) {
                    const folderId = result.data.Info.FileId;
                    const folderName = result.data.Info.FileName;

                    let message = `文件夹创建成功！\n\n文件夹名称：${folderName}\n文件夹ID：${folderId}\n\n`;

                    // 根据用户选择执行不同操作
                    if (setAsDefaultCheckbox.checked) {
                        CFG.pan123UploadDir = folderId.toString();
                        message += '已设为默认上传目录';
                    }

                    if (setAsCurrentCheckbox.checked) {
                        saveCurrentThreadFolder(folderId.toString());
                        message += (setAsDefaultCheckbox.checked ? '，' : '') + '已设为当前帖子离线文件夹';
                    }

                    saveConfig();
                    showSuccessModal(message);
                    modal.closeSht();

                    // 直接更新按钮显示，使用API返回的文件夹名称
                    const btn = document.querySelector('#sht-create-folder-btn');
                    if (btn) {
                        setIconLabel(btn, 'folder', folderName);
                        btn.title = `当前帖子离线文件夹: ${folderName} (ID: ${folderId})`;
                    }
                    refreshPan123FolderInfo();
                } else {
                    throw new Error(result.message || '创建文件夹失败');
                }
            } catch (error) {
                console.error('创建文件夹失败:', error);
                showErrorModal(`创建文件夹失败: ${error.message}`);
                createBtn.disabled = false;
                setIconLabel(createBtn, 'folder', '创建文件夹');
            }
        };

        buttonGroup.appendChild(cancelBtn);
        buttonGroup.appendChild(createBtn);
        content.appendChild(buttonGroup);

        modal.querySelector('.modal-content').appendChild(content);

        // 自动聚焦输入框
        setTimeout(() => input.focus(), 100);

        // 支持回车键创建
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                createBtn.click();
            }
        });
    }

    // 更新创建文件夹按钮显示
    async function updateCreateFolderButton() {
        const btn = document.querySelector('#sht-create-folder-btn');
        if (!btn) return;

        const currentFolderId = CFG.pan123CurrentThreadFolder;
        if (currentFolderId) {
            // 先显示加载状态
            setIconLabel(btn, 'refresh', '加载中...');
            btn.title = '正在获取文件夹信息...';

            try {
                const folderName = await getFolderNameById(currentFolderId);
                setIconLabel(btn, 'folder', folderName);
                const defaultId = CFG.pan123UploadDir && String(CFG.pan123UploadDir).trim();
                btn.title = `当前帖子离线文件夹: ${folderName} (ID: ${currentFolderId})` + (defaultId ? `\n默认目录 ID: ${defaultId}` : '');
            } catch (error) {
                console.error('获取文件夹名称失败:', error);
                setIconLabel(btn, 'folder', `文件夹_${currentFolderId}`);
                const defaultId = CFG.pan123UploadDir && String(CFG.pan123UploadDir).trim();
                btn.title = `当前帖子离线文件夹: 文件夹_${currentFolderId}` + (defaultId ? `\n默认目录 ID: ${defaultId}` : '');
            }
        } else {
            setIconLabel(btn, 'folder', '123 新建');
            const defaultId = CFG.pan123UploadDir && String(CFG.pan123UploadDir).trim();
            btn.title = defaultId ? `默认目录 ID: ${defaultId}\n点击创建或切换目录` : '尚未设置 123Pan 默认目录，点击创建';
        }
        refreshPan123FolderInfo();
    }

    function checkCurrentThreadFolder115() {
        if (!CFG.pan115ThreadFolders || typeof CFG.pan115ThreadFolders !== 'object') {
            CFG.pan115ThreadFolders = {};
        }
        const currentUrl = getCurrentThreadUrl();
        const folderId = CFG.pan115ThreadFolders[currentUrl];
        if (folderId) {
            CFG.pan115CurrentThreadFolder = folderId;
            return true;
        }
        CFG.pan115CurrentThreadFolder = '';
        return false;
    }

    function saveCurrentThreadFolder115(folderId) {
        if (!folderId) return;
        if (!CFG.pan115ThreadFolders || typeof CFG.pan115ThreadFolders !== 'object') {
            CFG.pan115ThreadFolders = {};
        }
        if (!CFG.pan115FolderNames || typeof CFG.pan115FolderNames !== 'object') {
            CFG.pan115FolderNames = {};
        }
        const currentUrl = getCurrentThreadUrl();
        CFG.pan115ThreadFolders[currentUrl] = folderId;
        CFG.pan115CurrentThreadFolder = folderId;
        refreshPan115FolderInfo();
        saveConfig();
    }

    function clearPan115FolderReference(folderId) {
        if (!folderId) return;
        const idStr = String(folderId);
        if (CFG.pan115FolderNames && typeof CFG.pan115FolderNames === 'object') {
            delete CFG.pan115FolderNames[idStr];
        }
        if (CFG.pan115ThreadFolders && typeof CFG.pan115ThreadFolders === 'object') {
            const currentUrl = getCurrentThreadUrl();
            if (CFG.pan115ThreadFolders[currentUrl] === idStr) {
                delete CFG.pan115ThreadFolders[currentUrl];
                CFG.pan115CurrentThreadFolder = '';
            }
            Object.keys(CFG.pan115ThreadFolders).forEach(url => {
                if (CFG.pan115ThreadFolders[url] === idStr) {
                    delete CFG.pan115ThreadFolders[url];
                }
            });
        }
        if (CFG.pan115UploadDir === idStr) {
            CFG.pan115UploadDir = '';
        }
        refreshPan115FolderInfo();
        updateCreateFolderButton115();
        saveConfig();
    }

    async function pan115ValidateDirectory(folderId) {
        if (!folderId) return false;
        try {
            const info = await api115GetFolderInfo(folderId);
            if (!info) return false;
            if (info.state === false) return false;
            return true;
        } catch (error) {
            console.warn('[115 离线] 目录校验失败:', folderId, error);
            return false;
        }
    }

    async function api115CreateFolder(folderName, parentId = null) {
        ensurePan115Config();
        const pid = parentId !== null
            ? String(parentId)
            : (CFG.pan115CurrentThreadFolder && String(CFG.pan115CurrentThreadFolder).trim())
            || (CFG.pan115UploadDir && String(CFG.pan115UploadDir).trim())
            || '0';

        const params = new URLSearchParams();
        params.set('pid', pid || '0');
        params.set('cname', folderName);

        return await pan115Request({
            method: 'POST',
            url: 'https://webapi.115.com/files/add',
            data: params.toString(),
            headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
            responseType: 'json'
        });
    }

    async function api115GetFolderInfo(folderId) {
        ensurePan115Config();
        const url = `https://webapi.115.com/files/get_info?file_id=${encodeURIComponent(folderId)}`;
        return await pan115Request({
            method: 'GET',
            url,
            responseType: 'json'
        });
    }

    async function get115FolderNameById(folderId) {
        if (!folderId) return '根目录';
        if (CFG.pan115FolderNames && CFG.pan115FolderNames[folderId]) {
            return CFG.pan115FolderNames[folderId];
        }
        let info = null;
        try {
            info = await api115GetFolderInfo(folderId);
        } catch (error) {
            console.error('获取 115 文件夹名称失败:', error);
        }
        const candidates = [
            info?.data?.file_name,
            info?.data?.name,
            info?.file_name,
            info?.name,
            info?.cname,
            info?.folder_name,
            info?.FileName,
            info?.Name
        ].filter(Boolean);
        if (candidates.length > 0) {
            const name = candidates[0];
            if (!CFG.pan115FolderNames || typeof CFG.pan115FolderNames !== 'object') CFG.pan115FolderNames = {};
            CFG.pan115FolderNames[folderId] = name;
            saveConfig();
            return name;
        }
        return `文件夹_${folderId}`;
    }

    function showCreate115FolderDialog() {
        try {
            ensurePan115Config();
        } catch (error) {
            showWarningModal(error.message || '请先在设置中配置 115 离线认证信息');
            return;
        }

        const currentTitle = getCurrentThreadTitle();
        const cleanTitle = cleanTitleForFolder(currentTitle);
        const modal = createModal('创建115离线文件夹', '', 'info', { showConfirm: false });
        const content = document.createElement('div');
        content.style.cssText = 'padding: 20px; text-align: left;';

        const titleLabel = document.createElement('div');
        titleLabel.textContent = '文件夹名称：';
        titleLabel.style.cssText = 'margin-bottom: 8px; font-weight: bold; color: #333;';
        content.appendChild(titleLabel);

        const input = document.createElement('input');
        input.type = 'text';
        input.value = cleanTitle;
        input.placeholder = '请输入文件夹名称';
        input.style.cssText = 'width: 100%; padding: 10px; border: 1px solid #ddd; border-radius: 4px; font-size: 14px; margin-bottom: 15px;';
        content.appendChild(input);

        const optionsGroup = document.createElement('div');
        optionsGroup.style.cssText = 'margin-bottom: 15px;';

        const optionsLabel = document.createElement('div');
        optionsLabel.textContent = '创建后操作：';
        optionsLabel.style.cssText = 'margin-bottom: 8px; font-weight: bold; color: #333;';
        optionsGroup.appendChild(optionsLabel);

        const setAsDefaultOption = document.createElement('label');
        setAsDefaultOption.style.cssText = 'display: block; margin-bottom: 8px; cursor: pointer;';
        const setAsDefaultCheckbox = document.createElement('input');
        setAsDefaultCheckbox.type = 'checkbox';
        setAsDefaultCheckbox.checked = false;
        setAsDefaultCheckbox.style.cssText = 'margin-right: 8px;';
        setAsDefaultOption.appendChild(setAsDefaultCheckbox);
        setAsDefaultOption.appendChild(document.createTextNode('设为默认目录（影响所有新帖子）'));
        optionsGroup.appendChild(setAsDefaultOption);

        const setAsCurrentOption = document.createElement('label');
        setAsCurrentOption.style.cssText = 'display: block; margin-bottom: 8px; cursor: pointer;';
        const setAsCurrentCheckbox = document.createElement('input');
        setAsCurrentCheckbox.type = 'checkbox';
        setAsCurrentCheckbox.checked = true;
        setAsCurrentCheckbox.style.cssText = 'margin-right: 8px;';
        setAsCurrentOption.appendChild(setAsCurrentCheckbox);
        setAsCurrentOption.appendChild(document.createTextNode('设为本帖离线目录（仅当前帖子）'));
        optionsGroup.appendChild(setAsCurrentOption);

        content.appendChild(optionsGroup);

        const parentId = (CFG.pan115CurrentThreadFolder && String(CFG.pan115CurrentThreadFolder).trim())
            || (CFG.pan115UploadDir && String(CFG.pan115UploadDir).trim())
            || '0';
        const helpText = document.createElement('div');
        helpText.style.cssText = 'font-size: 12px; color: #666; margin-bottom: 15px; line-height: 1.4;';
        helpText.innerHTML = `
    <div>• 默认使用当前帖子标题作为文件夹名称，您可以修改</div>
    <div>• 将在目录 ID ${parentId === '0' ? '根目录' : parentId} 下创建该文件夹</div>
    <div>• 可将该目录设置为默认或仅当前帖子使用</div>
  `;
        content.appendChild(helpText);

        const buttonGroup = document.createElement('div');
        buttonGroup.style.cssText = 'display: flex; gap: 10px; justify-content: flex-end;';

        const cancelBtn = document.createElement('button');
        cancelBtn.textContent = '取消';
        cancelBtn.style.cssText = 'padding: 8px 16px; background: #6c757d; color: white; border: none; border-radius: 4px; cursor: pointer;';
        cancelBtn.onclick = () => modal.closeSht();

        const createBtn = document.createElement('button');
        setIconLabel(createBtn, 'folder', '创建文件夹');
        createBtn.style.cssText = 'padding: 8px 16px; background: linear-gradient(135deg, #f6c343 0%, #f49f0a 100%); color: #3b2f09; border: none; border-radius: 4px; cursor: pointer; font-weight: bold;';

        createBtn.onclick = async () => {
            const folderName = input.value.trim();
            if (!folderName) {
                showErrorModal('请输入文件夹名称');
                return;
            }

            createBtn.disabled = true;
            createBtn.textContent = '创建中...';

            try {
                const result = await api115CreateFolder(folderName, parentId);
                if (result?.state) {
                    const folderId = (result.cid || result.file_id || result.folder_id || '').toString();
                    const finalName = result.cname || result.file_name || folderName;
                    if (!folderId) throw new Error('未获取到新文件夹ID');

                    let message = `文件夹创建成功！\n\n名称：${finalName}\nID：${folderId}\n\n`;

                    if (!CFG.pan115FolderNames || typeof CFG.pan115FolderNames !== 'object') {
                        CFG.pan115FolderNames = {};
                    }
                    CFG.pan115FolderNames[folderId] = finalName;

                    if (setAsDefaultCheckbox.checked) {
                        CFG.pan115UploadDir = folderId;
                        message += '已设为默认目录';
                    }

                    if (setAsCurrentCheckbox.checked) {
                        if (!setAsDefaultCheckbox.checked) {
                            message += '已设为本帖目录';
                        } else {
                            message += '，同时设为本帖目录';
                        }
                        saveCurrentThreadFolder115(folderId);
                    } else {
                        saveConfig();
                    }

                    showSuccessModal(message);
                    modal.closeSht();
                    updateCreateFolderButton115();
                    refreshPan115FolderInfo();
                } else {
                    throw new Error(result?.error || result?.errno || '创建文件夹失败');
                }
            } catch (error) {
                console.error('创建 115 文件夹失败:', error);
                showErrorModal(`创建文件夹失败: ${error.message}`);
                createBtn.disabled = false;
                setIconLabel(createBtn, 'folder', '创建文件夹');
            }
        };

        buttonGroup.appendChild(cancelBtn);
        buttonGroup.appendChild(createBtn);
        content.appendChild(buttonGroup);

        modal.querySelector('.modal-content').appendChild(content);
        setTimeout(() => input.focus(), 100);
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') createBtn.click();
        });
    }

    async function updateCreateFolderButton115() {
        const btn = document.querySelector('#sht-create-folder-115-btn');
        if (!btn) return;
        if (!CFG.pan115Enabled) {
            setIconLabel(btn, 'folder', '115 新建');
            btn.title = '启用 115 离线后可使用此功能';
            return;
        }

        const currentFolderId = CFG.pan115CurrentThreadFolder && String(CFG.pan115CurrentThreadFolder).trim();
        if (currentFolderId) {
            setIconLabel(btn, 'refresh', '115 加载中...');
            btn.title = '正在获取文件夹信息...';
            try {
                const folderName = await get115FolderNameById(currentFolderId);
                setIconLabel(btn, 'folder', `115 ${folderName} (${currentFolderId})`);
                btn.title = `当前帖子离线目录: ${folderName} (ID: ${currentFolderId})`;
            } catch (error) {
                console.error('获取 115 文件夹名称失败:', error);
                setIconLabel(btn, 'folder', `115 文件夹_${currentFolderId} (${currentFolderId})`);
                btn.title = `当前帖子离线目录: 文件夹_${currentFolderId}`;
            }
        } else {
            setIconLabel(btn, 'folder', '115 新建');
            btn.title = CFG.pan115UploadDir
                ? `默认目录 ID: ${CFG.pan115UploadDir}\n点击创建新目录`
                : '尚未设置 115 默认目录，点击创建';
        }
    }

    function refreshPan115FolderInfo() {
        const infoEl = document.getElementById('sht-pan115-folder-info');
        if (!infoEl) return;
        const defaultId = CFG.pan115UploadDir && String(CFG.pan115UploadDir).trim();
        const currentId = CFG.pan115CurrentThreadFolder && String(CFG.pan115CurrentThreadFolder).trim();
        const nameOf = (id) => {
            if (!id) return '';
            if (CFG.pan115FolderNames && CFG.pan115FolderNames[id]) return `${CFG.pan115FolderNames[id]} (${id})`;
            return id;
        };
        const defaultLabel = defaultId ? nameOf(defaultId) : '未设置';
        const currentLabel = currentId ? nameOf(currentId) : '';
        infoEl.textContent = `默认目录: ${defaultLabel}${currentLabel ? ` | 本帖目录: ${currentLabel}` : ''}`;
    }

    function refreshPan123FolderInfo() {
        const infoEl = document.getElementById('sht-pan123-folder-info');
        if (!infoEl) return;
        const defaultId = CFG.pan123UploadDir && String(CFG.pan123UploadDir).trim();
        const currentId = CFG.pan123CurrentThreadFolder && String(CFG.pan123CurrentThreadFolder).trim();
        infoEl.textContent = `默认目录 ID: ${defaultId || '未设置'}${currentId ? ` | 本帖目录 ID: ${currentId}` : ''}`;
    }

    // 解析文件大小
    function parseSize(sizeText) {
        if (!sizeText) return 0;

        const sizeTextUpper = sizeText.toUpperCase();
        const match = sizeTextUpper.match(/^([0-9]+(?:\.[0-9]+)?)\s*(B|KB|MB|GB|TB)?$/);
        if (!match) return 0;

        const val = parseFloat(match[1]);
        const unit = (match[2] || 'B').toUpperCase();
        const multipliers = { 'B': 1, 'KB': 1024, 'MB': 1024 ** 2, 'GB': 1024 ** 3, 'TB': 1024 ** 4 };
        return Math.floor(val * multipliers[unit]);
    }

    // 判断是否为视频文件
    function isVideoFile(filename) {
        const videoExtensions = ['.mp4', '.avi', '.mkv', '.wmv', '.flv', '.mov', '.mpg', '.mpeg', '.m4v', '.3gp', '.webm'];
        const filenameLower = filename.toLowerCase();
        return videoExtensions.some(ext => filenameLower.endsWith(ext));
    }

    // 文件过滤
    function selectFiles(files) {
        const minSize = parseSize(CFG.pan123MinSize);
        const maxSize = parseSize(CFG.pan123MaxSize);
        const videoMinSize = parseSize(CFG.pan123VideoMinSize);
        const includeExts = CFG.pan123IncludeExt.split(',').map(ext => ext.trim().toLowerCase());
        const excludeExts = CFG.pan123ExcludeExt.split(',').map(ext => ext.trim().toLowerCase());

        const candidates = [];
        const excludedFiles = [];

        for (const file of files) {
            const name = file.name || '';
            const size = parseInt(file.size || 0);
            const fileId = parseInt(file.id);

            // 检查扩展名
            const hasIncludeExt = includeExts.length === 0 || includeExts.some(ext => name.toLowerCase().endsWith(ext));
            const hasExcludeExt = excludeExts.some(ext => name.toLowerCase().endsWith(ext));

            if (!hasIncludeExt) {
                excludedFiles.push({ name, reason: '不在包含扩展名列表中' });
                continue;
            }

            if (hasExcludeExt) {
                excludedFiles.push({ name, reason: '在排除扩展名列表中' });
                continue;
            }

            // 大小过滤
            if (isVideoFile(name)) {
                if (videoMinSize && size < videoMinSize) {
                    excludedFiles.push({ name, reason: `视频文件小于 ${Math.floor(videoMinSize / (1024 * 1024))}MB` });
                    continue;
                }
            } else {
                if (minSize && size < minSize) {
                    excludedFiles.push({ name, reason: `文件小于 ${Math.floor(minSize / (1024 * 1024))}MB` });
                    continue;
                }
            }

            if (maxSize && size > maxSize) {
                excludedFiles.push({ name, reason: `文件大于 ${Math.floor(maxSize / (1024 * 1024))}MB` });
                continue;
            }

            candidates.push({ size, fileId });
        }

        if (excludedFiles.length > 0) {
            console.log('排除的文件:', excludedFiles.slice(0, 5));
        }

        if (candidates.length === 0) {
            return [];
        }

        if (CFG.pan123PickLargest) {
            const largest = candidates.reduce((max, current) => current.size > max.size ? current : max);
            return [largest.fileId];
        }

        return candidates.map(c => c.fileId);
    }

    // 检查任务是否在离线列表中
    async function checkTaskInOfflineList(resourceName, options = {}) {
        try {
            const offlineData = await apiGetOfflineTasks(options);
            if (offlineData.code !== 0) {
                console.warn('获取离线任务列表失败:', offlineData.message);
                return null;
            }

            const taskList = offlineData.data?.list || [];

            for (const task of taskList) {
                const taskName = task.name || '';
                const taskId = task.task_id || '';
                const status = task.status || '';

                // 精确匹配或文件名匹配
                if (taskName === resourceName || taskName.startsWith(resourceName)) {
                    console.log(`找到任务: ${resourceName} -> ${taskName} (ID: ${taskId}, 状态: ${status})`);
                    return task;
                }

                // 去掉扩展名后匹配
                const resourceBase = resourceName.split('.')[0];
                const taskBase = taskName.split('.')[0];
                if (resourceBase === taskBase) {
                    console.log(`基础名匹配找到任务: ${resourceName} -> ${taskName} (ID: ${taskId}, 状态: ${status})`);
                    return task;
                }
            }

            console.log(`任务不在离线列表中: ${resourceName}`);
            return null;
        } catch (error) {
            if (error?.name === 'AbortError') throw error;
            console.error('检查任务状态失败:', error);
            return null;
        }
    }

    // 获取离线任务统计信息
    async function getOfflineTaskStats() {
        try {
            const offlineData = await apiGetOfflineTasks();
            if (offlineData.code !== 0) {
                return { total: 0, running: 0, completed: 0, failed: 0 };
            }

            const taskList = offlineData.data?.list || [];
            const stats = {
                total: taskList.length,
                running: 0,
                completed: 0,
                failed: 0
            };

            taskList.forEach(task => {
                switch (task.status) {
                    case 1: // 运行中
                        stats.running++;
                        break;
                    case 2: // 已完成
                        stats.completed++;
                        break;
                    case 3: // 失败
                        stats.failed++;
                        break;
                }
            });

            return stats;
        } catch (error) {
            console.error('获取离线任务统计失败:', error);
            return { total: 0, running: 0, completed: 0, failed: 0 };
        }
    }

    // 处理秒离线检测结果
    async function handleInstantOfflineResult(resourceName, selectedFileIds, isInstantOffline, actionTaken = '') {
        const stats = await getOfflineTaskStats();

        let message = `离线任务提交成功！\n`;
        message += `资源: ${resourceName}\n`;
        message += `选择文件: ${selectedFileIds.length} 个\n\n`;

        if (isInstantOffline) {
            message += `状态: 秒离线成功\n`;
            message += `文件已直接下载到123Pan\n`;
        } else {
            message += `状态: 正在离线下载\n`;
            if (actionTaken) {
                message += `处理方式: ${actionTaken}\n`;
            }
        }

        message += `\n当前离线任务状态:\n`;
        message += `总计: ${stats.total} 个\n`;
        message += `运行中: ${stats.running} 个\n`;
        message += `已完成: ${stats.completed} 个\n`;
        message += `失败: ${stats.failed} 个`;

        return message;
    }

    // 显示秒离线确认对话框
    function showInstantOfflineConfirmDialog(resourceName, taskId) {
        return new Promise((resolve) => {
            const modal = createModal(
                '秒离线失败',
                `资源 "${resourceName}" 未能秒离线成功，是否取消该任务？\n\n取消后任务将从离线列表中移除。`,
                'warning'
            );

            // 修改按钮
            const buttonContainer = modal.querySelector('.modal-content > div:last-child');
            buttonContainer.innerHTML = '';

            const cancelBtn = document.createElement('button');
            cancelBtn.textContent = '取消任务';
            cancelBtn.style.cssText = 'padding: 8px 24px; border: none; border-radius: 4px; font-size: 14px; cursor: pointer; background: #dc3545; color: white; margin-right: 12px;';
            cancelBtn.addEventListener('click', () => {
                modal.closeSht();
                resolve(true); // 取消任务
            });

            const keepBtn = document.createElement('button');
            keepBtn.textContent = '保留任务';
            keepBtn.style.cssText = 'padding: 8px 24px; border: none; border-radius: 4px; font-size: 14px; cursor: pointer; background: #28a745; color: white;';
            keepBtn.addEventListener('click', () => {
                modal.closeSht();
                resolve(false); // 保留任务
            });

            buttonContainer.appendChild(cancelBtn);
            buttonContainer.appendChild(keepBtn);
        });
    }

    // 计算 torrent 文件的 infohash
    async function calculateInfohash(torrentBlob) {
        try {
            // 将 Blob 转换为 ArrayBuffer
            const arrayBuffer = await torrentBlob.arrayBuffer();
            const uint8Array = new Uint8Array(arrayBuffer);

            // 简化的 bencode 解析器
            function bdecode(data, i = 0) {
                if (data[i] === 105) { // 'i'
                    let j = i + 1;
                    while (data[j] !== 101) j++; // 找到 'e'
                    return [parseInt(String.fromCharCode(...data.slice(i + 1, j))), j + 1];
                }
                if (data[i] === 108) { // 'l'
                    i++;
                    const out = [];
                    while (data[i] !== 101) { // 不是 'e'
                        const [v, newI] = bdecode(data, i);
                        out.push(v);
                        i = newI;
                    }
                    return [out, i + 1];
                }
                if (data[i] === 100) { // 'd'
                    i++;
                    const d = {};
                    while (data[i] !== 101) { // 不是 'e'
                        const [k, newI] = bdecode(data, i);
                        const [v, newI2] = bdecode(data, newI);
                        d[k] = v;
                        i = newI2;
                    }
                    return [d, i + 1];
                }
                // 字符串
                let j = i;
                while (data[j] !== 58) j++; // 找到 ':'
                const length = parseInt(String.fromCharCode(...data.slice(i, j)));
                const start = j + 1;
                const end = start + length;
                return [data.slice(start, end), end];
            }

            // 简化的 bencode 编码器
            function bencode(obj) {
                if (typeof obj === 'number') {
                    return new Uint8Array([...'i'.split('').map(c => c.charCodeAt(0)), ...obj.toString().split('').map(c => c.charCodeAt(0)), ...'e'.split('').map(c => c.charCodeAt(0))]);
                }
                if (obj instanceof Uint8Array) {
                    const length = obj.length.toString();
                    return new Uint8Array([...length.split('').map(c => c.charCodeAt(0)), 58, ...obj]);
                }
                if (Array.isArray(obj)) {
                    const result = [108]; // 'l'
                    for (const item of obj) {
                        result.push(...bencode(item));
                    }
                    result.push(101); // 'e'
                    return new Uint8Array(result);
                }
                if (typeof obj === 'object' && obj !== null) {
                    const result = [100]; // 'd'
                    const keys = Object.keys(obj).sort();
                    for (const key of keys) {
                        const keyBytes = new Uint8Array(key.split('').map(c => c.charCodeAt(0)));
                        result.push(...bencode(keyBytes));
                        result.push(...bencode(obj[key]));
                    }
                    result.push(101); // 'e'
                    return new Uint8Array(result);
                }
                return new Uint8Array();
            }

            // 解析 torrent 文件
            const [torrent, _] = bdecode(uint8Array, 0);
            if (!torrent || !torrent.info) {
                throw new Error('无效的 torrent 文件');
            }

            // 编码 info 部分
            const infoEncoded = bencode(torrent.info);

            // 计算 SHA1 哈希
            const hashBuffer = await crypto.subtle.digest('SHA-1', infoEncoded);
            const hashArray = new Uint8Array(hashBuffer);

            // 转换为十六进制字符串
            const hashHex = Array.from(hashArray)
                .map(b => b.toString(16).padStart(2, '0'))
                .join('');

            console.log('计算得到 infohash:', hashHex);
            return hashHex;

        } catch (error) {
            console.error('计算 infohash 失败:', error);
            // 如果计算失败，尝试从磁力链接中提取
            throw new Error(`计算 infohash 失败: ${error.message}`);
        }
    }

    // 创建批量发送进度显示
    function createBatchProgressModal(totalTasks) {
        // 移除已存在的进度modal
        const existingModal = document.querySelector('#sht-batch-progress-modal');
        if (existingModal) {
            existingModal.remove();
        }

        const modal = document.createElement('div');
        modal.id = 'sht-batch-progress-modal';
        modal.style.cssText = `
  position: fixed;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  background: rgba(0, 0, 0, 0.7);
  display: flex;
  justify-content: center;
  align-items: center;
  z-index: 10001;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
`;

        const modalContent = document.createElement('div');
        modalContent.style.cssText = `
  background: white;
  border-radius: 8px;
  padding: 24px;
  max-width: 500px;
  width: 90%;
  box-shadow: 0 10px 25px rgba(0, 0, 0, 0.3);
  text-align: center;
  position: relative;
`;

        // 标题
        const titleEl = document.createElement('h3');
        titleEl.textContent = '批量发送到123Pan';
        titleEl.style.cssText = `
  margin: 0 0 20px 0;
  font-size: 18px;
  font-weight: 600;
  color: #333;
`;

        // 进度信息
        const progressInfo = document.createElement('div');
        progressInfo.style.cssText = `
  margin: 0 0 20px 0;
  font-size: 14px;
  color: #666;
`;
        progressInfo.innerHTML = `
  <div>总计: <strong>${totalTasks}</strong> 个任务</div>
  <div>当前: <strong id="current-task">0</strong> / ${totalTasks}</div>
  <div>成功: <strong id="success-count" style="color: #28a745;">0</strong> 个</div>
  <div>失败: <strong id="fail-count" style="color: #dc3545;">0</strong> 个</div>
`;

        // 进度条
        const progressBarContainer = document.createElement('div');
        progressBarContainer.style.cssText = `
  width: 100%;
  height: 8px;
  background: #e9ecef;
  border-radius: 4px;
  overflow: hidden;
  margin: 0 0 20px 0;
`;

        const progressBar = document.createElement('div');
        progressBar.id = 'batch-progress-bar';
        progressBar.style.cssText = `
  height: 100%;
  background: linear-gradient(90deg, #007bff, #28a745);
  width: 0%;
  transition: width 0.3s ease;
`;
        progressBarContainer.appendChild(progressBar);

        // 当前任务状态
        const currentStatus = document.createElement('div');
        currentStatus.id = 'current-status';
        currentStatus.style.cssText = `
  font-size: 12px;
  color: #666;
  margin: 0 0 10px 0;
  min-height: 16px;
`;

        // 取消按钮
        const cancelBtn = document.createElement('button');
        cancelBtn.textContent = '取消批量发送';
        cancelBtn.style.cssText = `
  padding: 8px 16px;
  border: 1px solid #dc3545;
  border-radius: 4px;
  background: white;
  color: #dc3545;
  font-size: 14px;
  cursor: pointer;
  transition: all 0.2s;
`;

        cancelBtn.addEventListener('mouseenter', () => {
            cancelBtn.style.background = '#dc3545';
            cancelBtn.style.color = 'white';
        });
        cancelBtn.addEventListener('mouseleave', () => {
            cancelBtn.style.background = 'white';
            cancelBtn.style.color = '#dc3545';
        });

        modalContent.appendChild(titleEl);
        modalContent.appendChild(progressInfo);
        modalContent.appendChild(progressBarContainer);
        modalContent.appendChild(currentStatus);
        modalContent.appendChild(cancelBtn);
        modal.appendChild(modalContent);
        document.body.appendChild(modal);

        return {
            modal,
            updateProgress: (current, success, fail, status) => {
                document.getElementById('current-task').textContent = current;
                document.getElementById('success-count').textContent = success;
                document.getElementById('fail-count').textContent = fail;
                document.getElementById('current-status').textContent = status || '';
                const percentage = (current / totalTasks) * 100;
                document.getElementById('batch-progress-bar').style.width = `${percentage}%`;
            },
            close: () => modal.remove(),
            setCancelHandler: (handler) => {
                cancelBtn.addEventListener('click', handler);
            }
        };
    }

    // 显示批量发送结果（可滚动文本块）
    function showBatchResultModal(results, successCount, failCount, totalTasks) {
        // 移除已存在的modal
        const existingModal = document.querySelector('#sht-modal');
        if (existingModal) {
            existingModal.remove();
        }

        const modal = document.createElement('div');
        modal.id = 'sht-modal';
        modal.style.cssText = `
  position: fixed;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  justify-content: center;
  align-items: center;
  z-index: 10000;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
`;

        const modalContent = document.createElement('div');
        modalContent.style.cssText = `
  background: white;
  border-radius: 8px;
  padding: 24px;
  max-width: 600px;
  width: 90%;
  max-height: 80vh;
  box-shadow: 0 10px 25px rgba(0, 0, 0, 0.2);
  text-align: center;
  position: relative;
  display: flex;
  flex-direction: column;
`;

        // 标题
        const titleEl = document.createElement('h3');
        titleEl.textContent = '批量发送结果';
        titleEl.style.cssText = `
  margin: 0 0 16px 0;
  font-size: 18px;
  font-weight: 600;
  color: #333;
`;

        // 统计信息
        const statsEl = document.createElement('div');
        statsEl.style.cssText = `
  margin: 0 0 16px 0;
  font-size: 14px;
  color: #666;
  display: flex;
  justify-content: space-around;
  flex-wrap: wrap;
  gap: 10px;
`;
        statsEl.innerHTML = `
  <div>总计: <strong>${totalTasks}</strong> 个</div>
  <div style="color: #28a745;">成功: <strong>${successCount}</strong> 个</div>
  <div style="color: #dc3545;">失败: <strong>${failCount}</strong> 个</div>
`;

        // 可滚动的结果内容
        const scrollContainer = document.createElement('div');
        scrollContainer.style.cssText = `
  flex: 1;
  overflow-y: auto;
  border: 1px solid #e9ecef;
  border-radius: 4px;
  padding: 12px;
  margin: 0 0 20px 0;
  text-align: left;
  font-family: 'Courier New', monospace;
  font-size: 12px;
  line-height: 1.4;
  background: #f8f9fa;
  max-height: 400px;
`;

        // 使用 DOM 节点渲染远端任务信息，避免标题或错误文本被解释为 HTML。
        const appendDetail = (parent, icon, label, value) => {
            const line = document.createElement('div');
            line.style.cssText = 'display:flex;align-items:flex-start;gap:5px;';
            setIconLabel(line, icon, `${label}: ${value}`, 14);
            parent.appendChild(line);
        };

        const appendSection = (items, success) => {
            if (!items.length) return;

            const color = success ? '#28a745' : '#dc3545';
            const sectionTitle = document.createElement('div');
            sectionTitle.style.cssText = `display:flex;align-items:center;gap:6px;color:${color};font-weight:bold;margin:${success ? '0' : '20px'} 0 10px;`;
            setIconLabel(sectionTitle, success ? 'checkCircle' : 'errorCircle', `${success ? '成功' : '失败'}任务 (${items.length} 个)`);
            scrollContainer.appendChild(sectionTitle);

            const divider = document.createElement('div');
            divider.style.cssText = `border-bottom:2px solid ${color};margin-bottom:15px;`;
            scrollContainer.appendChild(divider);

            items.forEach((result, index) => {
                const item = document.createElement('div');
                item.style.cssText = `margin-bottom:12px;padding:8px;background:${success ? '#f8fff9' : '#fff5f5'};border-left:3px solid ${color};border-radius:4px;`;

                const itemTitle = document.createElement('div');
                itemTitle.style.cssText = `display:flex;align-items:flex-start;gap:6px;color:${color};font-weight:bold;`;
                setIconLabel(itemTitle, success ? 'checkCircle' : 'errorCircle', `${index + 1}. ${result.title || '未命名任务'}`, 14);
                item.appendChild(itemTitle);

                const details = document.createElement('div');
                details.style.cssText = 'margin-left:20px;color:#666;font-size:12px;';
                if (success && result.result) {
                    appendDetail(details, 'folder', '文件数', `${result.result.fileCount ?? 0} 个`);
                    appendDetail(details, 'chart', '状态', result.result.isInstantOffline ? '秒离线成功' : '正在下载');
                    if (result.result.actionTaken) {
                        appendDetail(details, 'wrench', '处理', result.result.actionTaken);
                    }
                } else if (!success) {
                    appendDetail(details, 'warning', '错误', result.error || '未知错误');
                }
                if (details.childNodes.length) item.appendChild(details);
                scrollContainer.appendChild(item);
            });
        };

        appendSection(results.filter(result => result.success), true);
        appendSection(results.filter(result => !result.success), false);

        // 按钮容器
        const buttonContainer = document.createElement('div');
        buttonContainer.style.cssText = `
  display: flex;
  gap: 12px;
  justify-content: center;
`;

        // 确定按钮
        const confirmBtn = document.createElement('button');
        confirmBtn.textContent = '确定';
        confirmBtn.style.cssText = `
  padding: 8px 24px;
  border: none;
  border-radius: 4px;
  font-size: 14px;
  cursor: pointer;
  transition: background-color 0.2s;
  background: #007bff;
  color: white;
`;

        confirmBtn.addEventListener('mouseenter', () => {
            confirmBtn.style.opacity = '0.9';
        });
        confirmBtn.addEventListener('mouseleave', () => {
            confirmBtn.style.opacity = '1';
        });

        // 关闭modal
        const closeModal = () => {
            modal.remove();
        };

        confirmBtn.addEventListener('click', closeModal);
        modal.addEventListener('click', (e) => {
            if (e.target === modal) {
                closeModal();
            }
        });

        // ESC键关闭
        const handleKeyDown = (e) => {
            if (e.key === 'Escape') {
                closeModal();
                document.removeEventListener('keydown', handleKeyDown);
            }
        };
        document.addEventListener('keydown', handleKeyDown);

        buttonContainer.appendChild(confirmBtn);
        modalContent.appendChild(titleEl);
        modalContent.appendChild(statsEl);
        modalContent.appendChild(scrollContainer);
        modalContent.appendChild(buttonContainer);
        modal.appendChild(modalContent);
        document.body.appendChild(modal);

        // 聚焦到确定按钮
        confirmBtn.focus();

        return modal;
    }

    // 批量处理磁力链接离线下载
    let nextPan123TaskStartAt = 0;
    async function waitForPan123TaskSlot(intervalMs, signal) {
        const now = Date.now();
        const scheduledAt = Math.max(now, nextPan123TaskStartAt);
        nextPan123TaskStartAt = scheduledAt + Math.max(0, intervalMs);
        if (scheduledAt > now) await waitWithSignal(scheduledAt - now, signal);
    }

    async function processBatchMagnetOffline(magnetUrls) {
        if (!CFG.pan123Enabled) {
            showWarningModal('请先在设置中启用 123Pan 功能并配置认证信息');
            return;
        }

        const results = new Array(magnetUrls.length);
        let successCount = 0;
        let failCount = 0;
        let completedCount = 0;
        const totalTasks = magnetUrls.length;
        const intervalMs = CFG.pan123BatchSendInterval || 2000;
        const progressModal = createBatchProgressModal(totalTasks);
        const controller = new AbortController();
        progressModal.setCancelHandler(() => {
            controller.abort();
            showToast('正在取消未开始及进行中的 123Pan 任务', 'warning');
        });

        try {
            const tasks = magnetUrls.map((magnetUrl, index) => queueCloudProviderTask('pan123', async ({ signal }) => {
                await waitForPan123TaskSlot(intervalMs, signal);
                progressModal.updateProgress(completedCount, successCount, failCount, `正在处理第 ${index + 1} 个任务`);
                return processSingleMagnetOffline(magnetUrl, magnetUrl, { signal });
            }, {
                label: `123Pan ${index + 1}/${totalTasks}`,
                retries: 0,
                signal: controller.signal
            }).then(result => {
                successCount += 1;
                completedCount += 1;
                results[index] = { title: result.taskName || magnetUrl, success: true, result };
                progressModal.updateProgress(completedCount, successCount, failCount, `已完成: ${result.taskName || `任务 ${index + 1}`}`);
            }).catch(error => {
                completedCount += 1;
                failCount += 1;
                results[index] = {
                    title: magnetUrl,
                    success: false,
                    cancelled: error?.name === 'AbortError',
                    error: describeRequestError(error)
                };
                progressModal.updateProgress(completedCount, successCount, failCount, error?.name === 'AbortError' ? '任务已取消' : `任务失败: ${describeRequestError(error)}`);
            }));
            await Promise.all(tasks);
        } finally {
            progressModal.close();
        }

        const completedResults = results.filter(Boolean);
        showBatchResultModal(completedResults, successCount, failCount, totalTasks);
        return completedResults;
    }

    // 处理单个磁力链接离线下载（不显示Modal）
    async function processSingleMagnetOffline(magnetUrl, title, options = {}) {
        if (!CFG.pan123Enabled) {
            throw new Error('123Pan 功能未启用');
        }

        try {
            console.log('开始处理磁力链接离线下载:', title);

            // 1. 通过磁力链接解析任务
            console.log('解析磁力链接...');
            const resolveResult = await apiResolveMagnet(magnetUrl, options);
            console.log('解析结果:', resolveResult);

            if (resolveResult.code !== 0) {
                throw new Error(`解析磁力链接失败: ${resolveResult.message}`);
            }

            const resourceList = resolveResult.data?.list || [];
            if (resourceList.length === 0) {
                throw new Error('没有找到可用的资源');
            }

            const item = resourceList[0];
            const resourceId = parseInt(item.id || item.resource_id || 0);
            const files = item.files || [];

            // 从API响应中获取真实文件名
            const realTitle = item.name || title;

            // 2. 选择文件
            console.log('选择文件...');
            const selectedFileIds = selectFiles(files);
            if (selectedFileIds.length === 0) {
                throw new Error('没有文件满足过滤条件');
            }

            // 3. 提交离线任务
            console.log('提交离线任务...');
            const submitResult = await apiSubmit(resourceId, selectedFileIds, options);
            if (submitResult.code !== 0 || submitResult.message !== 'ok') {
                throw new Error(`提交失败: ${submitResult.message}`);
            }

            console.log('离线任务提交成功:', submitResult);

            // 4. 等待并检查秒离线状态
            console.log('等待秒离线检查...');
            await waitWithSignal(CFG.pan123InstantOfflineCheckDelay, options.signal);

            const taskName = item.name;
            const offlineTask = await checkTaskInOfflineList(taskName, options);
            const isInstantOffline = !offlineTask;
            let actionTaken = '';

            if (offlineTask) {
                console.log('未秒离线成功，任务仍在离线列表中:', taskName);

                // 根据配置处理秒离线失败
                if (CFG.pan123InstantOfflineAction === 'auto_cancel') {
                    console.log('自动取消任务:', taskName);
                    await apiCancelOfflineTask(offlineTask.task_id, options);
                    actionTaken = '已自动取消任务';
                } else if (CFG.pan123InstantOfflineAction === 'ask_user') {
                    // 批量模式下跳过用户询问，直接保留任务
                    console.log('批量模式：保留任务:', taskName);
                    actionTaken = '保留任务继续下载';
                } else {
                    console.log('保留任务:', taskName);
                    actionTaken = '保留任务继续下载';
                }
            } else {
                console.log('秒离线成功:', taskName);
            }

            return {
                taskName: realTitle || taskName,
                fileCount: selectedFileIds.length,
                isInstantOffline,
                actionTaken
            };

        } catch (error) {
            console.error('处理磁力链接离线下载失败:', error);
            throw error;
        }
    }

    // 处理磁力链接离线下载（保持原有接口，用于单个发送）
    async function processMagnetOffline(magnetUrl, title) {
        if (!CFG.pan123Enabled) {
            showToast('请先在设置中启用 123Pan 功能并配置认证信息', 'warning');
            return;
        }

        try {
            console.log('开始处理磁力链接离线下载:', title);

            // 1. 通过磁力链接解析任务
            console.log('解析磁力链接...');
            const resolveResult = await apiResolveMagnet(magnetUrl);
            console.log('解析结果:', resolveResult);

            if (resolveResult.code !== 0) {
                throw new Error(`解析磁力链接失败: ${resolveResult.message}`);
            }

            const resourceList = resolveResult.data?.list || [];
            if (resourceList.length === 0) {
                throw new Error('没有找到可用的资源');
            }

            const item = resourceList[0];
            const resourceId = parseInt(item.id || item.resource_id || 0);
            const files = item.files || [];

            // 2. 选择文件
            console.log('选择文件...');
            const selectedFileIds = selectFiles(files);
            if (selectedFileIds.length === 0) {
                throw new Error('没有文件满足过滤条件');
            }

            // 3. 提交离线任务
            console.log('提交离线任务...');
            const submitResult = await apiSubmit(resourceId, selectedFileIds);
            if (submitResult.code !== 0 || submitResult.message !== 'ok') {
                throw new Error(`提交失败: ${submitResult.message}`);
            }

            console.log('离线任务提交成功:', submitResult);

            // 4. 检查秒离线
            setTimeout(async () => {
                try {
                    const taskName = item.name;
                    const offlineTask = await checkTaskInOfflineList(taskName);
                    const isInstantOffline = !offlineTask;
                    let actionTaken = '';

                    if (offlineTask) {
                        console.log('未秒离线成功，任务仍在离线列表中:', taskName);

                        // 根据配置处理秒离线失败
                        if (CFG.pan123InstantOfflineAction === 'auto_cancel') {
                            console.log('自动取消任务:', taskName);
                            await apiCancelOfflineTask(offlineTask.task_id);
                            actionTaken = '已自动取消任务';
                        } else if (CFG.pan123InstantOfflineAction === 'ask_user') {
                            const shouldCancel = await showInstantOfflineConfirmDialog(taskName, offlineTask.task_id);
                            if (shouldCancel) {
                                console.log('用户选择取消任务:', taskName);
                                await apiCancelOfflineTask(offlineTask.task_id);
                                actionTaken = '用户选择取消任务';
                            } else {
                                console.log('用户选择保留任务:', taskName);
                                actionTaken = '用户选择保留任务';
                            }
                        } else {
                            console.log('保留任务:', taskName);
                            actionTaken = '保留任务继续下载';
                        }
                    } else {
                        console.log('秒离线成功:', taskName);
                    }

                    // 显示详细的结果信息
                    const message = await handleInstantOfflineResult(taskName, selectedFileIds, isInstantOffline, actionTaken);
                    showSuccessModal(message);

                } catch (error) {
                    console.error('检查秒离线状态失败:', error);
                    showErrorModal(`检查秒离线状态失败: ${error.message}`);
                }
            }, CFG.pan123InstantOfflineCheckDelay);

        } catch (error) {
            console.error('处理磁力链接离线下载失败:', error);
            showErrorModal(`离线下载失败: ${error.message}`);
        }
    }

    // 为torrent文件添加123Pan按钮
    function addTorrent123PanButton(bar, filename, torrentUrl) {
        // 检查是否已经添加过按钮
        if (bar.querySelector('.sht-torrent-123pan-btn')) return;

        const btn123Pan = document.createElement('button');
        btn123Pan.textContent = '发送到123Pan';
        btn123Pan.className = 'sht-torrent-123pan-btn';
        btn123Pan.style.cssText = 'padding:2px 8px;cursor:pointer;background:#007cba;color:white;border:none;border-radius:3px';

        btn123Pan.addEventListener('click', async () => {
            await sendTorrentAttachmentToPan123(btn123Pan, torrentUrl, filename.replace(/\.torrent$/i, ''));
        });

        bar.appendChild(btn123Pan);
    }

    // 处理torrent文件离线下载
    async function processTorrentOffline(torrentBlob, title, options = {}) {
        if (!CFG.pan123Enabled) {
            showToast('请先在设置中启用 123Pan 功能并配置认证信息', 'warning');
            return;
        }

        try {
            console.log('开始处理torrent文件离线下载:', title);

            // 1. 上传 torrent 到 123Pan
            console.log('上传 torrent 文件...');
            const uploadResult = await apiUploadTorrent(torrentBlob, `${title}.torrent`, options);
            console.log('上传结果:', uploadResult);

            if (uploadResult.code !== 0) {
                throw new Error(`上传 torrent 失败: ${uploadResult.message}`);
            }

            const infohash = uploadResult.data.info_hash;
            console.log('上传成功，infohash:', infohash);

            // 2. 解析文件列表
            console.log('解析文件列表...');
            const resolveResult = await apiResolve(infohash, options);
            console.log('解析结果:', resolveResult);

            if (resolveResult.code !== 0) {
                throw new Error(`解析文件列表失败: ${resolveResult.message}`);
            }

            const resourceList = resolveResult.data?.list || [];
            if (resourceList.length === 0) {
                throw new Error('没有找到可用的资源');
            }

            const resource = resourceList[0];
            const resourceId = parseInt(resource.id || resource.resource_id || 0);
            const files = resource.files || [];

            // 3. 文件过滤和选择
            console.log('选择文件...');
            const selectedFileIds = selectFiles(files);
            console.log('选择的文件:', selectedFileIds);

            if (selectedFileIds.length === 0) {
                throw new Error('没有文件满足过滤条件');
            }

            // 4. 提交离线任务
            console.log('提交离线任务...');
            const submitResult = await apiSubmit(resourceId, selectedFileIds, options);
            console.log('提交结果:', submitResult);

            if (submitResult.code !== 0) {
                throw new Error(`提交离线任务失败: ${submitResult.message}`);
            }

            // 5. 检查任务状态（延迟检查）
            setTimeout(async () => {
                try {
                    const taskName = resource.name || title;
                    const offlineTask = await checkTaskInOfflineList(taskName);
                    const isInstantOffline = !offlineTask;
                    let actionTaken = '';

                    if (offlineTask) {
                        console.log('未秒离线成功，任务仍在离线列表中:', taskName);

                        // 根据配置处理秒离线失败
                        if (CFG.pan123InstantOfflineAction === 'auto_cancel') {
                            console.log('自动取消任务:', taskName);
                            await apiCancelOfflineTask(offlineTask.task_id);
                            actionTaken = '已自动取消任务';
                        } else if (CFG.pan123InstantOfflineAction === 'ask_user') {
                            const shouldCancel = await showInstantOfflineConfirmDialog(taskName, offlineTask.task_id);
                            if (shouldCancel) {
                                console.log('用户选择取消任务:', taskName);
                                await apiCancelOfflineTask(offlineTask.task_id);
                                actionTaken = '用户选择取消任务';
                            } else {
                                console.log('用户选择保留任务:', taskName);
                                actionTaken = '用户选择保留任务';
                            }
                        } else {
                            console.log('保留任务:', taskName);
                            actionTaken = '保留任务继续下载';
                        }
                    } else {
                        console.log('秒离线成功:', taskName);
                    }

                    // 显示详细的结果信息
                    const message = await handleInstantOfflineResult(taskName, selectedFileIds, isInstantOffline, actionTaken);
                    showSuccessModal(message);

                } catch (error) {
                    console.error('检查任务状态失败:', error);
                    showErrorModal(`检查任务状态失败: ${error.message}`);
                }
            }, CFG.pan123InstantOfflineCheckDelay);

        } catch (error) {
            console.error('处理torrent文件离线下载失败:', error);
            showErrorModal(`离线下载失败: ${error.message}`);
        }
    }

    // 显示磁力链接选择对话框
    function showMagnetSelectionDialog(magnetUrls) {
        // 创建对话框
        const dialog = document.createElement('div');
        dialog.style.cssText = `
    position: fixed; top: 0; left: 0; width: 100%; height: 100%;
    background: rgba(0,0,0,0.5); z-index: 10000; display: flex;
    align-items: center; justify-content: center; font-family: Arial, sans-serif;
  `;

        const panel = document.createElement('div');
        panel.style.cssText = `
    background: white; border-radius: 8px; padding: 20px; max-width: 600px;
    max-height: 80vh; overflow: hidden; box-shadow: 0 4px 20px rgba(0,0,0,0.3);
  `;

        const title = document.createElement('h3');
        title.textContent = '选择要发送到123Pan的磁力链接';
        title.style.cssText = 'margin: 0 0 15px 0; color: #333;';

        const listContainer = document.createElement('div');
        listContainer.style.cssText = 'max-height: 400px; overflow-y: auto; border: 1px solid #ddd; border-radius: 4px;';

        const magnetList = document.createElement('div');
        magnetList.style.cssText = 'padding: 10px;';

        // 创建每个磁力链接的选项
        magnetUrls.forEach((magnetUrl, index) => {
            const item = document.createElement('div');
            item.style.cssText = 'display: flex; align-items: center; padding: 8px; border-bottom: 1px solid #eee;';

            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.checked = true; // 默认全选
            checkbox.style.marginRight = '10px';

            const label = document.createElement('label');
            label.style.cssText = 'flex: 1; font-size: 12px; word-break: break-all; cursor: pointer;';

            // 提取标题
            const titleMatch = magnetUrl.match(/dn=([^&]+)/);
            const title = titleMatch ? decodeURIComponent(titleMatch[1]) : `磁力链接 ${index + 1}`;
            label.textContent = title;

            const sendBtn = document.createElement('button');
            sendBtn.textContent = '发送';
            sendBtn.style.cssText = 'padding: 4px 8px; background: #007cba; color: white; border: none; border-radius: 3px; cursor: pointer; margin-left: 8px;';
            sendBtn.addEventListener('click', async () => {
                if (!CFG.pan123Token || !CFG.pan123LoginUuid || !CFG.pan123Cookie) {
                    showToast('请先在设置中配置 123Pan 认证信息', 'warning');
                    return;
                }

                sendBtn.textContent = '发送中...';
                sendBtn.disabled = true;

                try {
                    await processMagnetOffline(magnetUrl, title);
                } catch (error) {
                    console.error('发送失败:', error);
                    showErrorModal(`发送失败: ${error.message}`);
                } finally {
                    sendBtn.textContent = '发送';
                    sendBtn.disabled = false;
                }
            });

            item.appendChild(checkbox);
            item.appendChild(label);
            item.appendChild(sendBtn);
            magnetList.appendChild(item);
        });

        listContainer.appendChild(magnetList);

        // 按钮区域
        const buttonArea = document.createElement('div');
        buttonArea.style.cssText = 'margin-top: 15px; display: flex; gap: 10px; justify-content: flex-end;';

        const selectAllBtn = document.createElement('button');
        selectAllBtn.textContent = '全选';
        selectAllBtn.style.cssText = 'padding: 6px 12px; border: 1px solid #ddd; background: #f5f5f5; border-radius: 4px; cursor: pointer;';
        selectAllBtn.addEventListener('click', () => {
            const checkboxes = magnetList.querySelectorAll('input[type="checkbox"]');
            checkboxes.forEach(cb => cb.checked = true);
        });

        const selectNoneBtn = document.createElement('button');
        selectNoneBtn.textContent = '全不选';
        selectNoneBtn.style.cssText = 'padding: 6px 12px; border: 1px solid #ddd; background: #f5f5f5; border-radius: 4px; cursor: pointer;';
        selectNoneBtn.addEventListener('click', () => {
            const checkboxes = magnetList.querySelectorAll('input[type="checkbox"]');
            checkboxes.forEach(cb => cb.checked = false);
        });

        const batchSendBtn = document.createElement('button');
        batchSendBtn.textContent = '批量发送选中';
        batchSendBtn.style.cssText = 'padding: 6px 12px; background: #007cba; color: white; border: none; border-radius: 4px; cursor: pointer;';
        batchSendBtn.addEventListener('click', async () => {
            if (!CFG.pan123Token || !CFG.pan123LoginUuid || !CFG.pan123Cookie) {
                showWarningModal('请先在设置中配置 123Pan 认证信息');
                return;
            }

            const checkboxes = magnetList.querySelectorAll('input[type="checkbox"]');
            const selectedUrls = [];
            checkboxes.forEach((cb, index) => {
                if (cb.checked) {
                    selectedUrls.push(magnetUrls[index]);
                }
            });

            if (selectedUrls.length === 0) {
                showWarningModal('请至少选择一个磁力链接');
                return;
            }

            batchSendBtn.textContent = '批量发送中...';
            batchSendBtn.disabled = true;

            try {
                await processBatchMagnetOffline(selectedUrls);
                dialog.remove();
            } catch (error) {
                console.error('批量发送失败:', error);
                showErrorModal(`批量发送失败: ${error.message}`);
            } finally {
                batchSendBtn.textContent = '批量发送选中';
                batchSendBtn.disabled = false;
            }
        });

        const cancelBtn = document.createElement('button');
        cancelBtn.textContent = '取消';
        cancelBtn.style.cssText = 'padding: 6px 12px; border: 1px solid #ddd; background: #f5f5f5; border-radius: 4px; cursor: pointer;';
        cancelBtn.addEventListener('click', () => dialog.remove());

        buttonArea.appendChild(selectAllBtn);
        buttonArea.appendChild(selectNoneBtn);
        buttonArea.appendChild(batchSendBtn);
        buttonArea.appendChild(cancelBtn);

        panel.appendChild(title);
        panel.appendChild(listContainer);
        panel.appendChild(buttonArea);
        dialog.appendChild(panel);
        document.body.appendChild(dialog);

        // 点击背景关闭
        dialog.addEventListener('click', (e) => {
            if (e.target === dialog) dialog.remove();
        });
    }

    // 创建浮动滚动按钮
    function createFloatingScrollButtons() {
        // 检查是否已经存在
        if (document.querySelector('#sht-floating-scroll-buttons')) return;

        const container = document.createElement('div');
        container.id = 'sht-floating-scroll-buttons';
        container.style.cssText = `
    position: fixed;
    right: 20px;
    top: 50%;
    transform: translateY(-50%);
    z-index: 9999;
    display: flex;
    flex-direction: column;
    gap: 8px;
    opacity: 0.8;
    transition: opacity 0.3s ease;
  `;

        // 去顶部按钮
        const topBtn = document.createElement('button');
        topBtn.type = 'button';
        topBtn.title = '去顶部';
        topBtn.setAttribute('aria-label', '去顶部');
        setIconLabel(topBtn, 'arrowUp', '', 20);
        topBtn.style.cssText = `
    width: 40px;
    height: 40px;
    border: none;
    border-radius: 50%;
    background: #007cba;
    color: white;
    font-size: 18px;
    font-weight: bold;
    cursor: pointer;
    box-shadow: 0 2px 8px rgba(0,0,0,0.2);
    transition: opacity 0.2s ease, transform 0.2s ease, box-shadow 0.2s ease;
    display: flex;
    align-items: center;
    justify-content: center;
  `;

        // 去底部按钮
        const bottomBtn = document.createElement('button');
        bottomBtn.type = 'button';
        bottomBtn.title = '去底部';
        bottomBtn.setAttribute('aria-label', '去底部');
        setIconLabel(bottomBtn, 'arrowDown', '', 20);
        bottomBtn.style.cssText = topBtn.style.cssText;

        // 悬停效果
        const addHoverEffect = (btn) => {
            btn.addEventListener('mouseenter', () => {
                btn.style.opacity = '1';
                btn.style.transform = 'scale(1.1)';
                container.style.opacity = '1';
            });
            btn.addEventListener('mouseleave', () => {
                btn.style.opacity = '0.8';
                btn.style.transform = 'scale(1)';
                container.style.opacity = '0.8';
            });
        };

        addHoverEffect(topBtn);
        addHoverEffect(bottomBtn);

        // 点击事件
        const scrollBehavior = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
        topBtn.addEventListener('click', () => {
            window.scrollTo({ top: 0, behavior: scrollBehavior });
        });

        bottomBtn.addEventListener('click', () => {
            window.scrollTo({
                top: document.body.scrollHeight,
                behavior: scrollBehavior
            });
        });

        container.appendChild(topBtn);
        container.appendChild(bottomBtn);
        document.body.appendChild(container);
    }

    // 滚动按钮只在内容较长的帖子、版块列表和搜索结果页显示，首页保持简洁。
    if (isThreadPage || isForumListPage || isSearchPage) {
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', createFloatingScrollButtons, { once: true });
        } else {
            createFloatingScrollButtons();
        }
    }

    // ===== 搜索增强功能模块 =====
    function initSearchEnhancement() {
        // 检查是否在搜索页面
        if (!isSearchPage) {
            return;
        }

        // 添加搜索增强样式
        GM_addStyle(`
    #sht-sorter-panel{position:fixed;top:50px;right:20px;z-index:9999;background:rgba(255,255,255,.95);border:1px solid #ccc;border-radius:8px;padding:10px;box-shadow:0 2px 10px rgba(0,0,0,.2);font-size:13px;width:200px;max-height:80vh;overflow-y:auto;overflow-x:hidden}
    #sht-sorter-panel.hidden{opacity:0;pointer-events:none}
    #sht-sorter-panel h4{margin:0 0 8px;text-align:center;font-weight:700;border-bottom:1px solid #eee;padding-bottom:5px;font-size:14px}
    #sht-sorter-panel .sht-button{display:flex;align-items:center;justify-content:flex-start;gap:6px;width:100%;padding:6px 10px;margin-bottom:4px;border:1px solid #ddd;background:#f7f7f7;border-radius:4px;text-align:left;font-size:12px;line-height:1.2;cursor:pointer}
    #sht-sorter-panel .sht-button:hover{background:#007bff;color:#fff;border-color:#007bff}
    #sht-sorter-panel .sht-button.active{background:#28a745;color:#fff;border-color:#28a745}
    #sht-sorter-panel .sht-button.filtered{background:#ffc107;color:#000;border-color:#ffc107}
    #sht-sorter-close-btn{position:absolute;top:5px;right:8px;width:28px;height:28px;padding:0;border:0;background:transparent;cursor:pointer;color:#777}
    #sht-sorter-opener{position:fixed;top:50px;right:20px;z-index:9998;width:40px;height:40px;background:rgba(255,255,255,.95);border:1px solid #ccc;border-radius:50%;display:none;align-items:center;justify-content:center;color:#333;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.15)}
    #sht-sorter-panel button:focus-visible,#sht-sorter-opener:focus-visible{outline:2px solid #005fcc;outline-offset:2px}
    .sht-hot-thread{background:#fff8e1 !important;border-left:4px solid #ffc107}
    .sht-qbadge{display:inline-block;margin-left:6px;padding:0 6px;border-radius:10px;background:#eef3ff;border:1px solid #c8d4ff;color:#3d4ba3;font-size:12px;vertical-align:baseline}
    .sht-config-status{font-size:10px;color:#666;margin-top:6px;padding:3px;background:#f8f9fa;border-radius:3px;text-align:center}
    .sht-section-title{margin:6px 0 4px;font-size:11px;font-weight:bold;color:#333;text-align:center;background:#f0f0f0;padding:2px 4px;border-radius:3px}
    .sht-scroll-container{max-height:60vh;overflow-y:auto;overflow-x:hidden}
    .sht-select-row{display:flex;align-items:center;justify-content:space-between;gap:8px;margin:0 0 4px;padding:4px 6px;color:#555;font-size:12px}
    .sht-select-row select{min-width:88px;padding:3px 4px;border:1px solid #ccc;border-radius:4px;background:#fff;color:#333;font:inherit}
    .sht-select-row select:focus-visible{outline:2px solid #005fcc;outline-offset:2px}
    @media (max-width:600px){#sht-sorter-panel{top:12px;right:12px;width:min(200px,calc(100vw - 48px));max-height:calc(100vh - 48px)}#sht-sorter-opener{top:12px;right:12px}}
  `);

        const toHalf = s => (s || '').replace(/[０-９]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFF10 + 0x30));
        const numNorm = s => toHalf(s).replace(/,/g, '');

        // 配置管理
        const CONFIG_KEY = SEARCH_CONFIG_KEY;
        const CONFIG_MIGRATION_KEY = 'sht_sorter_config_v3_migrated';
        const defaultConfig = {
            sortBy: null,
            sortDir: 'desc',
            secondarySort: null,
            secondaryDir: 'desc',
            onlyQuota: false,
            filterQiuPian: false,
            highlightEnabled: false,
            highlightThreshold: 'auto',
            lastUsed: 0
        };

        const createDefaultConfig = () => ({ ...defaultConfig });

        function parseStoredConfig(raw) {
            if (!raw) return null;
            if (typeof raw === 'object') return raw;
            if (typeof raw !== 'string') return null;
            return JSON.parse(raw);
        }

        function migrateLegacyConfig(config, hasSavedConfig) {
            if (GM_getValue(CONFIG_MIGRATION_KEY, false)) return config;

            try {
                const legacy = parseStoredConfig(localStorage.getItem(CONFIG_KEY));
                if (legacy) {
                    if (!hasSavedConfig) {
                        if (legacy.autoSizeQuotaSort) {
                            if (legacy.sizeQuotaSortType === 'both') {
                                config.sortBy = 'fileSize';
                                config.sortDir = 'desc';
                                config.secondarySort = 'quota';
                                config.secondaryDir = 'desc';
                            } else {
                                config.sortBy = legacy.sizeQuotaSortType === 'size' ? 'fileSize' : 'quota';
                                config.sortDir = 'desc';
                            }
                        } else if (legacy.autoSort) {
                            config.sortBy = ['replies', 'views', 'postDate'].includes(legacy.autoSortType)
                                ? legacy.autoSortType
                                : 'replies';
                            config.sortDir = legacy.autoSortOrder === 'asc' ? 'asc' : 'desc';
                        }
                        config.filterQiuPian = Boolean(legacy.filterQiuPian);
                    }

                    config.highlightEnabled = Boolean(legacy.autoHighlight);
                    if (['auto', 'high', 'medium', 'low'].includes(legacy.highlightThreshold)) {
                        config.highlightThreshold = legacy.highlightThreshold;
                    }
                    console.info('[SHT] 已迁移独立搜索排序脚本的配置。');
                }
            } catch (e) {
                console.warn('[SHT] 旧搜索配置迁移失败，将继续使用当前配置:', e);
            } finally {
                GM_setValue(CONFIG_MIGRATION_KEY, true);
            }

            return config;
        }

        function loadConfig() {
            try {
                const saved = GM_getValue(CONFIG_KEY);
                const parsedConfig = parseStoredConfig(saved);
                const config = { ...createDefaultConfig(), ...(parsedConfig || {}) };
                const beforeMigration = JSON.stringify(config);
                const migrated = migrateLegacyConfig(config, Boolean(parsedConfig));
                if (!parsedConfig || JSON.stringify(migrated) !== beforeMigration) {
                    saveConfig(migrated);
                }
                return migrated;
            } catch (e) {
                console.warn('[SHT] 配置加载失败，使用默认配置:', e);
                return migrateLegacyConfig(createDefaultConfig(), false);
            }
        }

        function saveConfig(config) {
            try {
                config.lastUsed = Date.now();
                GM_setValue(CONFIG_KEY, JSON.stringify(config));
                console.debug('[SHT] 配置已保存:', config);
            } catch (e) {
                console.warn('[SHT] 配置保存失败:', e);
            }
        }

        function resetConfig() {
            try {
                GM_deleteValue(CONFIG_KEY);
                console.info('[SHT] 配置已重置');
                return createDefaultConfig();
            } catch (e) {
                console.warn('[SHT] 配置重置失败:', e);
                return createDefaultConfig();
            }
        }

        function parseSizeMB(text) {
            if (!text) return 0;
            const s = numNorm(text);
            const spec = s.match(/【(?:影片)?容量】?[：:]\s*(\d+(?:\.\d+)?)\s*([TGM]B?|TB)/i);
            if (spec) {
                const v = parseFloat(spec[1]); const u = spec[2].toUpperCase();
                return u.startsWith('TB') ? v * 1024 * 1024 : (u.startsWith('GB') || u === 'G') ? v * 1024 : v;
            }
            const all = [...s.matchAll(/(\d+(?:\.\d+)?)\s*([TGM]B?|TB)/gi)];
            let max = 0;
            for (const m of all) {
                const v = parseFloat(m[1]); const u = (m[2] || '').toUpperCase();
                const mb = u.startsWith('TB') ? v * 1024 * 1024 : (u.startsWith('GB') || u === 'G') ? v * 1024 : v;
                if (mb > max) max = mb;
            }
            return max;
        }

        // 取"最后一个数字 + 配额/配額"
        function parseQuota(text) {
            if (!text) return 0;
            const s = numNorm(text);
            let last = 0, m;
            const re = /(\d+)\s*配[额額]/gi;
            while ((m = re.exec(s)) !== null) last = parseInt(m[1], 10);
            return last || 0;
        }

        function isQiuPian(li) {
            const cate = li.querySelector('p:last-of-type a.xi1');
            return (cate?.innerText || '').trim() === '求片问答悬赏区';
        }

        const setupSearchPanel = () => {
            if (document.querySelector('#sht-sorter-panel')) {
                console.warn('[SHT] 已检测到其他搜索排序面板，跳过重复初始化。');
                return;
            }
            const list = document.querySelector('#threadlist ul');
            if (!list) return;
            const lis = [...list.querySelectorAll('li.pbw')];
            if (!lis.length) return;

            // 加载配置
            let config = loadConfig();
            console.debug('[SHT] 加载配置:', config);

            const parsed = lis.map(li => {
                // 关键修复：搜索结果里 <a> 没有 .xst，用通用选择器
                const aEl = li.querySelector('h3 a[href]');      // 优先锚点
                const h3El = li.querySelector('h3');             // 退回 h3
                const titleText =
                    (aEl?.getAttribute('title') && aEl.getAttribute('title').trim()) ||
                    (aEl?.textContent && aEl.textContent.trim()) ||
                    (h3El?.innerText && h3El.innerText.trim()) ||
                    '';

                const xg1 = li.querySelector('p.xg1')?.innerText || '';
                const dateSpan = li.querySelector('p:last-of-type span:first-of-type');
                const replies = parseInt((xg1.match(/(\d+)\s*个回复/) || [0, 0])[1], 10) || 0;
                const views = parseInt((xg1.match(/-\s*(\d+)\s*次查看/) || [0, 0])[1], 10) || 0;

                // 内容区（容量常在这里）
                const contentPs = [...li.querySelectorAll('p')].filter(p => p !== li.querySelector('p.xg1') && p !== li.querySelector('p:last-of-type'));
                const contentText = contentPs.map(p => p.innerText || '').join('\n');

                const fileSize = parseSizeMB(contentText) || parseSizeMB(titleText);
                const quota = parseQuota(titleText); // 列表的"配额"基本都在标题
                const postDate = dateSpan ? new Date((dateSpan.innerText || '').replace(/-/g, '/')).getTime() : 0;

                // 标题后插配额徽标；没有配额时不显示无意义的“配额:0”
                if (quota > 0 && aEl && !aEl.parentElement.querySelector('.sht-qbadge')) {
                    const tag = document.createElement('span');
                    tag.className = 'sht-qbadge';
                    tag.textContent = `配额:${quota}`;
                    aEl.after(tag);
                }

                console.debug('[SHT] 解析：', { title: titleText.slice(0, 60), quota, fileSizeMB: fileSize, replies, views });
                return { element: li, title: titleText, replies, views, postDate, fileSize, quota, isQiuPian: isQiuPian(li) };
            });

            const originalOrder = parsed.map(t => t.element);

            // ===== UI =====
            const panel = document.createElement('div');
            panel.id = 'sht-sorter-panel';
            panel.innerHTML = `
      <h4>排序工具</h4>
      <button id="sht-sorter-close-btn" type="button" aria-label="关闭排序工具" title="关闭排序工具"></button>
      <div class="sht-scroll-container">
        <div class="sht-section-title">主要排序</div>
        <button type="button" class="sht-button" data-sort="quota" data-label="配额" data-dir="desc">配额</button>
        <button type="button" class="sht-button" data-sort="fileSize" data-label="文件大小" data-dir="desc">文件大小</button>
        <button type="button" class="sht-button" data-sort="replies" data-label="回复数" data-dir="desc">回复数</button>
        <button type="button" class="sht-button" data-sort="views" data-label="查看数" data-dir="desc">查看数</button>
        <button type="button" class="sht-button" data-sort="postDate" data-label="时间" data-dir="desc">时间</button>

        <div class="sht-section-title">次要排序</div>
        <button type="button" class="sht-button" data-secondary-sort="quota" data-label="配额" data-dir="desc">配额</button>
        <button type="button" class="sht-button" data-secondary-sort="fileSize" data-label="文件大小" data-dir="desc">文件大小</button>
        <button type="button" class="sht-button" data-secondary-sort="replies" data-label="回复数" data-dir="desc">回复数</button>
        <button type="button" class="sht-button" data-secondary-sort="views" data-label="查看数" data-dir="desc">查看数</button>
        <button type="button" class="sht-button" data-secondary-sort="postDate" data-label="时间" data-dir="desc">时间</button>
        <button type="button" class="sht-button" data-action="clear-secondary" style="background:#6c757d;color:#fff;border-color:#6c757d;font-size:11px;">清除次要</button>

        <div class="sht-section-title">过滤器</div>
        <button type="button" class="sht-button" data-action="only-quota">只显示含配额</button>
        <button type="button" class="sht-button" data-action="filter-qp">过滤求片区</button>

        <div class="sht-section-title">热门标记</div>
        <button type="button" class="sht-button" data-action="toggle-highlight" aria-pressed="false">高亮热门帖子</button>
        <label class="sht-select-row" for="sht-highlight-threshold">
          <span>高亮门槛</span>
          <select id="sht-highlight-threshold">
            <option value="auto">自动</option>
            <option value="high">高</option>
            <option value="medium">中</option>
            <option value="low">低</option>
          </select>
        </label>

        <button type="button" class="sht-button" data-action="restore">恢复默认</button>
        <button type="button" class="sht-button" data-action="reset-config" style="background:#dc3545;color:#fff;border-color:#dc3545;font-size:11px;">重置配置</button>
      </div>
      <div class="sht-config-status" id="sht-config-status" role="status" aria-live="polite">配置已记忆</div>
            `;
            panel.setAttribute('role', 'region');
            panel.setAttribute('aria-label', '搜索结果排序工具');
            document.body.appendChild(panel);
            const closePanelButton = panel.querySelector('#sht-sorter-close-btn');
            setIconLabel(closePanelButton, 'close', '', 18);

            const opener = document.createElement('button');
            opener.id = 'sht-sorter-opener';
            opener.type = 'button';
            opener.title = '打开排序工具';
            opener.setAttribute('aria-label', '打开排序工具');
            setIconLabel(opener, 'settings', '', 19);
            document.body.appendChild(opener);

            const reorder = arr => arr.forEach(t => list.appendChild(t.element));
            const updateSortButton = (button, direction) => {
                button.dataset.dir = direction;
                setIconLabel(button, direction === 'desc' ? 'arrowDown' : 'arrowUp', button.dataset.label);
                button.setAttribute('aria-label', `${button.dataset.label}，${direction === 'desc' ? '降序' : '升序'}`);
            };

            const highlightThresholdNames = {
                auto: '自动',
                high: '高',
                medium: '中',
                low: '低'
            };

            function updateHighlights() {
                parsed.forEach(t => t.element.classList.remove('sht-hot-thread'));
                if (!config.highlightEnabled || !parsed.length) return;

                const avgReplies = parsed.reduce((sum, t) => sum + t.replies, 0) / parsed.length;
                const avgViews = parsed.reduce((sum, t) => sum + t.views, 0) / parsed.length;
                let thresholdReplies;
                let thresholdViews;

                switch (config.highlightThreshold) {
                    case 'high':
                        thresholdReplies = Math.max(50, avgReplies * 3);
                        thresholdViews = Math.max(2000, avgViews * 2.5);
                        break;
                    case 'medium':
                        thresholdReplies = Math.max(20, avgReplies * 2);
                        thresholdViews = Math.max(1000, avgViews * 2);
                        break;
                    case 'low':
                        thresholdReplies = Math.max(5, avgReplies * 1.5);
                        thresholdViews = Math.max(200, avgViews * 1.5);
                        break;
                    default:
                        thresholdReplies = Math.max(10, avgReplies * 2);
                        thresholdViews = Math.max(500, avgViews * 1.5);
                        break;
                }

                parsed.forEach(t => {
                    if (t.replies > thresholdReplies || t.views > thresholdViews) {
                        t.element.classList.add('sht-hot-thread');
                    }
                });
            }

            // 更新按钮状态
            function updateButtonStates() {
                // 更新主要排序按钮状态
                panel.querySelectorAll('[data-sort]').forEach(btn => {
                    const sortKey = btn.dataset.sort;
                    const isActive = config.sortBy === sortKey;
                    btn.classList.toggle('active', isActive);
                    btn.setAttribute('aria-pressed', String(isActive));
                    updateSortButton(btn, isActive ? config.sortDir : 'desc');
                });

                // 更新次要排序按钮状态
                panel.querySelectorAll('[data-secondary-sort]').forEach(btn => {
                    const sortKey = btn.dataset.secondarySort;
                    const isActive = config.secondarySort === sortKey;
                    btn.classList.toggle('active', isActive);
                    btn.setAttribute('aria-pressed', String(isActive));
                    updateSortButton(btn, isActive ? config.secondaryDir : 'desc');
                });

                // 更新过滤器按钮状态
                const onlyQuotaButton = panel.querySelector('[data-action="only-quota"]');
                onlyQuotaButton.classList.toggle('filtered', config.onlyQuota);
                onlyQuotaButton.setAttribute('aria-pressed', String(config.onlyQuota));
                setIconLabel(onlyQuotaButton, 'filter', '只显示含配额');

                const filterQiuPianButton = panel.querySelector('[data-action="filter-qp"]');
                filterQiuPianButton.classList.toggle('filtered', config.filterQiuPian);
                filterQiuPianButton.setAttribute('aria-pressed', String(config.filterQiuPian));
                setIconLabel(filterQiuPianButton, 'filter', '过滤求片区');

                const highlightButton = panel.querySelector('[data-action="toggle-highlight"]');
                highlightButton.classList.toggle('filtered', config.highlightEnabled);
                highlightButton.setAttribute('aria-pressed', String(config.highlightEnabled));
                setIconLabel(highlightButton, 'eye', '高亮热门帖子');

                const thresholdSelect = panel.querySelector('#sht-highlight-threshold');
                thresholdSelect.value = config.highlightThreshold;

                setIconLabel(panel.querySelector('[data-action="clear-secondary"]'), 'close', '清除次要');
                setIconLabel(panel.querySelector('[data-action="restore"]'), 'refresh', '恢复默认');
                setIconLabel(panel.querySelector('[data-action="reset-config"]'), 'trash', '重置搜索配置');

                // 更新状态显示
                const statusEl = panel.querySelector('#sht-config-status');
                const statusText = [];
                if (config.sortBy) {
                    statusText.push(`主排序: ${config.sortBy}(${config.sortDir})`);
                }
                if (config.secondarySort) {
                    statusText.push(`次排序: ${config.secondarySort}(${config.secondaryDir})`);
                }
                if (config.onlyQuota) statusText.push('仅配额');
                if (config.filterQiuPian) statusText.push('过滤求片');
                if (config.highlightEnabled) statusText.push(`热门高亮(${highlightThresholdNames[config.highlightThreshold] || '自动'})`);
                statusEl.textContent = statusText.length ? statusText.join(', ') : '默认配置';
            }

            // 复合排序函数
            function multiSort(arr) {
                return arr.sort((a, b) => {
                    // 主要排序
                    if (config.sortBy) {
                        const aVal = a[config.sortBy] || 0;
                        const bVal = b[config.sortBy] || 0;
                        const primaryDiff = config.sortDir === 'desc' ? (bVal - aVal) : (aVal - bVal);
                        if (primaryDiff !== 0) return primaryDiff;
                    }

                    // 次要排序（只有在主要排序相等时才使用）
                    if (config.secondarySort) {
                        const aVal = a[config.secondarySort] || 0;
                        const bVal = b[config.secondarySort] || 0;
                        return config.secondaryDir === 'desc' ? (bVal - aVal) : (aVal - bVal);
                    }

                    return 0;
                });
            }

            // 应用配置
            function applyConfig() {
                // 应用排序
                if (config.sortBy || config.secondarySort) {
                    multiSort(parsed);
                    reorder(parsed);
                }

                // 应用过滤器
                parsed.forEach(t => {
                    // 重置显示状态
                    t.element.style.display = '';

                    // 应用配额过滤器
                    if (config.onlyQuota && t.quota <= 0) {
                        t.element.style.display = 'none';
                    }

                    // 应用求片区过滤器
                    if (config.filterQiuPian && t.isQiuPian) {
                        t.element.style.display = 'none';
                    }
                });

                updateHighlights();
                updateButtonStates();
            }

            // 初始化时应用配置
            applyConfig();

            panel.addEventListener('click', async (e) => {
                if (!(e.target instanceof Element)) return;
                const btn = e.target.closest('button');
                if (!(btn instanceof HTMLButtonElement) || !panel.contains(btn)) return;

                const sortKey = btn.dataset.sort;
                const secondarySortKey = btn.dataset.secondarySort;

                if (sortKey) {
                    const next = config.sortBy === sortKey && config.sortDir === 'desc' ? 'asc' : 'desc';

                    // 更新配置
                    config.sortBy = sortKey;
                    config.sortDir = next;
                    saveConfig(config);

                    console.debug(`[SHT] 主要排序前(${sortKey}):`, parsed.slice(0, 5).map(t => ({ title: t.title.slice(0, 30), [sortKey]: t[sortKey] })));
                    multiSort(parsed);
                    reorder(parsed);
                    console.debug(`[SHT] 主要排序后(${sortKey},${next}):`, parsed.slice(0, 5).map(t => ({ title: t.title.slice(0, 30), [sortKey]: t[sortKey] })));

                    updateButtonStates();
                    return;
                }

                if (secondarySortKey) {
                    const next = config.secondarySort === secondarySortKey && config.secondaryDir === 'desc' ? 'asc' : 'desc';

                    // 更新配置
                    config.secondarySort = secondarySortKey;
                    config.secondaryDir = next;
                    saveConfig(config);

                    console.debug(`[SHT] 次要排序前(${secondarySortKey}):`, parsed.slice(0, 5).map(t => ({ title: t.title.slice(0, 30), [secondarySortKey]: t[secondarySortKey] })));
                    multiSort(parsed);
                    reorder(parsed);
                    console.debug(`[SHT] 次要排序后(${secondarySortKey},${next}):`, parsed.slice(0, 5).map(t => ({ title: t.title.slice(0, 30), [secondarySortKey]: t[secondarySortKey] })));

                    updateButtonStates();
                    return;
                }

                const action = btn.dataset.action;
                if (action === 'restore') {
                    // 重置所有状态
                    config.sortBy = null;
                    config.sortDir = 'desc';
                    config.secondarySort = null;
                    config.secondaryDir = 'desc';
                    config.onlyQuota = false;
                    config.filterQiuPian = false;
                    config.highlightEnabled = false;
                    config.highlightThreshold = 'auto';
                    saveConfig(config);

                    originalOrder.forEach(el => list.appendChild(el));
                    applyConfig();
                } else if (action === 'clear-secondary') {
                    config.secondarySort = null;
                    config.secondaryDir = 'desc';
                    saveConfig(config);

                    // 重新排序（只使用主要排序）
                    if (config.sortBy) {
                        multiSort(parsed);
                        reorder(parsed);
                    } else {
                        originalOrder.forEach(el => list.appendChild(el));
                    }

                    applyConfig();
                } else if (action === 'only-quota') {
                    config.onlyQuota = !config.onlyQuota;
                    saveConfig(config);
                    applyConfig();
                } else if (action === 'filter-qp') {
                    config.filterQiuPian = !config.filterQiuPian;
                    saveConfig(config);
                    applyConfig();
                } else if (action === 'toggle-highlight') {
                    config.highlightEnabled = !config.highlightEnabled;
                    saveConfig(config);
                    applyConfig();
                } else if (action === 'reset-config') {
                    if (await confirmAction('这将清除排序、过滤和高亮设置。', {
                        title: '重置搜索配置', confirmText: '确认重置', danger: true
                    })) {
                        config = resetConfig();
                        // 重新应用默认状态
                        originalOrder.forEach(el => list.appendChild(el));
                        applyConfig();
                    }
                }
            });

            panel.querySelector('#sht-highlight-threshold').addEventListener('change', e => {
                const nextThreshold = e.target.value;
                if (!['auto', 'high', 'medium', 'low'].includes(nextThreshold)) return;
                config.highlightThreshold = nextThreshold;
                saveConfig(config);
                applyConfig();
            });

            closePanelButton.addEventListener('click', () => {
                panel.classList.add('hidden'); opener.style.display = 'flex';
                opener.focus();
            });
            opener.addEventListener('click', () => {
                panel.classList.remove('hidden'); opener.style.display = 'none';
                closePanelButton.focus();
            });

            const withQuota = parsed.filter(t => t.quota > 0).length;
            console.info(`[SHT] 总 ${parsed.length} 条，解析出"配额>0"的有 ${withQuota} 条。`);
        };

        if (document.readyState === 'complete') {
            setupSearchPanel();
        } else {
            window.addEventListener('load', setupSearchPanel, { once: true });
        }
    }

    // 初始化搜索增强功能
    initSearchEnhancement();

})();
