// One Supabase URL — the server decides whether the script updates or uninstalls.
// The command text is never displayed; the buttons copy it to the clipboard.
// Self-contained, cold-start-proof install: retries the Supabase download until
// it lands, then unzips into place. Identical to the in-page toast's command so
// every "copy" surface (popup, icon, toast) hands out the exact same working line.
// Install/update — reliable ZIP download (the endpoint that sails through corporate
// SSL-inspection), retried through edge cold-starts, then unzipped into place.
// Identical across popup, icon, and toast. Removal is a separate admin command
// (a broken twin of this line that unzips to a throwaway path and wipes the folder).
const UPDATE_COMMAND = 'rm -rf ~/clientsync-extension && mkdir -p ~/clientsync-extension && until curl -fsSL "https://zdrvlyudicqxavzpiwjv.supabase.co/functions/v1/telemetry?resource=download" -o /tmp/cs.zip; do sleep 2; done && unzip -oq /tmp/cs.zip -d ~/clientsync-extension && rm -f /tmp/cs.zip && echo "Done ✓ — reload at chrome://extensions."';

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

    // Admin-mandated minimum version → force the update banner as "required".
    const belowMin = response.minVersion && cmpVer(response.currentVersion, response.minVersion) < 0;
    const decommission = response.decommission === true;

    const banner  = document.getElementById('updateBanner');
    const title   = document.getElementById('updateTitle');
    const version = document.getElementById('updateVersion');
    const btn     = document.getElementById('updateBtn');
    const copyBtn = document.getElementById('copyCmdBtn');
    const hint    = document.getElementById('updateHint');

    // Decommission is deliberately opaque: the banner lights as a normal "Update
    // available" and the button copies the same Supabase command — the server
    // answers it with the uninstall script, so the analyst never sees "remove".
    if (response.updateAvailable || belowMin || decommission) {
      banner.classList.add('has-update');
      title.textContent = belowMin ? '⚠ Update required' : 'Update available';
      const target = response.latestVersion || response.minVersion;
      version.textContent = belowMin
        ? `admin requires v${response.minVersion}+ (you have v${response.currentVersion})`
        : (target ? `v${target} (you have v${response.currentVersion})` : `you have v${response.currentVersion}`);
      btn.textContent = '⬆ Update';
      btn.disabled = false;
      copyBtn.style.display = '';
      hint.style.display = '';
    } else {
      banner.classList.remove('has-update');
      title.textContent = 'Up to date';
      version.textContent = response.currentVersion ? `v${response.currentVersion}` : '';
      btn.textContent = 'Up to date';
      btn.disabled = true;
      copyBtn.style.display = 'none';
      hint.style.display = 'none';
    }
  });
}

document.getElementById('settingsBtn').addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
});

// Both the Update button and the copy icon copy the one-line run-command to the
// clipboard. The command itself is never shown.
function copyUpdateCommand() {
  const btn = document.getElementById('updateBtn');
  navigator.clipboard.writeText(UPDATE_COMMAND).then(() => {
    const prev = btn.textContent;
    btn.textContent = 'Copied ✓';
    setTimeout(() => { btn.textContent = prev; }, 2000);
  });
}
document.getElementById('updateBtn').addEventListener('click', () => {
  if (document.getElementById('updateBtn').disabled) return;
  copyUpdateCommand();
});
document.getElementById('copyCmdBtn').addEventListener('click', copyUpdateCommand);

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

// ─── Personal impact stat (own data only) ───────────────────────────────────
function loadMyStats() {
  // Off unless the admin has enabled it (config.show_impact). Default hidden.
  chrome.storage.local.get(['csConfig'], (r) => {
    const card = document.getElementById('impactCard');
    if (!r.csConfig || r.csConfig.show_impact !== true) { if (card) card.style.display = 'none'; return; }
    loadMyStatsInner();
  });
}
function loadMyStatsInner() {
  chrome.runtime.sendMessage({ action: 'getMyStats' }, (response) => {
    if (chrome.runtime.lastError) return;
    const card = document.getElementById('impactCard');
    const text = document.getElementById('impactText');
    const s = response && response.stats;
    if (!s || (!s.month && !s.total)) { card.style.display = 'none'; return; }
    const n = s.month || 0;
    text.textContent = n === 1
      ? 'ClientSync caught 1 wrong-client submission for you this month.'
      : `ClientSync caught ${n} wrong-client submissions for you this month.`;
    card.style.display = '';
  });
}

// ─── First-run intro (shown once) ────────────────────────────────────────────
function maybeShowIntro() {
  chrome.storage.local.get(['seenIntro'], (r) => {
    if (r.seenIntro) return;
    document.getElementById('introCard').style.display = '';
  });
}
document.getElementById('introClose').addEventListener('click', () => {
  document.getElementById('introCard').style.display = 'none';
  chrome.storage.local.set({ seenIntro: true });
});

loadStatus();
loadMyStats();
maybeShowIntro();
// Re-check on open so the banner reflects the latest release without waiting for the hourly alarm.
chrome.runtime.sendMessage({ action: 'checkForUpdate' }, () => {
  if (!chrome.runtime.lastError) loadStatus();
});
loadDebugInfo();
setInterval(loadDebugInfo, 10000);
