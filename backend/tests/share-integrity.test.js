/**
 * Share Integrity Tests
 * 
 * Tests that all matched amounts are whole shares (multiples of 1000 sats).
 * This addresses the pending bug investigation from progress.md where
 * match amounts of 22,294 sats (not divisible by 1000) were observed.
 * 
 * INVARIANT: 1 share = 1000 sats payout
 * All bet amounts must be multiples of 1000.
 */

const {
  createTestDatabase,
  createTestUser,
  createTestMarket,
  placeOrder,
  getMarketBets,
  getOrder,
  getMarketOrders,
} = require('./testHelpers');

describe('Share Integrity - All Amounts Must Be Whole Shares', () => {
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

  describe('Single Order Matching', () => {
    test('matched bet amount is multiple of 1000', () => {
      // Place orders that should match
      placeOrder(db, bob.id, market.id, 'no', 40, 10000);
      placeOrder(db, alice.id, market.id, 'yes', 60, 10000);
      
      const bets = getMarketBets(db, market.id);
      expect(bets.length).toBe(1);
      expect(bets[0].amount_sats % 1000).toBe(0);
    });

    test('partial fill amount is multiple of 1000', () => {
      placeOrder(db, bob.id, market.id, 'no', 40, 5000); // 5 shares
      const result = placeOrder(db, alice.id, market.id, 'yes', 60, 10000); // wants 10 shares
      
      // Should fill 5000 (5 shares) and leave 5000 remaining
      expect(result.filled).toBe(5000);
      expect(result.filled % 1000).toBe(0);
      expect(result.remaining % 1000).toBe(0);
      
      const bets = getMarketBets(db, market.id);
      bets.forEach(bet => {
        expect(bet.amount_sats % 1000).toBe(0);
      });
    });

    test('order amounts must be multiples of 1000 (whole shares)', () => {
      // Orders should ideally be for whole shares
      // 7000 sats = 7 shares - valid
      const result1 = placeOrder(db, bob.id, market.id, 'no', 40, 7000);
      expect(result1.error).toBeUndefined();
      
      // 10000 sats = 10 shares - valid
      const result2 = placeOrder(db, alice.id, market.id, 'yes', 60, 10000);
      expect(result2.filled % 1000).toBe(0);
    });
  });

  describe('Multiple Partial Fills', () => {
    test('all fill amounts from multiple matches are multiples of 1000', () => {
      // Create multiple NO orders
      placeOrder(db, bob.id, market.id, 'no', 45, 3000);  // 3 shares
      placeOrder(db, carol.id, market.id, 'no', 42, 4000); // 4 shares
      placeOrder(db, bob.id, market.id, 'no', 40, 5000);  // 5 shares
      
      // Alice buys 10 shares (10000 sats)
      const result = placeOrder(db, alice.id, market.id, 'yes', 60, 10000);
      
      // All matched amounts should be whole shares
      result.matched_bets.forEach(match => {
        expect(match.amount % 1000).toBe(0);
      });
      
      const bets = getMarketBets(db, market.id);
      bets.forEach(bet => {
        expect(bet.amount_sats % 1000).toBe(0);
      });
    });

    test('cascading fills maintain share integrity', () => {
      // Large NO order
      placeOrder(db, bob.id, market.id, 'no', 40, 20000); // 20 shares
      
      // Multiple small YES orders
      for (let i = 0; i < 5; i++) {
        const result = placeOrder(db, alice.id, market.id, 'yes', 60, 3000);
        expect(result.filled % 1000).toBe(0);
      }
      
      const bets = getMarketBets(db, market.id);
      bets.forEach(bet => {
        expect(bet.amount_sats % 1000).toBe(0);
      });
    });
  });

  describe('Order Remainder Integrity', () => {
    test('unfilled order remainder is whole shares', () => {
      placeOrder(db, bob.id, market.id, 'no', 40, 3000);
      const result = placeOrder(db, alice.id, market.id, 'yes', 60, 10000);
      
      expect(result.status).toBe('partial');
      expect(result.remaining).toBe(7000); // 7 shares remaining
      expect(result.remaining % 1000).toBe(0);
      
      const order = getOrder(db, result.order_id);
      const remaining = order.amount_sats - order.filled_sats;
      expect(remaining % 1000).toBe(0);
    });

    test('resting order after partial fill has whole shares remaining', () => {
      const noResult = placeOrder(db, bob.id, market.id, 'no', 40, 10000);
      placeOrder(db, alice.id, market.id, 'yes', 60, 3000);
      
      const noOrder = getOrder(db, noResult.order_id);
      const remaining = noOrder.amount_sats - noOrder.filled_sats;
      expect(remaining).toBe(7000); // 7 shares remaining
      expect(remaining % 1000).toBe(0);
    });
  });

  describe('Minimum Share Size', () => {
    test('minimum order is 1 share (1000 sats)', () => {
      // Minimum meaningful order is 1000 sats
      const result = placeOrder(db, alice.id, market.id, 'yes', 50, 1000);
      expect(result.error).toBeUndefined();
      expect(result.order_id).toBeDefined();
    });

    test('very small match still respects share boundary', () => {
      placeOrder(db, bob.id, market.id, 'no', 40, 1000); // 1 share
      const result = placeOrder(db, alice.id, market.id, 'yes', 60, 5000);
      
      expect(result.filled).toBe(1000);
      expect(result.remaining).toBe(4000);
      
      const bets = getMarketBets(db, market.id);
      expect(bets.length).toBe(1);
      expect(bets[0].amount_sats).toBe(1000);
    });
  });

  describe('Edge Cases That Could Break Share Integrity', () => {
    test('orders at various prices maintain share integrity', () => {
      // Test across different price points
      const prices = [1, 10, 25, 33, 50, 67, 75, 90, 99];
      
      prices.forEach(price => {
        const testMarket = createTestMarket(db);
        const user1 = createTestUser(db, 10000000);
        const user2 = createTestUser(db, 10000000);
        
        placeOrder(db, user1.id, testMarket.id, 'no', price, 5000);
        placeOrder(db, user2.id, testMarket.id, 'yes', 100 - price, 5000);
        
        const bets = getMarketBets(db, testMarket.id);
        bets.forEach(bet => {
          expect(bet.amount_sats % 1000).toBe(0);
        });
      });
    });

    test('rapid sequential orders maintain share integrity', () => {
      // Simulate rapid trading
      placeOrder(db, bob.id, market.id, 'no', 40, 50000);
      
      for (let i = 0; i < 20; i++) {
        const result = placeOrder(db, alice.id, market.id, 'yes', 60, 2000);
        expect(result.filled % 1000).toBe(0);
      }
      
      const bets = getMarketBets(db, market.id);
      bets.forEach(bet => {
        expect(bet.amount_sats % 1000).toBe(0);
      });
    });

    test('mismatched amounts still produce whole share fills', () => {
      // Order sizes that don't divide evenly
      placeOrder(db, bob.id, market.id, 'no', 40, 7000);   // 7 shares
      placeOrder(db, carol.id, market.id, 'no', 40, 3000); // 3 shares
      
      const result = placeOrder(db, alice.id, market.id, 'yes', 60, 8000); // wants 8 shares
      
      // Should fill 7 from bob, 1 from carol (or similar)
      expect(result.filled).toBe(8000);
      
      result.matched_bets.forEach(match => {
        expect(match.amount % 1000).toBe(0);
      });
    });
  });

  describe('Invariant: Bet Amount = Shares × 1000', () => {
    test('bet amount always equals shares times 1000', () => {
      // Complex scenario with multiple orders and prices
      placeOrder(db, bob.id, market.id, 'no', 45, 6000);
      placeOrder(db, carol.id, market.id, 'no', 43, 8000);
      placeOrder(db, bob.id, market.id, 'no', 40, 10000);
      
      placeOrder(db, alice.id, market.id, 'yes', 60, 15000);
      
      const bets = getMarketBets(db, market.id);
      
      bets.forEach(bet => {
        const shares = bet.amount_sats / 1000;
        expect(Number.isInteger(shares)).toBe(true);
        expect(shares).toBeGreaterThan(0);
      });
    });
  });
});

