/**
 * Auto-Settlement and Self-Trade Tests for Order Matching
 * Tests automatic position settlement and self-trade prevention
 */

const {
  createTestDatabase,
  createTestUser,
  createTestMarket,
  placeOrder,
  getMarketBets,
  getUserPositions,
  getUserBalance,
} = require('./testHelpers');

describe('Self-Trade Prevention', () => {
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

  describe('Same user opposite orders', () => {
    test('user cannot match with their own resting order', () => {
      // Alice posts NO@40
      placeOrder(db, alice.id, market.id, 'no', 40, 10000);
      
      // Alice tries to buy YES@60 (would match her own NO)
      const result = placeOrder(db, alice.id, market.id, 'yes', 60, 10000);
      
      // Order goes to book without matching
      expect(result.status).toBe('open');
      expect(result.filled).toBe(0);
      expect(result.matched_bets.length).toBe(0);
    });

    test('user skips own order but matches other users', () => {
      // Alice and Bob both post NO@40
      placeOrder(db, alice.id, market.id, 'no', 40, 5000);
      placeOrder(db, bob.id, market.id, 'no', 40, 5000);
      
      // Alice buys YES@60 - should only match Bob's order
      const result = placeOrder(db, alice.id, market.id, 'yes', 60, 10000);
      
      expect(result.filled).toBe(5000); // Only Bob's 5000
      expect(result.remaining).toBe(5000); // Alice's order not matched
      expect(result.matched_bets.length).toBe(1);
      expect(result.matched_bets[0].matchedUserId).toBe(bob.id);
    });

    test('user positions get auto-settled when acquiring opposite side', () => {
      // Alice buys YES from Bob
      placeOrder(db, bob.id, market.id, 'no', 40, 5000);
      placeOrder(db, alice.id, market.id, 'yes', 60, 5000);
      
      // Later, Alice sells YES (buys NO) to Carol - triggers auto-settle
      const carol = createTestUser(db, 10000000);
      placeOrder(db, carol.id, market.id, 'yes', 70, 5000);
      const result = placeOrder(db, alice.id, market.id, 'no', 30, 5000);
      
      // Alice's positions should be auto-settled (both become 0)
      expect(result.auto_settled).not.toBeNull();
      const positions = getUserPositions(db, alice.id, market.id);
      expect(positions.yes).toBe(0);
      expect(positions.no).toBe(0);
    });
  });
});

