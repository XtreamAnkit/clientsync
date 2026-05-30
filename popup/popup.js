function formatRelativeTime(timestamp) {
  if (!timestamp) return 'Never';
  const diff = Date.now() - timestamp;
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function showRefreshMsg(text, type) {
  const msg = document.getElementById('refreshMsg');
  msg.textContent = text;
  msg.className = `refresh-msg ${type}`;
  setTimeout(() => { msg.className = 'refresh-msg hidden'; }, 3000);
}

function loadStatus() {
  chrome.runtime.sendMessage({ action: 'getStatus' }, (response) => {
    if (chrome.runtime.lastError || !response) return;
    document.getElementById('customerCount').textContent = response.customerCount;
    document.getElementById('lastSynced').textContent = formatRelativeTime(response.lastSynced);

    const banner = document.getElementById('updateBanner');
    if (response.updateAvailable) {
      document.getElementById('updateVersion').textContent =
        `v${response.latestVersion} (you have v${response.currentVersion})`;
      const link = document.getElementById('updateLink');
      if (response.releaseUrl) link.href = response.releaseUrl;
      banner.style.display = '';
    } else {
      banner.style.display = 'none';
    }
  });
}

document.getElementById('settingsBtn').addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
});

document.getElementById('refreshBtn').addEventListener('click', () => {
  const btn = document.getElementById('refreshBtn');
  btn.disabled = true;
  btn.textContent = 'Refreshing…';

  chrome.runtime.sendMessage({ action: 'refreshCustomerList' }, (response) => {
    btn.disabled = false;
    btn.textContent = '↻ Refresh list';

    if (chrome.runtime.lastError || !response?.success) {
      showRefreshMsg('Refresh failed. Check your Supabase config.', 'error');
    } else {
      showRefreshMsg(`Synced ${response.count} customers.`, 'success');
      loadStatus();
    }
  });
});

function loadDebugInfo() {
  const card = document.getElementById('debugCard');
  chrome.tabs.query({ url: '*://snowbit.zendesk.com/*' }, (tabs) => {
    if (!tabs.length) { card.style.display = 'none'; return; }
    chrome.storage.local.get(['debugTicket', 'debugOrg'], (result) => {
      if (!result.debugTicket) { card.style.display = 'none'; return; }
      card.style.display = '';
      document.getElementById('debugInfo').textContent = `#${result.debugTicket}  ${result.debugOrg || '—'}`;
    });
  });
}

loadStatus();
// Re-check on open so the banner reflects the latest release without waiting for the hourly alarm.
chrome.runtime.sendMessage({ action: 'checkForUpdate' }, () => {
  if (!chrome.runtime.lastError) loadStatus();
});
loadDebugInfo();
setInterval(loadDebugInfo, 10000);
