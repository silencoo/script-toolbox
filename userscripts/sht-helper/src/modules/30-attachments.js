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
