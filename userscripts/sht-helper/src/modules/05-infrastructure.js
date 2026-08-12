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
