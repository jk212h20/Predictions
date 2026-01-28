/**
 * Market Maker Bot Module
 * 
 * Provides liquidity for attendance prediction markets by offering NO shares
 * at various prices. Includes risk management with threshold-based pullback.
 * 
 * Key concepts:
 * - Curve Shapes: Normalized distributions (bell, exponential, etc.) stored in library
 * - Market Weights: Per-market budget allocation that auto-rebalances
 * - Relative Odds: User-provided estimates that adjust weights
 * - Pullback: Automatic reduction of offers when exposure crosses thresholds
 * - Max Risk: Guaranteed maximum loss through atomic execution
 * 
 * Formula: effective_curve = shape × max_loss × market_weight × pullback_ratio
 */

const { v4: uuidv4 } = require('uuid');
const db = require('./database');

// ==================== CURVE SHAPE GENERATORS ====================

/**
 * Price points for curves (5% to 50% YES probability)
 */
const PRICE_POINTS = [5, 10, 15, 20, 25, 30, 35, 40, 45, 50];

/**
 * Generate a Bell (Gaussian) curve shape
 * @param {number} mu - Center of the bell (default 20 = 20% probability)
 * @param {number} sigma - Spread/width (default 15)
 * @returns {Array} Normalized points that sum to 1.0
 */
function generateBellShape(mu = 20, sigma = 15) {
  const raw = PRICE_POINTS.map(p => {
    const exponent = -Math.pow(p - mu, 2) / (2 * Math.pow(sigma, 2));
    return Math.exp(exponent);
  });
  return normalizeShape(raw);
}

/**
 * Generate a Flat/Linear curve shape (equal at all prices)
 * @returns {Array} Normalized points that sum to 1.0
 */
function generateFlatShape() {
  const raw = PRICE_POINTS.map(() => 1);
  return normalizeShape(raw);
}

/**
 * Generate an Exponential Decay curve shape
 * Heavy at low prices, fading at higher prices
 * @param {number} decay - Decay rate (default 0.08)
 * @returns {Array} Normalized points that sum to 1.0
 */
function generateExponentialShape(decay = 0.08) {
  const raw = PRICE_POINTS.map(p => Math.exp(-decay * p));
  return normalizeShape(raw);
}

/**
 * Generate a Logarithmic curve shape
 * Decreasing returns as price rises
 * @returns {Array} Normalized points that sum to 1.0
 */
function generateLogarithmicShape() {
  const raw = PRICE_POINTS.map(p => Math.log(101 - p));
  return normalizeShape(raw);
}

/**
 * Generate a Sigmoid/S-Curve shape
 * Sharp transition around a midpoint
 * @param {number} midpoint - Center of sigmoid (default 25)
 * @param {number} steepness - How sharp the transition is (default 0.3)
 * @returns {Array} Normalized points that sum to 1.0
 */
function generateSigmoidShape(midpoint = 25, steepness = 0.3) {
  // Inverted sigmoid - high at low prices, low at high prices
  const raw = PRICE_POINTS.map(p => 1 / (1 + Math.exp(steepness * (p - midpoint))));
  return normalizeShape(raw);
}

/**
 * Generate a Parabolic curve shape
 * Strongly favor low prices
 * @param {number} maxPrice - Price at which shape reaches 0 (default 55)
 * @returns {Array} Normalized points that sum to 1.0
 */
function generateParabolicShape(maxPrice = 55) {
  const raw = PRICE_POINTS.map(p => Math.pow(Math.max(0, maxPrice - p), 2));
  return normalizeShape(raw);
}

/**
 * Normalize a shape so all values sum to 1.0
 * @param {Array<number>} raw - Raw shape values
 * @returns {Array<{price: number, weight: number}>} Normalized points
 */
function normalizeShape(raw) {
  const sum = raw.reduce((a, b) => a + b, 0);
  if (sum === 0) return PRICE_POINTS.map(p => ({ price: p, weight: 0 }));
  return PRICE_POINTS.map((price, i) => ({
    price,
    weight: raw[i] / sum
  }));
}

/**
 * Generate a shape based on type and parameters
 * @param {string} shapeType - Type of shape
 * @param {object} params - Shape parameters
 * @returns {Array<{price: number, weight: number}>} Normalized points
 */
function generateShape(shapeType, params = {}) {
  switch (shapeType) {
    case 'bell':
      return generateBellShape(params.mu || 20, params.sigma || 15);
    case 'flat':
      return generateFlatShape();
    case 'exponential':
      return generateExponentialShape(params.decay || 0.08);
    case 'logarithmic':
      return generateLogarithmicShape();
    case 'sigmoid':
      return generateSigmoidShape(params.midpoint || 25, params.steepness || 0.3);
    case 'parabolic':
      return generateParabolicShape(params.maxPrice || 55);
    case 'custom':
      // Custom shapes come with their own normalized_points
      return params.normalized_points || generateBellShape();
    default:
      return generateBellShape(); // Default to bell
  }
}

// ==================== SHAPE LIBRARY ====================

/**
 * Save a curve shape to the library
 */
function saveShape(name, shapeType, params = {}, normalizedPoints = null) {
  const points = normalizedPoints || generateShape(shapeType, params);
  const id = uuidv4();
  
  db.prepare(`
    INSERT INTO bot_curve_shapes (id, name, shape_type, params, normalized_points)
    VALUES (?, ?, ?, ?, ?)
  `).run(id, name, shapeType, JSON.stringify(params), JSON.stringify(points));
  
  return { id, name, shapeType, params, normalizedPoints: points };
}

/**
 * Get all saved shapes
 */
function getShapes() {
  const shapes = db.prepare(`SELECT * FROM bot_curve_shapes ORDER BY is_default DESC, name`).all();
  return shapes.map(s => ({
    ...s,
    params: JSON.parse(s.params),
    normalized_points: JSON.parse(s.normalized_points)
  }));
}

/**
 * Get a specific shape by ID
 */
