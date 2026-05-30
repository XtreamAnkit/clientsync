(function () {
  'use strict';


  // ─── Customer list ────────────────────────────────────────────────────────────

  let customers = [];

  chrome.storage.local.get(['customerList'], r => {
    customers = r.customerList || [];
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.customerList) {
      customers = changes.customerList.newValue || [];
      validate();
    }
  });

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
    if (!/\/tickets\/\d+/.test(location.href)) { clearUI(); return; }

    const org         = getOrg();
    const notesEl     = getNotes();
    const noteHrefs   = notesEl
      ? [...notesEl.querySelectorAll('a[href]')].map(a => a.getAttribute('href') || '')
      : [];
    const notesVisible = (notesEl?.textContent || '').toLowerCase();
    const hrefText     = noteHrefs.join(' ').toLowerCase();
    const subjectText  = getSubject().toLowerCase();

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
    blockUI(org, displayItems, highlightTerms);
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

  function blockUI(org, found, highlightTerms) {
    blocked = true;
    document.body.classList.add('cs-blocked');
    const notesEl = getNotes();
    if (notesEl && highlightTerms?.length) highlightMatches(notesEl, highlightTerms);
    let el = document.querySelector('#client-mismatch-warning');
    if (!el) {
      el = document.createElement('div');
      el.id = 'client-mismatch-warning';
      document.body.appendChild(el);
    }
    el.innerHTML = `
      <div class="warning-overlay">
        <div class="warning-modal">
          <div class="warning-header"><h2>⚠️ Hold up! Wrong client detected!</h2></div>
          <div class="warning-content">
            <p>Seems like the wrong client is selected. Please verify before submitting.</p>
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
          <div class="warning-footer"><p class="hint">Fix the client or update your notes to continue.</p></div>
        </div>
      </div>`;
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
