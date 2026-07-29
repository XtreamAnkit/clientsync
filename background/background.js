import { fetchActiveCustomerNames, sendTelemetry, fetchConfig } from './supabase-config.js';

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
      type: 'basic', iconUrl: 'icons/icon128.png', title, message, priority: 2
    });
  } catch (_) {}
}
async function updateIndicators() {
  const { updateAvailable, latestVersion, csConfig, lastNotified } =
    await chrome.storage.local.get(['updateAvailable', 'latestVersion', 'csConfig', 'lastNotified']);
  const cfg = csConfig || {};
  const cur = chrome.runtime.getManifest().version;
  const belowMin = cfg.min_version && isNewer(cfg.min_version, cur);
  const announcement = cfg.announcement || null;
  const needUpdate = !!updateAvailable || !!belowMin;

  // Badge: red for update, blue for announcement, none otherwise.
  if (needUpdate)        setBadge('↑', '#d93025');
  else if (announcement) setBadge('!', '#1a73e8');
  else                   setBadge('');

  // One desktop notification per distinct state change.
  const state = JSON.stringify({ u: needUpdate ? (latestVersion || cfg.min_version || 'y') : null, a: announcement });
  if (state !== (lastNotified || '')) {
    if (needUpdate) {
      notify('ClientSync update available',
        (belowMin ? `Your admin requires v${cfg.min_version}+. ` : `Version ${latestVersion} is available. `)
        + 'Click here to copy the update command.');
    } else if (announcement) {
      notify('ClientSync announcement', announcement);
    }
    await chrome.storage.local.set({ lastNotified: state });
  }
}

// The one-line update command (kept in sync with the popup's copy button).
const UPDATE_COMMAND = 'rm -rf ~/clientsync-extension && mkdir -p ~/clientsync-extension && curl -fsSL "https://github.com/XtreamAnkit/clientsync/releases/latest/download/clientsync.zip" -o /tmp/cs.zip && unzip -oq /tmp/cs.zip -d ~/clientsync-extension && rm /tmp/cs.zip && echo "ClientSync updated. Reload at chrome://extensions and refresh Zendesk."';

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
async function refreshConfig() {
  const { agentEmail } = await chrome.storage.local.get(['agentEmail']);
  const res = await fetchConfig(agentEmail);
  if (!res || !res.config) return null;
  const merged = { ...res.config };
  const ov = res.override;
  if (ov) {
    for (const k of ['enabled','enforcement','scan_hyperlinks','scan_subject','highlight',
                     'min_version','message_title','message_body']) {
      if (ov[k] !== null && ov[k] !== undefined) merged[k] = ov[k];
    }
  }
  await chrome.storage.local.set({ csConfig: merged });
  await updateIndicators();
  return merged;
}

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

const ALARM_NAME = 'refreshCustomerList';
const REFRESH_INTERVAL_MINUTES = 5;

const UPDATE_ALARM_NAME = 'checkForUpdate';
const UPDATE_INTERVAL_MINUTES = 60;

const CONFIG_ALARM_NAME = 'refreshConfig';
const CONFIG_INTERVAL_MINUTES = 1;  // Chrome's minimum — config lands within ~60s even for idle tabs.
const LATEST_RELEASE_URL = 'https://api.github.com/repos/XtreamAnkit/clientsync/releases/latest';

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

async function checkForUpdate() {
  try {
    const res = await fetch(LATEST_RELEASE_URL, { headers: { 'Accept': 'application/vnd.github+json' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const latest = (data.tag_name || '').replace(/^v/, '');
    const current = chrome.runtime.getManifest().version;
    const available = !!latest && isNewer(latest, current);
    await chrome.storage.local.set({
      updateAvailable: available,
      latestVersion: latest || null,
      releaseUrl: data.html_url || null
    });
    await updateIndicators();
    return available;
  } catch (error) {
    console.warn('[ClientSync] Update check failed:', error.message);
    return null;
  }
}

async function refreshCustomerList() {
  try {
    const customerNames = await fetchActiveCustomerNames();
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
    return null;
  }
}

async function reloadZendeskTabs() {
  const tabs = await chrome.tabs.query({ url: '*://snowbit.zendesk.com/*' });
  tabs.forEach(tab => chrome.tabs.reload(tab.id));
}

// Fetch immediately on install/update, then reload any open Zendesk tabs
chrome.runtime.onInstalled.addListener(async () => {
  await refreshCustomerList();
  // Freshly installed/updated build — clear any stale "update available" flag.
  await chrome.storage.local.set({ updateAvailable: false, latestVersion: null });
  // createAlarm is idempotent — safe to call even if alarm already exists
  chrome.alarms.create(ALARM_NAME, { periodInMinutes: REFRESH_INTERVAL_MINUTES });
  chrome.alarms.create(UPDATE_ALARM_NAME, { periodInMinutes: UPDATE_INTERVAL_MINUTES });
  chrome.alarms.create(CONFIG_ALARM_NAME, { periodInMinutes: CONFIG_INTERVAL_MINUTES });
  await checkForUpdate();
  await refreshConfig();
  await sendHeartbeat();
  await reloadZendeskTabs();
});

// Fetch on browser startup (service worker restart)
chrome.runtime.onStartup.addListener(async () => {
  await refreshCustomerList();
  await checkForUpdate();
  await refreshConfig();
  await sendHeartbeat();
});

// Periodic refresh via alarm
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === ALARM_NAME) {
    await refreshCustomerList();
  } else if (alarm.name === CONFIG_ALARM_NAME) {
    await refreshConfig();
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
        enforcement: cfg.enforcement || 'block'
      });
    });
    return true;
  }

  if (message.action === 'checkForUpdate') {
    checkForUpdate().then(available => sendResponse({ available }));
    return true;
  }

  // Content script asks for a fresh config pull (on ticket switch / tab focus) so
  // admin changes reflect within seconds of the agent interacting — no reload.
  if (message.action === 'refreshConfigNow') {
    refreshConfig().then(() => sendResponse({ ok: true }));
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

  // Analyst flags a warning as a false positive → log each item as feedback.
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
