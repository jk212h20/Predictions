/**
 * MATCHING ENGINE v2.0
 * 
 * Clean implementation based on spec agreed 2026-01-31.
 * 
 * CONSTANTS:
 *   SATS_PER_SHARE = 1000 (1 share pays 1000 sats to winner)
 *   PRICE RANGE: 1-999 sats (0.1% - 99.9% implied odds)
 * 
 * RULES:
 *   - Both YES and NO pay their stated price_sats per share
 *   - Matching: YES@Y matches NO@N when Y + N >= 1000 (prices cross)
 *   - Trade executes at RESTING order's price (maker advantage)
 *   - Taker pays (1000 - resting_price), gets price improvement if limit > actual
 *   - Auto-settle: If yes_user_id == no_user_id, payout = shares × 1000
 * 
 * TESTED: All 15 scenarios pass (matching, conservation, improvement, settle, resolution)
 */

const { v4: uuidv4 } = require('uuid');

const SATS_PER_SHARE = 1000;
const MIN_PRICE = 1;
const MAX_PRICE = 999;

/**
 * Place an order in a market.
 * 
 * @param {Object} db - better-sqlite3 database instance
 * @param {string} userId - User placing the order
 * @param {string} marketId - Market to trade in
 * @param {string} side - 'yes' or 'no'
 * @param {number} priceSats - Price per share in sats (1-999)
 * @param {number} amountSats - Total payout desired (shares × 1000)
 * @returns {Object} Result with success flag and details
 */
