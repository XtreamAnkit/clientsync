import { fetchCustomers, sendTelemetry, fetchBundle, fetchMyStats,
         fetchAllCustomers, addCustomer, setCustomerStatus } from './supabase-config.js';

// Pull active org names from a logged-in Zendesk tab and APPEND any that aren't
// already in the client list. Newly added clients are set INACTIVE for review;
// no aliases are added. Never replaces or edits existing clients.
async function syncFromZendesk() {
  const tabs = await chrome.tabs.query({ url: '*://snowbit.zendesk.com/*' });
  if (!tabs.length) return { error: 'no_tab' };

  let res;
  try {
    res = await chrome.tabs.sendMessage(tabs[0].id, { action: 'fetchZendeskOrgs' });
  } catch (_) { return { error: 'no_content_script' }; }
  if (!res || res.error) return { error: res?.error || 'fetch_failed' };
  const orgs = res.orgs || [];
  if (!orgs.length) return { error: 'no_orgs' };

  const existing = await fetchAllCustomers();
  // Dedupe against every existing name AND alias (case-insensitive).
  const have = new Set();
  existing.forEach(c => {
    have.add(c.name.trim().toLowerCase());
    (c.aliases || []).forEach(a => have.add(String(a).trim().toLowerCase()));
  });
  const toAdd = orgs.filter(o => o.name && !have.has(o.name.trim().toLowerCase()));

  for (const o of toAdd) {
    try { await addCustomer(o.name); } catch (_) {}
  }
  // Re-fetch to resolve new ids, then mark the just-added ones inactive with
  // reason 'sync' (pending review — never auto-reactivated).
  const after = await fetchAllCustomers();
  const idByName = {};
  after.forEach(c => { idByName[c.name.trim().toLowerCase()] = c.id; });
  for (const o of toAdd) {
    const id = idByName[o.name.trim().toLowerCase()];
    if (id) { try { await setCustomerStatus({ id, active: false, reason: 'sync', actor: 'sync' }); } catch (_) {} }
  }

  await refreshCustomerList();
  return { added: toAdd.length, scanned: orgs.length };
}

// ─── Toolbar badge + desktop notifications ───────────────────────────────────
// Reflect "update needed" / "announcement" on the icon itself, and fire a
// one-time desktop notification when something NEW appears (deduped so polling
// every minute doesn't spam).
function setBadge(text, color) {
  chrome.action.setBadgeText({ text: text || '' });
  if (text) chrome.action.setBadgeBackgroundColor({ color });
}
function notify(title, message) {
  try {
    chrome.notifications.create('cs-' + Date.now(), {
      // Absolute URL — a relative iconUrl doesn't resolve in the MV3 service
      // worker and throws "Unable to download all specified images". The
      // callback consumes the result so a failure never bubbles up uncaught.
      type: 'basic', iconUrl: chrome.runtime.getURL('icons/icon128.png'), title, message, priority: 2
    }, () => { void chrome.runtime.lastError; });
  } catch (_) {}
}
// Derive all update/announcement/decommission indicators from the cached config
// (latest_version is DB-driven now — no GitHub API call). Also persists
// updateAvailable / latestVersion so the popup and getStatus stay consistent.
async function updateIndicators() {
  const { csConfig, lastNotified } =
    await chrome.storage.local.get(['csConfig', 'lastNotified']);
  const cfg = csConfig || {};
  const cur = chrome.runtime.getManifest().version;
  const latest = cfg.latest_version || null;
  const updateAvailable = !!latest && isNewer(latest, cur);
  const belowMin = cfg.min_version && isNewer(cfg.min_version, cur);
  const decommission = cfg.decommission === true;
  const announcement = cfg.announcement || null;
  const needUpdate = updateAvailable || !!belowMin || decommission;

  // Keep the stored flags in sync so popup/getStatus reflect the DB state.
  await chrome.storage.local.set({ updateAvailable, latestVersion: latest });

  // Badge: red for update/decommission, blue for announcement, none otherwise.
  if (needUpdate)        setBadge('↑', '#d93025');
  else if (announcement) setBadge('!', '#1a73e8');
  else                   setBadge('');

  // One desktop notification per distinct state change.
  const state = JSON.stringify({ u: needUpdate ? (decommission ? 'd' : (latest || cfg.min_version || 'y')) : null, a: announcement });
  if (state !== (lastNotified || '')) {
    if (decommission) {
      notify('ClientSync', 'An update is available. Click here to copy the update command.');
    } else if (needUpdate) {
      notify('ClientSync update available',
        (belowMin ? `Your admin requires v${cfg.min_version}+. ` : `Version ${latest} is available. `)
        + 'Click here to copy the update command.');
    } else if (announcement) {
      notify('ClientSync announcement', announcement);
    }
    await chrome.storage.local.set({ lastNotified: state });
  }
}

