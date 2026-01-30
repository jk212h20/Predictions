/**
 * Edge Case Tests for Order Matching
 * 
 * Tests boundary conditions, extreme scenarios, and rare edge cases
 * that could potentially break the matching system.
 * 
 * AREAS COVERED:
 * - Market status transitions
 * - Minimum/maximum order amounts
 * - Queue behavior with many orders
 * - Exact balance scenarios
 * - Rounding edge cases
 */

const {
  createTestDatabase,
  createTestUser,
  createTestMarket,
  placeOrder,
  cancelOrder,
  getUserBalance,
  getOrder,
  getMarketOrders,
  getMarketBets,
} = require('./testHelpers');

describe('Market Status Edge Cases', () => {
  let db;
  let alice;
  let bob;

  beforeEach(() => {
    db = createTestDatabase();
    alice = createTestUser(db, 10000000);
    bob = createTestUser(db, 10000000);
  });

  test('cannot place order on resolved market', () => {
    const market = createTestMarket(db, { status: 'resolved' });
    
    const result = placeOrder(db, alice.id, market.id, 'yes', 50, 10000);
    
    expect(result.error).toBe('Market not available for trading');
  });

  test('cannot place order on pending_resolution market', () => {
    const market = createTestMarket(db, { status: 'pending_resolution' });
    
    const result = placeOrder(db, alice.id, market.id, 'yes', 50, 10000);
    
    expect(result.error).toBe('Market not available for trading');
  });

  test('cannot place order on cancelled market', () => {
    const market = createTestMarket(db, { status: 'cancelled' });
    
    const result = placeOrder(db, alice.id, market.id, 'yes', 50, 10000);
    
    expect(result.error).toBe('Market not available for trading');
  });

  test('can place order on open market', () => {
    const market = createTestMarket(db, { status: 'open' });
    
    const result = placeOrder(db, alice.id, market.id, 'yes', 50, 10000);
    
    expect(result.error).toBeUndefined();
    expect(result.order_id).toBeDefined();
  });

  test('non-existent market returns error', () => {
    const result = placeOrder(db, alice.id, 'non-existent-market-id', 'yes', 50, 10000);
    
    expect(result.error).toBe('Market not available for trading');
  });
});

describe('Minimum Amount Edge Cases', () => {
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

  test('exactly 100 sats is minimum', () => {
    const result = placeOrder(db, alice.id, market.id, 'yes', 50, 100);
    expect(result.error).toBeUndefined();
  });

  test('99 sats rejected', () => {
    const result = placeOrder(db, alice.id, market.id, 'yes', 50, 99);
    expect(result.error).toBe('Minimum order is 100 sats');
  });

  test('1 sat rejected', () => {
    const result = placeOrder(db, alice.id, market.id, 'yes', 50, 1);
    expect(result.error).toBe('Minimum order is 100 sats');
  });

  test('0 sats rejected', () => {
    const result = placeOrder(db, alice.id, market.id, 'yes', 50, 0);
    expect(result.error).toBe('Minimum order is 100 sats');
  });

  test('negative amount rejected', () => {
    const result = placeOrder(db, alice.id, market.id, 'yes', 50, -100);
    expect(result.error).toBe('Minimum order is 100 sats');
  });

  test('minimum order can match', () => {
    placeOrder(db, bob.id, market.id, 'no', 40, 100);
    const result = placeOrder(db, alice.id, market.id, 'yes', 60, 100);
    
    expect(result.status).toBe('filled');
    expect(result.filled).toBe(100);
  });
});

describe('Maximum Amount Edge Cases', () => {
  let db;
  let market;
  let alice;
  let bob;

  beforeEach(() => {
    db = createTestDatabase();
    market = createTestMarket(db);
    alice = createTestUser(db, 1000000000); // 1B sats
    bob = createTestUser(db, 1000000000);
  });

  test('very large order accepted if balance sufficient', () => {
    const result = placeOrder(db, alice.id, market.id, 'yes', 50, 500000000);
    expect(result.error).toBeUndefined();
    expect(result.cost).toBe(250000000);
  });

  test('order exactly equal to balance', () => {
    const user = createTestUser(db, 10000); // Just enough for YES@50 of 20000
    const result = placeOrder(db, user.id, market.id, 'yes', 50, 20000);
    
    expect(result.error).toBeUndefined();
    expect(getUserBalance(db, user.id)).toBe(0);
  });

  test('order 1 sat over balance rejected', () => {
    const user = createTestUser(db, 9999);
    const result = placeOrder(db, user.id, market.id, 'yes', 50, 20000);
    
    expect(result.error).toBe('Insufficient balance');
  });

  test('large order matches with multiple smaller orders', () => {
    // Multiple small NO orders
    for (let i = 0; i < 10; i++) {
      placeOrder(db, bob.id, market.id, 'no', 40, 10000);
    }
    
    // One large YES order
    const result = placeOrder(db, alice.id, market.id, 'yes', 60, 100000);
    
    expect(result.status).toBe('filled');
    expect(result.filled).toBe(100000);
    expect(result.matched_bets.length).toBe(10);
  });
});

