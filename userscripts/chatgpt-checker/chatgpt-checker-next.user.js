// ==UserScript==
// @name         ChatGPT Checker Next
// @namespace    https://github.com/zetaloop/chatgpt-checker-next
// @homepage     https://github.com/zetaloop/chatgpt-checker-next
// @author       zetaloop
// @icon         data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA2NCA2NCI+PHBhdGggZmlsbD0iIzJjM2U1MCIgZD0iTTMyIDJDMTUuNDMyIDIgMiAxNS40MzIgMiAzMnMxMy40MzIgMzAgMzAgMzAgMzAtMTMuNDMyIDMwLTMwUzQ4LjU2OCAyIDMyIDJ6bTAgNTRjLTEzLjIzMyAwLTI0LTEwLjc2Ny0yNC0yNFMxOC43NjcgOCAzMiA4czI0IDEwLjc2NyAyNCAyNFM0NS4yMzMgNTYgMzIgNTZ6Ii8+PHBhdGggZmlsbD0iIzNkYzJmZiIgZD0iTTMyIDEyYy0xMS4wNDYgMC0yMCA4Ljk1NC0yMCAyMHM4Ljk1NCAyMCAyMCAyMCAyMC04Ljk1NCAyMC0yMFM0My4wNDYgMTIgMzIgMTJ6bTAgMzZjLTguODM3IDAtMTYtNy4xNjMtMTYtMTZzNy4xNjMtMTYgMTYtMTYgMTYgNy4xNjMgMTYgMTZTNDAuODM3IDQ4IDMyIDQ4eiIvPjxwYXRoIGZpbGw9IiMwMGZmN2YiIGQ9Ik0zMiAyMGMtNi42MjcgMC0xMiA1LjM3My0xMiAxMnM1LjM3MyAxMiAxMiAxMiAxMi01LjM3MyAxMi0xMlMzOC42MjcgMjAgMzIgMjB6bTAgMjBjLTQuNDE4IDAtOC0zLjU4Mi04LThzMy41ODItOCA4LTggOCAzLjU4MiA4IDgtMy41ODIgOC04IDh6Ii8+PGNpcmNsZSBmaWxsPSIjZmZmIiBjeD0iMzIiIGN5PSIzMiIgcj0iNCIvPjwvc3ZnPg==
// @version      4.5.0
// @description  查看 ChatGPT、Codex 和 Grok 的账号、用量与服务信息。
// @match        *://chatgpt.com/*
// @match        *://grok.com/*
// @grant        GM_addElement
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        unsafeWindow
// @sandbox      raw
// @run-at       document-start
// @downloadURL  none
// @updateURL    none
// @license AGPLv3
// ==/UserScript==

// Compatibility changes: Script Toolbox, 2026-09-05.
// Based on zetaloop/chatgpt-checker-next 6c153995ae03073c90f090ea8f5a8aa41b65762d.
// This derivative remains AGPLv3; see the accompanying LICENSE and README.md.
// Quota estimation adapted from Codex Quota Compass (silencoo/script-toolbox).
// The following MIT notice applies to that contribution:
// Copyright (c) 2026 silencoo
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

