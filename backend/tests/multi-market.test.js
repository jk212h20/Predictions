/**
 * Multi-Market Scenario Tests
 * 
 * Tests that the matching system correctly handles scenarios where
 * users have positions in multiple markets simultaneously.
 * 
 * KEY BEHAVIORS:
 * - User balance is shared across all markets
 * - Auto-settle only affects same-market positions
 * - Orders in different markets are independent
 * - Self-trade prevention applies per-market
 */

const {
  createTestDatabase,
  createTestUser,
  createTestMarket,
  placeOrder,
  cancelOrder,
  getUserBalance,
  getMarketBets,
  getUserPositions,
} = require('./testHelpers');

describe('Multi-Market - Balance Sharing', () => {
  let db;
  let market1;
  let market2;
  let market3;
  let alice;
  let bob;

  beforeEach(() => {
    db = createTestDatabase();
    market1 = createTestMarket(db);
    market2 = createTestMarket(db);
    market3 = createTestMarket(db);
    alice = createTestUser(db, 1000000);
    bob = createTestUser(db, 1000000);
  });

  test('user can place orders in multiple markets', () => {
    const result1 = placeOrder(db, alice.id, market1.id, 'yes', 50, 10000);
    const result2 = placeOrder(db, alice.id, market2.id, 'yes', 60, 10000);
    const result3 = placeOrder(db, alice.id, market3.id, 'no', 40, 10000);
    
    expect(result1.error).toBeUndefined();
    expect(result2.error).toBeUndefined();
    expect(result3.error).toBeUndefined();
    
    // Total cost: 5000 + 6000 + 6000 = 17000
    expect(getUserBalance(db, alice.id)).toBe(1000000 - 17000);
  });

  test('balance is deducted correctly across markets', () => {
    const startBalance = getUserBalance(db, alice.id);
    
    placeOrder(db, alice.id, market1.id, 'yes', 50, 20000); // Cost: 10000
    placeOrder(db, alice.id, market2.id, 'yes', 25, 20000); // Cost: 5000
    
    expect(getUserBalance(db, alice.id)).toBe(startBalance - 15000);
  });

  test('insufficient balance prevents order in any market', () => {
    // Spend most of balance in market1
    placeOrder(db, alice.id, market1.id, 'yes', 50, 1900000); // Cost: 950000
    
    // Try to spend more than remaining in market2
    const result = placeOrder(db, alice.id, market2.id, 'yes', 50, 200000);
    
    expect(result.error).toBe('Insufficient balance');
  });

  test('cancellation in one market frees balance for another', () => {
    const order1 = placeOrder(db, alice.id, market1.id, 'yes', 50, 1800000); // Cost: 900000
    const balanceAfterOrder1 = getUserBalance(db, alice.id);
    expect(balanceAfterOrder1).toBe(100000); // 1M - 900k
    
    // Can't afford this order
    const failedOrder = placeOrder(db, alice.id, market2.id, 'yes', 50, 400000);
    expect(failedOrder.error).toBe('Insufficient balance');
    
    // Cancel first order
    cancelOrder(db, alice.id, order1.order_id);
    
    // Now can afford
    const successOrder = placeOrder(db, alice.id, market2.id, 'yes', 50, 400000);
    expect(successOrder.error).toBeUndefined();
  });
});

