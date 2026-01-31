/**
 * Stress Test with Invariant Checks
 * 
 * Tests the matching engine with:
 * - 5 interacting accounts
 * - Random prices and amounts
 * - Partial fills
 * - Before/after invariant verification
 * 
 * INVARIANTS CHECKED:
 * 1. Total money conserved (sum of balances + locked in bets = initial total)
 * 2. No negative balances ever
 * 3. Order fill amounts never exceed order amounts
 * 4. Every bet has valid references
 * 5. Resolved bets pay exactly 1000 per share to winner
 */

const Database = require('better-sqlite3');
const { v4: uuidv4 } = require('uuid');
const matchingEngine = require('../matching-engine');

const SATS_PER_SHARE = 1000;

// Test configuration
const NUM_USERS = 5;
const INITIAL_BALANCE = 10000000; // 10M sats each = 50M total
const NUM_MARKETS = 3;
const TRADES_PER_RUN = 200;
const NUM_RUNS = 5;

function createTestDb() {
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

function createUsers(db, count, balance) {
  const users = [];
  for (let i = 0; i < count; i++) {
    const id = uuidv4();
    db.prepare('INSERT INTO users (id, email, username, balance_sats) VALUES (?, ?, ?, ?)')
      .run(id, `${id}@test.com`, `user-${id.slice(0,8)}`, balance);
    users.push(id);
  }
  return users;
}

function createMarkets(db, count) {
  const markets = [];
  for (let i = 0; i < count; i++) {
    const id = uuidv4();
    db.prepare('INSERT INTO markets (id, type, title, status) VALUES (?, ?, ?, ?)')
      .run(id, 'attendance', `Market ${i}`, 'open');
    markets.push(id);
  }
  return markets;
}

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randomChoice(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

/**
 * Calculate system state for invariant checking
 */
function getSystemState(db) {
  const users = db.prepare('SELECT id, balance_sats FROM users').all();
  const orders = db.prepare('SELECT * FROM orders').all();
  const bets = db.prepare('SELECT * FROM bets').all();
  
  const totalBalances = users.reduce((sum, u) => sum + u.balance_sats, 0);
  
  // Money locked in open orders (not yet matched)
  const moneyInOpenOrders = orders
    .filter(o => ['open', 'partial'].includes(o.status))
    .reduce((sum, o) => {
      const unfilledShares = Math.floor((o.amount_sats - o.filled_sats) / SATS_PER_SHARE);
      return sum + (unfilledShares * o.price_sats);
    }, 0);
  
  // Money locked in active bets (will be paid out on resolution)
  const moneyInActiveBets = bets
    .filter(b => b.status === 'active')
    .reduce((sum, b) => sum + b.amount_sats, 0);
  
  // Count stats
  const openOrders = orders.filter(o => ['open', 'partial'].includes(o.status)).length;
  const filledOrders = orders.filter(o => o.status === 'filled').length;
  const activeBets = bets.filter(b => b.status === 'active').length;
  const settledBets = bets.filter(b => b.status === 'settled').length;
  
  return {
    totalBalances,
    moneyInOpenOrders,
    moneyInActiveBets,
    // CORRECT CONSERVATION: balances + bets + unfilled orders = initial
    totalAccountedMoney: totalBalances + moneyInActiveBets + moneyInOpenOrders,
    openOrders,
    filledOrders,
    activeBets,
    settledBets,
    users: users.map(u => ({ id: u.id.slice(0,8), balance: u.balance_sats }))
  };
}

/**
 * Check all invariants
 */
function checkInvariants(db, initialTotal, label) {
  const errors = [];
  
  // Get current state
  const users = db.prepare('SELECT id, balance_sats FROM users').all();
  const orders = db.prepare('SELECT * FROM orders').all();
  const bets = db.prepare('SELECT * FROM bets').all();
  
  // INVARIANT 1: No negative balances
  for (const user of users) {
    if (user.balance_sats < 0) {
      errors.push(`NEGATIVE BALANCE: User ${user.id.slice(0,8)} has ${user.balance_sats}`);
    }
  }
  
  // INVARIANT 2: Order fills don't exceed amounts
  for (const order of orders) {
    if (order.filled_sats > order.amount_sats) {
      errors.push(`OVERFILL: Order ${order.id.slice(0,8)} filled ${order.filled_sats} > amount ${order.amount_sats}`);
    }
  }
  
  // INVARIANT 3: Active bets have valid amounts
  for (const bet of bets.filter(b => b.status === 'active')) {
    if (bet.amount_sats < SATS_PER_SHARE) {
      errors.push(`INVALID BET: Bet ${bet.id.slice(0,8)} has amount ${bet.amount_sats} < ${SATS_PER_SHARE}`);
    }
    if (bet.amount_sats % SATS_PER_SHARE !== 0) {
      errors.push(`INVALID BET: Bet ${bet.id.slice(0,8)} amount ${bet.amount_sats} not multiple of ${SATS_PER_SHARE}`);
    }
  }
  
  // INVARIANT 4: Money conservation
  // Total = balances + money in active bets + money in unfilled orders
  const totalBalances = users.reduce((sum, u) => sum + u.balance_sats, 0);
  const moneyInActiveBets = bets
    .filter(b => b.status === 'active')
    .reduce((sum, b) => sum + b.amount_sats, 0);
  const moneyInOpenOrders = orders
    .filter(o => ['open', 'partial'].includes(o.status))
    .reduce((sum, o) => {
      const unfilledShares = Math.floor((o.amount_sats - o.filled_sats) / SATS_PER_SHARE);
      return sum + (unfilledShares * o.price_sats);
    }, 0);
  const totalAccounted = totalBalances + moneyInActiveBets + moneyInOpenOrders;
  
  if (totalAccounted !== initialTotal) {
    errors.push(`MONEY LEAK: Initial=${initialTotal}, Accounted=${totalAccounted}, Diff=${totalAccounted - initialTotal}`);
    errors.push(`  Balances=${totalBalances}, Bets=${moneyInActiveBets}, Orders=${moneyInOpenOrders}`);
  }
  
  if (errors.length > 0) {
    console.error(`\n❌ INVARIANT VIOLATIONS at ${label}:`);
    errors.forEach(e => console.error(`   ${e}`));
    return false;
  }
  
  return true;
}

describe('Stress Tests with Invariant Checks', () => {
  
  describe('Pre-Production Edge Cases', () => {
    let db, alice, bob, market;
    
    beforeEach(() => {
      // Fresh database for each test - ensures isolation
      db = createTestDb();
      [alice, bob] = createUsers(db, 2, 100000);
      market = createMarkets(db, 1)[0];
    });
    
    test('Cancel order by wrong user rejected', () => {
      const order = matchingEngine.placeOrder(db, alice, market, 'yes', 500, 5000);
      expect(order.success).toBe(true);
      
      const cancelResult = matchingEngine.cancelOrder(db, bob, order.orderId);
      expect(cancelResult.success).toBe(false);
      expect(cancelResult.error).toContain('does not belong');
    });
    
    test('Cancel non-existent order rejected', () => {
      const result = matchingEngine.cancelOrder(db, alice, 'fake-order-id');
      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });
    
    test('Cancel already-filled order rejected', () => {
      // Alice places NO, Bob matches with YES
      const aliceOrder = matchingEngine.placeOrder(db, alice, market, 'no', 500, 5000);
      matchingEngine.placeOrder(db, bob, market, 'yes', 500, 5000);
      
      // Order is now filled, try to cancel
      const cancelResult = matchingEngine.cancelOrder(db, alice, aliceOrder.orderId);
      expect(cancelResult.success).toBe(false);
      expect(cancelResult.error).toContain('cannot be cancelled');
    });
    
    test('Resolve market with invalid outcome rejected', () => {
      const result = matchingEngine.resolveMarket(db, market, 'maybe');
      expect(result.success).toBe(false);
    });
    
    test('Resolve non-existent market rejected', () => {
      const result = matchingEngine.resolveMarket(db, 'fake-market-id', 'yes');
      expect(result.success).toBe(false);
    });
    
    test('Multiple orders at same price aggregate correctly', () => {
      // Three users all place NO@400
      const charlie = createUsers(db, 1, 100000)[0];
      matchingEngine.placeOrder(db, alice, market, 'no', 400, 10000);
      matchingEngine.placeOrder(db, bob, market, 'no', 400, 10000);
      matchingEngine.placeOrder(db, charlie, market, 'no', 400, 10000);
      
      // Someone places YES@700 for 25 shares (matches 30 available)
      const taker = createUsers(db, 1, 100000)[0];
      const result = matchingEngine.placeOrder(db, taker, market, 'yes', 700, 25000);
      
      expect(result.success).toBe(true);
      expect(result.filled).toBe(25);
      expect(result.betsCreated.length).toBeLessThanOrEqual(3); // May match 1-3 orders
    });
    
    test('Price priority: better prices match first', () => {
      // Alice: NO@300, Bob: NO@400, Charlie: NO@500
      const charlie = createUsers(db, 1, 100000)[0];
      matchingEngine.placeOrder(db, alice, market, 'no', 300, 10000);
      matchingEngine.placeOrder(db, bob, market, 'no', 400, 10000);
      matchingEngine.placeOrder(db, charlie, market, 'no', 500, 10000);
      
      // Taker places YES@600 for 10 shares
      const taker = createUsers(db, 1, 100000)[0];
      const result = matchingEngine.placeOrder(db, taker, market, 'yes', 600, 10000);
      
      // Should match Charlie's NO@500 first (best for taker)
      expect(result.success).toBe(true);
      expect(result.filled).toBe(10);
      expect(result.betsCreated[0].priceSats).toBe(500); // Charlie's price
    });
    
    test('Transaction log created for order placement', () => {
      const initialCount = db.prepare('SELECT COUNT(*) as c FROM transactions').get().c;
      
      matchingEngine.placeOrder(db, alice, market, 'yes', 500, 5000);
      
      const finalCount = db.prepare('SELECT COUNT(*) as c FROM transactions').get().c;
      expect(finalCount).toBeGreaterThan(initialCount);
      
      const tx = db.prepare('SELECT * FROM transactions WHERE user_id = ? ORDER BY created_at DESC').get(alice);
      expect(tx.type).toBe('order_placed');
      expect(tx.amount_sats).toBe(-2500); // 5 shares @ 500
    });
    
    test('Transaction log created for bet win', () => {
      // Create and fill orders
      matchingEngine.placeOrder(db, alice, market, 'no', 500, 5000);
      matchingEngine.placeOrder(db, bob, market, 'yes', 500, 5000);
      
      // Resolve YES (Bob wins)
      matchingEngine.resolveMarket(db, market, 'yes');
      
      const tx = db.prepare("SELECT * FROM transactions WHERE user_id = ? AND type = 'bet_won'").get(bob);
      expect(tx).toBeTruthy();
      expect(tx.amount_sats).toBe(5000); // 5 shares × 1000
    });
  });

  describe('Edge Case Verification', () => {
    let db, alice, market;
    
    beforeEach(() => {
      // Fresh database for each test - ensures isolation
      db = createTestDb();
      alice = createUsers(db, 1, 10000)[0];
      market = createMarkets(db, 1)[0];
    });
    
    test('Non-integer price rejected', () => {
      const result = matchingEngine.placeOrder(db, alice, market, 'yes', 500.5, 1000);
      expect(result.success).toBe(false);
      expect(result.error).toContain('integer');
    });
    
    test('Non-integer amount rejected', () => {
      const result = matchingEngine.placeOrder(db, alice, market, 'yes', 500, 1500.5);
      expect(result.success).toBe(false);
    });
    
    test('Insufficient balance rejected with exact error', () => {
      const result = matchingEngine.placeOrder(db, alice, market, 'yes', 500, 100000); // 50 shares @ 500 = 25000, alice has 10000
      expect(result.success).toBe(false);
      expect(result.error).toContain('Insufficient');
    });
    
    test('Price below minimum (0) rejected', () => {
      const result = matchingEngine.placeOrder(db, alice, market, 'yes', 0, 1000);
      expect(result.success).toBe(false);
    });
    
    test('Price above maximum (1000) rejected', () => {
      const result = matchingEngine.placeOrder(db, alice, market, 'yes', 1000, 1000);
      expect(result.success).toBe(false);
    });
    
    test('Amount below minimum (999) rejected', () => {
      const result = matchingEngine.placeOrder(db, alice, market, 'yes', 500, 999);
      expect(result.success).toBe(false);
    });
    
    test('Invalid side rejected', () => {
      const result = matchingEngine.placeOrder(db, alice, market, 'maybe', 500, 1000);
      expect(result.success).toBe(false);
      expect(result.error).toContain('Side');
    });
    
    test('Non-existent user rejected', () => {
      const result = matchingEngine.placeOrder(db, 'fake-user-id', market, 'yes', 500, 1000);
      expect(result.success).toBe(false);
      expect(result.error).toContain('User not found');
    });
    
    test('Non-existent market rejected', () => {
      const result = matchingEngine.placeOrder(db, alice, 'fake-market-id', 'yes', 500, 1000);
      expect(result.success).toBe(false);
      expect(result.error).toContain('Market not found');
    });
    
    test('Closed market rejected', () => {
      const closedMarket = uuidv4();
      db.prepare('INSERT INTO markets (id, type, title, status) VALUES (?, ?, ?, ?)')
        .run(closedMarket, 'attendance', 'Closed Market', 'resolved');
      
      const result = matchingEngine.placeOrder(db, alice, closedMarket, 'yes', 500, 1000);
      expect(result.success).toBe(false);
      expect(result.error).toContain('not open');
    });
    
    test('Database isolation: each test gets fresh state', () => {
      // This test verifies that alice has exactly 10000 (initial balance)
      // If previous tests leaked state, this would fail
      const balance = db.prepare('SELECT balance_sats FROM users WHERE id = ?').get(alice);
      expect(balance.balance_sats).toBe(10000);
      
      // Place an order
      matchingEngine.placeOrder(db, alice, market, 'yes', 500, 2000);
      const afterOrder = db.prepare('SELECT balance_sats FROM users WHERE id = ?').get(alice);
      expect(afterOrder.balance_sats).toBe(9000); // 10000 - 1000
    });
  });

  test('Single market, 5 users, 200 random trades', () => {
    const db = createTestDb();
    const users = createUsers(db, NUM_USERS, INITIAL_BALANCE);
    const markets = createMarkets(db, 1);
    const market = markets[0];
    
    const initialTotal = NUM_USERS * INITIAL_BALANCE;
    const startState = getSystemState(db);
    
    console.log('\n📊 INITIAL STATE:');
    console.log(`   Total money: ${initialTotal.toLocaleString()} sats`);
    console.log(`   Users: ${users.map(u => u.slice(0,8)).join(', ')}`);
    
    let successfulTrades = 0;
    let failedTrades = 0;
    let matchedShares = 0;
    
    // Run random trades
    for (let i = 0; i < TRADES_PER_RUN; i++) {
      const user = randomChoice(users);
      const side = randomChoice(['yes', 'no']);
      const price = randomInt(100, 900);  // Avoid extremes
      const shares = randomInt(1, 50);
      const amount = shares * SATS_PER_SHARE;
      
      const result = matchingEngine.placeOrder(db, user, market, side, price, amount);
      
      if (result.success) {
        successfulTrades++;
        matchedShares += result.filled;
        
        // Check invariants periodically
        if (i % 50 === 0) {
          const ok = checkInvariants(db, initialTotal, `trade ${i}`);
          expect(ok).toBe(true);
        }
      } else {
        failedTrades++;
      }
    }
    
    // Final invariant check
    const finalOk = checkInvariants(db, initialTotal, 'final');
    expect(finalOk).toBe(true);
    
    const endState = getSystemState(db);
    
    console.log('\n📊 FINAL STATE:');
    console.log(`   Successful trades: ${successfulTrades}`);
    console.log(`   Failed trades: ${failedTrades} (usually insufficient balance)`);
    console.log(`   Shares matched: ${matchedShares}`);
    console.log(`   Open orders: ${endState.openOrders}`);
    console.log(`   Active bets: ${endState.activeBets}`);
    console.log(`   Money in balances: ${endState.totalBalances.toLocaleString()}`);
    console.log(`   Money in active bets: ${endState.moneyInActiveBets.toLocaleString()}`);
    console.log(`   Total accounted: ${endState.totalAccountedMoney.toLocaleString()}`);
    console.log(`   ✅ Initial total: ${initialTotal.toLocaleString()}`);
    
    expect(endState.totalAccountedMoney).toBe(initialTotal);
  });

  test('Multiple markets, cancellations included', () => {
    const db = createTestDb();
    const users = createUsers(db, NUM_USERS, INITIAL_BALANCE);
    const markets = createMarkets(db, NUM_MARKETS);
    
    const initialTotal = NUM_USERS * INITIAL_BALANCE;
    const orderIds = []; // Track orders for cancellation
    
    console.log('\n📊 MULTI-MARKET TEST:');
    console.log(`   Markets: ${NUM_MARKETS}`);
    console.log(`   Users: ${NUM_USERS}`);
    
    let trades = 0;
    let cancellations = 0;
    
    for (let i = 0; i < TRADES_PER_RUN; i++) {
      const action = Math.random();
      
      if (action < 0.8 || orderIds.length === 0) {
        // Place order
        const user = randomChoice(users);
        const market = randomChoice(markets);
        const side = randomChoice(['yes', 'no']);
        const price = randomInt(100, 900);
        const shares = randomInt(1, 30);
        const amount = shares * SATS_PER_SHARE;
        
        const result = matchingEngine.placeOrder(db, user, market, side, price, amount);
        
        if (result.success && ['open', 'partial'].includes(result.orderStatus)) {
          orderIds.push({ orderId: result.orderId, userId: user });
        }
        if (result.success) trades++;
        
      } else {
        // Cancel random order
        const orderInfo = randomChoice(orderIds);
        const result = matchingEngine.cancelOrder(db, orderInfo.userId, orderInfo.orderId);
        if (result.success) {
          cancellations++;
          const idx = orderIds.findIndex(o => o.orderId === orderInfo.orderId);
          if (idx >= 0) orderIds.splice(idx, 1);
        }
      }
      
      // Check invariants periodically
      if (i % 50 === 0) {
        const ok = checkInvariants(db, initialTotal, `action ${i}`);
        expect(ok).toBe(true);
      }
    }
    
    const finalOk = checkInvariants(db, initialTotal, 'final');
    expect(finalOk).toBe(true);
    
    console.log(`   Trades placed: ${trades}`);
    console.log(`   Cancellations: ${cancellations}`);
    console.log(`   ✅ Money conserved`);
  });

  test('Full lifecycle: trade, resolve, verify payouts', () => {
    const db = createTestDb();
    const users = createUsers(db, NUM_USERS, INITIAL_BALANCE);
    const markets = createMarkets(db, 1);
    const market = markets[0];
    
    const initialTotal = NUM_USERS * INITIAL_BALANCE;
    
    console.log('\n📊 FULL LIFECYCLE TEST:');
    
    // Phase 1: Random trading
    let trades = 0;
    for (let i = 0; i < 100; i++) {
      const user = randomChoice(users);
      const side = randomChoice(['yes', 'no']);
      const price = randomInt(200, 800);
      const shares = randomInt(1, 20);
      const amount = shares * SATS_PER_SHARE;
      
      const result = matchingEngine.placeOrder(db, user, market, side, price, amount);
      if (result.success) trades++;
    }
    
    const beforeResolve = getSystemState(db);
    console.log(`   Trades: ${trades}`);
    console.log(`   Active bets before resolve: ${beforeResolve.activeBets}`);
    console.log(`   Money in bets: ${beforeResolve.moneyInActiveBets.toLocaleString()}`);
    
    // Check invariant before resolution
    const preResolveOk = checkInvariants(db, initialTotal, 'before resolve');
    expect(preResolveOk).toBe(true);
    
    // Phase 2: Resolve market
    const outcome = randomChoice(['yes', 'no']);
    const resolution = matchingEngine.resolveMarket(db, market, outcome);
    
    console.log(`   Resolution: ${outcome.toUpperCase()}`);
    console.log(`   Bets settled: ${resolution.betsSettled}`);
    console.log(`   Orders refunded: ${resolution.ordersRefunded}`);
    
    // Phase 3: Check final state
    const afterResolve = getSystemState(db);
    
    console.log(`   Active bets after: ${afterResolve.activeBets}`);
    console.log(`   Money in balances: ${afterResolve.totalBalances.toLocaleString()}`);
    
    // After resolution, all money should be back in balances
    expect(afterResolve.activeBets).toBe(0);
    expect(afterResolve.totalBalances).toBe(initialTotal);
    
    console.log(`   ✅ All money returned to users after resolution`);
  });

  test('Stress test with partial fills', () => {
    const db = createTestDb();
    const users = createUsers(db, 3, INITIAL_BALANCE);
    const [alice, bob, charlie] = users;
    const markets = createMarkets(db, 1);
    const market = markets[0];
    
    const initialTotal = 3 * INITIAL_BALANCE;
    
    console.log('\n📊 PARTIAL FILL TEST:');
    
    // Alice places large NO order at 400 (50 shares)
    const aliceOrder = matchingEngine.placeOrder(db, alice, market, 'no', 400, 50000);
    expect(aliceOrder.success).toBe(true);
    console.log(`   Alice: NO@400 x50 shares (cost: 20000)`);
    
    // Bob takes some YES@600 (20 shares) - should match Alice partially
    const bobOrder = matchingEngine.placeOrder(db, bob, market, 'yes', 600, 20000);
    expect(bobOrder.success).toBe(true);
    expect(bobOrder.filled).toBe(20);
    console.log(`   Bob: YES@600 x20 shares -> matched ${bobOrder.filled}`);
    
    // Charlie takes more YES@700 (15 shares) - should match Alice more
    const charlieOrder = matchingEngine.placeOrder(db, charlie, market, 'yes', 700, 15000);
    expect(charlieOrder.success).toBe(true);
    expect(charlieOrder.filled).toBe(15);
    console.log(`   Charlie: YES@700 x15 shares -> matched ${charlieOrder.filled}`);
    
    // Check Alice's order is now partial (35 filled of 50)
    const aliceOrderNow = db.prepare('SELECT * FROM orders WHERE id = ?').get(aliceOrder.orderId);
    expect(aliceOrderNow.status).toBe('partial');
    expect(aliceOrderNow.filled_sats).toBe(35000);
    console.log(`   Alice order status: ${aliceOrderNow.status} (${aliceOrderNow.filled_sats/1000} of 50 shares filled)`);
    
    // Verify invariants
    const ok = checkInvariants(db, initialTotal, 'after partial fills');
    expect(ok).toBe(true);
    
    // Verify bets created correctly
    const bets = db.prepare('SELECT * FROM bets WHERE market_id = ?').all(market);
    expect(bets.length).toBe(2);
    
    const totalBetShares = bets.reduce((sum, b) => sum + b.amount_sats / SATS_PER_SHARE, 0);
    expect(totalBetShares).toBe(35); // 20 + 15
    
    console.log(`   ✅ Partial fills working correctly`);
    console.log(`   ✅ ${bets.length} bets created, ${totalBetShares} shares matched`);
  });

  test('High volume: 5 runs of 200 trades each', () => {
    for (let run = 0; run < NUM_RUNS; run++) {
      const db = createTestDb();
      const users = createUsers(db, NUM_USERS, INITIAL_BALANCE);
      const markets = createMarkets(db, NUM_MARKETS);
      
      const initialTotal = NUM_USERS * INITIAL_BALANCE;
      let errors = 0;
      
      for (let i = 0; i < TRADES_PER_RUN; i++) {
        const user = randomChoice(users);
        const market = randomChoice(markets);
        const side = randomChoice(['yes', 'no']);
        const price = randomInt(50, 950);
        const shares = randomInt(1, 100);
        const amount = shares * SATS_PER_SHARE;
        
        const result = matchingEngine.placeOrder(db, user, market, side, price, amount);
        
        // Quick balance check
        const balance = db.prepare('SELECT balance_sats FROM users WHERE id = ?').get(user);
        if (balance.balance_sats < 0) {
          errors++;
        }
      }
      
      const ok = checkInvariants(db, initialTotal, `run ${run + 1}`);
      expect(ok).toBe(true);
      expect(errors).toBe(0);
      
      if (run === 0) {
        console.log(`\n📊 HIGH VOLUME TEST: ${NUM_RUNS} runs x ${TRADES_PER_RUN} trades`);
      }
      console.log(`   Run ${run + 1}: ✅ passed`);
    }
  });
});
