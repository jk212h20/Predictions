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
export const register = (email, password, username) =>
  fetch(`${API_BASE}/auth/register`, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify({ email, password, username }),
  }).then(handleResponse);

export const login = (email, password) =>
  fetch(`${API_BASE}/auth/login`, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify({ email, password }),
  }).then(handleResponse);

export const demoLogin = (email, username) =>
  fetch(`${API_BASE}/auth/demo-login`, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify({ email, username }),
  }).then(handleResponse);

export const googleLogin = (credential) =>
  fetch(`${API_BASE}/auth/google`, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify({ credential }),
  }).then(handleResponse);

export const getGoogleClientId = () =>
  fetch(`${API_BASE}/auth/google-client-id`).then(handleResponse);

// LNURL-auth (Lightning Login)
export const getLnurlAuthChallenge = () =>
  fetch(`${API_BASE}/auth/lnurl`).then(handleResponse);

export const getLnurlAuthStatus = (k1) =>
  fetch(`${API_BASE}/auth/lnurl/status/${k1}`).then(handleResponse);

export const completeLnurlAuth = (k1) =>
  fetch(`${API_BASE}/auth/lnurl/complete`, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify({ k1 }),
  }).then(handleResponse);

export const linkLightning = (k1) =>
  fetch(`${API_BASE}/auth/link-lightning`, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify({ k1 }),
  }).then(handleResponse);

export const mergeAccounts = (k1, confirm = false) =>
  fetch(`${API_BASE}/auth/merge-accounts`, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify({ k1, confirm }),
  }).then(handleResponse);

export const getUser = () =>
  fetch(`${API_BASE}/user/me`, { headers: getHeaders() }).then(handleResponse);

export const getBalance = () =>
  fetch(`${API_BASE}/user/balance`, { headers: getHeaders() }).then(handleResponse);

// Profile management
export const updateProfile = (data) =>
  fetch(`${API_BASE}/user/profile`, {
    method: 'PUT',
    headers: getHeaders(),
    body: JSON.stringify(data),
  }).then(handleResponse);

export const changePassword = (current_password, new_password) =>
  fetch(`${API_BASE}/user/password`, {
    method: 'PUT',
    headers: getHeaders(),
    body: JSON.stringify({ current_password, new_password }),
  }).then(handleResponse);

export const unlinkLightning = () =>
  fetch(`${API_BASE}/user/unlink-lightning`, {
    method: 'POST',
    headers: getHeaders(),
  }).then(handleResponse);

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