describe('Share Integrity - Stress Tests', () => {
  let db;
  let market;
  
  beforeEach(() => {
    db = createTestDatabase();
    market = createTestMarket(db);
  });

  test('100 random orders maintain share integrity', () => {
    const users = [];
    for (let i = 0; i < 10; i++) {
      users.push(createTestUser(db, 100000000));
    }
    
    // Place 100 random orders
    for (let i = 0; i < 100; i++) {
      const user = users[i % users.length];
      const side = Math.random() > 0.5 ? 'yes' : 'no';
      const price = Math.floor(Math.random() * 89) + 5; // 5-94
      const shares = Math.floor(Math.random() * 10) + 1; // 1-10 shares
      const amount = shares * 1000;
      
      const result = placeOrder(db, user.id, market.id, side, price, amount);
      
      if (result.filled > 0) {
        expect(result.filled % 1000).toBe(0);
      }
      if (result.remaining > 0) {
        expect(result.remaining % 1000).toBe(0);
      }
    }
    
    // Verify all bets
    const bets = getMarketBets(db, market.id);
    bets.forEach(bet => {
      expect(bet.amount_sats % 1000).toBe(0);
    });
    
    // Verify all orders
    const orders = getMarketOrders(db, market.id);
    orders.forEach(order => {
      expect(order.amount_sats % 1000).toBe(0);
      expect(order.filled_sats % 1000).toBe(0);
    });
  });
});
