// ==UserScript==
// @name         JPopSuki Batch RSS Manager
// @namespace    https://jpopsuki.eu/
// @version      0.1.0
// @description  Batch-create JPopSuki notification filters and export their RSS subscriptions as JSON
// @match        https://jpopsuki.eu/user.php?action=notify*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  const CATEGORIES = [
    'Album',
    'Single',
    'PV',
    'DVD',
    'TV-Music',
    'TV-Variety',
    'TV-Drama',
    'Fansubs',
    'Pictures',
    'Misc',
  ];

  function createPanel() {
    const panel = document.createElement('div');
    panel.id = 'jps-batch-rss-panel';
    panel.style.position = 'fixed';
    panel.style.right = '16px';
    panel.style.bottom = '16px';
    panel.style.zIndex = '9999';
    panel.style.background = '#1b1b1b';
    panel.style.color = '#eee';
    panel.style.border = '1px solid #444';
    panel.style.borderRadius = '8px';
    panel.style.padding = '12px';
    panel.style.width = '320px';
    panel.style.font = '14px/1.4 -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Helvetica, Arial';

    const title = document.createElement('div');
    title.textContent = 'JPopSuki Batch RSS Manager';
    title.style.fontWeight = '600';
    title.style.marginBottom = '8px';

    const artistWrap = document.createElement('div');
    artistWrap.style.marginBottom = '8px';
    const artistLabel = document.createElement('label');
    artistLabel.textContent = 'Artist:';
    artistLabel.style.display = 'block';
    const artistInput = document.createElement('input');
    artistInput.type = 'text';
    artistInput.placeholder = 'e.g. ITZY';
    artistInput.style.width = '100%';
    artistInput.style.boxSizing = 'border-box';
    artistInput.style.padding = '6px 8px';
    artistInput.style.border = '1px solid #555';
    artistInput.style.borderRadius = '6px';
    artistInput.id = 'jps-batch-artist';
    artistWrap.appendChild(artistLabel);
    artistWrap.appendChild(artistInput);

    const catsWrap = document.createElement('div');
    catsWrap.style.margin = '8px 0';
    catsWrap.style.maxHeight = '180px';
    catsWrap.style.overflow = 'auto';
    catsWrap.style.border = '1px solid #333';
    catsWrap.style.borderRadius = '6px';
    catsWrap.style.padding = '6px';
    CATEGORIES.forEach((cat) => {
      const row = document.createElement('label');
      row.style.display = 'flex';
      row.style.alignItems = 'center';
      row.style.gap = '6px';
      row.style.margin = '2px 0';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.value = cat;
      cb.checked = true;
      cb.className = 'jps-batch-cat';
      const span = document.createElement('span');
      span.textContent = cat;
      row.appendChild(cb);
      row.appendChild(span);
      catsWrap.appendChild(row);
    });

    const buttons = document.createElement('div');
    buttons.style.display = 'flex';
    buttons.style.gap = '8px';
    buttons.style.marginTop = '8px';
    const runBtn = document.createElement('button');
    runBtn.textContent = 'Create Filters';
    runBtn.style.flex = '1';
    runBtn.style.padding = '8px 10px';
    runBtn.style.borderRadius = '6px';
    runBtn.style.border = '1px solid #555';
    runBtn.style.background = '#2b6cb0';
    runBtn.style.color = '#fff';
    runBtn.style.cursor = 'pointer';

    const extractBtn = document.createElement('button');
    extractBtn.textContent = 'Extract';
    extractBtn.style.padding = '8px 10px';
    extractBtn.style.borderRadius = '6px';
    extractBtn.style.border = '1px solid #555';
    extractBtn.style.background = '#38a169';
    extractBtn.style.color = '#fff';
    extractBtn.style.cursor = 'pointer';

    const closeBtn = document.createElement('button');
    closeBtn.textContent = 'Close';
    closeBtn.style.padding = '8px 10px';
    closeBtn.style.borderRadius = '6px';
    closeBtn.style.border = '1px solid #555';
    closeBtn.style.background = '#333';
    closeBtn.style.color = '#ddd';
    closeBtn.style.cursor = 'pointer';

    buttons.appendChild(runBtn);
    buttons.appendChild(extractBtn);
    buttons.appendChild(closeBtn);

    const logArea = document.createElement('div');
    logArea.id = 'jps-batch-log';
    logArea.style.marginTop = '10px';
    logArea.style.maxHeight = '220px';
    logArea.style.overflow = 'auto';
    logArea.style.background = '#121212';
    logArea.style.border = '1px solid #333';
    logArea.style.borderRadius = '6px';
    logArea.style.padding = '8px';

    panel.appendChild(title);
    panel.appendChild(artistWrap);
    panel.appendChild(catsWrap);
    panel.appendChild(buttons);
    panel.appendChild(logArea);

    document.body.appendChild(panel);

    closeBtn.addEventListener('click', () => panel.remove());
    extractBtn.addEventListener('click', () => {
      const data = extractRssFromDom();
      appendLog('Extracted ' + data.length + ' RSS items from current page.');
      renderJsonResult(data);
    });
    runBtn.addEventListener('click', async () => {
      const artist = artistInput.value.trim();
      if (!artist) {
        appendLog('Please input an artist.');
        return;
      }
      const selectedCats = Array.from(
        panel.querySelectorAll('input.jps-batch-cat:checked')
      ).map((n) => n.value);

      if (selectedCats.length === 0) {
        appendLog('Please select at least one category.');
        return;
      }

      runBtn.disabled = true;
      try {
        appendLog(`Creating filters for "${artist}" ...`);
        await createFiltersSequential(artist, selectedCats);
        appendLog('Filters created. Refreshing page to load new RSS links ...');
        setTimeout(() => {
          window.location.reload();
        }, 600);
      } catch (err) {
        appendLog('Error: ' + (err && err.message ? err.message : String(err)));
      } finally {
        runBtn.disabled = false;
      }
    });

    function appendLog(msg) {
      const p = document.createElement('div');
      p.textContent = msg;
      logArea.appendChild(p);
      logArea.scrollTop = logArea.scrollHeight;
    }
  }

  async function createFiltersSequential(artist, categories) {
    for (const category of categories) {
      const label = `${artist} ${category}`;
      await createFilter({ label, artist, category });
    }
  }

  async function createFilter({ label, artist, category }) {
    const form = new URLSearchParams();
    form.set('action', 'notify_handle');
    form.set('label', label);
    form.set('artists', artist);
    form.append('categories[]', category);

    const res = await fetch('/user.php', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      credentials: 'same-origin',
      redirect: 'follow',
      body: form.toString(),
    });
    // Server typically 302 redirects back to notify page; following is fine.
    if (!res.ok && res.status !== 0) {
      throw new Error(`Failed to create filter: ${label} (status ${res.status})`);
    }
  }

  function extractRssFromDom() {
    const items = [];
    const h3s = Array.from(document.querySelectorAll('h3'));
    for (const h3 of h3s) {
      const a = h3.querySelector('a[href*="feeds.php?feed=torrents_notify_"]');
      if (!a) continue;
      const href = a.getAttribute('href');
      if (!href) continue;
      let label = '';
      // Prefer "name" parameter from the query string
      try {
        const u = new URL(href, window.location.origin);
        const nameParam = u.searchParams.get('name');
        if (nameParam) {
          label = decodeURIComponent(nameParam.replace(/\+/g, ' '));
        }
      } catch (_) {}
      if (!label) {
        // Fallback: take text content inside h3 minus the Delete link
        const clone = h3.cloneNode(true);
        const del = clone.querySelector('a[href*="notify_delete"]');
        if (del && del.parentElement) del.parentElement.removeChild(del);
        const img = clone.querySelector('img');
        if (img && img.parentElement) img.parentElement.removeChild(img);
        label = (clone.textContent || '').replace(/\(\s*\)\s*$/, '').trim();
      }
      const absUrl = new URL(href, window.location.origin).href;
      items.push({ label, url: absUrl });
    }
    return items;
  }

  function renderJsonResult(items) {
    const container = document.createElement('div');
    container.style.marginTop = '8px';
    const ta = document.createElement('textarea');
    ta.style.width = '100%';
    ta.style.boxSizing = 'border-box';
    ta.style.height = '160px';
    ta.style.background = '#0f0f0f';
    ta.style.color = '#e2e8f0';
    ta.style.border = '1px solid #333';
    ta.style.borderRadius = '6px';
    ta.readOnly = true;
    // Output minimal JSON for import usage
    ta.value = JSON.stringify(items, null, 2);

    const copyBtn = document.createElement('button');
    copyBtn.textContent = 'Copy JSON';
    copyBtn.style.marginTop = '6px';
    copyBtn.style.padding = '6px 10px';
    copyBtn.style.borderRadius = '6px';
    copyBtn.style.border = '1px solid #555';
    copyBtn.style.background = '#4a5568';
    copyBtn.style.color = '#fff';
    copyBtn.style.cursor = 'pointer';
    copyBtn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(ta.value);
      } catch (_) {
        ta.select();
        document.execCommand('copy');
      }
    });

    container.appendChild(ta);
    container.appendChild(copyBtn);
    const logArea = document.getElementById('jps-batch-log');
    if (logArea) logArea.appendChild(container);
  }

  function ensureTriggerButton() {
    if (document.getElementById('jps-batch-rss-open')) return;
    const btn = document.createElement('button');
    btn.id = 'jps-batch-rss-open';
    btn.textContent = 'JPopSuki RSS';
    btn.style.position = 'fixed';
    btn.style.right = '16px';
    btn.style.bottom = '16px';
    btn.style.zIndex = '9998';
    btn.style.padding = '8px 10px';
    btn.style.borderRadius = '6px';
    btn.style.border = '1px solid #555';
    btn.style.background = '#2d3748';
    btn.style.color = '#fff';
    btn.style.cursor = 'pointer';
    btn.addEventListener('click', () => {
      if (!document.getElementById('jps-batch-rss-panel')) {
        createPanel();
      }
    });
    document.body.appendChild(btn);
  }

  ensureTriggerButton();
})();
