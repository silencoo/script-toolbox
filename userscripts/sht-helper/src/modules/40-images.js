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