function placeOrder(db, userId, marketId, side, priceSats, amountSats) {
  // Validate inputs
  if (!['yes', 'no'].includes(side)) {
    return { success: false, error: 'Side must be "yes" or "no"' };
  }
  
  if (priceSats < MIN_PRICE || priceSats > MAX_PRICE || !Number.isInteger(priceSats)) {
    return { success: false, error: `Price must be integer ${MIN_PRICE}-${MAX_PRICE}` };
  }
  
  if (amountSats < SATS_PER_SHARE || !Number.isInteger(amountSats)) {
    return { success: false, error: `Amount must be at least ${SATS_PER_SHARE} sats` };
  }
  
  // Calculate shares and cost
  // Price = what THIS side pays per share (both YES and NO)
  const shares = Math.floor(amountSats / SATS_PER_SHARE);
  const costPerShare = priceSats;  // Both sides pay their stated price
  const totalCost = shares * costPerShare;
  
  // Generate order ID upfront (needed for bet records)
  const orderId = uuidv4();
  
  // Run in transaction
  const executeOrder = db.transaction(() => {
    // Check user exists and get balance
    const user = db.prepare('SELECT balance_sats FROM users WHERE id = ?').get(userId);
    if (!user) {
      throw new Error('User not found');
    }
    
    // Check sufficient balance
    if (user.balance_sats < totalCost) {
      throw new Error(`Insufficient balance. Need ${totalCost}, have ${user.balance_sats}`);
    }
    
    // Check market exists and is open
    const market = db.prepare('SELECT status FROM markets WHERE id = ?').get(marketId);
    if (!market) {
      throw new Error('Market not found');
    }
    if (market.status !== 'open') {
      throw new Error('Market is not open for trading');
    }
    
    // Deduct cost from user balance
    db.prepare('UPDATE users SET balance_sats = balance_sats - ? WHERE id = ?')
      .run(totalCost, userId);
    
    // Log the order placement transaction
    const userAfterDeduct = db.prepare('SELECT balance_sats FROM users WHERE id = ?').get(userId);
    db.prepare(`
      INSERT INTO transactions (id, user_id, type, amount_sats, balance_after, reference_id, status, created_at)
      VALUES (?, ?, 'order_placed', ?, ?, ?, 'completed', datetime('now'))
    `).run(uuidv4(), userId, -totalCost, userAfterDeduct.balance_sats, orderId);
    
    // Find matching orders
    const oppositeSide = side === 'yes' ? 'no' : 'yes';
    
    // Matching condition:
    // If incoming is YES at price Y, matches NO orders where (1000 - NO_price) <= Y
    // i.e., NO_price >= 1000 - Y
    // If incoming is NO at price N, matches YES orders where YES_price >= 1000 - N
    
    let matchQuery;
    if (side === 'yes') {
      // YES@Y matches NO orders where NO.price >= (1000 - Y)
      // Example: YES@500 matches NO where NO_price >= 500 (so NO@500, NO@600, etc.)
      // Best for YES taker: match NO with highest price first (they pay more → better deal for us)
      matchQuery = db.prepare(`
        SELECT * FROM orders 
        WHERE market_id = ? 
          AND side = 'no' 
          AND status IN ('open', 'partial')
          AND price_sats >= ?
        ORDER BY price_sats DESC, created_at ASC
      `);
    } else {
      // NO@N matches YES orders where YES.price >= (1000 - N)
      // Example: NO@500 matches YES where YES_price >= 500 (so YES@500, YES@600, etc.)
      // Best for NO taker: match YES with highest price first (they pay more → better deal for us)
      matchQuery = db.prepare(`
        SELECT * FROM orders 
        WHERE market_id = ? 
          AND side = 'yes' 
          AND status IN ('open', 'partial')
          AND price_sats >= ?
        ORDER BY price_sats DESC, created_at ASC
      `);
    }
    
    const minMatchPrice = SATS_PER_SHARE - priceSats;
    const matchingOrders = matchQuery.all(marketId, minMatchPrice);
    
    // DEBUG: Log matching attempt
    console.log(`[MATCHING] User ${userId.slice(0,8)} placing ${side.toUpperCase()}@${priceSats} for ${shares} shares`);
    console.log(`[MATCHING] Looking for ${oppositeSide.toUpperCase()} orders where price >= ${minMatchPrice}`);
    console.log(`[MATCHING] Found ${matchingOrders.length} potential matches:`, matchingOrders.map(o => `${o.id.slice(0,8)}:${o.side}@${o.price_sats}`));
    
    let remainingShares = shares;
    let actualMatchCost = 0;  // Track actual cost at trade prices (for price improvement)
    const betsCreated = [];
    
    for (const restingOrder of matchingOrders) {
      if (remainingShares <= 0) break;
      
      const restingRemaining = restingOrder.amount_sats / SATS_PER_SHARE - restingOrder.filled_sats / SATS_PER_SHARE;
      // Actually, let's use the actual column names. Check the schema.
      // Orders have: amount_sats (total payout), filled_sats (filled payout)
      // So remaining = (amount_sats - filled_sats) / SATS_PER_SHARE
      const restingRemainingShares = Math.floor((restingOrder.amount_sats - restingOrder.filled_sats) / SATS_PER_SHARE);
      
      if (restingRemainingShares <= 0) continue;
      
      const matchedShares = Math.min(remainingShares, restingRemainingShares);
      const matchedSats = matchedShares * SATS_PER_SHARE;
      
      // Trade price stored in bet should ALWAYS be the YES price
      // (what the YES side pays per share)
      let betPriceSats;
      if (side === 'yes') {
        // Incoming is YES, resting is NO
        // YES pays (1000 - NO_price), so YES_price = 1000 - restingOrder.price_sats
        betPriceSats = SATS_PER_SHARE - restingOrder.price_sats;
      } else {
        // Incoming is NO, resting is YES
        // YES price is the resting order's price
        betPriceSats = restingOrder.price_sats;
      }
      
      // Determine who is YES and who is NO
      let yesUserId, noUserId;
      if (side === 'yes') {
        yesUserId = userId;
        noUserId = restingOrder.user_id;
      } else {
        yesUserId = restingOrder.user_id;
        noUserId = userId;
      }
      
      // Create bet
      const betId = uuidv4();
      // Determine order IDs for the bet record
      let yesOrderId, noOrderId;
      if (side === 'yes') {
        yesOrderId = orderId;
        noOrderId = restingOrder.id;
      } else {
        yesOrderId = restingOrder.id;
        noOrderId = orderId;
      }
      
      db.prepare(`
        INSERT INTO bets (id, market_id, yes_user_id, no_user_id, yes_order_id, no_order_id, amount_sats, price_sats, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', datetime('now'))
      `).run(betId, marketId, yesUserId, noUserId, yesOrderId, noOrderId, matchedSats, betPriceSats);
      
      betsCreated.push({
        betId,
        shares: matchedShares,
        priceSats: betPriceSats,
        counterpartyId: restingOrder.user_id
      });
      
      // Update resting order
      const newFilledSats = restingOrder.filled_sats + matchedSats;
      const newStatus = newFilledSats >= restingOrder.amount_sats ? 'filled' : 'partial';
      db.prepare('UPDATE orders SET filled_sats = ?, status = ?, updated_at = datetime(\'now\') WHERE id = ?')
        .run(newFilledSats, newStatus, restingOrder.id);
      
      // Calculate actual cost for this match
      // If YES taker: pays betPriceSats per share (the YES price)
      // If NO taker: pays (1000 - betPriceSats) per share  
      const actualCostPerShare = side === 'yes' ? betPriceSats : (SATS_PER_SHARE - betPriceSats);
      actualMatchCost += matchedShares * actualCostPerShare;
      
      remainingShares -= matchedShares;
      
      // AUTO-SETTLE CHECK: If same user owns both sides
      if (yesUserId === noUserId) {
        const settlePayout = matchedShares * SATS_PER_SHARE;
        db.prepare('UPDATE users SET balance_sats = balance_sats + ? WHERE id = ?')
          .run(settlePayout, yesUserId);
        db.prepare('UPDATE bets SET status = \'settled\' WHERE id = ?')
          .run(betId);
        const userAfterSettle = db.prepare('SELECT balance_sats FROM users WHERE id = ?').get(yesUserId);
        db.prepare(`
          INSERT INTO transactions (id, user_id, type, amount_sats, balance_after, reference_id, status, created_at)
          VALUES (?, ?, 'bet_won', ?, ?, ?, 'completed', datetime('now'))
        `).run(uuidv4(), yesUserId, settlePayout, userAfterSettle.balance_sats, betId);
      }
    }
    
    // Calculate price improvement refund
    // We charged totalCost = shares * costPerShare (at limit price)
    // Actual cost = actualMatchCost (filled shares at trade price) + remaining * costPerShare (unfilled at limit)
    const filledShares = shares - remainingShares;
    const chargedForFilled = filledShares * costPerShare;
    const priceImprovement = chargedForFilled - actualMatchCost;
    
    if (priceImprovement > 0) {
      db.prepare('UPDATE users SET balance_sats = balance_sats + ? WHERE id = ?')
        .run(priceImprovement, userId);
    }
    
    // Create order record (always create one for tracking)
    let orderStatus = 'filled';
    const filledSats = filledShares * SATS_PER_SHARE;
    const totalSats = shares * SATS_PER_SHARE;
    
    if (remainingShares > 0) {
      orderStatus = shares === remainingShares ? 'open' : 'partial';
    }
    
    // Insert the order (orderId was created at start of function)
    db.prepare(`
      INSERT INTO orders (id, user_id, market_id, side, price_sats, amount_sats, filled_sats, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
    `).run(orderId, userId, marketId, side, priceSats, totalSats, filledSats, orderStatus);
    
    // Get updated balance
    const updatedUser = db.prepare('SELECT balance_sats FROM users WHERE id = ?').get(userId);
    
    // Transaction-local invariant check: balance should not be negative
    if (updatedUser.balance_sats < 0) {
      throw new Error('INVARIANT VIOLATION: Balance went negative');
    }
    
    return {
      success: true,
      orderId,
      orderStatus,
      filled: shares - remainingShares,
      remaining: remainingShares,
      cost: totalCost,
      newBalance: updatedUser.balance_sats,
      betsCreated
    };
  });
  
  try {
    return executeOrder();
  } catch (error) {
    return { success: false, error: error.message };
  }
}

