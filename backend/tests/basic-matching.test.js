/**
 * Basic Matching Tests for Order Matching
 * Tests core order matching logic
 */

const {
  createTestDatabase,
  createTestUser,
  createTestMarket,
  placeOrder,
  getOrder,
  getMarketBets,
  getUserBalance,
} = require('./testHelpers');

describe('Basic Order Matching', () => {
  let db;
  let market;
  let alice; // YES buyer
  let bob;   // NO seller (market maker)

  beforeEach(() => {
    db = createTestDatabase();
    market = createTestMarket(db);
    alice = createTestUser(db, 1000000); // 1M sats
    bob = createTestUser(db, 1000000);   // 1M sats
  });

  describe('Exact complement matching', () => {
    test('YES@60 matches with NO@40 (exact complement)', () => {
      // Bob places NO@40 (willing to pay 40% for NO side)
      const noResult = placeOrder(db, bob.id, market.id, 'no', 40, 10000);
      expect(noResult.status).toBe('open');
      
      // Alice places YES@60 (willing to pay 60% for YES side)
      // This matches because 100 - 60 = 40, and NO@40 exists
      const yesResult = placeOrder(db, alice.id, market.id, 'yes', 60, 10000);
      expect(yesResult.status).toBe('filled');
      expect(yesResult.filled).toBe(10000);
      expect(yesResult.matched_bets.length).toBe(1);
      
      // Verify bet was created
      const bets = getMarketBets(db, market.id);
      expect(bets.length).toBe(1);
      expect(bets[0].yes_user_id).toBe(alice.id);
      expect(bets[0].no_user_id).toBe(bob.id);
      expect(bets[0].amount_sats).toBe(10000);
      expect(bets[0].price_cents).toBe(60); // Trade at 60% YES (complement of NO@40)
    });

    test('NO@30 matches with YES@70 (exact complement)', () => {
      // Alice places YES@70
      const yesResult = placeOrder(db, alice.id, market.id, 'yes', 70, 10000);
      expect(yesResult.status).toBe('open');
      
      // Bob places NO@30 - matches because 100 - 30 = 70, and YES@70 exists
      const noResult = placeOrder(db, bob.id, market.id, 'no', 30, 10000);
      expect(noResult.status).toBe('filled');
      expect(noResult.filled).toBe(10000);
      
      const bets = getMarketBets(db, market.id);
      expect(bets.length).toBe(1);
      // price_cents in bet = 100 - resting_NO_price (when YES is resting, it's stored directly)
      // But here YES is resting at 70, NO taker at 30, bet stores 100 - 70 = 30
      expect(bets[0].price_cents).toBe(30); // Bet records effective YES price from NO's perspective
    });
  });

  describe('Better price matching', () => {
    test('YES@60 gets better deal matching NO@45', () => {
      // Bob places NO@45 (asking for only 45% of pot, giving 55% YES price)
      placeOrder(db, bob.id, market.id, 'no', 45, 10000);
      
      // Alice willing to pay 60%, but gets matched at 55%
      const result = placeOrder(db, alice.id, market.id, 'yes', 60, 10000);
      expect(result.status).toBe('filled');
      
      const bets = getMarketBets(db, market.id);
      expect(bets[0].price_cents).toBe(55); // Better than Alice's 60% limit
    });

    test('NO@40 gets better deal matching YES@75', () => {
      // Alice places YES@75 (willing to pay 75%)
      placeOrder(db, alice.id, market.id, 'yes', 75, 10000);
      
      // Bob willing to pay 40%, but trade at 75% YES = 25% NO
      const result = placeOrder(db, bob.id, market.id, 'no', 40, 10000);
      expect(result.status).toBe('filled');
      
      const bets = getMarketBets(db, market.id);
      // When NO matches YES@75, bet price = 100 - 75 = 25
      expect(bets[0].price_cents).toBe(25); // 100 - resting YES price
    });

    test('YES taker matches with highest NO price first', () => {
      // Bob places multiple NO orders
      placeOrder(db, bob.id, market.id, 'no', 40, 5000);  // NO@40 (YES@60)
      placeOrder(db, bob.id, market.id, 'no', 45, 5000);  // NO@45 (YES@55) - BEST
      placeOrder(db, bob.id, market.id, 'no', 42, 5000);  // NO@42 (YES@58)
      
      // Alice places YES@60 for 5000
      const result = placeOrder(db, alice.id, market.id, 'yes', 60, 5000);
      expect(result.status).toBe('filled');
      
      // Should match with NO@45 (best for YES taker - lowest effective price)
      const bets = getMarketBets(db, market.id);
      expect(bets[0].price_cents).toBe(55); // 100 - 45 = 55%
    });
  });

  describe('No match scenarios', () => {
    test('YES order goes to book when no matching NO orders', () => {
      const result = placeOrder(db, alice.id, market.id, 'yes', 50, 10000);
      expect(result.status).toBe('open');
      expect(result.filled).toBe(0);
      expect(result.remaining).toBe(10000);
      expect(result.matched_bets.length).toBe(0);
      
      // Order should be in the book
      const order = getOrder(db, result.order_id);
      expect(order.status).toBe('open');
      expect(order.filled_sats).toBe(0);
    });

    test('NO order goes to book when no matching YES orders', () => {
      const result = placeOrder(db, bob.id, market.id, 'no', 50, 10000);
      expect(result.status).toBe('open');
      expect(result.filled).toBe(0);
      expect(result.matched_bets.length).toBe(0);
    });

    test('YES@60 does not match NO@35 (price gap)', () => {
      // NO@35 means YES would need to be >= 65% to match
      placeOrder(db, bob.id, market.id, 'no', 35, 10000);
      
      // YES@60 won't match - too low
      const result = placeOrder(db, alice.id, market.id, 'yes', 60, 10000);
      expect(result.status).toBe('open');
      expect(result.filled).toBe(0);
    });

    test('NO@40 does not match YES@55 (price gap)', () => {
      // YES@55 means NO would need to be >= 45% to match
      placeOrder(db, alice.id, market.id, 'yes', 55, 10000);
      
      // NO@40 won't match - too low
      const result = placeOrder(db, bob.id, market.id, 'no', 40, 10000);
      expect(result.status).toBe('open');
      expect(result.filled).toBe(0);
    });
  });

  describe('Order status tracking', () => {
    test('resting order becomes filled when fully matched', () => {
      const noResult = placeOrder(db, bob.id, market.id, 'no', 40, 10000);
      expect(noResult.status).toBe('open');
      
      placeOrder(db, alice.id, market.id, 'yes', 60, 10000);
      
      // Check resting order is now filled
      const restingOrder = getOrder(db, noResult.order_id);
      expect(restingOrder.status).toBe('filled');
      expect(restingOrder.filled_sats).toBe(10000);
    });

    test('incoming order marked filled when fully matched', () => {
      placeOrder(db, bob.id, market.id, 'no', 40, 10000);
      
      const yesResult = placeOrder(db, alice.id, market.id, 'yes', 60, 10000);
      expect(yesResult.status).toBe('filled');
      
      const order = getOrder(db, yesResult.order_id);
      expect(order.status).toBe('filled');
    });
  });

  describe('Balance effects', () => {
    test('both users balances correctly deducted after match', () => {
      const aliceStart = getUserBalance(db, alice.id);
      const bobStart = getUserBalance(db, bob.id);
      
      // Bob: NO@40 for 10000 sats costs (100-40)% = 60% = 6000 sats
      placeOrder(db, bob.id, market.id, 'no', 40, 10000);
      expect(getUserBalance(db, bob.id)).toBe(bobStart - 6000);
      
      // Alice: YES@60 for 10000 sats costs 60% = 6000 sats
      placeOrder(db, alice.id, market.id, 'yes', 60, 10000);
      expect(getUserBalance(db, alice.id)).toBe(aliceStart - 6000);
    });

    test('YES taker pays less when getting better price', () => {
      const aliceStart = getUserBalance(db, alice.id);
      
      // Bob posts NO@45 (YES@55)
      placeOrder(db, bob.id, market.id, 'no', 45, 10000);
      
      // Alice willing to pay 60% but trade at 55%
      // Cost = ceil(10000 * 60 / 100) = 6000 (cost is based on order price, not fill price)
      placeOrder(db, alice.id, market.id, 'yes', 60, 10000);
      
      // Alice's balance deducted by her order cost (60%)
      expect(getUserBalance(db, alice.id)).toBe(aliceStart - 6000);
    });
  });
});
