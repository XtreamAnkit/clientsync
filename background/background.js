import { fetchActiveCustomerNames, sendTelemetry } from './supabase-config.js';

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
  await checkForUpdate();
  await sendHeartbeat();
  await reloadZendeskTabs();
});

// Fetch on browser startup (service worker restart)
chrome.runtime.onStartup.addListener(async () => {
  await refreshCustomerList();
  await checkForUpdate();
  await sendHeartbeat();
});

// Periodic refresh via alarm
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === ALARM_NAME) {
    await refreshCustomerList();
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
    chrome.storage.local.get(['customerList', 'lastSynced', 'updateAvailable', 'latestVersion', 'releaseUrl'], (result) => {
      sendResponse({
        customerCount: (result.customerList || []).length,
        lastSynced: result.lastSynced || null,
        updateAvailable: !!result.updateAvailable,
        latestVersion: result.latestVersion || null,
        releaseUrl: result.releaseUrl || null,
        currentVersion: chrome.runtime.getManifest().version
      });
    });
    return true;
  }

  if (message.action === 'checkForUpdate') {
    checkForUpdate().then(available => sendResponse({ available }));
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
