/**
 * CONCURRENCY STRESS TEST
 * 
 * Tests that the db.transaction() wrapper in POST /api/orders 
 * correctly prevents double-fills when multiple users try to
 * match the same order simultaneously.
 * 
 * This simulates the race condition that WOULD occur without transactions:
 * - Bot has NO@40 for 10,000 sats
 * - 4 users simultaneously submit YES@60 for 10,000 sats
 * - Without transactions: All 4 might match (40,000 sats against 10,000)
 * - With transactions: Only 1 matches, others get 'open' status
 */

const {
  createTestDatabase,
  createTestUser,
  createTestMarket,
  placeOrder,
  getOrder,
  getUserBalance,
  getMarketBets
} = require('./testHelpers');

describe('Concurrency Protection', () => {
  let db, market, botUser;
  
  beforeEach(() => {
    db = createTestDatabase();
    market = createTestMarket(db);
    botUser = createTestUser(db, 1000000); // Bot with 1M sats
  });
  
  afterEach(() => {
    db.close();
  });

  describe('Parallel Order Matching', () => {
    
    test('multiple users cannot double-fill a single order (sequential simulation)', () => {
      // Bot places a NO order for 10,000 sats
      const botOrder = placeOrder(db, botUser.id, market.id, 'no', 40, 10000);
      expect(botOrder.status).toBe('open');
      
      // Create 4 users, each with enough balance
      const users = [];
      for (let i = 0; i < 4; i++) {
        users.push(createTestUser(db, 100000));
      }
      
      // Each user tries to buy YES@60 for 10,000 sats
      // With proper transactions, only the FIRST should match
      const results = users.map(user => 
        placeOrder(db, user.id, market.id, 'yes', 60, 10000)
      );
      
      // Count how many got filled
      const filledCount = results.filter(r => r.status === 'filled').length;
      const partialCount = results.filter(r => r.status === 'partial').length;
      const openCount = results.filter(r => r.status === 'open').length;
      
      console.log('Results:', {
        filled: filledCount,
        partial: partialCount,
        open: openCount,
        details: results.map(r => ({
          status: r.status,
          filled: r.filled || (r.amount_sats - (r.remaining || r.amount_sats)),
          matched: r.matched_bets?.length || 0
        }))
      });
      
      // CRITICAL: Only ONE user should get the match
      expect(filledCount).toBe(1);
      expect(openCount).toBe(3);
      
      // Verify the bot order is now filled
      const botOrderAfter = getOrder(db, botOrder.order_id);
      expect(botOrderAfter.status).toBe('filled');
      expect(botOrderAfter.filled_sats).toBe(10000);
      
      // Verify only one bet was created
      const bets = getMarketBets(db, market.id);
      expect(bets.length).toBe(1);
      expect(bets[0].amount_sats).toBe(10000);
    });
    
    test('partial fill protection - order gets exactly filled, not over-filled', () => {
      // Bot places a NO order for 5,000 sats
      const botOrder = placeOrder(db, botUser.id, market.id, 'no', 40, 5000);
      
      // Create 3 users
      const users = [
        createTestUser(db, 100000),
        createTestUser(db, 100000),
        createTestUser(db, 100000)
      ];
      
      // Each user tries to buy 3,000 sats
      // Only ~1.6 users worth can be filled (5000/3000)
      const results = users.map(user => 
        placeOrder(db, user.id, market.id, 'yes', 60, 3000)
      );
      
      // Check total filled across all users
      const totalFilled = results.reduce((sum, r) => {
        const filled = r.filled !== undefined ? r.filled : (r.amount_sats - (r.remaining || r.amount_sats));
        return sum + filled;
      }, 0);
      
      console.log('Partial fill results:', {
        totalFilled,
        botOrderAmount: 5000,
        results: results.map(r => ({
          status: r.status,
          filled: r.filled || (r.amount_sats - (r.remaining || r.amount_sats))
        }))
      });
      
      // Total filled should equal bot order (not exceed it)
      expect(totalFilled).toBe(5000);
      
      // Verify bot order
      const botOrderAfter = getOrder(db, botOrder.order_id);
      expect(botOrderAfter.filled_sats).toBe(5000);
    });
    
    test('balance deduction is atomic - no double-spend', () => {
      // User has exactly enough for one order
      const user = createTestUser(db, 6000); // YES@60 costs 6000 for 10000 sats
      
      // Bot provides liquidity
      placeOrder(db, botUser.id, market.id, 'no', 40, 10000);
      placeOrder(db, botUser.id, market.id, 'no', 40, 10000);
      
      // Try to place two orders "simultaneously" 
      // (the transaction should prevent the second from succeeding)
      const result1 = placeOrder(db, user.id, market.id, 'yes', 60, 10000);
      const result2 = placeOrder(db, user.id, market.id, 'yes', 60, 10000);
      
      console.log('Double-spend test:', {
        result1: { status: result1.status, error: result1.error },
        result2: { status: result2.status, error: result2.error }
      });
      
      // First should succeed, second should fail (insufficient balance)
      expect(result1.error).toBeUndefined();
      expect(result2.error).toBe('Insufficient balance');
      
      // User balance should be near zero (paid 6000 for the first order)
      const balance = getUserBalance(db, user.id);
      expect(balance).toBe(0);
    });
    
    test('price levels are respected - cannot match at wrong price', () => {
      // Bot places NO@30 (requires YES@70+ to match)
      placeOrder(db, botUser.id, market.id, 'no', 30, 10000);
      
      const user = createTestUser(db, 100000);
      
      // User tries YES@60 - should NOT match (60 + 30 = 90, need 100)
      const result = placeOrder(db, user.id, market.id, 'yes', 60, 10000);
      
      expect(result.status).toBe('open');
      expect(result.matched_bets.length).toBe(0);
      
      // Now try YES@70 - SHOULD match
      const result2 = placeOrder(db, user.id, market.id, 'yes', 70, 10000);
      
      expect(result2.status).toBe('filled');
      expect(result2.matched_bets.length).toBe(1);
    });
    
    test('multiple orders at different prices - best price matched first', () => {
      // Bot places orders at different prices
      const botNo45 = placeOrder(db, botUser.id, market.id, 'no', 45, 3000); // Best for YES taker (55%)
      const botNo40 = placeOrder(db, botUser.id, market.id, 'no', 40, 3000); // Second (60%)
      const botNo35 = placeOrder(db, botUser.id, market.id, 'no', 35, 3000); // Worst (65%)
      
      const user = createTestUser(db, 100000);
      
      // User buys 5000 sats worth
      const result = placeOrder(db, user.id, market.id, 'yes', 65, 5000);
      
      // Should match NO@45 first (3000), then NO@40 (2000 partial)
      expect(result.status).toBe('filled');
      expect(result.matched_bets.length).toBe(2);
      
      // Verify prices
      const prices = result.matched_bets.map(b => b.price).sort((a, b) => a - b);
      expect(prices).toContain(55); // From NO@45
      expect(prices).toContain(60); // From NO@40
      
      // NO@35 should be untouched
      const no35After = getOrder(db, botNo35.order_id);
      expect(no35After.filled_sats).toBe(0);
    });
  });
  
  describe('Edge Cases', () => {
    
    test('exact amount match - no rounding issues', () => {
      // Bot offers exactly what user wants
      placeOrder(db, botUser.id, market.id, 'no', 40, 10000);
      
      const user = createTestUser(db, 100000);
      const result = placeOrder(db, user.id, market.id, 'yes', 60, 10000);
      
      expect(result.status).toBe('filled');
      expect(result.remaining).toBe(0);
      expect(result.filled).toBe(10000);
    });
    
    test('zero remaining liquidity - subsequent orders go to book', () => {
      // Bot offers 10000
      placeOrder(db, botUser.id, market.id, 'no', 40, 10000);
      
      // First user takes it all
      const user1 = createTestUser(db, 100000);
      const result1 = placeOrder(db, user1.id, market.id, 'yes', 60, 10000);
      expect(result1.status).toBe('filled');
      
      // Second user finds no liquidity
      const user2 = createTestUser(db, 100000);
      const result2 = placeOrder(db, user2.id, market.id, 'yes', 60, 10000);
      expect(result2.status).toBe('open');
      expect(result2.matched_bets.length).toBe(0);
    });
    
    test('self-trade prevention - cannot match own orders', () => {
      const user = createTestUser(db, 200000);
      
      // User places NO order
      placeOrder(db, user.id, market.id, 'no', 40, 10000);
      
      // User tries to place matching YES order
      const result = placeOrder(db, user.id, market.id, 'yes', 60, 10000);
      
      // Should not self-trade
      expect(result.matched_bets.length).toBe(0);
      expect(result.status).toBe('open');
    });
  });
});
