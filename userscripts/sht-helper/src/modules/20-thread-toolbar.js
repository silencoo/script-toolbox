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