describe('Queue Behavior Edge Cases', () => {
  let db;
  let market;

  beforeEach(() => {
    db = createTestDatabase();
    market = createTestMarket(db);
  });

  test('many orders at same price - one gets filled', () => {
    const users = [];
    for (let i = 0; i < 10; i++) {
      users.push(createTestUser(db, 1000000));
    }
    
    // All users place NO@40
    const orderIds = [];
    users.forEach(user => {
      const result = placeOrder(db, user.id, market.id, 'no', 40, 1000);
      orderIds.push(result.order_id);
    });
    
    // One YES order should match ONE of the NO orders
    const taker = createTestUser(db, 1000000);
    const result = placeOrder(db, taker.id, market.id, 'yes', 60, 1000);
    
    expect(result.filled).toBe(1000);
    expect(result.matched_bets.length).toBe(1);
    
    // Verify exactly one order filled (whichever was first by created_at)
    const filledCount = orderIds.filter(id => getOrder(db, id).status === 'filled').length;
    const openCount = orderIds.filter(id => getOrder(db, id).status === 'open').length;
    
    expect(filledCount).toBe(1);
    expect(openCount).toBe(9);
  });

  test('100 orders in queue handled correctly', () => {
    const maker = createTestUser(db, 100000000);
    const taker = createTestUser(db, 100000000);
    
    // 100 small NO orders
    for (let i = 0; i < 100; i++) {
      placeOrder(db, maker.id, market.id, 'no', 40, 1000);
    }
    
    // One large YES order
    const result = placeOrder(db, taker.id, market.id, 'yes', 60, 100000);
    
    expect(result.filled).toBe(100000);
    expect(result.matched_bets.length).toBe(100);
    
    // All NO orders should be filled
    const orders = getMarketOrders(db, market.id);
    const filledOrders = orders.filter(o => o.status === 'filled' && o.side === 'no');
    expect(filledOrders.length).toBe(100);
  });

  test('orders at different prices matched in correct order', () => {
    const maker = createTestUser(db, 10000000);
    const taker = createTestUser(db, 10000000);
    
    // Orders at various prices (best to worst for taker)
    placeOrder(db, maker.id, market.id, 'no', 45, 2000); // Best: YES@55
    placeOrder(db, maker.id, market.id, 'no', 43, 2000);
    placeOrder(db, maker.id, market.id, 'no', 41, 2000);
    placeOrder(db, maker.id, market.id, 'no', 40, 2000); // Worst: YES@60
    
    const result = placeOrder(db, taker.id, market.id, 'yes', 60, 8000);
    
    // Should fill in price order
    const prices = result.matched_bets.map(b => b.price);
    expect(prices).toEqual([55, 57, 59, 60]);
  });
});

describe('Exact Balance Scenarios', () => {
  let db;
  let market;

  beforeEach(() => {
    db = createTestDatabase();
    market = createTestMarket(db);
  });

  test('place order with exactly available balance', () => {
    const user = createTestUser(db, 5000);
    
    // YES@50 for 10000 costs exactly 5000
    const result = placeOrder(db, user.id, market.id, 'yes', 50, 10000);
    
    expect(result.error).toBeUndefined();
    expect(getUserBalance(db, user.id)).toBe(0);
  });

  test('multiple orders draining balance to zero', () => {
    const user = createTestUser(db, 10000);
    
    // Two orders: 5000 + 5000 = 10000 total cost
    const r1 = placeOrder(db, user.id, market.id, 'yes', 50, 10000); // Cost: 5000
    expect(r1.error).toBeUndefined();
    
    const r2 = placeOrder(db, user.id, market.id, 'yes', 50, 10000); // Cost: 5000
    expect(r2.error).toBeUndefined();
    
    expect(getUserBalance(db, user.id)).toBe(0);
  });

  test('third order fails when balance is zero', () => {
    const user = createTestUser(db, 10000);
    
    placeOrder(db, user.id, market.id, 'yes', 50, 10000);
    placeOrder(db, user.id, market.id, 'yes', 50, 10000);
    
    const result = placeOrder(db, user.id, market.id, 'yes', 50, 1000);
    
    expect(result.error).toBe('Insufficient balance');
  });

  test('cancel restores balance allowing new order', () => {
    const user = createTestUser(db, 5000);
    
    const order1 = placeOrder(db, user.id, market.id, 'yes', 50, 10000);
    expect(getUserBalance(db, user.id)).toBe(0);
    
    cancelOrder(db, user.id, order1.order_id);
    expect(getUserBalance(db, user.id)).toBe(5000);
    
    const order2 = placeOrder(db, user.id, market.id, 'yes', 50, 10000);
    expect(order2.error).toBeUndefined();
  });
});

