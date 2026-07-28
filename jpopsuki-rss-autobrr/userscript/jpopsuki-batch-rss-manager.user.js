// ==UserScript==
// @name         JPopSuki RSS + Autobrr Manager
// @namespace    https://github.com/silencoo/script-toolbox
// @version      1.0.0
// @description  Create JPopSuki RSS notifications and safely manage their Autobrr indexers, feeds, filters, and qBittorrent actions
// @match        https://jpopsuki.eu/user.php?action=notify*
// @include      http://localhost:7474/*
// @include      http://127.0.0.1:7474/*
// @include      https://localhost:7474/*
// @include      https://127.0.0.1:7474/*
// @homepageURL  https://github.com/silencoo/script-toolbox/tree/main/jpopsuki-rss-autobrr
// @supportURL   https://github.com/silencoo/script-toolbox/issues
// @downloadURL  https://raw.githubusercontent.com/silencoo/script-toolbox/main/jpopsuki-rss-autobrr/userscript/jpopsuki-batch-rss-manager.user.js
// @updateURL    https://raw.githubusercontent.com/silencoo/script-toolbox/main/jpopsuki-rss-autobrr/userscript/jpopsuki-batch-rss-manager.user.js
// @run-at       document-idle
// @sandbox      DOM
// @connect      self
// @connect      localhost
// @connect      127.0.0.1
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_openInTab
// @license      MIT
// ==/UserScript==

