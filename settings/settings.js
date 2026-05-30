import {
  fetchAllCustomers,
  addCustomer,
  updateCustomer,
  updateAliases,
  toggleCustomerActive,
  deleteCustomer
} from '../background/supabase-config.js';

let allCustomers = [];
let editingId = null;
let deleteTargetId = null;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function escapeHtml(str) {
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}

function getInitials(name) {
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map(w => w[0])
    .join('')
    .toUpperCase();
}

function formatDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

// Consistent avatar colour from name
const AVATAR_PALETTES = [
  ['#e0e7ff','#4338ca'], ['#fce7f3','#be185d'], ['#d1fae5','#065f46'],
  ['#fef3c7','#92400e'], ['#ede9fe','#5b21b6'], ['#fee2e2','#991b1b'],
  ['#cffafe','#155e75'], ['#fef9c3','#713f12'],
];

function avatarPalette(name) {
  let hash = 0;
  for (const c of name) hash = (hash * 31 + c.charCodeAt(0)) | 0;
  return AVATAR_PALETTES[Math.abs(hash) % AVATAR_PALETTES.length];
}

// ─── Stats ────────────────────────────────────────────────────────────────────

function updateStats(customers) {
  const active = customers.filter(c => c.is_active).length;
  document.getElementById('statTotal').textContent    = customers.length;
  document.getElementById('statActive').textContent   = active;
  document.getElementById('statInactive').textContent = customers.length - active;
}

// ─── Render Table ─────────────────────────────────────────────────────────────

function renderTable(customers) {
  const tbody = document.getElementById('customerTableBody');
  const count  = document.getElementById('resultCount');

  const isFiltered = customers.length !== allCustomers.length;
  count.textContent = isFiltered
    ? `${customers.length} of ${allCustomers.length}`
    : `${customers.length} customer${customers.length !== 1 ? 's' : ''}`;

  if (customers.length === 0) {
    const isSearch = document.getElementById('searchInput').value.trim() !== '';
    tbody.innerHTML = `
      <tr>
        <td class="empty-state-cell" colspan="4">
          <div class="empty-state-inner">
            <div class="empty-icon">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                ${isSearch
                  ? '<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>'
                  : '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/>'}
              </svg>
            </div>
            <p class="empty-title">${isSearch ? 'No matches found' : 'No customers yet'}</p>
            <p class="empty-sub">${isSearch ? 'Try a different search term.' : 'Add your first customer to get started.'}</p>
          </div>
        </td>
      </tr>`;
    return;
  }

  tbody.innerHTML = customers.map(c => {
    const [bg, fg] = avatarPalette(c.name);
    const aliases   = c.aliases || [];
    const aliasChips = aliases.map((a, i) =>
      `<span class="alias-chip">${escapeHtml(a)}<button class="alias-remove" data-id="${c.id}" data-idx="${i}" title="Remove alias">×</button></span>`
    ).join('');
    return `
      <tr>
        <td>
          <div class="customer-cell">
            <div class="customer-avatar" style="background:${bg};color:${fg};border-color:${bg}">${getInitials(c.name)}</div>
            <div class="customer-info">
              <span class="customer-name">${escapeHtml(c.name)}</span>
              <div class="alias-row">
                ${aliasChips}
                <button class="alias-add-btn" data-id="${c.id}" title="Add alias">+</button>
              </div>
            </div>
          </div>
        </td>
        <td><span class="date-cell">${formatDate(c.created_at)}</span></td>
        <td><span class="badge badge-toggle ${c.is_active ? 'active' : 'inactive'}" data-id="${c.id}" data-active="${c.is_active}" title="Click to ${c.is_active ? 'deactivate' : 'activate'}">${c.is_active ? 'Active' : 'Inactive'}</span></td>
        <td>
          <div class="actions-cell">
            <button class="btn-row-edit" data-id="${c.id}" data-name="${escapeHtml(c.name)}">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
                <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
              </svg>
              Edit
            </button>
            <button class="btn-row-delete" data-id="${c.id}" data-name="${escapeHtml(c.name)}">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="3 6 5 6 21 6"/>
                <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>
                <path d="M10 11v6"/><path d="M14 11v6"/>
              </svg>
              Delete
            </button>
          </div>
        </td>
      </tr>`;
  }).join('');

  tbody.querySelectorAll('.btn-row-edit').forEach(btn => {
    btn.addEventListener('click', () => openEditModal(Number(btn.dataset.id), btn.dataset.name));
  });

  tbody.querySelectorAll('.btn-row-delete').forEach(btn => {
    btn.addEventListener('click', () => openDeleteModal(Number(btn.dataset.id), btn.dataset.name));
  });

  tbody.querySelectorAll('.badge-toggle').forEach(badge => {
    badge.addEventListener('click', async () => {
      const id       = Number(badge.dataset.id);
      const isActive = badge.dataset.active === 'true';
      try {
        await toggleCustomerActive(id, !isActive);
        showToast(isActive ? 'Customer deactivated.' : 'Customer activated.', 'success');
        await loadCustomers();
        triggerBackgroundSync();
      } catch (err) {
        showToast(`Error: ${err.message}`, 'error');
      }
    });
  });

  tbody.querySelectorAll('.alias-remove').forEach(btn => {
    btn.addEventListener('click', async e => {
      e.stopPropagation();
      const id       = Number(btn.dataset.id);
      const idx      = Number(btn.dataset.idx);
      const customer = allCustomers.find(c => c.id === id);
      if (!customer) return;
      const newAliases = (customer.aliases || []).filter((_, i) => i !== idx);
      try {
        await updateAliases(id, newAliases);
        await loadCustomers();
        triggerBackgroundSync();
      } catch (err) {
        showToast(`Error: ${err.message}`, 'error');
      }
    });
  });

  tbody.querySelectorAll('.alias-add-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      if (btn.parentNode.querySelector('.alias-input-wrap')) return; // already open
      const id = Number(btn.dataset.id);
      btn.style.display = 'none';

      const wrap = document.createElement('span');
      wrap.className = 'alias-input-wrap';
      wrap.innerHTML = `<input class="alias-inline-input" placeholder="alias…" /><button class="alias-confirm" title="Add">✓</button><button class="alias-cancel" title="Cancel">✕</button>`;
      btn.insertAdjacentElement('afterend', wrap);
      const input = wrap.querySelector('.alias-inline-input');
      input.focus();

      const cancel = () => { wrap.remove(); btn.style.display = ''; };

      const confirm = async () => {
        const alias = input.value.trim();
        if (!alias) { cancel(); return; }
        const customer = allCustomers.find(c => c.id === id);
        if (!customer) { cancel(); return; }
        const newAliases = [...(customer.aliases || []), alias];
        try {
          await updateAliases(id, newAliases);
          await loadCustomers();
          triggerBackgroundSync();
        } catch (err) {
          showToast(`Error: ${err.message}`, 'error');
          cancel();
        }
      };

      wrap.querySelector('.alias-confirm').addEventListener('click', confirm);
      wrap.querySelector('.alias-cancel').addEventListener('click', cancel);
      input.addEventListener('keydown', e => {
        if (e.key === 'Enter') { e.preventDefault(); confirm(); }
        if (e.key === 'Escape') cancel();
      });
    });
  });
}

