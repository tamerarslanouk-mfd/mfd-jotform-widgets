/**
 * MFD Email Typo Check — JotForm Custom Widget
 *
 * Catches common email-domain typos (gmial.com → gmail.com, yahooo.com → yahoo.com,
 * hotnail.com → hotmail.com, etc.) using the open-source Mailcheck library.
 *
 * Where this fits in the validation pipeline:
 *   Layer 1 — JotForm native "Confirm Email" double-entry: catches fat-finger typos
 *             (already enabled on the production form's Personal Email field, qid 75).
 *   Layer 2 — THIS widget: catches systematic domain typos that survive double-entry
 *             (applicant types "gmial.com" twice consistently).
 *   Layer 3 — Server-side validate_jurisdiction.py runs DNS MX checks at agent
 *             review time to catch fake/non-existent domains.
 *
 * Submitted value format:
 *   - Clean email: "you@gmail.com [confirmed]"
 *   - Applicant accepted suggestion: "you@gmail.com [auto-corrected from gmial.com]"
 *   - Applicant rejected suggestion: "you@gmial.com [⚠ rejected suggestion: gmail.com]"
 *   - Invalid format: "(invalid format) [⚠ NOT SUBMITTED]"
 */

(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const els = {
    email: $("email"),
    status: $("status"),
  };

  // State
  let lastSuggestion = null; // { full, address, domain }
  let suggestionRejected = false; // Tamer needs to know if applicant ignored a suggestion
  let acceptedFrom = null; // string — what they typed before applying suggestion (if any)
  let checkTimer = null; // debounce timer for input-driven check
  const CHECK_DEBOUNCE_MS = 500;

  // -------- JotForm widget integration --------
  if (typeof JFCustomWidget !== "undefined") {
    JFCustomWidget.subscribe("ready", () => requestResize());

    JFCustomWidget.subscribe("submit", () => {
      JFCustomWidget.sendSubmit({
        valid: isValidEmail(els.email.value),
        value: formatSubmittedValue(),
      });
    });
  } else {
    console.log("[MFD Email] Standalone preview — no JFCustomWidget. UI works, no submit wiring.");
  }

  function requestResize() {
    if (typeof JFCustomWidget !== "undefined") {
      JFCustomWidget.requestFrameResize({ height: document.body.scrollHeight + 20 });
    }
  }

  // -------- Validation helpers --------
  function isValidEmail(s) {
    if (!s) return false;
    // Permissive RFC-ish syntax check; matches what JotForm itself enforces
    return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s.trim());
  }

  function formatSubmittedValue() {
    const v = (els.email.value || "").trim();
    if (!v) return "";
    if (!isValidEmail(v)) return `(invalid format) [⚠ NOT SUBMITTED]`;
    if (acceptedFrom) return `${v} [auto-corrected from ${acceptedFrom}]`;
    if (suggestionRejected && lastSuggestion) {
      return `${v} [⚠ rejected suggestion: ${lastSuggestion.full}]`;
    }
    return `${v} [confirmed]`;
  }

  // -------- Mailcheck wiring --------
  els.email.addEventListener("input", onEmailInput);
  els.email.addEventListener("blur", runCheck);
  els.email.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault(); // don't submit any parent form on Enter inside this widget
      if (checkTimer) clearTimeout(checkTimer);
      runCheck();
    }
  });

  function onEmailInput() {
    // Reset state on each keystroke that changes the value materially
    suggestionRejected = false;
    acceptedFrom = null;
    lastSuggestion = null;
    els.status.hidden = true;
    requestResize();
    // Schedule a debounced check — fires ~500ms after the user stops typing
    if (checkTimer) clearTimeout(checkTimer);
    checkTimer = setTimeout(runCheck, CHECK_DEBOUNCE_MS);
  }

  // Bump mailcheck's similarity tolerance so 3-char-distance typos get caught
  // (gmaillll vs gmail = distance 3; yahooooo vs yahoo = distance 3, etc.)
  // Defaults are 2 for all three thresholds — too conservative for our $76-$228 mistake cost.
  Mailcheck.domainThreshold = 3;
  Mailcheck.secondLevelThreshold = 3;
  Mailcheck.topLevelThreshold = 2;

  // Popular domains we explicitly check for "stuck-key" typos that survive mailcheck
  // (e.g., gmaillllll vs gmail, distance > 3 won't trigger mailcheck, but obvious to a human)
  const POPULAR_DOMAINS = [
    "gmail.com", "yahoo.com", "hotmail.com", "outlook.com", "aol.com",
    "icloud.com", "me.com", "mac.com", "msn.com", "live.com",
    "comcast.net", "verizon.net", "att.net", "sbcglobal.net", "optonline.net",
    "cox.net", "earthlink.net", "bellsouth.net", "ymail.com", "rocketmail.com",
    "googlemail.com", "protonmail.com", "proton.me",
  ];

  // Detect "stuck key" typos: domain has 3+ consecutive identical characters that, when
  // collapsed to 1 or 2, match a popular domain. Catches gmaillll, yahooooo, hotmaillll, etc.
  function detectStuckKey(email) {
    const m = email.match(/^([^@]+)@(.+)$/);
    if (!m) return null;
    const local = m[1];
    const domain = m[2].toLowerCase();
    if (POPULAR_DOMAINS.includes(domain)) return null; // already a known good domain

    // Try collapsing 3+ repeats to 1 char: "gmaillll" -> "gmail"
    const collapsed1 = domain.replace(/(.)\1{2,}/g, "$1");
    // Try collapsing 3+ repeats to 2 chars: "yahoooo" -> "yahoo"
    const collapsed2 = domain.replace(/(.)\1{2,}/g, "$1$1");

    for (const candidate of [collapsed1, collapsed2]) {
      if (candidate !== domain && POPULAR_DOMAINS.includes(candidate)) {
        return { full: `${local}@${candidate}`, address: local, domain: candidate };
      }
    }
    return null;
  }

  function runCheck() {
    if (checkTimer) {
      clearTimeout(checkTimer);
      checkTimer = null;
    }
    const v = (els.email.value || "").trim();
    if (!v) {
      els.status.hidden = true;
      requestResize();
      return;
    }

    if (!isValidEmail(v)) {
      showInvalid("This doesn't look like a valid email address. Please re-check it.");
      return;
    }

    // First try mailcheck (catches single-char typos within threshold)
    let suggestion = null;
    Mailcheck.run({
      email: v,
      suggested: (s) => { suggestion = s; },
      empty: () => { suggestion = null; },
    });

    // Fall back to stuck-key detector for runs of 3+ repeats that mailcheck misses
    if (!suggestion) {
      suggestion = detectStuckKey(v);
    }

    if (suggestion) {
      lastSuggestion = suggestion;
      showSuggestion(v, suggestion);
    } else {
      showMatch(v);
    }
  }

  function showSuggestion(typed, suggestion) {
    els.status.hidden = false;
    els.status.className = "status suggest";
    els.status.innerHTML = `
      <div><strong>⚠️ Possible typo</strong></div>
      <div style="margin-top:6px">You typed: <strong>${escapeHtml(typed)}</strong></div>
      <div style="margin-top:4px">Did you mean:</div>
      <div class="suggested">${escapeHtml(suggestion.full)}</div>
      <div class="actions">
        <button type="button" class="btn-fix" onclick="window.__mfd_acceptSuggestion()">Yes — fix it for me</button>
        <button type="button" class="btn-keep" onclick="window.__mfd_rejectSuggestion()">No — keep what I typed</button>
      </div>
    `;
    window.__mfd_acceptSuggestion = () => {
      acceptedFrom = els.email.value.trim();
      els.email.value = suggestion.full;
      lastSuggestion = null;
      suggestionRejected = false;
      showMatch(suggestion.full, true);
    };
    window.__mfd_rejectSuggestion = () => {
      suggestionRejected = true;
      els.status.className = "status invalid";
      els.status.innerHTML = `
        <div><strong>⚠ Going with what you typed: <code>${escapeHtml(typed)}</code></strong></div>
        <div style="margin-top:4px;font-size:12px">Tamer will be alerted to double-check this address before filing the application.</div>
      `;
      requestResize();
    };
    requestResize();
  }

  function showMatch(email, fromCorrection = false) {
    els.status.hidden = false;
    els.status.className = "status match";
    const prefix = fromCorrection ? "✓ Corrected" : "✓ Looks good";
    els.status.innerHTML = `<div><strong>${prefix}:</strong> <code>${escapeHtml(email)}</code></div>`;
    requestResize();
  }

  function showInvalid(msg) {
    els.status.hidden = false;
    els.status.className = "status invalid";
    els.status.innerHTML = `<div><strong>${escapeHtml(msg)}</strong></div>`;
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
