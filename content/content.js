(function () {
  'use strict';


  // ─── Customer list ────────────────────────────────────────────────────────────

  let customers = [];

  // Remote-control config (set by admin). Defaults keep full protection on if the
  // config hasn't loaded yet or the backend is unreachable.
  const DEFAULT_CONFIG = {
    enabled: true, enforcement: 'block', scan_hyperlinks: true,
    scan_subject: true, highlight: true, message_title: null, message_body: null
  };
  let config = { ...DEFAULT_CONFIG };

  chrome.storage.local.get(['customerList', 'csConfig'], r => {
    customers = r.customerList || [];
    if (r.csConfig) config = { ...DEFAULT_CONFIG, ...r.csConfig };
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.customerList) customers = changes.customerList.newValue || [];
    if (changes.csConfig)     config = { ...DEFAULT_CONFIG, ...(changes.csConfig.newValue || {}) };
    if (changes.customerList || changes.csConfig) validate();
  });

  // Ask the background worker for a fresh config pull. Called on load, tab focus,
  // and ticket switches so admin changes (kill switch, mode, messages) take effect
  // within seconds of the agent interacting — without anyone reloading anything.
  function pokeConfig() {
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

  // ─── Selectors ────────────────────────────────────────────────────────────────

  const selOrg     = '[data-test-id="tabs-nav-item-organizations"]';
  const selNotes   = '[data-test-id="omnicomposer-rich-text-ckeditor"]';
  const selSubject = '[data-test-id="omni-header-subject"]';
  const selSubmit  = '[data-test-id="submit_button-button"]';
  const selDrop    = '[data-test-id="submit_button-menu-button"]';

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
  const getBtns    = () => [selSubmit, selDrop].map(s => document.querySelector(s)).filter(Boolean);

  // ─── Validation ───────────────────────────────────────────────────────────────

  function validate() {
    // Global kill switch — admin disabled the extension.
    if (config.enabled === false) { clearUI(); return; }
    if (!/\/tickets\/\d+/.test(location.href)) { clearUI(); return; }

    const org         = getOrg();
    const notesEl     = getNotes();
    const noteHrefs   = (notesEl && config.scan_hyperlinks !== false)
      ? [...notesEl.querySelectorAll('a[href]')].map(a => a.getAttribute('href') || '')
      : [];
    const notesVisible = (notesEl?.textContent || '').toLowerCase();
    const hrefText     = noteHrefs.join(' ').toLowerCase();
    const subjectText  = config.scan_subject === false ? '' : getSubject().toLowerCase();

    if (!org || !customers.length) return;

    const inText    = (term, text) => new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(text);
    const orgLower  = org.toLowerCase();

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
        const hits = [c.name, ...(c.aliases || [])]
          .map(term => {
            const inVisible = inText(term, notesVisible);
            const inHref    = inText(term, hrefText);
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
            <button id="cs-report-fp" class="cs-fp-btn">🚩 Report false positive</button>
          </div>
        </div>
      </div>`;

    const fpBtn = el.querySelector('#cs-report-fp');
    if (fpBtn) fpBtn.addEventListener('click', () => {
      fpBtn.disabled = true;
      fpBtn.textContent = 'Reported ✓ — thanks';
      try {
        chrome.runtime.sendMessage({
          action: 'reportFalsePositive',
          ticketId: lastDetection?.ticketId || getActiveTicket(),
          ticketOrg: org,
          items: lastDetection?.items || []
        }).catch(() => {});
      } catch (_) {}
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
    }
    attach();
    pokeConfig();
    try { chrome.storage.local.set({ debugTicket: lastTicketId, debugOrg: getOrg() }).catch(() => {}); } catch (_) {}
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