(function () {
    "use strict";

    const MODE_CHATGPT = "chatgpt";
    const MODE_CODEX = "codex";
    const MODE_GROK = "grok";
    const pageWindow = unsafeWindow;

    function detectPageMode() {
        const { hostname, pathname } = pageWindow.location;
        if (hostname === "grok.com") return MODE_GROK;
        if (hostname === "chatgpt.com" && pathname.startsWith("/codex")) {
            return MODE_CODEX;
        }
        return MODE_CHATGPT;
    }

    const currentPageMode = detectPageMode();
    const isChatgptMode = currentPageMode === MODE_CHATGPT;
    const isCodexMode = currentPageMode === MODE_CODEX;
    const isGrokMode = currentPageMode === MODE_GROK;
    const CHECKER_SETTINGS_KEY = "checker-next-display-settings-v1";
    const CHECKER_DISPLAY_ITEMS = [
        ["pow", "PoW 难度", "checker-pow-row", "chatgpt"],
        ["persona", "用户类型", "persona-container", "chatgpt"],
        ["region", "用户地区", "user-region-container", "chatgpt"],
        ["pricing", "价格地区", "price-region-container", "chatgpt"],
        ["model", "模型与思考", "chatgpt-runtime-model-section", "chatgpt"],
        ["research", "深度研究", "deep-research-section", "chatgpt"],
        ["images", "图片生成", "image-gen-section", "chatgpt"],
        ["files", "文件上传", "file-upload-section", "chatgpt"],
        ["paste", "粘贴转文件", "paste-text-to-file-section", "chatgpt"],
        ["memory", "记忆用量", "memory-section", "chatgpt"],
        ["codex", "Codex 额度", "codex-section", "openai"],
        ["features", "功能开关", "features-section", "chatgpt"],
        ["subscription", "真实订阅", "checker-subscription", "openai"],
        ["storage", "文件库容量", "checker-storage", "openai"],
        ["daily", "Codex 每日统计", "checker-daily", "openai"],
        ["estimate", "Codex 周额估算", "checker-estimate", "openai"],
        ["freshness", "更新时间", "checker-freshness", "openai"],
        ["grok", "Grok 信息与功能", "grok-section", "grok"],
    ];
    let checkerSettings;
    try {
        checkerSettings = normalizeCheckerSettings(GM_getValue(CHECKER_SETTINGS_KEY, null));
    } catch {
        checkerSettings = normalizeCheckerSettings(null);
    }
    const checkerThemeMedia = pageWindow.matchMedia("(prefers-color-scheme: dark)");
    const checkerDetails = Object.fromEntries(["subscription", "storage", "daily", "quota"].map(key =>
        [key, { status: "idle", value: null, updated: null, error: null, sequence: 0 }]));
    const checkerFreshness = new Map();
    let checkerAccountId = null;
    let checkerAccountEpoch = 0;
    let checkerRequestSequence = 0;
    const CHECKER_DATA_LABELS = {
        subscription: "真实订阅", storage: "文件库容量", daily: "Codex 每日统计",
        account: "用户地区", pricing: "价格地区", pow: "PoW / 用户类型",
        models: "模型列表", limits: "对话额度", memory: "记忆用量", quota: "Codex 额度", age: "年龄验证入口",
        estimate: "Codex 周额估算",
    };

    function normalizeCheckerSettings(value) {
        const visible = {};
        for (const [key] of CHECKER_DISPLAY_ITEMS) {
            visible[key] = typeof value?.visible?.[key] === "boolean" ? value.visible[key] : true;
        }
        const usdPer1000 = value?.analytics?.usdPer1000;
        const historyDays = value?.analytics?.historyDays;
        return {
            theme: ["light", "dark", "system"].includes(value?.theme) ? value.theme : "light", visible,
            analytics: {
                usdPer1000: typeof usdPer1000 === "number" && Number.isFinite(usdPer1000) && usdPer1000 >= 0 && usdPer1000 <= 1000000 ? usdPer1000 : 40,
                historyDays: Number.isInteger(historyDays) && historyDays >= 1 && historyDays <= 365 ? historyDays : 30,
            },
        };
    }

    function parseCheckerAnalyticsInputs(rateText, daysText) {
        const usdPer1000 = typeof rateText === "string" && rateText.trim() ? Number(rateText) : NaN;
        const historyDays = typeof daysText === "string" && daysText.trim() ? Number(daysText) : NaN;
        if (!Number.isFinite(usdPer1000) || usdPer1000 < 0 || usdPer1000 > 1000000) return { error: "换算单价应为 0 到 1,000,000 之间的数字。", field: "checker-usd-rate" };
        if (!Number.isInteger(historyDays) || historyDays < 1 || historyDays > 365) return { error: "历史天数应为 1 到 365 之间的整数。", field: "checker-history-days" };
        return { value: { usdPer1000, historyDays } };
    }

    function syncCheckerAnalyticsInputs() {
        document.getElementById("checker-usd-rate").value = checkerSettings.analytics.usdPer1000;
        document.getElementById("checker-history-days").value = checkerSettings.analytics.historyDays;
        for (const id of ["checker-usd-rate", "checker-history-days"]) document.getElementById(id).removeAttribute("aria-invalid");
    }

    function checkerItemApplies(mode) {
        return mode === currentPageMode || (mode === "openai" && !isGrokMode);
    }

    function applyCheckerTheme() {
        const theme = checkerSettings.theme === "system"
            ? (checkerThemeMedia.matches ? "dark" : "light") : checkerSettings.theme;
        for (const element of document.querySelectorAll("#checker-next-displayBox, .checker-tooltip")) {
            element.dataset.checkerTheme = theme;
        }
    }

    function applyCheckerSettings() {
        applyCheckerTheme();
        for (const [key, , id] of CHECKER_DISPLAY_ITEMS) {
            const element = document.getElementById(id);
            if (element) element.dataset.checkerHidden = String(!checkerSettings.visible[key]);
            const input = document.getElementById(`checker-show-${key}`);
            if (input) input.checked = checkerSettings.visible[key];
        }
        const themeSelect = document.getElementById("checker-theme");
        if (themeSelect) themeSelect.value = checkerSettings.theme;
        const pow = document.getElementById("pow-section");
        if (pow) pow.dataset.checkerHidden = String(!["pow", "persona", "region", "pricing"].some(key => checkerSettings.visible[key]));
        const details = document.getElementById("checker-more-details");
        if (details) details.hidden = isGrokMode || !["subscription", "storage", "daily", "estimate", "freshness"].some(key => checkerSettings.visible[key]);
        const empty = document.getElementById("checker-empty");
        if (empty) empty.hidden = CHECKER_DISPLAY_ITEMS.some(([key, , , mode]) => checkerItemApplies(mode) && checkerSettings.visible[key]);
    }

    function saveCheckerSettings() {
        const status = document.getElementById("checker-settings-status");
        try {
            GM_setValue(CHECKER_SETTINGS_KEY, checkerSettings);
            if (status) status.textContent = "已保存，刷新后保留。";
        } catch {
            if (status) status.textContent = "本页已应用，但保存失败。";
        }
        applyCheckerSettings();
    }

    function bindCheckerSettings() {
        const button = document.getElementById("checker-settings-button");
        const settings = document.getElementById("checker-settings");
        button.addEventListener("click", () => {
            settings.hidden = !settings.hidden;
            button.setAttribute("aria-expanded", String(!settings.hidden));
        });
        document.getElementById("checker-theme").addEventListener("change", event => {
            checkerSettings.theme = event.target.value;
            saveCheckerSettings();
        });
        for (const [key] of CHECKER_DISPLAY_ITEMS) {
            document.getElementById(`checker-show-${key}`)?.addEventListener("change", event => {
                checkerSettings.visible[key] = event.target.checked;
                saveCheckerSettings();
                if (document.getElementById("checker-more-details").open) void refreshCheckerDetails(false);
            });
        }
        document.getElementById("checker-settings-reset").addEventListener("click", () => {
            const rangeChanged = checkerSettings.analytics.historyDays !== 30;
            checkerSettings = normalizeCheckerSettings(null);
            syncCheckerAnalyticsInputs();
            saveCheckerSettings();
            renderCheckerDetails();
            if (document.getElementById("checker-more-details").open) void refreshCheckerDetails(rangeChanged);
        });
        document.getElementById("checker-analytics-settings").addEventListener("submit", event => {
            event.preventDefault();
            const parsed = parseCheckerAnalyticsInputs(document.getElementById("checker-usd-rate").value, document.getElementById("checker-history-days").value);
            const status = document.getElementById("checker-settings-status");
            for (const id of ["checker-usd-rate", "checker-history-days"]) document.getElementById(id).removeAttribute("aria-invalid");
            if (parsed.error) {
                status.textContent = parsed.error;
                const input = document.getElementById(parsed.field);
                input.setAttribute("aria-invalid", "true");
                input.focus();
                return;
            }
            const rangeChanged = checkerSettings.analytics.historyDays !== parsed.value.historyDays;
            checkerSettings.analytics = parsed.value;
            saveCheckerSettings();
            renderCheckerDetails();
            if (rangeChanged && document.getElementById("checker-more-details").open) void refreshCheckerDetails(true);
        });
        document.getElementById("checker-more-details").addEventListener("toggle", event => {
            if (event.target.open) void refreshCheckerDetails(false);
        });
        document.getElementById("checker-details-refresh").addEventListener("click", () => void refreshCheckerDetails(true));
        document.getElementById("checker-open-analytics").addEventListener("click", () => {
            checkerSettings.visible.estimate = true;
            checkerSettings.visible.daily = true;
            saveCheckerSettings();
            document.getElementById("checker-more-details").open = true;
            void refreshCheckerDetails(false);
            const title = document.getElementById("checker-estimate-title");
            title.tabIndex = -1;
            title.focus({ preventScroll: true });
            title.scrollIntoView({ block: "center" });
        });
        applyCheckerSettings();
        syncCheckerAnalyticsInputs();
        renderCheckerDetails();
    }

    checkerThemeMedia.addEventListener("change", applyCheckerTheme);

    function checkerNumber(value) {
        return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
    }

    function checkerDate(value) {
        if (typeof value !== "string" || !value.trim()) return null;
        const date = new Date(value);
        return Number.isNaN(date.getTime()) ? null : date.toLocaleString();
    }

    function parseCheckerSubscription(data, accountId) {
        let entry;
        if (data?.accounts && typeof data.accounts === "object" && !Array.isArray(data.accounts)) {
            const entries = Object.entries(data.accounts).filter(([, value]) => value?.account);
            entry = accountId ? entries.find(([key, value]) => key === accountId || value.account.account_id === accountId || value.account.id === accountId)?.[1]
                : entries.length === 1 ? entries[0][1] : null;
            if (!entry && entries.length) return { message: "暂未确认当前工作区，请在切换工作区后刷新详情。", rows: [] };
        } else if (data?.account && data?.entitlement) {
            const id = data.account.account_id ?? data.account.id;
            if (accountId && id && id !== accountId) return { message: "响应属于其他工作区，请刷新详情。", rows: [] };
            entry = data;
        }
        const rows = [];
        const account = entry?.account;
        const entitlement = entry?.entitlement;
        const add = (label, value) => { if (typeof value === "string" && value.trim()) rows.push([label, value]); };
        add("套餐", entitlement?.subscription_plan);
        add("账户类型", account?.plan_type);
        if (typeof entitlement?.has_active_subscription === "boolean") rows.push(["付费订阅", entitlement.has_active_subscription ? "有效" : "未启用"]);
        add("计费周期", entitlement?.billing_period);
        add("币种", entitlement?.billing_currency);
        for (const [field, label] of [["renews_at", "续订时间"], ["cancels_at", "取消生效"], ["expires_at", "到期时间"]]) {
            add(label, checkerDate(entitlement?.[field]));
        }
        return { rows };
    }

    function parseCheckerStorage(data) {
        const allowed = checkerNumber(data?.allowed_bytes);
        const remaining = checkerNumber(data?.remaining_bytes);
        const reportedUsed = checkerNumber(data?.used_bytes);
        const used = reportedUsed ?? (allowed !== null && remaining !== null && remaining <= allowed ? allowed - remaining : null);
        return { allowed, remaining, used, overLimit: typeof data?.is_over_limit === "boolean" ? data.is_over_limit : null };
    }

    function parseCheckerDaily(data) {
        if (!Array.isArray(data?.data)) return null;
        const days = new Map();
        for (const row of data.data) {
            if (typeof row?.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(row.date)) return null;
            if (days.has(row.date)) return null; // Do not double-count an unexpected grouping.
            days.set(row.date, { date: row.date, credits: checkerNumber(row.totals?.credits), turns: checkerNumber(row.totals?.turns) });
        }
        if (data.data.length && !days.size) return null;
        return [...days.values()].sort((a, b) => b.date.localeCompare(a.date));
    }

    function parseCheckerQuotaUsage(data, receivedAt = Date.now()) {
        // Never substitute a five-hour limit or a separate Spark window for the weekly code limit.
        const window = [data?.rate_limit?.secondary_window, data?.rate_limit?.primary_window]
            .find(value => value?.limit_window_seconds === 604800);
        if (!window) return null;
        const resetAt = checkerNumber(window.reset_at)
            ?? (checkerNumber(window.reset_after_seconds) === null ? null : receivedAt / 1000 + window.reset_after_seconds);
        return {
            usedPercent: checkerNumber(window.used_percent),
            resetAt: resetAt === null ? null : resetAt * 1000,
            startAt: resetAt === null ? null : (resetAt - 604800) * 1000,
        };
    }

    function evaluateCheckerQuotaEstimate(quota, daily, now = Date.now()) {
        const unavailable = (kind, message) => ({ kind, message, total: null, remaining: null });
        if (quota?.status === "loading" || daily?.status === "loading") return unavailable("loading", "正在读取周限额和每日积分…");
        if (quota?.status === "error" || daily?.status === "error") {
            const failed = [quota?.status === "error" ? `周限额：${quota.error}` : "", daily?.status === "error" ? `每日积分：${daily.error}` : ""].filter(Boolean);
            return unavailable("error", `读取失败（${failed.join("；")}），请刷新详情。`);
        }
        if (quota?.status !== "ready" || daily?.status !== "ready") return unavailable("idle", "展开详情后读取周限额和每日积分。");
        const window = quota.value;
        if (!window) return unavailable("unavailable", "接口未返回可识别的代码每周限额，暂不估算。");
        const { usedPercent, startAt, resetAt } = window;
        if (checkerNumber(usedPercent) === null || usedPercent > 100) return unavailable("unavailable", "每周已用比例缺失或无效，暂不估算。");
        if (usedPercent === 0) return unavailable("unavailable", "每周已用为 0%，暂时无法反推总额。");
        if (!Number.isFinite(startAt) || !Number.isFinite(resetAt) || !Number.isFinite(new Date(startAt).getTime())
            || !Number.isFinite(new Date(resetAt).getTime()) || startAt > now || resetAt <= now) {
            return unavailable("unavailable", "周期时间缺失或已跨过重置点，请刷新详情。");
        }
        if (!Array.isArray(daily.value)) return unavailable("unavailable", "接口未提供可识别的每日积分。");
        const today = new Date(now).toISOString().slice(0, 10);
        const startDate = new Date(startAt).toISOString().slice(0, 10);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(daily.range?.start) || !/^\d{4}-\d{2}-\d{2}$/.test(daily.range?.end)
            || daily.range.start > startDate || daily.range.end <= today) {
            return unavailable("unavailable", "每日统计范围未确认覆盖本周期，请刷新详情。");
        }
        if (!Number.isFinite(quota.updated) || !Number.isFinite(daily.updated) || Math.abs(quota.updated - daily.updated) > 60000) {
            return unavailable("delayed", "两份数据的读取时间相差超过 1 分钟，请刷新详情后估算。");
        }
        const rows = daily.value.filter(row => row.date >= startDate && row.date <= today);
        const todayRow = rows.find(row => row.date === today);
        if (!todayRow || todayRow.credits === null || todayRow.credits <= 0) {
            return unavailable("delayed", "今日积分尚未返回或仍为 0，等待统计更新后再估算。");
        }
        if (rows.some(row => checkerNumber(row.credits) === null)) return unavailable("unavailable", "周期内有记录缺少有效积分，暂不估算。");
        const cycleCredits = rows.reduce((sum, row) => sum + row.credits, 0);
        const total = cycleCredits / (usedPercent / 100);
        if (!Number.isFinite(total)) return unavailable("unavailable", "积分或比例超出可计算范围，暂不估算。");
        return {
            kind: "provisional", total, remaining: Math.max(0, total - cycleCredits),
            cycleCredits, usedPercent, startAt, resetAt,
            boundaryPartial: startAt % 86400000 !== 0,
            message: "暂估值：每日积分可能延迟，已用百分比可能取整。",
        };
    }

    function checkerDetailEnabled(key) {
        if (key === "quota") return checkerSettings.visible.estimate || checkerSettings.visible.daily;
        if (key === "daily") return checkerSettings.visible.daily || checkerSettings.visible.estimate;
        return checkerSettings.visible[key];
    }

    function checkerRequestKind(url) {
        const path = url.pathname;
        if (/^\/backend-api\/accounts\/(check\/v4-2023-04-27|optimized\/check)$/.test(path)) return "subscription";
        if (path === "/backend-api/files/library/storage/usage") return "storage";
        if (path === "/backend-api/wham/analytics/daily-workspace-usage-counts" && url.searchParams.get("group_by") === "day" && !url.searchParams.has("workspace_user")) return "daily";
        if (path === "/backend-api/me") return "account";
        if (path.startsWith("/backend-api/checkout_pricing_config/configs")) return "pricing";
        if (path.endsWith("/sentinel/chat-requirements/prepare")) return "pow";
        if (path === "/backend-api/models") return "models";
        if (path === "/backend-api/conversation/init") return "limits";
        if (path === "/backend-api/memories") return "memory";
        if (path === "/backend-api/wham/usage") return "quota";
        if (path === "/backend-api/settings/is_adult") return "age";
        return null;
    }

    function captureCheckerRequest(resource, options = {}) {
        if (isGrokMode) return null;
        try {
            const url = new URL(typeof resource === "string" ? resource : resource?.url || String(resource), pageWindow.location.href);
            if (url.origin !== pageWindow.location.origin || !url.pathname.startsWith("/backend-api/")) return null;
            // Observe only scope headers; never inspect a request body or retain authorization.
            const accountId = new Headers(options.headers ?? resource?.headers).get("chatgpt-account-id");
            if (accountId && accountId !== checkerAccountId) {
                checkerAccountId = accountId;
                checkerAccountEpoch++;
                checkerFreshness.clear();
                for (const state of Object.values(checkerDetails)) Object.assign(state, { status: "idle", value: null, updated: null, error: null, sequence: 0 });
                renderCheckerDetails();
            }
            const kind = checkerRequestKind(url);
            return kind ? { kind, epoch: checkerAccountEpoch, sequence: ++checkerRequestSequence,
                range: kind === "daily" ? { start: url.searchParams.get("start_date"), end: url.searchParams.get("end_date") } : null } : null;
        } catch {
            return null;
        }
    }

    async function observeCheckerResponse(request, response) {
        if (!request || request.epoch !== checkerAccountEpoch) return;
        const state = checkerDetails[request.kind];
        if (state && request.sequence < state.sequence) return;
        if (state) state.sequence = request.sequence;
        try {
            if (!response?.ok) throw new Error(response ? `HTTP ${response.status}` : "网络连接失败");
            const data = await response.clone().json();
            if (request.epoch !== checkerAccountEpoch || (state && request.sequence !== state.sequence)) return;
            if (state) {
                state.value = request.kind === "subscription" ? parseCheckerSubscription(data, checkerAccountId)
                    : request.kind === "storage" ? parseCheckerStorage(data)
                    : request.kind === "quota" ? parseCheckerQuotaUsage(data) : parseCheckerDaily(data);
                state.range = request.range ?? null;
                state.status = "ready";
                state.error = null;
                state.updated = Date.now();
            }
            checkerFreshness.set(request.kind, { updated: Date.now(), error: null });
            if (request.refreshUI && request.kind === "quota") {
                updateCodexInfo(getCodexUsageWindows(data));
                updateCodexCredits(data?.credits);
                updateCodexResetCredits(data?.rate_limit_reset_credits);
            }
        } catch (error) {
            if (request.epoch !== checkerAccountEpoch || (state && request.sequence !== state.sequence)) return;
            const message = /^HTTP \d+$/.test(error?.message) ? error.message : response?.ok ? "响应无法解析" : "网络连接失败";
            if (state) { state.status = "error"; state.error = message; }
            checkerFreshness.set(request.kind, { updated: checkerFreshness.get(request.kind)?.updated ?? null, error: message });
        }
        renderCheckerDetails();
    }

    function getCheckerAccessToken() {
        try {
            const bootstrap = JSON.parse(document.getElementById("client-bootstrap")?.textContent || "null");
            const token = bootstrap?.session?.accessToken ?? pageWindow.CLIENT_BOOTSTRAP?.session?.accessToken;
            return typeof token === "string" && token ? token : null;
        } catch {
            return null;
        }
    }

    async function refreshCheckerDetails(force) {
        if (isGrokMode) return;
        const requestedHistoryDays = checkerSettings.analytics.historyDays;
        const token = getCheckerAccessToken();
        const end = new Date();
        const start = new Date(end);
        // A weekly cycle can touch eight UTC dates; keep it covered even with a shorter history preference.
        start.setUTCDate(start.getUTCDate() - Math.max(8, checkerSettings.analytics.historyDays) + 1);
        end.setUTCDate(end.getUTCDate() + 1);
        const query = new URLSearchParams({ start_date: start.toISOString().slice(0, 10), end_date: end.toISOString().slice(0, 10), group_by: "day" });
        const paths = {
            subscription: `/backend-api/accounts/check/v4-2023-04-27?timezone_offset_min=${new Date().getTimezoneOffset()}`,
            storage: "/backend-api/files/library/storage/usage",
            daily: `/backend-api/wham/analytics/daily-workspace-usage-counts?${query}`,
            quota: "/backend-api/wham/usage",
        };
        const refreshEstimatePair = (checkerSettings.visible.estimate || checkerSettings.visible.daily)
            && (force || [checkerDetails.quota, checkerDetails.daily].some(state => state.status === "idle"));
        const tasks = Object.entries(checkerDetails).map(async ([key, state]) => {
            const forceThis = force || (refreshEstimatePair && ["quota", "daily"].includes(key));
            if (!checkerDetailEnabled(key) || state.status === "loading" || (!forceThis && state.status !== "idle")) return;
            if (!token) {
                state.status = "error";
                state.error = "暂未取得登录状态，请等页面加载后重试";
                return;
            }
            state.status = "loading";
            state.error = null;
            const headers = { Authorization: `Bearer ${token}` };
            if (checkerAccountId) headers["ChatGPT-Account-Id"] = checkerAccountId;
            const request = { kind: key, epoch: checkerAccountEpoch, sequence: ++checkerRequestSequence, refreshUI: true };
            if (key === "daily") request.range = { start: query.get("start_date"), end: query.get("end_date") };
            state.sequence = request.sequence;
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 20000);
            try {
                // Use the untouched fetch so a local fake-plan patch cannot alter real account data.
                const response = await originalFetch(paths[key], { method: "GET", credentials: "same-origin", headers, signal: controller.signal });
                await observeCheckerResponse(request, response);
            } catch {
                await observeCheckerResponse(request, null);
            } finally {
                clearTimeout(timeout);
            }
        });
        renderCheckerDetails();
        await Promise.all(tasks);
        renderCheckerDetails();
        if (requestedHistoryDays !== checkerSettings.analytics.historyDays && checkerDetailEnabled("daily")) void refreshCheckerDetails(true);
    }

    function checkerFormatNumber(value) {
        return value === null ? "未提供" : value.toLocaleString(undefined, { maximumFractionDigits: 2 });
    }

    function checkerFormatBytes(value) {
        if (value === null) return "未提供";
        const unit = value >= 1024 ** 3 ? 3 : value >= 1024 ** 2 ? 2 : value >= 1024 ? 1 : 0;
        return `${(value / 1024 ** unit).toLocaleString(undefined, { maximumFractionDigits: 2 })} ${["B", "KiB", "MiB", "GiB"][unit]}`;
    }

    function appendCheckerNote(parent, text, className = "checker-note") {
        const element = document.createElement("p");
        element.className = className;
        element.textContent = text;
        parent.appendChild(element);
    }

    function appendCheckerRows(parent, rows) {
        const list = document.createElement("dl");
        list.className = "checker-data-list";
        for (const [label, value] of rows) {
            const term = document.createElement("dt");
            const detail = document.createElement("dd");
            term.textContent = label;
            detail.textContent = value;
            list.append(term, detail);
        }
        parent.appendChild(list);
    }

    function summarizeCheckerUsage(rows, usdPer1000) {
        const sum = field => rows.length && rows.every(row => checkerNumber(row[field]) !== null)
            ? checkerNumber(rows.reduce((total, row) => total + row[field], 0)) : null;
        const credits = sum("credits");
        return {
            credits, turns: sum("turns"),
            usd: credits === null ? null : checkerNumber(credits * usdPer1000 / 1000),
            latestActivity: rows.filter(row => row.credits > 0 || row.turns > 0).map(row => row.date).sort().at(-1) || null,
        };
    }

    function getCheckerUsagePeriods(daily, quota, historyDays, now = Date.now()) {
        const today = new Date(now).toISOString().slice(0, 10);
        const since = new Date(now);
        since.setUTCDate(since.getUTCDate() - historyDays + 1);
        const sinceDate = since.toISOString().slice(0, 10);
        const rows = Array.isArray(daily.value) ? daily.value.filter(row => row.date <= today) : [];
        const recent = rows.filter(row => row.date >= sinceDate);
        const window = quota?.status === "ready" ? quota.value : null;
        const cycleKnown = !!window && Number.isFinite(window.startAt) && Number.isFinite(window.resetAt)
            && Number.isFinite(new Date(window.startAt).getTime()) && window.startAt <= now && now < window.resetAt;
        const startDate = cycleKnown ? new Date(window.startAt).toISOString().slice(0, 10) : null;
        return {
            today, recent, startDate,
            cycle: cycleKnown ? rows.filter(row => row.date >= startDate) : null,
            history: cycleKnown ? recent.filter(row => row.date < startDate) : null,
            rangeCovered: !!daily.range && daily.range.start <= sinceDate && daily.range.end > today,
        };
    }

    function formatCheckerCredits(value) {
        return checkerNumber(value) === null ? "未提供" : value.toLocaleString(undefined, { maximumFractionDigits: 3 });
    }

    function formatCheckerUsd(value) {
        return checkerNumber(value) === null ? "未提供" : value.toLocaleString(undefined, { style: "currency", currency: "USD" });
    }

    function appendCheckerUsageTable(parent, rows, title, today) {
        if (!rows.length) {
            appendCheckerNote(parent, "暂无返回记录，不代表用量为零。");
            return;
        }
        const table = document.createElement("table");
        table.className = "checker-daily-table checker-valuation-table";
        const caption = document.createElement("caption");
        caption.textContent = title;
        table.appendChild(caption);
        const head = table.createTHead().insertRow();
        for (const label of ["UTC 日期", "积分", "估值 USD", "轮次"]) {
            const th = document.createElement("th"); th.scope = "col"; th.textContent = label; head.appendChild(th);
        }
        const tbody = table.createTBody();
        for (const row of [...rows].sort((a, b) => b.date.localeCompare(a.date))) {
            const tr = tbody.insertRow();
            const values = [row.date, formatCheckerCredits(row.credits), formatCheckerUsd(row.credits === null ? null : row.credits * checkerSettings.analytics.usdPer1000 / 1000), checkerFormatNumber(row.turns)];
            for (const value of values) tr.insertCell().textContent = value;
            if (row.date === today) {
                const label = document.createElement("span");
                label.className = "checker-today-label";
                label.textContent = "今日 · 可能延迟";
                tr.cells[0].appendChild(label);
            }
        }
        const stats = summarizeCheckerUsage(rows, checkerSettings.analytics.usdPer1000);
        const footer = table.createTFoot().insertRow();
        for (const value of ["记录合计", formatCheckerCredits(stats.credits), formatCheckerUsd(stats.usd), checkerFormatNumber(stats.turns)]) footer.insertCell().textContent = value;
        parent.appendChild(table);
    }

    function renderCheckerDailyUsage(body, daily, openPeriods = []) {
        const { quota } = checkerDetails;
        const { historyDays, usdPer1000 } = checkerSettings.analytics;
        const periods = getCheckerUsagePeriods(daily, quota, historyDays);
        const todayRow = periods.recent.find(row => row.date === periods.today);
        if (todayRow) {
            const todayStats = summarizeCheckerUsage([todayRow], usdPer1000);
            appendCheckerRows(body, [["今日积分", formatCheckerCredits(todayStats.credits)], ["今日积分估值", formatCheckerUsd(todayStats.usd)], ["今日轮次", checkerFormatNumber(todayStats.turns)]]);
        } else appendCheckerNote(body, "今日尚无返回记录，不代表用量为零。");
        const latest = summarizeCheckerUsage(periods.recent, usdPer1000).latestActivity;
        appendCheckerNote(body, `最近有活动记录：${latest || "尚未提供"}`);
        appendCheckerNote(body, `历史范围：近 ${historyDays} 天（含今天）。估值按 ${formatCheckerUsd(usdPer1000)} / 1,000 积分换算，不是账单金额。`);
        if (!periods.rangeCovered) appendCheckerNote(body, "已载入数据尚未覆盖所选历史范围，请刷新详情。");
        const appendPeriod = (key, title, rows, caption) => {
            const details = document.createElement("details");
            details.dataset.checkerPeriod = key;
            details.open = openPeriods.includes(key);
            const summary = document.createElement("summary");
            summary.textContent = `${title}（${rows.length} 天记录）`;
            details.appendChild(summary);
            appendCheckerUsageTable(details, rows, caption, periods.today);
            body.appendChild(details);
        };
        if (periods.cycle !== null) {
            const stats = summarizeCheckerUsage(periods.cycle, usdPer1000);
            appendCheckerRows(body, [["周期已记积分", formatCheckerCredits(stats.credits)], ["周期积分估值", formatCheckerUsd(stats.usd)], ["周期轮次", checkerFormatNumber(stats.turns)]]);
            appendPeriod("cycle", "当前周期明细", periods.cycle, `周期开始日期：${periods.startDate} · 首日可能跨周期`);
            appendPeriod("history", "周期外历史", periods.history, `近 ${historyDays} 天内，周期开始日期之前的记录`);
        } else {
            appendCheckerNote(body, "尚未确认当前周周期，以下展示近期记录。");
            appendPeriod("recent", "近期记录", periods.recent, `近 ${historyDays} 天 · UTC 日期`);
        }
        appendCheckerNote(body, "工作区统计可能延迟；缺失日期不补零，缺失积分或轮次不当作 0。积分不是剩余额度。");
    }

    function renderCheckerQuotaEstimate() {
        const body = document.getElementById("checker-estimate-body");
        if (!body) return;
        const { quota, daily } = checkerDetails;
        const result = evaluateCheckerQuotaEstimate(quota, daily);
        const periods = getCheckerUsagePeriods(daily, quota, checkerSettings.analytics.historyDays);
        const stats = summarizeCheckerUsage(periods.cycle || [], checkerSettings.analytics.usdPer1000);
        const renderKey = JSON.stringify([result, stats, quota.updated, daily.updated, checkerSettings.analytics]);
        if (body.dataset.checkerRenderKey === renderKey) return;
        body.dataset.checkerRenderKey = renderKey;
        const explanationOpen = body.querySelector("details")?.open ?? false;
        body.replaceChildren();
        body.setAttribute("aria-busy", String(result.kind === "loading"));
        appendCheckerNote(body, result.message, result.kind === "error" ? "checker-note checker-error" : "checker-note");
        if (result.total !== null) {
            appendCheckerRows(body, [
                ["周期已记积分", checkerFormatNumber(result.cycleCredits)],
                ["周期轮次", checkerFormatNumber(stats.turns)],
                ["周期积分估值", formatCheckerUsd(stats.usd)],
                ["每周已用", `${checkerFormatNumber(result.usedPercent)}%`],
                ["估算周总额", `${checkerFormatNumber(result.total)} 积分`],
                ["周总额估值", formatCheckerUsd(result.total * checkerSettings.analytics.usdPer1000 / 1000)],
                ["估算剩余", `${checkerFormatNumber(result.remaining)} 积分`],
            ]);
            appendCheckerNote(body, `周期开始：${new Date(result.startAt).toLocaleString()}`);
            appendCheckerNote(body, `周期重置：${new Date(result.resetAt).toLocaleString()}`);
            if (result.boundaryPartial) appendCheckerNote(body, "周期在 UTC 日内重置，首日统计可能包含上一周期的积分。");
        }
        const explanation = document.createElement("details");
        explanation.open = explanationOpen;
        const summary = document.createElement("summary");
        summary.textContent = "计算依据";
        explanation.appendChild(summary);
        appendCheckerNote(explanation, "周总额 ≈ 本周期已记积分 ÷（每周已用百分比 ÷ 100）");
        appendCheckerNote(explanation, "剩余 ≈ 估算周总额 − 本周期已记积分");
        appendCheckerNote(explanation, `金额估值 = 积分 × ${formatCheckerUsd(checkerSettings.analytics.usdPer1000)} ÷ 1,000；单价来自设置，不是官方报价或账单。`);
        if (result.total !== null) appendCheckerNote(explanation,
            `${checkerFormatNumber(result.cycleCredits)} ÷ (${checkerFormatNumber(result.usedPercent)} ÷ 100) ≈ ${checkerFormatNumber(result.total)} 积分`);
        appendCheckerNote(explanation, "沿用 Codex Quota Compass 的估算方式，假设积分统计与代码周限额口径一致。未返回的日期不补零，不推算 Spark 等独立限额。");
        appendCheckerNote(explanation, "两份数据读取时间相差超过 1 分钟时暂停估算；同时读取也不保证服务端统计同步。");
        if (quota.updated) appendCheckerNote(explanation, `周限额读取：${new Date(quota.updated).toLocaleString()}`);
        if (daily.updated) appendCheckerNote(explanation, `每日积分读取：${new Date(daily.updated).toLocaleString()}`);
        if (stats.latestActivity) appendCheckerNote(explanation, `周期内最近活动：${stats.latestActivity}`);
        body.appendChild(explanation);
    }

    function renderCheckerDetails() {
        const root = document.getElementById("checker-more-details");
        if (!root) return;
        const addText = appendCheckerNote;
        const addRows = appendCheckerRows;
        for (const [key, state] of Object.entries(checkerDetails)) {
            if (key === "quota") continue;
            const body = document.getElementById(`checker-${key}-body`);
            const renderKey = JSON.stringify([checkerAccountEpoch, state.sequence, state.status, state.updated, state.error, key === "daily" ? [checkerSettings.analytics, checkerDetails.quota.sequence, checkerDetails.quota.status, Date.now() < checkerDetails.quota.value?.resetAt, new Date().toISOString().slice(0, 10)] : null]);
            if (body.dataset.checkerRenderKey === renderKey) continue;
            body.dataset.checkerRenderKey = renderKey;
            const periodState = body.checkerOpenPeriods || (body.checkerOpenPeriods = {});
            for (const element of body.querySelectorAll("details[data-checker-period]")) periodState[element.dataset.checkerPeriod] = element.open;
            const openPeriods = Object.keys(periodState).filter(key => periodState[key]);
            body.replaceChildren();
            body.setAttribute("aria-busy", String(state.status === "loading"));
            if (state.status === "idle") addText(body, "未读取，展开详情后加载。");
            if (state.status === "loading") addText(body, "正在读取…");
            if (state.status === "error") addText(body, `读取失败 · ${state.error}。可点“刷新详情”重试。`, "checker-note checker-error");
            if (state.value !== null) {
                if (key === "subscription") {
                    if (state.value.rows.length) addRows(body, state.value.rows);
                    else addText(body, state.value.message || "接口未提供订阅字段。");
                } else if (key === "storage") {
                    const { used, allowed, remaining, overLimit } = state.value;
                    if ([used, allowed, remaining].every(value => value === null) && overLimit === null) addText(body, "接口未提供容量字段。");
                    else {
                        addRows(body, [["已用", checkerFormatBytes(used)], ["容量上限", checkerFormatBytes(allowed)], ["剩余", checkerFormatBytes(remaining)]]);
                        if (allowed > 0 && used !== null) {
                            const bar = document.createElement("progress");
                            bar.max = allowed;
                            bar.value = Math.min(used, allowed);
                            bar.setAttribute("aria-label", "文件库已用容量");
                            body.appendChild(bar);
                        }
                        if (overLimit === true) addText(body, "容量已超限", "checker-note checker-error");
                    }
                } else {
                    renderCheckerDailyUsage(body, state, openPeriods);
                }
            } else if (state.status === "ready") addText(body, "接口未提供可识别的数据。");
            if (state.updated) addText(body, `${state.status === "error" || state.status === "loading" ? "保留上次结果 · " : "更新于 "}${new Date(state.updated).toLocaleString()}`);
        }
        renderCheckerQuotaEstimate();
        const freshness = document.getElementById("checker-freshness-body");
        const freshnessKey = JSON.stringify([...checkerFreshness]);
        if (freshness.dataset.checkerRenderKey !== freshnessKey) {
            freshness.dataset.checkerRenderKey = freshnessKey;
            freshness.replaceChildren();
            if (!checkerFreshness.size) addText(freshness, "尚未读取数据。打开对应的网页功能后，会记录接收时间。");
            else addRows(freshness, [...checkerFreshness].map(([key, value]) => [CHECKER_DATA_LABELS[key], `${value.updated ? new Date(value.updated).toLocaleTimeString() : "未成功读取"}${value.error ? ` · ${value.error}` : ""}`]));
        }
        const refresh = document.getElementById("checker-details-refresh");
        const pending = Object.entries(checkerDetails).some(([key, state]) => checkerDetailEnabled(key) && state.status === "loading");
        refresh.disabled = pending || !Object.keys(checkerDetails).some(checkerDetailEnabled);
        refresh.textContent = pending ? "正在读取…" : "刷新详情";
    }

    const CHATGPT_FAKE_PLAN_KEY = "checker-next-chatgpt-fake-plan";
    const CHATGPT_FAKE_PLAN_ENABLED_KEY =
        "checker-next-chatgpt-fake-plan-enabled";
    const CHATGPT_IMPORT_MAP_CACHE_KEY =
        "checker-next-chatgpt-import-map-cache";
    const CHATGPT_MODULE_INJECTION_ENABLED_KEY =
        "checker-next-chatgpt-module-injection-enabled";
    const CHATGPT_COPY_BUTTON_ENABLED_KEY =
        "checker-next-chatgpt-copy-button-enabled";
    const CHATGPT_SELECTION_POPOVER_DISABLED_KEY =
        "checker-next-chatgpt-selection-popover-disabled";
    const CHATGPT_RUNTIME_MODEL_STATE_EVENT =
        "checker-next-runtime-model-state";
    const CHATGPT_RUNTIME_MODEL_REQUEST_EVENT =
        "checker-next-runtime-model-request";
    const CHATGPT_RUNTIME_MODEL_SET_EVENT = "checker-next-runtime-model-set";
    const CHATGPT_RUNTIME_CUSTOM_VALUE = "__checker_next_custom__";

    let chatgptModuleInjectionEnabled =
        isChatgptMode &&
        localStorage.getItem(CHATGPT_MODULE_INJECTION_ENABLED_KEY) !== "false";
    let chatgptCopyButtonEnabled =
        isChatgptMode &&
        localStorage.getItem(CHATGPT_COPY_BUTTON_ENABLED_KEY) !== "false";
    let chatgptSelectionPopoverDisabled =
        isChatgptMode &&
        localStorage.getItem(CHATGPT_SELECTION_POPOVER_DISABLED_KEY) === "true";
    let chatgptSelectionPopoverStyle;
    let userRegionValue = null;
    let priceRegionCode = null;
    let chatgptRuntimeModelState;
    let chatgptFakePlanCatalog;
    let chatgptCopyIcons;
    let chatgptImportMapInserted = false;
    let chatgptImportPatchNeedsReload = false;
    let chatgptInstalledPatchSettings;
    let chatgptPendingPatchSettings;
    let chatgptImportPatchTargets;
    let chatgptImportPatchFailure;
    let chatgptImportMapObserver;
    let chatgptNativeBridge;
    const chatgptReportedFailures = new Set();
    const chatgptRuntimeModelCatalogs = {
        chat: [],
        work: [],
    };

    if (isChatgptMode) {
        // Native exported functions work even when HTTP/module preloads have
        // already resolved the original modules. Keep rewriting opt-in only.
        if (localStorage.getItem(CHATGPT_FAKE_PLAN_ENABLED_KEY) === "true") {
            installCachedChatgptImportMapPatch();
        }
        chatgptSelectionPopoverStyle = GM_addElement("style", {
            media: chatgptSelectionPopoverDisabled ? "all" : "not all",
            textContent:
                '[aria-live="polite"][popover="manual"][style*="position-anchor: --targeted-action-selection"] { display: none !important; }',
        });
    }
    const NOT_STARTED_BADGE = '<span style="color:var(--checker-muted)"> (未开始)</span>';

    let grokActiveSubscriptions = null;
    let grokXSubscriptionType = null;
    let grokCountryCode = null;
    let grokUserInfoFetched = false;

    let grokAvailableModels = null;
    let grokModelsFetched = false;
    let grokModeTitles = new Map();
    let grokRateLimitData;
    let grokRateLimitModelName;
    let grokStorageUsageData;
    let grokAutomationsCount;

    let grokModelConfigOverrideValue;
    let grokXaiEmployeeValue;
    let grokCanUseDebugToolsValue;

    let grokEarlyAccessDisplayValue;
    let grokAsyncChatDisplayValue;
    const grokMemberships = [
        [
            "isSuperGrokLiteUser",
            "grok-super-grok-lite",
            "SuperGrok Lite",
            "checker-next-grok-super-grok-lite",
        ],
        [
            "isSuperGrokUser",
            "grok-super-grok",
            "SuperGrok",
            "checker-next-grok-super-grok",
        ],
        [
            "isSuperGrokPlusUser",
            "grok-super-grok-plus",
            "SuperGrok Plus",
            "checker-next-grok-super-grok-plus",
        ],
        [
            "isSuperGrokProUser",
            "grok-super-grok-pro",
            "SuperGrok Pro",
            "checker-next-grok-super-grok-pro",
        ],
        [
            "isEnterpriseUser",
            "grok-enterprise",
            "Enterprise",
            "checker-next-grok-enterprise",
        ],
        [
            "isXPremiumUser",
            "grok-x-premium",
            "X Premium",
            "checker-next-grok-x-premium",
        ],
    ].map(([field, id, label, storageKey]) => ({
        field,
        id,
        label,
        storageKey,
        enabled: isGrokMode && localStorage.getItem(storageKey) === "true",
    }));
    const grokMembershipValues = new Map();

    if (isGrokMode) {
        pageWindow.__next_f = pageWindow.__next_f || [];
        const originalPush = pageWindow.__next_f.push;
        pageWindow.__next_f.push = function (...args) {
            try {
                if (args[0] && typeof args[0][1] === "string") {
                    let dataString = args[0][1];
                    const sessionUserPattern =
                        /("user":\{"sessionId":"[^"]*","userId":"[^"]*","email":")([^"]*)("[\s\S]*?"canUseDebugTools":)(true|false)/;
                    const sessionUserMatch =
                        dataString.match(sessionUserPattern);
                    if (sessionUserMatch) {
                        const originalEmail = sessionUserMatch[2];
                        const atIndex = originalEmail.lastIndexOf("@");
                        const internalEmail = grokDevToolsEnabled
                            ? `${atIndex > 0 ? originalEmail.slice(0, atIndex) : originalEmail || "checker-next"}@x.ai`
                            : originalEmail;
                        const canUseDebugTools =
                            grokDevToolsEnabled ||
                            sessionUserMatch[4] === "true";
                        dataString = dataString.replace(
                            sessionUserPattern,
                            (_match, prefix, _email, suffix) =>
                                `${prefix}${internalEmail}${suffix}${canUseDebugTools}`,
                        );
                        args[0][1] = dataString;
                        const lowerEmail = internalEmail.toLowerCase();
                        grokXaiEmployeeValue =
                            lowerEmail.endsWith("@x.ai") ||
                            lowerEmail.endsWith("@teachx.ai");
                        grokCanUseDebugToolsValue = canUseDebugTools;
                        updateGrokDevToolsStatus();
                    }

                    for (const membership of grokMemberships) {
                        if (membership.enabled) {
                            dataString = dataString.replace(
                                new RegExp(`"${membership.field}":false`, "g"),
                                `"${membership.field}":true`,
                            );
                            if (membership.field === "isXPremiumUser") {
                                dataString = dataString
                                    .replace(
                                        /"xSubscriptionType"\s*:\s*(?:"[^"]*"|null)/g,
                                        '"xSubscriptionType":"Premium"',
                                    )
                                    .replace(
                                        /"effectiveXSubscriptionType"\s*:\s*(?:"[^"]*"|null)/g,
                                        '"effectiveXSubscriptionType":"Premium"',
                                    );
                            }
                            args[0][1] = dataString;
                        }

                        const valueMatch =
                            membership.field === "isXPremiumUser"
                                ? dataString.match(
                                      /"xSubscriptionType"\s*:\s*"([^"]*)"/,
                                  )
                                : dataString.match(
                                      new RegExp(
                                          `"${membership.field}":(true|false)`,
                                      ),
                                  );
                        if (valueMatch) {
                            const value =
                                membership.field === "isXPremiumUser"
                                    ? valueMatch[1] === "Premium"
                                    : valueMatch[1] === "true";
                            grokMembershipValues.set(membership.field, value);
                            updateBooleanStatus(
                                `${membership.id}-status`,
                                value,
                            );
                        }
                    }

                    if (!grokUserInfoFetched) {
                        const activeSubsMatch = dataString.match(
                            /"activeSubscriptions"\s*:\s*\[([^\]]*)\]/,
                        );
                        if (activeSubsMatch) {
                            try {
                                const subsArray = JSON.parse(
                                    `[${activeSubsMatch[1]}]`,
                                );
                                grokActiveSubscriptions = subsArray;
                            } catch (e) {
                                console.error(
                                    "[CheckerNext] 解析 Grok activeSubscriptions 出错:",
                                    e,
                                );
                                const stringsMatch =
                                    activeSubsMatch[1].match(/"([^"]+)"/g);
                                if (stringsMatch) {
                                    grokActiveSubscriptions = stringsMatch.map(
                                        (s) => s.replace(/"/g, ""),
                                    );
                                }
                            }
                        }

                        const subTypeMatch = dataString.match(
                            /"xSubscriptionType"\s*:\s*"([^"]*)"/,
                        );
                        if (subTypeMatch) {
                            grokXSubscriptionType = subTypeMatch[1];
                        }

                        const countryMatch = dataString.match(
                            /"countryCode"\s*:\s*"([^"]*)"/,
                        );
                        if (countryMatch) {
                            grokCountryCode = countryMatch[1];
                        }

                        if (grokXSubscriptionType && grokCountryCode) {
                            grokUserInfoFetched = true;
                            console.log(
                                "[CheckerNext] Parsed Grok user info:",
                                grokActiveSubscriptions,
                                grokXSubscriptionType,
                                grokCountryCode,
                            );
                            updateGrokUserInfo();
                        }
                    }

                    if (
                        grokEarlyAccessEnabled &&
                        dataString.indexOf(
                            '"enableEarlyAccessModels":false',
                        ) !== -1
                    ) {
                        dataString = dataString.replace(
                            /"enableEarlyAccessModels":false/g,
                            '"enableEarlyAccessModels":true',
                        );
                        args[0][1] = dataString;
                        console.log(
                            "[CheckerNext] 已替换 enableEarlyAccessModels 为 true",
                        );
                    }
                    const earlyAccessMatch = dataString.match(
                        /"enableEarlyAccessModels":(true|false)/,
                    );
                    if (earlyAccessMatch) {
                        grokEarlyAccessDisplayValue =
                            earlyAccessMatch[1] === "true";
                        updateBooleanStatus(
                            "grok-early-access-status",
                            grokEarlyAccessDisplayValue,
                        );
                    }

                    if (
                        grokAsyncChatEnabled &&
                        dataString.indexOf('"isAsyncChat":false') !== -1
                    ) {
                        dataString = dataString.replace(
                            /"isAsyncChat":false/g,
                            '"isAsyncChat":true',
                        );
                        args[0][1] = dataString;
                        console.log("[CheckerNext] 已替换 isAsyncChat 为 true");
                    }
                    const asyncChatMatch = dataString.match(
                        /"isAsyncChat":(true|false)/,
                    );
                    if (asyncChatMatch) {
                        grokAsyncChatDisplayValue =
                            asyncChatMatch[1] === "true";
                        updateBooleanStatus(
                            "grok-async-chat-status",
                            grokAsyncChatDisplayValue,
                        );
                    }
                }
            } catch (e) {
                console.error("[CheckerNext] 处理 Grok RSC 数据出错:", e);
            }
            return originalPush.apply(pageWindow.__next_f, args);
        };
    }

    const GROK_DEV_TOOLS_KEY = "checker-next-grok-dev-tools";
    let grokDevToolsEnabled =
        isGrokMode && localStorage.getItem(GROK_DEV_TOOLS_KEY) === "true";

    const GROK_ALL_MODELS_KEY = "checker-next-grok-all-models";
    let grokAllModelsEnabled =
        isGrokMode && localStorage.getItem(GROK_ALL_MODELS_KEY) === "true";

    const GROK_EARLY_ACCESS_KEY = "checker-next-grok-early-access";
    let grokEarlyAccessEnabled =
        isGrokMode && localStorage.getItem(GROK_EARLY_ACCESS_KEY) === "true";

    const GROK_ASYNC_CHAT_KEY = "checker-next-grok-async-chat";
    let grokAsyncChatEnabled =
        isGrokMode && localStorage.getItem(GROK_ASYNC_CHAT_KEY) === "true";

    const CHATGPT_AGE_VERIFICATION_SETTING_KEY =
        "checker-next-chatgpt-age-verification-setting";
    let chatgptAgeVerificationSettingEnabled =
        isChatgptMode &&
        localStorage.getItem(CHATGPT_AGE_VERIFICATION_SETTING_KEY) === "true";

    function rewriteModuleImports(sourceText, assetUrl, assetBaseUrl) {
        let patched = sourceText;
        patched = patched.replaceAll(
            "import.meta.url",
            JSON.stringify(assetUrl),
        );
        patched = patched.replaceAll('from"./', `from"${assetBaseUrl}/`);
        patched = patched.replaceAll("from'./", `from'${assetBaseUrl}/`);
        patched = patched.replaceAll('import"./', `import"${assetBaseUrl}/`);
        patched = patched.replaceAll("import'./", `import'${assetBaseUrl}/`);
        patched = patched.replaceAll('import("./', `import("${assetBaseUrl}/`);
        patched = patched.replaceAll("import('./", `import('${assetBaseUrl}/`);
        patched = patched.replaceAll("import(`./", `import(\`${assetBaseUrl}/`);

        const normalizedBase = assetBaseUrl.endsWith("/")
            ? assetBaseUrl
            : `${assetBaseUrl}/`;
        const normalizedAssetBase = assetBaseUrl.endsWith("/")
            ? assetBaseUrl.slice(0, -1)
            : assetBaseUrl;
        patched = patched.replaceAll(
            'from"assets/',
            `from"${normalizedAssetBase}/assets/`,
        );
        patched = patched.replaceAll(
            "from'assets/",
            `from'${normalizedAssetBase}/assets/`,
        );
        patched = patched.replaceAll(
            'import"assets/',
            `import"${normalizedAssetBase}/assets/`,
        );
        patched = patched.replaceAll(
            "import'assets/",
            `import'${normalizedAssetBase}/assets/`,
        );
        patched = patched.replaceAll(
            'import("assets/',
            `import("${normalizedAssetBase}/assets/`,
        );
        patched = patched.replaceAll(
            "import('assets/",
            `import('${normalizedAssetBase}/assets/`,
        );
        patched = patched.replaceAll(
            'new URL("assets/',
            `new URL("${normalizedBase}assets/`,
        );
        patched = patched.replaceAll(
            "new URL('assets/",
            `new URL('${normalizedBase}assets/`,
        );
        return patched;
    }

    function extractChatgptFakePlanCatalog(sourceText) {
        const enumPattern =
            /([A-Za-z$_][\w$]*)=function\(([A-Za-z$_][\w$]*)\)\{return ((?:\2\.[A-Z][A-Z0-9_]*=`[^`]*`,)+)\2\}\(\{\}\)/g;
        const enums = [...sourceText.matchAll(enumPattern)].map((match) => ({
            name: match[1],
            entries: [
                ...match[3].matchAll(
                    /[A-Za-z$_][\w$]*\.([A-Z][A-Z0-9_]*)=`([^`]*)`/g,
                ),
            ].map((entry) => [entry[1], entry[2]]),
        }));
        const planSymbols = new Set(
            [
                ...sourceText.matchAll(
                    /is[A-Za-z$_][\w$]*\(\)\{return this\.data\.subscriptionStatus\.planType===([A-Za-z$_][\w$]*)\.[A-Z][A-Z0-9_]*\}/g,
                ),
            ].map((match) => match[1]),
        );
        const planEnumIndexes = enums.flatMap(({ name }, index) =>
            planSymbols.has(name) ? [index] : [],
        );
        if (planEnumIndexes.length !== 1 || planEnumIndexes[0] === 0) {
            return null;
        }

        const planTypes = enums[planEnumIndexes[0]].entries.map(
            ([planKey, planType]) => ({ planKey, planType }),
        );
        const subscriptions = enums[planEnumIndexes[0] - 1].entries;
        const options = subscriptions.flatMap(
            ([subscriptionKey, subscriptionPlan]) => {
                const plan = planTypes
                    .filter(
                        ({ planKey }) =>
                            subscriptionKey === planKey ||
                            subscriptionKey.startsWith(`${planKey}_`),
                    )
                    .sort(
                        (left, right) =>
                            right.planKey.length - left.planKey.length,
                    )[0];
                return plan
                    ? [{ subscriptionKey, subscriptionPlan, ...plan }]
                    : [];
            },
        );
        return options.length === subscriptions.length
            ? { options, planTypes }
            : null;
    }

    function findChatgptFakePlan(catalog, value) {
        const subscription = catalog?.options.find(
            ({ subscriptionPlan }) => subscriptionPlan === value,
        );
        if (subscription) return subscription;

        const plan = catalog?.planTypes.find(
            ({ planType }) => planType === value,
        );
        if (!plan) return undefined;
        return catalog.options
            .filter(
                ({ planKey }) =>
                    plan.planKey === planKey ||
                    plan.planKey.startsWith(`${planKey}_`),
            )
            .sort(
                (left, right) =>
                    right.planKey.length - left.planKey.length ||
                    left.subscriptionKey.length - right.subscriptionKey.length,
            )[0];
    }

    function patchChatgptFakePlanAssetSource(sourceText) {
        const target = findChatgptFakePlan(
            extractChatgptFakePlanCatalog(sourceText),
            chatgptFakePlanValue,
        );
        if (!target) return null;

        const { planType: targetPlanType, subscriptionPlan } = target;
        const hasPaid =
            targetPlanType !== "guest" &&
            targetPlanType !== "free" &&
            targetPlanType !== "free_workspace";

        const planTypePattern =
            /planType:\s*[A-Za-z$_][\w$]*\.account\.plan_type\?\?[A-Za-z$_][\w$]*/;
        const hasPaidSubscriptionPattern =
            /hasPaidSubscription:\s*[A-Za-z$_][\w$]*\.entitlement\.has_active_subscription\?\?!1/;
        const subscriptionPlanPattern =
            /subscriptionPlan:\s*[A-Za-z$_][\w$]*\.entitlement\.subscription_plan\?\?void 0/;
        const lightAccountPlanTypePattern =
            /return this\.data\.lightAccount\.planType/;
        const sessionAccountPattern =
            /authStatus===[A-Za-z$_][\w$]*\.LoggedIn\)\{let [A-Za-z$_][\w$]*=([A-Za-z$_][\w$]*)\.user,([A-Za-z$_][\w$]*)=\1\.session\?\.account;/;
        const requiredPatterns = [
            planTypePattern,
            hasPaidSubscriptionPattern,
            subscriptionPlanPattern,
            lightAccountPlanTypePattern,
            sessionAccountPattern,
        ];
        if (
            requiredPatterns.some(
                (pattern) =>
                    [...sourceText.matchAll(new RegExp(pattern.source, "g"))]
                        .length !== 1,
            )
        ) {
            return null;
        }

        let patched = sourceText;

        patched = patched.replace(
            planTypePattern,
            `planType:"${targetPlanType}"`,
        );

        patched = patched.replace(
            hasPaidSubscriptionPattern,
            `hasPaidSubscription:${hasPaid ? "!0" : "!1"}`,
        );

        patched = patched.replace(
            subscriptionPlanPattern,
            `subscriptionPlan:"${subscriptionPlan}"`,
        );

        patched = patched.replace(
            lightAccountPlanTypePattern,
            `return "${targetPlanType}"`,
        );

        patched = patched.replace(
            sessionAccountPattern,
            (match, _sessionVariable, accountVariable) =>
                `${match}${accountVariable}&&(${accountVariable}.planType="${targetPlanType}");`,
        );

        return patched;
    }

    function injectImportMap(importMapJson) {
        const withNonce = document.querySelector("script[nonce], link[nonce]");
        const nonce =
            document.currentScript?.nonce ||
            withNonce?.nonce ||
            withNonce?.getAttribute("nonce");
        if (!nonce || !document.head) return null;

        const script = document.createElement("script");
        script.type = "importmap";
        script.nonce = nonce;
        script.textContent = JSON.stringify(importMapJson);
        document.head.insertBefore(script, document.head.firstChild);
        return script;
    }

    // Bootstrap data is no longer guaranteed to contain pageLoadResourceHrefs.
    // Only accept the page's own asset directory; never fetch arbitrary URLs
    // from bootstrap data, DOM attributes, or a stale userscript cache.
    function collectChatgptAssetUrls() {
        const candidates = [];
        try {
            const bootstrapText = document.getElementById("client-bootstrap")?.textContent;
            const bootstrap = bootstrapText ? JSON.parse(bootstrapText) : pageWindow.CLIENT_BOOTSTRAP;
            if (Array.isArray(bootstrap?.pageLoadResourceHrefs)) {
                candidates.push(...bootstrap.pageLoadResourceHrefs);
            }
        } catch {
            // A changed/malformed bootstrap must not hide valid preload links.
        }
        for (const element of document.querySelectorAll(
            'link[rel="modulepreload"][href], script[type="module"][src]',
        )) {
            candidates.push(element.href || element.src);
        }
        for (const entry of pageWindow.performance?.getEntriesByType("resource") || []) {
            candidates.push(entry.name);
        }
        const urls = new Set();
        for (const candidate of candidates) {
            if (typeof candidate !== "string") continue;
            try {
                const url = new URL(candidate, pageWindow.location.href);
                if (url.origin === pageWindow.location.origin &&
                    /^\/cdn\/assets\/[^/]+\.js$/.test(url.pathname) &&
                    !url.username && !url.password) {
                    urls.add(url.href);
                }
            } catch {
                // Ignore invalid resource entries independently.
            }
        }
        return [...urls];
    }

    function waitForChatgptImportMapTarget() {
        if (chatgptImportMapObserver || document.readyState !== "loading") return;
        const stop = () => {
            chatgptImportMapObserver?.disconnect();
            chatgptImportMapObserver = undefined;
            document.removeEventListener("DOMContentLoaded", finish);
        };
        const finish = () => {
            stop();
            if (!chatgptImportMapInserted && isChatgptImportPatchEnabled()) {
                chatgptImportPatchFailure = "页面未及时提供模块映射插入位置；模块增强暂不可用。";
                updateChatgptInjectionStatus();
            }
        };
        chatgptImportMapObserver = new MutationObserver(() => {
            if (!isChatgptImportPatchEnabled()) return stop();
            if (!document.head || !document.querySelector("script[nonce], link[nonce]")) return;
            stop();
            installCachedChatgptImportMapPatch();
        });
        chatgptImportMapObserver.observe(document, { childList: true, subtree: true });
        document.addEventListener("DOMContentLoaded", finish, { once: true });
    }

    function patchChatgptRuntimeModelAssetSource(sourceText, bindingsOnly = false) {
        const singleMatch = (pattern) => {
            const matches = [...sourceText.matchAll(pattern)];
            return matches.length === 1 ? matches[0] : null;
        };
        const surfaceSwitchMatch = singleMatch(
            /function ([A-Za-z$_][\w$]*)\(\{conversation:([A-Za-z$_][\w$]*),entryIntent:[A-Za-z$_][\w$]*,nextMode:([A-Za-z$_][\w$]*)\}\)\{if\(\3===([A-Za-z$_][\w$]*)\.Chat&&[A-Za-z$_][\w$]*\(\)\)return!1;let ([A-Za-z$_][\w$]*)=[A-Za-z$_][\w$]*\(\);return [A-Za-z$_][\w$]*\(\(\)=>\{[^{}]{0,300}?[A-Za-z$_][\w$]*\(\{conversation:\2,currentMode:\5,nextMode:\3\}\),[A-Za-z$_][\w$]*\(\3\)\}\),!0\}/g,
        );
        const originModeMatch = singleMatch(
            /function [A-Za-z$_][\w$]*\(([A-Za-z$_][\w$]*)\)\{([A-Za-z$_][\w$]*)\(\1,([A-Za-z$_][\w$]*)=>\{[^{}]{0,200}?\.conversationOrigin=([A-Za-z$_][\w$]*)\.TPP\)\}\)\}/g,
        );
        const threadMutatorMatch = singleMatch(
            /function ([A-Za-z$_][\w$]*)\(([A-Za-z$_][\w$]*),([A-Za-z$_][\w$]*)\)\{([A-Za-z$_][\w$]*)\(([A-Za-z$_][\w$]*)=>\{let ([A-Za-z$_][\w$]*)=([A-Za-z$_][\w$]*)\(\2,\5\);\6&&\3\(\6\)\}\)\}/g,
        );
        const originDecisionMatch = singleMatch(
            /function ([A-Za-z$_][\w$]*)\(([A-Za-z$_][\w$]*)\)\{return ([A-Za-z$_][\w$]*)\(\{(?=[^{}]{0,500}isNewConversation:[A-Za-z$_][\w$]*\(\2\))(?=[^{}]{0,500}conversationIsLoading:[A-Za-z$_][\w$]*\(\2\))(?=[^{}]{0,500}modelSlug:[A-Za-z$_][\w$]*\(\2\))[^{}]{0,500}?conversationOrigin:([A-Za-z$_][\w$]*)\(\2\)[^{}]{0,500}\}\)\}/g,
        );
        const workOnlyMatch = singleMatch(
            /function ([A-Za-z$_][\w$]*)\(\)\{return ([A-Za-z$_][\w$]*)\(\)&&([A-Za-z$_][\w$]*)\(([A-Za-z$_][\w$]*)\.WorkOnlyMode\)===!0\}/g,
        );
        const originSelectorMatch = singleMatch(
            /([A-Za-z$_][\w$]*)=([A-Za-z$_][\w$]*)\(([A-Za-z$_][\w$]*)=>\3\?\.conversationOrigin\?\?null\)/g,
        );
        const threadSelectorsMatch = singleMatch(
            /getCurrentLeafId:\s*[A-Za-z$_][\w$]*\(\s*([A-Za-z$_][\w$]*)\s*=>\s*\{\s*let\s+[A-Za-z$_][\w$]*\s*=\s*([A-Za-z$_][\w$]*)\.getTree\(\1\)/g,
        );
        const threadGetterMatch = singleMatch(
            /function ([A-Za-z$_][\w$]*)\(([A-Za-z$_][\w$]*),([A-Za-z$_][\w$]*)=([A-Za-z$_][\w$]*)\(\)\)\{let ([A-Za-z$_][\w$]*)=([A-Za-z$_][\w$]*)\(\2,\3\);return \3\.threads\[\5\]\}/g,
        );
        const messageTextMatch = singleMatch(
            /function\s+([A-Za-z_$][\w$]*)\s*\(\s*[A-Za-z_$][\w$]*\s*,\s*[A-Za-z_$][\w$]*\s*=\s*\{\s*shouldGetTextFromContentReferences:\s*!1\s*,\s*shouldGetVisibleText:\s*!1\s*\}\s*\)\s*\{/g,
        );
        const exportMatches = [...sourceText.matchAll(/export\{/g)];
        if (
            !surfaceSwitchMatch ||
            !originModeMatch ||
            !threadMutatorMatch ||
            !originDecisionMatch ||
            !workOnlyMatch ||
            !originSelectorMatch ||
            !threadSelectorsMatch ||
            !threadGetterMatch ||
            !messageTextMatch ||
            originModeMatch[2] !== threadMutatorMatch[1] ||
            originDecisionMatch[4] !== originSelectorMatch[1] ||
            !surfaceSwitchMatch[0].includes(`&&${workOnlyMatch[1]}()`) ||
            exportMatches.length !== 1
        ) {
            return null;
        }

        if (bindingsOnly) return {
            switchSurface: surfaceSwitchMatch[1],
            surfaceMode: surfaceSwitchMatch[4],
            getOrigin: originDecisionMatch[4],
            originEnum: originModeMatch[4],
            getThread: threadGetterMatch[1],
            threadSelectors: threadSelectorsMatch[2],
            getMessageText: messageTextMatch[1],
        };

        const surfaceSwitchBodyStart = surfaceSwitchMatch[0].indexOf("){");
        const patchedSurfaceSwitch =
            surfaceSwitchBodyStart === -1
                ? surfaceSwitchMatch[0]
                : `${surfaceSwitchMatch[0].slice(0, surfaceSwitchBodyStart + 2)}globalThis.__checkerNextRuntimeModelBridge?.setOriginOverride(${surfaceSwitchMatch[2]},${surfaceSwitchMatch[3]}===${surfaceSwitchMatch[4]}.TPP?"work":"chat");${surfaceSwitchMatch[0].slice(surfaceSwitchBodyStart + 2)}`;
        const patchedWorkOnly = workOnlyMatch[0].replace(
            `function ${workOnlyMatch[1]}(){return`,
            `function ${workOnlyMatch[1]}(){return globalThis.__checkerNextRuntimeModelBridge?.getCurrentOriginOverride()==="chat"?!1:`,
        );
        const patchedOriginSelector = `${originSelectorMatch[1]}=(()=>{let checkerNextNativeOrigin=${originSelectorMatch[2]}(${originSelectorMatch[3]}=>${originSelectorMatch[3]}?.conversationOrigin??null);return conversation=>{let origin=globalThis.__checkerNextRuntimeModelBridge?.getOriginOverride(conversation),nativeOrigin=checkerNextNativeOrigin(conversation);return origin==="work"?${originModeMatch[4]}.TPP:origin==="chat"?null:nativeOrigin}})()`;
        if (
            patchedSurfaceSwitch === surfaceSwitchMatch[0] ||
            patchedWorkOnly === workOnlyMatch[0] ||
            patchedOriginSelector === originSelectorMatch[0]
        ) {
            return null;
        }

        let bridgeSource = `
globalThis.__checkerNextRuntimeModelBridge=(()=>{
    const conversations=new Map;
    const customModels=new Set;
    const originOverrides=new Map;
    let newConversation,stateScheduled=!1,modelGetter,modelSetter,thinkingStore;
    const getServerId=conversation=>typeof conversation.serverId$==="function"?conversation.serverId$():null;
    const getOriginKey=conversation=>getServerId(conversation)??conversation.id;
    const getOriginOverride=conversation=>conversation?originOverrides.get(getOriginKey(conversation)):void 0;
    const getOrigin=conversation=>{
        const conversationOrigin=__CONVERSATION_ORIGIN__(conversation);
        return conversationOrigin===__ORIGIN_ENUM__.TPP?"work":"chat";
    };
    const setOriginOverride=(conversation,origin)=>{
        const originKey=getOriginKey(conversation);
        originOverrides.set(originKey,origin);
        conversations.set(originKey,conversation);
        if(conversation.id!==originKey)conversations.set(conversation.id,conversation);
        __THREAD_MUTATOR__(conversation.id,thread=>{thread.conversationOrigin=origin==="work"?__ORIGIN_ENUM__.TPP:null});
    };
    const setOrigin=(conversation,origin)=>{
        __SURFACE_SWITCH__({conversation,nextMode:origin==="work"?__SURFACE_MODE__.TPP:__SURFACE_MODE__.Chat});
    };
    const getCurrentConversation=()=>{
        const routeId=globalThis.location.pathname.match(/\\/(?:c|share)\\/([^/?#]+)/)?.[1];
        if(routeId)return conversations.get(routeId);
        return newConversation&&getServerId(newConversation)==null?newConversation:void 0;
    };
    const getCurrentOriginOverride=()=>getOriginOverride(getCurrentConversation());
    const emitState=error=>{
        const conversation=getCurrentConversation();
        let detail={ready:!error,available:!1,error:error?String(error):null};
        if(conversation&&!error)try{
            const model=modelGetter(conversation);
            detail={
                ready:!0,
                available:!0,
                model:model.id,
                thinkingEffort:model.configurableThinkingEffort||model.id==="gpt-5-thinking"?thinkingStore(conversation).conversationThinkingEffort$():void 0,
                origin:getOrigin(conversation)
            };
        }catch(error){detail={ready:!1,available:!0,error:String(error)}}
        globalThis.dispatchEvent(new CustomEvent("checker-next-runtime-model-state",{detail}));
    };
    const scheduleState=()=>{
        if(stateScheduled)return;
        stateScheduled=!0;
        queueMicrotask(()=>{try{emitState()}finally{stateScheduled=!1}});
    };
    const register=(conversation,nextModelGetter,nextModelSetter,nextThinkingStore)=>{
        if(!conversation)return;
        modelGetter=nextModelGetter;
        modelSetter=nextModelSetter;
        thinkingStore=nextThinkingStore;
        if(conversation.id!=null)conversations.set(conversation.id,conversation);
        if(conversation.config?.sharedConversationId!=null)conversations.set(conversation.config.sharedConversationId,conversation);
        const serverId=getServerId(conversation);
        if(serverId!=null){
            conversations.set(serverId,conversation);
            const origin=originOverrides.get(conversation.id);
            if(origin){
                originOverrides.delete(conversation.id);
                originOverrides.set(serverId,origin);
            }
        }else newConversation=conversation;
        scheduleState();
    };
    const getTurns=()=>{
        const conversation=getCurrentConversation();
        const thread=conversation&&__THREAD_GETTER__(conversation.id);
        return thread?__THREAD_SELECTORS__.getConversationTurns(thread):[];
    };
    const getMessageText=message=>__MESSAGE_TEXT__(message,{shouldGetTextFromContentReferences:!0,shouldGetVisibleText:!0});
    globalThis.addEventListener("checker-next-runtime-model-request",()=>emitState());
    globalThis.addEventListener("checker-next-runtime-model-set",event=>{
        const conversation=getCurrentConversation();
        if(!conversation){emitState("未找到当前对话");return}
        try{
            const detail=event.detail??{};
            if(detail.origin==="work"||detail.origin==="chat")setOrigin(conversation,detail.origin);
            const model=typeof detail.model==="string"?detail.model.trim():"";
            if(model){customModels.add(model);modelSetter(conversation,model)}
            const hasThinkingEffort=Object.hasOwn(detail,"thinkingEffort")&&(detail.thinkingEffort===null||typeof detail.thinkingEffort==="string");
            const thinkingEffort=typeof detail.thinkingEffort==="string"?detail.thinkingEffort.trim():void 0;
            if(hasThinkingEffort)thinkingStore(conversation).setThinkingEffort(thinkingEffort||void 0,modelGetter(conversation).id);
        }catch(error){emitState(error);return}
        scheduleState();
    });
    scheduleState();
    return{register,allows:model=>customModels.has(model),getOrigin,getOriginOverride,getCurrentOriginOverride,setOriginOverride,getTurns,getMessageText};
})();
`;
        for (const [placeholder, value] of [
            ["__CONVERSATION_ORIGIN__", originDecisionMatch[4]],
            ["__ORIGIN_ENUM__", originModeMatch[4]],
            ["__SURFACE_SWITCH__", surfaceSwitchMatch[1]],
            ["__SURFACE_MODE__", surfaceSwitchMatch[4]],
            ["__THREAD_MUTATOR__", threadMutatorMatch[1]],
            ["__THREAD_SELECTORS__", threadSelectorsMatch[2]],
            ["__THREAD_GETTER__", threadGetterMatch[1]],
            ["__MESSAGE_TEXT__", messageTextMatch[1]],
        ]) {
            bridgeSource = bridgeSource.split(placeholder).join(value);
        }

        let patched = sourceText.replace(
            surfaceSwitchMatch[0],
            patchedSurfaceSwitch,
        );
        patched = patched.replace(workOnlyMatch[0], patchedWorkOnly);
        patched = patched.replace(
            originSelectorMatch[0],
            patchedOriginSelector,
        );
        patched = patched.replace(/export\{/, `${bridgeSource}export{`);
        return patched;
    }

    function getChatgptImportPatchSettings() {
        const fakePlanEnabled =
            localStorage.getItem(CHATGPT_FAKE_PLAN_ENABLED_KEY) === "true";
        const fakePlan = getChatgptFakePlan(
            localStorage.getItem(CHATGPT_FAKE_PLAN_KEY) || "pro",
        );
        return {
            fakePlan: fakePlanEnabled ? fakePlan?.subscriptionPlan || "" : "",
        };
    }

    function getChatgptImportPatchItems(settings) {
        const items = ["运行时模型切换"];
        if (chatgptCopyButtonEnabled) items.push("复制全文");
        if (settings?.fakePlan) {
            items.push(`假装会员：${settings.fakePlan}`);
        }
        return items;
    }

    async function extractChatgptCopyIcons(
        sharedUrl,
        sharedSource,
        conversationSource,
    ) {
        const singleMatch = (pattern, sourceText) => {
            const matches = [...sourceText.matchAll(pattern)];
            return matches.length === 1 ? matches[0] : null;
        };
        const buttonMatch = singleMatch(
            /let [A-Za-z$_][\w$]*=[A-Za-z$_][\w$]*\?\?`([^`]+)`,[A-Za-z$_][\w$]*=[A-Za-z$_][\w$]*!=null&&`max-md:hidden`[\s\S]{0,1800}?default:\{let [A-Za-z$_][\w$]*=\(0,[A-Za-z$_][\w$]*\.jsx\)\(`button`,\{\.\.\.[A-Za-z$_][\w$]*,className:[A-Za-z$_][\w$]*\([A-Za-z$_][\w$]*===`primary`\?`([^`]+)`:[A-Za-z$_][\w$]*===`tertiary`\?`[^`]+`:`[^`]+`,`([^`]+)`,`([^`]+)`,[A-Za-z$_][\w$]*\.className\)/g,
            conversationSource,
        );
        const actionIconsMatch = singleMatch(
            /id:`message-turn-actions`,icons:\{((?:[^{}]|\{[^{}]*\})+)\}\}/g,
            conversationSource,
        );
        const checkMatch = actionIconsMatch
            ? singleMatch(
                  /(?:^|,)check:\{[^{}]*normal:([A-Za-z$_][\w$]*)[^{}]*\}/g,
                  actionIconsMatch[1],
              )
            : null;
        const copyMatch = actionIconsMatch
            ? singleMatch(
                  /(?:^|,)copy:\{[^{}]*normal:([A-Za-z$_][\w$]*)[^{}]*\}/g,
                  actionIconsMatch[1],
              )
            : null;
        const errorMessageMatch = singleMatch(
            /\[([A-Za-z$_][\w$]*)\.danger\]:\{defaultMessage:`Error`,description:`Prefix for error toast announcements`,id:`toast\.error`\}/g,
            sharedSource,
        );
        const iconMapMatch = errorMessageMatch
            ? singleMatch(
                  new RegExp(
                      `\\{((?:\\[${RegExp.escape(errorMessageMatch[1])}\\.[A-Za-z]+\\]:[A-Za-z$_][\\w$]*,?){4,8})\\}`,
                      "g",
                  ),
                  sharedSource,
              )
            : null;
        const errorMatch = iconMapMatch
            ? singleMatch(
                  new RegExp(
                      `\\[${RegExp.escape(errorMessageMatch[1])}\\.danger\\]:([A-Za-z$_][\\w$]*)`,
                      "g",
                  ),
                  iconMapMatch[1],
              )
            : null;
        if (!buttonMatch || !checkMatch || !copyMatch || !errorMatch) {
            return null;
        }

        const inlineIcon = (localName) => {
            const match = singleMatch(
                new RegExp(
                    `(?<![\\w$])${RegExp.escape(localName)}` +
                        "=[A-Za-z$_][\\w$]*\\(\\{name:`[^`]+`,canvas:\\{width:(\\d+),height:(\\d+),viewBox:`([^`]+)`[\\s\\S]{0,2500}?body:`([^`]+)`\\}\\)",
                    "g",
                ),
                conversationSource,
            );
            return match
                ? {
                      width: match[1],
                      height: match[2],
                      viewBox: match[3],
                      body: match[4],
                  }
                : null;
        };
        const success = inlineIcon(checkMatch[1]);
        const idle = inlineIcon(copyMatch[1]);
        if (!idle || !success) return null;

        const errorIconMatch = singleMatch(
            new RegExp(
                `(?<![\\w$])${RegExp.escape(errorMatch[1])}` +
                    "=([A-Za-z$_][\\w$]*)\\(([A-Za-z$_][\\w$]*),`([^`]+)`,\\d+,\\d+(?:,!0)?\\)",
                "g",
            ),
            sharedSource,
        );
        const spriteMatch = errorIconMatch
            ? singleMatch(
                  new RegExp(
                      `(?<![\\w$])${RegExp.escape(errorIconMatch[2])}` +
                          "=`([^`]+)`",
                      "g",
                  ),
                  sharedSource,
              )
            : null;
        if (!errorIconMatch || !spriteMatch) return null;

        const spriteResponse = await originalFetch(
            new URL(spriteMatch[1], new URL(sharedUrl).origin),
        );
        if (!spriteResponse.ok) {
            throw new Error(
                `${spriteResponse.status} ${spriteResponse.statusText}`,
            );
        }
        const symbol = new DOMParser()
            .parseFromString(await spriteResponse.text(), "image/svg+xml")
            .getElementById(errorIconMatch[3]);
        const viewBox = symbol?.getAttribute("viewBox");
        if (symbol?.localName !== "symbol" || !viewBox) return null;

        return {
            button: {
                className: buttonMatch.slice(2).join(" "),
                iconClassName: buttonMatch[1],
                width: idle.width,
                height: idle.height,
            },
            idle,
            success,
            error: { viewBox, body: symbol.innerHTML },
        };
    }

    function isChatgptFakePlanCatalog(value) {
        return Array.isArray(value?.options) && Array.isArray(value.planTypes);
    }

    function isChatgptCopyIcons(value) {
        return (
            typeof value?.button?.className === "string" &&
            typeof value.button.iconClassName === "string" &&
            typeof value.button.width === "string" &&
            typeof value.button.height === "string" &&
            ["idle", "success", "error"].every(
                (state) =>
                    typeof value?.[state]?.viewBox === "string" &&
                    typeof value[state].body === "string",
            )
        );
    }

    function getChatgptImportPatchSignature() {
        const { fakePlan } = getChatgptImportPatchSettings();
        const transformSignature = [
            rewriteModuleImports,
            extractChatgptFakePlanCatalog,
            findChatgptFakePlan,
            extractChatgptCopyIcons,
            patchChatgptRuntimeModelAssetSource,
            patchChatgptRuntimeModelConversationAssetSource,
            patchChatgptFakePlanAssetSource,
        ].join("\n");
        return [transformSignature, fakePlan].join("\n");
    }

    function setChatgptImportMapPatchCache(value) {
        GM_setValue(CHATGPT_IMPORT_MAP_CACHE_KEY, value);
    }

    function isChatgptImportPatchEnabled() {
        return isChatgptMode && chatgptModuleInjectionEnabled;
    }

    function installCachedChatgptImportMapPatch() {
        if (!isChatgptImportPatchEnabled()) return;
        if (chatgptImportMapInserted || pageWindow.__checkerNextImportMapInstalled) return;

        const cached = GM_getValue(CHATGPT_IMPORT_MAP_CACHE_KEY, null);
        if (!cached) return;
        if (
            typeof cached !== "object" ||
            !Array.isArray(cached.assets) ||
            cached.assets.length !== 2 ||
            cached.assets.some(
                (asset) =>
                    typeof asset?.assetUrl !== "string" ||
                    typeof asset.sourceText !== "string" ||
                    !isChatgptCachedAssetUrl(asset.assetUrl),
            )
        ) {
            reportChatgptFailure("缓存模块补丁格式无效。");
            return;
        }
        chatgptFakePlanCatalog =
            cached.fakePlanCatalog ||
            extractChatgptFakePlanCatalog(cached.assets[0].sourceText);
        if (!isChatgptFakePlanCatalog(chatgptFakePlanCatalog)) {
            reportChatgptFailure("缓存模块中的 ChatGPT 会员枚举无法读取。");
            return;
        }
        if (cached.signature !== getChatgptImportPatchSignature()) return;
        if (!isChatgptCopyIcons(cached.copyIcons)) {
            reportChatgptFailure("缓存模块补丁格式无效。");
            return;
        }
        chatgptCopyIcons = cached.copyIcons;
        if (!document.head || !document.querySelector("script[nonce], link[nonce]") && !document.currentScript?.nonce) {
            waitForChatgptImportMapTarget();
            return;
        }
        const mappedAssets = cached.assets.map((asset) => ({
            ...asset,
            blobUrl: URL.createObjectURL(
                new Blob([asset.sourceText], { type: "text/javascript" }),
            ),
        }));
        const importMap = injectImportMap({
            imports: Object.fromEntries(
                mappedAssets.map((asset) => [asset.assetUrl, asset.blobUrl]),
            ),
        });
        if (!importMap) {
            for (const asset of mappedAssets) {
                URL.revokeObjectURL(asset.blobUrl);
            }
            chatgptImportPatchFailure =
                "页面尚未提供可同步插入模块映射的脚本 nonce。";
            reportChatgptFailure(chatgptImportPatchFailure);
            return;
        }

        chatgptImportMapInserted = true;
        chatgptImportPatchFailure = undefined;
        chatgptInstalledPatchSettings = getChatgptImportPatchSettings();
        console.info(
            "[CheckerNext] 已创建缓存 import map 元素:",
            cached.assets.map((asset) => asset.assetUrl),
        );
    }

    function isChatgptCachedAssetUrl(value) {
        try {
            const url = new URL(value);
            return url.origin === pageWindow.location.origin &&
                /^\/cdn\/assets\/[^/]+\.js$/.test(url.pathname) &&
                !url.username && !url.password;
        } catch {
            return false;
        }
    }

    function patchChatgptRuntimeModelConversationAssetSource(sourceText, bindingsOnly = false) {
        const singleMatch = (pattern) => {
            const matches = [...sourceText.matchAll(pattern)];
            return matches.length === 1 ? matches[0] : null;
        };
        const modelSetterMatch = singleMatch(
            /function ([A-Za-z$_][\w$]*)\(([A-Za-z$_][\w$]*),([A-Za-z$_][\w$]*)\)\{(?:[^{}]|\{[^{}]*\}){0,500}?[A-Za-z$_][\w$]*\(\(\)=>\{let ([A-Za-z$_][\w$]*)=([A-Za-z$_][\w$]*)\(\2\);[^{}]{0,500}?([A-Za-z$_][\w$]*)\.set\(\2,\{\.\.\.\6\(\2\),\[\4\]:\{modelSlug:\3,[^{}]{0,300}\}\}\)\}\)\}/g,
        );
        const thinkingStoreMatch = singleMatch(
            /function [A-Za-z$_][\w$]*\(([A-Za-z$_][\w$]*)\)\{if\(\1==null\)return;let [A-Za-z$_][\w$]*=([A-Za-z$_][\w$]*)\(\1\);if\([^{}]{0,180}\)return ([A-Za-z$_][\w$]*)\(\1\)\.conversationThinkingEffort\$\(\)\}/g,
        );
        const thinkingSetterMatch = singleMatch(
            /setThinkingEffort:\(([A-Za-z$_][\w$]*),([A-Za-z$_][\w$]*)\)=>\{if\(([A-Za-z$_][\w$]*)\(\)\)\{[A-Za-z$_][\w$]*\(\(\)=>\{let ([A-Za-z$_][\w$]*)=\2\?\?([A-Za-z$_][\w$]*)\(([A-Za-z$_][\w$]*)\)\.id,(?:[^{}]|\{[^{}]*\}){0,500}?[A-Za-z$_][\w$]*\.set\(\1\),[A-Za-z$_][\w$]*\(\1,\4\)\}\);return\}[A-Za-z$_][\w$]*\.setThinkingEffort\(\1\)\}/g,
        );
        const modelGetterName =
            thinkingStoreMatch?.[2] === thinkingSetterMatch?.[5]
                ? thinkingStoreMatch[2]
                : null;
        const modelGetterMatch = modelGetterName
            ? singleMatch(
                  new RegExp(
                      `${RegExp.escape(modelGetterName)}=([A-Za-z$_][\\w$]*)\\(([A-Za-z$_][\\w$]*)=>([A-Za-z$_][\\w$]*)\\(\\(\\)=>\\{`,
                      "g",
                  ),
              )
            : null;
        const modelResolverMatch = singleMatch(
            /function ([A-Za-z$_][\w$]*)\(([A-Za-z$_][\w$]*),([A-Za-z$_][\w$]*)\)\{if\((?:!\()?!\3\|\|([A-Za-z$_][\w$]*)\(\)\.some\(([A-Za-z$_][\w$]*)=>\5\.model_slug===\3\)(?:\))?\)return ?(?:[A-Za-z$_][\w$]*\(\2,\3\))?;?/g,
        );
        const surfaceSelectorName = modelSetterMatch?.[5];
        const surfaceSelectorMatch = surfaceSelectorName
            ? singleMatch(
                  new RegExp(
                      `function ${RegExp.escape(surfaceSelectorName)}\\(([A-Za-z$_][\\w$]*)\\)\\{return ([A-Za-z$_][\\w$]*)\\(\\1\\)\\?\`tpp\`:\`chat\`\\}`,
                      "g",
                  ),
              )
            : null;
        if (
            !modelSetterMatch ||
            !modelGetterName ||
            !modelGetterMatch ||
            !thinkingStoreMatch ||
            !thinkingSetterMatch ||
            !modelResolverMatch ||
            !surfaceSelectorMatch ||
            modelSetterMatch[5] !== surfaceSelectorName
        ) {
            return null;
        }

        if (bindingsOnly) return {
            getModel: modelGetterName,
            setModel: modelSetterMatch[1],
            thinkingStore: thinkingStoreMatch[3],
        };

        const deniedModel = `${modelResolverMatch[4]}().some(${modelResolverMatch[5]}=>${modelResolverMatch[5]}.model_slug===${modelResolverMatch[3]})`;
        const patchedModelResolver = modelResolverMatch[0].replace(
            deniedModel,
            `(${deniedModel}&&!globalThis.__checkerNextRuntimeModelBridge?.allows(${modelResolverMatch[3]}))`,
        );
        const patchedSurfaceSelector = surfaceSelectorMatch[0].replace(
            `function ${surfaceSelectorName}(${surfaceSelectorMatch[1]}){`,
            `function ${surfaceSelectorName}(${surfaceSelectorMatch[1]}){let checkerNextOrigin=globalThis.__checkerNextRuntimeModelBridge?.getOrigin(${surfaceSelectorMatch[1]});if(checkerNextOrigin==="work")return"tpp";if(checkerNextOrigin==="chat")return"chat";`,
        );
        const patchedModelGetter = `${modelGetterMatch[0]}if(globalThis.__checkerNextRuntimeModelBridge){globalThis.__checkerNextRuntimeModelBridge.register(${modelGetterMatch[2]},${modelGetterName},${modelSetterMatch[1]},${thinkingStoreMatch[3]});globalThis.__checkerNextImportMapInstalled=!0}else console.error("[CheckerNext] 运行时模型 bridge 未注册。");`;
        if (
            patchedModelResolver === modelResolverMatch[0] ||
            patchedSurfaceSelector === surfaceSelectorMatch[0] ||
            patchedModelGetter === modelGetterMatch[0]
        ) {
            return null;
        }

        return sourceText
            .replace(modelResolverMatch[0], patchedModelResolver)
            .replace(surfaceSelectorMatch[0], patchedSurfaceSelector)
            .replace(modelGetterMatch[0], patchedModelGetter);
    }

    function getChatgptAssetPatchFunctions(assetType) {
        if (assetType === "conversation") {
            return [patchChatgptRuntimeModelConversationAssetSource];
        }
        const patchFunctions = [patchChatgptRuntimeModelAssetSource];
        if (isChatgptFakePlanRuntimeEnabled()) {
            patchFunctions.push(patchChatgptFakePlanAssetSource);
        }
        return patchFunctions;
    }

    function resolveChatgptNativeExports(source, bindings) {
        if (!bindings) return null;
        const exports = [...source.matchAll(/export\{([^}]+)\}/g)];
        if (exports.length !== 1) return null;
        const names = new Map(exports[0][1].split(",").map((entry) => {
            const match = entry.trim().match(/^([\w$]+)(?:\s+as\s+([\w$]+))?$/);
            return match ? [match[1], match[2] || match[1]] : [];
        }).filter((entry) => entry.length === 2));
        const result = {};
        for (const [key, name] of Object.entries(bindings)) {
            if (!names.has(name)) return null;
            result[key] = names.get(name);
        }
        return result;
    }

    function findChatgptNativeConversation() {
        const isConversation = (value) => value && typeof value === "object" &&
            typeof value.id === "string" && typeof value.serverId$ === "function";
        const inspect = (value) => {
            if (isConversation(value)) return value;
            if (!value || typeof value !== "object") return null;
            for (const key of ["conversation", "chatSDK", "value"]) {
                if (isConversation(value[key])) return value[key];
                if (key === "value" && isConversation(value[key]?.conversation)) return value[key].conversation;
            }
            return null;
        };
        // Inspect only the active composer ancestry and its context values.
        // Do not enumerate message state or other conversations.
        const composer = document.getElementById("prompt-textarea");
        for (let node = composer; node; node = node.parentElement) {
            const fiberKey = Object.keys(node).find((key) => key.startsWith("__reactFiber$"));
            let fiber = fiberKey && node[fiberKey];
            for (let depth = 0; fiber && depth < 100; depth++, fiber = fiber.return) {
                const candidate = inspect(fiber.memoizedProps);
                if (candidate) return candidate;
                for (let context = fiber.dependencies?.firstContext; context; context = context.next) {
                    const contextual = inspect(context.memoizedValue);
                    if (contextual) return contextual;
                }
            }
            if (fiberKey) break;
        }
        return null;
    }

    async function connectChatgptNativeModules(targets, sources) {
        const shared = resolveChatgptNativeExports(sources[0],
            patchChatgptRuntimeModelAssetSource(sources[0], true));
        const conversation = resolveChatgptNativeExports(sources[1],
            patchChatgptRuntimeModelConversationAssetSource(sources[1], true));
        if (!shared || !conversation) throw new Error("当前模块未提供所需的运行时导出。");
        const modules = await Promise.all(targets.map((target) => import(target.assetUrl)));
        if (!isChatgptImportPatchEnabled()) return;
        const api = {};
        for (const [index, exports] of [shared, conversation].entries()) {
            for (const [name, alias] of Object.entries(exports)) api[name] = modules[index][alias];
        }
        for (const name of ["switchSurface", "getOrigin", "getThread", "getMessageText", "getModel", "setModel", "thinkingStore"]) {
            if (typeof api[name] !== "function") throw new Error(`原生模块导出不可用：${name}`);
        }
        if (!api.surfaceMode || !api.originEnum || typeof api.threadSelectors?.getConversationTurns !== "function") {
            throw new Error("原生模块类型与当前页面不匹配。");
        }
        chatgptNativeBridge?.dispose();
        let current;
        let signature;
        let timer;
        const emit = (error) => {
            current = isChatgptImportPatchEnabled() ? findChatgptNativeConversation() : null;
            let state = { ready: !error, available: false, error: error ? String(error) : null };
            if (current && !error) try {
                const model = api.getModel(current);
                state = {
                    ready: true, available: true, model: model.id,
                    origin: api.getOrigin(current) === api.originEnum.TPP ? "work" : "chat",
                    thinkingEffort: model.configurableThinkingEffort
                        ? api.thinkingStore(current).conversationThinkingEffort$() : undefined,
                };
            } catch (error) {
                state = { ready: false, available: false, error: String(error) };
            }
            const next = JSON.stringify(state);
            if (next === signature) return;
            signature = next;
            pageWindow.dispatchEvent(new pageWindow.CustomEvent(CHATGPT_RUNTIME_MODEL_STATE_EVENT, { detail: state }));
        };
        const sync = () => {
            if (timer || document.hidden) return;
            timer = setTimeout(() => { timer = undefined; emit(); }, 150);
        };
        const set = (event) => {
            if (!isChatgptImportPatchEnabled()) return;
            current = findChatgptNativeConversation();
            if (!current) return emit("未找到当前对话");
            try {
                const detail = event.detail || {};
                if (detail.origin === "chat" || detail.origin === "work") {
                    api.switchSurface({ conversation: current, nextMode: detail.origin === "work" ? api.surfaceMode.TPP : api.surfaceMode.Chat });
                }
                if (typeof detail.model === "string" && detail.model.trim()) api.setModel(current, detail.model.trim());
                if (Object.hasOwn(detail, "thinkingEffort")) {
                    api.thinkingStore(current).setThinkingEffort(
                        typeof detail.thinkingEffort === "string" ? detail.thinkingEffort.trim() || undefined : undefined,
                        api.getModel(current).id,
                    );
                }
                emit();
            } catch (error) { emit(error); }
        };
        pageWindow.addEventListener(CHATGPT_RUNTIME_MODEL_REQUEST_EVENT, sync);
        pageWindow.addEventListener(CHATGPT_RUNTIME_MODEL_SET_EVENT, set);
        document.addEventListener("visibilitychange", sync);
        chatgptNativeBridge = {
            sync,
            getTurns: () => {
                const conversation = findChatgptNativeConversation();
                const thread = conversation && api.getThread(conversation.id);
                return thread ? api.threadSelectors.getConversationTurns(thread) : [];
            },
            getMessageText: (message) => api.getMessageText(message, { shouldGetTextFromContentReferences: true, shouldGetVisibleText: true }),
            dispose: () => {
                clearTimeout(timer);
                pageWindow.removeEventListener(CHATGPT_RUNTIME_MODEL_REQUEST_EVENT, sync);
                pageWindow.removeEventListener(CHATGPT_RUNTIME_MODEL_SET_EVENT, set);
                document.removeEventListener("visibilitychange", sync);
            },
        };
        pageWindow.__checkerNextRuntimeModelBridge = chatgptNativeBridge;
        chatgptImportPatchFailure = undefined;
        chatgptImportPatchNeedsReload = false;
        emit();
        updateChatgptInjectionStatus();
    }

    async function prepareChatgptImportMapPatchCache() {
        if (!isChatgptImportPatchEnabled()) return;

        chatgptPendingPatchSettings = getChatgptImportPatchSettings();
        if (!chatgptImportPatchTargets) {
            const pageAssetUrls = collectChatgptAssetUrls();
            const targets = [
                {
                    assetType: "shared",
                    assetUrl: pageAssetUrls.find((assetUrl) =>
                        /\/4813494d-[^/?]+\.js(?:[?#]|$)/.test(assetUrl),
                    ),
                },
                {
                    assetType: "conversation",
                    assetUrl: pageAssetUrls.find((assetUrl) =>
                        /\/conversation-small-[^/?]+\.js(?:[?#]|$)/.test(
                            assetUrl,
                        ),
                    ),
                },
            ];
            if (targets.some((target) => !target.assetUrl)) {
                chatgptImportPatchFailure =
                    "页面没有提供可补丁的 ChatGPT 目标模块，资源结构可能已经变化。";
                updateChatgptInjectionStatus();
                console.error("[CheckerNext] 未找到 ChatGPT 目标模块。");
                return;
            }
            chatgptImportPatchTargets = targets;
        }

        const targets = chatgptImportPatchTargets;
        const assetUrls = targets.map((target) => target.assetUrl);
        // Do not fight already-resolved modulepreloads for normal diagnostics,
        // model controls and copy. Import the existing modules, map verified
        // exports, and call their native functions on the active composer.
        if (!chatgptPendingPatchSettings.fakePlan && !chatgptImportMapInserted) {
            try {
                const sources = await Promise.all(assetUrls.map(async (url) => {
                    const response = await originalFetch(url);
                    if (!response.ok) throw new Error(`HTTP ${response.status}`);
                    return response.text();
                }));
                chatgptFakePlanCatalog = extractChatgptFakePlanCatalog(sources[0]);
                updateChatgptFakePlanControls();
                await connectChatgptNativeModules(targets, sources);
                // An icon change must not disable otherwise working controls.
                try {
                    chatgptCopyIcons = await extractChatgptCopyIcons(assetUrls[0], ...sources);
                    syncChatgptCopyButton();
                } catch (error) { reportChatgptFailure(`复制图标暂不可用：${String(error)}`); }
            } catch (error) {
                chatgptImportPatchFailure = `原生模块连接失败：${String(error)}`;
                updateChatgptRuntimeModelControls();
            }
            return;
        }
        const cached = GM_getValue(CHATGPT_IMPORT_MAP_CACHE_KEY, null);
        if (
            !chatgptFakePlanCatalog &&
            isChatgptFakePlanCatalog(cached?.fakePlanCatalog)
        ) {
            chatgptFakePlanCatalog = cached.fakePlanCatalog;
            updateChatgptFakePlanControls();
            chatgptPendingPatchSettings = getChatgptImportPatchSettings();
        }
        const signature = getChatgptImportPatchSignature();
        if (
            cached?.assets?.every(
                (asset, index) => asset.assetUrl === assetUrls[index],
            ) &&
            cached?.signature === signature &&
            cached.assets.length === targets.length &&
            isChatgptFakePlanCatalog(cached.fakePlanCatalog) &&
            isChatgptCopyIcons(cached.copyIcons)
        ) {
            chatgptImportPatchFailure = undefined;
            chatgptImportPatchNeedsReload = !chatgptImportMapInserted &&
                !pageWindow.__checkerNextImportMapInstalled;
            chatgptCopyIcons = cached.copyIcons;
            syncChatgptCopyButton();
            updateChatgptInjectionStatus();
            return;
        }

        chatgptImportPatchFailure = undefined;
        chatgptImportPatchNeedsReload = false;
        try {
            const responses = await Promise.all(
                assetUrls.map((assetUrl) => originalFetch(assetUrl)),
            );
            const assets = [];
            let sharedSource;
            let conversationSource;
            for (const [index, response] of responses.entries()) {
                if (!response.ok) {
                    throw new Error(
                        `${response.status} ${response.statusText}`,
                    );
                }

                const target = targets[index];
                const assetUrl = assetUrls[index];
                let sourceText = await response.text();
                if (target.assetType === "conversation") {
                    conversationSource = sourceText;
                }
                if (target.assetType === "shared") {
                    sharedSource = sourceText;
                    chatgptFakePlanCatalog =
                        extractChatgptFakePlanCatalog(sourceText);
                    if (!chatgptFakePlanCatalog) {
                        setChatgptImportMapPatchCache(null);
                        chatgptImportPatchFailure =
                            "假装会员列表与当前 ChatGPT 模块不匹配。";
                        updateChatgptInjectionStatus();
                        console.error(
                            "[CheckerNext] 未能读取 ChatGPT 会员枚举。",
                        );
                        return;
                    }
                    updateChatgptFakePlanControls();
                    chatgptPendingPatchSettings =
                        getChatgptImportPatchSettings();
                }
                for (const patch of getChatgptAssetPatchFunctions(
                    target.assetType,
                )) {
                    const patched = patch(sourceText);
                    if (typeof patched !== "string" || patched.length === 0) {
                        const patchLabel =
                            patch === patchChatgptFakePlanAssetSource
                                ? "假装会员"
                                : "运行时模型";
                        setChatgptImportMapPatchCache(null);
                        chatgptImportPatchFailure = `${patchLabel}补丁与当前 ChatGPT 模块不匹配。`;
                        updateChatgptInjectionStatus();
                        console.error(
                            `[CheckerNext] 模块补丁未匹配: ${patch.name}`,
                        );
                        return;
                    }
                    sourceText = patched;
                }

                const assetBaseUrl = assetUrl.slice(
                    0,
                    assetUrl.lastIndexOf("/"),
                );
                assets.push({
                    assetUrl,
                    sourceText: rewriteModuleImports(
                        sourceText,
                        assetUrl,
                        assetBaseUrl,
                    ),
                });
            }

            const copyIcons = await extractChatgptCopyIcons(
                targets.find((target) => target.assetType === "shared")
                    .assetUrl,
                sharedSource,
                conversationSource,
            );
            if (!copyIcons) {
                setChatgptImportMapPatchCache(null);
                chatgptImportPatchFailure =
                    "复制按钮图标与当前 ChatGPT 模块不匹配。";
                updateChatgptInjectionStatus();
                console.error("[CheckerNext] 未能读取 ChatGPT 复制按钮图标。");
                return;
            }

            if (!isChatgptImportPatchEnabled()) return;
            chatgptCopyIcons = copyIcons;
            setChatgptImportMapPatchCache({
                assets,
                copyIcons,
                fakePlanCatalog: chatgptFakePlanCatalog,
                signature: getChatgptImportPatchSignature(),
            });
            syncChatgptCopyButton();
            chatgptImportPatchNeedsReload = true;
            updateChatgptInjectionStatus();
            console.info(
                "[CheckerNext] 模块补丁缓存已更新，重新载入后生效:",
                assetUrls,
            );
        } catch (error) {
            if (!isChatgptImportPatchEnabled()) return;
            chatgptImportPatchFailure = `补丁缓存生成失败：${String(error)}`;
            updateChatgptInjectionStatus();
            console.error("[CheckerNext] 生成模块补丁缓存失败:", error);
        }
    }

    let chatgptAgeVerificationSettingFetched = false;
    let chatgptAgeVerificationSettingDisplayValue = null;
    let chatgptAgeVerificationSettingWasModified = false;
    let chatgptAgeVerificationSettingError = null;

    function updateGrokDevToolsSliderStyle(slider, sliderDot, enabled) {
        if (enabled) {
            slider.style.backgroundColor = "var(--checker-success)";
            sliderDot.style.transform = "translateX(12px)";
        } else {
            slider.style.backgroundColor = "var(--checker-switch)";
            sliderDot.style.transform = "translateX(0)";
        }
    }

    function getChatgptFakePlan(value) {
        return findChatgptFakePlan(chatgptFakePlanCatalog, value);
    }

    function updateChatgptFakePlanControls() {
        const select = document.getElementById("chatgpt-fake-plan-select");
        const toggle = document.getElementById("chatgpt-fake-plan-toggle");
        const slider = document.getElementById("chatgpt-fake-plan-slider");
        const sliderDot = document.getElementById(
            "chatgpt-fake-plan-slider-dot",
        );
        if (!(select instanceof HTMLSelectElement)) return;

        const selectedPlan = getChatgptFakePlan(chatgptFakePlanValue);
        if (
            selectedPlan &&
            chatgptFakePlanValue !== selectedPlan.subscriptionPlan
        ) {
            chatgptFakePlanValue = selectedPlan.subscriptionPlan;
            localStorage.setItem(CHATGPT_FAKE_PLAN_KEY, chatgptFakePlanValue);
        }
        const options = (chatgptFakePlanCatalog?.options || []).map(
            ({ subscriptionPlan, planType }) => {
                const option = document.createElement("option");
                option.value = subscriptionPlan;
                option.textContent = `${planType} (${subscriptionPlan})`;
                return option;
            },
        );
        if (!selectedPlan) {
            const placeholder = document.createElement("option");
            placeholder.value = "";
            placeholder.textContent = chatgptFakePlanCatalog
                ? "请选择"
                : "读取中…";
            placeholder.disabled = true;
            options.unshift(placeholder);
        }
        select.replaceChildren(...options);
        select.value = selectedPlan?.subscriptionPlan || "";
        select.disabled = !chatgptFakePlanCatalog;
        select.title = select.selectedOptions[0]?.textContent || "";

        if (
            toggle instanceof HTMLInputElement &&
            slider instanceof HTMLElement &&
            sliderDot instanceof HTMLElement
        ) {
            toggle.checked = Boolean(selectedPlan && chatgptFakePlanEnabled);
            toggle.disabled = !selectedPlan;
            updateGrokDevToolsSliderStyle(
                slider,
                sliderDot,
                isChatgptFakePlanRuntimeEnabled(),
            );
        }
    }

    let chatgptFakePlanValue = isChatgptMode
        ? localStorage.getItem(CHATGPT_FAKE_PLAN_KEY) || "pro"
        : "pro";
    let chatgptFakePlanEnabled =
        isChatgptMode &&
        localStorage.getItem(CHATGPT_FAKE_PLAN_ENABLED_KEY) === "true";

    function isChatgptFakePlanRuntimeEnabled() {
        return Boolean(
            chatgptFakePlanEnabled && getChatgptFakePlan(chatgptFakePlanValue),
        );
    }

    function updateChatgptRuntimeModelCatalog(origin, data) {
        if (!isChatgptMode || (origin !== "chat" && origin !== "work")) return;
        if (!Array.isArray(data?.models)) {
            reportChatgptFailure(`ChatGPT ${origin} 模型列表格式无效。`);
        }
        chatgptRuntimeModelCatalogs[origin] = Array.isArray(data?.models)
            ? data.models.flatMap((model) => {
                  if (typeof model?.slug !== "string" || !model.slug.trim()) {
                      return [];
                  }
                  return [
                      {
                          slug: model.slug.trim(),
                          title:
                              typeof model.title === "string" &&
                              model.title.trim()
                                  ? model.title.trim()
                                  : model.slug.trim(),
                          thinkingEfforts: Array.isArray(model.thinking_efforts)
                              ? model.thinking_efforts
                                    .map((effort) =>
                                        typeof effort === "string"
                                            ? effort
                                            : effort?.thinking_effort,
                                    )
                                    .filter(
                                        (effort) =>
                                            typeof effort === "string" &&
                                            effort.trim(),
                                    )
                              : [],
                      },
                  ];
              })
            : [];
        updateChatgptRuntimeModelOptions();
    }

    function updateChatgptRuntimeModelOptions(
        selectedModelValue = undefined,
        selectedThinkingValue = undefined,
    ) {
        const originElement = document.getElementById("chatgpt-runtime-origin");
        const modelElement = document.getElementById("chatgpt-runtime-model");
        const thinkingElement = document.getElementById(
            "chatgpt-runtime-thinking",
        );
        const originSelect =
            originElement instanceof HTMLSelectElement ? originElement : null;
        const modelSelect =
            modelElement instanceof HTMLSelectElement ? modelElement : null;
        const thinkingSelect =
            thinkingElement instanceof HTMLSelectElement
                ? thinkingElement
                : null;
        if (!originSelect || !modelSelect || !thinkingSelect) return;

        const modelValue =
            typeof selectedModelValue === "string"
                ? selectedModelValue
                : modelSelect.value === CHATGPT_RUNTIME_CUSTOM_VALUE
                  ? ""
                  : modelSelect.value;
        const thinkingValue =
            typeof selectedThinkingValue === "string"
                ? selectedThinkingValue
                : thinkingSelect.value === CHATGPT_RUNTIME_CUSTOM_VALUE
                  ? ""
                  : thinkingSelect.value;
        const createOption = (value, text = value) => {
            const option = document.createElement("option");
            option.value = value;
            option.textContent = text;
            return option;
        };
        const models = chatgptRuntimeModelCatalogs[originSelect.value] || [];
        const createPlaceholder = (
            text = chatgptRuntimeModelState?.available ? "默认" :
                chatgptImportPatchFailure ? "暂不可用" :
                chatgptImportPatchNeedsReload ? "刷新后可用" : "等待模块就绪…",
        ) => {
            const option = createOption("", text);
            option.disabled = true;
            return option;
        };
        const modelOptions = modelValue ? [] : [createPlaceholder()];
        modelOptions.push(
            ...models.map((model) =>
                createOption(
                    model.slug,
                    model.title === model.slug
                        ? model.slug
                        : `${model.slug}（${model.title}）`,
                ),
            ),
        );
        if (modelValue && !models.some((model) => model.slug === modelValue)) {
            modelOptions.push(createOption(modelValue));
        }
        modelOptions.push(
            createOption(CHATGPT_RUNTIME_CUSTOM_VALUE, "自定义…"),
        );
        modelSelect.replaceChildren(...modelOptions);
        modelSelect.value = modelValue;
        modelSelect.title = modelSelect.selectedOptions[0]?.textContent || "";
        const modelDetail = document.getElementById("chatgpt-runtime-model-detail");
        if (modelDetail) modelDetail.textContent = modelSelect.title;

        const selectedModel = models.find((model) => model.slug === modelValue);
        const efforts = [...new Set(selectedModel?.thinkingEfforts || [])].map(
            String,
        );
        const thinkingOptions = chatgptRuntimeModelState?.available
            ? [createOption("", "未指定")]
            : [createPlaceholder()];
        thinkingOptions.push(...efforts.map((effort) => createOption(effort)));
        if (thinkingValue && !efforts.includes(thinkingValue)) {
            thinkingOptions.push(createOption(thinkingValue));
        }
        thinkingOptions.push(
            createOption(CHATGPT_RUNTIME_CUSTOM_VALUE, "自定义…"),
        );
        thinkingSelect.replaceChildren(...thinkingOptions);
        thinkingSelect.value = thinkingValue;
    }

    function reportChatgptFailure(message) {
        if (chatgptReportedFailures.has(message)) return;
        chatgptReportedFailures.add(message);
        console.error(`[CheckerNext] ${message}`);
    }

    function updateChatgptInjectionStatus() {
        if (!isChatgptMode) return;
        const status = document.getElementById("chatgpt-injection-status");
        const tooltip = document.getElementById(
            "chatgpt-module-injection-tooltip-box",
        );
        if (!status) return;

        const formatItems = (settings) =>
            getChatgptImportPatchItems(settings)
                .map((item) => `• ${item}`)
                .join("\n");
        const installedItems = formatItems(chatgptInstalledPatchSettings);
        const pendingItems = formatItems(
            chatgptPendingPatchSettings || getChatgptImportPatchSettings(),
        );
        let label = "检查中";
        let color = "var(--checker-muted)";
        let description = "正在检查 ChatGPT 模块补丁。";
        const injectionInstalled = Boolean(
            Reflect.get(pageWindow, "__checkerNextImportMapInstalled"),
        );

        if (!chatgptModuleInjectionEnabled) {
            label = injectionInstalled ? "刷新生效" : "注入关闭";
            color = injectionInstalled ? "var(--checker-warning)" : "var(--checker-muted)";
            description = injectionInstalled
                ? `当前页面仍已注入：\n${installedItems}\n\n刷新页面后关闭模块注入。`
                : "模块注入已关闭。\n\n运行时模型和假装会员均不会生效。";
        } else if (chatgptNativeBridge && !chatgptImportPatchFailure && !chatgptImportPatchNeedsReload && !chatgptPendingPatchSettings?.fakePlan) {
            label = chatgptRuntimeModelState?.available ? "原生连接" : "等待对话";
            color = chatgptRuntimeModelState?.available ? "var(--checker-success)" : "var(--checker-muted)";
            description = chatgptRuntimeModelState?.available
                ? "已连接当前页面的原生模块：模型、思考强度、Chat/Work 和复制全文。无需刷新或改写模块。"
                : "原生模块已加载，等待当前对话初始化。";
        } else if (chatgptImportPatchFailure) {
            label = "暂不可用";
            color = "var(--checker-error)";
            description = chatgptImportPatchFailure;
            if (chatgptRuntimeModelState) {
                description += `\n\n当前页面已注入：\n${installedItems}`;
            } else {
                description += `\n\n准备注入：\n${pendingItems}`;
            }
        } else if (chatgptImportPatchNeedsReload) {
            label = "刷新生效";
            color = "var(--checker-warning)";
            description = chatgptRuntimeModelState
                ? `当前页面已注入：\n${installedItems}\n\n刷新后生效：\n${pendingItems}`
                : `补丁已准备好，请刷新一次页面：\n${pendingItems}`;
        } else if (injectionInstalled) {
            label = "注入成功";
            color = "var(--checker-success)";
            description = `当前页面已注入：\n${installedItems}`;
        } else if (
            document.readyState === "complete" &&
            chatgptImportMapInserted
        ) {
            label = "刷新重试";
            color = "var(--checker-warning)";
            description = `模块映射已经插入，但补丁模块没有执行。页面可能先载入了原模块，刷新页面可重新尝试。\n\n准备注入：\n${pendingItems}`;
        }

        status.innerText = label;
        status.style.color = color;
        if (tooltip) tooltip.innerText = description;
    }

    function updateChatgptRuntimeModelControls() {
        if (!isChatgptMode) return;
        updateChatgptInjectionStatus();
        const originElement = document.getElementById("chatgpt-runtime-origin");
        const modelElement = document.getElementById("chatgpt-runtime-model");
        const thinkingElement = document.getElementById(
            "chatgpt-runtime-thinking",
        );
        const originSelect =
            originElement instanceof HTMLSelectElement ? originElement : null;
        const modelSelect =
            modelElement instanceof HTMLSelectElement ? modelElement : null;
        const thinkingSelect =
            thinkingElement instanceof HTMLSelectElement
                ? thinkingElement
                : null;
        if (!originSelect || !modelSelect || !thinkingSelect) return;

        const controlsDisabled = !chatgptModuleInjectionEnabled ||
            !chatgptRuntimeModelState?.available;
        originSelect.disabled = controlsDisabled;
        modelSelect.disabled = controlsDisabled;
        thinkingSelect.disabled = controlsDisabled;

        const state = chatgptRuntimeModelState;
        let modelValue;
        let thinkingValue;
        if (state?.available) {
            if (
                document.activeElement !== originSelect &&
                (state.origin === "chat" || state.origin === "work")
            ) {
                originSelect.value = state.origin;
            }
            if (
                document.activeElement !== modelSelect &&
                typeof state.model === "string"
            ) {
                modelValue = state.model;
            }
            if (document.activeElement !== thinkingSelect) {
                thinkingValue =
                    typeof state.thinkingEffort === "string"
                        ? state.thinkingEffort
                        : "";
            }
        }
        updateChatgptRuntimeModelOptions(modelValue, thinkingValue);
    }

    function requestChatgptRuntimeModelState() {
        if (!isChatgptMode || !chatgptModuleInjectionEnabled) return;
        pageWindow.dispatchEvent(
            new pageWindow.CustomEvent(CHATGPT_RUNTIME_MODEL_REQUEST_EVENT),
        );
    }

    if (isChatgptMode) {
        pageWindow.addEventListener(
            CHATGPT_RUNTIME_MODEL_STATE_EVENT,
            (event) => {
                if (!event.detail || typeof event.detail !== "object") {
                    reportChatgptFailure("ChatGPT 运行时模型返回了无效状态。");
                    return;
                }
                chatgptRuntimeModelState = event.detail;
                if (event.detail.error) {
                    reportChatgptFailure(
                        `ChatGPT 运行时模型出错：${event.detail.error}`,
                    );
                }
                updateChatgptRuntimeModelControls();
                syncChatgptCopyButton();
            },
        );
        pageWindow.addEventListener("load", updateChatgptInjectionStatus, {
            once: true,
        });
    }

    function getChatgptMessageText(message) {
        const role = message?.author?.role;
        const metadata = message?.metadata;
        if (
            message?.clientMetadata?.err ||
            (role !== "user" && role !== "assistant") ||
            (role === "assistant" && message.recipient !== "all") ||
            metadata?.reasoning_status ||
            metadata?.is_thinking_preamble_message
        ) {
            return "";
        }
        return (
            pageWindow.__checkerNextRuntimeModelBridge?.getMessageText?.(
                message,
            ) ?? ""
        );
    }

    function formatChatgptConversation(turns) {
        let transcript = "";
        for (const turn of turns ?? []) {
            let role;
            let text = "";
            for (const message of turn?.messages ?? []) {
                const messageText = getChatgptMessageText(message);
                if (!messageText) continue;
                role ??= message.author.role === "user" ? "用户" : "助手";
                text = text ? `${text}\n\n${messageText}` : messageText;
            }
            if (!text) continue;
            const formattedTurn = `「${role}」\n${text}`;
            transcript = transcript
                ? `${transcript}\n\n========\n\n${formattedTurn}`
                : formattedTurn;
        }
        if (!transcript) throw new Error("会话中没有可复制的正文");
        return transcript;
    }

    function setChatgptCopyButtonState(button, state, icons) {
        const icon =
            state === "success"
                ? icons.success
                : state === "error"
                  ? icons.error
                  : icons.idle;
        button.replaceChildren(icon.cloneNode(true));
        button.classList.toggle(
            "hover:bg-token-bg-tertiary!",
            state !== "idle",
        );
        const label =
            state === "loading"
                ? "正在复制"
                : state === "success"
                  ? "已复制"
                  : state === "error"
                    ? "复制失败"
                    : "复制全文";
        button.setAttribute("aria-label", label);
        button.title = label;
    }

    function syncChatgptCopyButton() {
        const existing = document.getElementById(
            "checker-next-copy-conversation-button",
        );
        const pathname = pageWindow.location.pathname;
        const isConversationPath =
            /^\/(?:c|share|g\/[^/]+\/(?:shared\/)?c)\/[^/]+$/.test(pathname);
        if (!chatgptCopyButtonEnabled || !isConversationPath) {
            existing?.remove();
            if (chatgptCopyButtonEnabled && pathname.includes("/c/")) {
                reportChatgptFailure(
                    `未识别 ChatGPT 会话路径，复制按钮无法插入：${pathname}`,
                );
            }
            return;
        }
        if (
            existing instanceof HTMLButtonElement &&
            existing.dataset.pathname === pathname &&
            chatgptModuleInjectionEnabled &&
            !existing.disabled
        ) {
            return;
        }
        const turns = chatgptModuleInjectionEnabled
            ? pageWindow.__checkerNextRuntimeModelBridge?.getTurns?.()
            : undefined;
        const ready = Array.isArray(turns) && turns.length > 0;
        if (existing instanceof HTMLButtonElement) {
            existing.dataset.pathname = pathname;
            existing.disabled = !ready;
            return;
        }

        const actionContainer = document.getElementById(
            "conversation-header-actions",
        );
        const actions = actionContainer?.querySelector(
            ":scope > div.flex.items-center",
        );
        if (
            !(actionContainer instanceof HTMLElement) ||
            !(actions instanceof HTMLElement)
        ) {
            if (document.querySelector(".agent-turn")) {
                reportChatgptFailure(
                    "未找到 ChatGPT 会话页头操作区，复制按钮无法插入。",
                );
            }
            return;
        }
        if (!chatgptCopyIcons) return;

        const button = document.createElement("button");
        button.className = chatgptCopyIcons.button.className;
        const nativeIcon = document.createElementNS(
            "http://www.w3.org/2000/svg",
            "svg",
        );
        nativeIcon.setAttribute("width", chatgptCopyIcons.button.width);
        nativeIcon.setAttribute("height", chatgptCopyIcons.button.height);
        nativeIcon.setAttribute("aria-hidden", "true");
        nativeIcon.setAttribute("class", chatgptCopyIcons.button.iconClassName);
        const icons = Object.fromEntries(
            ["idle", "success", "error"].map((state) => {
                const icon = nativeIcon.cloneNode(false);
                icon.setAttribute("viewBox", chatgptCopyIcons[state].viewBox);
                icon.setAttribute("fill", "currentColor");
                icon.innerHTML = chatgptCopyIcons[state].body;
                return [state, icon];
            }),
        );

        button.id = "checker-next-copy-conversation-button";
        button.type = "button";
        button.dataset.pathname = pathname;
        button.disabled = !ready;
        setChatgptCopyButtonState(button, "idle", icons);
        let copying = false;
        button.addEventListener("click", async () => {
            if (copying) return;
            copying = true;
            setChatgptCopyButtonState(button, "loading", icons);
            try {
                const currentTurns =
                    pageWindow.__checkerNextRuntimeModelBridge?.getTurns?.();
                if (!Array.isArray(currentTurns)) {
                    throw new Error("当前会话尚未载入");
                }
                await pageWindow.navigator.clipboard.writeText(
                    formatChatgptConversation(currentTurns),
                );
                setChatgptCopyButtonState(button, "success", icons);
            } catch (error) {
                console.error("[CheckerNext] 复制会话失败:", error);
                setChatgptCopyButtonState(button, "error", icons);
            } finally {
                copying = false;
            }
            setTimeout(
                () => setChatgptCopyButtonState(button, "idle", icons),
                1000,
            );
        });
        actions.prepend(button);
        const gap = getComputedStyle(actionContainer).columnGap;
        actions.style.columnGap = gap;
        actionContainer.parentElement.style.columnGap = gap;
    }

    // 全局状态：记录弹窗是否正在显示
    let isDisplayBoxVisible = false;

    function createElements() {
        if (!document.body) {
            requestAnimationFrame(createElements);
            return;
        }

        if (document.getElementById("checker-next-displayBox")) return;

        // 创建显示框
        const displayBox = document.createElement("div");
        displayBox.id = "checker-next-displayBox";
        displayBox.dataset.mode = currentPageMode;
        displayBox.setAttribute("role", "region");
        displayBox.setAttribute("aria-label", "ChatGPT Checker Next 信息面板");
        displayBox.inert = !isDisplayBoxVisible;
        displayBox.style.position = "fixed";
        displayBox.style.top = "50%";
        displayBox.style.right = "12px";
        displayBox.style.transform = "translateY(-50%)";
        displayBox.style.width = "min(328px, calc(100vw - 24px))";
        displayBox.style.padding = "0";
        displayBox.style.maxHeight = "calc(100dvh - 24px)";
        displayBox.style.overflowX = "hidden";
        displayBox.style.overflowY = "auto";
        displayBox.style.scrollbarWidth = "thin";
        displayBox.style.backgroundColor = "var(--checker-background)";
        displayBox.style.color = "var(--checker-text)";
        displayBox.style.fontSize = "13px";
        displayBox.style.borderRadius = "12px";
        displayBox.style.boxShadow = "0 8px 32px rgb(0 0 0 / 22%)";
        displayBox.style.zIndex = "10000";
        displayBox.style.transition = "height 0.3s ease";
        displayBox.style.opacity = "0";
        displayBox.style.transform =
            "translateY(-50%) translateX(4px) scale(0.98)";
        displayBox.style.pointerEvents = "none";
        displayBox.style.height = "auto";

        const scriptVersion =
            typeof GM_info === "object" &&
            GM_info &&
            typeof GM_info.script === "object" &&
            typeof GM_info.script.version === "string"
                ? GM_info.script.version
                : "";

        const contentWrapper = document.createElement("div");
        contentWrapper.className = "checker-content";
        contentWrapper.style.padding = "16px";
        contentWrapper.innerHTML = `
        <style>
            #checker-next-displayBox[data-mode="codex"] :is(#pow-section, #chatgpt-runtime-model-section, #deep-research-section, #file-upload-section, #paste-text-to-file-section, #image-gen-section, #memory-section, #features-section, #grok-section),
            #checker-next-displayBox[data-mode="grok"] :is(#pow-section, #chatgpt-runtime-model-section, #deep-research-section, #file-upload-section, #paste-text-to-file-section, #image-gen-section, #memory-section, #features-section, #codex-section),
            #checker-next-displayBox[data-mode="chatgpt"] #grok-section {
                display: none !important;
            }
            #checker-next-displayBox[data-mode="codex"] #codex-section,
            #checker-next-displayBox[data-mode="grok"] #grok-section,
            #checker-next-displayBox[data-mode="chatgpt"] #features-section {
                display: block !important;
                margin-top: 0 !important;
            }
            #checker-next-displayBox[data-mode="chatgpt"] #codex-section {
                display: block !important;
            }
            #checker-next-displayBox[data-mode="chatgpt"] .codex-section-title {
                margin-bottom: 2px !important;
            }
            #codex-section a {
                color: #8ab4f8;
                text-decoration: none;
            }
            #codex-section a:hover {
                text-decoration: underline;
            }
            #chatgpt-runtime-model-section select {
                width: 100%;
                box-sizing: border-box;
                background-color: #333;
                color: #fff;
                border: 0;
                border-radius: 4px;
                padding: 4px 8px;
                font-size: 11px;
                cursor: pointer;
                outline: none;
                line-height: 1em;
            }
            /* Authored themes, independent of the host page's color scheme. */
            #checker-next-displayBox, .checker-tooltip {
                --checker-background: #fff;
                --checker-text: #25282e;
                --checker-muted: #626975;
                --checker-surface: #f5f6f8;
                --checker-border: #d6dae0;
                --checker-focus: #7053c1;
                --checker-success: #24713d;
                --checker-warning: #8a6000;
                --checker-error: #bd3039;
                --checker-link: #365fb0;
                --checker-track: #e6e8ed;
                --checker-switch: #929aa5;
                --checker-accent: #8660cd;
                color-scheme: light;
            }
            #checker-next-displayBox[data-checker-theme="dark"], .checker-tooltip[data-checker-theme="dark"] {
                --checker-background: #27292c;
                --checker-text: #eceef1;
                --checker-muted: #a9afb9;
                --checker-surface: #34373c;
                --checker-border: #4a4f58;
                --checker-focus: #b39af7;
                --checker-success: #98dca8;
                --checker-warning: #e9ca76;
                --checker-error: #ff9197;
                --checker-link: #9fbdf0;
                --checker-track: #454951;
                --checker-switch: #616975;
                --checker-accent: #b88be9;
                color-scheme: dark;
            }
            #checker-next-displayBox {
                font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
                line-height: 1.6;
                border: 1px solid var(--checker-border);
                overscroll-behavior: contain;
                font-variant-numeric: tabular-nums;
            }
            #checker-next-displayBox, #checker-next-displayBox * { box-sizing: border-box; }
            #checker-next-displayBox strong { font-size: 13px; font-weight: 650; color: var(--checker-text); }
            #checker-next-displayBox #pow-section > div:first-child strong { font-size: 15px; }
            #checker-next-displayBox .checker-content > div[id$="-section"] + div[id$="-section"] {
                margin-top: 14px !important;
            }
            #checker-next-displayBox .checker-content > div[id$="-section"] > div:first-child {
                margin-top: 0 !important;
                margin-bottom: 6px !important;
            }
            #checker-next-displayBox[data-mode] #features-section {
                margin-top: 14px !important;
                padding-top: 12px;
                border-top: 1px solid var(--checker-border);
            }
            #checker-next-displayBox #chatgpt-runtime-model-section > div:last-child {
                grid-template-columns: 34px minmax(0, 1fr) !important;
                gap: 6px 10px !important;
            }
            #checker-next-displayBox select {
                appearance: none !important;
                -webkit-appearance: none !important;
                display: block;
                min-width: 0;
                width: 100% !important;
                height: 30px;
                margin: 0;
                border: 1px solid var(--checker-border) !important;
                border-radius: 6px !important;
                padding: 4px 30px 4px 9px !important;
                background: var(--checker-surface) url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath d='m3 4.5 3 3 3-3' fill='none' stroke='%237a828e' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E") no-repeat right 10px center !important;
                color: var(--checker-text) !important;
                font: 12px/1.4 system-ui, sans-serif !important;
                text-overflow: ellipsis;
                cursor: pointer;
            }
            #checker-next-displayBox select:disabled { opacity: .55; cursor: default; }
            #checker-next-displayBox select:focus-visible,
            #checker-next-displayBox [id$="-tooltip"]:focus-visible {
                outline: 2px solid var(--checker-focus) !important;
                outline-offset: 2px;
            }
            #checker-next-displayBox .checker-select-detail {
                display: none;
                grid-column: 2;
                color: var(--checker-muted);
                overflow-wrap: anywhere;
                font-size: 11px;
                line-height: 1.5;
            }
            #chatgpt-runtime-model:focus + .checker-select-detail { display: block; }
            #checker-next-displayBox [id$="-tooltip"] {
                display: inline-flex !important;
                align-items: center;
                justify-content: center;
                vertical-align: 1px;
                flex: 0 0 14px;
                width: 14px !important;
                height: 14px !important;
                margin-left: 4px !important;
                color: var(--checker-muted) !important;
                border-color: #727986 !important;
                font: 10px/1 system-ui, sans-serif !important;
                user-select: none;
            }
            #checker-next-displayBox #features-section > div[id],
            #checker-next-displayBox #grok-section > div:has(> label > input[type="checkbox"]) {
                display: grid !important;
                grid-template-columns: minmax(0, 1fr) 30px;
                gap: 12px;
                align-items: center;
                min-height: 32px;
            }
            #checker-next-displayBox #features-section > div[id] > span { min-width: 0; overflow-wrap: anywhere; }
            #checker-next-displayBox #chatgpt-fake-plan-container > span {
                display: flex;
                gap: 6px;
                align-items: center;
                white-space: nowrap;
            }
            #checker-next-displayBox #chatgpt-fake-plan-container select { flex: 1; width: 0 !important; }
            #checker-next-displayBox label:has(> input[id$="-toggle"]) {
                flex: none;
                width: 30px !important;
                height: 18px !important;
                margin: 0;
                border: 0;
                padding: 0;
                line-height: 1;
            }
            #checker-next-displayBox input[id$="-toggle"] {
                position: absolute;
                inset: -6px 0;
                width: 100% !important;
                height: 30px !important;
                margin: 0;
                z-index: 1;
                cursor: pointer;
            }
            #checker-next-displayBox [id$="-slider"] { transition: background-color .15s ease !important; }
            #checker-next-displayBox [id$="-slider-dot"] {
                width: 12px !important;
                height: 12px !important;
                transition: transform .15s ease !important;
            }
            #checker-next-displayBox input[type="checkbox"]:focus-visible + span {
                outline: 2px solid var(--checker-focus);
                outline-offset: 3px;
            }
            #checker-next-displayBox label:has(> input:disabled) { opacity: .45; }
            #checker-next-displayBox input:disabled { cursor: default; }
            #checker-next-displayBox .codex-window-row + .codex-window-row { margin-top: 10px; }
            #checker-next-displayBox .codex-window-heading { display: flex; align-items: baseline; gap: 8px; }
            #checker-next-displayBox .codex-window-label { flex: 1; min-width: 0; font-size: 12px; overflow-wrap: anywhere; }
            #checker-next-displayBox .codex-window-percent { flex: none; font-size: 12px; color: var(--checker-muted); }
            #checker-next-displayBox .codex-window-usage { color: var(--checker-text); }
            #checker-next-displayBox .codex-window-track { height: 5px; margin: 5px 0; background: var(--checker-track); border-radius: 3px; overflow: hidden; }
            #checker-next-displayBox .codex-window-reset { color: var(--checker-muted); font-size: 11px; overflow-wrap: anywhere; }
            #checker-next-displayBox :is(#codex-reset-credits-container, #codex-credits-container) { margin-top: 12px !important; }
            #checker-next-displayBox a { color: var(--checker-link); }
            #checker-next-displayBox .checker-footer { font-size: 10px; line-height: 1.5; margin-top: 14px; padding-top: 10px; border-top: 1px solid var(--checker-border); color: var(--checker-muted); text-align: center; }
            #checker-next-displayBox .checker-footer a { color: inherit; }
            #checker-next-displayBox .checker-header { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 12px; }
            #checker-next-displayBox .checker-header strong { font-size: 16px; }
            #checker-next-displayBox .checker-button {
                appearance: none; font: inherit; font-size: 12px; line-height: 1.4; color: var(--checker-text);
                border: 1px solid var(--checker-border); border-radius: 6px; padding: 6px 10px;
                background: var(--checker-background); cursor: pointer; min-height: 30px;
            }
            #checker-next-displayBox .checker-button:hover { background: var(--checker-surface); }
            #checker-next-displayBox .checker-button:disabled { opacity: .55; cursor: default; }
            #checker-next-displayBox :is(button, summary, input):focus-visible { outline: 2px solid var(--checker-focus); outline-offset: 2px; }
            #checker-next-displayBox .checker-settings { background: var(--checker-surface); border: 1px solid var(--checker-border); padding: 12px; border-radius: 8px; margin-bottom: 14px; }
            #checker-next-displayBox .checker-theme-row { display: grid; grid-template-columns: auto minmax(0, 1fr); align-items: center; gap: 12px; margin-bottom: 12px; }
            #checker-next-displayBox .checker-settings fieldset { min-width: 0; padding: 0; margin: 0 0 10px; border: 0; }
            #checker-next-displayBox .checker-settings legend { font-size: 12px; font-weight: 600; margin-bottom: 6px; padding: 0; }
            #checker-next-displayBox .checker-analytics-settings { margin: 12px 0; padding: 12px 0; border-top: 1px solid var(--checker-border); border-bottom: 1px solid var(--checker-border); }
            #checker-next-displayBox .checker-analytics-fields { display: grid; grid-template-columns: minmax(0, 1fr) 88px; gap: 8px 10px; align-items: center; font-size: 12px; margin: 8px 0; }
            #checker-next-displayBox .checker-analytics-fields input { width: 100%; min-width: 0; height: 30px; border: 1px solid var(--checker-border); border-radius: 6px; padding: 4px 8px; color: var(--checker-text); background: var(--checker-background); font: inherit; }
            #checker-next-displayBox input[aria-invalid="true"] { border-color: var(--checker-error); }
            #checker-next-displayBox .codex-section-title { display: flex; align-items: center; }
            #checker-next-displayBox #checker-open-analytics { margin-left: auto; font-size: 11px; }
            #checker-next-displayBox .checker-settings-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 2px 10px; }
            #checker-next-displayBox .checker-setting-option { display: flex; align-items: center; gap: 6px; min-height: 30px; font-size: 12px; line-height: 1.5; cursor: pointer; }
            #checker-next-displayBox .checker-setting-option input { appearance: auto; position: static; opacity: 1; width: 14px; height: 14px; margin: 0; flex: none; accent-color: var(--checker-focus); cursor: pointer; }
            #checker-next-displayBox .checker-note { color: var(--checker-muted); font-size: 11px; line-height: 1.6; margin: 6px 0 0; overflow-wrap: anywhere; }
            #checker-next-displayBox .checker-error { color: var(--checker-error); }
            #checker-next-displayBox .checker-more-details { margin-top: 14px; padding-top: 12px; border-top: 1px solid var(--checker-border); }
            #checker-next-displayBox summary { display: list-item; cursor: pointer; font-size: 12px; padding: 4px 0; }
            #checker-next-displayBox .checker-more-details > summary { font-size: 13px; font-weight: 650; }
            #checker-next-displayBox .checker-details-toolbar { margin-top: 8px; }
            #checker-next-displayBox .checker-detail-section { padding-top: 12px; }
            #checker-next-displayBox .checker-detail-section + .checker-detail-section { margin-top: 12px; border-top: 1px solid var(--checker-border); }
            #checker-next-displayBox .checker-data-list { display: grid; grid-template-columns: minmax(0, .8fr) minmax(0, 1.2fr); gap: 5px 10px; margin: 8px 0 0; font-size: 12px; }
            #checker-next-displayBox .checker-data-list dt { color: var(--checker-muted); }
            #checker-next-displayBox .checker-data-list dd { margin: 0; text-align: right; overflow-wrap: anywhere; }
            #checker-next-displayBox progress { appearance: none; display: block; width: 100%; height: 5px; margin: 10px 0; border: 0; border-radius: 4px; overflow: hidden; background: var(--checker-track); }
            #checker-next-displayBox progress::-webkit-progress-bar { background: var(--checker-track); }
            #checker-next-displayBox progress::-webkit-progress-value { background: var(--checker-accent); }
            #checker-next-displayBox progress::-moz-progress-bar { background: var(--checker-accent); }
            #checker-next-displayBox .checker-daily-table { width: 100%; border-collapse: collapse; font-size: 11px; font-variant-numeric: tabular-nums; }
            #checker-next-displayBox .checker-daily-table :is(th, td) { padding: 5px 2px; text-align: right; border-bottom: 1px solid var(--checker-border); overflow-wrap: anywhere; }
            #checker-next-displayBox .checker-daily-table :is(th, td):first-child { text-align: left; }
            #checker-next-displayBox .checker-daily-table caption { text-align: left; padding: 6px 0; color: var(--checker-muted); }
            #checker-next-displayBox .checker-valuation-table { table-layout: fixed; }
            #checker-next-displayBox .checker-valuation-table :is(th, td):first-child { width: 31%; }
            #checker-next-displayBox .checker-valuation-table :is(th, td):last-child { width: 16%; }
            #checker-next-displayBox .checker-valuation-table tfoot { font-weight: 600; }
            #checker-next-displayBox .checker-today-label { display: block; color: var(--checker-muted); font-size: 10px; }
            #checker-next-displayBox#checker-next-displayBox[data-mode] [data-checker-hidden="true"],
            #checker-next-displayBox [hidden] { display: none !important; }
            @media (prefers-reduced-motion: reduce) {
                #checker-next-displayBox, #checker-next-displayBox *, #status-icon { transition: none !important; }
            }
        </style>
        <div class="checker-header">
            <strong>${isGrokMode ? "Grok" : isCodexMode ? "Codex" : "ChatGPT"}</strong>
            <button type="button" class="checker-button" id="checker-settings-button" aria-expanded="false" aria-controls="checker-settings">设置</button>
        </div>
        <div id="checker-settings" class="checker-settings" hidden>
            <div class="checker-theme-row">
                <label for="checker-theme">主题</label>
                <select id="checker-theme"><option value="light">白色</option><option value="dark">深色</option><option value="system">跟随系统</option></select>
            </div>
            <fieldset><legend>显示内容</legend><div class="checker-settings-grid">
                ${CHECKER_DISPLAY_ITEMS.filter(([, , , mode]) => checkerItemApplies(mode)).map(([key, label]) => `<label class="checker-setting-option"><input type="checkbox" id="checker-show-${key}"><span>${label}</span></label>`).join("")}
            </div></fieldset>
            <form id="checker-analytics-settings" class="checker-analytics-settings" novalidate ${isGrokMode ? "hidden" : ""}>
                <strong>积分统计</strong>
                <div class="checker-analytics-fields">
                    <label for="checker-usd-rate">USD / 1,000 积分</label><input id="checker-usd-rate" type="number" min="0" max="1000000" step="any" aria-describedby="checker-analytics-note checker-settings-status">
                    <label for="checker-history-days">历史天数</label><input id="checker-history-days" type="number" min="1" max="365" step="1" aria-describedby="checker-settings-status">
                </div>
                <button class="checker-button" type="submit">保存统计设置</button>
                <p class="checker-note" id="checker-analytics-note">旧脚本默认 40 USD / 1,000 积分，仅用于估值，可自行修改；不是官方报价。</p>
            </form>
            <button type="button" class="checker-button" id="checker-settings-reset">恢复默认设置</button>
            <p class="checker-note" id="checker-settings-status" role="status">只调整面板显示，不改变功能开关。</p>
        </div>
        <p class="checker-note" id="checker-empty" hidden>内容已全部隐藏，可在设置中重新开启。</p>
        <div id="pow-section">
            <div id="checker-pow-row">
            PoW难度：<span id="difficulty">...</span><span id="difficulty-level" style="margin-left: 3px"></span>
            <span id="difficulty-tooltip" style="
                cursor: pointer;
                color: #fff;
                font-size: 12px;
                display: inline-block;
                width: 14px;
                height: 14px;
                line-height: 14px;
                text-align: center;
                border-radius: 50%;
                border: 1px solid #fff;
                margin-left: 3px;
            ">?</span></div>
            <span id="persona-container" style="display: block">用户类型：<span id="persona">...</span></span>
            <span id="user-region-container" style="display: block">用户地区：<span id="user-region">${userRegionValue || "..."}</span></span>
            <span id="price-region-container" style="display: block">价格地区：<span id="price-region">${priceRegionCode || "..."}</span></span>
        </div>
        <div id="chatgpt-runtime-model-section" style="margin-top: 10px;">
            <div style="margin-bottom: 4px;">
                <strong>模型</strong>
                <span id="chatgpt-runtime-model-tooltip" style="
                    cursor: pointer;
                    color: #fff;
                    font-size: 12px;
                    display: inline-block;
                    width: 14px;
                    height: 14px;
                    line-height: 14px;
                    text-align: center;
                    border-radius: 50%;
                    border: 1px solid #fff;
                    margin-left: 3px;
                ">?</span>
            </div>
            <div style="display: grid; grid-template-columns: 44px minmax(0, 1fr); gap: 4px; align-items: center;">
                <label for="chatgpt-runtime-origin">模式</label>
                <select id="chatgpt-runtime-origin">
                    <option value="chat">Chat</option>
                    <option value="work">Work</option>
                </select>
                <label for="chatgpt-runtime-model">模型</label>
                <select id="chatgpt-runtime-model" aria-describedby="chatgpt-runtime-model-detail">
                    <option value="" disabled selected>读取中…</option>
                    <option value="${CHATGPT_RUNTIME_CUSTOM_VALUE}">自定义…</option>
                </select>
                <div id="chatgpt-runtime-model-detail" class="checker-select-detail"></div>
                <label for="chatgpt-runtime-thinking">思考</label>
                <select id="chatgpt-runtime-thinking">
                    <option value="" disabled selected>读取中…</option>
                    <option value="${CHATGPT_RUNTIME_CUSTOM_VALUE}">自定义…</option>
                </select>
            </div>
        </div>
        <div id="deep-research-section" style="margin-top: 10px; display: none">
            <div style="margin-top: 10px; margin-bottom: 2px;">
                <strong>深度研究</strong>
            </div>
            剩余次数：<span id="deep-research-usage">...</span><br>
            重置时间：<span id="deep-research-reset-time">...</span>
        </div>
        <div id="image-gen-section" style="margin-top: 10px; display: none">
            <div style="margin-top: 10px; margin-bottom: 2px;">
                <strong>图片生成</strong>
            </div>
            剩余次数：<span id="image-gen-usage">...</span><br>
            重置时间：<span id="image-gen-reset-time">...</span>
        </div>
        <div id="file-upload-section" style="margin-top: 10px; display: none">
            <div style="margin-top: 10px; margin-bottom: 2px;">
                <strong>文件上传</strong>
            </div>
            剩余次数：<span id="file-upload-usage">...</span><br>
            重置时间：<span id="file-upload-reset-time">...</span>
        </div>
        <div id="paste-text-to-file-section" style="margin-top: 10px; display: none">
            <div style="margin-top: 10px; margin-bottom: 2px;">
                <strong>粘贴文本为文件</strong>
            </div>
            剩余次数：<span id="paste-text-to-file-usage">...</span><br>
            重置时间：<span id="paste-text-to-file-reset-time">...</span>
        </div>
        <div id="memory-section" style="margin-top: 10px; display: none">
            <div style="margin-top: 10px; margin-bottom: 2px;">
                <strong>模型记忆</strong>
            </div>
            记忆容量：<span id="memory-usage">...</span>
        </div>
        <div id="codex-section" style="margin-top: 10px; display: none">
            <div class="codex-section-title" style="margin-bottom: 8px;">
                <strong>Codex</strong>
                <span id="codex-tooltip" style="
                    cursor: pointer;
                    color: #fff;
                    font-size: 12px;
                    display: inline-block;
                    width: 14px;
                    height: 14px;
                    line-height: 14px;
                    text-align: center;
                    border-radius: 50%;
                    border: 1px solid #fff;
                    margin-left: 3px;
                ">?</span>
                <button type="button" class="checker-button" id="checker-open-analytics">积分分析</button>
            </div>
            <div id="codex-windows-container">${isChatgptMode ? '<a href="#settings/Usage">查看用量</a>' : "额度：..."}</div>
            <div id="codex-credits-container" style="margin-top: 10px; display: none;">
                <div style="margin-bottom: 2px;">
                    <strong>积分</strong>
                    <span id="codex-credits-tooltip" style="
                        cursor: pointer;
                        color: #fff;
                        font-size: 12px;
                        display: inline-block;
                        width: 14px;
                        height: 14px;
                        line-height: 14px;
                        text-align: center;
                        border-radius: 50%;
                        border: 1px solid #fff;
                        margin-left: 3px;
                    ">?</span>
                </div>
                剩余积分：<span id="codex-credits-value">...</span>
            </div>
            <div id="codex-reset-credits-container" style="margin-top: 10px; display: none;">
                <div style="margin-bottom: 2px;">
                    <strong>重置机会</strong>
                </div>
                可用次数：<span id="codex-reset-credits-count">...</span>
                <div id="codex-reset-credits-expirations" style="margin-top: 2px; white-space: pre-line;"></div>
                <a id="codex-reset-credits-link" href="${isCodexMode ? "/#settings/Usage" : "#settings/Usage"}" style="display: none; margin-top: 2px;">查看到期时间</a>
            </div>
        </div>
        <div id="grok-section" style="margin-top: 10px; display: none">
            <div style="margin-bottom: 2px;">
                <strong>Grok</strong>
            </div>
            Grok订阅：<span id="grok-active-subscriptions">...</span><br>
            X订阅：<span id="grok-x-subscription-type">...</span><br>
            账号地区：<span id="grok-country-code">...</span><br>
            可用模型：<span id="grok-available-models">...</span>
            <div id="grok-usage-section" style="margin-top: 10px; display: none;">
                <div style="margin-bottom: 2px;">
                    <strong>用量</strong>
                </div>
                <div id="grok-rate-limit-container" style="display: none;">模型额度：<span id="grok-rate-limit">...</span></div>
                <div id="grok-storage-container" style="display: none;">存储：<span id="grok-storage">...</span></div>
                <div id="grok-automations-container" style="display: none;">自动化：<span id="grok-automations">...</span></div>
            </div>
            <div style="margin-top: 10px; margin-bottom: 2px;">
                <strong>功能</strong>
                <span id="grok-feature-tooltip" style="
                    cursor: pointer;
                    color: #fff;
                    font-size: 12px;
                    display: inline-block;
                    width: 14px;
                    height: 14px;
                    line-height: 14px;
                    text-align: center;
                    border-radius: 50%;
                    border: 1px solid #fff;
                    margin-left: 3px;
                ">?</span>
            </div>
            <div id="grok-dev-tools-container" style="display: flex; align-items: center; justify-content: space-between;">
                <span>开发工具：<span id="grok-dev-tools-status">...</span>
                <span id="grok-dev-tools-tooltip" style="
                    cursor: pointer;
                    color: #fff;
                    font-size: 12px;
                    display: inline-block;
                    width: 14px;
                    height: 14px;
                    line-height: 14px;
                    text-align: center;
                    border-radius: 50%;
                    border: 1px solid #fff;
                    margin-left: 3px;
                ">?</span></span>
                <label style="position: relative; display: inline-block; width: 28px; height: 16px; cursor: pointer;">
                    <input type="checkbox" id="grok-dev-tools-toggle" style="opacity: 0; width: 0; height: 0;">
                    <span id="grok-dev-tools-slider" style="
                        position: absolute;
                        cursor: pointer;
                        top: 0;
                        left: 0;
                        right: 0;
                        bottom: 0;
                        background-color: var(--checker-switch);
                        transition: 0.3s;
                        border-radius: 16px;
                    "></span>
                    <span id="grok-dev-tools-slider-dot" style="
                        position: absolute;
                        content: '';
                        height: 10px;
                        width: 10px;
                        left: 3px;
                        bottom: 3px;
                        background-color: white;
                        transition: 0.3s;
                        border-radius: 50%;
                    "></span>
                </label>
            </div>
            <div id="grok-async-chat-container" style="display: flex; align-items: center; justify-content: space-between;">
                <span>异步聊天：<span id="grok-async-chat-status">...</span>
                <span id="grok-async-chat-tooltip" style="
                    cursor: pointer;
                    color: #fff;
                    font-size: 12px;
                    display: inline-block;
                    width: 14px;
                    height: 14px;
                    line-height: 14px;
                    text-align: center;
                    border-radius: 50%;
                    border: 1px solid #fff;
                    margin-left: 3px;
                ">?</span></span>
                <label style="position: relative; display: inline-block; width: 28px; height: 16px; cursor: pointer;">
                    <input type="checkbox" id="grok-async-chat-toggle" style="opacity: 0; width: 0; height: 0;">
                    <span id="grok-async-chat-slider" style="
                        position: absolute;
                        cursor: pointer;
                        top: 0;
                        left: 0;
                        right: 0;
                        bottom: 0;
                        background-color: var(--checker-switch);
                        transition: 0.3s;
                        border-radius: 16px;
                    "></span>
                    <span id="grok-async-chat-slider-dot" style="
                        position: absolute;
                        content: '';
                        height: 10px;
                        width: 10px;
                        left: 3px;
                        bottom: 3px;
                        background-color: white;
                        transition: 0.3s;
                        border-radius: 50%;
                    "></span>
                </label>
            </div>
            <div id="grok-early-access-container" style="display: flex; align-items: center; justify-content: space-between;">
                <span>抢先体验模型：<span id="grok-early-access-status">...</span>
                <span id="grok-early-access-tooltip" style="
                    cursor: pointer;
                    color: #fff;
                    font-size: 12px;
                    display: inline-block;
                    width: 14px;
                    height: 14px;
                    line-height: 14px;
                    text-align: center;
                    border-radius: 50%;
                    border: 1px solid #fff;
                    margin-left: 3px;
                ">?</span></span>
                <label style="position: relative; display: inline-block; width: 28px; height: 16px; cursor: pointer;">
                    <input type="checkbox" id="grok-early-access-toggle" style="opacity: 0; width: 0; height: 0;">
                    <span id="grok-early-access-slider" style="
                        position: absolute;
                        cursor: pointer;
                        top: 0;
                        left: 0;
                        right: 0;
                        bottom: 0;
                        background-color: var(--checker-switch);
                        transition: 0.3s;
                        border-radius: 16px;
                    "></span>
                    <span id="grok-early-access-slider-dot" style="
                        position: absolute;
                        content: '';
                        height: 10px;
                        width: 10px;
                        left: 3px;
                        bottom: 3px;
                        background-color: white;
                        transition: 0.3s;
                        border-radius: 50%;
                    "></span>
                </label>
            </div>
            <div id="grok-all-models-container" style="display: flex; align-items: center; justify-content: space-between;">
                <span>解锁所有模型
                <span id="grok-all-models-tooltip" style="
                    cursor: pointer;
                    color: #fff;
                    font-size: 12px;
                    display: inline-block;
                    width: 14px;
                    height: 14px;
                    line-height: 14px;
                    text-align: center;
                    border-radius: 50%;
                    border: 1px solid #fff;
                    margin-left: 3px;
                ">?</span></span>
                <label style="position: relative; display: inline-block; width: 28px; height: 16px; cursor: pointer;">
                    <input type="checkbox" id="grok-all-models-toggle" style="opacity: 0; width: 0; height: 0;">
                    <span id="grok-all-models-slider" style="
                        position: absolute;
                        cursor: pointer;
                        top: 0;
                        left: 0;
                        right: 0;
                        bottom: 0;
                        background-color: var(--checker-switch);
                        transition: 0.3s;
                        border-radius: 16px;
                    "></span>
                    <span id="grok-all-models-slider-dot" style="
                        position: absolute;
                        content: '';
                        height: 10px;
                        width: 10px;
                        left: 3px;
                        bottom: 3px;
                        background-color: white;
                        transition: 0.3s;
                        border-radius: 50%;
                    "></span>
                </label>
            </div>
            ${grokMemberships
                .map(
                    ({ id, label }) => `
            <div id="${id}-container" style="display: flex; align-items: center; justify-content: space-between;">
                <span>假装 ${label}：<span id="${id}-status">...</span></span>
                <label style="position: relative; display: inline-block; width: 28px; height: 16px; cursor: pointer;">
                    <input type="checkbox" id="${id}-toggle" style="opacity: 0; width: 0; height: 0;">
                    <span id="${id}-slider" style="
                        position: absolute;
                        cursor: pointer;
                        top: 0;
                        left: 0;
                        right: 0;
                        bottom: 0;
                        background-color: var(--checker-switch);
                        transition: 0.3s;
                        border-radius: 16px;
                    "></span>
                    <span id="${id}-slider-dot" style="
                        position: absolute;
                        content: '';
                        height: 10px;
                        width: 10px;
                        left: 3px;
                        bottom: 3px;
                        background-color: white;
                        transition: 0.3s;
                        border-radius: 50%;
                    "></span>
                </label>
            </div>`,
                )
                .join("")}
        </div>
        <div id="features-section" style="margin-top: 10px; display: none">
            <div style="margin-top: 10px; margin-bottom: 2px;">
                <strong>功能</strong>
                <span id="features-tooltip" style="
                    cursor: pointer;
                    color: #fff;
                    font-size: 12px;
                    display: inline-block;
                    width: 14px;
                    height: 14px;
                    line-height: 14px;
                    text-align: center;
                    border-radius: 50%;
                    border: 1px solid #fff;
                    margin-left: 3px;
                ">?</span>
            </div>
            <div id="chatgpt-module-injection-container" style="display: flex; align-items: center; justify-content: space-between;">
                <span>模块连接：<span id="chatgpt-injection-status" style="color: var(--checker-muted);">检查中</span>
                <span id="chatgpt-module-injection-tooltip" style="
                    cursor: pointer;
                    color: #fff;
                    font-size: 12px;
                    display: inline-block;
                    width: 14px;
                    height: 14px;
                    line-height: 14px;
                    text-align: center;
                    border-radius: 50%;
                    border: 1px solid #fff;
                    margin-left: 3px;
                ">?</span></span>
                <label style="position: relative; display: inline-block; width: 28px; height: 16px; cursor: pointer;">
                    <input type="checkbox" id="chatgpt-module-injection-toggle" style="opacity: 0; width: 0; height: 0;">
                    <span id="chatgpt-module-injection-slider" style="
                        position: absolute;
                        cursor: pointer;
                        top: 0;
                        left: 0;
                        right: 0;
                        bottom: 0;
                        background-color: var(--checker-switch);
                        transition: 0.3s;
                        border-radius: 16px;
                    "></span>
                    <span id="chatgpt-module-injection-slider-dot" style="
                        position: absolute;
                        content: '';
                        height: 10px;
                        width: 10px;
                        left: 3px;
                        bottom: 3px;
                        background-color: white;
                        transition: 0.3s;
                        border-radius: 50%;
                    "></span>
                </label>
            </div>
            <div id="chatgpt-age-verification-container" style="display: flex; align-items: center; justify-content: space-between;">
                <span>年龄验证入口：<span id="chatgpt-age-verification-status">未读取</span>
                <span id="chatgpt-age-verification-tooltip" style="
                    cursor: pointer;
                    color: #fff;
                    font-size: 12px;
                    display: inline-block;
                    width: 14px;
                    height: 14px;
                    line-height: 14px;
                    text-align: center;
                    border-radius: 50%;
                    border: 1px solid #fff;
                    margin-left: 3px;
                ">?</span></span>
                <label style="position: relative; display: inline-block; width: 28px; height: 16px; cursor: pointer;">
                    <input type="checkbox" aria-label="在支持此字段的页面显示年龄验证入口" id="chatgpt-age-verification-toggle" style="opacity: 0; width: 0; height: 0;">
                    <span id="chatgpt-age-verification-slider" style="
                        position: absolute;
                        cursor: pointer;
                        top: 0;
                        left: 0;
                        right: 0;
                        bottom: 0;
                        background-color: var(--checker-switch);
                        transition: 0.3s;
                        border-radius: 16px;
                    "></span>
                    <span id="chatgpt-age-verification-slider-dot" style="
                        position: absolute;
                        content: '';
                        height: 10px;
                        width: 10px;
                        left: 3px;
                        bottom: 3px;
                        background-color: white;
                        transition: 0.3s;
                        border-radius: 50%;
                    "></span>
                </label>
            </div>
            <div id="chatgpt-copy-button-container" style="display: flex; align-items: center; justify-content: space-between;">
                <span>复制按钮
                <span id="chatgpt-copy-button-tooltip" style="
                    cursor: pointer;
                    color: #fff;
                    font-size: 12px;
                    display: inline-block;
                    width: 14px;
                    height: 14px;
                    line-height: 14px;
                    text-align: center;
                    border-radius: 50%;
                    border: 1px solid #fff;
                    margin-left: 3px;
                ">?</span></span>
                <label style="position: relative; display: inline-block; width: 28px; height: 16px; cursor: pointer;">
                    <input type="checkbox" id="chatgpt-copy-button-toggle" style="opacity: 0; width: 0; height: 0;">
                    <span id="chatgpt-copy-button-slider" style="
                        position: absolute;
                        cursor: pointer;
                        top: 0;
                        left: 0;
                        right: 0;
                        bottom: 0;
                        background-color: var(--checker-switch);
                        transition: 0.3s;
                        border-radius: 16px;
                    "></span>
                    <span id="chatgpt-copy-button-slider-dot" style="
                        position: absolute;
                        content: '';
                        height: 10px;
                        width: 10px;
                        left: 3px;
                        bottom: 3px;
                        background-color: white;
                        transition: 0.3s;
                        border-radius: 50%;
                    "></span>
                </label>
            </div>
            <div id="chatgpt-selection-popover-container" style="display: flex; align-items: center; justify-content: space-between;">
                <span>禁用划词悬浮窗
                <span id="chatgpt-selection-popover-tooltip" style="
                    cursor: pointer;
                    color: #fff;
                    font-size: 12px;
                    display: inline-block;
                    width: 14px;
                    height: 14px;
                    line-height: 14px;
                    text-align: center;
                    border-radius: 50%;
                    border: 1px solid #fff;
                    margin-left: 3px;
                ">?</span></span>
                <label style="position: relative; display: inline-block; width: 28px; height: 16px; cursor: pointer;">
                    <input type="checkbox" id="chatgpt-selection-popover-toggle" style="opacity: 0; width: 0; height: 0;">
                    <span id="chatgpt-selection-popover-slider" style="
                        position: absolute;
                        cursor: pointer;
                        top: 0;
                        left: 0;
                        right: 0;
                        bottom: 0;
                        background-color: var(--checker-switch);
                        transition: 0.3s;
                        border-radius: 16px;
                    "></span>
                    <span id="chatgpt-selection-popover-slider-dot" style="
                        position: absolute;
                        content: '';
                        height: 10px;
                        width: 10px;
                        left: 3px;
                        bottom: 3px;
                        background-color: white;
                        transition: 0.3s;
                        border-radius: 50%;
                    "></span>
                </label>
            </div>
            <div id="chatgpt-fake-plan-container" style="display: flex; align-items: center; justify-content: space-between;">
                <span>假装
                <select id="chatgpt-fake-plan-select" style="
                    background-color: #333;
                    color: #fff;
                    border: 0px;
                    border-radius: 4px;
                    padding: 4px 8px 4px 8px;
                    font-size: 11px;
                    cursor: pointer;
                    outline: none;
                    line-height: 1em;
                    width: 140px;
                    box-sizing: border-box;
                ">
                    <option value="" disabled>读取中…</option>
                </select>
                <span id="chatgpt-fake-plan-tooltip" style="
                    cursor: pointer;
                    color: #fff;
                    font-size: 12px;
                    display: inline-block;
                    width: 14px;
                    height: 14px;
                    line-height: 14px;
                    text-align: center;
                    border-radius: 50%;
                    border: 1px solid #fff;
                    margin-left: 3px;
                    margin-right: 2px;
                ">?</span></span>
                <label style="position: relative; display: inline-block; width: 28px; height: 16px; cursor: pointer;">
                    <input type="checkbox" id="chatgpt-fake-plan-toggle" style="opacity: 0; width: 0; height: 0;">
                    <span id="chatgpt-fake-plan-slider" style="
                        position: absolute;
                        cursor: pointer;
                        top: 0;
                        left: 0;
                        right: 0;
                        bottom: 0;
                        background-color: var(--checker-switch);
                        transition: 0.3s;
                        border-radius: 16px;
                    "></span>
                    <span id="chatgpt-fake-plan-slider-dot" style="
                        position: absolute;
                        content: '';
                        height: 10px;
                        width: 10px;
                        left: 3px;
                        bottom: 3px;
                        background-color: white;
                        transition: 0.3s;
                        border-radius: 50%;
                    "></span>
                </label>
            </div>
        </div>
        <details id="checker-more-details" class="checker-more-details">
            <summary>详细信息</summary>
            <div class="checker-details-toolbar">
                <button type="button" class="checker-button" id="checker-details-refresh">刷新详情</button>
                <p class="checker-note">展开时读取已开启项目，其他数据随网页更新。</p>
            </div>
            ${["subscription", "storage", "estimate", "daily", "freshness"].map(key => `<section id="checker-${key}" class="checker-detail-section" aria-labelledby="checker-${key}-title"><strong id="checker-${key}-title">${key === "freshness" ? "最近成功读取" : CHECKER_DATA_LABELS[key]}</strong><div id="checker-${key}-body"></div></section>`).join("")}
        </details>
        <div class="checker-footer">
            <a href="https://github.com/zetaloop/chatgpt-checker-next" target="_blank" style="color: inherit; text-decoration: none;">ChatGPT Checker Next</a>${scriptVersion ? ` <span>v${scriptVersion}</span>` : ""}
    </div>`;
        displayBox.appendChild(contentWrapper);
        document.body.appendChild(displayBox);

        let displayBoxInitialized = false;
        const resizeObserver = new ResizeObserver(() => {
            if (!displayBoxInitialized) return;
            displayBox.style.height = `${contentWrapper.offsetHeight + 2}px`;
        });
        resizeObserver.observe(contentWrapper);

        // 如果之前弹窗正在显示，直接恢复显示状态（跳过动画）
        if (isDisplayBoxVisible) {
            displayBox.style.transition = "none";
            displayBox.style.height = `${contentWrapper.offsetHeight + 2}px`;
            displayBox.style.opacity = "1";
            displayBox.style.transform =
                "translateY(-50%) translateX(0) scale(1)";
            displayBox.style.pointerEvents = "auto";
            displayBox.offsetHeight; // 强制重绘
            displayBox.style.transition =
                "height 0.2s ease, opacity 0.06s ease-out, transform 0.06s ease-out";
            displayBoxInitialized = true;
        }

        // 创建收缩状态的指示器
        const collapsedIndicator = document.createElement("div");
        collapsedIndicator.id = "checker-next-open-panel";
        collapsedIndicator.tabIndex = 0;
        collapsedIndicator.setAttribute("role", "button");
        collapsedIndicator.setAttribute("aria-label", "打开 ChatGPT Checker Next");
        collapsedIndicator.setAttribute("aria-controls", displayBox.id);
        collapsedIndicator.setAttribute("aria-expanded", String(isDisplayBoxVisible));
        collapsedIndicator.style.position = "fixed";
        collapsedIndicator.style.boxSizing = "border-box";
        collapsedIndicator.style.opacity = isDisplayBoxVisible ? "0" : "1";
        collapsedIndicator.style.top = "50%";
        collapsedIndicator.style.right = "28px";
        collapsedIndicator.style.transform = "translateY(-50%)";
        collapsedIndicator.style.width = "32px";
        collapsedIndicator.style.height = "32px";
        collapsedIndicator.style.backgroundColor = "transparent";
        collapsedIndicator.style.borderRadius = "50%";
        collapsedIndicator.style.cursor = "pointer";
        collapsedIndicator.style.zIndex = "10000";
        collapsedIndicator.style.padding = "4px";
        collapsedIndicator.style.display = "flex";
        collapsedIndicator.style.alignItems = "center";
        collapsedIndicator.style.justifyContent = "center";
        collapsedIndicator.style.transition = "all 0.3s ease";

        // 使用SVG作为指示器
        collapsedIndicator.innerHTML = `
    <svg id="status-icon" width="32" height="32" viewBox="0 0 64 64" style="transition: all 0.3s ease;">
        <defs>
            <linearGradient id="gradient" x1="0%" y1="0%" x2="100%" y2="100%">
                <stop offset="0%" style="stop-color:#888;stop-opacity:1" />
                <stop offset="100%" style="stop-color:#666;stop-opacity:1" />
            </linearGradient>
            <filter id="glow">
                <feGaussianBlur stdDeviation="2" result="coloredBlur"/>
                <feMerge>
                    <feMergeNode in="coloredBlur"/>
                    <feMergeNode in="SourceGraphic"/>
                </feMerge>
            </filter>
        </defs>
        <g id="icon-group" filter="url(#glow)">
            <circle cx="32" cy="32" r="28" fill="url(#gradient)" stroke="#fff" stroke-width="2"/>
            <circle cx="32" cy="32" r="20" fill="none" stroke="#fff" stroke-width="2" stroke-dasharray="100">
                <animateTransform
                    attributeName="transform"
                    attributeType="XML"
                    type="rotate"
                    from="0 32 32"
                    to="360 32 32"
                    dur="8s"
                    repeatCount="indefinite"/>
            </circle>
            <circle cx="32" cy="32" r="12" fill="none" stroke="#fff" stroke-width="2">
                <animate
                    attributeName="r"
                    values="12;14;12"
                    dur="2s"
                    repeatCount="indefinite"/>
            </circle>
            <circle id="center-dot" cx="32" cy="32" r="4" fill="#fff">
                <animate
                    attributeName="r"
                    values="4;6;4"
                    dur="2s"
                    repeatCount="indefinite"/>
            </circle>
        </g>
    </svg>`;
        document.body.appendChild(collapsedIndicator);
        if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
            collapsedIndicator.querySelector("svg")?.pauseAnimations();
        }
        for (const toggle of displayBox.querySelectorAll('input[id$="-toggle"]')) {
            if (!toggle.hasAttribute("aria-label")) {
                const row = toggle.closest('div[id$="-container"]');
                const name = row?.querySelector(":scope > span")?.childNodes[0]?.textContent.trim().replace(/[：:]$/, "");
                toggle.setAttribute("aria-label", name || "切换功能");
            }
        }

        // 辅助函数
        function isPointInRect(x, y, rect) {
            return (
                x >= rect.left &&
                x <= rect.right &&
                y >= rect.top &&
                y <= rect.bottom
            );
        }

        function showDisplayBox() {
            // 打开时先禁用高度动画，设置正确高度
            displayBox.style.transition = "none";
            displayBox.style.height = `${contentWrapper.offsetHeight + 2}px`;
            // 强制重绘后启用所有动画
            displayBox.offsetHeight;
            displayBox.style.transition =
                "height 0.2s ease, opacity 0.06s ease-out, transform 0.06s ease-out";
            displayBox.style.opacity = "1";
            displayBox.style.transform =
                "translateY(-50%) translateX(0) scale(1)";
            displayBox.style.pointerEvents = "auto";
            displayBoxInitialized = true;
            isDisplayBoxVisible = true;
            displayBox.inert = false;
            collapsedIndicator.setAttribute("aria-expanded", "true");
            collapsedIndicator.tabIndex = -1;
            requestChatgptRuntimeModelState();
            collapsedIndicator.style.opacity = "0";
        }

        function hideDisplayBox() {
            displayBox.style.opacity = "0";
            displayBox.style.transform =
                "translateY(-50%) translateX(2px) scale(0.98)";
            displayBox.style.pointerEvents = "none";
            displayBoxInitialized = false;
            isDisplayBoxVisible = false;
            displayBox.inert = true;
            collapsedIndicator.setAttribute("aria-expanded", "false");
            collapsedIndicator.tabIndex = 0;
            collapsedIndicator.style.opacity = "1";
        }

        collapsedIndicator.addEventListener("click", showDisplayBox);
        collapsedIndicator.addEventListener("keydown", (event) => {
            if (event.key !== "Enter" && event.key !== " ") return;
            event.preventDefault();
            showDisplayBox();
            document.getElementById("checker-settings-button")?.focus();
        });
        displayBox.addEventListener("keydown", (event) => {
            if (event.key !== "Escape") return;
            hideDisplayBox();
            collapsedIndicator.focus();
        });

        // 在 window 级别监听 mousemove，仅在鼠标移动时检测
        // 使用捕获阶段，确保即使其他层阻止冒泡也能收到事件
        window.addEventListener(
            "mousemove",
            function (e) {
                const indicatorRect =
                    collapsedIndicator.getBoundingClientRect();
                const displayBoxRect = displayBox.getBoundingClientRect();

                const overIndicator = isPointInRect(
                    e.clientX,
                    e.clientY,
                    indicatorRect,
                );
                const overDisplayBox = isPointInRect(
                    e.clientX,
                    e.clientY,
                    displayBoxRect,
                );

                if (overIndicator && !isDisplayBoxVisible) {
                    showDisplayBox();
                } else if (
                    !overIndicator &&
                    !overDisplayBox &&
                    isDisplayBoxVisible &&
                    !displayBox.contains(document.activeElement)
                ) {
                    hideDisplayBox();
                }
            },
            true,
        );

        // 保留原有事件作为备用
        collapsedIndicator.addEventListener("mouseenter", function () {
            if (!isDisplayBoxVisible) {
                showDisplayBox();
            }
        });

        displayBox.addEventListener("mouseleave", function () {
            if (
                !displayBox.contains(document.activeElement)
            ) {
                hideDisplayBox();
            }
        });
        displayBox.addEventListener("change", function (event) {
            if (event.target instanceof HTMLSelectElement) {
                event.target.title = event.target.selectedOptions[0]?.textContent || "";
            }
        });
        displayBox.addEventListener(
            "wheel",
            function (event) {
                if (displayBox.scrollHeight <= displayBox.clientHeight) return;
                displayBox.scrollTop += event.deltaY;
                event.preventDefault();
                event.stopPropagation();
            },
            { passive: false },
        );

        function createTooltip(id, text) {
            const element = document.createElement("div");
            element.id = id;
            element.className = "checker-tooltip";
            element.innerText = text;
            Object.assign(element.style, {
                position: "fixed",
                backgroundColor: "var(--checker-background)",
                color: "var(--checker-text)",
                padding: "8px 12px",
                borderRadius: "5px",
                fontSize: "12px",
                visibility: "hidden",
                zIndex: "10001",
                width: "min(260px, calc(100vw - 24px))",
                maxHeight: "calc(100dvh - 24px)",
                overflowY: "auto",
                boxSizing: "border-box",
                border: "1px solid var(--checker-border)",
                boxShadow: "0 4px 16px rgb(0 0 0 / 12%)",
                overflowWrap: "anywhere",
                lineHeight: "1.4",
                pointerEvents: "none",
            });
            document.body.appendChild(element);
            return element;
        }

        const tooltip = createTooltip(
            "tooltip",
            "这个数值越大，相当于 ChatGPT 认为你的 IP 风险越低。",
        );

        // 创建 Codex 提示框
        const codexTooltipBox = createTooltip(
            "codex-tooltip-box",
            isCodexMode ? "首次使用后开始计时。" : "打开“使用情况”后加载。",
        );

        // 创建积分提示框
        const creditsTooltipBox = createTooltip(
            "credits-tooltip-box",
            "单独购买的积分，可用于 Codex 任务。",
        );

        // 创建 Grok 功能提示框
        const grokFeatureTooltipBox = createTooltip(
            "grok-feature-tooltip-box",
            "刷新页面生效。",
        );

        // 创建 Grok 开发工具提示框
        const grokDevToolsTooltipBox = createTooltip(
            "grok-dev-tools-tooltip-box",
            "本页会按 xAI 员工身份运行：显示 Dev Tools 与 Dev Flags，启用 Debug Menu、会话导出、Trace、Admin Inspect、Flags 覆盖、自定义模型 ID 及其他员工前端判断。前端 session 邮箱域名会改成 @x.ai，canUseDebugTools 与 show_model_config_override 会设为 true；不会修改账号资料或后端权限。True 表示三项均已载入。刷新页面生效。",
        );

        // 创建功能提示框
        const featuresTooltipBox = createTooltip(
            "features-tooltip-box",
            "刷新页面生效。",
        );

        const chatgptRuntimeModelTooltipBox = createTooltip(
            "chatgpt-runtime-model-tooltip-box",
            "乱改会触发风控。",
        );

        const chatgptModuleInjectionTooltipBox = createTooltip(
            "chatgpt-module-injection-tooltip-box",
            "正在检查 ChatGPT 模块补丁。",
        );
        chatgptModuleInjectionTooltipBox.style.whiteSpace = "pre-line";

        const chatgptCopyButtonTooltipBox = createTooltip(
            "chatgpt-copy-button-tooltip-box",
            "在右上角显示复制全文按钮。",
        );

        const chatgptSelectionPopoverTooltipBox = createTooltip(
            "chatgpt-selection-popover-tooltip-box",
            "不显示［询问 ChatGPT丨开始写作］。",
        );

        // 创建年龄验证提示框
        const chatgptAgeVerificationSettingTooltipBox = createTooltip(
            "chatgpt-age-verification-tooltip-box",
            "此项只表示是否显示年龄验证入口，不代表年龄或验证结果。未读取时可打开 ChatGPT 账户设置触发加载；页面未返回该字段时无法判断。",
        );

        // 创建假装会员提示框
        const chatgptFakePlanTooltipBox = createTooltip(
            "chatgpt-fake-plan-tooltip-box",
            "可能导致功能异常，不影响模型列表。",
        );

        // 创建 Grok 所有模型提示框
        const grokAllModelsTooltipBox = createTooltip(
            "grok-all-models-tooltip-box",
            "在界面上解锁不可用的模型，并没有实际作用。",
        );

        // 创建 Grok 抢先体验模型提示框
        const grokEarlyAccessTooltipBox = createTooltip(
            "grok-early-access-tooltip-box",
            "将用户设置里的 enableEarlyAccessModels 设为 true。",
        );

        // 创建 Grok 异步聊天提示框
        const grokAsyncChatTooltipBox = createTooltip(
            "grok-async-chat-tooltip-box",
            "将用户设置里的 isAsyncChat 设为 true。",
        );

        function bindTooltipEvents(triggerId, tooltipElement) {
            const trigger = document.getElementById(triggerId);
            if (!trigger || !tooltipElement) return;
            trigger.tabIndex = 0;
            trigger.setAttribute("role", "button");
            trigger.setAttribute("aria-label", "查看说明");
            trigger.setAttribute("aria-describedby", tooltipElement.id);
            tooltipElement.setAttribute("role", "tooltip");
            function show() {
                tooltipElement.style.visibility = "visible";
                const anchor = trigger.getBoundingClientRect();
                const box = tooltipElement.getBoundingClientRect();
                const leftPosition = Math.max(12, Math.min(anchor.left - box.width - 8, window.innerWidth - box.width - 12));
                const topPosition = Math.max(12, Math.min(anchor.top, window.innerHeight - box.height - 12));
                tooltipElement.style.left = `${leftPosition}px`;
                tooltipElement.style.top = `${topPosition}px`;
            }
            function hide() {
                tooltipElement.style.visibility = "hidden";
            }
            trigger.addEventListener("mouseenter", show);
            trigger.addEventListener("mouseleave", () => { if (document.activeElement !== trigger) hide(); });
            trigger.addEventListener("focus", show);
            trigger.addEventListener("blur", hide);
            trigger.addEventListener("click", show);
            trigger.addEventListener("keydown", (event) => {
                if (event.key === "Escape") hide();
                if (event.key === "Enter" || event.key === " ") { event.preventDefault(); show(); }
            });
        }

        function bindAllTooltips() {
            bindTooltipEvents("difficulty-tooltip", tooltip);
            bindTooltipEvents("codex-tooltip", codexTooltipBox);
            bindTooltipEvents("codex-credits-tooltip", creditsTooltipBox);
            bindTooltipEvents("grok-feature-tooltip", grokFeatureTooltipBox);
            bindTooltipEvents(
                "grok-all-models-tooltip",
                grokAllModelsTooltipBox,
            );
            bindTooltipEvents("grok-dev-tools-tooltip", grokDevToolsTooltipBox);
            bindTooltipEvents(
                "chatgpt-age-verification-tooltip",
                chatgptAgeVerificationSettingTooltipBox,
            );
            bindTooltipEvents(
                "chatgpt-fake-plan-tooltip",
                chatgptFakePlanTooltipBox,
            );
            bindTooltipEvents(
                "grok-early-access-tooltip",
                grokEarlyAccessTooltipBox,
            );
            bindTooltipEvents(
                "grok-async-chat-tooltip",
                grokAsyncChatTooltipBox,
            );
            bindTooltipEvents("features-tooltip", featuresTooltipBox);
            bindTooltipEvents(
                "chatgpt-runtime-model-tooltip",
                chatgptRuntimeModelTooltipBox,
            );
            bindTooltipEvents(
                "chatgpt-module-injection-tooltip",
                chatgptModuleInjectionTooltipBox,
            );
            bindTooltipEvents(
                "chatgpt-copy-button-tooltip",
                chatgptCopyButtonTooltipBox,
            );
            bindTooltipEvents(
                "chatgpt-selection-popover-tooltip",
                chatgptSelectionPopoverTooltipBox,
            );
        }

        function bindToggle(id, enabled, storageKey, setEnabled) {
            const toggle = document.getElementById(`${id}-toggle`);
            const slider = document.getElementById(`${id}-slider`);
            const sliderDot = document.getElementById(`${id}-slider-dot`);
            if (!toggle || !slider || !sliderDot) return;

            toggle.checked = enabled;
            updateGrokDevToolsSliderStyle(slider, sliderDot, enabled);
            toggle.addEventListener("change", function () {
                setEnabled(toggle.checked);
                localStorage.setItem(storageKey, String(toggle.checked));
                updateGrokDevToolsSliderStyle(
                    slider,
                    sliderDot,
                    toggle.checked,
                );
            });
        }

        function updateChatgptCopyButtonToggle() {
            const toggle = document.getElementById(
                "chatgpt-copy-button-toggle",
            );
            const slider = document.getElementById(
                "chatgpt-copy-button-slider",
            );
            const sliderDot = document.getElementById(
                "chatgpt-copy-button-slider-dot",
            );
            if (!(toggle instanceof HTMLInputElement) || !slider || !sliderDot)
                return;

            toggle.checked = chatgptCopyButtonEnabled;
            toggle.disabled = !chatgptModuleInjectionEnabled;
            updateGrokDevToolsSliderStyle(
                slider,
                sliderDot,
                chatgptModuleInjectionEnabled && chatgptCopyButtonEnabled,
            );
            syncChatgptCopyButton();
        }

        function bindChatgptModuleInjectionToggle() {
            const toggle = document.getElementById(
                "chatgpt-module-injection-toggle",
            );
            const slider = document.getElementById(
                "chatgpt-module-injection-slider",
            );
            const sliderDot = document.getElementById(
                "chatgpt-module-injection-slider-dot",
            );
            if (!(toggle instanceof HTMLInputElement) || !slider || !sliderDot)
                return;

            const apply = () => {
                updateGrokDevToolsSliderStyle(
                    slider,
                    sliderDot,
                    chatgptModuleInjectionEnabled,
                );
                updateChatgptCopyButtonToggle();
            };

            toggle.checked = chatgptModuleInjectionEnabled;
            apply();

            toggle.addEventListener("change", function () {
                chatgptModuleInjectionEnabled = toggle.checked;
                localStorage.setItem(
                    CHATGPT_MODULE_INJECTION_ENABLED_KEY,
                    String(chatgptModuleInjectionEnabled),
                );
                chatgptImportPatchFailure = undefined;
                chatgptImportPatchNeedsReload = false;

                if (chatgptModuleInjectionEnabled) {
                    chatgptPendingPatchSettings =
                        getChatgptImportPatchSettings();
                    chatgptImportPatchNeedsReload = !Reflect.get(
                        pageWindow,
                        "__checkerNextImportMapInstalled",
                    );
                    void prepareChatgptImportMapPatchCache();
                    requestChatgptRuntimeModelState();
                } else {
                    setChatgptImportMapPatchCache(null);
                    chatgptPendingPatchSettings = undefined;
                }

                apply();
                updateChatgptRuntimeModelControls();
            });
        }

        function bindChatgptCopyButtonToggle() {
            const toggle = document.getElementById(
                "chatgpt-copy-button-toggle",
            );
            if (!(toggle instanceof HTMLInputElement)) return;

            updateChatgptCopyButtonToggle();
            toggle.addEventListener("change", () => {
                chatgptCopyButtonEnabled = toggle.checked;
                localStorage.setItem(
                    CHATGPT_COPY_BUTTON_ENABLED_KEY,
                    String(chatgptCopyButtonEnabled),
                );
                updateChatgptCopyButtonToggle();
                updateChatgptInjectionStatus();
            });
        }

        function bindChatgptAgeVerificationSettingToggle() {
            const container = document.getElementById(
                "chatgpt-age-verification-container",
            );
            const toggle = document.getElementById(
                "chatgpt-age-verification-toggle",
            );
            const slider = document.getElementById(
                "chatgpt-age-verification-slider",
            );
            const sliderDot = document.getElementById(
                "chatgpt-age-verification-slider-dot",
            );
            const statusEl = document.getElementById(
                "chatgpt-age-verification-status",
            );
            if (!container || !toggle || !slider || !sliderDot || !statusEl)
                return;

            function apply() {
                updateChatgptAgeVerificationSettingStatus();
                updateGrokDevToolsSliderStyle(
                    slider,
                    sliderDot,
                    chatgptAgeVerificationSettingEnabled,
                );
            }

            toggle.checked = chatgptAgeVerificationSettingEnabled;
            apply();

            toggle.addEventListener("change", function () {
                chatgptAgeVerificationSettingEnabled = toggle.checked;
                localStorage.setItem(
                    CHATGPT_AGE_VERIFICATION_SETTING_KEY,
                    chatgptAgeVerificationSettingEnabled ? "true" : "false",
                );
                apply();
            });
        }

        function bindChatgptRuntimeModelControls() {
            const originElement = document.getElementById(
                "chatgpt-runtime-origin",
            );
            const modelElement = document.getElementById(
                "chatgpt-runtime-model",
            );
            const thinkingElement = document.getElementById(
                "chatgpt-runtime-thinking",
            );
            const originSelect =
                originElement instanceof HTMLSelectElement
                    ? originElement
                    : null;
            const modelSelect =
                modelElement instanceof HTMLSelectElement ? modelElement : null;
            const thinkingSelect =
                thinkingElement instanceof HTMLSelectElement
                    ? thinkingElement
                    : null;
            if (!originSelect || !modelSelect || !thinkingSelect) return;

            function apply(detail) {
                if (!chatgptModuleInjectionEnabled) return;
                pageWindow.dispatchEvent(
                    new pageWindow.CustomEvent(
                        CHATGPT_RUNTIME_MODEL_SET_EVENT,
                        { detail },
                    ),
                );
            }

            function bindCustomOption(select, promptText, onChange) {
                let previousValue = select.value;
                select.addEventListener("focus", () => {
                    previousValue = select.value;
                });
                select.addEventListener("change", () => {
                    if (select.value === CHATGPT_RUNTIME_CUSTOM_VALUE) {
                        const value = pageWindow
                            .prompt(promptText, previousValue)
                            ?.trim();
                        if (!value) {
                            select.value = previousValue;
                            return;
                        }
                        if (
                            ![...select.options].some(
                                (option) => option.value === value,
                            )
                        ) {
                            const option = document.createElement("option");
                            option.value = value;
                            option.textContent = value;
                            select.insertBefore(
                                option,
                                select.lastElementChild,
                            );
                        }
                        select.value = value;
                    }
                    previousValue = select.value;
                    onChange(select.value);
                });
            }

            originSelect.addEventListener("change", () => {
                modelSelect.value = "";
                thinkingSelect.value = "";
                updateChatgptRuntimeModelOptions();
                apply({ origin: originSelect.value });
            });
            bindCustomOption(modelSelect, "输入模型 slug", (model) => {
                thinkingSelect.value = "";
                updateChatgptRuntimeModelOptions();
                if (model) apply({ model });
            });
            bindCustomOption(
                thinkingSelect,
                "输入思考强度",
                (thinkingEffort) => {
                    apply({ thinkingEffort: thinkingEffort || null });
                },
            );

            updateChatgptRuntimeModelControls();
            requestChatgptRuntimeModelState();
        }

        function bindChatgptFakePlanSelect() {
            const select = document.getElementById("chatgpt-fake-plan-select");
            const toggle = document.getElementById("chatgpt-fake-plan-toggle");
            const slider = document.getElementById("chatgpt-fake-plan-slider");
            const sliderDot = document.getElementById(
                "chatgpt-fake-plan-slider-dot",
            );
            if (
                !(select instanceof HTMLSelectElement) ||
                !(toggle instanceof HTMLInputElement) ||
                !(slider instanceof HTMLElement) ||
                !(sliderDot instanceof HTMLElement)
            ) {
                return;
            }

            updateChatgptFakePlanControls();

            select.addEventListener("change", function () {
                const selectedPlan = getChatgptFakePlan(select.value);
                if (!selectedPlan) return;
                chatgptFakePlanValue = selectedPlan.subscriptionPlan;
                localStorage.setItem(
                    CHATGPT_FAKE_PLAN_KEY,
                    chatgptFakePlanValue,
                );
                updateChatgptFakePlanControls();
                void prepareChatgptImportMapPatchCache();
            });
            toggle.addEventListener("change", function () {
                chatgptFakePlanEnabled = toggle.checked;
                localStorage.setItem(
                    CHATGPT_FAKE_PLAN_ENABLED_KEY,
                    chatgptFakePlanEnabled ? "true" : "false",
                );
                updateChatgptFakePlanControls();
                void prepareChatgptImportMapPatchCache();
            });
        }

        if (isGrokMode) {
            bindToggle(
                "grok-dev-tools",
                grokDevToolsEnabled,
                GROK_DEV_TOOLS_KEY,
                (value) => {
                    grokDevToolsEnabled = value;
                },
            );
            bindToggle(
                "grok-all-models",
                grokAllModelsEnabled,
                GROK_ALL_MODELS_KEY,
                (value) => {
                    grokAllModelsEnabled = value;
                },
            );
            bindToggle(
                "grok-early-access",
                grokEarlyAccessEnabled,
                GROK_EARLY_ACCESS_KEY,
                (value) => {
                    grokEarlyAccessEnabled = value;
                },
            );
            bindToggle(
                "grok-async-chat",
                grokAsyncChatEnabled,
                GROK_ASYNC_CHAT_KEY,
                (value) => {
                    grokAsyncChatEnabled = value;
                },
            );
            for (const membership of grokMemberships) {
                bindToggle(
                    membership.id,
                    membership.enabled,
                    membership.storageKey,
                    (value) => {
                        membership.enabled = value;
                    },
                );
            }
            updateGrokDevToolsStatus();
            updateBooleanStatus(
                "grok-early-access-status",
                grokEarlyAccessDisplayValue,
            );
            updateBooleanStatus(
                "grok-async-chat-status",
                grokAsyncChatDisplayValue,
            );
            for (const membership of grokMemberships) {
                updateBooleanStatus(
                    `${membership.id}-status`,
                    grokMembershipValues.get(membership.field),
                );
            }
            updateGrokUserInfo();
            updateGrokModels();
            if (grokRateLimitData) {
                updateGrokRateLimit(grokRateLimitData, grokRateLimitModelName);
            }
            if (grokStorageUsageData) {
                updateGrokStorageUsage(grokStorageUsageData);
            }
            if (Number.isFinite(grokAutomationsCount)) {
                updateGrokAutomations({ workspaceTotal: grokAutomationsCount });
            }
        }

        if (isChatgptMode) {
            bindChatgptModuleInjectionToggle();
            bindChatgptCopyButtonToggle();
            bindToggle(
                "chatgpt-selection-popover",
                chatgptSelectionPopoverDisabled,
                CHATGPT_SELECTION_POPOVER_DISABLED_KEY,
                (value) => {
                    chatgptSelectionPopoverDisabled = value;
                    chatgptSelectionPopoverStyle.media = value
                        ? "all"
                        : "not all";
                },
            );
            bindChatgptRuntimeModelControls();
            bindChatgptAgeVerificationSettingToggle();
            bindChatgptFakePlanSelect();
        }
        bindAllTooltips();
        bindCheckerSettings();
    }

    // 创建元素
    createElements();

    // 使用 MutationObserver 观测 DOM 改动
    const observer = new MutationObserver(() => {
        if (!document.getElementById("checker-next-displayBox")) {
            createElements();
        }
        if (isChatgptMode) {
            syncChatgptCopyButton();
            chatgptNativeBridge?.sync();
        }
    });

    function startObserverWhenReady() {
        if (!document.body) {
            requestAnimationFrame(startObserverWhenReady);
            return;
        }
        observer.observe(document.body, { childList: true, subtree: true });
    }
    startObserverWhenReady();

    let powFetched = false;
    let codexFetched = false;

    // 更新difficulty指示器
    function updateDifficultyIndicator(difficulty) {
        const difficultyLevel = document.getElementById("difficulty-level");

        if (difficulty === "...") {
            setIconColors("#888", "#666");
            difficultyLevel.innerText = "";
            powFetched = false;
            const powSection = document.getElementById("pow-section");
            if (powSection && isCodexMode && codexFetched)
                powSection.style.display = "none";
            return;
        }

        const cleanDifficulty = difficulty.replace("0x", "").replace(/^0+/, "");
        const hexLength = cleanDifficulty.length;

        let color, secondaryColor, textColor, level;

        if (hexLength <= 2) {
            color = "#F44336";
            secondaryColor = "#d32f2f";
            textColor = "var(--checker-error)";
            level = "(风险)";
        } else if (hexLength === 3) {
            color = "#FFC107";
            secondaryColor = "#ffa000";
            textColor = "var(--checker-warning)";
            level = "(中等)";
        } else if (hexLength === 4) {
            color = "#8BC34A";
            secondaryColor = "#689f38";
            textColor = "var(--checker-success)";
            level = "(良好)";
        } else {
            color = "#4CAF50";
            secondaryColor = "#388e3c";
            textColor = "var(--checker-success)";
            level = "(优秀)";
        }

        setIconColors(color, secondaryColor);
        difficultyLevel.innerHTML = `<span style="color: ${textColor}">${level}</span>`;
        powFetched = true;
        const powSection = document.getElementById("pow-section");
        if (powSection) powSection.style.display = "block";
    }

    function setIconColors(primaryColor, secondaryColor) {
        const gradient = document.querySelector("#gradient");
        gradient.innerHTML = `
            <stop offset="0%" style="stop-color:${primaryColor};stop-opacity:1" />
            <stop offset="100%" style="stop-color:${secondaryColor};stop-opacity:1" />
        `;
    }

    // 更新 Codex 用量
    let codexUsageWindows = [];
    let codexCreditsVisible = false;
    let codexResetAvailableCount;
    let codexResetCredits;

    function isCodexWindowDuration(limitWindowSeconds, expectedSeconds) {
        return (
            Number.isFinite(limitWindowSeconds) &&
            limitWindowSeconds > 0 &&
            Math.abs(limitWindowSeconds - expectedSeconds) <=
                expectedSeconds * 0.05
        );
    }

    function formatCodexWindowLabel(name, limitWindowSeconds) {
        let period = "";
        if (isCodexWindowDuration(limitWindowSeconds, 5 * 60 * 60)) {
            period = "每5小时";
        } else if (
            isCodexWindowDuration(limitWindowSeconds, 30 * 24 * 60 * 60)
        ) {
            period = "每月";
        } else if (
            isCodexWindowDuration(limitWindowSeconds, 7 * 24 * 60 * 60)
        ) {
            period = "每周";
        } else if (isCodexWindowDuration(limitWindowSeconds, 24 * 60 * 60)) {
            period = "每天";
        } else if (
            Number.isFinite(limitWindowSeconds) &&
            limitWindowSeconds > 0
        ) {
            period = `每${formatCodexDuration(limitWindowSeconds, true)}`;
        }
        return period ? `${name} ${period}` : name;
    }

    function getCodexUsageWindows(data) {
        const windows = [];

        function appendWindow(window, name) {
            if (!window || typeof window !== "object") return;
            const limitWindowSeconds = Number.isFinite(
                window.limit_window_seconds,
            )
                ? window.limit_window_seconds
                : null;
            windows.push({
                label: formatCodexWindowLabel(name, limitWindowSeconds),
                usedPercent: Number.isFinite(window.used_percent)
                    ? Math.max(0, Math.min(100, window.used_percent))
                    : null,
                resetAfterSeconds: Number.isFinite(window.reset_after_seconds)
                    ? window.reset_after_seconds
                    : null,
                resetAt: Number.isFinite(window.reset_at)
                    ? window.reset_at * 1000
                    : null,
                limitWindowSeconds,
            });
        }

        function appendRateLimit(rateLimit, name) {
            if (!rateLimit || typeof rateLimit !== "object") return;
            appendWindow(rateLimit.primary_window, name);
            appendWindow(rateLimit.secondary_window, name);
        }

        appendRateLimit(data?.rate_limit, "代码");
        if (Array.isArray(data?.additional_rate_limits)) {
            for (const additionalRateLimit of data.additional_rate_limits) {
                const name =
                    typeof additionalRateLimit?.limit_name === "string" &&
                    additionalRateLimit.limit_name.trim()
                        ? additionalRateLimit.limit_name.trim()
                        : "附加用量";
                appendRateLimit(
                    additionalRateLimit?.rate_limit,
                    name === "GPT-5.3-Codex-Spark"
                        ? "Spark"
                        : name === "gpt-reserve"
                          ? "Reserve Luna"
                          : name,
                );
            }
        }
        appendWindow(data?.code_review_rate_limit?.primary_window, "代码审查");
        return windows;
    }

    function updateCodexDisplayState() {
        codexFetched =
            codexUsageWindows.length > 0 ||
            codexCreditsVisible ||
            codexResetAvailableCount != null ||
            (codexResetCredits?.length ?? 0) > 0;

        const section = document.getElementById("codex-section");
        if (section) {
            section.style.display = codexFetched ? "block" : "none";
            section.style.marginTop = powFetched ? "10px" : "0";
        }
        if (!codexFetched || !isCodexMode || powFetched) return;

        setIconColors("#C26FFD", "#A855F7");
        const powSection = document.getElementById("pow-section");
        if (powSection) powSection.style.display = "none";
    }

    function updateCodexInfo(windows) {
        const container = document.getElementById("codex-windows-container");
        if (!container || windows.length === 0) return;

        const now = Date.now();
        codexUsageWindows = windows.map((window) => ({
            ...window,
            resetTime:
                window.resetAfterSeconds != null
                    ? now + window.resetAfterSeconds * 1000
                    : window.resetAt,
            resetElement: null,
        }));
        container.replaceChildren();

        for (const [index, window] of codexUsageWindows.entries()) {
            const row = document.createElement("div");
            row.className = "codex-window-row";
            row.innerHTML = `
                <div class="codex-window-heading">
                    <span class="codex-window-label"></span>
                    <span class="codex-window-percent">已用 <span class="codex-window-usage">...</span></span>
                </div>
                <div class="codex-window-track">
                    <div class="codex-window-progress-bar" style="height: 100%; width: 0%; background: var(--checker-accent); border-radius: 4px;"></div>
                </div>
                <div class="codex-window-reset">重置：<span class="codex-window-reset-time">...</span></div>
            `;
            const usage = row.querySelector(".codex-window-usage");
            const label = row.querySelector(".codex-window-label");
            const bar = row.querySelector(".codex-window-progress-bar");
            const reset = row.querySelector(".codex-window-reset-time");
            if (!usage || !label || !bar || !reset) continue;

            usage.innerText =
                window.usedPercent == null ? "..." : `${window.usedPercent}%`;
            label.innerText = window.label;
            bar.style.width = `${window.usedPercent ?? 0}%`;
            window.resetElement = reset;
            container.appendChild(row);
        }

        updateCodexDisplayState();
        updateCodexCountdown();
    }

    function updateCodexCredits(credits) {
        const container = document.getElementById("codex-credits-container");
        const valueEl = document.getElementById("codex-credits-value");
        if (!container || !valueEl) return;
        const balanceRaw =
            credits &&
            (typeof credits.balance === "string"
                ? credits.balance.trim()
                : typeof credits.balance === "number"
                  ? String(credits.balance)
                  : "");
        if (Number(balanceRaw) > 0) {
            valueEl.innerText = balanceRaw;
            container.style.display = "block";
            codexCreditsVisible = true;
        } else {
            valueEl.innerText = "...";
            container.style.display = "none";
            codexCreditsVisible = false;
        }
        updateCodexDisplayState();
    }

    function updateCodexResetCredits(resetCredits) {
        if (!resetCredits || typeof resetCredits !== "object") return;

        if (Number.isFinite(resetCredits.available_count)) {
            codexResetAvailableCount = Math.max(
                0,
                Math.floor(resetCredits.available_count),
            );
        }
        if (Array.isArray(resetCredits.credits)) {
            codexResetCredits = resetCredits.credits.filter(
                (credit) => credit?.status === "available",
            );
        }

        const container = document.getElementById(
            "codex-reset-credits-container",
        );
        const count = document.getElementById("codex-reset-credits-count");
        const expirations = document.getElementById(
            "codex-reset-credits-expirations",
        );
        const detailsLink = document.getElementById("codex-reset-credits-link");
        if (!container || !count || !expirations || !detailsLink) return;

        const availableCredits = codexResetCredits ?? [];
        count.innerText = `${codexResetAvailableCount ?? availableCredits.length}次`;
        expirations.innerText = availableCredits
            .map(
                (credit, index) =>
                    `第${index + 1}次到期：${formatCodexAbsoluteTime(credit.expires_at) || "..."}`,
            )
            .join("\n");
        detailsLink.style.display =
            availableCredits.length === 0 && codexResetAvailableCount > 0
                ? "block"
                : "none";
        container.style.display = "block";
        updateCodexDisplayState();
    }

    function isCodexTimerNotStarted(limitSecs, resetAfterSecs) {
        return (
            limitSecs != null &&
            resetAfterSecs != null &&
            limitSecs === resetAfterSecs
        );
    }

    function formatCodexDuration(totalSecs, omitZeroUnits) {
        if (totalSecs == null) return "...";
        const t = Math.max(0, Math.floor(totalSecs));
        const d = Math.floor(t / 86400);
        const h = Math.floor((t % 86400) / 3600);
        const m = Math.floor((t % 3600) / 60);
        const s = t % 60;

        if (d >= 1) {
            const parts = [`${d}天`];
            if (!omitZeroUnits || h > 0) parts.push(`${h}小时`);
            if (!omitZeroUnits || m > 0) parts.push(`${m}分钟`);
            if (!omitZeroUnits || s > 0) parts.push(`${s}秒`);
            return parts.join("");
        } else {
            const parts = [];
            if (!omitZeroUnits || h > 0) parts.push(`${h}小时`);
            if (!omitZeroUnits || m > 0) parts.push(`${m}分钟`);
            if (!omitZeroUnits || s > 0) parts.push(`${s}秒`);
            return parts.length ? parts.join("") : "0秒";
        }
    }

    function formatCodexAbsoluteTime(timestampMs) {
        if (timestampMs == null) return "";
        const date = new Date(timestampMs);
        if (Number.isNaN(date.getTime())) return "";
        const year = date.getFullYear();
        const month = date.getMonth() + 1;
        const day = date.getDate();
        const hours = `${date.getHours()}`.padStart(2, "0");
        const minutes = `${date.getMinutes()}`.padStart(2, "0");
        const seconds = `${date.getSeconds()}`.padStart(2, "0");
        return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
    }

    function updateCodexCountdown() {
        if ((checkerSettings.visible.estimate || checkerSettings.visible.daily) && document.getElementById("checker-more-details")?.open) renderCheckerDetails();
        for (const window of codexUsageWindows) {
            const reset = window.resetElement;
            if (!reset) continue;

            const notStarted = isCodexTimerNotStarted(
                window.limitWindowSeconds,
                window.resetAfterSeconds,
            );
            if (window.usedPercent == null) {
                reset.innerText = "...";
            } else if (notStarted) {
                reset.innerHTML = `${formatCodexDuration(
                    window.limitWindowSeconds,
                    true,
                )}${NOT_STARTED_BADGE}`;
            } else if (window.resetTime != null) {
                const secs = Math.max(
                    0,
                    Math.floor((window.resetTime - Date.now()) / 1000),
                );
                reset.innerText = formatCodexDuration(secs, false);
            } else {
                reset.innerText = "...";
            }

            const tooltipText = formatCodexAbsoluteTime(window.resetAt);
            if (tooltipText) {
                reset.title = tooltipText;
            } else {
                reset.removeAttribute("title");
            }
        }
    }
    setInterval(updateCodexCountdown, 1000);

    function updateBooleanStatus(target, value) {
        const statusEl =
            typeof target === "string"
                ? document.getElementById(target)
                : target;
        if (!statusEl) return;
        if (value === true) {
            statusEl.innerHTML = '<span style="color: var(--checker-success);">True</span>';
        } else if (value === false) {
            statusEl.innerHTML = '<span style="color: var(--checker-error);">False</span>';
        } else {
            statusEl.innerText = "...";
        }
    }

    // 更新 ChatGPT 各自的开关状态显示
    function updateChatgptAgeVerificationSettingStatus(
        originalValue = undefined,
        wasModified = false,
        error = null,
    ) {
        if (!isChatgptMode) return;
        // Save before looking up the panel: a document-start response can arrive
        // before the UI exists. Missing/null/string values are never false.
        if (arguments.length > 0) {
            chatgptAgeVerificationSettingFetched = true;
            chatgptAgeVerificationSettingDisplayValue =
                typeof originalValue === "boolean" ? originalValue : null;
            chatgptAgeVerificationSettingWasModified = wasModified;
            chatgptAgeVerificationSettingError = error;
        }
        const statusEl = document.getElementById(
            "chatgpt-age-verification-status",
        );
        if (!statusEl) return;
        const value = chatgptAgeVerificationSettingDisplayValue;
        statusEl.textContent = chatgptAgeVerificationSettingError ? "读取失败" :
            !chatgptAgeVerificationSettingFetched ? "未读取" :
            value === null ? "未提供此字段" :
            chatgptAgeVerificationSettingWasModified ? "本地显示" :
            value ? "服务端显示" : "服务端隐藏";
        statusEl.style.color = "var(--checker-muted)";
        const toggle = document.getElementById("chatgpt-age-verification-toggle");
        if (toggle) {
            toggle.disabled = value === null;
            toggle.title = value === null ? "当前页面未提供可切换的入口字段" : "仅改变入口显示；切换后刷新页面生效";
        }
        const tooltip = document.getElementById("chatgpt-age-verification-tooltip-box");
        if (tooltip) {
            tooltip.textContent = "此项读取 show_age_verification_setting，只表示入口显示，不代表年龄或验证结果。" +
                (chatgptAgeVerificationSettingError ? ` 接口读取失败：${chatgptAgeVerificationSettingError}。` : "") +
                (chatgptAgeVerificationSettingFetched && value === null && !chatgptAgeVerificationSettingError ? " 当前响应未提供布尔字段，旧开关不适用。" : "") +
                " 开关仅在字段受支持时改变本地入口显示，切换后刷新生效；验证请使用 ChatGPT 官方流程。";
        }
    }

    function updateGrokDevToolsStatus() {
        if (!isGrokMode) return;

        const values = [
            grokModelConfigOverrideValue,
            grokXaiEmployeeValue,
            grokCanUseDebugToolsValue,
        ];
        updateBooleanStatus(
            "grok-dev-tools-status",
            values.every((value) => value === true)
                ? true
                : values.some((value) => value === false)
                  ? false
                  : undefined,
        );
    }

    function updateGrokUserInfo() {
        if (!isGrokMode) return;

        const activeSubsEl = document.getElementById(
            "grok-active-subscriptions",
        );
        const subTypeEl = document.getElementById("grok-x-subscription-type");
        const countryEl = document.getElementById("grok-country-code");

        if (activeSubsEl) {
            if (
                grokActiveSubscriptions &&
                Array.isArray(grokActiveSubscriptions)
            ) {
                if (grokActiveSubscriptions.length === 0) {
                    activeSubsEl.innerText = "无";
                } else {
                    activeSubsEl.innerText = grokActiveSubscriptions.join("、");
                }
            } else if (!grokUserInfoFetched) {
                activeSubsEl.innerText = "...";
            }
        }

        if (subTypeEl) {
            if (grokXSubscriptionType) {
                subTypeEl.innerText = grokXSubscriptionType;
            } else if (!grokUserInfoFetched) {
                subTypeEl.innerText = "...";
            }
        }

        if (countryEl) {
            if (grokCountryCode) {
                countryEl.innerText = grokCountryCode;
            } else if (!grokUserInfoFetched) {
                countryEl.innerText = "...";
            }
        }
    }

    function processGrokModes(data) {
        if (!Array.isArray(data?.modes)) return false;

        let modified = false;
        grokModeTitles = new Map();
        for (const mode of data.modes) {
            if (!mode || typeof mode.id !== "string") continue;
            const title =
                typeof mode.title === "string" && mode.title
                    ? mode.title
                    : mode.id;
            grokModeTitles.set(mode.id, title);
            if (
                grokAllModelsEnabled &&
                mode.availability?.available === undefined
            ) {
                mode.availability = { available: {} };
                modified = true;
            }
        }

        grokAvailableModels = data.modes
            .filter((mode) => mode?.availability?.available !== undefined)
            .map((mode) => `${grokModeTitles.get(mode.id)} (${mode.id})`);
        grokModelsFetched = true;
        updateGrokModels();
        return modified;
    }

    function updateGrokModels() {
        if (!isGrokMode) return;

        const modelsEl = document.getElementById("grok-available-models");
        if (!modelsEl) return;

        if (grokAvailableModels && Array.isArray(grokAvailableModels)) {
            const formattedModels = grokAvailableModels.map((model) => {
                const match = model.match(/^(.+?)(\s*\([^)]+\))$/);
                if (match) {
                    return `${match[1]}<span style="color: var(--checker-muted); font-size: 9px;">${match[2]}</span>`;
                }
                return model;
            });
            modelsEl.innerHTML = `<div style="display: block; padding-left: 0.5em; font-size: 12px; line-height: 1.2;">${formattedModels.join("<br>")}</div>`;
        } else if (!grokModelsFetched) {
            modelsEl.innerHTML = "...";
        }
    }

    function processGrokServerClientData() {
        const scriptEl = document.getElementById(
            "server-client-data-experimentation",
        );
        if (!scriptEl) return false;

        try {
            const data = JSON.parse(scriptEl.textContent || "{}");
            const serverConfig = data?.serverConfig;
            if (serverConfig && typeof serverConfig === "object") {
                const originalValue = serverConfig.show_model_config_override;
                if (typeof originalValue === "boolean") {
                    if (grokDevToolsEnabled && !originalValue) {
                        serverConfig.show_model_config_override = true;
                        scriptEl.textContent = JSON.stringify(data);
                    }
                    grokModelConfigOverrideValue =
                        grokDevToolsEnabled || originalValue;
                    updateGrokDevToolsStatus();
                }
            }

            updateGrokUserInfo();
        } catch (e) {
            console.error(
                "[CheckerNext] 处理 Grok server-client-data 出错:",
                e,
            );
        }
        return true;
    }

    function processGrokModesData() {
        const scriptEl = document.getElementById("server-client-data-modes");
        if (!scriptEl) return false;

        try {
            const data = JSON.parse(scriptEl.textContent || "{}");
            if (processGrokModes(data)) {
                scriptEl.textContent = JSON.stringify(data);
            }
        } catch (e) {
            console.error("[CheckerNext] 处理 Grok modes 数据出错:", e);
        }
        return true;
    }

    function processGrokEmbeddedData() {
        const serverDataReady = processGrokServerClientData();
        const modesDataReady = processGrokModesData();
        return serverDataReady && modesDataReady;
    }

    function initGrokDataProcessing() {
        if (!isGrokMode || processGrokEmbeddedData()) return;

        const grokObserver = new MutationObserver((mutations, obs) => {
            if (processGrokEmbeddedData()) obs.disconnect();
        });

        if (document.documentElement) {
            grokObserver.observe(document.documentElement, {
                childList: true,
                subtree: true,
            });
        } else {
            document.addEventListener("DOMContentLoaded", () => {
                processGrokEmbeddedData();
            });
        }
    }

    initGrokDataProcessing();

    let grokFetched = false;

    function showGrokUsageRow(containerId) {
        const section = document.getElementById("grok-usage-section");
        const container = document.getElementById(containerId);
        if (!section || !container) return false;

        section.style.display = "block";
        container.style.display = "block";
        if (!grokFetched) {
            // Grok 品牌色
            setIconColors("#000000", "#1D1D1D");
            grokFetched = true;
        }
        return true;
    }

    function updateGrokRateLimit(data, modelName) {
        if (!isGrokMode) return;
        if (data && typeof data === "object") {
            grokRateLimitData = data;
            grokRateLimitModelName =
                typeof modelName === "string" ? modelName : null;
        }
        if (!grokRateLimitData) return;

        const remaining = Number.isFinite(grokRateLimitData.remainingQueries)
            ? grokRateLimitData.remainingQueries
            : grokRateLimitData.remainingTokens;
        const total = Number.isFinite(grokRateLimitData.totalQueries)
            ? grokRateLimitData.totalQueries
            : grokRateLimitData.totalTokens;
        const valueEl = document.getElementById("grok-rate-limit");
        if (
            !valueEl ||
            !Number.isFinite(remaining) ||
            !Number.isFinite(total) ||
            !showGrokUsageRow("grok-rate-limit-container")
        ) {
            return;
        }

        const modeTitle =
            grokModeTitles.get(grokRateLimitModelName) ||
            grokRateLimitModelName ||
            "";
        let text = `${modeTitle ? `${modeTitle} ` : ""}${remaining}/${total}`;
        if (
            Number.isFinite(grokRateLimitData.waitTimeSeconds) &&
            grokRateLimitData.waitTimeSeconds > 0
        ) {
            text += `（${formatCodexDuration(grokRateLimitData.waitTimeSeconds, true)}后重置）`;
        } else if (
            Number.isFinite(grokRateLimitData.windowSizeSeconds) &&
            grokRateLimitData.windowSizeSeconds > 0
        ) {
            text += isCodexWindowDuration(
                grokRateLimitData.windowSizeSeconds,
                24 * 60 * 60,
            )
                ? "（每天）"
                : `（每${formatCodexDuration(grokRateLimitData.windowSizeSeconds, true)}）`;
        }
        valueEl.innerText = text;
    }

    function formatGrokStorageSize(bytes) {
        const units = ["B", "KB", "MB", "GB", "TB"];
        let value = bytes;
        let unitIndex = 0;
        while (value >= 1024 && unitIndex < units.length - 1) {
            value /= 1024;
            unitIndex++;
        }
        return `${Number(value.toFixed(value >= 100 ? 0 : 1))} ${units[unitIndex]}`;
    }

    function updateGrokStorageUsage(data) {
        if (!isGrokMode) return;
        if (data && typeof data === "object") grokStorageUsageData = data;
        if (!grokStorageUsageData) return;

        const used = Number(grokStorageUsageData.usedStorageBytes);
        const total = Number(grokStorageUsageData.totalStorageBytes);
        const valueEl = document.getElementById("grok-storage");
        if (
            !valueEl ||
            !Number.isFinite(used) ||
            !Number.isFinite(total) ||
            total <= 0 ||
            !showGrokUsageRow("grok-storage-container")
        ) {
            return;
        }

        valueEl.innerText = `${formatGrokStorageSize(used)}/${formatGrokStorageSize(total)}`;
        const videoTotal = Number(
            grokStorageUsageData.totalGeneratedVideoStorageBytes,
        );
        if (Number.isFinite(videoTotal) && videoTotal > 0) {
            valueEl.innerText += `，视频 ${formatGrokStorageSize(Number(grokStorageUsageData.usedGeneratedVideoStorageBytes) || 0)}/${formatGrokStorageSize(videoTotal)}`;
        }
    }

    function updateGrokAutomations(data) {
        if (!isGrokMode) return;
        if (data && typeof data === "object") {
            const count = Number.isFinite(data.workspaceTotal)
                ? data.workspaceTotal
                : Array.isArray(data.automations)
                  ? data.automations.length
                  : null;
            if (Number.isFinite(count)) grokAutomationsCount = count;
        }

        const valueEl = document.getElementById("grok-automations");
        if (
            valueEl &&
            Number.isFinite(grokAutomationsCount) &&
            showGrokUsageRow("grok-automations-container")
        ) {
            valueEl.innerText = String(grokAutomationsCount);
        }
    }

    function isResetTimestampNear(resetAfter, expectedTimestamp) {
        if (!resetAfter || typeof expectedTimestamp !== "number") return false;
        const timestamp = new Date(resetAfter).getTime();
        if (Number.isNaN(timestamp)) return false;
        return Math.abs(timestamp - expectedTimestamp) <= 5000;
    }

    const CHATGPT_FEATURE_LIMITS = {
        deep_research: ["deep-research", 30 * 24 * 60 * 60 * 1000],
        file_upload: ["file-upload", 3 * 60 * 60 * 1000],
        paste_text_to_file: ["paste-text-to-file", 3 * 60 * 60 * 1000],
        image_gen: ["image-gen", 24 * 60 * 60 * 1000],
    };

    function updateChatgptFeatureLimit(config, remaining, resetAfter) {
        if (!isChatgptMode) return;
        const [id, resetPeriod] = config;
        const section = document.getElementById(`${id}-section`);
        const usageEl = document.getElementById(`${id}-usage`);
        const resetEl = document.getElementById(`${id}-reset-time`);
        if (!section || !usageEl || !resetEl) return;

        if (typeof remaining !== "number") {
            section.style.display = "none";
            return;
        }

        section.style.display = "block";
        section.style.marginTop = powFetched ? "10px" : "0";
        if (isResetTimestampNear(resetAfter, Date.now() + resetPeriod)) {
            usageEl.innerHTML = `${remaining}次${NOT_STARTED_BADGE}`;
        } else {
            usageEl.innerText = `${remaining}次`;
        }

        resetEl.innerText = resetAfter
            ? new Date(resetAfter)
                  .toLocaleString("zh-CN", { hour12: false })
                  .replace(/\//g, "-")
            : "...";
    }

    function updateUserRegion(country, region) {
        if (!isChatgptMode || typeof country !== "string" || !country.trim())
            return;

        const parts = [country.trim()];
        if (typeof region === "string" && region.trim()) {
            parts.push(region.trim());
        }
        userRegionValue = parts.join(" / ");

        const container = document.getElementById("user-region-container");
        const valueEl = document.getElementById("user-region");
        if (!container || !valueEl) return;
        valueEl.innerText = userRegionValue;
        container.style.display = "block";
    }

    function updatePriceRegion(countryCode) {
        if (
            !isChatgptMode ||
            typeof countryCode !== "string" ||
            !countryCode.trim()
        )
            return;

        priceRegionCode = countryCode.trim().toUpperCase();

        const container = document.getElementById("price-region-container");
        const valueEl = document.getElementById("price-region");
        if (!container || !valueEl) return;
        valueEl.innerText = priceRegionCode;
        container.style.display = "block";
    }

    let memoryUsageTokens = null;
    let memoryMaxTokensValue = null;
    function updateMemoryUsage(memoryNumTokens, memoryMaxTokens) {
        if (!isChatgptMode) return;
        const section = document.getElementById("memory-section");
        const valueEl = document.getElementById("memory-usage");
        if (!section || !valueEl) return;

        const valid =
            typeof memoryNumTokens === "number" &&
            typeof memoryMaxTokens === "number" &&
            memoryMaxTokens > 0;

        if (valid) {
            memoryUsageTokens = memoryNumTokens;
            memoryMaxTokensValue = memoryMaxTokens;
        }

        if (
            typeof memoryUsageTokens === "number" &&
            typeof memoryMaxTokensValue === "number"
        ) {
            valueEl.innerText = `${memoryUsageTokens}/${memoryMaxTokensValue}`;
            section.style.display = "block";
            section.style.marginTop = powFetched ? "10px" : "0";
        } else {
            valueEl.innerText = "...";
            section.style.display = "none";
        }
    }

    function recreateResponseText(text, response) {
        return new pageWindow.Response(text, {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
        });
    }

    // 拦截 fetch 请求
    const originalFetch = pageWindow.fetch.bind(pageWindow);
    pageWindow.fetch = async function (resource, options = {}) {
        const requestUrl =
            typeof resource === "string" ? resource : resource?.url || String(resource);
        const requestMethod =
            options?.method || resource?.method || "GET";
        const finalMethod = requestMethod.toUpperCase();
        const checkerRequest = captureCheckerRequest(resource, options);
        let response;
        try {
            response = await originalFetch(resource, options);
        } catch (error) {
            void observeCheckerResponse(checkerRequest, null);
            throw error;
        }
        void observeCheckerResponse(checkerRequest, response);

        if (
            (requestUrl.includes(
                "/backend-api/sentinel/chat-requirements/prepare",
            ) ||
                requestUrl.includes(
                    "/backend-anon/sentinel/chat-requirements/prepare",
                )) &&
            finalMethod === "POST" &&
            response.ok
        ) {
            if (!isChatgptMode) {
                return response;
            }
            try {
                const data = await response.clone().json();
                const difficulty = data.proofofwork
                    ? data.proofofwork.difficulty
                    : "...";
                const persona = data.persona || "...";
                const difficultyElement = document.getElementById("difficulty");
                if (difficultyElement) difficultyElement.innerText = difficulty;

                const personaContainer =
                    document.getElementById("persona-container");
                const personaElement = document.getElementById("persona");
                if (personaContainer && personaElement) {
                    if (
                        persona &&
                        typeof persona === "string" &&
                        persona !== "..." &&
                        !persona.toLowerCase().includes("free")
                    ) {
                        personaElement.innerText = persona;
                    } else {
                        personaElement.innerText = "...";
                    }
                    personaContainer.style.display = "block";
                }
                updateDifficultyIndicator(difficulty);

                return response;
            } catch (e) {
                console.error("[CheckerNext] 处理响应或重新创建响应时出错:", e);
                const difficultyElement = document.getElementById("difficulty");
                if (difficultyElement) difficultyElement.innerText = "...";
                updateDifficultyIndicator("...");
                const personaElement = document.getElementById("persona");
                if (personaElement) personaElement.innerText = "...";

                return response;
            }
        }

        if (
            requestUrl.endsWith("/backend-api/me") &&
            finalMethod === "GET" &&
            response.ok
        ) {
            if (!isChatgptMode) {
                return response;
            }
            try {
                const data = await response.clone().json();
                updateUserRegion(
                    typeof data?.country === "string" ? data.country : null,
                    typeof data?.region === "string" ? data.region : null,
                );
                return response;
            } catch (e) {
                console.error("[CheckerNext] 处理用户地区响应出错:", e);
                return response;
            }
        }

        if (
            requestUrl.includes(
                "/backend-api/checkout_pricing_config/configs",
            ) &&
            finalMethod === "GET" &&
            response.ok
        ) {
            if (!isChatgptMode) {
                return response;
            }
            try {
                const data = await response.clone().json();
                updatePriceRegion(
                    typeof data?.country_code === "string"
                        ? data.country_code
                        : null,
                );
                return response;
            } catch (e) {
                console.error("[CheckerNext] 处理价格地区响应出错:", e);
                return response;
            }
        }

        if (
            requestUrl.includes("/backend-api/memories") &&
            finalMethod === "GET" &&
            response.ok
        ) {
            if (!isChatgptMode) {
                return response;
            }
            try {
                const data = await response.clone().json();
                updateMemoryUsage(
                    typeof data?.memory_num_tokens === "number"
                        ? data.memory_num_tokens
                        : null,
                    typeof data?.memory_max_tokens === "number"
                        ? data.memory_max_tokens
                        : null,
                );
                return response;
            } catch (e) {
                console.error("[CheckerNext] 处理记忆用量响应出错:", e);
                return response;
            }
        }

        if (
            /\/backend-api\/tpp\/models\/?(?:[?#]|$)/.test(requestUrl) &&
            finalMethod === "GET" &&
            response.ok
        ) {
            if (!isChatgptMode) return response;
            try {
                updateChatgptRuntimeModelCatalog(
                    "work",
                    await response.clone().json(),
                );
                return response;
            } catch (e) {
                console.error("[CheckerNext] 处理 Work 模型响应出错:", e);
                return response;
            }
        }

        if (
            /\/backend-api\/models\/?(?:[?#]|$)/.test(requestUrl) &&
            finalMethod === "GET" &&
            response.ok
        ) {
            if (!isChatgptMode) return response;
            try {
                updateChatgptRuntimeModelCatalog(
                    "chat",
                    await response.clone().json(),
                );
                return response;
            } catch (e) {
                console.error("[CheckerNext] 处理 Chat 模型响应出错:", e);
                return response;
            }
        }

        if (
            requestUrl.includes("/backend-api/conversation/init") &&
            finalMethod === "POST" &&
            response.ok
        ) {
            try {
                const data = await response.clone().json();
                if (Array.isArray(data.limits_progress)) {
                    for (const limit of data.limits_progress) {
                        const config =
                            CHATGPT_FEATURE_LIMITS[limit.feature_name];
                        if (Array.isArray(config)) {
                            updateChatgptFeatureLimit(
                                config,
                                limit.remaining,
                                limit.reset_after,
                            );
                        }
                    }
                }
                return response;
            } catch (e) {
                console.error("[CheckerNext] 处理功能用量响应出错:", e);
                return response;
            }
        }

        if (
            /\/backend-api\/settings\/is_adult\/?(?:[?#]|$)/.test(requestUrl) &&
            finalMethod === "GET"
        ) {
            if (!isChatgptMode) return response;
            if (!response.ok) {
                updateChatgptAgeVerificationSettingStatus(undefined, false, `HTTP ${response.status}`);
                return response;
            }
            try {
                const data = await response.clone().json();

                const originalValue =
                    typeof data?.show_age_verification_setting === "boolean"
                        ? data.show_age_verification_setting : undefined;
                let modified = false;

                if (
                    chatgptAgeVerificationSettingEnabled &&
                    originalValue === false
                ) {
                    data.show_age_verification_setting = true;
                    modified = true;
                }

                updateChatgptAgeVerificationSettingStatus(
                    originalValue,
                    modified,
                );

                if (modified) {
                    return recreateResponseText(JSON.stringify(data), response);
                }
                return response;
            } catch (e) {
                updateChatgptAgeVerificationSettingStatus(undefined, false, "响应格式无法识别");
                console.error("[CheckerNext] 处理 is_adult 响应出错:", e);
                return response;
            }
        }

        if (
            /\/backend-api\/wham\/usage\/?(?:[?#]|$)/.test(requestUrl) &&
            finalMethod === "GET" &&
            response.ok
        ) {
            if (!isChatgptMode && !isCodexMode) return response;
            try {
                const data = await response.clone().json();
                updateCodexInfo(getCodexUsageWindows(data));
                updateCodexCredits(data?.credits);
                updateCodexResetCredits(data?.rate_limit_reset_credits);
                return response;
            } catch (e) {
                console.error("[CheckerNext] 处理 Codex 响应出错:", e);
                return response;
            }
        }

        if (
            /\/backend-api\/wham\/rate-limit-reset-credits\/?(?:[?#]|$)/.test(
                requestUrl,
            ) &&
            finalMethod === "GET" &&
            response.ok
        ) {
            if (!isChatgptMode && !isCodexMode) return response;
            try {
                updateCodexResetCredits(await response.clone().json());
                return response;
            } catch (e) {
                console.error("[CheckerNext] 处理 Codex 重置机会响应出错:", e);
                return response;
            }
        }

        if (
            requestUrl.includes("grok.com/rest/user-settings") &&
            finalMethod === "GET" &&
            response.ok
        ) {
            if (!isGrokMode) return response;
            try {
                const data = await response.clone().json();
                const preferences = data?.preferences;
                let modified = false;
                if (preferences && typeof preferences === "object") {
                    if (
                        typeof preferences.enableEarlyAccessModels === "boolean"
                    ) {
                        if (
                            grokEarlyAccessEnabled &&
                            !preferences.enableEarlyAccessModels
                        ) {
                            preferences.enableEarlyAccessModels = true;
                            modified = true;
                        }
                        grokEarlyAccessDisplayValue =
                            preferences.enableEarlyAccessModels;
                        updateBooleanStatus(
                            "grok-early-access-status",
                            grokEarlyAccessDisplayValue,
                        );
                    }
                    if (typeof preferences.isAsyncChat === "boolean") {
                        if (grokAsyncChatEnabled && !preferences.isAsyncChat) {
                            preferences.isAsyncChat = true;
                            modified = true;
                        }
                        grokAsyncChatDisplayValue = preferences.isAsyncChat;
                        updateBooleanStatus(
                            "grok-async-chat-status",
                            grokAsyncChatDisplayValue,
                        );
                    }
                }
                return modified
                    ? recreateResponseText(JSON.stringify(data), response)
                    : response;
            } catch (e) {
                console.error("[CheckerNext] 处理 Grok 用户设置响应出错:", e);
                return response;
            }
        }

        if (
            requestUrl.includes("grok.com/rest/modes") &&
            finalMethod === "POST" &&
            response.ok
        ) {
            if (!isGrokMode) return response;
            try {
                const data = await response.clone().json();
                return processGrokModes(data)
                    ? recreateResponseText(JSON.stringify(data), response)
                    : response;
            } catch (e) {
                console.error("[CheckerNext] 处理 Grok modes 响应出错:", e);
                return response;
            }
        }

        if (
            requestUrl.includes("grok.com/rest/rate-limits") &&
            finalMethod === "POST" &&
            response.ok
        ) {
            if (!isGrokMode) return response;
            try {
                const data = await response.clone().json();
                let modelName;
                const requestBody = Reflect.get(options, "body");
                if (typeof requestBody === "string") {
                    const requestData = JSON.parse(requestBody);
                    if (typeof requestData?.modelName === "string") {
                        modelName = requestData.modelName;
                    }
                }
                updateGrokRateLimit(data, modelName);
                return response;
            } catch (e) {
                console.error("[CheckerNext] 处理 Grok 模型额度响应出错:", e);
                return response;
            }
        }

        if (
            requestUrl.includes("grok.com/rest/automations") &&
            finalMethod === "GET" &&
            response.ok
        ) {
            if (!isGrokMode) return response;
            try {
                updateGrokAutomations(await response.clone().json());
                return response;
            } catch (e) {
                console.error("[CheckerNext] 处理 Grok 自动化响应出错:", e);
                return response;
            }
        }

        if (
            requestUrl.includes("grok.com/rest/assets/storage-usage") &&
            finalMethod === "GET" &&
            response.ok
        ) {
            if (!isGrokMode) return response;
            try {
                updateGrokStorageUsage(await response.clone().json());
                return response;
            } catch (e) {
                console.error("[CheckerNext] 处理 Grok 存储用量响应出错:", e);
                return response;
            }
        }
        return response;
    };

    if (isChatgptMode && isChatgptImportPatchEnabled()) {
        if (document.readyState === "loading") {
            document.addEventListener(
                "DOMContentLoaded",
                () => void prepareChatgptImportMapPatchCache(),
                { once: true },
            );
        } else {
            void prepareChatgptImportMapPatchCache();
        }
    }
})();
