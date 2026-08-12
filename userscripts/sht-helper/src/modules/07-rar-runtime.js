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
