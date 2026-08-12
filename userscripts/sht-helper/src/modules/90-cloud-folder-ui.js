    // 清理标题用于文件夹名称
    function cleanTitleForFolder(title) {
        if (!title) return `文件夹_${new Date().toISOString().slice(0, 10)}`;

        return title
            .replace(/[<>:"/\\|?*]/g, '')  // 移除Windows不允许的字符
            .replace(/[\r\n\t]/g, ' ')     // 替换换行符和制表符为空格
            .replace(/\s+/g, ' ')          // 合并多个空格
            .trim()                        // 去除首尾空格
            .substring(0, 100);            // 限制长度
    }

    // 获取当前帖子标题
    function getCurrentThreadTitle() {
        const titleElement = document.querySelector('#thread_subject');
        if (titleElement) {
            return titleElement.textContent?.trim() || '';
        }

        // 备用方案：从页面标题获取
        const pageTitle = document.title;
        if (pageTitle && pageTitle !== '色花堂') {
            return pageTitle.replace(' - 色花堂', '').trim();
        }

        return '';
    }

    // 获取当前帖子URL
    function getCurrentThreadUrl() {
        return window.location.href;
    }

    // 检查当前帖子是否有对应的文件夹
    function checkCurrentThreadFolder() {
        const currentUrl = getCurrentThreadUrl();
        const folderId = CFG.pan123ThreadFolders[currentUrl];

        if (folderId) {
            CFG.pan123CurrentThreadFolder = folderId;
            return true;
        }

        CFG.pan123CurrentThreadFolder = '';
        return false;
    }

    // 保存当前帖子的文件夹映射
    function saveCurrentThreadFolder(folderId) {
        const currentUrl = getCurrentThreadUrl();
        CFG.pan123ThreadFolders[currentUrl] = folderId;
        CFG.pan123CurrentThreadFolder = folderId;
        refreshPan123FolderInfo();
        saveConfig();
    }

    // 显示创建文件夹对话框
    function showCreateFolderDialog() {
        if (!CFG.pan123Enabled || !CFG.pan123Token || !CFG.pan123LoginUuid || !CFG.pan123Cookie) {
            showWarningModal('请先在设置中配置 123Pan 认证信息');
            return;
        }

        const currentTitle = getCurrentThreadTitle();
        const cleanTitle = cleanTitleForFolder(currentTitle);

        const modal = createModal('创建123Pan文件夹', '', 'info', { showConfirm: false });
        const content = document.createElement('div');
        content.style.cssText = 'padding: 20px; text-align: left;';

        // 标题说明
        const titleLabel = document.createElement('div');
        titleLabel.textContent = '文件夹名称：';
        titleLabel.style.cssText = 'margin-bottom: 8px; font-weight: bold; color: #333;';
        content.appendChild(titleLabel);

        // 输入框
        const input = document.createElement('input');
        input.type = 'text';
        input.value = cleanTitle;
        input.placeholder = '请输入文件夹名称';
        input.style.cssText = 'width: 100%; padding: 10px; border: 1px solid #ddd; border-radius: 4px; font-size: 14px; margin-bottom: 15px;';
        content.appendChild(input);

        // 选项组
        const optionsGroup = document.createElement('div');
        optionsGroup.style.cssText = 'margin-bottom: 15px;';

        const optionsLabel = document.createElement('div');
        optionsLabel.textContent = '创建后操作：';
        optionsLabel.style.cssText = 'margin-bottom: 8px; font-weight: bold; color: #333;';
        optionsGroup.appendChild(optionsLabel);

        const setAsDefaultOption = document.createElement('label');
        setAsDefaultOption.style.cssText = 'display: block; margin-bottom: 8px; cursor: pointer;';
        const setAsDefaultCheckbox = document.createElement('input');
        setAsDefaultCheckbox.type = 'checkbox';
        setAsDefaultCheckbox.checked = false;
        setAsDefaultCheckbox.style.cssText = 'margin-right: 8px;';
        setAsDefaultOption.appendChild(setAsDefaultCheckbox);
        setAsDefaultOption.appendChild(document.createTextNode('设为默认文件夹（影响所有新帖子）'));
        optionsGroup.appendChild(setAsDefaultOption);

        const setAsCurrentOption = document.createElement('label');
        setAsCurrentOption.style.cssText = 'display: block; margin-bottom: 8px; cursor: pointer;';
        const setAsCurrentCheckbox = document.createElement('input');
        setAsCurrentCheckbox.type = 'checkbox';
        setAsCurrentCheckbox.checked = true;
        setAsCurrentCheckbox.style.cssText = 'margin-right: 8px;';
        setAsCurrentOption.appendChild(setAsCurrentCheckbox);
        setAsCurrentOption.appendChild(document.createTextNode('设为本次离线文件夹（仅影响当前帖子）'));
        optionsGroup.appendChild(setAsCurrentOption);

        content.appendChild(optionsGroup);

        // 说明文字
        const helpText = document.createElement('div');
        helpText.style.cssText = 'font-size: 12px; color: #666; margin-bottom: 15px; line-height: 1.4;';
        helpText.innerHTML = `
    <div>• 默认使用当前帖子标题作为文件夹名称</div>
    <div>• 已自动清理特殊字符，您可以根据需要修改</div>
    <div>• 建议选择"设为本次离线文件夹"避免嵌套问题</div>
  `;
        content.appendChild(helpText);

        // 按钮组
        const buttonGroup = document.createElement('div');
        buttonGroup.style.cssText = 'display: flex; gap: 10px; justify-content: flex-end;';

        const cancelBtn = document.createElement('button');
        cancelBtn.textContent = '取消';
        cancelBtn.style.cssText = 'padding: 8px 16px; background: #6c757d; color: white; border: none; border-radius: 4px; cursor: pointer;';
        cancelBtn.onclick = () => modal.closeSht();

        const createBtn = document.createElement('button');
        setIconLabel(createBtn, 'folder', '创建文件夹');
        createBtn.style.cssText = 'padding: 8px 16px; background: linear-gradient(135deg, #007cba 0%, #005a87 100%); color: white; border: none; border-radius: 4px; cursor: pointer; font-weight: bold;';

        createBtn.onclick = async () => {
            const folderName = input.value.trim();
            if (!folderName) {
                showErrorModal('请输入文件夹名称');
                return;
            }

            createBtn.disabled = true;
            createBtn.textContent = '创建中...';

            try {
                const result = await apiCreateFolder(folderName);

                if (result.code === 0 && result.data?.Info) {
                    const folderId = result.data.Info.FileId;
                    const folderName = result.data.Info.FileName;

                    let message = `文件夹创建成功！\n\n文件夹名称：${folderName}\n文件夹ID：${folderId}\n\n`;

                    // 根据用户选择执行不同操作
                    if (setAsDefaultCheckbox.checked) {
                        CFG.pan123UploadDir = folderId.toString();
                        message += '已设为默认上传目录';
                    }

                    if (setAsCurrentCheckbox.checked) {
                        saveCurrentThreadFolder(folderId.toString());
                        message += (setAsDefaultCheckbox.checked ? '，' : '') + '已设为当前帖子离线文件夹';
                    }

                    saveConfig();
                    showSuccessModal(message);
                    modal.closeSht();

                    // 直接更新按钮显示，使用API返回的文件夹名称
                    const btn = document.querySelector('#sht-create-folder-btn');
                    if (btn) {
                        setIconLabel(btn, 'folder', folderName);
                        btn.title = `当前帖子离线文件夹: ${folderName} (ID: ${folderId})`;
                    }
                    refreshPan123FolderInfo();
                } else {
                    throw new Error(result.message || '创建文件夹失败');
                }
            } catch (error) {
                console.error('创建文件夹失败:', error);
                showErrorModal(`创建文件夹失败: ${error.message}`);
                createBtn.disabled = false;
                setIconLabel(createBtn, 'folder', '创建文件夹');
            }
        };

        buttonGroup.appendChild(cancelBtn);
        buttonGroup.appendChild(createBtn);
        content.appendChild(buttonGroup);

        modal.querySelector('.modal-content').appendChild(content);

        // 自动聚焦输入框
        setTimeout(() => input.focus(), 100);

        // 支持回车键创建
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                createBtn.click();
            }
        });
    }

    // 更新创建文件夹按钮显示
    async function updateCreateFolderButton() {
        const btn = document.querySelector('#sht-create-folder-btn');
        if (!btn) return;

        const currentFolderId = CFG.pan123CurrentThreadFolder;
        if (currentFolderId) {
            // 先显示加载状态
            setIconLabel(btn, 'refresh', '加载中...');
            btn.title = '正在获取文件夹信息...';

            try {
                const folderName = await getFolderNameById(currentFolderId);
                setIconLabel(btn, 'folder', folderName);
                const defaultId = CFG.pan123UploadDir && String(CFG.pan123UploadDir).trim();
                btn.title = `当前帖子离线文件夹: ${folderName} (ID: ${currentFolderId})` + (defaultId ? `\n默认目录 ID: ${defaultId}` : '');
            } catch (error) {
                console.error('获取文件夹名称失败:', error);
                setIconLabel(btn, 'folder', `文件夹_${currentFolderId}`);
                const defaultId = CFG.pan123UploadDir && String(CFG.pan123UploadDir).trim();
                btn.title = `当前帖子离线文件夹: 文件夹_${currentFolderId}` + (defaultId ? `\n默认目录 ID: ${defaultId}` : '');
            }
        } else {
            setIconLabel(btn, 'folder', '123 新建');
            const defaultId = CFG.pan123UploadDir && String(CFG.pan123UploadDir).trim();
            btn.title = defaultId ? `默认目录 ID: ${defaultId}\n点击创建或切换目录` : '尚未设置 123Pan 默认目录，点击创建';
        }
        refreshPan123FolderInfo();
    }

    function checkCurrentThreadFolder115() {
        if (!CFG.pan115ThreadFolders || typeof CFG.pan115ThreadFolders !== 'object') {
            CFG.pan115ThreadFolders = {};
        }
        const currentUrl = getCurrentThreadUrl();
        const folderId = CFG.pan115ThreadFolders[currentUrl];
        if (folderId) {
            CFG.pan115CurrentThreadFolder = folderId;
            return true;
        }
        CFG.pan115CurrentThreadFolder = '';
        return false;
    }

    function saveCurrentThreadFolder115(folderId) {
        if (!folderId) return;
        if (!CFG.pan115ThreadFolders || typeof CFG.pan115ThreadFolders !== 'object') {
            CFG.pan115ThreadFolders = {};
        }
        if (!CFG.pan115FolderNames || typeof CFG.pan115FolderNames !== 'object') {
            CFG.pan115FolderNames = {};
        }
        const currentUrl = getCurrentThreadUrl();
        CFG.pan115ThreadFolders[currentUrl] = folderId;
        CFG.pan115CurrentThreadFolder = folderId;
        refreshPan115FolderInfo();
        saveConfig();
    }

    function clearPan115FolderReference(folderId) {
        if (!folderId) return;
        const idStr = String(folderId);
        if (CFG.pan115FolderNames && typeof CFG.pan115FolderNames === 'object') {
            delete CFG.pan115FolderNames[idStr];
        }
        if (CFG.pan115ThreadFolders && typeof CFG.pan115ThreadFolders === 'object') {
            const currentUrl = getCurrentThreadUrl();
            if (CFG.pan115ThreadFolders[currentUrl] === idStr) {
                delete CFG.pan115ThreadFolders[currentUrl];
                CFG.pan115CurrentThreadFolder = '';
            }
            Object.keys(CFG.pan115ThreadFolders).forEach(url => {
                if (CFG.pan115ThreadFolders[url] === idStr) {
                    delete CFG.pan115ThreadFolders[url];
                }
            });
        }
        if (CFG.pan115UploadDir === idStr) {
            CFG.pan115UploadDir = '';
        }
        refreshPan115FolderInfo();
        updateCreateFolderButton115();
        saveConfig();
    }

    async function pan115ValidateDirectory(folderId) {
        if (!folderId) return false;
        try {
            const info = await api115GetFolderInfo(folderId);
            if (!info) return false;
            if (info.state === false) return false;
            return true;
        } catch (error) {
            console.warn('[115 离线] 目录校验失败:', folderId, error);
            return false;
        }
    }

    async function api115CreateFolder(folderName, parentId = null) {
        ensurePan115Config();
        const pid = parentId !== null
            ? String(parentId)
            : (CFG.pan115CurrentThreadFolder && String(CFG.pan115CurrentThreadFolder).trim())
            || (CFG.pan115UploadDir && String(CFG.pan115UploadDir).trim())
            || '0';

        const params = new URLSearchParams();
        params.set('pid', pid || '0');
        params.set('cname', folderName);

        return await pan115Request({
            method: 'POST',
            url: 'https://webapi.115.com/files/add',
            data: params.toString(),
            headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
            responseType: 'json'
        });
    }

    async function api115GetFolderInfo(folderId) {
        ensurePan115Config();
        const url = `https://webapi.115.com/files/get_info?file_id=${encodeURIComponent(folderId)}`;
        return await pan115Request({
            method: 'GET',
            url,
            responseType: 'json'
        });
    }

    async function get115FolderNameById(folderId) {
        if (!folderId) return '根目录';
        if (CFG.pan115FolderNames && CFG.pan115FolderNames[folderId]) {
            return CFG.pan115FolderNames[folderId];
        }
        let info = null;
        try {
            info = await api115GetFolderInfo(folderId);
        } catch (error) {
            console.error('获取 115 文件夹名称失败:', error);
        }
        const candidates = [
            info?.data?.file_name,
            info?.data?.name,
            info?.file_name,
            info?.name,
            info?.cname,
            info?.folder_name,
            info?.FileName,
            info?.Name
        ].filter(Boolean);
        if (candidates.length > 0) {
            const name = candidates[0];
            if (!CFG.pan115FolderNames || typeof CFG.pan115FolderNames !== 'object') CFG.pan115FolderNames = {};
            CFG.pan115FolderNames[folderId] = name;
            saveConfig();
            return name;
        }
        return `文件夹_${folderId}`;
    }

    function showCreate115FolderDialog() {
        try {
            ensurePan115Config();
        } catch (error) {
            showWarningModal(error.message || '请先在设置中配置 115 离线认证信息');
            return;
        }

        const currentTitle = getCurrentThreadTitle();
        const cleanTitle = cleanTitleForFolder(currentTitle);
        const modal = createModal('创建115离线文件夹', '', 'info', { showConfirm: false });
        const content = document.createElement('div');
        content.style.cssText = 'padding: 20px; text-align: left;';

        const titleLabel = document.createElement('div');
        titleLabel.textContent = '文件夹名称：';
        titleLabel.style.cssText = 'margin-bottom: 8px; font-weight: bold; color: #333;';
        content.appendChild(titleLabel);

        const input = document.createElement('input');
        input.type = 'text';
        input.value = cleanTitle;
        input.placeholder = '请输入文件夹名称';
        input.style.cssText = 'width: 100%; padding: 10px; border: 1px solid #ddd; border-radius: 4px; font-size: 14px; margin-bottom: 15px;';
        content.appendChild(input);

        const optionsGroup = document.createElement('div');
        optionsGroup.style.cssText = 'margin-bottom: 15px;';

        const optionsLabel = document.createElement('div');
        optionsLabel.textContent = '创建后操作：';
        optionsLabel.style.cssText = 'margin-bottom: 8px; font-weight: bold; color: #333;';
        optionsGroup.appendChild(optionsLabel);

        const setAsDefaultOption = document.createElement('label');
        setAsDefaultOption.style.cssText = 'display: block; margin-bottom: 8px; cursor: pointer;';
        const setAsDefaultCheckbox = document.createElement('input');
        setAsDefaultCheckbox.type = 'checkbox';
        setAsDefaultCheckbox.checked = false;
        setAsDefaultCheckbox.style.cssText = 'margin-right: 8px;';
        setAsDefaultOption.appendChild(setAsDefaultCheckbox);
        setAsDefaultOption.appendChild(document.createTextNode('设为默认目录（影响所有新帖子）'));
        optionsGroup.appendChild(setAsDefaultOption);

        const setAsCurrentOption = document.createElement('label');
        setAsCurrentOption.style.cssText = 'display: block; margin-bottom: 8px; cursor: pointer;';
        const setAsCurrentCheckbox = document.createElement('input');
        setAsCurrentCheckbox.type = 'checkbox';
        setAsCurrentCheckbox.checked = true;
        setAsCurrentCheckbox.style.cssText = 'margin-right: 8px;';
        setAsCurrentOption.appendChild(setAsCurrentCheckbox);
        setAsCurrentOption.appendChild(document.createTextNode('设为本帖离线目录（仅当前帖子）'));
        optionsGroup.appendChild(setAsCurrentOption);

        content.appendChild(optionsGroup);

        const parentId = (CFG.pan115CurrentThreadFolder && String(CFG.pan115CurrentThreadFolder).trim())
            || (CFG.pan115UploadDir && String(CFG.pan115UploadDir).trim())
            || '0';
        const helpText = document.createElement('div');
        helpText.style.cssText = 'font-size: 12px; color: #666; margin-bottom: 15px; line-height: 1.4;';
        helpText.innerHTML = `
    <div>• 默认使用当前帖子标题作为文件夹名称，您可以修改</div>
    <div>• 将在目录 ID ${parentId === '0' ? '根目录' : parentId} 下创建该文件夹</div>
    <div>• 可将该目录设置为默认或仅当前帖子使用</div>
  `;
        content.appendChild(helpText);

        const buttonGroup = document.createElement('div');
        buttonGroup.style.cssText = 'display: flex; gap: 10px; justify-content: flex-end;';

        const cancelBtn = document.createElement('button');
        cancelBtn.textContent = '取消';
        cancelBtn.style.cssText = 'padding: 8px 16px; background: #6c757d; color: white; border: none; border-radius: 4px; cursor: pointer;';
        cancelBtn.onclick = () => modal.closeSht();

        const createBtn = document.createElement('button');
        setIconLabel(createBtn, 'folder', '创建文件夹');
        createBtn.style.cssText = 'padding: 8px 16px; background: linear-gradient(135deg, #f6c343 0%, #f49f0a 100%); color: #3b2f09; border: none; border-radius: 4px; cursor: pointer; font-weight: bold;';

        createBtn.onclick = async () => {
            const folderName = input.value.trim();
            if (!folderName) {
                showErrorModal('请输入文件夹名称');
                return;
            }

            createBtn.disabled = true;
            createBtn.textContent = '创建中...';

            try {
                const result = await api115CreateFolder(folderName, parentId);
                if (result?.state) {
                    const folderId = (result.cid || result.file_id || result.folder_id || '').toString();
                    const finalName = result.cname || result.file_name || folderName;
                    if (!folderId) throw new Error('未获取到新文件夹ID');

                    let message = `文件夹创建成功！\n\n名称：${finalName}\nID：${folderId}\n\n`;

                    if (!CFG.pan115FolderNames || typeof CFG.pan115FolderNames !== 'object') {
                        CFG.pan115FolderNames = {};
                    }
                    CFG.pan115FolderNames[folderId] = finalName;

                    if (setAsDefaultCheckbox.checked) {
                        CFG.pan115UploadDir = folderId;
                        message += '已设为默认目录';
                    }

                    if (setAsCurrentCheckbox.checked) {
                        if (!setAsDefaultCheckbox.checked) {
                            message += '已设为本帖目录';
                        } else {
                            message += '，同时设为本帖目录';
                        }
                        saveCurrentThreadFolder115(folderId);
                    } else {
                        saveConfig();
                    }

                    showSuccessModal(message);
                    modal.closeSht();
                    updateCreateFolderButton115();
                    refreshPan115FolderInfo();
                } else {
                    throw new Error(result?.error || result?.errno || '创建文件夹失败');
                }
            } catch (error) {
                console.error('创建 115 文件夹失败:', error);
                showErrorModal(`创建文件夹失败: ${error.message}`);
                createBtn.disabled = false;
                setIconLabel(createBtn, 'folder', '创建文件夹');
            }
        };

        buttonGroup.appendChild(cancelBtn);
        buttonGroup.appendChild(createBtn);
        content.appendChild(buttonGroup);

        modal.querySelector('.modal-content').appendChild(content);
        setTimeout(() => input.focus(), 100);
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') createBtn.click();
        });
    }

    async function updateCreateFolderButton115() {
        const btn = document.querySelector('#sht-create-folder-115-btn');
        if (!btn) return;
        if (!CFG.pan115Enabled) {
            setIconLabel(btn, 'folder', '115 新建');
            btn.title = '启用 115 离线后可使用此功能';
            return;
        }

        const currentFolderId = CFG.pan115CurrentThreadFolder && String(CFG.pan115CurrentThreadFolder).trim();
        if (currentFolderId) {
            setIconLabel(btn, 'refresh', '115 加载中...');
            btn.title = '正在获取文件夹信息...';
            try {
                const folderName = await get115FolderNameById(currentFolderId);
                setIconLabel(btn, 'folder', `115 ${folderName} (${currentFolderId})`);
                btn.title = `当前帖子离线目录: ${folderName} (ID: ${currentFolderId})`;
            } catch (error) {
                console.error('获取 115 文件夹名称失败:', error);
                setIconLabel(btn, 'folder', `115 文件夹_${currentFolderId} (${currentFolderId})`);
                btn.title = `当前帖子离线目录: 文件夹_${currentFolderId}`;
            }
        } else {
            setIconLabel(btn, 'folder', '115 新建');
            btn.title = CFG.pan115UploadDir
                ? `默认目录 ID: ${CFG.pan115UploadDir}\n点击创建新目录`
                : '尚未设置 115 默认目录，点击创建';
        }
    }

    function refreshPan115FolderInfo() {
        const infoEl = document.getElementById('sht-pan115-folder-info');
        if (!infoEl) return;
        const defaultId = CFG.pan115UploadDir && String(CFG.pan115UploadDir).trim();
        const currentId = CFG.pan115CurrentThreadFolder && String(CFG.pan115CurrentThreadFolder).trim();
        const nameOf = (id) => {
            if (!id) return '';
            if (CFG.pan115FolderNames && CFG.pan115FolderNames[id]) return `${CFG.pan115FolderNames[id]} (${id})`;
            return id;
        };
        const defaultLabel = defaultId ? nameOf(defaultId) : '未设置';
        const currentLabel = currentId ? nameOf(currentId) : '';
        infoEl.textContent = `默认目录: ${defaultLabel}${currentLabel ? ` | 本帖目录: ${currentLabel}` : ''}`;
    }

    function refreshPan123FolderInfo() {
        const infoEl = document.getElementById('sht-pan123-folder-info');
        if (!infoEl) return;
        const defaultId = CFG.pan123UploadDir && String(CFG.pan123UploadDir).trim();
        const currentId = CFG.pan123CurrentThreadFolder && String(CFG.pan123CurrentThreadFolder).trim();
        infoEl.textContent = `默认目录 ID: ${defaultId || '未设置'}${currentId ? ` | 本帖目录 ID: ${currentId}` : ''}`;
    }
