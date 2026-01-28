const API_BASE = 'http://localhost:3001/api';

// Get token from localStorage
const getToken = () => localStorage.getItem('token');

// API helper
async function api(endpoint, options = {}) {
  const token = getToken();
  const headers = {
    'Content-Type': 'application/json',
    ...(token && { Authorization: `Bearer ${token}` }),
    ...options.headers,
  };

  const response = await fetch(`${API_BASE}${endpoint}`, {
    ...options,
    headers,
  });

  const data = await response.json();
  
  if (!response.ok) {
    throw new Error(data.error || 'API Error');
  }
  
  return data;
}

// Auth
export const demoLogin = (email, username) => 
  api('/auth/demo-login', { method: 'POST', body: JSON.stringify({ email, username }) });

// User
export const getUser = () => api('/user/me');
export const getBalance = () => api('/user/balance');
export const getPositions = () => api('/user/positions');
export const getOrders = () => api('/user/orders');

// Wallet
export const createDeposit = (amount_sats) => 
  api('/wallet/deposit', { method: 'POST', body: JSON.stringify({ amount_sats }) });
export const checkDeposit = (payment_hash) => 
  api('/wallet/check-deposit', { method: 'POST', body: JSON.stringify({ payment_hash }) });
export const simulatePayment = (payment_hash) => 
  api('/wallet/simulate-payment', { method: 'POST', body: JSON.stringify({ payment_hash }) });
export const withdraw = (payment_request, amount_sats) => 
  api('/wallet/withdraw', { method: 'POST', body: JSON.stringify({ payment_request, amount_sats }) });

// Markets
export const getGrandmasters = () => api('/grandmasters');
export const getEventMarket = () => api('/markets/event');
export const getMarket = (id) => api(`/markets/${id}`);

// Orders
export const placeOrder = (market_id, side, price_cents, amount_sats) => 
  api('/orders', { method: 'POST', body: JSON.stringify({ market_id, side, price_cents, amount_sats }) });
export const cancelOrder = (id) => 
  api(`/orders/${id}`, { method: 'DELETE' });

// Admin
export const getAdminMarkets = () => api('/admin/markets');
export const initiateResolution = (market_id, resolution, notes) => 
  api('/admin/resolve/initiate', { method: 'POST', body: JSON.stringify({ market_id, resolution, notes }) });
export const confirmResolution = (market_id, emergency_code) => 
  api('/admin/resolve/confirm', { method: 'POST', body: JSON.stringify({ market_id, emergency_code }) });
export const cancelResolution = (market_id) => 
  api('/admin/resolve/cancel', { method: 'POST', body: JSON.stringify({ market_id }) });
export const addGrandmaster = (data) => 
  api('/admin/grandmasters', { method: 'POST', body: JSON.stringify(data) });

export default api;
