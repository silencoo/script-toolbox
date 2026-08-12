    /*********************** 配置 ***********************/
    const CONFIG_SCHEMA_VERSION = 3;
    const volatileCredentialVault = {};
    const DEFAULT_CONFIG = {
        schemaVersion: CONFIG_SCHEMA_VERSION,
        maxAutoBytes: 2 * 1024 * 1024,
        autoHoistToTop: true,
        textExts: ['txt', 'nfo', 'log', 'json', 'ini', 'md', 'csv'],
        maxEntryBytes: 3 * 1024 * 1024,
        passwordCandidates: ['', 'www.98T.la', '98T.la', '98t', 'sehuatang', 'sht', 'sht123', '123456', 'www.sehuatang.org'],
        wrapAtTop: true,
        toolbarCompactMode: false,
        toolbarGroupState: { quick: true, attachments: false, cloud: false, more: false },

        blockImages: true,
        imageAllowDomains: [],
        imagePlaceholderShowMeta: false,
        imageMinBlockSizePx: 40,
        imageProcessBatch: 50,
        mutationDebounceMs: 300,

        autoCollectED2K: true,
        ed2kDebounceMs: 500,

        autoCollectMagnet: true,
        magnetDebounceMs: 500,

        // 历史记录功能
        enableHistory: true,
        maxHistoryItems: 1000,
        historyItems: [],

        // 只看楼主功能
        authorOnlyMode: false,

        // 一键评分功能
        enableQuickRate: true,
        defaultRateScore: 2, // 默认评分分数
        defaultRateReason: '很给力!', // 默认评分理由

        // 排版优化功能
        hideReplyColumn: false,
        hideLastReplyColumn: false,
        hideAuthorColumn: false,
        hideStickyThreads: false,

        // 分页和过滤功能
        hidePagination: false,
        enableKeywordFilter: false,
        keywordFilters: [],
        enhanceTitles: false,

        // 历史访问帖子处理
        historyPostAction: 'none', // 'none', 'hide', 'blue', 'strikethrough'
        historyPostColor: '#0066cc',

        // 帖子详情标题处理
        enableThreadTitleEnhance: false,
        titleReplaceRules: [
            { pattern: '\\[\\d+\\.\\d+G/\\d+V/\\d+配额\\]', replacement: '' }
        ],
        hideTypeLabels: ['情色分享', '图文故事', '视频分享'],

        // 帖子列表页标题处理
        enableListTitleEnhance: false,
        listTitleReplaceRules: [
            { pattern: '\\[\\d+\\.\\d+G/\\d+V/\\d+配额\\]', replacement: '' },
            { pattern: '\\[情色分享\\]', replacement: '' },
            { pattern: '\\[图文故事\\]', replacement: '' }
        ],

        // 论坛模块屏蔽
        enableModuleFilter: false,
        hiddenModules: [],

        // 123Pan 离线下载配置
        // 115 离线下载配置
        pan115Enabled: false,
        pan115Cookie: '',
        pan115UserAgent: '',
        pan115UploadDir: '',
        pan115FolderNames: {},
        pan115CurrentThreadFolder: '',
        pan115ThreadFolders: {},

        // 123Pan 离线下载配置
        pan123Enabled: false,
        pan123Token: '',
        pan123LoginUuid: '',
        pan123Cookie: '',
        pan123UploadDir: '',
        pan123MinSize: '10MB',
        pan123MaxSize: '1000GB',
        pan123IncludeExt: 'mp4,avi,mkv,wmv,flv,mov',
        pan123ExcludeExt: 'txt,nfo,srt,sub,url,mht,jpg,jpeg,png,gif,bmp,webp,ico,svg',
        pan123VideoMinSize: '100MB',
        pan123PickLargest: false,

        // 秒离线处理配置
        pan123InstantOfflineAction: 'auto_cancel', // 'auto_cancel', 'ask_user', 'keep_task'
        pan123InstantOfflineCheckDelay: 2000, // 检查延迟时间(毫秒)
        pan123BatchSendInterval: 2000, // 批量发送间隔时间(毫秒)
        pan123CurrentThreadFolder: '', // 当前帖子的文件夹ID
        pan123ThreadFolders: {}, // 帖子URL到文件夹ID的映射

        // 任务、凭据和诊断
        cloudTaskConcurrency: 2,
        credentialsSessionOnly: false,
        debugMode: false,

        // ED2K文件名处理配置
        ed2kFileNameReplaceEnabled: false,
        ed2kFileNameReplaceRules: [
            { pattern: '\\[\\d+\\.\\d+G/\\d+V/\\d+配额\\]', replacement: '' },
            { pattern: '\\[情色分享\\]', replacement: '' },
            { pattern: '\\[图文故事\\]', replacement: '' },
            { pattern: '\\[视频分享\\]', replacement: '' }
        ]
    };
    const MAIN_CONFIG_KEY = 'sht_cfg_v2';
    const SEARCH_CONFIG_KEY = 'sht_sorter_config';
    const CONFIG_EXPORT_VERSION = SCRIPT_VERSION;
    const SENSITIVE_CONFIG_KEYS = Object.freeze([
        'pan115Cookie',
        'pan115UserAgent',
        'pan123Token',
        'pan123LoginUuid',
        'pan123Cookie'
    ]);
    let CFG = loadConfig();

    function readSessionCredentials() {
        return { ...volatileCredentialVault };
    }

    function migrateConfig(input) {
        const migrated = input && typeof input === 'object' && !Array.isArray(input) ? { ...input } : {};
        const fromVersion = Number(migrated.schemaVersion || 1);
        if (fromVersion < 2 && migrated.toolbarCollapsed != null) {
            migrated.toolbarCompactMode = Boolean(migrated.toolbarCollapsed);
            delete migrated.toolbarCollapsed;
        }
        if (fromVersion < 3) {
            if (migrated.toolbarGroupState) {
                migrated.toolbarGroupState = { ...DEFAULT_CONFIG.toolbarGroupState, ...migrated.toolbarGroupState };
            }
            if (migrated.cloudTaskConcurrency != null) {
                migrated.cloudTaskConcurrency = Math.max(1, Math.min(4, Number(migrated.cloudTaskConcurrency) || 2));
            }
        }
        migrated.schemaVersion = CONFIG_SCHEMA_VERSION;
        return migrated;
    }

    function saveConfig() {
        const storedConfig = cloneJson(CFG);
        storedConfig.schemaVersion = CONFIG_SCHEMA_VERSION;
        if (storedConfig.credentialsSessionOnly) {
            SENSITIVE_CONFIG_KEYS.forEach(key => {
                volatileCredentialVault[key] = storedConfig[key] || '';
                storedConfig[key] = '';
            });
        } else {
            SENSITIVE_CONFIG_KEYS.forEach(key => delete volatileCredentialVault[key]);
        }
        const configString = JSON.stringify(storedConfig);
        GM_setValue(MAIN_CONFIG_KEY, configString);
        diagnosticLog('debug', 'config', '配置已保存', {
            schemaVersion: CONFIG_SCHEMA_VERSION,
            credentialsSessionOnly: storedConfig.credentialsSessionOnly
        });
    }
    function loadConfig() {
        try {
            const raw = GM_getValue(MAIN_CONFIG_KEY);
            if (raw) {
                const parsed = migrateConfig(JSON.parse(raw));
                const config = {
                    ...DEFAULT_CONFIG,
                    ...parsed,
                    toolbarGroupState: { ...DEFAULT_CONFIG.toolbarGroupState, ...(parsed.toolbarGroupState || {}) }
                };
                if (config.credentialsSessionOnly) Object.assign(config, readSessionCredentials());
                return config;
            }
        } catch (e) {
            diagnosticLog('warning', 'config', '配置加载失败，已回退默认值', { message: e?.message });
        }
        return cloneJson(DEFAULT_CONFIG);
    }

    /*********************** 图标与控件 ***********************/
    const SVG_NS = 'http://www.w3.org/2000/svg';
    const ICON_DEFINITIONS = Object.freeze({
        arrowDown: [['path', { d: 'M12 5v14m0 0 6-6m-6 6-6-6' }]],
        arrowUp: [['path', { d: 'M12 19V5m0 0 6 6m-6-6-6 6' }]],
        bolt: [['path', { d: 'm13 2-9 12h7l-1 8 9-12h-7l1-8Z' }]],
        chart: [
            ['path', { d: 'M4 19V9m6 10V5m6 14v-7m4 7H2' }]
        ],
        checkCircle: [
            ['circle', { cx: '12', cy: '12', r: '9' }],
            ['path', { d: 'm8 12 2.5 2.5L16 9' }]
        ],
        clipboard: [
            ['rect', { x: '6', y: '5', width: '12', height: '16', rx: '2' }],
            ['path', { d: 'M9 5V3h6v2M9 10h6m-6 4h6' }]
        ],
        close: [
            ['path', { d: 'm6 6 12 12M18 6 6 18' }]
        ],
        cloud: [
            ['path', { d: 'M7 18h10a4 4 0 0 0 .6-7.95A6 6 0 0 0 6.2 8.2 4.5 4.5 0 0 0 7 18Z' }]
        ],
        database: [
            ['ellipse', { cx: '12', cy: '5', rx: '8', ry: '3' }],
            ['path', { d: 'M4 5v6c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 11v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6' }]
        ],
        download: [
            ['path', { d: 'M12 3v12m0 0 5-5m-5 5-5-5M5 21h14' }]
        ],
        errorCircle: [
            ['circle', { cx: '12', cy: '12', r: '9' }],
            ['path', { d: 'm9 9 6 6m0-6-6 6' }]
        ],
        eye: [
            ['path', { d: 'M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z' }],
            ['circle', { cx: '12', cy: '12', r: '2.5' }]
        ],
        filter: [
            ['path', { d: 'M3 5h18l-7 8v6l-4 2v-8L3 5Z' }]
        ],
        folder: [
            ['path', { d: 'M3 6.5h7l2 2h9v9.5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6.5Z' }]
        ],
        history: [
            ['path', { d: 'M3 12a9 9 0 1 0 3-6.7L3 8m0 0V3m0 5h5' }],
            ['path', { d: 'M12 7v5l3 2' }]
        ],
        image: [
            ['rect', { x: '3', y: '4', width: '18', height: '16', rx: '2' }],
            ['circle', { cx: '8.5', cy: '9', r: '1.5' }],
            ['path', { d: 'm4 17 5-5 4 4 2-2 5 5' }]
        ],
        import: [
            ['path', { d: 'M12 3v12m0 0 5-5m-5 5-5-5M5 21h14' }]
        ],
        refresh: [
            ['path', { d: 'M20 7v5h-5M4 17v-5h5' }],
            ['path', { d: 'M6.1 8A7 7 0 0 1 18.5 7M17.9 16A7 7 0 0 1 5.5 17' }]
        ],
        search: [
            ['circle', { cx: '11', cy: '11', r: '7' }],
            ['path', { d: 'm16 16 5 5' }]
        ],
        settings: [
            ['circle', { cx: '12', cy: '12', r: '3' }],
            ['path', { d: 'M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H2.8v-4H3a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1a1.7 1.7 0 0 0 1.9.3A1.7 1.7 0 0 0 10 3V2.8h4V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v4H21a1.7 1.7 0 0 0-1.6 1Z' }]
        ],
        trash: [
            ['path', { d: 'M4 7h16M9 3h6l1 4H8l1-4Zm-3 4 1 14h10l1-14M10 11v6m4-6v6' }]
        ],
        upload: [
            ['path', { d: 'M12 15V3m0 0 5 5m-5-5-5 5M5 21h14' }]
        ],
        user: [
            ['circle', { cx: '12', cy: '8', r: '4' }],
            ['path', { d: 'M4 21a8 8 0 0 1 16 0' }]
        ],
        warning: [
            ['path', { d: 'M12 3 2.5 20h19L12 3Z' }],
            ['path', { d: 'M12 9v4m0 3h.01' }]
        ],
        wrench: [
            ['path', { d: 'M14.5 6.5a4 4 0 0 0-5-5L7 4l3 3-3 3-3-3-2.5 2.5a4 4 0 0 0 5 5L15 23l4-4-8.5-8.5' }]
        ]
    });

    function createIcon(name, size = 16) {
        const definition = ICON_DEFINITIONS[name];
        if (!definition) throw new Error(`未知图标: ${name}`);

        const svg = document.createElementNS(SVG_NS, 'svg');
        svg.setAttribute('viewBox', '0 0 24 24');
        svg.setAttribute('width', String(size));
        svg.setAttribute('height', String(size));
        svg.setAttribute('fill', 'none');
        svg.setAttribute('stroke', 'currentColor');
        svg.setAttribute('stroke-width', '1.8');
        svg.setAttribute('stroke-linecap', 'round');
        svg.setAttribute('stroke-linejoin', 'round');
        svg.setAttribute('aria-hidden', 'true');
        svg.setAttribute('focusable', 'false');
        svg.style.flex = '0 0 auto';

        definition.forEach(([tag, attributes]) => {
            const node = document.createElementNS(SVG_NS, tag);
            Object.entries(attributes).forEach(([key, value]) => node.setAttribute(key, value));
            svg.appendChild(node);
        });
        return svg;
    }

    function setIconLabel(element, iconName, label = '', size = 16) {
        element.replaceChildren(createIcon(iconName, size));
        if (label) element.appendChild(document.createTextNode(label));
        if (element instanceof HTMLButtonElement) {
            element.type = 'button';
            element.style.display = 'inline-flex';
            element.style.alignItems = 'center';
            element.style.justifyContent = 'center';
            element.style.gap = '5px';
        }
        return element;
    }

    /*********************** 工具函数 ***********************/
    const extOf = (n = '') => (n.toLowerCase().match(/\.([a-z0-9]+)(?:\?|$)/) || [])[1] || '';
    const isTextLike = n => CFG.textExts.includes(extOf(n));
    const isZip = n => extOf(n) === 'zip';
    const isRar = n => extOf(n) === 'rar';
    const absoluteUrl = href => { try { return new URL(href, location.origin).toString(); } catch { return href; } };
    const hostnameOf = url => { try { return new URL(url, location.origin).hostname; } catch { return ''; } };
    function analyzeDecodedText(str) {
        const stats = {
            length: str.length,
            replacement: 0,
            nulls: 0,
            controls: 0,
            whitespace: 0,
            letters: 0,
            vowels: 0,
            digits: 0,
            cjk: 0,
            hiragana: 0,
            katakana: 0,
            hangul: 0,
            punctuation: 0,
            asciiPrintable: 0,
            otherPrintable: 0,
            unique: new Set(),
        };
        for (const ch of str) {
            const code = ch.charCodeAt(0);
            stats.unique.add(ch);
            if (code === 0) { stats.nulls++; continue; }
            if (code === 0xFFFD) stats.replacement++;
            if (code < 0x20) {
                if (code === 0x09 || code === 0x0A || code === 0x0D) stats.whitespace++;
                else stats.controls++;
                continue;
            }
            if (code === 0x20 || code === 0xA0) {
                stats.whitespace++;
                continue;
            }
            if ((code >= 0x41 && code <= 0x5A) || (code >= 0x61 && code <= 0x7A)) {
                stats.letters++;
                if ('AEIOUaeiou'.includes(ch)) stats.vowels++;
            }
            if (code >= 0x30 && code <= 0x39) stats.digits++;
            if ((code >= 0x4E00 && code <= 0x9FFF) || (code >= 0x3400 && code <= 0x4DBF)) stats.cjk++;
            if (code >= 0x3040 && code <= 0x309F) stats.hiragana++;
            if (code >= 0x30A0 && code <= 0x30FF) stats.katakana++;
            if (code >= 0xAC00 && code <= 0xD7A3) stats.hangul++;
            if ((code >= 0x21 && code <= 0x2F) || (code >= 0x3A && code <= 0x40) || (code >= 0x5B && code <= 0x60) || (code >= 0x7B && code <= 0x7E)) {
                stats.punctuation++;
            }
            if (code >= 0x20 && code <= 0x7E) stats.asciiPrintable++;
            else stats.otherPrintable++;
        }
        stats.uniqueCount = stats.unique.size;
        stats.uniqueRatio = stats.uniqueCount / Math.max(1, stats.length);
        stats.asciiPrintableRatio = stats.asciiPrintable / Math.max(1, stats.length);
        stats.cjkRatio = stats.cjk / Math.max(1, stats.length);
        stats.letterRatio = stats.letters / Math.max(1, stats.length);
        stats.whitespaceRatio = stats.whitespace / Math.max(1, stats.length);
        stats.vowelRatio = stats.vowels / Math.max(1, stats.length);
        return stats;
    }

    function scoreDecodedStats(stats, encoding, extra = 0) {
        if (!stats || stats.length === 0) return -Infinity;
        if (stats.replacement > 0 || stats.nulls > 0 || stats.controls > Math.max(1, stats.length * 0.02)) {
            return -Infinity;
        }
        let score = extra;
        score += stats.cjk * 4.0;
        score += (stats.hiragana + stats.katakana + stats.hangul) * 3.5;
        score += stats.letters * 3.0;
        score += stats.digits * 1.6;
        score += stats.whitespace * 0.8;
        score += stats.punctuation * 0.1;
        score += stats.asciiPrintable * 0.1;
        score += stats.otherPrintable * 0.6;
        score += stats.uniqueCount * 0.2;
        score += stats.vowels * 0.4;
        if (encoding.startsWith('utf-16')) score += 1.0;
        if (encoding === 'utf-8') score += 0.5;
        if (stats.uniqueRatio < 0.05 && stats.length > 20) score -= 5;
        return score;
    }

    function computePairSimilarity(buf) {
        const even = new Array(256).fill(0);
        const odd = new Array(256).fill(0);
        let pairs = 0;
        for (let i = 0; i + 1 < buf.length; i += 2) {
            even[buf[i]]++;
            odd[buf[i + 1]]++;
            pairs++;
        }
        if (!pairs) return 1;
        let dot = 0, evenNorm = 0, oddNorm = 0;
        for (let i = 0; i < 256; i++) {
            dot += even[i] * odd[i];
            evenNorm += even[i] * even[i];
            oddNorm += odd[i] * odd[i];
        }
        if (!evenNorm || !oddNorm) return 1;
        return dot / Math.sqrt(evenNorm * oddNorm);
    }

    function computeUtf16Heuristics(buf) {
        let zeroEven = 0;
        let zeroOdd = 0;
        let pairs = 0;
        for (let i = 0; i + 1 < buf.length; i += 2) {
            if (buf[i] === 0) zeroEven++;
            if (buf[i + 1] === 0) zeroOdd++;
            pairs++;
        }
        const similarity = computePairSimilarity(buf);
        return { pairs, zeroEven, zeroOdd, similarity };
    }

    function decodeBest(buf, debugName = '') {
        const data = buf instanceof Uint8Array
            ? buf
            : buf instanceof ArrayBuffer
                ? new Uint8Array(buf)
                : toU8(buf);
        if (!data || !data.length) {
            console.log(`[编码检测] ${debugName} 无有效字节输入`);
            return '';
        }

        // 1. 优先检测 BOM（最可靠）
        if (data.length >= 3) {
            if (data[0] === 0xEF && data[1] === 0xBB && data[2] === 0xBF) {
                try {
                    const bomDecoded = new TextDecoder('utf-8').decode(data.slice(3));
                    console.log(`[编码检测] ${debugName} 使用 UTF-8 BOM 解码`);
                    return bomDecoded;
                } catch { }
            }
            if (data[0] === 0xFF && data[1] === 0xFE) {
                try {
                    const bomDecoded = new TextDecoder('utf-16le').decode(data.slice(2));
                    console.log(`[编码检测] ${debugName} 使用 UTF-16LE BOM 解码`);
                    return bomDecoded;
                } catch { }
            }
            if (data[0] === 0xFE && data[1] === 0xFF) {
                try {
                    const bomDecoded = new TextDecoder('utf-16be').decode(data.slice(2));
                    console.log(`[编码检测] ${debugName} 使用 UTF-16BE BOM 解码`);
                    return bomDecoded;
                } catch { }
            }
        }

        const candidates = [];
        const utf16Heur = computeUtf16Heuristics(data);
        const pairs = utf16Heur.pairs;
        const ratioEvenZero = pairs ? utf16Heur.zeroEven / pairs : 0;
        const ratioOddZero = pairs ? utf16Heur.zeroOdd / pairs : 0;
        const utf16Similarity = utf16Heur.similarity;
        const suspectUtf16 = data.length >= 4 && data.length % 2 === 0 &&
            (utf16Similarity < 0.2 || ratioEvenZero > 0.4 || ratioOddZero > 0.4);
        console.log(`[编码检测] ${debugName} UTF-16 启发式`, {
            length: data.length,
            pairs,
            zeroEven: utf16Heur.zeroEven,
            zeroOdd: utf16Heur.zeroOdd,
            ratioEvenZero,
            ratioOddZero,
            similarity: utf16Similarity,
            suspectUtf16
        });

        function addCandidateFromDecoded(decoded, encoding, extra = 0) {
            const stats = analyzeDecodedText(decoded);
            const score = scoreDecodedStats(stats, encoding, extra);
            if (score === -Infinity) return;
            candidates.push({ encoding, decoded, stats, score });
            console.log(`[编码检测] ${debugName} 候选 ${encoding} 分数:`, score, stats);
        }

        function tryAdd(encoding, extra = 0, decoderOptions) {
            let adjustedExtra = extra;
            if (suspectUtf16 && !encoding.startsWith('utf-16')) {
                adjustedExtra -= encoding === 'utf-8' ? 5 : 25;
            }
            try {
                const decoded = new TextDecoder(encoding, decoderOptions).decode(data);
                addCandidateFromDecoded(decoded, encoding, adjustedExtra);
            } catch (error) {
                console.log(`[编码检测] ${debugName} 尝试 ${encoding} 解码失败:`, error);
            }
        }

        // 2. 优先尝试 UTF-8（兼容 ASCII，Web 标准）
        tryAdd('utf-8');

        // 3. 使用 jschardet 检测（作为参考）
        function detectEncoding(buffer) {
            try {
                if (typeof jschardet !== 'undefined' && jschardet.detect) {
                    const result = jschardet.detect(buffer);
                    console.log(`[编码检测] ${debugName} jschardet 结果:`, result);
                    if (result && result.encoding) {
                        return { encoding: String(result.encoding).toLowerCase(), confidence: result.confidence ?? 0 };
                    }
                }
            } catch (error) {
                console.log(`[编码检测] ${debugName} jschardet 失败:`, error);
            }
            return null;
        }

        const detected = detectEncoding(data);
        if (detected && detected.encoding && detected.encoding !== 'utf-8') {
            const normalized = detected.encoding.replace(/[^a-z0-9\-]/g, '');
            if (normalized) {
                const extraScore = detected.confidence ? detected.confidence * 20 : 0;
                tryAdd(normalized, extraScore);
            }
        }

        // 3.b 根据字节分布启发式尝试 UTF-16
        if (suspectUtf16) {
            const similarityBoost = Math.max(0, (0.2 - utf16Similarity) * 80);
            const leBias = Math.max(0, ratioOddZero - ratioEvenZero) * 40;
            const beBias = Math.max(0, ratioEvenZero - ratioOddZero) * 40;
            tryAdd('utf-16le', similarityBoost + leBias);
            tryAdd('utf-16be', similarityBoost + beBias);
        }

        // 4. 尝试常见中文编码
        const chineseEncodings = ['gbk', 'gb18030', 'big5'];
        for (const encoding of chineseEncodings) {
            tryAdd(encoding);
        }

        // 5. 尝试其他编码
        const otherEncodings = ['shift_jis', 'euc-jp', 'iso-8859-1'];
        for (const encoding of otherEncodings) {
            tryAdd(encoding);
        }

        if (candidates.length > 0) {
            candidates.sort((a, b) => b.score - a.score);
            const utf8Candidate = candidates.find(c => c.encoding === 'utf-8');
            const bestUtf16Candidate = candidates.find(c => c.encoding.startsWith('utf-16'));
            let best = candidates[0];
            if (suspectUtf16 && bestUtf16Candidate && !best.encoding.startsWith('utf-16')) {
                const diff = bestUtf16Candidate.score - best.score;
                if (diff >= -40) {
                    console.log(`[编码检测] ${debugName} 启发式选择 UTF-16 候选，分差:`, diff);
                    best = bestUtf16Candidate;
                }
            }
            if (utf8Candidate && best.encoding !== 'utf-8') {
                const diff = best.score - utf8Candidate.score;
                if (diff < 12 && utf8Candidate.stats.letterRatio >= 0.2 && utf8Candidate.stats.asciiPrintableRatio >= 0.7) {
                    console.log(`[编码检测] ${debugName} 采用 UTF-8 候选，得分差 ${diff}`);
                    best = utf8Candidate;
                }
            }
            console.log(`[编码检测] ${debugName} 最终选用编码:`, best.encoding, '得分:', best.score);
            return best.decoded;
        }

        // 6. 最后降级：使用 UTF-8 即使有乱码
        try {
            const fallbackDecoded = new TextDecoder('utf-8').decode(data);
            console.log(`[编码检测] ${debugName} 使用 UTF-8 降级解码（可能有乱码）`);
            return fallbackDecoded;
        } catch {
            // 兜底：返回原始字节的字符串表示
            console.log(`[编码检测] ${debugName} 所有编码尝试失败，使用原始字节`);
            return String.fromCharCode(...data.slice(0, 1000));
        }
    }
    function formatBytes(n) { if (n < 1024) return n + ' B'; if (n < 1024 ** 2) return (n / 1024).toFixed(2) + ' KB'; if (n < 1024 ** 3) return (n / 1024 ** 2).toFixed(2) + ' MB'; return (n / 1024 ** 3).toFixed(2) + ' GB'; }
    function parseSizeBytesFromSpan(span) {
        const em = span?.querySelector?.('em.xg1'); if (!em) return null; const t = em.textContent || '';
        const b = t.match(/([\d,.]+)\s*Bytes/i); if (b) return Math.floor(Number(b[1].replace(/[,.\s]/g, '')));
        const u = t.match(/([\d.]+)\s*(KB|MB|GB)/i); if (u) { const n = parseFloat(u[1]); const mul = u[2].toUpperCase() === 'KB' ? 1024 : u[2].toUpperCase() === 'MB' ? 1024 ** 2 : 1024 ** 3; return Math.floor(n * mul); }
        return null;
    }

    /*********************** 自定义Modal组件 ***********************/
    // 创建自定义Modal
    function createModal(title, message, type = 'info', { showConfirm = true } = {}) {
        // 移除已存在的modal
        const existingModal = document.querySelector('#sht-modal');
        if (existingModal) {
            existingModal.remove();
        }

        const modal = document.createElement('div');
        modal.id = 'sht-modal';
        modal.setAttribute('role', 'dialog');
        modal.setAttribute('aria-modal', 'true');
        modal.setAttribute('aria-labelledby', 'sht-modal-title');
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
        modalContent.className = 'modal-content';
        modalContent.style.cssText = `
    background: white;
    border-radius: 8px;
    padding: 24px;
    max-width: 400px;
    width: 90%;
    box-shadow: 0 10px 25px rgba(0, 0, 0, 0.2);
    text-align: center;
    position: relative;
  `;

        // 标题
        const titleEl = document.createElement('h3');
        titleEl.id = 'sht-modal-title';
        titleEl.textContent = title;
        titleEl.style.cssText = `
    margin: 0 0 16px 0;
    font-size: 18px;
    font-weight: 600;
    color: #333;
  `;

        // 消息内容
        const messageEl = document.createElement('div');
        messageEl.textContent = message;
        messageEl.style.cssText = `
    margin: 0 0 24px 0;
    font-size: 14px;
    line-height: 1.5;
    color: #666;
    white-space: pre-line;
  `;

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
  `;

        // 根据类型设置颜色
        if (type === 'success') {
            confirmBtn.style.background = '#28a745';
            confirmBtn.style.color = 'white';
        } else if (type === 'error') {
            confirmBtn.style.background = '#dc3545';
            confirmBtn.style.color = 'white';
        } else if (type === 'warning') {
            confirmBtn.style.background = '#ffc107';
            confirmBtn.style.color = '#212529';
        } else {
            confirmBtn.style.background = '#007bff';
            confirmBtn.style.color = 'white';
        }

        confirmBtn.addEventListener('mouseenter', () => {
            confirmBtn.style.opacity = '0.9';
        });
        confirmBtn.addEventListener('mouseleave', () => {
            confirmBtn.style.opacity = '1';
        });

        const previouslyFocused = document.activeElement;
        let closed = false;

        // 关闭modal
        const closeModal = () => {
            if (closed) return;
            closed = true;
            document.removeEventListener('keydown', handleKeyDown);
            modal.remove();
            if (previouslyFocused instanceof HTMLElement && previouslyFocused.isConnected) {
                previouslyFocused.focus();
            }
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
            } else if (e.key === 'Tab') {
                const focusable = [...modal.querySelectorAll('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href]')];
                if (!focusable.length) return;
                const first = focusable[0];
                const last = focusable[focusable.length - 1];
                if (e.shiftKey && document.activeElement === first) {
                    e.preventDefault();
                    last.focus();
                } else if (!e.shiftKey && document.activeElement === last) {
                    e.preventDefault();
                    first.focus();
                }
            }
        };
        document.addEventListener('keydown', handleKeyDown);

        modalContent.appendChild(titleEl);
        modalContent.appendChild(messageEl);
        if (showConfirm) {
            buttonContainer.appendChild(confirmBtn);
            modalContent.appendChild(buttonContainer);
        }
        modal.appendChild(modalContent);
        document.body.appendChild(modal);

        if (showConfirm) {
            confirmBtn.focus();
        } else {
            modalContent.tabIndex = -1;
            modalContent.focus();
        }

        modal.closeSht = closeModal;
        return modal;
    }

    // 显示成功消息
    function showSuccessModal(message) {
        return createModal('操作成功', message, 'success');
    }

    // 显示错误消息
    function showErrorModal(message) {
        return createModal('操作失败', message, 'error');
    }

    // 显示警告消息
    function showWarningModal(message) {
        return createModal('警告', message, 'warning');
    }

    // 显示信息消息
    function showInfoModal(message) {
        return createModal('提示', message, 'info');
    }

    function cloneJson(value) {
        return JSON.parse(JSON.stringify(value));
    }

    function readSearchConfig() {
        try {
            const raw = GM_getValue(SEARCH_CONFIG_KEY);
            if (!raw) return null;
            return typeof raw === 'string' ? JSON.parse(raw) : cloneJson(raw);
        } catch (error) {
            console.warn('[SHT] 搜索配置读取失败:', error);
            return null;
        }
    }

    function createConfigExport(includeSensitive = false) {
        const mainConfig = cloneJson(CFG);
        // 历史记录有单独导出入口，避免配置文件无限膨胀。
        delete mainConfig.historyItems;
        if (!includeSensitive) {
            SENSITIVE_CONFIG_KEYS.forEach(key => delete mainConfig[key]);
        }

        return {
            format: 'sht-helper-config',
            version: CONFIG_EXPORT_VERSION,
            exportTime: new Date().toISOString(),
            includesSensitiveCredentials: includeSensitive,
            config: mainConfig,
            searchConfig: readSearchConfig()
        };
    }

    function sanitizeImportedObject(input, defaults, label) {
        if (!input || typeof input !== 'object' || Array.isArray(input)) {
            throw new Error(`${label}不是有效对象`);
        }

        const output = {};
        for (const [key, defaultValue] of Object.entries(defaults)) {
            if (!Object.prototype.hasOwnProperty.call(input, key)) continue;
            const value = input[key];
            if (Array.isArray(defaultValue)) {
                if (!Array.isArray(value)) throw new Error(`${label}.${key} 类型无效`);
                output[key] = cloneJson(value.slice(0, 5000));
            } else if (defaultValue && typeof defaultValue === 'object') {
                if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label}.${key} 类型无效`);
                output[key] = cloneJson(value);
            } else if (typeof defaultValue === 'number') {
                if (!Number.isFinite(value)) throw new Error(`${label}.${key} 必须是有限数字`);
                output[key] = value;
            } else if (typeof value === typeof defaultValue) {
                output[key] = value;
            } else {
                throw new Error(`${label}.${key} 类型无效`);
            }
        }
        return output;
    }

    function sanitizeImportedSearchConfig(input) {
        if (input == null) return null;
        if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('searchConfig 不是有效对象');
        const defaults = {
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
        const sortKeys = [null, 'quota', 'fileSize', 'replies', 'views', 'postDate'];
        const sanitized = { ...defaults };
        if (!sortKeys.includes(input.sortBy ?? null) || !sortKeys.includes(input.secondarySort ?? null)) {
            throw new Error('searchConfig 排序字段无效');
        }
        if (input.sortDir != null && !['asc', 'desc'].includes(input.sortDir)) throw new Error('searchConfig.sortDir 无效');
        if (input.secondaryDir != null && !['asc', 'desc'].includes(input.secondaryDir)) throw new Error('searchConfig.secondaryDir 无效');
        if (input.highlightThreshold != null && !['auto', 'low', 'medium', 'high'].includes(input.highlightThreshold)) {
            throw new Error('searchConfig.highlightThreshold 无效');
        }
        sanitized.sortBy = input.sortBy ?? null;
        sanitized.secondarySort = input.secondarySort ?? null;
        if (input.sortDir != null) sanitized.sortDir = input.sortDir;
        if (input.secondaryDir != null) sanitized.secondaryDir = input.secondaryDir;
        if (input.highlightThreshold != null) sanitized.highlightThreshold = input.highlightThreshold;
        ['onlyQuota', 'filterQiuPian', 'highlightEnabled'].forEach(key => {
            if (input[key] != null) {
                if (typeof input[key] !== 'boolean') throw new Error(`searchConfig.${key} 类型无效`);
                sanitized[key] = input[key];
            }
        });
        if (input.lastUsed != null) {
            if (!Number.isFinite(input.lastUsed)) throw new Error('searchConfig.lastUsed 必须是有限数字');
            sanitized.lastUsed = input.lastUsed;
        }
        return sanitized;
    }

    function buildConfigDiffPreview(mainConfig, searchConfig) {
        const changed = [];
        Object.entries(mainConfig).forEach(([key, value]) => {
            if (JSON.stringify(CFG[key]) === JSON.stringify(value)) return;
            changed.push(SENSITIVE_CONFIG_KEYS.includes(key) ? `${key}: [敏感值已隐藏]` : `${key}: 将更新`);
        });
        if (searchConfig) changed.push('searchConfig: 将更新搜索排序、筛选和高亮设置');
        const visible = changed.slice(0, 30);
        if (changed.length > visible.length) visible.push(`……另有 ${changed.length - visible.length} 项`);
        return visible.length ? visible.join('\n') : '没有检测到配置差异。';
    }

    // 导出配置；敏感凭据默认不包含。
    function exportConfig(includeSensitive = false) {
        try {
            const configToExport = createConfigExport(includeSensitive);
            const blob = new Blob([JSON.stringify(configToExport, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `sht_config_${new Date().toISOString().slice(0, 10)}.json`;
            a.click();
            URL.revokeObjectURL(url);

            showSuccessModal(`配置导出成功！\n\n${includeSensitive ? '已包含网盘凭据，请妥善保管。' : '未包含网盘 Cookie、Token 等敏感凭据。'}`);
        } catch (error) {
            console.error('导出配置失败:', error);
            showErrorModal('导出配置失败: ' + error.message);
        }
    }

    // 导入配置
    function importConfig() {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.json';
        input.style.display = 'none';

        input.addEventListener('change', (e) => {
            const file = e.target.files[0];

            // 清理input元素
            if (input.parentNode) {
                input.parentNode.removeChild(input);
            }

            if (!file) {
                console.log('用户取消了文件选择');
                return;
            }
            if (file.size > 2 * 1024 * 1024) {
                showErrorModal('配置文件过大，最大支持 2 MB。历史记录请使用独立导入/导出功能。');
                return;
            }

            const reader = new FileReader();
            reader.onload = async (e) => {
                try {
                    const importedData = JSON.parse(e.target.result);

                    // 兼容旧版导出，但只接受白名单字段和匹配的基础类型。
                    if (!importedData || !importedData.config || !importedData.version) {
                        throw new Error('无效的配置文件格式');
                    }

                    const mainConfig = migrateConfig(sanitizeImportedObject(importedData.config, DEFAULT_CONFIG, 'config'));
                    const searchConfig = sanitizeImportedSearchConfig(importedData.searchConfig);
                    const importsCredentials = SENSITIVE_CONFIG_KEYS.some(key =>
                        Object.prototype.hasOwnProperty.call(mainConfig, key) && Boolean(mainConfig[key])
                    );

                    const confirmMessage = `版本: ${importedData.version}\n导出时间: ${importedData.exportTime || '未知'}\n敏感凭据: ${importsCredentials ? '包含' : '不包含（保留本机现有凭据）'}\n\n变更预览：\n${buildConfigDiffPreview(mainConfig, searchConfig)}\n\n只会覆盖文件中包含的有效设置。`;
                    if (!await confirmAction(confirmMessage, { title: '导入配置预览', confirmText: '确认导入' })) return;

                    Object.assign(CFG, mainConfig);
                    saveConfig();
                    if (searchConfig) GM_setValue(SEARCH_CONFIG_KEY, JSON.stringify(searchConfig));

                    if (CFG.credentialsSessionOnly) {
                        showSuccessModal('配置导入成功！\n\n临时凭据已在当前页面内存中生效，刷新或离开页面即清除。');
                    } else {
                        showSuccessModal('配置导入成功！\n\n页面将自动刷新以应用新设置。未包含的敏感凭据已保留。');
                        setTimeout(() => location.reload(), 2000);
                    }

                } catch (error) {
                    console.error('导入配置失败:', error);
                    showErrorModal('导入配置失败: ' + error.message);
                }
            };

            reader.readAsText(file);
        });

        // 添加取消事件监听器
        input.addEventListener('cancel', () => {
            console.log('用户取消了文件选择');
            if (input.parentNode) {
                input.parentNode.removeChild(input);
            }
        });

        document.body.appendChild(input);
        input.click();
    }

    // 重置配置
    async function resetConfig() {
        if (!await confirmAction('这将清除所有自定义设置，包括历史记录和会话凭据。', {
            title: '重置全部配置', confirmText: '确认重置', danger: true
        })) return;

        try {
            // 重置为默认配置
            Object.keys(CFG).forEach(key => delete CFG[key]);
            Object.assign(CFG, cloneJson(DEFAULT_CONFIG));

            // 清空历史记录
            CFG.historyItems = [];
            SENSITIVE_CONFIG_KEYS.forEach(key => delete volatileCredentialVault[key]);

            // 保存配置
            saveConfig();

            showSuccessModal('配置已重置为默认值！\n\n页面将自动刷新以应用新设置。');

            // 延迟刷新页面
            setTimeout(() => {
                location.reload();
            }, 2000);

        } catch (error) {
            console.error('重置配置失败:', error);
            showErrorModal('重置配置失败: ' + error.message);
        }
    }

    // ED2K文件名正则替换处理
    function processEd2kFileName(fileName) {
        if (!CFG.ed2kFileNameReplaceEnabled || !CFG.ed2kFileNameReplaceRules || CFG.ed2kFileNameReplaceRules.length === 0) {
            return fileName;
        }

        let processedName = fileName;

        try {
            for (let i = 0; i < CFG.ed2kFileNameReplaceRules.length; i++) {
                const rule = CFG.ed2kFileNameReplaceRules[i];
                if (rule.pattern && rule.replacement !== undefined) {
                    const regex = new RegExp(rule.pattern, 'g');
                    processedName = processedName.replace(regex, rule.replacement);
                }
            }

            // 清理多余的空格
            processedName = processedName.replace(/\s+/g, ' ').trim();
            return processedName;
        } catch (error) {
            console.error('ED2K文件名正则替换失败:', error);
            return fileName; // 出错时返回原文件名
        }
    }

    // 处理ED2K链接中的文件名
    function processEd2kLink(ed2kLink) {
        if (!CFG.ed2kFileNameReplaceEnabled || !CFG.ed2kFileNameReplaceRules || CFG.ed2kFileNameReplaceRules.length === 0) {
            return ed2kLink;
        }

        try {
            // ED2K链接格式: ed2k://|file|filename|filesize|hash|/
            const ed2kRegex = /^(ed2k:\/\/\|file\|)([^|]+)(\|[^|]+\|[^|]+\|.*)$/;
            const match = ed2kLink.match(ed2kRegex);

            if (match) {
                const prefix = match[1];
                const originalFileName = match[2];
                const suffix = match[3];

                const processedFileName = processEd2kFileName(originalFileName);
                return prefix + processedFileName + suffix;
            }

            return ed2kLink; // 如果格式不匹配，返回原链接
        } catch (error) {
            console.error('ED2K链接处理失败:', error);
            return ed2kLink; // 出错时返回原链接
        }
    }
