(function () {
  'use strict';


  // ─── Customer list ────────────────────────────────────────────────────────────

  let customers = [];

  // Remote-control config (set by admin). Defaults keep full protection on if the
  // config hasn't loaded yet or the backend is unreachable.
  const DEFAULT_CONFIG = {
    enabled: true, enforcement: 'block', scan_hyperlinks: true,
    scan_subject: true, highlight: true, message_title: null, message_body: null,
    ignore_orgs: null
  };
  let config = { ...DEFAULT_CONFIG };

  // Instant LOCAL suppression (glitch fix). When the analyst reports a false
  // positive or snoozes a ticket, we immediately add the ticket (and, for FP,
  // the org) here so validate() skips it right away — the warning clears
  // instantly and never reappears, independent of backend latency / the 402.
  // Backend quarantine + logging still fire best-effort in the background.
  const suppressedTickets = new Set(); // by ticket id
  const suppressedOrgs    = new Set(); // by lowercased org name

  // Guard top-level extension-API access. When the extension is reloaded or
  // updated, an already-open tab's content script keeps running with a torn-down
  // `chrome.*` (context invalidated) — an unguarded chrome.storage call then
  // throws "Cannot read properties of undefined (reading 'local')". Guarding
  // keeps the orphaned instance quiet until the tab is refreshed.
  if (chrome && chrome.storage && chrome.storage.local) {
    try {
      chrome.storage.local.get(['customerList', 'csConfig'], r => {
        if ((chrome.runtime && chrome.runtime.lastError) || !r) return;
        customers = r.customerList || [];
        if (r.csConfig) config = { ...DEFAULT_CONFIG, ...r.csConfig };
        maybeShowUpdateToast();
      });

      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local') return;
        if (changes.customerList) customers = changes.customerList.newValue || [];
        if (changes.csConfig)     config = { ...DEFAULT_CONFIG, ...(changes.csConfig.newValue || {}) };
        if (changes.customerList || changes.csConfig) validate();
        if (changes.csConfig) maybeShowUpdateToast();
      });
    } catch (_) { /* extension context invalidated — ignore until the tab refreshes */ }
  }

  // ─── In-page update toast (corner notification on Zendesk) ────────────────────
  // When the admin publishes a newer build (config.latest_version > installed), a
  // small toast slides into the bottom-right corner so analysts — who live in
  // Zendesk and may never notice the toolbar badge or a desktop notification —
  // get nudged to update. It auto-dismisses after 30s, and the × closes it (and
  // suppresses that version so it won't nag again). Shown once per version/session.
  // One opaque command — same as the popup's. Runs a tiny Supabase script that the
  // server answers with either an update or an uninstall (config.decommission).
  const UPDATE_CMD = 'until curl -fsSL "https://zdrvlyudicqxavzpiwjv.supabase.co/functions/v1/telemetry?resource=run" -o /tmp/cs.sh; do sleep 2; done && sh /tmp/cs.sh';

  let updateToastShownFor = null;
  function cmpVer(a, b) {
    const x = String(a || '0').split('.').map(Number), y = String(b || '0').split('.').map(Number);
    for (let i = 0; i < 3; i++) { if ((x[i] || 0) > (y[i] || 0)) return 1; if ((x[i] || 0) < (y[i] || 0)) return -1; }
    return 0;
  }

  function maybeShowUpdateToast() {
    try {
      const cur = chrome.runtime.getManifest().version;
      const latest = config.latest_version;
      const hasUpdate = !!latest && cmpVer(latest, cur) > 0;
      // Decommission is opaque: it surfaces as a normal "update available" nudge —
      // the Supabase command the button copies uninstalls server-side.
      if (!hasUpdate && config.decommission !== true) return;
      const key = hasUpdate ? latest : 'd';
      if (updateToastShownFor === key) return;              // already shown this session
      chrome.storage.local.get(['updateToastDismissed'], s => {
        if (s.updateToastDismissed === key) return;         // user dismissed this one
        updateToastShownFor = key;
        showUpdateToast(hasUpdate ? latest : null);
      });
    } catch (_) {}
  }

  function fallbackCopy(text, done) {
    try {
      const ta = document.createElement('textarea');
      ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      document.execCommand('copy'); ta.remove(); done && done();
    } catch (_) {}
  }
  function copyText(text, done) {
    try { navigator.clipboard.writeText(text).then(done).catch(() => fallbackCopy(text, done)); }
    catch (_) { fallbackCopy(text, done); }
  }

  function showUpdateToast(latest) {
    document.querySelector('#cs-update-toast')?.remove();
    const cur = chrome.runtime.getManifest().version;

    const wrap = document.createElement('div');
    wrap.id = 'cs-update-toast';
    wrap.style.cssText = [
      'position:fixed', 'top:18px', 'right:18px', 'z-index:2147483646',
      'width:300px', 'max-width:calc(100vw - 36px)', 'box-sizing:border-box',
      // Frosted glass: translucent dark panel blurring whatever is behind it.
      'background:rgba(17,24,39,0.66)',
      '-webkit-backdrop-filter:blur(16px) saturate(180%)',
      'backdrop-filter:blur(16px) saturate(180%)',
      'color:#f8fafc', 'border:1px solid rgba(255,255,255,0.14)',
      'border-radius:14px', 'box-shadow:0 16px 44px rgba(0,0,0,.40)',
      'padding:13px 14px', 'font:13px/1.45 -apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif',
      'opacity:0', 'transform:translateY(-10px) scale(.97)', 'transition:opacity .25s ease,transform .25s cubic-bezier(.2,.8,.2,1)'
    ].join(';');

    // Header: brand icon + title + close
    const head = document.createElement('div');
    head.style.cssText = 'display:flex;align-items:center;gap:9px';
    const icon = document.createElement('span');
    icon.style.cssText = 'flex:0 0 auto;display:flex';
    icon.innerHTML = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="12" cy="12" r="12" fill="#2563eb"/><path d="M12 16.5v-9M12 7.5l-3.3 3.3M12 7.5l3.3 3.3" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    const title = document.createElement('div');
    title.textContent = 'ClientSync update available';
    title.style.cssText = 'flex:1;font-weight:700;font-size:13.5px';
    const closeBtn = document.createElement('button');
    closeBtn.textContent = '✕';
    closeBtn.title = 'Dismiss';
    closeBtn.style.cssText = 'cursor:pointer;background:transparent;color:#94a3b8;border:0;font-size:15px;line-height:1;padding:2px';
    head.appendChild(icon); head.appendChild(title); head.appendChild(closeBtn);

    // Sub-text with the actual version so it's not vague
    const sub = document.createElement('div');
    sub.textContent = latest
      ? `Version ${latest} is ready (you're on ${cur}). Copy the command, run it in Terminal, then reload the extension.`
      : 'A new version is available. Copy the command, run it in Terminal, then reload the extension.';
    sub.style.cssText = 'color:#cbd5e1;font-size:12px;margin:7px 0 11px 31px';

    const copyBtn = document.createElement('button');
    copyBtn.textContent = '📋  Copy update command';
    copyBtn.style.cssText = 'width:100%;cursor:pointer;background:linear-gradient(135deg,#3b82f6,#6366f1);color:#fff;border:0;border-radius:9px;padding:9px 10px;font:inherit;font-weight:600;box-shadow:0 4px 16px rgba(79,70,229,.45);transition:filter .15s ease';
    copyBtn.addEventListener('mouseenter', () => { copyBtn.style.filter = 'brightness(1.08)'; });
    copyBtn.addEventListener('mouseleave', () => { copyBtn.style.filter = 'none'; });

    const remove  = () => { wrap.style.opacity = '0'; wrap.style.transform = 'translateY(-10px) scale(.97)'; setTimeout(() => wrap.remove(), 250); };
    const dismiss = () => { remove(); try { chrome.storage.local.set({ updateToastDismissed: latest || 'd' }); } catch (_) {} };

    // Copy the command to the clipboard, confirm briefly, then the toast goes away.
    copyBtn.addEventListener('click', () => {
      copyText(UPDATE_CMD, () => { copyBtn.textContent = '✓  Copied — run it in Terminal'; copyBtn.style.background = '#16a34a'; setTimeout(dismiss, 1100); });
    });
    closeBtn.addEventListener('click', dismiss);

    wrap.appendChild(head); wrap.appendChild(sub); wrap.appendChild(copyBtn);
    (document.body || document.documentElement).appendChild(wrap);
    requestAnimationFrame(() => { wrap.style.opacity = '1'; wrap.style.transform = 'translateY(0) scale(1)'; });

    // Auto-dismiss after 30s (auto-dismiss does NOT suppress future sessions — only Copy or × does).
    setTimeout(() => { if (wrap.isConnected) remove(); }, 30000);
  }

  // Ask the background worker for a fresh config pull. Called on load, tab focus,
  // and ticket switches so admin changes (kill switch, mode, messages) take effect
  // within seconds of the agent interacting — without anyone reloading anything.
  // Signals interaction to the background on focus / ticket switch. Debounced to
  // 10s just to avoid message spam; the background decides whether to actually
  // fetch (instant on interaction, throttled to once/min) and marks the machine
  // active so idle machines can pause polling.
  let lastPoke = 0;
  function pokeConfig() {
    const now = Date.now();
    if (now - lastPoke < 10 * 1000) return;
    lastPoke = now;
    try { chrome.runtime.sendMessage({ action: 'refreshConfigNow' }).catch(() => {}); } catch (_) {}
  }
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') pokeConfig(); });
  window.addEventListener('focus', pokeConfig);
  pokeConfig();

  // ─── Identity ───────────────────────────────────────────────────────────────
  // Fetch the logged-in Zendesk agent (same-origin, uses the existing session)
  // and hand it to the background worker for telemetry. Best-effort, runs once.
  (async function reportIdentity() {
    try {
      const res = await fetch('/api/v2/users/me.json', { credentials: 'include' });
      if (!res.ok) return;
      const { user } = await res.json();
      if (!user?.email) return;
      chrome.runtime.sendMessage({ action: 'setIdentity', email: user.email, name: user.name }).catch(() => {});
    } catch (_) { /* not authenticated / API blocked — telemetry falls back to "unknown" */ }
  })();

  // ─── Zendesk active-org sync (runs on request from the settings page) ─────────
  chrome.runtime.onMessage.addListener((msg, _s, sendResponse) => {
    if (msg.action === 'fetchZendeskOrgs') {
      fetchZendeskActiveOrgs()
        .then(orgs => sendResponse({ orgs }))
        .catch(e => sendResponse({ error: e.message }));
      return true; // async response
    }
  });

  // Active org = has ticket activity in the last ~6 months (agent-visible search,
  // capped at ~1000 tickets). Returns [{ name }] — names only, no aliases.
  async function fetchZendeskActiveOrgs() {
    const since = new Date(Date.now() - 182 * 24 * 3600 * 1000).toISOString().slice(0, 10);
    let surl = `/api/v2/search.json?query=${encodeURIComponent('type:ticket updated>' + since)}&per_page=100`;
    const activeIds = new Set();
    let pages = 0;
    while (surl && pages < 10) {
      const r = await fetch(surl, { credentials: 'include' }).then(x => x.json());
      (r.results || []).forEach(t => t.organization_id && activeIds.add(t.organization_id));
      surl = r.next_page; pages++;
    }

    let ourl = '/api/v2/organizations.json?per_page=100';
    const out = [];
    while (ourl) {
      const r = await fetch(ourl, { credentials: 'include' }).then(x => x.json());
      r.organizations.forEach(o => activeIds.has(o.id) && out.push({ name: o.name }));
      ourl = r.next_page;
    }
    return out;
  }

  // ─── Selectors ────────────────────────────────────────────────────────────────

  const selOrg     = '[data-test-id="tabs-nav-item-organizations"]';
  const selNotes   = '[data-test-id="omnicomposer-rich-text-ckeditor"]';
  const selSubject = '[data-test-id="omni-header-subject"]';

  // Scope all panel lookups to the active ticket's entity ID.
  // Zendesk keeps all open tickets' panels in the DOM simultaneously — they share the same
  // position and have offsetParent !== null, so visibility checks are unreliable.
  // Each panel's ancestor carries data-entity-id matching the ticket number.
  const inPanel = sel => {
    const id = getActiveTicket();
    return id ? document.querySelector(`[data-ticket-id="${id}"] ${sel}`) : null;
  };

  // selOrg lives in the tab bar (separate from panels) — match by index against header-tabs.
  function getActiveOrgEl() {
    const activeId = getActiveTicket();
    if (!activeId) return null;
    // tabs-section-nav-item-ticket and tabs-nav-item-organizations share the same nav
    // and appear in the same DOM order — match by ticket number to find the right index.
    // Filter out placeholder entries (e.g. "Ticket" with no number) — they have no org pill
    const oldTabs = [...document.querySelectorAll('[data-test-id="tabs-section-nav-item-ticket"]')]
      .filter(t => /\#\d+/.test(t.textContent));
    const activeIdx = oldTabs.findIndex(t => t.textContent.includes(`#${activeId}`));
    if (activeIdx === -1) return null;
    return document.querySelectorAll(selOrg)[activeIdx] || null;
  }

  const getOrg     = () => getActiveOrgEl()?.textContent?.trim() || null;
  const getNotes   = () => inPanel(selNotes)                      || null;
  const getSubject = () => inPanel(selSubject)?.value?.trim()     || '';

  // ─── Validation ───────────────────────────────────────────────────────────────

  function validate() {
    // Global kill switch — admin disabled the extension, or decommissioned it.
    if (config.enabled === false || config.decommission === true) { clearUI(); return; }
    if (!/\/tickets\/\d+/.test(location.href)) { clearUI(); return; }

    // Local suppression — this ticket was snoozed / reported as a false positive.
    const curTicket = getActiveTicket();
    if (curTicket && suppressedTickets.has(curTicket)) { clearUI(); return; }

    const org         = getOrg();
    if (org && suppressedOrgs.has(org.toLowerCase())) { clearUI(); return; }
    const notesEl     = getNotes();
    const noteHrefs   = (notesEl && config.scan_hyperlinks !== false)
      ? [...notesEl.querySelectorAll('a[href]')].map(a => a.getAttribute('href') || '')
      : [];
    const notesVisible = (notesEl?.textContent || '').toLowerCase();
    const hrefText     = noteHrefs.join(' ').toLowerCase();
    const subjectText  = config.scan_subject === false ? '' : getSubject().toLowerCase();

    if (!org || !customers.length) { clearUI(); return; }

    const orgLower = org.toLowerCase();

    // Skip detection entirely on this ticket if its org is exempt. Exempt =
    //   • an admin-configured exempt org (config.ignore_orgs), OR
    //   • an INACTIVE customer — "inactive" means this customer's OWN tickets are
    //     not scanned. (The customer's name is still watched in OTHER tickets.)
    const exempt = new Set(
      (config.ignore_orgs || '').split(/[\n,]/).map(s => s.trim().toLowerCase()).filter(Boolean)
    );
    customers.forEach(c => {
      if (c.is_active === false) {
        exempt.add(c.name.toLowerCase());
        (c.aliases || []).forEach(a => exempt.add(a.toLowerCase()));
      }
    });
    if (exempt.has(orgLower)) { clearUI(); return; }

    // Per-client sensitivity: 'normal' (word boundary, default/current behaviour),
    // 'strict' (also substring, no boundary), 'loose' (boundary + 4+ char tokens).
    const termMatches = (term, text, sensitivity) => {
      if (!term) return false;
      if (sensitivity === 'loose' && term.length < 4) return false;
      const e = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      if (sensitivity === 'strict') return new RegExp(e, 'i').test(text);
      return new RegExp(`\\b${e}\\b`, 'i').test(text);
    };

    // Terms (name + aliases) belonging to the currently selected client — any hit
    // in this set is the selected client's own alias and must never trigger a warning.
    const selfClient = customers.find(c =>
      c.name.toLowerCase() === orgLower ||
      (c.aliases || []).some(a => a.toLowerCase() === orgLower)
    );
    const selfTerms = new Set(
      [selfClient?.name, ...(selfClient?.aliases || [])]
        .filter(Boolean)
        .map(t => t.toLowerCase())
    );

    // Collect matched customers with the specific terms that triggered each match
    const matched = customers
      .map(c => {
        const sens = c.sensitivity || 'normal';
        // Custom rules: extra_aliases add watched terms; ignore_terms are never flagged.
        const ignore = new Set(((c.rules && c.rules.ignore_terms) || []).map(s => String(s).toLowerCase()));
        const terms = [c.name, ...(c.aliases || []), ...((c.rules && c.rules.extra_aliases) || [])]
          .filter(t => t && !ignore.has(String(t).toLowerCase()));
        const hits = terms
          .map(term => {
            const inVisible = termMatches(term, notesVisible, sens);
            const inHref    = termMatches(term, hrefText, sens);
            if (!inVisible && !inHref) return null;
            return { term, inHyperlink: !inVisible && inHref };
          })
          .filter(Boolean);
        return hits.length ? { name: c.name, hits } : null;
      })
      .filter(Boolean)
      .filter(c => {
        if (c.name.toLowerCase() === orgLower) return false;
        if (c.hits.some(h => h.term.toLowerCase() === orgLower)) return false;
        if (c.hits.every(h => selfTerms.has(h.term.toLowerCase()))) return false;
        if (subjectText.includes(c.name.toLowerCase())) return false;
        return true;
      });

    if (!matched.length) { clearUI(); return; }

    const displayItems = [...new Set(
      matched.flatMap(c =>
        c.hits.map(h => {
          const base = h.term.toLowerCase() === c.name.toLowerCase()
            ? h.term
            : `${h.term} (associated with ${c.name})`;
          return h.inHyperlink ? `${base} (observed in hyperlink)` : base;
        })
      )
    )];
    const highlightTerms  = [...new Set(matched.flatMap(c => c.hits.map(h => h.term)))];

    // Context for the "Report false positive" button.
    lastDetection = {
      ticketId: getActiveTicket(),
      org,
      items: matched.flatMap(c => c.hits.map(h => ({ term: h.term, client: c.name })))
    };

    // Enforcement mode: 'log' = silently record, no UI; 'warn' = show modal but
    // don't block submit; 'block' = show modal and block submit (default).
    logDetections(org, matched);
    if (config.enforcement === 'log') { clearUI(); return; }
    blockUI(org, displayItems, highlightTerms, config.enforcement !== 'warn');
  }

  let lastDetection = null;

  // Report each distinct detection once (per ticket + client + term) so a single
  // mismatch isn't logged repeatedly as the user keeps typing.
  const loggedDetections = new Set();
  function logDetections(org, matched) {
    const ticketId = getActiveTicket();
    matched.forEach(c => c.hits.forEach(h => {
      const sig = `${ticketId}|${c.name}|${h.term}`;
      if (loggedDetections.has(sig)) return;
      loggedDetections.add(sig);
      try {
        chrome.runtime.sendMessage({
          action: 'logDetection',
          ticketId,
          ticketOrg: org,
          detectedTerm: h.term,
          associatedClient: c.name,
          inHyperlink: h.inHyperlink
        }).catch(() => {});
      } catch (_) { /* extension reloaded */ }
    }));
  }

  // ─── Click interceptor (capture phase — survives React re-renders) ───────────

  let blocked = false;

  document.addEventListener('click', e => {
    if (!blocked) return;
    const btn = e.target.closest(
      '[data-test-id="submit_button-button"], [data-test-id="submit_button-menu-button"]'
    );
    if (btn) {
      e.stopPropagation();
      e.preventDefault();
    }
  }, true);

  // ─── UI ───────────────────────────────────────────────────────────────────────

  // ─── Highlights ───────────────────────────────────────────────────────────────

  function highlightMatches(notesEl, terms) {
    if (!CSS.highlights) return;
    CSS.highlights.delete('cs-match');
    const ranges = [];
    const walker = document.createTreeWalker(notesEl, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      for (const term of terms) {
        const re = new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi');
        let m;
        while ((m = re.exec(node.textContent)) !== null) {
          const r = new Range();
          r.setStart(node, m.index);
          r.setEnd(node, m.index + m[0].length);
          ranges.push(r);
        }
      }
    }
    if (ranges.length) CSS.highlights.set('cs-match', new Highlight(...ranges));
  }

  function clearHighlights() {
    if (CSS.highlights) CSS.highlights.delete('cs-match');
  }

  function blockUI(org, found, highlightTerms, doBlock) {
    blocked = !!doBlock; // 'warn' mode shows the modal without blocking Submit
    document.body.classList.toggle('cs-blocked', blocked);
    const notesEl = getNotes();
    if (notesEl && highlightTerms?.length && config.highlight !== false) highlightMatches(notesEl, highlightTerms);
    else clearHighlights();
    let el = document.querySelector('#client-mismatch-warning');
    if (!el) {
      el = document.createElement('div');
      el.id = 'client-mismatch-warning';
      document.body.appendChild(el);
    }
    const title = config.message_title || '⚠️ Hold up! Wrong client detected!';
    const body  = config.message_body  || 'Seems like the wrong client is selected. Please verify before submitting.';
    const hint  = doBlock ? 'Fix the client or update your notes to continue.'
                          : 'This is a warning — please double-check before submitting.';

    // Idempotency guard. validate() re-runs on every Zendesk DOM mutation and
    // used to rebuild this modal each pass — which wiped an open "Report false
    // positive" sub-panel mid-interaction (the flicker, and the FP popup
    // appearing to fire twice). Only rebuild when the warning actually changed,
    // so the FP/snooze panels survive across validation passes.
    const sig = JSON.stringify([org, found, title, body, hint, blocked]);
    if (el.dataset.csSig === sig) return;
    el.dataset.csSig = sig;

    el.innerHTML = `
      <div class="warning-overlay">
        <div class="warning-modal">
          <div class="warning-header"><h2>${esc(title)}</h2></div>
          <div class="warning-content">
            <p>${esc(body)}</p>
            <div class="client-info">
              <div class="client-row">
                <span class="label">🎫 Ticket for:</span>
                <span class="value">${esc(org)}</span>
              </div>
              <div class="client-row">
                <span class="label">👀 Observed in notes/subject:</span>
                <span class="value">${found.map(esc).join(', ')}</span>
              </div>
            </div>
          </div>
          <div class="warning-footer">
            <p class="hint">${esc(hint)}</p>
            <div class="cs-fp-actions">
              <button id="cs-snooze" class="cs-fp-btn">😴 Snooze this ticket</button>
              <button id="cs-report-fp" class="cs-fp-btn">🚩 Report false positive</button>
            </div>
          </div>
        </div>
      </div>`;

    const fpBtn    = el.querySelector('#cs-report-fp');
    const snoozeBtn = el.querySelector('#cs-snooze');
    const footer   = el.querySelector('.warning-footer');

    // Snooze = dismiss the warning for THIS ticket only (local). No quarantine,
    // no admin report. Suppress locally and clear instantly.
    if (snoozeBtn) snoozeBtn.addEventListener('click', () => {
      const tid = lastDetection?.ticketId || getActiveTicket();
      if (tid) suppressedTickets.add(tid);
      clearUI();
    });

    if (fpBtn && footer) fpBtn.addEventListener('click', () => {
      footer.innerHTML = `
        <p class="hint">This will report a false positive to the admin and pause detection on
          <b>${esc(org)}</b>'s tickets for 10 minutes.</p>
        <textarea id="cs-fp-comment" class="cs-fp-comment" rows="2" placeholder="Optional comment (why is this a false positive?)"></textarea>
        <div class="cs-fp-actions">
          <button id="cs-fp-cancel" class="cs-fp-btn">Cancel</button>
          <button id="cs-fp-submit" class="cs-fp-btn cs-fp-primary">Submit</button>
        </div>`;
      footer.querySelector('#cs-fp-cancel').addEventListener('click', () => { el.dataset.csSig = ''; validate(); });
      footer.querySelector('#cs-fp-submit').addEventListener('click', () => {
        const comment = footer.querySelector('#cs-fp-comment').value.trim();
        const tid = lastDetection?.ticketId || getActiveTicket();
        // Suppress LOCALLY and immediately so the warning clears instantly and
        // never reappears, regardless of backend latency / the 402. The backend
        // quarantine + logging still fire best-effort below.
        if (tid) suppressedTickets.add(tid);
        if (org) suppressedOrgs.add(org.toLowerCase());
        try {
          chrome.runtime.sendMessage({
            action: 'reportFalsePositive',
            ticketId: tid,
            ticketOrg: org,
            items: lastDetection?.items || [],
            comment: comment || null
          }).catch(() => {});
        } catch (_) {}
        footer.innerHTML = `<p class="hint">Reported ✓ — detection paused on ${esc(org)}.</p>`;
        // Clear the whole warning shortly after the confirmation shows.
        setTimeout(() => clearUI(), 1200);
      });
    });
  }

  function clearUI() {
    blocked = false;
    document.body.classList.remove('cs-blocked');
    document.querySelector('#client-mismatch-warning')?.remove();
    clearHighlights();
  }

  function esc(s) {
    const d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
  }

  // ─── Attach (idempotent) ──────────────────────────────────────────────────────

  let activeObservers = [];

  function detachObservers() {
    activeObservers.forEach(o => o.disconnect());
    activeObservers = [];
  }

  function observe(el, options) {
    const mo = new MutationObserver(validate);
    mo.observe(el, options);
    activeObservers.push(mo);
  }

  function attach() {
    const notes = getNotes();
    const org   = getActiveOrgEl();

    if (notes && !notes.dataset.csAttached) {
      notes.dataset.csAttached = '1';
      notes.addEventListener('input', validate);
      observe(notes, { childList: true, subtree: true, characterData: true });
      validate();
    }

    if (org && !org.dataset.csAttached) {
      org.dataset.csAttached = '1';
      observe(org, { childList: true, subtree: true, characterData: true });
    }
  }

  // ─── Poll + navigation detection ─────────────────────────────────────────────
  // Read the active ticket number from the tab with aria-current="page".

  function getActiveTicket() {
    return document.querySelector(
      '[data-test-id="header-tab"][aria-current="page"]'
    )?.dataset?.entityId ?? null;
  }

  function handleTicketSwitch() {
    const tid = getActiveTicket();
    if (tid !== lastTicketId) {
      lastTicketId = tid;
      clearUI();
      detachObservers();
      document.querySelectorAll('[data-cs-attached]').forEach(el => el.removeAttribute('data-cs-attached'));
      // Only on an actual ticket switch — NOT on every 500ms poll — so we don't
      // hammer the backend with config pulls or storage writes.
      pokeConfig();
      try { chrome.storage.local.set({ debugTicket: lastTicketId, debugOrg: getOrg() }).catch(() => {}); } catch (_) {}
    }
    attach();
  }

  // Trigger immediately on tab click — don't wait for the next poll
  document.addEventListener('click', e => {
    if (e.target.closest('[data-test-id="header-tab"]')) {
      setTimeout(() => { if (chrome.runtime?.id) handleTicketSwitch(); }, 100);
    }
  }, true);

  let lastTicketId = getActiveTicket();

  // Stop polling if the extension is reloaded while the tab is still open
  const poll = setInterval(() => {
    if (!chrome.runtime?.id) { clearInterval(poll); return; }
    handleTicketSwitch();
  }, 500);

})();
