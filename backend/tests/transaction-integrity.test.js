/**
 * Transaction Integrity Tests
 * 
 * Tests that all balance changes are properly recorded in the transactions table
 * and that balance_after values are consistent with actual balances.
 * 
 * INVARIANTS:
 * - Every balance change has a corresponding transaction record
 * - transaction.balance_after matches the actual user balance at that point
 * - Sum of all transactions for a user equals their current balance
 */

const {
  createTestDatabase,
  createTestUser,
  createTestMarket,
  placeOrder,
  cancelOrder,
  getUserBalance,
  getOrder,
} = require('./testHelpers');

// Helper to get all transactions for a user
function getUserTransactions(db, userId) {
  return db.prepare(`
    SELECT * FROM transactions WHERE user_id = ? ORDER BY created_at ASC
  `).all(userId);
}

// Helper to get the sum of all transaction amounts for a user
function getTransactionSum(db, userId) {
  const result = db.prepare(`
    SELECT COALESCE(SUM(amount_sats), 0) as total FROM transactions WHERE user_id = ?
  `).get(userId);
  return result.total;
}

describe('Transaction Integrity - Recording', () => {
  let db;
  let market;
  let alice;
  let bob;

  beforeEach(() => {
    db = createTestDatabase();
    market = createTestMarket(db);
    alice = createTestUser(db, 1000000);
    bob = createTestUser(db, 1000000);
  });

  describe('Order Placement Transactions', () => {
    test('order_placed transaction recorded for YES order', () => {
      const result = placeOrder(db, alice.id, market.id, 'yes', 60, 10000);
      
      const transactions = getUserTransactions(db, alice.id);
      const orderTx = transactions.find(t => t.type === 'order_placed');
      
      expect(orderTx).toBeDefined();
      expect(orderTx.amount_sats).toBe(-result.cost); // Negative for cost
      expect(orderTx.reference_id).toBe(result.order_id);
      expect(orderTx.status).toBe('completed');
    });

    test('order_placed transaction recorded for NO order', () => {
      const result = placeOrder(db, bob.id, market.id, 'no', 40, 10000);
      
      const transactions = getUserTransactions(db, bob.id);
      const orderTx = transactions.find(t => t.type === 'order_placed');
      
      expect(orderTx).toBeDefined();
      expect(orderTx.amount_sats).toBe(-result.cost);
      expect(orderTx.reference_id).toBe(result.order_id);
    });

    test('transaction balance_after matches actual balance', () => {
      const balanceBefore = getUserBalance(db, alice.id);
      const result = placeOrder(db, alice.id, market.id, 'yes', 60, 10000);
      
      const transactions = getUserTransactions(db, alice.id);
      const orderTx = transactions.find(t => t.type === 'order_placed');
      const balanceAfter = getUserBalance(db, alice.id);
      
      expect(orderTx.balance_after).toBe(balanceAfter);
      expect(balanceAfter).toBe(balanceBefore - result.cost);
    });
  });

  describe('Order Cancellation Transactions', () => {
    test('order_cancelled transaction recorded with refund', () => {
      const placeResult = placeOrder(db, alice.id, market.id, 'yes', 60, 10000);
      const cancelResult = cancelOrder(db, alice.id, placeResult.order_id);
      
      const transactions = getUserTransactions(db, alice.id);
      const cancelTx = transactions.find(t => t.type === 'order_cancelled');
      
      expect(cancelTx).toBeDefined();
      expect(cancelTx.amount_sats).toBe(cancelResult.refund); // Positive for refund
      expect(cancelTx.reference_id).toBe(placeResult.order_id);
    });

    test('partial order cancellation records correct refund', () => {
      // Bob places large NO order
      const noResult = placeOrder(db, bob.id, market.id, 'no', 40, 10000);
      
      // Alice partially fills it
      placeOrder(db, alice.id, market.id, 'yes', 60, 3000);
      
      // Bob cancels remaining
      const cancelResult = cancelOrder(db, bob.id, noResult.order_id);
      
      const transactions = getUserTransactions(db, bob.id);
      const cancelTx = transactions.find(t => t.type === 'order_cancelled');
      
      // Refund should be for 7000 sats remaining at 60% cost = 4200
      expect(cancelTx.amount_sats).toBe(cancelResult.refund);
      expect(cancelResult.refund).toBe(4200); // 7000 * 0.6
    });
  });

  describe('Auto-Settle Transactions', () => {
    test('bet_won transaction recorded for auto-settle', () => {
      // Alice gets YES position
      placeOrder(db, bob.id, market.id, 'no', 40, 5000);
      placeOrder(db, alice.id, market.id, 'yes', 60, 5000);
      
      // Carol provides opposite liquidity
      const carol = createTestUser(db, 1000000);
      placeOrder(db, carol.id, market.id, 'yes', 70, 5000);
      
      // Alice takes NO - triggers auto-settle
      const result = placeOrder(db, alice.id, market.id, 'no', 30, 5000);
      
      expect(result.auto_settled).not.toBeNull();
      
      const transactions = getUserTransactions(db, alice.id);
      const settleTx = transactions.find(t => t.type === 'bet_won');
      
      expect(settleTx).toBeDefined();
      expect(settleTx.amount_sats).toBe(result.auto_settled.payout);
    });
  });

  describe('Transaction Consistency', () => {
    test('balance equals starting balance plus sum of transactions', () => {
      const startingBalance = 1000000;
      
      // Multiple operations
      placeOrder(db, alice.id, market.id, 'yes', 50, 10000); // -5000
      placeOrder(db, alice.id, market.id, 'no', 50, 10000);  // -5000
      placeOrder(db, alice.id, market.id, 'yes', 60, 5000);  // -3000
      
      const txSum = getTransactionSum(db, alice.id);
      const currentBalance = getUserBalance(db, alice.id);
      
      expect(currentBalance).toBe(startingBalance + txSum);
    });

    test('consecutive balance_after values are consistent', () => {
      placeOrder(db, alice.id, market.id, 'yes', 50, 10000);
      placeOrder(db, alice.id, market.id, 'yes', 60, 5000);
      placeOrder(db, alice.id, market.id, 'no', 30, 8000);
      
      const transactions = getUserTransactions(db, alice.id);
      
      let expectedBalance = 1000000; // Starting balance
      
      for (const tx of transactions) {
        expectedBalance += tx.amount_sats;
        expect(tx.balance_after).toBe(expectedBalance);
      }
      
      expect(getUserBalance(db, alice.id)).toBe(expectedBalance);
    });

    test('order place and cancel result in net zero balance change', () => {
      const startBalance = getUserBalance(db, alice.id);
      
      const result = placeOrder(db, alice.id, market.id, 'yes', 50, 10000);
      cancelOrder(db, alice.id, result.order_id);
      
      expect(getUserBalance(db, alice.id)).toBe(startBalance);
      
      // Verify via transaction sum
      const txSum = getTransactionSum(db, alice.id);
      expect(txSum).toBe(0);
    });
  });
});