describe('Multi-Market - Position Independence', () => {
  let db;
  let market1;
  let market2;
  let alice;
  let bob;

  beforeEach(() => {
    db = createTestDatabase();
    market1 = createTestMarket(db);
    market2 = createTestMarket(db);
    alice = createTestUser(db, 10000000);
    bob = createTestUser(db, 10000000);
  });

  test('positions in different markets are tracked separately', () => {
    // Bob provides liquidity in both markets
    placeOrder(db, bob.id, market1.id, 'no', 40, 10000);
    placeOrder(db, bob.id, market2.id, 'no', 40, 10000);
    
    // Alice takes YES in market1
    placeOrder(db, alice.id, market1.id, 'yes', 60, 10000);
    
    // Check positions
    const pos1 = getUserPositions(db, alice.id, market1.id);
    const pos2 = getUserPositions(db, alice.id, market2.id);
    
    expect(pos1.yes).toBe(10000);
    expect(pos1.no).toBe(0);
    expect(pos2.yes).toBe(0);
    expect(pos2.no).toBe(0);
  });

  test('bets are market-specific', () => {
    // Match in market1
    placeOrder(db, bob.id, market1.id, 'no', 40, 10000);
    placeOrder(db, alice.id, market1.id, 'yes', 60, 10000);
    
    // No match in market2 (different price)
    placeOrder(db, bob.id, market2.id, 'no', 30, 10000);
    
    const bets1 = getMarketBets(db, market1.id);
    const bets2 = getMarketBets(db, market2.id);
    
    expect(bets1.length).toBe(1);
    expect(bets2.length).toBe(0);
  });

  test('orders in one market do not affect another', () => {
    // Place YES in market1
    const order1 = placeOrder(db, alice.id, market1.id, 'yes', 50, 10000);
    
    // Place NO in market2 at same price - should NOT self-match
    const order2 = placeOrder(db, alice.id, market2.id, 'no', 50, 10000);
    
    expect(order1.status).toBe('open');
    expect(order2.status).toBe('open');
    
    // Verify separate order books
    const bets1 = getMarketBets(db, market1.id);
    const bets2 = getMarketBets(db, market2.id);
    
    expect(bets1.length).toBe(0);
    expect(bets2.length).toBe(0);
  });
});

describe('Multi-Market - Auto-Settle Isolation', () => {
  let db;
  let market1;
  let market2;
  let alice;
  let bob;
  let carol;

  beforeEach(() => {
    db = createTestDatabase();
    market1 = createTestMarket(db);
    market2 = createTestMarket(db);
    alice = createTestUser(db, 10000000);
    bob = createTestUser(db, 10000000);
    carol = createTestUser(db, 10000000);
  });

  test('auto-settle only affects same market', () => {
    // Alice gets YES in market1
    placeOrder(db, bob.id, market1.id, 'no', 40, 5000);
    placeOrder(db, alice.id, market1.id, 'yes', 60, 5000);
    
    // Alice gets YES in market2
    placeOrder(db, bob.id, market2.id, 'no', 40, 5000);
    placeOrder(db, alice.id, market2.id, 'yes', 60, 5000);
    
    // Alice gets NO in market1 - should auto-settle ONLY market1
    placeOrder(db, carol.id, market1.id, 'yes', 70, 5000);
    const result = placeOrder(db, alice.id, market1.id, 'no', 30, 5000);
    
    expect(result.auto_settled).not.toBeNull();
    
    // Market1 positions should be settled
    const pos1 = getUserPositions(db, alice.id, market1.id);
    expect(pos1.yes).toBe(0);
    expect(pos1.no).toBe(0);
    
    // Market2 positions should be unchanged
    const pos2 = getUserPositions(db, alice.id, market2.id);
    expect(pos2.yes).toBe(5000);
    expect(pos2.no).toBe(0);
  });

  test('cross-market positions do not trigger auto-settle', () => {
    // Alice gets YES in market1
    placeOrder(db, bob.id, market1.id, 'no', 40, 5000);
    placeOrder(db, alice.id, market1.id, 'yes', 60, 5000);
    
    // Alice gets NO in market2 (different market!)
    placeOrder(db, carol.id, market2.id, 'yes', 70, 5000);
    const result = placeOrder(db, alice.id, market2.id, 'no', 30, 5000);
    
    // Should NOT auto-settle (different markets)
    expect(result.auto_settled).toBeNull();
    
    // Both positions should remain
    const pos1 = getUserPositions(db, alice.id, market1.id);
    const pos2 = getUserPositions(db, alice.id, market2.id);
    
    expect(pos1.yes).toBe(5000);
    expect(pos2.no).toBe(5000);
  });
});