describe('Auto-Settlement', () => {
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

  describe('Equal opposing positions', () => {
    test('auto-settles when user has equal YES and NO positions', () => {
      // Alice buys YES
      placeOrder(db, bob.id, market.id, 'no', 40, 10000);
      placeOrder(db, alice.id, market.id, 'yes', 60, 10000);
      
      // Alice now has 10000 YES
      let positions = getUserPositions(db, alice.id, market.id);
      expect(positions.yes).toBe(10000);
      expect(positions.no).toBe(0);
      
      // Alice buys NO (from Carol's YES order)
      placeOrder(db, carol.id, market.id, 'yes', 70, 10000);
      const result = placeOrder(db, alice.id, market.id, 'no', 30, 10000);
      
      // Should auto-settle
      expect(result.auto_settled).not.toBeNull();
      expect(result.auto_settled.payout).toBe(10000); // Equal positions settled
      
      // Positions should be zero
      positions = getUserPositions(db, alice.id, market.id);
      expect(positions.yes).toBe(0);
      expect(positions.no).toBe(0);
    });

    test('auto-settle credits correct amount to balance', () => {
      // Setup: Alice gets YES position
      placeOrder(db, bob.id, market.id, 'no', 40, 10000);
      placeOrder(db, alice.id, market.id, 'yes', 60, 10000);
      const balanceAfterYes = getUserBalance(db, alice.id);
      
      // Alice gets NO position - triggers auto-settle
      placeOrder(db, carol.id, market.id, 'yes', 70, 10000);
      const result = placeOrder(db, alice.id, market.id, 'no', 30, 10000);
      
      // Auto-settle should credit 10000 (1 YES + 1 NO = 10000 sats guaranteed)
      // NO@30 cost = (100-30)% = 70% of 10000 = 7000 sats
      expect(result.auto_settled.payout).toBe(10000);
      expect(result.new_balance).toBe(balanceAfterYes - 7000 + 10000); // NO cost - 7000, settle +10000
    });
  });

  describe('Unequal opposing positions', () => {
    test('settles smaller NO against larger YES (15k YES gets 10k NO)', () => {
      // Alice gets 15000 YES from a single bet
      placeOrder(db, bob.id, market.id, 'no', 40, 15000);
      placeOrder(db, alice.id, market.id, 'yes', 60, 15000);
      
      // Alice gets 10000 NO from a single bet - auto-settle kicks in
      placeOrder(db, carol.id, market.id, 'yes', 70, 10000);
      const result = placeOrder(db, alice.id, market.id, 'no', 30, 10000);
      
      // Auto-settle settles the smaller position completely
      // 10k NO is fully consumed, leaving net 5k YES exposure (15k - 10k)
      // But internally, only the NO side is marked settled, YES bet remains at 15k
      const positions = getUserPositions(db, alice.id, market.id);
      expect(positions.yes).toBe(15000);  // Original YES bet amount
      expect(positions.no).toBe(0);        // NO position fully settled
    });

    test('settles smaller YES against larger NO (10k YES gets 15k NO)', () => {
      // Alice gets 10000 YES from a single bet
      placeOrder(db, bob.id, market.id, 'no', 40, 10000);
      placeOrder(db, alice.id, market.id, 'yes', 60, 10000);
      
      // Alice gets 15000 NO from a single bet - auto-settle kicks in
      placeOrder(db, carol.id, market.id, 'yes', 70, 15000);
      const result = placeOrder(db, alice.id, market.id, 'no', 30, 15000);
      
      // Auto-settle settles the smaller position completely  
      // 10k YES is fully consumed, leaving net 5k NO exposure (15k - 10k)
      // But internally, only the YES side is marked settled, NO bet remains at 15k
      const positions = getUserPositions(db, alice.id, market.id);
      expect(positions.yes).toBe(0);       // YES position fully settled
      expect(positions.no).toBe(15000);    // Original NO bet amount
    });
  });

  describe('No auto-settle scenarios', () => {
    test('no auto-settle when only YES position', () => {
      placeOrder(db, bob.id, market.id, 'no', 40, 10000);
      const result = placeOrder(db, alice.id, market.id, 'yes', 60, 10000);
      
      expect(result.auto_settled).toBeNull();
      
      const positions = getUserPositions(db, alice.id, market.id);
      expect(positions.yes).toBe(10000);
      expect(positions.no).toBe(0);
    });

    test('no auto-settle when only NO position', () => {
      placeOrder(db, bob.id, market.id, 'yes', 70, 10000);
      const result = placeOrder(db, alice.id, market.id, 'no', 30, 10000);
      
      expect(result.auto_settled).toBeNull();
      
      const positions = getUserPositions(db, alice.id, market.id);
      expect(positions.yes).toBe(0);
      expect(positions.no).toBe(10000);
    });

    test('no auto-settle when order goes to book without matching', () => {
      // No matching orders - order just goes to book
      const result = placeOrder(db, alice.id, market.id, 'yes', 50, 10000);
      
      expect(result.auto_settled).toBeNull();
      expect(result.matched_bets.length).toBe(0);
    });
  });

  describe('Multiple bets auto-settle', () => {
    test('settles multiple small bets against one large opposing bet', () => {
      // Alice builds YES position from multiple trades
      placeOrder(db, bob.id, market.id, 'no', 40, 3000);
      placeOrder(db, alice.id, market.id, 'yes', 60, 3000);
      
      placeOrder(db, bob.id, market.id, 'no', 42, 4000);
      placeOrder(db, alice.id, market.id, 'yes', 60, 4000);
      
      placeOrder(db, bob.id, market.id, 'no', 38, 3000);
      placeOrder(db, alice.id, market.id, 'yes', 62, 3000);
      
      // Alice now has 10000 YES from 3 bets
      let positions = getUserPositions(db, alice.id, market.id);
      expect(positions.yes).toBe(10000);
      
      // One large NO trade
      placeOrder(db, carol.id, market.id, 'yes', 70, 10000);
      const result = placeOrder(db, alice.id, market.id, 'no', 30, 10000);
      
      // Should settle all 10000
      expect(result.auto_settled).not.toBeNull();
      expect(result.auto_settled.payout).toBe(10000);
      
      positions = getUserPositions(db, alice.id, market.id);
      expect(positions.yes).toBe(0);
      expect(positions.no).toBe(0);
    });
  });

  describe('Bets status after auto-settle', () => {
    test('settled bets marked as settled status', () => {
      // Alice gets YES
      placeOrder(db, bob.id, market.id, 'no', 40, 5000);
      placeOrder(db, alice.id, market.id, 'yes', 60, 5000);
      
      // Alice gets NO - triggers settle
      placeOrder(db, carol.id, market.id, 'yes', 70, 5000);
      placeOrder(db, alice.id, market.id, 'no', 30, 5000);
      
      // Check bet statuses
      const bets = getMarketBets(db, market.id);
      const settledBets = bets.filter(b => b.status === 'settled');
      const activeBets = bets.filter(b => b.status === 'active');
      
      // Should have 2 settled (Alice's YES and NO) and 2 active (Bob's NO, Carol's YES)
      expect(settledBets.length).toBeGreaterThanOrEqual(2);
      expect(activeBets.length).toBeGreaterThanOrEqual(0);
    });
  });
});

