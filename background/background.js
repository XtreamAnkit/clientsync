import { fetchActiveCustomerNames } from './supabase-config.js';

const ALARM_NAME = 'refreshCustomerList';
const REFRESH_INTERVAL_MINUTES = 5;

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
  // createAlarm is idempotent — safe to call even if alarm already exists
  chrome.alarms.create(ALARM_NAME, { periodInMinutes: REFRESH_INTERVAL_MINUTES });
  await reloadZendeskTabs();
});

// Fetch on browser startup (service worker restart)
chrome.runtime.onStartup.addListener(async () => {
  await refreshCustomerList();
});

// Periodic refresh via alarm
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === ALARM_NAME) {
    await refreshCustomerList();
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
    chrome.storage.local.get(['customerList', 'lastSynced'], (result) => {
      sendResponse({
        customerCount: (result.customerList || []).length,
        lastSynced: result.lastSynced || null
      });
    });
    return true;
  }
});