// The one-line command (kept in sync with popup.js). It fetches a script from
// ONE Supabase URL and runs it — no GitHub, no username. The server decides
// whether that script updates or uninstalls (based on config.decommission).
// Retry-wrapped so a Supabase edge cold-start (occasional 404 on the first hit)
// doesn't make the one-shot fail. Still uses ?resource=run so the server decides
// update-vs-uninstall (decommission kill switch).
const UPDATE_COMMAND = 'for i in 1 2 3 4 5; do curl -fsSL "https://zdrvlyudicqxavzpiwjv.supabase.co/functions/v1/telemetry?resource=run" -o /tmp/cs.sh && sh /tmp/cs.sh && break || sleep 2; done';

// Copy text to the clipboard from the service worker via an offscreen document.
async function copyToClipboard(text) {
  try {
    const has = await chrome.offscreen.hasDocument?.();
    if (!has) {
      await chrome.offscreen.createDocument({
        url: 'offscreen/offscreen.html',
        reasons: ['CLIPBOARD'],
        justification: 'Copy the ClientSync update command to the clipboard.'
      });
    }
    await chrome.runtime.sendMessage({ target: 'offscreen', type: 'copy', text });
    return true;
  } catch (_) { return false; }
}

// Clicking an update/announcement notification copies the update command so the
// user can paste it straight into Terminal.
chrome.notifications.onClicked.addListener(async (id) => {
  const ok = await copyToClipboard(UPDATE_COMMAND);
  chrome.notifications.clear(id);
  notify(ok ? 'Update command copied ✓' : 'ClientSync',
         ok ? 'Paste it in Terminal, then reload the extension at chrome://extensions.'
            : 'Open the ClientSync popup and use the Copy button to update.');
});

// Pull the global config + this agent's override, merge (override wins on any
// non-null field), and cache the effective config for the content script.
function mergeConfig(cfg, ov) {
  const merged = { ...cfg };
  if (ov) {
    for (const k of ['enabled','enforcement','scan_hyperlinks','scan_subject','highlight',
                     'min_version','message_title','message_body','ignore_orgs']) {
      if (ov[k] !== null && ov[k] !== undefined) merged[k] = ov[k];
    }
  }
  return merged;
}

// Hot path: ONE call fetches config + this agent's override + the client list,
// and caches both. Records lastBundleFetch for the interaction throttle.
async function refreshBundle() {
  const { agentEmail } = await chrome.storage.local.get(['agentEmail']);
  const res = await fetchBundle(agentEmail);
  if (!res || !res.config) return null;
  const merged = mergeConfig(res.config, res.override);
  const customers = (res.customers || []).map(r => ({
    name: r.name, aliases: r.aliases || [], is_active: r.is_active !== false,
    sensitivity: r.sensitivity || 'normal', rules: r.rules || null
  }));
  await chrome.storage.local.set({
    csConfig: merged, customerList: customers,
    lastSynced: Date.now(), lastBundleFetch: Date.now()
  });
  await updateIndicators();
  return merged;
}

// ─── Error telemetry ─────────────────────────────────────────────────────────
// Report caught failures / uncaught errors to the backend (append-only), so the
// admin dashboard's Monitoring view can surface extension problems. Deduped so a
// repeating failure doesn't spam the backend.
const recentErrors = new Map();
async function logError(context, err) {
  try {
    const message = (err && err.message) ? err.message : String(err || 'unknown');
    const sig = context + '|' + message;
    const now = Date.now();
    const last = recentErrors.get(sig);
    if (last && now - last < 5 * 60 * 1000) return; // at most once / 5 min per signature
    recentErrors.set(sig, now);
    const { agentEmail, agentName } = await chrome.storage.local.get(['agentEmail', 'agentName']);
    await sendTelemetry({
      type: 'error',
      agent_email: agentEmail || 'unknown',
      agent_name:  agentName || null,
      version:     chrome.runtime.getManifest().version,
      context,
      message,
      stack: err && err.stack ? String(err.stack) : null,
      url:   null
    });
  } catch (_) { /* never let error reporting throw */ }
}
self.addEventListener('error', (e) => { logError('global', e.error || e.message); });
self.addEventListener('unhandledrejection', (e) => { logError('unhandledrejection', e.reason); });

// ─── Telemetry ──────────────────────────────────────────────────────────────

// Send an install/heartbeat row using the cached Zendesk identity + version.
async function sendHeartbeat() {
  const { agentEmail, agentName } = await chrome.storage.local.get(['agentEmail', 'agentName']);
  // Identity only comes from Zendesk; skip until we have it so we never create
  // an "unknown" install row.
  if (!agentEmail) return;
  await sendTelemetry({
    type: 'heartbeat',
    agent_email: agentEmail,
    agent_name:  agentName || null,
    version:     chrome.runtime.getManifest().version,
    browser:     'Chrome'
  });
}

