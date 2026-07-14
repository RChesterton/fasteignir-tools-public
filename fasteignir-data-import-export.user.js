// ==UserScript==
// @name         Fasteignir Data Import/Export
// @namespace    fasteignir-tools
// @version      0.28
// @description  Import/export saved-property and ISP data, and sync temporary search exclusions
// @match        https://fasteignir.visir.is/user/dashboard*
// @match        https://fasteignir.visir.is/search/results*
// @updateURL    https://raw.githubusercontent.com/RChesterton/fasteignir-tools-public/main/fasteignir-data-import-export.user.js
// @downloadURL  https://raw.githubusercontent.com/RChesterton/fasteignir-tools-public/main/fasteignir-data-import-export.user.js
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @connect      www.mila.is
// @connect      thjonustuvefur.ljosleidarinn.is
// @connect      api.github.com
// ==/UserScript==

/*
  HISTORY (condensed — see prior versions for full detail):
    v0.1  First draft. Manual paste only. Untested by Claude (no network access
          to mila.is/ljosleidarinn.is from the sandbox it was written in, and no
          way to run a real Tampermonkey environment there either).
    v0.2  Added "Load from saved properties" (reads dashboard cards directly).
    v0.3  Fixed postcode-from-whole-line bug (a unit number could get mistaken
          for the real postcode); added unit-number/rental-tag stripping via a
          blacklist of known junk patterns (íb/íbúð, parens, dash-suffix, TIL
          LEIGU); added dedup-by-building.
    v0.4  Fixed a broken \b word-boundary (doesn't fire before accented
          Icelandic letters in JS regex — the íb-stripping silently never
          matched); fixed a second bug where a genuine house-number range
          ("122-124") was wrongly mangled by the same dash-stripping logic
          meant for unit suffixes; textarea now shows the cleaned address
          (what's actually sent) instead of raw scraped text, so cleanup is
          reviewable before running rather than a hidden transformation.

  v0.5 — the big one, from a full live testing session against the real
  sites. Two structural changes plus everything that came out of testing:

  1) ADDRESS CLEANING REWRITTEN FROM SCRATCH (blacklist → whitelist).
     The old approach kept growing a list of known junk patterns to strip
     (íb301, (214), - 504, TIL LEIGU...) — a new fix every time a new junk
     shape turned up, with two real bugs found along the way. Replaced with
     one rule: a valid address is <street-word> <number><optional single
     letter>, full stop. Take exactly that, discard everything else, no
     matter what shape the leftover text is in. This handles every junk
     pattern seen so far AS A SIDE EFFECT, with no pattern-specific code:
       "Mýrargata 41 Vesturvin 1 íb 508" -> "Mýrargata 41"
       "Stakkholt 2a - 504"              -> "Stakkholt 2a"
       "Suðurlandsbraut 42 - TIL LEIGU"  -> "Suðurlandsbraut 42"
       "Langholtsvegur 122-124"          -> "Langholtsvegur 122"  (confirmed
                                              wanted — both networks store
                                              122 and 124 as separate entries,
                                              and the combined range string
                                              matches neither)
     The "optional single letter" part uses a negative lookahead to make
     sure it's a real lone suffix (like "1D" or "24B"), not accidentally the
     first letter of a whole separate word — without that guard, "Mýrargata
     41 Vesturvin 1" was wrongly grabbing the V off "Vesturvin" and producing
     "Mýrargata 41V". Confirmed against real data before shipping.
     KNOWN EXCEPTION, on purpose: "Hverfisgata íbúð 0001 83" — the apartment
     number sits BEFORE the house number here, which this rule can't handle
     (and no simple rule found could, without risking wrong matches
     elsewhere). This now returns null/no-match honestly rather than a wrong
     guess, and shows up in results as "doesn't fit the expected address
     shape" rather than being silently mishandled.

  2) DISAMBIGUATION FIXED: postcode alone is not enough.
     Confirmed with a real example (Hafnarbraut 12 in postcode 200): Míla
     had EIGHT entries sharing that postcode — 12, 12a, 12b, 12c, 12d, 12e,
     12f, 12g — all separate physical buildings. Postcode-only filtering
     called that "ambiguous" when it should have found exactly one match.
     Worse case confirmed: Grensásvegur 1 has SIXTEEN entries on both
     networks sharing one postcode (1, 1a–1h, 10–16a) — genuinely distinct
     registered addresses, not informal sub-labels, so getting this wrong
     means confidently reporting results for the wrong building entirely,
     with no error to flag it.
     Fixed by matching postcode AND street-number AND street-letter
     together (case-insensitive), on both networks.

  3) SPEED-TIER PARSING REWRITTEN, NUMBER-BASED INSTEAD OF PHRASE-BASED.
     Four real result patterns were captured live from Míla's actual result
     page during testing (original Icelandic, exact wording):
       10 Gbps:   "...tengst ljósleiðara MEÐ 10X og átt möguleika á allt að
                   10 gígabitum á sekúndu..."
       2.5 Gbps:  "...tengst 10X ljósleiðara hjá okkur og átt möguleika á
                   2,5 gígabitum á sekúndu..."
       1 Gbps:    "...tengst ljósleiðara ALLA LEIÐ og átt möguleika á allt
                   að EINUM gígabita..."
       Not avail: "Áætlun um lagningu ljósleiðara á þessu svæði liggur EKKI
                   FYRIR AÐ SVO stöddu."
     IMPORTANT, found during testing: bare "10x" is NOT a safe signal for
     10 Gbps — the 2.5 Gbps response also contains the literal substring
     "10x" ("tengst 10x ljósleiðara hjá okkur"), just not "MEÐ 10x". An
     earlier proposed fix would have silently mislabeled that 2.5 Gbps
     address as 10 Gbps. Also found: the header line above the body text
     ("Ljósleiðari í boði" vs "Ljósnet í boði") is NOT reliable either — a
     genuine non-availability result still said "Ljósnet í boði" as its
     header, while the real answer was entirely in the sentence below it.
     So this version ignores both "10x"/"alla leið" phrases AND the header
     line entirely, and instead extracts the actual gígabit number directly:
       "ekki fyrir að svo"           -> NOT AVAILABLE
       "einum"/"1" + gígabit         -> 1 Gbps
       "2,5"/"2.5" + gígabit         -> 2.5 Gbps
       "5"/"5,0"/"5.0" + gígabit     -> 5 Gbps  (no live example yet, by
                                                  extrapolation from the
                                                  2.5/10 pattern)
       "10"/"10,0"/"10.0" + gígabit  -> 10 Gbps
       none of the above             -> UNRECOGNIZED, flag for a human look

  4) UI REWORKED: replaced the floating panel with a small collapsible box
     inserted at the top of the page (same insertion point and collapse-
     arrow pattern as fasteignir-dashboard-helper's toolbar), defaulting to
     collapsed. On-page display is deliberately minimal now — short status
     codes per network, not full sentences — since the detailed text was
     always meant as raw material for an eventual spreadsheet export, not
     something to live permanently on the page. Full detail (including the
     resultUrl to manually verify) is still there, just in a title tooltip
     and a click-through link rather than inline text.

  NOT INCLUDED IN THIS VERSION, ON PURPOSE: the GitHub Gist export pipeline
  discussed earlier (fixed-URL Gist, PAT scoped to "gist" only, stored via
  GM_setValue). That still needs its own design pass — exact data shape,
  token-entry UI, update-vs-create logic — none of which has been tested or
  confirmed yet, unlike everything above. Building it blind now would mean
  guessing past what's actually been validated, which is the opposite of
  how the rest of this script got built. Flagging it as the next real item,
  not forgetting it.

  v0.6: fixed a real bug found via live testing of v0.5 — Ljósleiðarinn
  sometimes stores a merged range as one entry (confirmed real response:
  querying "Langholtsvegur 122" returns a single entry literally named
  "Langholtsvegur 122-124", covering two adjoining numbers). The v0.5
  disambiguation read the trailing number by anchoring at the END of the
  string, which pulled 124 out of "122-124" and wrongly rejected a query
  for 122 as a non-match. parseNumberLetter now recognizes this merged-
  range shape and accepts either bound as a valid match. Verified against
  the actual captured API response, and re-verified the original Hafnarbraut
  12/12a/12b letter-disambiguation still works correctly after the change.

  v0.7: added the GitHub Gist export pipeline. First export creates a gist
  and remembers its ID; later exports update that same gist rather than
  creating new ones, so there's one stable URL. Token entered once via the
  UI, stored with GM_setValue, never in the script text — assumed to be a
  classic PAT scoped to "gist" only. Genuinely untested against the real
  GitHub API — built from documented request/response shape, not from an
  actual successful call. If it fails, the error message returned by
  GitHub's API should show in the export status line; that's the most
  useful thing to report back.

  STILL UNTESTED BY CLAUDE: same as every version — no way to run this for
  real from where it's written. Every change above was validated as pure
  string-processing logic against real captured data before being put in
  here, but the actual GM_xmlhttpRequest calls, the UI rendering, the
  collapse behavior, and the new Gist export have not been executed by me
  even once.

  v0.8 — four real fixes from live testing feedback:
    a) SPEED: cut REQUEST_DELAY_MS from 700ms to 200ms, and rewrote the
       batch runner to check CONCURRENCY (4) distinct buildings at once
       via a worker pool, instead of strictly one at a time. onRowDone
       still fires progressively per original address the moment its
       building resolves, so live progress still works even though
       several checks now run in parallel — rows can land out of input
       order as a result, which doesn't matter since every row carries
       its own id/url rather than relying on position. UNVERIFIED RISK:
       neither network's actual rate limits are known, so this is a
       reasonable-sounding guess, not a confirmed-safe setting.
    b) ID CAPTURE — a real gap caught via user feedback, not something
       found through testing: nothing was capturing the fasteignir.visir.is
       property ID/URL at all, meaning results could only ever be tied
       back to a source listing by address text — fragile, and useless
       for joining against other data. Fixed: loadAddressesFromDashboard
       now reads each card's real ID (same el.dataset.id already used
       elsewhere) and encodes it into the textarea line as a trailing
       "#<id>" marker (e.g. "Borgargerði 3, 108 #1065890"), which
       parseAddressLine now reads back out. Every result row now carries
       id + url; manually-typed addresses (no card behind them) correctly
       get id: null rather than a fabricated value. The on-page address
       text is now a link to the actual listing when an id exists.
    c) MERGE-ON-EXPORT — previously logged as a known gap, now built:
       exporting used to overwrite the entire gist with only the current
       run's results, so re-running just the addresses that were
       skipped/failed and exporting again would wipe out everything else
       that wasn't in that smaller run. Fixed by fetching whatever's
       already in the gist first and merging by address text (a fresh row
       replaces a matching address, everything else is kept). Same
       limitation as when this was originally discussed: if an address's
       text itself changes between runs, it's treated as a new entry, not
       a replacement — there's no more stable join key than the text
       itself available here.
    d) Suðurlandsbraut 42 and Suðurgata 9 (both flagged "no match" /
       "parsing issue" during testing) are confirmed NOT script bugs —
       Suðurlandsbraut 42 genuinely isn't registered as a plain "42" on
       either network (Míla has 42a/42b, Ljósleiðarinn only 42b); Suðurgata
       9 isn't found by either network even searching manually with the
       confirmed-correct address. Both are real data gaps, not something
       to chase further in code.
*/

