require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const jwt = require('jsonwebtoken');
const db = require('./database');
const lightning = require('./lightning');
const { seed } = require('./seed');

const app = express();
const PORT = process.env.PORT || 3001;
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-in-production';

app.use(cors());
app.use(express.json());

// Serve static files from frontend build in production
if (process.env.NODE_ENV === 'production') {
  app.use(express.static(path.join(__dirname, '../frontend/dist')));
}

// Seed database on startup if empty
const gmCount = db.prepare('SELECT COUNT(*) as count FROM grandmasters').get();
if (gmCount.count === 0) {
  seed();
}

// ==================== AUTH MIDDLEWARE ====================
function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) {
    return res.status(401).json({ error: 'No token provided' });
  }
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

function adminMiddleware(req, res, next) {
  if (!req.user?.is_admin) {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

// ==================== AUTH ROUTES ====================

// Mock login (for development) - creates or returns user
app.post('/api/auth/demo-login', (req, res) => {
  const { email, username } = req.body;
  
  let user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  
  if (!user) {
    const id = uuidv4();
    db.prepare(`
      INSERT INTO users (id, email, username, balance_sats)
      VALUES (?, ?, ?, 100000)
    `).run(id, email, username || email.split('@')[0]);
    user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  }
  
  const token = jwt.sign(
    { id: user.id, email: user.email, is_admin: user.is_admin },
    JWT_SECRET,
    { expiresIn: '7d' }
  );
  
  res.json({ token, user: { ...user, balance_sats: user.balance_sats } });
});

// LNURL-auth challenge
app.get('/api/auth/lnurl', (req, res) => {
  const challenge = lightning.generateAuthChallenge();
  // Store challenge for verification (in production, use Redis/DB)
  res.json(challenge);
});

// ==================== USER ROUTES ====================

app.get('/api/user/me', authMiddleware, (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json(user);
});

app.get('/api/user/balance', authMiddleware, (req, res) => {
  const user = db.prepare('SELECT balance_sats FROM users WHERE id = ?').get(req.user.id);
  res.json({ balance_sats: user?.balance_sats || 0 });
});

app.get('/api/user/positions', authMiddleware, (req, res) => {
  const positions = db.prepare(`
    SELECT b.*, m.title, m.type, m.status as market_status,
           CASE WHEN b.yes_user_id = ? THEN 'yes' ELSE 'no' END as side
    FROM bets b
    JOIN markets m ON b.market_id = m.id
    WHERE (b.yes_user_id = ? OR b.no_user_id = ?) AND b.status = 'active'
  `).all(req.user.id, req.user.id, req.user.id);
  res.json(positions);
});

app.get('/api/user/orders', authMiddleware, (req, res) => {
  const orders = db.prepare(`
    SELECT o.*, m.title, m.type
    FROM orders o
    JOIN markets m ON o.market_id = m.id
    WHERE o.user_id = ? AND o.status IN ('open', 'partial')
    ORDER BY o.created_at DESC
  `).all(req.user.id);
  res.json(orders);
});

// ==================== LIGHTNING/WALLET ROUTES ====================

app.post('/api/wallet/deposit', authMiddleware, (req, res) => {
  const { amount_sats } = req.body;
  if (!amount_sats || amount_sats < 1000) {
    return res.status(400).json({ error: 'Minimum deposit is 1000 sats' });
  }
  
  const invoice = lightning.createInvoice(amount_sats, `Deposit for ${req.user.email}`);
  
  // Record pending transaction
  db.prepare(`
    INSERT INTO transactions (id, user_id, type, amount_sats, balance_after, lightning_invoice, lightning_payment_hash, status)
    VALUES (?, ?, 'deposit', ?, 0, ?, ?, 'pending')
  `).run(uuidv4(), req.user.id, amount_sats, invoice.payment_request, invoice.payment_hash);
  
  res.json(invoice);
});

app.post('/api/wallet/check-deposit', authMiddleware, (req, res) => {
  const { payment_hash } = req.body;
  const invoice = lightning.checkInvoice(payment_hash);
  
  if (invoice.status === 'paid') {
    // Check if already credited
    const tx = db.prepare(`
      SELECT * FROM transactions WHERE lightning_payment_hash = ? AND status = 'pending'
    `).get(payment_hash);
    
    if (tx) {
      // Credit user
      const user = db.prepare('SELECT balance_sats FROM users WHERE id = ?').get(req.user.id);
      const newBalance = user.balance_sats + tx.amount_sats;
      
      db.prepare('UPDATE users SET balance_sats = ? WHERE id = ?').run(newBalance, req.user.id);
      db.prepare(`
        UPDATE transactions SET status = 'completed', balance_after = ? WHERE id = ?
      `).run(newBalance, tx.id);
      
      return res.json({ status: 'credited', balance_sats: newBalance });
    }
  }
  
  res.json({ status: invoice.status });
});

// Mock: Simulate payment (for testing only)
app.post('/api/wallet/simulate-payment', authMiddleware, (req, res) => {
  const { payment_hash } = req.body;
  const result = lightning.simulatePayment(payment_hash);
  res.json(result);
});

app.post('/api/wallet/withdraw', authMiddleware, (req, res) => {
  const { payment_request, amount_sats } = req.body;
  
  const user = db.prepare('SELECT balance_sats FROM users WHERE id = ?').get(req.user.id);
  if (user.balance_sats < amount_sats) {
    return res.status(400).json({ error: 'Insufficient balance' });
  }
  
  // Deduct balance first
  const newBalance = user.balance_sats - amount_sats;
  db.prepare('UPDATE users SET balance_sats = ? WHERE id = ?').run(newBalance, req.user.id);
  
  // Pay invoice
  const payment = lightning.payInvoice(payment_request, amount_sats);
  
  // Record transaction
  db.prepare(`
    INSERT INTO transactions (id, user_id, type, amount_sats, balance_after, lightning_invoice, status)
    VALUES (?, ?, 'withdrawal', ?, ?, ?, 'completed')
  `).run(uuidv4(), req.user.id, -amount_sats, newBalance, payment_request);
  
  res.json({ success: true, balance_sats: newBalance });
});

// ==================== MARKET ROUTES ====================

// Get all GMs with their attendance market odds
app.get('/api/grandmasters', (req, res) => {
  const gms = db.prepare(`
    SELECT g.*, 
           m_attend.id as attendance_market_id,
           m_win.id as winner_market_id
    FROM grandmasters g
    LEFT JOIN markets m_attend ON m_attend.grandmaster_id = g.id AND m_attend.type = 'attendance'
    LEFT JOIN markets m_win ON m_win.grandmaster_id = g.id AND m_win.type = 'winner'
    ORDER BY g.fide_rating DESC
  `).all();
  
  // Calculate implied odds for each GM based on order book
  const gmsWithOdds = gms.map(gm => {
    const bestYes = db.prepare(`
      SELECT MIN(price_cents) as price FROM orders 
      WHERE market_id = ? AND side = 'no' AND status IN ('open', 'partial')
    `).get(gm.attendance_market_id);
    
    const bestNo = db.prepare(`
      SELECT MAX(price_cents) as price FROM orders 
      WHERE market_id = ? AND side = 'yes' AND status IN ('open', 'partial')
    `).get(gm.attendance_market_id);
    
    return {
      ...gm,
      attendance_yes_price: bestYes?.price ? (100 - bestYes.price) : null,
      attendance_no_price: bestNo?.price || null,
    };
  });
  
  res.json(gmsWithOdds);
});

// Get event market
app.get('/api/markets/event', (req, res) => {
  const market = db.prepare(`
    SELECT * FROM markets WHERE type = 'event'
  `).get();
  res.json(market);
});

// Get market by ID with order book
app.get('/api/markets/:id', (req, res) => {
  const market = db.prepare(`
    SELECT m.*, g.name as grandmaster_name, g.fide_rating, g.country
    FROM markets m
    LEFT JOIN grandmasters g ON m.grandmaster_id = g.id
    WHERE m.id = ?
  `).get(req.params.id);
  
  if (!market) return res.status(404).json({ error: 'Market not found' });
  
  // Get order book (aggregated by price)
  const yesOrders = db.prepare(`
    SELECT price_cents, SUM(amount_sats - filled_sats) as total_sats, COUNT(*) as order_count
    FROM orders
    WHERE market_id = ? AND side = 'yes' AND status IN ('open', 'partial')
    GROUP BY price_cents
    ORDER BY price_cents DESC
  `).all(req.params.id);
  
  const noOrders = db.prepare(`
    SELECT price_cents, SUM(amount_sats - filled_sats) as total_sats, COUNT(*) as order_count
    FROM orders
    WHERE market_id = ? AND side = 'no' AND status IN ('open', 'partial')
    GROUP BY price_cents
    ORDER BY price_cents ASC
  `).all(req.params.id);
  
  // Get recent trades
  const recentBets = db.prepare(`
    SELECT price_cents, amount_sats, created_at
    FROM bets
    WHERE market_id = ?
    ORDER BY created_at DESC
    LIMIT 20
  `).all(req.params.id);
  
  res.json({
    ...market,
    orderBook: { yes: yesOrders, no: noOrders },
    recentTrades: recentBets,
  });
});

// ==================== ORDER ROUTES ====================

app.post('/api/orders', authMiddleware, (req, res) => {
  const { market_id, side, price_cents, amount_sats } = req.body;
  
  // Validation
  if (!['yes', 'no'].includes(side)) {
    return res.status(400).json({ error: 'Side must be yes or no' });
  }
  if (price_cents < 1 || price_cents > 99) {
    return res.status(400).json({ error: 'Price must be between 1 and 99 cents' });
  }
  if (amount_sats < 100) {
    return res.status(400).json({ error: 'Minimum order is 100 sats' });
  }
  
  // Check market exists and is open
  const market = db.prepare('SELECT * FROM markets WHERE id = ?').get(market_id);
  if (!market || market.status !== 'open') {
    return res.status(400).json({ error: 'Market not available for trading' });
  }
  
  // Check balance - cost is price * amount / 100 for YES, (100-price) * amount / 100 for NO
  const user = db.prepare('SELECT balance_sats FROM users WHERE id = ?').get(req.user.id);
  const cost = side === 'yes' 
    ? Math.ceil(amount_sats * price_cents / 100)
    : Math.ceil(amount_sats * (100 - price_cents) / 100);
  
  if (user.balance_sats < cost) {
    return res.status(400).json({ error: 'Insufficient balance', required: cost, available: user.balance_sats });
  }
  
  // Deduct balance
  const newBalance = user.balance_sats - cost;
  db.prepare('UPDATE users SET balance_sats = ? WHERE id = ?').run(newBalance, req.user.id);
  
  // Try to match with existing orders
  const orderId = uuidv4();
  let remainingAmount = amount_sats;
  const matchedBets = [];
  
  // Find matching orders on opposite side
  const oppositeSide = side === 'yes' ? 'no' : 'yes';
  const matchCondition = side === 'yes' 
    ? 'price_cents <= ?' // YES buyer matches with NO seller at complementary price
    : 'price_cents >= ?';
  const matchPrice = side === 'yes' ? (100 - price_cents) : (100 - price_cents);
  
  const matchingOrders = db.prepare(`
    SELECT * FROM orders
    WHERE market_id = ? AND side = ? AND status IN ('open', 'partial')
    AND ${side === 'yes' ? 'price_cents <= ?' : 'price_cents >= ?'}
    ORDER BY ${side === 'yes' ? 'price_cents ASC' : 'price_cents DESC'}, created_at ASC
  `).all(market_id, oppositeSide, matchPrice);
  
  for (const matchOrder of matchingOrders) {
    if (remainingAmount <= 0) break;
    
    const matchAvailable = matchOrder.amount_sats - matchOrder.filled_sats;
    const matchAmount = Math.min(remainingAmount, matchAvailable);
    const tradePrice = matchOrder.price_cents; // Price from the resting order
    
    // Create bet
    const betId = uuidv4();
    const yesUserId = side === 'yes' ? req.user.id : matchOrder.user_id;
    const noUserId = side === 'no' ? req.user.id : matchOrder.user_id;
    const yesOrderId = side === 'yes' ? orderId : matchOrder.id;
    const noOrderId = side === 'no' ? orderId : matchOrder.id;
    
    db.prepare(`
      INSERT INTO bets (id, market_id, yes_user_id, no_user_id, yes_order_id, no_order_id, price_cents, amount_sats)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(betId, market_id, yesUserId, noUserId, yesOrderId, noOrderId, 100 - tradePrice, matchAmount);
    
    // Update matched order
    const newFilled = matchOrder.filled_sats + matchAmount;
    const newStatus = newFilled >= matchOrder.amount_sats ? 'filled' : 'partial';
    db.prepare('UPDATE orders SET filled_sats = ?, status = ? WHERE id = ?')
      .run(newFilled, newStatus, matchOrder.id);
    
    remainingAmount -= matchAmount;
    matchedBets.push({ betId, amount: matchAmount, price: 100 - tradePrice });
  }
  
  // Create order for remaining amount
  const orderStatus = remainingAmount === 0 ? 'filled' : 
                      remainingAmount < amount_sats ? 'partial' : 'open';
  
  db.prepare(`
    INSERT INTO orders (id, user_id, market_id, side, price_cents, amount_sats, filled_sats, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(orderId, req.user.id, market_id, side, price_cents, amount_sats, amount_sats - remainingAmount, orderStatus);
  
  // Record transaction
  db.prepare(`
    INSERT INTO transactions (id, user_id, type, amount_sats, balance_after, reference_id, status)
    VALUES (?, ?, 'order_placed', ?, ?, ?, 'completed')
  `).run(uuidv4(), req.user.id, -cost, newBalance, orderId);
  
  res.json({
    order_id: orderId,
    status: orderStatus,
    filled: amount_sats - remainingAmount,
    remaining: remainingAmount,
    cost,
    new_balance: newBalance,
    matched_bets: matchedBets
  });
});

app.delete('/api/orders/:id', authMiddleware, (req, res) => {
  const order = db.prepare('SELECT * FROM orders WHERE id = ? AND user_id = ?')
    .get(req.params.id, req.user.id);
  
  if (!order) return res.status(404).json({ error: 'Order not found' });
  if (order.status === 'filled' || order.status === 'cancelled') {
    return res.status(400).json({ error: 'Order cannot be cancelled' });
  }
  
  // Refund remaining amount
  const remaining = order.amount_sats - order.filled_sats;
  const refund = order.side === 'yes'
    ? Math.ceil(remaining * order.price_cents / 100)
    : Math.ceil(remaining * (100 - order.price_cents) / 100);
  
  const user = db.prepare('SELECT balance_sats FROM users WHERE id = ?').get(req.user.id);
  const newBalance = user.balance_sats + refund;
  
  db.prepare('UPDATE users SET balance_sats = ? WHERE id = ?').run(newBalance, req.user.id);
  db.prepare('UPDATE orders SET status = ? WHERE id = ?').run('cancelled', order.id);
  
  db.prepare(`
    INSERT INTO transactions (id, user_id, type, amount_sats, balance_after, reference_id, status)
    VALUES (?, ?, 'order_cancelled', ?, ?, ?, 'completed')
  `).run(uuidv4(), req.user.id, refund, newBalance, order.id);
  
  res.json({ success: true, refund, new_balance: newBalance });
});

// ==================== ADMIN ROUTES ====================

app.get('/api/admin/markets', authMiddleware, adminMiddleware, (req, res) => {
  const markets = db.prepare(`
    SELECT m.*, g.name as grandmaster_name,
           (SELECT COUNT(*) FROM bets WHERE market_id = m.id AND status = 'active') as active_bets,
           (SELECT SUM(amount_sats) FROM bets WHERE market_id = m.id AND status = 'active') as total_volume
    FROM markets m
    LEFT JOIN grandmasters g ON m.grandmaster_id = g.id
    ORDER BY m.type, g.fide_rating DESC
  `).all();
  res.json(markets);
});

// Initiate resolution (starts 24-hour delay)
app.post('/api/admin/resolve/initiate', authMiddleware, adminMiddleware, (req, res) => {
  const { market_id, resolution, notes } = req.body;
  
  if (!['yes', 'no'].includes(resolution)) {
    return res.status(400).json({ error: 'Resolution must be yes or no' });
  }
  
  const market = db.prepare('SELECT * FROM markets WHERE id = ?').get(market_id);
  if (!market) return res.status(404).json({ error: 'Market not found' });
  if (market.status !== 'open') {
    return res.status(400).json({ error: 'Market is not open' });
  }
  
  // Set market to pending
  const scheduledTime = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  db.prepare('UPDATE markets SET status = ? WHERE id = ?').run('pending_resolution', market_id);
  
  // Log resolution initiation
  db.prepare(`
    INSERT INTO resolution_log (id, market_id, admin_user_id, action, resolution, scheduled_time, notes)
    VALUES (?, ?, ?, 'initiated', ?, ?, ?)
  `).run(uuidv4(), market_id, req.user.id, resolution, scheduledTime, notes);
  
  res.json({ 
    success: true, 
    scheduled_time: scheduledTime,
    message: 'Resolution scheduled. Confirm or cancel within 24 hours.'
  });
});

// Confirm resolution (after delay or immediately with emergency code)
app.post('/api/admin/resolve/confirm', authMiddleware, adminMiddleware, (req, res) => {
  const { market_id, emergency_code } = req.body;
  
  const market = db.prepare('SELECT * FROM markets WHERE id = ?').get(market_id);
  if (!market) return res.status(404).json({ error: 'Market not found' });
  
  const pendingResolution = db.prepare(`
    SELECT * FROM resolution_log 
    WHERE market_id = ? AND action = 'initiated'
    ORDER BY created_at DESC LIMIT 1
  `).get(market_id);
  
  if (!pendingResolution) {
    return res.status(400).json({ error: 'No pending resolution found' });
  }
  
  // Check if emergency or past scheduled time
  const isEmergency = emergency_code === process.env.EMERGENCY_CODE;
  const isPastScheduled = new Date() >= new Date(pendingResolution.scheduled_time);
  
  if (!isEmergency && !isPastScheduled) {
    return res.status(400).json({ 
      error: 'Resolution period not complete',
      scheduled_time: pendingResolution.scheduled_time
    });
  }
  
  // Execute resolution
  const resolution = pendingResolution.resolution;
  db.prepare('UPDATE markets SET status = ?, resolution = ?, resolution_time = ?, resolved_by = ? WHERE id = ?')
    .run('resolved', resolution, new Date().toISOString(), req.user.id, market_id);
  
  // Log confirmation
  db.prepare(`
    INSERT INTO resolution_log (id, market_id, admin_user_id, action, resolution)
    VALUES (?, ?, ?, ?, ?)
  `).run(uuidv4(), market_id, req.user.id, isEmergency ? 'emergency_resolved' : 'confirmed', resolution);
  
  // Settle all bets
  const bets = db.prepare('SELECT * FROM bets WHERE market_id = ? AND status = ?').all(market_id, 'active');
  
  for (const bet of bets) {
    const winnerId = resolution === 'yes' ? bet.yes_user_id : bet.no_user_id;
    const payout = bet.amount_sats; // Winner gets full amount
    
    // Credit winner
    db.prepare('UPDATE users SET balance_sats = balance_sats + ? WHERE id = ?').run(payout, winnerId);
    
    // Update bet
    db.prepare('UPDATE bets SET status = ?, winner_user_id = ?, settled_at = ? WHERE id = ?')
      .run('settled', winnerId, new Date().toISOString(), bet.id);
    
    // Record transactions
    db.prepare(`
      INSERT INTO transactions (id, user_id, type, amount_sats, balance_after, reference_id, status)
      VALUES (?, ?, 'bet_won', ?, (SELECT balance_sats FROM users WHERE id = ?), ?, 'completed')
    `).run(uuidv4(), winnerId, payout, winnerId, bet.id);
  }
  
  // Cancel all open orders
  const openOrders = db.prepare(`
    SELECT * FROM orders WHERE market_id = ? AND status IN ('open', 'partial')
  `).all(market_id);
  
  for (const order of openOrders) {
    const remaining = order.amount_sats - order.filled_sats;
    const refund = order.side === 'yes'
      ? Math.ceil(remaining * order.price_cents / 100)
      : Math.ceil(remaining * (100 - order.price_cents) / 100);
    
    db.prepare('UPDATE users SET balance_sats = balance_sats + ? WHERE id = ?').run(refund, order.user_id);
    db.prepare('UPDATE orders SET status = ? WHERE id = ?').run('cancelled', order.id);
  }
  
  res.json({ 
    success: true, 
    resolution, 
    bets_settled: bets.length,
    orders_cancelled: openOrders.length
  });
});

// Cancel pending resolution
app.post('/api/admin/resolve/cancel', authMiddleware, adminMiddleware, (req, res) => {
  const { market_id } = req.body;
  
  const market = db.prepare('SELECT * FROM markets WHERE id = ?').get(market_id);
  if (!market || market.status !== 'pending_resolution') {
    return res.status(400).json({ error: 'No pending resolution to cancel' });
  }
  
  db.prepare('UPDATE markets SET status = ? WHERE id = ?').run('open', market_id);
  
  db.prepare(`
    INSERT INTO resolution_log (id, market_id, admin_user_id, action)
    VALUES (?, ?, ?, 'cancelled')
  `).run(uuidv4(), market_id, req.user.id);
  
  res.json({ success: true, message: 'Resolution cancelled, market reopened' });
});

// Add grandmaster
app.post('/api/admin/grandmasters', authMiddleware, adminMiddleware, (req, res) => {
  const { name, fide_id, fide_rating, country, title, is_influencer } = req.body;
  
  const gmId = uuidv4();
  db.prepare(`
    INSERT INTO grandmasters (id, name, fide_id, fide_rating, country, title, is_influencer)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(gmId, name, fide_id, fide_rating || 0, country, title || 'GM', is_influencer ? 1 : 0);
  
  // Create markets
  const attendId = uuidv4();
  db.prepare(`
    INSERT INTO markets (id, type, grandmaster_id, title, description)
    VALUES (?, 'attendance', ?, ?, ?)
  `).run(attendId, gmId, `Will ${name} attend?`, `Market resolves YES if ${name} attends the Bitcoin Chess 960 Championship.`);
  
  const winnerId = uuidv4();
  db.prepare(`
    INSERT INTO markets (id, type, grandmaster_id, title, description)
    VALUES (?, 'winner', ?, ?, ?)
  `).run(winnerId, gmId, `Will ${name} win?`, `Market resolves YES if ${name} wins the Bitcoin Chess 960 Championship.`);
  
  res.json({ 
    grandmaster_id: gmId,
    attendance_market_id: attendId,
    winner_market_id: winnerId
  });
});

// ==================== HEALTH CHECK ====================
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Serve frontend for any non-API routes in production
if (process.env.NODE_ENV === 'production') {
  app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, '../frontend/dist/index.html'));
  });
}

app.listen(PORT, () => {
  console.log(`Bitcoin Chess 960 Predictions API running on port ${PORT}`);
});
