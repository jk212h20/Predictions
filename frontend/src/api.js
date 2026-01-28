// API base URL - uses relative path in production, localhost in dev
const API_BASE = import.meta.env.PROD ? '/api' : 'http://localhost:3001/api';

const getHeaders = () => {
  const headers = { 'Content-Type': 'application/json' };
  const token = localStorage.getItem('token');
  if (token) headers['Authorization'] = `Bearer ${token}`;
  return headers;
};

const handleResponse = async (res) => {
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
};

// Auth
export const demoLogin = (email, username) =>
  fetch(`${API_BASE}/auth/demo-login`, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify({ email, username }),
  }).then(handleResponse);

export const getUser = () =>
  fetch(`${API_BASE}/user/me`, { headers: getHeaders() }).then(handleResponse);

export const getBalance = () =>
  fetch(`${API_BASE}/user/balance`, { headers: getHeaders() }).then(handleResponse);

// Markets
export const getGrandmasters = () =>
  fetch(`${API_BASE}/grandmasters`).then(handleResponse);

export const getEventMarket = () =>
  fetch(`${API_BASE}/markets/event`).then(handleResponse);

export const getMarket = (id) =>
  fetch(`${API_BASE}/markets/${id}`).then(handleResponse);

// Orders
export const placeOrder = (market_id, side, price_cents, amount_sats) =>
  fetch(`${API_BASE}/orders`, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify({ market_id, side, price_cents, amount_sats }),
  }).then(handleResponse);

export const cancelOrder = (id) =>
  fetch(`${API_BASE}/orders/${id}`, {
    method: 'DELETE',
    headers: getHeaders(),
  }).then(handleResponse);

// Wallet
export const createDeposit = (amount_sats) =>
  fetch(`${API_BASE}/wallet/deposit`, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify({ amount_sats }),
  }).then(handleResponse);

export const checkDeposit = (payment_hash) =>
  fetch(`${API_BASE}/wallet/check-deposit`, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify({ payment_hash }),
  }).then(handleResponse);

export const simulatePayment = (payment_hash) =>
  fetch(`${API_BASE}/wallet/simulate-payment`, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify({ payment_hash }),
  }).then(handleResponse);

export const withdraw = (payment_request, amount_sats) =>
  fetch(`${API_BASE}/wallet/withdraw`, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify({ payment_request, amount_sats }),
  }).then(handleResponse);

// Admin
export const getAdminMarkets = () =>
  fetch(`${API_BASE}/admin/markets`, { headers: getHeaders() }).then(handleResponse);

export const initiateResolution = (market_id, resolution, notes) =>
  fetch(`${API_BASE}/admin/resolve/initiate`, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify({ market_id, resolution, notes }),
  }).then(handleResponse);

export const confirmResolution = (market_id, emergency_code) =>
  fetch(`${API_BASE}/admin/resolve/confirm`, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify({ market_id, emergency_code }),
  }).then(handleResponse);

export const cancelResolution = (market_id) =>
  fetch(`${API_BASE}/admin/resolve/cancel`, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify({ market_id }),
  }).then(handleResponse);
