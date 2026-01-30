/**
 * Integer-Based Trading System Tests
 * 
 * Validates the new system where:
 * - 1 share = 1000 sats payout to winner
 * - Price = sats per share (1-999)
 * - Matching: YES price + NO price >= 1000
 * - NO ROUNDING - all integer arithmetic
 * - Perfect money conservation
 */

const {
  SHARE_VALUE_SATS,
  createTestDatabase,
  createTestUser,
  createTestMarket,
  placeOrder,
  cancelOrder,
  getUserBalance,
  getMarketBets,
  getOrder,
  getMarketOrders,
  getUserPositions,
  impliedPercent,
} = require('./testHelpers');

describe('Integer System - Basic Matching', () => {
  let db;
  let market;
  let alice;
  let bob;

  beforeEach(() => {
    db = createTestDatabase();
    market = createTestMarket(db);
    alice = createTestUser(db, 10000000);
    bob = createTestUser(db, 10000000);
  });

  test('1 share = 1000 sats constant', () => {
    expect(SHARE_VALUE_SATS).toBe(1000);
  });

  test('YES@600 matches NO@400 (sum = 1000)', () => {
    // Bob posts NO @ 400 sats/share, 10 shares
    const noResult = placeOrder(db, bob.id, market.id, 'no', 400, 10);
    expect(noResult.status).toBe('open');
    expect(noResult.cost).toBe(4000); // 10 * 400
    
    // Alice takes YES @ 600 sats/share, 10 shares
    const yesResult = placeOrder(db, alice.id, market.id, 'yes', 600, 10);
    expect(yesResult.status).toBe('filled');
    expect(yesResult.filled_shares).toBe(10);
    expect(yesResult.cost).toBe(6000); // 10 * 600 (complement of 400)
    
    // Total locked should be exactly 10000 (10 shares * 1000 sats)
    const bets = getMarketBets(db, market.id);
    expect(bets.length).toBe(1);
    expect(bets[0].shares).toBe(10);
    expect(bets[0].trade_price_sats).toBe(600); // YES price
  });

  test('YES@700 matches NO@400, taker gets price improvement', () => {
    // Bob posts NO @ 400 sats/share, 5 shares
    placeOrder(db, bob.id, market.id, 'no', 400, 5);
    
    // Alice offers up to 700 sats/share but only pays 600 (1000-400)
    const aliceStart = getUserBalance(db, alice.id);
    const yesResult = placeOrder(db, alice.id, market.id, 'yes', 700, 5);
    
    expect(yesResult.filled_shares).toBe(5);
    expect(yesResult.cost).toBe(3000); // Actual cost: 5 * 600
    expect(yesResult.max_cost).toBe(3500); // Would pay up to: 5 * 700
    expect(yesResult.refund).toBe(500); // Price improvement: 3500 - 3000
  });

  test('YES@500 does NOT match NO@400 (sum = 900 < 1000)', () => {
    placeOrder(db, bob.id, market.id, 'no', 400, 5);
    const yesResult = placeOrder(db, alice.id, market.id, 'yes', 500, 5);
    
    expect(yesResult.status).toBe('open');
    expect(yesResult.filled_shares).toBe(0);
    
    // Both orders should be resting
    const orders = getMarketOrders(db, market.id, 'open');
    expect(orders.length).toBe(2);
  });

  test('exact complement prices match', () => {
    // At 50/50, both sides pay 500
    placeOrder(db, bob.id, market.id, 'no', 500, 10);
    const yesResult = placeOrder(db, alice.id, market.id, 'yes', 500, 10);
    
    expect(yesResult.status).toBe('filled');
    expect(yesResult.cost).toBe(5000); // 10 * 500
    
    const bets = getMarketBets(db, market.id);
    expect(bets[0].trade_price_sats).toBe(500);
  });
});

