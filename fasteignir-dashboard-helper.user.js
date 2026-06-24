// ==UserScript==
// @name         Fasteignir.is Dashboard Helper
// @namespace    fasteignir-dashboard-helper
// @version      3.11
// @description  Adds filters, sold-listing detection, and relisting search to your saved properties on fasteignir.visir.is
// @match        https://fasteignir.visir.is/user/dashboard*
// @match        https://fasteignir.visir.is/search/results/*
// @updateURL    https://raw.githubusercontent.com/RChesterton/fasteignir-tools-public/main/fasteignir-dashboard-helper.user.js
// @downloadURL  https://raw.githubusercontent.com/RChesterton/fasteignir-tools-public/main/fasteignir-dashboard-helper.user.js
// @grant        none
// @run-at       document-idle
// ==/UserScript==

// ============================================================================
// REQUIRED BROWSER SETTING - READ BEFORE USING "Remove Sold" (bulk):
// This script opens MULTIPLE search tabs in quick succession via window.open().
// Browsers only reliably allow popups in direct response to a user click -
// once a tab is more than one or two calls removed from that original click
// (or a blocking confirm() dialog has been shown in between), it's likely to
// be silently blocked. Confirmed via live testing: without a permanent
// popup-allow exception for fasteignir.visir.is, a bulk run can fail to open
// most of its search tabs, leaving affected properties stuck reporting
// "could not be confirmed."
//   Firefox: Settings -> Privacy & Security -> Permissions -> Block pop-up
//            windows -> Exceptions... -> add https://fasteignir.visir.is -> Allow
//   Chrome:  Settings -> Privacy and security -> Site settings -> Pop-ups and
//            redirects -> Add (under "Allowed to send pop-ups") -> add the site
// Set this up BEFORE running "Remove Sold" in any new browser or profile.
// ============================================================================