/**
 * Cancel an open order and refund the user.
 * 
 * @param {Object} db - better-sqlite3 database instance
 * @param {string} userId - User cancelling the order
 * @param {string} orderId - Order to cancel
 * @returns {Object} Result with success flag and refund amount
 */
function cancelOrder(db, userId, orderId) {
  const executeCancellation = db.transaction(() => {
    // Get the order
    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
    
    if (!order) {
      throw new Error('Order not found');
    }
    
    if (order.user_id !== userId) {
      throw new Error('Order does not belong to this user');
    }
    
    if (!['open', 'partial'].includes(order.status)) {
      throw new Error('Order cannot be cancelled (already filled or cancelled)');
    }
    
    // Calculate refund - both sides pay their stated price
    const unfilledSats = order.amount_sats - order.filled_sats;
    const unfilledShares = Math.floor(unfilledSats / SATS_PER_SHARE);
    const costPerShare = order.price_sats;  // Both sides pay their stated price
    const refund = unfilledShares * costPerShare;
    
    // Update order status
    db.prepare('UPDATE orders SET status = \'cancelled\', updated_at = datetime(\'now\') WHERE id = ?')
      .run(orderId);
    
    // Refund user
    db.prepare('UPDATE users SET balance_sats = balance_sats + ? WHERE id = ?')
      .run(refund, userId);
    
    // Get updated balance
    const updatedUser = db.prepare('SELECT balance_sats FROM users WHERE id = ?').get(userId);
    
    // Log transaction
    db.prepare(`
      INSERT INTO transactions (id, user_id, type, amount_sats, balance_after, reference_id, status, created_at)
      VALUES (?, ?, 'order_cancelled', ?, ?, ?, 'completed', datetime('now'))
    `).run(uuidv4(), userId, refund, updatedUser.balance_sats, orderId);
    
    return {
      success: true,
      refund,
      newBalance: updatedUser.balance_sats
    };
  });
  
  try {
    return executeCancellation();
  } catch (error) {
    return { success: false, error: error.message };
  }
}

