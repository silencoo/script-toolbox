    // ========== 123Pan 离线下载功能 ==========

    // 123Pan API 基础函数
    function makePan123Session(overrides = {}) {
        const token = overrides.token ?? CFG.pan123Token;
        const loginUuid = overrides.loginUuid ?? CFG.pan123LoginUuid;
        const cookie = overrides.cookie ?? CFG.pan123Cookie;
        if (!token || !loginUuid || !cookie) {
            throw new Error('123Pan 认证信息不完整，请检查配置');
        }

        return {
            headers: {
                'Accept': 'application/json, text/plain, */*',
                'App-Version': '3',
                'Authorization': token,
                'Origin': 'https://www.123pan.com',
                'Referer': 'https://www.123pan.com/',
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X) AppleWebKit/537.36 (KHTML, like Gecko) Chrome Safari',
                'platform': 'web',
                'LoginUuid': loginUuid,
                'Cookie': cookie
            }
        };
    }

    // 生成随机查询参数
    function generateRandomQuery() {
        return `${Math.floor(Math.random() * 10000000000)}=${Math.floor(Math.random() * 10000000000)}-${Math.floor(Math.random() * 1000000)}-${Math.floor(Math.random() * 10000000000)}`;
    }

    async function pan123RequestJson({ method = 'GET', url, body, headers = {}, sessionOverrides = {}, signal = null, retries = 0 }) {
        const session = makePan123Session(sessionOverrides);
        const isFormData = typeof FormData !== 'undefined' && body instanceof FormData;
        const response = await shtRequest({
            method, url, signal, retries, timeout: 30_000, responseType: 'json', scope: 'pan123',
            headers: {
                ...session.headers,
                ...(body != null && !isFormData ? { 'Content-Type': 'application/json;charset=UTF-8' } : {}),
                ...headers
            },
            data: body == null || isFormData ? body : JSON.stringify(body)
        });
        return responseJson(response, '123Pan 响应');
    }

    async function testPan123Connection({ token, loginUuid, cookie }) {
        const url = `https://www.123pan.com/b/api/offline_download/task/list?${generateRandomQuery()}`;
        const result = await pan123RequestJson({
            method: 'POST', url, sessionOverrides: { token, loginUuid, cookie },
            body: { current_page: 1, page_size: 1, status_arr: [0, 1, 3, 4] }
        });
        if (result?.code !== 0) throw new Error(result?.message || '123Pan 凭据验证失败');
        return result;
    }

    // 使用GM_xmlhttpRequest下载文件（绕过CORS）
    async function downloadFileWithGM(url, options = {}) {
        const response = await shtRequest({
            method: 'GET', url, responseType: 'arraybuffer', timeout: 30_000,
            signal: options.signal, onProgress: options.onProgress, retries: 1, scope: 'torrent-download',
            headers: {
                'Cookie': document.cookie,
                'User-Agent': navigator.userAgent,
                'Referer': window.location.href
            }
        });
        return new Blob([response.response]);
    }

    const torrentSendControllers = new WeakMap();
    async function sendTorrentAttachmentToPan123(button, url, title) {
        const running = torrentSendControllers.get(button);
        if (running) {
            running.abort();
            return;
        }
        if (!CFG.pan123Enabled || !CFG.pan123Token || !CFG.pan123LoginUuid || !CFG.pan123Cookie) {
            showToast('请先在设置中启用 123Pan 并配置认证信息', 'warning');
            return;
        }
        const controller = new AbortController();
        torrentSendControllers.set(button, controller);
        try {
            button.textContent = '准备中…（点击取消）';
            const torrentBlob = await downloadFileWithGM(url, {
                signal: controller.signal,
                onProgress: ({ loaded, total }) => {
                    const value = total ? `${Math.round((loaded / total) * 100)}%` : formatBytes(loaded);
                    button.textContent = `下载 ${value}（点击取消）`;
                }
            });
            button.textContent = '提交中…（点击取消）';
            await processTorrentOffline(torrentBlob, title, { signal: controller.signal });
            showToast('种子任务已发送到 123Pan', 'success');
        } catch (error) {
            showToast(describeRequestError(error), error?.name === 'AbortError' ? 'info' : 'error', 5000);
        } finally {
            torrentSendControllers.delete(button);
            button.textContent = '发送到123Pan';
        }
    }

    // 上传 torrent 文件到 123Pan
    async function apiUploadTorrent(torrentBlob, filename, options = {}) {
        const url = `https://www.123pan.com/b/api/offline_download/upload/seed?${generateRandomQuery()}`;

        const formData = new FormData();
        formData.append('upload-torrent', torrentBlob, filename);
        return pan123RequestJson({ method: 'POST', url, body: formData, signal: options.signal });
    }

    // 解析资源（通过infohash）
    async function apiResolve(infohash, options = {}) {
        const url = `https://www.123pan.com/b/api/v2/offline_download/task/resolve?${generateRandomQuery()}`;
        return pan123RequestJson({ method: 'POST', url, body: { info_hash: infohash.toLowerCase() }, signal: options.signal });
    }

    // 解析磁力链接
    async function apiResolveMagnet(magnetUrl, options = {}) {
        const url = `https://www.123pan.com/b/api/v2/offline_download/task/resolve?${generateRandomQuery()}`;
        return pan123RequestJson({ method: 'POST', url, body: { urls: magnetUrl }, signal: options.signal });
    }

    // 提交离线任务
    async function apiSubmit(resourceId, fileIds, options = {}) {
        const url = `https://www.123pan.com/b/api/v2/offline_download/task/submit?${generateRandomQuery()}`;

        const payload = {
            resource_list: [{
                resource_id: resourceId,
                select_file_id: fileIds
            }]
        };

        // 优先使用当前帖子的文件夹，否则使用默认文件夹
        const uploadDir = CFG.pan123CurrentThreadFolder || CFG.pan123UploadDir;
        if (uploadDir) {
            payload.upload_dir = parseInt(uploadDir);
        }

        return pan123RequestJson({ method: 'POST', url, body: payload, signal: options.signal });
    }

    // 获取离线任务列表
    async function apiGetOfflineTasks(options = {}) {
        const url = `https://www.123pan.com/b/api/offline_download/task/list?${generateRandomQuery()}`;

        const data = {
            current_page: 1,
            page_size: 15,
            status_arr: [0, 1, 3, 4] // 0: pending, 1: downloading, 3: completed, 4: failed
        };

        return pan123RequestJson({ method: 'POST', url, body: data, signal: options.signal });
    }

    // 取消离线任务
    async function apiCancelOfflineTask(taskId, options = {}) {
        const url = `https://www.123pan.com/b/api/offline_download/task/abort?${generateRandomQuery()}`;

        const data = {
            all: false,
            is_abort: true,
            task_ids: [parseInt(taskId)]
        };

        return pan123RequestJson({ method: 'POST', url, body: data, signal: options.signal });
    }

    // 创建文件夹
    async function apiCreateFolder(folderName, parentFileId = 0) {
        const url = `https://www.123pan.com/b/api/file/upload_request?${generateRandomQuery()}`;

        const data = {
            driveId: 0,
            etag: '',
            fileName: folderName,
            parentFileId: parentFileId,
            size: 0,
            type: 1, // 1表示文件夹
            duplicate: 1, // 允许重复名称
            NotReuse: true,
            event: 'newCreateFolder',
            operateType: 1,
            RequestSource: null
        };

        return pan123RequestJson({ method: 'POST', url, body: data });
    }

    // 获取文件夹信息（通过文件ID）
    async function apiGetFileInfo(fileId) {
        const url = `https://www.123pan.com/b/api/file/info?${generateRandomQuery()}&fileId=${fileId}`;

        try {
            const result = await pan123RequestJson({ method: 'GET', url, retries: 1 });

            if (result.code === 0 && result.data) {
                return result.data;
            }

            return null;
        } catch (error) {
            console.error('获取文件信息失败:', error);
            throw error;
        }
    }

    // 获取文件夹名称（通过ID）
    async function getFolderNameById(folderId) {
        if (!folderId || folderId === '0') return '根目录';

        try {
            const folder = await apiGetFileInfo(folderId);
            return folder ? folder.FileName : `文件夹_${folderId}`;
        } catch (error) {
            console.error('获取文件夹名称失败:', error);
            return `文件夹_${folderId}`;
        }
    }
