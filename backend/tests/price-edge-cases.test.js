/**
 * Price Edge Case Tests for Order Matching
 * Tests boundary conditions for pricing
 */

const {
  createTestDatabase,
  createTestUser,
  createTestMarket,
  placeOrder,
  getMarketBets,
} = require('./testHelpers');

describe('Price Edge Cases', () => {
  let db;
  let market;
  let alice;
  let bob;

  beforeEach(() => {
    db = createTestDatabase();
    market = createTestMarket(db);
    alice = createTestUser(db, 10000000); // 10M sats
    bob = createTestUser(db, 10000000);
  });

  describe('Minimum price (1%)', () => {
    test('YES@1 order accepted and correctly priced', () => {
      const result = placeOrder(db, alice.id, market.id, 'yes', 1, 10000);
      expect(result.error).toBeUndefined();
      expect(result.cost).toBe(100); // ceil(10000 * 1 / 100) = 100
    });

    test('NO@1 order accepted and correctly priced', () => {
      const result = placeOrder(db, bob.id, market.id, 'no', 1, 10000);
      expect(result.error).toBeUndefined();
      expect(result.cost).toBe(9900); // ceil(10000 * 99 / 100) = 9900
    });

    test('YES@1 matches with NO@99', () => {
      placeOrder(db, bob.id, market.id, 'no', 99, 10000);
      const result = placeOrder(db, alice.id, market.id, 'yes', 1, 10000);
      expect(result.status).toBe('filled');
      
      const bets = getMarketBets(db, market.id);
      expect(bets[0].price_cents).toBe(1);
    });
  });

  describe('Maximum price (99%)', () => {
    test('YES@99 order accepted and correctly priced', () => {
      const result = placeOrder(db, alice.id, market.id, 'yes', 99, 10000);
      expect(result.error).toBeUndefined();
      expect(result.cost).toBe(9900); // ceil(10000 * 99 / 100) = 9900
    });

    test('NO@99 order accepted and correctly priced', () => {
      const result = placeOrder(db, bob.id, market.id, 'no', 99, 10000);
      expect(result.error).toBeUndefined();
      expect(result.cost).toBe(100); // ceil(10000 * 1 / 100) = 100
    });

    test('YES@99 matches with NO@1', () => {
      placeOrder(db, bob.id, market.id, 'no', 1, 10000);
      const result = placeOrder(db, alice.id, market.id, 'yes', 99, 10000);
      expect(result.status).toBe('filled');
      
      const bets = getMarketBets(db, market.id);
      expect(bets[0].price_cents).toBe(99);
    });
  });

  describe('50/50 price point', () => {
    test('YES@50 matches with NO@50 exactly', () => {
      placeOrder(db, bob.id, market.id, 'no', 50, 10000);
      const result = placeOrder(db, alice.id, market.id, 'yes', 50, 10000);
      expect(result.status).toBe('filled');
      
      const bets = getMarketBets(db, market.id);
      expect(bets[0].price_cents).toBe(50);
    });

    test('YES@50 and NO@50 have equal costs', () => {
      const yesResult = placeOrder(db, alice.id, market.id, 'yes', 50, 10000);
      const noResult = placeOrder(db, bob.id, market.id, 'no', 50, 10000);
      expect(yesResult.cost).toBe(5000);
      expect(noResult.cost).toBe(5000);
    });
  });

  describe('Threshold boundary matching', () => {
    test('YES@50 does NOT match NO@49 (just below threshold)', () => {
      // YES@50 needs NO >= 50 to match (100 - 50 = 50)
      placeOrder(db, bob.id, market.id, 'no', 49, 10000);
      const result = placeOrder(db, alice.id, market.id, 'yes', 50, 10000);
      expect(result.status).toBe('open');
      expect(result.filled).toBe(0);
    });

    test('YES@51 matches NO@49 (just crosses threshold)', () => {
      // YES@51 needs NO >= 49 (100 - 51 = 49)
      placeOrder(db, bob.id, market.id, 'no', 49, 10000);
      const result = placeOrder(db, alice.id, market.id, 'yes', 51, 10000);
      expect(result.status).toBe('filled');
    });

    test('NO@50 does NOT match YES@49 (just below threshold)', () => {
      // NO@50 needs YES >= 50 to match (100 - 50 = 50)
      placeOrder(db, alice.id, market.id, 'yes', 49, 10000);
      const result = placeOrder(db, bob.id, market.id, 'no', 50, 10000);
      expect(result.status).toBe('open');
      expect(result.filled).toBe(0);
    });

    test('NO@49 matches YES@51 (just crosses threshold)', () => {
      // NO@49 needs YES >= 51 (100 - 49 = 51)
      placeOrder(db, alice.id, market.id, 'yes', 51, 10000);
      const result = placeOrder(db, bob.id, market.id, 'no', 49, 10000);
      expect(result.status).toBe('filled');
    });
  });

  describe('Wide spread scenarios', () => {
    test('YES@10 does not match NO@10 (80% gap)', () => {
      // YES@10 needs NO >= 90 (100 - 10 = 90)
      // NO@10 available, but only gives YES price of 90%, not enough
      placeOrder(db, bob.id, market.id, 'no', 10, 10000);
      const result = placeOrder(db, alice.id, market.id, 'yes', 10, 10000);
      expect(result.status).toBe('open');
    });

    test('YES@90 matches NO@10 (tight complement)', () => {
      // YES@90 needs NO >= 10 (100 - 90 = 10)
      placeOrder(db, bob.id, market.id, 'no', 10, 10000);
      const result = placeOrder(db, alice.id, market.id, 'yes', 90, 10000);
      expect(result.status).toBe('filled');
    });
  });

  describe('Asymmetric pricing', () => {
    test('highly bullish YES@95 trades correctly', () => {
      placeOrder(db, bob.id, market.id, 'no', 5, 10000);
      const result = placeOrder(db, alice.id, market.id, 'yes', 95, 10000);
      expect(result.status).toBe('filled');
      
      const bets = getMarketBets(db, market.id);
      expect(bets[0].price_cents).toBe(95);
    });

    test('highly bearish NO@95 trades correctly', () => {
      placeOrder(db, alice.id, market.id, 'yes', 5, 10000);
      const result = placeOrder(db, bob.id, market.id, 'no', 95, 10000);
      expect(result.status).toBe('filled');
      
      const bets = getMarketBets(db, market.id);
      // When NO matches YES@5, bet price = 100 - 5 = 95
      expect(bets[0].price_cents).toBe(95);
    });
  });
});
