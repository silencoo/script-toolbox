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
