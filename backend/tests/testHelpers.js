/**
 * Test Helpers for Order Matching Tests
 * 
 * Provides an in-memory SQLite database and utility functions
 * for testing the order matching logic in isolation.
 */

const Database = require('better-sqlite3');
const { v4: uuidv4 } = require('uuid');

/**
 * Creates an in-memory SQLite database with the full schema
 */
function createTestDatabase() {
  const db = new Database(':memory:');
  
  // Initialize schema (same as production)
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

    CREATE TABLE orders (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      market_id TEXT NOT NULL,
      side TEXT NOT NULL CHECK(side IN ('yes', 'no')),
      price_cents INTEGER NOT NULL CHECK(price_cents >= 1 AND price_cents <= 99),
      amount_sats INTEGER NOT NULL,
      filled_sats INTEGER DEFAULT 0,
      status TEXT DEFAULT 'open' CHECK(status IN ('open', 'partial', 'filled', 'cancelled')),
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id),
      FOREIGN KEY (market_id) REFERENCES markets(id)
    );

    CREATE TABLE bets (
      id TEXT PRIMARY KEY,
      market_id TEXT NOT NULL,
      yes_user_id TEXT NOT NULL,
      no_user_id TEXT NOT NULL,
      yes_order_id TEXT NOT NULL,
      no_order_id TEXT NOT NULL,
      price_cents INTEGER NOT NULL,
      amount_sats INTEGER NOT NULL,
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
    CREATE INDEX idx_orders_price ON orders(market_id, side, price_cents, created_at);
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
 * Gets user's positions in a market
 */
function getUserPositions(db, userId, marketId) {
  const yesBets = db.prepare(`
    SELECT COALESCE(SUM(amount_sats), 0) as total
    FROM bets WHERE market_id = ? AND yes_user_id = ? AND status = 'active'
  `).get(marketId, userId).total;
  
  const noBets = db.prepare(`
    SELECT COALESCE(SUM(amount_sats), 0) as total
    FROM bets WHERE market_id = ? AND no_user_id = ? AND status = 'active'
  `).get(marketId, userId).total;
  
  return { yes: yesBets, no: noBets };
}

/**
 * Core order matching logic extracted from server.js
 * This is the function we're testing
 */
function placeOrder(db, userId, marketId, side, priceCents, amountSats, options = {}) {
  // Validation
  if (!['yes', 'no'].includes(side)) {
    return { error: 'Side must be yes or no' };
  }
  if (priceCents < 1 || priceCents > 99) {
    return { error: 'Probability must be between 1% and 99%' };
  }
  if (amountSats < 100) {
    return { error: 'Minimum order is 100 sats' };
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
  
  const cost = side === 'yes' 
    ? Math.ceil(amountSats * priceCents / 100)
    : Math.ceil(amountSats * (100 - priceCents) / 100);
  
  if (user.balance_sats < cost) {
    return { error: 'Insufficient balance', required: cost, available: user.balance_sats };
  }
  
  // Deduct balance
  const newBalance = user.balance_sats - cost;
  db.prepare('UPDATE users SET balance_sats = ? WHERE id = ?').run(newBalance, userId);
  
  // Try to match with existing orders
  const orderId = uuidv4();
  let remainingAmount = amountSats;
  const matchedBets = [];
  
  // Find matching orders on opposite side
  const oppositeSide = side === 'yes' ? 'no' : 'yes';
  const minComplementPrice = 100 - priceCents;
  
  // YES taker wants highest NO prices first (best for taker)
  // NO taker wants highest YES prices first (best for taker)
  const matchingOrders = db.prepare(`
    SELECT * FROM orders
    WHERE market_id = ? AND side = ? AND status IN ('open', 'partial')
    AND price_cents >= ?
    ORDER BY price_cents DESC, created_at ASC
  `).all(marketId, oppositeSide, minComplementPrice);
  
  for (const matchOrder of matchingOrders) {
    if (remainingAmount <= 0) break;
    
    // Skip self-trades
    if (matchOrder.user_id === userId) {
      continue;
    }
    
    const matchAvailable = matchOrder.amount_sats - matchOrder.filled_sats;
    const matchAmount = Math.min(remainingAmount, matchAvailable);
    const tradePrice = matchOrder.price_cents; // Price from resting order
    
    // Create bet
    const betId = uuidv4();
    const yesUserId = side === 'yes' ? userId : matchOrder.user_id;
    const noUserId = side === 'no' ? userId : matchOrder.user_id;
    const yesOrderId = side === 'yes' ? orderId : matchOrder.id;
    const noOrderId = side === 'no' ? orderId : matchOrder.id;
    
    db.prepare(`
      INSERT INTO bets (id, market_id, yes_user_id, no_user_id, yes_order_id, no_order_id, price_cents, amount_sats)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(betId, marketId, yesUserId, noUserId, yesOrderId, noOrderId, 100 - tradePrice, matchAmount);
    
    // Update matched order
    const newFilled = matchOrder.filled_sats + matchAmount;
    const newStatus = newFilled >= matchOrder.amount_sats ? 'filled' : 'partial';
    db.prepare('UPDATE orders SET filled_sats = ?, status = ? WHERE id = ?')
      .run(newFilled, newStatus, matchOrder.id);
    
    remainingAmount -= matchAmount;
    matchedBets.push({ 
      betId, 
      amount: matchAmount, 
      price: 100 - tradePrice,
      matchedOrderId: matchOrder.id,
      matchedUserId: matchOrder.user_id
    });
  }
  
  // Create order for remaining/full amount
  const orderStatus = remainingAmount === 0 ? 'filled' : 
                      remainingAmount < amountSats ? 'partial' : 'open';
  
  db.prepare(`
    INSERT INTO orders (id, user_id, market_id, side, price_cents, amount_sats, filled_sats, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(orderId, userId, marketId, side, priceCents, amountSats, amountSats - remainingAmount, orderStatus);
  
  // Record transaction
  db.prepare(`
    INSERT INTO transactions (id, user_id, type, amount_sats, balance_after, reference_id)
    VALUES (?, ?, 'order_placed', ?, ?, ?)
  `).run(uuidv4(), userId, -cost, newBalance, orderId);
  
  // AUTO-SETTLE: Check if user now has opposing positions
  let autoSettled = null;
  if (matchedBets.length > 0) {
    const yesShares = db.prepare(`
      SELECT COALESCE(SUM(amount_sats), 0) as total
      FROM bets WHERE market_id = ? AND yes_user_id = ? AND status = 'active'
    `).get(marketId, userId).total;
    
    const noShares = db.prepare(`
      SELECT COALESCE(SUM(amount_sats), 0) as total
      FROM bets WHERE market_id = ? AND no_user_id = ? AND status = 'active'
    `).get(marketId, userId).total;
    
    if (yesShares > 0 && noShares > 0) {
      const settleAmount = Math.min(yesShares, noShares);
      const settlePayout = settleAmount;
      
      // Mark bets as settled (oldest first)
      let remainingToSettle = settleAmount;
      
      const yesBets = db.prepare(`
        SELECT * FROM bets 
        WHERE market_id = ? AND yes_user_id = ? AND status = 'active'
        ORDER BY created_at ASC
      `).all(marketId, userId);
      
      for (const bet of yesBets) {
        if (remainingToSettle <= 0) break;
        if (bet.amount_sats <= remainingToSettle) {
          db.prepare(`UPDATE bets SET status = 'settled', settled_at = datetime('now'), winner_user_id = ? WHERE id = ?`)
            .run(userId, bet.id);
          remainingToSettle -= bet.amount_sats;
        }
      }
      
      remainingToSettle = settleAmount;
      const noBets = db.prepare(`
        SELECT * FROM bets 
        WHERE market_id = ? AND no_user_id = ? AND status = 'active'
        ORDER BY created_at ASC
      `).all(marketId, userId);
      
      for (const bet of noBets) {
        if (remainingToSettle <= 0) break;
        if (bet.amount_sats <= remainingToSettle) {
          db.prepare(`UPDATE bets SET status = 'settled', settled_at = datetime('now'), winner_user_id = ? WHERE id = ?`)
            .run(userId, bet.id);
          remainingToSettle -= bet.amount_sats;
        }
      }
      
      // Credit user the settled amount
      const currentUser = db.prepare('SELECT balance_sats FROM users WHERE id = ?').get(userId);
      const balanceAfterSettle = currentUser.balance_sats + settlePayout;
      db.prepare('UPDATE users SET balance_sats = ? WHERE id = ?').run(balanceAfterSettle, userId);
      
      db.prepare(`
        INSERT INTO transactions (id, user_id, type, amount_sats, balance_after, reference_id)
        VALUES (?, ?, 'bet_won', ?, ?, ?)
      `).run(uuidv4(), userId, settlePayout, balanceAfterSettle, 'auto-settle-' + marketId);
      
      autoSettled = {
        pairs_settled: settleAmount / 1000,
        payout: settlePayout,
        new_balance: balanceAfterSettle
      };
    }
  }
  
  return {
    order_id: orderId,
    status: orderStatus,
    filled: amountSats - remainingAmount,
    remaining: remainingAmount,
    cost,
    new_balance: autoSettled ? autoSettled.new_balance : newBalance,
    matched_bets: matchedBets,
    auto_settled: autoSettled
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
  
  const remaining = order.amount_sats - order.filled_sats;
  const refund = order.side === 'yes'
    ? Math.ceil(remaining * order.price_cents / 100)
    : Math.ceil(remaining * (100 - order.price_cents) / 100);
  
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
 * Creates a small delay in created_at timestamp
 */
function createOrderWithTimestamp(db, userId, marketId, side, priceCents, amountSats, timestampOffset = 0) {
  const orderId = uuidv4();
  const cost = side === 'yes' 
    ? Math.ceil(amountSats * priceCents / 100)
    : Math.ceil(amountSats * (100 - priceCents) / 100);
  
  const user = db.prepare('SELECT balance_sats FROM users WHERE id = ?').get(userId);
  if (user.balance_sats < cost) {
    return { error: 'Insufficient balance' };
  }
  
  const newBalance = user.balance_sats - cost;
  db.prepare('UPDATE users SET balance_sats = ? WHERE id = ?').run(newBalance, userId);
  
  // Insert with a custom timestamp offset (in seconds)
  db.prepare(`
    INSERT INTO orders (id, user_id, market_id, side, price_cents, amount_sats, filled_sats, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 0, 'open', datetime('now', ? || ' seconds'))
  `).run(orderId, userId, marketId, side, priceCents, amountSats, timestampOffset.toString());
  
  return { orderId, cost, newBalance };
}

module.exports = {
  createTestDatabase,
  createTestUser,
  createTestGrandmaster,
  createTestMarket,
  getUserBalance,
  getOrder,
  getMarketOrders,
  getMarketBets,
  getUserPositions,
  placeOrder,
  cancelOrder,
  createOrderWithTimestamp,
};