describe('Transaction Integrity - Matched Orders', () => {
  let db;
  let market;
  let alice;
  let bob;

  beforeEach(() => {
    db = createTestDatabase();
    market = createTestMarket(db);
    alice = createTestUser(db, 1000000);
    bob = createTestUser(db, 1000000);
  });

  test('both parties have transaction records after match', () => {
    placeOrder(db, bob.id, market.id, 'no', 40, 10000);
    placeOrder(db, alice.id, market.id, 'yes', 60, 10000);
    
    const aliceTxs = getUserTransactions(db, alice.id);
    const bobTxs = getUserTransactions(db, bob.id);
    
    expect(aliceTxs.length).toBeGreaterThan(0);
    expect(bobTxs.length).toBeGreaterThan(0);
  });

  test('no phantom transactions created', () => {
    // Just place orders without matches
    placeOrder(db, alice.id, market.id, 'yes', 40, 10000); // Won't match (no counterpart)
    
    const transactions = getUserTransactions(db, alice.id);
    
    // Should only have one transaction (order_placed)
    expect(transactions.length).toBe(1);
    expect(transactions[0].type).toBe('order_placed');
  });
});

describe('Transaction Integrity - Edge Cases', () => {
  let db;
  let market;
  
  beforeEach(() => {
    db = createTestDatabase();
    market = createTestMarket(db);
  });

  test('multiple rapid transactions maintain integrity', () => {
    const alice = createTestUser(db, 10000000);
    const bob = createTestUser(db, 10000000);
    
    // Rapid order placement
    const orders = [];
    for (let i = 0; i < 20; i++) {
      const result = placeOrder(db, alice.id, market.id, 'yes', 50 + (i % 10), 1000);
      orders.push(result);
    }
    
    // Verify transaction count
    const transactions = getUserTransactions(db, alice.id);
    expect(transactions.length).toBe(20);
    
    // Verify final balance
    const txSum = getTransactionSum(db, alice.id);
    expect(getUserBalance(db, alice.id)).toBe(10000000 + txSum);
  });

  test('complex scenario with matches, partial fills, and cancels', () => {
    const alice = createTestUser(db, 1000000);
    const bob = createTestUser(db, 1000000);
    const carol = createTestUser(db, 1000000);
    
    const initialTotal = 3000000;
    
    // Bob places large NO order
    const bobOrder = placeOrder(db, bob.id, market.id, 'no', 40, 50000);
    
    // Alice partially fills
    placeOrder(db, alice.id, market.id, 'yes', 60, 20000);
    
    // Carol partially fills
    placeOrder(db, carol.id, market.id, 'yes', 60, 15000);
    
    // Bob cancels remaining
    cancelOrder(db, bob.id, bobOrder.order_id);
    
    // Calculate total balances
    const aliceBalance = getUserBalance(db, alice.id);
    const bobBalance = getUserBalance(db, bob.id);
    const carolBalance = getUserBalance(db, carol.id);
    const total = aliceBalance + bobBalance + carolBalance;
    
    // Total should be preserved (no money created or destroyed)
    // Note: This is only true pre-resolution - money moves between users
    // but total in system remains constant
    expect(total).toBe(initialTotal);
    
    // Verify each user's transaction integrity
    [alice, bob, carol].forEach(user => {
      const txSum = getTransactionSum(db, user.id);
      const balance = getUserBalance(db, user.id);
      expect(balance).toBe(1000000 + txSum);
    });
  });

  test('transaction records have all required fields', () => {
    const alice = createTestUser(db, 1000000);
    
    const result = placeOrder(db, alice.id, market.id, 'yes', 50, 10000);
    
    const transactions = getUserTransactions(db, alice.id);
    const tx = transactions[0];
    
    // Required fields
    expect(tx.id).toBeDefined();
    expect(tx.user_id).toBe(alice.id);
    expect(tx.type).toBeDefined();
    expect(tx.amount_sats).toBeDefined();
    expect(tx.balance_after).toBeDefined();
    expect(tx.created_at).toBeDefined();
    expect(tx.status).toBeDefined();
  });
});