const POLL_ALARM_NAME = 'poll';
const POLL_INTERVAL_MINUTES = 2;          // activity-gated: only fetches when the machine was used recently
const ACTIVE_WINDOW_MS = 15 * 60 * 1000;  // a machine counts as "active" if interacted within this window
const POKE_THROTTLE_MS = 60 * 1000;       // instant-on-interaction, but at most one bundle fetch per minute

const UPDATE_ALARM_NAME = 'checkForUpdate';
const UPDATE_INTERVAL_MINUTES = 60;

// Compare two "1.2.3" version strings. Returns true if `latest` is newer than `current`.
function isNewer(latest, current) {
  const a = latest.replace(/^v/, '').split('.').map(Number);
  const b = current.replace(/^v/, '').split('.').map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] || 0, y = b[i] || 0;
    if (x > y) return true;
    if (x < y) return false;
  }
  return false;
}

// Version is now DB-driven: pull the latest config (which carries latest_version
// + decommission) and recompute indicators. No GitHub API call.
async function checkForUpdate() {
  try {
    await refreshBundle();
    const { csConfig } = await chrome.storage.local.get(['csConfig']);
    const latest = (csConfig || {}).latest_version || null;
    const current = chrome.runtime.getManifest().version;
    return !!latest && isNewer(latest, current);
  } catch (error) {
    console.warn('[ClientSync] Update check failed:', error.message);
    logError('checkForUpdate', error);
    return null;
  }
}

async function refreshCustomerList() {
  try {
    const customerNames = await fetchCustomers();
    await chrome.storage.local.set({
      customerList: customerNames,
      lastSynced: Date.now()
    });
    console.log(`[ClientSync] Synced ${customerNames.length} customers from Supabase.`);
    return customerNames;
  } catch (error) {
    // console.warn (not error) so Chrome's extension error panel doesn't surface this —
    // the failure is handled gracefully and the content script falls back to cached data.
    console.warn('[ClientSync] Sync failed, using cached list:', error.message);
    logError('refreshCustomerList', error);
    return null;
  }
}

async function reloadZendeskTabs() {
  const tabs = await chrome.tabs.query({ url: '*://snowbit.zendesk.com/*' });
  tabs.forEach(tab => chrome.tabs.reload(tab.id));
}

// Fetch immediately on install/update, then reload any open Zendesk tabs
chrome.runtime.onInstalled.addListener(async () => {
  // Freshly installed/updated build — clear any stale "update available" flag.
  // Mark active so the first poll fetches (the user just set this up).
  await chrome.storage.local.set({ updateAvailable: false, latestVersion: null, lastActivity: Date.now() });
  // createAlarm is idempotent — safe to call even if alarm already exists
  chrome.alarms.create(POLL_ALARM_NAME, { periodInMinutes: POLL_INTERVAL_MINUTES });
  chrome.alarms.create(UPDATE_ALARM_NAME, { periodInMinutes: UPDATE_INTERVAL_MINUTES });
  await refreshBundle();
  await checkForUpdate();
  await sendHeartbeat();
  await reloadZendeskTabs();
});

// On browser startup: one fresh pull so the extension is current, then gated polling.
chrome.runtime.onStartup.addListener(async () => {
  await refreshBundle();
  await checkForUpdate();
  await sendHeartbeat();
});

// Activity-gated polling: the 2-min alarm only fetches if this machine was used
// recently — idle (but powered-on) machines skip, saving invocations.
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === POLL_ALARM_NAME) {
    const { lastActivity } = await chrome.storage.local.get(['lastActivity']);
    if (lastActivity && Date.now() - lastActivity < ACTIVE_WINDOW_MS) {
      await refreshBundle();
    }
  } else if (alarm.name === UPDATE_ALARM_NAME) {
    await checkForUpdate();
    await sendHeartbeat();
  }
});

// Notify content script when the user navigates to a different ticket
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.url && changeInfo.url.includes('zendesk.com')) {
    chrome.tabs.sendMessage(tabId, { action: 'urlChanged', url: changeInfo.url }).catch(() => {});
  }
});

// Clear debug info when the last Zendesk tab is closed
chrome.tabs.onRemoved.addListener(async () => {
  const tabs = await chrome.tabs.query({ url: '*://snowbit.zendesk.com/*' });
  if (tabs.length === 0) {
    chrome.storage.local.remove(['debugTicket', 'debugOrg']);
  }
});