(function () {
  'use strict';

  // ---------- Search-results tab: verify, auto-favorite, report back ----------
  // When the dashboard script opens a search tab to check for a relisting, it
  // does so via window.open(), which sets window.opener on the new tab. We use
  // that to make sure we ONLY act on tabs our own script opened - never a
  // search tab the person opened themselves, even if it has zero results.
  // Before closing (or giving up), this tab reports its outcome back to the
  // dashboard tab via postMessage, since that's the only way the dashboard
  // can know what happened in a separate browser tab.
  if (location.pathname.startsWith('/search/results')) {
    if (window.opener) {
      const params = new URLSearchParams(location.search);
      const propertyId = params.get('fdhPropId') || '';
      const isBulk = params.get('fdhBulk') === '1';
      const expectedSize = params.has('fdhSize') ? parseFloat(params.get('fdhSize')) : null;
      const expectedRooms = params.has('fdhRooms') ? parseInt(params.get('fdhRooms'), 10) : null;
      const expectedBaths = params.has('fdhBaths') ? parseInt(params.get('fdhBaths'), 10) : null;
      const expectedBeds = params.has('fdhBeds') ? parseInt(params.get('fdhBeds'), 10) : null;

      function reportBack(outcome, extra) {
        try {
          if (window.opener && !window.opener.closed) {
            window.opener.postMessage(
              { type: 'fdhRelistResult', propertyId, outcome, ...(extra || {}) },
              location.origin
            );
          }
        } catch (e) {
          console.warn('[Fasteignir Helper] could not report search result back:', e);
        }
      }

      // Clicking "add to favorites" triggers one of two native alert()
      // popups from the site itself. These aren't blocking anything that
      // matters here, but suppressing them lets us read their exact wording
      // to know definitively whether the save actually went through, rather
      // than just assuming success because a click happened.
      let lastFavoriteOutcome = null; // 'already-saved' | 'newly-saved' | null
      const originalAlertHere = window.alert.bind(window);
      window.alert = function (msg) {
        if (typeof msg === 'string') {
          if (msg.includes('þegar verið vistuð')) {
            lastFavoriteOutcome = 'already-saved';
            console.log('[Fasteignir Helper] suppressed "already saved" popup:', msg);
            return undefined;
          }
          if (msg.includes('hefur verið vistuð')) {
            lastFavoriteOutcome = 'newly-saved';
            console.log('[Fasteignir Helper] suppressed "saved" popup:', msg);
            return undefined;
          }
        }
        return originalAlertHere(msg);
      };

      // Strict exact match on every criterion we have ground truth for. If
      // the original property itself never showed a given stat, we skip
      // that check (nothing to compare against) - but if we DO know the
      // original's value, the candidate must show a matching value too; a
      // candidate missing that data point is rejected, not given the
      // benefit of the doubt, since we can't confirm it's correct. No
      // tolerance on size - a genuine relisting is treated as having the
      // exact same size; a real but unexplained difference is instead
      // flagged separately by isAreaMismatchCandidate below, rather than
      // silently absorbed or silently ignored.
      function isRealMatch(cardEl) {
        if (expectedSize != null) {
          const sizeEl = cardEl.querySelector('.estate__parameters--1');
          const size = sizeEl ? parseSize(sizeEl.textContent) : null;
          if (size == null || Math.abs(size - expectedSize) > 0.05) return false;
        }
        if (expectedRooms != null) {
          const roomsEl = cardEl.querySelector('.estate__parameters--2');
          const rooms = roomsEl ? parseIntSafe(roomsEl.textContent) : null;
          if (rooms == null || rooms !== expectedRooms) return false;
        }
        if (expectedBaths != null) {
          const bathsEl = cardEl.querySelector('.estate__parameters--3');
          const baths = bathsEl ? parseIntSafe(bathsEl.textContent) : null;
          if (baths == null || baths !== expectedBaths) return false;
        }
        if (expectedBeds != null) {
          const bedsEl = cardEl.querySelector('.estate__parameters--4');
          const beds = bedsEl ? parseIntSafe(bedsEl.textContent) : null;
          if (beds == null || beds !== expectedBeds) return false;
        }
        return true;
      }

      // Matches on every known criterion EXCEPT size, where it must show a
      // confirmed different value (not just missing data) - this is the
      // "probably the same property, but the floor area changed" case,
      // which we flag for manual review rather than silently treating as
      // either a match or a non-match.
      function isAreaMismatchCandidate(cardEl) {
        if (expectedRooms != null) {
          const roomsEl = cardEl.querySelector('.estate__parameters--2');
          const rooms = roomsEl ? parseIntSafe(roomsEl.textContent) : null;
          if (rooms == null || rooms !== expectedRooms) return false;
        }
        if (expectedBaths != null) {
          const bathsEl = cardEl.querySelector('.estate__parameters--3');
          const baths = bathsEl ? parseIntSafe(bathsEl.textContent) : null;
          if (baths == null || baths !== expectedBaths) return false;
        }
        if (expectedBeds != null) {
          const bedsEl = cardEl.querySelector('.estate__parameters--4');
          const beds = bedsEl ? parseIntSafe(bedsEl.textContent) : null;
          if (beds == null || beds !== expectedBeds) return false;
        }
        if (expectedSize == null) return false; // nothing to compare against
        const sizeEl = cardEl.querySelector('.estate__parameters--1');
        const size = sizeEl ? parseSize(sizeEl.textContent) : null;
        if (size == null) return false; // can't confirm an actual difference
        if (Math.abs(size - expectedSize) <= 0.05) return false; // this would already be an exact match
        return true;
      }

      // Clicks a card's favorite button and watches for the resulting
      // confirmation. This turns out to be a visible on-page popup rather
      // than a native alert() in at least some cases (our alert override
      // wouldn't catch that), so we poll the page's own text for the two
      // known phrases as well, on top of whatever the override captures.
      async function favoriteCard(cardEl) {
        lastFavoriteOutcome = null;
        const favBtn = cardEl.querySelector('.add-to-favorites');
        if (!favBtn) return 'no-fav-button';
        favBtn.click();
        const maxChecks = 10; // up to ~3 seconds
        for (let i = 0; i < maxChecks; i++) {
          await new Promise((r) => setTimeout(r, 300));
          if (lastFavoriteOutcome) return lastFavoriteOutcome;
          const text = document.body.innerText;
          if (text.includes('þegar verið vistuð')) return 'already-saved';
          if (text.includes('hefur verið vistuð')) return 'newly-saved';
        }
        return lastFavoriteOutcome || 'unknown-after-click';
      }

      let attempts = 0;
      const maxAttempts = 16; // ~8 seconds, fallback only - see noResults check below

      async function poll() {
        attempts++;
        const allCards = Array.from(document.querySelectorAll('.estate__item[data-id]'));
        const matches = allCards.filter(isRealMatch);
        const noResults = document.body.innerText.includes('Leitin skilaði engum niðurstöðum');

        if (noResults) {
          reportBack('no-match');
          window.close();
          return;
        }

        if (matches.length > 0) {
          // One or more cards passed the strict exact-match check. Two
          // genuinely different listings never share an identical exact
          // match on every known criterion, so if more than one DISTINCT
          // property ID passes here, it's a genuine extra relisting worth
          // saving too - not just the same card rendered twice.
          const confirmedIds = new Set();
          for (const card of matches) {
            const outcome = await favoriteCard(card);
            console.log('[Fasteignir Helper] favorite outcome for', card.dataset.id, ':', outcome);
            if (outcome === 'already-saved' || outcome === 'newly-saved') {
              confirmedIds.add(card.dataset.id);
            }
            await new Promise((r) => setTimeout(r, 300));
          }
          const savedCount = confirmedIds.size;
          // Read the price off the first match for the dashboard's price-
          // change comparison.
          const priceEl = matches[0].querySelector('.estate__price');
          const priceText = priceEl ? priceEl.textContent.trim() : '';
          const newPrice = priceEl ? parsePrice(priceEl.textContent) : null;
          const newIsTilbod = newPrice == null && /tilbo/i.test(priceText);
          reportBack(savedCount > 0 ? 'favorited' : 'unknown-after-click', { newPrice, newIsTilbod, savedCount });
          setTimeout(() => window.close(), 500);
          return;
        }

        // No exact match yet. Keep waiting in case the page is still
        // rendering. Only once we've fully given up do we check for an
        // area-mismatch candidate - checking earlier risks a false read on
        // a partially-rendered page.
        if (attempts >= maxAttempts) {
          const areaMismatches = allCards.filter(isAreaMismatchCandidate);
          if (areaMismatches.length > 0) {
            if (!isBulk) {
              areaMismatches.forEach((card) => {
                card.style.outline = '3px solid #d98c00';
                card.style.outlineOffset = '2px';
              });
            }
            reportBack('area-mismatch');
            if (isBulk) {
              window.close();
            }
            // else: leave the tab open intentionally for manual review.
            return;
          }
          reportBack('no-match');
          window.close();
          return;
        }
        setTimeout(poll, 500);
      }
      poll();
    }
    return;
  }

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
        <button id="fdh-remove" class="fdh-danger" disabled>Remove Sold</button>
        <div id="fdh-status-line"></div>
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
    statusLine(
      `Showing ${visibleCount} of ${cards.length} properties. Active: ${activeCount}, Removed: ${soldCount}.${suffix ? ' ' + suffix : ''}`
    );
  }

  document.getElementById('fdh-apply').addEventListener('click', () => {
    applyFilter();
    reloadImages();
  });
  document.getElementById('fdh-address-filter').addEventListener('input', applyFilter);

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

  // ---------- Relisting search ----------

  // Tracks property IDs we're waiting to hear back from a search tab about.
  // Maps propertyId -> { resolve, timeoutId }.
  const pendingRelistChecks = new Map();

  window.addEventListener('message', (event) => {
    if (event.origin !== location.origin) return;
    const data = event.data;
    if (!data || data.type !== 'fdhRelistResult') return;
    const pending = pendingRelistChecks.get(data.propertyId);
    if (pending) {
      clearTimeout(pending.timeoutId);
      pendingRelistChecks.delete(data.propertyId);
      pending.resolve({
        outcome: data.outcome,
        newPrice: data.newPrice,
        newIsTilbod: data.newIsTilbod,
        savedCount: data.savedCount,
      });
    }
  });

  // The site's search appears not to handle a hyphenated street-number range
  // (e.g. "Langholtsvegur 122-124") - using just the part before the hyphen
  // (e.g. "Langholtsvegur 122") finds it correctly. This only affects the
  // search keyword; c.street itself is left untouched everywhere else
  // (open house list, alerts, etc.) so the full address still displays.
  function searchKeyword(street) {
    if (!street) return street;
    const hyphenIndex = street.indexOf('-');
    if (hyphenIndex === -1) return street;
    return street.slice(0, hyphenIndex).trim();
  }

  // Builds a search URL. We include a broad area range (floor/ceil of the
  // known size, as plain integers) to help the site's own search actually
  // surface the listing, plus exact bathroom/bedroom/room counts (these are
  // already plain integers, unlike area, so they haven't shown the same
  // formatting problems). We still rely entirely on our own verification
  // (isRealMatch, using the fdh* params below) to do the final, strict
  // narrowing. fdhBulk marks a search opened from the bulk "Remove Sold"
  // flow, so the search tab knows to close itself even on an area-mismatch
  // finding (a single tab in that case isn't useful unattended, unlike the
  // single-property flow where it's left open for review).
  function buildSearchUrl(c, isBulk) {
    const hashParts = [];
    if (c.size != null) {
      // Widened well beyond the original size (rather than a tight
      // floor/ceil band) so the SITE'S OWN search doesn't pre-filter out a
      // genuine relisting that's been remeasured to a meaningfully different
      // size. Confirmed via live testing: a tight band silently excluded real
      // relistings before they ever reached our own matching logic - Snæland
      // 2 (92 -> 98 m²) and Helluvað 13 (99.2 -> 96.1 m²) were both wrongly
      // reported as no-match and removed with nothing saved, because the
      // candidate card never appeared in the site's results at all, so
      // neither isRealMatch nor isAreaMismatchCandidate ever got a chance to
      // see it. This widening only affects what the site hands back to filter
      // through - isRealMatch below still requires exact size agreement
      // before anything gets favorited, so this does NOT loosen what counts
      // as a genuine match.
      const AREA_SEARCH_TOLERANCE = 20;
      const areaMin = Math.max(0, Math.floor(c.size) - AREA_SEARCH_TOLERANCE);
      const areaMax = Math.ceil(c.size) + AREA_SEARCH_TOLERANCE;
      hashParts.push(`area=${areaMin},${areaMax}`);
    }
    hashParts.push('sort=price');
    if (c.street) {
      hashParts.push(`keyword=${encodeURIComponent(searchKeyword(c.street))}`);
    }
    hashParts.push('stype=sale');
    if (c.baths != null) hashParts.push(`bathroom=${c.baths},${c.baths}`);
    if (c.beds != null) hashParts.push(`bedroom=${c.beds},${c.beds}`);
    if (c.rooms != null) hashParts.push(`room=${c.rooms},${c.rooms}`);

    const extra = new URLSearchParams();
    extra.set('stype', 'sale');
    extra.set('fdhAutoFav', '1');
    extra.set('fdhPropId', c.id);
    if (isBulk) extra.set('fdhBulk', '1');
    if (c.size != null) extra.set('fdhSize', c.size);
    if (c.rooms != null) extra.set('fdhRooms', c.rooms);
    if (c.baths != null) extra.set('fdhBaths', c.baths);
    if (c.beds != null) extra.set('fdhBeds', c.beds);

    const base = `https://fasteignir.visir.is/search/results/?${extra.toString()}`;
    return `${base}#/?${hashParts.join('&')}`;
  }

  // Opens a search tab for this property and returns a Promise that resolves
  // once the search tab reports its outcome (or we give up waiting). Must be
  // called synchronously in direct response to a user click wherever
  // possible, since window.open() is otherwise likely to be popup-blocked.
  function triggerRelistSearch(c, isBulk) {
    return new Promise((resolve) => {
      const win = window.open(buildSearchUrl(c, isBulk), '_blank');
      if (!win) {
        resolve({ outcome: 'popup-blocked' });
        return;
      }
      const timeoutId = setTimeout(() => {
        pendingRelistChecks.delete(c.id);
        resolve({ outcome: 'unknown' });
      }, 15000);
      pendingRelistChecks.set(c.id, { resolve, timeoutId });
    });
  }

  // Same address and EXACTLY matching size/rooms/bathrooms/bedrooms where
  // both sides have a value. No tolerance on size - two real, different
  // nearby-sized units (e.g. 96.1 vs 96.4) must never be treated as the
  // same property just because they're close. The trade-off: if a
  // relisting's size happens to get rounded AND you already have both the
  // old and new entries saved, this won't catch that locally - but a real
  // search will still resolve it correctly (the site will say "already
  // saved" once it finds the active one), just slightly less efficiently.
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
  // relisting is effectively already saved - no need to spend a search tab
  // confirming that.
  function findActiveDuplicate(c) {
    return cards.find((other) => other.id !== c.id && other.status === 'active' && isSameProperty(other, c));
  }

  // Other saved entries for this same property that are themselves sold -
  // these are stale duplicates that should be cleaned up alongside c once we
  // know an active entry for the property already exists.
  function findSoldDuplicates(c) {
    return cards.filter(
      (other) =>
        other.id !== c.id &&
        (other.status === 'gone' || other.status === 'sold-text' || other.status === 'sold-address') &&
        isSameProperty(other, c)
    );
  }

  // Removes a saved property exactly once, even if called more than once for
  // the same card (e.g. once directly, once as a side effect of cleaning up
  // a duplicate sibling elsewhere in the same batch).
  function removeSavedProperty(c) {
    if (c._removed) return;
    c._removed = true;
    const closeBtn = c.el.querySelector('.js-remove-favourite');
    if (closeBtn) closeBtn.click();
  }

  // Resolves a property's relisting outcome. If a still-active duplicate is
  // already saved, skips the search entirely and reports it as saved.
  function resolveRelisting(c, isBulk) {
    const dup = findActiveDuplicate(c);
    if (dup) {
      return Promise.resolve({ outcome: 'already-saved-locally', newPrice: dup.price, newIsTilbod: dup.isTilbod });
    }
    return triggerRelistSearch(c, isBulk);
  }

  // Resolves c's relisting outcome and, once it's definite, removes c and
  // any other stale sold duplicates of the same property too - whatever the
  // answer is (relisted and saved, already saved, or confirmed not
  // relisted), it applies equally to every saved entry for that physical
  // property, not just whichever one happened to trigger the check. An
  // "area mismatch" outcome is deliberately NOT treated as definite - that
  // needs a person to look at it, so nothing gets removed for it. Any
  // unexpected error resolving the outcome is caught here so one property's
  // failure can never take down a whole bulk batch's summary/reload step.
  // resolveFn defaults to resolveRelisting but can be swapped for a deduped
  // version when processing many properties at once.
  async function processSoldProperty(c, resolveFn) {
    let result;
    try {
      result = await (resolveFn ? resolveFn(c) : resolveRelisting(c, false));
    } catch (err) {
      console.error('[Fasteignir Helper] error resolving relisting for', c.id, err);
      return { outcome: 'error' };
    }
    if (
      result.outcome === 'favorited' ||
      result.outcome === 'already-saved-locally' ||
      result.outcome === 'no-match'
    ) {
      removeSavedProperty(c);
      findSoldDuplicates(c).forEach(removeSavedProperty);
      // Keep the cache in sync with this removal immediately, so a later
      // soft-refresh (triggered by some other property entirely) doesn't
      // restore a stale status for something that's already been handled.
      saveStatusCache();
    }
    return result;
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
  // or null if the price (or Tilboð status) is unchanged. Deliberately states
  // old vs new rather than computing increase/decrease - that's trivial for
  // the person to work out themselves from the two values.
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

  // A per-property button shown only on flagged (no-longer-valid) cards.
  // Clicking it removes that one property and searches for a relisting,
  // reporting the outcome once the search tab finishes. Every message is
  // prefixed with the property's address, since this can be triggered on
  // several different cards in quick succession.
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
      // Note: only opens a search tab (when resolveRelisting doesn't find a
      // local duplicate) synchronously, in direct response to this click, so
      // window.open() isn't treated as an unsolicited popup. We deliberately
      // wait for a definite outcome before removing the sold card itself -
      // removing it unconditionally would risk losing track of the property
      // entirely if the search comes back uncertain (e.g. popup-blocked or
      // the tab closes without reporting back) and no relisting got saved.
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
        alert(msg);
        // A reload is only needed here - the new relisting was favorited in
        // a separate tab, so this page's own DOM has no way to know about
        // it otherwise. Uses the cache, so this doesn't re-check every other
        // property, only whatever's new.
        reloadUsingCache();
      } else if (result.outcome === 'already-saved-locally') {
        let msg = `${c.street}: An active listing for this property was already in your saved properties.`;
        const priceLine = priceChangeLine(c.price, c.isTilbod, result.newPrice, !!result.newIsTilbod);
        if (priceLine) msg += '\n' + priceLine;
        alert(msg);
        applyFilter();
        renderOpenHouses();
      } else if (result.outcome === 'no-match') {
        alert(`${c.street}: No new listing was found.`);
        applyFilter();
        renderOpenHouses();
      } else if (result.outcome === 'area-mismatch') {
        alert(
          `${c.street}: No new listing was found.\nNOTE: Another listing was found with a different floor area - the search tab has been left open so you can take a look.`
        );
        // Not removed - left in place for manual review, search tab stays open.
      } else if (result.outcome === 'popup-blocked') {
        alert(`${c.street}: Could not open a search tab - please allow popups for this site. The property was not removed - you can try again.`);
      } else if (result.outcome === 'error') {
        alert(`${c.street}: Something went wrong while checking this property. The property was not removed - you can try again.`);
      } else {
        alert(`${c.street}: Could not confirm the search result, so the property was not removed. You can try again.`);
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
    }
  }

  // Immediately badge anything we can tell from the address alone, no fetch needed
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

  async function checkOne(c, isRetry) {
    if (c.status === 'sold-address') return; // already known, skip fetch
    setBadge(c, 'Checking...', 'fdh-badge-checking');
    try {
      const res = await fetch(c.url, { credentials: 'include' });
      const finalUrl = res.url || c.url;
      const looksGoneByUrl = finalUrl.includes('404.html') || res.status === 404;
      if (looksGoneByUrl) {
        applyStatus(c, 'gone');
        return;
      }
      const html = await res.text();
      if (html.includes('Umbeðin síða fannst ekki')) {
        applyStatus(c, 'gone');
        return;
      }
      if (checkSoldInText(html)) {
        applyStatus(c, 'sold-text');
        return;
      }
      applyStatus(c, 'active');
    } catch (e) {
      if (!isRetry) {
        await new Promise((r) => setTimeout(r, 400));
        return checkOne(c, true);
      }
      // A repeated fetch failure here, in practice, means the redirect to
      // the 404 page involves a cross-origin hop the browser won't follow
      // for a plain fetch (property images are served from a different
      // subdomain, api-beta.fasteignir.is, so a similar hop on the page
      // redirect is plausible) - so we treat it as gone rather than as a
      // separate, ambiguous "error" state.
      console.warn('[Fasteignir Helper] fetch failed twice for', c.url, '- treating as gone (404).', e);
      applyStatus(c, 'gone');
    }
  }

  async function checkAll() {
    const toCheck = cards.filter((c) => c.status !== 'sold-address');
    const batchSize = 12;
    let done = 0;
    setFilterControlsDisabled(true);
    try {
      applyFilter('(checking statuses...)');
      for (let i = 0; i < toCheck.length; i += batchSize) {
        const batch = toCheck.slice(i, i + batchSize);
        await Promise.all(batch.map((c) => checkOne(c)));
        done += batch.length;
        statusLine(`Checked ${done} of ${toCheck.length}...`);
        await new Promise((r) => setTimeout(r, 50)); // light pacing without making the initial check drag
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
  const CACHE_KEY = 'fdh_statusCache';
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
            await Promise.all(uncached.map((c) => checkOne(c)));
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

  // Automatically check status once when the dashboard loads.
  runInitialCheck();

  // ---------- Remove Sold ----------

  async function removeSold() {
    const toRemove = cards.filter(
      (c) => c.status === 'gone' || c.status === 'sold-text' || c.status === 'sold-address'
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
    // Two or more sold entries can represent the same physical property
    // (e.g. it was saved more than once over time, or relisted once before
    // and went stale again). Searching for each separately would be
    // redundant and risks the later ones getting popup-blocked - instead,
    // entries that match each other share a single search outcome.
    const relistOutcomeCache = new Map();
    function propertyKey(c) {
      return `${(c.street || '').trim().toLowerCase()}|${c.size}|${c.rooms}|${c.baths}|${c.beds}`;
    }
    function resolveRelistingDeduped(c) {
      const key = propertyKey(c);
      if (relistOutcomeCache.has(key)) {
        return relistOutcomeCache.get(key);
      }
      const p = resolveRelisting(c, true); // isBulk = true
      relistOutcomeCache.set(key, p);
      return p;
    }

    const resultPromises = [];
    const priceChanges = [];
    const areaMismatchAddresses = [];
    for (const c of toRemove) {
      if (c._removed) continue; // already cleaned up as another property's sold duplicate
      // Checks for a local duplicate first (no tab needed if found). Note:
      // only the first one or two calls in this loop that actually need to
      // open a tab are likely to avoid the browser's popup blocker, since
      // each subsequent one happens after an awaited delay, outside the
      // original click's gesture window - allow popups for this site to
      // avoid missing relistings later in the batch. Removal of c (and any
      // other sold duplicates of the same property) is handled inside
      // processSoldProperty, and only once the outcome is definite - removing
      // unconditionally would risk losing track of the property entirely if
      // the search comes back uncertain and no relisting got saved.
      const resultPromise = processSoldProperty(c, resolveRelistingDeduped).then((result) => {
        if (!c._removed) {
          if (result.outcome === 'area-mismatch') {
            areaMismatchAddresses.push(c.street);
          } else {
            console.warn('[Fasteignir Helper] leaving', c.id, 'in place - uncertain relisting outcome:', result.outcome);
          }
        } else if (result.outcome === 'favorited' || result.outcome === 'already-saved-locally') {
          const line = priceChangeLine(c.price, c.isTilbod, result.newPrice, !!result.newIsTilbod);
          if (line) priceChanges.push(`${c.street}: ${line}`);
        }
        return result;
      });
      resultPromises.push(resultPromise);
      // small delay so the site's own AJAX call has time to fire before the next one
      await new Promise((r) => setTimeout(r, 600));
    }
    statusLine(`Waiting on relisting searches for ${resultPromises.length} propert${resultPromises.length === 1 ? 'y' : 'ies'}...`);
    const outcomes = await Promise.all(resultPromises);
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
      message += ` ${uncertainCount} could not be confirmed and ${uncertainCount === 1 ? 'was' : 'were'} left in your saved list - please check manually.`;
    }
    if (priceChanges.length > 0) {
      message += `\nPrice changes:\n${priceChanges.join('\n')}`;
    }
    if (areaMismatchAddresses.length > 0) {
      message += `\nNOTE: A listing with a different floor area was found for: ${areaMismatchAddresses.join(', ')}`;
    }
    alert(message);
    if (favoritedCount > 0) {
      // A reload is only needed when something new was actually favorited -
      // that happened in a separate tab, so this page has no way to know
      // about it otherwise. Uses the cache, so this doesn't re-check
      // everyone else, only whatever's new.
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

  applyFilter();
  renderDebug();
})();
