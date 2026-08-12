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