describe('Transaction Integrity - Conservation Laws', () => {
  let db;
  let market;
  
  beforeEach(() => {
    db = createTestDatabase();
    market = createTestMarket(db);
  });

  test('total system balance is conserved during trading', () => {
    const users = [];
    const initialBalancePerUser = 1000000;
    const numUsers = 5;
    
    for (let i = 0; i < numUsers; i++) {
      users.push(createTestUser(db, initialBalancePerUser));
    }
    
    const initialTotal = numUsers * initialBalancePerUser;
    
    // Do lots of trading (only unmatched orders)
    for (let i = 0; i < 50; i++) {
      const user = users[i % numUsers];
      const side = i % 2 === 0 ? 'yes' : 'no';
      // Use prices that won't match (YES low, NO high)
      const price = side === 'yes' ? 20 : 80;
      const amount = 1000 * (Math.floor(Math.random() * 5) + 1);
      
      placeOrder(db, user.id, market.id, side, price, amount);
    }
    
    // For unmatched orders, balance is conserved
    let totalBalance = 0;
    users.forEach(user => {
      totalBalance += getUserBalance(db, user.id);
    });
    
    // Total should be conserved (money only locked in orders, not in bets)
    expect(totalBalance).toBe(initialTotal);
  });

  test('money locked in orders is accounted for', () => {
    const alice = createTestUser(db, 1000000);
    const startBalance = getUserBalance(db, alice.id);
    
    // Place order that won't match
    const result = placeOrder(db, alice.id, market.id, 'yes', 20, 10000);
    
    const currentBalance = getUserBalance(db, alice.id);
    const lockedInOrder = result.cost;
    
    // Balance should be reduced by order cost
    expect(currentBalance).toBe(startBalance - lockedInOrder);
    
    // But total "wealth" (balance + locked) is conserved
    expect(currentBalance + lockedInOrder).toBe(startBalance);
  });
});
