/**
 * Market Maker Bot Module
 * 
 * Provides liquidity for attendance prediction markets by offering NO shares
 * at various prices. Includes risk management with threshold-based pullback.
 * 
 * Key concepts:
 * - Curve Shapes: Normalized distributions (bell, exponential, etc.) stored in library
 * - Market Weights: Per-market budget allocation that auto-rebalances  
 * - Multiplier: Display more liquidity than budget (e.g., 10× means show 10M with 1M budget)
 * - Pullback: Automatic reduction when exposure crosses 1% thresholds
 * - Max Risk: Guaranteed maximum loss through pullback formula
 * 
 * PULLBACK FORMULA:
 *   pullback_ratio = (max_loss - exposure) / max_loss
 *   displayed_liquidity = max_loss × multiplier × pullback_ratio
 * 
 * DEPLOYMENT FORMULA:
 *   effective_budget = min(user_balance, max_loss) × multiplier × pullback_ratio
 *   For each market: market_budget = effective_budget × tier_weight
 *   For each price: order_amount = market_budget × shape_weight
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
 * @param {string} name - Shape name
 * @param {string} shapeType - Type of shape
 * @param {object} params - Shape parameters
 * @param {Array} normalizedPoints - Pre-computed normalized points (optional)
 * @param {number} crossoverPoint - Price where YES/NO switch occurs (default 25)
 */