describe('Integer System - Money Conservation', () => {
  let db;
  let market;
  let alice;
  let bob;
  let carol;

  beforeEach(() => {
    db = createTestDatabase();
    market = createTestMarket(db);
    alice = createTestUser(db, 10000000);
    bob = createTestUser(db, 10000000);
    carol = createTestUser(db, 10000000);
  });

  test('total money is EXACTLY conserved after matching', () => {
    const initialTotal = 30000000; // 3 users * 10M
    
    // Multiple trades
    placeOrder(db, bob.id, market.id, 'no', 400, 100);
    placeOrder(db, alice.id, market.id, 'yes', 600, 50);
    placeOrder(db, carol.id, market.id, 'yes', 650, 30);
    
    // Calculate total
    const balanceTotal = getUserBalance(db, alice.id) + 
                         getUserBalance(db, bob.id) + 
                         getUserBalance(db, carol.id);
    
    const bets = getMarketBets(db, market.id);
    const lockedInBets = bets.reduce((sum, b) => sum + b.shares * SHARE_VALUE_SATS, 0);
    
    const orders = getMarketOrders(db, market.id);
    const lockedInOrders = orders
      .filter(o => o.status === 'open' || o.status === 'partial')
      .reduce((sum, o) => sum + (o.shares - o.filled_shares) * o.price_sats, 0);
    
    // EXACT conservation - no rounding errors!
    expect(balanceTotal + lockedInBets + lockedInOrders).toBe(initialTotal);
  });

  test('cancel returns EXACT amount', () => {
    const startBalance = getUserBalance(db, alice.id);
    
    const order = placeOrder(db, alice.id, market.id, 'yes', 600, 10);
    expect(getUserBalance(db, alice.id)).toBe(startBalance - 6000);
    
    cancelOrder(db, alice.id, order.order_id);
    expect(getUserBalance(db, alice.id)).toBe(startBalance); // Exactly restored
  });

  test('partial fill + cancel returns exact remaining', () => {
    placeOrder(db, bob.id, market.id, 'no', 300, 5); // Will match 5 shares
    
    const order = placeOrder(db, alice.id, market.id, 'yes', 700, 10); // 5 filled, 5 open
    expect(order.filled_shares).toBe(5);
    expect(order.remaining_shares).toBe(5);
    
    // Cost: 5 filled @ 700 + 5 open @ 700 = 7000? No wait...
    // Filled cost: 5 * (1000-300) = 5 * 700 = 3500
    // Open cost: 5 * 700 = 3500
    // Total: 7000
    expect(order.cost).toBe(7000);
    
    const cancelResult = cancelOrder(db, alice.id, order.order_id);
    expect(cancelResult.refund).toBe(3500); // 5 * 700 exactly
  });
});

describe('Integer System - Price Improvement', () => {
  let db;
  let market;
  let alice;
  let bob;

  beforeEach(() => {
    db = createTestDatabase();
    market = createTestMarket(db);
    alice = createTestUser(db, 10000000);
    bob = createTestUser(db, 10000000);
  });

  test('taker gets best available price', () => {
    // Multiple NO orders at different prices
    placeOrder(db, bob.id, market.id, 'no', 450, 5); // Best for YES taker
    placeOrder(db, bob.id, market.id, 'no', 400, 5);
    placeOrder(db, bob.id, market.id, 'no', 350, 5);
    
    // Alice willing to pay 700, matches best first
    const result = placeOrder(db, alice.id, market.id, 'yes', 700, 15);
    
    // Should match in price order: 450, 400, 350
    // Costs: 550 + 600 + 650 = 1800 per 5 shares each
    // Total: 5*550 + 5*600 + 5*650 = 2750 + 3000 + 3250 = 9000
    expect(result.cost).toBe(9000);
    expect(result.max_cost).toBe(10500); // 15 * 700
    expect(result.refund).toBe(1500); // Price improvement
  });

  test('sitting order ALWAYS filled at their price', () => {
    placeOrder(db, bob.id, market.id, 'no', 300, 10);
    const bobBalanceBefore = getUserBalance(db, bob.id);
    
    // Alice takes at very high price
    placeOrder(db, alice.id, market.id, 'yes', 900, 10);
    
    // Bob's cost was 300/share, unchanged
    const bets = getMarketBets(db, market.id);
    expect(bets[0].trade_price_sats).toBe(700); // YES price = 1000-300
    
    // Bob paid 3000, Alice paid 7000, total = 10000 = 10 shares * 1000
    const bobBalanceAfter = getUserBalance(db, bob.id);
    expect(bobBalanceBefore - bobBalanceAfter).toBe(0); // No additional deduction from Bob
  });
});