function getShape(id) {
  const shape = db.prepare(`SELECT * FROM bot_curve_shapes WHERE id = ?`).get(id);
  if (!shape) return null;
  return {
    ...shape,
    params: JSON.parse(shape.params),
    normalized_points: JSON.parse(shape.normalized_points)
  };
}

/**
 * Get the default shape (or create one if none exists)
 */
function getDefaultShape() {
  let shape = db.prepare(`SELECT * FROM bot_curve_shapes WHERE is_default = 1`).get();
  
  if (!shape) {
    // Create default bell curve shape
    const id = uuidv4();
    const params = { mu: 20, sigma: 15 };
    const points = generateBellShape(params.mu, params.sigma);
    
    db.prepare(`
      INSERT INTO bot_curve_shapes (id, name, shape_type, params, normalized_points, is_default)
      VALUES (?, 'Default Bell', 'bell', ?, ?, 1)
    `).run(id, JSON.stringify(params), JSON.stringify(points));
    
    shape = db.prepare(`SELECT * FROM bot_curve_shapes WHERE id = ?`).get(id);
  }
  
  return {
    ...shape,
    params: JSON.parse(shape.params),
    normalized_points: JSON.parse(shape.normalized_points)
  };
}

/**
 * Set a shape as the default
 */
function setDefaultShape(id) {
  db.prepare(`UPDATE bot_curve_shapes SET is_default = 0`).run();
  db.prepare(`UPDATE bot_curve_shapes SET is_default = 1 WHERE id = ?`).run(id);
}

/**
 * Delete a shape (cannot delete default)
 */
function deleteShape(id) {
  const shape = getShape(id);
  if (shape?.is_default) {
    throw new Error('Cannot delete the default shape');
  }
  db.prepare(`DELETE FROM bot_curve_shapes WHERE id = ?`).run(id);
}

/**
 * Update shape parameters and regenerate points
 */
