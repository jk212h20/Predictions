/**
 * Validation Tests for Order Matching
 * Tests input validation before matching occurs
 */

const {
  createTestDatabase,
  createTestUser,
  createTestMarket,
  placeOrder,
  getUserBalance,
} = require('./testHelpers');

describe('Order Validation', () => {
  let db;
  let user;
  let market;

  beforeEach(() => {
    db = createTestDatabase();
    user = createTestUser(db, 1000000); // 1M sats
    market = createTestMarket(db);
  });

  describe('Side validation', () => {
    test('rejects invalid side "buy"', () => {
      const result = placeOrder(db, user.id, market.id, 'buy', 50, 10000);
      expect(result.error).toBe('Side must be yes or no');
    });

    test('rejects invalid side "sell"', () => {
      const result = placeOrder(db, user.id, market.id, 'sell', 50, 10000);
      expect(result.error).toBe('Side must be yes or no');
    });

    test('rejects empty side', () => {
      const result = placeOrder(db, user.id, market.id, '', 50, 10000);
      expect(result.error).toBe('Side must be yes or no');
    });

    test('accepts "yes" side', () => {
      const result = placeOrder(db, user.id, market.id, 'yes', 50, 10000);
      expect(result.error).toBeUndefined();
      expect(result.order_id).toBeDefined();
    });

    test('accepts "no" side', () => {
      const result = placeOrder(db, user.id, market.id, 'no', 50, 10000);
      expect(result.error).toBeUndefined();
      expect(result.order_id).toBeDefined();
    });
  });

  describe('Price validation', () => {
    test('rejects price of 0%', () => {
      const result = placeOrder(db, user.id, market.id, 'yes', 0, 10000);
      expect(result.error).toBe('Probability must be between 1% and 99%');
    });

    test('rejects price of 100%', () => {
      const result = placeOrder(db, user.id, market.id, 'yes', 100, 10000);
      expect(result.error).toBe('Probability must be between 1% and 99%');
    });

    test('rejects negative price', () => {
      const result = placeOrder(db, user.id, market.id, 'yes', -5, 10000);
      expect(result.error).toBe('Probability must be between 1% and 99%');
    });

    test('rejects price over 100%', () => {
      const result = placeOrder(db, user.id, market.id, 'yes', 150, 10000);
      expect(result.error).toBe('Probability must be between 1% and 99%');
    });

    test('accepts minimum price of 1%', () => {
      const result = placeOrder(db, user.id, market.id, 'yes', 1, 10000);
      expect(result.error).toBeUndefined();
      expect(result.order_id).toBeDefined();
    });

    test('accepts maximum price of 99%', () => {
      const result = placeOrder(db, user.id, market.id, 'yes', 99, 10000);
      expect(result.error).toBeUndefined();
      expect(result.order_id).toBeDefined();
    });

    test('accepts mid-range price of 50%', () => {
      const result = placeOrder(db, user.id, market.id, 'yes', 50, 10000);
      expect(result.error).toBeUndefined();
      expect(result.order_id).toBeDefined();
    });
  });

  describe('Amount validation', () => {
    test('rejects amount below minimum (99 sats)', () => {
      const result = placeOrder(db, user.id, market.id, 'yes', 50, 99);
      expect(result.error).toBe('Minimum order is 100 sats');
    });

    test('accepts minimum amount (100 sats)', () => {
      const result = placeOrder(db, user.id, market.id, 'yes', 50, 100);
      expect(result.error).toBeUndefined();
      expect(result.order_id).toBeDefined();
    });

    test('accepts large amount (1M sats)', () => {
      const result = placeOrder(db, user.id, market.id, 'yes', 50, 1000000);
      expect(result.error).toBeUndefined();
      expect(result.order_id).toBeDefined();
    });
  });

  describe('Market status validation', () => {
    test('rejects order on closed market', () => {
      const closedMarket = createTestMarket(db, { status: 'resolved' });
      const result = placeOrder(db, user.id, closedMarket.id, 'yes', 50, 10000);
      expect(result.error).toBe('Market not available for trading');
    });

    test('rejects order on pending resolution market', () => {
      const pendingMarket = createTestMarket(db, { status: 'pending_resolution' });
      const result = placeOrder(db, user.id, pendingMarket.id, 'yes', 50, 10000);
      expect(result.error).toBe('Market not available for trading');
    });

    test('rejects order on cancelled market', () => {
      const cancelledMarket = createTestMarket(db, { status: 'cancelled' });
      const result = placeOrder(db, user.id, cancelledMarket.id, 'yes', 50, 10000);
      expect(result.error).toBe('Market not available for trading');
    });

    test('rejects order on non-existent market', () => {
      const result = placeOrder(db, user.id, 'non-existent-id', 'yes', 50, 10000);
      expect(result.error).toBe('Market not available for trading');
    });

    test('accepts order on open market', () => {
      const result = placeOrder(db, user.id, market.id, 'yes', 50, 10000);
      expect(result.error).toBeUndefined();
      expect(result.order_id).toBeDefined();
    });
  });

  describe('Balance validation', () => {
    test('rejects YES order when balance insufficient', () => {
      const poorUser = createTestUser(db, 100); // Only 100 sats
      // YES@50% for 10000 sats costs 5000 sats
      const result = placeOrder(db, poorUser.id, market.id, 'yes', 50, 10000);
      expect(result.error).toBe('Insufficient balance');
      expect(result.required).toBe(5000);
      expect(result.available).toBe(100);
    });

    test('rejects NO order when balance insufficient', () => {
      const poorUser = createTestUser(db, 100); // Only 100 sats
      // NO@50% for 10000 sats costs 5000 sats (100-50=50%)
      const result = placeOrder(db, poorUser.id, market.id, 'no', 50, 10000);
      expect(result.error).toBe('Insufficient balance');
      expect(result.required).toBe(5000);
      expect(result.available).toBe(100);
    });

    test('accepts order when balance exactly sufficient', () => {
      const exactUser = createTestUser(db, 5000); // Exactly enough
      // YES@50% for 10000 sats costs 5000 sats
      const result = placeOrder(db, exactUser.id, market.id, 'yes', 50, 10000);
      expect(result.error).toBeUndefined();
      expect(result.order_id).toBeDefined();
      expect(getUserBalance(db, exactUser.id)).toBe(0);
    });

    test('deducts correct balance for YES order', () => {
      const initialBalance = getUserBalance(db, user.id);
      // YES@60% for 10000 sats costs 6000 sats
      placeOrder(db, user.id, market.id, 'yes', 60, 10000);
      expect(getUserBalance(db, user.id)).toBe(initialBalance - 6000);
    });

    test('deducts correct balance for NO order', () => {
      const initialBalance = getUserBalance(db, user.id);
      // NO@60% for 10000 sats costs 4000 sats (100-60=40%)
      placeOrder(db, user.id, market.id, 'no', 60, 10000);
      expect(getUserBalance(db, user.id)).toBe(initialBalance - 4000);
    });
  });
});
