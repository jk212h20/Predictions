/**
 * Direct tests for matching-engine.js
 * 
 * Uses the PRODUCTION schema (amount_sats, filled_sats)
 * Tests the ACTUAL matching engine code
 */

const Database = require('better-sqlite3');
const { v4: uuidv4 } = require('uuid');
const matchingEngine = require('../matching-engine');

const SATS_PER_SHARE = 1000;

/**
 * Create test database with PRODUCTION schema
 */
function createProductionTestDb() {
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

    CREATE TABLE markets (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL CHECK(type IN ('attendance', 'winner', 'event')),
      grandmaster_id TEXT,
      title TEXT NOT NULL,
      description TEXT,
      status TEXT DEFAULT 'open' CHECK(status IN ('open', 'pending_resolution', 'resolved', 'cancelled')),
      resolution TEXT CHECK(resolution IN ('yes', 'no', NULL)),
      created_at TEXT DEFAULT (datetime('now'))
    );

    -- PRODUCTION SCHEMA: amount_sats = payout value (shares × 1000)
    CREATE TABLE orders (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      market_id TEXT NOT NULL,
      side TEXT NOT NULL CHECK(side IN ('yes', 'no')),
      price_sats INTEGER NOT NULL CHECK(price_sats >= 1 AND price_sats <= 999),
      amount_sats INTEGER NOT NULL,
      filled_sats INTEGER DEFAULT 0,
      status TEXT DEFAULT 'open' CHECK(status IN ('open', 'partial', 'filled', 'cancelled')),
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
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
      price_sats INTEGER NOT NULL,
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
    CREATE INDEX idx_orders_user ON orders(user_id, status);
    CREATE INDEX idx_bets_market ON bets(market_id, status);
  `);
  
  return db;
}

function createUser(db, balance = 100000) {
  const id = uuidv4();
  db.prepare('INSERT INTO users (id, email, username, balance_sats) VALUES (?, ?, ?, ?)')
    .run(id, `${id}@test.com`, `user-${id.slice(0,8)}`, balance);
  return id;
}

function createMarket(db, status = 'open') {
  const id = uuidv4();
  db.prepare('INSERT INTO markets (id, type, title, status) VALUES (?, ?, ?, ?)')
    .run(id, 'attendance', 'Test Market', status);
  return id;
}

function getBalance(db, userId) {
  return db.prepare('SELECT balance_sats FROM users WHERE id = ?').get(userId).balance_sats;
}

function getOrders(db, marketId) {
  return db.prepare('SELECT * FROM orders WHERE market_id = ?').all(marketId);
}

function getBets(db, marketId) {
  return db.prepare('SELECT * FROM bets WHERE market_id = ?').all(marketId);
}

describe('Matching Engine - Direct Tests', () => {
  let db, market, alice, bob;

  beforeEach(() => {
    db = createProductionTestDb();
    market = createMarket(db);
    alice = createUser(db, 100000);
    bob = createUser(db, 100000);
  });

  describe('Basic Matching', () => {
    test('YES@500 + NO@500 matches (sum = 1000)', () => {
      // Bob places NO@500 for 10 shares (pays 500 * 10 = 5000)
      const bobResult = matchingEngine.placeOrder(db, bob, market, 'no', 500, 10000);
      expect(bobResult.success).toBe(true);
      expect(bobResult.orderStatus).toBe('open');
      expect(getBalance(db, bob)).toBe(100000 - 5000);

      // Alice places YES@500 for 10 shares (pays 500 * 10 = 5000)
      const aliceResult = matchingEngine.placeOrder(db, alice, market, 'yes', 500, 10000);
      expect(aliceResult.success).toBe(true);
      expect(aliceResult.orderStatus).toBe('filled');
      expect(aliceResult.filled).toBe(10);
      expect(getBalance(db, alice)).toBe(100000 - 5000);

      // Should have created a bet
      const bets = getBets(db, market);
      expect(bets.length).toBe(1);
      expect(bets[0].amount_sats).toBe(10000);
      expect(bets[0].price_sats).toBe(500); // Resting order's price
    });

    test('YES@600 + NO@400 matches (sum = 1000)', () => {
      // Bob places NO@400 for 5 shares (pays 400 * 5 = 2000)
      matchingEngine.placeOrder(db, bob, market, 'no', 400, 5000);

      // Alice places YES@600 for 5 shares (pays 600 * 5 = 3000)
      const aliceResult = matchingEngine.placeOrder(db, alice, market, 'yes', 600, 5000);
      expect(aliceResult.success).toBe(true);
      expect(aliceResult.filled).toBe(5);
      
      // Alice should get price improvement (pays 1000-400=600, not her limit of 600)
      // Wait, her limit IS 600, so no improvement. She pays 600*5=3000
      expect(getBalance(db, alice)).toBe(100000 - 3000);
    });

    test('YES@700 + NO@400 matches with price improvement', () => {
      // Bob places NO@400 (pays 400 per share)
      matchingEngine.placeOrder(db, bob, market, 'no', 400, 5000);

      // Alice places YES@700 (willing to pay up to 700)
      // Trade happens at resting price (400), so Alice pays 1000-400=600
      const aliceResult = matchingEngine.placeOrder(db, alice, market, 'yes', 700, 5000);
      expect(aliceResult.success).toBe(true);
      expect(aliceResult.filled).toBe(5);
      
      // Alice pays 600 * 5 = 3000 (not 700 * 5 = 3500)
      expect(getBalance(db, alice)).toBe(100000 - 3000);
    });

    test('YES@400 + NO@400 does NOT match (sum = 800 < 1000)', () => {
      // Bob places NO@400
      matchingEngine.placeOrder(db, bob, market, 'no', 400, 5000);

      // Alice places YES@400 - should NOT match
      const aliceResult = matchingEngine.placeOrder(db, alice, market, 'yes', 400, 5000);
      expect(aliceResult.success).toBe(true);
      expect(aliceResult.orderStatus).toBe('open');
      expect(aliceResult.filled).toBe(0);

      // No bets created
      const bets = getBets(db, market);
      expect(bets.length).toBe(0);
    });
  });

  describe('Money Conservation', () => {
    test('Total money is conserved after match', () => {
      const aliceStart = getBalance(db, alice);
      const bobStart = getBalance(db, bob);
      const totalStart = aliceStart + bobStart;

      // Bob: NO@400 for 10 shares
      matchingEngine.placeOrder(db, bob, market, 'no', 400, 10000);
      // Alice: YES@600 for 10 shares
      matchingEngine.placeOrder(db, alice, market, 'yes', 600, 10000);

      const aliceEnd = getBalance(db, alice);
      const bobEnd = getBalance(db, bob);
      const totalEnd = aliceEnd + bobEnd;

      // Total money should be conserved (minus what's locked in bets)
      const bets = getBets(db, market);
      const lockedInBets = bets.reduce((sum, b) => sum + b.amount_sats, 0);
      expect(totalStart).toBe(totalEnd + lockedInBets);
    });

    test('Cancel returns exact amount', () => {
      const start = getBalance(db, alice);
      
      // Place order: YES@600 for 5 shares costs 600*5=3000
      const result = matchingEngine.placeOrder(db, alice, market, 'yes', 600, 5000);
      expect(getBalance(db, alice)).toBe(start - 3000);
      
      // Cancel should return exactly 3000
      const cancelResult = matchingEngine.cancelOrder(db, alice, result.orderId);
      expect(cancelResult.success).toBe(true);
      expect(cancelResult.refund).toBe(3000);
      expect(getBalance(db, alice)).toBe(start);
    });
  });

  describe('Self-Matching and Auto-Settle', () => {
    test('Same user can match their own orders (auto-settle)', () => {
      const start = getBalance(db, alice);
      
      // Alice places YES@500 for 10 shares (pays 5000)
      matchingEngine.placeOrder(db, alice, market, 'yes', 500, 10000);
      expect(getBalance(db, alice)).toBe(start - 5000);
      
      // Alice places NO@500 for 10 shares (pays 5000)
      // This should match her own YES order and auto-settle
      const result = matchingEngine.placeOrder(db, alice, market, 'no', 500, 10000);
      expect(result.success).toBe(true);
      expect(result.filled).toBe(10);
      
      // After auto-settle, Alice gets back 1000*10=10000
      // Net: paid 5000 + 5000, got back 10000 = break even
      expect(getBalance(db, alice)).toBe(start);
      
      // Bet should be settled
      const bets = getBets(db, market);
      expect(bets.length).toBe(1);
      expect(bets[0].status).toBe('settled');
    });
  });

  describe('Edge Cases', () => {
    test('Minimum price (1 sat) works', () => {
      // YES@1 for 1 share costs 1 sat
      const result = matchingEngine.placeOrder(db, alice, market, 'yes', 1, 1000);
      expect(result.success).toBe(true);
      expect(result.cost).toBe(1);
    });

    test('Maximum price (999 sats) works', () => {
      // YES@999 for 1 share costs 999 sats
      const result = matchingEngine.placeOrder(db, alice, market, 'yes', 999, 1000);
      expect(result.success).toBe(true);
      expect(result.cost).toBe(999);
    });

    test('Invalid price (0) rejected', () => {
      const result = matchingEngine.placeOrder(db, alice, market, 'yes', 0, 1000);
      expect(result.success).toBe(false);
    });

    test('Invalid price (1000) rejected', () => {
      const result = matchingEngine.placeOrder(db, alice, market, 'yes', 1000, 1000);
      expect(result.success).toBe(false);
    });

    test('Insufficient balance rejected', () => {
      const poorUser = createUser(db, 100);
      const result = matchingEngine.placeOrder(db, poorUser, market, 'yes', 500, 1000);
      expect(result.success).toBe(false);
      expect(result.error).toContain('Insufficient');
    });

    test('Closed market rejected', () => {
      const closedMarket = createMarket(db, 'resolved');
      const result = matchingEngine.placeOrder(db, alice, closedMarket, 'yes', 500, 1000);
      expect(result.success).toBe(false);
    });
  });

  describe('Resolution', () => {
    test('Winner gets 1000 sats per share', () => {
      // Bob: NO@400 for 10 shares
      matchingEngine.placeOrder(db, bob, market, 'no', 400, 10000);
      // Alice: YES@600 for 10 shares
      matchingEngine.placeOrder(db, alice, market, 'yes', 600, 10000);

      const aliceAfterTrade = getBalance(db, alice);
      const bobAfterTrade = getBalance(db, bob);

      // Resolve YES
      const resolution = matchingEngine.resolveMarket(db, market, 'yes');
      expect(resolution.success).toBe(true);
      expect(resolution.betsSettled).toBe(1);

      // Alice wins 10000 sats (10 shares * 1000)
      expect(getBalance(db, alice)).toBe(aliceAfterTrade + 10000);
      // Bob gets nothing more
      expect(getBalance(db, bob)).toBe(bobAfterTrade);
    });

    test('Open orders refunded on resolution', () => {
      // Alice places order that doesn't match
      const aliceStart = getBalance(db, alice);
      matchingEngine.placeOrder(db, alice, market, 'yes', 300, 5000);
      expect(getBalance(db, alice)).toBe(aliceStart - 1500);

      // Resolve market - should refund Alice's open order
      matchingEngine.resolveMarket(db, market, 'yes');
      expect(getBalance(db, alice)).toBe(aliceStart);
    });
  });
});