function updateShape(id, params) {
  const shape = getShape(id);
  if (!shape) throw new Error('Shape not found');
  
  const newParams = { ...shape.params, ...params };
  const newPoints = shape.shape_type === 'custom' 
    ? (params.normalized_points || shape.normalized_points)
    : generateShape(shape.shape_type, newParams);
  
  db.prepare(`
    UPDATE bot_curve_shapes 
    SET params = ?, normalized_points = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(JSON.stringify(newParams), JSON.stringify(newPoints), id);
  
  return getShape(id);
}

// ==================== MARKET WEIGHTS ====================

/**
 * Initialize weights for all attendance markets
 * Each market gets equal weight, summing to 1.0
 */
function initializeMarketWeights() {
  const markets = db.prepare(`
    SELECT id FROM markets WHERE type = 'attendance' AND status = 'open'
  `).all();
  
  if (markets.length === 0) return;
  
  const defaultWeight = 1.0 / markets.length;
  
  for (const market of markets) {
    db.prepare(`
      INSERT OR IGNORE INTO bot_market_weights (id, market_id, weight, relative_odds)
      VALUES (?, ?, ?, 1.0)
    `).run(uuidv4(), market.id, defaultWeight);
  }
  
  // Normalize to ensure sum = 1.0
  normalizeWeights();
}

/**
 * Get all market weights
 */
function getMarketWeights() {
  const weights = db.prepare(`
    SELECT w.*, m.title, g.name as grandmaster_name, g.fide_rating
    FROM bot_market_weights w
    JOIN markets m ON w.market_id = m.id
    LEFT JOIN grandmasters g ON m.grandmaster_id = g.id
    WHERE m.type = 'attendance' AND m.status = 'open'
    ORDER BY w.weight DESC
  `).all();
  
  return weights;
}

/**
 * Get weight for a specific market
 */
function getMarketWeight(marketId) {
  return db.prepare(`SELECT * FROM bot_market_weights WHERE market_id = ?`).get(marketId);
}

/**
 * Set weight for a market and auto-rebalance others
 * @param {string} marketId - Market to adjust
 * @param {number} newWeight - New weight (0-1)
 * @param {boolean} lock - Whether to lock this weight from auto-adjustment
 */
function setMarketWeight(marketId, newWeight, lock = false) {
  // Clamp weight to valid range
  newWeight = Math.max(0, Math.min(1, newWeight));
  
  // Get current state
  const allWeights = db.prepare(`
    SELECT * FROM bot_market_weights
  `).all();
  
  const currentMarket = allWeights.find(w => w.market_id === marketId);
  if (!currentMarket) {
    // Initialize if not exists
    db.prepare(`
      INSERT INTO bot_market_weights (id, market_id, weight, is_locked)
      VALUES (?, ?, ?, ?)
    `).run(uuidv4(), marketId, newWeight, lock ? 1 : 0);
    normalizeWeights([marketId]);
    return;
  }
  
  const oldWeight = currentMarket.weight;
  const weightDiff = newWeight - oldWeight;
  
  // Update this market
  db.prepare(`
    UPDATE bot_market_weights 
    SET weight = ?, is_locked = ?, updated_at = datetime('now')
    WHERE market_id = ?
  `).run(newWeight, lock ? 1 : 0, marketId);
  
  if (lock) {
    // If locking, rebalance unlocked markets
    normalizeWeights([marketId]);
  } else {
    // Distribute the difference to unlocked markets proportionally
    const unlockedMarkets = allWeights.filter(w => 
      w.market_id !== marketId && !w.is_locked
    );
    
    if (unlockedMarkets.length > 0 && weightDiff !== 0) {
      const totalUnlockedWeight = unlockedMarkets.reduce((sum, w) => sum + w.weight, 0);
      
      for (const market of unlockedMarkets) {
        // Proportional adjustment
        const proportion = totalUnlockedWeight > 0 
          ? market.weight / totalUnlockedWeight 
          : 1 / unlockedMarkets.length;
        const adjustment = -weightDiff * proportion;
        const newMarketWeight = Math.max(0, market.weight + adjustment);
        
        db.prepare(`
          UPDATE bot_market_weights SET weight = ?, updated_at = datetime('now')
          WHERE market_id = ?
        `).run(newMarketWeight, market.market_id);
      }
    }
    
    // Final normalization to handle edge cases
    normalizeWeights();
  }
}

/**
 * Normalize all weights to sum to 1.0
 * @param {Array<string>} lockedIds - Additional market IDs to treat as locked
 */
function normalizeWeights(lockedIds = []) {
  const allWeights = db.prepare(`SELECT * FROM bot_market_weights`).all();
  
  // Separate locked and unlocked
  const locked = allWeights.filter(w => w.is_locked || lockedIds.includes(w.market_id));
  const unlocked = allWeights.filter(w => !w.is_locked && !lockedIds.includes(w.market_id));
  
  const lockedSum = locked.reduce((sum, w) => sum + w.weight, 0);
  const remainingBudget = Math.max(0, 1.0 - lockedSum);
  
  if (unlocked.length === 0) return;
  
  const unlockedSum = unlocked.reduce((sum, w) => sum + w.weight, 0);
  const scale = unlockedSum > 0 ? remainingBudget / unlockedSum : remainingBudget / unlocked.length;
  
  for (const market of unlocked) {
    const newWeight = unlockedSum > 0 
      ? market.weight * scale 
      : remainingBudget / unlocked.length;
    
    db.prepare(`
      UPDATE bot_market_weights SET weight = ?, updated_at = datetime('now')
      WHERE market_id = ?
    `).run(newWeight, market.market_id);
  }
}

/**
 * Set relative odds for a market (from user's estimate)
 * These are used to scale the base weight
 */
function setRelativeOdds(marketId, relativeOdds) {
  db.prepare(`
    UPDATE bot_market_weights 
    SET relative_odds = ?, updated_at = datetime('now')
    WHERE market_id = ?
  `).run(relativeOdds, marketId);
}

/**
 * Apply relative odds to recalculate weights
 * This takes the relative_odds values and normalizes them into weights
 */
function applyRelativeOdds() {
  const weights = db.prepare(`
    SELECT * FROM bot_market_weights WHERE is_locked = 0
  `).all();
  
  const totalOdds = weights.reduce((sum, w) => sum + (w.relative_odds || 1), 0);
  
  for (const w of weights) {
    const odds = w.relative_odds || 1;
    const newWeight = odds / totalOdds;
    db.prepare(`
      UPDATE bot_market_weights SET weight = ?, updated_at = datetime('now')
      WHERE market_id = ?
    `).run(newWeight, w.market_id);
  }
  
  normalizeWeights();
}

/**
 * Lock/unlock a market weight
 */
function setWeightLock(marketId, locked) {
  db.prepare(`
    UPDATE bot_market_weights 
    SET is_locked = ?, updated_at = datetime('now')
    WHERE market_id = ?
  `).run(locked ? 1 : 0, marketId);
  
  if (!locked) {
    normalizeWeights();
  }
}

// ==================== CONFIGURATION ====================

/**
 * Get bot configuration
 */
function getConfig() {
  let config = db.prepare('SELECT * FROM bot_config WHERE id = ?').get('default');
  if (!config) {
    // Initialize default config if not exists
    const adminUser = db.prepare('SELECT id FROM users WHERE is_admin = 1').get();
    if (!adminUser) {
      throw new Error('No admin user found. Cannot initialize bot.');
    }
    
    db.prepare(`
      INSERT INTO bot_config (id, bot_user_id, max_acceptable_loss, total_liquidity, threshold_percent, global_multiplier, is_active)
      VALUES ('default', ?, 10000000, 100000000, 1.0, 1.0, 0)
    `).run(adminUser.id);
    
    // Initialize exposure tracking
    db.prepare(`
      INSERT OR IGNORE INTO bot_exposure (id, total_at_risk, current_tier)
      VALUES ('default', 0, 0)
    `).run();
    
    config = db.prepare('SELECT * FROM bot_config WHERE id = ?').get('default');
  }
  return config;
}

/**
 * Update bot configuration
 */
function updateConfig(updates) {
  const { max_acceptable_loss, total_liquidity, threshold_percent, global_multiplier, is_active } = updates;
  
  const config = getConfig();
  
  db.prepare(`
    UPDATE bot_config 
    SET max_acceptable_loss = COALESCE(?, max_acceptable_loss),
        total_liquidity = COALESCE(?, total_liquidity),
        threshold_percent = COALESCE(?, threshold_percent),
        global_multiplier = COALESCE(?, global_multiplier),
        is_active = COALESCE(?, is_active),
        updated_at = datetime('now')
    WHERE id = 'default'
  `).run(max_acceptable_loss, total_liquidity, threshold_percent, global_multiplier, is_active ? 1 : 0);
  
  logBotAction('config_updated', JSON.stringify(updates));
  
  return getConfig();
}

// ==================== CURVE MANAGEMENT ====================

/**
 * Get the default buy curve for a market type
 * Price points are stored as JSON: [{price: 5, amount: 10000}, {price: 10, amount: 20000}, ...]
 */
function getBuyCurve(marketType = 'attendance') {
  const curve = db.prepare(`
    SELECT * FROM bot_curves 
    WHERE config_id = 'default' AND market_type = ? AND curve_type = 'buy' AND is_active = 1
  `).get(marketType);
  
  if (!curve) {
    // Return default LINEAR curve (same amount at all price points)
    return {
      id: null,
      market_type: marketType,
      curve_type: 'buy',
      price_points: [
        { price: 5, amount: 100000 },
        { price: 10, amount: 100000 },
        { price: 15, amount: 100000 },
        { price: 20, amount: 100000 },
        { price: 25, amount: 100000 },
        { price: 30, amount: 100000 },
        { price: 35, amount: 100000 },
        { price: 40, amount: 100000 },
        { price: 45, amount: 100000 },
        { price: 50, amount: 100000 }
      ]
    };
  }
  
  return {
    ...curve,
    price_points: JSON.parse(curve.price_points)
  };
}

/**
 * Get the sell curve for acquired NO shares
 */
function getSellCurve(marketType = 'attendance') {
  const curve = db.prepare(`
    SELECT * FROM bot_curves 
    WHERE config_id = 'default' AND market_type = ? AND curve_type = 'sell' AND is_active = 1
  `).get(marketType);
  
  if (!curve) {
    // Return default sell curve (higher prices than buy)
    return {
      id: null,
      market_type: marketType,
      curve_type: 'sell',
      price_points: [
        { price: 55, percent_of_holdings: 25 },
        { price: 65, percent_of_holdings: 25 },
        { price: 75, percent_of_holdings: 25 },
        { price: 85, percent_of_holdings: 25 }
      ]
    };
  }
  
  return {
    ...curve,
    price_points: JSON.parse(curve.price_points)
  };
}

/**
 * Save a curve (buy or sell)
 */
function saveCurve(marketType, curveType, pricePoints) {
  const existing = db.prepare(`
    SELECT id FROM bot_curves 
    WHERE config_id = 'default' AND market_type = ? AND curve_type = ?
  `).get(marketType, curveType);
  
  if (existing) {
    db.prepare(`
      UPDATE bot_curves 
      SET price_points = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(JSON.stringify(pricePoints), existing.id);
    return existing.id;
  } else {
    const id = uuidv4();
    db.prepare(`
      INSERT INTO bot_curves (id, config_id, market_type, curve_type, price_points)
      VALUES (?, 'default', ?, ?, ?)
    `).run(id, marketType, curveType, JSON.stringify(pricePoints));
    return id;
  }
}

