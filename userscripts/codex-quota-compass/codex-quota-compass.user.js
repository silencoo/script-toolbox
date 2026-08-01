// ==UserScript==
// @name         Codex Quota Compass (Visual Edition)
// @namespace    https://github.com/silencoo/script-toolbox
// @version      1.9.0
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
            flex-direction: column;
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

        .table-container {
            max-height: 200px;
            overflow: auto;
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
            position: fixed;
            bottom: 24px;
            right: 24px;
            z-index: 10000;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            gap: 8px;
            padding: 10px 20px;
            height: 40px;
            background: linear-gradient(180deg, #10a37f 0%, #0d8c6d 100%);
            color: #fff;
            font-size: 13px;
            font-weight: 600;
            letter-spacing: 0.2px;
            border: 1px solid rgba(0, 0, 0, 0.08);
            border-radius: 20px;
            box-shadow: 0 4px 12px rgba(16, 163, 127, 0.25), 0 1px 3px rgba(0, 0, 0, 0.08);
            cursor: pointer;
            outline: none;
            user-select: none;
            transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1);
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        }

        #codex-compass-btn:hover {
            background: linear-gradient(180deg, #12b38b 0%, #0e9a78 100%);
            box-shadow: 0 6px 16px rgba(16, 163, 127, 0.35), 0 2px 4px rgba(0, 0, 0, 0.1);
            transform: translateY(-1px);
        }

        #codex-compass-btn:active {
            transform: translateY(0) scale(0.98);
            box-shadow: 0 2px 6px rgba(16, 163, 127, 0.2);
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

            #codex-compass-btn {
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

    function renderTable(list, stats) {
        const rows = [...list]
            .sort((left, right) => String(right.date).localeCompare(String(left.date)))
            .map((row) => {
                const credits = numberOrZero(row.totals?.credits);
                const turns = numberOrZero(row.totals?.turns);
                return `
                    <tr>
                        <td>${escapeHtml(row.date)}</td>
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

    function showPanel(data) {
        const root = document.getElementById('codex-compass-root');
        if (!root) return;

        const { secondary, dailyList, cycleStartDate } = data;
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
        const ratio = usedPercent / 100;
        const estimatedCredits = ratio > 0 ? currentStats.credits / ratio : 0;

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
                <div class="compass-title" id="codex-compass-title">Codex Quota Analytics (v1.9.0)</div>
                <button class="compass-close" id="compass-close-btn" type="button" aria-label="Close">&times;</button>
            </div>
            <div class="compass-grid">
                <div class="compass-card">
                    <div class="card-label">Used Percent</div>
                    <div class="card-value">${usedPercent}%</div>
                </div>
                <div class="compass-card">
                    <div class="card-label">Used This Cycle</div>
                    <div class="card-value">${currentStats.credits.toFixed(1)} <span class="card-unit">Credits</span></div>
                </div>
                <div class="compass-card highlight">
                    <div class="card-label">Est. Total Quota</div>
                    <div class="card-value">${estimatedCredits.toFixed(1)} <span class="card-unit">Credits</span></div>
                </div>
                <div class="compass-card">
                    <div class="card-label">Est. Cycle Value</div>
                    <div class="card-value">$ ${(estimatedCredits * CONFIG.USD_PER_CREDIT).toFixed(2)}</div>
                </div>
            </div>

            <div class="compass-section-title">Current Cycle (Since ${escapeHtml(cycleStartDate)})</div>
            ${renderTable(currentCycleList, currentStats)}

            ${historyList.length > 0 ? `
                <div class="compass-section-title history">${historyRangeTitle}</div>
                ${renderTable(historyList, historyStats)}
            ` : ''}
        `;

        root.style.display = 'flex';
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
        return bootstrapData.match(/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/)?.[0] || '';
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
            button.innerHTML = '<span class="compass-btn-spinner"></span> Analyzing...';
        }

        try {
            const usage = await apiGet('/backend-api/wham/usage', token);
            const secondary = usage?.rate_limit?.secondary_window || usage?.rate_limit?.primary_window;
            const now = Date.now();
            const endDate = toDateString(new Date(now + 86400000));
            const startDate = toDateString(new Date(now - CONFIG.HISTORY_DAYS * 86400000));
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

            showPanel({ secondary, dailyList, cycleStartDate });
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            alert(`Codex Quota Compass error: ${message}`);
        } finally {
            button?.classList.remove('loading');
            if (button) button.textContent = 'Run Analytics';
        }
    }

    function init() {
        if (document.getElementById('codex-compass-btn')) return;

        const button = document.createElement('button');
        button.id = 'codex-compass-btn';
        button.type = 'button';
        button.textContent = 'Run Analytics';
        button.addEventListener('click', run);
        document.body.appendChild(button);

        const root = document.createElement('div');
        root.id = 'codex-compass-root';
        root.setAttribute('role', 'dialog');
        root.setAttribute('aria-modal', 'true');
        root.setAttribute('aria-labelledby', 'codex-compass-title');
        root.setAttribute('aria-hidden', 'true');
        document.body.appendChild(root);

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
