    /*********************** 网络与解压（同前） ***********************/
    async function httpGetArrayBuffer(url, options = {}) {
        const response = await shtRequest({
            method: 'GET', url, responseType: 'arraybuffer', timeout: 30_000,
            signal: options.signal, onProgress: options.onProgress, retries: 1,
            scope: 'attachment',
            headers: {
                'Referer': location.href,
                'Accept': 'text/plain, text/html, application/octet-stream, */*',
                'Accept-Charset': 'utf-8, gbk, gb2312, shift_jis, euc-jp, big5, iso-8859-1',
                'Accept-Encoding': 'identity'
            }
        });
        return response.response;
    }
    async function tryExtractZipTexts(buf, pwds, maxEntryBytes) {
        await loadOptionalLibrary('zip');
        const blob = new Blob([buf]); const results = []; const tries = ['', ...pwds.filter(p => p && p.trim() !== '')];
        for (const pwd of tries) {
            try {
                const zr = new zip.ZipReader(new zip.BlobReader(blob), { password: pwd || undefined }); const entries = await zr.getEntries();
                for (const e of entries) {
                    if (e.directory) continue; if (!isTextLike(e.filename)) continue;
                    // 额外检查是否为图片文件或种子文件，避免处理压缩包中的图片和种子
                    const isImageFile = /\.(jpg|jpeg|png|gif|webp|bmp|svg|ico)$/i.test(e.filename);
                    const isTorrentFile = /\.torrent$/i.test(e.filename);
                    if (isImageFile || isTorrentFile) continue;
                    if (typeof e.uncompressedSize === 'number' && e.uncompressedSize > maxEntryBytes) continue;
                    const u8 = await e.getData(new zip.Uint8ArrayWriter()); const text = decodeBest(u8);
                    if (text) results.push({ name: e.filename, text: text.replace(/\uFFFD/g, ''), size: u8.byteLength, pwd });
                } await zr.close(); if (results.length) break;
            } catch { }
        }
        return dedupeByName(results);
    }
    // RAR 文件检测函数
    function isRarFile(array_buffer) {
        if (array_buffer.byteLength < 8) {
            return false;
        }

        const header1 = Array.from(new Uint8Array(array_buffer).slice(0, 4)).join(', ');
        const header2 = Array.from(new Uint8Array(array_buffer).slice(0, 7)).join(', ');
        const header3 = Array.from(new Uint8Array(array_buffer).slice(0, 8)).join(', ');

        const rar_header1 = '82, 69, 126, 94'; // old
        const rar_header2 = '82, 97, 114, 33, 26, 7, 0'; // 1.5 to 4.0
        const rar_header3 = '82, 97, 114, 33, 26, 7, 1, 0'; // 5.0

        return (header1 === rar_header1 || header2 === rar_header2 || header3 === rar_header3);
    }

    async function tryExtractRarTexts(buf, pwds, maxEntryBytes) {
        const results = [];
        const tries = ['', ...pwds.filter(p => p && p.trim() !== '')];

        for (const pwd of tries) {
            try {
                const result = await tryExtractWithPassword(buf, pwd);

                if (result.ok && result.entries) {
                    for (const entry of result.entries) {
                        const name = entry.name;

                        if (!isTextLike(name)) continue;

                        // 额外检查是否为图片文件或种子文件，避免处理压缩包中的图片和种子
                        const isImageFile = /\.(jpg|jpeg|png|gif|webp|bmp|svg|ico)$/i.test(name);
                        const isTorrentFile = /\.torrent$/i.test(name);
                        if (isImageFile || isTorrentFile) continue;

                        const size = entry.size || 0;
                        if (size && size > maxEntryBytes) continue;

                        // 解码文本内容 - 改进编码检测
                        let text = null;
                        try {
                            // 调试数据格式
                            console.log('[RAR] 处理文件:', name, '原始数据类型:', typeof entry.data, 'isArray:', Array.isArray(entry.data), 'length:', entry.data?.length);

                            // 确保数据是 Uint8Array 格式
                            const data = toU8(entry.data);
                            if (!data) {
                                console.log('[RAR] 无法转换文件数据:', name, '原始数据:', entry.data);
                                continue;
                            }

                            console.log('[RAR] 数据转换成功:', name, '转换后类型:', data.constructor.name, '长度:', data.length, '前10字节:', Array.from(data.slice(0, 10)));

                            // 使用改进的编码检测
                            text = decodeBest(data, name);

                            // 如果解码结果包含大量乱码字符，尝试其他编码
                            if (text && /[\uFFFD\uFFFE\uFFFF]/.test(text) && text.length > 10) {
                                console.log('[RAR] 检测到乱码，尝试其他编码:', name);

                                // 尝试常见的中文编码
                                const chineseEncodings = ['gbk', 'gb18030', 'big5', 'utf-8'];
                                for (const encoding of chineseEncodings) {
                                    try {
                                        const testText = new TextDecoder(encoding).decode(data);
                                        if (!/[\uFFFD\uFFFE\uFFFF]/.test(testText) || testText.length > text.length) {
                                            text = testText;
                                            console.log('[RAR] 使用编码', encoding, '成功:', name);
                                            break;
                                        }
                                    } catch (e) {
                                        // 忽略编码错误
                                    }
                                }
                            }

                            if (text) {
                                results.push({
                                    name,
                                    text: text.replace(/\uFFFD/g, ''),
                                    size: size,
                                    pwd
                                });
                            }
                        } catch (error) {
                            console.log('[RAR] 文本解码失败:', name, error);
                        }
                    }
                }

                if (results.length) break;
            } catch (error) {
                console.log('RAR 解压失败:', error);
            }
        }

        return dedupeByName(results);
    }
    function dedupeByName(arr) { const map = new Map(); for (const x of arr) if (!map.has(x.name)) map.set(x.name, x); return Array.from(map.values()); }

    // 一键评分功能
    async function quickRate(originalRateBtn) {
        try {
            console.log('原始评分按钮:', originalRateBtn);
            console.log('按钮href:', originalRateBtn.href);
            console.log('按钮onclick:', originalRateBtn.onclick);

            // 尝试从href或onclick中提取评分URL
            let rateUrl = originalRateBtn.href;

            // 如果没有href，尝试从onclick中提取
            if (!rateUrl && originalRateBtn.onclick) {
                const onclickStr = originalRateBtn.onclick.toString();
                console.log('onclick字符串:', onclickStr);

                // 查找showWindow调用中的URL
                const showWindowMatch = onclickStr.match(/showWindow\([^,]+,\s*['"]([^'"]+)['"]/);
                if (showWindowMatch) {
                    rateUrl = showWindowMatch[1];
                    console.log('从onclick提取的URL:', rateUrl);
                }
            }

            if (!rateUrl || !rateUrl.includes('rate')) {
                console.log('无法获取评分URL，尝试从页面URL提取参数');

                // 从当前页面URL中提取tid
                const currentUrl = new URL(location.href);
                const tid = currentUrl.searchParams.get('tid');

                if (!tid) {
                    console.log('无法从页面URL获取tid');
                    return;
                }

                // 尝试从页面中查找pid
                const pidMatch = document.querySelector('input[name="pid"]') ||
                    document.querySelector('[name="pid"]') ||
                    document.querySelector('#pid') ||
                    document.querySelector('[id*="pid"]');

                let pid = null;
                if (pidMatch) {
                    pid = pidMatch.value || pidMatch.id?.replace(/[^\d]/g, '');
                }

                if (!pid) {
                    // 尝试从页面内容中查找pid
                    const pidRegex = /pid(\d+)/;
                    const pageContent = document.documentElement.innerHTML;
                    const pidMatch2 = pageContent.match(pidRegex);
                    if (pidMatch2) {
                        pid = pidMatch2[1];
                    }
                }

                if (!pid) {
                    console.log('无法获取pid');
                    return;
                }

                console.log('使用页面参数 - tid:', tid, 'pid:', pid);

                // 直接使用提取的参数
                await submitRating(tid, pid);
                return;
            }

            // 从URL中提取tid和pid
            const urlParams = new URLSearchParams(rateUrl.split('?')[1]);
            const tid = urlParams.get('tid');
            const pid = urlParams.get('pid');

            if (!tid || !pid) {
                console.log('无法获取tid或pid');
                return;
            }

            await submitRating(tid, pid);
        } catch (error) {
            console.error('评分过程中出错:', error);
            showToast('评分过程中出错: ' + describeRequestError(error), 'error', 5000);
        }
    }

    // 提交评分的独立函数
    async function submitRating(tid, pid) {
        try {
            console.log('开始提交评分 - tid:', tid, 'pid:', pid);

            // 获取formhash
            const formhashInput = document.querySelector('input[name="formhash"]');
            const formhash = formhashInput ? formhashInput.value : '';

            if (!formhash) {
                console.log('无法获取formhash');
                showToast('无法获取安全令牌，请刷新页面后重试', 'warning', 5000);
                return;
            }

            // 构建评分请求数据 - 根据实际 curl 请求格式
            const rateData = new URLSearchParams();
            rateData.append('formhash', formhash);
            rateData.append('tid', tid);
            rateData.append('pid', pid);
            rateData.append('referer', location.href);
            rateData.append('handlekey', 'rate');
            rateData.append('score8', CFG.defaultRateScore.toString());
            rateData.append('reason', CFG.defaultRateReason); // 添加评分理由

            // 始终向当前论坛来源发送评分，兼容官方子域名与同源镜像。
            const rateEndpoint = new URL('/forum.php?mod=misc&action=rate&ratesubmit=yes&infloat=yes&inajax=1', location.origin);
            const response = await shtRequest({
                method: 'POST',
                url: rateEndpoint.toString(),
                responseType: 'text',
                timeout: 20_000,
                retries: 0,
                scope: 'rating',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'X-Requested-With': 'XMLHttpRequest',
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
                    'Accept-Language': 'en-GB,en-US;q=0.9,en;q=0.8,zh-CN;q=0.7,zh;q=0.6',
                    'Cache-Control': 'max-age=0',
                    'Sec-Fetch-Dest': 'iframe',
                    'Sec-Fetch-Mode': 'navigate',
                    'Sec-Fetch-Site': 'same-origin',
                    'Sec-Fetch-User': '?1',
                    'Upgrade-Insecure-Requests': '1'
                },
                data: rateData.toString()
            });

            console.log('评分响应状态:', response.status);

            if (response.status >= 200 && response.status < 300) {
                const result = response.responseText || response.response || '';
                console.log('评分响应内容:', result);

                // 检查是否包含成功标识
                const isSuccess = result.includes('succeedhandle_rate') ||
                    result.includes('成功') ||
                    result.includes('success') ||
                    result.includes('评分成功') ||
                    result.includes('评分完成') ||
                    result.includes('操作成功');

                if (isSuccess) {
                    // 尝试提取成功消息
                    let successMessage = `评分成功！已给出${CFG.defaultRateScore}分`;
                    const successMatch = result.match(/succeedhandle_rate\([^,]+,\s*['"]([^'"]+)['"]/);
                    if (successMatch) {
                        successMessage = successMatch[1]; // 使用服务器返回的消息
                    }

                    // 评分成功，更新按钮状态
                    const rateClone = document.querySelector('#ak_rate');
                    if (rateClone) {
                        rateClone.style.background = '#4CAF50';
                        rateClone.style.color = 'white';
                        rateClone.textContent = `已评分(${CFG.defaultRateScore}分)`;
                        rateClone.onclick = null; // 禁用再次点击
                    }
                    console.log(`评分成功: ${CFG.defaultRateScore}分 - ${successMessage}`);
                    showToast(successMessage, 'success');
                } else {
                    console.log('评分失败:', result);
                    showToast('评分失败，请检查登录状态或权限', 'error', 5000);
                }
            } else {
                console.log('评分请求失败:', response.status);
                showToast('评分请求失败，状态码: ' + response.status, 'error', 5000);
            }
        } catch (error) {
            console.error('评分过程中出错:', error);
            showToast('评分过程中出错: ' + describeRequestError(error), 'error', 5000);
        }
    }
