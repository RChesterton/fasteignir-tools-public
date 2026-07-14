// ==UserScript==
// @name         Icelandic Web Helper
// @namespace    fasteignir-tools
// @version      0.12
// @description  Translation nudges, description expansion, Fasteignaleitin/Fasteignir cross-links, and Fasteignir search-save repair
// @match        https://fasteignir.visir.is/*
// @match        https://fasteignir.is/*
// @match        https://fasteignaleitin.is/*
// @updateURL    https://raw.githubusercontent.com/RChesterton/fasteignir-tools-public/main/icelandic-web-helper.user.js
// @downloadURL  https://raw.githubusercontent.com/RChesterton/fasteignir-tools-public/main/icelandic-web-helper.user.js
// @grant        GM_xmlhttpRequest
// @connect      fasteignir.visir.is
// ==/UserScript==

(function () {
  'use strict';

  const host = location.hostname;
  const isFasteignirVisir = host === 'fasteignir.visir.is' || host === 'fasteignir.is';
  const isFasteignaleitin = host === 'fasteignaleitin.is';

  function gmRequest(opts) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        ...opts,
        onload: (res) => resolve(res),
        onerror: (err) => reject(err),
        ontimeout: () => reject(new Error('timeout')),
      });
    });
  }

  function normalizeWhitespace(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
  }

  function parseFloatSafe(text) {
    const m = String(text || '').replace(',', '.').match(/\d+(?:\.\d+)?/);
    return m ? parseFloat(m[0]) : null;
  }

  function parseIntSafe(text) {
    const m = String(text || '').match(/\d+/);
    return m ? parseInt(m[0], 10) : null;
  }

  function parsePrice(text) {
    const digits = String(text || '').replace(/[^\d]/g, '');
    return digits ? parseInt(digits, 10) : null;
  }

  // Make the page as translation-friendly as a userscript reasonably can.
  // This removes page-level blockers, but browser/extension translation
  // prompts are still controlled by the browser/extension itself.
  function makePageTranslatable() {
    if (document.documentElement.lang !== 'is') document.documentElement.lang = 'is';
    if (document.documentElement.getAttribute('translate') !== 'yes') {
      document.documentElement.setAttribute('translate', 'yes');
    }
    if (document.body && document.body.getAttribute('translate') !== 'yes') {
      document.body.setAttribute('translate', 'yes');
    }

    document.querySelectorAll('[translate]').forEach((el) => {
      if (String(el.getAttribute('translate')).toLowerCase() === 'no') {
        el.setAttribute('translate', 'yes');
      }
    });
    document.querySelectorAll('.notranslate,.no-translate').forEach((el) => {
      el.classList.remove('notranslate', 'no-translate');
    });
    document.querySelectorAll('meta[name="google"][content="notranslate" i]').forEach((el) => el.remove());

    let contentLanguage = document.querySelector('meta[http-equiv="Content-Language" i]');
    if (!contentLanguage) {
      contentLanguage = document.createElement('meta');
      contentLanguage.setAttribute('http-equiv', 'Content-Language');
      document.head.appendChild(contentLanguage);
    }
    if (contentLanguage.getAttribute('content') !== 'is') contentLanguage.setAttribute('content', 'is');
  }

  let translationCleanupTimer = null;
  function scheduleTranslationCleanup() {
    if (translationCleanupTimer) return;
    translationCleanupTimer = setTimeout(() => {
      translationCleanupTimer = null;
      makePageTranslatable();
    }, 500);
  }

  makePageTranslatable();
  if (document.body) {
    new MutationObserver(scheduleTranslationCleanup).observe(document.body, {
      childList: true,
      subtree: true,
    });
  }

  // ============================================================
  // Description expansion
  // ============================================================
  if (isFasteignirVisir && /\/property\//.test(location.pathname)) {
    function expandFasteignirVisirDescription() {
      document.querySelectorAll('button.description__bottom-btn').forEach((btn) => btn.click());
    }
    expandFasteignirVisirDescription();
    new MutationObserver(expandFasteignirVisirDescription).observe(document.body, {
      childList: true,
      subtree: true,
    });
  }

  function cleanStreetForQuery(streetPart) {
    const value = normalizeWhitespace(streetPart);
    let m = value.match(/^(.+?)\s+\(?(\d{1,4})\)?\s?([a-zA-Z])?(?![a-zA-Z])/);
    if (!m) m = value.match(/^(.+?)\s+\((\d{1,4})\)\s?([a-zA-Z])?(?![a-zA-Z])/);
    if (!m) return null;
    return `${normalizeWhitespace(m[1])} ${m[2]}${m[3] ? m[3].toLowerCase() : ''}`;
  }

  function parseNumberLetter(streetAndNumber) {
    const s = streetAndNumber || '';
    const rangeMatch = s.match(/(\d{1,4})-(\d{1,4})\s*$/);
    if (rangeMatch) return { numbers: [rangeMatch[1], rangeMatch[2]], letter: null };
    const m = s.match(/(\d{1,4})\s*([a-zA-Z])?\s*$/);
    if (!m) return { numbers: [], letter: null };
    return { numbers: [m[1]], letter: m[2] ? m[2].toLowerCase() : null };
  }

  function detailsMatch(expected, candidate) {
    if (expected.size != null) {
      if (candidate.size == null || Math.abs(candidate.size - expected.size) > 0.05) return false;
    }
    if (expected.rooms != null && candidate.rooms !== expected.rooms) return false;
    if (expected.baths != null && candidate.baths != null && candidate.baths !== expected.baths) return false;
    if (expected.beds != null && candidate.beds != null && candidate.beds !== expected.beds) return false;
    if (expected.price != null && candidate.price != null && candidate.price !== expected.price) return false;
    return true;
  }

  function sameAddress(expected, candidate) {
    if (!expected.streetAndNumber || !candidate.streetAndNumber) return false;
    if (expected.postcode && candidate.postcode && expected.postcode !== candidate.postcode) return false;
    const expectedParsed = parseNumberLetter(expected.streetAndNumber);
    const candidateParsed = parseNumberLetter(candidate.streetAndNumber);
    if (!candidateParsed.numbers.includes(expectedParsed.numbers[0])) return false;
    return (candidateParsed.letter || '') === (expectedParsed.letter || '');
  }

  function parseFasteignirCard(el) {
    const titleEl = el.querySelector('.estate__item-title');
    let street = '';
    let rest = '';
    if (titleEl) {
      const span = titleEl.querySelector('span');
      street = span ? normalizeWhitespace(span.textContent) : '';
      rest = Array.from(titleEl.childNodes)
        .filter((n) => n.nodeType === Node.TEXT_NODE || n.nodeName === 'BR')
        .map((n) => n.textContent || ' ')
        .join(' ')
        .trim();
    }
    const postalMatch = rest.match(/(\d{3})/);
    const priceEl = el.querySelector('.estate__price');
    return {
      id: el.dataset.id,
      url: `https://fasteignir.visir.is/property/${el.dataset.id}`,
      streetAndNumber: cleanStreetForQuery(street),
      postcode: postalMatch ? postalMatch[1] : null,
      size: parseFloatSafe(el.querySelector('.estate__parameters--1') && el.querySelector('.estate__parameters--1').textContent),
      rooms: parseIntSafe(el.querySelector('.estate__parameters--2') && el.querySelector('.estate__parameters--2').textContent),
      baths: parseIntSafe(el.querySelector('.estate__parameters--3') && el.querySelector('.estate__parameters--3').textContent),
      beds: parseIntSafe(el.querySelector('.estate__parameters--4') && el.querySelector('.estate__parameters--4').textContent),
      price: priceEl ? parsePrice(priceEl.textContent) : null,
    };
  }

  function extractMetaDescriptionStats() {
    const meta = document.querySelector('meta[name="description"]');
    const text = meta ? normalizeWhitespace(meta.getAttribute('content')) : '';
    const postcodeMatch = text.match(/\b(\d{3})\b/);
    const roomsMatch = text.match(/(\d+)\s*herbergi/i);
    const sizeMatch = text.match(/([\d,.]+)\s*m²/i);
    const priceMatch = text.match(/([\d.]+)\s*kr/i);
    return {
      postcode: postcodeMatch ? postcodeMatch[1] : null,
      rooms: roomsMatch ? parseInt(roomsMatch[1], 10) : null,
      size: sizeMatch ? parseFloat(sizeMatch[1].replace(',', '.')) : null,
      price: priceMatch ? parsePrice(priceMatch[1]) : null,
    };
  }

  // ============================================================
  // Fasteignir search page: repair "Vista leit" and hide saved results
  // ============================================================
  if (isFasteignirVisir && location.pathname.startsWith('/search/results')) {
    let savedSearchResultsPromise = null;
    let hideSavedTimer = null;
    let hideSavedRunId = 0;

    function searchSaveStatus(btn, text, isError) {
      if (!btn) return;
      let status = btn.nextElementSibling;
      if (!status || !status.classList || !status.classList.contains('iwh-save-search-status')) {
        status = null;
      }
      if (!status) {
        status = document.createElement('span');
        status.className = 'iwh-save-search-status';
        status.style.cssText = 'margin-left:8px;font-size:13px;color:#555;';
        btn.insertAdjacentElement('afterend', status);
      }
      status.style.color = isError ? '#b00020' : '#555';
      status.textContent = text;
    }

    async function waitForSearchId(btn) {
      for (let i = 0; i < 20; i++) {
        const rel = btn ? normalizeWhitespace(btn.getAttribute('rel')) : '';
        const hidden = document.getElementById('tracker-searchid');
        const hiddenValue = hidden ? normalizeWhitespace(hidden.value) : '';
        if (rel) return rel;
        if (hiddenValue) return hiddenValue;
        await new Promise((r) => setTimeout(r, 250));
      }
      return null;
    }

    async function saveCurrentSearch(btn) {
      const searchId = await waitForSearchId(btn);
      if (!searchId) {
        searchSaveStatus(btn, 'Could not find a search ID yet. Try again after results finish loading.', true);
        return;
      }
      searchSaveStatus(btn, 'Saving search...', false);
      try {
        const body = `id=${encodeURIComponent(searchId)}&stype=sale`;
        const res = await gmRequest({
          method: 'POST',
          url: 'https://fasteignir.visir.is/ajax/add_favourite_search',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
            Accept: 'application/json, text/javascript, */*; q=0.01',
            'X-Requested-With': 'XMLHttpRequest',
          },
          data: body,
          timeout: 15000,
        });
        const responseText = normalizeWhitespace(res.responseText || '');
        if (res.status < 200 || res.status >= 300) {
          searchSaveStatus(btn, `Save failed: HTTP ${res.status}`, true);
          return;
        }
        let json;
        try {
          json = JSON.parse(res.responseText || '{}');
        } catch (e) {
          const hint = responseText ? responseText.slice(0, 80) : 'empty response';
          searchSaveStatus(btn, `Save failed: non-JSON response (${hint})`, true);
          return;
        }
        if (json.message === 'success') searchSaveStatus(btn, 'Search saved.', false);
        else if (json.message === 'already_has') searchSaveStatus(btn, 'Search already saved.', false);
        else if (json.message === 'not_logged') searchSaveStatus(btn, 'Not logged in.', true);
        else searchSaveStatus(btn, `Unexpected response: ${json.message || res.status}`, true);
      } catch (e) {
        searchSaveStatus(btn, `Save failed: ${e.message}`, true);
      }
    }

    function handleSaveSearchClick(btn, event) {
      if (!btn) return;
      if (event) {
        event.preventDefault();
        event.stopPropagation();
        if (event.stopImmediatePropagation) event.stopImmediatePropagation();
      }
      saveCurrentSearch(btn);
    }

    function patchSaveSearchButton() {
      document.querySelectorAll('[id="add-search-favourites"]').forEach((btn) => {
        if (btn.dataset.iwhSaveSearchPatched === 'true') return;
        btn.dataset.iwhSaveSearchPatched = 'true';
        btn.addEventListener('click', (event) => handleSaveSearchClick(btn, event), true);
      });
    }

    function savedSearchHideStatus(text, isError) {
      let status = document.getElementById('iwh-saved-result-hide-status');
      if (!status) {
        const btn = document.querySelector('[id="add-search-favourites"]');
        if (!btn || !btn.parentElement) return;
        status = document.createElement('span');
        status.id = 'iwh-saved-result-hide-status';
        status.style.cssText = 'margin-left:8px;font-size:13px;color:#555;';
        btn.parentElement.appendChild(status);
      }
      status.style.color = isError ? '#b00020' : '#555';
      status.textContent = text;
    }

    async function fetchSavedSearchResults() {
      if (savedSearchResultsPromise) return savedSearchResultsPromise;
      savedSearchResultsPromise = fetch('/user/dashboard', { credentials: 'include' })
        .then(async (res) => {
          if (!res.ok) throw new Error(`dashboard HTTP ${res.status}`);
          const html = await res.text();
          const doc = new DOMParser().parseFromString(html, 'text/html');
          const savedCards = Array.from(doc.querySelectorAll('.estate__item[data-id]')).map(parseFasteignirCard);
          return {
            ids: new Set(savedCards.map((card) => String(card.id)).filter(Boolean)),
            cards: savedCards,
          };
        })
        .catch((e) => {
          savedSearchResultsPromise = null;
          throw e;
        });
      return savedSearchResultsPromise;
    }

    function searchResultMatchesSaved(candidate, saved) {
      if (candidate.id && saved.ids.has(String(candidate.id))) return true;
      return saved.cards.some((savedCard) => sameAddress(savedCard, candidate) && detailsMatch(savedCard, candidate));
    }

    async function hideSavedSearchResults(runId) {
      let saved;
      try {
        saved = await fetchSavedSearchResults();
      } catch (e) {
        console.warn('[Icelandic Web Helper] could not load saved properties for search-result hiding:', e);
        savedSearchHideStatus('Could not load saved properties.', true);
        return;
      }
      if (runId !== hideSavedRunId) return;

      let hiddenCount = 0;
      let checkedCount = 0;
      document.querySelectorAll('.estate__item[data-id]').forEach((el) => {
        const candidate = parseFasteignirCard(el);
        const shouldHide = searchResultMatchesSaved(candidate, saved);
        checkedCount++;
        if (shouldHide) {
          el.dataset.iwhHiddenSavedResult = 'true';
          el.style.display = 'none';
          hiddenCount++;
        } else if (el.dataset.iwhHiddenSavedResult === 'true') {
          delete el.dataset.iwhHiddenSavedResult;
          el.style.display = '';
        }
      });

      savedSearchHideStatus(
        hiddenCount > 0 ? `Hidden already saved: ${hiddenCount}/${checkedCount}` : '',
        false
      );
    }

    function scheduleHideSavedSearchResults() {
      clearTimeout(hideSavedTimer);
      hideSavedTimer = setTimeout(() => {
        hideSavedRunId++;
        hideSavedSearchResults(hideSavedRunId);
      }, 250);
    }

    document.addEventListener('click', (event) => {
      const btn = event.target && event.target.closest && event.target.closest('[id="add-search-favourites"]');
      if (btn) handleSaveSearchClick(btn, event);
    }, true);

    patchSaveSearchButton();
    new MutationObserver(patchSaveSearchButton).observe(document.body, {
      childList: true,
      subtree: true,
    });

    scheduleHideSavedSearchResults();
    new MutationObserver(scheduleHideSavedSearchResults).observe(document.body, {
      childList: true,
      subtree: true,
    });
  }

  // ============================================================
  // Fasteignaleitin -> Fasteignir cross-link, no tabs/iframes
  // ============================================================
  if (isFasteignaleitin) {
    const FF_LOGO_URL = 'https://fasteignir.visir.is/images/ff-icon.svg';

    function expandFasteignaleitinDescription() {
      document.querySelectorAll('div[style*="max-height"]:not([data-iwh-expanded])').forEach((wrapper) => {
        if (!wrapper.querySelector('.prose')) return;
        wrapper.setAttribute('data-iwh-expanded', 'true');
        const toggle = wrapper.nextElementSibling;
        if (toggle) toggle.click();
      });
    }

    function getFasteignaleitinPropertyData() {
      const h1 = document.querySelector('h1');
      if (!h1) return null;
      const streetAndNumber = cleanStreetForQuery(h1.textContent);
      if (!streetAndNumber) return null;

      const metaStats = extractMetaDescriptionStats();
      const breadcrumb = h1.nextElementSibling;
      const breadcrumbText = breadcrumb ? normalizeWhitespace(breadcrumb.textContent) : '';
      const postcodeMatch = breadcrumbText.match(/(\d{3})\s*$/);

      return {
        streetAndNumber,
        postcode: (postcodeMatch && postcodeMatch[1]) || metaStats.postcode,
        size: metaStats.size,
        rooms: metaStats.rooms,
        baths: null,
        beds: null,
        price: metaStats.price,
      };
    }

    function removeCrossLinkLogo() {
      const existing = document.getElementById('iwh-crosslink-logo');
      if (existing) existing.remove();
    }

    function showCrossLinkLogo(href) {
      removeCrossLinkLogo();
      const h1 = document.querySelector('h1');
      if (!h1) return;
      const link = document.createElement('a');
      link.id = 'iwh-crosslink-logo';
      link.href = href;
      link.target = '_blank';
      link.title = 'Also listed on fasteignir.visir.is';
      link.style.cssText = 'display:inline-block;margin-left:10px;vertical-align:middle;';
      const img = document.createElement('img');
      img.src = FF_LOGO_URL;
      img.alt = 'fasteignir.visir.is';
      img.style.cssText = 'height:20px;width:auto;';
      link.appendChild(img);
      h1.appendChild(link);
    }

    async function findFasteignirMatch(propertyData) {
      const params = new URLSearchParams();
      params.set('stype', 'sale');
      params.set('keyword', propertyData.streetAndNumber);
      if (propertyData.rooms != null) params.set('room', `${propertyData.rooms},${propertyData.rooms}`);
      const res = await gmRequest({
        method: 'GET',
        url: `https://fasteignir.visir.is/ajaxsearch/getresults?${params.toString()}`,
        headers: {
          Accept: 'text/html, */*; q=0.01',
          'X-Requested-With': 'XMLHttpRequest',
          Referer: 'https://fasteignir.visir.is/search/results/?stype=sale',
        },
        timeout: 15000,
      });
      if (res.status < 200 || res.status >= 300) return null;

      const doc = new DOMParser().parseFromString(res.responseText || '', 'text/html');
      const candidates = Array.from(doc.querySelectorAll('.estate__item[data-id]')).map(parseFasteignirCard);
      const addressMatches = candidates.filter((candidate) => sameAddress(propertyData, candidate));
      if (addressMatches.length === 1) return addressMatches[0].url;

      const detailMatches = addressMatches.filter((candidate) => detailsMatch(propertyData, candidate));
      if (detailMatches.length === 1) return detailMatches[0].url;

      // Multiple indistinguishable matches — happens when the same unit is relisted
      // under a new ID with identical details. Pick the newest (highest numeric ID)
      // as it's the currently active listing.
      if (detailMatches.length > 1) {
        const newest = detailMatches.reduce((a, b) => (Number(a.id) >= Number(b.id) ? a : b));
        console.warn('[Icelandic Web Helper] cross-link: multiple identical matches, picking newest', newest.id);
        return newest.url;
      }

      console.warn('[Icelandic Web Helper] cross-link did not resolve uniquely', {
        propertyData,
        addressMatches,
        detailMatches,
      });
      return null;
    }

    function tryStartCrossLink(state) {
      if (state.started) return;
      state.attempts++;

      const propertyData = getFasteignaleitinPropertyData();
      if (!propertyData) {
        if (state.attempts >= 20) {
          state.started = true;
          console.warn('[Icelandic Web Helper] cross-link: gave up waiting for property data');
        }
        return;
      }
      if (!propertyData.postcode) {
        state.started = true;
        console.warn('[Icelandic Web Helper] cross-link: found address but could not parse postcode', propertyData);
        return;
      }

      state.started = true;
      findFasteignirMatch(propertyData)
        .then((url) => {
          if (url) showCrossLinkLogo(url);
        })
        .catch((e) => console.warn('[Icelandic Web Helper] cross-link lookup failed:', e.message));
    }

    function initFasteignaleitinPropertyPage() {
      removeCrossLinkLogo();
      expandFasteignaleitinDescription();

      const state = { started: false, attempts: 0 };
      tryStartCrossLink(state);

      const observer = new MutationObserver(() => {
        expandFasteignaleitinDescription();
        tryStartCrossLink(state);
      });
      observer.observe(document.body, { childList: true, subtree: true });
      setTimeout(() => observer.disconnect(), 12000);
    }

    let lastPath = location.pathname;
    if (/\/property\//.test(lastPath)) initFasteignaleitinPropertyPage();

    setInterval(() => {
      if (location.pathname !== lastPath) {
        lastPath = location.pathname;
        if (/\/property\//.test(lastPath)) {
          initFasteignaleitinPropertyPage();
        } else {
          removeCrossLinkLogo();
        }
      }
    }, 500);
  }
})();
