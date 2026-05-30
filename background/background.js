import { fetchActiveCustomerNames } from './supabase-config.js';

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
  await reloadZendeskTabs();
});

// Fetch on browser startup (service worker restart)
chrome.runtime.onStartup.addListener(async () => {
  await refreshCustomerList();
  await checkForUpdate();
});

// Periodic refresh via alarm
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === ALARM_NAME) {
    await refreshCustomerList();
  } else if (alarm.name === UPDATE_ALARM_NAME) {
    await checkForUpdate();
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
});
