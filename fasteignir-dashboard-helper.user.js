// ==UserScript==
// @name         Fasteignir.is Dashboard Helper
// @namespace    fasteignir-dashboard-helper
// @version      3.23
// @description  Adds filters, sold-listing detection, and relisting search to your saved properties on fasteignir.visir.is
// @match        https://fasteignir.visir.is/user/dashboard*
// @match        https://fasteignir.visir.is/search/results*
// @match        https://fasteignir.visir.is/property/*
// @updateURL    https://raw.githubusercontent.com/RChesterton/fasteignir-tools-public/main/fasteignir-dashboard-helper.user.js
// @downloadURL  https://raw.githubusercontent.com/RChesterton/fasteignir-tools-public/main/fasteignir-dashboard-helper.user.js
// @grant        GM_xmlhttpRequest
// @connect      fasteignir.visir.is
// @run-at       document-end
// ==/UserScript==

(function () {
  'use strict';

  // ---------- Return to a property after a login-triggered save ----------

  const FAVORITE_INTENT_KEY = 'fdh_favoriteIntent';
  const PENDING_FAVORITE_KEY = 'fdh_pendingFavorite';
  const FAVORITE_RESULT_KEY = 'fdh_favoriteResult';
  const FAVORITE_INTENT_MAX_AGE_MS = 2 * 60 * 1000;
  const PENDING_FAVORITE_MAX_AGE_MS = 10 * 60 * 1000;

  function removeSessionValue(key) {
    try {
      sessionStorage.removeItem(key);
    } catch (_) {}
  }

  function writeSessionValue(key, value) {
    try {
      sessionStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch (_) {
      return false;
    }
  }

  function readFreshSessionValue(key, maxAgeMs) {
    try {
      const value = JSON.parse(sessionStorage.getItem(key) || 'null');
      const createdAt = Number(value && value.createdAt);
      if (!value || !Number.isFinite(createdAt) || Date.now() - createdAt > maxAgeMs) {
        sessionStorage.removeItem(key);
        return null;
      }
      return value;
    } catch (_) {
      removeSessionValue(key);
      return null;
    }
  }

  function propertyIdFromUrl(value) {
    try {
      const url = new URL(value, location.href);
      if (url.origin !== location.origin) return null;
      const match = url.pathname.match(/^\/property\/(\d+)\/?$/);
      return match ? match[1] : null;
    } catch (_) {
      return null;
    }
  }

  function safeFavoriteReturnUrl(value) {
    try {
      const url = new URL(value, location.href);
      if (url.origin !== location.origin) return null;
      if (propertyIdFromUrl(url.href)) return url.href;
      if (url.pathname.startsWith('/search/results')) return url.href;
      return null;
    } catch (_) {
      return null;
    }
  }

  function canonicalPropertyIdFromCard(card) {
    if (!card) return null;
    const links = [];
    if (card.matches('a[href]')) links.push(card);
    links.push(...card.querySelectorAll('a[href]'));
    for (const link of links) {
      const id = propertyIdFromUrl(link.getAttribute('href'));
      if (id) return id;
    }
    return null;
  }

  function favoriteContextFromControl(control) {
    const card = control && control.closest('.estate__item');
    const propertyId = card
      ? canonicalPropertyIdFromCard(card)
      : propertyIdFromUrl(location.href);
    const returnUrl = safeFavoriteReturnUrl(location.href);
    if (!propertyId || !returnUrl) return null;
    return { propertyId, returnUrl, createdAt: Date.now() };
  }

  function installLoginSaveCapture() {
    document.addEventListener('click', (event) => {
      const target = event.target && event.target.closest ? event.target : null;
      if (!target) return;

      const favoriteControl = target.closest([
        '.add-to-favorites',
        '.js-add-to-favorites',
        '.js-add-favourite',
      ].join(','));
      if (favoriteControl) {
        const context = favoriteContextFromControl(favoriteControl);
        if (context) writeSessionValue(FAVORITE_INTENT_KEY, context);
      }

      const loginLink = target.closest(
        '.b-favorites-message.error .login-poppup-wrapper a.pop_block2'
      );
      if (!loginLink || (loginLink.textContent || '').trim().toLowerCase() !== 'skrá þig inn.') {
        return;
      }
      const intent = readFreshSessionValue(FAVORITE_INTENT_KEY, FAVORITE_INTENT_MAX_AGE_MS);
      if (!intent || !/^\d+$/.test(String(intent.propertyId || ''))) return;
      const returnUrl = safeFavoriteReturnUrl(intent.returnUrl);
      if (!returnUrl) return;

      intent.returnUrl = returnUrl;
      intent.loginPromptOpenedAt = Date.now();
      writeSessionValue(FAVORITE_INTENT_KEY, intent);
    }, true);

    document.addEventListener('submit', (event) => {
      const form = event.target;
      if (
        !form ||
        !form.matches ||
        !form.matches('form#login_form.modal__share-message-form') ||
        !form.closest('.fancybox-wrap.fancybox-opened')
      ) {
        return;
      }

      const intent = readFreshSessionValue(FAVORITE_INTENT_KEY, FAVORITE_INTENT_MAX_AGE_MS);
      const loginPromptOpenedAt = Number(intent && intent.loginPromptOpenedAt);
      if (
        !intent ||
        !/^\d+$/.test(String(intent.propertyId || '')) ||
        !Number.isFinite(loginPromptOpenedAt) ||
        Date.now() - loginPromptOpenedAt > FAVORITE_INTENT_MAX_AGE_MS
      ) {
        return;
      }
      const returnUrl = safeFavoriteReturnUrl(intent.returnUrl);
      if (!returnUrl) return;

      writeSessionValue(PENDING_FAVORITE_KEY, {
        propertyId: String(intent.propertyId),
        returnUrl,
        createdAt: Date.now(),
      });
      removeSessionValue(FAVORITE_INTENT_KEY);
    }, true);
  }

  function collectJsonMarkers(value, markers = new Set()) {
    if (Array.isArray(value)) {
      value.forEach((item) => collectJsonMarkers(item, markers));
    } else if (value && typeof value === 'object') {
      Object.entries(value).forEach(([key, item]) => {
        markers.add(String(key).toLowerCase());
        collectJsonMarkers(item, markers);
      });
    } else if (typeof value === 'string') {
      markers.add(value.toLowerCase());
    }
    return markers;
  }

  function classifyFavoriteResponse(status, responseText) {
    if (status < 200 || status >= 300) return 'unconfirmed';
    let parsed;
    try {
      parsed = JSON.parse(responseText);
    } catch (_) {
      return 'unconfirmed';
    }
    const markers = collectJsonMarkers(parsed);
    if (markers.has('already_has')) return 'already-saved';
    if (markers.has('success')) return 'saved';
    return 'unconfirmed';
  }

  async function savePendingFavorite(pending) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch(`/ajax/add_property_favorite/${pending.propertyId}`, {
        credentials: 'include',
        headers: { 'X-Requested-With': 'XMLHttpRequest' },
        signal: controller.signal,
      });
      const responseText = await response.text();
      const outcome = classifyFavoriteResponse(response.status, responseText);
      console.log(
        `[Fasteignir Helper] pending save response for ${pending.propertyId} (HTTP ${response.status}):`,
        responseText.slice(0, 300)
      );
      return outcome;
    } catch (error) {
      console.warn('[Fasteignir Helper] pending save failed:', error);
      return 'unconfirmed';
    } finally {
      clearTimeout(timeout);
    }
  }

  function favoriteResultMessage(outcome) {
    if (outcome === 'saved') return 'Property saved.';
    if (outcome === 'already-saved') return 'Property was already saved.';
    return 'Save could not be confirmed. Try the Save button manually.';
  }

  async function finishPendingFavorite(pending) {
    removeSessionValue(PENDING_FAVORITE_KEY);
    const outcome = await savePendingFavorite(pending);
    writeSessionValue(FAVORITE_RESULT_KEY, {
      outcome,
      propertyId: pending.propertyId,
      returnUrl: pending.returnUrl,
      createdAt: Date.now(),
    });
    location.replace(pending.returnUrl);
  }

  function showPendingFavoriteResult() {
    const result = readFreshSessionValue(FAVORITE_RESULT_KEY, PENDING_FAVORITE_MAX_AGE_MS);
    if (!result) return;
    removeSessionValue(FAVORITE_RESULT_KEY);
    setTimeout(() => alert(favoriteResultMessage(result.outcome)), 0);
  }

  const isPropertyPage = /^\/property\/\d+\/?$/.test(location.pathname);
  const isSearchResultsPage = location.pathname.startsWith('/search/results');
  if (isPropertyPage || isSearchResultsPage) {
    installLoginSaveCapture();
    showPendingFavoriteResult();
  }

  if (location.pathname.startsWith('/user/dashboard')) {
    const pendingFavorite = readFreshSessionValue(
      PENDING_FAVORITE_KEY,
      PENDING_FAVORITE_MAX_AGE_MS
    );
    if (pendingFavorite && /^\d+$/.test(String(pendingFavorite.propertyId || ''))) {
      const returnUrl = safeFavoriteReturnUrl(pendingFavorite.returnUrl);
      if (returnUrl) {
        pendingFavorite.returnUrl = returnUrl;
        finishPendingFavorite(pendingFavorite);
        return;
      }
      removeSessionValue(PENDING_FAVORITE_KEY);
    }
  }

  // ---------- Search results: hide adverts and already-saved properties ----------

  function initSearchResultsCleaner() {
    const HIDDEN_AD_CLASS = 'fdh-search-hidden-ad';
    const HIDDEN_SAVED_CLASS = 'fdh-search-hidden-saved';
    let savedPropertyIds = null;
    let showSaved = false;
    let applyTimer = null;
    let searchStatusMessage = '';
    let searchStatusHref = null;

    const searchStyle = document.createElement('style');
    searchStyle.textContent = `
      .${HIDDEN_AD_CLASS}, .${HIDDEN_SAVED_CLASS} { display: none !important; }
      #fdh-show-saved-wrap {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        margin-left: 16px;
        color: #333;
        font-size: 14px;
        font-weight: normal;
        white-space: nowrap;
      }
      #fdh-show-saved-wrap input { margin: 0; }
      #fdh-search-status {
        margin-left: 16px;
        color: #a33;
        font-size: 13px;
        font-weight: normal;
      }
    `;
    document.head.appendChild(searchStyle);

    function canonicalPropertyId(card) {
      const links = [];
      if (card.matches('a[href]')) links.push(card);
      links.push(...card.querySelectorAll('a[href]'));

      for (const link of links) {
        try {
          const url = new URL(link.getAttribute('href'), location.href);
          if (url.origin !== location.origin) continue;
          const match = url.pathname.match(/^\/property\/(\d+)\/?$/);
          if (match) return match[1];
        } catch (_) {}
      }
      return null;
    }

    function topLevelResultCards() {
      return Array.from(document.querySelectorAll('.estate__item')).filter(
        (card) => !card.parentElement || !card.parentElement.closest('.estate__item')
      );
    }

    function findResultCountEl() {
      const resultCountPattern = /^\d+\s*eignir\s+fundust$/i;
      const candidates = Array.from(document.querySelectorAll('h1, h2, h3, h4, div, span, p'));
      return candidates.find((el) => {
        if (!resultCountPattern.test((el.textContent || '').trim())) return false;
        return !Array.from(el.children).some((child) =>
          resultCountPattern.test((child.textContent || '').trim())
        );
      }) || null;
    }

    function ensureSearchControls() {
      const countEl = findResultCountEl();
      if (!countEl) return null;

      let wrap = document.getElementById('fdh-show-saved-wrap');
      if (!wrap) {
        wrap = document.createElement('label');
        wrap.id = 'fdh-show-saved-wrap';
        wrap.innerHTML = '<input id="fdh-show-saved" type="checkbox"><span></span>';
        countEl.insertAdjacentElement('afterend', wrap);
        wrap.querySelector('input').addEventListener('change', (event) => {
          showSaved = event.target.checked;
          applySearchFiltering();
        });
      }

      let status = document.getElementById('fdh-search-status');
      if (!status) {
        status = document.createElement('span');
        status.id = 'fdh-search-status';
        wrap.insertAdjacentElement('afterend', status);
      }
      renderSearchStatus(status);
      return { wrap, status };
    }

    function renderSearchStatus(status) {
      const currentLink = status.firstElementChild && status.firstElementChild.tagName === 'A'
        ? status.firstElementChild
        : null;
      const currentHref = currentLink ? currentLink.getAttribute('href') : null;
      if (status.textContent === searchStatusMessage && currentHref === searchStatusHref) return;

      status.textContent = '';
      if (!searchStatusMessage) return;

      if (searchStatusHref) {
        const link = document.createElement('a');
        link.href = searchStatusHref;
        link.textContent = searchStatusMessage;
        status.appendChild(link);
      } else {
        status.textContent = searchStatusMessage;
      }
    }

    function setSearchStatus(message, href = null) {
      searchStatusMessage = message || '';
      searchStatusHref = href;
      const controls = ensureSearchControls();
      if (!controls) return;
      renderSearchStatus(controls.status);
    }

    function applySearchFiltering() {
      const cards = topLevelResultCards();
      const savedMatchIds = new Set();

      for (const card of cards) {
        card.classList.remove(HIDDEN_AD_CLASS, HIDDEN_SAVED_CLASS);

        // These are promoted developments/properties placed ahead of the
        // normal results, even when they contain a property-looking link.
        if (card.classList.contains('wide-item-desktop')) {
          card.classList.add(HIDDEN_AD_CLASS);
          continue;
        }

        const linkId = canonicalPropertyId(card);
        if (!linkId) {
          card.classList.add(HIDDEN_AD_CLASS);
          continue;
        }

        const dataId = card.dataset.id ? String(card.dataset.id) : null;
        const confirmedId = !dataId || dataId === linkId ? linkId : null;
        if (dataId && dataId !== linkId) {
          console.warn('[Fasteignir Helper] result card ID/link mismatch; leaving it visible:', {
            dataId,
            linkId,
          });
        }

        if (confirmedId && savedPropertyIds && savedPropertyIds.has(confirmedId)) {
          savedMatchIds.add(confirmedId);
          if (!showSaved) card.classList.add(HIDDEN_SAVED_CLASS);
        }
      }

      const controls = ensureSearchControls();
      if (controls) {
        const savedMatchCount = savedMatchIds.size;
        const checkbox = controls.wrap.querySelector('input');
        const label = controls.wrap.querySelector('span');
        checkbox.checked = showSaved;
        const labelText = `Show Saved (${savedMatchCount})`;
        if (label.textContent !== labelText) label.textContent = labelText;
        controls.wrap.style.display = savedPropertyIds && savedMatchCount > 0 ? 'inline-flex' : 'none';
      }
    }

    function scheduleFiltering() {
      if (applyTimer !== null) return;
      applyTimer = setTimeout(() => {
        applyTimer = null;
        applySearchFiltering();
      }, 80);
    }

    async function loadSavedPropertyIds() {
      try {
        const response = await fetch('/user/dashboard', {
          credentials: 'include',
          headers: { Accept: 'text/html,application/xhtml+xml' },
          redirect: 'manual',
        });
        if (
          response.type === 'opaqueredirect' ||
          response.status === 0 ||
          (response.status >= 300 && response.status < 400)
        ) {
          throw new Error('not logged in');
        }
        if (!response.ok) throw new Error(`HTTP ${response.status}`);

        const responseUrl = new URL(response.url, location.href);
        const html = await response.text();
        const doc = new DOMParser().parseFromString(html, 'text/html');
        const looksLoggedOut =
          !responseUrl.pathname.startsWith('/user/dashboard') ||
          Boolean(doc.querySelector('input[type="password"], form[action*="login" i]'));
        if (looksLoggedOut) throw new Error('not logged in');

        const ids = new Set();
        for (const card of doc.querySelectorAll('.estate__item[data-id]')) {
          const id = String(card.dataset.id || '').trim();
          if (id) ids.add(id);
        }
        for (const link of doc.querySelectorAll('a[href*="/property/"]')) {
          try {
            const url = new URL(link.getAttribute('href'), responseUrl);
            const match = url.pathname.match(/^\/property\/(\d+)\/?$/);
            if (url.origin === location.origin && match) ids.add(match[1]);
          } catch (_) {}
        }

        savedPropertyIds = ids;
        setSearchStatus('');
      } catch (error) {
        savedPropertyIds = null;
        const isLoggedOut = error && error.message === 'not logged in';
        const message = isLoggedOut
          ? 'Sign in to hide saved properties.'
          : 'Saved-property check unavailable.';
        setSearchStatus(
          message,
          isLoggedOut ? '/user/login?goto=/user/dashboard' : null
        );
        console.warn('[Fasteignir Helper] could not load saved properties:', error);
      }
      applySearchFiltering();
    }

    applySearchFiltering();
    loadSavedPropertyIds();
    new MutationObserver(scheduleFiltering).observe(document.body, {
      childList: true,
      subtree: true,
    });
  }

  if (isSearchResultsPage) {
    initSearchResultsCleaner();
    return;
  }

  if (isPropertyPage) return;

  // ---------- Suppress the native "deleted" confirmation popup ----------
  // Clicking the "x" triggers the site's own removal handler, which calls a
  // native alert("Eigninni var eytt úr eignamöppu...") on success. Native
  // alert() blocks ALL page JavaScript until the user clicks OK, which would
  // stall automated removal. We intercept just that specific message so
  // other alerts (including our own) still behave normally.
  const originalAlert = window.alert.bind(window);
  window.alert = function (msg) {
    if (typeof msg === 'string' && msg.includes('eytt úr eignamöppu')) {
      console.log('[Fasteignir Helper] suppressed confirmation popup:', msg);
      return undefined;
    }
    return originalAlert(msg);
  };

  // ---------- Helpers ----------

  // Icelandic letters, used to make sure "seld"/"selt" is a standalone word
  // and not part of another word like "óseldar" (unsold) or, importantly,
  // place names like "Seltjarnarnes" - the lookahead below requires the
  // character right after "seld"/"selt" to be a non-letter (space, comma,
  // end of string etc), so it can never match into the middle of a longer
  // word, no matter what that word is.
  const ICE_LETTER = 'a-záðéíóúýþæöA-ZÁÐÉÍÓÚÝÞÆÖ';
  const SOLD_WORD_RE = new RegExp(`(?<![${ICE_LETTER}])(seld|selt)(?![${ICE_LETTER}])`, 'i');

  function parsePrice(text) {
    const digits = (text || '').replace(/[^\d]/g, '');
    return digits ? parseInt(digits, 10) : null;
  }

  function parseSize(text) {
    const m = (text || '').replace(',', '.').match(/[\d.]+/);
    return m ? parseFloat(m[0]) : null;
  }

  function parseIntSafe(text) {
    const m = (text || '').match(/\d+/);
    return m ? parseInt(m[0], 10) : null;
  }

  // ---------- Open house parsing ----------

  const ICE_MONTHS = {
    janúar: 0, febrúar: 1, mars: 2, apríl: 3, maí: 4, júní: 5,
    júlí: 6, ágúst: 7, september: 8, október: 9, nóvember: 10, desember: 11,
  };

  // Parses text like "24. júní, kl. 16:00 – 16:30" into a usable date/time.
  // No year is shown on the site, so one is inferred: if the parsed date
  // would be more than a day in the past relative to today, it must mean
  // next year (handles the Dec->Jan rollover).
  function parseOpenHouseText(text) {
    const t = (text || '').trim();
    const m = t.match(/(\d{1,2})\.\s*([a-záðéíóúýþæö]+),?\s*kl\.\s*(\d{1,2}:\d{2})\s*[-–—]\s*(\d{1,2}:\d{2})/i);
    if (!m) return null;
    const day = parseInt(m[1], 10);
    const monthIndex = ICE_MONTHS[m[2].toLowerCase()];
    if (monthIndex == null) return null;
    const startTime = m[3];
    const endTime = m[4];

    const now = new Date();
    let year = now.getFullYear();
    let date = new Date(year, monthIndex, day);
    if (date.getTime() < now.getTime() - 24 * 60 * 60 * 1000) {
      year += 1;
      date = new Date(year, monthIndex, day);
    }
    return { date, day, month: monthIndex, year, startTime, endTime };
  }

  function getCardEls() {
    return Array.from(document.querySelectorAll('.estate__item[data-id]'));
  }

  function parseCard(el) {
    const id = el.dataset.id;
    const titleEl = el.querySelector('.estate__item-title');
    let street = '';
    let rest = '';
    if (titleEl) {
      const span = titleEl.querySelector('span');
      street = span ? span.textContent.trim() : '';
      rest = Array.from(titleEl.childNodes)
        .filter((n) => n.nodeType === Node.TEXT_NODE)
        .map((n) => n.textContent.trim())
        .join(' ')
        .trim();
    }
    const postalMatch = rest.match(/(\d{3})/);
    const postal = postalMatch ? postalMatch[1] : '';

    // Each parameter box has a fixed category tied to its class suffix
    // (--1 size icon, --2 rooms icon, --3 bathrooms icon, --4 bedrooms icon).
    // Some properties omit boxes entirely (e.g. no bathroom count listed), so
    // we must select each one by its specific class rather than by position,
    // otherwise a missing box shifts every later value into the wrong field.
    const sizeEl = el.querySelector('.estate__parameters--1');
    const roomsEl = el.querySelector('.estate__parameters--2');
    const bathsEl = el.querySelector('.estate__parameters--3');
    const bedsEl = el.querySelector('.estate__parameters--4');
    const size = sizeEl ? parseSize(sizeEl.textContent) : null;
    const rooms = roomsEl ? parseIntSafe(roomsEl.textContent) : null;
    const baths = bathsEl ? parseIntSafe(bathsEl.textContent) : null;
    const beds = bedsEl ? parseIntSafe(bedsEl.textContent) : null;

    const priceEl = el.querySelector('.estate__price');
    const priceText = priceEl ? priceEl.textContent.trim() : '';
    const price = priceEl ? parsePrice(priceEl.textContent) : null;
    // "Tilboð" (by offer) listings have no numeric price at all.
    const isTilbod = price == null && /tilbo/i.test(priceText);

    const addressSaysSold = SOLD_WORD_RE.test(street + ' ' + rest);

    const openHouses = Array.from(el.querySelectorAll('.estate__data'))
      .map((d) => parseOpenHouseText(d.textContent))
      .filter(Boolean);

    return {
      id,
      el,
      street,
      postal,
      size,
      rooms,
      baths,
      beds,
      price,
      isTilbod,
      addressSaysSold,
      openHouses,
      url: `https://fasteignir.visir.is/property/${id}`,
      status: addressSaysSold ? 'sold-address' : 'unchecked',
    };
  }

  // ---------- Toolbar UI ----------

  const style = document.createElement('style');
  style.textContent = `
    #fdh-toolbar, #fdh-openhouse {
      background: #fff;
      border: 1px solid #ddd;
      border-radius: 8px;
      padding: 14px 16px;
      margin: 0 0 12px 0;
      font-family: inherit;
      font-size: 14px;
    }
    #fdh-toolbar { display: flex; flex-direction: column; gap: 12px; }
    #fdh-toolbar .fdh-row {
      display: flex;
      flex-wrap: wrap;
      gap: 14px;
      align-items: flex-end;
      width: 100%;
    }
    .fdh-section-header {
      display: flex; align-items: center; justify-content: space-between;
    }
    .fdh-section-header-left { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; }
    .fdh-section-header h4 { margin: 0; font-size: 14px; color: #333; }
    .fdh-collapse-arrow {
      cursor: pointer; font-size: 13px; color: #777; user-select: none;
      padding: 2px 6px;
    }
    .fdh-collapse-arrow:hover { color: #333; }
    #fdh-toolbar .fdh-field { display: flex; flex-direction: column; gap: 4px; }
    #fdh-toolbar label { font-size: 13px; color: #555; }
    #fdh-toolbar .fdh-checkbox-label, #fdh-openhouse .fdh-checkbox-label {
      font-size: 13px; color: #333; display: flex; align-items: center; gap: 4px;
    }
    #fdh-toolbar input[type=number] { width: 80px; }
    #fdh-toolbar input[type=number], #fdh-toolbar input[type=text] { padding: 4px; box-sizing: border-box; }
    #fdh-toolbar input:disabled, #fdh-toolbar select:disabled {
      opacity: 0.65;
      cursor: not-allowed;
    }
    #fdh-toolbar .fdh-range { display: flex; gap: 4px; align-items: center; }
    #fdh-toolbar button {
      background: #3b68bc; color: #fff; border: none; border-radius: 5px;
      padding: 7px 12px; cursor: pointer; font-size: 13px;
    }
    #fdh-toolbar button:hover { background: #2d5099; }
    #fdh-toolbar button.fdh-secondary { background: #888; }
    #fdh-toolbar button.fdh-secondary:hover { background: #666; }
    #fdh-toolbar button.fdh-danger { background: #b3261e; }
    #fdh-toolbar button.fdh-danger:hover { background: #8f1e18; }
    #fdh-toolbar button:disabled,
    #fdh-toolbar button.fdh-danger:disabled {
      background: #ccc; color: #888; cursor: not-allowed;
    }
    #fdh-postal-list { display: flex; flex-wrap: wrap; gap: 6px; }
    #fdh-postal-list label { display: flex; align-items: center; gap: 3px; font-size: 13px; }
    #fdh-status-line { font-size: 14px; color: #333; }
    #fdh-status-report { display: none; width: 100%; }
    #fdh-status-report.fdh-visible { display: block; }
    #fdh-status-report-actions {
      display: flex; align-items: center; gap: 8px; margin-bottom: 6px;
    }
    #fdh-status-report-output {
      width: 100%; min-height: 260px; resize: vertical; box-sizing: border-box;
      padding: 8px; border: 1px solid #ccc; background: #fff; color: #222;
      font: 12px/1.4 Consolas, "Courier New", monospace;
    }
    .fdh-badge {
      display: inline-block; font-size: 11px; font-weight: bold; padding: 2px 8px;
      border-radius: 10px; margin: 4px 0; color: #fff;
    }
    .fdh-badge-active { background: #3a9d3a; }
    .fdh-badge-gone { background: #b3261e; }
    .fdh-badge-sold-text { background: #d98c00; }
    .fdh-badge-sold-address { background: #d98c00; }
    .fdh-badge-checking { background: #999; }
    .fdh-remove-search-btn {
      display: inline-block; font-size: 11px; font-weight: bold; padding: 2px 8px;
      border-radius: 10px; margin: 4px 0 4px 4px; color: #fff; background: #7a3bbc;
      border: none; cursor: pointer;
    }
    .fdh-remove-search-btn:hover { background: #5e2d92; }
    .fdh-remove-search-btn:disabled { background: #bbb; cursor: default; }
    .fdh-debug { font-size: 11px; color: #777; }
    .fdh-hidden-by-filter { display: none !important; }
    #fdh-openhouse-body { margin-top: 8px; font-size: 13px; color: #333; }
    #fdh-openhouse-body .fdh-oh-date { margin: 3px 0; }
    #fdh-openhouse-body a { color: #3b68bc; text-decoration: none; }
    #fdh-openhouse-body a:hover { text-decoration: underline; }
  `;
  document.head.appendChild(style);

  const toolbar = document.createElement('div');
  toolbar.id = 'fdh-toolbar';
  toolbar.innerHTML = `
    <div class="fdh-section-header">
      <div class="fdh-section-header-left">
        <h4>Filters</h4>
        <label class="fdh-checkbox-label"><input type="checkbox" id="fdh-show-active" checked> Show Active</label>
        <label class="fdh-checkbox-label"><input type="checkbox" id="fdh-show-sold" checked> Show Removed</label>
        <label class="fdh-checkbox-label"><input type="checkbox" id="fdh-debug"> Show Data</label>
        <span id="fdh-visible-count" style="font-size:13px;color:#555;"></span>
      </div>
      <span class="fdh-collapse-arrow" id="fdh-toolbar-collapse">▾</span>
    </div>
    <div id="fdh-toolbar-body" style="display:flex; flex-direction:column; gap:12px;">
      <div class="fdh-row">
        <div class="fdh-field">
          <label>Address Filter</label>
          <input type="text" id="fdh-address-filter" placeholder="e.g. Kristnibraut" style="width:140px;" autocomplete="off" readonly>
        </div>
        <div class="fdh-field">
          <label>Price (million ISK)</label>
          <div class="fdh-range">
            <input type="number" id="fdh-price-min" placeholder="min" step="5" autocomplete="off" readonly>
            <span>-</span>
            <input type="number" id="fdh-price-max" placeholder="max" step="5" autocomplete="off" readonly>
          </div>
        </div>
        <div class="fdh-field">
          <label>Size (m²)</label>
          <div class="fdh-range">
            <input type="number" id="fdh-size-min" placeholder="min" autocomplete="off" readonly>
            <span>-</span>
            <input type="number" id="fdh-size-max" placeholder="max" autocomplete="off" readonly>
          </div>
        </div>
        <div class="fdh-field">
          <label>Rooms</label>
          <input type="number" id="fdh-rooms-min" placeholder="min" autocomplete="off" readonly>
        </div>
        <div class="fdh-field">
          <label>Bathrooms</label>
          <input type="number" id="fdh-baths-min" placeholder="min" autocomplete="off" readonly>
        </div>
        <div class="fdh-field">
          <label>Bedrooms</label>
          <input type="number" id="fdh-beds-min" placeholder="min" autocomplete="off" readonly>
        </div>
      </div>
      <div class="fdh-row">
        <label class="fdh-checkbox-label"><input type="checkbox" id="fdh-exclude-tilbod"> Exclude Tilboð</label>
        <label class="fdh-checkbox-label"><input type="checkbox" id="fdh-only-tilbod"> Only Tilboð</label>
        <label class="fdh-checkbox-label"><input type="checkbox" id="fdh-exclude-unknown"> Exclude Unknown</label>
        <label class="fdh-checkbox-label"><input type="checkbox" id="fdh-only-unknown"> Only Unknown</label>
      </div>
      <div class="fdh-row">
        <div class="fdh-field" style="flex:1;">
          <label>Postal code</label>
          <div id="fdh-postal-list"></div>
        </div>
      </div>
      <div class="fdh-row">
        <button id="fdh-apply">Filter</button>
        <button id="fdh-clear" class="fdh-secondary">Clear filter</button>
        <button id="fdh-test-status">Test Status Check</button>
        <button id="fdh-remove" class="fdh-danger" disabled>Remove Sold</button>
        <div id="fdh-status-line"></div>
      </div>
      <div id="fdh-status-report">
        <div id="fdh-status-report-actions">
          <button id="fdh-copy-status-report" class="fdh-secondary">Copy Report</button>
          <button id="fdh-clear-status-report" class="fdh-secondary">Clear Report</button>
        </div>
        <textarea id="fdh-status-report-output" readonly autocomplete="off"></textarea>
      </div>
    </div>
  `;

  const firstCard = getCardEls()[0];
  if (firstCard && firstCard.parentElement) {
    firstCard.parentElement.insertAdjacentElement('beforebegin', toolbar);
  } else {
    document.body.insertBefore(toolbar, document.body.firstChild);
  }

  const openHouseSection = document.createElement('div');
  openHouseSection.id = 'fdh-openhouse';
  openHouseSection.innerHTML = `
    <div class="fdh-section-header">
      <div class="fdh-section-header-left">
        <h4>Upcoming Open Houses</h4>
        <label class="fdh-checkbox-label"><input type="checkbox" id="fdh-only-openhouse"> Only show Open Houses</label>
      </div>
      <span class="fdh-collapse-arrow" id="fdh-oh-collapse">▾</span>
    </div>
    <div id="fdh-openhouse-body"></div>
  `;
  toolbar.insertAdjacentElement('afterend', openHouseSection);

  function setupCollapse(arrowId, bodyId) {
    const arrow = document.getElementById(arrowId);
    const body = document.getElementById(bodyId);
    arrow.addEventListener('click', () => {
      const collapsed = body.style.display === 'none';
      body.style.display = collapsed ? '' : 'none';
      arrow.textContent = collapsed ? '▾' : '▸';
    });
  }
  setupCollapse('fdh-toolbar-collapse', 'fdh-toolbar-body');
  setupCollapse('fdh-oh-collapse', 'fdh-openhouse-body');

  // ---------- Build card data + postal code checkboxes ----------

  let cards = getCardEls().map(parseCard);

  function buildPostalList() {
    const postals = Array.from(new Set(cards.map((c) => c.postal).filter(Boolean))).sort();
    const container = document.getElementById('fdh-postal-list');
    container.innerHTML = postals
      .map(
        (p) => `<label><input type="checkbox" class="fdh-postal-cb" value="${p}" checked>${p}</label>`
      )
      .join('');
  }
  buildPostalList();

  // Lists every upcoming open house among saved properties, grouped by date
  // (earliest first), with entries sharing the exact same date and time
  // range combined onto one line. Excludes properties already known to be
  // sold (via the address text, or already removed in this session).
  function renderOpenHouses() {
    const entries = [];
    cards.forEach((c) => {
      if (c.status === 'sold-address' || c._removed) return;
      (c.openHouses || []).forEach((oh) => entries.push({ ...oh, street: c.street, url: c.url }));
    });
    const body = document.getElementById('fdh-openhouse-body');
    if (entries.length === 0) {
      body.textContent = 'None among your saved properties.';
      return;
    }
    // Sort by date, then start time, then end time - so when two entries
    // share a start time, the one ending earlier is listed first.
    entries.sort(
      (a, b) => a.date - b.date || a.startTime.localeCompare(b.startTime) || a.endTime.localeCompare(b.endTime)
    );
    const dateGroups = new Map();
    entries.forEach((oh) => {
      const dateKey = `${String(oh.day).padStart(2, '0')}/${String(oh.month + 1).padStart(2, '0')}`;
      if (!dateGroups.has(dateKey)) dateGroups.set(dateKey, new Map());
      const timeGroups = dateGroups.get(dateKey);
      const timeKey = `${oh.startTime}-${oh.endTime}`;
      if (!timeGroups.has(timeKey)) timeGroups.set(timeKey, []);
      timeGroups.get(timeKey).push(oh);
    });
    const rows = [];
    dateGroups.forEach((timeGroups, dateKey) => {
      const segments = [];
      timeGroups.forEach((items, timeKey) => {
        const addresses = items
          .map((oh) => `<a href="${oh.url}" target="_blank">${oh.street}</a>`)
          .join(', ');
        segments.push(`${timeKey}: ${addresses}`);
      });
      rows.push(`<div class="fdh-oh-date"><strong>${dateKey}</strong> ${segments.join(' | ')}</div>`);
    });
    body.innerHTML = rows.join('');
  }
  renderOpenHouses();

  function statusLine(msg) {
    document.getElementById('fdh-status-line').textContent = msg;
  }

  function updateVisibleCount(visibleCount) {
    document.getElementById('fdh-visible-count').textContent = `${visibleCount}/${cards.length}`;
  }

  function reloadImages() {
    document.querySelectorAll('.estate__item[data-id] img').forEach((img) => {
      if (!img.src) return;
      const base = img.src.split('?')[0];
      img.src = `${base}?_r=${Date.now()}`;
    });
  }

  // ---------- Debug overlay ----------

  function renderDebug() {
    const show = document.getElementById('fdh-debug').checked;
    cards.forEach((c) => {
      let dbg = c.el.querySelector('.fdh-debug');
      if (show) {
        if (!dbg) {
          dbg = document.createElement('div');
          dbg.className = 'fdh-debug';
          const content = c.el.querySelector('.estate__item-content') || c.el;
          content.appendChild(dbg);
        }
        dbg.textContent = `size:${c.size ?? '?'} rooms:${c.rooms ?? '?'} baths:${c.baths ?? '?'} beds:${c.beds ?? '?'} price:${c.isTilbod ? 'Tilboð' : c.price ?? '?'} postal:${c.postal ?? '?'}`;
      } else if (dbg) {
        dbg.remove();
      }
    });
  }
  document.getElementById('fdh-debug').addEventListener('change', () => {
    renderDebug();
  });

  // ---------- Filtering ----------

  function applyFilter(suffix) {
    const showActive = document.getElementById('fdh-show-active').checked;
    const showSold = document.getElementById('fdh-show-sold').checked;
    const onlyOpenHouse = document.getElementById('fdh-only-openhouse').checked;
    const addressQuery = document.getElementById('fdh-address-filter').value.trim().toLowerCase();

    const priceMinRaw = document.getElementById('fdh-price-min').value;
    const priceMaxRaw = document.getElementById('fdh-price-max').value;
    const priceFilterActive = priceMinRaw !== '' || priceMaxRaw !== '';
    const priceMin = priceMinRaw !== '' ? parseFloat(priceMinRaw) * 1e6 : -Infinity;
    const priceMax = priceMaxRaw !== '' ? parseFloat(priceMaxRaw) * 1e6 : Infinity;
    const excludeTilbod = document.getElementById('fdh-exclude-tilbod').checked;
    const onlyTilbod = document.getElementById('fdh-only-tilbod').checked;
    const excludeUnknown = document.getElementById('fdh-exclude-unknown').checked;
    const onlyUnknown = document.getElementById('fdh-only-unknown').checked;

    const sizeMinRaw = document.getElementById('fdh-size-min').value;
    const sizeMaxRaw = document.getElementById('fdh-size-max').value;
    const sizeFilterActive = sizeMinRaw !== '' || sizeMaxRaw !== '';
    const sizeMin = sizeMinRaw !== '' ? parseFloat(sizeMinRaw) : -Infinity;
    const sizeMax = sizeMaxRaw !== '' ? parseFloat(sizeMaxRaw) : Infinity;

    const roomsMinRaw = document.getElementById('fdh-rooms-min').value;
    const roomsFilterActive = roomsMinRaw !== '';
    const roomsMin = roomsFilterActive ? parseFloat(roomsMinRaw) : -Infinity;

    const bathsMinRaw = document.getElementById('fdh-baths-min').value;
    const bathsFilterActive = bathsMinRaw !== '';
    const bathsMin = bathsFilterActive ? parseFloat(bathsMinRaw) : -Infinity;

    const bedsMinRaw = document.getElementById('fdh-beds-min').value;
    const bedsFilterActive = bedsMinRaw !== '';
    const bedsMin = bedsFilterActive ? parseFloat(bedsMinRaw) : -Infinity;

    const checkedPostals = Array.from(document.querySelectorAll('.fdh-postal-cb:checked')).map(
      (cb) => cb.value
    );
    const allPostalsChecked =
      checkedPostals.length === document.querySelectorAll('.fdh-postal-cb').length;

    let visibleCount = 0;
    cards.forEach((c) => {
      let priceOk;
      if (onlyTilbod) {
        priceOk = c.isTilbod;
      } else if (c.isTilbod) {
        priceOk = !excludeTilbod;
      } else if (c.price == null) {
        // No price shown at all (rare/edge case) - exclude only if a filter is active.
        priceOk = !priceFilterActive;
      } else {
        priceOk = c.price >= priceMin && c.price <= priceMax;
      }

      const addressOk = !addressQuery || c.street.toLowerCase().includes(addressQuery);
      const sizeOk = !sizeFilterActive || (c.size != null && c.size >= sizeMin && c.size <= sizeMax);
      const roomsOk = !roomsFilterActive || (c.rooms != null && c.rooms >= roomsMin);
      const bathsOk = !bathsFilterActive || (c.baths != null && c.baths >= bathsMin);
      const bedsOk = !bedsFilterActive || (c.beds != null && c.beds >= bedsMin);
      const hasUnknownStats = c.size == null || c.rooms == null || c.baths == null || c.beds == null;
      const unknownOk = onlyUnknown ? hasUnknownStats : !excludeUnknown || !hasUnknownStats;
      const postalOk = allPostalsChecked || checkedPostals.includes(c.postal);
      const openHouseOk = !onlyOpenHouse || (c.openHouses && c.openHouses.length > 0);

      let statusOk;
      if (c.status === 'active') {
        statusOk = showActive;
      } else if (c.status === 'gone' || c.status === 'sold-text' || c.status === 'sold-address') {
        statusOk = showSold;
      } else {
        // Not checked yet (or check still in progress) - don't hide it
        // while we don't yet know which bucket it belongs in.
        statusOk = true;
      }

      const match =
        priceOk && addressOk && sizeOk && roomsOk && bathsOk && bedsOk && unknownOk && postalOk && statusOk && openHouseOk;
      c.el.classList.toggle('fdh-hidden-by-filter', !match);
      if (match) visibleCount++;
    });
    updateVisibleCount(visibleCount);
    const activeCount = cards.filter((c) => c.status === 'active' && !c._removed).length;
    const soldCount = cards.filter(
      (c) =>
        (c.status === 'gone' || c.status === 'sold-text' || c.status === 'sold-address') && !c._removed
    ).length;
    const unknownStatusCount = cards.filter((c) => c.status === 'unknown' && !c._removed).length;
    statusLine(
      `Showing ${visibleCount} of ${cards.length} properties. Active: ${activeCount}, Removed: ${soldCount}` +
      `${unknownStatusCount > 0 ? `, Unknown status: ${unknownStatusCount}` : ''}.` +
      `${suffix ? ' ' + suffix : ''}`
    );
  }

  document.getElementById('fdh-apply').addEventListener('click', () => {
    applyFilter();
    reloadImages();
  });
  document.getElementById('fdh-address-filter').addEventListener('input', () => applyFilter());

  function setFilterControlsDisabled(disabled) {
    toolbar.querySelectorAll(
      '#fdh-address-filter, #fdh-price-min, #fdh-price-max, #fdh-size-min, #fdh-size-max, ' +
      '#fdh-rooms-min, #fdh-baths-min, #fdh-beds-min, .fdh-postal-cb, ' +
      '#fdh-exclude-tilbod, #fdh-only-tilbod, #fdh-exclude-unknown, #fdh-only-unknown, ' +
      '#fdh-show-active, #fdh-show-sold, #fdh-debug, #fdh-apply, #fdh-clear'
    ).forEach((el) => {
      el.disabled = disabled;
    });
    document.getElementById('fdh-only-openhouse').disabled = disabled;
  }

  // autocomplete="off" alone does NOT stop Firefox/Chrome from autofilling
  // saved passwords or addresses into these fields - confirmed via live
  // testing (a saved password ended up in the Bedrooms filter). Browsers
  // deliberately ignore that attribute for any field their own heuristics
  // decide looks identity-related, regardless of type or id. Marking the
  // field readonly until the user actually focuses it is the standard
  // workaround, since readonly genuinely excludes it from the browser's
  // autofill path rather than just hinting that it should be skipped.
  ['fdh-address-filter', 'fdh-price-min', 'fdh-price-max', 'fdh-size-min', 'fdh-size-max',
    'fdh-rooms-min', 'fdh-baths-min', 'fdh-beds-min'].forEach((id) => {
    const el = document.getElementById(id);
    el.addEventListener('focus', () => el.removeAttribute('readonly'));
    el.addEventListener('blur', () => el.setAttribute('readonly', ''));
  });
  document.getElementById('fdh-exclude-tilbod').addEventListener('change', () => {
    if (document.getElementById('fdh-exclude-tilbod').checked) {
      document.getElementById('fdh-only-tilbod').checked = false;
    }
    applyFilter();
    reloadImages();
  });
  document.getElementById('fdh-only-tilbod').addEventListener('change', () => {
    if (document.getElementById('fdh-only-tilbod').checked) {
      document.getElementById('fdh-exclude-tilbod').checked = false;
    }
    applyFilter();
    reloadImages();
  });
  document.getElementById('fdh-exclude-unknown').addEventListener('change', () => {
    if (document.getElementById('fdh-exclude-unknown').checked) {
      document.getElementById('fdh-only-unknown').checked = false;
    }
    applyFilter();
    reloadImages();
  });
  document.getElementById('fdh-only-unknown').addEventListener('change', () => {
    if (document.getElementById('fdh-only-unknown').checked) {
      document.getElementById('fdh-exclude-unknown').checked = false;
    }
    applyFilter();
    reloadImages();
  });
  document.getElementById('fdh-show-active').addEventListener('change', () => {
    applyFilter();
    reloadImages();
  });
  document.getElementById('fdh-show-sold').addEventListener('change', () => {
    applyFilter();
    reloadImages();
  });
  document.getElementById('fdh-only-openhouse').addEventListener('change', () => {
    applyFilter();
    reloadImages();
  });
  document.getElementById('fdh-clear').addEventListener('click', () => {
    Array.from(toolbar.querySelectorAll('input[type=number]')).forEach((i) => (i.value = ''));
    Array.from(toolbar.querySelectorAll('.fdh-postal-cb')).forEach((cb) => (cb.checked = true));
    document.getElementById('fdh-address-filter').value = '';
    document.getElementById('fdh-exclude-tilbod').checked = false;
    document.getElementById('fdh-only-tilbod').checked = false;
    document.getElementById('fdh-exclude-unknown').checked = false;
    document.getElementById('fdh-only-unknown').checked = false;
    document.getElementById('fdh-show-active').checked = true;
    document.getElementById('fdh-show-sold').checked = true;
    document.getElementById('fdh-only-openhouse').checked = false;
    applyFilter();
    reloadImages();
  });

  // ---------- Silent relisting search ----------

  // Keeps the site's own pre-filter loose so a genuine relisting that was
  // remeasured doesn't get silently excluded before our own stricter matching
  // logic ever sees it. Confirmed via live testing: a tight band excluded
  // real relistings before they reached our matching (Snæland 2, Helluvað 13).
  const AREA_SEARCH_TOLERANCE = 20;

  // The site's search doesn't handle a hyphenated street-number range
  // (e.g. "Langholtsvegur 122-124") - using just the part before the hyphen
  // finds it correctly.
  function searchKeyword(street) {
    if (!street) return street;
    const hyphenIndex = street.indexOf('-');
    if (hyphenIndex === -1) return street;
    return street.slice(0, hyphenIndex).trim();
  }

  // Builds a search results URL for manual review (no auto-favorite trigger).
  // Used when area-mismatch or results-no-match needs human eyes.
  function buildManualReviewUrl(c) {
    const hashParts = [];
    if (c.size != null) {
      const areaMin = Math.max(0, Math.floor(c.size) - AREA_SEARCH_TOLERANCE);
      const areaMax = Math.ceil(c.size) + AREA_SEARCH_TOLERANCE;
      hashParts.push(`area=${areaMin},${areaMax}`);
    }
    hashParts.push('sort=price');
    if (c.street) hashParts.push(`keyword=${encodeURIComponent(searchKeyword(c.street))}`);
    hashParts.push('stype=sale');
    if (c.baths != null) hashParts.push(`bathroom=${c.baths},${c.baths}`);
    if (c.beds != null) hashParts.push(`bedroom=${c.beds},${c.beds}`);
    if (c.rooms != null) hashParts.push(`room=${c.rooms},${c.rooms}`);
    return `https://fasteignir.visir.is/search/results/?stype=sale#/?${hashParts.join('&')}`;
  }

  // Strict match: if the sold card (ref) has a value for any field, the
  // candidate must also have that field with a matching value. A candidate
  // that's missing data we have on the ref is rejected — we can't confirm it.
  function isRealMatchData(ref, candidate) {
    if (ref.size != null) {
      if (candidate.size == null) return false;
      if (Math.abs(candidate.size - ref.size) > 0.05) return false;
    }
    if (ref.rooms != null) {
      if (candidate.rooms == null) return false;
      if (candidate.rooms !== ref.rooms) return false;
    }
    if (ref.baths != null) {
      if (candidate.baths == null) return false;
      if (candidate.baths !== ref.baths) return false;
    }
    if (ref.beds != null) {
      if (candidate.beds == null) return false;
      if (candidate.beds !== ref.beds) return false;
    }
    return true;
  }

  // Area-mismatch: rooms/baths/beds all match the ref (where known), but
  // size is confirmed different (both sides have a value that differs > 0.05).
  // Indicates "probably the same property but the listed area changed" —
  // needs a person to review rather than being silently saved or ignored.
  function isAreaMismatchData(ref, candidate) {
    if (ref.size == null || candidate.size == null) return false;
    if (Math.abs(candidate.size - ref.size) <= 0.05) return false;
    if (ref.rooms != null) {
      if (candidate.rooms == null || candidate.rooms !== ref.rooms) return false;
    }
    if (ref.baths != null) {
      if (candidate.baths == null || candidate.baths !== ref.baths) return false;
    }
    if (ref.beds != null) {
      if (candidate.beds == null || candidate.beds !== ref.beds) return false;
    }
    return true;
  }

  const LIVE_RELIST_CONCURRENCY = 4;
  const LIVE_OPERATION_TIMEOUT_MS = 15000;
  const LIVE_RETRY_DELAYS_MS = [0, 750, 2000];
  const LIVE_RETRYABLE_HTTP = new Set([408, 425, 429, 500, 502, 503, 504]);

  function parseJsonScalar(text) {
    try {
      const value = JSON.parse(text);
      return typeof value === 'string' ? value : null;
    } catch (_) {
      return null;
    }
  }

  async function requestTextOnce(url, options) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), LIVE_OPERATION_TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        ...options,
        signal: controller.signal,
      });
      return {
        ok: response.ok,
        status: response.status,
        text: await response.text(),
        finalUrl: response.url || url,
        retryable: LIVE_RETRYABLE_HTTP.has(response.status),
        error: null,
      };
    } catch (error) {
      return {
        ok: false,
        status: null,
        text: '',
        finalUrl: url,
        retryable: true,
        error: error && error.name === 'AbortError'
          ? `Timed out after ${LIVE_OPERATION_TIMEOUT_MS} ms`
          : String(error && error.message ? error.message : error),
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  async function requestTextWithRetries(url, options) {
    let result = null;
    let attempts = 0;
    for (const retryDelayMs of LIVE_RETRY_DELAYS_MS) {
      if (retryDelayMs > 0) await wait(retryDelayMs);
      attempts++;
      result = await requestTextOnce(url, options);
      if (!result.retryable) break;
    }
    return { ...result, attempts };
  }

  async function runBoundedWorkers(items, concurrency, handler, onProgress) {
    const results = new Array(items.length);
    let nextIndex = 0;
    let completed = 0;
    let active = 0;

    async function worker() {
      while (true) {
        const index = nextIndex++;
        if (index >= items.length) return;
        active++;
        if (onProgress) onProgress({ phase: 'started', completed, active, total: items.length });
        try {
          results[index] = await handler(items[index], index);
        } finally {
          active--;
          completed++;
          if (onProgress) {
            onProgress({
              phase: 'completed',
              completed,
              active,
              total: items.length,
              result: results[index],
            });
          }
        }
      }
    }

    const workerCount = Math.min(Math.max(1, concurrency), items.length);
    if (workerCount > 0) {
      await Promise.all(Array.from({ length: workerCount }, () => worker()));
    }
    return results;
  }

  // Calls the site's add-to-favorites endpoint directly for a known property
  // ID. Returns 'newly-saved', 'already-saved', or 'failed'.
  async function saveSilently(id) {
    const response = await requestTextWithRetries(`/ajax/add_property_favorite/${id}`, {
      method: 'GET',
      credentials: 'include',
      headers: { 'X-Requested-With': 'XMLHttpRequest' },
      cache: 'no-store',
    });
    const scalar = response.ok ? parseJsonScalar(response.text) : null;
    const outcome = scalar === 'success'
      ? 'newly-saved'
      : scalar === 'already_has'
        ? 'already-saved'
        : 'failed';
    console.log(
      `[Fasteignir Helper] save response for ${id} ` +
      `(HTTP ${response.status == null ? 'none' : response.status}, ${response.attempts} attempt(s)):`,
      response.text.slice(0, 300) || response.error
    );
    try {
      const existing = JSON.parse(sessionStorage.getItem('fdh_saveDiag') || '[]');
      existing.push({
        id,
        httpStatus: response.status,
        body: response.text.slice(0, 500),
        error: response.error,
        attempts: response.attempts,
        outcome,
        ts: new Date().toISOString(),
      });
      sessionStorage.setItem('fdh_saveDiag', JSON.stringify(existing));
    } catch (_) {}
    return outcome;
  }

  function isDifferentListingId(ref, candidate) {
    return String(candidate.id) !== String(ref.id);
  }

  function exactReplacementMatches(ref, candidates) {
    return candidates.filter((candidate) =>
      isDifferentListingId(ref, candidate) && isRealMatchData(ref, candidate)
    );
  }

  // Searches silently for a relisting of the sold card c. Returns:
  //   'no-match'         — search returned no results → safe to remove
  //   'favorited'        — found exact match(es), saved them → safe to remove
  //   'area-mismatch'    — results found, size differs → leave in place, open tab
  //   'results-no-match' — results found but nothing matched → leave, open tab
  //   'save-failed'      — found a match but save endpoint failed → leave in place
  //   'error'            — network/parse failure → leave in place
  async function silentRelistSearch(c) {
    const params = new URLSearchParams({ stype: 'sale' });
    if (c.street) params.set('keyword', searchKeyword(c.street));
    if (c.size != null) {
      const areaMin = Math.max(0, Math.floor(c.size) - AREA_SEARCH_TOLERANCE);
      const areaMax = Math.ceil(c.size) + AREA_SEARCH_TOLERANCE;
      params.set('area', `${areaMin},${areaMax}`);
    }
    const searchUrl = `/ajaxsearch/getresults?${params.toString()}`;
    console.log(`[Fasteignir Helper] silent search for ${c.id} (${c.street}): ${searchUrl}`);

    const response = await requestTextWithRetries(searchUrl, {
      method: 'GET',
      headers: { 'Accept': 'text/html, */*; q=0.01', 'X-Requested-With': 'XMLHttpRequest' },
      credentials: 'include',
      cache: 'no-store',
    });
    if (!response.ok) {
      console.error(
        `[Fasteignir Helper] search failed for ${c.id} after ${response.attempts} attempt(s):`,
        response.error || `HTTP ${response.status}`
      );
      return { outcome: 'error' };
    }
    const html = response.text;

    if (/Leitin skilaði engum niðurstöðum/i.test(html)) {
      console.log(`[Fasteignir Helper] no results for ${c.id}`);
      return { outcome: 'no-match' };
    }

    const doc = new DOMParser().parseFromString(html, 'text/html');
    const cardEls = Array.from(doc.querySelectorAll('.estate__item[data-id]'));

    if (cardEls.length === 0) {
      // A non-empty response without recognizable cards means the search
      // itself could not be trusted. Leave the saved property untouched.
      console.warn(`[Fasteignir Helper] got HTML for ${c.id} but found no card elements`);
      return { outcome: 'error' };
    }

    const candidates = cardEls.map(parseCard);
    console.log(`[Fasteignir Helper] ${candidates.length} card(s) returned:`, candidates.map(cd => `${cd.id} ${cd.street} ${cd.size}m² ${cd.rooms}r`));

    const exactMatches = exactReplacementMatches(c, candidates);

    if (exactMatches.length > 0) {
      console.log(`[Fasteignir Helper] exact match(es):`, exactMatches.map(cd => cd.id));
      const confirmedIds = new Set();
      let newPrice = null;
      let newIsTilbod = false;
      for (const match of exactMatches) {
        const saveResult = await saveSilently(match.id);
        if (saveResult === 'newly-saved' || saveResult === 'already-saved') {
          confirmedIds.add(match.id);
          if (newPrice == null) {
            newPrice = match.price;
            newIsTilbod = match.isTilbod;
          }
        }
      }
      if (confirmedIds.size > 0) {
        return { outcome: 'favorited', newPrice, newIsTilbod, savedCount: confirmedIds.size };
      }
      return { outcome: 'save-failed' };
    }

    const areaMismatches = candidates.filter((cd) =>
      isDifferentListingId(c, cd) && isAreaMismatchData(c, cd)
    );
    if (areaMismatches.length > 0) {
      console.log(`[Fasteignir Helper] area mismatch for ${c.id}:`, areaMismatches.map(cd => `${cd.id} size=${cd.size}`));
      return { outcome: 'area-mismatch' };
    }

    console.log(`[Fasteignir Helper] results found but none matched ${c.id}`);
    return { outcome: 'results-no-match' };
  }

  // ---------- Property matching helpers ----------

  // Same address and EXACTLY matching size/rooms/bathrooms/bedrooms where
  // both sides have a value. No tolerance on size - two real, different
  // nearby-sized units must never be treated as the same property just because
  // they're close.
  function isSameProperty(a, b) {
    if (!a.street || !b.street) return false;
    if (a.street.trim().toLowerCase() !== b.street.trim().toLowerCase()) return false;
    if (a.size != null && b.size != null && Math.abs(a.size - b.size) > 0.05) return false;
    if (a.rooms != null && b.rooms != null && a.rooms !== b.rooms) return false;
    if (a.baths != null && b.baths != null && a.baths !== b.baths) return false;
    if (a.beds != null && b.beds != null && a.beds !== b.beds) return false;
    return true;
  }

  // If a still-active saved property already matches this sold one, the
  // relisting is effectively already saved - no need to spend a search on it.
  function findActiveDuplicate(c) {
    return cards.find((other) => other.id !== c.id && other.status === 'active' && isSameProperty(other, c));
  }

  // Other saved entries for this same property that are themselves sold -
  // stale duplicates to clean up alongside c once we know an active entry exists.
  function findSoldDuplicates(c) {
    return cards.filter(
      (other) =>
        other.id !== c.id &&
        (other.status === 'gone' || other.status === 'sold-text' || other.status === 'sold-address') &&
        isSameProperty(other, c)
    );
  }

  const removalPromisesById = new Map();

  async function verifySavedPropertyAbsent(id) {
    const response = await requestTextWithRetries('/user/dashboard', {
      method: 'GET',
      credentials: 'include',
      headers: { Accept: 'text/html,application/xhtml+xml' },
      cache: 'no-store',
    });
    if (!response.ok) return null;
    try {
      const finalUrl = new URL(response.finalUrl, location.href);
      if (finalUrl.pathname !== '/user/dashboard') return null;
      const doc = new DOMParser().parseFromString(response.text, 'text/html');
      const savedCards = Array.from(doc.querySelectorAll('.estate__item[data-id]'));
      if (savedCards.length === 0) return null;
      return !savedCards.some((el) => String(el.dataset.id) === String(id));
    } catch (_) {
      return null;
    }
  }

  // Removes a saved property exactly once. The card is marked removed only
  // after the site's endpoint confirms success, or a fresh dashboard fetch
  // proves the ID is no longer saved after a lost response.
  async function removeSavedProperty(c) {
    if (c._removed) return true;
    const id = String(c.id);
    if (removalPromisesById.has(id)) return removalPromisesById.get(id);

    const removalPromise = (async () => {
      let confirmed = false;
      for (const retryDelayMs of LIVE_RETRY_DELAYS_MS) {
        if (retryDelayMs > 0) await wait(retryDelayMs);
        const response = await requestTextOnce(`/ajax/remove_property_favorite/${id}`, {
          method: 'GET',
          credentials: 'include',
          headers: { 'X-Requested-With': 'XMLHttpRequest' },
          cache: 'no-store',
        });
        const scalar = response.ok ? parseJsonScalar(response.text) : null;
        console.log(
          `[Fasteignir Helper] remove response for ${id} ` +
          `(HTTP ${response.status == null ? 'none' : response.status}):`,
          response.text.slice(0, 300) || response.error
        );
        if (scalar === 'success') {
          confirmed = true;
          break;
        }

        const absent = await verifySavedPropertyAbsent(id);
        if (absent === true) {
          confirmed = true;
          break;
        }
        if (!response.retryable) break;
      }

      if (!confirmed) {
        console.warn(`[Fasteignir Helper] removal was not confirmed for ${id}; leaving it in place`);
        return false;
      }
      c._removed = true;
      c.el.remove();
      return true;
    })();

    removalPromisesById.set(id, removalPromise);
    try {
      return await removalPromise;
    } finally {
      removalPromisesById.delete(id);
    }
  }

  // If a still-active duplicate is already saved, skip the search entirely.
  // Otherwise do a silent search.
  function resolveRelisting(c) {
    const dup = findActiveDuplicate(c);
    if (dup) {
      return Promise.resolve({ outcome: 'already-saved-locally', newPrice: dup.price, newIsTilbod: dup.isTilbod });
    }
    return silentRelistSearch(c);
  }

  function shouldRemoveAfterRelisting(status, outcome) {
    if (
      outcome === 'favorited' ||
      outcome === 'already-saved-locally' ||
      outcome === 'no-match'
    ) {
      return true;
    }
    const confirmedSold = status === 'sold-text' || status === 'sold-address';
    return confirmedSold && (outcome === 'area-mismatch' || outcome === 'results-no-match');
  }

  // Resolves c's relisting outcome and, once it is safe, removes c and any
  // other stale sold duplicates of the same property. Confirmed-missing
  // listings retain the existing manual-review protection. A listing whose
  // own text/card says sold can be removed after a successful search even
  // when that search finds no exact different-ID replacement.
  async function processSoldProperty(c, resolveFn) {
    if (c._removed) return { outcome: 'already-removed', removedCount: 0, removalFailed: false };
    let result;
    try {
      result = await (resolveFn ? resolveFn(c) : resolveRelisting(c));
    } catch (err) {
      console.error('[Fasteignir Helper] error resolving relisting for', c.id, err);
      return { outcome: 'error', removedCount: 0, removalFailed: false };
    }
    let removedCount = 0;
    let removalFailed = false;
    if (shouldRemoveAfterRelisting(c.status, result.outcome)) {
      const removalTargets = [c, ...findSoldDuplicates(c)];
      for (const target of removalTargets) {
        if (target._removed) continue;
        if (await removeSavedProperty(target)) {
          removedCount++;
        } else {
          removalFailed = true;
        }
      }
      if (removedCount > 0) saveStatusCache();
    }
    return { ...result, removedCount, removalFailed };
  }

  // ---------- Price-change reporting ----------

  function formatISKAmount(n) {
    return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  }

  function formatPriceDisplay(price, isTilbod) {
    if (isTilbod || price == null) return 'Tilboð';
    return `${formatISKAmount(price)} kr.`;
  }

  // Builds a "NOW PRICED AT X (was Y)" / "NOW LISTED AS TILBOÐ (was Y)" line,
  // or null if the price (or Tilboð status) is unchanged.
  function priceChangeLine(oldPrice, oldIsTilbod, newPrice, newIsTilbod) {
    const oldDisplay = formatPriceDisplay(oldPrice, oldIsTilbod);
    const newDisplay = formatPriceDisplay(newPrice, newIsTilbod);
    if (oldDisplay === newDisplay) return null;
    if (newIsTilbod) {
      return `NOW LISTED AS TILBOÐ (was ${oldDisplay})`;
    }
    return `NOW PRICED AT ${newDisplay} (was ${oldDisplay})`;
  }

  // ---------- Status badge rendering ----------

  function setBadge(c, label, cls) {
    let badge = c.el.querySelector('.fdh-badge');
    if (!badge) {
      badge = document.createElement('div');
      badge.className = 'fdh-badge';
      const content = c.el.querySelector('.estate__item-content') || c.el;
      content.insertBefore(badge, content.firstChild);
    }
    badge.className = `fdh-badge ${cls}`;
    badge.textContent = label;
  }

  // A per-property button shown on flagged (no-longer-valid) cards. Clicking
  // it searches silently for a relisting and reports the outcome.
  function addRemoveSearchButton(c) {
    if (c.el.querySelector('.fdh-remove-search-btn')) return;
    const btn = document.createElement('button');
    btn.className = 'fdh-remove-search-btn';
    btn.textContent = 'Remove & Search';
    const badge = c.el.querySelector('.fdh-badge');
    if (badge) {
      badge.insertAdjacentElement('afterend', btn);
    } else {
      const content = c.el.querySelector('.estate__item-content') || c.el;
      content.insertBefore(btn, content.firstChild);
    }
    btn.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      btn.disabled = true;
      btn.textContent = 'Searching...';
      const result = await processSoldProperty(c);
      if (c._removed) {
        btn.textContent = 'Removed';
      } else {
        btn.disabled = false;
        btn.textContent = 'Remove & Search';
      }
      if (result.outcome === 'favorited') {
        const count = result.savedCount || 1;
        let msg = `${c.street}: ${count > 1 ? count + ' relistings were saved to your properties.' : 'A relisting was saved to your properties.'}`;
        const priceLine = priceChangeLine(c.price, c.isTilbod, result.newPrice, !!result.newIsTilbod);
        if (priceLine) msg += '\n' + priceLine;
        if (result.removalFailed) msg += '\nThe old saved listing could not be confirmed as removed and was left in place.';
        alert(msg);
        // A reload is needed — the new relisting was favorited via fetch, so
        // this page's DOM has no way to know about it otherwise.
        reloadUsingCache();
      } else if (result.outcome === 'already-saved-locally') {
        let msg = `${c.street}: An active listing for this property was already in your saved properties.`;
        const priceLine = priceChangeLine(c.price, c.isTilbod, result.newPrice, !!result.newIsTilbod);
        if (priceLine) msg += '\n' + priceLine;
        if (result.removalFailed) msg += '\nThe old saved listing could not be confirmed as removed and was left in place.';
        alert(msg);
        applyFilter();
        renderOpenHouses();
      } else if (result.outcome === 'no-match') {
        alert(
          `${c.street}: No new listing was found.` +
          (result.removalFailed
            ? '\nThe old saved listing could not be confirmed as removed and was left in place.'
            : '')
        );
        applyFilter();
        renderOpenHouses();
      } else if (result.outcome === 'area-mismatch') {
        window.open(buildManualReviewUrl(c));
        alert(`${c.street}: No exact match found.\nNOTE: A listing at that address with a different floor area was found — a search tab has been opened for manual review.`);
      } else if (result.outcome === 'results-no-match') {
        window.open(buildManualReviewUrl(c));
        alert(`${c.street}: Listings were found for that address but none matched this property's details — a search tab has been opened for manual review.`);
      } else if (result.outcome === 'save-failed') {
        alert(`${c.street}: A matching relisting was found but could not be saved automatically. Please check manually.`);
      } else if (result.outcome === 'error') {
        alert(`${c.street}: Something went wrong while checking this property. It was not removed — you can try again.`);
      } else {
        alert(`${c.street}: Could not confirm the outcome, so the property was not removed. You can try again.`);
      }
    });
  }

  function flagForRemoval(c) {
    addRemoveSearchButton(c);
  }

  // Single place that applies a resolved status to a card - badges it and
  // flags it for removal if needed. Used both by a live check (checkOne)
  // and by restoring a cached status without re-checking.
  function applyStatus(c, status) {
    c.status = status;
    if (status === 'active') {
      setBadge(c, 'Active', 'fdh-badge-active');
    } else if (status === 'gone') {
      setBadge(c, '404', 'fdh-badge-gone');
      flagForRemoval(c);
    } else if (status === 'sold-text') {
      setBadge(c, 'Sold (text)', 'fdh-badge-sold-text');
      flagForRemoval(c);
    } else if (status === 'sold-address') {
      setBadge(c, 'Address says sold', 'fdh-badge-sold-address');
      flagForRemoval(c);
    } else if (status === 'unknown') {
      const badge = c.el.querySelector('.fdh-badge');
      if (badge) badge.remove();
      const removeButton = c.el.querySelector('.fdh-remove-search-btn');
      if (removeButton) removeButton.remove();
    }
  }

  cards.forEach((c) => {
    if (c.addressSaysSold) {
      applyStatus(c, 'sold-address');
    }
  });

  // ---------- "seld" text detection in fetched listing page ----------

  function checkSoldInText(html) {
    try {
      const doc = new DOMParser().parseFromString(html, 'text/html');
      doc.querySelectorAll('script, style, nav, header, footer').forEach((n) => n.remove());
      const text = (doc.body ? doc.body.innerText : '').replace(/\s+/g, ' ').trim();
      // Only look near the top of the page content, where the agent usually
      // adds a "seld með fyrirvara" type note.
      const window_ = text.slice(0, 3000);
      return SOLD_WORD_RE.test(window_);
    } catch (e) {
      return false;
    }
  }

  // ---------- Read-only status-check diagnostic ----------

  const STATUS_CHECK_CONCURRENCY = 16;
  const RELIST_TEST_CONCURRENCY = 4;
  const STATUS_TEST_TIMEOUT_MS = 15000;
  const STATUS_TEST_RETRY_DELAYS_MS = [0, 500, 1500];
  const STATUS_TEST_RETRYABLE_HTTP = new Set([408, 425, 429, 500, 502, 503, 504]);

  function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function requestStatusDiagnostic(c) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), STATUS_TEST_TIMEOUT_MS);
    const startedAt = performance.now();
    try {
      const response = await fetch(c.url, {
        method: 'GET',
        credentials: 'include',
        headers: { Accept: 'text/html,application/xhtml+xml' },
        redirect: 'manual',
        cache: 'no-store',
        signal: controller.signal,
      });
      const durationMs = Math.round(performance.now() - startedAt);
      const finalUrl = response.url || c.url;

      if (
        response.type === 'opaqueredirect' ||
        (response.status >= 300 && response.status < 400)
      ) {
        return {
          classification: 'redirect',
          status: response.status,
          responseType: response.type,
          finalUrl,
          durationMs,
          retryable: false,
          error: null,
        };
      }

      const html = await response.text();
      if (response.status === 404 || finalUrl.includes('/404.html')) {
        return {
          classification: 'http-404',
          status: response.status,
          responseType: response.type,
          finalUrl,
          durationMs,
          retryable: false,
          error: null,
        };
      }
      if (html.includes('Umbeðin síða fannst ekki')) {
        return {
          classification: 'not-found-page',
          status: response.status,
          responseType: response.type,
          finalUrl,
          durationMs,
          retryable: false,
          error: null,
        };
      }
      if (!response.ok) {
        return {
          classification: 'http-error',
          status: response.status,
          responseType: response.type,
          finalUrl,
          durationMs,
          retryable: STATUS_TEST_RETRYABLE_HTTP.has(response.status),
          error: `HTTP ${response.status}`,
        };
      }
      if (checkSoldInText(html)) {
        return {
          classification: 'sold-text',
          status: response.status,
          responseType: response.type,
          finalUrl,
          durationMs,
          retryable: false,
          error: null,
        };
      }
      return {
        classification: 'active',
        status: response.status,
        responseType: response.type,
        finalUrl,
        durationMs,
        retryable: false,
        error: null,
      };
    } catch (error) {
      return {
        classification: 'transport-error',
        status: null,
        responseType: null,
        finalUrl: c.url,
        durationMs: Math.round(performance.now() - startedAt),
        retryable: true,
        error: error && error.name === 'AbortError'
          ? `Timed out after ${STATUS_TEST_TIMEOUT_MS} ms`
          : String(error && error.message ? error.message : error),
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  function isConfirmedNotFoundUrl(value) {
    try {
      const url = new URL(value);
      return url.hostname === 'fasteignir.visir.is' && url.pathname === '/404.html';
    } catch (_) {
      return false;
    }
  }

  function requestRedirectDiagnostic(c) {
    return new Promise((resolve) => {
      const startedAt = performance.now();
      let settled = false;

      function finish(result) {
        if (settled) return;
        settled = true;
        resolve({
          ...result,
          durationMs: Math.round(performance.now() - startedAt),
        });
      }

      try {
        GM_xmlhttpRequest({
          method: 'GET',
          url: c.url,
          headers: { Accept: 'text/html,application/xhtml+xml' },
          redirect: 'follow',
          nocache: true,
          timeout: STATUS_TEST_TIMEOUT_MS,
          onload: (response) => {
            const finalUrl = response.finalUrl || c.url;
            const html = response.responseText || '';
            const confirmedMissing =
              response.status === 404 ||
              isConfirmedNotFoundUrl(finalUrl) ||
              html.includes('Umbeðin síða fannst ekki');

            if (confirmedMissing) {
              finish({
                classification: 'confirmed-missing',
                status: response.status,
                statusText: response.statusText || '',
                finalUrl,
                retryable: false,
                error: null,
              });
              return;
            }

            const retryable =
              response.status === 0 || STATUS_TEST_RETRYABLE_HTTP.has(response.status);
            finish({
              classification:
                response.status >= 200 && response.status < 300
                  ? 'resolved-nonmissing'
                  : 'redirect-http-error',
              status: response.status,
              statusText: response.statusText || '',
              finalUrl,
              retryable,
              error: response.status >= 200 && response.status < 300
                ? null
                : `HTTP ${response.status}`,
            });
          },
          onerror: (response) => finish({
            classification: 'redirect-transport-error',
            status: response && Number.isFinite(response.status) ? response.status : null,
            statusText: response && response.statusText ? response.statusText : '',
            finalUrl: response && response.finalUrl ? response.finalUrl : c.url,
            retryable: true,
            error: 'Tampermonkey request failed',
          }),
          ontimeout: () => finish({
            classification: 'redirect-transport-error',
            status: null,
            statusText: '',
            finalUrl: c.url,
            retryable: true,
            error: `Timed out after ${STATUS_TEST_TIMEOUT_MS} ms`,
          }),
          onabort: () => finish({
            classification: 'redirect-transport-error',
            status: null,
            statusText: '',
            finalUrl: c.url,
            retryable: true,
            error: 'Tampermonkey request was aborted',
          }),
        });
      } catch (error) {
        finish({
          classification: 'redirect-transport-error',
          status: null,
          statusText: '',
          finalUrl: c.url,
          retryable: true,
          error: String(error && error.message ? error.message : error),
        });
      }
    });
  }

  async function resolveRedirectStatus(c) {
    let result = null;
    let attempts = 0;
    for (const retryDelayMs of STATUS_TEST_RETRY_DELAYS_MS) {
      if (retryDelayMs > 0) await wait(retryDelayMs);
      attempts++;
      result = await requestRedirectDiagnostic(c);
      if (!result.retryable) break;
    }
    return {
      classification: result.classification,
      httpStatus: result.status,
      statusText: result.statusText,
      finalUrl: result.finalUrl,
      attempts,
      durationMs: result.durationMs,
      error: result.error,
    };
  }

  function statusFingerprint(c) {
    return {
      address: c.street,
      postcode: c.postal,
      propertyId: String(c.id),
      size: c.size,
      rooms: c.rooms,
      baths: c.baths,
      beds: c.beds,
      price: c.price,
      isTilbod: c.isTilbod,
      url: c.url,
      addressSaysSold: c.addressSaysSold,
    };
  }

  function finalStatusClassification(c, initial, redirectResolution) {
    if (c.addressSaysSold) return 'confirmed-sold-address';
    if (initial.classification === 'sold-text') return 'confirmed-sold-text';
    if (
      initial.classification === 'http-404' ||
      initial.classification === 'not-found-page'
    ) {
      return 'confirmed-missing';
    }
    if (initial.classification === 'redirect') {
      return redirectResolution && redirectResolution.classification === 'confirmed-missing'
        ? 'confirmed-missing'
        : 'unknown';
    }
    if (initial.classification === 'active') return 'active';
    return 'unknown';
  }

  async function testOneStatus(c) {
    const startedAt = performance.now();
    let result = null;
    let attempts = 0;

    for (const retryDelayMs of STATUS_TEST_RETRY_DELAYS_MS) {
      if (retryDelayMs > 0) await wait(retryDelayMs);
      attempts++;
      result = await requestStatusDiagnostic(c);
      if (!result.retryable) break;
    }

    const redirectResolution = result.classification === 'redirect'
      ? await resolveRedirectStatus(c)
      : null;
    const finalClassification = finalStatusClassification(c, result, redirectResolution);

    return {
      ...statusFingerprint(c),
      initialClassification: result.classification,
      httpStatus: result.status,
      responseType: result.responseType,
      finalUrl: result.finalUrl,
      attempts,
      redirectResolution,
      finalClassification,
      wouldBeRemovalCandidate:
        finalClassification === 'confirmed-missing' ||
        finalClassification === 'confirmed-sold-text' ||
        finalClassification === 'confirmed-sold-address',
      durationMs: Math.round(performance.now() - startedAt),
      error: result.error,
      relistingDryRun: null,
    };
  }

  function cardMatchEvidence(c) {
    return {
      propertyId: String(c.id),
      address: c.street,
      postcode: c.postal,
      size: c.size,
      rooms: c.rooms,
      baths: c.baths,
      beds: c.beds,
      price: c.price,
      isTilbod: c.isTilbod,
      url: c.url,
    };
  }

  function buildRelistingSearchUrl(c) {
    const params = new URLSearchParams({ stype: 'sale' });
    if (c.street) params.set('keyword', searchKeyword(c.street));
    if (c.size != null) {
      const areaMin = Math.max(0, Math.floor(c.size) - AREA_SEARCH_TOLERANCE);
      const areaMax = Math.ceil(c.size) + AREA_SEARCH_TOLERANCE;
      params.set('area', `${areaMin},${areaMax}`);
    }
    return `/ajaxsearch/getresults?${params.toString()}`;
  }

  async function requestRelistingDryRun(c) {
    const searchUrl = buildRelistingSearchUrl(c);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), STATUS_TEST_TIMEOUT_MS);
    const startedAt = performance.now();

    try {
      const response = await fetch(searchUrl, {
        method: 'GET',
        headers: {
          Accept: 'text/html, */*; q=0.01',
          'X-Requested-With': 'XMLHttpRequest',
        },
        credentials: 'include',
        cache: 'no-store',
        signal: controller.signal,
      });
      const html = await response.text();
      const durationMs = Math.round(performance.now() - startedAt);
      if (!response.ok) {
        return {
          outcome: 'search-error',
          searchUrl,
          manualReviewUrl: buildManualReviewUrl(c),
          httpStatus: response.status,
          durationMs,
          error: `HTTP ${response.status}`,
          candidates: [],
        };
      }
      if (/Leitin skilaði engum niðurstöðum/i.test(html)) {
        return {
          outcome: 'no-match',
          searchUrl,
          manualReviewUrl: buildManualReviewUrl(c),
          httpStatus: response.status,
          durationMs,
          error: null,
          candidates: [],
        };
      }

      const doc = new DOMParser().parseFromString(html, 'text/html');
      const candidates = Array.from(doc.querySelectorAll('.estate__item[data-id]')).map(parseCard);
      const candidateEvidence = candidates.map(cardMatchEvidence);
      if (candidates.length === 0) {
        return {
          outcome: 'manual-review',
          searchUrl,
          manualReviewUrl: buildManualReviewUrl(c),
          httpStatus: response.status,
          durationMs,
          error: 'Search returned HTML but no property cards were recognized',
          candidates: [],
        };
      }

      const allExactMatches = candidates.filter((candidate) => isRealMatchData(c, candidate));
      const sameListingMatches = allExactMatches.filter(
        (candidate) => String(candidate.id) === String(c.id)
      );
      const exactMatches = allExactMatches.filter(
        (candidate) => String(candidate.id) !== String(c.id)
      );
      const areaMismatches = candidates.filter((candidate) => isAreaMismatchData(c, candidate));
      if (exactMatches.length === 1) {
        return {
          outcome: 'likely-relisting',
          searchUrl,
          manualReviewUrl: buildManualReviewUrl(c),
          httpStatus: response.status,
          durationMs,
          error: null,
          matches: exactMatches.map(cardMatchEvidence),
          sameListingMatches: sameListingMatches.map(cardMatchEvidence),
          candidates: candidateEvidence,
        };
      }
      if (exactMatches.length > 1) {
        return {
          outcome: 'ambiguous-likely-relisting',
          searchUrl,
          manualReviewUrl: buildManualReviewUrl(c),
          httpStatus: response.status,
          durationMs,
          error: null,
          matches: exactMatches.map(cardMatchEvidence),
          sameListingMatches: sameListingMatches.map(cardMatchEvidence),
          candidates: candidateEvidence,
        };
      }
      if (areaMismatches.length > 0) {
        return {
          outcome: 'partial-match-area-change',
          searchUrl,
          manualReviewUrl: buildManualReviewUrl(c),
          httpStatus: response.status,
          durationMs,
          error: null,
          matches: areaMismatches.map(cardMatchEvidence),
          sameListingMatches: sameListingMatches.map(cardMatchEvidence),
          candidates: candidateEvidence,
        };
      }
      if (sameListingMatches.length > 0) {
        return {
          outcome: 'same-listing-still-searchable',
          searchUrl,
          manualReviewUrl: buildManualReviewUrl(c),
          httpStatus: response.status,
          durationMs,
          error: null,
          matches: sameListingMatches.map(cardMatchEvidence),
          sameListingMatches: sameListingMatches.map(cardMatchEvidence),
          candidates: candidateEvidence,
        };
      }
      return {
        outcome: 'manual-review',
        searchUrl,
        manualReviewUrl: buildManualReviewUrl(c),
        httpStatus: response.status,
        durationMs,
        error: null,
        candidates: candidateEvidence,
      };
    } catch (error) {
      return {
        outcome: 'search-error',
        searchUrl,
        manualReviewUrl: buildManualReviewUrl(c),
        httpStatus: null,
        durationMs: Math.round(performance.now() - startedAt),
        error: error && error.name === 'AbortError'
          ? `Timed out after ${STATUS_TEST_TIMEOUT_MS} ms`
          : String(error && error.message ? error.message : error),
        candidates: [],
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  async function analyzeRelistingDryRun(c, statusById) {
    const activeSavedAtAddress = cards.filter((other) =>
      other.id !== c.id &&
      statusById.get(String(other.id)) === 'active' &&
      other.street &&
      c.street &&
      other.street.trim().toLowerCase() === c.street.trim().toLowerCase()
    );
    const activeSavedMatches = activeSavedAtAddress.filter((other) => isSameProperty(other, c));

    if (activeSavedMatches.length === 1) {
      return {
        outcome: 'active-saved-match',
        matches: activeSavedMatches.map(cardMatchEvidence),
        sameAddressActiveCandidates: activeSavedAtAddress.map(cardMatchEvidence),
        manualReviewUrl: buildManualReviewUrl(c),
      };
    }
    if (activeSavedMatches.length > 1) {
      return {
        outcome: 'ambiguous-active-saved-match',
        matches: activeSavedMatches.map(cardMatchEvidence),
        sameAddressActiveCandidates: activeSavedAtAddress.map(cardMatchEvidence),
        manualReviewUrl: buildManualReviewUrl(c),
      };
    }

    const searchResult = await requestRelistingDryRun(c);
    return {
      ...searchResult,
      sameAddressActiveCandidates: activeSavedAtAddress.map(cardMatchEvidence),
    };
  }

  function countBy(rows, keyFn) {
    const counts = {};
    for (const row of rows) {
      const key = keyFn(row);
      counts[key] = (counts[key] || 0) + 1;
    }
    return counts;
  }

  function buildStatusDiagnosticReport(results, durationMs, statusDurationMs, relistingDurationMs) {
    const initialClassifications = countBy(results, (result) => result.initialClassification);
    const finalClassifications = countBy(results, (result) => result.finalClassification);
    const relistingRows = results.filter((result) => result.relistingDryRun);
    const relistingOutcomes = countBy(relistingRows, (result) => result.relistingDryRun.outcome);
    const retriedProperties = results.filter((result) =>
      result.attempts > 1 ||
      (result.redirectResolution && result.redirectResolution.attempts > 1)
    ).length;
    const unresolved = results.filter((result) =>
      result.finalClassification === 'unknown'
    ).length;
    const confirmedRemovalCandidates = results.filter((result) => result.wouldBeRemovalCandidate);

    return {
      reportVersion: 2,
      scriptVersion: '3.23',
      generatedAt: new Date().toISOString(),
      mode: 'report-only',
      propertiesChanged: 0,
      externalWrites: {
        favoritesSaved: 0,
        propertiesRemoved: 0,
        cacheWrites: 0,
        gistWrites: 0,
      },
      settings: {
        statusConcurrency: STATUS_CHECK_CONCURRENCY,
        relistingConcurrency: RELIST_TEST_CONCURRENCY,
        timeoutMs: STATUS_TEST_TIMEOUT_MS,
        maximumAttempts: STATUS_TEST_RETRY_DELAYS_MS.length,
        initialRedirectHandling: 'manual',
        opaqueRedirectResolution: 'GM_xmlhttpRequest follow',
      },
      summary: {
        total: results.length,
        durationMs,
        statusDurationMs,
        relistingDurationMs,
        initialClassifications,
        finalClassifications,
        confirmedRemovalCandidates: confirmedRemovalCandidates.length,
        relistingOutcomes,
        retriedProperties,
        unresolved,
      },
      confirmedRemovalCandidates,
      unknown: results.filter((result) => result.finalClassification === 'unknown'),
      attention: results.filter((result) => result.finalClassification !== 'active'),
      results,
    };
  }

  async function runStatusDiagnostic() {
    const button = document.getElementById('fdh-test-status');
    const reportWrap = document.getElementById('fdh-status-report');
    const output = document.getElementById('fdh-status-report-output');
    button.disabled = true;
    reportWrap.classList.remove('fdh-visible');
    output.value = '';

    const results = new Array(cards.length);
    const startedAt = performance.now();
    let nextIndex = 0;
    let completed = 0;

    async function worker() {
      while (nextIndex < cards.length) {
        const index = nextIndex++;
        results[index] = await testOneStatus(cards[index]);
        completed++;
        statusLine(`Testing status: ${completed}/${cards.length}`);
      }
    }

    try {
      const workerCount = Math.min(STATUS_CHECK_CONCURRENCY, cards.length) || 1;
      await Promise.all(Array.from({ length: workerCount }, () => worker()));
      const statusDurationMs = Math.round(performance.now() - startedAt);
      const statusById = new Map(
        results.map((result) => [result.propertyId, result.finalClassification])
      );
      const cardsById = new Map(cards.map((card) => [String(card.id), card]));
      const removalCandidates = results.filter((result) => result.wouldBeRemovalCandidate);
      const relistingStartedAt = performance.now();
      let nextRelistingIndex = 0;
      let relistingCompleted = 0;

      async function relistingWorker() {
        while (nextRelistingIndex < removalCandidates.length) {
          const result = removalCandidates[nextRelistingIndex++];
          const card = cardsById.get(result.propertyId);
          if (!card) {
            result.relistingDryRun = {
              outcome: 'manual-review',
              error: `No dashboard card found for property ID ${result.propertyId}`,
              matches: [],
            };
          } else {
            result.relistingDryRun = await analyzeRelistingDryRun(card, statusById);
          }
          relistingCompleted++;
          statusLine(`Testing relistings: ${relistingCompleted}/${removalCandidates.length}`);
        }
      }

      const relistingWorkerCount = Math.min(RELIST_TEST_CONCURRENCY, removalCandidates.length);
      if (relistingWorkerCount > 0) {
        await Promise.all(Array.from({ length: relistingWorkerCount }, () => relistingWorker()));
      }
      const relistingDurationMs = Math.round(performance.now() - relistingStartedAt);
      const durationMs = Math.round(performance.now() - startedAt);
      const report = buildStatusDiagnosticReport(
        results,
        durationMs,
        statusDurationMs,
        relistingDurationMs
      );
      output.value = JSON.stringify(report, null, 2);
      reportWrap.classList.add('fdh-visible');

      const counts = report.summary.finalClassifications;
      statusLine(
        `Test complete: ${report.summary.total} checked, ` +
        `${counts.active || 0} active, ${counts['confirmed-missing'] || 0} confirmed missing, ` +
        `${(counts['confirmed-sold-text'] || 0) + (counts['confirmed-sold-address'] || 0)} sold, ` +
        `${report.summary.unresolved} unknown. ` +
        'No properties changed.'
      );
    } finally {
      button.disabled = false;
    }
  }

  async function checkOne(c) {
    if (c.status === 'sold-address') return; // already known, skip fetch
    setBadge(c, 'Checking...', 'fdh-badge-checking');
    try {
      const result = await testOneStatus(c);
      if (result.finalClassification === 'confirmed-missing') {
        applyStatus(c, 'gone');
      } else if (result.finalClassification === 'confirmed-sold-text') {
        applyStatus(c, 'sold-text');
      } else if (result.finalClassification === 'confirmed-sold-address') {
        applyStatus(c, 'sold-address');
      } else if (result.finalClassification === 'active') {
        applyStatus(c, 'active');
      } else {
        applyStatus(c, 'unknown');
      }
    } catch (error) {
      console.warn('[Fasteignir Helper] status check was inconclusive for', c.url, error);
      applyStatus(c, 'unknown');
    }
  }

  async function checkAll() {
    const toCheck = cards.filter((c) => c.status !== 'sold-address');
    const batchSize = STATUS_CHECK_CONCURRENCY;
    setFilterControlsDisabled(true);
    try {
      statusLine('Checking...');
      let done = 0;
      for (let i = 0; i < toCheck.length; i += batchSize) {
        const batch = toCheck.slice(i, i + batchSize);
        await Promise.all(batch.map((c) => checkOne(c)));
        done += batch.length;
        statusLine(`Checking: ${done} of ${toCheck.length}...`);
        await new Promise((r) => setTimeout(r, 20));
      }
      applyFilter();
      saveStatusCache();
    } finally {
      setFilterControlsDisabled(false);
    }
    document.getElementById('fdh-remove').disabled = false;
  }

  // ---------- Status caching across our own soft refreshes ----------
  // Not persisted beyond the current browser session (sessionStorage clears
  // when the tab/browser closes). The cache is only ever consulted right
  // after our own code triggers a reload (via the one-time skip flag below)
  // - a genuine page load or a hard refresh by the user always does a full
  // check, ignoring whatever cache might still be sitting in sessionStorage
  // from earlier in the session. It also expires after a while on its own -
  // without that, a single wrong status (a transient hiccup, a since-fixed
  // detection bug, or a property whose real status has simply changed since)
  // would otherwise get copied forward forever across repeated soft-refreshes
  // with nothing ever re-validating it.
  // Version the cache key so no status produced by the retired unsafe fetch
  // path can be restored into the validated classifier.
  const CACHE_KEY = 'fdh_statusCache_v321';
  const SKIP_FLAG_KEY = 'fdh_skipFullCheck';
  const CACHE_MAX_AGE_MS = 20 * 60 * 1000; // 20 minutes

  function saveStatusCache() {
    try {
      const map = {};
      cards.forEach((c) => {
        map[c.id] = c.status;
      });
      sessionStorage.setItem(CACHE_KEY, JSON.stringify({ savedAt: Date.now(), statuses: map }));
    } catch (e) {
      console.warn('[Fasteignir Helper] could not save status cache:', e);
    }
  }

  function loadStatusCache() {
    try {
      const raw = sessionStorage.getItem(CACHE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || !parsed.savedAt || Date.now() - parsed.savedAt > CACHE_MAX_AGE_MS) {
        return null; // too old to trust - the caller will do a full check instead
      }
      return parsed.statuses || null;
    } catch (e) {
      return null;
    }
  }

  // Call this right before any reload our own code triggers, so the next
  // load knows to restore from cache instead of doing a full check.
  function reloadUsingCache() {
    try {
      sessionStorage.setItem(SKIP_FLAG_KEY, '1');
    } catch (e) {
      // If this fails, the next load will just do a full check - safe either way.
    }
    location.reload();
  }

  // On load after a reload-from-save, print any persisted save diagnostics to console.
  try {
    const diag = sessionStorage.getItem('fdh_saveDiag');
    if (diag) {
      sessionStorage.removeItem('fdh_saveDiag');
      console.log('[Fasteignir Helper] Save diagnostics from before reload:', JSON.parse(diag));
    }
  } catch (_) {}

  async function runInitialCheck() {
    let skip = false;
    try {
      skip = sessionStorage.getItem(SKIP_FLAG_KEY) === '1';
      sessionStorage.removeItem(SKIP_FLAG_KEY); // one-time use only
    } catch (e) {
      skip = false;
    }

    if (skip) {
      const cache = loadStatusCache();
      if (cache) {
        setFilterControlsDisabled(true);
        const uncached = [];
        try {
          cards.forEach((c) => {
            if (c.status === 'sold-address') return; // already known
            if (cache[c.id] != null) {
              applyStatus(c, cache[c.id]);
            } else {
              uncached.push(c); // new since the last full check - check it for real
            }
          });
          if (uncached.length > 0) {
            for (let i = 0; i < uncached.length; i += STATUS_CHECK_CONCURRENCY) {
              const batch = uncached.slice(i, i + STATUS_CHECK_CONCURRENCY);
              await Promise.all(batch.map((c) => checkOne(c)));
            }
          }
          applyFilter('(using cached results)');
          saveStatusCache();
        } finally {
          setFilterControlsDisabled(false);
        }
        document.getElementById('fdh-remove').disabled = false;
        return;
      }
    }
    // No usable cache, or this is a genuine page load/hard refresh - do a full check.
    await checkAll();
  }

  runInitialCheck();

  // ---------- Remove Sold ----------

  async function removeSold() {
    const toRemove = cards.filter(
      (c) =>
        !c._removed &&
        (c.status === 'gone' || c.status === 'sold-text' || c.status === 'sold-address')
    );
    if (toRemove.length === 0) {
      originalAlert('No sold properties to remove.');
      return;
    }
    if (
      !confirm(
        `Remove ${toRemove.length} sold propert${toRemove.length === 1 ? 'y' : 'ies'} from your saved list and search for relistings? This cannot be undone.`
      )
    ) {
      return;
    }

    // Deduplicate exact property fingerprints so stale copies of the same
    // property share one complete search/save/remove pipeline.
    function propertyKey(c) {
      return `${(c.street || '').trim().toLowerCase()}|${c.size}|${c.rooms}|${c.baths}|${c.beds}`;
    }
    const workByProperty = new Map();
    for (const card of toRemove) {
      const key = propertyKey(card);
      if (!workByProperty.has(key)) workByProperty.set(key, card);
    }
    const workItems = Array.from(workByProperty.values());

    const priceChanges = [];
    const areaMismatchAddresses = [];
    const resultsNoMatchAddresses = [];
    let relistingsSaved = 0;
    let alreadySavedLive = 0;
    let unresolvedOperations = 0;

    function updateStatus(progress) {
      const removedCount = toRemove.filter((c) => c._removed).length;
      statusLine(
        `Removing sold: ${progress.completed}/${progress.total} checks complete. ` +
        `${progress.active} active. ${relistingsSaved} saved. ` +
        `${removedCount}/${toRemove.length} removed. ${unresolvedOperations} unresolved.`
      );
    }

    updateStatus({ completed: 0, active: 0, total: workItems.length });
    const outcomes = await runBoundedWorkers(
      workItems,
      LIVE_RELIST_CONCURRENCY,
      async (c) => {
        try {
          const result = await processSoldProperty(c);
          return { ...result, card: c };
        } catch (error) {
          console.error('[Fasteignir Helper] live removal pipeline failed for', c.id, error);
          return { outcome: 'error', card: c, removedCount: 0, removalFailed: false };
        }
      },
      (progress) => {
        if (progress.phase === 'completed') {
          const result = progress.result;
          const c = result.card;
          if (result.outcome === 'area-mismatch') {
            areaMismatchAddresses.push(c.street);
          } else if (result.outcome === 'results-no-match') {
            resultsNoMatchAddresses.push(c.street);
          }
          if (!c._removed) {
            if (result.outcome !== 'area-mismatch' && result.outcome !== 'results-no-match') {
              console.warn('[Fasteignir Helper] leaving', c.id, 'in place - outcome:', result.outcome);
            }
          } else if (result.outcome === 'favorited' || result.outcome === 'already-saved-locally') {
            const line = priceChangeLine(c.price, c.isTilbod, result.newPrice, !!result.newIsTilbod);
            if (line) priceChanges.push(`${c.street}: ${line}`);
            if (result.outcome === 'favorited') relistingsSaved += result.savedCount || 1;
            if (result.outcome === 'already-saved-locally') alreadySavedLive++;
          }
          if (!c._removed && result.outcome !== 'already-removed') unresolvedOperations++;
        }
        updateStatus(progress);
      }
    );

    const favoritedCount = outcomes.reduce(
      (sum, o) => sum + (o.outcome === 'favorited' ? o.savedCount || 1 : 0),
      0
    );
    const alreadySavedCount = outcomes.filter((o) => o.outcome === 'already-saved-locally').length;
    // Counted from the cards themselves, not from outcomes.length - a card
    // removed as a side effect of cleaning up another property's sold
    // duplicate never gets its own entry in outcomes.
    const removedCount = toRemove.filter((c) => c._removed).length;
    const uncertainCount = toRemove.length - removedCount;

    let message = `Removed ${removedCount} sold propert${removedCount === 1 ? 'y' : 'ies'}. ${favoritedCount} relisting${favoritedCount === 1 ? '' : 's'} found and saved.`;
    if (alreadySavedCount > 0) {
      message += ` ${alreadySavedCount} already had an active listing saved.`;
    }
    if (uncertainCount > 0) {
      message += ` ${uncertainCount} could not be confirmed and ${uncertainCount === 1 ? 'was' : 'were'} left in your saved list. Please check manually.`;
    }
    if (priceChanges.length > 0) {
      message += `\nPrice changes:\n${priceChanges.join('\n')}`;
    }
    if (areaMismatchAddresses.length > 0) {
      message += `\nNOTE: different floor area found (manual review needed): ${areaMismatchAddresses.join(', ')}`;
    }
    if (resultsNoMatchAddresses.length > 0) {
      message += `\nNOTE: results found but no detail match (manual review needed): ${resultsNoMatchAddresses.join(', ')}`;
    }

    statusLine(
      `Remove Sold complete. ${removedCount} removed. ${favoritedCount} saved. ` +
      `${uncertainCount} unresolved.`
    );
    alert(message);

    if (favoritedCount > 0 || removedCount > 0) {
      // Direct save/removal calls do not update every part of the current DOM.
      // Reload with the bounded cache path so the dashboard reflects the server.
      reloadUsingCache();
    } else {
      applyFilter();
      renderOpenHouses();
    }
  }

  document.getElementById('fdh-remove').addEventListener('click', () => {
    document.getElementById('fdh-remove').disabled = true;
    removeSold().finally(() => {
      const btn = document.getElementById('fdh-remove');
      if (btn) btn.disabled = false;
    });
  });

  document.getElementById('fdh-test-status').addEventListener('click', () => {
    runStatusDiagnostic().catch((error) => {
      console.error('[Fasteignir Helper] status diagnostic failed:', error);
      statusLine('Status test could not complete. No properties changed.');
    });
  });

  document.getElementById('fdh-copy-status-report').addEventListener('click', async () => {
    const output = document.getElementById('fdh-status-report-output');
    if (!output.value) return;
    try {
      await navigator.clipboard.writeText(output.value);
      statusLine('Status test report copied. No properties changed.');
    } catch (_) {
      output.focus();
      output.select();
      document.execCommand('copy');
      statusLine('Status test report copied. No properties changed.');
    }
  });

  document.getElementById('fdh-clear-status-report').addEventListener('click', () => {
    document.getElementById('fdh-status-report-output').value = '';
    document.getElementById('fdh-status-report').classList.remove('fdh-visible');
    applyFilter();
  });

  applyFilter('Checking listing status...');
  renderDebug();
})();