// ─── Load ─────────────────────────────────────────────────────────────────────

async function loadCustomers() {
  setSyncState('syncing', 'Syncing…');
  try {
    allCustomers = await fetchAllCustomers();
    updateStats(allCustomers);
    applySearch();
    setSyncState('ok', 'Synced');
  } catch (err) {
    setSyncState('error', 'Sync failed');
    showToast(`Failed to load: ${err.message}`, 'error');
    document.getElementById('customerTableBody').innerHTML = `
      <tr>
        <td class="empty-state-cell" colspan="4">
          <div class="empty-state-inner">
            <div class="empty-icon"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg></div>
            <p class="empty-title">Could not load customers</p>
            <p class="empty-sub">Check your Supabase credentials in supabase-config.js</p>
          </div>
        </td>
      </tr>`;
  }
}

function applySearch() {
  const q = document.getElementById('searchInput').value.trim().toLowerCase();
  const filtered = q ? allCustomers.filter(c =>
    c.name.toLowerCase().includes(q) ||
    (c.aliases || []).some(a => a.toLowerCase().includes(q))
  ) : allCustomers;
  renderTable(filtered);
}

// ─── Search ───────────────────────────────────────────────────────────────────

const searchInput = document.getElementById('searchInput');
const searchClear = document.getElementById('searchClear');

searchInput.addEventListener('input', () => {
  searchClear.classList.toggle('hidden', searchInput.value === '');
  applySearch();
});

searchClear.addEventListener('click', () => {
  searchInput.value = '';
  searchClear.classList.add('hidden');
  searchInput.focus();
  applySearch();
});

// ─── Add / Edit Modal ─────────────────────────────────────────────────────────

