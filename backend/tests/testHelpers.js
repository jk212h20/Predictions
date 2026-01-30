/**
 * Test Helpers for Order Matching Tests
 * 
 * INTEGER-BASED TRADING SYSTEM
 * ============================
 * - 1 share = 1000 sats payout to winner
 * - Price = sats per share (1-999)
 * - Matching: YES price + NO price >= 1000
 * - Sitting order filled at exact price
 * - Taker gets improvement if available
 * 
 * Example:
 *   Bob posts: NO @ 400 sats/share (5 shares) → pays 2000 sats
 *   Alice takes: YES @ 700 sats/share (5 shares) → would pay up to 3500
 *   Match: 700 + 400 >= 1000 ✓
 *   Bob fills at 400, Alice pays 1000-400 = 600/share = 3000 sats
 *   Total locked: 5000 sats, winner gets all
 */

const Database = require('better-sqlite3');
const { v4: uuidv4 } = require('uuid');

// Constants
const SHARE_VALUE_SATS = 1000;  // 1 share = 1000 sats payout

/**
 * Creates an in-memory SQLite database with the new integer-based schema
 */
function createTestDatabase() {
  const db = new Database(':memory:');
  
  db.exec(`
    CREATE TABLE users (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE,
      username TEXT,
      balance_sats INTEGER DEFAULT 0,
      is_admin INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE grandmasters (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      fide_rating INTEGER,
      country TEXT,
      tier TEXT,
      likelihood_score INTEGER,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE markets (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL CHECK(type IN ('attendance', 'winner', 'event')),
      grandmaster_id TEXT,
      title TEXT NOT NULL,
      description TEXT,
      status TEXT DEFAULT 'open' CHECK(status IN ('open', 'pending_resolution', 'resolved', 'cancelled')),
      resolution TEXT CHECK(resolution IN ('yes', 'no', NULL)),
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (grandmaster_id) REFERENCES grandmasters(id)
    );

    -- Orders: Integer-based system
    -- price_sats = what this side pays per share (1-999)
    -- shares = number of shares (integer)
    CREATE TABLE orders (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      market_id TEXT NOT NULL,
      side TEXT NOT NULL CHECK(side IN ('yes', 'no')),
      price_sats INTEGER NOT NULL CHECK(price_sats >= 1 AND price_sats <= 999),
      shares INTEGER NOT NULL CHECK(shares >= 1),
      filled_shares INTEGER DEFAULT 0,
      status TEXT DEFAULT 'open' CHECK(status IN ('open', 'partial', 'filled', 'cancelled')),
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id),
      FOREIGN KEY (market_id) REFERENCES markets(id)
    );

    -- Bets: Each share is 1000 sats payout
    -- trade_price_sats = what YES side paid per share (for record keeping)
    CREATE TABLE bets (
      id TEXT PRIMARY KEY,
      market_id TEXT NOT NULL,
      yes_user_id TEXT NOT NULL,
      no_user_id TEXT NOT NULL,
      yes_order_id TEXT NOT NULL,
      no_order_id TEXT NOT NULL,
      trade_price_sats INTEGER NOT NULL,
      shares INTEGER NOT NULL,
      status TEXT DEFAULT 'active' CHECK(status IN ('active', 'settled', 'refunded')),
      winner_user_id TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      settled_at TEXT,
      FOREIGN KEY (market_id) REFERENCES markets(id)
    );

    CREATE TABLE transactions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      type TEXT NOT NULL,
      amount_sats INTEGER NOT NULL,
      balance_after INTEGER NOT NULL,
      reference_id TEXT,
      status TEXT DEFAULT 'completed',
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX idx_orders_market ON orders(market_id, status);
    CREATE INDEX idx_orders_price ON orders(market_id, side, price_sats, created_at);
    CREATE INDEX idx_bets_market ON bets(market_id, status);
    CREATE INDEX idx_bets_yes ON bets(yes_user_id, market_id);
    CREATE INDEX idx_bets_no ON bets(no_user_id, market_id);
  `);
  
  return db;
}

/**
 * Creates a test user with a specified balance
 */
function createTestUser(db, balance = 1000000, options = {}) {
  const id = options.id || uuidv4();
  const email = options.email || `test-${id.substring(0, 8)}@test.com`;
  const username = options.username || `user-${id.substring(0, 8)}`;
  const is_admin = options.is_admin || 0;
  
  db.prepare(`
    INSERT INTO users (id, email, username, balance_sats, is_admin)
    VALUES (?, ?, ?, ?, ?)
  `).run(id, email, username, balance, is_admin);
  
  return { id, email, username, balance_sats: balance, is_admin };
}

/**
 * Creates a test grandmaster
 */
