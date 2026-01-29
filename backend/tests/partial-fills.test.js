/**
 * Partial Fill Tests for Order Matching
 * Tests scenarios where orders are partially filled
 */

const {
  createTestDatabase,
  createTestUser,
  createTestMarket,
  placeOrder,
  getOrder,
  getMarketBets,
  getMarketOrders,
} = require('./testHelpers');

describe('Partial Fills', () => {
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

  describe('Order larger than liquidity', () => {
    test('YES order partially fills against smaller NO order', () => {
      // Bob provides 5000 sats of liquidity
      placeOrder(db, bob.id, market.id, 'no', 40, 5000);
      
      // Alice wants 10000 sats but only 5000 available
      const result = placeOrder(db, alice.id, market.id, 'yes', 60, 10000);
      expect(result.status).toBe('partial');
      expect(result.filled).toBe(5000);
      expect(result.remaining).toBe(5000);
      expect(result.matched_bets.length).toBe(1);
    });

    test('partial order goes to book for remaining amount', () => {
      placeOrder(db, bob.id, market.id, 'no', 40, 3000);
      
      const result = placeOrder(db, alice.id, market.id, 'yes', 60, 10000);
      
      const order = getOrder(db, result.order_id);
      expect(order.status).toBe('partial');
      expect(order.amount_sats).toBe(10000);
      expect(order.filled_sats).toBe(3000);
    });

    test('resting order fully consumed becomes filled', () => {
      const noResult = placeOrder(db, bob.id, market.id, 'no', 40, 3000);
      
      placeOrder(db, alice.id, market.id, 'yes', 60, 10000);
      
      const restingOrder = getOrder(db, noResult.order_id);
      expect(restingOrder.status).toBe('filled');
      expect(restingOrder.filled_sats).toBe(3000);
    });
  });

  describe('Multiple orders to fill', () => {
    test('YES order fills against multiple NO orders', () => {
      // Multiple NO orders at different prices
      placeOrder(db, bob.id, market.id, 'no', 45, 3000);   // Best for taker
      placeOrder(db, carol.id, market.id, 'no', 42, 4000); // Second best
      placeOrder(db, bob.id, market.id, 'no', 40, 5000);   // Third
      
      // Alice buys 10000 - fills first two completely, partial on third
      const result = placeOrder(db, alice.id, market.id, 'yes', 60, 10000);
      expect(result.status).toBe('filled');
      expect(result.filled).toBe(10000);
      expect(result.matched_bets.length).toBe(3);
      
      // Verify fill amounts
      expect(result.matched_bets[0].amount).toBe(3000); // NO@45
      expect(result.matched_bets[1].amount).toBe(4000); // NO@42
      expect(result.matched_bets[2].amount).toBe(3000); // NO@40 (partial)
    });

    test('creates multiple bets for multiple matches', () => {
      placeOrder(db, bob.id, market.id, 'no', 45, 5000);
      placeOrder(db, carol.id, market.id, 'no', 43, 5000);
      
      placeOrder(db, alice.id, market.id, 'yes', 60, 10000);
      
      const bets = getMarketBets(db, market.id);
      expect(bets.length).toBe(2);
      
      // Each bet should have correct users
      const bet1 = bets.find(b => b.amount_sats === 5000 && b.price_cents === 55);
      const bet2 = bets.find(b => b.amount_sats === 5000 && b.price_cents === 57);
      expect(bet1.no_user_id).toBe(bob.id);
      expect(bet2.no_user_id).toBe(carol.id);
    });

    test('stops matching when all liquidity consumed', () => {
      placeOrder(db, bob.id, market.id, 'no', 45, 2000);
      placeOrder(db, carol.id, market.id, 'no', 43, 3000);
      
      const result = placeOrder(db, alice.id, market.id, 'yes', 60, 10000);
      expect(result.status).toBe('partial');
      expect(result.filled).toBe(5000);
      expect(result.remaining).toBe(5000);
    });
  });

  describe('Order smaller than resting order', () => {
    test('small YES partially fills large NO order', () => {
      const noResult = placeOrder(db, bob.id, market.id, 'no', 40, 100000);
      expect(noResult.status).toBe('open');
      
      const yesResult = placeOrder(db, alice.id, market.id, 'yes', 60, 5000);
      expect(yesResult.status).toBe('filled');
      expect(yesResult.filled).toBe(5000);
      
      // NO order should be partial now
      const noOrder = getOrder(db, noResult.order_id);
      expect(noOrder.status).toBe('partial');
      expect(noOrder.filled_sats).toBe(5000);
    });

    test('multiple small orders can fill one large order', () => {
      const noResult = placeOrder(db, bob.id, market.id, 'no', 40, 10000);
      
      // Three small orders
      placeOrder(db, alice.id, market.id, 'yes', 60, 3000);
      placeOrder(db, carol.id, market.id, 'yes', 60, 3000);
      placeOrder(db, alice.id, market.id, 'yes', 60, 4000);
      
      // NO order should now be filled
      const noOrder = getOrder(db, noResult.order_id);
      expect(noOrder.status).toBe('filled');
      expect(noOrder.filled_sats).toBe(10000);
      
      // Should have 3 bets
      const bets = getMarketBets(db, market.id);
      expect(bets.length).toBe(3);
    });
  });

  describe('Exactly equal amounts', () => {
    test('equal amounts result in both orders filled', () => {
      const noResult = placeOrder(db, bob.id, market.id, 'no', 40, 10000);
      const yesResult = placeOrder(db, alice.id, market.id, 'yes', 60, 10000);
      
      expect(yesResult.status).toBe('filled');
      
      const noOrder = getOrder(db, noResult.order_id);
      const yesOrder = getOrder(db, yesResult.order_id);
      
      expect(noOrder.status).toBe('filled');
      expect(yesOrder.status).toBe('filled');
    });
  });

  describe('Partial fill with remaining liquidity', () => {
    test('resting order remains available after partial fill', () => {
      // Large NO order
      placeOrder(db, bob.id, market.id, 'no', 40, 20000);
      
      // First fill
      placeOrder(db, alice.id, market.id, 'yes', 60, 5000);
      
      // Second fill from different user
      const result = placeOrder(db, carol.id, market.id, 'yes', 60, 5000);
      expect(result.status).toBe('filled');
      
      // Check open orders - should have NO order with 10000 remaining
      const openOrders = getMarketOrders(db, market.id, 'partial');
      expect(openOrders.length).toBe(1);
      expect(openOrders[0].amount_sats - openOrders[0].filled_sats).toBe(10000);
    });
  });

  describe('Mixed partial scenarios', () => {
    test('complex scenario with partial fills on both sides', () => {
      // Bob posts large NO order
      placeOrder(db, bob.id, market.id, 'no', 40, 15000);
      
      // Alice partially fills
      const result1 = placeOrder(db, alice.id, market.id, 'yes', 60, 5000);
      expect(result1.status).toBe('filled');
      
      // Carol posts YES at different price (won't match)
      const result2 = placeOrder(db, carol.id, market.id, 'yes', 55, 8000);
      expect(result2.status).toBe('open');
      
      // Bob posts more NO that matches Carol's order
      const result3 = placeOrder(db, bob.id, market.id, 'no', 45, 8000);
      expect(result3.status).toBe('filled');
      
      const bets = getMarketBets(db, market.id);
      expect(bets.length).toBe(2);
    });
  });
});
