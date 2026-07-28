const EDGE_URL      = 'https://suqpzsaytsrtokibqxbv.supabase.co/functions/v1/customers';
const TELEMETRY_URL = 'https://suqpzsaytsrtokibqxbv.supabase.co/functions/v1/telemetry';
const CLIENT_SECRET = 'cs-snowbit-k9x2m7pq4r';

const HEADERS = {
  'x-client-secret': CLIENT_SECRET,
  'Content-Type': 'application/json'
};

// Fire-and-forget telemetry POST. Never throws — telemetry must never disrupt
// the extension's core behaviour, so failures are swallowed silently.
export async function sendTelemetry(payload) {
  try {
    await fetch(TELEMETRY_URL, {
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

// Fetch only active customers (name + aliases) — used by background for caching
export async function fetchActiveCustomerNames() {
  const data = await handleResponse(await fetch(EDGE_URL, { headers: HEADERS }));
  return data.map(row => ({ name: row.name, aliases: row.aliases || [] }));
}

// Fetch all customers with full details — used by settings page
export async function fetchAllCustomers() {
  return handleResponse(await fetch(`${EDGE_URL}?all=true`, { headers: HEADERS }));
}

// Add a new customer
export async function addCustomer(name) {
  return handleResponse(await fetch(EDGE_URL, {
    method: 'POST',
    headers: HEADERS,
    body: JSON.stringify({ name: name.trim() })
  }));
}

// Update an existing customer's name
export async function updateCustomer(id, name) {
  return handleResponse(await fetch(`${EDGE_URL}/${id}`, {
    method: 'PATCH',
    headers: HEADERS,
    body: JSON.stringify({ name: name.trim() })
  }));
}

// Toggle a customer's active status
export async function toggleCustomerActive(id, isActive) {
  return handleResponse(await fetch(`${EDGE_URL}/${id}`, {
    method: 'PATCH',
    headers: HEADERS,
    body: JSON.stringify({ is_active: isActive })
  }));
}

// Update aliases for a customer
export async function updateAliases(id, aliases) {
  return handleResponse(await fetch(`${EDGE_URL}/${id}`, {
    method: 'PATCH',
    headers: HEADERS,
    body: JSON.stringify({ aliases })
  }));
}

// Delete a customer
export async function deleteCustomer(id) {
  return handleResponse(await fetch(`${EDGE_URL}/${id}`, {
    method: 'DELETE',
    headers: HEADERS
  }));
}