describe('Integer System - Validation', () => {
  let db;
  let market;
  let alice;

  beforeEach(() => {
    db = createTestDatabase();
    market = createTestMarket(db);
    alice = createTestUser(db, 10000000);
  });

  test('price must be 1-999', () => {
    expect(placeOrder(db, alice.id, market.id, 'yes', 0, 10).error)
      .toBe('Price must be integer between 1 and 999 sats');
    expect(placeOrder(db, alice.id, market.id, 'yes', 1000, 10).error)
      .toBe('Price must be integer between 1 and 999 sats');
    expect(placeOrder(db, alice.id, market.id, 'yes', -1, 10).error)
      .toBe('Price must be integer between 1 and 999 sats');
  });

  test('price must be integer', () => {
    expect(placeOrder(db, alice.id, market.id, 'yes', 500.5, 10).error)
      .toBe('Price must be integer between 1 and 999 sats');
  });

  test('shares must be positive integer', () => {
    expect(placeOrder(db, alice.id, market.id, 'yes', 500, 0).error)
      .toBe('Shares must be positive integer');
    expect(placeOrder(db, alice.id, market.id, 'yes', 500, -1).error)
      .toBe('Shares must be positive integer');
    expect(placeOrder(db, alice.id, market.id, 'yes', 500, 1.5).error)
      .toBe('Shares must be positive integer');
  });

  test('valid prices at boundaries', () => {
    expect(placeOrder(db, alice.id, market.id, 'yes', 1, 10).error).toBeUndefined();
    expect(placeOrder(db, alice.id, market.id, 'yes', 999, 10).error).toBeUndefined();
  });
});

describe('Integer System - Auto-Settle', () => {
  let db;
  let market;
  let alice;
  let bob;
  let carol;

  beforeEach(() => {
    db = createTestDatabase();
    market = createTestMarket(db);
    alice = createTestUser(db, 10000000);
    bob = createTestUser(db, 10000000);
    carol = createTestUser(db, 10000000);
  });

  test('opposing positions auto-settle', () => {
    // Alice gets YES position
    placeOrder(db, bob.id, market.id, 'no', 400, 10);
    placeOrder(db, alice.id, market.id, 'yes', 600, 10);
    
    let alicePos = getUserPositions(db, alice.id, market.id);
    expect(alicePos.yes).toBe(10);
    expect(alicePos.no).toBe(0);
    
    // Alice now gets NO position (should trigger auto-settle)
    placeOrder(db, carol.id, market.id, 'yes', 700, 10);
    const noResult = placeOrder(db, alice.id, market.id, 'no', 300, 10);
    
    expect(noResult.auto_settled).not.toBeNull();
    expect(noResult.auto_settled.shares_settled).toBe(10);
    expect(noResult.auto_settled.payout).toBe(10000); // 10 * 1000
    
    // Positions should be netted
    alicePos = getUserPositions(db, alice.id, market.id);
    expect(alicePos.yes).toBe(0);
    expect(alicePos.no).toBe(0);
  });

  test('auto-settle pays exactly 1000 per share pair', () => {
    const aliceStart = getUserBalance(db, alice.id);
    
    // Alice gets 5 YES shares
    placeOrder(db, bob.id, market.id, 'no', 400, 5);
    placeOrder(db, alice.id, market.id, 'yes', 600, 5); // Pays 3000
    
    // Alice gets 5 NO shares
    placeOrder(db, carol.id, market.id, 'yes', 800, 5);
    placeOrder(db, alice.id, market.id, 'no', 200, 5); // Pays 1000
    
    // Auto-settle should return 5000 (5 shares * 1000)
    const aliceEnd = getUserBalance(db, alice.id);
    
    // Net: Started 10M, paid 3000 for YES, paid 1000 for NO, received 5000 back
    expect(aliceEnd).toBe(aliceStart - 3000 - 1000 + 5000);
  });
});

describe('Integer System - Implied Percentage', () => {
  let db;
  let market;
  let alice;
  let bob;

  beforeEach(() => {
    db = createTestDatabase();
    market = createTestMarket(db);
    alice = createTestUser(db, 10000000);
    bob = createTestUser(db, 10000000);
  });

  test('impliedPercent calculates correctly', () => {
    expect(impliedPercent(500)).toBe('50.0');
    expect(impliedPercent(600)).toBe('60.0');
    expect(impliedPercent(333)).toBe('33.3');
    expect(impliedPercent(1)).toBe('0.1');
    expect(impliedPercent(999)).toBe('99.9');
  });

  test('order response includes implied_pct', () => {
    const result = placeOrder(db, alice.id, market.id, 'yes', 600, 10);
    expect(result.implied_pct).toBe('60.0');
  });

  test('matched bet records correct trade_price_sats', () => {
    placeOrder(db, bob.id, market.id, 'no', 350, 10);
    placeOrder(db, alice.id, market.id, 'yes', 700, 10);
    
    const bets = getMarketBets(db, market.id);
    // YES price = 1000 - 350 = 650
    expect(bets[0].trade_price_sats).toBe(650);
  });
});