function createTestGrandmaster(db, options = {}) {
  const id = options.id || uuidv4();
  const name = options.name || `Test GM ${id.substring(0, 8)}`;
  
  db.prepare(`
    INSERT INTO grandmasters (id, name, fide_rating, country)
    VALUES (?, ?, ?, ?)
  `).run(id, name, options.fide_rating || 2700, options.country || 'USA');
  
  return { id, name };
}

/**
 * Creates a test market
 */
function createTestMarket(db, options = {}) {
  const id = options.id || uuidv4();
  const gmId = options.grandmaster_id || createTestGrandmaster(db).id;
  const type = options.type || 'attendance';
  const status = options.status || 'open';
  
  db.prepare(`
    INSERT INTO markets (id, type, grandmaster_id, title, status)
    VALUES (?, ?, ?, ?, ?)
  `).run(id, type, gmId, options.title || `Test Market ${id.substring(0, 8)}`, status);
  
  return { id, type, grandmaster_id: gmId, status };
}

/**
 * Gets user's current balance
 */
function getUserBalance(db, userId) {
  const user = db.prepare('SELECT balance_sats FROM users WHERE id = ?').get(userId);
  return user ? user.balance_sats : null;
}

/**
 * Gets an order by ID
 */
function getOrder(db, orderId) {
  return db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
}

/**
 * Gets all orders in a market
 */
function getMarketOrders(db, marketId, status = null) {
  if (status) {
    return db.prepare(`
      SELECT * FROM orders WHERE market_id = ? AND status = ? ORDER BY created_at
    `).all(marketId, status);
  }
  return db.prepare(`
    SELECT * FROM orders WHERE market_id = ? ORDER BY created_at
  `).all(marketId);
}

/**
 * Gets all bets in a market
 */
function getMarketBets(db, marketId) {
  return db.prepare(`
    SELECT * FROM bets WHERE market_id = ? ORDER BY created_at
  `).all(marketId);
}

/**
 * Gets user's positions in a market (in shares)
 */
function getUserPositions(db, userId, marketId) {
  const yesShares = db.prepare(`
    SELECT COALESCE(SUM(shares), 0) as total
    FROM bets WHERE market_id = ? AND yes_user_id = ? AND status = 'active'
  `).get(marketId, userId).total;
  
  const noShares = db.prepare(`
    SELECT COALESCE(SUM(shares), 0) as total
    FROM bets WHERE market_id = ? AND no_user_id = ? AND status = 'active'
  `).get(marketId, userId).total;
  
  return { yes: yesShares, no: noShares };
}

/**
 * Calculate implied percentage from sats price
 */
function impliedPercent(priceSats) {
  return (priceSats / SHARE_VALUE_SATS * 100).toFixed(1);
}

/**
 * INTEGER-BASED ORDER MATCHING
 * 
 * Key rules:
 * 1. 1 share = 1000 sats total value
 * 2. YES price + NO price must >= 1000 to match
 * 3. Sitting order fills at their exact price
 * 4. Taker pays complement of sitting price (gets improvement)
 * 5. No rounding ever - all integers
 */