// Cancel ALL orders for logged-in user
export const cancelAllOrders = () =>
  fetch(`${API_BASE}/orders/cancel-all`, {
    method: 'POST',
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

// User Portfolio
export const getPositions = () =>
  fetch(`${API_BASE}/user/positions`, { headers: getHeaders() }).then(handleResponse);

export const getOpenOrders = () =>
  fetch(`${API_BASE}/user/orders`, { headers: getHeaders() }).then(handleResponse);

export const getTransactions = (params = {}) => {
  const queryParams = new URLSearchParams();
  if (params.limit) queryParams.append('limit', params.limit);
  if (params.offset) queryParams.append('offset', params.offset);
  if (params.type) queryParams.append('type', params.type);
  
  const queryString = queryParams.toString();
  return fetch(`${API_BASE}/user/transactions${queryString ? '?' + queryString : ''}`, { 
    headers: getHeaders() 
  }).then(handleResponse);
};

export const getTrades = (params = {}) => {
  const queryParams = new URLSearchParams();
  if (params.limit) queryParams.append('limit', params.limit);
  if (params.offset) queryParams.append('offset', params.offset);
  
  const queryString = queryParams.toString();
  return fetch(`${API_BASE}/user/trades${queryString ? '?' + queryString : ''}`, { 
    headers: getHeaders() 
  }).then(handleResponse);
};

// ==================== BOT ADMIN API ====================

// Bot stats and configuration
export const getBotStats = () =>
  fetch(`${API_BASE}/admin/bot/stats`, { headers: getHeaders() }).then(handleResponse);

export const getBotConfig = () =>
  fetch(`${API_BASE}/admin/bot/config`, { headers: getHeaders() }).then(handleResponse);

export const updateBotConfig = (config) =>
  fetch(`${API_BASE}/admin/bot/config`, {
    method: 'PUT',
    headers: getHeaders(),
    body: JSON.stringify(config),
  }).then(handleResponse);

// Bot curves
export const getBuyCurve = (market_type = 'attendance') =>
  fetch(`${API_BASE}/admin/bot/curves/buy?market_type=${market_type}`, { headers: getHeaders() }).then(handleResponse);

export const getSellCurve = (market_type = 'attendance') =>
  fetch(`${API_BASE}/admin/bot/curves/sell?market_type=${market_type}`, { headers: getHeaders() }).then(handleResponse);

export const saveBuyCurve = (market_type, price_points) =>
  fetch(`${API_BASE}/admin/bot/curves/buy`, {
    method: 'PUT',
    headers: getHeaders(),
    body: JSON.stringify({ market_type, price_points }),
  }).then(handleResponse);

export const saveSellCurve = (market_type, price_points) =>
  fetch(`${API_BASE}/admin/bot/curves/sell`, {
    method: 'PUT',
    headers: getHeaders(),
    body: JSON.stringify({ market_type, price_points }),
  }).then(handleResponse);

// Market overrides
export const getMarketOverride = (marketId) =>
  fetch(`${API_BASE}/admin/bot/markets/${marketId}/override`, { headers: getHeaders() }).then(handleResponse);

export const setMarketOverride = (marketId, override_type, multiplier, custom_curve) =>
  fetch(`${API_BASE}/admin/bot/markets/${marketId}/override`, {
    method: 'PUT',
    headers: getHeaders(),
    body: JSON.stringify({ override_type, multiplier, custom_curve }),
  }).then(handleResponse);

export const batchSetOverride = (market_ids, override_type, multiplier) =>
  fetch(`${API_BASE}/admin/bot/batch-override`, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify({ market_ids, override_type, multiplier }),
  }).then(handleResponse);

// Bot orders and holdings
export const getBotOrders = () =>
  fetch(`${API_BASE}/admin/bot/orders`, { headers: getHeaders() }).then(handleResponse);

export const getBotHoldings = () =>
  fetch(`${API_BASE}/admin/bot/holdings`, { headers: getHeaders() }).then(handleResponse);

export const getBotMarkets = () =>
  fetch(`${API_BASE}/admin/bot/markets`, { headers: getHeaders() }).then(handleResponse);

// Bot deployment
export const deployMarketOrders = (marketId) =>
  fetch(`${API_BASE}/admin/bot/deploy/${marketId}`, {
    method: 'POST',
    headers: getHeaders(),
  }).then(handleResponse);

export const deployAllOrders = () =>
  fetch(`${API_BASE}/admin/bot/deploy-all`, {
    method: 'POST',
    headers: getHeaders(),
  }).then(handleResponse);

export const getDeploymentPreview = () =>
  fetch(`${API_BASE}/admin/bot/deployment-preview`, { headers: getHeaders() }).then(handleResponse);

export const withdrawAllOrders = () =>
  fetch(`${API_BASE}/admin/bot/withdraw-all`, {
    method: 'POST',
    headers: getHeaders(),
  }).then(handleResponse);

// Bot analytics
export const getBotWorstCase = () =>
  fetch(`${API_BASE}/admin/bot/worst-case`, { headers: getHeaders() }).then(handleResponse);

export const getBotLog = (limit = 50) =>
  fetch(`${API_BASE}/admin/bot/log?limit=${limit}`, { headers: getHeaders() }).then(handleResponse);

// ==================== CURVE SHAPE LIBRARY ====================

// Preview a shape without saving
export const previewShape = (shape_type, params = {}) =>
  fetch(`${API_BASE}/admin/bot/shapes/preview`, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify({ shape_type, params }),
  }).then(handleResponse);

// Get all saved shapes
export const getShapes = () =>
  fetch(`${API_BASE}/admin/bot/shapes`, { headers: getHeaders() }).then(handleResponse);

// Get default shape
export const getDefaultShape = () =>
  fetch(`${API_BASE}/admin/bot/shapes/default`, { headers: getHeaders() }).then(handleResponse);

