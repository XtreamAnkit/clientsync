// ─── Backend endpoints: PRIMARY (new) with automatic FALLBACK (old) ──────────
// The new Supabase project is primary (healthy). The old project is kept as a
// safety net: if the primary is ever unreachable / paused (e.g. a repeat of the
// free-tier 402 outage), the extension transparently retries the SAME request
// against the fallback, so detection never goes dark. 4xx responses (401/404…)
// are NOT treated as an outage — only network errors and 402/5xx fail over.
const PRIMARY_BASE  = 'https://zdrvlyudicqxavzpiwjv.supabase.co/functions/v1';
const FALLBACK_BASE = 'https://suqpzsaytsrtokibqxbv.supabase.co/functions/v1';
const BASES = [PRIMARY_BASE, FALLBACK_BASE];

const TELEMETRY_PATH = '/telemetry';

const CLIENT_SECRET = 'cs-snowbit-k9x2m7pq4r';

const HEADERS = {
  'x-client-secret': CLIENT_SECRET,
  'Content-Type': 'application/json'
};

// Try primary first; on a network error or a 402/5xx (outage-shaped) response,
// retry the same request against the fallback project. Returns the first usable
// Response; throws only if every backend is unreachable.
async function failoverFetch(path, init) {
  let lastErr = null;
  for (const base of BASES) {
    try {
      const res = await fetch(base + path, init);
      if (res.status === 402 || res.status >= 500) { lastErr = new Error(`HTTP ${res.status}`); continue; }
      return res;
    } catch (e) { lastErr = e; /* network error — try the next backend */ }
  }
  throw lastErr || new Error('all backends unreachable');
}

// Combined bundle: config + this agent's override + client list in ONE call.
// Returns { config, override, customers } or null on failure. This is the hot
// path the extension polls, so it's a single invocation instead of two.
export async function fetchBundle(agentEmail) {
  try {
    const qs = agentEmail ? `?resource=bundle&email=${encodeURIComponent(agentEmail)}` : '?resource=bundle';
    const res = await failoverFetch(`${TELEMETRY_PATH}${qs}`, { headers: HEADERS });
    if (!res.ok) return null;
    return await res.json(); // { config, override, customers }
  } catch (_) { return null; }
}

// Fetch the remote-control config plus this agent's override (if any).
// Returns { config, override } or null on failure so the extension falls back
// to its cached (or default) behaviour.
export async function fetchConfig(agentEmail) {
  try {
    const qs = agentEmail ? `?resource=config&email=${encodeURIComponent(agentEmail)}` : '?resource=config';
    const res = await failoverFetch(`${TELEMETRY_PATH}${qs}`, { headers: HEADERS });
    if (!res.ok) return null;
    return await res.json(); // { config, override }
  } catch (_) { return null; }
}

// Personal impact stat for the signed-in analyst — ONLY their own detection
// counts. Returns { month, total } or null. This is the single analytic the
// client-secret surface may read, and only for the agent's own email.
export async function fetchMyStats(agentEmail) {
  if (!agentEmail) return null;
  try {
    const res = await failoverFetch(`${TELEMETRY_PATH}?resource=my_stats&email=${encodeURIComponent(agentEmail)}`, { headers: HEADERS });
    if (!res.ok) return null;
    return await res.json(); // { month, total }
  } catch (_) { return null; }
}

// Fire-and-forget telemetry POST. Never throws — telemetry must never disrupt
// the extension's core behaviour, so failures are swallowed silently.
export async function sendTelemetry(payload) {
  try {
    await failoverFetch(TELEMETRY_PATH, {
      method: 'POST',
      headers: HEADERS,
      body: JSON.stringify(payload)
    });
  } catch (_) { /* offline / backend down — ignore */ }
}

async function handleResponse(res) {
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `HTTP ${res.status}`);
  }
  return res.status === 204 ? null : res.json();
}

// Fetch ALL customers (name + aliases + active flag) via the telemetry endpoint,
// which also lazily auto-reactivates expired temporary inactivations. Names are
// always watched; the active flag only controls whether the customer's OWN
// tickets are scanned (inactive = that org's tickets are exempt).
export async function fetchCustomers() {
  const res = await failoverFetch(`${TELEMETRY_PATH}?resource=active_customers`, { headers: HEADERS });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  return (data.customers || []).map(row => ({
    name: row.name,
    aliases: row.aliases || [],
    is_active: row.is_active !== false,
    sensitivity: row.sensitivity || 'normal',
    rules: row.rules || null
  }));
}

// Change a customer's active state with an audited reason. Used by the settings
// toggle (reason 'manual'), the false-positive flow (reason 'false_positive'),
// and the sync (reason 'sync'). Temporary reasons auto-revert after 10 minutes.
export async function setCustomerStatus({ id, name, active, reason, actor, comment }) {
  return handleResponse(await failoverFetch(TELEMETRY_PATH, {
    method: 'POST',
    headers: HEADERS,
    body: JSON.stringify({ type: 'customer_status', id, name, active, reason, actor, comment })
  }));
}

// Fetch all customers with full details (id, name, aliases, is_active,
// created_at…) via telemetry — used by the settings page. Returns the array.
export async function fetchAllCustomers() {
  const data = await handleResponse(await failoverFetch(`${TELEMETRY_PATH}?resource=all_customers`, { headers: HEADERS }));
  return (data && data.customers) || [];
}

// Add a new customer. Returns [row] (first element has .id) so the settings
// bulk-import can immediately attach aliases to the new id.
export async function addCustomer(name) {
  const row = await handleResponse(await failoverFetch(TELEMETRY_PATH, {
    method: 'POST',
    headers: HEADERS,
    body: JSON.stringify({ type: 'customer_add', name: name.trim() })
  }));
  return [row];
}

// Update an existing customer's name
export async function updateCustomer(id, name) {
  return handleResponse(await failoverFetch(TELEMETRY_PATH, {
    method: 'POST',
    headers: HEADERS,
    body: JSON.stringify({ type: 'customer_update', id, name: name.trim() })
  }));
}

// Toggle a customer's active status (kept for completeness; the settings page
// uses setCustomerStatus for the audited quarantine flow instead).
export async function toggleCustomerActive(id, isActive) {
  return handleResponse(await failoverFetch(TELEMETRY_PATH, {
    method: 'POST',
    headers: HEADERS,
    body: JSON.stringify({ type: 'customer_update', id, is_active: isActive })
  }));
}

// Update aliases for a customer
export async function updateAliases(id, aliases) {
  return handleResponse(await failoverFetch(TELEMETRY_PATH, {
    method: 'POST',
    headers: HEADERS,
    body: JSON.stringify({ type: 'customer_update', id, aliases })
  }));
}

// Delete a customer
export async function deleteCustomer(id) {
  return handleResponse(await failoverFetch(`${TELEMETRY_PATH}?customer_id=${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: HEADERS
  }));
}
