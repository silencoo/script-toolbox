// ==UserScript==
// @name         XSijishe 网页增强
// @namespace    https://github.com/silencoo/script-toolbox
// @version      7.1.0
// @description  自适应布局、页面导航、栏目显隐、图片裁剪/完整/瀑布流模式与链接归一化
// @author       silencoo
// @match        *://xsijishe.com/*
// @match        *://*.xsijishe.com/*
// @match        *://xsijishe.net/*
// @match        *://*.xsijishe.net/*
// @match        *://xsijishe.cn/*
// @match        *://*.xsijishe.cn/*
// @homepageURL  https://github.com/silencoo/script-toolbox/tree/main/userscripts/xsijishe-enhancer
// @supportURL   https://github.com/silencoo/script-toolbox/issues
// @downloadURL  https://raw.githubusercontent.com/silencoo/script-toolbox/main/userscripts/xsijishe-enhancer/xsijishe-enhancer.user.js
// @updateURL    https://raw.githubusercontent.com/silencoo/script-toolbox/main/userscripts/xsijishe-enhancer/xsijishe-enhancer.user.js
// @grant        GM_setValue
// @grant        GM_getValue
// @run-at       document-start
// @license      MIT
// ==/UserScript==

(function () {
    'use strict';

    var VERSION = '7.1.0';
    var HOSTS = ['xsijishe.net', 'xsijishe.com', 'xsijishe.cn'];
    var PRIMARY_HOST = 'xsijishe.com';

    var STORE_KEY_HIDDEN = 'xsijishe-enhancer:hidden-parts';
    var STORE_KEY_IMAGE_FIT = 'xsijishe-enhancer:preserve-ratio';
    var STORE_KEY_IMAGE_MODE = 'xsijishe-enhancer:image-mode';
    var STORE_KEY_FOOTER = 'xsijishe-enhancer:footer-hidden';
    var IMAGE_MODES = ['cover', 'contain', 'masonry'];

    var MODULE_SELECTOR = [
        '.nex_tuijian',
        '.nex_newrecommend',
        '.nex_pubpart',
        '.nex_gongxianbox',
        '.nex_Ranklists'
    ].join(',');

    var enhancerObserver = null;
    var sectionObserver = null;
    var bootObserver = null;
    var refreshTimer = 0;

    function isTargetHost(hostname) {
        if (!hostname) return false;
        return HOSTS.some(function (host) {
            return hostname === host || hostname.endsWith('.' + host);
        });
    }

    function normalizeUrl(href) {
        if (typeof href !== 'string' || !href) return href;
        try {
            var url = new URL(href, location.href);
            if (!isTargetHost(url.hostname)) return href;

            url.hostname = PRIMARY_HOST;
            url.searchParams.delete('mobile');
            url.searchParams.delete('forcemobile');
            return url.toString();
        } catch (error) {
            return href;
        }
    }

    function normalizeAnchor(anchor) {
        if (!anchor || anchor.nodeType !== 1) return;
        var raw = anchor.getAttribute('href');
        if (!raw || raw.charAt(0) === '#') return;
        var normalized = normalizeUrl(raw);
        if (normalized !== raw) anchor.setAttribute('href', normalized);
    }

    function normalizeTree(root) {
        if (!root || root.nodeType !== 1) return;
        if (root.matches && root.matches('a[href]')) normalizeAnchor(root);
        if (!root.querySelectorAll) return;
        root.querySelectorAll('a[href]').forEach(normalizeAnchor);
    }

    function startLinkNormalizer() {
        if (!document.documentElement) return;
        normalizeTree(document.documentElement);

        var observer = new MutationObserver(function (mutations) {
            mutations.forEach(function (mutation) {
                if (mutation.type === 'attributes') {
                    normalizeAnchor(mutation.target);
                    return;
                }
                mutation.addedNodes.forEach(normalizeTree);
            });
        });

        observer.observe(document.documentElement, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['href']
        });
    }

    function patchNavigationApis() {
        ['pushState', 'replaceState'].forEach(function (method) {
            try {
                var original = history[method];
                history[method] = function () {
                    if (typeof arguments[2] === 'string') {
                        arguments[2] = normalizeUrl(arguments[2]);
                    }
                    return original.apply(this, arguments);
                };
            } catch (error) {}
        });

        try {
            var originalOpen = window.open;
            window.open = function (url) {
                if (typeof url === 'string') arguments[0] = normalizeUrl(url);
                return originalOpen.apply(this, arguments);
            };
        } catch (error) {}
    }

    function readStored(key, fallback) {
        var value;
        try {
            if (typeof GM_getValue === 'function') {
                value = GM_getValue(key);
            } else {
                value = localStorage.getItem(key);
            }
        } catch (error) {
            return fallback;
        }

        if (value === null || value === undefined) return fallback;
        if (typeof value === 'string') {
            try {
                return JSON.parse(value);
            } catch (error) {
                return value;
            }
        }
        return value;
    }

    function writeStored(key, value) {
        try {
            if (typeof GM_setValue === 'function') GM_setValue(key, value);
        } catch (error) {}
        try {
            localStorage.setItem(key, JSON.stringify(value));
        } catch (error) {}
    }

    function getHiddenKeys() {
        var value = readStored(STORE_KEY_HIDDEN, []);
        return Array.isArray(value) ? value : [];
    }

    function setHiddenKeys(keys) {
        writeStored(STORE_KEY_HIDDEN, keys);
    }

    function migrateLegacySettings() {
        var hidden = getHiddenKeys();
        var cleaned = hidden.filter(function (key) {
            return key &&
                key !== 'nexfttop' &&
                key !== 'nexftbottom' &&
                key.indexOf('xss-anchor-') !== 0;
        });
        if (cleaned.length !== hidden.length) setHiddenKeys(cleaned);
    }

    function ensureViewportMeta() {
        var meta = document.querySelector('meta[name="viewport"]');
        if (!meta) {
            meta = document.createElement('meta');
            meta.setAttribute('name', 'viewport');
            (document.head || document.documentElement).appendChild(meta);
        }
        meta.setAttribute('content', 'width=device-width, initial-scale=1, viewport-fit=cover');
    }

    function slugify(value) {
        var slug = String(value || '')
            .trim()
            .toLowerCase()
            .replace(/\s+/g, '-')
            .replace(/[^\w\u3400-\u9fff-]/g, '')
            .replace(/-+/g, '-')
            .slice(0, 42);
        return slug || 'section';
    }

    function getModuleTitle(element) {
        var title = element.querySelector('.nex_common_hd > span');
        if (!title) title = element.querySelector('.nex_common_hd span, h2, h3');
        return title ? title.textContent.trim() : '';
    }

    function scanModules() {
        var occurrences = Object.create(null);
        return Array.from(document.querySelectorAll(MODULE_SELECTOR))
            .filter(function (element) {
                return !element.closest('[data-xss-injected="1"]');
            })
            .map(function (element) {
                var title = getModuleTitle(element);
                if (!title) return null;

                var slug = slugify(title);
                occurrences[slug] = (occurrences[slug] || 0) + 1;
                var suffix = occurrences[slug] > 1 ? '-' + occurrences[slug] : '';
                var key = 'module:' + slug + suffix;
                var anchor = 'xss-section-' + slug + suffix;

                element.setAttribute('data-xss-section', anchor);
                element.style.scrollMarginTop = '86px';
                return { element: element, title: title, key: key, anchor: anchor };
            })
            .filter(Boolean);
    }

    function applyModuleVisibility(modules) {
        var hidden = getHiddenKeys();
        (modules || scanModules()).forEach(function (module) {
            module.element.classList.toggle('xss-module-hidden', hidden.indexOf(module.key) !== -1);
        });
    }

    function setModuleHidden(key, shouldHide) {
        var hidden = getHiddenKeys();
        var index = hidden.indexOf(key);
        if (shouldHide && index === -1) hidden.push(key);
        if (!shouldHide && index !== -1) hidden.splice(index, 1);
        setHiddenKeys(hidden);

        var modules = scanModules();
        applyModuleVisibility(modules);
        refreshNavigation(modules);
    }

    function getImageMode() {
        var mode = readStored(STORE_KEY_IMAGE_MODE, '');
        if (IMAGE_MODES.indexOf(mode) !== -1) return mode;
        return readStored(STORE_KEY_IMAGE_FIT, false) ? 'contain' : 'cover';
    }

    function setImageMode(mode) {
        if (IMAGE_MODES.indexOf(mode) === -1) mode = 'cover';
        writeStored(STORE_KEY_IMAGE_MODE, mode);
        writeStored(STORE_KEY_IMAGE_FIT, mode === 'contain');
    }

    function applyImageMode() {
        var mode = getImageMode();
        document.documentElement.setAttribute('data-xss-image-mode', mode);
        document.documentElement.setAttribute('data-xss-image-fit', mode === 'contain' ? 'contain' : 'cover');
    }

    function applyFooterMode() {
        var hidden = readStored(STORE_KEY_FOOTER, true) !== false;
        document.documentElement.classList.toggle('xss-hide-footer', hidden);
    }

    function injectPageStyles() {
        if (document.querySelector('style[data-xss-enhancer-style]')) return;

        var style = document.createElement('style');
        style.setAttribute('data-xss-enhancer-style', '1');
        style.textContent = `
            :root {
                --xss-accent: #f26a3d;
                --xss-accent-soft: #fff1eb;
                --xss-bg: #f6f7f9;
                --xss-surface: #ffffff;
                --xss-border: #e7e9ed;
                --xss-text: #24272d;
                --xss-muted: #747b86;
                --xss-radius: 14px;
            }

            html {
                scroll-behavior: smooth;
                background: var(--xss-bg);
            }

            html body {
                min-width: 0 !important;
                overflow-x: clip !important;
                background: var(--xss-bg) !important;
                color: var(--xss-text);
            }

            html body *,
            html body *::before,
            html body *::after {
                box-sizing: border-box;
            }

            html body #hd,
            html body #wp,
            html body #wp > .wp,
            html body .nex_index_top {
                width: 100% !important;
                min-width: 0 !important;
                max-width: none !important;
            }

            html body #hd {
                height: 120px !important;
            }

            html body .nex_top_bg {
                width: 100% !important;
                max-width: 100% !important;
                min-width: 0 !important;
                height: 64px !important;
                min-height: 64px !important;
                background: var(--xss-surface) !important;
                border-bottom: 1px solid var(--xss-border);
                box-shadow: 0 1px 0 rgba(22, 26, 33, .02);
            }

            html body .nex_top_bg_inter {
                position: relative !important;
                width: 100% !important;
                max-width: 100% !important;
                min-width: 0 !important;
                height: 64px !important;
                min-height: 64px !important;
            }

            html body .nex_top_interior {
                position: relative !important;
                display: grid !important;
                grid-template-columns: 120px 72px minmax(260px, 1fr) 50px;
                align-items: center;
                gap: 12px;
                width: min(1180px, calc(100% - 32px)) !important;
                height: 64px !important;
                margin: 0 auto !important;
            }

            html body .nexlogo,
            html body .nex_nav_ranklist,
            html body .nex_top_search,
            html body .nexdl {
                position: static !important;
                inset: auto !important;
                float: none !important;
                margin: 0 !important;
            }

            html body .nexlogo {
                width: 120px !important;
                height: 50px !important;
                display: flex;
                align-items: center;
            }

            html body .nexlogo img {
                display: block;
                max-width: 120px;
                height: auto;
            }

            html body .nex_nav_ranklist {
                width: 72px !important;
            }

            html body .nex_top_search {
                display: flex !important;
                align-items: center;
                gap: 12px;
                width: auto !important;
                min-width: 0;
            }

            html body #scbar {
                flex: 1 1 320px;
                width: auto !important;
                min-width: 220px;
            }

            html body .nex_scbar_hot_td {
                flex: 0 1 245px;
                min-width: 0;
                overflow: hidden;
                white-space: nowrap;
            }

            html body .nexdl {
                width: 50px !important;
                height: 50px !important;
            }

            html body .nex_top_interior > .clear {
                display: none !important;
            }

            html body .nexnav {
                width: 100% !important;
                height: 56px !important;
                min-width: 0 !important;
                overflow-x: auto !important;
                overflow-y: hidden !important;
                background: var(--xss-surface) !important;
                border-bottom: 1px solid var(--xss-border);
                scrollbar-width: thin;
            }

            html body .nexheader {
                width: 100% !important;
                max-width: 100% !important;
                min-width: 0 !important;
                height: 56px !important;
            }

            html body .nexheader > .w1180 {
                width: 100% !important;
                max-width: 100% !important;
                min-width: 0 !important;
                margin: 0 !important;
            }

            html body .nex_fastpost_btn {
                display: none !important;
            }

            html body .nexnav > ul {
                display: flex !important;
                align-items: stretch;
                width: max-content !important;
                min-width: min(1180px, 100%) !important;
                height: 56px !important;
                margin: 0 auto !important;
                padding: 0 !important;
            }

            html body .nexnav > ul > li {
                flex: 0 0 auto;
                float: none !important;
                height: 56px !important;
            }

            html body .nexnav > ul > li > a {
                display: flex !important;
                align-items: center;
                height: 56px !important;
                padding: 0 18px !important;
                color: var(--xss-text) !important;
                font-size: 15px !important;
                font-weight: 500;
                text-shadow: none !important;
                white-space: nowrap;
            }

            html body .nexnav > ul > li > a:hover,
            html body .nexnav > ul > li.a > a {
                color: var(--xss-accent) !important;
            }

            html body .nexnav > ul > li.a > a {
                box-shadow: inset 0 -3px 0 var(--xss-accent);
            }

            html body #mu {
                min-width: 0 !important;
                max-width: 100% !important;
            }

            html body #wp {
                margin: 0 !important;
                padding: 0 !important;
            }

            html body .nex_index_top {
                margin-top: 0 !important;
            }

            html body .nex_index_top > .w1180 {
                width: min(1180px, calc(100% - 32px)) !important;
                max-width: 1180px !important;
                min-width: 0 !important;
                margin: 18px auto 36px !important;
                padding: 0 !important;
            }

            html body .nex_plugin_reserved > .w1180,
            html body .nex_index_ads,
            html body .nex_index_ads .area,
            html body .nex_mid_ads,
            html body .nex_mid_ads > ul {
                width: 100% !important;
                max-width: 100% !important;
                min-width: 0 !important;
            }

            html body .nex_mid_ads > ul {
                display: grid !important;
                grid-template-columns: repeat(3, minmax(0, 1fr));
                gap: 12px;
            }

            html body .nex_mid_ads > ul > li {
                float: none !important;
                width: auto !important;
                min-width: 0 !important;
                margin: 0 !important;
            }

            html body .nex_tuijian,
            html body .nex_pubpart,
            html body .nex_gongxianbox {
                width: 100% !important;
                height: auto !important;
                margin: 0 0 18px !important;
                padding: 18px !important;
                overflow: hidden;
                background: var(--xss-surface);
                border: 1px solid var(--xss-border);
                border-radius: var(--xss-radius);
                box-shadow: 0 5px 18px rgba(27, 31, 38, .035);
            }

            html body .nex_common_hd {
                display: flex !important;
                align-items: center;
                gap: 14px;
                width: 100% !important;
                min-width: 0;
                min-height: 44px !important;
                height: auto !important;
                margin: 0 0 14px !important;
                padding: 0 0 12px !important;
                overflow: visible !important;
                border-bottom: 1px solid var(--xss-border);
            }

            html body .nex_common_hd > span {
                position: relative;
                display: block !important;
                flex: 0 0 auto;
                float: none !important;
                width: auto !important;
                height: auto !important;
                padding-left: 12px;
                color: var(--xss-text) !important;
                font-size: 19px !important;
                font-weight: 650 !important;
                line-height: 1.35 !important;
            }

            html body .nex_common_hd > span::before {
                content: "";
                position: absolute;
                left: 0;
                top: .18em;
                bottom: .18em;
                width: 4px;
                border-radius: 4px;
                background: var(--xss-accent);
            }

            html body .nex_common_hd .nex_tabchange,
            html body .nex_common_hd .nex_phtab_tops ul {
                display: flex !important;
                align-items: center;
                gap: 4px;
                float: none !important;
                width: auto !important;
                margin: 0 !important;
            }

            html body .nex_common_hd .nex_tabchange > li,
            html body .nex_common_hd .nex_phtab_tops li {
                float: none !important;
                margin: 0 !important;
                padding: 5px 9px !important;
                border-radius: 7px;
                line-height: 1.2 !important;
            }

            html body .nex_common_hd .nex_tabchange > li.on,
            html body .nex_common_hd .nex_phtab_tops li.on {
                color: var(--xss-accent) !important;
                background: var(--xss-accent-soft);
            }

            html body .nex_common_hd .nex_sp_line,
            html body .nex_common_hd .nex_tab_line {
                display: none !important;
            }

            html body .nex_common_hd .nex_more_btns {
                margin-left: auto !important;
                color: var(--xss-muted) !important;
            }

            html body .nex_rollingboxs,
            html body .nex_contribution {
                position: relative !important;
                width: 100% !important;
                max-width: 100% !important;
                min-width: 0 !important;
                height: 130px !important;
            }

            html body .nex_rollingboxs .area,
            html body .nex_rollingboxs .frame,
            html body .nex_rollingboxs .column,
            html body .nex_rollingboxs .block,
            html body .nex_rollingboxs .dxb_bc,
            html body .nex_contribution .area,
            html body .nex_contribution .frame,
            html body .nex_contribution .column,
            html body .nex_contribution .block,
            html body .nex_contribution .dxb_bc {
                width: 100% !important;
                max-width: 100% !important;
                min-width: 0 !important;
            }

            html body .nex_rollingboxs .tempWrap,
            html body .nex_contribution .tempWrap {
                width: 100% !important;
                max-width: 100% !important;
            }

            html body .nex_rollingboxs .nexproul,
            html body .nex_contribution .nexctb {
                max-width: none !important;
            }

            html body .nex_rollingboxs .next,
            html body .nex_contribution .next {
                right: 0 !important;
                left: auto !important;
            }

            html body .nex_rollingboxs .prev,
            html body .nex_contribution .prev {
                left: 0 !important;
            }

            html body .nex_newrecommend {
                display: grid !important;
                grid-template-columns: minmax(0, 1fr) 230px;
                align-items: start;
                gap: 18px;
                width: 100% !important;
                height: auto !important;
                margin: 0 0 18px !important;
            }

            html body .nex_latest_left,
            html body .nex_recommend_ranks {
                float: none !important;
                width: auto !important;
                min-width: 0 !important;
                height: auto !important;
                margin: 0 !important;
                padding: 18px !important;
                overflow: hidden;
                background: var(--xss-surface);
                border: 1px solid var(--xss-border);
                border-radius: var(--xss-radius);
                box-shadow: 0 5px 18px rgba(27, 31, 38, .035);
            }

            html body .nex_newrecos,
            html body .nex_newrecos > ul,
            html body .nex_newrecos .area,
            html body .nex_newrecos .frame,
            html body .nex_newrecos .column,
            html body .nex_newrecos .block {
                width: 100% !important;
                min-width: 0 !important;
                height: auto !important;
                margin: 0 !important;
            }

            html body .nex_newrecos .dxb_bc {
                display: grid !important;
                grid-template-columns: repeat(auto-fit, minmax(188px, 1fr));
                gap: 22px 12px;
                width: 100% !important;
                min-width: 0 !important;
                height: auto !important;
            }

            html body .nex_newrecos .dxb_bc > li {
                float: none !important;
                width: auto !important;
                min-width: 0 !important;
                height: auto !important;
                margin: 0 !important;
                padding: 0 !important;
            }

            html body .nex_newrecos_img,
            html body .nex_newrecos_img > a {
                display: block !important;
                width: 100% !important;
                height: auto !important;
                aspect-ratio: 23 / 13;
                overflow: hidden;
                border-radius: 9px;
                background: #17191d;
            }

            html body .nex_newrecos_img img,
            html body .nex_acgcommon_img img,
            html body .nex_ctbpic img,
            html body .nex_recons_rankinter img {
                display: block !important;
                width: 100% !important;
                height: 100% !important;
                object-fit: cover;
                transition: transform .2s ease;
            }

            html[data-xss-image-fit="contain"] body .nex_newrecos_img img,
            html[data-xss-image-fit="contain"] body .nex_acgcommon_img img,
            html[data-xss-image-fit="contain"] body .nex_ctbpic img,
            html[data-xss-image-fit="contain"] body .nex_recons_rankinter img {
                object-fit: contain !important;
                transform: none !important;
            }

            html body .nex_newrecos_img:hover img,
            html body .nex_acgcommon_img:hover img {
                transform: scale(1.025);
            }

            html body .nex_newrecos_btms h5,
            html body .nex_acgcommon_btm h5 {
                margin-top: 9px !important;
                color: var(--xss-text) !important;
                font-size: 14px !important;
                line-height: 1.45 !important;
            }

            html body .nex_newrecos_btms,
            html body .nex_acgcommon_btm,
            html body .nex_newrecos_btms h5,
            html body .nex_acgcommon_btm h5,
            html body .nex_newrecos_btms h5 > a,
            html body .nex_acgcommon_btm h5 > a {
                width: 100% !important;
                min-width: 0 !important;
                max-width: 100% !important;
                overflow: hidden;
                text-overflow: ellipsis;
            }

            html body .nex_recommend_ranks .nex_common_hd {
                flex-wrap: wrap;
            }

            html body .nex_recommend_ranks .nex_recon_lists {
                width: 100% !important;
                height: auto !important;
            }

            html body .nex_pubpart .nex_videospot,
            html body .nex_pubpart .nex_videospot > ul,
            html body .nex_pubpart .nex_videospot > ul > li,
            html body .nex_pubpart .nex_acgbox,
            html body .nex_pubpart .nex_acgbox > dl,
            html body .nex_pubpart .nex_acgbox .area,
            html body .nex_pubpart .nex_acgbox .frame,
            html body .nex_pubpart .nex_acgbox .column,
            html body .nex_pubpart .nex_acgbox .block {
                width: 100% !important;
                min-width: 0 !important;
                height: auto !important;
            }

            html body .nex_pubpart .nex_acgbox .dxb_bc {
                display: grid !important;
                grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
                gap: 20px 10px;
                width: 100% !important;
                min-width: 0 !important;
                height: auto !important;
            }

            html body .nex_pubpart .nex_acgbox .dxb_bc > dd {
                display: block !important;
                float: none !important;
                width: auto !important;
                min-width: 0 !important;
                height: auto !important;
                margin: 0 !important;
                padding: 0 !important;
            }

            html body .nex_acgcommon_img,
            html body .nex_acgcommon_img > a {
                display: block !important;
                width: 100% !important;
                height: auto !important;
                aspect-ratio: 19 / 12;
                overflow: hidden;
                border-radius: 9px;
                background: #17191d;
            }

            /* Masonry only owns the normal content-card grids. Fixed-size carousels,
               contribution strips and ranking thumbnails keep their original geometry. */
            html[data-xss-image-mode="masonry"] body .nex_newrecos .dxb_bc {
                display: block !important;
                columns: 188px 4;
                column-gap: 12px;
            }

            html[data-xss-image-mode="masonry"] body .nex_pubpart .nex_acgbox .dxb_bc {
                display: block !important;
                columns: 150px 6;
                column-gap: 10px;
            }

            html[data-xss-image-mode="masonry"] body .nex_newrecos .dxb_bc > li,
            html[data-xss-image-mode="masonry"] body .nex_pubpart .nex_acgbox .dxb_bc > dd {
                display: inline-block !important;
                width: 100% !important;
                max-width: 100% !important;
                margin: 0 0 18px !important;
                break-inside: avoid;
                page-break-inside: avoid;
                vertical-align: top;
            }

            html[data-xss-image-mode="masonry"] body .nex_newrecos_img,
            html[data-xss-image-mode="masonry"] body .nex_newrecos_img > a,
            html[data-xss-image-mode="masonry"] body .nex_acgcommon_img,
            html[data-xss-image-mode="masonry"] body .nex_acgcommon_img > a {
                height: auto !important;
                min-height: 0 !important;
                aspect-ratio: auto !important;
            }

            html[data-xss-image-mode="masonry"] body .nex_newrecos_img img,
            html[data-xss-image-mode="masonry"] body .nex_acgcommon_img img {
                width: 100% !important;
                max-width: 100% !important;
                height: auto !important;
                object-fit: contain !important;
                transform: none !important;
            }

            html body .nex_Ranklists {
                width: 100% !important;
                height: auto !important;
                margin: 0 0 18px !important;
            }

            html body .nex_Ranklists > ul {
                display: grid !important;
                grid-template-columns: repeat(3, minmax(0, 1fr));
                gap: 16px;
                width: 100% !important;
                min-width: 0 !important;
                height: auto !important;
                margin: 0 !important;
            }

            html body .nex_Ranklists > ul > li {
                float: none !important;
                width: auto !important;
                min-width: 0 !important;
                height: auto !important;
                margin: 0 !important;
                padding: 18px !important;
                overflow: hidden;
                background: var(--xss-surface);
                border: 1px solid var(--xss-border);
                border-radius: var(--xss-radius);
                box-shadow: 0 5px 18px rgba(27, 31, 38, .035);
            }

            html body .nex_Ranklists .nex_rankingsd,
            html body .nex_Ranklists .nex_rankingsd dl,
            html body .nex_Ranklists .area,
            html body .nex_Ranklists .frame,
            html body .nex_Ranklists .column,
            html body .nex_Ranklists .block,
            html body .nex_Ranklists .dxb_bc,
            html body .nex_Ranklists .dxb_bc > dd {
                width: 100% !important;
                min-width: 0 !important;
                height: auto !important;
            }

            html body .nex_Ranklists .dxb_bc > dd {
                display: grid !important;
                grid-template-columns: 100px minmax(0, 1fr);
                align-items: start;
                gap: 12px;
                float: none !important;
            }

            html body .nex_Ranklists .nex_rkpics {
                float: none !important;
                width: 100px !important;
                height: 72px !important;
                overflow: hidden;
                border-radius: 8px;
            }

            html body .nex_Ranklists .nex_rkpics img {
                display: block !important;
                width: 100% !important;
                height: 100% !important;
                object-fit: cover;
            }

            html body .nex_Ranklists .nex_rkintel {
                float: none !important;
                width: auto !important;
                min-width: 0 !important;
                margin: 0 !important;
            }

            html body .nex_Ranklists .nex_rkintel h5 {
                position: relative;
                min-height: 24px;
                height: auto !important;
            }

            html body .nex_Ranklists .nex_rkintel h5 em {
                position: absolute !important;
                left: 0;
                top: 0;
                float: none !important;
            }

            html body .nex_Ranklists .nex_rkintel h5 a {
                display: -webkit-box !important;
                float: none !important;
                width: auto !important;
                min-width: 0 !important;
                padding-left: 30px;
                overflow: hidden;
                -webkit-box-orient: vertical;
                -webkit-line-clamp: 2;
                line-height: 20px !important;
            }

            html body .nex_Ranklists .nex_rkintel h5 > .clear {
                display: none !important;
            }

            html body .nex_Ranklists .dxb_bc > dd > .clear {
                display: none !important;
            }

            html body .nex_friendlinks,
            html body .nex_friendlinks > ul,
            html body .nex_friendlinks .area,
            html body .nex_friendlinks .frame,
            html body .nex_friendlinks .column,
            html body .nex_friendlinks .block,
            html body .nex_friendlinks .dxb_bc,
            html body .nex_friendlinks .dxb_bc > *,
            html body .nex_friendlinks ul {
                width: 100% !important;
                max-width: 100% !important;
                min-width: 0 !important;
                height: auto !important;
            }

            html body .xss-module-hidden {
                display: none !important;
            }

            html.xss-hide-footer body .nexfooter,
            html.xss-hide-footer body .nexfttop,
            html.xss-hide-footer body .nexftbottom,
            html.xss-hide-footer body #ft {
                display: none !important;
            }

            @media (max-width: 1040px) {
                html body .nex_top_interior {
                    grid-template-columns: 108px minmax(250px, 1fr) 46px;
                }

                html body .nex_nav_ranklist {
                    display: none !important;
                }

                html body .nex_scbar_hot_td {
                    flex-basis: 180px;
                }

                html body .nex_newrecommend {
                    grid-template-columns: minmax(0, 1fr) 220px;
                }
            }

            @media (max-width: 820px) {
                html body .nex_scbar_hot_td {
                    display: none !important;
                }

                html body .nex_newrecommend {
                    grid-template-columns: minmax(0, 1fr);
                }

                html body .nex_recommend_ranks {
                    width: 100% !important;
                }

                html body .nex_Ranklists > ul {
                    grid-template-columns: none;
                    grid-auto-flow: column;
                    grid-auto-columns: minmax(280px, 85vw);
                    overflow-x: auto;
                    overscroll-behavior-inline: contain;
                    scroll-snap-type: x proximity;
                    scrollbar-width: thin;
                }

                html body .nex_Ranklists > ul > li {
                    scroll-snap-align: start;
                }

                html body .nex_mid_ads > ul {
                    grid-template-columns: minmax(0, 1fr);
                }
            }

            @media (max-width: 620px) {
                html body #hd {
                    height: 108px !important;
                }

                html body .nex_top_bg,
                html body .nex_top_bg_inter,
                html body .nex_top_interior {
                    height: 58px !important;
                    min-height: 58px !important;
                }

                html body .nex_top_interior {
                    grid-template-columns: 92px minmax(0, 1fr);
                    gap: 10px;
                    width: calc(100% - 20px) !important;
                }

                html body .nexlogo {
                    width: 92px !important;
                    height: 44px !important;
                }

                html body .nexlogo img {
                    max-width: 92px;
                }

                html body .nexdl {
                    display: none !important;
                }

                html body #scbar {
                    min-width: 0;
                }

                html body .nex_scbar_type_td {
                    display: none !important;
                }

                html body .nexnav,
                html body .nexnav > ul,
                html body .nexnav > ul > li,
                html body .nexnav > ul > li > a {
                    height: 50px !important;
                }

                html body .nexnav > ul > li > a {
                    padding: 0 14px !important;
                    font-size: 14px !important;
                }

                html body .nex_index_top > .w1180 {
                    width: calc(100% - 20px) !important;
                    margin-top: 14px !important;
                }

                html body .nex_tuijian,
                html body .nex_pubpart,
                html body .nex_gongxianbox,
                html body .nex_latest_left,
                html body .nex_recommend_ranks,
                html body .nex_Ranklists > ul > li {
                    padding: 12px !important;
                    border-radius: 12px;
                }

                html body .nex_common_hd {
                    min-height: 40px !important;
                    margin-bottom: 12px !important;
                }

                html body .nex_common_hd > span {
                    font-size: 17px !important;
                }

                html body .nex_common_hd {
                    flex-wrap: wrap;
                    gap: 8px;
                }

                html body .nex_common_hd .nex_more_btns {
                    margin-left: 0 !important;
                }

                html body .nex_newrecos .dxb_bc,
                html body .nex_pubpart .nex_acgbox .dxb_bc {
                    grid-template-columns: repeat(2, minmax(0, 1fr));
                    gap: 18px 8px;
                }

                html[data-xss-image-mode="masonry"] body .nex_newrecos .dxb_bc,
                html[data-xss-image-mode="masonry"] body .nex_pubpart .nex_acgbox .dxb_bc {
                    column-count: 2;
                    column-width: auto;
                    column-gap: 8px;
                }

                html[data-xss-image-mode="masonry"] body .nex_newrecos .dxb_bc > li,
                html[data-xss-image-mode="masonry"] body .nex_pubpart .nex_acgbox .dxb_bc > dd {
                    margin-bottom: 14px !important;
                }

                html body .nex_newrecos_btms h5,
                html body .nex_acgcommon_btm h5 {
                    font-size: 13px !important;
                }
            }

            @media (max-width: 360px) {
                html body .nex_newrecos .dxb_bc,
                html body .nex_pubpart .nex_acgbox .dxb_bc {
                    grid-template-columns: minmax(0, 1fr);
                }

                html[data-xss-image-mode="masonry"] body .nex_newrecos .dxb_bc,
                html[data-xss-image-mode="masonry"] body .nex_pubpart .nex_acgbox .dxb_bc {
                    column-count: 1;
                }
            }

            @media (prefers-reduced-motion: reduce) {
                html {
                    scroll-behavior: auto;
                }

                html body .nex_newrecos_img img,
                html body .nex_acgcommon_img img {
                    transition: none;
                }
            }
        `;
        (document.head || document.documentElement).appendChild(style);
    }

    function icon(name) {
        var icons = {
            compass: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="m15.5 8.5-2 5-5 2 2-5 5-2Z"/></svg>',
            close: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg>',
            list: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6h10M9 12h10M9 18h10"/><circle cx="5" cy="6" r="1"/><circle cx="5" cy="12" r="1"/><circle cx="5" cy="18" r="1"/></svg>',
            tune: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h10M18 7h2M4 17h2M10 17h10M14 4v6M6 14v6"/></svg>',
            eye: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z"/><circle cx="12" cy="12" r="2.5"/></svg>'
        };
        return icons[name] || '';
    }

    function injectNavigation() {
        if (!document.body || document.getElementById('xss-ui-host')) return;

        var host = document.createElement('div');
        host.id = 'xss-ui-host';
        host.setAttribute('data-xss-injected', '1');
        document.body.appendChild(host);

        var shadow = host.attachShadow({ mode: 'open' });
        shadow.innerHTML = `
            <style>
                :host {
                    --accent: #f26a3d;
                    --accent-hover: #dd562d;
                    --accent-soft: #fff1eb;
                    --surface: #fff;
                    --subtle: #f7f8fa;
                    --border: #e6e8ec;
                    --text: #25282e;
                    --muted: #747b86;
                    --shadow: 0 18px 50px rgba(22, 27, 34, .17);
                    all: initial;
                    position: fixed;
                    inset: 0;
                    z-index: 2147483646;
                    pointer-events: none;
                    color: var(--text);
                    font-family: Inter, "PingFang SC", "Microsoft YaHei", system-ui, sans-serif;
                    font-size: 14px;
                    line-height: 1.5;
                }

                *, *::before, *::after { box-sizing: border-box; }
                button, input { font: inherit; }
                button { color: inherit; }
                svg {
                    display: block;
                    width: 19px;
                    height: 19px;
                    fill: none;
                    stroke: currentColor;
                    stroke-width: 1.8;
                    stroke-linecap: round;
                    stroke-linejoin: round;
                }

                .launcher {
                    position: fixed;
                    right: 18px;
                    bottom: 22px;
                    display: inline-flex;
                    align-items: center;
                    gap: 8px;
                    height: 44px;
                    padding: 0 15px;
                    pointer-events: auto;
                    color: #fff;
                    background: var(--accent);
                    border: 0;
                    border-radius: 12px;
                    box-shadow: 0 9px 28px rgba(223, 86, 45, .3);
                    cursor: pointer;
                    font-weight: 650;
                    transition: background .16s ease, transform .16s ease;
                }

                .launcher:hover { background: var(--accent-hover); transform: translateY(-1px); }
                .launcher:active { transform: translateY(0); }

                .backdrop {
                    position: fixed;
                    inset: 0;
                    display: none;
                    pointer-events: auto;
                    background: rgba(18, 22, 28, .34);
                    backdrop-filter: blur(2px);
                }

                .backdrop.open { display: block; }

                .panel {
                    position: fixed;
                    right: 16px;
                    bottom: 76px;
                    display: flex;
                    flex-direction: column;
                    width: min(360px, calc(100vw - 24px));
                    max-height: min(720px, calc(100dvh - 96px));
                    pointer-events: auto;
                    visibility: hidden;
                    opacity: 0;
                    transform: translateY(10px) scale(.985);
                    overflow: hidden;
                    background: var(--surface);
                    border: 1px solid var(--border);
                    border-radius: 16px;
                    box-shadow: var(--shadow);
                    transition: opacity .16s ease, transform .16s ease, visibility .16s;
                }

                .panel.open {
                    visibility: visible;
                    opacity: 1;
                    transform: none;
                }

                .panel-head {
                    display: flex;
                    align-items: center;
                    gap: 10px;
                    min-height: 58px;
                    padding: 11px 12px 9px 16px;
                    border-bottom: 1px solid var(--border);
                }

                .panel-title {
                    flex: 1;
                    min-width: 0;
                }

                .panel-title strong {
                    display: block;
                    font-size: 15px;
                    line-height: 1.25;
                }

                .panel-title span {
                    display: block;
                    margin-top: 2px;
                    color: var(--muted);
                    font-size: 12px;
                }

                .icon-button {
                    display: inline-grid;
                    place-items: center;
                    width: 36px;
                    height: 36px;
                    padding: 0;
                    color: var(--muted);
                    background: transparent;
                    border: 0;
                    border-radius: 9px;
                    cursor: pointer;
                }

                .icon-button:hover { color: var(--text); background: var(--subtle); }

                .tabs {
                    display: grid;
                    grid-template-columns: 1fr 1fr;
                    gap: 4px;
                    margin: 10px 12px 4px;
                    padding: 4px;
                    background: var(--subtle);
                    border-radius: 10px;
                }

                .tab {
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    gap: 7px;
                    min-height: 36px;
                    padding: 0 10px;
                    color: var(--muted);
                    background: transparent;
                    border: 0;
                    border-radius: 8px;
                    cursor: pointer;
                }

                .tab[aria-selected="true"] {
                    color: var(--text);
                    background: var(--surface);
                    box-shadow: 0 1px 4px rgba(26, 31, 38, .09);
                    font-weight: 650;
                }

                .tab svg { width: 17px; height: 17px; }

                .view {
                    display: none;
                    min-height: 0;
                    overflow-y: auto;
                    overscroll-behavior: contain;
                    scrollbar-width: thin;
                }

                .view.active { display: block; }

                .toc {
                    margin: 5px 0 10px;
                    padding: 0 8px;
                }

                .toc-item {
                    display: grid;
                    grid-template-columns: 26px minmax(0, 1fr);
                    align-items: center;
                    gap: 9px;
                    width: 100%;
                    min-height: 42px;
                    padding: 5px 9px;
                    text-align: left;
                    background: transparent;
                    border: 0;
                    border-radius: 9px;
                    cursor: pointer;
                }

                .toc-item:hover { background: var(--subtle); }

                .toc-item[aria-current="true"] {
                    color: var(--accent-hover);
                    background: var(--accent-soft);
                    font-weight: 650;
                }

                .toc-number {
                    display: grid;
                    place-items: center;
                    width: 24px;
                    height: 24px;
                    color: var(--muted);
                    background: var(--subtle);
                    border: 1px solid var(--border);
                    border-radius: 7px;
                    font-size: 11px;
                    font-variant-numeric: tabular-nums;
                }

                .toc-item[aria-current="true"] .toc-number {
                    color: var(--accent-hover);
                    background: #fff;
                    border-color: #ffd2c2;
                }

                .toc-label {
                    overflow: hidden;
                    text-overflow: ellipsis;
                    white-space: nowrap;
                }

                .settings {
                    padding: 8px 12px 14px;
                }

                .section-label {
                    display: flex;
                    align-items: center;
                    justify-content: space-between;
                    margin: 11px 4px 6px;
                    color: var(--muted);
                    font-size: 12px;
                    font-weight: 650;
                    letter-spacing: .02em;
                }

                .text-button {
                    padding: 3px 6px;
                    color: var(--accent-hover);
                    background: transparent;
                    border: 0;
                    border-radius: 5px;
                    cursor: pointer;
                    font-size: 12px;
                }

                .text-button:hover { background: var(--accent-soft); }

                .setting-row {
                    display: grid;
                    grid-template-columns: minmax(0, 1fr) auto;
                    align-items: center;
                    gap: 14px;
                    min-height: 58px;
                    padding: 9px 10px;
                    border-bottom: 1px solid var(--border);
                }

                .setting-row:last-child { border-bottom: 0; }
                .setting-copy strong { display: block; font-size: 13px; font-weight: 600; }
                .setting-copy span { display: block; margin-top: 2px; color: var(--muted); font-size: 11px; }

                .setting-row.image-mode-row {
                    grid-template-columns: minmax(0, 1fr);
                    gap: 9px;
                    padding-block: 11px 12px;
                }

                .mode-options {
                    display: grid;
                    grid-template-columns: repeat(3, minmax(0, 1fr));
                    gap: 4px;
                    padding: 3px;
                    background: #f1f2f4;
                    border: 1px solid var(--border);
                    border-radius: 9px;
                }

                .mode-option {
                    min-width: 0;
                    height: 30px;
                    padding: 0 5px;
                    color: var(--muted);
                    background: transparent;
                    border: 0;
                    border-radius: 6px;
                    cursor: pointer;
                    font: inherit;
                    font-size: 12px;
                    font-weight: 600;
                    white-space: nowrap;
                    transition: color .16s ease, background .16s ease, box-shadow .16s ease;
                }

                .mode-option:hover { color: var(--text); }

                .mode-option[aria-checked="true"] {
                    color: var(--accent-strong);
                    background: #fff;
                    box-shadow: 0 1px 4px rgba(25, 30, 38, .12);
                }

                .switch {
                    position: relative;
                    width: 40px;
                    height: 23px;
                    padding: 0;
                    background: #cfd3da;
                    border: 0;
                    border-radius: 999px;
                    cursor: pointer;
                    transition: background .16s ease;
                }

                .switch::after {
                    content: "";
                    position: absolute;
                    left: 3px;
                    top: 3px;
                    width: 17px;
                    height: 17px;
                    background: #fff;
                    border-radius: 50%;
                    box-shadow: 0 1px 3px rgba(20, 24, 30, .24);
                    transition: transform .16s ease;
                }

                .switch[aria-pressed="true"] { background: var(--accent); }
                .switch[aria-pressed="true"]::after { transform: translateX(17px); }

                .hide-list {
                    overflow: hidden;
                    border: 1px solid var(--border);
                    border-radius: 10px;
                }

                .hide-item {
                    display: grid;
                    grid-template-columns: minmax(0, 1fr) auto;
                    align-items: center;
                    gap: 10px;
                    min-height: 42px;
                    padding: 7px 9px 7px 11px;
                    border-bottom: 1px solid var(--border);
                }

                .hide-item:last-child { border-bottom: 0; }

                .hide-name {
                    overflow: hidden;
                    text-overflow: ellipsis;
                    white-space: nowrap;
                    font-size: 13px;
                }

                .visibility {
                    display: inline-grid;
                    place-items: center;
                    width: 32px;
                    height: 30px;
                    padding: 0;
                    color: var(--muted);
                    background: transparent;
                    border: 0;
                    border-radius: 7px;
                    cursor: pointer;
                }

                .visibility:hover { color: var(--text); background: var(--subtle); }
                .visibility[aria-pressed="true"] { color: var(--accent-hover); background: var(--accent-soft); }
                .visibility svg { width: 17px; height: 17px; }
                .visibility[aria-pressed="true"] svg { opacity: .55; }

                .empty {
                    padding: 30px 20px;
                    color: var(--muted);
                    text-align: center;
                    font-size: 13px;
                }

                .status {
                    position: fixed;
                    left: 50%;
                    bottom: 22px;
                    max-width: min(360px, calc(100vw - 32px));
                    padding: 9px 13px;
                    pointer-events: none;
                    opacity: 0;
                    transform: translate(-50%, 8px);
                    color: #fff;
                    background: #24272d;
                    border-radius: 9px;
                    box-shadow: 0 8px 28px rgba(0, 0, 0, .2);
                    font-size: 12px;
                    transition: opacity .16s ease, transform .16s ease;
                }

                .status.show { opacity: 1; transform: translate(-50%, 0); }

                button:focus-visible {
                    outline: 3px solid rgba(242, 106, 61, .28);
                    outline-offset: 2px;
                }

                @media (min-width: 1580px) {
                    .launcher, .backdrop, .close-button { display: none !important; }

                    .panel {
                        left: 14px;
                        right: auto;
                        top: 120px;
                        bottom: auto;
                        width: max(176px, calc((100vw - 1180px) / 2 - 24px));
                        max-width: 220px;
                        max-height: calc(100dvh - 140px);
                        visibility: visible;
                        opacity: 1;
                        transform: none;
                        border-radius: 14px;
                        box-shadow: 0 10px 34px rgba(22, 27, 34, .1);
                    }

                    .panel-head { padding-left: 13px; }
                    .panel-title span { display: none; }
                    .tabs { margin-inline: 8px; }
                    .tab { padding-inline: 6px; font-size: 12px; }
                    .toc { padding-inline: 5px; }
                    .toc-item { grid-template-columns: 23px minmax(0, 1fr); gap: 6px; padding-inline: 6px; }
                    .toc-number { width: 22px; height: 22px; }
                    .settings { padding-inline: 7px; }
                    .setting-row { padding-inline: 6px; gap: 8px; }
                    .setting-copy span { display: none; }
                    .hide-item { padding-inline: 7px; }
                }

                @media (max-width: 560px) {
                    .launcher {
                        right: 12px;
                        bottom: 12px;
                        width: 44px;
                        padding: 0;
                        justify-content: center;
                        border-radius: 13px;
                    }

                    .launcher span { display: none; }

                    .panel {
                        inset: auto 0 0 0;
                        width: 100%;
                        max-height: min(82dvh, 720px);
                        border-width: 1px 0 0;
                        border-radius: 18px 18px 0 0;
                        transform: translateY(24px);
                    }

                    .panel.open { transform: none; }
                    .status { bottom: 66px; }
                }

                @media (prefers-reduced-motion: reduce) {
                    .launcher, .panel, .status, .switch, .switch::after, .mode-option { transition: none; }
                }
            </style>

            <button class="launcher" type="button" aria-haspopup="dialog" aria-expanded="false">
                ${icon('compass')}
                <span>页面导航</span>
            </button>
            <div class="backdrop"></div>
            <aside class="panel" role="dialog" aria-modal="false" aria-label="页面导航与显示设置">
                <header class="panel-head">
                    ${icon('compass')}
                    <div class="panel-title">
                        <strong>页面导航</strong>
                        <span class="module-count">正在识别栏目…</span>
                    </div>
                    <button class="icon-button close-button" type="button" aria-label="关闭面板">
                        ${icon('close')}
                    </button>
                </header>
                <div class="tabs" role="tablist" aria-label="面板内容">
                    <button class="tab" type="button" role="tab" aria-selected="true" data-view="toc">
                        ${icon('list')}<span>目录</span>
                    </button>
                    <button class="tab" type="button" role="tab" aria-selected="false" data-view="settings">
                        ${icon('tune')}<span>显示</span>
                    </button>
                </div>
                <section class="view active" data-panel="toc" role="tabpanel">
                    <nav class="toc" aria-label="页面栏目"></nav>
                </section>
                <section class="view" data-panel="settings" role="tabpanel">
                    <div class="settings">
                        <div class="section-label">页面显示</div>
                        <div class="setting-row image-mode-row">
                            <div class="setting-copy">
                                <strong>图片布局</strong>
                                <span>瀑布流按原始比例排版，竖图不裁剪</span>
                            </div>
                            <div class="mode-options" role="radiogroup" aria-label="图片布局">
                                <button class="mode-option" type="button" role="radio" aria-checked="false" data-image-mode="cover">裁剪</button>
                                <button class="mode-option" type="button" role="radio" aria-checked="false" data-image-mode="contain">完整</button>
                                <button class="mode-option" type="button" role="radio" aria-checked="false" data-image-mode="masonry">瀑布流</button>
                            </div>
                        </div>
                        <div class="setting-row">
                            <div class="setting-copy">
                                <strong>隐藏页脚</strong>
                                <span>收起底部介绍与声明</span>
                            </div>
                            <button class="switch footer-switch" type="button" aria-pressed="false" aria-label="隐藏页脚"></button>
                        </div>
                        <div class="section-label">
                            <span>栏目显隐</span>
                            <button class="text-button show-all" type="button">全部显示</button>
                        </div>
                        <div class="hide-list"></div>
                    </div>
                </section>
            </aside>
            <div class="status" role="status" aria-live="polite"></div>
        `;

        var launcher = shadow.querySelector('.launcher');
        var backdrop = shadow.querySelector('.backdrop');
        var panel = shadow.querySelector('.panel');
        var closeButton = shadow.querySelector('.close-button');
        var tabs = Array.from(shadow.querySelectorAll('.tab'));
        var imageModeButtons = Array.from(shadow.querySelectorAll('.mode-option'));
        var footerSwitch = shadow.querySelector('.footer-switch');
        var showAll = shadow.querySelector('.show-all');
        var toastTimer = 0;

        function isRail() {
            return window.matchMedia('(min-width: 1580px)').matches;
        }

        function setPanelOpen(open, restoreFocus) {
            var shouldOpen = isRail() || open;
            panel.classList.toggle('open', shouldOpen);
            backdrop.classList.toggle('open', open && !isRail());
            launcher.setAttribute('aria-expanded', String(open));
            panel.setAttribute('aria-modal', String(open && !isRail()));

            if (open && !isRail()) {
                window.setTimeout(function () {
                    var active = shadow.querySelector('.tab[aria-selected="true"]');
                    if (active) active.focus();
                }, 0);
            } else if (restoreFocus && !isRail()) {
                launcher.focus();
            }
        }

        function showStatus(message) {
            var status = shadow.querySelector('.status');
            status.textContent = message;
            status.classList.add('show');
            window.clearTimeout(toastTimer);
            toastTimer = window.setTimeout(function () {
                status.classList.remove('show');
            }, 1800);
        }

        function selectTab(name) {
            tabs.forEach(function (tab) {
                var selected = tab.getAttribute('data-view') === name;
                tab.setAttribute('aria-selected', String(selected));
            });
            shadow.querySelectorAll('.view').forEach(function (view) {
                view.classList.toggle('active', view.getAttribute('data-panel') === name);
            });
            if (name === 'settings') renderSettings(scanModules());
        }

        function syncSwitches() {
            var imageMode = getImageMode();
            imageModeButtons.forEach(function (button) {
                var selected = button.getAttribute('data-image-mode') === imageMode;
                button.setAttribute('aria-checked', String(selected));
                button.tabIndex = selected ? 0 : -1;
            });
            footerSwitch.setAttribute('aria-pressed', String(readStored(STORE_KEY_FOOTER, true) !== false));
        }

        function renderSettings(modules) {
            var hidden = getHiddenKeys();
            var list = shadow.querySelector('.hide-list');

            if (!modules.length) {
                list.innerHTML = '<div class="empty">当前页面没有可管理的栏目</div>';
                return;
            }

            list.innerHTML = '';
            modules.forEach(function (module) {
                var row = document.createElement('div');
                var isHidden = hidden.indexOf(module.key) !== -1;
                row.className = 'hide-item';
                row.innerHTML = `
                    <span class="hide-name"></span>
                    <button class="visibility" type="button" aria-pressed="${String(isHidden)}"
                        aria-label="${isHidden ? '显示' : '隐藏'} ${escapeText(module.title)}">
                        ${icon('eye')}
                    </button>
                `;
                row.querySelector('.hide-name').textContent = module.title;
                row.querySelector('.visibility').addEventListener('click', function () {
                    var nextHidden = this.getAttribute('aria-pressed') !== 'true';
                    setModuleHidden(module.key, nextHidden);
                    showStatus(nextHidden ? '已隐藏「' + module.title + '」' : '已显示「' + module.title + '」');
                });
                list.appendChild(row);
            });
        }

        launcher.addEventListener('click', function () {
            setPanelOpen(true, false);
        });
        closeButton.addEventListener('click', function () {
            setPanelOpen(false, true);
        });
        backdrop.addEventListener('click', function () {
            setPanelOpen(false, true);
        });

        tabs.forEach(function (tab, index) {
            tab.addEventListener('click', function () {
                selectTab(tab.getAttribute('data-view'));
            });
            tab.addEventListener('keydown', function (event) {
                if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
                event.preventDefault();
                var direction = event.key === 'ArrowRight' ? 1 : -1;
                var next = tabs[(index + direction + tabs.length) % tabs.length];
                next.focus();
                selectTab(next.getAttribute('data-view'));
            });
        });

        function activateImageMode(mode, focusButton) {
            var labels = {
                cover: '填充裁剪',
                contain: '完整显示',
                masonry: '瀑布流'
            };
            setImageMode(mode);
            applyImageMode();
            syncSwitches();
            if (focusButton) {
                var selected = shadow.querySelector('.mode-option[data-image-mode="' + mode + '"]');
                if (selected) selected.focus();
            }
            showStatus('图片已切换为' + labels[mode]);
        }

        imageModeButtons.forEach(function (button, index) {
            button.addEventListener('click', function () {
                activateImageMode(this.getAttribute('data-image-mode'), false);
            });
            button.addEventListener('keydown', function (event) {
                var keys = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'];
                if (keys.indexOf(event.key) === -1) return;
                event.preventDefault();
                var nextIndex = index;
                if (event.key === 'Home') nextIndex = 0;
                if (event.key === 'End') nextIndex = imageModeButtons.length - 1;
                if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
                    nextIndex = (index - 1 + imageModeButtons.length) % imageModeButtons.length;
                }
                if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
                    nextIndex = (index + 1) % imageModeButtons.length;
                }
                activateImageMode(imageModeButtons[nextIndex].getAttribute('data-image-mode'), true);
            });
        });

        footerSwitch.addEventListener('click', function () {
            var enabled = this.getAttribute('aria-pressed') !== 'true';
            writeStored(STORE_KEY_FOOTER, enabled);
            applyFooterMode();
            syncSwitches();
            showStatus(enabled ? '页脚已隐藏' : '页脚已显示');
        });

        showAll.addEventListener('click', function () {
            setHiddenKeys([]);
            var modules = scanModules();
            applyModuleVisibility(modules);
            refreshNavigation(modules);
            showStatus('所有栏目均已显示');
        });

        shadow.addEventListener('keydown', function (event) {
            if (event.key === 'Escape' && !isRail()) {
                setPanelOpen(false, true);
                return;
            }
            if (event.key === 'Tab' && panel.classList.contains('open') && !isRail()) {
                var focusable = Array.from(panel.querySelectorAll('button:not([disabled])'))
                    .filter(function (element) {
                        return element.offsetParent !== null;
                    });
                if (!focusable.length) return;
                var first = focusable[0];
                var last = focusable[focusable.length - 1];
                if (event.shiftKey && shadow.activeElement === first) {
                    event.preventDefault();
                    last.focus();
                } else if (!event.shiftKey && shadow.activeElement === last) {
                    event.preventDefault();
                    first.focus();
                }
            }
        });

        window.matchMedia('(min-width: 1580px)').addEventListener('change', function () {
            setPanelOpen(false, false);
        });

        syncSwitches();
        setPanelOpen(false, false);
    }

    function escapeText(value) {
        return String(value || '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function refreshNavigation(modules) {
        var host = document.getElementById('xss-ui-host');
        if (!host || !host.shadowRoot) return;
        var shadow = host.shadowRoot;
        var list = shadow.querySelector('.toc');
        var count = shadow.querySelector('.module-count');
        var visibleModules = (modules || scanModules()).filter(function (module) {
            return !module.element.classList.contains('xss-module-hidden');
        });

        count.textContent = visibleModules.length + ' 个可见栏目';
        list.innerHTML = '';

        if (!visibleModules.length) {
            list.innerHTML = '<div class="empty">没有可见栏目<br>可在“显示”中恢复</div>';
        } else {
            visibleModules.forEach(function (module, index) {
                var button = document.createElement('button');
                button.className = 'toc-item';
                button.type = 'button';
                button.setAttribute('data-anchor', module.anchor);
                button.setAttribute('aria-current', 'false');
                button.innerHTML =
                    '<span class="toc-number">' + String(index + 1).padStart(2, '0') + '</span>' +
                    '<span class="toc-label"></span>';
                button.querySelector('.toc-label').textContent = module.title;
                button.addEventListener('click', function () {
                    module.element.scrollIntoView({
                        behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
                        block: 'start'
                    });
                    if (!window.matchMedia('(min-width: 1580px)').matches) {
                        var panel = shadow.querySelector('.panel');
                        var backdrop = shadow.querySelector('.backdrop');
                        panel.classList.remove('open');
                        panel.setAttribute('aria-modal', 'false');
                        backdrop.classList.remove('open');
                        shadow.querySelector('.launcher').setAttribute('aria-expanded', 'false');
                    }
                });
                list.appendChild(button);
            });
        }

        var settingsView = shadow.querySelector('[data-panel="settings"]');
        if (settingsView.classList.contains('active')) {
            var settingsTab = shadow.querySelector('[data-view="settings"]');
            if (settingsTab) settingsTab.click();
        }

        setupSectionHighlight(visibleModules, shadow);
    }

    function setupSectionHighlight(modules, shadow) {
        if (sectionObserver) sectionObserver.disconnect();
        if (!modules.length || typeof IntersectionObserver !== 'function') return;

        var visible = Object.create(null);
        sectionObserver = new IntersectionObserver(function (entries) {
            entries.forEach(function (entry) {
                var anchor = entry.target.getAttribute('data-xss-section');
                if (!anchor) return;
                if (entry.isIntersecting) {
                    visible[anchor] = entry.boundingClientRect.top;
                } else {
                    delete visible[anchor];
                }
            });

            var active = Object.keys(visible).sort(function (a, b) {
                return Math.abs(visible[a]) - Math.abs(visible[b]);
            })[0];

            shadow.querySelectorAll('.toc-item').forEach(function (item) {
                item.setAttribute('aria-current', String(item.getAttribute('data-anchor') === active));
            });
        }, {
            root: null,
            rootMargin: '-12% 0px -68% 0px',
            threshold: 0
        });

        modules.forEach(function (module) {
            sectionObserver.observe(module.element);
        });
    }

    function scheduleRefresh() {
        window.clearTimeout(refreshTimer);
        refreshTimer = window.setTimeout(function () {
            var modules = scanModules();
            applyModuleVisibility(modules);
            refreshNavigation(modules);
        }, 180);
    }

    function startEnhancerObserver() {
        if (enhancerObserver || !document.documentElement) return;
        enhancerObserver = new MutationObserver(function (mutations) {
            var needsRefresh = mutations.some(function (mutation) {
                return Array.from(mutation.addedNodes).some(function (node) {
                    if (node.nodeType !== 1 || !node.matches) return false;
                    return node.matches(MODULE_SELECTOR) ||
                        (node.querySelector && node.querySelector(MODULE_SELECTOR));
                });
            });
            if (needsRefresh) scheduleRefresh();
        });
        enhancerObserver.observe(document.documentElement, { childList: true, subtree: true });
    }

    function bootEnhancer() {
        if (!document.body) return;
        // document-start 时提前插入的 head/body 节点可能被 HTML 解析器重建，
        // DOMContentLoaded 后再次保证样式和界面宿主存在。
        ensureViewportMeta();
        injectPageStyles();
        migrateLegacySettings();
        applyImageMode();
        applyFooterMode();
        injectNavigation();

        var modules = scanModules();
        applyModuleVisibility(modules);
        refreshNavigation(modules);
        startEnhancerObserver();
    }

    function ensureEnhancerBooted() {
        if (!document.body || !document.querySelector(MODULE_SELECTOR)) return false;
        bootEnhancer();
        var complete = !!document.querySelector('style[data-xss-enhancer-style]') &&
            !!document.getElementById('xss-ui-host');
        if (complete && bootObserver) {
            bootObserver.disconnect();
            bootObserver = null;
        }
        return complete;
    }

    try {
        var normalizedLocation = normalizeUrl(location.href);
        if (normalizedLocation !== location.href) {
            location.replace(normalizedLocation);
            return;
        }
    } catch (error) {}

    patchNavigationApis();

    if (document.documentElement) {
        ensureViewportMeta();
        startLinkNormalizer();
        injectPageStyles();
    } else {
        document.addEventListener('readystatechange', function onReady() {
            if (!document.documentElement) return;
            document.removeEventListener('readystatechange', onReady);
            ensureViewportMeta();
            startLinkNormalizer();
            injectPageStyles();
        });
    }

    if (!isTargetHost(location.hostname)) return;

    if (!ensureEnhancerBooted() && document.documentElement) {
        bootObserver = new MutationObserver(ensureEnhancerBooted);
        bootObserver.observe(document.documentElement, { childList: true, subtree: true });
        document.addEventListener('DOMContentLoaded', ensureEnhancerBooted, { once: true });
        window.addEventListener('load', function () {
            ensureEnhancerBooted();
            window.setTimeout(function () {
                if (bootObserver) {
                    bootObserver.disconnect();
                    bootObserver = null;
                }
            }, 2200);
        }, { once: true });
        [0, 250, 800, 1800].forEach(function (delay) {
            window.setTimeout(ensureEnhancerBooted, delay);
        });
    }

    console.info('[xsijishe-enhancer] v' + VERSION + ' loaded');
})();
