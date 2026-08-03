// ==UserScript==
// @name         RAR 附件在线解压助手（修复版）
// @namespace    https://tampermonkey-helper.local/
// @version      0.2.1
// @description  为网页 .rar 附件添加“解压预览”，在浏览器内解包（支持密码字典与手动输入），无需本地下载；修复回调只返回文件名导致“未解出任何文件”的问题，直显文本内容。
// @author       silencoo
// @homepageURL  https://github.com/silencoo/script-toolbox/tree/main/userscripts/rar-attachment-extractor
// @supportURL   https://github.com/silencoo/script-toolbox/issues
// @match        *://*/*
// @grant        GM_xmlhttpRequest
// @grant        GM_registerMenuCommand
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_setClipboard
// @grant        GM_notification
// @grant        unsafeWindow
// @connect      *
// @run-at       document-idle
// @inject-into  page
// ==/UserScript==

(() => {
    'use strict';

    /** ================= 配置 ================= */
    const STORAGE_KEYS = {
      PASSWORDS: 'rar_helper_passwords',
      AUTO_PREVIEW: 'rar_helper_auto_preview',
      JS_CACHE: 'rar_helper_libunrar_js_cache_v1',
      MEM_CACHE: 'rar_helper_libunrar_mem_cache_v1',
    };

    const DEFAULT_PASSWORDS = [
      '', 'password', '123456',
      'www.sehuatang.org', 'sehuatang',
      'www.tjupt.org', 'gaytorrent', 'carpt.net'
    ];
    const MAX_AUTO_BYTES = 40 * 1024 * 1024;
    const TEXT_EXTS = new Set(['txt','nfo','log','json','ini','xml','md','sfv','srt']);

    const LIB_SOURCES = [{
      name: 'github raw gh-pages',
      js:  'https://raw.githubusercontent.com/wcchoi/libunrar-js/refs/heads/gh-pages/libunrar.js',
      mem: 'https://raw.githubusercontent.com/wcchoi/libunrar-js/refs/heads/gh-pages/libunrar.js.mem',
    }];

    const W = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window;

    /** ================= 菜单 ================= */
    const AUTO_PREVIEW_ENABLED = !!GM_getValue(STORAGE_KEYS.AUTO_PREVIEW, false);

    GM_registerMenuCommand(AUTO_PREVIEW_ENABLED ? '禁用自动解压' : '启用自动解压', () => {
      GM_setValue(STORAGE_KEYS.AUTO_PREVIEW, !AUTO_PREVIEW_ENABLED);
      notify('RAR 解压助手', `已${AUTO_PREVIEW_ENABLED ? '禁用' : '启用'}自动解压，请刷新页面。`);
    });

    GM_registerMenuCommand('设置密码字典', () => {
      const current = getStoredPasswords().join('\n');
      const input = prompt('请输入常用密码（每行一个，支持逗号分隔）', current);
      if (input === null) return;
      GM_setValue(STORAGE_KEYS.PASSWORDS, input);
      notify('RAR 解压助手', '密码字典已更新，请刷新页面。');
    });

    GM_registerMenuCommand('清除库缓存', () => {
      GM_setValue(STORAGE_KEYS.JS_CACHE, '');
      GM_setValue(STORAGE_KEYS.MEM_CACHE, '');
      notify('RAR 解压助手', '已清除 libunrar 缓存，请刷新页面。');
    });

    /** ================= 工具函数 ================= */
    function toU8(data) {
      try {
        if (!data) return null;
        if (data instanceof Uint8Array) return data;
        if (data instanceof ArrayBuffer) return new Uint8Array(data);
        if (ArrayBuffer.isView(data) && data.buffer) return new Uint8Array(data.buffer, data.byteOffset || 0, data.byteLength);
        if (typeof Blob !== 'undefined' && data instanceof Blob) return null;
        if (typeof data === 'string') return new TextEncoder().encode(data);
        if (Array.isArray(data)) return new Uint8Array(data);
        if (data && typeof data === 'object') {
          if (data.data) return toU8(data.data);
          if (data.bytes) return toU8(data.bytes);
        }
      } catch(_) {}
      return null;
    }
      // 把 { "0":101, "1":100, ... } 这种对象字节转成 Uint8Array
  function objBytesToU8(obj) {
    if (!obj) return null;
    if (obj instanceof Uint8Array) return obj;
    if (Array.isArray(obj)) return new Uint8Array(obj);
    if (typeof obj === 'object') {
      const keys = Object.keys(obj).sort((a,b)=>Number(a)-Number(b));
      const out = new Uint8Array(keys.length);
      for (let i=0;i<keys.length;i++) out[i] = (obj[keys[i]]|0) & 0xFF;
      return out;
    }
    return null;
  }

  // 递归把 result.ls 的目录树收集为 {name, size, data}[]
  function collectEntriesFromResult(result) {
    const entries = [];

    function walkLS(ls, prefix="") {
      if (!ls || typeof ls !== 'object') return;
      for (const [name, node] of Object.entries(ls)) {
        const niceName = (node.fullFileName || (prefix ? (prefix + '/' + name) : name));
        if (node?.type === 'file') {
          // 优先各种字段；fileContent 是对象形式的字节
          let u8 = toU8(node.fileContent) || toU8(node.content) || toU8(node.data) || objBytesToU8(node.fileContent);
          if (!u8 && node.bytes) u8 = toU8(node.bytes);
          if (u8) entries.push({ name: niceName, size: node.fileSize ?? u8.byteLength, data: u8 });
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

    function getStoredPasswords() {
      const raw = (GM_getValue(STORAGE_KEYS.PASSWORDS, '') || '').trim();
      if (!raw) return [];
      return raw.split(/\s*[,\n]\s*/).map(s => s.trim()).filter(Boolean);
    }
    const PASSWORD_CANDIDATES = Array.from(new Set([...getStoredPasswords(), ...DEFAULT_PASSWORDS]));

    function notify(title, text) {
      try { GM_notification?.({ title, text, timeout: 4000 }); } catch {}
    }

    const formatBytes = (n) => {
      n = Number(n) || 0;
      if (n < 1024) return `${n} B`;
      if (n < 1024 ** 2) return `${(n/1024).toFixed(2)} KB`;
      if (n < 1024 ** 3) return `${(n/1024**2).toFixed(2)} MB`;
      return `${(n/1024**3).toFixed(2)} GB`;
    };

    const isLikelyText = (name) => TEXT_EXTS.has((name.split('.').pop()||'').toLowerCase());
    const absoluteUrl = (href) => { try { return new URL(href, location.href).toString(); } catch { return href; } };

    function decodeText(u8) {
      try { return new TextDecoder('utf-8',   { fatal:false }).decode(u8); } catch {}
      try { return new TextDecoder('gb18030', { fatal:false }).decode(u8); } catch {}
      let s = ''; for (let i=0;i<u8.length;i++) s += String.fromCharCode(u8[i] & 0xFF);
      return s;
    }

    function uint8ToBase64(u8) {
      let s = '';
      for (let i=0;i<u8.length;i++) s += String.fromCharCode(u8[i]);
      return btoa(s);
    }
    function base64ToUint8(b64) {
      const bin = atob(b64); const len = bin.length;
      const out = new Uint8Array(len);
      for (let i=0;i<len;i++) out[i] = bin.charCodeAt(i);
      return out;
    }

    function runScriptFromText(code) {
      return new Promise((resolve, reject) => {
        const blob = new Blob([code], { type: 'application/javascript' });
        const url  = URL.createObjectURL(blob);
        const s    = document.createElement('script');
        s.src = url;
        s.onload = () => { URL.revokeObjectURL(url); resolve(); };
        s.onerror = (e) => { URL.revokeObjectURL(url); reject(e); };
        (document.head || document.documentElement).appendChild(s);
      });
    }

    function triggerDownload(entry) {
      const blob = new Blob([entry.data.buffer.slice(entry.data.byteOffset, entry.data.byteOffset + entry.data.byteLength)]);
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement('a');
      a.href = url; a.download = entry.name || 'extracted.bin';
      document.body.appendChild(a); a.click();
      setTimeout(()=>{ URL.revokeObjectURL(url); a.remove(); }, 1000);
    }

    /** ================= 网络请求（GM_xhr） ================= */
    function fetchArrayBuffer(url, signal) {
      return new Promise((resolve, reject) => {
        GM_xmlhttpRequest({
          url, method:'GET', responseType:'arraybuffer', timeout: 60_000,
          headers: {
            'User-Agent': navigator.userAgent,
            'Referer': location.href,
            'Accept': '*/*',
          },
          onload: res => {
            if (signal?.aborted) return reject(new Error('abort'));
            (res.status >= 200 && res.status < 300) ? resolve(res.response)
                                                    : reject(new Error(`HTTP ${res.status}`));
          },
          onerror: ()  => reject(new Error('网络错误')),
          ontimeout: () => reject(new Error('下载超时')),
        });
      });
    }

    function fetchBinary(url, timeout = 30_000) {
      return new Promise((resolve, reject) => {
        GM_xmlhttpRequest({
          url, method:'GET', responseType:'arraybuffer', timeout,
          headers: { 'Accept': '*/*', 'Referer': location.href },
          onload: res => (res.status >= 200 && res.status < 300) ? resolve(res.response)
                                                                 : reject(new Error(`HTTP ${res.status}`)),
          onerror: ()  => reject(new Error('网络错误')),
          ontimeout: () => reject(new Error('超时')),
        });
      });
    }

    function fetchText(url, timeout = 20_000) {
      return new Promise((resolve, reject) => {
        GM_xmlhttpRequest({
          url, method:'GET', responseType:'text', timeout,
          headers: { 'Accept': 'text/plain,*/*;q=0.8', 'Referer': location.href },
          onload: res => (res.status >= 200 && res.status < 300) ? resolve(res.responseText)
                                                                 : reject(new Error(`HTTP ${res.status}`)),
          onerror: ()  => reject(new Error('网络错误')),
          ontimeout: () => reject(new Error('超时')),
        });
      });
    }

    /** ================= libunrar 加载（修复点） ================= */
    let gWorker = null;
    let gWorkerReady = null;

    async function ensureLibReady() {
      if (gWorker && gWorkerReady) return gWorkerReady;

      // 拉 gh-pages 的 js / mem
      const JS_URL  = LIB_SOURCES[0].js;
      const MEM_URL = LIB_SOURCES[0].mem;

      const [jsCode, memBuf] = await Promise.all([fetchText(JS_URL), fetchBinary(MEM_URL)]);

      // 用 blob: 提供 .mem
      const memBlob = new Blob([new Uint8Array(memBuf)], { type:'application/octet-stream' });
      const memURL  = URL.createObjectURL(memBlob);

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

      // 1) 优先：不带回调的调用方式 —— 直接“拿返回值”
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

      const workerBlob = new Blob([workerSource], { type:'application/javascript' });
      const workerURL  = URL.createObjectURL(workerBlob);

      gWorker = new Worker(workerURL);
      gWorkerReady = new Promise((resolve, reject) => {
        const t = setTimeout(()=>reject(new Error('Worker 初始化超时')), 5000);
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
        gWorker.onerror = (e)=>{ clearTimeout(t); reject(new Error('Worker 脚本错误: ' + (e.message||e.filename))); };
      });

      return gWorkerReady;
    }

    /** ================= 调用 Worker 抽取 ================= */
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

    /** ================= 解压逻辑（主线程） ================= */
    async function tryExtractWithPassword(buffer, password) {
      console.log('[rar-helper] tryExtractWithPassword: password =', password);
      try {
        console.log('laodi')
        const result = await callWorkerExtract(buffer, password);
        console.log(result.ls);
        console.log('bushi')
        console.debug('[rar-helper] worker result keys:', Object.keys(result||{}));
        // 统一从各种可能的返回结构里收集
        const outEntries = collectEntriesFromResult(result);
        console.log('[rar-helper] collected entries:', outEntries.map(e => `${e.name} (${e.size})`));
        if (outEntries.length) return { ok: true, entries: outEntries };

        const s = JSON.stringify(result||{});
        if (/password|wrong\s*password|encrypted\s*headers/i.test(s)) {
          return { ok:false, wrongPassword:true };
        }
        return { ok:false, error:'未成功解出任何文件' };
      } catch (err) {
        const s = String(err||'');
        if (/password|wrong\s*password|encrypted\s*headers/i.test(s)) {
          return { ok:false, wrongPassword:true };
        }
        return { ok:false, error: err?.message || s };
      }
    }

    async function extractArchive(buffer, candidates, panel) {
      for (const pwd of candidates) {
        const display = pwd || '(空密码)';
        panel.setStatus(`尝试密码：${display}`);
        const r = await tryExtractWithPassword(buffer, pwd);
        if (r.ok) {
          panel.setStatus(`解压成功（密码：${display}）`);
          renderEntries(panel, r.entries, pwd);
          return;
        }
        if (r.wrongPassword) continue;
        if (r.error) panel.appendMessage(`密码 ${display} 失败：${r.error}`);
      }

      panel.setStatus('未能自动解压，请手动输入密码');
      const manual = prompt('请输入压缩包密码（留空表示空密码；取消则放弃）：');
      if (manual === null) return;

      const r = await tryExtractWithPassword(buffer, manual);
      if (r.ok) {
        panel.setStatus(`解压成功（密码：${manual || '(空)'}）`);
        renderEntries(panel, r.entries, manual);
      } else {
        panel.setStatus(`手动密码解压失败：${r.error || '未知错误'}`);
      }
    }

    /** ================= UI ================= */
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
        autoInput.type = 'checkbox'; autoInput.checked = AUTO_PREVIEW_ENABLED;
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

      attach() { this.anchor.insertAdjacentElement('afterend', this.container); }
      setStatus(t){ this.statusEl.textContent = t; }
      appendMessage(t){ const d=document.createElement('div'); d.textContent=t; this.logArea.appendChild(d); }
      clearResults(){ this.logArea.innerHTML=''; }

      async startExtract() {
        const href = absoluteUrl(this.anchor.href);
        if (!href) { this.setStatus('无法解析链接地址'); return; }
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
          console.error('[rar-helper] 解压失败', err);
        } finally {
          this.extractBtn.disabled = false;
        }
      }
    }

    function renderEntries(panel, entries, passwordUsed) {
      if (!entries.length) { panel.appendMessage('未提取到任何文件。'); return; }

      const list = document.createElement('div');
      list.className = 'rar-preview-list';
      list.style.cssText = 'margin-top:8px;display:flex;flex-direction:column;gap:8px;';

      entries.forEach(entry => {
        const card = document.createElement('div');
        card.style.cssText = 'border:1px solid rgba(0,0,0,0.1);border-radius:6px;padding:8px;background:#fafafa;display:flex;flex-direction:column;gap:6px;';

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
          textarea.style.cssText = 'width:100%;box-sizing:border-box;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px;background:#fff;';
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
          downloadBtn.addEventListener('click', () => triggerDownload(entry));
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

    /** ================= 扫描与标记 ================= */
    const SELECTOR_RAR_LINK   = 'a[href]';
    const OBSERVER_CONFIG     = { childList:true, subtree:true };

    function isRarAnchor(anchor) {
      if (!(anchor instanceof HTMLAnchorElement)) return false;
      const href = anchor.getAttribute('href') || '';
      const text = anchor.textContent || '';
      const dataHref = anchor.dataset?.href || '';
      const match = (s) => /\.part\d+\.rar\b/i.test(s) || /\.rar\b/i.test(s);
      if (match(href) || match(text) || match(dataHref)) return true;
      const title = anchor.getAttribute('title') || '';
      if (match(title)) return true;
      if (/forum\.php\?mod=attachment/i.test(href) && /rar/i.test(text)) return true;
      return false;
    }

    function enhanceAnchor(anchor) {
      if (anchor.dataset.rarHelper === '1') return;
      anchor.dataset.rarHelper = '1';
      const panel = new ExtractPanel(anchor);
      panel.attach();

      if (AUTO_PREVIEW_ENABLED) {
        const m = anchor.textContent?.match(/(\d+(?:\.\d+)?)(\s?[GMK]B)/i);
        let approx = null;
        if (m) {
          let num = parseFloat(m[1]); let unit = m[2].replace(/\s+/g,'').toUpperCase();
          if (unit === 'KB') approx = num * 1024;
          else if (unit === 'MB') approx = num * 1024 * 1024;
          else if (unit === 'GB') approx = num * 1024 * 1024 * 1024;
        }
        if (approx !== null && approx <= MAX_AUTO_BYTES) panel.startExtract();
      }
    }

    function scan() {
      document.querySelectorAll(SELECTOR_RAR_LINK).forEach(a => { if (isRarAnchor(a)) enhanceAnchor(a); });
    }

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', scan, { once:true });
    } else {
      scan();
    }
    new MutationObserver(() => scan()).observe(document.body, OBSERVER_CONFIG);
  })();