describe('Multi-Market - Self-Trade Prevention', () => {
  let db;
  let market1;
  let market2;
  let alice;

  beforeEach(() => {
    db = createTestDatabase();
    market1 = createTestMarket(db);
    market2 = createTestMarket(db);
    alice = createTestUser(db, 10000000);
  });

  test('self-trade prevention is per-market', () => {
    // Alice posts NO in market1
    placeOrder(db, alice.id, market1.id, 'no', 40, 10000);
    
    // Alice posts matching YES in market1 - should NOT self-trade
    const result1 = placeOrder(db, alice.id, market1.id, 'yes', 60, 10000);
    expect(result1.filled).toBe(0);
    expect(result1.matched_bets.length).toBe(0);
    
    // But can place opposite orders in different markets
    const result2 = placeOrder(db, alice.id, market2.id, 'no', 40, 10000);
    const result3 = placeOrder(db, alice.id, market2.id, 'yes', 60, 10000);
    
    // Neither should match (both are Alice's)
    expect(result2.filled).toBe(0);
    expect(result3.filled).toBe(0);
  });
});

describe('Multi-Market - Complex Scenarios', () => {
  let db;

  beforeEach(() => {
    db = createTestDatabase();
  });

  test('user with positions in 5 markets maintains correct total wealth', () => {
    const markets = [];
    for (let i = 0; i < 5; i++) {
      markets.push(createTestMarket(db));
    }
    
    const alice = createTestUser(db, 5000000);
    const bob = createTestUser(db, 5000000);
    const initialTotal = 10000000;
    
    // Place orders in each market
    markets.forEach((market, i) => {
      placeOrder(db, bob.id, market.id, 'no', 40 + i, 10000);
      placeOrder(db, alice.id, market.id, 'yes', 60 - i, 10000);
    });
    
    // Calculate total wealth = balance + locked in bets
    const balance = getUserBalance(db, alice.id) + getUserBalance(db, bob.id);
    let lockedInBets = 0;
    markets.forEach(market => {
      const bets = getMarketBets(db, market.id);
      bets.forEach(bet => lockedInBets += bet.amount_sats);
    });
    
    // Total wealth should be conserved (balance + locked positions)
    expect(balance + lockedInBets).toBe(initialTotal);
    
    // Verify each market has independent positions
    markets.forEach(market => {
      const bets = getMarketBets(db, market.id);
      expect(bets.length).toBe(1);
    });
  });

  test('cancelling orders across markets restores balance correctly', () => {
    const market1 = createTestMarket(db);
    const market2 = createTestMarket(db);
    const market3 = createTestMarket(db);
    
    const alice = createTestUser(db, 1000000);
    const startBalance = 1000000;
    
    // Place orders in all markets (none match)
    const o1 = placeOrder(db, alice.id, market1.id, 'yes', 30, 10000); // Cost: 3000
    const o2 = placeOrder(db, alice.id, market2.id, 'no', 70, 10000);  // Cost: 3000
    const o3 = placeOrder(db, alice.id, market3.id, 'yes', 50, 10000); // Cost: 5000
    
    expect(getUserBalance(db, alice.id)).toBe(startBalance - 11000);
    
    // Cancel all
    cancelOrder(db, alice.id, o1.order_id);
    cancelOrder(db, alice.id, o2.order_id);
    cancelOrder(db, alice.id, o3.order_id);
    
    expect(getUserBalance(db, alice.id)).toBe(startBalance);
  });

  test('matched and unmatched orders in different markets', () => {
    const market1 = createTestMarket(db);
    const market2 = createTestMarket(db);
    
    const alice = createTestUser(db, 1000000);
    const bob = createTestUser(db, 1000000);
    
    // Market1: match
    placeOrder(db, bob.id, market1.id, 'no', 40, 10000);
    const matched = placeOrder(db, alice.id, market1.id, 'yes', 60, 10000);
    expect(matched.status).toBe('filled');
    
    // Market2: no match (different prices)
    placeOrder(db, bob.id, market2.id, 'no', 30, 10000);
    const unmatched = placeOrder(db, alice.id, market2.id, 'yes', 50, 10000);
    expect(unmatched.status).toBe('open');
    
    // Verify state
    const bets1 = getMarketBets(db, market1.id);
    const bets2 = getMarketBets(db, market2.id);
    
    expect(bets1.length).toBe(1);
    expect(bets2.length).toBe(0);
  });

  test('stress: 10 users trading across 5 markets', () => {
    const markets = [];
    const users = [];
    const initialBalancePerUser = 1000000;
    
    for (let i = 0; i < 5; i++) {
      markets.push(createTestMarket(db));
    }
    
    for (let i = 0; i < 10; i++) {
      users.push(createTestUser(db, initialBalancePerUser));
    }
    
    const initialTotal = users.length * initialBalancePerUser;
    
    // Random trading
    for (let i = 0; i < 200; i++) {
      const user = users[i % users.length];
      const market = markets[i % markets.length];
      const side = i % 2 === 0 ? 'yes' : 'no';
      const price = 30 + (i % 40); // 30-69
      const amount = 1000 * ((i % 5) + 1);
      
      placeOrder(db, user.id, market.id, side, price, amount);
    }
    
    // Verify conservation
    let totalBalance = 0;
    users.forEach(user => {
      const balance = getUserBalance(db, user.id);
      expect(balance).toBeGreaterThanOrEqual(0);
      totalBalance += balance;
    });
    
    expect(totalBalance).toBe(initialTotal);
  });
});

