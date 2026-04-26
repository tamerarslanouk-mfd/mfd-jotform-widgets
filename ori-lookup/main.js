/**
 * MFD ORI Lookup — JotForm Custom Widget
 *
 * Resolves an applicant's NJ home address to the correct ORI (Originating Agency Identifier),
 * which determines which police department processes their firearms application.
 *
 * Strategy:
 *   1. User types street + city + ZIP (defaults to NJ)
 *   2. Widget calls US Census Geocoder (free, no key) → returns legal Minor Civil Division (MCD)
 *   3. Widget looks up the MCD in bundled ori-data.json → returns matching ORI
 *   4. If geocoder ambiguous or fails, widget falls back to fuzzy name match on the city as typed
 *   5. Manual override: searchable dropdown of all 563 NJ municipalities
 *   6. Special-case warnings (Newark NJNPD0000 vs deprecated NJ0071400, etc.) shown prominently
 *
 * Submitted value: "ORI: NJ0020100 — Paramus PD (Bergen County)"  (free-text suitable for the
 *   existing "What Police Department serves your Jurisdiction?" field on the form)
 */

(function () {
  "use strict";

  // -------- DOM refs --------
  const $ = (id) => document.getElementById(id);
  const els = {
    street: $("street"),
    city: $("city"),
    zip: $("zip"),
    findBtn: $("find-btn"),
    result: $("result"),
    muniSearch: $("muni-search"),
    muniList: $("muni-list"),
    selected: $("selected"),
    selectedValue: $("selected-value"),
    clearBtn: $("clear-btn"),
  };

  // -------- State --------
  let oriData = null;
  let hardBlocks = null; // { hard_block: {ori: {...}}, warn_unverified: {oris_pending_verification: [...]} }
  let warnIndex = {}; // {ori: warn_entry} built from hardBlocks.warn_unverified
  let njspByOri = {}; // {ori: {station, email, troop}} from authoritative NJSP scrape
  let zipToMunis = null; // {by_zip: {zip5: [{municipality, county, ori, ...}, ...]}}
  let stripIndex = {}; // {normalized_base_name: [muni_key, ...]}, built at load time
  let selectedEntry = null; // { municipality, county, ori, display_name, ... }
  let selectedConfidence = null; // "verified-census" | "verified-zip-disambiguation" | "manual-pick" | etc.

  // -------- Initialization --------
  Promise.all([
    fetch("ori-data.json").then((r) => r.json()),
    fetch("ori-hard-blocks.json").then((r) => r.json()),
    fetch("njsp-barracks.json").then((r) => r.json()),
    fetch("zip-to-munis.json").then((r) => r.json()),
  ])
    .then(([data, blocks, njsp, zips]) => {
      oriData = data;
      hardBlocks = blocks;
      zipToMunis = zips;
      buildStripIndex();
      buildWarnIndex();
      buildNjspIndex(njsp);
      console.log(
        `[MFD ORI] Loaded ${oriData._meta.total_municipalities} munis, ${Object.keys(hardBlocks.hard_block).length} hard-blocks, ${Object.keys(warnIndex).length} warn-unverified, ${Object.keys(njspByOri).length} NJSP barracks, ${zipToMunis._meta.total_zips} ZIPs (${zipToMunis._meta.multi_muni_zips} span multiple munis)`
      );
      attachListeners();
      renderManualList(oriData.all);
    })
    .catch((err) => {
      console.error("[MFD ORI] Failed to load data files", err);
      showError("Could not load the ORI database. Please refresh the page or pick manually below.");
    });

  function buildNjspIndex(njsp) {
    njspByOri = {};
    for (const e of (njsp.entries || [])) {
      njspByOri[e.ori] = e;
    }
  }

  // Find the NJSP station info for a given likely_route string (e.g., "NJNSP2200" or
  // "NJNSP2200 or NJNSP2800"). Returns array of {ori, station, email, troop} for each
  // ORI mentioned, ignoring uncertainty markers.
  function njspContactsFor(likelyRoute) {
    if (!likelyRoute) return [];
    const orisMentioned = (likelyRoute.match(/NJNSP\d{4}/g) || []);
    return orisMentioned
      .map((o) => njspByOri[o])
      .filter(Boolean);
  }

  function buildWarnIndex() {
    warnIndex = {};
    const list = hardBlocks?.warn_unverified?.oris_pending_verification || [];
    for (const w of list) {
      warnIndex[w.ori] = w;
    }
  }

  // -------- JotForm widget integration --------
  // JFCustomWidget is provided by the JotForm widget host iframe shim. When the widget runs
  // standalone (local preview), JFCustomWidget is undefined — we still want the UI to work.
  if (typeof JFCustomWidget !== "undefined") {
    JFCustomWidget.subscribe("ready", function () {
      requestResize();
    });

    JFCustomWidget.subscribe("submit", function () {
      const value = formatSubmittedValue();
      JFCustomWidget.sendSubmit({
        valid: true, // The widget value is optional — never block submission
        value: value,
      });
    });
  } else {
    console.log("[MFD ORI] Running standalone (no JFCustomWidget). UI fully functional, no submit wiring.");
  }

  // -------- Auto-fill from URL parameters (set by JotForm placeholder substitution) --------
  // The iframe URL is set to:
  //   .../ori-lookup/?street={UserStreetAddress}&city={UserCity}&state={UserState}&zip={UserZipCode}
  // JotForm substitutes the {field} placeholders with the live values from the form's
  // address fields. The widget reads these from window.location.search on load and
  // auto-runs the ORI lookup — no retyping by the applicant.
  function autoPopulateFromUrl() {
    if (!oriData) return; // wait for data load
    const params = new URLSearchParams(window.location.search);
    const street = (params.get("street") || "").trim();
    const city = (params.get("city") || "").trim();
    const zip = (params.get("zip") || "").trim();
    // state is implicit NJ for our use case — ignore for lookup

    // Skip if all empty (placeholders weren't substituted, or applicant hasn't filled them yet)
    if (!street && !city && !zip) {
      console.log("[MFD ORI] No URL params provided — manual entry mode.");
      return;
    }

    // Skip if placeholders came through unsubstituted (looks like literal "{UserCity}")
    const looksLikePlaceholder = (s) => /^\{[A-Za-z]+\}$/.test(s);
    if (looksLikePlaceholder(street) || looksLikePlaceholder(city) || looksLikePlaceholder(zip)) {
      console.log("[MFD ORI] URL params look like unsubstituted placeholders — manual entry mode.");
      return;
    }

    // Pre-fill the inputs (visible to applicant as confirmation that we have their address)
    if (street) els.street.value = street;
    if (city) els.city.value = city;
    if (zip) els.zip.value = zip;
    updateFindButton();

    // Auto-run lookup. Prefer ZIP-based disambiguation (instant, deterministic) before geocoding.
    if (zip && zip.length === 5) {
      onZipChanged();
      // ZIP lookup may resolve immediately for single-muni ZIPs.
      // For multi-muni ZIPs, the warning UI is shown and applicant picks.
    }

    // If ZIP is single-muni and we have a street address too, also run the geocoder for
    // additional confidence (this confirms the muni Census says you're in matches the
    // ZIP-derived muni). Skip if the ZIP-warn UI is visible (multi-muni case — let user pick).
    if (street && zip) {
      // Small delay so onZipChanged() can render its UI first
      setTimeout(() => {
        if (!els.findBtn.disabled) {
          findByAddress();
        }
      }, 100);
    }
  }

  // Hook into the data-load callback so autoPopulate runs once oriData is ready
  // (the existing fetch chain calls attachListeners + renderManualList — append our auto-fill)
  const _origAttachListeners = attachListeners;
  attachListeners = function () {
    _origAttachListeners.apply(this, arguments);
    autoPopulateFromUrl();
  };

  function requestResize() {
    if (typeof JFCustomWidget !== "undefined") {
      // Estimate height from rendered DOM
      const height = document.body.scrollHeight + 20;
      JFCustomWidget.requestFrameResize({ height });
    }
  }

  function formatSubmittedValue() {
    if (!selectedEntry) return "";
    const e = selectedEntry;
    const conf = selectedConfidence || "unknown";
    const base = `ORI: ${e.ori} — ${e.display_name || e.municipality} PD (${e.county} County)`;

    // High-confidence (Census-verified, ZIP-disambiguated by user, or future fid-card-direct) — clean single line
    if (
      conf === "verified-census" ||
      conf === "verified-multi-geocoder" ||
      conf === "verified-zip-disambiguation" ||
      conf === "fid-card-direct"
    ) {
      return `${base} [${conf}]`;
    }

    // Unverified-confirmed: applicant clicked through the warning. Make this LOUD in the inbox
    // so Tamer sees the action item at a glance.
    if (conf === "unverified-confirmed") {
      const warn = warnIndex[e.ori];
      const njspContacts = warn ? njspContactsFor(warn.likely_route) : [];
      const contactLine = njspContacts.length
        ? ` Email ${njspContacts.map((c) => c.email).join(" or ")} to confirm.`
        : " Call the PD records bureau to confirm.";
      const likely = warn?.likely_route ? ` Likely actual: ${warn.likely_route}.` : "";
      return `⚠️ NEEDS VERIFY BEFORE FILING — ${base}.${likely}${contactLine} [${conf}]`;
    }

    // Manual/disambiguation paths — flag for review but less urgently
    if (conf === "manual-after-census-fail" || conf === "manual-disambiguation" || conf === "manual-pick") {
      return `⚠ REVIEW — ${base} [${conf}]`;
    }

    return `${base} [${conf}]`;
  }

  // -------- Listeners --------
  function attachListeners() {
    [els.street, els.city, els.zip].forEach((el) => {
      el.addEventListener("input", updateFindButton);
    });
    els.zip.addEventListener("input", onZipChanged);
    els.findBtn.addEventListener("click", findByAddress);
    els.muniSearch.addEventListener("input", filterManualList);
    els.clearBtn.addEventListener("click", clearSelection);
  }

  function updateFindButton() {
    const ready = els.street.value.trim() && els.city.value.trim() && els.zip.value.trim().length === 5;
    els.findBtn.disabled = !ready;
  }

  // PROACTIVE multi-muni ZIP warning — fires the moment user types a 5-digit ZIP.
  // This catches the postal-vs-legal trap at its earliest possible moment, BEFORE
  // any geocoding or city-name guessing happens.
  function onZipChanged() {
    const zip = els.zip.value.trim();
    if (zip.length !== 5 || !zipToMunis) return;
    const munis = zipToMunis.by_zip[zip];
    if (!munis || munis.length === 0) return;

    if (munis.length === 1) {
      // Single muni — silent confirmation, no warning needed
      const m = munis[0];
      if (m.matched_in_ori_table && m.ori) {
        showZipMatched(zip, m);
      }
      return;
    }

    // Multi-muni ZIP — show the proactive warning with picker
    showZipMultiMuniWarning(zip, munis);
  }

  function showZipMatched(zip, muni) {
    // Subtle "we got you" confirmation for single-muni ZIPs
    els.result.hidden = false;
    els.result.className = "result match";
    els.result.innerHTML = `<div style="font-size:13px"><strong>ZIP ${escapeHtml(zip)}</strong> = ${escapeHtml(muni.municipality)} (${escapeHtml(muni.county)} County). You can either fill the rest of your address and click "Find My Police Department" to verify, or skip ahead and we'll use this match.</div>`;
    requestResize();
  }

  function showZipMultiMuniWarning(zip, munis) {
    let html = `<h3>⚠️ ZIP ${escapeHtml(zip)} covers ${munis.length} legal municipalities</h3>
      <div style="margin-top:8px">Your <strong>postal city</strong> may be different from your <strong>legal town</strong>. Each town has a different police department and ORI. <strong>Pick the legal town where you actually live</strong> — if you're unsure, look at your most recent property tax bill or vehicle registration.</div>
      <div style="margin-top:12px;padding:10px;background:#fffaf0;border:2px solid #d69e2e;border-radius:4px"><strong>Why this matters:</strong> Using the wrong town's ORI causes the application to misroute. You'll lose $76–$228 in non-refundable fees and wait weeks for the wrong police department to formally withdraw your application before you can resubmit.</div>
      <div style="margin-top:12px"><strong>Which is YOUR legal town?</strong></div>
      <div class="candidates" style="margin-top:6px">`;

    munis.forEach((m, i) => {
      const ori = m.ori || "(needs verification)";
      const ck = m.matched_in_ori_table ? "✓" : "?";
      html += `<button type="button" class="candidate-btn" onclick="window.__mfd_pickZipCand(${i})">
        ${ck} <strong>${escapeHtml(m.municipality)}</strong> <small>${escapeHtml(m.county)} County · ORI ${escapeHtml(ori)}</small>
      </button>`;
    });
    html += `</div>
      <div style="margin-top:10px;font-size:12px;color:#4a5568">Or continue typing your full street address and click "Find My Police Department" — we'll geocode and try to determine your legal town from the address.</div>`;

    els.result.hidden = false;
    els.result.className = "result warning";
    els.result.innerHTML = html;
    window.__mfd_pickZipCand = (i) => {
      const muni = munis[i];
      if (!muni.matched_in_ori_table || !muni.ori) {
        // Use Census name as fallback display
        showError(`We don't have an ORI on file for ${muni.municipality} (${muni.county}). Please pick from the manual list below — search by partial name.`);
        return;
      }
      const oriEntry = oriData.by_municipality[`${muni.municipality} (${muni.county})`] || null;
      if (oriEntry) acceptEntry(oriEntry, "verified-zip-disambiguation");
      else showError("Internal error — could not look up ORI entry. Please pick manually below.");
    };
    requestResize();
  }

  // -------- Address lookup (Census Geocoder + ORI table) --------
  async function findByAddress() {
    const street = els.street.value.trim();
    const city = els.city.value.trim();
    const zip = els.zip.value.trim();

    showLoading("Looking up your municipality…");
    els.findBtn.disabled = true;

    try {
      // Census Geocoder — geographies endpoint returns all layer types including County
      // Subdivisions (= legal MCD in NJ). Don't filter by layers= — the filter sometimes
      // returns 0 matches on otherwise-resolvable addresses.
      const oneline = `${street}, ${city}, NJ ${zip}`;
      const url =
        "https://geocoding.geo.census.gov/geocoder/geographies/onelineaddress" +
        "?address=" + encodeURIComponent(oneline) +
        "&benchmark=Public_AR_Current" +
        "&vintage=Current_Current" +
        "&format=json";

      const resp = await fetch(url);
      if (!resp.ok) throw new Error(`Census Geocoder HTTP ${resp.status}`);
      const data = await resp.json();

      const matches = data.result?.addressMatches || [];
      if (!matches.length) {
        // Geocoder couldn't find the address → fall back to fuzzy city match
        return tryFuzzyCity(city);
      }

      const match = matches[0];
      const subs = match.geographies?.["County Subdivisions"] || [];
      if (!subs.length) {
        // Address found but no County Subdivision → fall back
        return tryFuzzyCity(city);
      }

      // The MCD name from Census looks like "Paramus borough" or "Hopewell township"
      // Our ORI table has "Paramus" / "Hopewell Township (Cumberland)" — normalize and match
      const mcdName = subs[0].NAME || ""; // e.g. "Paramus borough"
      const stateAbbr = subs[0].STATE || "34"; // 34 = NJ
      if (stateAbbr !== "34") {
        showError(
          `Address geocoded to a non-NJ jurisdiction (${stateAbbr}). MFD's NJ ORI list won't help here — pick manually below if you're applying as an out-of-state resident.`
        );
        return;
      }

      const matchedEntry = findMuniByCensusName(mcdName);
      if (matchedEntry) {
        showMatch(matchedEntry, `Your address is in ${capitalizeMcd(mcdName)}, ${matchedEntry.county} County.`);
      } else {
        // Census returned an MCD but our ORI table doesn't have it (rare — would mean a missing
        // entry in NJ_ORI_Master_List.xlsx). Surface the disambiguation rather than guessing.
        const base = normalizeMuniName(mcdName);
        const keys = stripIndex[base] || [];
        if (keys.length > 1) {
          const candidates = keys.map((k) => oriData.by_municipality[k]);
          showCandidates(candidates, `Geocoder matched "${capitalizeMcd(mcdName)}" — but that name exists in multiple NJ counties. Pick the right one:`);
        } else {
          console.warn(`[MFD ORI] Census returned MCD "${mcdName}" but no matching ORI entry`);
          showUnverifiedFallback([], mcdName);
        }
      }
    } catch (err) {
      console.error("[MFD ORI] Geocoder error", err);
      // Network or API failure → still try fuzzy match
      tryFuzzyCity(city);
    } finally {
      updateFindButton();
    }
  }

  function tryFuzzyCity(cityName) {
    // CRITICAL: This function is called when Census Geocoder failed. We must NEVER auto-select
    // an ORI based on the typed city alone — postal cities frequently differ from legal
    // municipalities (e.g., "Matawan" mailing addresses are often legally in Aberdeen Township
    // and route to a different police department / ORI). Show the candidate with a strong
    // warning that the user must verify before accepting.
    if (!cityName) return showUnverifiedFallback([], "Couldn't resolve your address.");
    const base = normalizeMuniName(cityName);
    const keys = stripIndex[base] || [];
    const candidates = keys.map((k) => oriData.by_municipality[k]);
    showUnverifiedFallback(candidates, cityName);
  }

  function showUnverifiedFallback(candidates, typedCity) {
    let html = `<h3>⚠️ NOT VERIFIED — Please confirm manually</h3>
      <div>We couldn't verify your address with the official US Census database. This often happens with:
        <ul style="margin:6px 0 6px 18px;padding:0">
          <li>Newer construction or rural addresses</li>
          <li>Apartment numbers or PO Boxes</li>
          <li>Addresses where the <strong>postal city</strong> differs from the <strong>legal town</strong> (a common NJ trap — e.g., a "Matawan" mailing address may legally be in Aberdeen Township and route to a different police department)</li>
        </ul>
      </div>`;

    if (candidates.length) {
      html += `<div style="margin-top:10px"><strong>Possible matches based on what you typed ("${escapeHtml(typedCity)}"):</strong></div>
        <div class="candidates">`;
      candidates.forEach((entry, i) => {
        html += `<button type="button" class="candidate-btn" onclick="window.__mfd_pickCand(${i})">
          ${escapeHtml(entry.display_name || entry.municipality)} <small>${escapeHtml(entry.county)} County · ORI ${escapeHtml(entry.ori)}</small>
        </button>`;
      });
      html += `</div>`;
      window.__mfd_pickCand = (i) => acceptEntry(candidates[i], "manual-after-census-fail");
    }

    html += `<div style="margin-top:12px;padding:10px;background:#fff5f5;border-left:3px solid #c53030;font-size:12px;color:#742a2a">
      <strong>Most reliable answer:</strong> if you have an existing NJ FID Card or Carry Permit, look at the <em>Issuing Authority</em> printed on it — that's your correct police department. Then find that town in the manual list below.
    </div>`;

    els.result.hidden = false;
    els.result.className = "result error";
    els.result.innerHTML = html;
    requestResize();
  }

  function normalizeMuniName(s) {
    // Strip common NJ geo-type suffixes so Census's "Hopewell township" matches our
    // display-name "Hopewell Township", "Paramus borough" matches "Paramus", etc.
    return String(s || "")
      .toLowerCase()
      .replace(/\s+(borough|boro|township|twp|city|town|village)\s*$/i, "")
      .trim();
  }

  function buildStripIndex() {
    stripIndex = {};
    for (const entry of oriData.all) {
      const base = normalizeMuniName(entry.display_name || entry.municipality);
      if (!stripIndex[base]) stripIndex[base] = [];
      stripIndex[base].push(makeKey(entry));
    }
  }

  function findMuniByCensusName(censusName) {
    const base = normalizeMuniName(censusName);
    const keys = stripIndex[base];
    if (!keys || !keys.length) return null;
    if (keys.length === 1) return oriData.by_municipality[keys[0]];
    // Multiple matches — without county info we can't disambiguate. Return null so caller
    // can show a candidate picker via tryFuzzyCity().
    return null;
  }

  function capitalizeMcd(s) {
    return s.replace(/\w\S*/g, (t) => t.charAt(0).toUpperCase() + t.substr(1).toLowerCase());
  }

  // -------- Result rendering --------
  function showLoading(msg) {
    els.result.hidden = false;
    els.result.className = "result";
    els.result.innerHTML = `<div>${escapeHtml(msg)} <span class="loading"></span></div>`;
    requestResize();
  }

  function showMatch(entry, contextMsg) {
    // showMatch is now ONLY called for verified Census Geocoder hits, never for fuzzy fallbacks.
    // Fuzzy fallbacks go through showUnverifiedFallback() which forces explicit user confirmation.
    const cls = entry.has_special_case ? "warning" : "match";
    const headerIcon = entry.has_special_case ? "⚠️" : "✓";
    const headerText = entry.has_special_case
      ? "Match found — but this town has a special case"
      : "Verified by US Census Geocoder";

    let html = `
      <h3>${headerIcon} ${escapeHtml(headerText)}</h3>
      <div>${escapeHtml(contextMsg)}</div>
      <div class="ori-code">${escapeHtml(entry.ori)} — ${escapeHtml(entry.display_name || entry.municipality)} PD</div>
    `;

    if (entry.has_special_case && entry.special_case_explanation) {
      html += `<div style="margin-top:8px"><strong>Important:</strong> ${escapeHtml(entry.special_case_explanation)}</div>`;
    } else if (entry.notes) {
      html += `<div style="margin-top:8px;color:#4a5568;font-size:12px">Note: ${escapeHtml(entry.notes)}</div>`;
    }

    if (entry.historical_ori) {
      html += `<div style="margin-top:6px;color:#742a2a;font-size:12px">⚠ Never use the legacy ORI: <code>${escapeHtml(entry.historical_ori)}</code></div>`;
    }

    html += `<button type="button" class="accept-btn" onclick="window.__mfd_accept()">Use this ORI</button>`;

    els.result.hidden = false;
    els.result.className = `result ${cls}`;
    els.result.innerHTML = html;

    window.__mfd_pending = entry;
    window.__mfd_accept = () => acceptEntry(entry, "verified-census");
    requestResize();
  }

  function showCandidates(candidates, contextMsg) {
    let html = `<h3>Multiple matches</h3><div>${escapeHtml(contextMsg)}</div><div class="candidates">`;
    candidates.forEach((entry, i) => {
      html += `<button type="button" class="candidate-btn" onclick="window.__mfd_pickCand(${i})">
        ${escapeHtml(entry.display_name || entry.municipality)} <small>${escapeHtml(entry.county)} County · ORI ${escapeHtml(entry.ori)}</small>
      </button>`;
    });
    html += `</div>`;
    els.result.hidden = false;
    els.result.className = "result match";
    els.result.innerHTML = html;
    window.__mfd_pickCand = (i) => acceptEntry(candidates[i], "manual-disambiguation");
    requestResize();
  }

  function showError(msg) {
    els.result.hidden = false;
    els.result.className = "result error";
    els.result.innerHTML = `<h3>Couldn't find a match</h3><div>${escapeHtml(msg)}</div>`;
    requestResize();
  }

  // -------- Manual override list --------
  function renderManualList(entries) {
    // Sort alphabetically by display_name for stable browsing
    const sorted = [...entries].sort((a, b) =>
      (a.display_name || a.municipality).localeCompare(b.display_name || b.municipality)
    );
    const html = sorted
      .map(
        (e, i) => `
      <div class="muni-item${e.has_special_case ? " special" : ""}" tabindex="0" data-key="${escapeHtml(makeKey(e))}">
        ${escapeHtml(e.display_name || e.municipality)}<span class="county">(${escapeHtml(e.county)})</span>
        <span class="ori">${escapeHtml(e.ori)}</span>
      </div>`
      )
      .join("");
    els.muniList.innerHTML = html;
    // Click + keyboard handlers
    els.muniList.querySelectorAll(".muni-item").forEach((node) => {
      node.addEventListener("click", () => onManualPick(node));
      node.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onManualPick(node);
        }
      });
    });
  }

  function onManualPick(node) {
    const key = node.dataset.key;
    const entry = oriData.by_municipality[key];
    if (entry) acceptEntry(entry, "manual-pick");
  }

  function makeKey(entry) {
    // Mirror tools/build_ori_lookup.py municipality_key()
    const muni = entry.municipality;
    const county = entry.county;
    const lc = muni.toLowerCase();
    if (lc.endsWith(`(${county.toLowerCase()})`)) return muni;
    return `${muni} (${county})`;
  }

  function filterManualList() {
    const q = els.muniSearch.value.toLowerCase().trim();
    if (!q) return renderManualList(oriData.all);
    const filtered = oriData.all.filter((e) => {
      return (
        (e.display_name || e.municipality).toLowerCase().includes(q) ||
        e.county.toLowerCase().includes(q) ||
        (e.ori || "").toLowerCase().includes(q)
      );
    });
    renderManualList(filtered);
  }

  // -------- Selection --------
  function acceptEntry(entry, confidence) {
    // STAGE 1: Hard-block check — refuse known-dead ORIs that cause $76-$228 cancellations.
    const block = hardBlocks?.hard_block?.[entry.ori];
    if (block) {
      showHardBlock(entry, block);
      return; // never accept a hard-blocked entry
    }

    // STAGE 2: Warn-unverified — entry is in our XLSX but FBI doesn't list it; likely State-Police
    // patrolled and the muni-format ORI is stale. Require explicit user confirmation.
    const warn = warnIndex[entry.ori];
    if (warn && confidence !== "unverified-confirmed") {
      showWarnUnverified(entry, warn);
      return;
    }

    selectedEntry = entry;
    selectedConfidence = confidence || "unknown";
    els.selected.hidden = false;
    els.selectedValue.textContent = formatSubmittedValue();
    els.result.hidden = true;
    requestResize();
  }

  function showHardBlock(entry, block) {
    let html = `<h3>🛑 BLOCKED — This ORI is known to cause application cancellation</h3>
      <div style="margin-top:8px"><strong>You picked:</strong> ${escapeHtml(entry.display_name || entry.municipality)} (${escapeHtml(entry.county)}) → <code>${escapeHtml(entry.ori)}</code></div>
      <div style="margin-top:10px;padding:10px;background:#fff5f5;border:2px solid #c53030;border-radius:4px">
        <strong>Was:</strong> ${escapeHtml(block.was)}<br>
        <strong>Reason:</strong> ${escapeHtml(block.reason)}<br>
        <strong>Effective:</strong> ${escapeHtml(block.effective)}
      </div>
      <div style="margin-top:10px"><strong>Use this instead:</strong></div>
      <div class="ori-code">${escapeHtml(block.use_instead)} — ${escapeHtml(block.use_instead_name)}</div>`;
    if (block.use_instead === "VERIFY_WITH_CCPD" || block.use_instead.startsWith("VERIFY")) {
      html += `<div style="margin-top:10px;color:#742a2a"><strong>Action required:</strong> Call the receiving PD's records bureau to confirm the exact routing ORI before submitting.</div>`;
    }
    if (block.source) {
      html += `<div style="margin-top:8px;font-size:11px;color:#4a5568">Source: <a href="${escapeHtml(block.source)}" target="_blank" rel="noopener">${escapeHtml(block.source)}</a></div>`;
    }
    els.result.hidden = false;
    els.result.className = "result error";
    els.result.innerHTML = html;
    requestResize();
  }

  function showWarnUnverified(entry, warn) {
    const njspContacts = njspContactsFor(warn.likely_route);

    let html = `<h3>⚠️ UNVERIFIED — verify with the police department BEFORE submitting</h3>
      <div style="margin-top:8px"><strong>You picked:</strong> ${escapeHtml(entry.display_name || entry.municipality)} (${escapeHtml(entry.county)}) → <code>${escapeHtml(entry.ori)}</code></div>
      <div style="margin-top:10px;padding:10px;background:#fffaf0;border:2px solid #d69e2e;border-radius:4px">
        <strong>Why this warning:</strong> Our records show ORI <code>${escapeHtml(entry.ori)}</code> but the FBI's current database does not list it. This town is most likely <strong>State-Police-patrolled</strong> now, and the actual routing ORI is probably <code>${escapeHtml(warn.likely_route)}</code>.
      </div>`;

    if (njspContacts.length) {
      html += `<div style="margin-top:10px"><strong>Verify by emailing the patrolling NJSP barracks directly:</strong></div>
        <div style="margin-top:6px;padding:10px;background:#ebf8ff;border:1px solid #4299e1;border-radius:4px;font-size:13px">`;
      for (const c of njspContacts) {
        html += `<div style="margin:4px 0"><code>${escapeHtml(c.ori)}</code> — ${escapeHtml(c.station)} (Troop ${escapeHtml(c.troop)}) — <a href="mailto:${escapeHtml(c.email)}?subject=ORI verification for ${escapeHtml(entry.display_name || entry.municipality)}, ${escapeHtml(entry.county)} County" style="color:#2b6cb0">${escapeHtml(c.email)}</a></div>`;
      }
      html += `</div>`;
    } else {
      html += `<div style="margin-top:10px"><strong>Recommended action:</strong> Call the local police department's records bureau (or the patrolling NJSP barracks) to confirm the current correct ORI.</div>`;
    }

    html += `<div style="margin-top:10px;color:#742a2a;font-weight:600">Submitting the wrong ORI costs $76–$228 in non-refundable fees and weeks of delay.</div>`;
    if (warn.notes) {
      html += `<div style="margin-top:8px;font-size:12px;color:#4a5568"><strong>Note:</strong> ${escapeHtml(warn.notes)}</div>`;
    }
    html += `<div style="margin-top:14px;display:flex;gap:8px;flex-wrap:wrap">
      <button type="button" class="accept-btn" style="background:#a0aec0;flex:1;min-width:200px" onclick="window.__mfd_acceptUnverified()">I VERIFIED with the PD — proceed with this ORI</button>
      <button type="button" class="accept-btn" style="background:#fff;color:#742a2a;border:2px solid #742a2a;flex:1;min-width:200px" onclick="window.__mfd_clearAfterWarn()">Cancel — I'll verify first</button>
    </div>`;
    els.result.hidden = false;
    els.result.className = "result warning";
    els.result.innerHTML = html;
    window.__mfd_acceptUnverified = () => acceptEntry(entry, "unverified-confirmed");
    window.__mfd_clearAfterWarn = () => {
      els.result.hidden = true;
      requestResize();
    };
    requestResize();
  }

  function clearSelection() {
    selectedEntry = null;
    selectedConfidence = null;
    els.selected.hidden = true;
    requestResize();
  }

  // -------- Helpers --------
  function escapeHtml(s) {
    if (s == null) return "";
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }
})();