// Save a new shape
export const saveShape = (name, shape_type, params = {}, normalized_points = null) =>
  fetch(`${API_BASE}/admin/bot/shapes`, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify({ name, shape_type, params, normalized_points }),
  }).then(handleResponse);

// Get a specific shape
export const getShape = (id) =>
  fetch(`${API_BASE}/admin/bot/shapes/${id}`, { headers: getHeaders() }).then(handleResponse);

// Update a shape
export const updateShape = (id, params, normalized_points = null) =>
  fetch(`${API_BASE}/admin/bot/shapes/${id}`, {
    method: 'PUT',
    headers: getHeaders(),
    body: JSON.stringify({ params, normalized_points }),
  }).then(handleResponse);

// Set a shape as default
export const setDefaultShape = (id) =>
  fetch(`${API_BASE}/admin/bot/shapes/${id}/set-default`, {
    method: 'POST',
    headers: getHeaders(),
  }).then(handleResponse);

// Delete a shape
export const deleteShape = (id) =>
  fetch(`${API_BASE}/admin/bot/shapes/${id}`, {
    method: 'DELETE',
    headers: getHeaders(),
  }).then(handleResponse);

// ==================== MARKET WEIGHTS ====================

// Initialize weights for all attendance markets
export const initializeWeights = () =>
  fetch(`${API_BASE}/admin/bot/weights/initialize`, {
    method: 'POST',
    headers: getHeaders(),
  }).then(handleResponse);

// Get all market weights
export const getMarketWeights = () =>
  fetch(`${API_BASE}/admin/bot/weights`, { headers: getHeaders() }).then(handleResponse);

// Set weight for a specific market (auto-rebalances others)
export const setMarketWeight = (marketId, weight, lock = false) =>
  fetch(`${API_BASE}/admin/bot/weights/${marketId}`, {
    method: 'PUT',
    headers: getHeaders(),
    body: JSON.stringify({ weight, lock }),
  }).then(handleResponse);

// Lock/unlock a market weight
export const setWeightLock = (marketId, locked) =>
  fetch(`${API_BASE}/admin/bot/weights/${marketId}/lock`, {
    method: 'PUT',
    headers: getHeaders(),
    body: JSON.stringify({ locked }),
  }).then(handleResponse);

// Set relative odds for a market
export const setRelativeOdds = (marketId, relative_odds) =>
  fetch(`${API_BASE}/admin/bot/weights/${marketId}/odds`, {
    method: 'PUT',
    headers: getHeaders(),
    body: JSON.stringify({ relative_odds }),
  }).then(handleResponse);

// Apply relative odds to recalculate weights
export const applyRelativeOdds = () =>
  fetch(`${API_BASE}/admin/bot/weights/apply-odds`, {
    method: 'POST',
    headers: getHeaders(),
  }).then(handleResponse);

// Batch set relative odds (for importing a vector)
export const batchSetOdds = (odds) =>
  fetch(`${API_BASE}/admin/bot/weights/batch-odds`, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify({ odds }),
  }).then(handleResponse);

// ==================== TIER MANAGEMENT ====================

// Get tier summary (all tiers with budget percentages)
export const getTierSummary = () =>
  fetch(`${API_BASE}/admin/bot/tiers`, { headers: getHeaders() }).then(handleResponse);

// Get markets in a specific tier
export const getTierMarkets = (tier) =>
  fetch(`${API_BASE}/admin/bot/tiers/${encodeURIComponent(tier)}/markets`, { headers: getHeaders() }).then(handleResponse);

// Set budget percentage for a tier (auto-rebalances other tiers)
export const setTierBudget = (tier, budget_percent) =>
  fetch(`${API_BASE}/admin/bot/tiers/${encodeURIComponent(tier)}/budget`, {
    method: 'PUT',
    headers: getHeaders(),
    body: JSON.stringify({ budget_percent }),
  }).then(handleResponse);

// Initialize weights from likelihood scores
export const initializeFromScores = () =>
  fetch(`${API_BASE}/admin/bot/tiers/initialize-from-scores`, {
    method: 'POST',
    headers: getHeaders(),
  }).then(handleResponse);
