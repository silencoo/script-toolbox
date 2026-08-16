// ==UserScript==
// @name         Codex Quota Compass (Visual Edition)
// @namespace    https://github.com/silencoo/script-toolbox
// @version      1.10.2
// @description  Display Codex quota usage and detailed daily metrics cleanly.
// @match        https://chatgpt.com/codex/cloud/settings/analytics*
// @homepageURL  https://github.com/silencoo/script-toolbox/tree/main/userscripts/codex-quota-compass
// @supportURL   https://github.com/silencoo/script-toolbox/issues
// @downloadURL  https://raw.githubusercontent.com/silencoo/script-toolbox/main/userscripts/codex-quota-compass/codex-quota-compass.user.js
// @updateURL    https://raw.githubusercontent.com/silencoo/script-toolbox/main/userscripts/codex-quota-compass/codex-quota-compass.user.js
// @grant        GM_addStyle
// @run-at       document-idle
// @noframes
// @license      MIT
// ==/UserScript==

(function () {
    'use strict';

    const CONFIG = {
        USD_PER_CREDIT: 40 / 1000,
        HISTORY_DAYS: 30,
    };

    const VERSION = '1.10.2';
    const ANALYTICS_BUTTON_ICON = `
        <svg class="compass-btn-icon" viewBox="0 0 20 20" fill="none" aria-hidden="true">
            <path d="M3.75 16.25h12.5M5.5 13V9.75M10 13V5.75M14.5 13V8"
                stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
        </svg>
    `;

    GM_addStyle(`
        #codex-compass-root {
            position: fixed;
            top: 5%;
            left: 50%;
            transform: translateX(-50%);
            width: min(720px, calc(100vw - 32px));
            max-height: 90vh;
            box-sizing: border-box;
            overflow-y: auto;
            background: #fff;
            border-radius: 12px;
            box-shadow: 0 10px 50px rgba(0, 0, 0, 0.25);
            z-index: 10001;
            padding: 24px;
            display: none;
            border: 1px solid #e5e5e5;
            color: #333;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        }

        .compass-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 15px;
        }

        .compass-title {
            font-size: 18px;
            font-weight: 600;
            color: #111;
        }

        .compass-close {
            padding: 0;
            border: 0;
            background: transparent;
            cursor: pointer;
            font-size: 24px;
            color: #999;
            line-height: 1;
            transition: color 0.2s;
        }

        .compass-close:hover {
            color: #333;
        }

        .compass-grid {
            display: grid;
            grid-template-columns: repeat(4, minmax(0, 1fr));
            gap: 12px;
            margin-bottom: 20px;
        }

        .compass-card {
            min-width: 0;
            background: #f9f9f9;
            padding: 12px;
            border-radius: 8px;
            border: 1px solid #eee;
        }

        .compass-card.highlight {
            background: #eefaf5;
            border-color: #d1f2e1;
        }

        .compass-card.unavailable {
            background: #fafafa;
            border-color: #e5e5e5;
        }

        .card-label {
            font-size: 12px;
            color: #666;
            margin-bottom: 4px;
        }

        .card-value {
            font-size: 15px;
            font-weight: bold;
            color: #10a37f;
            white-space: nowrap;
        }

        .card-unit {
            font-size: 10px;
            font-weight: normal;
        }

        .card-value.muted {
            color: #777;
        }

        .compass-notice {
            margin: 0 0 18px;
            padding: 10px 12px;
            border: 1px solid #f0d9a8;
            border-radius: 8px;
            background: #fff9ec;
            color: #725316;
            font-size: 12px;
            line-height: 1.5;
        }

        .compass-notice strong {
            color: #5d430f;
        }

        .compass-notice.info {
            border-color: #cfe4dc;
            background: #f1faf7;
            color: #315d50;
        }

        .compass-notice.info strong {
            color: #204c40;
        }

        .compass-section-title {
            margin-bottom: 8px;
            color: #444;
            font-size: 13px;
            font-weight: 600;
        }

        .compass-section-title.history {
            margin-top: 10px;
            color: #666;
        }

        .compass-formula {
            margin: 4px 0 18px;
            padding: 14px;
            border: 1px solid #e7e7e7;
            border-radius: 8px;
            background: #fafafa;
            color: #555;
            font-size: 12px;
            line-height: 1.55;
        }

        .compass-formula-title {
            margin-bottom: 8px;
            color: #333;
            font-size: 13px;
            font-weight: 600;
        }

        .compass-formula code {
            display: block;
            margin: 5px 0;
            padding: 7px 9px;
            overflow-wrap: anywhere;
            border-radius: 5px;
            background: #f0f0f0;
            color: #333;
            font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
            font-size: 11px;
        }

        .compass-formula-result {
            margin-top: 8px;
            color: #333;
            font-weight: 600;
        }

        .compass-caveats {
            margin: 9px 0 0;
            padding-left: 18px;
            color: #707070;
        }

        .compass-caveats li + li {
            margin-top: 3px;
        }

        .table-container {
            max-height: 200px;
            overflow: auto;
            flex-shrink: 0;
            border: 1px solid #eee;
            border-radius: 6px;
            margin-bottom: 15px;
        }

        .compass-table {
            width: 100%;
            border-collapse: collapse;
            font-size: 12px;
        }

        .compass-table thead {
            position: sticky;
            top: 0;
            background: #f5f5f5;
            z-index: 1;
        }

        .compass-table th {
            text-align: left;
            padding: 8px;
            border-bottom: 1px solid #eee;
            color: #666;
            font-weight: 600;
        }

        .compass-table td {
            padding: 8px;
            border-bottom: 1px solid #f0f0f0;
        }

        .compass-table .numeric {
            font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
        }

        .compass-date-note {
            display: block;
            margin-top: 2px;
            color: #9a6a0a;
            font-size: 10px;
            white-space: nowrap;
        }

        .compass-empty {
            text-align: center;
            color: #888;
        }

        .compass-footer-row {
            background: #fafafa;
            font-weight: bold;
            position: sticky;
            bottom: 0;
            border-top: 2px solid #eee;
        }

        .compass-footer-row .amount {
            color: #10a37f;
        }

        #codex-compass-btn {
            position: static;
            z-index: auto;
            flex: 0 0 auto;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            gap: 6px;
            height: 32px;
            margin-inline-end: 8px;
            padding: 0 12px;
            background: var(--text-primary, #171717);
            color: var(--main-surface-primary, #fff);
            font-size: 12px;
            font-weight: 600;
            letter-spacing: 0.2px;
            border: 1px solid transparent;
            border-radius: 8px;
            box-shadow: none;
            cursor: pointer;
            outline: none;
            user-select: none;
            transition: opacity 0.2s cubic-bezier(0.16, 1, 0.3, 1),
                transform 0.2s cubic-bezier(0.16, 1, 0.3, 1),
                outline-color 0.2s cubic-bezier(0.16, 1, 0.3, 1);
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        }

        #codex-compass-btn:hover {
            opacity: 0.82;
        }

        #codex-compass-btn:active {
            transform: scale(0.98);
        }

        #codex-compass-btn:focus-visible {
            outline: 2px solid var(--text-primary, #171717);
            outline-offset: 2px;
        }

        .compass-btn-icon {
            width: 16px;
            height: 16px;
            flex: 0 0 auto;
        }

        #codex-compass-btn.compass-floating-fallback {
            position: fixed;
            right: 24px;
            bottom: 24px;
            z-index: 10000;
            height: 40px;
            margin-inline-end: 0;
            padding: 0 20px;
            border-radius: 20px;
            font-size: 13px;
            box-shadow: 0 4px 12px rgba(0, 0, 0, 0.18), 0 1px 3px rgba(0, 0, 0, 0.08);
        }

        #codex-compass-btn.loading {
            opacity: 0.85;
            cursor: wait;
            pointer-events: none;
        }

        .compass-btn-spinner {
            width: 14px;
            height: 14px;
            border: 2px solid rgba(255, 255, 255, 0.3);
            border-top-color: #fff;
            border-radius: 50%;
            animation: compass-spin 0.6s linear infinite;
        }

        @keyframes compass-spin {
            to { transform: rotate(360deg); }
        }

        @media (max-width: 640px) {
            #codex-compass-root {
                top: 16px;
                max-height: calc(100vh - 32px);
                padding: 18px;
            }

            .compass-grid {
                grid-template-columns: repeat(2, minmax(0, 1fr));
            }

            #codex-compass-btn.compass-floating-fallback {
                right: 16px;
                bottom: 16px;
            }
        }
    `);

    function numberOrZero(value) {
        const number = Number(value);
        return Number.isFinite(number) ? number : 0;
    }

    function escapeHtml(value) {
        return String(value)
            .replaceAll('&', '&amp;')
            .replaceAll('<', '&lt;')
            .replaceAll('>', '&gt;')
            .replaceAll('"', '&quot;')
            .replaceAll("'", '&#039;');
    }

    function toDateString(date) {
        return date.toISOString().slice(0, 10);
    }

    async function apiGet(path, token) {
        const response = await fetch(path, {
            credentials: 'same-origin',
            headers: { Authorization: `Bearer ${token}` },
        });

        if (!response.ok) {
            throw new Error(`Request failed: ${response.status}`);
        }

        return response.json();
    }

    function getStats(list) {
        const credits = list.reduce((sum, item) => sum + numberOrZero(item.totals?.credits), 0);
        const turns = list.reduce((sum, item) => sum + numberOrZero(item.totals?.turns), 0);
        return {
            credits,
            turns,
            usd: credits * CONFIG.USD_PER_CREDIT,
        };
    }

    function renderTable(list, stats, options = {}) {
        const { todayDate = '' } = options;
        const rows = [...list]
            .sort((left, right) => String(right.date).localeCompare(String(left.date)))
            .map((row) => {
                const credits = numberOrZero(row.totals?.credits);
                const turns = numberOrZero(row.totals?.turns);
                const isToday = String(row.date) === todayDate;
                return `
                    <tr>
                        <td>
                            ${escapeHtml(row.date)}
                            ${isToday ? '<span class="compass-date-note">Today · may be delayed</span>' : ''}
                        </td>
                        <td class="numeric">${credits.toFixed(3)}</td>
                        <td>$ ${(credits * CONFIG.USD_PER_CREDIT).toFixed(2)}</td>
                        <td>${turns}</td>
                    </tr>
                `;
            })
            .join('');

        return `
            <div class="table-container">
                <table class="compass-table">
                    <thead>
                        <tr><th>Date</th><th>Credits</th><th>Amount</th><th>Turns</th></tr>
                    </thead>
                    <tbody>
                        ${rows || '<tr><td class="compass-empty" colspan="4">No usage recorded</td></tr>'}
                    </tbody>
                    <tfoot>
                        <tr class="compass-footer-row">
                            <td>Total</td>
                            <td>${stats.credits.toFixed(3)}</td>
                            <td class="amount">$ ${stats.usd.toFixed(2)}</td>
                            <td>${stats.turns}</td>
                        </tr>
                    </tfoot>
                </table>
            </div>
        `;
    }

    function formatPercent(value) {
        return Number.isInteger(value) ? value.toFixed(0) : value.toFixed(2);
    }

    function getLatestActivityDate(list) {
        const dates = list
            .filter((item) => (
                numberOrZero(item.totals?.credits) > 0
                || numberOrZero(item.totals?.turns) > 0
            ))
            .map((item) => String(item.date))
            .sort();
        return dates.at(-1) || '';
    }

    function evaluateEstimate(currentCycleList, usedPercent, todayDate) {
        const currentStats = getStats(currentCycleList);
        const ratio = usedPercent / 100;
        const todayRows = currentCycleList.filter((item) => String(item.date) === todayDate);
        const todayStats = getStats(todayRows);
        const hasTodayActivity = todayStats.credits > 0 || todayStats.turns > 0;
        const latestActivityDate = getLatestActivityDate(currentCycleList);

        if (ratio <= 0) {
            return {
                kind: 'unavailable',
                estimatedCredits: null,
                latestActivityDate,
                message: 'The usage endpoint reports 0%, so division cannot produce a meaningful quota estimate.',
            };
        }

        if (currentStats.credits <= 0) {
            return {
                kind: 'delayed',
                estimatedCredits: null,
                latestActivityDate,
                message: `The daily endpoint reports 0 credits for this cycle while the usage endpoint reports ${formatPercent(usedPercent)}%. The estimate is withheld instead of treating delayed data as zero usage.`,
            };
        }

        if (todayRows.length === 0 || !hasTodayActivity) {
            const todayState = todayRows.length === 0 ? 'missing' : 'still zero';
            return {
                kind: 'delayed',
                estimatedCredits: null,
                latestActivityDate,
                message: `Today's daily row (${todayDate}) is ${todayState}. Because the percentage and credit totals are not aligned in time, the estimate is withheld.`,
            };
        }

        return {
            kind: 'provisional',
            estimatedCredits: currentStats.credits / ratio,
            latestActivityDate,
            message: 'Today has recorded activity, but daily analytics may still lag behind the usage percentage. Treat the result as provisional.',
        };
    }

    function renderEstimateNotice(estimate) {
        const title = estimate.kind === 'provisional'
            ? 'Provisional estimate'
            : estimate.kind === 'delayed'
                ? 'Daily data delayed or unverified'
                : 'Estimate unavailable';
        const className = estimate.kind === 'provisional' ? 'compass-notice info' : 'compass-notice';
        const latestActivity = estimate.latestActivityDate
            ? ` Latest recorded activity date: ${escapeHtml(estimate.latestActivityDate)}.`
            : '';
        return `
            <div class="${className}" role="status">
                <strong>${title}.</strong> ${escapeHtml(estimate.message)}${latestActivity}
            </div>
        `;
    }

    function renderFormula(currentStats, usedPercent, estimate) {
        const percentText = formatPercent(usedPercent);
        const rateText = CONFIG.USD_PER_CREDIT.toFixed(4);
        const result = estimate.estimatedCredits === null
            ? `<span>Not calculated: the required inputs are not synchronized.</span>`
            : `<span>${currentStats.credits.toFixed(3)} ÷ (${percentText}% ÷ 100) = ${estimate.estimatedCredits.toFixed(1)} credits</span>`;

        return `
            <section class="compass-formula" aria-labelledby="compass-formula-title">
                <div class="compass-formula-title" id="compass-formula-title">How the estimate is calculated</div>
                <code>Reported cycle credits = Σ daily credits dated on/after the cycle start date</code>
                <code>Provisional total quota = Reported cycle credits ÷ (Used percent ÷ 100)</code>
                <code>Provisional value = Provisional total quota × $${rateText} per credit</code>
                <div class="compass-formula-result">Current calculation: ${result}</div>
                <ul class="compass-caveats">
                    <li>Used percent comes from the usage endpoint; credits come from daily analytics. They can refresh at different times.</li>
                    <li>Today's row is considered unsettled. If it is missing or zero, the script does not show a quota estimate.</li>
                    <li>Daily data uses calendar dates, so a quota cycle that resets mid-day can make the first day's total imperfect.</li>
                    <li>Dollar values use the configured rate and are estimates, not billing data.</li>
                </ul>
            </section>
        `;
    }

    function showPanel(data) {
        const root = document.getElementById('codex-compass-root');
        if (!root) return;

        const { secondary, dailyList, cycleStartDate, todayDate } = data;
        const currentCycleList = [];
        const historyList = [];

        dailyList.forEach((item) => {
            if (String(item.date) >= cycleStartDate) {
                currentCycleList.push(item);
            } else {
                historyList.push(item);
            }
        });

        const currentStats = getStats(currentCycleList);
        const historyStats = getStats(historyList);
        const usedPercent = numberOrZero(secondary?.used_percent);
        const estimate = evaluateEstimate(currentCycleList, usedPercent, todayDate);
        const estimatedCredits = estimate.estimatedCredits;
        const estimateValue = estimatedCredits === null
            ? '—'
            : `${estimatedCredits.toFixed(1)} <span class="card-unit">Credits</span>`;
        const estimatedUsd = estimatedCredits === null
            ? '—'
            : `$ ${(estimatedCredits * CONFIG.USD_PER_CREDIT).toFixed(2)}`;

        let historyRangeTitle = 'History (Outside Current Cycle)';
        if (historyList.length > 0) {
            const sortedHistory = [...historyList]
                .sort((left, right) => String(left.date).localeCompare(String(right.date)));
            const start = escapeHtml(sortedHistory[0].date);
            const end = escapeHtml(sortedHistory[sortedHistory.length - 1].date);
            historyRangeTitle = `History (${start} to ${end})`;
        }

        root.innerHTML = `
            <div class="compass-header">
                <div class="compass-title" id="codex-compass-title">Codex Quota Analytics (v${VERSION})</div>
                <button class="compass-close" id="compass-close-btn" type="button" aria-label="Close">&times;</button>
            </div>
            ${renderEstimateNotice(estimate)}
            <div class="compass-grid">
                <div class="compass-card">
                    <div class="card-label">Used Percent</div>
                    <div class="card-value">${formatPercent(usedPercent)}%</div>
                </div>
                <div class="compass-card">
                    <div class="card-label">Reported Credits</div>
                    <div class="card-value">${currentStats.credits.toFixed(1)} <span class="card-unit">Credits</span></div>
                </div>
                <div class="compass-card ${estimatedCredits === null ? 'unavailable' : 'highlight'}">
                    <div class="card-label">Provisional Quota</div>
                    <div class="card-value ${estimatedCredits === null ? 'muted' : ''}">${estimateValue}</div>
                </div>
                <div class="compass-card ${estimatedCredits === null ? 'unavailable' : ''}">
                    <div class="card-label">Provisional Value</div>
                    <div class="card-value ${estimatedCredits === null ? 'muted' : ''}">${estimatedUsd}</div>
                </div>
            </div>

            ${renderFormula(currentStats, usedPercent, estimate)}

            <div class="compass-section-title">Current Cycle (Since ${escapeHtml(cycleStartDate)})</div>
            ${renderTable(currentCycleList, currentStats, { todayDate })}

            ${historyList.length > 0 ? `
                <div class="compass-section-title history">${historyRangeTitle}</div>
                ${renderTable(historyList, historyStats)}
            ` : ''}
        `;

        root.style.display = 'block';
        root.setAttribute('aria-hidden', 'false');
        document.getElementById('compass-close-btn')?.addEventListener('click', hidePanel);
    }

    function hidePanel() {
        const root = document.getElementById('codex-compass-root');
        if (!root) return;
        root.style.display = 'none';
        root.setAttribute('aria-hidden', 'true');
    }

    function getAccessToken() {
        const bootstrapData = document.getElementById('client-bootstrap')?.textContent || '';
        if (!bootstrapData) return '';

        try {
            const bootstrap = JSON.parse(bootstrapData);
            const accessToken = bootstrap?.session?.accessToken;
            return typeof accessToken === 'string' ? accessToken : '';
        } catch {
            return '';
        }
    }

    function showIdleButton(button) {
        button.innerHTML = `${ANALYTICS_BUTTON_ICON}<span>Quota Analytics</span>`;
    }

    async function run() {
        const button = document.getElementById('codex-compass-btn');
        const token = getAccessToken();

        if (!token) {
            alert('Failed to get token. Please make sure you are logged in and reload the page.');
            return;
        }

        button?.classList.add('loading');
        if (button) {
            button.innerHTML = '<span class="compass-btn-spinner" aria-hidden="true"></span><span>Analyzing...</span>';
        }

        try {
            const usage = await apiGet('/backend-api/wham/usage', token);
            const secondary = usage?.rate_limit?.secondary_window || usage?.rate_limit?.primary_window;
            const now = Date.now();
            const endDate = toDateString(new Date(now + 86400000));
            const startDate = toDateString(new Date(now - CONFIG.HISTORY_DAYS * 86400000));
            const todayDate = toDateString(new Date(now));
            const cycleStartDate = secondary?.reset_at && secondary?.limit_window_seconds
                ? toDateString(new Date((secondary.reset_at - secondary.limit_window_seconds) * 1000))
                : startDate;
            const query = new URLSearchParams({
                start_date: startDate,
                end_date: endDate,
                group_by: 'day',
            });
            const dailyData = await apiGet(
                `/backend-api/wham/analytics/daily-workspace-usage-counts?${query}`,
                token,
            );
            const dailyList = Array.isArray(dailyData?.data) ? dailyData.data : [];

            showPanel({ secondary, dailyList, cycleStartDate, todayDate });
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            alert(`Codex Quota Compass error: ${message}`);
        } finally {
            button?.classList.remove('loading');
            if (button) showIdleButton(button);
        }
    }

    function getHeaderButtonMount() {
        const profileButton = document.querySelector('button[data-testid="profile-button"]');
        const header = profileButton?.closest('.sticky');
        const actionGroup = profileButton?.parentElement;

        if (!profileButton || !header || !actionGroup || !header.contains(actionGroup)) {
            return null;
        }

        return { actionGroup, profileButton };
    }

    function mountButton() {
        let button = document.getElementById('codex-compass-btn');
        if (!button) {
            button = document.createElement('button');
            button.id = 'codex-compass-btn';
            button.type = 'button';
            button.setAttribute('aria-label', 'Run Codex quota analytics');
            showIdleButton(button);
            button.addEventListener('click', run);
        }

        const headerMount = getHeaderButtonMount();
        if (headerMount) {
            button.classList.remove('compass-floating-fallback');
            if (
                button.parentElement !== headerMount.actionGroup
                || button.nextElementSibling !== headerMount.profileButton
            ) {
                headerMount.actionGroup.insertBefore(button, headerMount.profileButton);
            }
            return;
        }

        if (!button.isConnected) {
            button.classList.add('compass-floating-fallback');
            document.body.appendChild(button);
        }
    }

    function init() {
        mountButton();

        let root = document.getElementById('codex-compass-root');
        if (!root) {
            root = document.createElement('div');
            root.id = 'codex-compass-root';
            root.setAttribute('role', 'dialog');
            root.setAttribute('aria-modal', 'true');
            root.setAttribute('aria-labelledby', 'codex-compass-title');
            root.setAttribute('aria-hidden', 'true');
            document.body.appendChild(root);
        }

        let mountFrame = 0;
        const buttonObserver = new MutationObserver(() => {
            const button = document.getElementById('codex-compass-btn');
            const headerMount = getHeaderButtonMount();
            const isMountedInHeader = Boolean(
                button
                && headerMount
                && button.parentElement === headerMount.actionGroup
                && button.nextElementSibling === headerMount.profileButton
            );
            if (isMountedInHeader || mountFrame) return;

            mountFrame = requestAnimationFrame(() => {
                mountFrame = 0;
                mountButton();
            });
        });
        buttonObserver.observe(document.body, { childList: true, subtree: true });

        document.addEventListener('keydown', (event) => {
            if (event.key === 'Escape') hidePanel();
        });
    }

    if (document.readyState === 'loading') {
        window.addEventListener('DOMContentLoaded', init, { once: true });
    } else {
        init();
    }
})();