/*
  v0.9 — two fixes from a second round of feedback on v0.8:
    a) URL now uses the card's ACTUAL link (<a class="js-property-link"
       href="/property/...">, confirmed real markup), resolved to an
       absolute URL, rather than constructing one from the ID — that was
       an unnecessary assumption when the real href was sitting right
       there. Only falls back to constructing a URL from the ID if no
       such link is found on the card at all.
    b) Merge-on-export now keys by id when a row has one, falling back to
       address text only for rows with none (manual entries, or anything
       exported before v0.8 added id-capture at all). KNOWN TRANSITION
       GAP: any rows already in the gist from v0.7-or-earlier exports have
       no id field, so they'll key by their old address text rather than
       matching against a new id-keyed row for the same property —
       meaning the first export after upgrading may produce one old
       (address-keyed, no id) and one new (id-keyed) entry for properties
       checked in both eras, rather than cleanly replacing the old one.
       Re-running everything once after upgrading would naturally clear
       this up, since every row would then have an id.
*/

/*
  v0.10 — fixed a real bug in v0.8/0.9's id-capture, found via live
  testing: the "#<id>" marker was added to every loaded address's raw
  text, but the textarea-population code never actually displayed raw —
  it reconstructed a clean string from streetAndNumber+postcode instead,
  which never included the marker at all. The marker only ever showed up
  for the ONE case that fell back to displaying raw directly (an address
  that didn't fit the expected shape) — meaning id-capture was silently
  broken for ~191 of 192 real addresses, not the one-line cosmetic issue
  it looked like at first.

  Replaced the text-marker approach entirely with position-based
  matching instead: loadAddressesFromDashboard's result is kept in
  memory, and when Check runs, each textarea line is compared against
  what was loaded at that same position — if it matches exactly
  (unedited), the real loaded object (id/url intact) is used directly;
  otherwise it falls back to parsing the line fresh (id: null). Verified
  against the actual scenario that motivated this design: three
  identically-displayed duplicate addresses (e.g. Kuggavogur 26 x3, real
  saved units, real distinct IDs) correctly keep their own separate IDs
  by position, an edited line correctly loses its ID without disturbing
  neighboring lines, and a manually-appended extra line correctly gets
  no ID. raw is back to clean text everywhere — no more marker leaking
  into anything visible.

  Also added autocomplete="off" to the token field and the textarea, so
  Firefox doesn't try to offer to save the token as a password.
*/

/*
  v0.14 — fixed a history-merge bug in the saved-property Gist export.
  v0.13 correctly learned how to treat relisted properties as the same
  logical property when the CURRENT export was compared against the
  PREVIOUS one, but there was still one ugly transition case left:

  if an older export had already produced a stale removed row for a
  property, and a later export contained the relisted active row, the
  exact-id match on the active row could "use up" that row first and
  leave the stale removed twin behind forever. Real examples found in the
  live Gist during validation: Auðbrekka 16, Jöklasel 25, Flúðasel 91,
  and one of the Kuggavogur 26 units.

  Fixed by adding a second reconciliation pass AFTER the normal merge:
  removed rows are compared against active rows at the same address, and
  only collapsed when there is one clear best candidate based on the
  same hard layout signals already used elsewhere (rooms/baths/beds),
  then tightened further with size and price when needed to avoid
  accidentally merging distinct saved units in the same building.

  Important effect: this is deliberately a cleanup pass for stale
  removed-history duplicates, not a broad "collapse same-address rows"
  rule. Genuine multiple saved units at the same address still remain
  separate when the evidence is ambiguous.
*/

/*
  v0.15 — UI renamed and tightened up now that this script has grown past
  being "just" an internet checker. The script and the dashboard section
  are now both called Data Import/Export, the main action buttons are
  grouped around the actual check flow ("Load", "Check", "Export"), button
  labels use normal title capitalization, and the noisy per-row status list
  moved lower in the panel.

  The live run output is now anomaly-only: normal positive rows no longer
  spam the page, and only cases that need human attention (for example a
  double skip or a double no-match) are shown there. The double-skip case
  uses the same red warning treatment as the existing double-no-match case
  rather than quietly blending in.
*/

/*
  v0.16 — the data-import/export pass.

  1) ISP RESULTS NOW MERGE BY BUILDING, NOT LISTING ID.
     The checks were already deduped by building at run time, but the Gist
     export still kept rows per listing id/url, which let relistings pile up
     duplicate ISP rows. Results are now merged by cleaned street+number+
     postcode instead, with listing ids/urls kept only as provenance.

  2) STABLE POSITIVE ISP RESULTS ARE REUSED ON RERUNS.
     If a building already has Míla 10 Gbps and/or Ljósleiðarinn
     CONNECTABLE in the Gist, those network checks are skipped on later
     runs by default and the cached result is reused. That makes repeat
     runs substantially faster once a building has been seen.

  3) SAVED-PROPERTY LIST UI SPLIT INTO LOAD / EXPORT / CLEAR.
     The hidden top textarea is now a shared scratch area: JSON preview for
     Load Saved Property List, simple address/postcode/url CSV output for
     Export Saved Property List, and a dedicated Clear button. Each action
     clears the box before writing into it.

  4) PANEL STYLING MATCHES DASHBOARD HELPER MORE CLOSELY.
     The panel now uses the same white card, border, radius, inherited
     typography, h4-style title, and collapse-arrow treatment rather than
     the older heavier box styling.
*/

/*
  v0.12 — saved-property export now treats relisted properties as the SAME
  underlying property when they still match the dashboard-helper notion of
  "same property" (same displayed address plus matching room/bath/bed shape,
  with size allowed to drift). This fixes a real workflow issue: the
  dashboard-helper removes stale sold entries and re-saves the relisting with
  a NEW fasteignir ID/URL, so keying only by id/url would otherwise mark the
  old row as removed and create a duplicate new row for what is, in practice,
  the same saved property. Property-list exports now:
    - merge exact id/url matches first
    - otherwise fuzzy-match likely relistings by address + layout fields
    - retain removed properties instead of dropping them
    - flag rows that have been relisted and keep a small history of seen ids/urls
*/

/*
  v0.13 — extends the relisting/export history tracking so price changes across
  relistings are retained too. When a property is matched as the same saved
  property but the current asking price differs, the export now keeps the
  previous price, current price, change timestamp, and a simple seen-price
  history rather than silently replacing the old value.
*/

/*
  v0.27 — search-result listings can be hidden for 30 days by exact listing ID.
  The exclusion list is stored in the existing Gist so it follows the user
  across configured browsers and devices. Relistings with a different ID are
  unaffected. Manual early restoration is deferred to a later version.
*/

