const UPDATE_COMMAND = 'rm -rf ~/clientsync-extension && mkdir -p ~/clientsync-extension && curl -fsSL "https://github.com/XtreamAnkit/clientsync/releases/latest/download/clientsync.zip" -o /tmp/cs.zip && unzip -oq /tmp/cs.zip -d ~/clientsync-extension && rm /tmp/cs.zip && echo "ClientSync updated. Reload at chrome://extensions and refresh Zendesk."';

function cmpVer(a, b) {
  const x = String(a || '0').split('.').map(Number), y = String(b || '0').split('.').map(Number);
  for (let i = 0; i < 3; i++) { if ((x[i]||0) > (y[i]||0)) return 1; if ((x[i]||0) < (y[i]||0)) return -1; }
  return 0;
}

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
    if (response.currentVersion) {
      document.getElementById('currentVersion').textContent = `v${response.currentVersion}`;
    }

    // Admin announcement banner
    const ann = document.getElementById('announceBanner');
    if (response.announcement) {
      document.getElementById('announceText').textContent = response.announcement;
      ann.style.display = '';
    } else { ann.style.display = 'none'; }

    // Status badge reflects the admin's enforcement config
    const sb = document.getElementById('statusBadge');
    if (sb) {
      if (response.enabled === false) { sb.textContent = 'Disabled'; sb.className = 'status-badge inactive'; }
      else if (response.enforcement === 'warn') { sb.textContent = 'Warn-only'; sb.className = 'status-badge'; }
      else if (response.enforcement === 'log')  { sb.textContent = 'Logging';   sb.className = 'status-badge'; }
      else { sb.textContent = 'Active'; sb.className = 'status-badge active'; }
    }

    // Admin-mandated minimum version → force the update banner as "required"
    const belowMin = response.minVersion && cmpVer(response.currentVersion, response.minVersion) < 0;

    const banner  = document.getElementById('updateBanner');
    const title   = document.getElementById('updateTitle');
    const version = document.getElementById('updateVersion');
    const btn     = document.getElementById('copyCmdBtn');
    const cmdRow  = document.getElementById('updateCmdRow');
    const hint    = document.getElementById('updateHint');

    if (response.updateAvailable || belowMin) {
      banner.classList.add('has-update');
      title.textContent = belowMin ? '⚠ Update required' : 'Update available';
      const target = response.latestVersion || response.minVersion;
      version.textContent = belowMin
        ? `admin requires v${response.minVersion}+ (you have v${response.currentVersion})`
        : `v${target} (you have v${response.currentVersion})`;
      btn.textContent = 'Copy';
      btn.disabled = false;
      document.getElementById('updateCmd').textContent = UPDATE_COMMAND;
      cmdRow.style.display = '';
      hint.style.display = '';
    } else {
      banner.classList.remove('has-update');
      title.textContent = 'Up to date';
      version.textContent = response.currentVersion ? `v${response.currentVersion}` : '';
      btn.textContent = 'Up to date';
      btn.disabled = true;
      cmdRow.style.display = 'none';
      hint.style.display = 'none';
    }
  });
}

document.getElementById('settingsBtn').addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
});

document.getElementById('copyCmdBtn').addEventListener('click', () => {
  const btn = document.getElementById('copyCmdBtn');
  navigator.clipboard.writeText(UPDATE_COMMAND).then(() => {
    btn.textContent = 'Copied!';
    setTimeout(() => { btn.textContent = 'Copy'; }, 2000);
  });
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