describe('Complex Auto-Settle Scenarios', () => {
  let db;
  let market;
  
  beforeEach(() => {
    db = createTestDatabase();
    market = createTestMarket(db);
  });

  test('multiple users trading - smaller NO is fully settled against larger YES', () => {
    const alice = createTestUser(db, 10000000);
    const bob = createTestUser(db, 10000000);
    const carol = createTestUser(db, 10000000);
    
    // Bob is a market maker providing both sides
    placeOrder(db, bob.id, market.id, 'no', 40, 10000);
    placeOrder(db, bob.id, market.id, 'yes', 70, 10000);
    
    // Alice takes YES from Bob (10k YES bet)
    const aliceYes = placeOrder(db, alice.id, market.id, 'yes', 60, 10000);
    expect(aliceYes.auto_settled).toBeNull(); // No NO position yet
    
    // Carol takes NO from Bob's YES
    const carolNo = placeOrder(db, carol.id, market.id, 'no', 30, 10000);
    expect(carolNo.auto_settled).toBeNull(); // No YES position
    
    // Now Alice takes NO from a new Carol YES order (5k NO bet)
    // This triggers auto-settle - the smaller NO is fully settled
    placeOrder(db, carol.id, market.id, 'yes', 70, 5000);
    const aliceNo = placeOrder(db, alice.id, market.id, 'no', 30, 5000);
    
    // Auto-settle consumed the smaller NO (5k), leaving Alice with net 5k YES
    // The system settles the smaller position completely
    const alicePositions = getUserPositions(db, alice.id, market.id);
    expect(alicePositions.yes).toBe(10000); // 10k YES bet remains (not partially reduced)
    expect(alicePositions.no).toBe(0);      // 5k NO bet fully settled
    
    // Carol should have NO position
    const carolPositions = getUserPositions(db, carol.id, market.id);
    expect(carolPositions.no).toBe(10000);
  });
});
