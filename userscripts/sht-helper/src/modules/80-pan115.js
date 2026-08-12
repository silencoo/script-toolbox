    // ========== 115 离线下载功能 ==========
    const PAN115_REQUEST_TIMEOUT = 20000;
    let pan115UidCache = { value: null, ts: 0 };

    function ensurePan115Config() {
        if (!CFG.pan115Enabled) {
            throw new Error('115 离线功能未启用');
        }
        if (!CFG.pan115Cookie || !CFG.pan115Cookie.trim()) {
            throw new Error('115 Cookie 未配置，请在设置中填写');
        }
    }

    function makePan115Headers(extra = {}) {
        const base = {
            'Accept': 'application/json, text/javascript, */*; q=0.01',
            'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
            'X-Requested-With': 'XMLHttpRequest',
            'User-Agent': CFG.pan115UserAgent?.trim() || navigator.userAgent,
            'Cookie': CFG.pan115Cookie.trim(),
            'Origin': 'https://115.com',
            'Referer': 'https://115.com/?tab=offline&mode=wangpan',
            'Sec-Fetch-Mode': 'cors',
            'Sec-Fetch-Site': 'same-origin',
            'Sec-Fetch-Dest': 'empty'
        };
        return { ...base, ...extra };
    }

    async function pan115Request({ method = 'GET', url, data, headers = {}, responseType = 'json', signal = null, retries = 0 }) {
        ensurePan115Config();
        const response = await shtRequest({
            method, url, data, headers: makePan115Headers(headers), responseType,
            timeout: PAN115_REQUEST_TIMEOUT, signal, retries, scope: 'pan115'
        });
        return responseType === 'json' ? responseJson(response, '115 响应') : (response.response ?? response.responseText);
    }

    async function testPan115Connection({ cookie, userAgent }) {
        if (!cookie?.trim()) throw new Error('请先填写 115 Cookie');
        const response = await shtRequest({
            method: 'GET', url: 'https://my.115.com/?ct=ajax&ac=get_user_aq', responseType: 'json',
            timeout: PAN115_REQUEST_TIMEOUT, retries: 0, scope: 'pan115-test',
            headers: {
                ...makePan115Headers(),
                'Cookie': cookie.trim(),
                'User-Agent': userAgent?.trim() || navigator.userAgent
            }
        });
        const result = await responseJson(response, '115 测试响应');
        const uid = result?.data?.uid || result?.uid;
        if (!uid) throw new Error(result?.error_msg || '未获取到 UID，Cookie 可能已失效');
        return { uid };
    }

    async function pan115FetchUid(signal = null) {
        ensurePan115Config();
        const now = Date.now();
        if (pan115UidCache.value && now - pan115UidCache.ts < 10 * 60 * 1000) {
            return pan115UidCache.value;
        }
        const result = await pan115Request({
            method: 'GET',
            url: 'https://my.115.com/?ct=ajax&ac=get_user_aq',
            responseType: 'json', signal
        });
        const uid = result?.data?.uid || result?.uid;
        if (!uid) {
            throw new Error('无法获取 115 UID，请检查 Cookie 是否有效');
        }
        pan115UidCache = { value: uid, ts: now };
        return uid;
    }

    async function pan115FetchSignTime(signal = null) {
        const result = await pan115Request({
            method: 'GET',
            url: 'https://115.com/?ct=offline&ac=space',
            responseType: 'json',
            signal,
            headers: { 'Accept-Encoding': 'text/html' }
        });
        if (!result) {
            throw new Error('115 返回空响应');
        }
        if (result.state === false) {
            throw new Error(result.error_msg || '获取 115 离线签名失败');
        }
        if (!result.sign || !result.time) {
            throw new Error('115 响应缺少 sign/time 字段');
        }
        return { sign: result.sign, time: result.time };
    }

    async function pan115AddTasks(urls, options = {}) {
        ensurePan115Config();
        const uniqueUrls = Array.from(new Set((urls || []).map(u => u && u.trim()).filter(Boolean)));
        if (uniqueUrls.length === 0) {
            throw new Error('没有可发送的链接');
        }

        const uid = await pan115FetchUid(options.signal);
        let signTime = await pan115FetchSignTime(options.signal);

        const targetDir = (CFG.pan115CurrentThreadFolder && String(CFG.pan115CurrentThreadFolder).trim())
            || (CFG.pan115UploadDir && String(CFG.pan115UploadDir).trim())
            || '';

        const results = [];
        let successCount = 0;

        if (targetDir && !options.__fallbackUsed) {
            const valid = await pan115ValidateDirectory(targetDir);
            if (!valid) {
                console.warn('[115 离线] 目录已失效:', targetDir);
                clearPan115FolderReference(targetDir);
                showWarningModal('115 离线目录不存在或已删除，已清除缓存，请重新创建或选择新目录。');
                return pan115AddTasks(urls, { __fallbackUsed: true, signal: options.signal });
            }
        }

        const encodeUrlFor115 = (url) => {
            try {
                return encodeURIComponent(url).replace(/%20/g, '+');
            } catch {
                return url;
            }
        };

        const batchParams = new URLSearchParams();
        if (targetDir) batchParams.set('wp_path_id', targetDir);
        batchParams.set('uid', uid);
        batchParams.set('sign', signTime.sign);
        batchParams.set('time', signTime.time);
        uniqueUrls.forEach((url, idx) => {
            batchParams.set(`url[${idx}]`, encodeUrlFor115(url));
        });

        try {
            const response = await pan115Request({
                method: 'POST',
                url: 'https://115.com/web/lixian/?ct=lixian&ac=add_task_urls',
                data: batchParams.toString(),
                headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
                responseType: 'json', signal: options.signal
            });

            const respList = response?.result || [];
            const dirRemovedKeywords = ['不存在', '删除', '无效'];
            let directoryInvalid = false;
            for (let i = 0; i < uniqueUrls.length; i++) {
                const url = uniqueUrls[i];
                const entry = respList[i];
                let success = false;
                let message = '提交成功';
                let errorMsg = undefined;

                if (entry && entry.info_hash && !entry.error_msg) {
                    success = true;
                } else if (entry) {
                    message = entry.error_msg || entry.error || entry.errno || '提交失败';
                    errorMsg = message;
                } else {
                    message = '提交失败（未返回结果）';
                    errorMsg = message;
                }

                if (success) successCount++;
                results.push({
                    url,
                    success,
                    response: entry ?? null,
                    message,
                    error: errorMsg
                });

                if (!success && errorMsg && dirRemovedKeywords.some(k => errorMsg.includes(k))) {
                    directoryInvalid = true;
                }
            }
            if (directoryInvalid && targetDir) {
                console.warn('[115 离线] 目标目录失效，清除缓存:', targetDir);
                clearPan115FolderReference(targetDir);
                showWarningModal('115 离线目录已失效（可能已删除或无权限）。目录缓存已清除，请重新创建或选择目录后再试。');
            }
            if (response?.state === false && response?.error && targetDir) {
                if (dirRemovedKeywords.some(k => response.error.includes(k))) {
                    clearPan115FolderReference(targetDir);
                    showWarningModal('115 离线目录已失效（可能已删除或无权限）。目录缓存已清除，请重新创建或选择目录后再试。');
                }
            }
        } catch (error) {
            const errMessage = error instanceof Error ? error.message : String(error);
            uniqueUrls.forEach((url) => {
                results.push({ url, success: false, error: errMessage, message: errMessage });
            });
        }

        return {
            successCount,
            failCount: results.length - successCount,
            total: results.length,
            details: results
        };
    }

    async function create115FolderAndSend(triggerButton) {
        try {
            ensurePan115Config();
        } catch (error) {
            showWarningModal(error.message || '请先在设置中配置 115 离线认证信息');
            return;
        }

        const button = triggerButton || null;
        const originalText = button?.textContent;
        if (button) {
            button.disabled = true;
            button.textContent = '115 创建中...';
        }

        try {
            const folderName = cleanTitleForFolder(getCurrentThreadTitle()) || `离线_${Date.now()}`;
            const createResult = await api115CreateFolder(folderName);
            if (!createResult?.state) {
                clearPan115FolderReference(CFG.pan115CurrentThreadFolder);
                throw new Error(createResult?.error || createResult?.errno || '创建 115 文件夹失败');
            }

            const folderId = (createResult.cid || createResult.file_id || createResult.folder_id || '').toString();
            const realName = createResult.cname || createResult.file_name || folderName;
            if (!folderId) {
                clearPan115FolderReference(CFG.pan115CurrentThreadFolder);
                throw new Error('未获取到新文件夹 ID');
            }

            if (!CFG.pan115FolderNames || typeof CFG.pan115FolderNames !== 'object') CFG.pan115FolderNames = {};
            CFG.pan115FolderNames[folderId] = realName;

            saveCurrentThreadFolder115(folderId);
            updateCreateFolderButton115();
            refreshPan115FolderInfo();

            const ed2kLinks = collectAllED2K();
            const magnetLinks = collectAllMagnets();
            const allLinks = Array.from(new Set([...ed2kLinks, ...magnetLinks]));

            if (!allLinks.length) {
                showInfoModal(`已创建目录：${realName} (${folderId})，但未收集到可离线的 ED2K 或磁力链接。`);
                return;
            }

            if (button) {
                button.textContent = '115 离线发送中...';
            }

            const summary = await queueCloudProviderTask('pan115',
                ({ signal }) => pan115AddTasks(allLinks, { signal }),
                { label: `115 批量任务（${allLinks.length}）`, retries: 0 }
            );
            const { successCount, failCount, details } = summary;
            const total = summary.total || allLinks.length;
            const modalResults = formatPan115ResultItems(details, allLinks);
            showBatchResultModal(modalResults, successCount, failCount, total);
            if (failCount > 0 && Array.isArray(details)) {
                console.warn('[115 离线] 以下任务提交失败:');
                details.forEach((item, idx) => {
                    if (!item || item.success) return;
                    console.warn(`[#${idx + 1}]`, item.url || '未知链接', '| 错误:', item.error || item.message || '未知原因', '| 响应:', item.response);
                });
            }
        } catch (error) {
            clearPan115FolderReference(CFG.pan115CurrentThreadFolder);
            console.error('115 一键创建+离线失败:', error);
            const errMsg = error instanceof Error ? (error.message || '') : String(error);
            if (errMsg && errMsg.includes('目录不存在或已删除')) {
                showWarningModal('115 离线目录不存在或已删除，缓存已清除，请重新创建或选择目录后再试。');
            } else {
                showErrorModal(`115 一键创建+离线失败: ${errMsg || error}`);
            }
        } finally {
            if (button) {
                button.disabled = false;
                setIconLabel(button, 'bolt', originalText || '115 新建并离线');
            }
        }
    }
