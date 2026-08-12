    function openSettings() {
        // 创建设置对话框
        const dialog = document.createElement('div');
        dialog.style.cssText = `
    position: fixed; top: 0; left: 0; width: 100%; height: 100%;
    background: rgba(0,0,0,0.5); z-index: 10000; display: flex;
    align-items: center; justify-content: center; font-family: Arial, sans-serif;
  `;

        const panel = document.createElement('div');
        panel.style.cssText = `
    background: white; border-radius: 8px; padding: 0; max-width: 800px;
    max-height: 85vh; overflow: hidden; box-shadow: 0 4px 20px rgba(0,0,0,0.3);
    display: flex; flex-direction: column;
  `;

        const title = document.createElement('h3');
        title.textContent = 'SHT 脚本设置';
        title.style.cssText = 'margin: 0; padding: 20px 20px 10px 20px; color: #333; border-bottom: 2px solid #eee;';

        // 创建标签页导航
        const tabNav = document.createElement('div');
        tabNav.style.cssText = 'display: flex; border-bottom: 1px solid #ddd; background: #f8f9fa;';

        const tabs = [
            { id: 'basic', name: '基础设置', icon: 'settings' },
            { id: 'display', name: '显示设置', icon: 'eye' },
            { id: 'collection', name: '收集设置', icon: 'download' },
            { id: 'pan115', name: '115 离线', icon: 'database' },
            { id: 'pan123', name: '123 离线', icon: 'cloud' },
            { id: 'advanced', name: '高级设置', icon: 'wrench' }
        ];

        const tabButtons = [];
        tabs.forEach((tab, index) => {
            const tabBtn = document.createElement('button');
            setIconLabel(tabBtn, tab.icon, tab.name);
            tabBtn.style.cssText = `
      flex: 1; padding: 12px 16px; border: none; background: transparent;
      cursor: pointer; font-size: 14px; border-bottom: 3px solid transparent;
      transition: all 0.2s ease;
    `;
            tabBtn.dataset.tab = tab.id;

            if (index === 0) {
                tabBtn.style.background = 'white';
                tabBtn.style.borderBottomColor = '#007cba';
                tabBtn.style.color = '#007cba';
            }

            tabBtn.addEventListener('click', () => switchTab(tab.id));
            tabNav.appendChild(tabBtn);
            tabButtons.push(tabBtn);
        });

        // 创建内容区域
        const contentArea = document.createElement('div');
        contentArea.style.cssText = 'flex: 1; overflow-y: auto; padding: 20px;';

        // 创建各个标签页内容
        const tabContents = {};

        // 基础设置标签页
        const basicTab = document.createElement('div');
        basicTab.id = 'tab-basic';
        basicTab.style.cssText = 'display: block;';
        tabContents.basic = basicTab;

        // 显示设置标签页
        const displayTab = document.createElement('div');
        displayTab.id = 'tab-display';
        displayTab.style.cssText = 'display: none;';
        tabContents.display = displayTab;

        // 收集设置标签页
        const collectionTab = document.createElement('div');
        collectionTab.id = 'tab-collection';
        collectionTab.style.cssText = 'display: none;';
        tabContents.collection = collectionTab;

        // 115 离线标签页
        const pan115Tab = document.createElement('div');
        pan115Tab.id = 'tab-pan115';
        pan115Tab.style.cssText = 'display: none;';
        tabContents.pan115 = pan115Tab;

        // 123Pan 设置标签页
        const pan123Tab = document.createElement('div');
        pan123Tab.id = 'tab-pan123';
        pan123Tab.style.cssText = 'display: none;';
        tabContents.pan123 = pan123Tab;

        // 高级设置标签页
        const advancedTab = document.createElement('div');
        advancedTab.id = 'tab-advanced';
        advancedTab.style.cssText = 'display: none;';
        tabContents.advanced = advancedTab;

        // 标签页切换函数
        function switchTab(tabId) {
            // 隐藏所有标签页
            Object.values(tabContents).forEach(tab => {
                tab.style.display = 'none';
            });

            // 重置所有按钮样式
            tabButtons.forEach(btn => {
                btn.style.background = 'transparent';
                btn.style.borderBottomColor = 'transparent';
                btn.style.color = '#333';
            });

            // 显示选中的标签页
            tabContents[tabId].style.display = 'block';

            // 高亮选中的按钮
            const activeBtn = tabButtons.find(btn => btn.dataset.tab === tabId);
            activeBtn.style.background = 'white';
            activeBtn.style.borderBottomColor = '#007cba';
            activeBtn.style.color = '#007cba';
        }

        // 基础设置内容
        const basicForm = document.createElement('form');
        basicForm.style.cssText = 'display: grid; gap: 15px;';

        // ===== 基础设置 =====
        // 密码候选设置
        const pwdGroup = createSettingGroup('密码候选', '压缩包解压时尝试的密码列表（每行一个密码）');
        const pwdInput = document.createElement('textarea');
        pwdInput.value = CFG.passwordCandidates.join('\n');
        pwdInput.rows = 6;
        pwdInput.style.cssText = 'width: 100%; padding: 8px; border: 1px solid #ddd; border-radius: 4px; font-family: monospace;';
        pwdGroup.appendChild(pwdInput);
        basicForm.appendChild(pwdGroup);

        // 自动加载阈值
        const autoGroup = createSettingGroup('自动加载阈值', '文件大小超过此值时需要手动点击加载（字节）');
        const autoInput = document.createElement('input');
        autoInput.type = 'number';
        autoInput.value = CFG.maxAutoBytes;
        autoInput.style.cssText = 'width: 100%; padding: 8px; border: 1px solid #ddd; border-radius: 4px;';
        autoGroup.appendChild(autoInput);
        basicForm.appendChild(autoGroup);

        // 压缩包内文件大小限制
        const entryGroup = createSettingGroup('压缩包内文件大小限制', '压缩包内单个文件超过此大小时不显示（字节）');
        const entryInput = document.createElement('input');
        entryInput.type = 'number';
        entryInput.value = CFG.maxEntryBytes;
        entryInput.style.cssText = 'width: 100%; padding: 8px; border: 1px solid #ddd; border-radius: 4px;';
        entryGroup.appendChild(entryInput);
        basicForm.appendChild(entryGroup);

        // 自动上顶
        const hoistGroup = createSettingGroup('自动上顶', '解析文本后自动添加到顶部聚合区');
        const hoistCheckbox = document.createElement('input');
        hoistCheckbox.type = 'checkbox';
        hoistCheckbox.checked = CFG.autoHoistToTop;
        hoistCheckbox.style.marginRight = '8px';
        hoistGroup.appendChild(hoistCheckbox);
        hoistGroup.appendChild(document.createTextNode('启用自动上顶'));
        basicForm.appendChild(hoistGroup);

        basicTab.appendChild(basicForm);

        // ===== 显示设置 =====
        const displayForm = document.createElement('form');
        displayForm.style.cssText = 'display: grid; gap: 15px;';

        // 图片屏蔽
        const imgGroup = createSettingGroup('图片屏蔽', '默认屏蔽帖子中的图片');
        const imgCheckbox = document.createElement('input');
        imgCheckbox.type = 'checkbox';
        imgCheckbox.checked = CFG.blockImages;
        imgCheckbox.style.marginRight = '8px';
        imgGroup.appendChild(imgCheckbox);
        imgGroup.appendChild(document.createTextNode('启用图片屏蔽'));
        displayForm.appendChild(imgGroup);

        // 图片白名单
        const whiteGroup = createSettingGroup('图片白名单', '不屏蔽这些域名的图片（逗号分隔）');
        const whiteInput = document.createElement('input');
        whiteInput.type = 'text';
        whiteInput.value = CFG.imageAllowDomains.join(', ');
        whiteInput.placeholder = '例如: example.com, imgur.com';
        whiteInput.style.cssText = 'width: 100%; padding: 8px; border: 1px solid #ddd; border-radius: 4px;';
        whiteGroup.appendChild(whiteInput);
        displayForm.appendChild(whiteGroup);

        // 占位显示元信息
        const metaGroup = createSettingGroup('占位显示元信息', '图片被屏蔽时是否显示域名和文件名');
        const metaCheckbox = document.createElement('input');
        metaCheckbox.type = 'checkbox';
        metaCheckbox.checked = CFG.imagePlaceholderShowMeta;
        metaCheckbox.style.marginRight = '8px';
        metaGroup.appendChild(metaCheckbox);
        metaGroup.appendChild(document.createTextNode('显示元信息'));
        displayForm.appendChild(metaGroup);

        // ===== 收集设置 =====
        const collectionForm = document.createElement('form');
        collectionForm.style.cssText = 'display: grid; gap: 15px;';

        // ED2K收集
        const ed2kGroup = createSettingGroup('ED2K收集', '自动收集并聚合页面中的ED2K链接');
        const ed2kCheckbox = document.createElement('input');
        ed2kCheckbox.type = 'checkbox';
        ed2kCheckbox.checked = CFG.autoCollectED2K;
        ed2kCheckbox.style.marginRight = '8px';
        ed2kGroup.appendChild(ed2kCheckbox);

        // ED2K文件名替换
        const ed2kReplaceGroup = createSettingGroup('ED2K文件名替换', '使用正则表达式替换ED2K链接中的文件名');
        const ed2kReplaceCheckbox = document.createElement('input');
        ed2kReplaceCheckbox.type = 'checkbox';
        ed2kReplaceCheckbox.checked = CFG.ed2kFileNameReplaceEnabled;
        ed2kReplaceCheckbox.style.marginRight = '8px';
        ed2kReplaceGroup.appendChild(ed2kReplaceCheckbox);

        // 替换规则容器
        const ed2kRulesContainer = document.createElement('div');
        ed2kRulesContainer.id = 'ed2k-rules-container';
        ed2kRulesContainer.style.cssText = 'margin-top: 10px; display: none;';
        ed2kReplaceGroup.appendChild(ed2kRulesContainer);

        // 添加规则按钮
        const addRuleBtn = document.createElement('button');
        addRuleBtn.type = 'button';
        addRuleBtn.textContent = '添加替换规则';
        addRuleBtn.style.cssText = 'padding: 4px 8px; margin: 5px 0; background: #007bff; color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 12px;';
        ed2kRulesContainer.appendChild(addRuleBtn);

        // 规则列表
        const rulesList = document.createElement('div');
        rulesList.id = 'ed2k-rules-list';
        rulesList.style.cssText = 'margin-top: 10px;';
        ed2kRulesContainer.appendChild(rulesList);

        // 显示/隐藏规则容器
        ed2kReplaceCheckbox.addEventListener('change', () => {
            ed2kRulesContainer.style.display = ed2kReplaceCheckbox.checked ? 'block' : 'none';
        });
        if (CFG.ed2kFileNameReplaceEnabled) {
            ed2kRulesContainer.style.display = 'block';
        }

        // 添加规则功能
        function addEd2kRule(rule = { pattern: '', replacement: '' }) {
            const ruleDiv = document.createElement('div');
            ruleDiv.style.cssText = 'display: flex; gap: 8px; margin: 5px 0; align-items: center;';

            const patternInput = document.createElement('input');
            patternInput.type = 'text';
            patternInput.placeholder = '正则表达式模式';
            patternInput.value = rule.pattern || '';
            patternInput.style.cssText = 'flex: 1; padding: 4px 8px; border: 1px solid #ddd; border-radius: 4px; font-size: 12px;';

            const replacementInput = document.createElement('input');
            replacementInput.type = 'text';
            replacementInput.placeholder = '替换为';
            replacementInput.value = rule.replacement || '';
            replacementInput.style.cssText = 'flex: 1; padding: 4px 8px; border: 1px solid #ddd; border-radius: 4px; font-size: 12px;';

            const deleteBtn = document.createElement('button');
            deleteBtn.type = 'button';
            deleteBtn.textContent = '删除';
            deleteBtn.style.cssText = 'padding: 4px 8px; background: #dc3545; color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 12px;';
            deleteBtn.addEventListener('click', () => {
                ruleDiv.remove();
            });

            ruleDiv.appendChild(patternInput);
            ruleDiv.appendChild(replacementInput);
            ruleDiv.appendChild(deleteBtn);
            rulesList.appendChild(ruleDiv);
        }

        // 添加规则按钮事件
        addRuleBtn.addEventListener('click', () => {
            addEd2kRule();
        });

        // 初始化现有规则
        if (CFG.ed2kFileNameReplaceRules && CFG.ed2kFileNameReplaceRules.length > 0) {
            CFG.ed2kFileNameReplaceRules.forEach(rule => {
                addEd2kRule(rule);
            });
        } else {
            // 添加默认规则
            addEd2kRule({ pattern: '\\[\\d+\\.\\d+G/\\d+V/\\d+配额\\]', replacement: '' });
        }
        ed2kGroup.appendChild(document.createTextNode('启用ED2K收集'));
        collectionForm.appendChild(ed2kGroup);
        collectionForm.appendChild(ed2kReplaceGroup);

        // 磁力收集
        const magnetGroup = createSettingGroup('磁力收集', '自动收集并聚合页面中的磁力链接');
        const magnetCheckbox = document.createElement('input');
        magnetCheckbox.type = 'checkbox';
        magnetCheckbox.checked = CFG.autoCollectMagnet;
        magnetCheckbox.style.marginRight = '8px';
        magnetGroup.appendChild(magnetCheckbox);
        magnetGroup.appendChild(document.createTextNode('启用磁力收集'));
        collectionForm.appendChild(magnetGroup);

        // 只看楼主
        const authorOnlyGroup = createSettingGroup('只看楼主', '默认只显示楼主的帖子');
        const authorOnlyCheckbox = document.createElement('input');
        authorOnlyCheckbox.type = 'checkbox';
        authorOnlyCheckbox.checked = CFG.authorOnlyMode;
        authorOnlyCheckbox.style.marginRight = '8px';
        authorOnlyGroup.appendChild(authorOnlyCheckbox);
        authorOnlyGroup.appendChild(document.createTextNode('启用只看楼主模式'));
        collectionForm.appendChild(authorOnlyGroup);

        // 历史记录
        const historyGroup = createSettingGroup('历史记录', '记录访问过的帖子历史');
        const historyCheckbox = document.createElement('input');
        historyCheckbox.type = 'checkbox';
        historyCheckbox.checked = CFG.enableHistory;
        historyCheckbox.style.marginRight = '8px';
        historyGroup.appendChild(historyCheckbox);
        historyGroup.appendChild(document.createTextNode('启用历史记录'));

        const historyLimitGroup = document.createElement('div');
        historyLimitGroup.style.cssText = 'margin-top: 10px; display: flex; align-items: center; gap: 8px;';
        historyLimitGroup.appendChild(document.createTextNode('最大记录数:'));
        const historyLimitInput = document.createElement('input');
        historyLimitInput.type = 'number';
        historyLimitInput.value = CFG.maxHistoryItems;
        historyLimitInput.min = '10';
        historyLimitInput.max = '10000';
        historyLimitInput.style.cssText = 'width: 100px; padding: 4px; border: 1px solid #ddd; border-radius: 4px;';
        historyLimitGroup.appendChild(historyLimitInput);
        historyGroup.appendChild(historyLimitGroup);
        collectionForm.appendChild(historyGroup);

        // 一键评分
        const quickRateGroup = createSettingGroup('一键评分', '点击评分按钮直接给出评分，无需弹窗');
        const quickRateCheckbox = document.createElement('input');
        quickRateCheckbox.type = 'checkbox';
        quickRateCheckbox.checked = CFG.enableQuickRate;
        quickRateCheckbox.style.marginRight = '8px';
        quickRateGroup.appendChild(quickRateCheckbox);
        quickRateGroup.appendChild(document.createTextNode('启用一键评分'));

        const rateScoreGroup = document.createElement('div');
        rateScoreGroup.style.cssText = 'margin-top: 10px; display: flex; align-items: center; gap: 8px;';
        rateScoreGroup.appendChild(document.createTextNode('默认评分:'));
        const rateScoreInput = document.createElement('input');
        rateScoreInput.type = 'number';
        rateScoreInput.value = CFG.defaultRateScore;
        rateScoreInput.min = '1';
        rateScoreInput.max = '10';
        rateScoreInput.style.cssText = 'width: 80px; padding: 4px; border: 1px solid #ddd; border-radius: 4px;';
        rateScoreGroup.appendChild(rateScoreInput);
        rateScoreGroup.appendChild(document.createTextNode('分'));
        quickRateGroup.appendChild(rateScoreGroup);


        // 评分理由设置
        const reasonGroup = document.createElement('div');
        reasonGroup.style.cssText = 'margin-top: 8px; display: flex; align-items: center; gap: 8px;';
        reasonGroup.appendChild(document.createTextNode('评分理由:'));
        const reasonInput = document.createElement('input');
        reasonInput.type = 'text';
        reasonInput.value = CFG.defaultRateReason;
        reasonInput.placeholder = '输入评分理由';
        reasonInput.style.cssText = 'flex: 1; padding: 4px; border: 1px solid #ddd; border-radius: 4px;';
        reasonGroup.appendChild(reasonInput);
        quickRateGroup.appendChild(reasonGroup);
        collectionForm.appendChild(quickRateGroup);

        collectionTab.appendChild(collectionForm);

        // 排版优化 - 添加到显示设置
        const layoutGroup = createSettingGroup('排版优化', '在帖子列表页面隐藏特定列和置顶帖');

        const hideReplyGroup = document.createElement('div');
        hideReplyGroup.style.cssText = 'margin: 8px 0; display: flex; align-items: center;';
        const hideReplyCheckbox = document.createElement('input');
        hideReplyCheckbox.type = 'checkbox';
        hideReplyCheckbox.checked = CFG.hideReplyColumn;
        hideReplyCheckbox.style.marginRight = '8px';
        hideReplyGroup.appendChild(hideReplyCheckbox);
        hideReplyGroup.appendChild(document.createTextNode('隐藏回复/查看列'));
        layoutGroup.appendChild(hideReplyGroup);

        const hideLastReplyGroup = document.createElement('div');
        hideLastReplyGroup.style.cssText = 'margin: 8px 0; display: flex; align-items: center;';
        const hideLastReplyCheckbox = document.createElement('input');
        hideLastReplyCheckbox.type = 'checkbox';
        hideLastReplyCheckbox.checked = CFG.hideLastReplyColumn;
        hideLastReplyCheckbox.style.marginRight = '8px';
        hideLastReplyGroup.appendChild(hideLastReplyCheckbox);
        hideLastReplyGroup.appendChild(document.createTextNode('隐藏最后回复列'));
        layoutGroup.appendChild(hideLastReplyGroup);

        const hideAuthorGroup = document.createElement('div');
        hideAuthorGroup.style.cssText = 'margin: 8px 0; display: flex; align-items: center;';
        const hideAuthorCheckbox = document.createElement('input');
        hideAuthorCheckbox.type = 'checkbox';
        hideAuthorCheckbox.checked = CFG.hideAuthorColumn;
        hideAuthorCheckbox.style.marginRight = '8px';
        hideAuthorGroup.appendChild(hideAuthorCheckbox);
        hideAuthorGroup.appendChild(document.createTextNode('隐藏作者列'));
        layoutGroup.appendChild(hideAuthorGroup);

        const hideStickyGroup = document.createElement('div');
        hideStickyGroup.style.cssText = 'margin: 8px 0; display: flex; align-items: center;';
        const hideStickyCheckbox = document.createElement('input');
        hideStickyCheckbox.type = 'checkbox';
        hideStickyCheckbox.checked = CFG.hideStickyThreads;
        hideStickyCheckbox.style.marginRight = '8px';
        hideStickyGroup.appendChild(hideStickyCheckbox);
        hideStickyGroup.appendChild(document.createTextNode('隐藏置顶帖'));
        layoutGroup.appendChild(hideStickyGroup);
        displayForm.appendChild(layoutGroup);

        displayTab.appendChild(displayForm);

        // ===== 高级设置 =====
        const advancedForm = document.createElement('form');
        advancedForm.style.cssText = 'display: grid; gap: 15px;';

        // 分页和过滤功能
        const filterGroup = createSettingGroup('分页和过滤', '隐藏分页、关键词过滤和标题增强功能');

        const hidePaginationGroup = document.createElement('div');
        hidePaginationGroup.style.cssText = 'margin: 8px 0; display: flex; align-items: center;';
        const hidePaginationCheckbox = document.createElement('input');
        hidePaginationCheckbox.type = 'checkbox';
        hidePaginationCheckbox.checked = CFG.hidePagination;
        hidePaginationCheckbox.style.marginRight = '8px';
        hidePaginationGroup.appendChild(hidePaginationCheckbox);
        hidePaginationGroup.appendChild(document.createTextNode('隐藏分页'));
        filterGroup.appendChild(hidePaginationGroup);

        const enhanceTitlesGroup = document.createElement('div');
        enhanceTitlesGroup.style.cssText = 'margin: 8px 0; display: flex; align-items: center;';
        const enhanceTitlesCheckbox = document.createElement('input');
        enhanceTitlesCheckbox.type = 'checkbox';
        enhanceTitlesCheckbox.checked = CFG.enhanceTitles;
        enhanceTitlesCheckbox.style.marginRight = '8px';
        enhanceTitlesGroup.appendChild(enhanceTitlesCheckbox);
        enhanceTitlesGroup.appendChild(document.createTextNode('标题增强（【】→[]）'));
        filterGroup.appendChild(enhanceTitlesGroup);

        // 列表页标题正则替换
        const listTitleGroup = document.createElement('div');
        listTitleGroup.style.cssText = 'margin: 8px 0; display: flex; flex-direction: column;';
        const listTitleLabel = document.createElement('label');
        listTitleLabel.textContent = '列表页标题正则替换:';
        listTitleLabel.style.cssText = 'margin-bottom: 4px; font-size: 12px; color: #666;';
        listTitleGroup.appendChild(listTitleLabel);

        const listTitleCheckbox = document.createElement('input');
        listTitleCheckbox.type = 'checkbox';
        listTitleCheckbox.checked = CFG.enableListTitleEnhance;
        listTitleCheckbox.style.marginRight = '8px';
        const listTitleCheckboxGroup = document.createElement('div');
        listTitleCheckboxGroup.style.cssText = 'margin: 8px 0; display: flex; align-items: center;';
        listTitleCheckboxGroup.appendChild(listTitleCheckbox);
        listTitleCheckboxGroup.appendChild(document.createTextNode('启用列表页标题正则替换'));
        listTitleGroup.appendChild(listTitleCheckboxGroup);

        // 列表页替换规则
        const listRulesLabel = document.createElement('label');
        listRulesLabel.textContent = '替换规则（每行一个，格式：正则表达式|替换内容）:';
        listRulesLabel.style.cssText = 'margin-bottom: 4px; font-size: 12px; color: #666;';
        listTitleGroup.appendChild(listRulesLabel);

        const listRulesTextarea = document.createElement('textarea');
        listRulesTextarea.value = CFG.listTitleReplaceRules.map(rule => `${rule.pattern}|${rule.replacement}`).join('\n');
        listRulesTextarea.placeholder = '例如：\n\\[\\d+\\.\\d+G/\\d+V/\\d+配额\\]|\n\\[情色分享\\]|\n\\[图文故事\\]|';
        listRulesTextarea.style.cssText = 'width: 100%; height: 80px; padding: 8px; border: 1px solid #ddd; border-radius: 4px; font-size: 12px; resize: vertical; font-family: monospace;';
        listTitleGroup.appendChild(listRulesTextarea);

        filterGroup.appendChild(listTitleGroup);

        const keywordFilterGroup = document.createElement('div');
        keywordFilterGroup.style.cssText = 'margin: 8px 0; display: flex; align-items: center;';
        const keywordFilterCheckbox = document.createElement('input');
        keywordFilterCheckbox.type = 'checkbox';
        keywordFilterCheckbox.checked = CFG.enableKeywordFilter;
        keywordFilterCheckbox.style.marginRight = '8px';
        keywordFilterGroup.appendChild(keywordFilterCheckbox);
        keywordFilterGroup.appendChild(document.createTextNode('启用关键词过滤'));
        filterGroup.appendChild(keywordFilterGroup);

        // 关键词输入区域
        const keywordInputGroup = document.createElement('div');
        keywordInputGroup.style.cssText = 'margin: 8px 0; display: flex; flex-direction: column;';
        const keywordLabel = document.createElement('label');
        keywordLabel.textContent = '关键词过滤（每行一个，支持正则表达式，匹配标题和类型）:';
        keywordLabel.style.cssText = 'margin-bottom: 4px; font-size: 12px; color: #666;';
        keywordInputGroup.appendChild(keywordLabel);

        const keywordTextarea = document.createElement('textarea');
        keywordTextarea.value = CFG.keywordFilters.join('\n');
        keywordTextarea.placeholder = '例如：\n测试\n.*广告.*\n^【.*】\n图文故事\n.*故事.*';
        keywordTextarea.style.cssText = 'width: 100%; height: 80px; padding: 8px; border: 1px solid #ddd; border-radius: 4px; font-size: 12px; resize: vertical;';
        keywordInputGroup.appendChild(keywordTextarea);
        filterGroup.appendChild(keywordInputGroup);

        // 历史访问帖子处理
        const historyPostGroup = document.createElement('div');
        historyPostGroup.style.cssText = 'margin: 8px 0; display: flex; flex-direction: column;';
        const historyPostLabel = document.createElement('label');
        historyPostLabel.textContent = '历史访问帖子处理:';
        historyPostLabel.style.cssText = 'margin-bottom: 4px; font-size: 12px; color: #666;';
        historyPostGroup.appendChild(historyPostLabel);

        const historyPostSelect = document.createElement('select');
        historyPostSelect.style.cssText = 'width: 100%; padding: 8px; border: 1px solid #ddd; border-radius: 4px; font-size: 12px;';
        historyPostSelect.innerHTML = `
    <option value="none">不处理</option>
    <option value="hide">隐藏已访问帖子</option>
    <option value="blue">标记为蓝色</option>
    <option value="strikethrough">添加删除线</option>
  `;
        historyPostSelect.value = CFG.historyPostAction;
        historyPostGroup.appendChild(historyPostSelect);

        // 颜色选择器（仅在选择蓝色时显示）
        const colorGroup = document.createElement('div');
        colorGroup.style.cssText = 'margin-top: 8px; display: flex; align-items: center; gap: 8px;';
        const colorLabel = document.createElement('label');
        colorLabel.textContent = '颜色:';
        colorLabel.style.cssText = 'font-size: 12px; color: #666;';
        colorGroup.appendChild(colorLabel);

        const colorInput = document.createElement('input');
        colorInput.type = 'color';
        colorInput.value = CFG.historyPostColor;
        colorInput.style.cssText = 'width: 40px; height: 30px; border: 1px solid #ddd; border-radius: 4px;';
        colorGroup.appendChild(colorInput);

        // 根据当前选择显示/隐藏颜色选择器
        const updateColorVisibility = () => {
            colorGroup.style.display = historyPostSelect.value === 'blue' ? 'flex' : 'none';
        };
        updateColorVisibility();
        historyPostSelect.addEventListener('change', updateColorVisibility);

        historyPostGroup.appendChild(colorGroup);
        filterGroup.appendChild(historyPostGroup);

        // 帖子详情标题处理
        const threadTitleGroup = document.createElement('div');
        threadTitleGroup.style.cssText = 'margin: 8px 0; display: flex; flex-direction: column;';
        const threadTitleLabel = document.createElement('label');
        threadTitleLabel.textContent = '标题正则替换（详情页+列表页）:';
        threadTitleLabel.style.cssText = 'margin-bottom: 4px; font-size: 12px; color: #666;';
        threadTitleGroup.appendChild(threadTitleLabel);

        const threadTitleCheckbox = document.createElement('input');
        threadTitleCheckbox.type = 'checkbox';
        threadTitleCheckbox.checked = CFG.enableThreadTitleEnhance;
        threadTitleCheckbox.style.marginRight = '8px';
        const threadTitleCheckboxGroup = document.createElement('div');
        threadTitleCheckboxGroup.style.cssText = 'margin: 8px 0; display: flex; align-items: center;';
        threadTitleCheckboxGroup.appendChild(threadTitleCheckbox);
        threadTitleCheckboxGroup.appendChild(document.createTextNode('启用标题正则替换'));
        threadTitleGroup.appendChild(threadTitleCheckboxGroup);

        // 类型标签隐藏选项
        const hideTypeCheckbox = document.createElement('input');
        hideTypeCheckbox.type = 'checkbox';
        hideTypeCheckbox.checked = CFG.hideTypeLabels && CFG.hideTypeLabels.length > 0;
        hideTypeCheckbox.style.marginRight = '8px';
        const hideTypeCheckboxGroup = document.createElement('div');
        hideTypeCheckboxGroup.style.cssText = 'margin: 8px 0; display: flex; align-items: center;';
        hideTypeCheckboxGroup.appendChild(hideTypeCheckbox);
        hideTypeCheckboxGroup.appendChild(document.createTextNode('隐藏类型标签（如：情色分享、图文故事等）'));
        threadTitleGroup.appendChild(hideTypeCheckboxGroup);

        // 替换规则输入区域
        const rulesLabel = document.createElement('label');
        rulesLabel.textContent = '替换规则（每行一个，格式：pattern|replacement）:';
        rulesLabel.style.cssText = 'margin-bottom: 4px; font-size: 12px; color: #666;';
        threadTitleGroup.appendChild(rulesLabel);

        const rulesTextarea = document.createElement('textarea');
        rulesTextarea.value = CFG.titleReplaceRules.map(rule => `${rule.pattern}|${rule.replacement}`).join('\n');
        rulesTextarea.placeholder = '例如：\n\\[\\d+\\.\\d+G/\\d+V/\\d+配额\\]|\n\\[.*?\\]|\\[\\1\\]';
        rulesTextarea.style.cssText = 'width: 100%; height: 80px; padding: 8px; border: 1px solid #ddd; border-radius: 4px; font-size: 12px; resize: vertical; font-family: monospace;';
        threadTitleGroup.appendChild(rulesTextarea);

        filterGroup.appendChild(threadTitleGroup);

        // 论坛模块屏蔽
        const moduleFilterGroup = document.createElement('div');
        moduleFilterGroup.style.cssText = 'margin: 8px 0; display: flex; flex-direction: column;';
        const moduleFilterLabel = document.createElement('label');
        moduleFilterLabel.textContent = '论坛模块屏蔽:';
        moduleFilterLabel.style.cssText = 'margin-bottom: 4px; font-size: 12px; color: #666;';
        moduleFilterGroup.appendChild(moduleFilterLabel);

        const moduleFilterCheckbox = document.createElement('input');
        moduleFilterCheckbox.type = 'checkbox';
        moduleFilterCheckbox.checked = CFG.enableModuleFilter;
        moduleFilterCheckbox.style.marginRight = '8px';
        const moduleFilterCheckboxGroup = document.createElement('div');
        moduleFilterCheckboxGroup.style.cssText = 'margin: 8px 0; display: flex; align-items: center;';
        moduleFilterCheckboxGroup.appendChild(moduleFilterCheckbox);
        moduleFilterCheckboxGroup.appendChild(document.createTextNode('启用论坛模块屏蔽'));
        moduleFilterGroup.appendChild(moduleFilterCheckboxGroup);

        // 模块选择区域
        const moduleSelectGroup = document.createElement('div');
        moduleSelectGroup.style.cssText = 'margin: 8px 0; display: flex; flex-direction: column;';
        const moduleSelectLabel = document.createElement('label');
        moduleSelectLabel.textContent = '选择要屏蔽的模块（每行一个）:';
        moduleSelectLabel.style.cssText = 'margin-bottom: 4px; font-size: 12px; color: #666;';
        moduleSelectGroup.appendChild(moduleSelectLabel);

        const moduleTextarea = document.createElement('textarea');
        moduleTextarea.value = CFG.hiddenModules.join('\n');
        moduleTextarea.placeholder = '例如：\n色花文学（大模块）\n投稿送邀请码（小模块）\n综合讨论区（大模块）\nAI专区（小模块）\n国产原创（小模块）\n原创自拍区（小模块）';
        moduleTextarea.style.cssText = 'width: 100%; height: 80px; padding: 8px; border: 1px solid #ddd; border-radius: 4px; font-size: 12px; resize: vertical;';
        moduleSelectGroup.appendChild(moduleTextarea);

        moduleFilterGroup.appendChild(moduleSelectGroup);
        filterGroup.appendChild(moduleFilterGroup);

        // 配置导入导出功能
        const configGroup = createSettingGroup('配置管理', '导出和导入脚本配置');

        const configButtonsGroup = document.createElement('div');
        configButtonsGroup.style.cssText = 'margin: 8px 0; display: flex; gap: 10px; flex-wrap: wrap;';

        const sensitiveExportLabel = document.createElement('label');
        sensitiveExportLabel.style.cssText = 'display:flex;align-items:flex-start;gap:8px;margin:8px 0;padding:8px;border:1px solid #f0c36d;border-radius:4px;background:#fff8e5;font-size:12px;';
        const sensitiveExportCheckbox = document.createElement('input');
        sensitiveExportCheckbox.type = 'checkbox';
        sensitiveExportCheckbox.checked = false;
        sensitiveExportCheckbox.setAttribute('aria-describedby', 'sht-sensitive-export-help');
        const sensitiveExportText = document.createElement('span');
        sensitiveExportText.id = 'sht-sensitive-export-help';
        sensitiveExportText.textContent = '在导出文件中包含 115/123Pan Cookie、Token 和 User-Agent（默认关闭；文件包含账号凭据，请仅保存在可信设备）。';
        sensitiveExportLabel.append(sensitiveExportCheckbox, sensitiveExportText);

        const exportConfigBtn = document.createElement('button');
        setIconLabel(exportConfigBtn, 'upload', '导出配置');
        exportConfigBtn.style.cssText = `
    padding: 8px 16px;
    background: linear-gradient(135deg, #28a745 0%, #1e7e34 100%);
    color: white;
    border: 1px solid #1e7e34;
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
        exportConfigBtn.addEventListener('mouseenter', () => {
            exportConfigBtn.style.background = 'linear-gradient(135deg, #1e7e34 0%, #155724 100%)';
            exportConfigBtn.style.transform = 'translateY(-1px)';
            exportConfigBtn.style.boxShadow = '0 2px 6px rgba(0,0,0,0.15)';
        });
        exportConfigBtn.addEventListener('mouseleave', () => {
            exportConfigBtn.style.background = 'linear-gradient(135deg, #28a745 0%, #1e7e34 100%)';
            exportConfigBtn.style.transform = 'translateY(0)';
            exportConfigBtn.style.boxShadow = '0 1px 3px rgba(0,0,0,0.1)';
        });
        exportConfigBtn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            exportConfig(sensitiveExportCheckbox.checked);
        });

        const importConfigBtn = document.createElement('button');
        setIconLabel(importConfigBtn, 'download', '导入配置');
        importConfigBtn.style.cssText = `
    padding: 8px 16px;
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
        importConfigBtn.addEventListener('mouseenter', () => {
            importConfigBtn.style.background = 'linear-gradient(135deg, #005a87 0%, #004066 100%)';
            importConfigBtn.style.transform = 'translateY(-1px)';
            importConfigBtn.style.boxShadow = '0 2px 6px rgba(0,0,0,0.15)';
        });
        importConfigBtn.addEventListener('mouseleave', () => {
            importConfigBtn.style.background = 'linear-gradient(135deg, #007cba 0%, #005a87 100%)';
            importConfigBtn.style.transform = 'translateY(0)';
            importConfigBtn.style.boxShadow = '0 1px 3px rgba(0,0,0,0.1)';
        });
        importConfigBtn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            importConfig();
        });

        const resetConfigBtn = document.createElement('button');
        setIconLabel(resetConfigBtn, 'refresh', '重置配置');
        resetConfigBtn.style.cssText = `
    padding: 8px 16px;
    background: linear-gradient(135deg, #ffc107 0%, #e0a800 100%);
    color: #212529;
    border: 1px solid #e0a800;
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
        resetConfigBtn.addEventListener('mouseenter', () => {
            resetConfigBtn.style.background = 'linear-gradient(135deg, #e0a800 0%, #d39e00 100%)';
            resetConfigBtn.style.transform = 'translateY(-1px)';
            resetConfigBtn.style.boxShadow = '0 2px 6px rgba(0,0,0,0.15)';
        });
        resetConfigBtn.addEventListener('mouseleave', () => {
            resetConfigBtn.style.background = 'linear-gradient(135deg, #ffc107 0%, #e0a800 100%)';
            resetConfigBtn.style.transform = 'translateY(0)';
            resetConfigBtn.style.boxShadow = '0 1px 3px rgba(0,0,0,0.1)';
        });
        resetConfigBtn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            resetConfig();
        });

        configButtonsGroup.appendChild(exportConfigBtn);
        configButtonsGroup.appendChild(importConfigBtn);
        configButtonsGroup.appendChild(resetConfigBtn);
        configGroup.appendChild(sensitiveExportLabel);
        configGroup.appendChild(configButtonsGroup);

        const runtimeGroup = createSettingGroup('运行与诊断', '工具栏显示、任务并发、会话凭据与脱敏诊断报告');
        const makeRuntimeToggle = (labelText, checked) => {
            const label = document.createElement('label');
            label.style.cssText = 'display:flex;align-items:center;gap:8px;margin:7px 0;font-size:12px;';
            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox'; checkbox.checked = checked;
            label.append(checkbox, document.createTextNode(labelText));
            runtimeGroup.appendChild(label);
            return checkbox;
        };
        const compactModeCheckbox = makeRuntimeToggle('启用帖子工具栏极简模式', CFG.toolbarCompactMode);
        const sessionCredentialsCheckbox = makeRuntimeToggle('网盘凭据仅保留在当前页面内存中（刷新或离开即清除）', CFG.credentialsSessionOnly);
        const debugModeCheckbox = makeRuntimeToggle('启用调试诊断日志（日志会自动脱敏）', CFG.debugMode);
        const concurrencyRow = document.createElement('label');
        concurrencyRow.style.cssText = 'display:flex;align-items:center;gap:8px;margin:7px 0;font-size:12px;';
        concurrencyRow.append(document.createTextNode('网盘任务并发数：'));
        const cloudConcurrencyInput = document.createElement('input');
        cloudConcurrencyInput.type = 'number'; cloudConcurrencyInput.min = '1'; cloudConcurrencyInput.max = '4';
        cloudConcurrencyInput.value = String(CFG.cloudTaskConcurrency || 2);
        cloudConcurrencyInput.style.width = '64px';
        concurrencyRow.append(cloudConcurrencyInput);
        runtimeGroup.appendChild(concurrencyRow);
        const diagnosticExportButton = document.createElement('button');
        diagnosticExportButton.type = 'button';
        setIconLabel(diagnosticExportButton, 'download', '导出脱敏诊断报告');
        diagnosticExportButton.style.cssText = 'padding:7px 12px;border:1px solid #777;border-radius:4px;background:#fff;cursor:pointer;margin-top:6px;';
        diagnosticExportButton.addEventListener('click', exportDiagnosticReport);
        runtimeGroup.appendChild(diagnosticExportButton);

        // 将 filterGroup 和 configGroup 添加到高级设置标签页
        advancedForm.appendChild(filterGroup);
        advancedForm.appendChild(runtimeGroup);
        advancedForm.appendChild(configGroup);
        advancedTab.appendChild(advancedForm);

        // ===== 115 离线下载配置 =====
        const pan115Form = document.createElement('form');
        pan115Form.style.cssText = 'display: grid; gap: 15px;';

        const pan115Group = document.createElement('div');
        pan115Group.style.cssText = 'margin: 8px 0; display: flex; flex-direction: column;';
        const pan115Label = document.createElement('label');
        pan115Label.textContent = '115 离线下载:';
        pan115Label.style.cssText = 'margin-bottom: 4px; font-size: 12px; color: #666;';
        pan115Group.appendChild(pan115Label);

        const pan115EnabledGroup = document.createElement('div');
        pan115EnabledGroup.style.cssText = 'margin: 8px 0; display: flex; align-items: center;';
        const pan115EnabledCheckbox = document.createElement('input');
        pan115EnabledCheckbox.type = 'checkbox';
        pan115EnabledCheckbox.checked = CFG.pan115Enabled;
        pan115EnabledCheckbox.style.marginRight = '8px';
        pan115EnabledGroup.appendChild(pan115EnabledCheckbox);
        pan115EnabledGroup.appendChild(document.createTextNode('启用 115 离线下载功能'));
        pan115Group.appendChild(pan115EnabledGroup);

        const pan115CookieGroup = createSettingGroup('Cookie', '115 网盘完整 Cookie（USERSESSIONID、UID、CID 等参数），通过浏览器开发者工具复制。');
        const pan115CookieInput = document.createElement('textarea');
        pan115CookieInput.value = CFG.pan115Cookie;
        pan115CookieInput.rows = 4;
        pan115CookieInput.placeholder = 'USERSESSIONID=...; UID=...; CID=...; SEID=...';
        pan115CookieInput.style.cssText = 'width: 100%; padding: 8px; border: 1px solid #ddd; border-radius: 4px; font-family: monospace;';
        pan115CookieGroup.appendChild(pan115CookieInput);
        attachSensitiveFieldControls(pan115CookieGroup, pan115CookieInput);
        pan115Group.appendChild(pan115CookieGroup);

        const pan115UserAgentGroup = createSettingGroup('User-Agent (可选)', '默认使用当前浏览器 UA，如需仿真 115 浏览器可在此自定义。');
        const pan115UserAgentInput = document.createElement('input');
        pan115UserAgentInput.type = 'text';
        pan115UserAgentInput.value = CFG.pan115UserAgent || '';
        pan115UserAgentInput.placeholder = navigator.userAgent;
        pan115UserAgentInput.style.cssText = 'width: 100%; padding: 8px; border: 1px solid #ddd; border-radius: 4px; font-family: monospace;';
        pan115UserAgentGroup.appendChild(pan115UserAgentInput);
        pan115Group.appendChild(pan115UserAgentGroup);

        const pan115CredentialActions = document.createElement('div');
        pan115CredentialActions.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap;margin:4px 0 10px;';
        const pan115TestButton = document.createElement('button');
        pan115TestButton.type = 'button'; pan115TestButton.textContent = '测试 115 连接';
        const pan115ClearButton = document.createElement('button');
        pan115ClearButton.type = 'button'; pan115ClearButton.textContent = '清除 115 凭据';
        [pan115TestButton, pan115ClearButton].forEach(button => { button.style.cssText = 'padding:6px 10px;border:1px solid #999;border-radius:4px;background:#fff;cursor:pointer;'; });
        pan115TestButton.addEventListener('click', async () => {
            pan115TestButton.disabled = true; pan115TestButton.textContent = '测试中…';
            try {
                const result = await testCloudProviderConnection('pan115', { cookie: pan115CookieInput.value, userAgent: pan115UserAgentInput.value });
                showToast(`115 连接成功（UID: ${result.uid}）`, 'success');
            } catch (error) { showToast(`115 连接失败：${describeRequestError(error)}`, 'error', 5000); }
            finally { pan115TestButton.disabled = false; pan115TestButton.textContent = '测试 115 连接'; }
        });
        pan115ClearButton.addEventListener('click', () => {
            pan115CookieInput.value = ''; pan115UserAgentInput.value = '';
            showToast('115 凭据输入框已清空，保存设置后生效', 'info');
        });
        pan115CredentialActions.append(pan115TestButton, pan115ClearButton);
        pan115Group.appendChild(pan115CredentialActions);

        const pan115UploadDirGroup = createSettingGroup('保存目录 ID (可选)', '填写 115 网盘目标目录 ID (wp_path_id)。留空则使用默认离线目录。');
        const pan115UploadDirInput = document.createElement('input');
        pan115UploadDirInput.type = 'text';
        pan115UploadDirInput.value = CFG.pan115UploadDir || '';
        pan115UploadDirInput.placeholder = '例如：3139826240074917796';
        pan115UploadDirInput.style.cssText = 'width: 100%; padding: 8px; border: 1px solid #ddd; border-radius: 4px;';
        pan115UploadDirGroup.appendChild(pan115UploadDirInput);
        pan115Group.appendChild(pan115UploadDirGroup);

        const pan115Hint = document.createElement('div');
        pan115Hint.style.cssText = 'font-size: 12px; color: #888; line-height: 1.5;';
        pan115Hint.innerHTML = '• 115 支持 ED2K、磁力链接离线下载<br>• 提交任务前脚本会自动获取 sign/time/uid<br>• 请确保 Cookie 信息最新，必要时在 115 官方网站重新复制';
        pan115Group.appendChild(pan115Hint);

        const pan115FolderGroup = createSettingGroup('文件夹管理', '为 115 离线创建或管理专用文件夹');
        const pan115FolderInfo = document.createElement('div');
        pan115FolderInfo.id = 'sht-pan115-folder-info';
        pan115FolderInfo.style.cssText = 'font-size: 12px; color: #666; margin-bottom: 10px; line-height: 1.5;';
        pan115FolderGroup.appendChild(pan115FolderInfo);

        const pan115FolderButtons = document.createElement('div');
        pan115FolderButtons.style.cssText = 'display: flex; gap: 10px; flex-wrap: wrap;';

        const pan115CreateFolderBtn = document.createElement('button');
        pan115CreateFolderBtn.type = 'button';
        setIconLabel(pan115CreateFolderBtn, 'folder', '新建 115 文件夹');
        pan115CreateFolderBtn.style.cssText = `
    padding: 8px 16px;
    background: linear-gradient(135deg, #f6c343 0%, #f49f0a 100%);
    color: #3b2f09;
    border: none;
    border-radius: 4px;
    cursor: pointer;
    font-weight: bold;
    display: flex;
    align-items: center;
    gap: 4px;
  `;
        pan115CreateFolderBtn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            showCreate115FolderDialog();
        });

        pan115FolderButtons.appendChild(pan115CreateFolderBtn);
        pan115FolderGroup.appendChild(pan115FolderButtons);
        pan115Group.appendChild(pan115FolderGroup);

        pan115Form.appendChild(pan115Group);
        pan115Tab.appendChild(pan115Form);
        refreshPan115FolderInfo();

        // ===== 123Pan 离线下载配置 =====
        const pan123Group = document.createElement('div');
        pan123Group.style.cssText = 'margin: 8px 0; display: flex; flex-direction: column;';
        const pan123Label = document.createElement('label');
        pan123Label.textContent = '123Pan 离线下载:';
        pan123Label.style.cssText = 'margin-bottom: 4px; font-size: 12px; color: #666;';
        pan123Group.appendChild(pan123Label);

        // 启用 123Pan
        const pan123EnabledCheckbox = document.createElement('input');
        pan123EnabledCheckbox.type = 'checkbox';
        pan123EnabledCheckbox.checked = CFG.pan123Enabled;
        pan123EnabledCheckbox.style.marginRight = '8px';
        const pan123EnabledGroup = document.createElement('div');
        pan123EnabledGroup.style.cssText = 'margin: 8px 0; display: flex; align-items: center;';
        pan123EnabledGroup.appendChild(pan123EnabledCheckbox);
        pan123EnabledGroup.appendChild(document.createTextNode('启用 123Pan 离线下载功能'));
        pan123Group.appendChild(pan123EnabledGroup);

        // Token 配置
        const pan123TokenGroup = createSettingGroup('Token', '123Pan API Token (Bearer 开头)');
        const pan123TokenInput = document.createElement('input');
        pan123TokenInput.type = 'text';
        pan123TokenInput.value = CFG.pan123Token;
        pan123TokenInput.placeholder = 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...';
        pan123TokenInput.style.cssText = 'width: 100%; padding: 8px; border: 1px solid #ddd; border-radius: 4px; font-family: monospace;';
        pan123TokenGroup.appendChild(pan123TokenInput);
        attachSensitiveFieldControls(pan123TokenGroup, pan123TokenInput);
        pan123Group.appendChild(pan123TokenGroup);

        // Login UUID 配置
        const pan123LoginUuidGroup = createSettingGroup('Login UUID', '123Pan 登录 UUID');
        const pan123LoginUuidInput = document.createElement('input');
        pan123LoginUuidInput.type = 'text';
        pan123LoginUuidInput.value = CFG.pan123LoginUuid;
        pan123LoginUuidInput.placeholder = '7ab2526ea059412c87f7ff866ff5c2ac...';
        pan123LoginUuidInput.style.cssText = 'width: 100%; padding: 8px; border: 1px solid #ddd; border-radius: 4px; font-family: monospace;';
        pan123LoginUuidGroup.appendChild(pan123LoginUuidInput);
        attachSensitiveFieldControls(pan123LoginUuidGroup, pan123LoginUuidInput);
        pan123Group.appendChild(pan123LoginUuidGroup);

        // Cookie 配置
        const pan123CookieGroup = createSettingGroup('Cookie', '123Pan Cookie');
        const pan123CookieInput = document.createElement('textarea');
        pan123CookieInput.value = CFG.pan123Cookie;
        pan123CookieInput.rows = 3;
        pan123CookieInput.placeholder = 'cna=xxx; HMACCOUNT=xxx; ...';
        pan123CookieInput.style.cssText = 'width: 100%; padding: 8px; border: 1px solid #ddd; border-radius: 4px; font-family: monospace;';
        pan123CookieGroup.appendChild(pan123CookieInput);
        attachSensitiveFieldControls(pan123CookieGroup, pan123CookieInput);
        pan123Group.appendChild(pan123CookieGroup);

        const pan123CredentialActions = document.createElement('div');
        pan123CredentialActions.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap;margin:4px 0 10px;';
        const pan123TestButton = document.createElement('button');
        pan123TestButton.type = 'button'; pan123TestButton.textContent = '测试 123Pan 连接';
        const pan123ClearButton = document.createElement('button');
        pan123ClearButton.type = 'button'; pan123ClearButton.textContent = '清除 123Pan 凭据';
        [pan123TestButton, pan123ClearButton].forEach(button => { button.style.cssText = 'padding:6px 10px;border:1px solid #999;border-radius:4px;background:#fff;cursor:pointer;'; });
        pan123TestButton.addEventListener('click', async () => {
            pan123TestButton.disabled = true; pan123TestButton.textContent = '测试中…';
            try {
                await testCloudProviderConnection('pan123', {
                    token: pan123TokenInput.value, loginUuid: pan123LoginUuidInput.value, cookie: pan123CookieInput.value
                });
                showToast('123Pan 连接成功', 'success');
            } catch (error) { showToast(`123Pan 连接失败：${describeRequestError(error)}`, 'error', 5000); }
            finally { pan123TestButton.disabled = false; pan123TestButton.textContent = '测试 123Pan 连接'; }
        });
        pan123ClearButton.addEventListener('click', () => {
            pan123TokenInput.value = ''; pan123LoginUuidInput.value = ''; pan123CookieInput.value = '';
            showToast('123Pan 凭据输入框已清空，保存设置后生效', 'info');
        });
        pan123CredentialActions.append(pan123TestButton, pan123ClearButton);
        pan123Group.appendChild(pan123CredentialActions);

        // 上传目录配置
        const pan123UploadDirGroup = createSettingGroup('上传目录 ID', '123Pan 上传目录 ID (可选)');
        const pan123UploadDirInput = document.createElement('input');
        pan123UploadDirInput.type = 'text';
        pan123UploadDirInput.value = CFG.pan123UploadDir;
        pan123UploadDirInput.placeholder = '123456';
        pan123UploadDirInput.style.cssText = 'width: 100%; padding: 8px; border: 1px solid #ddd; border-radius: 4px;';
        pan123UploadDirGroup.appendChild(pan123UploadDirInput);
        pan123Group.appendChild(pan123UploadDirGroup);

        // 文件过滤配置
        const pan123FilterGroup = document.createElement('div');
        pan123FilterGroup.style.cssText = 'margin: 8px 0; display: flex; flex-direction: column;';
        const pan123FilterLabel = document.createElement('label');
        pan123FilterLabel.textContent = '文件过滤配置:';
        pan123FilterLabel.style.cssText = 'margin-bottom: 4px; font-size: 12px; color: #666;';
        pan123FilterGroup.appendChild(pan123FilterLabel);

        // 最小文件大小
        const pan123MinSizeGroup = createSettingGroup('最小文件大小', '例如: 10MB');
        const pan123MinSizeInput = document.createElement('input');
        pan123MinSizeInput.type = 'text';
        pan123MinSizeInput.value = CFG.pan123MinSize;
        pan123MinSizeInput.placeholder = '10MB';
        pan123MinSizeInput.style.cssText = 'width: 100%; padding: 8px; border: 1px solid #ddd; border-radius: 4px;';
        pan123MinSizeGroup.appendChild(pan123MinSizeInput);
        pan123FilterGroup.appendChild(pan123MinSizeGroup);

        // 最大文件大小
        const pan123MaxSizeGroup = createSettingGroup('最大文件大小', '例如: 1000GB');
        const pan123MaxSizeInput = document.createElement('input');
        pan123MaxSizeInput.type = 'text';
        pan123MaxSizeInput.value = CFG.pan123MaxSize;
        pan123MaxSizeInput.placeholder = '1000GB';
        pan123MaxSizeInput.style.cssText = 'width: 100%; padding: 8px; border: 1px solid #ddd; border-radius: 4px;';
        pan123MaxSizeGroup.appendChild(pan123MaxSizeInput);
        pan123FilterGroup.appendChild(pan123MaxSizeGroup);

        // 包含扩展名
        const pan123IncludeExtGroup = createSettingGroup('包含扩展名', '逗号分隔，例如: mp4,avi,mkv');
        const pan123IncludeExtInput = document.createElement('input');
        pan123IncludeExtInput.type = 'text';
        pan123IncludeExtInput.value = CFG.pan123IncludeExt;
        pan123IncludeExtInput.placeholder = 'mp4,avi,mkv,wmv,flv,mov';
        pan123IncludeExtInput.style.cssText = 'width: 100%; padding: 8px; border: 1px solid #ddd; border-radius: 4px;';
        pan123IncludeExtGroup.appendChild(pan123IncludeExtInput);
        pan123FilterGroup.appendChild(pan123IncludeExtGroup);

        // 排除扩展名
        const pan123ExcludeExtGroup = createSettingGroup('排除扩展名', '逗号分隔，例如: txt,nfo,jpg,png');
        const pan123ExcludeExtInput = document.createElement('input');
        pan123ExcludeExtInput.type = 'text';
        pan123ExcludeExtInput.value = CFG.pan123ExcludeExt;
        pan123ExcludeExtInput.placeholder = 'txt,nfo,srt,sub,url,mht,jpg,jpeg,png,gif,bmp,webp,ico,svg';
        pan123ExcludeExtInput.style.cssText = 'width: 100%; padding: 8px; border: 1px solid #ddd; border-radius: 4px;';
        pan123ExcludeExtGroup.appendChild(pan123ExcludeExtInput);
        pan123FilterGroup.appendChild(pan123ExcludeExtGroup);

        // 视频文件最小大小
        const pan123VideoMinSizeGroup = createSettingGroup('视频文件最小大小', '例如: 100MB');
        const pan123VideoMinSizeInput = document.createElement('input');
        pan123VideoMinSizeInput.type = 'text';
        pan123VideoMinSizeInput.value = CFG.pan123VideoMinSize;
        pan123VideoMinSizeInput.placeholder = '100MB';
        pan123VideoMinSizeInput.style.cssText = 'width: 100%; padding: 8px; border: 1px solid #ddd; border-radius: 4px;';
        pan123VideoMinSizeGroup.appendChild(pan123VideoMinSizeInput);
        pan123FilterGroup.appendChild(pan123VideoMinSizeGroup);

        // 选择最大文件
        const pan123PickLargestCheckbox = document.createElement('input');
        pan123PickLargestCheckbox.type = 'checkbox';
        pan123PickLargestCheckbox.checked = CFG.pan123PickLargest;
        pan123PickLargestCheckbox.style.marginRight = '8px';
        const pan123PickLargestGroup = document.createElement('div');
        pan123PickLargestGroup.style.cssText = 'margin: 8px 0; display: flex; align-items: center;';
        pan123PickLargestGroup.appendChild(pan123PickLargestCheckbox);
        pan123PickLargestGroup.appendChild(document.createTextNode('只选择最大的文件'));
        pan123FilterGroup.appendChild(pan123PickLargestGroup);

        pan123Group.appendChild(pan123FilterGroup);

        // 秒离线处理配置
        const pan123InstantGroup = document.createElement('div');
        pan123InstantGroup.style.cssText = 'margin: 8px 0; display: flex; flex-direction: column;';
        const pan123InstantLabel = document.createElement('label');
        pan123InstantLabel.textContent = '秒离线处理:';
        pan123InstantLabel.style.cssText = 'margin-bottom: 4px; font-size: 12px; color: #666;';
        pan123InstantGroup.appendChild(pan123InstantLabel);

        // 秒离线处理方式选择
        const pan123InstantActionGroup = document.createElement('div');
        pan123InstantActionGroup.style.cssText = 'margin: 8px 0; display: flex; flex-direction: column; gap: 8px;';

        const pan123InstantActionLabel = document.createElement('label');
        pan123InstantActionLabel.textContent = '秒离线失败时的处理方式:';
        pan123InstantActionLabel.style.cssText = 'font-size: 12px; color: #333;';
        pan123InstantActionGroup.appendChild(pan123InstantActionLabel);

        const pan123InstantActionSelect = document.createElement('select');
        pan123InstantActionSelect.style.cssText = 'padding: 4px 8px; border: 1px solid #ddd; border-radius: 4px; font-size: 12px;';
        pan123InstantActionSelect.innerHTML = `
    <option value="auto_cancel">自动取消任务</option>
    <option value="ask_user">询问用户是否取消</option>
    <option value="keep_task">保留任务</option>
  `;
        pan123InstantActionSelect.value = CFG.pan123InstantOfflineAction || 'auto_cancel';
        pan123InstantActionGroup.appendChild(pan123InstantActionSelect);

        // 检查延迟时间
        const pan123DelayGroup = document.createElement('div');
        pan123DelayGroup.style.cssText = 'margin: 8px 0; display: flex; align-items: center; gap: 8px;';

        const pan123DelayLabel = document.createElement('label');
        pan123DelayLabel.textContent = '检查延迟时间(毫秒):';
        pan123DelayLabel.style.cssText = 'font-size: 12px; color: #333; min-width: 120px;';
        pan123DelayGroup.appendChild(pan123DelayLabel);

        const pan123DelayInput = document.createElement('input');
        pan123DelayInput.type = 'number';
        pan123DelayInput.value = CFG.pan123InstantOfflineCheckDelay || 2000;
        pan123DelayInput.min = '1000';
        pan123DelayInput.max = '10000';
        pan123DelayInput.step = '500';
        pan123DelayInput.style.cssText = 'padding: 4px 8px; border: 1px solid #ddd; border-radius: 4px; font-size: 12px; width: 100px;';
        pan123DelayGroup.appendChild(pan123DelayInput);

        // 批量发送间隔时间
        const pan123BatchIntervalGroup = document.createElement('div');
        pan123BatchIntervalGroup.style.cssText = 'margin: 8px 0; display: flex; align-items: center; gap: 8px;';

        const pan123BatchIntervalLabel = document.createElement('label');
        pan123BatchIntervalLabel.textContent = '批量发送间隔(毫秒):';
        pan123BatchIntervalLabel.style.cssText = 'font-size: 12px; color: #333; min-width: 120px;';
        pan123BatchIntervalGroup.appendChild(pan123BatchIntervalLabel);

        const pan123BatchIntervalInput = document.createElement('input');
        pan123BatchIntervalInput.type = 'number';
        pan123BatchIntervalInput.value = CFG.pan123BatchSendInterval || 2000;
        pan123BatchIntervalInput.min = '100';
        pan123BatchIntervalInput.max = '60000';
        pan123BatchIntervalInput.step = '100';
        pan123BatchIntervalInput.style.cssText = 'padding: 4px 8px; border: 1px solid #ddd; border-radius: 4px; font-size: 12px; width: 100px;';
        pan123BatchIntervalGroup.appendChild(pan123BatchIntervalInput);

        pan123InstantGroup.appendChild(pan123InstantActionGroup);
        pan123InstantGroup.appendChild(pan123DelayGroup);
        pan123InstantGroup.appendChild(pan123BatchIntervalGroup);
        pan123Group.appendChild(pan123InstantGroup);

        // 123Pan文件夹管理
        const folderGroup = createSettingGroup('文件夹管理', '123Pan文件夹操作');
        const pan123FolderInfo = document.createElement('div');
        pan123FolderInfo.id = 'sht-pan123-folder-info';
        pan123FolderInfo.style.cssText = 'font-size: 12px; color: #666; margin-bottom: 10px; line-height: 1.5;';
        folderGroup.appendChild(pan123FolderInfo);
        const folderButtonsGroup = document.createElement('div');
        folderButtonsGroup.style.cssText = 'margin: 8px 0; display: flex; gap: 10px; flex-wrap: wrap;';

        const createFolderBtn = document.createElement('button');
        setIconLabel(createFolderBtn, 'folder', '123 新建');
        createFolderBtn.style.cssText = `
    padding: 8px 16px;
    background: linear-gradient(135deg, #28a745 0%, #1e7e34 100%);
    color: white;
    border: none;
    border-radius: 4px;
    cursor: pointer;
    font-weight: bold;
    display: flex;
    align-items: center;
    gap: 4px;
  `;
        createFolderBtn.addEventListener('mouseenter', () => {
            createFolderBtn.style.background = 'linear-gradient(135deg, #1e7e34 0%, #155724 100%)';
            createFolderBtn.style.transform = 'translateY(-1px)';
            createFolderBtn.style.boxShadow = '0 2px 6px rgba(0,0,0,0.15)';
        });
        createFolderBtn.addEventListener('mouseleave', () => {
            createFolderBtn.style.background = 'linear-gradient(135deg, #28a745 0%, #1e7e34 100%)';
            createFolderBtn.style.transform = 'translateY(0)';
            createFolderBtn.style.boxShadow = '0 1px 3px rgba(0,0,0,0.1)';
        });
        createFolderBtn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            showCreateFolderDialog();
        });

        folderButtonsGroup.appendChild(createFolderBtn);
        folderGroup.appendChild(folderButtonsGroup);

        // 将 123Pan 设置添加到 123Pan 标签页
        const pan123Form = document.createElement('form');
        pan123Form.style.cssText = 'display: grid; gap: 15px;';
        pan123Form.appendChild(pan123Group);
        pan123Form.appendChild(folderGroup);
        pan123Tab.appendChild(pan123Form);
        refreshPan123FolderInfo();

        // 将所有标签页添加到内容区域
        contentArea.appendChild(basicTab);
        contentArea.appendChild(displayTab);
        contentArea.appendChild(collectionTab);
        contentArea.appendChild(pan115Tab);
        contentArea.appendChild(pan123Tab);
        contentArea.appendChild(advancedTab);

        // 按钮区域
        const buttonArea = document.createElement('div');
        buttonArea.style.cssText = 'padding: 15px 20px; border-top: 1px solid #eee; background: #f8f9fa;';

        const buttonGroup = document.createElement('div');
        buttonGroup.style.cssText = 'display: flex; gap: 10px; justify-content: flex-end;';

        const cancelBtn = document.createElement('button');
        cancelBtn.textContent = '取消';
        cancelBtn.type = 'button';
        cancelBtn.style.cssText = 'padding: 8px 16px; border: 1px solid #ddd; background: #f5f5f5; border-radius: 4px; cursor: pointer;';
        cancelBtn.onclick = () => dialog.remove();

        const saveBtn = document.createElement('button');
        saveBtn.textContent = '保存设置';
        saveBtn.type = 'button';
        saveBtn.style.cssText = 'padding: 8px 16px; border: none; background: #007cba; color: white; border-radius: 4px; cursor: pointer;';
        saveBtn.onclick = () => {
            // 保存设置
            CFG.passwordCandidates = pwdInput.value.split('\n').map(s => s.trim()).filter(Boolean);
            CFG.maxAutoBytes = parseInt(autoInput.value) || 2 * 1024 * 1024;
            CFG.maxEntryBytes = parseInt(entryInput.value) || 3 * 1024 * 1024;
            CFG.autoHoistToTop = hoistCheckbox.checked;
            CFG.blockImages = imgCheckbox.checked;
            CFG.imageAllowDomains = whiteInput.value.split(',').map(s => s.trim()).filter(Boolean);
            CFG.imagePlaceholderShowMeta = metaCheckbox.checked;
            CFG.autoCollectED2K = ed2kCheckbox.checked;
            CFG.autoCollectMagnet = magnetCheckbox.checked;

            // ED2K文件名替换设置
            CFG.ed2kFileNameReplaceEnabled = ed2kReplaceCheckbox.checked;

            // 收集替换规则
            const ed2kRules = [];
            const ruleDivs = rulesList.querySelectorAll('div');
            ruleDivs.forEach(ruleDiv => {
                const inputs = ruleDiv.querySelectorAll('input');
                if (inputs.length >= 2) {
                    const pattern = inputs[0].value.trim();
                    const replacement = inputs[1].value.trim();
                    if (pattern) {
                        ed2kRules.push({ pattern, replacement });
                    }
                }
            });
            CFG.ed2kFileNameReplaceRules = ed2kRules;
            CFG.authorOnlyMode = authorOnlyCheckbox.checked;
            CFG.enableHistory = historyCheckbox.checked;
            CFG.maxHistoryItems = parseInt(historyLimitInput.value) || 1000;

            // 排版优化设置
            CFG.hideReplyColumn = hideReplyCheckbox.checked;
            CFG.hideLastReplyColumn = hideLastReplyCheckbox.checked;
            CFG.hideAuthorColumn = hideAuthorCheckbox.checked;
            CFG.hideStickyThreads = hideStickyCheckbox.checked;

            // 分页和过滤设置
            CFG.hidePagination = hidePaginationCheckbox.checked;
            CFG.enhanceTitles = enhanceTitlesCheckbox.checked;
            CFG.enableKeywordFilter = keywordFilterCheckbox.checked;
            CFG.keywordFilters = keywordTextarea.value.split('\n').filter(line => line.trim() !== '');

            // 列表页标题正则替换设置
            CFG.enableListTitleEnhance = listTitleCheckbox.checked;
            const listRulesText = listRulesTextarea.value.split('\n').filter(line => line.trim() !== '');
            CFG.listTitleReplaceRules = listRulesText.map(line => {
                const parts = line.split('|');
                return {
                    pattern: parts[0] || '',
                    replacement: parts[1] || ''
                };
            });

            // 历史访问帖子处理设置
            CFG.historyPostAction = historyPostSelect.value;
            CFG.historyPostColor = colorInput.value;

            // 帖子详情标题处理设置
            CFG.enableThreadTitleEnhance = threadTitleCheckbox.checked;
            const rulesText = rulesTextarea.value.split('\n').filter(line => line.trim() !== '');
            CFG.titleReplaceRules = rulesText.map(line => {
                const parts = line.split('|');
                return {
                    pattern: parts[0] || '',
                    replacement: parts[1] || ''
                };
            });
            CFG.hideTypeLabels = hideTypeCheckbox.checked ? ['情色分享', '图文故事', '视频分享'] : [];

            // 论坛模块屏蔽
            CFG.enableModuleFilter = moduleFilterCheckbox.checked;
            CFG.hiddenModules = moduleTextarea.value.split('\n').filter(s => s.trim());

            // 一键评分设置
            CFG.enableQuickRate = quickRateCheckbox.checked;
            CFG.defaultRateScore = parseInt(rateScoreInput.value) || 2;
            CFG.defaultRateReason = reasonInput.value.trim() || '很给力!';

            CFG.toolbarCompactMode = compactModeCheckbox.checked;
            CFG.credentialsSessionOnly = sessionCredentialsCheckbox.checked;
            CFG.debugMode = debugModeCheckbox.checked;
            CFG.cloudTaskConcurrency = Math.max(1, Math.min(4, parseInt(cloudConcurrencyInput.value, 10) || 2));

            // 115 离线设置
            CFG.pan115Enabled = pan115EnabledCheckbox.checked;
            CFG.pan115Cookie = pan115CookieInput.value.trim();
            CFG.pan115UserAgent = pan115UserAgentInput.value.trim();
            CFG.pan115UploadDir = pan115UploadDirInput.value.trim();

            // 123Pan 设置
            CFG.pan123Enabled = pan123EnabledCheckbox.checked;
            CFG.pan123Token = pan123TokenInput.value.trim();
            CFG.pan123LoginUuid = pan123LoginUuidInput.value.trim();
            CFG.pan123Cookie = pan123CookieInput.value.trim();
            CFG.pan123UploadDir = pan123UploadDirInput.value.trim();
            CFG.pan123MinSize = pan123MinSizeInput.value.trim();
            CFG.pan123MaxSize = pan123MaxSizeInput.value.trim();
            CFG.pan123IncludeExt = pan123IncludeExtInput.value.trim();
            CFG.pan123ExcludeExt = pan123ExcludeExtInput.value.trim();
            CFG.pan123VideoMinSize = pan123VideoMinSizeInput.value.trim();
            CFG.pan123PickLargest = pan123PickLargestCheckbox.checked;
            CFG.pan123InstantOfflineAction = pan123InstantActionSelect.value;
            CFG.pan123InstantOfflineCheckDelay = parseInt(pan123DelayInput.value) || 2000;
            CFG.pan123BatchSendInterval = parseInt(pan123BatchIntervalInput.value) || 2000;

            saveConfig();
            dialog.remove();

            // 应用设置
            if (CFG.blockImages) applyImageBlocking(true, { forceRebuild: true }); else resetImageState();
            queueED2KScan(true); queueMagnetScan(true);

            // 应用排版设置
            applyLayoutSettings();

            // 应用论坛模块屏蔽
            if (isForumListPage || isForumHomePage) {
                applyModuleFilter();
            }

            if (CFG.credentialsSessionOnly) {
                showToast('设置已保存；临时凭据已在当前页面生效，刷新或离开页面即清除', 'success', 5000);
            } else {
                showToast('设置已保存，页面将刷新以应用新设置', 'success');
                setTimeout(() => location.reload(), 1000);
            }
        };

        buttonGroup.appendChild(cancelBtn);
        buttonGroup.appendChild(saveBtn);
        buttonArea.appendChild(buttonGroup);

        // 组装对话框
        panel.appendChild(title);
        panel.appendChild(tabNav);
        panel.appendChild(contentArea);
        panel.appendChild(buttonArea);
        dialog.appendChild(panel);
        document.body.appendChild(dialog);

        // 点击背景关闭
        dialog.onclick = (e) => { if (e.target === dialog) dialog.remove(); };
    }

    function createSettingGroup(title, description) {
        const group = document.createElement('div');
        group.style.cssText = 'border: 1px solid #eee; border-radius: 6px; padding: 15px; background: #fafafa;';

        const titleEl = document.createElement('div');
        titleEl.textContent = title;
        titleEl.style.cssText = 'font-weight: bold; margin-bottom: 5px; color: #333;';

        const descEl = document.createElement('div');
        descEl.textContent = description;
        descEl.style.cssText = 'font-size: 12px; color: #666; margin-bottom: 10px;';

        const inputContainer = document.createElement('div');

        group.appendChild(titleEl);
        group.appendChild(descEl);
        group.appendChild(inputContainer);

        // 返回输入容器，用于添加输入控件
        group.inputContainer = inputContainer;
        group.appendChild = (child) => inputContainer.appendChild(child);

        return group;
    }

    function attachSensitiveFieldControls(group, field) {
        let revealed = false;
        const applyMask = () => {
            if (field.tagName === 'INPUT') field.type = revealed ? 'text' : 'password';
            else field.style.webkitTextSecurity = revealed ? 'none' : 'disc';
        };
        applyMask();
        field.autocomplete = 'off';
        field.spellcheck = false;
        const actions = document.createElement('div');
        actions.style.cssText = 'display:flex;gap:8px;margin-top:6px;';
        const reveal = document.createElement('button');
        reveal.type = 'button'; reveal.textContent = '显示';
        const clear = document.createElement('button');
        clear.type = 'button'; clear.textContent = '清空';
        [reveal, clear].forEach(button => { button.style.cssText = 'padding:3px 8px;border:1px solid #aaa;border-radius:4px;background:#fff;cursor:pointer;font-size:12px;'; });
        reveal.addEventListener('click', () => {
            revealed = !revealed;
            applyMask();
            reveal.textContent = revealed ? '隐藏' : '显示';
        });
        clear.addEventListener('click', () => { field.value = ''; });
        actions.append(reveal, clear);
        group.appendChild(actions);
    }