describe('Rounding Edge Cases', () => {
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

  test('cost rounding at 1%', () => {
    // YES@1% for 10000 sats = ceil(10000 * 0.01) = 100
    const result = placeOrder(db, alice.id, market.id, 'yes', 1, 10000);
    expect(result.cost).toBe(100);
  });

  test('cost rounding at 99%', () => {
    // YES@99% for 10000 sats = ceil(10000 * 0.99) = 9900
    const result = placeOrder(db, alice.id, market.id, 'yes', 99, 10000);
    expect(result.cost).toBe(9900);
  });

  test('cost rounding at 33%', () => {
    // YES@33% for 1000 sats = ceil(1000 * 0.33) = 330
    const result = placeOrder(db, alice.id, market.id, 'yes', 33, 1000);
    expect(result.cost).toBe(330);
    
    // For 1001 sats = ceil(1001 * 0.33) = ceil(330.33) = 331
    const result2 = placeOrder(db, alice.id, market.id, 'yes', 33, 1001);
    expect(result2.cost).toBe(331);
  });

  test('NO cost rounding', () => {
    // NO@40 for 10000 sats pays (100-40)% = 60%
    // Cost = ceil(10000 * 0.60) = 6000
    const result = placeOrder(db, bob.id, market.id, 'no', 40, 10000);
    expect(result.cost).toBe(6000);
    
    // NO@67 for 1001 sats pays 33%
    // Cost = ceil(1001 * 0.33) = 331
    const result2 = placeOrder(db, bob.id, market.id, 'no', 67, 1001);
    expect(result2.cost).toBe(331);
  });

  test('partial fill refund calculation', () => {
    // Bob places NO@40 for 10000
    const noResult = placeOrder(db, bob.id, market.id, 'no', 40, 10000);
    // Cost: 6000
    
    // Alice takes 7000
    placeOrder(db, alice.id, market.id, 'yes', 60, 7000);
    
    // Bob cancels remaining 3000
    const cancelResult = cancelOrder(db, bob.id, noResult.order_id);
    
    // Refund for 3000 at 60% = ceil(3000 * 0.60) = 1800
    expect(cancelResult.refund).toBe(1800);
  });
});

describe('Boundary Price Cases', () => {
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

  test('YES@1 matches NO@99', () => {
    placeOrder(db, bob.id, market.id, 'no', 99, 10000);
    const result = placeOrder(db, alice.id, market.id, 'yes', 1, 10000);
    
    expect(result.status).toBe('filled');
    
    const bets = getMarketBets(db, market.id);
    expect(bets[0].price_cents).toBe(1);
  });

  test('YES@99 matches NO@1', () => {
    placeOrder(db, bob.id, market.id, 'no', 1, 10000);
    const result = placeOrder(db, alice.id, market.id, 'yes', 99, 10000);
    
    expect(result.status).toBe('filled');
    
    const bets = getMarketBets(db, market.id);
    expect(bets[0].price_cents).toBe(99);
  });

  test('YES@50 matches NO@50 exactly', () => {
    placeOrder(db, bob.id, market.id, 'no', 50, 10000);
    const result = placeOrder(db, alice.id, market.id, 'yes', 50, 10000);
    
    expect(result.status).toBe('filled');
    
    const bets = getMarketBets(db, market.id);
    expect(bets[0].price_cents).toBe(50);
  });

  test('YES@50 does NOT match NO@49', () => {
    placeOrder(db, bob.id, market.id, 'no', 49, 10000);
    const result = placeOrder(db, alice.id, market.id, 'yes', 50, 10000);
    
    expect(result.status).toBe('open');
    expect(result.filled).toBe(0);
  });

  test('YES@51 matches NO@49', () => {
    placeOrder(db, bob.id, market.id, 'no', 49, 10000);
    const result = placeOrder(db, alice.id, market.id, 'yes', 51, 10000);
    
    expect(result.status).toBe('filled');
  });
});

