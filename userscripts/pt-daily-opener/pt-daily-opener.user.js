// ==UserScript==
// @name         PT站点定时批量打开（防拦截 + 跨标签页互斥：监听器版）
// @namespace    http://tampermonkey.net/
// @version      1.11
// @description  每日显示“打开PT站点”按钮；定时仅自动打开一次（全浏览器互斥）；使用 GM_openInTab 规避拦截并后台开标签。
// @author       ChatGPT
// @match        *://*/*
// @grant        GM_notification
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_openInTab
// @grant        GM_addValueChangeListener
// @grant        GM_xmlhttpRequest
// @grant        GM_registerMenuCommand
// @connect      *
// @run-at       document-start
// @noframes
// ==/UserScript==

(function () {
  'use strict';

  /* ---------------- 配置区 ---------------- */
  const DEFAULT_SITES = [
    "https://sportscult.org/", "https://exoticaz.to/", "https://avistaz.to/", "https://cinemaz.to/",
    "https://www.torrentleech.org/",
    "https://u2.dmhy.org/", "https://ubits.club/", "https://zmpt.cc/", "https://springsunday.net/",
    "https://www.pttime.org/", "https://sewerpt.com/", "https://www.qingwapt.com/", "https://rousi.zip/",
    "https://ptchina.org/", "https://open.cd/", "https://www.nicept.net/", "https://cc.mypt.cc/",
    "https://kamept.com/", "https://jpopsuki.eu/", "https://hdtime.org/", "https://www.hddolby.com/index.php",
    "https://www.hdkyl.in/", "https://cspt.top/", "https://hhanclub.top/", "https://www.myanonamouse.net/index.php",
    "https://pornolab.net/forum/index.php", "https://pt.agsvpt.cn/index.php", "https://audiences.me/",
    "https://pt.cdfile.org/", "https://carpt.net/", "https://dicmusic.com/", "https://share.ilolicon.com/",
    "https://www.torrentleech.org/", "https://sunnypt.top/", "https://kp.m-team.cc/index",
    "https://pt.btschool.club/", "https://www.happyfappy.org/", "https://bitporn.eu/"
  ];
  const SITES_STORAGE_KEY = 'pt_sites_config';
  const SITES_PANEL_STYLE_ID = 'pt-sites-config-style';
  const parseSitesInput = text => {
    if (!text) return [];
    return text
      .split(/[\s,]+/)
      .map(item => item.trim())
      .filter(Boolean);
  };
  const loadSites = () => {
    const stored = (GM_getValue(SITES_STORAGE_KEY, '') || '').trim();
    const list = stored ? parseSitesInput(stored) : [];
    if (!list.length) return DEFAULT_SITES.slice();
    return list;
  };
  const saveSites = sites => {
    const cleaned = uniq(
      (sites || [])
        .map(item => item.trim())
        .filter(Boolean)
        .map(item => (/^[a-z]+:\/\//i.test(item) ? item : `https://${item}`))
    );
    GM_setValue(SITES_STORAGE_KEY, cleaned.join('\n'));
    return cleaned;
  };
  const ensureSitesPanelStyle = () => {
    if (document.getElementById(SITES_PANEL_STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = SITES_PANEL_STYLE_ID;
    style.textContent = `
      .pt-sites-config-overlay {
        position: fixed;
        inset: 0;
        background: rgba(0, 0, 0, 0.45);
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 2147483647;
        padding: 16px;
      }
      .pt-sites-config-card {
        width: min(540px, 100%);
        max-height: min(620px, 100%);
        background: #fff;
        border-radius: 12px;
        box-shadow: 0 18px 48px rgba(15, 23, 42, 0.28);
        display: flex;
        flex-direction: column;
        overflow: hidden;
        font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      .pt-sites-config-header {
        padding: 18px 20px 14px;
        border-bottom: 1px solid rgba(15, 23, 42, 0.08);
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
      }
      .pt-sites-config-header h2 {
        margin: 0;
        font-size: 18px;
        font-weight: 600;
        color: #0f172a;
      }
      .pt-sites-config-close {
        all: unset;
        cursor: pointer;
        font-size: 20px;
        line-height: 1;
        color: #64748b;
        padding: 4px;
        border-radius: 6px;
      }
      .pt-sites-config-close:hover {
        background: rgba(15, 23, 42, 0.06);
        color: #0f172a;
      }
      .pt-sites-config-body {
        padding: 18px 20px 22px;
        display: flex;
        flex-direction: column;
        gap: 14px;
        overflow: auto;
      }
      .pt-sites-config-body textarea {
        resize: vertical;
        min-height: 220px;
        max-height: 400px;
        padding: 12px;
        border-radius: 10px;
        border: 1px solid rgba(15, 23, 42, 0.12);
        font-size: 13px;
        line-height: 1.5;
        font-family: ui-monospace, SFMono-Regular, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
        color: #1f2937;
        background: #f8fafc;
      }
      .pt-sites-config-body textarea:focus {
        outline: none;
        border-color: #0d6efd;
        background: #fff;
        box-shadow: 0 0 0 3px rgba(13, 110, 253, 0.15);
      }
      .pt-sites-config-hint {
        font-size: 12px;
        color: #6b7280;
        line-height: 1.6;
      }
      .pt-sites-config-actions {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 12px;
      }
      .pt-sites-config-actions .pt-sites-config-status {
        font-size: 12px;
        color: #0f172a;
        white-space: pre-wrap;
      }
      .pt-sites-config-buttons {
        display: flex;
        gap: 10px;
      }
      .pt-sites-config-buttons button {
        all: unset;
        cursor: pointer;
        padding: 7px 14px;
        border-radius: 8px;
        font-size: 13px;
        font-weight: 500;
        border: 1px solid rgba(15, 23, 42, 0.14);
        color: #334155;
        background: #fff;
      }
      .pt-sites-config-buttons button:hover {
        background: rgba(15, 23, 42, 0.04);
      }
      .pt-sites-config-buttons button.pt-sites-config-primary {
        background: #0d6efd;
        color: #fff;
        border: 1px solid #0d6efd;
        box-shadow: 0 6px 16px rgba(13, 110, 253, 0.25);
      }
      .pt-sites-config-buttons button.pt-sites-config-primary:hover {
        background: #0b5ed7;
      }
    `;
    (document.head || document.documentElement).appendChild(style);
  };
  let sitesPanelElement = null;
  function removeSitesPanel() {
    if (sitesPanelElement) {
      try { sitesPanelElement.remove(); } catch (_) {}
      sitesPanelElement = null;
    }
  }
  function showSitesConfigPanel() {
    if (sitesPanelElement) return;
    if (!document.body) {
      window.addEventListener('DOMContentLoaded', showSitesConfigPanel, { once: true });
      return;
    }
    ensureSitesPanelStyle();
    const overlay = document.createElement('div');
    overlay.className = 'pt-sites-config-overlay';
    const storedList = loadSites();
    overlay.innerHTML = `
      <div class="pt-sites-config-card" role="dialog" aria-modal="true">
        <div class="pt-sites-config-header">
          <h2>配置 PT 站点列表</h2>
          <button class="pt-sites-config-close" title="关闭">×</button>
        </div>
        <div class="pt-sites-config-body">
          <textarea spellcheck="false" placeholder="每行一个站点地址，例如 https://example.org">${storedList.join('\n')}</textarea>
          <div class="pt-sites-config-hint">
            每行一个地址，支持粘贴多个链接。保存后请刷新页面以加载新的站点列表。
          </div>
          <div class="pt-sites-config-actions">
            <div class="pt-sites-config-status"></div>
            <div class="pt-sites-config-buttons">
              <button type="button" class="pt-sites-config-reset">恢复默认</button>
              <button type="button" class="pt-sites-config-cancel">取消</button>
              <button type="button" class="pt-sites-config-save pt-sites-config-primary">保存</button>
            </div>
          </div>
        </div>
      </div>
    `;
    const textarea = overlay.querySelector('textarea');
    const statusEl = overlay.querySelector('.pt-sites-config-status');
    const closeBtn = overlay.querySelector('.pt-sites-config-close');
    const cancelBtn = overlay.querySelector('.pt-sites-config-cancel');
    const saveBtn = overlay.querySelector('.pt-sites-config-save');
    const resetBtn = overlay.querySelector('.pt-sites-config-reset');

    const updateStatus = (message, tone = 'info') => {
      if (!statusEl) return;
      const palette = {
        info: '#0f172a',
        success: '#0f766e',
        warn: '#b45309',
        error: '#b91c1c'
      };
      statusEl.textContent = message || '';
      statusEl.style.color = palette[tone] || palette.info;
    };

    const handleKeydown = event => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      }
    };

    const onClose = () => {
      removeSitesPanel();
      document.removeEventListener('keydown', handleKeydown, true);
    };

    closeBtn?.addEventListener('click', onClose);
    cancelBtn?.addEventListener('click', onClose);
    overlay.addEventListener('click', event => {
      if (event.target === overlay) onClose();
    });
    resetBtn?.addEventListener('click', () => {
      textarea.value = DEFAULT_SITES.join('\n');
      updateStatus(`已填充默认站点，共 ${DEFAULT_SITES.length} 个。`, 'info');
    });
    saveBtn?.addEventListener('click', () => {
      const raw = textarea.value || '';
      const parsed = parseSitesInput(raw);
      const stored = saveSites(parsed);
      setAggregationState(null);
      textarea.value = stored.length ? stored.join('\n') : '';
      updateStatus(
        stored.length
          ? `已保存 ${stored.length} 个站点，请刷新页面后生效。`
          : `列表为空，将在刷新后恢复至默认站点（共 ${DEFAULT_SITES.length} 个）。`,
        stored.length ? 'success' : 'warn'
      );
    });
    textarea?.addEventListener('input', () => {
      updateStatus('');
    });

    sitesPanelElement = overlay;
    document.body.appendChild(overlay);
    textarea?.focus({ preventScroll: false });
    document.addEventListener('keydown', handleKeydown, true);
  }
  const SITES = loadSites();
  const TRIGGER_HOUR = 12;         // 每日触发小时（本机时区）
  const TRIGGER_MINUTE = 0;        // 每日触发分钟
  const AUTO_OPEN_CONFIRM = false; // 自动打开前是否弹确认
  const AUTO_INTERVAL_STORAGE_KEY = 'pt_open_interval_days';
  const AUTO_LAST_TRIGGER_DATE_KEY = 'pt_open_last_trigger_date';
  const DEFAULT_AUTO_INTERVAL_DAYS = 1;
  const MIN_AUTO_INTERVAL_DAYS = 1;
  const MAX_AUTO_INTERVAL_DAYS = 30;
  let autoOpenIntervalDays = clampIntervalDays(GM_getValue(AUTO_INTERVAL_STORAGE_KEY, DEFAULT_AUTO_INTERVAL_DAYS));
  if (typeof GM_addValueChangeListener === 'function') {
    GM_addValueChangeListener(AUTO_INTERVAL_STORAGE_KEY, (name, oldVal, newVal) => {
      autoOpenIntervalDays = clampIntervalDays(newVal);
    });
  }

  /* ------------- 常量与工具 ------------- */
  const INSTANCE_ID = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const LOCK_KEY = 'pt_open_trigger_date';     // “今日是否已触发”的全局键（只存日期，如 2025-09-25）
  const OPENED_DATE_KEY = 'pt_open_last_date';       // 跨标签页记录“今日是否已真正执行打开”
  // GM 存储没有原子的 compare-and-set。所有页面到点后会同时争抢 LOCK_KEY，
  // 因此必须等待写入稳定，再由最终仍持有锁的实例执行打开。
  const LOCK_SETTLE_MS = 1500;
  const LOCK_LEASE_MS = 10000;
  const LOCK_RETRY_JITTER_MS = 500;
  let lockSettlementTimerId = null;
  let lockSettlementClaimKey = '';
  let lockRetryTimerId = null;
  const BARK_ENDPOINT_STORAGE_KEY = 'pt_bark_endpoint';
  const STORED_BARK_ENDPOINT = (GM_getValue(BARK_ENDPOINT_STORAGE_KEY, '') || '').trim();
  const DEFAULT_BARK_ENDPOINT = ''; // 如需默认 Bark 地址，可填入类似 https://api.day.app/XXXXXXXX
  const BARK_ENDPOINT = (STORED_BARK_ENDPOINT || DEFAULT_BARK_ENDPOINT).trim();
  const LOGIN_DEBUG_KEY = 'pt_login_debug_enabled';
  const STANDALONE_NOTIFY_KEY = 'pt_standalone_login_notify';
  const DEBUG_LOGIN = !!GM_getValue(LOGIN_DEBUG_KEY, false);
  const STANDALONE_NOTIFY_ENABLED = !!GM_getValue(STANDALONE_NOTIFY_KEY, false);
  const LOGIN_NOTIFY_PREFIX = 'pt_login_notified_';
  const LOGIN_CHECK_TIMEOUT_MS = 20000;
  const LOGIN_CHECK_INTERVAL_MS = 1500;
  const LOGIN_TEXT_PATTERNS = [
    /(?:上传量|上傳量|上传|上傳|上载|上載|Uploaded|Upload(?:ed)?)\s*[:：]?\s*\d[\d.,]*(?:\s*(?:[TGMK]i?B|[TGMK]B|B))?/i,
    /(?:下载量|下載量|下载|下載|Downloaded|Download(?:ed)?)\s*[:：]?\s*\d[\d.,]*(?:\s*(?:[TGMK]i?B|[TGMK]B|B))?/i,
    /(?:分享率|分享比|Ratio)\s*[:：]?\s*\d+(?:\.\d+)?/i,
    /(?:魔力值|积分|积分数|种子数|做种)\s*[:：]?\s*\d+/i
  ];

  const uniq = arr => Array.from(new Set(arr)); // SITES 去重
  const SITE_ORIGINS = new Set(
    SITES.map(url => {
      try { return new URL(url).origin; } catch { return null; }
    }).filter(Boolean)
  );
  const SITE_HOST_INFO = (() => {
    const mapping = new Map();
    uniq(SITES).forEach(url => {
      try {
        const parsed = new URL(url);
        const host = parsed.hostname || parsed.origin;
        if (!host) return;
        const key = host.toLowerCase();
        if (!mapping.has(key)) mapping.set(key, host);
      } catch (_) {}
    });
    return {
      keys: Array.from(mapping.keys()),
      labelMap: mapping
    };
  })();
  const SITE_HOST_KEYS = SITE_HOST_INFO.keys;
  const SITE_HOST_LABEL_MAP = SITE_HOST_INFO.labelMap;
  const LOGIN_RESULTS_KEY_PREFIX = 'pt_login_results_session_';
  const AGGREGATION_STATE_KEY = 'pt_login_aggregation_state';
  const AGGREGATION_WAIT_MS = 3 * 60 * 1000; // 超过 3 分钟仍未完成则直接汇总
  const MAX_SUMMARY_ITEMS = 8;
  let aggregationDeadlineTimerId = null;

  function ymd(date = new Date()) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  function clampIntervalDays(value) {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed)) return DEFAULT_AUTO_INTERVAL_DAYS;
    if (parsed < MIN_AUTO_INTERVAL_DAYS) return MIN_AUTO_INTERVAL_DAYS;
    if (parsed > MAX_AUTO_INTERVAL_DAYS) return MAX_AUTO_INTERVAL_DAYS;
    return parsed;
  }

  function parseYmdDate(ymdString) {
    if (!ymdString || typeof ymdString !== 'string') return null;
    const parts = ymdString.split('-');
    if (parts.length !== 3) return null;
    const [yRaw, mRaw, dRaw] = parts;
    const y = Number.parseInt(yRaw, 10);
    const m = Number.parseInt(mRaw, 10);
    const d = Number.parseInt(dRaw, 10);
    if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return null;
    const candidate = new Date(y, m - 1, d, TRIGGER_HOUR, TRIGGER_MINUTE, 0, 0);
    if (Number.isNaN(candidate.getTime())) return null;
    return candidate;
  }

  function normalizeLockState(input) {
    if (!input || typeof input !== 'object') return null;
    const date = typeof input.date === 'string' ? input.date : '';
    if (!date) return null;
    let tsNumber = Number(input.ts);
    if (!Number.isFinite(tsNumber)) tsNumber = 0;
    const owner = typeof input.owner === 'string' ? input.owner : '';
    return { date, owner, ts: tsNumber };
  }

  function parseLockState(value) {
    if (!value) return null;
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (!trimmed) return null;
      try {
        const parsed = JSON.parse(trimmed);
        const normalized = normalizeLockState(parsed);
        if (normalized) return normalized;
      } catch (_) {
        return normalizeLockState({ date: trimmed });
      }
    } else if (typeof value === 'object') {
      const normalized = normalizeLockState(value);
      if (normalized) return normalized;
    }
    return null;
  }

  function buildLockState(date) {
    return {
      date,
      owner: INSTANCE_ID,
      ts: Date.now()
    };
  }

  function serializeLockState(state) {
    if (!state) return '';
    try {
      return JSON.stringify(state);
    } catch (_) {
      return '';
    }
  }

  function lockClaimKey(state) {
    if (!state) return '';
    return `${state.date}|${state.owner}|${state.ts}`;
  }

  function isSameLockClaim(left, right) {
    return !!left && !!right
      && left.date === right.date
      && left.owner === right.owner
      && left.ts === right.ts;
  }

  function wasOpenedOn(date) {
    return GM_getValue(OPENED_DATE_KEY, '') === date
      || GM_getValue(AUTO_LAST_TRIGGER_DATE_KEY, '') === date;
  }

  function isFreshLock(state, now = Date.now()) {
    if (!state || !state.owner || !state.ts) return false;
    return now - state.ts < LOCK_LEASE_MS;
  }

  function clearLockSettlementTimer() {
    if (lockSettlementTimerId) {
      clearTimeout(lockSettlementTimerId);
      lockSettlementTimerId = null;
    }
    lockSettlementClaimKey = '';
  }

  function clearLockRetryTimer() {
    if (lockRetryTimerId) {
      clearTimeout(lockRetryTimerId);
      lockRetryTimerId = null;
    }
  }

  function finalizeLockClaim(claim) {
    clearLockSettlementTimer();
    if (!claim || claim.date !== ymd()) return;

    if (wasOpenedOn(claim.date)) {
      return;
    }

    // 等待期结束后必须再次读取共享锁。只有最终写入且一直未被覆盖的实例
    // 才能继续；被其它标签页覆盖过的候选者全部退出。
    const storedState = parseLockState(GM_getValue(LOCK_KEY, ''));
    if (!isSameLockClaim(storedState, claim) || storedState.owner !== INSTANCE_ID) return;

    // 在打开第一个标签页之前写入完成标志，避免新页面启动后再次参与当天任务。
    GM_setValue(OPENED_DATE_KEY, claim.date);
    GM_setValue(AUTO_LAST_TRIGGER_DATE_KEY, claim.date);
    clearLockRetryTimer();
    notifyScheduleTriggered(claim.date);
    openSites(AUTO_OPEN_CONFIRM, { batchSource: 'auto' });
  }

  function scheduleLockSettlement(claim) {
    if (!claim || claim.owner !== INSTANCE_ID || claim.date !== ymd()) return;
    const claimKey = lockClaimKey(claim);
    if (lockSettlementTimerId && lockSettlementClaimKey === claimKey) return;
    clearLockSettlementTimer();
    lockSettlementClaimKey = claimKey;
    // 从当前页面实际观察/写入该候选值后开始等待，不能只依据候选时间戳；
    // 否则一个被浏览器暂停过的旧候选值可能在恢复后跳过稳定期。
    lockSettlementTimerId = setTimeout(() => finalizeLockClaim(claim), LOCK_SETTLE_MS);
  }

  function scheduleLockRetry(state) {
    if (!state || state.date !== ymd() || wasOpenedOn(state.date)) return;
    clearLockRetryTimer();
    const targetMoment = parseYmdDate(state.date);
    if (!targetMoment) return;
    const leaseRemainingMs = Math.max(0, state.ts + LOCK_LEASE_MS - Date.now());
    const jitterMs = Math.floor(Math.random() * LOCK_RETRY_JITTER_MS);
    lockRetryTimerId = setTimeout(() => {
      lockRetryTimerId = null;
      attemptAutoOpen(targetMoment);
    }, leaseRemainingMs + jitterMs + 50);
  }

  // 在后台打开站点（使用 GM_openInTab 规避拦截）
  function openSites(requireConfirm = true, options = {}) {
    const urls = uniq(SITES);
    const { batchSource } = options;
    const doOpen = () => {
      if (batchSource) startAggregationSession(batchSource);
      urls.forEach(url => GM_openInTab(url, { active: false, insert: true, setParent: true }));
    };
    if (requireConfirm) {
      if (confirm(`即将为您在后台打开 ${urls.length} 个PT站点，确定要继续吗？`)) {
        doOpen();
        return true;
      }
      return false;
    } else {
      doOpen();
      return true;
    }
  }

  function registerMenus() {
    if (typeof GM_registerMenuCommand !== 'function') return;
    GM_registerMenuCommand('配置 PT 站点列表', () => {
      showSitesConfigPanel();
    });
    GM_registerMenuCommand(`设置自动开启间隔（当前每${autoOpenIntervalDays}天）`, () => {
      const input = prompt(`请输入自动打开间隔（单位：天，范围 ${MIN_AUTO_INTERVAL_DAYS}-${MAX_AUTO_INTERVAL_DAYS}）`, String(autoOpenIntervalDays));
      if (input === null) return;
      const next = clampIntervalDays(input);
      autoOpenIntervalDays = next;
      GM_setValue(AUTO_INTERVAL_STORAGE_KEY, next);
      try {
        GM_notification?.({
          title: '自动开启间隔已更新',
          text: `新的自动开启间隔为每 ${next} 天执行（刷新页面后菜单项将同步更新）。`,
          timeout: 4000
        });
      } catch (_) {}
    });
    GM_registerMenuCommand('配置 Bark 推送地址', () => {
      const current = GM_getValue(BARK_ENDPOINT_STORAGE_KEY, '').trim();
      const input = prompt('请输入 Bark 推送地址（例如 https://api.day.app/XXXXXXXX）', current);
      if (input === null) return;
      const trimmed = input.trim();
      GM_setValue(BARK_ENDPOINT_STORAGE_KEY, trimmed);
      try {
        GM_notification?.({
          title: 'Bark 推送地址已更新',
          text: trimmed ? '登录成功将推送到新的 Bark（刷新页面后生效）' : '已关闭 Bark 推送（刷新页面后生效）',
          timeout: 3500
        });
      } catch (_) {}
    });
    GM_registerMenuCommand(STANDALONE_NOTIFY_ENABLED ? '关闭单站登录通知' : '开启单站登录通知', () => {
      const next = !GM_getValue(STANDALONE_NOTIFY_KEY, false);
      GM_setValue(STANDALONE_NOTIFY_KEY, next);
      try {
        GM_notification?.({
          title: '单站登录通知已更新',
          text: next ? '将对手动访问的站点发送登录提示（刷新页面后生效）' : '已关闭手动访问时的登录提示（刷新页面后生效）',
          timeout: 3500
        });
      } catch (_) {}
    });
    GM_registerMenuCommand(DEBUG_LOGIN ? '关闭登录调试日志' : '开启登录调试日志', () => {
      const next = !GM_getValue(LOGIN_DEBUG_KEY, false);
      GM_setValue(LOGIN_DEBUG_KEY, next);
      try {
        GM_notification?.({
          title: '登录调试日志',
          text: next ? '已开启登录调试日志（请刷新页面生效）' : '已关闭登录调试日志（请刷新页面生效）',
          timeout: 3500
        });
      } catch (_) {}
    });
  }

  const logLoginDebug = (...args) => {
    if (!DEBUG_LOGIN) return;
    try {
      console.log('[pt-helper login]', ...args);
    } catch (_) {}
  };

  const parseJSON = (raw, fallback) => {
    if (!raw) return fallback;
    try { return JSON.parse(raw); } catch (_) { return fallback; }
  };

  function getAggregationState() {
    const raw = GM_getValue(AGGREGATION_STATE_KEY, '');
    const state = parseJSON(raw, null);
    if (!state) return null;
    if (state.date !== ymd()) return null;
    return state;
  }

  function setAggregationState(state) {
    if (!state) {
      GM_setValue(AGGREGATION_STATE_KEY, '');
      return;
    }
    GM_setValue(AGGREGATION_STATE_KEY, JSON.stringify(state));
  }

  function isAggregationActive() {
    const state = getAggregationState();
    return !!(state && !state.completed);
  }

  function getSessionResults(sessionId) {
    if (!sessionId) return {};
    const raw = GM_getValue(`${LOGIN_RESULTS_KEY_PREFIX}${sessionId}`, '');
    return parseJSON(raw, {});
  }

  function setSessionResults(sessionId, results) {
    if (!sessionId) return;
    GM_setValue(`${LOGIN_RESULTS_KEY_PREFIX}${sessionId}`, JSON.stringify(results || {}));
  }

  function formatSummaryList(items) {
    if (!items.length) return '无';
    if (items.length <= MAX_SUMMARY_ITEMS) return items.join(', ');
    const shown = items.slice(0, MAX_SUMMARY_ITEMS);
    return `${shown.join(', ')} 等${items.length}个`;
  }

  function scheduleAggregationDeadline(state) {
    if (aggregationDeadlineTimerId) {
      clearTimeout(aggregationDeadlineTimerId);
      aggregationDeadlineTimerId = null;
    }
    if (!state || !state.sessionId || state.completed) return;
    aggregationDeadlineTimerId = setTimeout(() => {
      aggregationDeadlineTimerId = null;
      maybeSendAggregatedNotification();
    }, AGGREGATION_WAIT_MS + 1000);
  }

  function startAggregationSession(source) {
    const today = ymd();
    const now = Date.now();
    const existing = getAggregationState();
    if (existing && existing.date === today && !existing.completed && existing.sessionId) {
      const next = { ...existing };
      if (source) next.source = source;
      if (!next.startedAt) next.startedAt = now;
      setAggregationState(next);
      scheduleAggregationDeadline(next);
      logLoginDebug('沿用聚合会话', next);
      maybeSendAggregatedNotification(next);
      return next;
    }
    const sessionId = `${today}-${Math.random().toString(36).slice(2, 8)}${Math.random().toString(36).slice(2, 8)}`;
    const state = {
      date: today,
      sessionId,
      startedAt: now,
      source: source || 'auto',
      notified: false,
      completed: false,
      lastSummaryKey: ''
    };
    setAggregationState(state);
    setSessionResults(sessionId, {});
    scheduleAggregationDeadline(state);
    logLoginDebug('创建新聚合会话', state);
    return state;
  }

  function recordLoginResult(hostKey, status, detail = {}) {
    const state = getAggregationState();
    if (!state || !state.sessionId || state.completed) return;
    if (!hostKey) return;
    const normalizedKey = hostKey.toLowerCase();
    const label = SITE_HOST_LABEL_MAP.get(normalizedKey) || hostKey;
    const results = getSessionResults(state.sessionId);
    results[normalizedKey] = {
      status,
      label,
      message: detail.message || detail.reason || '',
      updatedAt: Date.now()
    };
    setSessionResults(state.sessionId, results);
    logLoginDebug('记录登录结果', {
      host: normalizedKey,
      status,
      message: results[normalizedKey].message,
      sessionId: state.sessionId
    });
    maybeSendAggregatedNotification(state, results);
  }

  function maybeSendAggregatedNotification(stateParam, resultsParam) {
    const latestState = stateParam || getAggregationState();
    if (!latestState || latestState.completed || latestState.date !== ymd()) return;
    const results = resultsParam || getSessionResults(latestState.sessionId);
    const successEntries = [];
    const failureEntries = [];
    Object.values(results).forEach(entry => {
      if (entry.status === 'success') {
        successEntries.push(entry);
      } else if (entry.status === 'failure') {
        failureEntries.push(entry);
      }
    });
    const pendingKeys = SITE_HOST_KEYS.filter(key => !results[key]);
    const pendingLabels = pendingKeys.map(key => SITE_HOST_LABEL_MAP.get(key) || key);
    const allReported = pendingKeys.length === 0 && SITE_HOST_KEYS.length > 0;
    const deadlineReached = Date.now() - (latestState.startedAt || 0) >= AGGREGATION_WAIT_MS;
    const summaryKey = `${successEntries.length}|${failureEntries.length}|${pendingLabels.length}`;
    const previousKey = latestState.lastSummaryKey || '';
    const readyForInitialNotification = !latestState.notified && (allReported || deadlineReached);
    const readyForUpdate = latestState.notified && summaryKey !== previousKey;
    if (!readyForInitialNotification && !readyForUpdate) return;
    if (latestState.notified && summaryKey === previousKey) return;

    const summaryChunks = [
      `成功 ${successEntries.length}`,
      `失败 ${failureEntries.length}`
    ];
    if (pendingLabels.length) summaryChunks.push(`待检测 ${pendingLabels.length}`);
    const title = `PT站点汇总 ${summaryChunks.join(' / ')}`;

    const successLabels = successEntries.map(entry => entry.label);
    const failureLabels = failureEntries.map(entry => entry.message ? `${entry.label}(${entry.message})` : entry.label);

    const bodyLines = [];
    if (successLabels.length) bodyLines.push(`成功: ${formatSummaryList(successLabels)}`);
    if (failureLabels.length) bodyLines.push(`失败: ${formatSummaryList(failureLabels)}`);
    if (pendingLabels.length) bodyLines.push(`待检测: ${formatSummaryList(pendingLabels)}`);
    const body = bodyLines.join('\n') || '暂无可汇总的信息';

    try {
      GM_notification?.({
        title,
        text: body,
        timeout: 8000
      });
    } catch (err) {
      logLoginDebug('GM_notification 汇总推送失败', err);
    }
    const nextState = {
      ...latestState,
      notified: true,
      lastSummaryKey: summaryKey,
      notifiedAt: Date.now()
    };
    if (!pendingLabels.length) {
      nextState.completed = true;
    }
    setAggregationState(nextState);
    if (aggregationDeadlineTimerId && nextState.completed) {
      clearTimeout(aggregationDeadlineTimerId);
      aggregationDeadlineTimerId = null;
    }
    logLoginDebug('聚合推送完成', {
      summary: summaryChunks,
      success: successLabels.length,
      failure: failureLabels.length,
      pending: pendingLabels.length,
      completed: !!nextState.completed
    });
  }

  function pushBark(title, body) {
    if (!BARK_ENDPOINT) {
      logLoginDebug('pushBark skipped：未配置 Bark 地址');
      return;
    }
    const base = BARK_ENDPOINT.replace(/\/+$/, '');
    if (!base) {
      logLoginDebug('pushBark skipped：Bark 地址为空');
      return;
    }
    const target = `${base}/${encodeURIComponent(title)}/${encodeURIComponent(body)}?group=pt-helper&isArchive=1`;
    try {
      logLoginDebug('pushBark 请求发送', target);
      GM_xmlhttpRequest({
        method: 'GET',
        url: target,
        timeout: 5000
      });
    } catch (err) {
      logLoginDebug('pushBark 请求异常', err);
    }
  }

  function notifyScheduleTriggered(triggerDateStr) {
    const title = 'PT站点自动打开提醒';
    const text = 'PT定时开启间隔已到，请自行查看登陆情况';
    logLoginDebug('定时提醒发送', { triggerDateStr, bark: !!BARK_ENDPOINT });
    try {
      GM_notification?.({
        title,
        text,
        timeout: 6000
      });
    } catch (err) {
      logLoginDebug('GM_notification 定时提醒失败', err);
    }
    pushBark(title, text);
  }

  function notifyLoginSuccess(hostname) {
    const title = `${hostname} 登录成功`;
    const text = '检测到上传/下载统计信息，当前处于已登录状态。';
    const aggregation = isAggregationActive();
    if (!aggregation && !STANDALONE_NOTIFY_ENABLED) {
      logLoginDebug('登录成功但跳过通知：独立提醒已关闭', { hostname });
      return;
    }
    logLoginDebug('登录成功，发送通知', { hostname, aggregation });
    try {
      GM_notification?.({
        title,
        text,
        timeout: 4000
      });
    } catch (err) {
      logLoginDebug('GM_notification 调用失败', err);
    }
    if (aggregation) {
      logLoginDebug('聚合模式启用，跳过单站额外通知', { hostname });
    }
  }

  function initLoginDetection() {
    if (!SITE_ORIGINS.has(location.origin)) return;
    const hostKey = location.hostname || location.origin;
    const today = ymd();
    const storageKey = `${LOGIN_NOTIFY_PREFIX}${hostKey}`;
    logLoginDebug('初始化登录检测', {
      origin: location.origin,
      hostKey,
      today,
      barkConfigured: !!BARK_ENDPOINT,
      debugEnabled: DEBUG_LOGIN
    });
    if (GM_getValue(storageKey, '') === today) {
      logLoginDebug('已通知过，跳过检测', { storageKey, today });
      return;
    }

    const deadline = Date.now() + LOGIN_CHECK_TIMEOUT_MS;
    let lastCheckSample = '';
    logLoginDebug('开始轮询检测', {
      timeoutMs: LOGIN_CHECK_TIMEOUT_MS,
      intervalMs: LOGIN_CHECK_INTERVAL_MS
    });
    const runCheck = () => {
      const body = document.body;
      if (!body) {
        logLoginDebug('尚未获取到正文，等待中');
        if (Date.now() < deadline) setTimeout(runCheck, 500);
        return;
      }
      const text = (body.innerText || body.textContent || '').replace(/\s+/g, ' ');
      lastCheckSample = text.slice(0, 200);
      const matchedPattern = LOGIN_TEXT_PATTERNS.find(re => re.test(text));
      logLoginDebug('轮询检查', {
        textLength: text.length,
        matched: !!matchedPattern,
        remainingMs: deadline - Date.now()
      });
      if (text && matchedPattern) {
        GM_setValue(storageKey, today);
        logLoginDebug('检测到登录迹象', { pattern: matchedPattern.toString() });
        recordLoginResult(hostKey, 'success');
        notifyLoginSuccess(location.hostname);
        return;
      }
      if (Date.now() < deadline) {
        setTimeout(runCheck, LOGIN_CHECK_INTERVAL_MS);
      } else {
        logLoginDebug('检测超时，未找到登录迹象', { sample: lastCheckSample });
        recordLoginResult(hostKey, 'failure', { message: '检测超时' });
      }
    };

    if (document.readyState === 'complete' || document.readyState === 'interactive') {
      logLoginDebug('文档已就绪，立即检测');
      runCheck();
    } else {
      logLoginDebug('等待 DOMContentLoaded 事件后检测');
      document.addEventListener('DOMContentLoaded', runCheck, { once: true });
    }
  }

  /* ---------------- 关键互斥逻辑（租约 + 稳定期） ----------------
   * GM_setValue 不提供原子锁。到点时多个页面可能同时写入候选值，
   * 所以候选者必须等待 LOCK_SETTLE_MS，再次确认自己仍是最终持有者。
   * 如果持有者在执行前关闭，其他页面会在租约过期后重新竞选。
  */

  // 注册跨页面变更监听
  GM_addValueChangeListener(LOCK_KEY, (name, oldVal, newVal) => {
    const today = ymd();
    const nextState = parseLockState(newVal);
    if (!nextState || nextState.date !== today) return;

    if (wasOpenedOn(today)) {
      clearLockSettlementTimer();
      clearLockRetryTimer();
      if (GM_getValue(OPENED_DATE_KEY, '') !== today) {
        GM_setValue(OPENED_DATE_KEY, today);
      }
      if (GM_getValue(AUTO_LAST_TRIGGER_DATE_KEY, '') !== today) {
        GM_setValue(AUTO_LAST_TRIGGER_DATE_KEY, today);
      }
      return;
    }

    const storedState = parseLockState(GM_getValue(LOCK_KEY, ''));
    if (!storedState || storedState.date !== today) return;
    if (storedState.owner === INSTANCE_ID) {
      clearLockRetryTimer();
      scheduleLockSettlement(storedState);
    } else {
      clearLockSettlementTimer();
      scheduleLockRetry(storedState);
    }
  });

  function getTriggerMomentFor(baseDate) {
    return new Date(
      baseDate.getFullYear(),
      baseDate.getMonth(),
      baseDate.getDate(),
      TRIGGER_HOUR,
      TRIGGER_MINUTE,
      0,
      0
    );
  }

  function getLastAutoTriggerDate() {
    const candidates = [
      GM_getValue(AUTO_LAST_TRIGGER_DATE_KEY, ''),
      GM_getValue(OPENED_DATE_KEY, '')
    ];
    let latest = null;
    candidates.forEach(value => {
      const parsed = parseYmdDate(value);
      if (parsed && (!latest || parsed > latest)) {
        latest = parsed;
      }
    });
    return latest;
  }

  function attemptAutoOpen(targetMoment) {
    const intervalDays = autoOpenIntervalDays;
    if (intervalDays < MIN_AUTO_INTERVAL_DAYS) return;

    const lastTrigger = getLastAutoTriggerDate();
    let shouldTrigger = false;
    if (!lastTrigger) {
      shouldTrigger = true;
    } else {
      const diffMs = targetMoment.getTime() - lastTrigger.getTime();
      const diffDays = Math.floor(diffMs / (24 * 60 * 60 * 1000));
      if (diffDays >= intervalDays) {
        shouldTrigger = true;
      }
    }

    if (!shouldTrigger) return;
    const triggerDateStr = ymd(targetMoment);
    if (wasOpenedOn(triggerDateStr)) return;

    const existingLock = parseLockState(GM_getValue(LOCK_KEY, ''));
    if (existingLock && existingLock.date === triggerDateStr) {
      if (existingLock.owner === INSTANCE_ID) {
        scheduleLockSettlement(existingLock);
        return;
      }
      if (isFreshLock(existingLock)) {
        scheduleLockRetry(existingLock);
        return;
      }
      // 持有者可能已经关闭；仅在租约过期且仍未打开时重新竞选。
    }

    const lockState = buildLockState(triggerDateStr);
    const serialized = serializeLockState(lockState);
    if (!serialized) return;
    GM_setValue(LOCK_KEY, serialized);
    // 不依赖变更监听是否会回调写入方；当前实例也显式进入稳定期。
    scheduleLockSettlement(lockState);
  }

  function tryImmediateAutoOpen() {
    const now = new Date();
    const todayTrigger = getTriggerMomentFor(now);
    if (now >= todayTrigger) {
      attemptAutoOpen(todayTrigger);
    }
  }

  function scheduleAutoOpen() {
    const now = new Date();
    let nextTrigger = getTriggerMomentFor(now);
    if (nextTrigger <= now) {
      nextTrigger.setDate(nextTrigger.getDate() + 1);
    }
    const scheduledTime = nextTrigger.getTime();
    const delayMs = Math.max(1000, scheduledTime - now.getTime());
    setTimeout(() => {
      attemptAutoOpen(new Date(scheduledTime));
      scheduleAutoOpen();
    }, delayMs);
  }

  /* ---------------- UI：每日一次按钮 ---------------- */
  function createOncePerDayButton() {
    const today = ymd();
    const clickedDate = GM_getValue('pt_btn_clicked_date', '');
    if (clickedDate === today) return;

    const btnContainer = document.createElement('div');
    btnContainer.innerHTML = `
      <button id="pt-open-btn" style="all: initial; font-family: system-ui, sans-serif; position: fixed; bottom: 20px; right: 20px; z-index: 2147483647; padding: 10px 14px; font-size: 14px; font-weight: 600; background: #0d6efd; color: #fff; border: none; border-radius: 8px; box-shadow: 0 4px 12px rgba(0,0,0,.18); cursor: pointer;">打开PT站点</button>
      <button id="pt-open-close" title="今日不再显示" style="all: initial; position: fixed; bottom: 56px; right: 20px; z-index: 2147483647; width: 22px; height: 22px; line-height: 20px; text-align: center; font-family: system-ui, sans-serif; font-size: 16px; color: #555; background: #fff; border-radius: 50%; border: 1px solid rgba(0,0,0,.15); box-shadow: 0 2px 6px rgba(0,0,0,.12); cursor: pointer;">×</button>
    `;
    document.body.appendChild(btnContainer);

    btnContainer.querySelector('#pt-open-btn').addEventListener('click', () => {
      const confirmed = openSites(true, { batchSource: 'manual' });
      if (confirmed) {
        btnContainer.remove();
        GM_setValue('pt_btn_clicked_date', today);
      }
    });

    btnContainer.querySelector('#pt-open-close').addEventListener('click', () => {
      btnContainer.remove();
      GM_setValue('pt_btn_clicked_date', today);
    });
  }

  /* ---------------- 启动 ---------------- */
  registerMenus();
  initLoginDetection();
  document.addEventListener('DOMContentLoaded', createOncePerDayButton);
  setTimeout(() => {
    tryImmediateAutoOpen();
    scheduleAutoOpen();
  }, 2000);
})();