function saveShape(name, shapeType, params = {}, normalizedPoints = null, crossoverPoint = 25) {
  const points = normalizedPoints || generateShape(shapeType, params);
  const id = uuidv4();
  
  db.prepare(`
    INSERT INTO bot_curve_shapes (id, name, shape_type, params, normalized_points, crossover_point)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, name, shapeType, JSON.stringify(params), JSON.stringify(points), crossoverPoint);
  
  return { id, name, shapeType, params, normalizedPoints: points, crossoverPoint };
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

// ==================== TIER DEFINITIONS ====================

/**
 * Tier order for sorting and display
 */
const TIER_ORDER = ['S', 'A+', 'A', 'B+', 'B', 'C', 'D'];

/**
 * Default curve centers by tier (where to concentrate offers)
 * Lower center = more offers at low prices (for unlikely players)
 * Higher center = more offers at higher prices (for likely players)
 */
const TIER_CURVE_CENTERS = {
  'S': 35,    // Very likely - center around 35%
  'A+': 28,   // Likely - center around 28%
  'A': 22,    // Moderately likely - center around 22%
  'B+': 18,   // Above average - center around 18%
  'B': 14,    // Average - center around 14%
  'C': 10,    // Below average - center around 10%
  'D': 7,     // Unlikely - center around 7%
  null: 12    // Unknown/unscored - default to 12%
};

/**
 * Get the default curve center for a tier
 */
function getDefaultCurveCenter(tier) {
  return TIER_CURVE_CENTERS[tier] || TIER_CURVE_CENTERS[null];
}

/**
 * Get all tiers with their markets and weights
 */
function getTierSummary() {
  const tiers = db.prepare(`
    SELECT 
      g.tier,
      COUNT(DISTINCT m.id) as market_count,
      COALESCE(SUM(w.weight), 0) as total_weight,
      GROUP_CONCAT(g.name, ', ') as players
    FROM grandmasters g
    JOIN markets m ON m.grandmaster_id = g.id AND m.type = 'attendance' AND m.status = 'open'
    LEFT JOIN bot_market_weights w ON w.market_id = m.id
    WHERE g.tier IS NOT NULL
    GROUP BY g.tier
    ORDER BY 
      CASE g.tier 
        WHEN 'S' THEN 1 WHEN 'A+' THEN 2 WHEN 'A' THEN 3 
        WHEN 'B+' THEN 4 WHEN 'B' THEN 5 WHEN 'C' THEN 6 WHEN 'D' THEN 7 
      END
  `).all();
  
  return tiers.map(t => ({
    tier: t.tier,
    marketCount: t.market_count,
    totalWeight: t.total_weight,
    budgetPercent: (t.total_weight * 100).toFixed(2),
    players: t.players ? t.players.split(', ').slice(0, 5) : [] // First 5 player names
  }));
}

/**
 * Get markets by tier with their weights
 */
function getMarketsByTier(tier) {
  return db.prepare(`
    SELECT 
      m.id as market_id,
      g.id as gm_id,
      g.name,
      g.fide_rating,
      g.tier,
      g.likelihood_score,
      COALESCE(w.weight, 0) as weight,
      COALESCE(w.is_locked, 0) as is_locked
    FROM grandmasters g
    JOIN markets m ON m.grandmaster_id = g.id AND m.type = 'attendance' AND m.status = 'open'
    LEFT JOIN bot_market_weights w ON w.market_id = m.id
    WHERE g.tier = ?
    ORDER BY g.likelihood_score DESC
  `).all(tier);
}

/**
 * Set total budget percentage for a tier
 * This will:
 * 1. Calculate the new total weight for this tier
 * 2. Distribute it proportionally among tier markets based on their relative weights
 * 3. Scale other tier weights to maintain sum = 1.0
 * 
 * @param {string} tier - Tier to adjust (S, A+, A, B+, B, C, D)
 * @param {number} budgetPercent - New budget percentage for this tier (0-100)
 */
function setTierBudget(tier, budgetPercent) {
  const newTierWeight = Math.max(0, Math.min(100, budgetPercent)) / 100;
  
  // Get all tiers' current weights
  const allTiers = getTierSummary();
  const currentTier = allTiers.find(t => t.tier === tier);
  
  if (!currentTier) {
    throw new Error(`Tier ${tier} not found`);
  }
  
  const oldTierWeight = currentTier.totalWeight;
  const weightDiff = newTierWeight - oldTierWeight;
  
  // Get markets in this tier
  const tierMarkets = getMarketsByTier(tier);
  
  if (tierMarkets.length === 0) {
    throw new Error(`No markets in tier ${tier}`);
  }
  
  // Calculate sum of weights for OTHER tiers (not this one)
  const otherTiersWeight = allTiers
    .filter(t => t.tier !== tier)
    .reduce((sum, t) => sum + t.totalWeight, 0);
  
  // Begin transaction
  const updateTier = db.transaction(() => {
    // 1. Distribute new weight among this tier's markets proportionally
    const tierCurrentTotal = tierMarkets.reduce((sum, m) => sum + m.weight, 0);
    
    for (const market of tierMarkets) {
      // Ensure market has a weight record
      const existingWeight = db.prepare(`SELECT * FROM bot_market_weights WHERE market_id = ?`).get(market.market_id);
      
      let newMarketWeight;
      if (tierCurrentTotal > 0) {
        // Proportional distribution based on current weights within tier
        const proportion = market.weight / tierCurrentTotal;
        newMarketWeight = newTierWeight * proportion;
      } else {
        // Equal distribution if no current weights
        newMarketWeight = newTierWeight / tierMarkets.length;
      }
      
      if (existingWeight) {
        db.prepare(`
          UPDATE bot_market_weights SET weight = ?, updated_at = datetime('now') WHERE market_id = ?
        `).run(newMarketWeight, market.market_id);
      } else {
        db.prepare(`
          INSERT INTO bot_market_weights (id, market_id, weight, relative_odds)
          VALUES (?, ?, ?, 1.0)
        `).run(uuidv4(), market.market_id, newMarketWeight);
      }
    }
    
    // 2. Scale other tiers proportionally to maintain sum = 1.0
    if (otherTiersWeight > 0 && weightDiff !== 0) {
      const remainingBudget = Math.max(0, 1.0 - newTierWeight);
      const scale = remainingBudget / otherTiersWeight;
      
      for (const otherTier of allTiers.filter(t => t.tier !== tier)) {
        const otherMarkets = getMarketsByTier(otherTier.tier);
        for (const market of otherMarkets) {
          const existingWeight = db.prepare(`SELECT * FROM bot_market_weights WHERE market_id = ?`).get(market.market_id);
          if (existingWeight && !existingWeight.is_locked) {
            const scaledWeight = market.weight * scale;
            db.prepare(`
              UPDATE bot_market_weights SET weight = ?, updated_at = datetime('now') WHERE market_id = ?
            `).run(scaledWeight, market.market_id);
          }
        }
      }
    }
  });
  
  updateTier();
  
  // Final normalization
  normalizeWeights();
  
  return getTierSummary();
}

/**
 * Initialize weights for all markets based on tier likelihood scores
 * Higher score = higher weight within tier
 * 
 * FIXED: Now includes ALL attendance markets, not just those with scores.
 * Markets without scores get a default score of 25 (average tier).
 */
function initializeWeightsFromScores() {
  // Get ALL attendance markets, including those without likelihood_score
  const markets = db.prepare(`
    SELECT m.id, g.likelihood_score, g.tier, g.name
    FROM markets m
    LEFT JOIN grandmasters g ON m.grandmaster_id = g.id
    WHERE m.type = 'attendance' AND m.status = 'open'
  `).all();
  
  if (markets.length === 0) return;
  
  // DEFAULT_SCORE for markets without likelihood_score (25 = average tier)
  const DEFAULT_SCORE = 25;
  
  // Calculate total score to normalize (use default for null scores)
  const totalScore = markets.reduce((sum, m) => sum + (m.likelihood_score || DEFAULT_SCORE), 0);
  
  const init = db.transaction(() => {
    for (const market of markets) {
      // Use default score for markets without likelihood_score
      const score = market.likelihood_score || DEFAULT_SCORE;
      const weight = score / totalScore;
      
      const existing = db.prepare(`SELECT * FROM bot_market_weights WHERE market_id = ?`).get(market.id);
      
      if (existing) {
        db.prepare(`
          UPDATE bot_market_weights SET weight = ?, relative_odds = ?, updated_at = datetime('now')
          WHERE market_id = ?
        `).run(weight, score, market.id);
      } else {
        db.prepare(`
          INSERT INTO bot_market_weights (id, market_id, weight, relative_odds)
          VALUES (?, ?, ?, ?)
        `).run(uuidv4(), market.id, weight, score);
      }
    }
  });
  
  init();
  normalizeWeights();
}

// ==================== MARKET WEIGHTS ====================

/**
 * Initialize weights for all attendance markets
 * Each market gets equal weight, summing to 1.0
 * 
 * FIXED: Now includes ALL markets, even those without likelihood_score.
 * Markets without scores get a default tier-based curve_center.
 */
function initializeMarketWeights() {
  // Get ALL attendance markets with their GM info (including those without scores)
  const markets = db.prepare(`
    SELECT m.id, g.likelihood_score, g.tier
    FROM markets m
    LEFT JOIN grandmasters g ON m.grandmaster_id = g.id
    WHERE m.type = 'attendance' AND m.status = 'open'
  `).all();
  
  if (markets.length === 0) return;
  
  const defaultWeight = 1.0 / markets.length;
  
  for (const market of markets) {
    // Check if weight already exists
    const existing = db.prepare(`SELECT * FROM bot_market_weights WHERE market_id = ?`).get(market.id);
    
    // Calculate the tier-based curve center (where to concentrate offers)
    const curveCenter = getDefaultCurveCenter(market.tier);
    
    if (!existing) {
      // New market - assign equal weight and tier-based curve center
      db.prepare(`
        INSERT INTO bot_market_weights (id, market_id, weight, relative_odds, curve_center)
        VALUES (?, ?, ?, ?, ?)
      `).run(uuidv4(), market.id, defaultWeight, market.likelihood_score || 1, curveCenter);
    } else if (existing.curve_center === null) {
      // Existing weight but no curve_center - set the default
      db.prepare(`
        UPDATE bot_market_weights SET curve_center = ?, updated_at = datetime('now')
        WHERE market_id = ?
      `).run(curveCenter, market.id);
    }
  }
  
  // Normalize to ensure sum = 1.0 (this will adjust for new markets)
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
 * AUTO-CORRECTION: If max_acceptable_loss > user balance, auto-reduce it
 */
function getConfig() {
  let config = db.prepare('SELECT * FROM bot_config WHERE id = ?').get('default');
  if (!config) {
    // Initialize default config if not exists
    const adminUser = db.prepare('SELECT id, balance_sats FROM users WHERE is_admin = 1').get();
    if (!adminUser) {
      throw new Error('No admin user found. Cannot initialize bot.');
    }
    
    // Set max_loss to user's balance (never higher)
    const initialMaxLoss = Math.min(10000000, adminUser.balance_sats);
    
    db.prepare(`
      INSERT INTO bot_config (id, bot_user_id, max_acceptable_loss, total_liquidity, threshold_percent, global_multiplier, is_active)
      VALUES ('default', ?, ?, 100000000, 1.0, 1.0, 0)
    `).run(adminUser.id, initialMaxLoss);
    
    // Initialize exposure tracking
    db.prepare(`
      INSERT OR IGNORE INTO bot_exposure (id, total_at_risk, current_tier)
      VALUES ('default', 0, 0)
    `).run();
    
    config = db.prepare('SELECT * FROM bot_config WHERE id = ?').get('default');
  }
  
  // AUTO-CORRECTION: Check if max_loss exceeds user's current balance
  const botUser = db.prepare('SELECT balance_sats FROM users WHERE id = ?').get(config.bot_user_id);
  if (botUser && config.max_acceptable_loss > botUser.balance_sats) {
    // Auto-reduce max_loss to match balance
    const correctedMaxLoss = botUser.balance_sats;
    db.prepare(`
      UPDATE bot_config 
      SET max_acceptable_loss = ?, updated_at = datetime('now')
      WHERE id = 'default'
    `).run(correctedMaxLoss);
    
    logBotAction('auto_correct_max_loss', JSON.stringify({
      old_max_loss: config.max_acceptable_loss,
      new_max_loss: correctedMaxLoss,
      user_balance: botUser.balance_sats,
      reason: 'max_loss exceeded user balance'
    }));
    
    config.max_acceptable_loss = correctedMaxLoss;
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
 * Get effective curve for a specific market (applying overrides, curve_center skew, and global multiplier)
 * 
 * NOW WITH CURVE SKEW: Each market can have a custom curve_center that shifts
 * where offers are concentrated. Lower curve_center = more offers at low prices (unlikely players).
 * 
 * IMPORTANT: All calculations are done in WHOLE SHARES first, then converted to sats.
 * 1 share = 1000 sats payout. Orders must always be for whole shares.
 * 
 * @param {string} marketId - Market to get curve for
 * @param {string} curveType - 'buy' or 'sell'
 * @param {number|null} totalBudget - Total budget to distribute (if null, uses config.total_liquidity)
 */
function getEffectiveCurve(marketId, curveType = 'buy', totalBudget = null) {
  const SATS_PER_SHARE = 1000;
  const MIN_SHARES = 1; // Minimum 1 share per order
  
  const config = getConfig();
  const market = db.prepare('SELECT * FROM markets WHERE id = ?').get(marketId);
  if (!market) return null;
  
  const override = getMarketOverride(marketId);
  
  // Check if disabled
  if (override?.override_type === 'disable') {
    return null;
  }
  
  // Get market weight (what fraction of budget goes to this market)
  let weightRecord = getMarketWeight(marketId);
  
  // Auto-initialize weights if none exist for this market
  if (!weightRecord) {
    initializeMarketWeights();
    weightRecord = getMarketWeight(marketId);
  }
  
  const marketWeight = weightRecord?.weight || 0;
  
  if (marketWeight === 0) {
    // No weight even after initialization - shouldn't happen but handle it
    return null;
  }
  
  // Get the shape (normalized proportions that sum to 1.0)
  let shape;
  if (override?.override_type === 'replace' && override.custom_curve) {
    shape = JSON.parse(override.custom_curve);
  } else {
    // Get default shape from library
    const defaultShape = getDefaultShape();
    
    // Get market-specific curve center for odds skew
    // curve_center determines where to concentrate offers (5-50)
    const curveCenter = weightRecord?.curve_center || getDefaultCurveCenter(null);
    
    // If the default shape is a bell curve, shift it based on curve_center
    // Otherwise use the shape as-is
    if (defaultShape.shape_type === 'bell') {
      // Regenerate bell curve centered at this market's curve_center
      shape = generateBellShape(curveCenter, defaultShape.params?.sigma || 12);
    } else {
      // For other shapes, use as-is (they already favor low prices)
      shape = defaultShape.normalized_points;
    }
  }
  
  // Apply market-specific multiplier
  const marketMultiplier = override?.override_type === 'multiply' ? override.multiplier : 1.0;
  
  // Use provided budget or fall back to config.total_liquidity
  const baseBudget = totalBudget !== null ? totalBudget : config.total_liquidity;
  
  // Calculate budget for this market (in sats)
  // baseBudget × market_weight × market_multiplier
  // Note: global_multiplier and pullback already applied at deployment level when calculating totalBudget
  const marketBudgetSats = baseBudget * marketWeight * (totalBudget !== null ? 1.0 : config.global_multiplier * marketMultiplier);
  
  // Convert to total shares this market can offer
  // CRITICAL: Calculate in shares first to ensure whole numbers
  const totalSharesForMarket = Math.floor(marketBudgetSats / SATS_PER_SHARE);
  
  if (totalSharesForMarket < MIN_SHARES) {
    return null; // Not enough budget for even 1 share
  }
  
  // Distribute shares according to shape weights using largest remainder method
  // This ensures we get whole shares that sum correctly
  const rawShares = shape.map(point => ({
    price: point.price,
    rawShare: totalSharesForMarket * point.weight,
  }));
  
  // Floor all values first
  let allocatedShares = rawShares.map(p => ({
    price: p.price,
    shares: Math.floor(p.rawShare),
    remainder: p.rawShare - Math.floor(p.rawShare)
  }));
  
  // Calculate how many shares are left to distribute
  const totalAllocated = allocatedShares.reduce((sum, p) => sum + p.shares, 0);
  let remainingShares = totalSharesForMarket - totalAllocated;
  
  // Distribute remaining shares to items with largest remainders
  if (remainingShares > 0) {
    // Sort by remainder descending
    const sortedByRemainder = [...allocatedShares].sort((a, b) => b.remainder - a.remainder);
    for (let i = 0; i < remainingShares && i < sortedByRemainder.length; i++) {
      // Find this item in original array and increment
      const idx = allocatedShares.findIndex(p => p.price === sortedByRemainder[i].price);
      if (idx >= 0) {
        allocatedShares[idx].shares++;
      }
    }
  }
  
  // Convert shares to amount_sats and filter out zero-share entries
  return allocatedShares
    .filter(point => point.shares >= MIN_SHARES)
    .map(point => ({
      price: point.price,
      amount: point.shares * SATS_PER_SHARE // Always a multiple of 1000
    }));
}

/**
 * Get curve center for a market (where to concentrate offers)
 * @param {string} marketId - Market ID
 * @returns {number|null} Curve center (5-50) or null if not set
 */
function getCurveCenter(marketId) {
  const weight = getMarketWeight(marketId);
  return weight?.curve_center || null;
}

/**
 * Set curve center for a market (manual override)
 * @param {string} marketId - Market ID
 * @param {number} curveCenter - Where to center curve (5-50), or null to reset to tier default
 */
function setCurveCenter(marketId, curveCenter) {
  // Validate range
  if (curveCenter !== null && (curveCenter < 5 || curveCenter > 50)) {
    throw new Error('Curve center must be between 5 and 50');
  }
  
  // Get market's tier for fallback
  const marketInfo = db.prepare(`
    SELECT g.tier FROM markets m
    LEFT JOIN grandmasters g ON m.grandmaster_id = g.id
    WHERE m.id = ?
  `).get(marketId);
  
  // If resetting to null, use tier default
  const finalValue = curveCenter !== null ? curveCenter : getDefaultCurveCenter(marketInfo?.tier);
  
  const existing = db.prepare(`SELECT * FROM bot_market_weights WHERE market_id = ?`).get(marketId);
  
  if (existing) {
    db.prepare(`
      UPDATE bot_market_weights SET curve_center = ?, updated_at = datetime('now')
      WHERE market_id = ?
    `).run(finalValue, marketId);
  } else {
    // Create weight record if doesn't exist
    initializeMarketWeights();
    db.prepare(`
      UPDATE bot_market_weights SET curve_center = ?, updated_at = datetime('now')
      WHERE market_id = ?
    `).run(finalValue, marketId);
  }
  
  return finalValue;
}

/**
 * Reset all curve centers to tier defaults
 */
function resetAllCurveCenters() {
  const markets = db.prepare(`
    SELECT m.id, g.tier FROM markets m
    LEFT JOIN grandmasters g ON m.grandmaster_id = g.id
    WHERE m.type = 'attendance' AND m.status = 'open'
  `).all();
  
  const update = db.prepare(`
    UPDATE bot_market_weights SET curve_center = ?, updated_at = datetime('now')
    WHERE market_id = ?
  `);
  
  const reset = db.transaction(() => {
    for (const market of markets) {
      const defaultCenter = getDefaultCurveCenter(market.tier);
      update.run(defaultCenter, market.id);
    }
  });
  
  reset();
  return markets.length;
}

// ==================== TWO-SIDED LIQUIDITY ====================

/**
 * Get effective curve for a market with two-sided liquidity (YES and NO orders)
 * 
 * The crossover point determines where the bot switches from YES seller to NO seller:
 * - Below crossover: Bot sells YES shares (takes YES side)
 * - Above crossover: Bot sells NO shares (takes NO side)
 * - At crossover: Gap/spread (no liquidity) - prevents self-trading
 * 
 * @param {string} marketId - Market to get curve for
 * @param {number|null} totalBudget - Total budget to distribute (if null, uses calculated budget)
 * @returns {object} { yesOrders: [...], noOrders: [...], crossoverPoint, summary }
 */
function getEffectiveCurveTwoSided(marketId, totalBudget = null) {
  const SATS_PER_SHARE = 1000;
  const MIN_SHARES = 1;
  
  const config = getConfig();
  const market = db.prepare('SELECT * FROM markets WHERE id = ?').get(marketId);
  if (!market) return null;
  
  const override = getMarketOverride(marketId);
  
  // Check if disabled
  if (override?.override_type === 'disable') {
    return null;
  }
  
  // Get market weight
  let weightRecord = getMarketWeight(marketId);
  if (!weightRecord) {
    initializeMarketWeights();
    weightRecord = getMarketWeight(marketId);
  }
  
  const marketWeight = weightRecord?.weight || 0;
  if (marketWeight === 0) return null;
  
  // Get the default shape and its crossover point
  const defaultShape = getDefaultShape();
  const crossoverPoint = defaultShape.crossover_point || 25;
  
  // Get shape points (normalized)
  let shape;
  if (override?.override_type === 'replace' && override.custom_curve) {
    shape = JSON.parse(override.custom_curve);
  } else {
    shape = defaultShape.normalized_points;
  }
  
  // Apply market-specific multiplier
  const marketMultiplier = override?.override_type === 'multiply' ? override.multiplier : 1.0;
  
  // Calculate budget for this market
  const baseBudget = totalBudget !== null ? totalBudget : config.total_liquidity;
  const marketBudgetSats = baseBudget * marketWeight * (totalBudget !== null ? 1.0 : config.global_multiplier * marketMultiplier);
  const totalSharesForMarket = Math.floor(marketBudgetSats / SATS_PER_SHARE);
  
  if (totalSharesForMarket < MIN_SHARES) {
    return null;
  }
  
  // Split curve into YES and NO sides based on crossover point
  const yesPoints = shape.filter(p => p.price < crossoverPoint);
  const noPoints = shape.filter(p => p.price > crossoverPoint);
  
  // Calculate weight sums for each side
  const yesWeightSum = yesPoints.reduce((sum, p) => sum + p.weight, 0);
  const noWeightSum = noPoints.reduce((sum, p) => sum + p.weight, 0);
  const totalWeight = yesWeightSum + noWeightSum;
  
  // Distribute shares using largest remainder method for each side
  const distributeShares = (points, totalShares) => {
    if (points.length === 0 || totalShares === 0) return [];
    
    const pointWeightSum = points.reduce((sum, p) => sum + p.weight, 0);
    if (pointWeightSum === 0) return [];
    
    // Calculate raw shares
    const rawShares = points.map(point => ({
      price: point.price,
      rawShare: (point.weight / pointWeightSum) * totalShares,
    }));
    
    // Floor all values
    let allocated = rawShares.map(p => ({
      price: p.price,
      shares: Math.floor(p.rawShare),
      remainder: p.rawShare - Math.floor(p.rawShare)
    }));
    
    // Distribute remainder
    const totalAllocated = allocated.reduce((sum, p) => sum + p.shares, 0);
    let remaining = totalShares - totalAllocated;
    
    if (remaining > 0) {
      const sorted = [...allocated].sort((a, b) => b.remainder - a.remainder);
      for (let i = 0; i < remaining && i < sorted.length; i++) {
        const idx = allocated.findIndex(p => p.price === sorted[i].price);
        if (idx >= 0) allocated[idx].shares++;
      }
    }
    
    return allocated
      .filter(p => p.shares >= MIN_SHARES)
      .map(p => ({
        price: p.price,
        amount: p.shares * SATS_PER_SHARE
      }));
  };
  
  // Distribute total shares proportionally between YES and NO sides
  const yesShares = totalWeight > 0 ? Math.floor(totalSharesForMarket * (yesWeightSum / totalWeight)) : 0;
  const noShares = totalSharesForMarket - yesShares;
  
  const yesOrders = distributeShares(yesPoints, yesShares);
  const noOrders = distributeShares(noPoints, noShares);
  
  // Calculate costs
  let yesCost = 0, noCost = 0;
  for (const order of yesOrders) {
    yesCost += Math.ceil(order.amount * order.price / 100);
  }
  for (const order of noOrders) {
    noCost += Math.ceil(order.amount * (100 - order.price) / 100);
  }
  
  return {
    yesOrders,
    noOrders,
    crossoverPoint,
    summary: {
      yesSideCount: yesOrders.length,
      noSideCount: noOrders.length,
      yesSideAmount: yesOrders.reduce((sum, o) => sum + o.amount, 0),
      noSideAmount: noOrders.reduce((sum, o) => sum + o.amount, 0),
      yesSideCost: yesCost,
      noSideCost: noCost,
      totalCost: yesCost + noCost,
      effectiveSpread: noOrders.length > 0 && yesOrders.length > 0
        ? Math.min(...noOrders.map(o => o.price)) - Math.max(...yesOrders.map(o => o.price))
        : null
    }
  };
}

/**
 * Calculate current exposure with YES/NO annihilation
 * 
 * When bot holds both YES and NO shares in the same market, they cancel out:
 * - 1 YES share + 1 NO share = 1000 sats (market-independent)
 * - Net exposure per market = |YES shares - NO shares|
 * - Annihilated value = min(YES, NO) × 1000 sats (returned to budget conceptually)
 * 
 * @returns {object} { netExposure, yesExposure, noExposure, annihilatedValue, byMarket }
 */
function calculateExposureWithAnnihilation() {
  const config = getConfig();
  
  // Get YES exposure per market (bot is on YES side)
  const yesExposureByMarket = db.prepare(`
    SELECT 
      market_id,
      SUM(amount_sats) as total_sats
    FROM bets
    WHERE yes_user_id = ? AND status = 'active'
    GROUP BY market_id
  `).all(config.bot_user_id);
  
  // Get NO exposure per market (bot is on NO side)
  const noExposureByMarket = db.prepare(`
    SELECT 
      market_id,
      SUM(amount_sats) as total_sats
    FROM bets
    WHERE no_user_id = ? AND status = 'active'
    GROUP BY market_id
  `).all(config.bot_user_id);
  
  // Create maps for easy lookup
  const yesMap = new Map(yesExposureByMarket.map(e => [e.market_id, e.total_sats]));
  const noMap = new Map(noExposureByMarket.map(e => [e.market_id, e.total_sats]));
  
  // Get all unique market IDs
  const allMarketIds = new Set([...yesMap.keys(), ...noMap.keys()]);
  
  // Calculate per-market metrics
  let totalYesExposure = 0;
  let totalNoExposure = 0;
  let totalAnnihilated = 0;
  let totalNetExposure = 0;
  const byMarket = [];
  
  for (const marketId of allMarketIds) {
    const yesAmount = yesMap.get(marketId) || 0;
    const noAmount = noMap.get(marketId) || 0;
    
    // Annihilation: min of the two sides
    const annihilated = Math.min(yesAmount, noAmount);
    
    // Net exposure: absolute difference
    const netExposure = Math.abs(yesAmount - noAmount);
    const netSide = yesAmount > noAmount ? 'yes' : (noAmount > yesAmount ? 'no' : 'neutral');
    
    totalYesExposure += yesAmount;
    totalNoExposure += noAmount;
    totalAnnihilated += annihilated;
    totalNetExposure += netExposure;
    
    byMarket.push({
      marketId,
      yesAmount,
      noAmount,
      annihilated,
      netExposure,
      netSide
    });
  }
  
  return {
    totalYesExposure,
    totalNoExposure,
    totalAnnihilated,
    netExposure: totalNetExposure,
    // Exposure used for pullback should be the NET exposure (after annihilation)
    effectiveExposure: totalNetExposure,
    byMarket
  };
}

/**
 * Update the crossover point for a saved curve shape
 * @param {string} shapeId - Shape ID
 * @param {number} crossoverPoint - New crossover point (5-50)
 */
function updateCrossoverPoint(shapeId, crossoverPoint) {
  // Validate range
  if (crossoverPoint < 5 || crossoverPoint > 50) {
    throw new Error('Crossover point must be between 5 and 50');
  }
  
  const shape = getShape(shapeId);
  if (!shape) {
    throw new Error('Shape not found');
  }
  
  db.prepare(`
    UPDATE bot_curve_shapes 
    SET crossover_point = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(crossoverPoint, shapeId);
  
  return getShape(shapeId);
}

/**
 * Deploy bot orders for all attendance markets with two-sided liquidity
 * 
 * This deploys BOTH YES and NO orders based on the crossover point:
 * - Below crossover: YES orders (bot sells YES shares)
 * - Above crossover: NO orders (bot sells NO shares)
 * 
 * @param {string} userId - User ID to place orders under
 */
function deployAllOrdersTwoSided(userId) {
  const config = getConfig();
  if (!config.is_active) {
    return { success: false, error: 'Bot is not active' };
  }
  
  if (!userId) {
    return { success: false, error: 'User ID required' };
  }
  
  // Step 1: Get user's current balance
  const user = db.prepare('SELECT balance_sats FROM users WHERE id = ?').get(userId);
  if (!user) {
    return { success: false, error: 'User not found' };
  }
  
  // Step 2: Cancel all existing orders and calculate refund
  const existingOrders = db.prepare(`
    SELECT * FROM orders WHERE user_id = ? AND status IN ('open', 'partial')
  `).all(userId);
  
  let totalRefund = 0;
  for (const order of existingOrders) {
    const remaining = order.amount_sats - order.filled_sats;
    const refund = order.side === 'yes'
      ? Math.ceil(remaining * order.price_cents / 100)
      : Math.ceil(remaining * (100 - order.price_cents) / 100);
    totalRefund += refund;
  }
  
  // Cancel all existing orders
  db.prepare(`
    UPDATE orders SET status = 'cancelled', updated_at = datetime('now')
    WHERE user_id = ? AND status IN ('open', 'partial')
  `).run(userId);
  
  // Refund to user
  if (totalRefund > 0) {
    db.prepare('UPDATE users SET balance_sats = balance_sats + ? WHERE id = ?').run(totalRefund, userId);
  }
  
  // Step 3: Calculate effective balance
  const effectiveBalance = user.balance_sats + totalRefund;
  
  // Step 4: Calculate deployable budget with annihilation-aware exposure
  const maxBudget = Math.min(effectiveBalance, config.max_acceptable_loss);
  const displayedLiquidity = maxBudget * config.global_multiplier;
  
  // Use annihilation-aware exposure calculation
  const exposureData = calculateExposureWithAnnihilation();
  const currentExposure = exposureData.effectiveExposure;
  const pullbackRatio = calculatePullbackRatio(currentExposure, config.max_acceptable_loss);
  const deployableBudget = displayedLiquidity * pullbackRatio;
  
  // Step 5: Get all attendance markets
  const markets = db.prepare(`
    SELECT m.id FROM markets m WHERE m.type = 'attendance' AND m.status = 'open'
  `).all();
  
  if (markets.length === 0) {
    return { 
      success: true, 
      deployed: 0, 
      totalYesOrders: 0,
      totalNoOrders: 0,
      totalCost: 0, 
      totalRefunded: totalRefund,
      effectiveBalance,
      pullbackRatio,
      deployableBudget,
      currentExposure,
      annihilatedValue: exposureData.totalAnnihilated
    };
  }
  
  // Step 6: Collect all orders from all markets
  let allYesOrders = [];
  let allNoOrders = [];
  let totalTheoreticCost = 0;
  
  for (const market of markets) {
    const curves = getEffectiveCurveTwoSided(market.id, deployableBudget);
    
    if (!curves) continue;
    
    for (const order of curves.yesOrders) {
      if (order.amount < 100) continue;
      const cost = Math.ceil(order.amount * order.price / 100);
      totalTheoreticCost += cost;
      allYesOrders.push({ marketId: market.id, ...order, cost });
    }
    
    for (const order of curves.noOrders) {
      if (order.amount < 100) continue;
      const cost = Math.ceil(order.amount * (100 - order.price) / 100);
      totalTheoreticCost += cost;
      allNoOrders.push({ marketId: market.id, ...order, cost });
    }
  }
  
  // Step 7: Scale down if needed
  let scaleFactor = 1.0;
  if (totalTheoreticCost > effectiveBalance && totalTheoreticCost > 0) {
    scaleFactor = effectiveBalance / totalTheoreticCost;
  }
  
  // Step 8: Place orders
  const results = { 
    deployed: 0, 
    totalYesOrders: 0,
    totalNoOrders: 0,
    totalCost: 0, 
    totalRefunded: totalRefund,
    effectiveBalance,
    maxBudget,
    displayedLiquidity,
    pullbackRatio,
    deployableBudget,
    currentExposure,
    annihilatedValue: exposureData.totalAnnihilated
  };
  const marketOrderCounts = {};
  
  // Place YES orders
  for (const order of allYesOrders) {
    const scaledAmount = Math.floor(order.amount * scaleFactor);
    if (scaledAmount < 100) continue;
    
    const actualCost = Math.ceil(scaledAmount * order.price / 100);
    
    const currentUser = db.prepare('SELECT balance_sats FROM users WHERE id = ?').get(userId);
    if (currentUser.balance_sats < actualCost) continue;
    
    const orderId = uuidv4();
    db.prepare(`
      INSERT INTO orders (id, user_id, market_id, side, price_cents, amount_sats, filled_sats, status)
      VALUES (?, ?, ?, 'yes', ?, ?, 0, 'open')
    `).run(orderId, userId, order.marketId, order.price, scaledAmount);
    
    db.prepare('UPDATE users SET balance_sats = balance_sats - ? WHERE id = ?').run(actualCost, userId);
    
    results.totalCost += actualCost;
    results.totalYesOrders++;
    
    if (!marketOrderCounts[order.marketId]) marketOrderCounts[order.marketId] = { yes: 0, no: 0 };
    marketOrderCounts[order.marketId].yes++;
  }
  
  // Place NO orders
  for (const order of allNoOrders) {
    const scaledAmount = Math.floor(order.amount * scaleFactor);
    if (scaledAmount < 100) continue;
    
    const actualCost = Math.ceil(scaledAmount * (100 - order.price) / 100);
    
    const currentUser = db.prepare('SELECT balance_sats FROM users WHERE id = ?').get(userId);
    if (currentUser.balance_sats < actualCost) continue;
    
    const orderId = uuidv4();
    db.prepare(`
      INSERT INTO orders (id, user_id, market_id, side, price_cents, amount_sats, filled_sats, status)
      VALUES (?, ?, ?, 'no', ?, ?, 0, 'open')
    `).run(orderId, userId, order.marketId, order.price, scaledAmount);
    
    db.prepare('UPDATE users SET balance_sats = balance_sats - ? WHERE id = ?').run(actualCost, userId);
    
    results.totalCost += actualCost;
    results.totalNoOrders++;
    
    if (!marketOrderCounts[order.marketId]) marketOrderCounts[order.marketId] = { yes: 0, no: 0 };
    marketOrderCounts[order.marketId].no++;
  }
  
  results.deployed = Object.keys(marketOrderCounts).length;
  results.scaleFactor = scaleFactor;
  results.totalOrders = results.totalYesOrders + results.totalNoOrders;
  
  // Update bot_user_id
  db.prepare(`
    UPDATE bot_config SET bot_user_id = ?, updated_at = datetime('now') WHERE id = 'default'
  `).run(userId);
  
  logBotAction('deploy_all_two_sided', JSON.stringify({ 
    userId, 
    effectiveBalance,
    maxBudget,
    pullbackRatio: pullbackRatio.toFixed(4),
    deployableBudget,
    scaleFactor: scaleFactor.toFixed(4),
    totalYesOrders: results.totalYesOrders,
    totalNoOrders: results.totalNoOrders,
    totalCost: results.totalCost,
    deployed: results.deployed,
    annihilatedValue: exposureData.totalAnnihilated
  }));
  
  return { success: true, ...results };
}

/**
 * Get deployment preview with two-sided liquidity
 * Shows exactly what YES and NO orders would be deployed
 * 
 * @param {string} userId - User ID to check balance against
 */
function getDeploymentPreviewTwoSided(userId) {
  const config = getConfig();
  
  if (!userId) {
    return { success: false, error: 'User ID required' };
  }
  
  const user = db.prepare('SELECT balance_sats FROM users WHERE id = ?').get(userId);
  if (!user) {
    return { success: false, error: 'User not found' };
  }
  
  // Get existing orders refund
  const existingOrders = db.prepare(`
    SELECT * FROM orders WHERE user_id = ? AND status IN ('open', 'partial')
  `).all(userId);
  
  let totalRefund = 0;
  for (const order of existingOrders) {
    const remaining = order.amount_sats - order.filled_sats;
    const refund = order.side === 'yes'
      ? Math.ceil(remaining * order.price_cents / 100)
      : Math.ceil(remaining * (100 - order.price_cents) / 100);
    totalRefund += refund;
  }
  
  const effectiveBalance = user.balance_sats + totalRefund;
  const maxBudget = Math.min(effectiveBalance, config.max_acceptable_loss);
  const displayedLiquidity = maxBudget * config.global_multiplier;
  
  // Get annihilation-aware exposure
  const exposureData = calculateExposureWithAnnihilation();
  const currentExposure = exposureData.effectiveExposure;
  const pullbackRatio = calculatePullbackRatio(currentExposure, config.max_acceptable_loss);
  const deployableBudget = displayedLiquidity * pullbackRatio;
  
  // Get default shape for crossover point
  const defaultShape = getDefaultShape();
  const crossoverPoint = defaultShape.crossover_point || 25;
  
  // Get all markets
  const markets = db.prepare(`
    SELECT m.id, m.title, g.name as grandmaster_name, g.fide_rating
    FROM markets m
    LEFT JOIN grandmasters g ON m.grandmaster_id = g.id
    WHERE m.type = 'attendance' AND m.status = 'open'
    ORDER BY g.fide_rating DESC
  `).all();
  
  // Calculate orders for each market
  const marketPreviews = [];
  let totalYesCost = 0, totalNoCost = 0;
  let totalYesOrders = 0, totalNoOrders = 0;
  
  for (const market of markets) {
    const curves = getEffectiveCurveTwoSided(market.id, deployableBudget);
    
    if (!curves) {
      marketPreviews.push({
        market_id: market.id,
        grandmaster_name: market.grandmaster_name,
        fide_rating: market.fide_rating,
        disabled: true,
        yesOrders: [],
        noOrders: [],
        summary: null
      });
      continue;
    }
    
    // Calculate costs
    const yesOrdersWithCost = curves.yesOrders.map(o => ({
      ...o,
      cost: Math.ceil(o.amount * o.price / 100)
    }));
    const noOrdersWithCost = curves.noOrders.map(o => ({
      ...o,
      cost: Math.ceil(o.amount * (100 - o.price) / 100)
    }));
    
    const marketYesCost = yesOrdersWithCost.reduce((sum, o) => sum + o.cost, 0);
    const marketNoCost = noOrdersWithCost.reduce((sum, o) => sum + o.cost, 0);
    
    marketPreviews.push({
      market_id: market.id,
      grandmaster_name: market.grandmaster_name,
      fide_rating: market.fide_rating,
      disabled: false,
      yesOrders: yesOrdersWithCost,
      noOrders: noOrdersWithCost,
      summary: {
        ...curves.summary,
        yesCost: marketYesCost,
        noCost: marketNoCost,
        totalCost: marketYesCost + marketNoCost
      }
    });
    
    totalYesCost += marketYesCost;
    totalNoCost += marketNoCost;
    totalYesOrders += curves.yesOrders.length;
    totalNoOrders += curves.noOrders.length;
  }
  
  const totalCost = totalYesCost + totalNoCost;
  const hasBalance = effectiveBalance >= totalCost;
  
  return {
    success: true,
    user_balance: user.balance_sats,
    existing_orders_refund: totalRefund,
    effective_balance: effectiveBalance,
    max_budget: maxBudget,
    displayed_liquidity: displayedLiquidity,
    pullback_ratio: pullbackRatio,
    deployable_budget: deployableBudget,
    current_exposure: currentExposure,
    crossover_point: crossoverPoint,
    // Annihilation info
    exposure_details: {
      totalYesExposure: exposureData.totalYesExposure,
      totalNoExposure: exposureData.totalNoExposure,
      annihilatedValue: exposureData.totalAnnihilated,
      netExposure: exposureData.netExposure
    },
    // Order summary
    total_yes_cost: totalYesCost,
    total_no_cost: totalNoCost,
    total_cost: totalCost,
    total_yes_orders: totalYesOrders,
    total_no_orders: totalNoOrders,
    total_orders: totalYesOrders + totalNoOrders,
    total_markets: marketPreviews.filter(m => !m.disabled).length,
    has_sufficient_balance: hasBalance,
    shortfall: hasBalance ? 0 : totalCost - effectiveBalance,
    markets: marketPreviews,
    config: {
      max_acceptable_loss: config.max_acceptable_loss,
      global_multiplier: config.global_multiplier,
      threshold_percent: config.threshold_percent,
      is_active: !!config.is_active
    }
  };
}

// ==================== PULLBACK THRESHOLDS ====================

/**
 * Default thresholds if none exist
 * These define a smooth pullback curve with discrete steps
 */
const DEFAULT_THRESHOLDS = [
  { exposure_percent: 0, pullback_percent: 100 },   // Full liquidity
  { exposure_percent: 25, pullback_percent: 75 },   // 75% liquidity at 25% exposure
  { exposure_percent: 50, pullback_percent: 50 },   // 50% liquidity at 50% exposure
  { exposure_percent: 75, pullback_percent: 25 },   // 25% liquidity at 75% exposure
  { exposure_percent: 90, pullback_percent: 10 },   // 10% liquidity at 90% exposure
  { exposure_percent: 100, pullback_percent: 0 },   // No liquidity at max exposure
];

/**
 * Get all pullback thresholds
 * Returns array sorted by exposure_percent ascending
 */
function getThresholds() {
  const thresholds = db.prepare(`
    SELECT * FROM bot_pullback_thresholds
    ORDER BY exposure_percent ASC
  `).all();
  
  return thresholds;
}

/**
 * Initialize default thresholds if none exist
 */
function initializeDefaultThresholds() {
  const existing = db.prepare(`SELECT COUNT(*) as count FROM bot_pullback_thresholds`).get();
  
  if (existing.count === 0) {
    const insert = db.prepare(`
      INSERT INTO bot_pullback_thresholds (id, exposure_percent, pullback_percent)
      VALUES (?, ?, ?)
    `);
    
    const insertAll = db.transaction(() => {
      for (const t of DEFAULT_THRESHOLDS) {
        insert.run(uuidv4(), t.exposure_percent, t.pullback_percent);
      }
    });
    
    insertAll();
  }
  
  return getThresholds();
}

/**
 * Add or update a threshold
 * @param {number} exposurePercent - Exposure level (0-100)
 * @param {number} pullbackPercent - Pullback ratio at this level (0-100)
 */
function setThreshold(exposurePercent, pullbackPercent) {
  // Validate
  if (exposurePercent < 0 || exposurePercent > 100) {
    throw new Error('Exposure percent must be between 0 and 100');
  }
  if (pullbackPercent < 0 || pullbackPercent > 100) {
    throw new Error('Pullback percent must be between 0 and 100');
  }
  
  // Check if threshold at this exposure already exists
  const existing = db.prepare(`
    SELECT * FROM bot_pullback_thresholds WHERE exposure_percent = ?
  `).get(exposurePercent);
  
  if (existing) {
    db.prepare(`
      UPDATE bot_pullback_thresholds 
      SET pullback_percent = ?, updated_at = datetime('now')
      WHERE exposure_percent = ?
    `).run(pullbackPercent, exposurePercent);
  } else {
    db.prepare(`
      INSERT INTO bot_pullback_thresholds (id, exposure_percent, pullback_percent)
      VALUES (?, ?, ?)
    `).run(uuidv4(), exposurePercent, pullbackPercent);
  }
  
  return getThresholds();
}

/**
 * Remove a threshold
 * Cannot remove 0% and 100% thresholds (they're required)
 */
function removeThreshold(exposurePercent) {
  if (exposurePercent === 0 || exposurePercent === 100) {
    throw new Error('Cannot remove 0% or 100% thresholds - they are required');
  }
  
  db.prepare(`DELETE FROM bot_pullback_thresholds WHERE exposure_percent = ?`).run(exposurePercent);
  return getThresholds();
}

/**
 * Bulk set all thresholds (replaces existing)
 * @param {Array} thresholds - Array of {exposure_percent, pullback_percent}
 */
function setAllThresholds(thresholds) {
  // Validate
  if (!Array.isArray(thresholds) || thresholds.length < 2) {
    throw new Error('Must provide at least 2 thresholds');
  }
  
  // Must include 0% and 100%
  const has0 = thresholds.some(t => t.exposure_percent === 0);
  const has100 = thresholds.some(t => t.exposure_percent === 100);
  if (!has0 || !has100) {
    throw new Error('Thresholds must include 0% and 100% exposure levels');
  }
  
  // Validate all values
  for (const t of thresholds) {
    if (t.exposure_percent < 0 || t.exposure_percent > 100) {
      throw new Error(`Invalid exposure percent: ${t.exposure_percent}`);
    }
    if (t.pullback_percent < 0 || t.pullback_percent > 100) {
      throw new Error(`Invalid pullback percent: ${t.pullback_percent}`);
    }
  }
  
  const replaceAll = db.transaction(() => {
    // Clear existing
    db.prepare(`DELETE FROM bot_pullback_thresholds`).run();
    
    // Insert new
    const insert = db.prepare(`
      INSERT INTO bot_pullback_thresholds (id, exposure_percent, pullback_percent)
      VALUES (?, ?, ?)
    `);
    
    for (const t of thresholds) {
      insert.run(uuidv4(), t.exposure_percent, t.pullback_percent);
    }
  });
  
  replaceAll();
  return getThresholds();
}

/**
 * Reset thresholds to defaults
 */
function resetThresholdsToDefaults() {
  return setAllThresholds(DEFAULT_THRESHOLDS);
}

/**
 * Calculate pullback ratio using custom thresholds
 * Interpolates between threshold levels
 * 
 * @param {number} exposurePercent - Current exposure as % of max_loss (0-100)
 * @returns {number} Pullback ratio (0-1)
 */
function calculatePullbackRatioFromThresholds(exposurePercent) {
  let thresholds = getThresholds();
  
  // If no thresholds, initialize defaults
  if (thresholds.length === 0) {
    thresholds = initializeDefaultThresholds();
  }
  
  // Sort by exposure (should already be sorted, but ensure)
  thresholds.sort((a, b) => a.exposure_percent - b.exposure_percent);
  
  // Find the two thresholds we're between
  let lower = thresholds[0];
  let upper = thresholds[thresholds.length - 1];
  
  for (let i = 0; i < thresholds.length - 1; i++) {
    if (exposurePercent >= thresholds[i].exposure_percent && 
        exposurePercent <= thresholds[i + 1].exposure_percent) {
      lower = thresholds[i];
      upper = thresholds[i + 1];
      break;
    }
  }
  
  // Linear interpolation between the two threshold levels
  if (upper.exposure_percent === lower.exposure_percent) {
    return lower.pullback_percent / 100;
  }
  
  const exposureRange = upper.exposure_percent - lower.exposure_percent;
  const pullbackRange = upper.pullback_percent - lower.pullback_percent;
  const exposureProgress = (exposurePercent - lower.exposure_percent) / exposureRange;
  const interpolatedPullback = lower.pullback_percent + (pullbackRange * exposureProgress);
  
  return Math.max(0, Math.min(1, interpolatedPullback / 100));
}

/**
 * Get pullback status showing current position relative to thresholds
 */
function getPullbackStatus() {
  const config = getConfig();
  const currentExposure = calculateCurrentExposure();
  const exposurePercent = (currentExposure / config.max_acceptable_loss) * 100;
  
  // Get thresholds
  let thresholds = getThresholds();
  if (thresholds.length === 0) {
    thresholds = initializeDefaultThresholds();
  }
  
  // Calculate current pullback ratio
  const useCustom = config.use_custom_thresholds;
  const pullbackRatio = useCustom 
    ? calculatePullbackRatioFromThresholds(exposurePercent)
    : calculatePullbackRatio(currentExposure, config.max_acceptable_loss);
  
  // Find next threshold
  const sortedThresholds = [...thresholds].sort((a, b) => a.exposure_percent - b.exposure_percent);
  let nextThreshold = null;
  let prevThreshold = null;
  
  for (const t of sortedThresholds) {
    if (t.exposure_percent > exposurePercent) {
      nextThreshold = t;
      break;
    }
    prevThreshold = t;
  }
  
  return {
    current_exposure_sats: currentExposure,
    current_exposure_percent: exposurePercent,
    max_loss_sats: config.max_acceptable_loss,
    pullback_ratio: pullbackRatio,
    pullback_percent: pullbackRatio * 100,
    use_custom_thresholds: !!useCustom,
    per_market_cap_percent: config.per_market_cap_percent || 25,
    per_market_cap_sats: Math.floor(config.max_acceptable_loss * (config.per_market_cap_percent || 25) / 100),
    thresholds: sortedThresholds,
    current_threshold: prevThreshold,
    next_threshold: nextThreshold,
    distance_to_next: nextThreshold 
      ? {
          percent: nextThreshold.exposure_percent - exposurePercent,
          sats: Math.floor(config.max_acceptable_loss * (nextThreshold.exposure_percent - exposurePercent) / 100)
        }
      : null
  };
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
 * 
 * FIXED: Now uses 1% thresholds instead of 10% tiers
 * This triggers pullback more frequently for smoother liquidity adjustment
 */
function updateExposure(newExposure) {
  const config = getConfig();
  const oldExposure = getExposure();
  
  // Calculate exposure percentage for pullback trigger
  // Using 1% threshold (threshold_percent from config)
  const threshold = config.threshold_percent || 1;
  const oldPercent = (oldExposure.total_at_risk / config.max_acceptable_loss) * 100;
  const newPercent = (newExposure / config.max_acceptable_loss) * 100;
  
  // Current tier = number of thresholds crossed
  const oldTier = Math.floor(oldPercent / threshold);
  const newTier = Math.floor(newPercent / threshold);
  
  db.prepare(`
    UPDATE bot_exposure
    SET total_at_risk = ?, current_tier = ?, updated_at = datetime('now')
    WHERE id = 'default'
  `).run(newExposure, newTier);
  
  // Trigger pullback if we crossed any threshold boundary
  const tierChanged = oldTier !== newTier;
  
  return {
    oldExposure: oldExposure.total_at_risk,
    newExposure,
    oldPercent,
    newPercent,
    oldTier,
    newTier,
    tierChanged,
    threshold
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
 * 
 * FIXED: Now uses the correct formula:
 *   deployable_budget = min(user_balance, max_loss) × multiplier × pullback_ratio
 * 
 * This matches getDeploymentPreview exactly.
 * 
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
  
  // Step 1: Get user's current balance
  const user = db.prepare('SELECT balance_sats FROM users WHERE id = ?').get(userId);
  if (!user) {
    return { success: false, error: 'User not found' };
  }
  
  // Step 2: Cancel all existing orders and calculate refund
  const existingOrders = db.prepare(`
    SELECT * FROM orders WHERE user_id = ? AND status IN ('open', 'partial')
  `).all(userId);
  
  let totalRefund = 0;
  for (const order of existingOrders) {
    const remaining = order.amount_sats - order.filled_sats;
    const refund = order.side === 'yes'
      ? Math.ceil(remaining * order.price_cents / 100)
      : Math.ceil(remaining * (100 - order.price_cents) / 100);
    totalRefund += refund;
  }
  
  // Cancel all existing orders
  db.prepare(`
    UPDATE orders SET status = 'cancelled', updated_at = datetime('now')
    WHERE user_id = ? AND status IN ('open', 'partial')
  `).run(userId);
  
  // Refund to user
  if (totalRefund > 0) {
    db.prepare('UPDATE users SET balance_sats = balance_sats + ? WHERE id = ?').run(totalRefund, userId);
  }
  
  // Step 3: Calculate effective balance (available for deployment)
  const effectiveBalance = user.balance_sats + totalRefund;
  
  // Step 4: Calculate deployable budget using the formula:
  // deployable_budget = min(user_balance, max_loss) × multiplier × pullback_ratio
  const maxBudget = Math.min(effectiveBalance, config.max_acceptable_loss);
  const displayedLiquidity = maxBudget * config.global_multiplier;
  const currentExposure = calculateCurrentExposure();
  const pullbackRatio = calculatePullbackRatio(currentExposure, config.max_acceptable_loss);
  const deployableBudget = displayedLiquidity * pullbackRatio;
  
  // Step 5: Get all attendance markets
  const markets = db.prepare(`
    SELECT m.id FROM markets m WHERE m.type = 'attendance' AND m.status = 'open'
  `).all();
  
  if (markets.length === 0) {
    return { 
      success: true, 
      deployed: 0, 
      failed: 0, 
      totalOrders: 0, 
      totalCost: 0, 
      totalRefunded: totalRefund,
      effectiveBalance,
      maxBudget,
      displayedLiquidity,
      pullbackRatio,
      deployableBudget
    };
  }
  
  // Step 6: Calculate orders using deployableBudget
  let allOrders = [];
  let totalTheoreticCost = 0;
  
  for (const market of markets) {
    // Get effective curve using deployableBudget (includes multiplier and pullback)
    const effectiveCurve = getEffectiveCurve(market.id, 'buy', deployableBudget);
    
    if (!effectiveCurve || effectiveCurve.length === 0) {
      continue;
    }
    
    for (const point of effectiveCurve) {
      if (point.amount < 100) continue;
      
      const cost = Math.ceil(point.amount * (100 - point.price) / 100);
      totalTheoreticCost += cost;
      allOrders.push({
        marketId: market.id,
        price: point.price,
        amount: point.amount,
        cost: cost
      });
    }
  }
  
  // Step 7: If theoretical cost > balance, scale down proportionally
  // This ensures we never exceed actual balance, even with multiplier
  let scaleFactor = 1.0;
  if (totalTheoreticCost > effectiveBalance && totalTheoreticCost > 0) {
    scaleFactor = effectiveBalance / totalTheoreticCost;
  }
  
  // Step 8: Place scaled orders
  const results = { 
    deployed: 0, 
    failed: 0, 
    totalOrders: 0, 
    totalCost: 0, 
    totalRefunded: totalRefund,
    effectiveBalance,
    maxBudget,
    displayedLiquidity,
    pullbackRatio,
    deployableBudget,
    currentExposure
  };
  const marketOrderCounts = {};
  
  for (const order of allOrders) {
    const scaledAmount = Math.floor(order.amount * scaleFactor);
    if (scaledAmount < 100) continue; // Skip orders below minimum
    
    const actualCost = Math.ceil(scaledAmount * (100 - order.price) / 100);
    
    // Check if we have enough balance left
    const currentUser = db.prepare('SELECT balance_sats FROM users WHERE id = ?').get(userId);
    if (currentUser.balance_sats < actualCost) {
      continue; // Skip if insufficient balance
    }
    
    // Place the order
    const orderId = uuidv4();
    db.prepare(`
      INSERT INTO orders (id, user_id, market_id, side, price_cents, amount_sats, filled_sats, status)
      VALUES (?, ?, ?, 'no', ?, ?, 0, 'open')
    `).run(orderId, userId, order.marketId, order.price, scaledAmount);
    
    // Deduct cost
    db.prepare('UPDATE users SET balance_sats = balance_sats - ? WHERE id = ?').run(actualCost, userId);
    
    results.totalCost += actualCost;
    results.totalOrders++;
    
    // Track per-market counts
    if (!marketOrderCounts[order.marketId]) {
      marketOrderCounts[order.marketId] = 0;
    }
    marketOrderCounts[order.marketId]++;
  }
  
  results.deployed = Object.keys(marketOrderCounts).length;
  results.scaleFactor = scaleFactor;
  
  // Step 9: Update bot_user_id to this user (for pullback tracking)
  db.prepare(`
    UPDATE bot_config SET bot_user_id = ?, updated_at = datetime('now') WHERE id = 'default'
  `).run(userId);
  
  logBotAction('deploy_all', JSON.stringify({ 
    userId, 
    effectiveBalance,
    maxBudget,
    displayedLiquidity,
    pullbackRatio: pullbackRatio.toFixed(4),
    deployableBudget,
    scaleFactor: scaleFactor.toFixed(4),
    totalOrders: results.totalOrders,
    totalCost: results.totalCost,
    deployed: results.deployed
  }));
  
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
 * 
 * IMPORTANT: Pullback is applied to all OTHER markets, NOT the market where
 * the action occurred. The active market already lost liquidity from the fills,
 * so we don't want to "double penalize" it.
 * 
 * WHOLE SHARES: All reductions are done in whole shares (1 share = 1000 sats).
 * We calculate the target reduction in shares, then remove whole shares.
 * If pullback_ratio = 0, we cancel ALL remaining orders.
 */
function atomicPullback(filledAmount, marketId) {
  const SATS_PER_SHARE = 1000;
  const MIN_SHARES = 1;
  
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
  
  // Tier changed - need to adjust bot orders on OTHER markets
  // (exclude the market where action just occurred - it already lost liquidity from fills)
  const pullbackRatio = calculatePullbackRatio(newExposure, config.max_acceptable_loss);
  
  // Get bot orders EXCLUDING the market where action occurred
  const botOrders = db.prepare(`
    SELECT * FROM orders WHERE user_id = ? AND status IN ('open', 'partial') AND market_id != ?
  `).all(config.bot_user_id, marketId);
  
  let ordersModified = 0;
  let totalReduction = 0;
  let totalRefund = 0;
  
  // SPECIAL CASE: If pullback_ratio = 0, cancel ALL remaining orders
  if (pullbackRatio <= 0) {
    for (const order of botOrders) {
      const remaining = order.amount_sats - order.filled_sats;
      if (remaining > 0) {
        // Cancel order entirely
        db.prepare('UPDATE orders SET status = ?, updated_at = datetime(\'now\') WHERE id = ?')
          .run('cancelled', order.id);
        
        // Refund the full remaining cost
        const refund = order.side === 'no'
          ? Math.ceil(remaining * (100 - order.price_cents) / 100)
          : Math.ceil(remaining * order.price_cents / 100);
        
        totalRefund += refund;
        totalReduction += remaining;
        ordersModified++;
      }
    }
    
    // Single refund for all cancelled orders
    if (totalRefund > 0) {
      db.prepare('UPDATE users SET balance_sats = balance_sats + ? WHERE id = ?')
        .run(totalRefund, config.bot_user_id);
    }
  } else {
    // Proportional reduction - work in whole shares
    for (const order of botOrders) {
      const remainingSats = order.amount_sats - order.filled_sats;
      const remainingShares = Math.floor(remainingSats / SATS_PER_SHARE);
      
      // Calculate target shares after pullback
      const targetShares = Math.floor(remainingShares * pullbackRatio);
      const sharesToRemove = remainingShares - targetShares;
      
      if (sharesToRemove > 0) {
        const reductionSats = sharesToRemove * SATS_PER_SHARE;
        const newRemainingSats = remainingSats - reductionSats;
        const newAmount = order.filled_sats + newRemainingSats;
        
        if (targetShares < MIN_SHARES) {
          // Cancel order entirely if below minimum
          db.prepare('UPDATE orders SET status = ?, updated_at = datetime(\'now\') WHERE id = ?')
            .run('cancelled', order.id);
        } else {
          // Reduce by whole shares
          db.prepare('UPDATE orders SET amount_sats = ?, updated_at = datetime(\'now\') WHERE id = ?')
            .run(newAmount, order.id);
        }
        
        // Refund the reduction cost
        const refund = order.side === 'no'
          ? Math.ceil(reductionSats * (100 - order.price_cents) / 100)
          : Math.ceil(reductionSats * order.price_cents / 100);
        
        totalRefund += refund;
        totalReduction += reductionSats;
        ordersModified++;
      }
    }
    
    // Single refund for all reductions
    if (totalRefund > 0) {
      db.prepare('UPDATE users SET balance_sats = balance_sats + ? WHERE id = ?')
        .run(totalRefund, config.bot_user_id);
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
    totalReduction,
    totalRefund,
    excludedMarket: marketId // The market where action occurred (not affected by pullback)
  }), exposureUpdate.oldExposure, newExposure);
  
  return {
    pullbackTriggered: true,
    oldTier: exposureUpdate.oldTier,
    newTier: exposureUpdate.newTier,
    exposure: newExposure,
    pullbackRatio,
    ordersModified,
    totalReduction,
    totalRefund
  };
}

// ==================== AUTO-MATCH DETECTION ====================

/**
 * Calculate potential auto-matches for a proposed NO order
 * When placing a NO order at price P, it will match with existing YES orders 
 * where YES price >= (100 - P)
 * 
 * @param {string} marketId - Market to check
 * @param {number} noPrice - Price of the NO order (this is the YES price the NO is offering)
 * @param {number} amount - Amount of the NO order in sats
 * @returns {object} Match details
 */
function calculatePotentialMatch(marketId, noPrice, amount) {
  // A NO order at price P matches YES orders where YES price >= (100 - P)
  // Example: NO@60 means "I want NO at 60% YES prob" → costs 40 sats
  // Matches YES orders at (100-60)=40% or higher
  const minYesPrice = 100 - noPrice;
  
  // Find existing YES orders that would match
  const matchingYesOrders = db.prepare(`
    SELECT * FROM orders
    WHERE market_id = ? 
      AND side = 'yes' 
      AND status IN ('open', 'partial')
      AND price_cents >= ?
    ORDER BY price_cents DESC, created_at ASC
  `).all(marketId, minYesPrice);
  
  if (matchingYesOrders.length === 0) {
    return {
      would_match: false,
      match_amount: 0,
      match_cost: 0,
      matching_orders: []
    };
  }
  
  // Calculate how much would match
  let remainingAmount = amount;
  let totalMatchAmount = 0;
  let totalMatchCost = 0;
  const matchingOrderDetails = [];
  
  for (const yesOrder of matchingYesOrders) {
    if (remainingAmount <= 0) break;
    
    const available = yesOrder.amount_sats - yesOrder.filled_sats;
    const matchAmount = Math.min(remainingAmount, available);
    
    // Cost to the NO side for this match
    // NO pays (100 - trade_price)% where trade_price is the resting order's price
    const tradePrice = yesOrder.price_cents;
    const matchCost = Math.ceil(matchAmount * (100 - tradePrice) / 100);
    
    totalMatchAmount += matchAmount;
    totalMatchCost += matchCost;
    remainingAmount -= matchAmount;
    
    matchingOrderDetails.push({
      order_id: yesOrder.id,
      yes_price: yesOrder.price_cents,
      available_amount: available,
      match_amount: matchAmount,
      match_cost: matchCost
    });
  }
  
  return {
    would_match: totalMatchAmount > 0,
    match_amount: totalMatchAmount,
    match_cost: totalMatchCost,
    remaining_as_order: amount - totalMatchAmount,
    matching_orders: matchingOrderDetails
  };
}

/**
 * Calculate all potential auto-matches for a deployment preview
 * 
 * FIXED: Now simulates actual matching behavior by:
 * 1. Getting the order book ONCE per market
 * 2. Tracking consumed amounts as each proposed order "matches"
 * 3. Processing proposed NO orders in price priority order (best prices first)
 * 
 * This ensures the preview matches EXACTLY what would happen if orders were placed.
 * 
 * @param {Array} marketPreviews - Array of market preview objects with orders
 * @returns {object} Auto-match summary
 */
function calculateAutoMatchesForDeployment(marketPreviews) {
  const autoMatches = [];
  let totalMatchAmount = 0;
  let totalMatchCost = 0;
  let marketsWithMatches = 0;
  
  for (const market of marketPreviews) {
    if (market.disabled || !market.orders || market.orders.length === 0) {
      continue;
    }
    
    // Step 1: Get ALL YES orders for this market ONCE
    // This is the "order book snapshot" we'll match against
    const yesOrders = db.prepare(`
      SELECT id, price_cents, amount_sats, filled_sats
      FROM orders
      WHERE market_id = ? 
        AND side = 'yes' 
        AND status IN ('open', 'partial')
      ORDER BY price_cents DESC, created_at ASC
    `).all(market.market_id);
    
    if (yesOrders.length === 0) {
      continue; // No YES orders to match against
    }
    
    // Step 2: Track available amounts for each YES order (simulate consumption)
    // Key: order_id, Value: remaining available sats
    const availableByYesOrder = new Map();
    for (const yesOrder of yesOrders) {
      availableByYesOrder.set(yesOrder.id, yesOrder.amount_sats - yesOrder.filled_sats);
    }
    
    // Step 3: Sort proposed NO orders by price DESC (best prices match first)
    // This matches actual matching engine behavior: orders at better prices get priority
    const sortedNoOrders = [...market.orders].sort((a, b) => b.price - a.price);
    
    const marketMatches = [];
    let marketMatchAmount = 0;
    let marketMatchCost = 0;
    
    // Step 4: Process each proposed NO order, consuming from the shared pool
    for (const proposedOrder of sortedNoOrders) {
      const noPrice = proposedOrder.price;
      let remainingAmount = proposedOrder.amount;
      let orderMatchAmount = 0;
      let orderMatchCost = 0;
      const matchingOrderDetails = [];
      
      // Find YES orders that would match
      // NO order at price P matches YES orders where YES_price >= (100 - P)
      // Because NO@60 means "I want NO at 60% YES prob" → costs 40 sats
      // and matches YES@40+ (who pay 40+ sats for YES)
      const minYesPriceToMatch = 100 - noPrice;
      
      for (const yesOrder of yesOrders) {
        if (remainingAmount <= 0) break;
        if (yesOrder.price_cents < minYesPriceToMatch) continue; // Won't match
        
        // Get CURRENT available (may have been consumed by previous proposed orders)
        const available = availableByYesOrder.get(yesOrder.id);
        if (available <= 0) continue;
        
        const matchAmount = Math.min(remainingAmount, available);
        
        // Calculate cost (NO pays 100 - trade_price where trade_price = YES order's price)
        const tradePrice = yesOrder.price_cents;
        const matchCost = Math.ceil(matchAmount * (100 - tradePrice) / 100);
        
        // "Consume" this amount from the YES order (for subsequent proposed orders)
        availableByYesOrder.set(yesOrder.id, available - matchAmount);
        
        orderMatchAmount += matchAmount;
        orderMatchCost += matchCost;
        remainingAmount -= matchAmount;
        
        matchingOrderDetails.push({
          order_id: yesOrder.id,
          yes_price: yesOrder.price_cents,
          available_before: available,
          match_amount: matchAmount,
          match_cost: matchCost
        });
      }
      
      if (orderMatchAmount > 0) {
        marketMatches.push({
          order_price: proposedOrder.price,
          order_amount: proposedOrder.amount,
          match_amount: orderMatchAmount,
          match_cost: orderMatchCost,
          remaining: proposedOrder.amount - orderMatchAmount,
          matching_orders: matchingOrderDetails
        });
        
        marketMatchAmount += orderMatchAmount;
        marketMatchCost += orderMatchCost;
      }
    }
    
    if (marketMatches.length > 0) {
      autoMatches.push({
        market_id: market.market_id,
        grandmaster_name: market.grandmaster_name,
        matches: marketMatches,
        total_match_amount: marketMatchAmount,
        total_match_cost: marketMatchCost
      });
      
      totalMatchAmount += marketMatchAmount;
      totalMatchCost += marketMatchCost;
      marketsWithMatches++;
    }
  }
  
  return {
    has_auto_matches: autoMatches.length > 0,
    markets_with_matches: marketsWithMatches,
    total_match_amount: totalMatchAmount,
    total_match_cost: totalMatchCost,
    matches_by_market: autoMatches
  };
}

// ==================== DEPLOYMENT PREVIEW ====================

/**
 * Get a preview of what would be deployed without actually deploying
 * This shows exactly what orders will be placed for each market
 * 
 * FIXED: Now uses effectiveBalance as the budget, matching deployAllOrders exactly
 * 
 * Formula: displayed_liquidity = effectiveBalance × multiplier × pullback_ratio
 * 
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
  
  // Cap effective budget at max_acceptable_loss (can't risk more than you've set)
  const maxBudget = Math.min(effectiveBalance, config.max_acceptable_loss);
  
  // Apply multiplier to get displayed liquidity
  const displayedLiquidity = maxBudget * config.global_multiplier;
  
  // Calculate current pullback ratio (for informational purposes)
  const currentExposure = calculateCurrentExposure();
  const pullbackRatio = calculatePullbackRatio(currentExposure, config.max_acceptable_loss);
  
  // Effective budget after pullback (what we'd actually deploy)
  const deployableBudget = displayedLiquidity * pullbackRatio;
  
  // Calculate what would be deployed to each market
  const marketPreviews = [];
  let totalCost = 0;
  let totalOrders = 0;
  
  for (const market of markets) {
    // FIXED: Pass the deployableBudget as the total budget
    const effectiveCurve = getEffectiveCurve(market.id, 'buy', deployableBudget);
    
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
  
  // Calculate auto-matches - which orders would immediately match existing YES orders
  const autoMatchData = calculateAutoMatchesForDeployment(marketPreviews);
  
  return {
    success: true,
    user_balance: user.balance_sats,
    existing_orders_refund: totalRefund,
    effective_balance: effectiveBalance,
    max_budget: maxBudget,
    displayed_liquidity: displayedLiquidity,
    pullback_ratio: pullbackRatio,
    deployable_budget: deployableBudget,
    current_exposure: currentExposure,
    total_cost: totalCost,
    total_orders: totalOrders,
    total_markets: marketPreviews.filter(m => !m.disabled).length,
    has_sufficient_balance: hasBalance,
    shortfall: hasBalance ? 0 : totalCost - effectiveBalance,
    markets: marketPreviews,
    // Auto-match warning data
    auto_matches: autoMatchData,
    config: {
      max_acceptable_loss: config.max_acceptable_loss,
      global_multiplier: config.global_multiplier,
      threshold_percent: config.threshold_percent,
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
  updateCrossoverPoint,
  
  // Two-Sided Liquidity
  getEffectiveCurveTwoSided,
  calculateExposureWithAnnihilation,
  deployAllOrdersTwoSided,
  getDeploymentPreviewTwoSided,
  
  // Tier Management
  TIER_ORDER,
  TIER_CURVE_CENTERS,
  getTierSummary,
  getMarketsByTier,
  setTierBudget,
  initializeWeightsFromScores,
  getDefaultCurveCenter,
  
  // Market Weights (Auto-Rebalancing)
  initializeMarketWeights,
  getMarketWeights,
  getMarketWeight,
  setMarketWeight,
  normalizeWeights,
  setRelativeOdds,
  applyRelativeOdds,
  setWeightLock,
  
  // Curve Center (Per-market odds skew)
  getCurveCenter,
  setCurveCenter,
  resetAllCurveCenters,
  
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
  getDeploymentPreview,
  
  // Pullback Thresholds
  DEFAULT_THRESHOLDS,
  getThresholds,
  initializeDefaultThresholds,
  setThreshold,
  removeThreshold,
  setAllThresholds,
  resetThresholdsToDefaults,
  calculatePullbackRatioFromThresholds,
  getPullbackStatus
};