function openAddModal() {
  editingId = null;
  document.getElementById('modalTitle').textContent    = 'Add New Customer';
  document.getElementById('modalDesc').textContent     = 'Enter the exact name as it appears in Worknotes or the Subject field.';
  document.getElementById('saveBtnText').textContent   = 'Save Customer';
  document.getElementById('customerNameInput').value   = '';
  clearInputError();
  openModal('customerModal');
  document.getElementById('customerNameInput').focus();
}

function openEditModal(id, name) {
  editingId = id;
  document.getElementById('modalTitle').textContent    = 'Edit Customer';
  document.getElementById('modalDesc').textContent     = 'Update the customer name. Changes take effect immediately.';
  document.getElementById('saveBtnText').textContent   = 'Save Changes';
  document.getElementById('customerNameInput').value   = name;
  clearInputError();
  openModal('customerModal');
  const input = document.getElementById('customerNameInput');
  input.focus();
  input.setSelectionRange(name.length, name.length);
}

function openModal(id) {
  document.getElementById(id).classList.remove('hidden');
}

function closeModal(id) {
  document.getElementById(id).classList.add('hidden');
}

document.getElementById('addCustomerBtn').addEventListener('click', openAddModal);
document.getElementById('closeModalBtn').addEventListener('click', () => closeModal('customerModal'));
document.getElementById('cancelBtn').addEventListener('click', () => closeModal('customerModal'));

document.getElementById('customerModal').addEventListener('click', e => {
  if (e.target === e.currentTarget) closeModal('customerModal');
});

// ─── Save ─────────────────────────────────────────────────────────────────────

document.getElementById('saveBtn').addEventListener('click', handleSave);
document.getElementById('customerNameInput').addEventListener('keydown', e => {
  if (e.key === 'Enter') handleSave();
  if (e.key === 'Escape') closeModal('customerModal');
});

async function handleSave() {
  const input = document.getElementById('customerNameInput');
  const name  = input.value.trim();

  if (!name) {
    showInputError('Please enter a customer name.');
    input.focus();
    return;
  }

  const btn     = document.getElementById('saveBtn');
  const spinner = document.getElementById('saveBtnSpinner');
  const btnText = document.getElementById('saveBtnText');

  btn.disabled     = true;
  spinner.classList.remove('hidden');
  btnText.textContent = editingId !== null ? 'Saving…' : 'Adding…';
  clearInputError();

  try {
    if (editingId !== null) {
      await updateCustomer(editingId, name);
      showToast(`"${name}" updated successfully.`, 'success');
    } else {
      await addCustomer(name);
      showToast(`"${name}" added successfully.`, 'success');
    }
    closeModal('customerModal');
    await loadCustomers();
    triggerBackgroundSync();
  } catch (err) {
    showInputError(err.message || 'Something went wrong. Please try again.');
  } finally {
    btn.disabled = false;
    spinner.classList.add('hidden');
    btnText.textContent = editingId !== null ? 'Save Changes' : 'Save Customer';
  }
}

// ─── Delete Modal ─────────────────────────────────────────────────────────────

function openDeleteModal(id, name) {
  deleteTargetId = id;
  document.getElementById('deleteTargetName').textContent = name;
  openModal('deleteModal');
}

document.getElementById('closeDeleteModalBtn').addEventListener('click', () => closeModal('deleteModal'));
document.getElementById('cancelDeleteBtn').addEventListener('click', () => closeModal('deleteModal'));

document.getElementById('deleteModal').addEventListener('click', e => {
  if (e.target === e.currentTarget) closeModal('deleteModal');
});

document.getElementById('confirmDeleteBtn').addEventListener('click', async () => {
  if (deleteTargetId === null) return;

  const btn     = document.getElementById('confirmDeleteBtn');
  const spinner = document.getElementById('deleteBtnSpinner');
  const btnText = document.getElementById('deleteBtnText');

  btn.disabled = true;
  spinner.classList.remove('hidden');
  btnText.textContent = 'Deleting…';

  try {
    const name = allCustomers.find(c => c.id === deleteTargetId)?.name ?? 'Customer';
    await deleteCustomer(deleteTargetId);
    showToast(`"${name}" removed.`, 'success');
    closeModal('deleteModal');
    await loadCustomers();
    triggerBackgroundSync();
  } catch (err) {
    showToast(`Error: ${err.message}`, 'error');
  } finally {
    btn.disabled = false;
    spinner.classList.add('hidden');
    btnText.textContent = 'Delete';
    deleteTargetId = null;
  }
});

// ─── Input Error ──────────────────────────────────────────────────────────────