/**
 * Resolve a market and pay out winners.
 * 
 * @param {Object} db - better-sqlite3 database instance
 * @param {string} marketId - Market to resolve
 * @param {string} outcome - 'yes' or 'no'
 * @returns {Object} Result with success flag and payout details
 */
function resolveMarket(db, marketId, outcome) {
  if (!['yes', 'no'].includes(outcome)) {
    return { success: false, error: 'Outcome must be "yes" or "no"' };
  }
  
  const executeResolution = db.transaction(() => {
    // Check market exists
    const market = db.prepare('SELECT * FROM markets WHERE id = ?').get(marketId);
    if (!market) {
      throw new Error('Market not found');
    }
    
    // Get all active bets
    const activeBets = db.prepare('SELECT * FROM bets WHERE market_id = ? AND status = \'active\'').all(marketId);
    
    const payouts = [];
    
    for (const bet of activeBets) {
      const shares = Math.floor(bet.amount_sats / SATS_PER_SHARE);
      const payout = shares * SATS_PER_SHARE;
      const winnerId = outcome === 'yes' ? bet.yes_user_id : bet.no_user_id;
      const loserId = outcome === 'yes' ? bet.no_user_id : bet.yes_user_id;
      
      // Pay winner
      db.prepare('UPDATE users SET balance_sats = balance_sats + ? WHERE id = ?')
        .run(payout, winnerId);
      
      // Log winner transaction
      const winnerBalance = db.prepare('SELECT balance_sats FROM users WHERE id = ?').get(winnerId);
      db.prepare(`
        INSERT INTO transactions (id, user_id, type, amount_sats, balance_after, reference_id, status, created_at)
        VALUES (?, ?, 'bet_won', ?, ?, ?, 'completed', datetime('now'))
      `).run(uuidv4(), winnerId, payout, winnerBalance.balance_sats, bet.id);
      
      // Log loser transaction (0 amount, just for record)
      if (winnerId !== loserId) {
        const loserBalance = db.prepare('SELECT balance_sats FROM users WHERE id = ?').get(loserId);
        db.prepare(`
          INSERT INTO transactions (id, user_id, type, amount_sats, balance_after, reference_id, status, created_at)
          VALUES (?, ?, 'bet_lost', 0, ?, ?, 'completed', datetime('now'))
        `).run(uuidv4(), loserId, loserBalance.balance_sats, bet.id);
      }
      
      // Update bet status
      db.prepare('UPDATE bets SET status = \'settled\' WHERE id = ?')
        .run(bet.id);
      
      payouts.push({ betId: bet.id, winnerId, payout });
    }
    
    // Cancel all open orders and refund
    const openOrders = db.prepare('SELECT * FROM orders WHERE market_id = ? AND status IN (\'open\', \'partial\')').all(marketId);
    
    for (const order of openOrders) {
      const unfilledSats = order.amount_sats - order.filled_sats;
      const unfilledShares = Math.floor(unfilledSats / SATS_PER_SHARE);
      const costPerShare = order.price_sats;  // Both sides pay their stated price
      const refund = unfilledShares * costPerShare;
      
      if (refund > 0) {
        db.prepare('UPDATE users SET balance_sats = balance_sats + ? WHERE id = ?')
          .run(refund, order.user_id);
        
        const userBalance = db.prepare('SELECT balance_sats FROM users WHERE id = ?').get(order.user_id);
        db.prepare(`
          INSERT INTO transactions (id, user_id, type, amount_sats, balance_after, reference_id, status, created_at)
          VALUES (?, ?, 'order_cancelled', ?, ?, ?, 'completed', datetime('now'))
        `).run(uuidv4(), order.user_id, refund, userBalance.balance_sats, order.id);
      }
      
      db.prepare('UPDATE orders SET status = \'cancelled\', updated_at = datetime(\'now\') WHERE id = ?')
        .run(order.id);
    }
    
    // Update market status
    db.prepare('UPDATE markets SET status = \'resolved\', resolution = ? WHERE id = ?')
      .run(outcome, marketId);
    
    return {
      success: true,
      outcome,
      betsSettled: payouts.length,
      ordersRefunded: openOrders.length,
      payouts
    };
  });
  
  try {
    return executeResolution();
  } catch (error) {
    return { success: false, error: error.message };
  }
}

module.exports = {
  placeOrder,
  cancelOrder,
  resolveMarket,
  SATS_PER_SHARE,
  MIN_PRICE,
  MAX_PRICE
};