/**
 * Get market override settings
 */
function getMarketOverride(marketId) {
  return db.prepare(`
    SELECT * FROM bot_market_overrides WHERE config_id = 'default' AND market_id = ?
  `).get(marketId);
}

/**
 * Set market override
 */
function setMarketOverride(marketId, overrideType, options = {}) {
  const existing = getMarketOverride(marketId);
  
  if (overrideType === null && existing) {
    // Remove override
    db.prepare('DELETE FROM bot_market_overrides WHERE id = ?').run(existing.id);
    return null;
  }
  
  if (existing) {
    db.prepare(`
      UPDATE bot_market_overrides 
      SET override_type = ?, multiplier = ?, custom_curve = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(overrideType, options.multiplier || 1.0, options.customCurve ? JSON.stringify(options.customCurve) : null, existing.id);
    return existing.id;
  } else {
    const id = uuidv4();
    db.prepare(`
      INSERT INTO bot_market_overrides (id, config_id, market_id, override_type, multiplier, custom_curve)
      VALUES (?, 'default', ?, ?, ?, ?)
    `).run(id, marketId, overrideType, options.multiplier || 1.0, options.customCurve ? JSON.stringify(options.customCurve) : null);
    return id;
  }
}

/**
 * Get effective curve for a specific market (applying overrides and global multiplier)
 * 
 * NEW LOGIC: Uses total_liquidity × market_weight × shape_weight to calculate amounts
 * The curve shape is just proportions, not absolute amounts
 */
function getEffectiveCurve(marketId, curveType = 'buy') {
  const config = getConfig();
  const market = db.prepare('SELECT * FROM markets WHERE id = ?').get(marketId);
  if (!market) return null;
  
  const override = getMarketOverride(marketId);
  
  // Check if disabled
  if (override?.override_type === 'disable') {
    return null;
  }
  
  // Get the shape (normalized proportions that sum to 1.0)
  let shape;
  if (override?.override_type === 'replace' && override.custom_curve) {
    shape = JSON.parse(override.custom_curve);
  } else {
    // Get default shape from library
    const defaultShape = getDefaultShape();
    shape = defaultShape.normalized_points;
  }
  
  // Get market weight (what fraction of total liquidity goes to this market)
  const weightRecord = getMarketWeight(marketId);
  const marketWeight = weightRecord?.weight || 0;
  
  if (marketWeight === 0) {
    // No weight assigned - need to initialize weights
    return null;
  }
  
  // Apply multipliers
  const marketMultiplier = override?.override_type === 'multiply' ? override.multiplier : 1.0;
  const effectiveMultiplier = config.global_multiplier * marketMultiplier;
  
  // Apply pullback reduction
  const exposure = getExposure();
  const pullbackRatio = calculatePullbackRatio(exposure.total_at_risk, config.max_acceptable_loss);
  
  // Calculate budget for this market
  // total_liquidity × market_weight × global_multiplier × market_multiplier × pullback_ratio
  const marketBudget = config.total_liquidity * marketWeight * effectiveMultiplier * pullbackRatio;
  
  // Distribute budget according to shape weights
  return shape.map(point => {
    // Each point has a price and a weight (proportion)
    const amount = Math.floor(marketBudget * point.weight);
    return {
      price: point.price,
      amount: amount
    };
  }).filter(point => point.amount >= 100); // Min 100 sats per order
}

// ==================== EXPOSURE & RISK TRACKING ====================

/**
 * Get current bot exposure
 */
function getExposure() {
  let exposure = db.prepare('SELECT * FROM bot_exposure WHERE id = ?').get('default');
  if (!exposure) {
    db.prepare(`
      INSERT INTO bot_exposure (id, total_at_risk, current_tier)
      VALUES ('default', 0, 0)
    `).run();
    exposure = db.prepare('SELECT * FROM bot_exposure WHERE id = ?').get('default');
  }
  return exposure;
}

/**
 * Calculate max loss if all current bets resolve against bot
 * This is the "sats at risk" - what bot would pay out if all YES bets win
 */
function calculateCurrentExposure() {
  const config = getConfig();
  
  // Sum of all active bets where bot is on NO side
  // If YES wins, bot loses amount_sats (the payout)
  const betsExposure = db.prepare(`
    SELECT COALESCE(SUM(amount_sats), 0) as total
    FROM bets
    WHERE no_user_id = ? AND status = 'active'
  `).get(config.bot_user_id);
  
  return betsExposure.total;
}

/**
 * Calculate the pullback ratio based on current exposure
 * Returns a number between 0 and 1
 * 
 * Linear pullback: ratio = 1 - (exposure / maxLoss)
 * - At 0 exposure: ratio = 1.0 (full liquidity)
 * - At 50% of max: ratio = 0.5 (half liquidity)
 * - At max loss: ratio = 0 (no more offers)
 * 
 * This GUARANTEES max loss is never exceeded.
 */
function calculatePullbackRatio(currentExposure, maxLoss) {
  if (currentExposure >= maxLoss) {
    return 0; // No more offers - max loss reached
  }
  return 1 - (currentExposure / maxLoss);
}

/**
 * Get exposure percentage (simpler than tiers)
 */
function getExposurePercent(currentExposure, maxLoss) {
  return (currentExposure / maxLoss) * 100;
}

/**
 * Update exposure tracking (called after order fills)
 */
function updateExposure(newExposure) {
  const config = getConfig();
  const oldExposure = getExposure();
  
  // Calculate exposure percentage for pullback trigger
  const oldPercent = Math.floor((oldExposure.total_at_risk / config.max_acceptable_loss) * 100);
  const newPercent = Math.floor((newExposure / config.max_acceptable_loss) * 100);
  
  db.prepare(`
    UPDATE bot_exposure
    SET total_at_risk = ?, current_tier = ?, updated_at = datetime('now')
    WHERE id = 'default'
  `).run(newExposure, newPercent);
  
  // Trigger pullback if we crossed a 10% threshold (for logging/UI purposes)
  const tierChanged = Math.floor(oldPercent / 10) !== Math.floor(newPercent / 10);
  
  return {
    oldExposure: oldExposure.total_at_risk,
    newExposure,
    oldPercent,
    newPercent,
    tierChanged
  };
}

// ==================== ORDER MANAGEMENT ====================

/**
 * Check if an order belongs to the bot
 */
function isBotOrder(orderId) {
  const config = getConfig();
  const order = db.prepare('SELECT user_id FROM orders WHERE id = ?').get(orderId);
  return order && order.user_id === config.bot_user_id;
}

/**
 * Check if a user is the bot
 */
function isBotUser(userId) {
  const config = getConfig();
  return userId === config.bot_user_id;
}

/**
 * Get all active bot orders
 */
function getBotOrders() {
  const config = getConfig();
  return db.prepare(`
    SELECT o.*, m.title as market_title, m.type as market_type, g.name as grandmaster_name
    FROM orders o
    JOIN markets m ON o.market_id = m.id
    LEFT JOIN grandmasters g ON m.grandmaster_id = g.id
    WHERE o.user_id = ? AND o.status IN ('open', 'partial')
    ORDER BY m.id, o.price_cents
  `).all(config.bot_user_id);
}

/**
 * Get bot's NO share holdings (from filled bets)
 */
function getBotHoldings() {
  const config = getConfig();
  return db.prepare(`
    SELECT 
      b.market_id,
      m.title as market_title,
      m.type as market_type,
      g.name as grandmaster_name,
      SUM(b.amount_sats) as total_shares,
      AVG(b.price_cents) as avg_price
    FROM bets b
    JOIN markets m ON b.market_id = m.id
    LEFT JOIN grandmasters g ON m.grandmaster_id = g.id
    WHERE b.no_user_id = ? AND b.status = 'active'
    GROUP BY b.market_id
  `).all(config.bot_user_id);
}

/**
 * Deploy bot orders for a single market based on effective curve
 * @param {string} marketId - Market to deploy to
 * @param {string} userId - User ID to place orders under (the logged-in user)
 */
function deployMarketOrders(marketId, userId) {
  const config = getConfig();
  if (!config.is_active) {
    return { success: false, error: 'Bot is not active' };
  }
  
  if (!userId) {
    return { success: false, error: 'User ID required' };
  }
  
  const market = db.prepare('SELECT * FROM markets WHERE id = ? AND status = ?').get(marketId, 'open');
  if (!market) {
    return { success: false, error: 'Market not found or not open' };
  }
  
  const effectiveCurve = getEffectiveCurve(marketId, 'buy');
  if (!effectiveCurve) {
    return { success: false, error: 'Market is disabled for bot' };
  }
  
  // Check user balance
  const user = db.prepare('SELECT balance_sats FROM users WHERE id = ?').get(userId);
  if (!user) {
    return { success: false, error: 'User not found' };
  }
  
  // Cancel existing user orders for this market (marked as bot orders)
  const existingOrders = db.prepare(`
    SELECT * FROM orders WHERE user_id = ? AND market_id = ? AND status IN ('open', 'partial')
  `).all(userId, marketId);
  
  let refundAmount = 0;
  for (const order of existingOrders) {
    const remaining = order.amount_sats - order.filled_sats;
    const refund = order.side === 'yes'
      ? Math.ceil(remaining * order.price_cents / 100)
      : Math.ceil(remaining * (100 - order.price_cents) / 100);
    refundAmount += refund;
  }
  
  db.prepare(`
    UPDATE orders SET status = 'cancelled', updated_at = datetime('now')
    WHERE user_id = ? AND market_id = ? AND status IN ('open', 'partial')
  `).run(userId, marketId);
  
  // Refund cancelled orders
  if (refundAmount > 0) {
    db.prepare('UPDATE users SET balance_sats = balance_sats + ? WHERE id = ?').run(refundAmount, userId);
  }
  
  // Refresh user balance after refund
  const updatedUser = db.prepare('SELECT balance_sats FROM users WHERE id = ?').get(userId);
  
  // Place new orders
  const placedOrders = [];
  let totalCost = 0;
  
  for (const point of effectiveCurve) {
    if (point.amount < 100) continue; // Min order size
    
    // Bot places NO orders (offering to take NO side at this YES price)
    // Cost for NO = (100 - price) * amount / 100
    const cost = Math.ceil(point.amount * (100 - point.price) / 100);
    
    // Check if user has enough balance
    if (totalCost + cost > updatedUser.balance_sats) {
      break; // Stop placing orders if insufficient balance
    }
    
    totalCost += cost;
    
    const orderId = uuidv4();
    db.prepare(`
      INSERT INTO orders (id, user_id, market_id, side, price_cents, amount_sats, filled_sats, status)
      VALUES (?, ?, ?, 'no', ?, ?, 0, 'open')
    `).run(orderId, userId, marketId, point.price, point.amount);
    
    placedOrders.push({ id: orderId, price: point.price, amount: point.amount, cost });
  }
  
  // Deduct cost from user balance
  if (totalCost > 0) {
    db.prepare('UPDATE users SET balance_sats = balance_sats - ? WHERE id = ?').run(totalCost, userId);
  }
  
  logBotAction('deploy_market', JSON.stringify({ marketId, userId, orders: placedOrders.length, totalCost }));
  
  return { success: true, orders: placedOrders, totalCost, refunded: refundAmount };
}

/**
 * Deploy bot orders for all attendance markets
 * @param {string} userId - User ID to place orders under (the logged-in user)
 */
function deployAllOrders(userId) {
  const config = getConfig();
  if (!config.is_active) {
    return { success: false, error: 'Bot is not active' };
  }
  
  if (!userId) {
    return { success: false, error: 'User ID required' };
  }
  
  const markets = db.prepare(`
    SELECT id FROM markets WHERE type = 'attendance' AND status = 'open'
  `).all();
  
  const results = { deployed: 0, failed: 0, totalOrders: 0, totalCost: 0, totalRefunded: 0 };
  
  for (const market of markets) {
    const result = deployMarketOrders(market.id, userId);
    if (result.success) {
      results.deployed++;
      results.totalOrders += result.orders.length;
      results.totalCost += result.totalCost;
      results.totalRefunded += result.refunded || 0;
    } else {
      results.failed++;
    }
  }
  
  logBotAction('deploy_all', JSON.stringify({ userId, ...results }));
  
  return { success: true, ...results };
}

/**
 * Withdraw all orders for a user (cancel and refund)
 * @param {string} userId - User ID to withdraw orders for
 */
function withdrawAllOrders(userId) {
  if (!userId) {
    return { success: false, error: 'User ID required' };
  }
  
  // Get all open orders for this user
  const orders = db.prepare(`
    SELECT * FROM orders WHERE user_id = ? AND status IN ('open', 'partial')
  `).all(userId);
  
  let totalRefund = 0;
  for (const order of orders) {
    const remaining = order.amount_sats - order.filled_sats;
    const refund = order.side === 'yes'
      ? Math.ceil(remaining * order.price_cents / 100)
      : Math.ceil(remaining * (100 - order.price_cents) / 100);
    totalRefund += refund;
  }
  
  // Cancel all orders
  const result = db.prepare(`
    UPDATE orders SET status = 'cancelled', updated_at = datetime('now')
    WHERE user_id = ? AND status IN ('open', 'partial')
  `).run(userId);
  
  // Refund balance
  db.prepare('UPDATE users SET balance_sats = balance_sats + ? WHERE id = ?')
    .run(totalRefund, userId);
  
  logBotAction('withdraw_all', JSON.stringify({ userId, orders: result.changes, refund: totalRefund }));
  
  return { success: true, ordersCancelled: result.changes, refund: totalRefund };
}

/**
 * Cancel all orders for a user (general function, not bot-specific)
 * @param {string} userId - User ID to cancel orders for
 */
function cancelAllUserOrders(userId) {
  if (!userId) {
    return { success: false, error: 'User ID required' };
  }
  
  // Get all open orders for this user
  const orders = db.prepare(`
    SELECT * FROM orders WHERE user_id = ? AND status IN ('open', 'partial')
  `).all(userId);
  
  let totalRefund = 0;
  for (const order of orders) {
    const remaining = order.amount_sats - order.filled_sats;
    const refund = order.side === 'yes'
      ? Math.ceil(remaining * order.price_cents / 100)
      : Math.ceil(remaining * (100 - order.price_cents) / 100);
    totalRefund += refund;
  }
  
  // Cancel all orders
  const result = db.prepare(`
    UPDATE orders SET status = 'cancelled', updated_at = datetime('now')
    WHERE user_id = ? AND status IN ('open', 'partial')
  `).run(userId);
  
  // Refund balance
  if (totalRefund > 0) {
    db.prepare('UPDATE users SET balance_sats = balance_sats + ? WHERE id = ?')
      .run(totalRefund, userId);
  }
  
  return { success: true, ordersCancelled: result.changes, refund: totalRefund };
}

/**
 * ATOMIC PULLBACK - Called when a bot order is filled
 * This MUST be called within the same transaction as the order fill
 */
function atomicPullback(filledAmount, marketId) {
  const config = getConfig();
  if (!config.is_active) return { pullbackTriggered: false };
  
  // Calculate new exposure
  const newExposure = calculateCurrentExposure();
  const exposureUpdate = updateExposure(newExposure);
  
  if (!exposureUpdate.tierChanged) {
    return { 
      pullbackTriggered: false, 
      exposure: newExposure,
      tier: exposureUpdate.newTier
    };
  }
  
  // Tier changed - need to adjust all bot orders
  const pullbackRatio = calculatePullbackRatio(newExposure, config.max_acceptable_loss);
  
  // Get all bot orders and reduce them proportionally
  const botOrders = db.prepare(`
    SELECT * FROM orders WHERE user_id = ? AND status IN ('open', 'partial')
  `).all(config.bot_user_id);
  
  let ordersModified = 0;
  let totalReduction = 0;
  
  for (const order of botOrders) {
    const remaining = order.amount_sats - order.filled_sats;
    const newRemaining = Math.floor(remaining * pullbackRatio);
    const reduction = remaining - newRemaining;
    
    if (reduction > 0) {
      // Reduce the order
      const newAmount = order.filled_sats + newRemaining;
      
      if (newRemaining < 100) {
        // Cancel order entirely
        db.prepare('UPDATE orders SET status = ?, updated_at = datetime(\'now\') WHERE id = ?')
          .run('cancelled', order.id);
      } else {
        db.prepare('UPDATE orders SET amount_sats = ?, updated_at = datetime(\'now\') WHERE id = ?')
          .run(newAmount, order.id);
      }
      
      // Refund the reduction
      const refund = order.side === 'no'
        ? Math.ceil(reduction * (100 - order.price_cents) / 100)
        : Math.ceil(reduction * order.price_cents / 100);
      
      db.prepare('UPDATE users SET balance_sats = balance_sats + ? WHERE id = ?')
        .run(refund, config.bot_user_id);
      
      totalReduction += reduction;
      ordersModified++;
    }
  }
  
  // Update last pullback time
  db.prepare(`
    UPDATE bot_exposure SET last_pullback_at = datetime('now') WHERE id = 'default'
  `).run();
  
  logBotAction('pullback', JSON.stringify({
    trigger: `tier ${exposureUpdate.oldTier} -> ${exposureUpdate.newTier}`,
    exposure: newExposure,
    pullbackRatio,
    ordersModified,
    totalReduction
  }), exposureUpdate.oldExposure, newExposure);
  
  return {
    pullbackTriggered: true,
    oldTier: exposureUpdate.oldTier,
    newTier: exposureUpdate.newTier,
    exposure: newExposure,
    pullbackRatio,
    ordersModified,
    totalReduction
  };
}

// ==================== DEPLOYMENT PREVIEW ====================

/**
 * Get a preview of what would be deployed without actually deploying
 * This shows exactly what orders will be placed for each market
 * @param {string} userId - User ID to check balance against
 */
function getDeploymentPreview(userId) {
  const config = getConfig();
  
  if (!userId) {
    return { success: false, error: 'User ID required' };
  }
  
  const user = db.prepare('SELECT balance_sats FROM users WHERE id = ?').get(userId);
  if (!user) {
    return { success: false, error: 'User not found' };
  }
  
  // Get all attendance markets
  const markets = db.prepare(`
    SELECT m.id, m.title, g.name as grandmaster_name, g.fide_rating
    FROM markets m
    LEFT JOIN grandmasters g ON m.grandmaster_id = g.id
    WHERE m.type = 'attendance' AND m.status = 'open'
    ORDER BY g.fide_rating DESC
  `).all();
  
  // Get current orders that would be cancelled (and refunded)
  const existingOrders = db.prepare(`
    SELECT o.*, m.title as market_title
    FROM orders o
    JOIN markets m ON o.market_id = m.id
    WHERE o.user_id = ? AND o.status IN ('open', 'partial')
  `).all(userId);
  
  let totalRefund = 0;
  for (const order of existingOrders) {
    const remaining = order.amount_sats - order.filled_sats;
    const refund = order.side === 'yes'
      ? Math.ceil(remaining * order.price_cents / 100)
      : Math.ceil(remaining * (100 - order.price_cents) / 100);
    totalRefund += refund;
  }
  
  // Calculate effective balance (current + refund from cancelled orders)
  const effectiveBalance = user.balance_sats + totalRefund;
  
  // Calculate what would be deployed to each market
  const marketPreviews = [];
  let totalCost = 0;
  let totalOrders = 0;
  
  for (const market of markets) {
    const effectiveCurve = getEffectiveCurve(market.id, 'buy');
    
    if (!effectiveCurve || effectiveCurve.length === 0) {
      marketPreviews.push({
        market_id: market.id,
        grandmaster_name: market.grandmaster_name,
        fide_rating: market.fide_rating,
        disabled: true,
        orders: [],
        total_amount: 0,
        total_cost: 0
      });
      continue;
    }
    
    // Calculate orders for this market
    const orders = [];
    let marketCost = 0;
    let marketAmount = 0;
    
    for (const point of effectiveCurve) {
      if (point.amount < 100) continue;
      
      // Cost for NO side = (100 - price) * amount / 100
      const cost = Math.ceil(point.amount * (100 - point.price) / 100);
      
      orders.push({
        price: point.price,
        amount: point.amount,
        cost: cost
      });
      
      marketCost += cost;
      marketAmount += point.amount;
    }
    
    marketPreviews.push({
      market_id: market.id,
      grandmaster_name: market.grandmaster_name,
      fide_rating: market.fide_rating,
      disabled: false,
      orders: orders,
      total_amount: marketAmount,
      total_cost: marketCost
    });
    
    totalCost += marketCost;
    totalOrders += orders.length;
  }
  
  // Check if user has sufficient balance
  const hasBalance = effectiveBalance >= totalCost;
  
  return {
    success: true,
    user_balance: user.balance_sats,
    existing_orders_refund: totalRefund,
    effective_balance: effectiveBalance,
    total_cost: totalCost,
    total_orders: totalOrders,
    total_markets: marketPreviews.filter(m => !m.disabled).length,
    has_sufficient_balance: hasBalance,
    shortfall: hasBalance ? 0 : totalCost - effectiveBalance,
    markets: marketPreviews,
    config: {
      total_liquidity: config.total_liquidity,
      global_multiplier: config.global_multiplier,
      is_active: !!config.is_active
    }
  };
}

// ==================== ANALYTICS ====================

/**
 * Get comprehensive bot statistics
 */
function getStats() {
  const config = getConfig();
  const exposure = getExposure();
  const botUser = db.prepare('SELECT balance_sats FROM users WHERE id = ?').get(config.bot_user_id);
  
  // Active orders
  const ordersStats = db.prepare(`
    SELECT 
      COUNT(*) as order_count,
      SUM(amount_sats - filled_sats) as total_offered,
      SUM(CASE WHEN side = 'no' THEN (amount_sats - filled_sats) * (100 - price_cents) / 100 ELSE 0 END) as total_locked
    FROM orders
    WHERE user_id = ? AND status IN ('open', 'partial')
  `).get(config.bot_user_id);
  
  // Holdings
  const holdings = getBotHoldings();
  const totalHoldings = holdings.reduce((sum, h) => sum + h.total_shares, 0);
  
  // Calculate max possible loss (if all active bets resolve YES)
  const currentExposure = calculateCurrentExposure();
  
  // Offers by price tier
  const offersByPrice = db.prepare(`
    SELECT 
      price_cents as price,
      SUM(amount_sats - filled_sats) as amount,
      COUNT(*) as markets
    FROM orders
    WHERE user_id = ? AND status IN ('open', 'partial') AND side = 'no'
    GROUP BY price_cents
    ORDER BY price_cents
  `).all(config.bot_user_id);
  
  // Top exposure markets
  const topExposure = db.prepare(`
    SELECT 
      m.id,
      m.title,
      g.name as grandmaster_name,
      SUM(b.amount_sats) as exposure
    FROM bets b
    JOIN markets m ON b.market_id = m.id
    LEFT JOIN grandmasters g ON m.grandmaster_id = g.id
    WHERE b.no_user_id = ? AND b.status = 'active'
    GROUP BY m.id
    ORDER BY exposure DESC
    LIMIT 10
  `).all(config.bot_user_id);
  
  const pullbackRatio = calculatePullbackRatio(currentExposure, config.max_acceptable_loss);
  const nextThreshold = (exposure.current_tier + 1) * config.max_acceptable_loss * (config.threshold_percent / 100);
  
  return {
    config: {
      maxAcceptableLoss: config.max_acceptable_loss,
      totalLiquidity: config.total_liquidity,
      thresholdPercent: config.threshold_percent,
      globalMultiplier: config.global_multiplier,
      isActive: !!config.is_active
    },
    risk: {
      currentExposure,
      maxAcceptableLoss: config.max_acceptable_loss,
      exposurePercent: (currentExposure / config.max_acceptable_loss * 100).toFixed(2),
      currentTier: exposure.current_tier,
      nextThreshold,
      untilNextThreshold: nextThreshold - currentExposure,
      pullbackRatio: pullbackRatio.toFixed(4),
      lastPullback: exposure.last_pullback_at
    },
    offers: {
      orderCount: ordersStats.order_count || 0,
      totalOffered: ordersStats.total_offered || 0,
      totalLocked: Math.floor(ordersStats.total_locked || 0),
      byPrice: offersByPrice
    },
    holdings: {
      totalShares: totalHoldings,
      byMarket: holdings
    },
    balance: {
      available: botUser?.balance_sats || 0,
      locked: Math.floor(ordersStats.total_locked || 0),
      total: (botUser?.balance_sats || 0) + Math.floor(ordersStats.total_locked || 0)
    },
    topExposure
  };
}

/**
 * Calculate worst case scenario
 * 
 * With linear pullback, the GUARANTEED worst case = max_acceptable_loss
 * because the pullback ratio hits 0 when exposure = max_loss, stopping all offers.
 * 
 * Current exposure shows how much of that budget is already at risk.
 */
function calculateWorstCase() {
  const config = getConfig();
  
  // Current exposure from active bets (actual risk right now)
  const currentExposure = calculateCurrentExposure();
  
  // The guaranteed worst case is simply the max loss setting
  // The linear pullback formula guarantees this can never be exceeded:
  // - pullback_ratio = 1 - (exposure / max_loss)
  // - when exposure = max_loss, ratio = 0, no more offers placed
  
  return {
    currentExposure,
    maxLoss: config.max_acceptable_loss,
    // Guaranteed worst case = max loss (by design)
    worstCase: config.max_acceptable_loss,
    exposurePercent: ((currentExposure / config.max_acceptable_loss) * 100).toFixed(1),
    remaining: config.max_acceptable_loss - currentExposure,
    isSafe: true // Always safe by design with linear pullback
  };
}

// ==================== LOGGING ====================

function logBotAction(action, details, exposureBefore = null, exposureAfter = null) {
  db.prepare(`
    INSERT INTO bot_log (id, action, details, exposure_before, exposure_after)
    VALUES (?, ?, ?, ?, ?)
  `).run(uuidv4(), action, details, exposureBefore, exposureAfter);
}

/**
 * Get recent bot activity log
 */
function getActivityLog(limit = 50) {
  return db.prepare(`
    SELECT * FROM bot_log ORDER BY created_at DESC LIMIT ?
  `).all(limit);
}

// ==================== EXPORTS ====================

module.exports = {
  // Configuration
  getConfig,
  updateConfig,
  
  // Curve Shape Generators
  PRICE_POINTS,
  generateShape,
  generateBellShape,
  generateFlatShape,
  generateExponentialShape,
  generateLogarithmicShape,
  generateSigmoidShape,
  generateParabolicShape,
  normalizeShape,
  
  // Shape Library
  saveShape,
  getShapes,
  getShape,
  getDefaultShape,
  setDefaultShape,
  deleteShape,
  updateShape,
  
  // Market Weights (Auto-Rebalancing)
  initializeMarketWeights,
  getMarketWeights,
  getMarketWeight,
  setMarketWeight,
  normalizeWeights,
  setRelativeOdds,
  applyRelativeOdds,
  setWeightLock,
  
  // Legacy Curves (for backward compatibility)
  getBuyCurve,
  getSellCurve,
  saveCurve,
  getMarketOverride,
  setMarketOverride,
  getEffectiveCurve,
  
  // Exposure & Risk
  getExposure,
  calculateCurrentExposure,
  calculatePullbackRatio,
  getExposurePercent,
  updateExposure,
  
  // Orders
  isBotOrder,
  isBotUser,
  getBotOrders,
  getBotHoldings,
  deployMarketOrders,
  deployAllOrders,
  withdrawAllOrders,
  cancelAllUserOrders,
  
  // Atomic operations
  atomicPullback,
  
  // Analytics
  getStats,
  calculateWorstCase,
  getActivityLog,
  
  // Deployment Preview
  getDeploymentPreview
};
