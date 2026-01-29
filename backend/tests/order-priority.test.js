/**
 * Order Priority Tests for Order Matching
 * Tests price-time priority in order matching
 */

const {
  createTestDatabase,
  createTestUser,
  createTestMarket,
  placeOrder,
  getMarketBets,
  createOrderWithTimestamp,
} = require('./testHelpers');

describe('Order Priority', () => {
  let db;
  let market;
  let alice;
  let bob;
  let carol;
  let dave;

  beforeEach(() => {
    db = createTestDatabase();
    market = createTestMarket(db);
    alice = createTestUser(db, 10000000);
    bob = createTestUser(db, 10000000);
    carol = createTestUser(db, 10000000);
    dave = createTestUser(db, 10000000);
  });

  describe('Price priority', () => {
    test('YES taker matches best NO price first (highest NO = best YES price)', () => {
      // Bob offers NO@40 (YES effective: 60%)
      placeOrder(db, bob.id, market.id, 'no', 40, 5000);
      // Carol offers NO@45 (YES effective: 55%) - BETTER for YES taker
      placeOrder(db, carol.id, market.id, 'no', 45, 5000);
      // Dave offers NO@42 (YES effective: 58%)
      placeOrder(db, dave.id, market.id, 'no', 42, 5000);
      
      // Alice buys YES@60 for only 5000 - should match NO@45 first
      const result = placeOrder(db, alice.id, market.id, 'yes', 60, 5000);
      expect(result.matched_bets.length).toBe(1);
      expect(result.matched_bets[0].price).toBe(55); // 100 - 45
      expect(result.matched_bets[0].matchedUserId).toBe(carol.id);
    });

    test('NO taker matches best YES price first (highest YES)', () => {
      // Alice offers YES@70 (NO effective: 30%)
      placeOrder(db, alice.id, market.id, 'yes', 70, 5000);
      // Carol offers YES@75 (NO effective: 25%) - BETTER for NO taker
      placeOrder(db, carol.id, market.id, 'yes', 75, 5000);
      // Dave offers YES@72 (NO effective: 28%)
      placeOrder(db, dave.id, market.id, 'yes', 72, 5000);
      
      // Bob buys NO@30 for only 5000 - should match YES@75 first
      const result = placeOrder(db, bob.id, market.id, 'no', 30, 5000);
      expect(result.matched_bets.length).toBe(1);
      // bet price = 100 - resting YES price = 100 - 75 = 25
      expect(result.matched_bets[0].price).toBe(25);
      expect(result.matched_bets[0].matchedUserId).toBe(carol.id);
    });

    test('fills multiple price levels in order', () => {
      // Three NO orders at different prices
      placeOrder(db, bob.id, market.id, 'no', 45, 3000);  // Best: YES@55
      placeOrder(db, carol.id, market.id, 'no', 43, 3000); // Middle: YES@57
      placeOrder(db, dave.id, market.id, 'no', 40, 3000);  // Worst: YES@60
      
      // Alice buys 9000 - fills all three in price order
      const result = placeOrder(db, alice.id, market.id, 'yes', 60, 9000);
      expect(result.matched_bets.length).toBe(3);
      
      // Verify order: NO@45 → NO@43 → NO@40
      expect(result.matched_bets[0].price).toBe(55);
      expect(result.matched_bets[1].price).toBe(57);
      expect(result.matched_bets[2].price).toBe(60);
    });
  });

  describe('Time priority (same price)', () => {
    test('earlier order at same price filled first', () => {
      // Bob and Carol both post NO@40, Bob first
      createOrderWithTimestamp(db, bob.id, market.id, 'no', 40, 5000, -10); // 10 seconds ago
      createOrderWithTimestamp(db, carol.id, market.id, 'no', 40, 5000, -5);  // 5 seconds ago
      
      // Alice buys only 5000 - should match Bob's order (earlier)
      const result = placeOrder(db, alice.id, market.id, 'yes', 60, 5000);
      expect(result.matched_bets.length).toBe(1);
      expect(result.matched_bets[0].matchedUserId).toBe(bob.id);
    });

    test('later order waits until earlier is filled', () => {
      createOrderWithTimestamp(db, bob.id, market.id, 'no', 40, 5000, -10);
      createOrderWithTimestamp(db, carol.id, market.id, 'no', 40, 5000, -5);
      
      // Alice buys 8000 - fills Bob completely, partially fills Carol
      const result = placeOrder(db, alice.id, market.id, 'yes', 60, 8000);
      expect(result.matched_bets.length).toBe(2);
      expect(result.matched_bets[0].matchedUserId).toBe(bob.id);
      expect(result.matched_bets[0].amount).toBe(5000);
      expect(result.matched_bets[1].matchedUserId).toBe(carol.id);
      expect(result.matched_bets[1].amount).toBe(3000);
    });
  });

  describe('Price-time combined', () => {
    test('better price always beats earlier time', () => {
      // Carol posts NO@45 later (better price)
      createOrderWithTimestamp(db, bob.id, market.id, 'no', 40, 5000, -10);  // Earlier, worse price
      createOrderWithTimestamp(db, carol.id, market.id, 'no', 45, 5000, -5); // Later, better price
      
      // Alice buys 5000 - matches Carol's better price despite later time
      const result = placeOrder(db, alice.id, market.id, 'yes', 60, 5000);
      expect(result.matched_bets[0].matchedUserId).toBe(carol.id);
    });

    test('complex scenario with multiple prices and times', () => {
      // Multiple orders at different prices and times
      createOrderWithTimestamp(db, bob.id, market.id, 'no', 43, 2000, -20);   // Early, mid price
      createOrderWithTimestamp(db, carol.id, market.id, 'no', 45, 3000, -15); // Best price
      createOrderWithTimestamp(db, dave.id, market.id, 'no', 43, 2000, -10);  // Later, same as Bob
      
      // Alice buys 7000
      const result = placeOrder(db, alice.id, market.id, 'yes', 60, 7000);
      
      // Order: Carol (best price) → Bob (earlier at 43) → Dave (later at 43)
      expect(result.matched_bets[0].matchedUserId).toBe(carol.id);
      expect(result.matched_bets[1].matchedUserId).toBe(bob.id);
      expect(result.matched_bets[2].matchedUserId).toBe(dave.id);
    });
  });

  describe('Price improvement scenarios', () => {
    test('multiple prices available, gets best fill', () => {
      placeOrder(db, bob.id, market.id, 'no', 45, 2000);  // YES@55 - Best
      placeOrder(db, carol.id, market.id, 'no', 44, 3000); // YES@56
      placeOrder(db, dave.id, market.id, 'no', 40, 5000);  // YES@60 - Worst
      
      const result = placeOrder(db, alice.id, market.id, 'yes', 60, 10000);
      
      // Should fill at progressively worse prices
      const bets = getMarketBets(db, market.id);
      const prices = bets.map(b => b.price_cents).sort((a, b) => a - b);
      expect(prices).toEqual([55, 56, 60]);
    });
  });
});