(function () {
  'use strict';

  // Speed: cut from 700ms (v0.5-0.7) and run several buildings concurrently
  // instead of strictly one at a time. Real, unverified risk: neither
  // network's actual rate limits are known, so this is a genuine guess at
  // a reasonable balance, not a confirmed-safe setting. If real testing
  // shows a spike in ERROR rows specifically at higher volumes, that's the
  // signal to back these back down, not assume it's unrelated.
  const REQUEST_DELAY_MS = 200;
  const CONCURRENCY = 4; // how many distinct buildings get checked at once

  // ---- Promise wrapper around GM_xmlhttpRequest ----
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

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  function normalizeWhitespace(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
  }

  // ---- Address cleaning (whitelist approach — see header notes above) ----
  // A valid address is <street-word> <number><optional lone letter>. Take
  // exactly that, discard everything else. The negative lookahead on the
  // letter group makes sure it's a real lone suffix (e.g. "1D"), not
  // accidentally the first letter of a separate word like "Vesturvin".
  function cleanStreetForQuery(streetPart) {
    const m = normalizeWhitespace(streetPart).match(/^(\S+)\s+(\d{1,4})\s?([a-zA-Z])?(?![a-zA-Z])/);
    if (!m) return null; // doesn't fit the expected shape — handled as a known, honest exception downstream
    return `${m[1]} ${m[2]}${m[3] ? m[3].toLowerCase() : ''}`;
  }

  function buildBuildingKey(streetAndNumber, postcode) {
    const street = normalizeWhitespace(streetAndNumber).toLowerCase();
    const zip = String(postcode || '').trim();
    if (!street || !zip) return null;
    return `${street}|${zip}`;
  }

  function cleanedDisplayAddress(streetAndNumber, postcode, fallbackRaw) {
    if (streetAndNumber) return `${streetAndNumber}, ${postcode || '???'}`;
    return normalizeWhitespace(fallbackRaw);
  }

  // Pulls the trailing number(s) + optional single letter off a street
  // string — used to disambiguate lettered addresses like Grensásvegur 1
  // vs 1a vs 1b... vs 16a, on both the typed/cleaned address and whatever
  // a network's own API returns.
  //
  // Handles a merged-range form too (e.g. Ljósleiðarinn storing a single
  // entry "Langholtsvegur 122-124" to cover two adjoining numbers): such
  // entries match if the typed number equals EITHER bound, not just the
  // last one. Without this, a plain end-anchored "grab the last number"
  // read would pull 124 out of "122-124" and wrongly reject a query for
  // 122 — confirmed as a real bug against Ljósleiðarinn's actual API
  // response before being fixed here, not a hypothetical.
  function parseNumberLetter(streetAndNumber) {
    const s = streetAndNumber || '';
    const rangeMatch = s.match(/(\d{1,4})-(\d{1,4})\s*$/);
    if (rangeMatch) {
      return { numbers: [rangeMatch[1], rangeMatch[2]], letter: null };
    }
    const m = s.match(/(\d{1,4})\s*([a-zA-Z])?\s*$/);
    if (!m) return { numbers: [], letter: null };
    return { numbers: [m[1]], letter: m[2] ? m[2].toLowerCase() : null };
  }

  // ---- Address parsing ----
  // Postcode is read ONLY from the text after the comma — never scanned
  // across the whole line, since some unit numbers are themselves 3 digits
  // (e.g. "Valshlíð 5 - 114, 102") and scanning the whole string risks
  // grabbing the unit number instead of the real postcode.
  //
  // Manually-typed/edited lines never have a real property ID — there's no
  // card behind them to read one from. id/url are null here; the actual ID
  // is attached separately for unedited loaded lines via position-matching
  // in the UI (see #fic-run below), not by parsing it out of the text.
  function parseAddressLine(line) {
    const trimmed = line.trim();
    if (!trimmed) return null;

    const commaIdx = trimmed.indexOf(',');
    let streetPart = trimmed;
    let rest = '';
    if (commaIdx !== -1) {
      streetPart = trimmed.slice(0, commaIdx).trim();
      rest = trimmed.slice(commaIdx + 1).trim();
    }

    const postcodeMatch = rest.match(/\b(\d{3})\b/);
    const postcode = postcodeMatch ? postcodeMatch[1] : null;

    return {
      raw: trimmed,
      streetAndNumber: cleanStreetForQuery(streetPart),
      postcode,
      buildingKey: buildBuildingKey(cleanStreetForQuery(streetPart), postcode),
      id: null,
      url: null,
    };
  }

  // ---- Reading addresses straight off the dashboard ----
  // Selectors copied directly from fasteignir-dashboard-helper's parseCard
  // rather than re-derived, since they're already confirmed working there.
  function getCardEls() {
    return Array.from(document.querySelectorAll('.estate__item[data-id]'));
  }

  function loadAddressesFromDashboard() {
    return getCardEls()
      .map((el) => {
        const id = el.dataset.id;
        const link = el.matches('a.js-property-link') ? el : el.querySelector('a.js-property-link');
        // Real href from the card's own link, resolved to an absolute URL —
        // confirmed real markup: <a href="/property/933291"
        // class="js-property-link">. Only falls back to constructing a URL
        // from the ID if no such link is found at all, rather than always
        // guessing the URL shape.
        const url = link
          ? new URL(link.getAttribute('href'), location.href).href
          : `https://fasteignir.visir.is/property/${id}`;
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
        const postal = postalMatch ? postalMatch[1] : null;
        const sizeEl = el.querySelector('.estate__parameters--1');
        const roomsEl = el.querySelector('.estate__parameters--2');
        const bathsEl = el.querySelector('.estate__parameters--3');
        const bedsEl = el.querySelector('.estate__parameters--4');
        const priceEl = el.querySelector('.estate__price');
        const parseFloatOrNull = (text) => {
          const m = (text || '').replace(',', '.').match(/[\d.]+/);
          return m ? parseFloat(m[0]) : null;
        };
        const parseIntOrNull = (text) => {
          const m = (text || '').match(/\d+/);
          return m ? parseInt(m[0], 10) : null;
        };
        const size = sizeEl ? parseFloatOrNull(sizeEl.textContent) : null;
        const rooms = roomsEl ? parseIntOrNull(roomsEl.textContent) : null;
        const baths = bathsEl ? parseIntOrNull(bathsEl.textContent) : null;
        const beds = bedsEl ? parseIntOrNull(bedsEl.textContent) : null;
        const price = priceEl ? parseInt((priceEl.textContent || '').replace(/[^\d]/g, ''), 10) : null;
        const priceText = priceEl ? priceEl.textContent : '';
        const isTilbod = price == null && /tilbo/i.test(priceText);
        if (!street) return null;
        return {
          raw: `${street}, ${postal || '???'}`,
          streetAndNumber: cleanStreetForQuery(street),
          postcode: postal,
          buildingKey: buildBuildingKey(cleanStreetForQuery(street), postal),
          id,
          url,
          size,
          rooms,
          baths,
          beds,
          price,
          isTilbod,
        };
      })
      .filter(Boolean);
  }

  function getUniqueSavedPropertiesFromDashboard() {
    const properties = loadAddressesFromDashboard();
    const unique = new Map();
    for (const property of properties) {
      const key = property.id || property.raw;
      if (!unique.has(key)) unique.set(key, property);
    }
    return Array.from(unique.values());
  }

  // ---- Result-page parsing (Míla) ----
  // Deliberately ignores "10x"/"alla leið" phrases and the header line
  // entirely — see header notes above for why both are unreliable. Only
  // the actual gígabit number in the body sentence is trusted.
  function parseMilaAvailability(html) {
    if (/ekki fyrir að svo/i.test(html)) {
      return { tier: 'NOT AVAILABLE', detail: 'No current plan to lay fiber in this area' };
    }
    const tierPatterns = [
      { re: /\b2[,.]5\s*gígabit/i, tier: '2.5 Gbps' }, // must be checked before the plain "5" pattern below, or it'll match the bare 5 inside "2,5" and misreport this as 5 Gbps
      { re: /\b10[,.]?0?\s*gígabit/i, tier: '10 Gbps' },
      { re: /\b5[,.]?0?\s*gígabit/i, tier: '5 Gbps' },
      { re: /\b(?:einum|1)\s*gígabit/i, tier: '1 Gbps' },
    ];
    for (const p of tierPatterns) {
      if (p.re.test(html)) return { tier: p.tier, detail: `Result page states ${p.tier}` };
    }
    return { tier: null, detail: null };
  }

  // ---- Míla check ----
  async function checkMila(address) {
    if (!address.streetAndNumber) {
      return { network: 'Míla', status: 'SKIPPED', detail: 'Address text does not fit the expected street+number shape — needs a manual look' };
    }
    if (!address.postcode) {
      return { network: 'Míla', status: 'SKIPPED', detail: 'No postcode found' };
    }

    const typed = parseNumberLetter(address.streetAndNumber);
    if (typed.numbers.length === 0) {
      return { network: 'Míla', status: 'SKIPPED', detail: 'Could not identify a house number in the cleaned address' };
    }

    let streetsRes;
    try {
      streetsRes = await gmRequest({
        method: 'POST',
        url: 'https://www.mila.is/api/mila/get-streets',
        headers: {
          'Content-Type': 'application/json',
          Origin: 'https://www.mila.is',
          Referer: 'https://www.mila.is/get-eg-tengst',
        },
        data: JSON.stringify({ street: address.streetAndNumber }),
        timeout: 15000,
      });
    } catch (e) {
      return { network: 'Míla', status: 'ERROR', detail: 'get-streets request failed: ' + e.message };
    }

    let matches;
    try {
      matches = JSON.parse(streetsRes.responseText);
    } catch (e) {
      return { network: 'Míla', status: 'ERROR', detail: 'Could not parse get-streets JSON' };
    }

    function milaResultUrl(entry) {
      const locationStr = `${entry.street.name} ${entry.streetNumber || ''} - ${entry.street.postalCode} ${entry.street.municipality}`.trim();
      return (
        'https://www.mila.is/get-eg-tengst-uppfletting?' +
        'location=' + encodeURIComponent(locationStr) +
        '&locationId=' + encodeURIComponent(entry.id) +
        '&locationOrigin=MILA'
      );
    }

    async function siblingEvidenceForMila() {
      const siblings = matches
        .filter((m) => {
          if (String(m.street && m.street.postalCode) !== address.postcode) return false;
          if (String(m.streetNumber) !== typed.numbers[0]) return false;
          return Boolean(m.streetLetter);
        })
        .slice(0, 4);
      const evidence = [];
      for (const sibling of siblings) {
        const siblingAddress = `${sibling.street.name} ${sibling.streetNumber || ''}${sibling.streetLetter || ''}`.trim();
        const resultUrl = milaResultUrl(sibling);
        try {
          const pageRes = await gmRequest({ method: 'GET', url: resultUrl, timeout: 15000 });
          const parsed = parseMilaAvailability(pageRes.responseText || '');
          evidence.push({
            address: `${siblingAddress}, ${sibling.street.postalCode}`,
            status: parsed.tier || 'UNRECOGNIZED',
            detail: parsed.detail || 'Sibling result page did not match any known Míla pattern',
            resultUrl,
          });
        } catch (e) {
          evidence.push({
            address: `${siblingAddress}, ${sibling.street.postalCode}`,
            status: 'ERROR',
            detail: 'Sibling result page request failed: ' + e.message,
            resultUrl,
          });
        }
      }
      return evidence;
    }

    const exact = matches.filter((m) => {
      if (String(m.street && m.street.postalCode) !== address.postcode) return false;
      if (String(m.streetNumber) !== typed.numbers[0]) return false;
      const mLetter = (m.streetLetter || '').toLowerCase();
      return mLetter === (typed.letter || '');
    });

    if (exact.length === 0) {
      const siblingEvidence = await siblingEvidenceForMila();
      return {
        network: 'Míla',
        status: 'NO MATCH',
        detail: `No exact street+number+postcode match for postcode ${address.postcode} — verify manually`,
        siblingEvidence,
      };
    }
    if (exact.length > 1) {
      return { network: 'Míla', status: 'AMBIGUOUS', detail: `${exact.length} candidates still matched after full disambiguation — verify manually` };
    }

    const entry = exact[0];
    const resultUrl = milaResultUrl(entry);

    let pageRes;
    try {
      pageRes = await gmRequest({ method: 'GET', url: resultUrl, timeout: 15000 });
    } catch (e) {
      return { network: 'Míla', status: 'ERROR', detail: 'Result page request failed: ' + e.message, resultUrl };
    }

    const html = pageRes.responseText || '';
    const parsed = parseMilaAvailability(html);

    if (parsed.tier) {
      return { network: 'Míla', status: parsed.tier, detail: parsed.detail, resultUrl };
    }

    return {
      network: 'Míla',
      status: 'UNRECOGNIZED',
      detail: 'Result page did not match any known pattern (not-available or a gígabit number) — open resultUrl and check manually',
      resultUrl,
    };
  }

  // ---- Ljósleiðarinn check ----
  // Never returns a speed/tier — this network's API only ever confirms
  // basic connectivity (connectionStatusCode 4 is the only confirmed value).
  async function checkLjosleidarinn(address) {
    if (!address.streetAndNumber) {
      return { network: 'Ljósleiðarinn', status: 'SKIPPED', detail: 'Address text does not fit the expected street+number shape — needs a manual look' };
    }

    const typed = parseNumberLetter(address.streetAndNumber);

    let validateRes;
    try {
      validateRes = await gmRequest({
        method: 'GET',
        url: 'https://thjonustuvefur.ljosleidarinn.is/api/v1/leit/addresses/' + encodeURIComponent(address.streetAndNumber),
        headers: {
          Accept: 'application/json, text/plain, */*',
          Origin: 'https://www.ljosleidarinn.is',
          Referer: 'https://www.ljosleidarinn.is/',
        },
        timeout: 15000,
      });
    } catch (e) {
      return { network: 'Ljósleiðarinn', status: 'ERROR', detail: 'address validation failed: ' + e.message };
    }

    let validateJson;
    try {
      validateJson = JSON.parse(validateRes.responseText);
    } catch (e) {
      return { network: 'Ljósleiðarinn', status: 'ERROR', detail: 'Could not parse address JSON' };
    }

    const streetList = validateJson.streetList || [];
    if (streetList.length === 0) {
      return { network: 'Ljósleiðarinn', status: 'NO MATCH', detail: validateJson.errorMessage || 'Address not recognized' };
    }

    const exact = streetList.filter((s) => {
      if (address.postcode && String(s.zip) !== address.postcode) return false;
      const sParsed = parseNumberLetter(s.street);
      if (!sParsed.numbers.includes(typed.numbers[0])) return false;
      return (sParsed.letter || '') === (typed.letter || '');
    });

    if (exact.length === 0) {
      return { network: 'Ljósleiðarinn', status: 'NO MATCH', detail: `${streetList.length} candidates found but none matched street+number+postcode exactly — verify manually` };
    }
    if (exact.length > 1) {
      return { network: 'Ljósleiðarinn', status: 'AMBIGUOUS', detail: `${exact.length} candidates still matched after full disambiguation — verify manually` };
    }

    const matchByZip = exact[0];

    let availRes;
    try {
      availRes = await gmRequest({
        method: 'GET',
        url:
          'https://thjonustuvefur.ljosleidarinn.is/api/v1/leit/availability/' +
          encodeURIComponent(matchByZip.zip) + '/' +
          encodeURIComponent(matchByZip.street),
        headers: {
          Accept: 'application/json, text/plain, */*',
          Origin: 'https://www.ljosleidarinn.is',
          Referer: 'https://www.ljosleidarinn.is/',
        },
        timeout: 15000,
      });
    } catch (e) {
      return { network: 'Ljósleiðarinn', status: 'ERROR', detail: 'availability request failed: ' + e.message };
    }

    let availJson;
    try {
      availJson = JSON.parse(availRes.responseText);
    } catch (e) {
      return { network: 'Ljósleiðarinn', status: 'ERROR', detail: 'Could not parse availability JSON' };
    }

    const code = availJson.connectionStatusCode;
    if (code === '4') {
      return { network: 'Ljósleiðarinn', status: 'CONNECTABLE', detail: 'connectionStatusCode 4 — confirmed meaning: can connect (no speed/tier info available from this API)' };
    }
    return {
      network: 'Ljósleiðarinn',
      status: 'CODE ' + code,
      detail: 'Status code not yet decoded — only "4" is confirmed so far. Check manually.',
    };
  }

  // ---- Batch runner ----
  // Multiple saved units in the same building (same cleaned street+number+
  // letter+postcode) only get checked once — fiber availability is a
  // building-level fact, not per-apartment. Every original address still
  // appears in the results; repeats just reuse the cached result.
  function dedupeKey(address) {
    return address && address.buildingKey
      ? address.buildingKey
      : buildBuildingKey(address && address.streetAndNumber, address && address.postcode);
  }

  function shouldReuseCachedMila(row) {
    return row && row.mila && row.mila.status === '10 Gbps';
  }

  function shouldReuseCachedLjosleidarinn(row) {
    return row && row.ljosleidarinn && row.ljosleidarinn.status === 'CONNECTABLE';
  }

  function shouldSkipBothFromCachedMila(row) {
    return shouldReuseCachedMila(row);
  }

  function cachedPairForBuilding(existingResults) {
    const map = new Map();
    for (const row of existingResults || []) {
      const parsed = row && row.buildingKey
        ? row
        : {
            ...row,
            ...parseAddressLine((row && row.buildingAddress) || (row && row.address) || ''),
      };
      const key = buildBuildingKey(parsed && parsed.streetAndNumber, parsed && parsed.postcode);
      if (!key) continue;
      if (!shouldReuseCachedMila(parsed) && !shouldReuseCachedLjosleidarinn(parsed)) continue;
      const previous = map.get(key);
      if (!previous) {
        map.set(key, parsed);
        continue;
      }
      // Prefer rows that already have both stable-positive results when
      // cleaning up pre-building-key history from older exports.
      const previousScore = (shouldReuseCachedMila(previous) ? 1 : 0) + (shouldReuseCachedLjosleidarinn(previous) ? 1 : 0);
      const nextScore = (shouldReuseCachedMila(parsed) ? 1 : 0) + (shouldReuseCachedLjosleidarinn(parsed) ? 1 : 0);
      if (nextScore >= previousScore) map.set(key, parsed);
    }
    return map;
  }

  // CONCURRENCY distinct buildings get checked at once via a small worker
  // pool, instead of strictly one at a time. onRowDone still fires
  // progressively per ORIGINAL address the moment its building's result is
  // ready — not held back until every building finishes — so live
  // progress still updates even though several are running in parallel.
  // One real consequence: rows can now appear out of input order (whichever
  // building resolves first), which doesn't matter for anything downstream
  // since every row still carries its own id/url, not a position.
  async function runBatch(addresses, onRowDone, cachedResultsByBuilding, onBuildingEvent) {
    const groups = new Map(); // dedupeKey -> [addresses sharing it]
    const invalidAddresses = [];
    const stats = {
      cachedNetworks: 0,
      checkedNetworks: 0,
      completedBuildings: 0,
      totalBuildings: 0,
    };
    for (const address of addresses) {
      const key = dedupeKey(address);
      if (!key) {
        invalidAddresses.push(address);
        continue;
      }
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(address);
    }
    const uniqueKeys = Array.from(groups.keys());
    const results = [];
    let nextIndex = 0;
    stats.totalBuildings = uniqueKeys.length + invalidAddresses.length;

    for (const address of invalidAddresses) {
      const row = {
        address: cleanedDisplayAddress(address.streetAndNumber, address.postcode, address.raw),
        rawAddress: address.raw,
        buildingAddress: cleanedDisplayAddress(address.streetAndNumber, address.postcode, address.raw),
        buildingKey: null,
        streetAndNumber: address.streetAndNumber || null,
        postcode: address.postcode || null,
        id: address.id || null,
        url: address.url || null,
        mila: {
          network: 'Míla',
          status: 'SKIPPED',
          detail: 'Address text does not fit the expected street+number shape — needs a manual look',
        },
        ljosleidarinn: {
          network: 'Ljósleiðarinn',
          status: 'SKIPPED',
          detail: 'Address text does not fit the expected street+number shape — needs a manual look',
        },
      };
      results.push(row);
      if (onRowDone) onRowDone(row);
      stats.checkedNetworks += 2;
      stats.completedBuildings += 1;
      if (onBuildingEvent) {
        onBuildingEvent({
          type: 'invalid',
          buildingAddress: row.buildingAddress,
          durationMs: 0,
          milaMode: 'checked',
          llMode: 'checked',
          milaStatus: row.mila.status,
          llStatus: row.ljosleidarinn.status,
          stats: { ...stats },
        });
      }
    }

    async function worker() {
      while (nextIndex < uniqueKeys.length) {
        const key = uniqueKeys[nextIndex++];
        const groupAddresses = groups.get(key);
        const representative = groupAddresses[0];
        const cached = cachedResultsByBuilding && cachedResultsByBuilding.get(key);
        const startedAt = Date.now();
        const skipBothFromMila = shouldSkipBothFromCachedMila(cached);
        const milaMode = shouldReuseCachedMila(cached) ? 'cached' : 'checked';
        const llMode = skipBothFromMila || shouldReuseCachedLjosleidarinn(cached) ? 'cached' : 'checked';
        if (onBuildingEvent) {
          onBuildingEvent({
            type: 'start',
            buildingAddress: cleanedDisplayAddress(representative.streetAndNumber, representative.postcode, representative.raw),
            milaMode,
            llMode,
            stats: { ...stats },
          });
        }
        const milaPromise = shouldReuseCachedMila(cached)
          ? Promise.resolve({ ...cached.mila })
          : checkMila(representative);
        const ljosPromise = shouldReuseCachedLjosleidarinn(cached)
          ? Promise.resolve({ ...cached.ljosleidarinn })
          : skipBothFromMila
          ? Promise.resolve({
              network: 'Ljósleiðarinn',
              status: 'SKIPPED',
              detail: 'Skipped because cached Míla 10 Gbps already confirms high-speed fiber at this building',
            })
          : checkLjosleidarinn(representative);
        const [milaResult, ljosResult] = await Promise.all([
          milaPromise,
          ljosPromise,
        ]);
        const pair = { mila: milaResult, ljosleidarinn: ljosResult };
        const checkedAt = new Date().toISOString();
        const freshMila = !shouldReuseCachedMila(cached);
        const freshLjosleidarinn = !shouldReuseCachedLjosleidarinn(cached) && !skipBothFromMila;
        stats.cachedNetworks += milaMode === 'cached' ? 1 : 0;
        stats.cachedNetworks += llMode === 'cached' ? 1 : 0;
        stats.checkedNetworks += milaMode === 'checked' ? 1 : 0;
        stats.checkedNetworks += llMode === 'checked' ? 1 : 0;
        stats.completedBuildings += 1;

        for (const address of groupAddresses) {
          const row = {
            address: cleanedDisplayAddress(address.streetAndNumber, address.postcode, address.raw),
            rawAddress: address.raw,
            buildingAddress: cleanedDisplayAddress(address.streetAndNumber, address.postcode, address.raw),
            buildingKey: key,
            streetAndNumber: address.streetAndNumber || null,
            postcode: address.postcode || null,
            id: address.id || null,
            url: address.url || null,
            mila: freshMila ? { ...pair.mila, checkedAt } : { ...pair.mila },
            ljosleidarinn: freshLjosleidarinn ? { ...pair.ljosleidarinn, checkedAt } : { ...pair.ljosleidarinn },
          };
          results.push(row);
          if (onRowDone) onRowDone(row);
        }
        if (onBuildingEvent) {
          onBuildingEvent({
            type: 'done',
            buildingAddress: cleanedDisplayAddress(representative.streetAndNumber, representative.postcode, representative.raw),
            durationMs: Date.now() - startedAt,
            milaMode,
            llMode,
            milaStatus: pair.mila && pair.mila.status,
            llStatus: pair.ljosleidarinn && pair.ljosleidarinn.status,
            stats: { ...stats },
          });
        }
        if (freshMila || freshLjosleidarinn) {
          await sleep(REQUEST_DELAY_MS);
        }
      }
    }

    const workerCount = Math.min(CONCURRENCY, uniqueKeys.length) || 1;
    await Promise.all(Array.from({ length: workerCount }, () => worker()));
    return results;
  }
  // ---- Short status codes for the minimal on-page display ----
  // Full detail is still there (title tooltip + click-through to resultUrl
  // when available) — this is just what's visible without interacting.
  const MILA_SHORT = {
    '10 Gbps': '10G', '5 Gbps': '5G', '2.5 Gbps': '2.5G', '1 Gbps': '1G',
    'NOT AVAILABLE': '✗', UNRECOGNIZED: '?', 'NO MATCH': 'no match',
    AMBIGUOUS: 'ambiguous', SKIPPED: 'skip', ERROR: 'error',
  };
  const LL_SHORT = {
    CONNECTABLE: '✓', 'NO MATCH': 'no match', AMBIGUOUS: 'ambiguous',
    SKIPPED: 'skip', ERROR: 'error',
  };
  function shortStatus(map, status) {
    if (map[status]) return map[status];
    if (status && status.startsWith('CODE ')) return status.toLowerCase();
    return status || '?';
  }

  function isAlertStatus(status) {
    return ['SKIPPED', 'NO MATCH', 'AMBIGUOUS', 'ERROR', 'UNRECOGNIZED'].includes(status);
  }

  function shouldShowAnomalyRow(row) {
    const milaStatus = row && row.mila && row.mila.status;
    const llStatus = row && row.ljosleidarinn && row.ljosleidarinn.status;
    if (!milaStatus || !llStatus) return false;
    if (milaStatus === 'NO MATCH' && llStatus === 'NO MATCH') return true;
    return milaStatus === llStatus && isAlertStatus(milaStatus);
  }

  // ---- GitHub Gist export ----
  // First export creates a new gist and remembers its ID via GM_setValue;
  // every export after that updates that SAME gist rather than creating a
  // new one, so there's one fixed, stable URL to read from going forward.
  // Token is entered once via the UI and stored with GM_setValue, never
  // hardcoded in the script text — assumed to be a classic GitHub Personal
  // Access Token scoped to ONLY the "gist" permission, per the original
  // design discussion (fine-grained tokens don't expose a discrete gist
  // scope the same way). UNTESTED against the real GitHub API — built from
  // documented API shape, not from an actual successful call.
  const GIST_FILENAME = 'fasteignir-internet-checker-results.json';
  const PROPERTY_LIST_GIST_FILENAME = 'fasteignir-saved-properties.json';
  async function getGistId() {
    return GM_getValue('fic_gist_id', null);
  }

  // Fetches whatever's already in the gist (if any) and merges by address
  // text — a fresh row replaces an existing one with the same address, but
  // anything not present in this run's results is kept untouched. Means
  // re-running just the addresses that were skipped/failed and exporting
  // again no longer wipes out everything else.
  // KNOWN LIMITATION, unchanged from when this was originally discussed: if
  // an address's text itself changes between runs, it's treated as a new
  // entry, not a replacement — address text is the only join key available
  // here, there's no more stable ID for merge purposes than that.
  async function fetchExistingGistFileJson(filename, fallbackValue) {
    const token = await GM_getValue('fic_github_token', null);
    const gistId = await getGistId();
    if (!token || !gistId) return fallbackValue;

    try {
      const res = await gmRequest({
        method: 'GET',
        url: `https://api.github.com/gists/${gistId}`,
        headers: {
          Authorization: 'token ' + token,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
        timeout: 15000,
      });
      if (res.status < 200 || res.status >= 300) return fallbackValue;
      const json = JSON.parse(res.responseText);
      const file = json.files && json.files[filename];
      if (!file || !file.content) return fallbackValue;
      return JSON.parse(file.content);
    } catch (e) {
      console.warn(`[Fasteignir Data Import/Export] could not fetch ${filename} from existing gist for merge:`, e.message);
      return fallbackValue;
    }
  }

  async function fetchExistingGistResults() {
    return fetchExistingGistFileJson(GIST_FILENAME, []);
  }

  async function fetchExistingGistProperties() {
    return fetchExistingGistFileJson(PROPERTY_LIST_GIST_FILENAME, []);
  }

  // ---- Search results: 30-day, cross-device listing exclusions ----
  const HIDDEN_LISTINGS_GIST_FILENAME = 'fasteignir-hidden-search-listings.json';
  const HIDDEN_LISTING_TTL_MS = 30 * 24 * 60 * 60 * 1000;

  function normalizeHiddenListingRows(value) {
    const rows = Array.isArray(value)
      ? value
      : value && Array.isArray(value.listings)
        ? value.listings
        : [];
    const now = Date.now();
    const active = new Map();
    let expiredCount = 0;

    for (const row of rows) {
      const propertyId = String(row && row.propertyId || '').trim();
      const hiddenUntilMs = Date.parse(row && row.hiddenUntil || '');
      if (!/^\d+$/.test(propertyId) || !Number.isFinite(hiddenUntilMs)) continue;
      if (hiddenUntilMs <= now) {
        expiredCount++;
        continue;
      }
      active.set(propertyId, {
        propertyId,
        hiddenAt: row.hiddenAt || new Date(now).toISOString(),
        hiddenUntil: new Date(hiddenUntilMs).toISOString(),
      });
    }
    return { active, expiredCount };
  }

  async function fetchHiddenListingRows() {
    const token = await GM_getValue('fic_github_token', null);
    const gistId = await getGistId();
    if (!token || !gistId) throw new Error('Gist token or ID is not configured');

    const res = await gmRequest({
      method: 'GET',
      url: `https://api.github.com/gists/${gistId}`,
      headers: {
        Authorization: 'token ' + token,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      timeout: 15000,
    });
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`GitHub API returned ${res.status}`);
    }

    const json = JSON.parse(res.responseText);
    const file = json.files && json.files[HIDDEN_LISTINGS_GIST_FILENAME];
    if (!file || !file.content) return [];
    const parsed = JSON.parse(file.content);
    return Array.isArray(parsed) ? parsed : parsed.listings || [];
  }

  function hiddenListingRowsFromMap(map) {
    return Array.from(map.values()).sort((a, b) => a.propertyId.localeCompare(b.propertyId));
  }

  async function writeHiddenListingRows(map) {
    const token = await GM_getValue('fic_github_token', null);
    const gistId = await getGistId();
    if (!token || !gistId) throw new Error('Gist token or ID is not configured');

    const res = await gmRequest({
      method: 'PATCH',
      url: `https://api.github.com/gists/${gistId}`,
      headers: {
        Authorization: 'token ' + token,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
      },
      data: JSON.stringify({
        files: {
          [HIDDEN_LISTINGS_GIST_FILENAME]: {
            content: JSON.stringify(hiddenListingRowsFromMap(map), null, 2),
          },
        },
      }),
      timeout: 15000,
    });
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`GitHub API returned ${res.status}`);
    }
  }

  function initHiddenSearchListings() {
    const HIDDEN_CLASS = 'fie-search-hidden-listing';
    let hiddenListings = new Map();
    let hiddenListingsReady = false;
    let applyTimer = null;
    let syncQueue = Promise.resolve();
    let statusMessage = '';

    const style = document.createElement('style');
    style.textContent = `
      .${HIDDEN_CLASS} { display: none !important; }
      .fie-hide-button-host { position: relative !important; padding-right: 44px !important; }
      .fie-hide-listing-button {
        position: absolute; top: 10px; right: 10px; z-index: 5;
        width: 24px; height: 24px; padding: 0; border: 0; border-radius: 50%;
        display: inline-flex; align-items: center; justify-content: center;
        background: #d8d8d8; color: #c62828; cursor: pointer;
        font: bold 20px/1 Arial, sans-serif;
      }
      .fie-hide-listing-button:hover { background: #c7c7c7; color: #a91515; }
      .fie-hide-listing-button:disabled { cursor: wait; opacity: 0.65; }
      #fie-hidden-status {
        margin-left: 16px; color: #a33; font-size: 13px; font-weight: normal;
      }
    `;
    document.head.appendChild(style);

    function canonicalPropertyId(card) {
      const links = [];
      if (card.matches('a[href]')) links.push(card);
      links.push(...card.querySelectorAll('a[href]'));
      for (const link of links) {
        try {
          const url = new URL(link.getAttribute('href'), location.href);
          const match = url.pathname.match(/^\/property\/(\d+)\/?$/);
          if (url.origin === location.origin && match) return match[1];
        } catch (_) {}
      }
      return null;
    }

    function resultCards() {
      return Array.from(document.querySelectorAll('.estate__item')).filter(
        (card) => !card.parentElement || !card.parentElement.closest('.estate__item')
      );
    }

    function findResultCountEl() {
      const pattern = /^\d+\s*eignir\s+fundust$/i;
      return Array.from(document.querySelectorAll('h1, h2, h3, h4')).find(
        (el) => pattern.test((el.textContent || '').trim())
      ) || null;
    }

    function ensureStatus() {
      const countEl = findResultCountEl();
      if (!countEl) return null;

      let status = document.getElementById('fie-hidden-status');
      if (!status) {
        status = document.createElement('span');
        status.id = 'fie-hidden-status';
        const savedControl = document.getElementById('fdh-show-saved-wrap');
        (savedControl || countEl).insertAdjacentElement('afterend', status);
      }
      if (status.textContent !== statusMessage) status.textContent = statusMessage;
      return status;
    }

    function setStatus(message) {
      statusMessage = message || '';
      const status = ensureStatus();
      if (status && status.textContent !== statusMessage) {
        status.textContent = statusMessage;
      }
    }

    async function hideRemoteListing(propertyId) {
      const latest = normalizeHiddenListingRows(await fetchHiddenListingRows()).active;
      const hiddenAt = new Date();
      latest.set(propertyId, {
        propertyId,
        hiddenAt: hiddenAt.toISOString(),
        hiddenUntil: new Date(hiddenAt.getTime() + HIDDEN_LISTING_TTL_MS).toISOString(),
      });
      await writeHiddenListingRows(latest);
      hiddenListings = latest;
    }

    function queueListingUpdate(propertyId, button) {
      button.disabled = true;
      setStatus('Hiding listing...');
      syncQueue = syncQueue
        .then(() => hideRemoteListing(propertyId))
        .then(() => setStatus(''))
        .catch((error) => {
          setStatus(`Could not update hidden listings: ${error.message}`);
          console.warn('[Fasteignir Data Import/Export] hidden-listing update failed:', error);
        })
        .finally(() => {
          button.disabled = false;
          applyFiltering();
        });
    }

    function ensureCardButton(card, propertyId) {
      const host = card.querySelector('.estate__item-title');
      if (!host) return;
      host.classList.add('fie-hide-button-host');

      let button = host.querySelector('.fie-hide-listing-button');
      if (!button) {
        button = document.createElement('button');
        button.type = 'button';
        button.className = 'fie-hide-listing-button';
        host.appendChild(button);
        button.addEventListener('click', (event) => {
          event.preventDefault();
          event.stopPropagation();
          event.stopImmediatePropagation();
          const id = button.dataset.propertyId;
          queueListingUpdate(id, button);
        });
      }

      button.dataset.propertyId = propertyId;
      if (button.textContent !== '×') button.textContent = '×';
      button.title = 'Hide this listing for 30 days';
      button.setAttribute('aria-label', button.title);
    }

    function applyFiltering() {
      for (const card of resultCards()) {
        card.classList.remove(HIDDEN_CLASS);
        const propertyId = canonicalPropertyId(card);
        if (!propertyId || card.classList.contains('wide-item-desktop')) continue;
        if (!hiddenListingsReady) continue;

        const isHidden = hiddenListings.has(propertyId);
        if (isHidden) {
          card.classList.add(HIDDEN_CLASS);
        } else {
          ensureCardButton(card, propertyId);
        }
      }
      ensureStatus();
    }

    function scheduleFiltering() {
      if (applyTimer !== null) return;
      applyTimer = setTimeout(() => {
        applyTimer = null;
        applyFiltering();
      }, 80);
    }

    async function loadHiddenListings() {
      try {
        const normalized = normalizeHiddenListingRows(await fetchHiddenListingRows());
        hiddenListings = normalized.active;
        hiddenListingsReady = true;
        setStatus('');
        applyFiltering();
        if (normalized.expiredCount > 0) {
          syncQueue = syncQueue
            .then(() => writeHiddenListingRows(hiddenListings))
            .catch((error) => console.warn(
              '[Fasteignir Data Import/Export] could not remove expired hidden listings:',
              error
            ));
        }
      } catch (error) {
        hiddenListingsReady = false;
        setStatus(`Hidden-list sync unavailable: ${error.message}`);
        console.warn('[Fasteignir Data Import/Export] could not load hidden listings:', error);
      }
    }

    applyFiltering();
    loadHiddenListings();
    new MutationObserver(scheduleFiltering).observe(document.body, {
      childList: true,
      subtree: true,
    });
  }

  if (location.pathname.startsWith('/search/results')) {
    initHiddenSearchListings();
    return;
  }

  function normalizeIspRow(row) {
    const parsed = row && row.buildingKey
      ? row
      : {
          ...row,
          ...parseAddressLine((row && row.buildingAddress) || (row && row.address) || ''),
        };
    const buildingKey = buildBuildingKey(parsed && parsed.streetAndNumber, parsed && parsed.postcode);
    if (!buildingKey) return null;
    return {
      ...parsed,
      buildingKey,
      buildingAddress: cleanedDisplayAddress(parsed.streetAndNumber, parsed.postcode, parsed.buildingAddress || parsed.address || ''),
      streetAndNumber: parsed.streetAndNumber || null,
      postcode: parsed.postcode || null,
      seenPropertyIds: dedupeList([...(parsed.seenPropertyIds || []), parsed.id]),
      seenPropertyUrls: dedupeList([...(parsed.seenPropertyUrls || []), parsed.url]),
      sourceAddresses: dedupeList([...(parsed.sourceAddresses || []), parsed.rawAddress, parsed.address, parsed.buildingAddress]),
    };
  }

  function reduceFreshResultsByBuilding(results) {
    const map = new Map();
    for (const row of results || []) {
      const normalized = normalizeIspRow(row);
      if (!normalized) continue;
      const existing = map.get(normalized.buildingKey);
      if (!existing) {
        map.set(normalized.buildingKey, normalized);
        continue;
      }
      map.set(normalized.buildingKey, {
        ...existing,
        address: normalized.address || existing.address,
        buildingAddress: normalized.buildingAddress || existing.buildingAddress,
        streetAndNumber: normalized.streetAndNumber || existing.streetAndNumber,
        postcode: normalized.postcode || existing.postcode,
        mila: normalized.mila || existing.mila,
        ljosleidarinn: normalized.ljosleidarinn || existing.ljosleidarinn,
        seenPropertyIds: dedupeList([...(existing.seenPropertyIds || []), ...(normalized.seenPropertyIds || []), existing.id, normalized.id]),
        seenPropertyUrls: dedupeList([...(existing.seenPropertyUrls || []), ...(normalized.seenPropertyUrls || []), existing.url, normalized.url]),
        sourceAddresses: dedupeList([...(existing.sourceAddresses || []), ...(normalized.sourceAddresses || [])]),
      });
    }
    return Array.from(map.values());
  }

  function mergeResultsByBuilding(existing, fresh) {
    const existingMap = new Map();
    for (const row of existing || []) {
      const normalized = normalizeIspRow(row);
      if (!normalized) continue;
      existingMap.set(normalized.buildingKey, normalized);
    }

    for (const row of reduceFreshResultsByBuilding(fresh)) {
      const previous = existingMap.get(row.buildingKey);
      if (!previous) {
        existingMap.set(row.buildingKey, row);
        continue;
      }
      existingMap.set(row.buildingKey, {
        ...previous,
        ...row,
        address: row.address || previous.address,
        buildingAddress: row.buildingAddress || previous.buildingAddress,
        streetAndNumber: row.streetAndNumber || previous.streetAndNumber,
        postcode: row.postcode || previous.postcode,
        mila: row.mila || previous.mila,
        ljosleidarinn: row.ljosleidarinn || previous.ljosleidarinn,
        seenPropertyIds: dedupeList([...(previous.seenPropertyIds || []), ...(row.seenPropertyIds || []), previous.id, row.id]),
        seenPropertyUrls: dedupeList([...(previous.seenPropertyUrls || []), ...(row.seenPropertyUrls || []), previous.url, row.url]),
        sourceAddresses: dedupeList([...(previous.sourceAddresses || []), ...(row.sourceAddresses || [])]),
      });
    }

    return Array.from(existingMap.values());
  }

  function propertyListKey(row) {
    return row && (row.id || row.url || row.raw);
  }

  function normalizePropertyAddress(row) {
    return String((row && row.raw) || '').trim().toLowerCase();
  }

  function numberOrNull(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
  }

  function sizesClose(a, b) {
    const aNum = numberOrNull(a);
    const bNum = numberOrNull(b);
    if (aNum == null || bNum == null) return false;
    return Math.abs(aNum - bNum) <= 0.15;
  }

  // Mirrors the dashboard helper's idea of "same property" closely enough for
  // export merging: relistings often get a new fasteignir id/url and can drift
  // in size/price, but the address and room/bath/bed shape usually stay put.
  function isSameSavedProperty(a, b) {
    if (normalizePropertyAddress(a) !== normalizePropertyAddress(b)) return false;

    let hardSignalMatches = 0;
    for (const field of ['rooms', 'baths', 'beds']) {
      const aValue = numberOrNull(a && a[field]);
      const bValue = numberOrNull(b && b[field]);
      if (aValue == null || bValue == null) continue;
      if (aValue !== bValue) return false;
      hardSignalMatches++;
    }

    if (hardSignalMatches > 0) return true;
    return sizesClose(a && a.size, b && b.size);
  }

  function sameIdOrUrl(a, b) {
    if (a && b && a.id && b.id && String(a.id) === String(b.id)) return true;
    if (a && b && a.url && b.url && String(a.url) === String(b.url)) return true;
    return false;
  }

  function chooseBestPropertyMatch(existingRows, currentRow, usedIndexes) {
    let exactMatchIndex = -1;
    let fuzzyMatchIndex = -1;

    for (let i = 0; i < existingRows.length; i++) {
      if (usedIndexes.has(i)) continue;
      const row = existingRows[i];
      if (sameIdOrUrl(row, currentRow)) {
        exactMatchIndex = i;
        break;
      }
      if (fuzzyMatchIndex === -1 && isSameSavedProperty(row, currentRow)) {
        fuzzyMatchIndex = i;
      }
    }

    return exactMatchIndex !== -1 ? exactMatchIndex : fuzzyMatchIndex;
  }

  function dedupeList(values) {
    return Array.from(new Set((values || []).filter(Boolean).map(String)));
  }

  function countMatchingLayoutSignals(a, b) {
    let matches = 0;
    for (const field of ['rooms', 'baths', 'beds']) {
      const aValue = numberOrNull(a && a[field]);
      const bValue = numberOrNull(b && b[field]);
      if (aValue == null || bValue == null) continue;
      if (aValue !== bValue) return -1;
      matches++;
    }
    return matches;
  }

  function chooseRemovedDuplicateTargetIndex(activeRows, removedRow) {
    let bestIndex = -1;
    let bestScore = -1;
    let bestScoreTied = false;

    for (let i = 0; i < activeRows.length; i++) {
      const activeRow = activeRows[i];
      if (normalizePropertyAddress(activeRow) !== normalizePropertyAddress(removedRow)) continue;

      const layoutMatches = countMatchingLayoutSignals(activeRow, removedRow);
      if (layoutMatches < 0) continue;

      const sizeMatches = sizesClose(activeRow && activeRow.size, removedRow && removedRow.size);
      const activePrice = numberOrNull(activeRow && activeRow.price);
      const removedPrice = numberOrNull(removedRow && removedRow.price);
      const priceMatches =
        activePrice != null &&
        removedPrice != null &&
        activePrice === removedPrice;

      // Needs at least one real signal beyond the bare address, or it's too
      // risky to silently absorb a removed row into an active one.
      if (layoutMatches === 0 && !sizeMatches && !priceMatches) continue;

      const score = (layoutMatches * 10) + (sizeMatches ? 3 : 0) + (priceMatches ? 2 : 0);
      if (score > bestScore) {
        bestIndex = i;
        bestScore = score;
        bestScoreTied = false;
      } else if (score === bestScore) {
        bestScoreTied = true;
      }
    }

    return bestScoreTied ? -1 : bestIndex;
  }

  function reconcileRemovedDuplicateRows(rows) {
    const activeRows = [];
    const removedRows = [];

    for (const row of rows) {
      if (row && row.savedStatus === 'removed') {
        removedRows.push(row);
      } else {
        activeRows.push(row);
      }
    }

    for (const removedRow of removedRows) {
      const targetIndex = chooseRemovedDuplicateTargetIndex(activeRows, removedRow);
      if (targetIndex === -1) {
        activeRows.push(removedRow);
        continue;
      }

      const target = activeRows[targetIndex];
      activeRows[targetIndex] = {
        ...target,
        hasBeenRelisted: true,
        relistCount: (target.relistCount || 0) + 1,
        seenListingIds: dedupeList([...(target.seenListingIds || []), ...(removedRow.seenListingIds || []), removedRow.id]),
        seenListingUrls: dedupeList([...(target.seenListingUrls || []), ...(removedRow.seenListingUrls || []), removedRow.url]),
        firstSeenSavedAt: target.firstSeenSavedAt || removedRow.firstSeenSavedAt,
      };
    }

    return activeRows;
  }

  function propertyListRow(property, now) {
    return {
      id: property.id || null,
      url: property.url || null,
      raw: property.raw,
      streetAndNumber: property.streetAndNumber,
      postcode: property.postcode,
      size: property.size,
      rooms: property.rooms,
      baths: property.baths,
      beds: property.beds,
      price: property.price,
      isTilbod: property.isTilbod,
      savedStatus: 'saved',
      isRemovedFromSaved: false,
      hasBeenRelisted: false,
      relistCount: 0,
      latestPreviousPrice: null,
      latestCurrentPrice: property.price ?? null,
      priceChangedAt: null,
      priceHistory: property.price != null ? [{ price: property.price, seenAt: now }] : [],
      seenListingIds: property.id ? [String(property.id)] : [],
      seenListingUrls: property.url ? [String(property.url)] : [],
      firstSeenSavedAt: now,
      lastSeenSavedAt: now,
      removedFromSavedAt: null,
    };
  }

  function mergePropertyList(existing, currentProperties) {
    const now = new Date().toISOString();
    const currentRows = currentProperties.map((property) => propertyListRow(property, now));
    const existingRows = Array.isArray(existing) ? existing.slice() : [];
    const usedExistingIndexes = new Set();
    const mergedRows = [];

    for (const currentRow of currentRows) {
      const matchIndex = chooseBestPropertyMatch(existingRows, currentRow, usedExistingIndexes);
      if (matchIndex === -1) {
        mergedRows.push(currentRow);
        continue;
      }

      usedExistingIndexes.add(matchIndex);
      const previous = existingRows[matchIndex] || {};
      const relisted =
        !sameIdOrUrl(previous, currentRow) &&
        (Boolean(previous.id || previous.url) || Boolean(currentRow.id || currentRow.url));
      const previousPrice = numberOrNull(previous.price);
      const currentPrice = numberOrNull(currentRow.price);
      const priceChanged =
        previousPrice != null &&
        currentPrice != null &&
        previousPrice !== currentPrice;
      const nextPriceHistory = Array.isArray(previous.priceHistory) ? previous.priceHistory.slice() : [];
      if (currentPrice != null) {
        const lastPriceEntry = nextPriceHistory[nextPriceHistory.length - 1];
        if (!lastPriceEntry || numberOrNull(lastPriceEntry.price) !== currentPrice) {
          nextPriceHistory.push({ price: currentPrice, seenAt: now });
        }
      }

      mergedRows.push({
        ...previous,
        ...currentRow,
        savedStatus: 'saved',
        isRemovedFromSaved: false,
        hasBeenRelisted: Boolean(previous.hasBeenRelisted) || relisted,
        relistCount: (previous.relistCount || 0) + (relisted ? 1 : 0),
        latestPreviousPrice: priceChanged ? previousPrice : previous.latestPreviousPrice || null,
        latestCurrentPrice: currentPrice != null ? currentPrice : previous.latestCurrentPrice || null,
        priceChangedAt: priceChanged ? now : previous.priceChangedAt || null,
        priceHistory: nextPriceHistory,
        seenListingIds: dedupeList([...(previous.seenListingIds || []), previous.id, currentRow.id]),
        seenListingUrls: dedupeList([...(previous.seenListingUrls || []), previous.url, currentRow.url]),
        firstSeenSavedAt: previous.firstSeenSavedAt || currentRow.firstSeenSavedAt,
        lastSeenSavedAt: now,
        removedFromSavedAt: null,
      });
    }

    for (let i = 0; i < existingRows.length; i++) {
      if (usedExistingIndexes.has(i)) continue;
      const row = existingRows[i];
      mergedRows.push({
        ...row,
        savedStatus: 'removed',
        isRemovedFromSaved: true,
        removedFromSavedAt: row.removedFromSavedAt || now,
      });
    }

    return reconcileRemovedDuplicateRows(mergedRows);
  }

  async function pushResultsToGist(results) {
    const token = await GM_getValue('fic_github_token', null);
    if (!token) {
      return { ok: false, error: 'No GitHub token saved yet - enter one in the token box first.' };
    }

    const existing = await fetchExistingGistResults();
    const merged = mergeResultsByBuilding(existing, results);

    const gistId = await getGistId();
    const payload = {
      description: 'Fasteignir Data Import/Export results',
      public: false,
      files: { [GIST_FILENAME]: { content: JSON.stringify(merged, null, 2) } },
    };
    const headers = {
      Authorization: 'token ' + token,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
    };

    try {
      const res = await gmRequest({
        method: gistId ? 'PATCH' : 'POST',
        url: gistId ? `https://api.github.com/gists/${gistId}` : 'https://api.github.com/gists',
        headers,
        data: JSON.stringify(payload),
        timeout: 15000,
      });

      if (res.status < 200 || res.status >= 300) {
        return { ok: false, error: `GitHub API returned ${res.status} - check the token's permissions` };
      }

      const json = JSON.parse(res.responseText);
      if (json.id) await GM_setValue('fic_gist_id', json.id);
      return { ok: true, url: json.html_url };
    } catch (e) {
      return { ok: false, error: 'Request failed: ' + e.message };
    }
  }

  async function pushPropertyListToGist(properties) {
    const token = await GM_getValue('fic_github_token', null);
    if (!token) {
      return { ok: false, error: 'No GitHub token saved yet - enter one in the token box first.' };
    }
    const gistId = await getGistId();
    const existing = await fetchExistingGistProperties();
    const merged = mergePropertyList(existing, properties);
    const activeCount = merged.filter((row) => row.savedStatus !== 'removed').length;
    const removedCount = merged.length - activeCount;
    const payload = {
      description: 'Fasteignir Data Import/Export data',
      public: false,
      files: {
        [PROPERTY_LIST_GIST_FILENAME]: { content: JSON.stringify(merged, null, 2) },
      },
    };
    try {
      const res = await gmRequest({
        method: gistId ? 'PATCH' : 'POST',
        url: gistId ? `https://api.github.com/gists/${gistId}` : 'https://api.github.com/gists',
        headers: {
          Authorization: 'token ' + token,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'Content-Type': 'application/json',
        },
        data: JSON.stringify(payload),
        timeout: 15000,
      });
      if (res.status < 200 || res.status >= 300) {
        return { ok: false, error: `GitHub API returned ${res.status}` };
      }
      const json = JSON.parse(res.responseText);
      if (json.id) await GM_setValue('fic_gist_id', json.id);
      return { ok: true, url: json.html_url, totalCount: merged.length, activeCount, removedCount };
    } catch (e) {
      return { ok: false, error: 'Request failed: ' + e.message };
    }
  }

  // ---- Collapsible top-of-page UI (same pattern as fasteignir-dashboard-helper) ----
  function buildUI() {
    if (!document.getElementById('fic-style')) {
      const style = document.createElement('style');
      style.id = 'fic-style';
      style.textContent = `
        #fic-box {
          background: #fff;
          border: 1px solid #ddd;
          border-radius: 8px;
          padding: 14px 16px;
          margin: 0 0 12px 0;
          font-family: inherit;
          font-size: 14px;
        }
        #fic-box .fic-section-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
        }
        #fic-box .fic-section-header h4 {
          margin: 0;
          font-size: 14px;
          color: #333;
          font-weight: 400;
        }
        #fic-box .fic-collapse-arrow {
          cursor: pointer;
          font-size: 13px;
          color: #777;
          user-select: none;
          padding: 2px 6px;
        }
        #fic-box .fic-collapse-arrow:hover { color: #333; }
        #fic-box .fic-body {
          display: none;
          margin-top: 8px;
          font-size: 13px;
          color: #333;
        }
        #fic-box .fic-row {
          display: flex;
          flex-wrap: wrap;
          gap: 8px;
          align-items: center;
        }
        #fic-box .fic-note { font-size: 11px; color: #666; }
        #fic-box textarea,
        #fic-box input[type=password] {
          padding: 4px;
          box-sizing: border-box;
          font: inherit;
        }
        #fic-box button {
          background: #3b68bc;
          color: #fff;
          border: none;
          border-radius: 5px;
          padding: 7px 12px;
          cursor: pointer;
          font-size: 13px;
        }
        #fic-box button:hover { background: #2d5099; }
        #fic-box button:disabled {
          background: #ccc;
          color: #888;
          cursor: not-allowed;
        }
      `;
      document.head.appendChild(style);
    }

    const box = document.createElement('div');
    box.id = 'fic-box';
    box.innerHTML = `
      <div id="fic-header" class="fic-section-header">
        <h4>Data Import/Export</h4>
        <span id="fic-collapse-arrow" class="fic-collapse-arrow">▸</span>
      </div>
      <div id="fic-body" class="fic-body" style="display:none;">
        <div class="fic-row">
          <button id="fic-export-properties" type="button">Load Properties</button>
          <button id="fic-load-properties" type="button">Load Property JSON</button>
          <button id="fic-clear-properties" type="button">Clear List</button>
          <button id="fic-export-properties-gist" type="button">Export Property List to Gist</button>
        </div>
        <div class="fic-note" style="margin-top:4px;">
          The top list is a scratch area for saved-property data; it does not run the ISP check.
        </div>
        <div id="fic-properties-status" style="margin-top:4px;color:#666;"></div>
        <textarea id="fic-properties-output" rows="6" readonly style="display:none;width:100%;margin-top:6px;"></textarea>
        <textarea id="fic-input" rows="6" autocomplete="off" style="width:100%;box-sizing:border-box;margin-top:6px;"></textarea>
        <div class="fic-row" style="margin-top:6px;">
          <button id="fic-load" type="button">Load from Saved Properties</button>
          <button id="fic-clear-input" type="button">Clear List</button>
          <button id="fic-run" type="button">Check and Export to Gist</button>
          <span id="fic-progress" style="color:#666;"></span>
          <span id="fic-export-status" style="color:#666;"></span>
        </div>
        <div style="margin-top:10px;padding-top:8px;border-top:1px solid #eee;font-size:12px;">
          <div id="fic-token-status" style="color:#666;margin-bottom:4px;">Checking token…</div>
          <input id="fic-token-input" type="password" placeholder="GitHub Token (Gist Scope Only)" autocomplete="off" style="width:55%;">
          <button id="fic-token-save" type="button">Save Token</button>
          <button id="fic-reset-gist" type="button" style="margin-left:6px;">Reset Gist</button>
        </div>
        <div id="fic-results" style="margin-top:10px;"></div>
      </div>
    `;

    function placeBox() {
      const openHouse = document.querySelector('#fdh-openhouse');
      const toolbar = document.querySelector('#fdh-toolbar');
      const firstCard = getCardEls()[0];
      if (openHouse) {
        openHouse.insertAdjacentElement('afterend', box);
      } else if (toolbar) {
        toolbar.insertAdjacentElement('afterend', box);
      } else if (firstCard && firstCard.parentElement) {
        firstCard.parentElement.insertAdjacentElement('beforebegin', box);
      } else if (!box.parentElement) {
        document.body.insertBefore(box, document.body.firstChild);
      }
    }
    placeBox();
    setTimeout(placeBox, 750);

    const header = box.querySelector('#fic-header');
    const body = box.querySelector('#fic-body');
    const arrow = box.querySelector('#fic-collapse-arrow');
    header.addEventListener('click', () => {
      const collapsed = getComputedStyle(body).display === 'none';
      body.style.display = collapsed ? 'block' : 'none';
      arrow.textContent = collapsed ? '▾' : '▸';
    });

    let lastResults = [];
    let lastLoadedAddresses = []; // parallel array to the loaded textarea lines, used to recover id/url for unedited lines

    function expectedDisplayLine(a) {
      return a.streetAndNumber
        ? `${a.streetAndNumber}, ${a.postcode || '???'}`
        : `${a.raw}  (!! doesn't fit expected shape, will be skipped)`;
    }

    function propertyScratchEl() {
      return box.querySelector('#fic-properties-output');
    }

    function clearPropertyScratch() {
      const outputEl = propertyScratchEl();
      outputEl.value = '';
      outputEl.style.display = 'none';
    }

    function showPropertyScratch(text) {
      const outputEl = propertyScratchEl();
      outputEl.value = '';
      outputEl.style.display = 'none';
      outputEl.value = text;
      outputEl.style.display = '';
    }

    function propertyCsvLine(property) {
      const address = normalizeWhitespace(property.streetAndNumber || String(property.raw || '').split(',')[0] || '');
      const postcode = property.postcode || '';
      const url = property.url || '';
      return `${address},${postcode},${url}`;
    }

    function appendRunLogLine(text, isWarning) {
      const resultsEl = box.querySelector('#fic-results');
      const div = document.createElement('div');
      div.style.cssText = 'border-top:1px solid #eee;padding:4px 0;' + (isWarning ? 'background:#fff3f3;' : '');
      div.textContent = text;
      resultsEl.appendChild(div);
    }

    (async () => {
      const tokenStatusEl = box.querySelector('#fic-token-status');
      const hasToken = await GM_getValue('fic_github_token', null);
      tokenStatusEl.textContent = hasToken ? 'Token: saved' : 'Token: not set';
    })();

    box.querySelector('#fic-token-save').addEventListener('click', async () => {
      const input = box.querySelector('#fic-token-input');
      const value = input.value.trim();
      if (!value) return;
      await GM_setValue('fic_github_token', value);
      input.value = ''; // don't leave the secret sitting visible in the field
      box.querySelector('#fic-token-status').textContent = 'Token: saved';
    });

    async function exportLastResults(exportBtn) {
      const statusEl = box.querySelector('#fic-export-status');
      if (lastResults.length === 0) {
        statusEl.textContent = 'Nothing to export yet - run a check first.';
        return;
      }
      if (exportBtn) exportBtn.disabled = true;
      statusEl.textContent = 'Exporting…';
      const result = await pushResultsToGist(lastResults);
      if (exportBtn) exportBtn.disabled = false;
      statusEl.innerHTML = result.ok
        ? `Exported - <a href="${result.url}" target="_blank">${result.url}</a>`
        : `Failed: ${result.error}`;
      return result;
    }

    box.querySelector('#fic-load').addEventListener('click', () => {
      lastLoadedAddresses = loadAddressesFromDashboard();
      box.querySelector('#fic-input').value = '';
      box.querySelector('#fic-input').value = lastLoadedAddresses.map(expectedDisplayLine).join('\n');
    });

    box.querySelector('#fic-clear-input').addEventListener('click', () => {
      box.querySelector('#fic-input').value = '';
      box.querySelector('#fic-progress').textContent = '';
      box.querySelector('#fic-results').innerHTML = '';
    });

    box.querySelector('#fic-load-properties').addEventListener('click', () => {
      const statusEl = box.querySelector('#fic-properties-status');
      const properties = getUniqueSavedPropertiesFromDashboard();
      if (properties.length === 0) {
        statusEl.textContent = 'No saved properties found on this dashboard page.';
        clearPropertyScratch();
        return;
      }
      showPropertyScratch(JSON.stringify(
        properties.map(({ id, url, raw, streetAndNumber, postcode, size, rooms, baths, beds, price, isTilbod }) => ({
          id,
          url,
          raw,
          streetAndNumber,
          postcode,
          size,
          rooms,
          baths,
          beds,
          price,
          isTilbod,
        })),
        null,
        2
      ));
      statusEl.textContent = `Loaded ${properties.length} unique saved properties as JSON preview.`;
    });

    box.querySelector('#fic-export-properties').addEventListener('click', () => {
      const statusEl = box.querySelector('#fic-properties-status');
      const properties = getUniqueSavedPropertiesFromDashboard();
      if (properties.length === 0) {
        statusEl.textContent = 'No saved properties found on this dashboard page.';
        clearPropertyScratch();
        return;
      }
      showPropertyScratch(
        ['Address,Postcode,URL']
          .concat(properties.map(propertyCsvLine))
          .join('\n')
      );
      statusEl.textContent = `Exported ${properties.length} saved properties as a simple list.`;
    });

    box.querySelector('#fic-clear-properties').addEventListener('click', () => {
      clearPropertyScratch();
      box.querySelector('#fic-properties-status').textContent = 'List cleared.';
    });

    box.querySelector('#fic-export-properties-gist').addEventListener('click', async () => {
      const statusEl = box.querySelector('#fic-properties-status');
      const properties = getUniqueSavedPropertiesFromDashboard();
      if (properties.length === 0) {
        statusEl.textContent = 'No saved properties found on this dashboard page.';
        return;
      }
      const exportBtn = box.querySelector('#fic-export-properties-gist');
      exportBtn.disabled = true;
      statusEl.textContent = 'Exporting property list to Gist…';
      const result = await pushPropertyListToGist(properties);
      exportBtn.disabled = false;
      if (result.ok) {
        statusEl.innerHTML =
          `Exported ${result.activeCount} saved properties, retained ${result.removedCount} removed ` +
          `(${result.totalCount} total) - <a href="${result.url}" target="_blank">${result.url}</a>`;
      } else {
        statusEl.textContent = `Failed: ${result.error}`;
      }
    });

    box.querySelector('#fic-reset-gist').addEventListener('click', async () => {
      if (!confirm('Reset the cached gist ID? This will not delete the token, but the next export will create a new gist.')) {
        return;
      }
      await GM_setValue('fic_gist_id', null);
      const statusEl = box.querySelector('#fic-properties-status');
      statusEl.textContent = 'Gist reset locally. Next export will create a new gist.';
    });

    box.querySelector('#fic-run').addEventListener('click', async () => {
      const runBtn = box.querySelector('#fic-run');
      const progressEl = box.querySelector('#fic-progress');
      const input = box.querySelector('#fic-input').value;
      // Position-matched against what was loaded there, NOT parsed from
      // text alone — a real fix, not the previous #id-in-text approach
      // (which leaked into the visible/results text and only ever worked
      // for one address out of ~190 in real testing, since the textarea
      // display never actually included the marker for normal lines).
      // An unedited line recovers its real id/url this way; an edited or
      // manually-typed line correctly falls back to id: null.
      const lines = input.split('\n');
      const addresses = lines
        .map((line, i) => {
          const loaded = lastLoadedAddresses[i];
          if (loaded && line.trim() === expectedDisplayLine(loaded).trim()) {
            return loaded;
          }
          return parseAddressLine(line);
        })
        .filter(Boolean);
      const resultsEl = box.querySelector('#fic-results');
      resultsEl.innerHTML = '';
      box.querySelector('#fic-export-status').textContent = '';
      runBtn.disabled = true;
      let done = 0;
      let lastRunStats = null;
      progressEl.textContent = `0 / ${addresses.length}`;
      const previousRunResults = lastResults.slice();
      const cachedResultsByBuilding = cachedPairForBuilding(
        (await fetchExistingGistResults()).concat(previousRunResults)
      );

      lastResults = await runBatch(addresses, (row) => {
        done++;
        progressEl.textContent = `${done} / ${addresses.length}`;
      }, cachedResultsByBuilding, (event) => {
        if (!event) return;
        lastRunStats = event.stats || lastRunStats;
        if (event.type === 'invalid') {
          appendRunLogLine(
            `${event.buildingAddress} - Mila checked -> SKIPPED, LL checked -> SKIPPED (0 ms)`,
            true
          );
          return;
        }
        if (event.type === 'done') {
          const isWarning =
            (event.milaStatus === event.llStatus && isAlertStatus(event.milaStatus)) ||
            (event.milaStatus === 'NO MATCH' && event.llStatus === 'NO MATCH');
          if (isWarning) {
            appendRunLogLine(
              `${event.buildingAddress} - Mila ${event.milaMode} -> ${event.milaStatus}, ` +
              `LL ${event.llMode} -> ${event.llStatus} (${event.durationMs} ms)`,
              true
            );
          }
        }
      });

      if (lastRunStats) {
        progressEl.textContent =
          `${done} / ${addresses.length} Complete. ` +
          `${lastRunStats.cachedNetworks} Cached. ${lastRunStats.checkedNetworks} Checked.`;
      } else {
        progressEl.textContent = `${done} / ${addresses.length} Complete.`;
      }
      await exportLastResults(runBtn);
      runBtn.disabled = false;
    });
  }

  buildUI();
})();
