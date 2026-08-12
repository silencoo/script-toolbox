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