describe('Integer System - Stress Tests', () => {
  let db;
  let market;

  beforeEach(() => {
    db = createTestDatabase();
    market = createTestMarket(db);
  });

  test('100 random trades maintain exact conservation', () => {
    const users = [];
    const initialBalance = 10000000;
    
    for (let i = 0; i < 10; i++) {
      users.push(createTestUser(db, initialBalance));
    }
    
    const initialTotal = users.length * initialBalance;
    
    // Random trading
    for (let i = 0; i < 100; i++) {
      const user = users[i % users.length];
      const side = i % 2 === 0 ? 'yes' : 'no';
      const price = 100 + (i * 7) % 800; // Various prices
      const shares = 1 + (i % 10);
      
      placeOrder(db, user.id, market.id, side, price, shares);
    }
    
    // Calculate total
    let balanceTotal = 0;
    users.forEach(user => {
      const balance = getUserBalance(db, user.id);
      expect(balance).toBeGreaterThanOrEqual(0);
      balanceTotal += balance;
    });
    
    const bets = getMarketBets(db, market.id);
    const lockedInBets = bets.reduce((sum, b) => sum + b.shares * SHARE_VALUE_SATS, 0);
    
    const orders = getMarketOrders(db, market.id);
    const lockedInOrders = orders
      .filter(o => o.status === 'open' || o.status === 'partial')
      .reduce((sum, o) => sum + (o.shares - o.filled_shares) * o.price_sats, 0);
    
    // EXACT conservation
    expect(balanceTotal + lockedInBets + lockedInOrders).toBe(initialTotal);
  });

  test('many cancellations maintain exact conservation', () => {
    const user = createTestUser(db, 10000000);
    const startBalance = 10000000;
    
    const orders = [];
    for (let i = 0; i < 50; i++) {
      const price = 100 + i * 10;
      const result = placeOrder(db, user.id, market.id, 'yes', price, 5);
      if (!result.error) {
        orders.push(result.order_id);
      }
    }
    
    // Cancel all
    for (const orderId of orders) {
      cancelOrder(db, user.id, orderId);
    }
    
    // Balance exactly restored
    expect(getUserBalance(db, user.id)).toBe(startBalance);
  });
});

describe('Integer System - Edge Cases', () => {
  let db;
  let market;
  let alice;
  let bob;

  beforeEach(() => {
    db = createTestDatabase();
    market = createTestMarket(db);
    alice = createTestUser(db, 10000000);
    bob = createTestUser(db, 10000000);
  });

  test('minimum price (1 sat) works', () => {
    // YES @ 1 sat matches NO @ 999 sat
    placeOrder(db, bob.id, market.id, 'no', 999, 10);
    const result = placeOrder(db, alice.id, market.id, 'yes', 1, 10);
    
    expect(result.status).toBe('filled');
    expect(result.cost).toBe(10); // 10 * 1 sat
  });

  test('maximum price (999 sats) works', () => {
    placeOrder(db, bob.id, market.id, 'no', 1, 10);
    const result = placeOrder(db, alice.id, market.id, 'yes', 999, 10);
    
    expect(result.status).toBe('filled');
    expect(result.cost).toBe(9990); // 10 * 999 sat
  });

  test('single share trades work', () => {
    placeOrder(db, bob.id, market.id, 'no', 400, 1);
    const result = placeOrder(db, alice.id, market.id, 'yes', 600, 1);
    
    expect(result.filled_shares).toBe(1);
    expect(result.cost).toBe(600);
  });

  test('insufficient balance rejected', () => {
    const poorUser = createTestUser(db, 100);
    
    const result = placeOrder(db, poorUser.id, market.id, 'yes', 500, 10);
    expect(result.error).toBe('Insufficient balance');
    expect(result.required).toBe(5000);
    expect(result.available).toBe(100);
  });

  test('self-trades prevented', () => {
    placeOrder(db, alice.id, market.id, 'no', 400, 10);
    const result = placeOrder(db, alice.id, market.id, 'yes', 600, 10);
    
    expect(result.status).toBe('open');
    expect(result.filled_shares).toBe(0);
  });

  test('closed market rejected', () => {
    const closedMarket = createTestMarket(db, { status: 'resolved' });
    const result = placeOrder(db, alice.id, closedMarket.id, 'yes', 500, 10);
    
    expect(result.error).toBe('Market not available for trading');
  });
});