function placeOrder(db, userId, marketId, side, priceSats, shares, options = {}) {
  // Validation
  if (!['yes', 'no'].includes(side)) {
    return { error: 'Side must be yes or no' };
  }
  if (!Number.isInteger(priceSats) || priceSats < 1 || priceSats > 999) {
    return { error: 'Price must be integer between 1 and 999 sats' };
  }
  if (!Number.isInteger(shares) || shares < 1) {
    return { error: 'Shares must be positive integer' };
  }
  
  // Check market exists and is open
  const market = db.prepare('SELECT * FROM markets WHERE id = ?').get(marketId);
  if (!market || market.status !== 'open') {
    return { error: 'Market not available for trading' };
  }
  
  // Check balance
  const user = db.prepare('SELECT balance_sats FROM users WHERE id = ?').get(userId);
  if (!user) {
    return { error: 'User not found' };
  }
  
  // Calculate maximum cost (user is willing to pay up to this)
  const maxCost = shares * priceSats;
  
  if (user.balance_sats < maxCost) {
    return { error: 'Insufficient balance', required: maxCost, available: user.balance_sats };
  }
  
  // Reserve maximum cost from balance
  let newBalance = user.balance_sats - maxCost;
  db.prepare('UPDATE users SET balance_sats = ? WHERE id = ?').run(newBalance, userId);
  
  // Try to match with existing orders
  const orderId = uuidv4();
  let remainingShares = shares;
  const matchedBets = [];
  let totalCost = 0;  // Actual cost (may be less than max due to price improvement)
  
  // Find matching orders on opposite side
  // For YES buyer: look for NO sellers where NO_price + YES_price >= 1000
  // Equivalently: NO_price >= 1000 - YES_price
  const oppositeSide = side === 'yes' ? 'no' : 'yes';
  const minComplementPrice = SHARE_VALUE_SATS - priceSats;
  
  // Match against best prices first
  // For YES taker: want highest NO prices (lower cost for YES)
  // For NO taker: want highest YES prices (lower cost for NO)
  const matchingOrders = db.prepare(`
    SELECT * FROM orders
    WHERE market_id = ? AND side = ? AND status IN ('open', 'partial')
    AND price_sats >= ?
    ORDER BY price_sats DESC, created_at ASC
  `).all(marketId, oppositeSide, minComplementPrice);
  
  for (const matchOrder of matchingOrders) {
    if (remainingShares <= 0) break;
    
    // Skip self-trades
    if (matchOrder.user_id === userId) {
      continue;
    }
    
    const matchAvailable = matchOrder.shares - matchOrder.filled_shares;
    const matchShares = Math.min(remainingShares, matchAvailable);
    
    // Sitting order filled at their price
    // Taker pays complement: 1000 - sitting_price
    const sittingPrice = matchOrder.price_sats;
    const takerPrice = SHARE_VALUE_SATS - sittingPrice;
    
    // Determine YES and NO prices based on who is taker
    const yesPriceSats = side === 'yes' ? takerPrice : sittingPrice;
    const noPriceSats = side === 'no' ? takerPrice : sittingPrice;
    
    // Create bet
    const betId = uuidv4();
    const yesUserId = side === 'yes' ? userId : matchOrder.user_id;
    const noUserId = side === 'no' ? userId : matchOrder.user_id;
    const yesOrderId = side === 'yes' ? orderId : matchOrder.id;
    const noOrderId = side === 'no' ? orderId : matchOrder.id;
    
    db.prepare(`
      INSERT INTO bets (id, market_id, yes_user_id, no_user_id, yes_order_id, no_order_id, trade_price_sats, shares)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(betId, marketId, yesUserId, noUserId, yesOrderId, noOrderId, yesPriceSats, matchShares);
    
    // Update matched order
    const newFilled = matchOrder.filled_shares + matchShares;
    const newStatus = newFilled >= matchOrder.shares ? 'filled' : 'partial';
    db.prepare('UPDATE orders SET filled_shares = ?, status = ? WHERE id = ?')
      .run(newFilled, newStatus, matchOrder.id);
    
    remainingShares -= matchShares;
    totalCost += matchShares * takerPrice;
    
    matchedBets.push({ 
      betId, 
      shares: matchShares, 
      price_sats: takerPrice,
      implied_pct: impliedPercent(yesPriceSats),
      matchedOrderId: matchOrder.id,
      matchedUserId: matchOrder.user_id
    });
  }
  
  // Calculate unfilled order cost
  const unfilledCost = remainingShares * priceSats;
  totalCost += unfilledCost;
  
  // Refund any price improvement (maxCost - totalCost)
  const refund = maxCost - totalCost;
  if (refund > 0) {
    newBalance += refund;
    db.prepare('UPDATE users SET balance_sats = ? WHERE id = ?').run(newBalance, userId);
  }
  
  // Create order for remaining/full amount
  const filledShares = shares - remainingShares;
  const orderStatus = remainingShares === 0 ? 'filled' : 
                      remainingShares < shares ? 'partial' : 'open';
  
  db.prepare(`
    INSERT INTO orders (id, user_id, market_id, side, price_sats, shares, filled_shares, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(orderId, userId, marketId, side, priceSats, shares, filledShares, orderStatus);
  
  // Record transaction
  db.prepare(`
    INSERT INTO transactions (id, user_id, type, amount_sats, balance_after, reference_id)
    VALUES (?, ?, 'order_placed', ?, ?, ?)
  `).run(uuidv4(), userId, -totalCost, newBalance, orderId);
  
  // AUTO-SETTLE: Check if user now has opposing positions
  let autoSettled = null;
  if (matchedBets.length > 0) {
    const yesShares = db.prepare(`
      SELECT COALESCE(SUM(shares), 0) as total
      FROM bets WHERE market_id = ? AND yes_user_id = ? AND status = 'active'
    `).get(marketId, userId).total;
    
    const noShares = db.prepare(`
      SELECT COALESCE(SUM(shares), 0) as total
      FROM bets WHERE market_id = ? AND no_user_id = ? AND status = 'active'
    `).get(marketId, userId).total;
    
    if (yesShares > 0 && noShares > 0) {
      const settleShares = Math.min(yesShares, noShares);
      const settlePayout = settleShares * SHARE_VALUE_SATS;  // 1000 sats per share
      
      // Mark bets as settled (oldest first)
      let remainingToSettle = settleShares;
      
      const yesBets = db.prepare(`
        SELECT * FROM bets 
        WHERE market_id = ? AND yes_user_id = ? AND status = 'active'
        ORDER BY created_at ASC
      `).all(marketId, userId);
      
      for (const bet of yesBets) {
        if (remainingToSettle <= 0) break;
        if (bet.shares <= remainingToSettle) {
          db.prepare(`UPDATE bets SET status = 'settled', settled_at = datetime('now'), winner_user_id = ? WHERE id = ?`)
            .run(userId, bet.id);
          remainingToSettle -= bet.shares;
        }
      }
      
      remainingToSettle = settleShares;
      const noBets = db.prepare(`
        SELECT * FROM bets 
        WHERE market_id = ? AND no_user_id = ? AND status = 'active'
        ORDER BY created_at ASC
      `).all(marketId, userId);
      
      for (const bet of noBets) {
        if (remainingToSettle <= 0) break;
        if (bet.shares <= remainingToSettle) {
          db.prepare(`UPDATE bets SET status = 'settled', settled_at = datetime('now'), winner_user_id = ? WHERE id = ?`)
            .run(userId, bet.id);
          remainingToSettle -= bet.shares;
        }
      }
      
      // Credit user the settled amount (1000 sats per share pair)
      const currentUser = db.prepare('SELECT balance_sats FROM users WHERE id = ?').get(userId);
      const balanceAfterSettle = currentUser.balance_sats + settlePayout;
      db.prepare('UPDATE users SET balance_sats = ? WHERE id = ?').run(balanceAfterSettle, userId);
      
      db.prepare(`
        INSERT INTO transactions (id, user_id, type, amount_sats, balance_after, reference_id)
        VALUES (?, ?, 'bet_won', ?, ?, ?)
      `).run(uuidv4(), userId, settlePayout, balanceAfterSettle, 'auto-settle-' + marketId);
      
      newBalance = balanceAfterSettle;
      
      autoSettled = {
        shares_settled: settleShares,
        payout: settlePayout,
        new_balance: balanceAfterSettle
      };
    }
  }
  
  return {
    order_id: orderId,
    status: orderStatus,
    filled_shares: filledShares,
    remaining_shares: remainingShares,
    cost: totalCost,
    max_cost: maxCost,
    refund,
    new_balance: newBalance,
    matched_bets: matchedBets,
    auto_settled: autoSettled,
    implied_pct: impliedPercent(priceSats)
  };
}

/**
 * Cancel an order and refund remaining amount
 */
function cancelOrder(db, userId, orderId) {
  const order = db.prepare('SELECT * FROM orders WHERE id = ? AND user_id = ?').get(orderId, userId);
  
  if (!order) {
    return { error: 'Order not found' };
  }
  if (order.status === 'filled' || order.status === 'cancelled') {
    return { error: 'Order cannot be cancelled' };
  }
  
  const remainingShares = order.shares - order.filled_shares;
  const refund = remainingShares * order.price_sats;  // Simple integer math!
  
  const user = db.prepare('SELECT balance_sats FROM users WHERE id = ?').get(userId);
  const newBalance = user.balance_sats + refund;
  
  db.prepare('UPDATE users SET balance_sats = ? WHERE id = ?').run(newBalance, userId);
  db.prepare('UPDATE orders SET status = ? WHERE id = ?').run('cancelled', orderId);
  
  db.prepare(`
    INSERT INTO transactions (id, user_id, type, amount_sats, balance_after, reference_id)
    VALUES (?, ?, 'order_cancelled', ?, ?, ?)
  `).run(uuidv4(), userId, refund, newBalance, orderId);
  
  return { success: true, refund, new_balance: newBalance };
}

/**
 * Simulate time passage for testing order priority
 */
function createOrderWithTimestamp(db, userId, marketId, side, priceSats, shares, timestampOffset = 0) {
  const orderId = uuidv4();
  const cost = shares * priceSats;
  
  const user = db.prepare('SELECT balance_sats FROM users WHERE id = ?').get(userId);
  if (user.balance_sats < cost) {
    return { error: 'Insufficient balance' };
  }
  
  const newBalance = user.balance_sats - cost;
  db.prepare('UPDATE users SET balance_sats = ? WHERE id = ?').run(newBalance, userId);
  
  db.prepare(`
    INSERT INTO orders (id, user_id, market_id, side, price_sats, shares, filled_shares, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 0, 'open', datetime('now', ? || ' seconds'))
  `).run(orderId, userId, marketId, side, priceSats, shares, timestampOffset.toString());
  
  return { orderId, cost, newBalance };
}

module.exports = {
  SHARE_VALUE_SATS,
  createTestDatabase,
  createTestUser,
  createTestGrandmaster,
  createTestMarket,
  getUserBalance,
  getOrder,
  getMarketOrders,
  getMarketBets,
  getUserPositions,
  impliedPercent,
  placeOrder,
  cancelOrder,
  createOrderWithTimestamp,
};