describe('Empty Order Book Edge Cases', () => {
  let db;
  let market;
  let alice;

  beforeEach(() => {
    db = createTestDatabase();
    market = createTestMarket(db);
    alice = createTestUser(db, 10000000);
  });

  test('order on empty book goes to book', () => {
    const result = placeOrder(db, alice.id, market.id, 'yes', 50, 10000);
    
    expect(result.status).toBe('open');
    expect(result.filled).toBe(0);
    expect(result.matched_bets.length).toBe(0);
  });

  test('first order sets market price', () => {
    placeOrder(db, alice.id, market.id, 'yes', 75, 10000);
    
    const orders = getMarketOrders(db, market.id);
    expect(orders.length).toBe(1);
    expect(orders[0].price_cents).toBe(75);
  });

  test('opposite side on empty book does not match', () => {
    // YES order
    const yes = placeOrder(db, alice.id, market.id, 'yes', 50, 10000);
    expect(yes.status).toBe('open');
    
    // NO order (from same user - can't match anyway, but also no other NO)
    const bob = createTestUser(db, 10000000);
    const no = placeOrder(db, bob.id, market.id, 'no', 40, 10000);
    expect(no.status).toBe('open'); // No YES orders at 60+ to match
  });
});

describe('Stress Edge Cases', () => {
  let db;
  let market;

  beforeEach(() => {
    db = createTestDatabase();
    market = createTestMarket(db);
  });

  test('place and cancel same order rapidly', () => {
    const user = createTestUser(db, 1000000);
    const startBalance = getUserBalance(db, user.id);
    
    for (let i = 0; i < 50; i++) {
      const result = placeOrder(db, user.id, market.id, 'yes', 50, 10000);
      cancelOrder(db, user.id, result.order_id);
    }
    
    expect(getUserBalance(db, user.id)).toBe(startBalance);
  });

  test('many partial fills and cancels', () => {
    const maker = createTestUser(db, 10000000);
    const takers = [];
    for (let i = 0; i < 10; i++) {
      takers.push(createTestUser(db, 1000000));
    }
    
    // Large NO order
    const noOrder = placeOrder(db, maker.id, market.id, 'no', 40, 100000);
    
    // Multiple takers
    for (let i = 0; i < 5; i++) {
      placeOrder(db, takers[i].id, market.id, 'yes', 60, 5000);
    }
    
    // Cancel remaining
    cancelOrder(db, maker.id, noOrder.order_id);
    
    // Verify 25000 was filled, 75000 cancelled
    const order = getOrder(db, noOrder.order_id);
    expect(order.filled_sats).toBe(25000);
    expect(order.status).toBe('cancelled');
  });

  test('alternating YES and NO orders', () => {
    const users = [];
    for (let i = 0; i < 20; i++) {
      users.push(createTestUser(db, 1000000));
    }
    
    // Alternating orders
    for (let i = 0; i < 20; i++) {
      const side = i % 2 === 0 ? 'yes' : 'no';
      const price = side === 'yes' ? 55 : 45;
      placeOrder(db, users[i].id, market.id, side, price, 5000);
    }
    
    // Should have matched 10 times
    const bets = getMarketBets(db, market.id);
    expect(bets.length).toBe(10);
  });
});

describe('Data Type Edge Cases', () => {
  let db;
  let market;
  let alice;

  beforeEach(() => {
    db = createTestDatabase();
    market = createTestMarket(db);
    alice = createTestUser(db, 10000000);
  });

  test('string price is handled', () => {
    // Should either convert or reject - not crash
    const result = placeOrder(db, alice.id, market.id, 'yes', '50', 10000);
    // Either accepted or clear error
    expect(result.order_id || result.error).toBeDefined();
  });

  test('floating point amount is floored/rejected', () => {
    const result = placeOrder(db, alice.id, market.id, 'yes', 50, 10000.7);
    // Should either floor or work - not crash
    expect(result.order_id || result.error).toBeDefined();
  });

  test('very large numbers do not overflow', () => {
    // JavaScript safe integer is 9007199254740991
    const bigUser = createTestUser(db, Number.MAX_SAFE_INTEGER);
    
    const result = placeOrder(db, bigUser.id, market.id, 'yes', 1, 100000000000);
    // Should either work or error gracefully
    expect(typeof result.error === 'string' || typeof result.order_id === 'string').toBe(true);
  });
});
