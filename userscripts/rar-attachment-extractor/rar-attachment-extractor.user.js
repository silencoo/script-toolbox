// ==UserScript==
// @name         RAR 附件在线解压助手
// @namespace    https://tampermonkey-helper.local/
// @version      0.1.0
// @description  自动为网页中的 .rar 附件添加“解压预览”按钮，在浏览器内直接尝试解包（支持密码字典与手动输入），无需下载本地即可提取文件或文本内容。
// @author       you
// @match        *://*/*
// @grant        GM_xmlhttpRequest
// @grant        GM_registerMenuCommand
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_setClipboard
// @grant        GM_notification
// @connect      *
// @run-at       document-idle
// ==/UserScript==

(() => {
  'use strict';

  /** ----------- 配置 ----------- */
  const STORAGE_KEYS = {
    PASSWORDS: 'rar_helper_passwords',
    AUTO_PREVIEW: 'rar_helper_auto_preview'
  };
  const DEFAULT_PASSWORDS = [
    '',
    'password',
    '123456',
    'www.sehuatang.org',
    'sehuatang',
    'www.tjupt.org',
    'gaytorrent',
    'carpt.net'
  ];
  const MAX_AUTO_BYTES = 40 * 1024 * 1024; // 超出此大小默认不自动拉取
  const TEXT_EXTS = new Set(['txt', 'nfo', 'log', 'json', 'ini', 'xml', 'md', 'sfv', 'srt']);

  const getStoredPasswords = () => {
    const raw = (GM_getValue(STORAGE_KEYS.PASSWORDS, '') || '').trim();
    if (!raw) return [];
    return raw.split(/\s*[,\n]\s*/).map(p => p.trim()).filter(Boolean);
  };

  const AUTO_PREVIEW_ENABLED = !!GM_getValue(STORAGE_KEYS.AUTO_PREVIEW, false);

  const PASSWORD_CANDIDATES = (() => {
    const custom = getStoredPasswords();
    const deduped = new Set([...custom, ...DEFAULT_PASSWORDS]);
    return Array.from(deduped);
  })();

  const LIB_CACHE_KEY_JS = 'rar_helper_libunrar_js_cache_v1';
  const LIB_CACHE_KEY_WASM = 'rar_helper_libunrar_wasm_cache_v1';
  const LIB_CACHE_KEY_MEM = 'rar_helper_libunrar_mem_cache_v1';
  const LIB_CACHE_KEY_SOURCE = 'rar_helper_libunrar_source_v1';
  const LIB_SOURCES = [
    {
      name: 'master dist',
      js: 'https://raw.githubusercontent.com/wcchoi/libunrar-js/master/dist/libunrar.js',
      wasm: 'https://raw.githubusercontent.com/wcchoi/libunrar-js/master/dist/libunrar.wasm',
      mem: 'https://raw.githubusercontent.com/wcchoi/libunrar-js/master/dist/libunrar.js.mem'
    },
    {
      name: 'tag 0.8.0 dist',
      js: 'https://raw.githubusercontent.com/wcchoi/libunrar-js/0.8.0/dist/libunrar.js',
      wasm: 'https://raw.githubusercontent.com/wcchoi/libunrar-js/0.8.0/dist/libunrar.wasm',
      mem: 'https://raw.githubusercontent.com/wcchoi/libunrar-js/0.8.0/dist/libunrar.js.mem'
    },
    {
      name: 'github pages',
      js: 'https://wcchoi.github.io/libunrar-js/libunrar.js',
      wasm: 'https://wcchoi.github.io/libunrar-js/libunrar.wasm',
      mem: 'https://wcchoi.github.io/libunrar-js/libunrar.js.mem'
    },
    {
      name: 'unpkg',
      js: 'https://unpkg.com/libunrar-js@0.8.0/dist/libunrar.js',
      wasm: 'https://unpkg.com/libunrar-js@0.8.0/dist/libunrar.wasm',
      mem: 'https://unpkg.com/libunrar-js@0.8.0/dist/libunrar.js.mem'
    },
    {
      name: 'jsdelivr',
      js: 'https://cdn.jsdelivr.net/npm/libunrar-js@0.8.0/dist/libunrar.js',
      wasm: 'https://cdn.jsdelivr.net/npm/libunrar-js@0.8.0/dist/libunrar.wasm',
      mem: 'https://cdn.jsdelivr.net/npm/libunrar-js@0.8.0/dist/libunrar.js.mem'
    },
    {
      name: 'fastly jsdelivr',
      js: 'https://fastly.jsdelivr.net/npm/libunrar-js@0.8.0/dist/libunrar.js',
      wasm: 'https://fastly.jsdelivr.net/npm/libunrar-js@0.8.0/dist/libunrar.wasm',
      mem: 'https://fastly.jsdelivr.net/npm/libunrar-js@0.8.0/dist/libunrar.js.mem'
    }
  ];
  let libLoadPromise = null;
  let activeBlobUrls = [];

  /** ----------- 菜单 ----------- */
  GM_registerMenuCommand(AUTO_PREVIEW_ENABLED ? '禁用自动解压' : '启用自动解压', () => {
    GM_setValue(STORAGE_KEYS.AUTO_PREVIEW, !AUTO_PREVIEW_ENABLED);
    notify('RAR 解压助手', `已${AUTO_PREVIEW_ENABLED ? '禁用' : '启用'}自动解压，请刷新页面。`);
  });

  GM_registerMenuCommand('设置密码字典', () => {
    const current = getStoredPasswords().join('\n');
    const input = prompt(
      '请输入常用密码（每行一个，支持逗号分隔）。脚本会优先尝试自定义密码，然后使用默认内置字典。',
      current
    );
    if (input === null) return;
    GM_setValue(STORAGE_KEYS.PASSWORDS, input);
    notify('RAR 解压助手', '密码字典已更新，请刷新页面。');
  });

  /** ----------- 核心逻辑 ----------- */
  const SELECTOR_RAR_LINK = 'a[href]';
  const OBSERVER_CONFIG = { childList: true, subtree: true };

  const formatBytes = bytes => {
    const n = Number(bytes) || 0;
    if (n < 1024) return `${n} B`;
    if (n < 1024 ** 2) return `${(n / 1024).toFixed(2)} KB`;
    if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(2)} MB`;
    return `${(n / 1024 ** 3).toFixed(2)} GB`;
  };

  const isLikelyText = filename => {
    const ext = (filename.split('.').pop() || '').toLowerCase();
    return TEXT_EXTS.has(ext);
  };

  const absoluteUrl = href => {
    try {
      return new URL(href, location.href).toString();
    } catch (_) {
      return href;
    }
  };

  function notify(title, text) {
    try {
      GM_notification?.({ title, text, timeout: 4000 });
    } catch (_) {}
  }

  function log(...args) {
    console.log('[rar-helper]', ...args);
  }

  async function fetchArrayBuffer(url, signal) {
    log('开始下载附件', url);
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        url,
        method: 'GET',
        responseType: 'arraybuffer',
        timeout: 60000,
        onload: res => {
          if (signal?.aborted) return reject(new Error('abort'));
          if (res.status >= 200 && res.status < 300) {
            resolve(res.response);
          } else {
            reject(new Error(`HTTP ${res.status}`));
          }
        },
        onerror: () => reject(new Error('网络错误')),
        ontimeout: () => reject(new Error('下载超时'))
      });
    });
  }

  async function fetchBinaryResource(url, timeout = 30000) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        url,
        method: 'GET',
        responseType: 'arraybuffer',
        timeout,
        onload: res => {
          if (res.status >= 200 && res.status < 300) resolve(res.response);
          else reject(new Error(`HTTP ${res.status}`));
        },
        onerror: () => reject(new Error('网络错误')),
        ontimeout: () => reject(new Error('超时'))
      });
    });
  }

  async function fetchTextResource(url, timeout = 20000) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        url,
        method: 'GET',
        responseType: 'text',
        timeout,
        onload: res => {
          if (res.status >= 200 && res.status < 300) resolve(res.responseText);
          else reject(new Error(`HTTP ${res.status}`));
        },
        onerror: () => reject(new Error('网络错误')),
        ontimeout: () => reject(new Error('超时'))
      });
    });
  }

  async function ensureLibReady() {
    if (window.libunrar || window.UNRAR) return;
    if (libLoadPromise) return libLoadPromise;
    libLoadPromise = (async () => {
      const evalLib = code => {
        const fn = new Function(code);
        fn();
      };

      const useLibrary = (code, wasmBytes, memBytes, sourceName) => {
        if (!code) return false;
        prepareModule(wasmBytes, memBytes, sourceName);
        try {
          evalLib(code);
          return window.libunrar || window.UNRAR;
        } catch (err) {
          console.warn('[rar-helper] 载入 libunrar-js 失败', err);
          delete window.libunrar;
          delete window.UNRAR;
          return false;
        }
      };

      const cachedJs = GM_getValue(LIB_CACHE_KEY_JS, '');
      const cachedWasm = GM_getValue(LIB_CACHE_KEY_WASM, '');
      const cachedMem = GM_getValue(LIB_CACHE_KEY_MEM, '');
      if (cachedJs && (cachedWasm || cachedMem)) {
        try {
          console.log('[rar-helper] 使用缓存的 libunrar-js');
          const wasmBytes = cachedWasm ? base64ToUint8(cachedWasm) : null;
          const memBytes = cachedMem ? base64ToUint8(cachedMem) : null;
          if (useLibrary(cachedJs, wasmBytes, memBytes, GM_getValue(LIB_CACHE_KEY_SOURCE, 'cached'))) return;
        } catch (err) {
          console.warn('[rar-helper] 缓存 libunrar-js 失效，尝试重新下载', err);
        }
      }

      for (const source of LIB_SOURCES) {
        try {
          console.log('[rar-helper] 下载 libunrar-js', source.name);
          const [code, wasmBuffer, memBuffer] = await Promise.all([
            fetchTextResource(source.js),
            fetchBinaryResource(source.wasm).catch(() => null),
            source.mem ? fetchBinaryResource(source.mem).catch(() => null) : Promise.resolve(null)
          ]);
          const wasmBytes = wasmBuffer ? new Uint8Array(wasmBuffer) : null;
          const memBytes = memBuffer ? new Uint8Array(memBuffer) : null;
          if (useLibrary(code, wasmBytes, memBytes, source.name)) {
            GM_setValue(LIB_CACHE_KEY_JS, code);
            GM_setValue(LIB_CACHE_KEY_WASM, wasmBytes ? uint8ToBase64(wasmBytes) : '');
            GM_setValue(LIB_CACHE_KEY_MEM, memBytes ? uint8ToBase64(memBytes) : '');
            GM_setValue(LIB_CACHE_KEY_SOURCE, source.name);
            return;
          }
        } catch (err) {
          console.warn('[rar-helper] 加载 libunrar-js 失败', source.name, err);
        }
      }
      throw new Error('无法加载 libunrar-js，请检查网络或来源地址');
    })();
    return libLoadPromise;
  }

  function prepareModule(wasmBytes, memBytes, sourceName) {
    cleanupBlobUrls();
    const locateMap = {};
    if (wasmBytes?.length) {
      const wasmBlob = new Blob([wasmBytes], { type: 'application/wasm' });
      const wasmUrl = URL.createObjectURL(wasmBlob);
      activeBlobUrls.push(wasmUrl);
      locateMap['libunrar.wasm'] = wasmUrl;
    }
    if (memBytes?.length) {
      const memBlob = new Blob([memBytes], { type: 'application/octet-stream' });
      const memUrl = URL.createObjectURL(memBlob);
      activeBlobUrls.push(memUrl);
      locateMap['libunrar.js.mem'] = memUrl;
    }

    const module = window.Module = {
      wasmBinary: wasmBytes && wasmBytes.length ? wasmBytes : undefined,
      noInitialRun: true,
      noExitRuntime: true,
      locateFile: path => locateMap[path] || path,
      memoryInitializer: memBytes ? memBytes.buffer.slice(memBytes.byteOffset, memBytes.byteOffset + memBytes.byteLength) : undefined,
      onAbort: err => console.error('[rar-helper] libunrar 模块异常', err),
      onRuntimeInitialized: () => console.log('[rar-helper] libunrar 初始化完成（来源：' + sourceName + '）')
    };
  }

  function cleanupBlobUrls() {
    if (!activeBlobUrls.length) return;
    activeBlobUrls.forEach(url => URL.revokeObjectURL(url));
    activeBlobUrls = [];
  }

  function uint8ToBase64(u8) {
    let binary = '';
    const len = u8.length;
    for (let i = 0; i < len; i++) binary += String.fromCharCode(u8[i]);
    return btoa(binary);
  }

  function base64ToUint8(base64) {
    const binary = atob(base64);
    const len = binary.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  async function tryExtractWithPassword(buffer, password) {
    await ensureLibReady();
    const { createExtractorFromData } = window.libunrar || window.UNRAR || {};
    if (!createExtractorFromData) {
      throw new Error('libunrar 未加载完成');
    }
    try {
      const data = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
      const extractor = await createExtractorFromData({ data, password });
      const list = extractor.getFileList();
      const fileHeaders = list?.fileHeaders || [];
      if (!fileHeaders.length) return { ok: false, error: '空压缩包' };

      const names = fileHeaders
        .filter(fh => !(fh.flags?.directory))
        .map(fh => fh.name || fh.fileName || fh.fileNameUTF8)
        .filter(Boolean);

      if (!names.length) return { ok: false, error: '未找到文件' };

      const extracted = extractor.extract({ files: names });
      const files = extracted?.files || [];

      if (!files.length) return { ok: false, error: '提取失败' };

      const entries = files
        .map(file => {
          const raw = file.extraction;
          if (!(raw instanceof Uint8Array)) return null;
          const size = raw.byteLength;
          const name = file.fileName || file.name || file.fileHeader?.name;
          return {
            name,
            size,
            data: raw
          };
        })
        .filter(Boolean);

      if (!entries.length) return { ok: false, error: '未成功解出任何文件' };

      return { ok: true, entries };
    } catch (err) {
      if (/password/i.test(String(err))) return { ok: false, wrongPassword: true };
      if (/Encrypted headers|encrypted headers/i.test(String(err))) return { ok: false, wrongPassword: true };
      return { ok: false, error: err?.message || String(err), wrongPassword: false };
    }
  }

  async function extractArchive(buffer, candidates, panel) {
    const tried = [];
    for (const pwd of candidates) {
      const displayPwd = pwd ? pwd : '(空密码)';
      panel.setStatus(`尝试密码：${displayPwd}`);
      const result = await tryExtractWithPassword(buffer, pwd);
      tried.push({ password: pwd, result });
      if (result.ok) {
        panel.setStatus(`解压成功（密码：${displayPwd}）`);
        renderEntries(panel, result.entries, pwd);
        return;
      }
      if (result.wrongPassword) {
        log('密码错误', displayPwd);
        continue;
      }
      if (result.error) {
        panel.appendMessage(`密码 ${displayPwd} 失败：${result.error}`);
      }
    }

    panel.setStatus('未能自动解压，请手动输入密码');
    const manual = prompt('请输入压缩包密码（留空取消）：');
    if (!manual && manual !== '') return;
    if (manual === '') {
      const res = await tryExtractWithPassword(buffer, '');
      if (res.ok) {
        panel.setStatus('使用空密码解压成功（手动）');
        renderEntries(panel, res.entries, '');
      } else {
        panel.setStatus('手动尝试失败，请检查密码');
      }
      return;
    }
    const res = await tryExtractWithPassword(buffer, manual);
    if (res.ok) {
      panel.setStatus(`解压成功（密码：${manual}）`);
      renderEntries(panel, res.entries, manual);
    } else {
      panel.setStatus(`手动密码解压失败：${res.error || '未知错误'}`);
    }
  }

  function renderEntries(panel, entries, passwordUsed) {
    if (!entries.length) {
      panel.appendMessage('未提取到任何文件。');
      return;
    }

    const list = document.createElement('div');
    list.className = 'rar-preview-list';
    list.style.cssText = 'margin-top:8px;display:flex;flex-direction:column;gap:8px;';

    entries.forEach(entry => {
      const card = document.createElement('div');
      card.style.cssText =
        'border:1px solid rgba(0,0,0,0.1);border-radius:6px;padding:8px;background:#fafafa;display:flex;flex-direction:column;gap:6px;';

      const head = document.createElement('div');
      head.style.cssText = 'display:flex;justify-content:space-between;gap:12px;align-items:center;';

      const title = document.createElement('span');
      title.textContent = entry.name || '(无文件名)';
      title.style.cssText = 'font-weight:600;word-break:break-all;';

      const meta = document.createElement('span');
      meta.textContent = formatBytes(entry.size);
      meta.style.cssText = 'font-size:12px;color:#555;';

      head.append(title, meta);
      card.append(head);

      if (isLikelyText(entry.name) && entry.size <= 512 * 1024) {
        const text = decodeText(entry.data);
        const textarea = document.createElement('textarea');
        textarea.value = text;
        textarea.rows = Math.min(16, Math.max(6, Math.ceil(text.length / 120)));
        textarea.style.cssText =
          'width:100%;box-sizing:border-box;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px;background:#fff;';
        card.append(textarea);

        const copyBtn = document.createElement('button');
        copyBtn.textContent = '复制文本';
        copyBtn.style.cssText = 'align-self:flex-start;padding:2px 10px;';
        copyBtn.addEventListener('click', () => {
          GM_setClipboard(textarea.value || '');
          copyBtn.textContent = '已复制';
          setTimeout(() => (copyBtn.textContent = '复制文本'), 1500);
        });
        card.append(copyBtn);
      } else {
        const downloadBtn = document.createElement('button');
        downloadBtn.textContent = '下载文件';
        downloadBtn.style.cssText = 'align-self:flex-start;padding:2px 10px;';
        downloadBtn.addEventListener('click', () => {
          triggerDownload(entry);
        });
        card.append(downloadBtn);
      }

      list.append(card);
    });

    panel.clearResults();
    panel.container.appendChild(list);
    if (passwordUsed !== undefined) {
      panel.appendMessage(`使用密码：${passwordUsed || '(空)'}`);
    }
  }

  function decodeText(uint8) {
    try {
      return new TextDecoder('utf-8').decode(uint8);
    } catch (_) {}
    try {
      return new TextDecoder('gb18030').decode(uint8);
    } catch (_) {}
    return '(无法解析为文本)';
  }

  function triggerDownload(entry) {
    const blob = new Blob([entry.data.buffer.slice(entry.data.byteOffset, entry.data.byteOffset + entry.data.byteLength)]);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = entry.name || 'extracted.bin';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      URL.revokeObjectURL(url);
      a.remove();
    }, 1000);
  }

  /** ----------- UI 面板 ----------- */
  class ExtractPanel {
    constructor(anchor) {
      this.anchor = anchor;
      this.container = document.createElement('div');
      this.container.className = 'rar-helper-panel';
      this.container.style.cssText =
        'margin:6px 0;padding:8px;border:1px solid rgba(0,0,0,0.1);border-radius:6px;background:#f6f9ff;max-width:680px;';

      const title = document.createElement('div');
      title.textContent = 'RAR 解压助手';
      title.style.cssText = 'font-weight:600;margin-bottom:6px;';

      this.statusEl = document.createElement('div');
      this.statusEl.style.cssText = 'font-size:12px;color:#555;margin-bottom:6px;';
      this.statusEl.textContent = '准备就绪';

      this.btnRow = document.createElement('div');
      this.btnRow.style.cssText = 'display:flex;flex-wrap:wrap;gap:8px;';

      this.extractBtn = document.createElement('button');
      this.extractBtn.textContent = '解压预览';
      this.extractBtn.style.cssText = 'padding:4px 10px;';
      this.extractBtn.addEventListener('click', () => this.startExtract());

      this.autoCheckbox = document.createElement('label');
      this.autoCheckbox.style.cssText = 'display:inline-flex;align-items:center;gap:4px;font-size:12px;';
      const autoInput = document.createElement('input');
      autoInput.type = 'checkbox';
      autoInput.checked = AUTO_PREVIEW_ENABLED;
      autoInput.addEventListener('change', () => {
        GM_setValue(STORAGE_KEYS.AUTO_PREVIEW, autoInput.checked);
        notify('RAR 解压助手', `已${autoInput.checked ? '启用' : '关闭'}自动解压，刷新后生效。`);
      });
      this.autoCheckbox.append(autoInput, document.createTextNode('自动解压'));

      this.btnRow.append(this.extractBtn, this.autoCheckbox);

      this.logArea = document.createElement('div');
      this.logArea.className = 'rar-helper-log';
      this.logArea.style.cssText = 'font-size:12px;color:#444;display:flex;flex-direction:column;gap:4px;';

      this.container.append(title, this.statusEl, this.btnRow, this.logArea);
    }

    attach() {
      this.anchor.insertAdjacentElement('afterend', this.container);
    }

    setStatus(text) {
      this.statusEl.textContent = text;
    }

    appendMessage(text) {
      const line = document.createElement('div');
      line.textContent = text;
      this.logArea.appendChild(line);
    }

    clearResults() {
      this.logArea.innerHTML = '';
    }

    async startExtract() {
      const href = absoluteUrl(this.anchor.href);
      if (!href) {
        this.setStatus('无法解析链接地址');
        return;
      }

      let abortController;
      try {
        this.extractBtn.disabled = true;
        this.setStatus('下载压缩包...');
        abortController = new AbortController();
        const buffer = await fetchArrayBuffer(href, abortController.signal);
        const size = buffer?.byteLength || 0;
        this.appendMessage(`压缩包大小：${formatBytes(size)}`);
        await extractArchive(buffer, PASSWORD_CANDIDATES, this);
      } catch (err) {
        this.setStatus(`失败：${err?.message || err}`);
        log('解压失败', err);
      } finally {
        this.extractBtn.disabled = false;
      }
    }
  }

  /** ----------- 扫描与标记 ----------- */
  function enhanceAnchor(anchor) {
    if (anchor.dataset.rarHelper === '1') return;
    anchor.dataset.rarHelper = '1';

    const panel = new ExtractPanel(anchor);
    panel.attach();

    if (AUTO_PREVIEW_ENABLED) {
      const sizeMatch = anchor.textContent?.match(/(\d+(?:\.\d+)?)(\s?[GMK]B)/i);
      const approxSize = (() => {
        if (!sizeMatch) return null;
        let [_, numStr, unit] = sizeMatch;
        const num = parseFloat(numStr);
        if (isNaN(num)) return null;
        unit = unit.replace(/\s+/g, '').toUpperCase();
        if (unit === 'KB') return num * 1024;
        if (unit === 'MB') return num * 1024 * 1024;
        if (unit === 'GB') return num * 1024 * 1024 * 1024;
        return null;
      })();

      if (approxSize !== null && approxSize <= MAX_AUTO_BYTES) {
        panel.startExtract();
      }
    }
  }

  function isRarAnchor(anchor) {
    if (!(anchor instanceof HTMLAnchorElement)) return false;
    const href = anchor.getAttribute('href') || '';
    const text = anchor.textContent || '';
    const dataHref = anchor.dataset?.href || '';

    const match = str => /\.part\d+\.rar\b/i.test(str) || /\.rar\b/i.test(str);

    if (match(href)) return true;
    if (match(text)) return true;
    if (match(dataHref)) return true;

    const title = anchor.getAttribute('title') || '';
    if (match(title)) return true;

    // Discuz 等站点 attachment link 通常放在 span 内，属性中含有 aid，可结合文本判断
    if (/forum\.php\?mod=attachment/i.test(href) && /rar/i.test(text)) return true;

    return false;
  }

  function scan() {
    document.querySelectorAll(SELECTOR_RAR_LINK).forEach(anchor => {
      if (isRarAnchor(anchor)) {
        enhanceAnchor(anchor);
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', scan, { once: true });
  } else {
    scan();
  }

  const observer = new MutationObserver(() => scan());
  observer.observe(document.body, OBSERVER_CONFIG);
})();