function showInputError(msg) {
  const err  = document.getElementById('inputError');
  const text = document.getElementById('inputErrorText');
  const inp  = document.getElementById('customerNameInput');
  text.textContent = msg;
  err.classList.remove('hidden');
  inp.classList.add('error');
}

function clearInputError() {
  document.getElementById('inputError').classList.add('hidden');
  document.getElementById('customerNameInput').classList.remove('error');
}

// ─── Toast ────────────────────────────────────────────────────────────────────

let toastTimer = null;

function showToast(message, type = 'success') {
  const toast = document.getElementById('toast');
  const icon  = document.getElementById('toastIcon');
  const msg   = document.getElementById('toastMessage');

  const icons = {
    success: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`,
    error:   `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>`,
  };

  icon.innerHTML     = icons[type] ?? '';
  msg.textContent    = message;
  toast.className    = `toast ${type}`;

  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.add('hidden'), 3500);
}

// ─── Sync Indicator ───────────────────────────────────────────────────────────

function setSyncState(state, label) {
  const dot   = document.querySelector('.sync-dot');
  const lbl   = document.getElementById('syncLabel');
  dot.className = `sync-dot ${state === 'ok' ? '' : state}`;
  lbl.textContent = label;
}

// ─── Background Sync ──────────────────────────────────────────────────────────

function triggerBackgroundSync() {
  chrome.runtime.sendMessage({ action: 'refreshCustomerList' });
}

// ─── Bulk Import ──────────────────────────────────────────────────────────────

function parseImportLines(raw) {
  return raw.split('\n')
    .map(line => {
      const [namePart, aliasPart] = line.split('|').map(s => s.trim());
      if (!namePart) return null;
      const aliases = aliasPart
        ? aliasPart.split(',').map(a => a.trim()).filter(Boolean)
        : [];
      return { name: namePart, aliases };
    })
    .filter(Boolean);
}

function updateImportPreview() {
  const raw     = document.getElementById('importTextarea').value;
  const parsed  = parseImportLines(raw);
  const preview = document.getElementById('importPreview');
  const btn     = document.getElementById('importBtnText');

  if (!parsed.length) {
    preview.classList.add('hidden');
    btn.textContent = 'Import';
    return;
  }

  btn.textContent = `Import ${parsed.length} customer${parsed.length !== 1 ? 's' : ''}`;
  preview.classList.remove('hidden');
  preview.innerHTML = parsed.map(c => `
    <div class="import-row">
      <span class="import-name">${escapeHtml(c.name)}</span>
      ${c.aliases.length ? `<span class="import-aliases">${c.aliases.map(escapeHtml).join(', ')}</span>` : ''}
    </div>`).join('');
}

document.getElementById('importBtn').addEventListener('click', () => {
  document.getElementById('importTextarea').value = '';
  document.getElementById('importPreview').classList.add('hidden');
  document.getElementById('importBtnText').textContent = 'Import';
  openModal('importModal');
  document.getElementById('importTextarea').focus();
});

document.getElementById('closeImportModalBtn').addEventListener('click', () => closeModal('importModal'));
document.getElementById('cancelImportBtn').addEventListener('click', () => closeModal('importModal'));

document.getElementById('importModal').addEventListener('click', e => {
  if (e.target === e.currentTarget) closeModal('importModal');
});

document.getElementById('importTextarea').addEventListener('input', updateImportPreview);

document.getElementById('confirmImportBtn').addEventListener('click', async () => {
  const parsed = parseImportLines(document.getElementById('importTextarea').value);
  if (!parsed.length) return;

  const btn     = document.getElementById('confirmImportBtn');
  const spinner = document.getElementById('importBtnSpinner');
  const btnText = document.getElementById('importBtnText');

  btn.disabled = true;
  spinner.classList.remove('hidden');

  let added = 0, failed = 0;
  for (const { name, aliases } of parsed) {
    try {
      const [result] = await addCustomer(name);
      if (aliases.length) await updateAliases(result.id, aliases);
      added++;
    } catch {
      failed++;
    }
    btnText.textContent = `Importing… ${added + failed}/${parsed.length}`;
  }

  btn.disabled = false;
  spinner.classList.add('hidden');
  closeModal('importModal');
  await loadCustomers();
  triggerBackgroundSync();

  if (failed === 0) {
    showToast(`${added} customer${added !== 1 ? 's' : ''} imported.`, 'success');
  } else {
    showToast(`${added} imported, ${failed} failed (duplicates or errors).`, 'error');
  }
});

// ─── Init ─────────────────────────────────────────────────────────────────────

loadCustomers();