describe('Multi-Market - Edge Cases', () => {
  let db;

  beforeEach(() => {
    db = createTestDatabase();
  });

  test('same grandmaster different market types (attendance vs winner)', () => {
    // Create GM
    const gm = db.prepare(`
      INSERT INTO grandmasters (id, name, fide_rating, country)
      VALUES ('gm1', 'Magnus Carlsen', 2800, 'NOR')
    `).run();
    
    // Create attendance and winner markets for same GM
    const attendance = createTestMarket(db, { grandmaster_id: 'gm1', type: 'attendance' });
    const winner = createTestMarket(db, { grandmaster_id: 'gm1', type: 'winner' });
    
    const alice = createTestUser(db, 1000000);
    const bob = createTestUser(db, 1000000);
    
    // Trade in both
    placeOrder(db, bob.id, attendance.id, 'no', 40, 10000);
    placeOrder(db, alice.id, attendance.id, 'yes', 60, 10000);
    
    placeOrder(db, bob.id, winner.id, 'no', 90, 10000);
    placeOrder(db, alice.id, winner.id, 'yes', 10, 10000);
    
    // Both should have independent bets
    const attendanceBets = getMarketBets(db, attendance.id);
    const winnerBets = getMarketBets(db, winner.id);
    
    expect(attendanceBets.length).toBe(1);
    expect(winnerBets.length).toBe(1);
    
    // Prices should be different
    expect(attendanceBets[0].price_cents).toBe(60); // From YES@60 match
    expect(winnerBets[0].price_cents).toBe(10);     // From YES@10 match
  });

  test('user exhausts balance across multiple markets then cancels', () => {
    const market1 = createTestMarket(db);
    const market2 = createTestMarket(db);
    
    const alice = createTestUser(db, 10000);
    
    // Place orders until balance exhausted
    const o1 = placeOrder(db, alice.id, market1.id, 'yes', 50, 10000); // Cost: 5000
    const o2 = placeOrder(db, alice.id, market2.id, 'yes', 50, 10000); // Cost: 5000
    
    expect(getUserBalance(db, alice.id)).toBe(0);
    
    // Can't place more
    const failed = placeOrder(db, alice.id, market1.id, 'yes', 50, 1000);
    expect(failed.error).toBe('Insufficient balance');
    
    // Cancel one order
    cancelOrder(db, alice.id, o1.order_id);
    expect(getUserBalance(db, alice.id)).toBe(5000);
    
    // Now can place again
    const success = placeOrder(db, alice.id, market1.id, 'yes', 50, 5000);
    expect(success.error).toBeUndefined();
  });
});