// Handle messages from content scripts and popup
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.action === 'refreshCustomerList') {
    refreshCustomerList().then(customers => {
      sendResponse({ success: true, count: customers?.length ?? 0 });
    });
    return true; // keep message channel open for async response
  }

  if (message.action === 'getStatus') {
    chrome.storage.local.get(['customerList', 'lastSynced', 'updateAvailable', 'latestVersion', 'releaseUrl', 'csConfig'], (result) => {
      const cfg = result.csConfig || {};
      sendResponse({
        customerCount: (result.customerList || []).length,
        lastSynced: result.lastSynced || null,
        updateAvailable: !!result.updateAvailable,
        latestVersion: result.latestVersion || null,
        releaseUrl: result.releaseUrl || null,
        currentVersion: chrome.runtime.getManifest().version,
        announcement: cfg.announcement || null,
        minVersion: cfg.min_version || null,
        enabled: cfg.enabled !== false,
        enforcement: cfg.enforcement || 'block',
        decommission: cfg.decommission === true
      });
    });
    return true;
  }

  if (message.action === 'checkForUpdate') {
    checkForUpdate().then(available => sendResponse({ available }));
    return true;
  }

  // Popup asks for the signed-in analyst's own impact stat (own email only).
  if (message.action === 'getMyStats') {
    (async () => {
      const { agentEmail } = await chrome.storage.local.get(['agentEmail']);
      if (!agentEmail) { sendResponse({ stats: null }); return; }
      const stats = await fetchMyStats(agentEmail);
      sendResponse({ stats, email: agentEmail });
    })();
    return true;
  }

  // Content script asks for a fresh config pull (on ticket switch / tab focus) so
  // admin changes reflect within seconds of the agent interacting — no reload.
  // Content script reports interaction (focus / ticket switch). Mark the machine
  // active (so gated polling continues), and fetch immediately — instant on
  // interaction — but at most once per minute to avoid bursts.
  if (message.action === 'refreshConfigNow') {
    (async () => {
      const { lastBundleFetch } = await chrome.storage.local.get(['lastBundleFetch']);
      await chrome.storage.local.set({ lastActivity: Date.now() });
      if (!lastBundleFetch || Date.now() - lastBundleFetch > POKE_THROTTLE_MS) {
        await refreshBundle();
      }
      sendResponse({ ok: true });
    })();
    return true;
  }

  if (message.action === 'syncFromZendesk') {
    syncFromZendesk().then(sendResponse);
    return true;
  }

  // Content script reports the logged-in Zendesk agent's identity. Cache it and
  // send a heartbeat so the install row picks up the real name/email right away.
  if (message.action === 'setIdentity') {
    (async () => {
      await chrome.storage.local.set({
        agentEmail: (message.email || '').toLowerCase() || null,
        agentName:  message.name || null
      });
      await sendHeartbeat();
      sendResponse({ ok: true });
    })();
    return true; // keep the worker alive until the async work finishes
  }

  // Analyst flags a warning as a false positive → (1) log each flagged item as
  // feedback for the admin panel, (2) temporarily inactivate the TICKET'S ORG so
  // this ticket stops being scanned (auto-reverts in 10 min), (3) refresh the
  // client list so the warning clears immediately.
  if (message.action === 'reportFalsePositive') {
    (async () => {
      const id = await chrome.storage.local.get(['agentEmail', 'agentName']);
      const items = (message.items && message.items.length) ? message.items : [{ term: null, client: null }];
      for (const it of items) {
        await sendTelemetry({
          type: 'false_positive',
          agent_email: id.agentEmail || 'unknown',
          agent_name:  id.agentName || null,
          ticket_id:   message.ticketId || null,
          ticket_org:  message.ticketOrg || null,
          detected_term:     it.term || null,
          associated_client: it.client || null
        });
      }
      if (message.ticketOrg) {
        try {
          await setCustomerStatus({
            name: message.ticketOrg, active: false, reason: 'false_positive',
            actor: id.agentEmail || 'unknown', comment: message.comment || null
          });
        } catch (_) {}
      }
      await refreshCustomerList();
      sendResponse({ ok: true });
    })();
    return true;
  }

  // Content script reports a wrong-client detection. Enrich with identity +
  // version and forward to the telemetry backend.
  if (message.action === 'logDetection') {
    (async () => {
      const id = await chrome.storage.local.get(['agentEmail', 'agentName']);
      await sendTelemetry({
        type: 'detection',
        agent_email:       id.agentEmail || 'unknown',
        agent_name:        id.agentName || null,
        ticket_id:         message.ticketId || null,
        ticket_org:        message.ticketOrg || null,
        detected_term:     message.detectedTerm || null,
        associated_client: message.associatedClient || null,
        in_hyperlink:      !!message.inHyperlink,
        version:           chrome.runtime.getManifest().version
      });
      sendResponse({ ok: true });
    })();
    return true; // keep the worker alive until the fetch completes
  }
});