(function () {
  'use strict';

  const Core = (() => {
    const STATE_SCHEMA_VERSION = 1;
    const KNOWN_CATEGORIES = [
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
    const FILTER_LIST_FIELDS = [
      'announce_types',
      'resolutions',
      'sources',
      'codecs',
      'containers',
      'match_hdr',
      'except_hdr',
      'match_other',
      'except_other',
      'match_language',
      'except_language',
      'formats',
      'quality',
      'media',
      'match_release_types',
      'origins',
      'except_origins',
      'external',
    ];
    const FILTER_READ_ONLY_FIELDS = new Set([
      'id',
      'name',
      'enabled',
      'indexers',
      'actions',
      'created_at',
      'updated_at',
      'actions_count',
      'actions_enabled_count',
      'is_auto_updated',
      'release_profile_duplicate',
    ]);

    class ToolkitError extends Error {
      constructor(message) {
        super(message);
        this.name = 'ToolkitError';
      }
    }

    function deepClone(value) {
      return JSON.parse(JSON.stringify(value));
    }

    function normalizeLabel(value) {
      if (typeof value !== 'string') {
        throw new ToolkitError('Every subscription label must be text.');
      }
      const label = value.normalize('NFKC').trim().replace(/\s+/g, ' ');
      if (!label) {
        throw new ToolkitError('Subscription labels cannot be empty.');
      }
      if (label.length > 200 || /[\x00-\x1f\x7f]/.test(label)) {
        throw new ToolkitError(`Unsafe subscription label: ${label.slice(0, 40)}`);
      }
      return label;
    }

    function splitLabel(label) {
      const ordered = [...KNOWN_CATEGORIES].sort(
        (left, right) => right.length - left.length
      );
      for (const category of ordered) {
        const suffix = ` ${category}`;
        if (label.endsWith(suffix) && label.length > suffix.length) {
          return {
            artist: label.slice(0, -suffix.length),
            category,
          };
        }
      }
      return { artist: label, category: 'Misc' };
    }

    function sanitizePathComponent(value) {
      const cleaned = String(value)
        .replace(/[\x00-\x1f\x7f/\\:]/g, '_')
        .replace(/\s+/g, ' ')
        .replace(/^[ .]+|[ .]+$/g, '')
        .slice(0, 120);
      if (!cleaned || cleaned === '.' || cleaned === '..') {
        throw new ToolkitError(`Unsafe save-path component from ${value}`);
      }
      return cleaned;
    }

    function normalizeSaveBase(value) {
      if (typeof value !== 'string' || !value.trim()) {
        throw new ToolkitError('Save base cannot be empty.');
      }
      let normalized = value.trim().replace(/\\/g, '/');
      if (!normalized.startsWith('/') && !/^[A-Za-z]:\//.test(normalized)) {
        throw new ToolkitError(
          'Save base must be an absolute POSIX path or Windows drive path.'
        );
      }
      const prefix = /^[A-Za-z]:\//.test(normalized)
        ? normalized.slice(0, 3)
        : '/';
      const remainder = normalized.slice(prefix.length);
      const parts = remainder.split('/').filter(Boolean);
      if (parts.some((part) => part === '.' || part === '..')) {
        throw new ToolkitError('Save base cannot contain . or .. path segments.');
      }
      if (!parts.length) return prefix;
      normalized = `${prefix}${parts.join('/')}`;
      return normalized.replace(/\/+$/, '');
    }

    function buildSavePath(base, subscription) {
      const normalizedBase = normalizeSaveBase(base);
      const separator = normalizedBase.endsWith('/') ? '' : '/';
      return (
        normalizedBase +
        separator +
        sanitizePathComponent(subscription.artist) +
        '/' +
        sanitizePathComponent(subscription.category)
      );
    }

    function normalizeBaseUrl(value) {
      let parsed;
      try {
        parsed = new URL(String(value || '').trim());
      } catch (_) {
        throw new ToolkitError('Autobrr base must be an absolute HTTP(S) URL.');
      }
      if (!['http:', 'https:'].includes(parsed.protocol)) {
        throw new ToolkitError('Autobrr base must use HTTP or HTTPS.');
      }
      if (
        parsed.username ||
        parsed.password ||
        parsed.search ||
        parsed.hash
      ) {
        throw new ToolkitError(
          'Autobrr base cannot contain credentials, query, or fragment.'
        );
      }
      const isLoopback = ['localhost', '127.0.0.1'].includes(
        parsed.hostname.toLowerCase()
      );
      if (parsed.protocol === 'http:' && !isLoopback) {
        throw new ToolkitError(
          'Plain HTTP is allowed only for localhost; use HTTPS remotely.'
        );
      }
      return parsed.href.replace(/\/+$/, '');
    }

    function validateRssUrl(value, label) {
      let parsed;
      try {
        parsed = new URL(String(value || '').trim());
      } catch (_) {
        throw new ToolkitError(`Subscription ${label} has an invalid RSS URL.`);
      }
      if (
        parsed.protocol !== 'https:' ||
        !['jpopsuki.eu', 'www.jpopsuki.eu'].includes(
          parsed.hostname.toLowerCase()
        ) ||
        parsed.pathname.replace(/\/+$/, '') !== '/feeds.php' ||
        (parsed.port && parsed.port !== '443') ||
        parsed.username ||
        parsed.password ||
        parsed.hash
      ) {
        throw new ToolkitError(
          `Subscription ${label} does not use the expected JPopSuki HTTPS feed.`
        );
      }
      if (
        !parsed.searchParams.get('feed') ||
        !['passkey', 'auth', 'authkey'].some((name) =>
          parsed.searchParams.get(name)
        )
      ) {
        throw new ToolkitError(
          `Subscription ${label} is missing RSS credential parameters.`
        );
      }
      return parsed.href;
    }

    async function sha256Hex(value) {
      if (!globalThis.crypto || !globalThis.crypto.subtle) {
        throw new ToolkitError('Web Crypto SHA-256 is unavailable.');
      }
      const bytes = new TextEncoder().encode(value);
      const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
      return Array.from(new Uint8Array(digest))
        .map((byte) => byte.toString(16).padStart(2, '0'))
        .join('');
    }

    async function validateSubscriptions(rows) {
      if (!Array.isArray(rows)) {
        throw new ToolkitError('Subscriptions must be an array.');
      }
      const subscriptions = [];
      const labels = new Map();
      const fingerprints = new Map();
      for (const [position, row] of rows.entries()) {
        if (!row || typeof row !== 'object' || Array.isArray(row)) {
          throw new ToolkitError(`Subscription #${position + 1} is invalid.`);
        }
        const label = normalizeLabel(row.label);
        const url = validateRssUrl(row.url, label);
        const labelKey = label.toLocaleLowerCase('en-US');
        const fingerprint = await sha256Hex(url);
        if (labels.has(labelKey)) {
          if (labels.get(labelKey) === fingerprint) {
            continue;
          }
          throw new ToolkitError(
            `Duplicate label has different RSS URLs: ${label}`
          );
        }
        if (fingerprints.has(fingerprint)) {
          throw new ToolkitError(
            `One RSS URL is assigned to both ${fingerprints.get(
              fingerprint
            )} and ${label}.`
          );
        }
        labels.set(labelKey, fingerprint);
        fingerprints.set(fingerprint, label);
        const { artist, category } = splitLabel(label);
        subscriptions.push({
          label,
          url,
          artist,
          category,
          key: (await sha256Hex(labelKey)).slice(0, 24),
          url_fingerprint: fingerprint,
        });
      }
      if (!subscriptions.length) {
        throw new ToolkitError(
          'No RSS subscriptions were found. Create filters and refresh first.'
        );
      }
      return subscriptions;
    }

    function redactText(value) {
      return String(value)
        .replace(
          /([?&](?:feed|user|auth|authkey|passkey|apikey|api_key)=)[^&\s"'\\]+/gi,
          '$1<redacted>'
        )
        .replace(
          /("(?:[^"]*(?:cookie|token|secret|password|authorization|credential|passkey|authkey|api[_-]?key)[^"]*|auth)"\s*:\s*")[^"]*"/gi,
          '$1<redacted>"'
        );
    }

    function parsePositiveInt(value, field) {
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed <= 0) {
        throw new ToolkitError(`${field} must be a positive integer.`);
      }
      return parsed;
    }

    function emptyState() {
      return { schema_version: STATE_SCHEMA_VERSION, items: {} };
    }

    function validateManagedState(value) {
      if (
        !value ||
        typeof value !== 'object' ||
        Array.isArray(value) ||
        value.schema_version !== STATE_SCHEMA_VERSION ||
        !value.items ||
        typeof value.items !== 'object' ||
        Array.isArray(value.items)
      ) {
        throw new ToolkitError('Managed state has an unsupported schema.');
      }
      const state = emptyState();
      const labels = new Set();
      for (const [key, rawEntry] of Object.entries(value.items)) {
        if (
          !/^[a-f0-9]{24}$/.test(key) ||
          !rawEntry ||
          typeof rawEntry !== 'object' ||
          Array.isArray(rawEntry)
        ) {
          throw new ToolkitError(`Managed state entry ${key} is invalid.`);
        }
        const entry = {
          label: normalizeLabel(rawEntry.label),
        };
        const labelKey = entry.label.toLocaleLowerCase('en-US');
        if (labels.has(labelKey)) {
          throw new ToolkitError(
            `Managed state contains duplicate label ${entry.label}.`
          );
        }
        labels.add(labelKey);
        if (rawEntry.url_fingerprint !== undefined) {
          if (!/^[a-f0-9]{64}$/.test(String(rawEntry.url_fingerprint))) {
            throw new ToolkitError(
              `Managed state fingerprint for ${entry.label} is invalid.`
            );
          }
          entry.url_fingerprint = String(rawEntry.url_fingerprint);
        }
        for (const field of ['indexer_id', 'feed_id', 'filter_id', 'interval']) {
          if (rawEntry[field] !== undefined) {
            entry[field] = parsePositiveInt(rawEntry[field], field);
          }
        }
        entry.complete = rawEntry.complete === true;
        state.items[key] = entry;
      }
      return state;
    }

    function findStateEntry(state, subscription) {
      if (state.items[subscription.key]) {
        return { key: subscription.key, entry: state.items[subscription.key] };
      }
      const labelKey = subscription.label.toLocaleLowerCase('en-US');
      for (const [key, entry] of Object.entries(state.items)) {
        if (
          String(entry.label || '').toLocaleLowerCase('en-US') === labelKey
        ) {
          return { key, entry };
        }
      }
      return null;
    }

    function stateEntryFor(state, subscription) {
      const existing = findStateEntry(state, subscription);
      if (existing) {
        return existing;
      }
      const entry = {
        label: subscription.label,
        url_fingerprint: subscription.url_fingerprint,
        complete: false,
      };
      state.items[subscription.key] = entry;
      return { key: subscription.key, entry };
    }

    function validManagedId(entry, field) {
      const value = Number(entry[field]);
      return Number.isInteger(value) && value > 0 ? value : null;
    }

    function entityId(entity, kind) {
      if (!entity || typeof entity !== 'object') {
        throw new ToolkitError(`${kind} response is not an object.`);
      }
      return parsePositiveInt(entity.id, `${kind} id`);
    }

    function entityName(entity) {
      try {
        return normalizeLabel(entity && entity.name);
      } catch (_) {
        return '';
      }
    }

    function findManagedEntity(
      entities,
      entry,
      idField,
      label,
      adoptExisting,
      kind
    ) {
      const managedId = validManagedId(entry, idField);
      if (managedId !== null) {
        const byId = entities.find((entity) => {
          try {
            return entityId(entity, kind) === managedId;
          } catch (_) {
            return false;
          }
        });
        if (byId) {
          const currentName = entityName(byId);
          if (currentName !== label) {
            throw new ToolkitError(
              `Managed ${kind} id=${managedId} is now named ` +
                `${currentName || '<invalid>'}, expected ${label}.`
            );
          }
          return byId;
        }
      }
      const matches = entities.filter(
        (entity) => entityName(entity) === label
      );
      if (!matches.length) {
        return null;
      }
      if (matches.length > 1) {
        throw new ToolkitError(
          `Multiple ${kind}s named ${label} exist: ${matches
            .map((entity) => entity.id)
            .join(', ')}`
        );
      }
      if (!adoptExisting) {
        throw new ToolkitError(
          `An unmanaged ${kind} named ${label} exists. ` +
            'Review it and enable Adopt existing.'
        );
      }
      return matches[0];
    }

    function isPrime(number) {
      if (number < 2) return false;
      if (number === 2) return true;
      if (number % 2 === 0) return false;
      for (let divisor = 3; divisor * divisor <= number; divisor += 2) {
        if (number % divisor === 0) return false;
      }
      return true;
    }

    function allocateIntervals(subscriptions, state, startValue) {
      const start = parsePositiveInt(startValue, 'Interval start');
      const allocated = {};
      const used = new Set();
      for (const subscription of subscriptions) {
        const found = findStateEntry(state, subscription);
        const interval = found
          ? validManagedId(found.entry, 'interval')
          : null;
        if (interval !== null && !used.has(interval)) {
          allocated[subscription.key] = interval;
          used.add(interval);
        }
      }
      let candidate = Math.max(2, start);
      for (const subscription of subscriptions) {
        if (allocated[subscription.key]) continue;
        while (!isPrime(candidate) || used.has(candidate)) {
          candidate += 1;
        }
        allocated[subscription.key] = candidate;
        used.add(candidate);
        candidate += 1;
      }
      return allocated;
    }

    function buildIndexerPayload(subscription) {
      return {
        enabled: true,
        identifier: 'rss',
        implementation: 'rss',
        name: subscription.label,
        irc: {},
        settings: {},
        feed: {
          url: subscription.url,
          settings: { download_type: 'TORRENT' },
        },
      };
    }

    function buildFeedPayload(subscription, indexerId, interval) {
      return {
        name: subscription.label,
        enabled: false,
        type: 'RSS',
        url: subscription.url,
        interval,
        timeout: 60,
        indexer_id: indexerId,
        settings: { download_type: 'TORRENT' },
      };
    }

    function feedIndexerId(feed) {
      const candidates = [
        feed && feed.indexer_id,
        feed && feed.indexer && feed.indexer.id,
      ];
      for (const candidate of candidates) {
        const parsed = Number(candidate);
        if (Number.isInteger(parsed) && parsed > 0) return parsed;
      }
      return null;
    }

    function feedNeedsUpdate(feed, subscription, indexerId, interval) {
      const settings =
        feed && feed.settings && typeof feed.settings === 'object'
          ? feed.settings
          : {};
      return (
        entityName(feed) !== subscription.label ||
        String(feed.url || '').trim() !== subscription.url ||
        String(feed.type || '').toUpperCase() !== 'RSS' ||
        Number(feed.interval) !== interval ||
        Number(feed.timeout === undefined ? 60 : feed.timeout) !== 60 ||
        feedIndexerId(feed) !== indexerId ||
        settings.download_type !== 'TORRENT'
      );
    }

    function buildFeedUpdatePayload(
      existing,
      subscription,
      indexer,
      interval
    ) {
      const indexerId = entityId(indexer, 'indexer');
      return {
        ...deepClone(existing),
        ...buildFeedPayload(subscription, indexerId, interval),
        id: entityId(existing, 'feed'),
        enabled: existing.enabled === true,
        indexer: {
          id: indexerId,
          name: subscription.label,
          identifier: indexer.identifier || 'rss',
          identifier_external:
            indexer.identifier_external || subscription.label,
        },
      };
    }

    function buildFilterCreatePayload(subscription) {
      return {
        name: subscription.label,
        enabled: false,
        resolutions: [],
        codecs: [],
        sources: [],
        containers: [],
        origins: [],
      };
    }

    function buildFilterUpdatePayload(
      existing,
      subscription,
      indexerId,
      qbitId,
      savePath
    ) {
      const payload = {};
      for (const [key, value] of Object.entries(existing)) {
        if (!FILTER_READ_ONLY_FIELDS.has(key)) {
          payload[key] = deepClone(value);
        }
      }
      payload.id = entityId(existing, 'filter');
      payload.name = subscription.label;
      payload.enabled = true;
      payload.priority = Number(existing.priority || 0);
      payload.use_regex = existing.use_regex === true;
      payload.smart_episode = existing.smart_episode === true;
      payload.indexers = [{ id: indexerId, name: subscription.label }];
      for (const field of FILTER_LIST_FIELDS) {
        payload[field] = Array.isArray(existing[field])
          ? deepClone(existing[field])
          : [];
      }
      if (!payload.announce_types.length) {
        payload.announce_types = ['NEW'];
      }

      const actions = Array.isArray(existing.actions)
        ? existing.actions
            .filter((action) => action && typeof action === 'object')
            .map((action) => deepClone(action))
        : [];
      let managedAction = actions.find(
        (action) => String(action.type || '').toUpperCase() === 'QBITTORRENT'
      );
      if (!managedAction) {
        managedAction = { id: 0, type: 'QBITTORRENT' };
        actions.push(managedAction);
      }
      Object.assign(managedAction, {
        name: managedAction.name || 'JPopSuki qBittorrent',
        type: 'QBITTORRENT',
        enabled: true,
        tags: subscription.label,
        save_path: savePath,
        reannounce_interval: 7,
        reannounce_max_attempts: 25,
        client_id: qbitId,
      });
      payload.actions = actions;
      return payload;
    }

    function filterNeedsUpdate(
      existing,
      indexerId,
      qbitId,
      savePath,
      label
    ) {
      if (existing.enabled !== true) return true;
      const boundIds = new Set(
        (Array.isArray(existing.indexers) ? existing.indexers : [])
          .map((indexer) => Number(indexer && indexer.id))
          .filter((id) => Number.isInteger(id) && id > 0)
      );
      if (boundIds.size !== 1 || !boundIds.has(indexerId)) return true;
      const action = (
        Array.isArray(existing.actions) ? existing.actions : []
      ).find(
        (item) =>
          item &&
          typeof item === 'object' &&
          String(item.type || '').toUpperCase() === 'QBITTORRENT'
      );
      return (
        !action ||
        action.enabled !== true ||
        Number(action.client_id) !== qbitId ||
        String(action.save_path || '') !== savePath ||
        String(action.tags || '') !== label
      );
    }

    function selectedStateEntries(state, selectedKeys = null) {
      const selected = selectedKeys ? new Set(selectedKeys) : null;
      return Object.entries(state.items)
        .filter(([key]) => !selected || selected.has(key))
        .sort((left, right) =>
          String(left[1].label).localeCompare(String(right[1].label))
        );
    }

    function mapEntities(entities, kind) {
      const mapped = new Map();
      for (const entity of entities) {
        try {
          mapped.set(entityId(entity, kind), entity);
        } catch (_) {
          // Ignore malformed unrelated API rows.
        }
      }
      return mapped;
    }

    function verifiedLiveId(
      entry,
      idField,
      entityMap,
      label,
      kind,
      notices
    ) {
      const id = validManagedId(entry, idField);
      if (id === null) return null;
      const entity = entityMap.get(id);
      if (!entity) {
        notices.push(`${kind} id=${id} for ${label} no longer exists`);
        return null;
      }
      const currentName = entityName(entity);
      if (currentName !== label) {
        throw new ToolkitError(
          `Refusing ${kind} id=${id}: current name ` +
            `${currentName || '<invalid>'} does not match ${label}.`
        );
      }
      return id;
    }

    function discoverCleanupCandidates(
      state,
      feeds,
      filters,
      selectedKeys = null
    ) {
      const feedMap = mapEntities(feeds, 'feed');
      const filterMap = mapEntities(filters, 'filter');
      const candidates = [];
      const notices = [];
      for (const [stateKey, entry] of selectedStateEntries(
        state,
        selectedKeys
      )) {
        const label = entry.label;
        const filterId = verifiedLiveId(
          entry,
          'filter_id',
          filterMap,
          label,
          'filter',
          notices
        );
        if (filterId !== null) {
          const current = filterMap.get(filterId);
          if (Array.isArray(current.indexers) && current.indexers.length === 0) {
            candidates.push({
              stateKey,
              idField: 'filter_id',
              kind: 'filter',
              id: filterId,
              label,
              reason: 'no bound indexers',
            });
          }
        }
        const feedId = verifiedLiveId(
          entry,
          'feed_id',
          feedMap,
          label,
          'feed',
          notices
        );
        if (feedId !== null) {
          const current = feedMap.get(feedId);
          if (current.enabled === false) {
            candidates.push({
              stateKey,
              idField: 'feed_id',
              kind: 'feed',
              id: feedId,
              label,
              reason: 'feed is disabled',
            });
          } else if (typeof current.enabled !== 'boolean') {
            notices.push(`feed id=${feedId} has an invalid enabled value`);
          }
        }
      }
      return { candidates, notices };
    }

    function discoverBundles(
      state,
      indexers,
      feeds,
      filters,
      selectedKeys
    ) {
      const indexerMap = mapEntities(indexers, 'indexer');
      const feedMap = mapEntities(feeds, 'feed');
      const filterMap = mapEntities(filters, 'filter');
      const notices = [];
      const bundles = [];
      for (const [stateKey, entry] of selectedStateEntries(
        state,
        selectedKeys
      )) {
        const label = entry.label;
        const bundle = {
          stateKey,
          label,
          filterId: verifiedLiveId(
            entry,
            'filter_id',
            filterMap,
            label,
            'filter',
            notices
          ),
          feedId: verifiedLiveId(
            entry,
            'feed_id',
            feedMap,
            label,
            'feed',
            notices
          ),
          indexerId: verifiedLiveId(
            entry,
            'indexer_id',
            indexerMap,
            label,
            'indexer',
            notices
          ),
        };
        bundles.push(bundle);
      }
      return { bundles, notices };
    }

    return {
      FILTER_LIST_FIELDS,
      KNOWN_CATEGORIES,
      ToolkitError,
      allocateIntervals,
      buildFeedPayload,
      buildFeedUpdatePayload,
      buildFilterCreatePayload,
      buildFilterUpdatePayload,
      buildIndexerPayload,
      buildSavePath,
      deepClone,
      discoverBundles,
      discoverCleanupCandidates,
      emptyState,
      entityId,
      entityName,
      feedNeedsUpdate,
      filterNeedsUpdate,
      findManagedEntity,
      findStateEntry,
      normalizeBaseUrl,
      normalizeLabel,
      normalizeSaveBase,
      parsePositiveInt,
      redactText,
      selectedStateEntries,
      splitLabel,
      stateEntryFor,
      validManagedId,
      validateManagedState,
      validateSubscriptions,
    };
  })();

  const CONFIG_KEY = 'jps-autobrr-config-v1';
  const TOKEN_KEY = 'jps-autobrr-token-v1';
  const STATE_KEY = 'jps-autobrr-managed-state-v1';
  const QUEUE_KEY = 'jps-autobrr-staged-rss-v1';
  const QUEUE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
  const CREATE_DELAY_MS = 350;

  class ApiError extends Error {
    constructor(status, message) {
      super(message);
      this.name = 'ApiError';
      this.status = status;
    }
  }

  function gmRequest(details, service = 'Autobrr') {
    return new Promise((resolve, reject) => {
      try {
        GM_xmlhttpRequest({
          ...details,
          onload: resolve,
          onerror: () =>
            reject(new ApiError(0, `${service} network request failed.`)),
          ontimeout: () =>
            reject(new ApiError(0, `${service} request timed out.`)),
          onabort: () =>
            reject(new ApiError(0, `${service} request was aborted.`)),
        });
      } catch (error) {
        reject(
          new ApiError(
            0,
            `${service} request could not start: ${Core.redactText(
              error.message
            )}`
          )
        );
      }
    });
  }

  class AutobrrClient {
    constructor(baseUrl, token) {
      this.baseUrl = Core.normalizeBaseUrl(baseUrl);
      if (!String(token || '').trim()) {
        throw new Core.ToolkitError('Autobrr API token is required.');
      }
      this.token = String(token).trim();
    }

    async request(method, path, payload, expectJson = true) {
      const response = await gmRequest({
        method,
        url: `${this.baseUrl}${path}`,
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'X-API-Token': this.token,
        },
        data: payload === undefined ? undefined : JSON.stringify(payload),
        responseType: 'text',
        timeout: 30000,
        anonymous: true,
      });
      const status = Number(response.status || 0);
      const body = String(response.responseText || response.response || '');
      if (status < 200 || status >= 300) {
        throw new ApiError(
          status,
          `${method} ${path} returned HTTP ${status}: ` +
            Core.redactText(body).slice(0, 500)
        );
      }
      if (!expectJson || status === 204 || !body.trim()) {
        return null;
      }
      try {
        return JSON.parse(body);
      } catch (_) {
        throw new ApiError(
          status,
          `${method} ${path} returned invalid JSON.`
        );
      }
    }

    async listIndexers() {
      return this.requireArray(
        await this.request('GET', '/api/indexer'),
        'indexers'
      );
    }

    async createIndexer(payload) {
      return this.requireObject(
        await this.request('POST', '/api/indexer', payload),
        'created indexer'
      );
    }

    async deleteIndexer(id) {
      await this.request('DELETE', `/api/indexer/${id}`, undefined, false);
    }

    async listFeeds() {
      return this.requireArray(
        await this.request('GET', '/api/feeds'),
        'feeds'
      );
    }

    async createFeed(payload) {
      return this.requireObject(
        await this.request('POST', '/api/feeds', payload),
        'created feed'
      );
    }

    async updateFeed(id, payload) {
      const response = await this.request('PUT', `/api/feeds/${id}`, payload);
      return response === null
        ? { ...payload, id }
        : this.requireObject(response, 'updated feed');
    }

    async setFeedEnabled(id, enabled) {
      await this.request(
        'PATCH',
        `/api/feeds/${id}/enabled`,
        { enabled },
        false
      );
    }

    async deleteFeed(id) {
      await this.request('DELETE', `/api/feeds/${id}`, undefined, false);
    }

    async listFilters() {
      return this.requireArray(
        await this.request('GET', '/api/filters'),
        'filters'
      );
    }

    async getFilter(id) {
      return this.requireObject(
        await this.request('GET', `/api/filters/${id}`),
        'filter'
      );
    }

    async createFilter(payload) {
      return this.requireObject(
        await this.request('POST', '/api/filters', payload),
        'created filter'
      );
    }

    async updateFilter(id, payload) {
      let response;
      try {
        response = await this.request('PATCH', `/api/filters/${id}`, payload);
      } catch (error) {
        if (!(error instanceof ApiError) || ![404, 405].includes(error.status)) {
          throw error;
        }
        response = await this.request('PUT', `/api/filters/${id}`, payload);
      }
      return response === null
        ? this.getFilter(id)
        : this.requireObject(response, 'updated filter');
    }

    async deleteFilter(id) {
      await this.request('DELETE', `/api/filters/${id}`, undefined, false);
    }

    async listDownloadClients() {
      return this.requireArray(
        await this.request('GET', '/api/download_clients'),
        'download clients'
      );
    }

    requireArray(value, description) {
      if (
        !Array.isArray(value) ||
        value.some((item) => !item || typeof item !== 'object')
      ) {
        throw new ApiError(0, `${description} response is not an object array.`);
      }
      return value;
    }

    requireObject(value, description) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new ApiError(0, `${description} response is not an object.`);
      }
      return value;
    }
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { ...Core, ApiError, AutobrrClient };
    return;
  }

  const delay = (milliseconds) =>
    new Promise((resolve) => window.setTimeout(resolve, milliseconds));

  function extractRssRows() {
    const itemsByUrl = new Map();
    for (const heading of document.querySelectorAll('h3')) {
      const anchor = heading.querySelector(
        'a[href*="feeds.php?feed=torrents_notify_"]'
      );
      if (!anchor) continue;
      const href = anchor.getAttribute('href');
      if (!href) continue;
      let parsed;
      try {
        parsed = new URL(href, window.location.origin);
      } catch (_) {
        continue;
      }
      if (
        parsed.origin !== window.location.origin ||
        parsed.pathname !== '/feeds.php'
      ) {
        continue;
      }
      let label = (parsed.searchParams.get('name') || '')
        .trim()
        .replace(/\s+/g, ' ');
      if (!label) {
        const clone = heading.cloneNode(true);
        for (const removable of clone.querySelectorAll(
          'a[href*="notify_delete"], img'
        )) {
          removable.remove();
        }
        label = (clone.textContent || '')
          .replace(/\(\s*\)\s*$/, '')
          .trim()
          .replace(/\s+/g, ' ');
      }
      if (label && !itemsByUrl.has(parsed.href)) {
        itemsByUrl.set(parsed.href, { label, url: parsed.href });
      }
    }
    return Array.from(itemsByUrl.values()).sort((left, right) =>
      left.label.localeCompare(right.label)
    );
  }

  async function createJpopsukiFilter({ label, artist, category }) {
    const form = new URLSearchParams();
    form.set('action', 'notify_handle');
    form.set('label', label);
    form.set('artists', artist);
    form.append('categories[]', category);
    const response = await gmRequest(
      {
        method: 'POST',
        url: new URL('/user.php', window.location.origin).href,
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        data: form.toString(),
        responseType: 'text',
        timeout: 30000,
        anonymous: false,
      },
      'JPopSuki'
    );
    const status = Number(response.status || 0);
    if (status < 200 || status >= 400) {
      throw new Error(
        `Failed to create ${label} (HTTP ${status}).`
      );
    }
  }

  function downloadJson(filename, value) {
    const blob = new Blob([JSON.stringify(value, null, 2) + '\n'], {
      type: 'application/json;charset=utf-8',
    });
    const objectUrl = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = objectUrl;
    link.download = filename;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
  }

  function replaceEntity(entities, replacement, kind) {
    const id = Core.entityId(replacement, kind);
    const index = entities.findIndex((entity) => Number(entity.id) === id);
    if (index >= 0) entities[index] = replacement;
    else entities.push(replacement);
  }

  async function startBrowserApp() {
    const isJpopsukiPage =
      window.location.hostname.toLowerCase() === 'jpopsuki.eu' ||
      window.location.hostname.toLowerCase() === 'www.jpopsuki.eu';
    const isAutobrrPage = !isJpopsukiPage;
    let state = Core.emptyState();
    let stateLoadError = '';
    if (isAutobrrPage) {
      try {
        state = Core.validateManagedState(
          await GM_getValue(STATE_KEY, Core.emptyState())
        );
      } catch (error) {
        stateLoadError =
          'Stored managed state is invalid. Import a valid backup before deleting.';
      }
    }

    const defaultConfig = {
      baseUrl: 'http://localhost:7474',
      qbitId: '',
      saveBase: '/downloads/jpopsuki',
      intervalStart: 600,
      adoptExisting: false,
    };
    const storedConfig = await GM_getValue(CONFIG_KEY, defaultConfig);
    const config = {
      ...defaultConfig,
      ...(storedConfig && typeof storedConfig === 'object'
        ? storedConfig
        : {}),
    };
    let sessionToken = isAutobrrPage
      ? String(await GM_getValue(TOKEN_KEY, '') || '')
      : '';
    let stagedRows = [];
    let queueLoadError = '';
    if (isAutobrrPage) {
      const queue = await GM_getValue(QUEUE_KEY, null);
      if (queue !== null) {
        if (
          !queue ||
          typeof queue !== 'object' ||
          queue.schema_version !== 1 ||
          !Array.isArray(queue.rows) ||
          !Number.isFinite(Number(queue.created_at))
        ) {
          queueLoadError =
            'Staged RSS data is invalid and was ignored. Stage it again from JPopSuki.';
          await GM_deleteValue(QUEUE_KEY);
        } else if (Date.now() - Number(queue.created_at) > QUEUE_MAX_AGE_MS) {
          queueLoadError =
            'Staged RSS data expired after 24 hours. Stage it again from JPopSuki.';
          await GM_deleteValue(QUEUE_KEY);
        } else {
          stagedRows = queue.rows;
        }
      }
    }

    const host = document.createElement('div');
    host.id = 'jps-autobrr-manager-host';
    const shadow = host.attachShadow({ mode: 'closed' });
    shadow.innerHTML = `
      <style>
        :host { all: initial; }
        * { box-sizing: border-box; }
        button, input, select { font: inherit; }
        #open {
          position: fixed; right: 16px; bottom: 16px; z-index: 2147483646;
          border: 1px solid #596579; border-radius: 8px; padding: 9px 12px;
          background: #273449; color: #fff; cursor: pointer;
          box-shadow: 0 4px 18px rgba(0,0,0,.35);
        }
        #panel {
          display: none; position: fixed; right: 16px; bottom: 16px;
          z-index: 2147483647; width: min(760px, calc(100vw - 32px));
          max-height: calc(100vh - 32px); overflow: auto; padding: 14px;
          border: 1px solid #4b5563; border-radius: 10px; background: #151a22;
          color: #e5e7eb; font: 14px/1.45 -apple-system, BlinkMacSystemFont,
            "Segoe UI", sans-serif; box-shadow: 0 12px 40px rgba(0,0,0,.55);
        }
        header { display: flex; align-items: center; gap: 8px; }
        header strong { flex: 1; font-size: 16px; }
        .tabs { display: flex; gap: 6px; margin: 12px 0; flex-wrap: wrap; }
        button {
          border: 1px solid #536174; border-radius: 6px; padding: 7px 10px;
          background: #334155; color: #fff; cursor: pointer;
        }
        button:hover { background: #41536e; }
        button.primary { background: #2563eb; }
        button.good { background: #15803d; }
        button.danger { background: #b91c1c; }
        button:disabled { opacity: .5; cursor: wait; }
        .tab.active { background: #2563eb; }
        section { display: none; }
        section.active { display: block; }
        .grid {
          display: grid; grid-template-columns: repeat(2, minmax(0, 1fr));
          gap: 10px;
        }
        label.field { display: block; }
        label.field > span { display: block; margin-bottom: 3px; color: #cbd5e1; }
        input[type="text"], input[type="password"], input[type="number"], select {
          width: 100%; border: 1px solid #4b5563; border-radius: 6px;
          padding: 7px 8px; background: #0f141b; color: #f8fafc;
        }
        .categories {
          display: grid; grid-template-columns: repeat(5, minmax(0, 1fr));
          gap: 5px; margin: 10px 0;
        }
        .categories label, .inline {
          display: flex; gap: 5px; align-items: center;
        }
        .actions { display: flex; flex-wrap: wrap; gap: 7px; margin: 10px 0; }
        .hint { color: #94a3b8; font-size: 12px; }
        .warning { color: #f6ad55; }
        #plan-output, #managed-output, #log {
          margin-top: 10px; border: 1px solid #374151; border-radius: 7px;
          background: #0b1016; padding: 9px; max-height: 250px; overflow: auto;
          white-space: pre-wrap; overflow-wrap: anywhere;
        }
        #log { max-height: 150px; color: #cbd5e1; }
        table { width: 100%; border-collapse: collapse; font-size: 12px; }
        th, td { text-align: left; border-bottom: 1px solid #2d3748; padding: 5px; }
        .managed-row {
          display: grid; grid-template-columns: auto 1fr auto; gap: 8px;
          align-items: center; padding: 6px; border-bottom: 1px solid #273244;
        }
        .managed-row small { color: #94a3b8; }
        @media (max-width: 620px) {
          .grid { grid-template-columns: 1fr; }
          .categories { grid-template-columns: repeat(2, minmax(0, 1fr)); }
        }
      </style>
      <button id="open" type="button">JPopSuki RSS</button>
      <div id="panel" role="dialog" aria-label="JPopSuki RSS and Autobrr Manager">
        <header>
          <strong>JPopSuki RSS + Autobrr Manager</strong>
          <button id="close" type="button">Close</button>
        </header>
        <div class="tabs">
          <button class="tab active" data-tab="create" type="button">Create RSS</button>
          <button class="tab" data-tab="autobrr" type="button">Autobrr</button>
          <button class="tab" data-tab="managed" type="button">Managed</button>
        </div>
        <section id="tab-create" class="active">
          <label class="field">
            <span>Artist</span>
            <input id="artist" type="text" placeholder="e.g. ITZY" />
          </label>
          <div id="categories" class="categories"></div>
          <div class="actions">
            <button id="create-filters" class="primary" type="button">Create Filters</button>
            <button id="stage-rss" class="good" type="button">Stage &amp; Open Autobrr</button>
            <button id="export-rss" type="button">Export private RSS JSON</button>
          </div>
          <label class="field">
            <span>Autobrr URL to open</span>
            <input id="autobrr-launch-url" type="text" />
          </label>
          <div id="rss-count" class="hint"></div>
          <p class="warning">
            RSS URLs contain account credentials. Staging is temporary and raw URLs
            are never stored in managed state.
          </p>
        </section>
        <section id="tab-autobrr">
          <div class="grid">
            <label class="field">
              <span>Autobrr base URL</span>
              <input id="base-url" type="text" />
            </label>
            <label class="field">
              <span>API token</span>
              <input id="api-token" type="password" autocomplete="off" />
            </label>
            <label class="field">
              <span>qBittorrent client</span>
              <select id="qbit-client"><option value="">Connect first</option></select>
            </label>
            <label class="field">
              <span>Save base</span>
              <input id="save-base" type="text" />
            </label>
            <label class="field">
              <span>Interval start</span>
              <input id="interval-start" type="number" min="2" />
            </label>
            <div>
              <label class="inline">
                <input id="remember-token" type="checkbox" />
                Remember token in userscript storage
              </label>
              <label class="inline">
                <input id="adopt-existing" type="checkbox" />
                Adopt unique existing same-name objects
              </label>
            </div>
          </div>
          <p class="hint">
            API configuration runs only on the Autobrr page. The token is never
            loaded on JPopSuki. It is not persisted unless Remember token is checked.
          </p>
          <div id="staged-count" class="hint"></div>
          <div class="actions">
            <button id="connect" type="button">Connect / Load clients</button>
            <button id="forget-token" type="button">Forget token</button>
            <button id="clear-staged" type="button">Clear staged RSS</button>
            <button id="plan" class="primary" type="button">Plan</button>
            <button id="apply" class="good" type="button">Apply</button>
          </div>
          <div id="plan-output">No plan yet.</div>
        </section>
        <section id="tab-managed">
          <div class="grid">
            <label class="field">
              <span>Search labels</span>
              <input id="managed-search" type="text" placeholder="literal or regex" />
            </label>
            <div>
              <label class="inline">
                <input id="managed-regex" type="checkbox" />
                Regex search
              </label>
              <span id="managed-count" class="hint"></span>
            </div>
          </div>
          <div class="actions">
            <button id="select-visible" type="button">Select visible</button>
            <button id="clear-selection" type="button">Clear selection</button>
            <button id="audit-cleanup" type="button">Plan cleanup</button>
            <button id="apply-cleanup" class="danger" type="button">Apply cleanup</button>
            <button id="delete-selected" class="danger" type="button">Delete selected bundles</button>
            <button id="export-state" type="button">Export state</button>
            <button id="import-state-button" type="button">Import state</button>
            <input id="import-state" type="file" accept="application/json,.json" hidden />
          </div>
          <div id="managed-list"></div>
          <div id="managed-output">Managed state is browser-local.</div>
        </section>
        <div id="log" aria-live="polite"></div>
      </div>
    `;
    document.body.appendChild(host);

    const byId = (id) => shadow.getElementById(id);
    const openButton = byId('open');
    const panel = byId('panel');
    const logArea = byId('log');
    const planOutput = byId('plan-output');
    const managedOutput = byId('managed-output');

    function log(message, kind = '') {
      const line = document.createElement('div');
      line.textContent = `[${new Date().toLocaleTimeString()}] ${Core.redactText(
        message
      )}`;
      if (kind === 'error') line.style.color = '#fca5a5';
      if (kind === 'ok') line.style.color = '#86efac';
      logArea.appendChild(line);
      logArea.scrollTop = logArea.scrollHeight;
    }

    if (stateLoadError) log(stateLoadError, 'error');
    if (queueLoadError) log(queueLoadError, 'error');

    for (const category of Core.KNOWN_CATEGORIES) {
      const label = document.createElement('label');
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.value = category;
      checkbox.checked = true;
      checkbox.className = 'category';
      label.append(checkbox, document.createTextNode(category));
      byId('categories').appendChild(label);
    }

    let initialBaseUrl = String(config.baseUrl || defaultConfig.baseUrl);
    if (isAutobrrPage) {
      try {
        if (
          new URL(Core.normalizeBaseUrl(initialBaseUrl)).origin !==
          window.location.origin
        ) {
          initialBaseUrl = window.location.origin;
        }
      } catch (_) {
        initialBaseUrl = window.location.origin;
      }
    }
    byId('base-url').value = initialBaseUrl;
    byId('autobrr-launch-url').value = String(
      config.baseUrl || defaultConfig.baseUrl
    );
    byId('save-base').value = String(config.saveBase || defaultConfig.saveBase);
    byId('interval-start').value = String(
      config.intervalStart || defaultConfig.intervalStart
    );
    byId('adopt-existing').checked = config.adoptExisting === true;
    byId('remember-token').checked = Boolean(sessionToken);
    byId('api-token').placeholder = sessionToken
      ? 'Saved token available'
      : 'Required; not remembered by default';

    if (isJpopsukiPage) {
      for (const tab of shadow.querySelectorAll('.tab')) {
        tab.style.display = tab.dataset.tab === 'create' ? '' : 'none';
      }
    } else {
      for (const tab of shadow.querySelectorAll('.tab')) {
        const active = tab.dataset.tab === 'autobrr';
        tab.style.display = tab.dataset.tab === 'create' ? 'none' : '';
        tab.classList.toggle('active', active);
      }
      for (const section of shadow.querySelectorAll('section')) {
        section.classList.toggle('active', section.id === 'tab-autobrr');
      }
      openButton.textContent = 'JPopSuki Autobrr';
    }

    function updateRssCount() {
      byId('rss-count').textContent = `${extractRssRows().length} RSS link(s) found on this page.`;
    }
    function updateStagedCount() {
      byId('staged-count').textContent =
        `${stagedRows.length} staged RSS subscription(s) available.`;
    }
    if (isJpopsukiPage) updateRssCount();
    updateStagedCount();

    openButton.addEventListener('click', () => {
      panel.style.display = 'block';
      openButton.style.display = 'none';
      if (isJpopsukiPage) updateRssCount();
      if (isAutobrrPage) renderManagedList();
    });
    byId('close').addEventListener('click', () => {
      panel.style.display = 'none';
      openButton.style.display = 'block';
    });
    for (const tab of shadow.querySelectorAll('.tab')) {
      tab.addEventListener('click', () => {
        for (const item of shadow.querySelectorAll('.tab')) {
          item.classList.toggle('active', item === tab);
        }
        for (const section of shadow.querySelectorAll('section')) {
          section.classList.toggle(
            'active',
            section.id === `tab-${tab.dataset.tab}`
          );
        }
        if (tab.dataset.tab === 'managed') renderManagedList();
      });
    }

    async function saveState() {
      state = Core.validateManagedState(state);
      await GM_setValue(STATE_KEY, state);
    }

    function assertStateHealthy() {
      if (stateLoadError) {
        throw new Core.ToolkitError(stateLoadError);
      }
    }

    function currentToken() {
      return byId('api-token').value.trim() || sessionToken;
    }

    function readSettings() {
      const baseUrl = Core.normalizeBaseUrl(byId('base-url').value);
      if (
        isAutobrrPage &&
        new URL(baseUrl).origin !== window.location.origin
      ) {
        throw new Core.ToolkitError(
          'Autobrr API base must use the origin of the current Autobrr page.'
        );
      }
      return {
        baseUrl,
        token: currentToken(),
        qbitId: byId('qbit-client').value
          ? Core.parsePositiveInt(byId('qbit-client').value, 'qBittorrent client')
          : null,
        saveBase: Core.normalizeSaveBase(byId('save-base').value),
        intervalStart: Core.parsePositiveInt(
          byId('interval-start').value,
          'Interval start'
        ),
        adoptExisting: byId('adopt-existing').checked,
        rememberToken: byId('remember-token').checked,
      };
    }

    async function persistSettings(settings) {
      config.baseUrl = settings.baseUrl;
      config.qbitId = settings.qbitId || '';
      config.saveBase = settings.saveBase;
      config.intervalStart = settings.intervalStart;
      config.adoptExisting = settings.adoptExisting;
      await GM_setValue(CONFIG_KEY, config);
      sessionToken = settings.token;
      if (settings.rememberToken) {
        await GM_setValue(TOKEN_KEY, settings.token);
      } else {
        await GM_deleteValue(TOKEN_KEY);
      }
      byId('api-token').value = '';
      byId('api-token').placeholder = sessionToken
        ? 'Token available for this tab'
        : 'Required; not remembered by default';
    }

    function makeClient(settings) {
      return new AutobrrClient(settings.baseUrl, settings.token);
    }

    async function loadClients(quiet = false) {
      const settings = readSettings();
      const client = makeClient(settings);
      const clients = await client.listDownloadClients();
      const qbitClients = clients.filter(
        (item) =>
          String(item.type || '').toUpperCase() === 'QBITTORRENT' &&
          Number.isInteger(Number(item.id)) &&
          Number(item.id) > 0
      );
      const select = byId('qbit-client');
      const desired = String(settings.qbitId || config.qbitId || '');
      select.replaceChildren();
      const placeholder = document.createElement('option');
      placeholder.value = '';
      placeholder.textContent = qbitClients.length
        ? 'Select qBittorrent client'
        : 'No qBittorrent clients found';
      select.appendChild(placeholder);
      for (const item of qbitClients) {
        const option = document.createElement('option');
        option.value = String(item.id);
        option.textContent = `${item.name || 'qBittorrent'} (id=${item.id})`;
        select.appendChild(option);
      }
      if (qbitClients.some((item) => String(item.id) === desired)) {
        select.value = desired;
      } else if (qbitClients.length === 1) {
        select.value = String(qbitClients[0].id);
      }
      settings.qbitId = select.value
        ? Core.parsePositiveInt(select.value, 'qBittorrent client')
        : null;
      await persistSettings(settings);
      if (!quiet) log(`Connected; loaded ${qbitClients.length} qBittorrent client(s).`, 'ok');
      return { client, settings };
    }

    async function prepareContext() {
      let settings = readSettings();
      let client = makeClient(settings);
      if (!settings.qbitId) {
        ({ client, settings } = await loadClients(true));
      }
      if (!settings.qbitId) {
        throw new Core.ToolkitError('Select a qBittorrent client.');
      }
      const subscriptions = await Core.validateSubscriptions(stagedRows);
      const intervals = Core.allocateIntervals(
        subscriptions,
        state,
        settings.intervalStart
      );
      for (const subscription of subscriptions) {
        Core.buildSavePath(settings.saveBase, subscription);
      }
      const [indexers, feeds, filters, downloadClients] = await Promise.all([
        client.listIndexers(),
        client.listFeeds(),
        client.listFilters(),
        client.listDownloadClients(),
      ]);
      const selectedClient = downloadClients.find(
        (item) =>
          Number(item.id) === settings.qbitId &&
          String(item.type || '').toUpperCase() === 'QBITTORRENT'
      );
      if (!selectedClient) {
        throw new Core.ToolkitError(
          `qBittorrent client id=${settings.qbitId} does not exist on this Autobrr instance.`
        );
      }
      await persistSettings(settings);
      return {
        client,
        settings,
        subscriptions,
        intervals,
        indexers,
        feeds,
        filters,
      };
    }

    async function computePlan() {
      assertStateHealthy();
      const context = await prepareContext();
      const planState = Core.deepClone(state);
      const rows = [];
      let failures = 0;
      for (const subscription of context.subscriptions) {
        const { entry } = Core.stateEntryFor(planState, subscription);
        try {
          const indexer = Core.findManagedEntity(
            context.indexers,
            entry,
            'indexer_id',
            subscription.label,
            context.settings.adoptExisting,
            'indexer'
          );
          const feed = Core.findManagedEntity(
            context.feeds,
            entry,
            'feed_id',
            subscription.label,
            context.settings.adoptExisting,
            'feed'
          );
          const filterSummary = Core.findManagedEntity(
            context.filters,
            entry,
            'filter_id',
            subscription.label,
            context.settings.adoptExisting,
            'filter'
          );
          const indexerAction = indexer ? 'REUSE' : 'CREATE';
          let feedAction = 'CREATE';
          if (feed) {
            feedAction = indexer
              ? Core.feedNeedsUpdate(
                  feed,
                  subscription,
                  Core.entityId(indexer, 'indexer'),
                  context.intervals[subscription.key]
                )
                ? 'UPDATE'
                : feed.enabled === true
                  ? 'SKIP'
                  : 'ENABLE'
              : 'UPDATE';
          }
          let filterAction = 'CREATE';
          if (filterSummary) {
            if (!indexer) {
              filterAction = 'UPDATE';
            } else {
              const fullFilter = await context.client.getFilter(
                Core.entityId(filterSummary, 'filter')
              );
              const savePath = Core.buildSavePath(
                context.settings.saveBase,
                subscription
              );
              filterAction = Core.filterNeedsUpdate(
                fullFilter,
                Core.entityId(indexer, 'indexer'),
                context.settings.qbitId,
                savePath,
                subscription.label
              )
                ? 'UPDATE'
                : 'SKIP';
            }
          }
          rows.push({
            label: subscription.label,
            indexer: indexerAction,
            feed: feedAction,
            filter: filterAction,
            savePath: Core.buildSavePath(
              context.settings.saveBase,
              subscription
            ),
          });
        } catch (error) {
          failures += 1;
          rows.push({
            label: subscription.label,
            error: Core.redactText(error.message),
          });
        }
      }
      renderPlan(rows);
      return { context, rows, failures };
    }

    function renderPlan(rows) {
      planOutput.replaceChildren();
      const table = document.createElement('table');
      const header = document.createElement('tr');
      for (const name of ['Label', 'Indexer', 'Feed', 'Filter', 'Save path']) {
        const cell = document.createElement('th');
        cell.textContent = name;
        header.appendChild(cell);
      }
      table.appendChild(header);
      for (const row of rows) {
        const line = document.createElement('tr');
        const values = row.error
          ? [row.label, 'ERROR', row.error, '', '']
          : [row.label, row.indexer, row.feed, row.filter, row.savePath];
        for (const value of values) {
          const cell = document.createElement('td');
          cell.textContent = value;
          if (value === 'ERROR') cell.style.color = '#fca5a5';
          line.appendChild(cell);
        }
        table.appendChild(line);
      }
      planOutput.appendChild(table);
    }

    async function applySubscription(context, subscription) {
      const { entry } = Core.stateEntryFor(state, subscription);
      entry.label = subscription.label;
      entry.url_fingerprint = subscription.url_fingerprint;
      entry.interval = context.intervals[subscription.key];
      entry.complete = false;

      let indexer = Core.findManagedEntity(
        context.indexers,
        entry,
        'indexer_id',
        subscription.label,
        context.settings.adoptExisting,
        'indexer'
      );
      if (!indexer) {
        log(`CREATE indexer ${subscription.label}`);
        indexer = await context.client.createIndexer(
          Core.buildIndexerPayload(subscription)
        );
        context.indexers.push(indexer);
      } else {
        log(`REUSE indexer ${subscription.label}`);
      }
      const indexerId = Core.entityId(indexer, 'indexer');
      entry.indexer_id = indexerId;
      await saveState();

      let feed = Core.findManagedEntity(
        context.feeds,
        entry,
        'feed_id',
        subscription.label,
        context.settings.adoptExisting,
        'feed'
      );
      if (!feed) {
        log(`CREATE feed ${subscription.label}`);
        feed = await context.client.createFeed(
          Core.buildFeedPayload(
            subscription,
            indexerId,
            context.intervals[subscription.key]
          )
        );
        context.feeds.push(feed);
      } else if (
        Core.feedNeedsUpdate(
          feed,
          subscription,
          indexerId,
          context.intervals[subscription.key]
        )
      ) {
        log(`UPDATE feed ${subscription.label}`);
        feed = await context.client.updateFeed(
          Core.entityId(feed, 'feed'),
          Core.buildFeedUpdatePayload(
            feed,
            subscription,
            indexer,
            context.intervals[subscription.key]
          )
        );
        replaceEntity(context.feeds, feed, 'feed');
      } else {
        log(`SKIP feed ${subscription.label}`);
      }
      const feedId = Core.entityId(feed, 'feed');
      entry.feed_id = feedId;
      await saveState();
      if (feed.enabled !== true) {
        log(`ENABLE feed ${subscription.label}`);
        await context.client.setFeedEnabled(feedId, true);
        feed.enabled = true;
      }

      let filterSummary = Core.findManagedEntity(
        context.filters,
        entry,
        'filter_id',
        subscription.label,
        context.settings.adoptExisting,
        'filter'
      );
      if (!filterSummary) {
        log(`CREATE filter ${subscription.label}`);
        filterSummary = await context.client.createFilter(
          Core.buildFilterCreatePayload(subscription)
        );
        context.filters.push(filterSummary);
      }
      const filterId = Core.entityId(filterSummary, 'filter');
      entry.filter_id = filterId;
      await saveState();

      const fullFilter = await context.client.getFilter(filterId);
      const savePath = Core.buildSavePath(
        context.settings.saveBase,
        subscription
      );
      if (
        Core.filterNeedsUpdate(
          fullFilter,
          indexerId,
          context.settings.qbitId,
          savePath,
          subscription.label
        )
      ) {
        log(`UPDATE filter ${subscription.label}`);
        await context.client.updateFilter(
          filterId,
          Core.buildFilterUpdatePayload(
            fullFilter,
            subscription,
            indexerId,
            context.settings.qbitId,
            savePath
          )
        );
      } else {
        log(`SKIP filter ${subscription.label}`);
      }
      entry.complete = true;
      await saveState();
    }

    async function runWithDisabled(button, task) {
      button.disabled = true;
      try {
        await task();
      } catch (error) {
        log(Core.redactText(error.message || String(error)), 'error');
      } finally {
        button.disabled = false;
      }
    }

    byId('connect').addEventListener('click', (event) =>
      runWithDisabled(event.currentTarget, () => loadClients())
    );

    byId('forget-token').addEventListener('click', async () => {
      sessionToken = '';
      byId('api-token').value = '';
      byId('api-token').placeholder = 'Required; not remembered by default';
      byId('remember-token').checked = false;
      await GM_deleteValue(TOKEN_KEY);
      log('Stored API token removed.', 'ok');
    });

    byId('plan').addEventListener('click', (event) =>
      runWithDisabled(event.currentTarget, async () => {
        const result = await computePlan();
        log(
          `Plan complete: ${result.rows.length} subscription(s), ` +
            `${result.failures} error(s).`,
          result.failures ? 'error' : 'ok'
        );
      })
    );

    byId('apply').addEventListener('click', (event) =>
      runWithDisabled(event.currentTarget, async () => {
        const { context, failures } = await computePlan();
        if (failures) {
          throw new Core.ToolkitError(
            'Apply blocked because the plan contains errors.'
          );
        }
        if (
          window.prompt(
            `Reconcile ${context.subscriptions.length} subscription(s)? ` +
              'Type APPLY to continue.'
          ) !== 'APPLY'
        ) {
          log('Apply cancelled.');
          return;
        }
        let failed = 0;
        for (const [index, subscription] of context.subscriptions.entries()) {
          log(
            `[${index + 1}/${context.subscriptions.length}] ${subscription.label}`
          );
          try {
            await applySubscription(context, subscription);
          } catch (error) {
            failed += 1;
            log(
              `${subscription.label}: ${Core.redactText(error.message)}`,
              'error'
            );
          }
        }
        renderManagedList();
        if (failed) {
          throw new Core.ToolkitError(
            `Apply finished with ${failed} failed subscription(s). Run Plan again.`
          );
        }
        await GM_deleteValue(QUEUE_KEY);
        stagedRows = [];
        updateStagedCount();
        log(
          `Reconciled ${context.subscriptions.length} subscription(s); ` +
            'cleared staged RSS credentials.',
          'ok'
        );
      })
    );

    byId('create-filters').addEventListener('click', (event) =>
      runWithDisabled(event.currentTarget, async () => {
        const artist = byId('artist').value.trim().replace(/\s+/g, ' ');
        if (!artist) {
          throw new Core.ToolkitError('Enter an artist.');
        }
        const categories = Array.from(
          shadow.querySelectorAll('.category:checked')
        ).map((item) => item.value);
        if (!categories.length) {
          throw new Core.ToolkitError('Select at least one category.');
        }
        const existing = new Set(
          extractRssRows().map((item) =>
            item.label.toLocaleLowerCase('en-US')
          )
        );
        const pending = categories
          .map((category) => ({
            artist,
            category,
            label: `${artist} ${category}`,
          }))
          .filter(
            (item) =>
              !existing.has(item.label.toLocaleLowerCase('en-US'))
          );
        if (!pending.length) {
          log('All selected labels already exist.');
          return;
        }
        const preview = pending.map((item) => `• ${item.label}`).join('\n');
        if (
          !window.confirm(
            `Create ${pending.length} JPopSuki filter(s)?\n\n${preview}`
          )
        ) {
          log('Creation cancelled.');
          return;
        }
        let failed = 0;
        for (const [index, item] of pending.entries()) {
          log(`[${index + 1}/${pending.length}] Creating ${item.label}`);
          try {
            await createJpopsukiFilter(item);
          } catch (error) {
            failed += 1;
            log(error.message, 'error');
          }
          if (index + 1 < pending.length) await delay(CREATE_DELAY_MS);
        }
        if (failed) {
          throw new Core.ToolkitError(
            `${failed} JPopSuki filter(s) failed. Refresh after reviewing.`
          );
        }
        log('JPopSuki filters created; refreshing for RSS links.', 'ok');
        window.setTimeout(() => window.location.reload(), 1000);
      })
    );

    byId('export-rss').addEventListener('click', () => {
      const rows = extractRssRows();
      if (!rows.length) {
        log('No RSS links found to export.', 'error');
        return;
      }
      if (
        !window.confirm(
          'Download private RSS credentials as JSON? Keep the file secret.'
        )
      ) {
        return;
      }
      downloadJson('jpopsuki-subscriptions.json', rows);
      log(`Exported ${rows.length} private RSS subscription(s).`, 'ok');
    });

    byId('stage-rss').addEventListener('click', (event) =>
      runWithDisabled(event.currentTarget, async () => {
        const rows = extractRssRows();
        const subscriptions = await Core.validateSubscriptions(rows);
        const baseUrl = Core.normalizeBaseUrl(
          byId('autobrr-launch-url').value
        );
        const staged = subscriptions.map((item) => ({
          label: item.label,
          url: item.url,
        }));
        await GM_setValue(QUEUE_KEY, {
          schema_version: 1,
          created_at: Date.now(),
          rows: staged,
        });
        config.baseUrl = baseUrl;
        await GM_setValue(CONFIG_KEY, config);
        log(
          `Staged ${staged.length} private RSS subscription(s); ` +
            'data older than 24 hours will be rejected.',
          'ok'
        );
        GM_openInTab(baseUrl, { active: true, setParent: false });
      })
    );

    byId('clear-staged').addEventListener('click', async () => {
      await GM_deleteValue(QUEUE_KEY);
      stagedRows = [];
      updateStagedCount();
      log('Staged RSS credentials cleared.', 'ok');
    });

    function managedMatcher() {
      const query = byId('managed-search').value;
      if (!query) return () => true;
      if (byId('managed-regex').checked) {
        let pattern;
        try {
          pattern = new RegExp(query, 'i');
        } catch (error) {
          byId('managed-count').textContent = `Invalid regex: ${error.message}`;
          return () => false;
        }
        return (label) => pattern.test(label);
      }
      const literal = query.toLocaleLowerCase('en-US');
      return (label) =>
        label.toLocaleLowerCase('en-US').includes(literal);
    }

    function renderManagedList() {
      const list = byId('managed-list');
      const checked = new Set(
        Array.from(list.querySelectorAll('input:checked')).map(
          (item) => item.dataset.key
        )
      );
      list.replaceChildren();
      const matches = managedMatcher();
      let visible = 0;
      for (const [key, entry] of Core.selectedStateEntries(state)) {
        const row = document.createElement('label');
        row.className = 'managed-row';
        row.dataset.visible = matches(entry.label) ? 'true' : 'false';
        if (row.dataset.visible === 'false') row.style.display = 'none';
        else visible += 1;
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.dataset.key = key;
        checkbox.checked = checked.has(key);
        const name = document.createElement('span');
        name.textContent = entry.label;
        const ids = document.createElement('small');
        ids.textContent =
          `indexer=${entry.indexer_id || '-'} ` +
          `feed=${entry.feed_id || '-'} filter=${entry.filter_id || '-'}`;
        row.append(checkbox, name, ids);
        list.appendChild(row);
      }
      byId('managed-count').textContent =
        `${visible}/${Object.keys(state.items).length} visible`;
    }

    function selectedManagedKeys() {
      return Array.from(
        byId('managed-list').querySelectorAll('input:checked')
      ).map((item) => item.dataset.key);
    }

    byId('managed-search').addEventListener('input', renderManagedList);
    byId('managed-regex').addEventListener('change', renderManagedList);
    byId('select-visible').addEventListener('click', () => {
      for (const row of byId('managed-list').querySelectorAll(
        '.managed-row[data-visible="true"]'
      )) {
        row.querySelector('input').checked = true;
      }
    });
    byId('clear-selection').addEventListener('click', () => {
      for (const checkbox of byId('managed-list').querySelectorAll(
        'input[type="checkbox"]'
      )) {
        checkbox.checked = false;
      }
    });

    async function cleanupPlan() {
      assertStateHealthy();
      const settings = readSettings();
      const client = makeClient(settings);
      const selected = selectedManagedKeys();
      const [feeds, filters] = await Promise.all([
        client.listFeeds(),
        client.listFilters(),
      ]);
      const result = Core.discoverCleanupCandidates(
        state,
        feeds,
        filters,
        selected.length ? selected : null
      );
      const lines = [
        ...result.notices.map((notice) => `NOTICE ${notice}`),
        ...result.candidates.map(
          (item) =>
            `DELETE ${item.kind} id=${item.id} ${item.label} (${item.reason})`
        ),
      ];
      managedOutput.textContent = lines.length
        ? lines.join('\n')
        : 'No managed empty filters or disabled feeds found.';
      await persistSettings(settings);
      return { client, ...result };
    }

    byId('audit-cleanup').addEventListener('click', (event) =>
      runWithDisabled(event.currentTarget, async () => {
        const result = await cleanupPlan();
        log(
          `Cleanup plan: ${result.candidates.length} candidate(s).`,
          'ok'
        );
      })
    );

    byId('apply-cleanup').addEventListener('click', (event) =>
      runWithDisabled(event.currentTarget, async () => {
        const result = await cleanupPlan();
        if (!result.candidates.length) return;
        if (
          window.prompt(
            `Delete ${result.candidates.length} managed cleanup candidate(s)? ` +
              'Type DELETE to continue.'
          ) !== 'DELETE'
        ) {
          log('Cleanup cancelled.');
          return;
        }
        for (const candidate of result.candidates) {
          if (candidate.kind === 'filter') {
            await result.client.deleteFilter(candidate.id);
          } else {
            await result.client.deleteFeed(candidate.id);
          }
          const entry = state.items[candidate.stateKey];
          delete entry[candidate.idField];
          entry.complete = false;
          await saveState();
          log(
            `Deleted ${candidate.kind} id=${candidate.id} for ${candidate.label}`,
            'ok'
          );
        }
        renderManagedList();
        managedOutput.textContent = 'Cleanup complete.';
      })
    );

    byId('delete-selected').addEventListener('click', (event) =>
      runWithDisabled(event.currentTarget, async () => {
        assertStateHealthy();
        const selected = selectedManagedKeys();
        if (!selected.length) {
          throw new Core.ToolkitError('Select at least one managed bundle.');
        }
        const settings = readSettings();
        const client = makeClient(settings);
        const [indexers, feeds, filters] = await Promise.all([
          client.listIndexers(),
          client.listFeeds(),
          client.listFilters(),
        ]);
        const result = Core.discoverBundles(
          state,
          indexers,
          feeds,
          filters,
          selected
        );
        const lines = [
          ...result.notices.map((notice) => `NOTICE ${notice}`),
          ...result.bundles.map(
            (bundle) =>
              `DELETE ${bundle.label}: filter=${bundle.filterId || '-'} ` +
              `feed=${bundle.feedId || '-'} indexer=${bundle.indexerId || '-'}`
          ),
        ];
        managedOutput.textContent = lines.join('\n');
        if (
          window.prompt(
            `Delete ${result.bundles.length} complete managed bundle(s)? ` +
              'Type DELETE to continue.'
          ) !== 'DELETE'
        ) {
          log('Bundle deletion cancelled.');
          return;
        }
        for (const bundle of result.bundles) {
          const entry = state.items[bundle.stateKey];
          const operations = [
            ['filter_id', 'filter', bundle.filterId, (id) => client.deleteFilter(id)],
            ['feed_id', 'feed', bundle.feedId, (id) => client.deleteFeed(id)],
            [
              'indexer_id',
              'indexer',
              bundle.indexerId,
              (id) => client.deleteIndexer(id),
            ],
          ];
          let failed = false;
          for (const [field, kind, id, remove] of operations) {
            if (id === null) {
              delete entry[field];
              continue;
            }
            try {
              await remove(id);
              delete entry[field];
              await saveState();
              log(`Deleted ${kind} id=${id} for ${bundle.label}`, 'ok');
            } catch (error) {
              failed = true;
              log(
                `Could not delete ${kind} id=${id}: ${error.message}`,
                'error'
              );
              break;
            }
          }
          if (
            !failed &&
            !['filter_id', 'feed_id', 'indexer_id'].some(
              (field) => Core.validManagedId(entry, field) !== null
            )
          ) {
            delete state.items[bundle.stateKey];
            await saveState();
          }
        }
        await persistSettings(settings);
        renderManagedList();
      })
    );

    byId('export-state').addEventListener('click', () => {
      try {
        assertStateHealthy();
        downloadJson('jpopsuki-autobrr-managed-state.json', state);
        log('Exported managed state without RSS URLs or API token.', 'ok');
      } catch (error) {
        log(error.message, 'error');
      }
    });

    byId('import-state-button').addEventListener('click', () =>
      byId('import-state').click()
    );
    byId('import-state').addEventListener('change', async (event) => {
      const file = event.currentTarget.files[0];
      event.currentTarget.value = '';
      if (!file) return;
      try {
        const imported = Core.validateManagedState(
          JSON.parse(await file.text())
        );
        if (
          window.prompt(
            `Replace browser managed state with ${Object.keys(imported.items).length} ` +
              'entry/entries? Type IMPORT to continue.'
          ) !== 'IMPORT'
        ) {
          log('State import cancelled.');
          return;
        }
        state = imported;
        await saveState();
        stateLoadError = '';
        renderManagedList();
        log('Managed state imported.', 'ok');
      } catch (error) {
        log(`State import failed: ${error.message}`, 'error');
      }
    });

    if (isAutobrrPage) renderManagedList();
  }

  startBrowserApp().catch((error) => {
    // Avoid printing credentials if initialization unexpectedly fails.
    console.error(`JPopSuki Autobrr Manager: ${Core.redactText(error.message)}`);
  });
})();
