    // 解析文件大小
    function parseSize(sizeText) {
        if (!sizeText) return 0;

        const sizeTextUpper = sizeText.toUpperCase();
        const match = sizeTextUpper.match(/^([0-9]+(?:\.[0-9]+)?)\s*(B|KB|MB|GB|TB)?$/);
        if (!match) return 0;

        const val = parseFloat(match[1]);
        const unit = (match[2] || 'B').toUpperCase();
        const multipliers = { 'B': 1, 'KB': 1024, 'MB': 1024 ** 2, 'GB': 1024 ** 3, 'TB': 1024 ** 4 };
        return Math.floor(val * multipliers[unit]);
    }

    // 判断是否为视频文件
    function isVideoFile(filename) {
        const videoExtensions = ['.mp4', '.avi', '.mkv', '.wmv', '.flv', '.mov', '.mpg', '.mpeg', '.m4v', '.3gp', '.webm'];
        const filenameLower = filename.toLowerCase();
        return videoExtensions.some(ext => filenameLower.endsWith(ext));
    }

    // 文件过滤
    function selectFiles(files) {
        const minSize = parseSize(CFG.pan123MinSize);
        const maxSize = parseSize(CFG.pan123MaxSize);
        const videoMinSize = parseSize(CFG.pan123VideoMinSize);
        const includeExts = CFG.pan123IncludeExt.split(',').map(ext => ext.trim().toLowerCase());
        const excludeExts = CFG.pan123ExcludeExt.split(',').map(ext => ext.trim().toLowerCase());

        const candidates = [];
        const excludedFiles = [];

        for (const file of files) {
            const name = file.name || '';
            const size = parseInt(file.size || 0);
            const fileId = parseInt(file.id);

            // 检查扩展名
            const hasIncludeExt = includeExts.length === 0 || includeExts.some(ext => name.toLowerCase().endsWith(ext));
            const hasExcludeExt = excludeExts.some(ext => name.toLowerCase().endsWith(ext));

            if (!hasIncludeExt) {
                excludedFiles.push({ name, reason: '不在包含扩展名列表中' });
                continue;
            }

            if (hasExcludeExt) {
                excludedFiles.push({ name, reason: '在排除扩展名列表中' });
                continue;
            }

            // 大小过滤
            if (isVideoFile(name)) {
                if (videoMinSize && size < videoMinSize) {
                    excludedFiles.push({ name, reason: `视频文件小于 ${Math.floor(videoMinSize / (1024 * 1024))}MB` });
                    continue;
                }
            } else {
                if (minSize && size < minSize) {
                    excludedFiles.push({ name, reason: `文件小于 ${Math.floor(minSize / (1024 * 1024))}MB` });
                    continue;
                }
            }

            if (maxSize && size > maxSize) {
                excludedFiles.push({ name, reason: `文件大于 ${Math.floor(maxSize / (1024 * 1024))}MB` });
                continue;
            }

            candidates.push({ size, fileId });
        }

        if (excludedFiles.length > 0) {
            console.log('排除的文件:', excludedFiles.slice(0, 5));
        }

        if (candidates.length === 0) {
            return [];
        }

        if (CFG.pan123PickLargest) {
            const largest = candidates.reduce((max, current) => current.size > max.size ? current : max);
            return [largest.fileId];
        }

        return candidates.map(c => c.fileId);
    }

    // 检查任务是否在离线列表中
    async function checkTaskInOfflineList(resourceName, options = {}) {
        try {
            const offlineData = await apiGetOfflineTasks(options);
            if (offlineData.code !== 0) {
                console.warn('获取离线任务列表失败:', offlineData.message);
                return null;
            }

            const taskList = offlineData.data?.list || [];

            for (const task of taskList) {
                const taskName = task.name || '';
                const taskId = task.task_id || '';
                const status = task.status || '';

                // 精确匹配或文件名匹配
                if (taskName === resourceName || taskName.startsWith(resourceName)) {
                    console.log(`找到任务: ${resourceName} -> ${taskName} (ID: ${taskId}, 状态: ${status})`);
                    return task;
                }

                // 去掉扩展名后匹配
                const resourceBase = resourceName.split('.')[0];
                const taskBase = taskName.split('.')[0];
                if (resourceBase === taskBase) {
                    console.log(`基础名匹配找到任务: ${resourceName} -> ${taskName} (ID: ${taskId}, 状态: ${status})`);
                    return task;
                }
            }

            console.log(`任务不在离线列表中: ${resourceName}`);
            return null;
        } catch (error) {
            if (error?.name === 'AbortError') throw error;
            console.error('检查任务状态失败:', error);
            return null;
        }
    }

    // 获取离线任务统计信息
    async function getOfflineTaskStats() {
        try {
            const offlineData = await apiGetOfflineTasks();
            if (offlineData.code !== 0) {
                return { total: 0, running: 0, completed: 0, failed: 0 };
            }

            const taskList = offlineData.data?.list || [];
            const stats = {
                total: taskList.length,
                running: 0,
                completed: 0,
                failed: 0
            };

            taskList.forEach(task => {
                switch (task.status) {
                    case 1: // 运行中
                        stats.running++;
                        break;
                    case 2: // 已完成
                        stats.completed++;
                        break;
                    case 3: // 失败
                        stats.failed++;
                        break;
                }
            });

            return stats;
        } catch (error) {
            console.error('获取离线任务统计失败:', error);
            return { total: 0, running: 0, completed: 0, failed: 0 };
        }
    }

    // 处理秒离线检测结果
    async function handleInstantOfflineResult(resourceName, selectedFileIds, isInstantOffline, actionTaken = '') {
        const stats = await getOfflineTaskStats();

        let message = `离线任务提交成功！\n`;
        message += `资源: ${resourceName}\n`;
        message += `选择文件: ${selectedFileIds.length} 个\n\n`;

        if (isInstantOffline) {
            message += `状态: 秒离线成功\n`;
            message += `文件已直接下载到123Pan\n`;
        } else {
            message += `状态: 正在离线下载\n`;
            if (actionTaken) {
                message += `处理方式: ${actionTaken}\n`;
            }
        }

        message += `\n当前离线任务状态:\n`;
        message += `总计: ${stats.total} 个\n`;
        message += `运行中: ${stats.running} 个\n`;
        message += `已完成: ${stats.completed} 个\n`;
        message += `失败: ${stats.failed} 个`;

        return message;
    }

    // 显示秒离线确认对话框
    function showInstantOfflineConfirmDialog(resourceName, taskId) {
        return new Promise((resolve) => {
            const modal = createModal(
                '秒离线失败',
                `资源 "${resourceName}" 未能秒离线成功，是否取消该任务？\n\n取消后任务将从离线列表中移除。`,
                'warning'
            );

            // 修改按钮
            const buttonContainer = modal.querySelector('.modal-content > div:last-child');
            buttonContainer.innerHTML = '';

            const cancelBtn = document.createElement('button');
            cancelBtn.textContent = '取消任务';
            cancelBtn.style.cssText = 'padding: 8px 24px; border: none; border-radius: 4px; font-size: 14px; cursor: pointer; background: #dc3545; color: white; margin-right: 12px;';
            cancelBtn.addEventListener('click', () => {
                modal.closeSht();
                resolve(true); // 取消任务
            });

            const keepBtn = document.createElement('button');
            keepBtn.textContent = '保留任务';
            keepBtn.style.cssText = 'padding: 8px 24px; border: none; border-radius: 4px; font-size: 14px; cursor: pointer; background: #28a745; color: white;';
            keepBtn.addEventListener('click', () => {
                modal.closeSht();
                resolve(false); // 保留任务
            });

            buttonContainer.appendChild(cancelBtn);
            buttonContainer.appendChild(keepBtn);
        });
    }

    // 计算 torrent 文件的 infohash
    async function calculateInfohash(torrentBlob) {
        try {
            // 将 Blob 转换为 ArrayBuffer
            const arrayBuffer = await torrentBlob.arrayBuffer();
            const uint8Array = new Uint8Array(arrayBuffer);

            // 简化的 bencode 解析器
            function bdecode(data, i = 0) {
                if (data[i] === 105) { // 'i'
                    let j = i + 1;
                    while (data[j] !== 101) j++; // 找到 'e'
                    return [parseInt(String.fromCharCode(...data.slice(i + 1, j))), j + 1];
                }
                if (data[i] === 108) { // 'l'
                    i++;
                    const out = [];
                    while (data[i] !== 101) { // 不是 'e'
                        const [v, newI] = bdecode(data, i);
                        out.push(v);
                        i = newI;
                    }
                    return [out, i + 1];
                }
                if (data[i] === 100) { // 'd'
                    i++;
                    const d = {};
                    while (data[i] !== 101) { // 不是 'e'
                        const [k, newI] = bdecode(data, i);
                        const [v, newI2] = bdecode(data, newI);
                        d[k] = v;
                        i = newI2;
                    }
                    return [d, i + 1];
                }
                // 字符串
                let j = i;
                while (data[j] !== 58) j++; // 找到 ':'
                const length = parseInt(String.fromCharCode(...data.slice(i, j)));
                const start = j + 1;
                const end = start + length;
                return [data.slice(start, end), end];
            }

            // 简化的 bencode 编码器
            function bencode(obj) {
                if (typeof obj === 'number') {
                    return new Uint8Array([...'i'.split('').map(c => c.charCodeAt(0)), ...obj.toString().split('').map(c => c.charCodeAt(0)), ...'e'.split('').map(c => c.charCodeAt(0))]);
                }
                if (obj instanceof Uint8Array) {
                    const length = obj.length.toString();
                    return new Uint8Array([...length.split('').map(c => c.charCodeAt(0)), 58, ...obj]);
                }
                if (Array.isArray(obj)) {
                    const result = [108]; // 'l'
                    for (const item of obj) {
                        result.push(...bencode(item));
                    }
                    result.push(101); // 'e'
                    return new Uint8Array(result);
                }
                if (typeof obj === 'object' && obj !== null) {
                    const result = [100]; // 'd'
                    const keys = Object.keys(obj).sort();
                    for (const key of keys) {
                        const keyBytes = new Uint8Array(key.split('').map(c => c.charCodeAt(0)));
                        result.push(...bencode(keyBytes));
                        result.push(...bencode(obj[key]));
                    }
                    result.push(101); // 'e'
                    return new Uint8Array(result);
                }
                return new Uint8Array();
            }

            // 解析 torrent 文件
            const [torrent, _] = bdecode(uint8Array, 0);
            if (!torrent || !torrent.info) {
                throw new Error('无效的 torrent 文件');
            }

            // 编码 info 部分
            const infoEncoded = bencode(torrent.info);

            // 计算 SHA1 哈希
            const hashBuffer = await crypto.subtle.digest('SHA-1', infoEncoded);
            const hashArray = new Uint8Array(hashBuffer);

            // 转换为十六进制字符串
            const hashHex = Array.from(hashArray)
                .map(b => b.toString(16).padStart(2, '0'))
                .join('');

            console.log('计算得到 infohash:', hashHex);
            return hashHex;

        } catch (error) {
            console.error('计算 infohash 失败:', error);
            // 如果计算失败，尝试从磁力链接中提取
            throw new Error(`计算 infohash 失败: ${error.message}`);
        }
    }

    // 创建批量发送进度显示
    function createBatchProgressModal(totalTasks) {
        // 移除已存在的进度modal
        const existingModal = document.querySelector('#sht-batch-progress-modal');
        if (existingModal) {
            existingModal.remove();
        }

        const modal = document.createElement('div');
        modal.id = 'sht-batch-progress-modal';
        modal.style.cssText = `
  position: fixed;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  background: rgba(0, 0, 0, 0.7);
  display: flex;
  justify-content: center;
  align-items: center;
  z-index: 10001;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
`;

        const modalContent = document.createElement('div');
        modalContent.style.cssText = `
  background: white;
  border-radius: 8px;
  padding: 24px;
  max-width: 500px;
  width: 90%;
  box-shadow: 0 10px 25px rgba(0, 0, 0, 0.3);
  text-align: center;
  position: relative;
`;

        // 标题
        const titleEl = document.createElement('h3');
        titleEl.textContent = '批量发送到123Pan';
        titleEl.style.cssText = `
  margin: 0 0 20px 0;
  font-size: 18px;
  font-weight: 600;
  color: #333;
`;

        // 进度信息
        const progressInfo = document.createElement('div');
        progressInfo.style.cssText = `
  margin: 0 0 20px 0;
  font-size: 14px;
  color: #666;
`;
        progressInfo.innerHTML = `
  <div>总计: <strong>${totalTasks}</strong> 个任务</div>
  <div>当前: <strong id="current-task">0</strong> / ${totalTasks}</div>
  <div>成功: <strong id="success-count" style="color: #28a745;">0</strong> 个</div>
  <div>失败: <strong id="fail-count" style="color: #dc3545;">0</strong> 个</div>
`;

        // 进度条
        const progressBarContainer = document.createElement('div');
        progressBarContainer.style.cssText = `
  width: 100%;
  height: 8px;
  background: #e9ecef;
  border-radius: 4px;
  overflow: hidden;
  margin: 0 0 20px 0;
`;

        const progressBar = document.createElement('div');
        progressBar.id = 'batch-progress-bar';
        progressBar.style.cssText = `
  height: 100%;
  background: linear-gradient(90deg, #007bff, #28a745);
  width: 0%;
  transition: width 0.3s ease;
`;
        progressBarContainer.appendChild(progressBar);

        // 当前任务状态
        const currentStatus = document.createElement('div');
        currentStatus.id = 'current-status';
        currentStatus.style.cssText = `
  font-size: 12px;
  color: #666;
  margin: 0 0 10px 0;
  min-height: 16px;
`;

        // 取消按钮
        const cancelBtn = document.createElement('button');
        cancelBtn.textContent = '取消批量发送';
        cancelBtn.style.cssText = `
  padding: 8px 16px;
  border: 1px solid #dc3545;
  border-radius: 4px;
  background: white;
  color: #dc3545;
  font-size: 14px;
  cursor: pointer;
  transition: all 0.2s;
`;

        cancelBtn.addEventListener('mouseenter', () => {
            cancelBtn.style.background = '#dc3545';
            cancelBtn.style.color = 'white';
        });
        cancelBtn.addEventListener('mouseleave', () => {
            cancelBtn.style.background = 'white';
            cancelBtn.style.color = '#dc3545';
        });

        modalContent.appendChild(titleEl);
        modalContent.appendChild(progressInfo);
        modalContent.appendChild(progressBarContainer);
        modalContent.appendChild(currentStatus);
        modalContent.appendChild(cancelBtn);
        modal.appendChild(modalContent);
        document.body.appendChild(modal);

        return {
            modal,
            updateProgress: (current, success, fail, status) => {
                document.getElementById('current-task').textContent = current;
                document.getElementById('success-count').textContent = success;
                document.getElementById('fail-count').textContent = fail;
                document.getElementById('current-status').textContent = status || '';
                const percentage = (current / totalTasks) * 100;
                document.getElementById('batch-progress-bar').style.width = `${percentage}%`;
            },
            close: () => modal.remove(),
            setCancelHandler: (handler) => {
                cancelBtn.addEventListener('click', handler);
            }
        };
    }

    // 显示批量发送结果（可滚动文本块）
    function showBatchResultModal(results, successCount, failCount, totalTasks) {
        // 移除已存在的modal
        const existingModal = document.querySelector('#sht-modal');
        if (existingModal) {
            existingModal.remove();
        }

        const modal = document.createElement('div');
        modal.id = 'sht-modal';
        modal.style.cssText = `
  position: fixed;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  justify-content: center;
  align-items: center;
  z-index: 10000;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
`;

        const modalContent = document.createElement('div');
        modalContent.style.cssText = `
  background: white;
  border-radius: 8px;
  padding: 24px;
  max-width: 600px;
  width: 90%;
  max-height: 80vh;
  box-shadow: 0 10px 25px rgba(0, 0, 0, 0.2);
  text-align: center;
  position: relative;
  display: flex;
  flex-direction: column;
`;

        // 标题
        const titleEl = document.createElement('h3');
        titleEl.textContent = '批量发送结果';
        titleEl.style.cssText = `
  margin: 0 0 16px 0;
  font-size: 18px;
  font-weight: 600;
  color: #333;
`;

        // 统计信息
        const statsEl = document.createElement('div');
        statsEl.style.cssText = `
  margin: 0 0 16px 0;
  font-size: 14px;
  color: #666;
  display: flex;
  justify-content: space-around;
  flex-wrap: wrap;
  gap: 10px;
`;
        statsEl.innerHTML = `
  <div>总计: <strong>${totalTasks}</strong> 个</div>
  <div style="color: #28a745;">成功: <strong>${successCount}</strong> 个</div>
  <div style="color: #dc3545;">失败: <strong>${failCount}</strong> 个</div>
`;

        // 可滚动的结果内容
        const scrollContainer = document.createElement('div');
        scrollContainer.style.cssText = `
  flex: 1;
  overflow-y: auto;
  border: 1px solid #e9ecef;
  border-radius: 4px;
  padding: 12px;
  margin: 0 0 20px 0;
  text-align: left;
  font-family: 'Courier New', monospace;
  font-size: 12px;
  line-height: 1.4;
  background: #f8f9fa;
  max-height: 400px;
`;

        // 使用 DOM 节点渲染远端任务信息，避免标题或错误文本被解释为 HTML。
        const appendDetail = (parent, icon, label, value) => {
            const line = document.createElement('div');
            line.style.cssText = 'display:flex;align-items:flex-start;gap:5px;';
            setIconLabel(line, icon, `${label}: ${value}`, 14);
            parent.appendChild(line);
        };

        const appendSection = (items, success) => {
            if (!items.length) return;

            const color = success ? '#28a745' : '#dc3545';
            const sectionTitle = document.createElement('div');
            sectionTitle.style.cssText = `display:flex;align-items:center;gap:6px;color:${color};font-weight:bold;margin:${success ? '0' : '20px'} 0 10px;`;
            setIconLabel(sectionTitle, success ? 'checkCircle' : 'errorCircle', `${success ? '成功' : '失败'}任务 (${items.length} 个)`);
            scrollContainer.appendChild(sectionTitle);

            const divider = document.createElement('div');
            divider.style.cssText = `border-bottom:2px solid ${color};margin-bottom:15px;`;
            scrollContainer.appendChild(divider);

            items.forEach((result, index) => {
                const item = document.createElement('div');
                item.style.cssText = `margin-bottom:12px;padding:8px;background:${success ? '#f8fff9' : '#fff5f5'};border-left:3px solid ${color};border-radius:4px;`;

                const itemTitle = document.createElement('div');
                itemTitle.style.cssText = `display:flex;align-items:flex-start;gap:6px;color:${color};font-weight:bold;`;
                setIconLabel(itemTitle, success ? 'checkCircle' : 'errorCircle', `${index + 1}. ${result.title || '未命名任务'}`, 14);
                item.appendChild(itemTitle);

                const details = document.createElement('div');
                details.style.cssText = 'margin-left:20px;color:#666;font-size:12px;';
                if (success && result.result) {
                    appendDetail(details, 'folder', '文件数', `${result.result.fileCount ?? 0} 个`);
                    appendDetail(details, 'chart', '状态', result.result.isInstantOffline ? '秒离线成功' : '正在下载');
                    if (result.result.actionTaken) {
                        appendDetail(details, 'wrench', '处理', result.result.actionTaken);
                    }
                } else if (!success) {
                    appendDetail(details, 'warning', '错误', result.error || '未知错误');
                }
                if (details.childNodes.length) item.appendChild(details);
                scrollContainer.appendChild(item);
            });
        };

        appendSection(results.filter(result => result.success), true);
        appendSection(results.filter(result => !result.success), false);

        // 按钮容器
        const buttonContainer = document.createElement('div');
        buttonContainer.style.cssText = `
  display: flex;
  gap: 12px;
  justify-content: center;
`;

        // 确定按钮
        const confirmBtn = document.createElement('button');
        confirmBtn.textContent = '确定';
        confirmBtn.style.cssText = `
  padding: 8px 24px;
  border: none;
  border-radius: 4px;
  font-size: 14px;
  cursor: pointer;
  transition: background-color 0.2s;
  background: #007bff;
  color: white;
`;

        confirmBtn.addEventListener('mouseenter', () => {
            confirmBtn.style.opacity = '0.9';
        });
        confirmBtn.addEventListener('mouseleave', () => {
            confirmBtn.style.opacity = '1';
        });

        // 关闭modal
        const closeModal = () => {
            modal.remove();
        };

        confirmBtn.addEventListener('click', closeModal);
        modal.addEventListener('click', (e) => {
            if (e.target === modal) {
                closeModal();
            }
        });

        // ESC键关闭
        const handleKeyDown = (e) => {
            if (e.key === 'Escape') {
                closeModal();
                document.removeEventListener('keydown', handleKeyDown);
            }
        };
        document.addEventListener('keydown', handleKeyDown);

        buttonContainer.appendChild(confirmBtn);
        modalContent.appendChild(titleEl);
        modalContent.appendChild(statsEl);
        modalContent.appendChild(scrollContainer);
        modalContent.appendChild(buttonContainer);
        modal.appendChild(modalContent);
        document.body.appendChild(modal);

        // 聚焦到确定按钮
        confirmBtn.focus();

        return modal;
    }

    // 批量处理磁力链接离线下载
    let nextPan123TaskStartAt = 0;
    async function waitForPan123TaskSlot(intervalMs, signal) {
        const now = Date.now();
        const scheduledAt = Math.max(now, nextPan123TaskStartAt);
        nextPan123TaskStartAt = scheduledAt + Math.max(0, intervalMs);
        if (scheduledAt > now) await waitWithSignal(scheduledAt - now, signal);
    }

    async function processBatchMagnetOffline(magnetUrls) {
        if (!CFG.pan123Enabled) {
            showWarningModal('请先在设置中启用 123Pan 功能并配置认证信息');
            return;
        }

        const results = new Array(magnetUrls.length);
        let successCount = 0;
        let failCount = 0;
        let completedCount = 0;
        const totalTasks = magnetUrls.length;
        const intervalMs = CFG.pan123BatchSendInterval || 2000;
        const progressModal = createBatchProgressModal(totalTasks);
        const controller = new AbortController();
        progressModal.setCancelHandler(() => {
            controller.abort();
            showToast('正在取消未开始及进行中的 123Pan 任务', 'warning');
        });

        try {
            const tasks = magnetUrls.map((magnetUrl, index) => queueCloudProviderTask('pan123', async ({ signal }) => {
                await waitForPan123TaskSlot(intervalMs, signal);
                progressModal.updateProgress(completedCount, successCount, failCount, `正在处理第 ${index + 1} 个任务`);
                return processSingleMagnetOffline(magnetUrl, magnetUrl, { signal });
            }, {
                label: `123Pan ${index + 1}/${totalTasks}`,
                retries: 0,
                signal: controller.signal
            }).then(result => {
                successCount += 1;
                completedCount += 1;
                results[index] = { title: result.taskName || magnetUrl, success: true, result };
                progressModal.updateProgress(completedCount, successCount, failCount, `已完成: ${result.taskName || `任务 ${index + 1}`}`);
            }).catch(error => {
                completedCount += 1;
                failCount += 1;
                results[index] = {
                    title: magnetUrl,
                    success: false,
                    cancelled: error?.name === 'AbortError',
                    error: describeRequestError(error)
                };
                progressModal.updateProgress(completedCount, successCount, failCount, error?.name === 'AbortError' ? '任务已取消' : `任务失败: ${describeRequestError(error)}`);
            }));
            await Promise.all(tasks);
        } finally {
            progressModal.close();
        }

        const completedResults = results.filter(Boolean);
        showBatchResultModal(completedResults, successCount, failCount, totalTasks);
        return completedResults;
    }

    // 处理单个磁力链接离线下载（不显示Modal）
    async function processSingleMagnetOffline(magnetUrl, title, options = {}) {
        if (!CFG.pan123Enabled) {
            throw new Error('123Pan 功能未启用');
        }

        try {
            console.log('开始处理磁力链接离线下载:', title);

            // 1. 通过磁力链接解析任务
            console.log('解析磁力链接...');
            const resolveResult = await apiResolveMagnet(magnetUrl, options);
            console.log('解析结果:', resolveResult);

            if (resolveResult.code !== 0) {
                throw new Error(`解析磁力链接失败: ${resolveResult.message}`);
            }

            const resourceList = resolveResult.data?.list || [];
            if (resourceList.length === 0) {
                throw new Error('没有找到可用的资源');
            }

            const item = resourceList[0];
            const resourceId = parseInt(item.id || item.resource_id || 0);
            const files = item.files || [];

            // 从API响应中获取真实文件名
            const realTitle = item.name || title;

            // 2. 选择文件
            console.log('选择文件...');
            const selectedFileIds = selectFiles(files);
            if (selectedFileIds.length === 0) {
                throw new Error('没有文件满足过滤条件');
            }

            // 3. 提交离线任务
            console.log('提交离线任务...');
            const submitResult = await apiSubmit(resourceId, selectedFileIds, options);
            if (submitResult.code !== 0 || submitResult.message !== 'ok') {
                throw new Error(`提交失败: ${submitResult.message}`);
            }

            console.log('离线任务提交成功:', submitResult);

            // 4. 等待并检查秒离线状态
            console.log('等待秒离线检查...');
            await waitWithSignal(CFG.pan123InstantOfflineCheckDelay, options.signal);

            const taskName = item.name;
            const offlineTask = await checkTaskInOfflineList(taskName, options);
            const isInstantOffline = !offlineTask;
            let actionTaken = '';

            if (offlineTask) {
                console.log('未秒离线成功，任务仍在离线列表中:', taskName);

                // 根据配置处理秒离线失败
                if (CFG.pan123InstantOfflineAction === 'auto_cancel') {
                    console.log('自动取消任务:', taskName);
                    await apiCancelOfflineTask(offlineTask.task_id, options);
                    actionTaken = '已自动取消任务';
                } else if (CFG.pan123InstantOfflineAction === 'ask_user') {
                    // 批量模式下跳过用户询问，直接保留任务
                    console.log('批量模式：保留任务:', taskName);
                    actionTaken = '保留任务继续下载';
                } else {
                    console.log('保留任务:', taskName);
                    actionTaken = '保留任务继续下载';
                }
            } else {
                console.log('秒离线成功:', taskName);
            }

            return {
                taskName: realTitle || taskName,
                fileCount: selectedFileIds.length,
                isInstantOffline,
                actionTaken
            };

        } catch (error) {
            console.error('处理磁力链接离线下载失败:', error);
            throw error;
        }
    }

    // 处理磁力链接离线下载（保持原有接口，用于单个发送）
    async function processMagnetOffline(magnetUrl, title) {
        if (!CFG.pan123Enabled) {
            showToast('请先在设置中启用 123Pan 功能并配置认证信息', 'warning');
            return;
        }

        try {
            console.log('开始处理磁力链接离线下载:', title);

            // 1. 通过磁力链接解析任务
            console.log('解析磁力链接...');
            const resolveResult = await apiResolveMagnet(magnetUrl);
            console.log('解析结果:', resolveResult);

            if (resolveResult.code !== 0) {
                throw new Error(`解析磁力链接失败: ${resolveResult.message}`);
            }

            const resourceList = resolveResult.data?.list || [];
            if (resourceList.length === 0) {
                throw new Error('没有找到可用的资源');
            }

            const item = resourceList[0];
            const resourceId = parseInt(item.id || item.resource_id || 0);
            const files = item.files || [];

            // 2. 选择文件
            console.log('选择文件...');
            const selectedFileIds = selectFiles(files);
            if (selectedFileIds.length === 0) {
                throw new Error('没有文件满足过滤条件');
            }

            // 3. 提交离线任务
            console.log('提交离线任务...');
            const submitResult = await apiSubmit(resourceId, selectedFileIds);
            if (submitResult.code !== 0 || submitResult.message !== 'ok') {
                throw new Error(`提交失败: ${submitResult.message}`);
            }

            console.log('离线任务提交成功:', submitResult);

            // 4. 检查秒离线
            setTimeout(async () => {
                try {
                    const taskName = item.name;
                    const offlineTask = await checkTaskInOfflineList(taskName);
                    const isInstantOffline = !offlineTask;
                    let actionTaken = '';

                    if (offlineTask) {
                        console.log('未秒离线成功，任务仍在离线列表中:', taskName);

                        // 根据配置处理秒离线失败
                        if (CFG.pan123InstantOfflineAction === 'auto_cancel') {
                            console.log('自动取消任务:', taskName);
                            await apiCancelOfflineTask(offlineTask.task_id);
                            actionTaken = '已自动取消任务';
                        } else if (CFG.pan123InstantOfflineAction === 'ask_user') {
                            const shouldCancel = await showInstantOfflineConfirmDialog(taskName, offlineTask.task_id);
                            if (shouldCancel) {
                                console.log('用户选择取消任务:', taskName);
                                await apiCancelOfflineTask(offlineTask.task_id);
                                actionTaken = '用户选择取消任务';
                            } else {
                                console.log('用户选择保留任务:', taskName);
                                actionTaken = '用户选择保留任务';
                            }
                        } else {
                            console.log('保留任务:', taskName);
                            actionTaken = '保留任务继续下载';
                        }
                    } else {
                        console.log('秒离线成功:', taskName);
                    }

                    // 显示详细的结果信息
                    const message = await handleInstantOfflineResult(taskName, selectedFileIds, isInstantOffline, actionTaken);
                    showSuccessModal(message);

                } catch (error) {
                    console.error('检查秒离线状态失败:', error);
                    showErrorModal(`检查秒离线状态失败: ${error.message}`);
                }
            }, CFG.pan123InstantOfflineCheckDelay);

        } catch (error) {
            console.error('处理磁力链接离线下载失败:', error);
            showErrorModal(`离线下载失败: ${error.message}`);
        }
    }

    // 为torrent文件添加123Pan按钮
    function addTorrent123PanButton(bar, filename, torrentUrl) {
        // 检查是否已经添加过按钮
        if (bar.querySelector('.sht-torrent-123pan-btn')) return;

        const btn123Pan = document.createElement('button');
        btn123Pan.textContent = '发送到123Pan';
        btn123Pan.className = 'sht-torrent-123pan-btn';
        btn123Pan.style.cssText = 'padding:2px 8px;cursor:pointer;background:#007cba;color:white;border:none;border-radius:3px';

        btn123Pan.addEventListener('click', async () => {
            await sendTorrentAttachmentToPan123(btn123Pan, torrentUrl, filename.replace(/\.torrent$/i, ''));
        });

        bar.appendChild(btn123Pan);
    }

    // 处理torrent文件离线下载
    async function processTorrentOffline(torrentBlob, title, options = {}) {
        if (!CFG.pan123Enabled) {
            showToast('请先在设置中启用 123Pan 功能并配置认证信息', 'warning');
            return;
        }

        try {
            console.log('开始处理torrent文件离线下载:', title);

            // 1. 上传 torrent 到 123Pan
            console.log('上传 torrent 文件...');
            const uploadResult = await apiUploadTorrent(torrentBlob, `${title}.torrent`, options);
            console.log('上传结果:', uploadResult);

            if (uploadResult.code !== 0) {
                throw new Error(`上传 torrent 失败: ${uploadResult.message}`);
            }

            const infohash = uploadResult.data.info_hash;
            console.log('上传成功，infohash:', infohash);

            // 2. 解析文件列表
            console.log('解析文件列表...');
            const resolveResult = await apiResolve(infohash, options);
            console.log('解析结果:', resolveResult);

            if (resolveResult.code !== 0) {
                throw new Error(`解析文件列表失败: ${resolveResult.message}`);
            }

            const resourceList = resolveResult.data?.list || [];
            if (resourceList.length === 0) {
                throw new Error('没有找到可用的资源');
            }

            const resource = resourceList[0];
            const resourceId = parseInt(resource.id || resource.resource_id || 0);
            const files = resource.files || [];

            // 3. 文件过滤和选择
            console.log('选择文件...');
            const selectedFileIds = selectFiles(files);
            console.log('选择的文件:', selectedFileIds);

            if (selectedFileIds.length === 0) {
                throw new Error('没有文件满足过滤条件');
            }

            // 4. 提交离线任务
            console.log('提交离线任务...');
            const submitResult = await apiSubmit(resourceId, selectedFileIds, options);
            console.log('提交结果:', submitResult);

            if (submitResult.code !== 0) {
                throw new Error(`提交离线任务失败: ${submitResult.message}`);
            }

            // 5. 检查任务状态（延迟检查）
            setTimeout(async () => {
                try {
                    const taskName = resource.name || title;
                    const offlineTask = await checkTaskInOfflineList(taskName);
                    const isInstantOffline = !offlineTask;
                    let actionTaken = '';

                    if (offlineTask) {
                        console.log('未秒离线成功，任务仍在离线列表中:', taskName);

                        // 根据配置处理秒离线失败
                        if (CFG.pan123InstantOfflineAction === 'auto_cancel') {
                            console.log('自动取消任务:', taskName);
                            await apiCancelOfflineTask(offlineTask.task_id);
                            actionTaken = '已自动取消任务';
                        } else if (CFG.pan123InstantOfflineAction === 'ask_user') {
                            const shouldCancel = await showInstantOfflineConfirmDialog(taskName, offlineTask.task_id);
                            if (shouldCancel) {
                                console.log('用户选择取消任务:', taskName);
                                await apiCancelOfflineTask(offlineTask.task_id);
                                actionTaken = '用户选择取消任务';
                            } else {
                                console.log('用户选择保留任务:', taskName);
                                actionTaken = '用户选择保留任务';
                            }
                        } else {
                            console.log('保留任务:', taskName);
                            actionTaken = '保留任务继续下载';
                        }
                    } else {
                        console.log('秒离线成功:', taskName);
                    }

                    // 显示详细的结果信息
                    const message = await handleInstantOfflineResult(taskName, selectedFileIds, isInstantOffline, actionTaken);
                    showSuccessModal(message);

                } catch (error) {
                    console.error('检查任务状态失败:', error);
                    showErrorModal(`检查任务状态失败: ${error.message}`);
                }
            }, CFG.pan123InstantOfflineCheckDelay);

        } catch (error) {
            console.error('处理torrent文件离线下载失败:', error);
            showErrorModal(`离线下载失败: ${error.message}`);
        }
    }

    // 显示磁力链接选择对话框
    function showMagnetSelectionDialog(magnetUrls) {
        // 创建对话框
        const dialog = document.createElement('div');
        dialog.style.cssText = `
    position: fixed; top: 0; left: 0; width: 100%; height: 100%;
    background: rgba(0,0,0,0.5); z-index: 10000; display: flex;
    align-items: center; justify-content: center; font-family: Arial, sans-serif;
  `;

        const panel = document.createElement('div');
        panel.style.cssText = `
    background: white; border-radius: 8px; padding: 20px; max-width: 600px;
    max-height: 80vh; overflow: hidden; box-shadow: 0 4px 20px rgba(0,0,0,0.3);
  `;

        const title = document.createElement('h3');
        title.textContent = '选择要发送到123Pan的磁力链接';
        title.style.cssText = 'margin: 0 0 15px 0; color: #333;';

        const listContainer = document.createElement('div');
        listContainer.style.cssText = 'max-height: 400px; overflow-y: auto; border: 1px solid #ddd; border-radius: 4px;';

        const magnetList = document.createElement('div');
        magnetList.style.cssText = 'padding: 10px;';

        // 创建每个磁力链接的选项
        magnetUrls.forEach((magnetUrl, index) => {
            const item = document.createElement('div');
            item.style.cssText = 'display: flex; align-items: center; padding: 8px; border-bottom: 1px solid #eee;';

            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.checked = true; // 默认全选
            checkbox.style.marginRight = '10px';

            const label = document.createElement('label');
            label.style.cssText = 'flex: 1; font-size: 12px; word-break: break-all; cursor: pointer;';

            // 提取标题
            const titleMatch = magnetUrl.match(/dn=([^&]+)/);
            const title = titleMatch ? decodeURIComponent(titleMatch[1]) : `磁力链接 ${index + 1}`;
            label.textContent = title;

            const sendBtn = document.createElement('button');
            sendBtn.textContent = '发送';
            sendBtn.style.cssText = 'padding: 4px 8px; background: #007cba; color: white; border: none; border-radius: 3px; cursor: pointer; margin-left: 8px;';
            sendBtn.addEventListener('click', async () => {
                if (!CFG.pan123Token || !CFG.pan123LoginUuid || !CFG.pan123Cookie) {
                    showToast('请先在设置中配置 123Pan 认证信息', 'warning');
                    return;
                }

                sendBtn.textContent = '发送中...';
                sendBtn.disabled = true;

                try {
                    await processMagnetOffline(magnetUrl, title);
                } catch (error) {
                    console.error('发送失败:', error);
                    showErrorModal(`发送失败: ${error.message}`);
                } finally {
                    sendBtn.textContent = '发送';
                    sendBtn.disabled = false;
                }
            });

            item.appendChild(checkbox);
            item.appendChild(label);
            item.appendChild(sendBtn);
            magnetList.appendChild(item);
        });

        listContainer.appendChild(magnetList);

        // 按钮区域
        const buttonArea = document.createElement('div');
        buttonArea.style.cssText = 'margin-top: 15px; display: flex; gap: 10px; justify-content: flex-end;';

        const selectAllBtn = document.createElement('button');
        selectAllBtn.textContent = '全选';
        selectAllBtn.style.cssText = 'padding: 6px 12px; border: 1px solid #ddd; background: #f5f5f5; border-radius: 4px; cursor: pointer;';
        selectAllBtn.addEventListener('click', () => {
            const checkboxes = magnetList.querySelectorAll('input[type="checkbox"]');
            checkboxes.forEach(cb => cb.checked = true);
        });

        const selectNoneBtn = document.createElement('button');
        selectNoneBtn.textContent = '全不选';
        selectNoneBtn.style.cssText = 'padding: 6px 12px; border: 1px solid #ddd; background: #f5f5f5; border-radius: 4px; cursor: pointer;';
        selectNoneBtn.addEventListener('click', () => {
            const checkboxes = magnetList.querySelectorAll('input[type="checkbox"]');
            checkboxes.forEach(cb => cb.checked = false);
        });

        const batchSendBtn = document.createElement('button');
        batchSendBtn.textContent = '批量发送选中';
        batchSendBtn.style.cssText = 'padding: 6px 12px; background: #007cba; color: white; border: none; border-radius: 4px; cursor: pointer;';
        batchSendBtn.addEventListener('click', async () => {
            if (!CFG.pan123Token || !CFG.pan123LoginUuid || !CFG.pan123Cookie) {
                showWarningModal('请先在设置中配置 123Pan 认证信息');
                return;
            }

            const checkboxes = magnetList.querySelectorAll('input[type="checkbox"]');
            const selectedUrls = [];
            checkboxes.forEach((cb, index) => {
                if (cb.checked) {
                    selectedUrls.push(magnetUrls[index]);
                }
            });

            if (selectedUrls.length === 0) {
                showWarningModal('请至少选择一个磁力链接');
                return;
            }

            batchSendBtn.textContent = '批量发送中...';
            batchSendBtn.disabled = true;

            try {
                await processBatchMagnetOffline(selectedUrls);
                dialog.remove();
            } catch (error) {
                console.error('批量发送失败:', error);
                showErrorModal(`批量发送失败: ${error.message}`);
            } finally {
                batchSendBtn.textContent = '批量发送选中';
                batchSendBtn.disabled = false;
            }
        });

        const cancelBtn = document.createElement('button');
        cancelBtn.textContent = '取消';
        cancelBtn.style.cssText = 'padding: 6px 12px; border: 1px solid #ddd; background: #f5f5f5; border-radius: 4px; cursor: pointer;';
        cancelBtn.addEventListener('click', () => dialog.remove());

        buttonArea.appendChild(selectAllBtn);
        buttonArea.appendChild(selectNoneBtn);
        buttonArea.appendChild(batchSendBtn);
        buttonArea.appendChild(cancelBtn);

        panel.appendChild(title);
        panel.appendChild(listContainer);
        panel.appendChild(buttonArea);
        dialog.appendChild(panel);
        document.body.appendChild(dialog);

        // 点击背景关闭
        dialog.addEventListener('click', (e) => {
            if (e.target === dialog) dialog.remove();
        });
    }
