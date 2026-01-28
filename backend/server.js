require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { OAuth2Client } = require('google-auth-library');
const db = require('./database');
const lightning = require('./lightning');
const bot = require('./bot');
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

// Email registration with password
app.post('/api/auth/register', async (req, res) => {
  const { email, password, username } = req.body;
  
  // Validation
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }
  
  if (password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters' });
  }
  
  // Check if email already exists
  const existing = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (existing) {
    return res.status(400).json({ error: 'An account with this email already exists' });
  }
  
  try {
    // Hash password
    const salt = await bcrypt.genSalt(10);
    const password_hash = await bcrypt.hash(password, salt);
    
    // Create user
    const id = uuidv4();
    db.prepare(`
      INSERT INTO users (id, email, username, password_hash, balance_sats, email_verified)
      VALUES (?, ?, ?, ?, 100000, 0)
    `).run(id, email, username || email.split('@')[0], password_hash);
    
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    
    const token = jwt.sign(
      { id: user.id, email: user.email, is_admin: user.is_admin },
      JWT_SECRET,
      { expiresIn: '7d' }
    );
    
    // Don't send password_hash to client
    const { password_hash: _, ...safeUser } = user;
    res.json({ token, user: safeUser });
  } catch (err) {
    console.error('Registration error:', err);
    res.status(500).json({ error: 'Registration failed' });
  }
});

// Email login with password
app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }
  
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  
  if (!user) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }
  
  // Check if user has a password (might have signed up via Google only)
  if (!user.password_hash) {
    return res.status(401).json({ error: 'This account uses Google sign-in. Please login with Google.' });
  }
  
  try {
    const isMatch = await bcrypt.compare(password, user.password_hash);
    
    if (!isMatch) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }
    
    const token = jwt.sign(
      { id: user.id, email: user.email, is_admin: user.is_admin },
      JWT_SECRET,
      { expiresIn: '7d' }
    );
    
    // Don't send password_hash to client
    const { password_hash: _, ...safeUser } = user;
    res.json({ token, user: safeUser });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Login failed' });
  }
});

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

// Google OAuth login
app.post('/api/auth/google', async (req, res) => {
  const { credential } = req.body;
  
  if (!credential) {
    return res.status(400).json({ error: 'No credential provided' });
  }
  
  const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
  if (!GOOGLE_CLIENT_ID) {
    return res.status(500).json({ error: 'Google OAuth not configured' });
  }
  
  try {
    const client = new OAuth2Client(GOOGLE_CLIENT_ID);
    const ticket = await client.verifyIdToken({
      idToken: credential,
      audience: GOOGLE_CLIENT_ID,
    });
    
    const payload = ticket.getPayload();
    const { email, name, picture, sub: googleId } = payload;
    
    // Find or create user
    let user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    
    if (!user) {
      // Create new user
      const id = uuidv4();
      db.prepare(`
        INSERT INTO users (id, email, username, google_id, avatar_url, balance_sats)
        VALUES (?, ?, ?, ?, ?, 100000)
      `).run(id, email, name || email.split('@')[0], googleId, picture);
      user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    } else if (!user.google_id) {
      // Link existing account to Google
      db.prepare('UPDATE users SET google_id = ?, avatar_url = ? WHERE id = ?')
        .run(googleId, picture, user.id);
      user = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
    }
    
    const token = jwt.sign(
      { id: user.id, email: user.email, is_admin: user.is_admin },
      JWT_SECRET,
      { expiresIn: '7d' }
    );
    
    res.json({ token, user: { ...user, balance_sats: user.balance_sats } });
  } catch (err) {
    console.error('Google auth error:', err);
    res.status(401).json({ error: 'Invalid Google credential' });
  }
});

// Get Google Client ID for frontend
app.get('/api/auth/google-client-id', (req, res) => {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) {
    return res.status(404).json({ error: 'Google OAuth not configured' });
  }
  res.json({ clientId });
});

// ==================== LNURL-AUTH ROUTES ====================

// Generate LNURL-auth challenge (returns QR code data)
app.get('/api/auth/lnurl', (req, res) => {
  // Use API_URL if set, otherwise use Railway's public domain, otherwise localhost
  const baseUrl = process.env.API_URL || 
    (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : `http://localhost:${PORT}`);
  const challenge = lightning.generateAuthChallenge(db, baseUrl);
  res.json(challenge);
});

// LNURL-auth callback (called by Lightning wallet)
// MUST return JSON per LNURL spec: { status: 'OK' } or { status: 'ERROR', reason: '...' }
app.get('/api/auth/lnurl/callback', (req, res) => {
  const { k1, sig, key } = req.query;
  
  if (!k1 || !sig || !key) {
    return res.json({ status: 'ERROR', reason: 'Missing required parameters (k1, sig, key)' });
  }
  
  const result = lightning.processAuthCallback(db, k1, sig, key);
  
  if (!result.ok) {
    return res.json({ status: 'ERROR', reason: result.error });
  }
  
  // Success - wallet will show success message to user
  res.json({ status: 'OK' });
});

// Check LNURL-auth status (frontend polls this)
app.get('/api/auth/lnurl/status/:k1', (req, res) => {
  const { k1 } = req.params;
  const status = lightning.getAuthStatus(db, k1);
  res.json(status);
});

// Complete LNURL-auth login (called by frontend after verification)
app.post('/api/auth/lnurl/complete', (req, res) => {
  const { k1 } = req.body;
  
  if (!k1) {
    return res.status(400).json({ error: 'Missing k1 parameter' });
  }
  
  // Get challenge status
  const status = lightning.getAuthStatus(db, k1);
  
  if (status.status !== 'verified') {
    return res.status(400).json({ error: `Challenge is ${status.status}, not verified` });
  }
  
  const pubkey = status.lightning_pubkey;
  
  // Find or create user by lightning pubkey
  let user = db.prepare('SELECT * FROM users WHERE lightning_pubkey = ?').get(pubkey);
  
  if (!user) {
    // Create new user with Lightning auth
    const id = uuidv4();
    const username = lightning.generateFriendlyUsername();
    const accountNumber = lightning.getNextAccountNumber(db);
    
    db.prepare(`
      INSERT INTO users (id, lightning_pubkey, username, account_number, balance_sats)
      VALUES (?, ?, ?, ?, 100000)
    `).run(id, pubkey, username, accountNumber);
    
    user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    console.log(`New Lightning user created: ${username} (account #${accountNumber})`);
  }
  
  // Mark challenge as used
  lightning.markChallengeUsed(db, k1);
  
  // Generate JWT
  const token = jwt.sign(
    { id: user.id, email: user.email, is_admin: user.is_admin },
    JWT_SECRET,
    { expiresIn: '7d' }
  );
  
  // Don't send password_hash to client
  const { password_hash: _, ...safeUser } = user;
  res.json({ token, user: safeUser });
});

// Link Lightning to existing account (requires auth)
app.post('/api/auth/link-lightning', authMiddleware, (req, res) => {
  const { k1 } = req.body;
  
  if (!k1) {
    return res.status(400).json({ error: 'Missing k1 parameter' });
  }
  
  // Get challenge status
  const status = lightning.getAuthStatus(db, k1);
  
  if (status.status !== 'verified') {
    return res.status(400).json({ error: `Challenge is ${status.status}, not verified` });
  }
  
  const pubkey = status.lightning_pubkey;
  
  // Check if this pubkey is already linked to another account
  const existingUser = db.prepare('SELECT * FROM users WHERE lightning_pubkey = ?').get(pubkey);
  
  if (existingUser && existingUser.id !== req.user.id) {
    return res.status(400).json({ 
      error: 'This Lightning wallet is already linked to another account',
      existing_user: existingUser.username
    });
  }
  
  // Link to current user
  db.prepare('UPDATE users SET lightning_pubkey = ? WHERE id = ?').run(pubkey, req.user.id);
  lightning.markChallengeUsed(db, k1);
  
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  const { password_hash: _, ...safeUser } = user;
  
  res.json({ success: true, user: safeUser });
});

// Merge accounts: Link Lightning pubkey and merge data from Lightning-only account
app.post('/api/auth/merge-accounts', authMiddleware, async (req, res) => {
  const { k1, confirm } = req.body;
  
  if (!k1) {
    return res.status(400).json({ error: 'Missing k1 parameter' });
  }
  
  // Get challenge status
  const status = lightning.getAuthStatus(db, k1);
  
  if (status.status !== 'verified') {
    return res.status(400).json({ error: `Challenge is ${status.status}, not verified` });
  }
  
  const pubkey = status.lightning_pubkey;
  
  // Check if this pubkey is linked to another account
  const lightningUser = db.prepare('SELECT * FROM users WHERE lightning_pubkey = ?').get(pubkey);
  
  if (!lightningUser) {
    // No existing account - just link it
    db.prepare('UPDATE users SET lightning_pubkey = ? WHERE id = ?').run(pubkey, req.user.id);
    lightning.markChallengeUsed(db, k1);
    
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    const { password_hash: _, ...safeUser } = user;
    return res.json({ merged: false, user: safeUser });
  }
  
  if (lightningUser.id === req.user.id) {
    return res.json({ merged: false, message: 'Already linked to your account' });
  }
  
  // Different account exists - need to merge
  if (!confirm) {
    // Return info about what would be merged
    return res.json({
      needs_confirmation: true,
      lightning_account: {
        username: lightningUser.username,
        balance_sats: lightningUser.balance_sats,
        has_email: !!lightningUser.email
      },
      message: 'This Lightning wallet is linked to another account. Confirm to merge accounts.'
    });
  }
  
  // User confirmed - perform merge
  const currentUser = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  
  // Transfer balance from Lightning account to current account
  const newBalance = currentUser.balance_sats + lightningUser.balance_sats;
  db.prepare('UPDATE users SET balance_sats = ?, lightning_pubkey = ? WHERE id = ?')
    .run(newBalance, pubkey, req.user.id);
  
  // Update all orders from Lightning account to current account
  db.prepare('UPDATE orders SET user_id = ? WHERE user_id = ?')
    .run(req.user.id, lightningUser.id);
  
  // Update all bets (both yes and no sides)
  db.prepare('UPDATE bets SET yes_user_id = ? WHERE yes_user_id = ?')
    .run(req.user.id, lightningUser.id);
  db.prepare('UPDATE bets SET no_user_id = ? WHERE no_user_id = ?')
    .run(req.user.id, lightningUser.id);
  db.prepare('UPDATE bets SET winner_user_id = ? WHERE winner_user_id = ?')
    .run(req.user.id, lightningUser.id);
  
  // Update transactions
  db.prepare('UPDATE transactions SET user_id = ? WHERE user_id = ?')
    .run(req.user.id, lightningUser.id);
  
  // Delete the old Lightning-only account
  db.prepare('DELETE FROM users WHERE id = ?').run(lightningUser.id);
  
  lightning.markChallengeUsed(db, k1);
  
  const mergedUser = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  const { password_hash: _, ...safeUser } = mergedUser;
  
  res.json({ 
    merged: true, 
    user: safeUser,
    balance_added: lightningUser.balance_sats
  });
});

// ==================== USER ROUTES ====================

app.get('/api/user/me', authMiddleware, (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  // Don't send password_hash to client
  const { password_hash: _, ...safeUser } = user;
  res.json(safeUser);
});

// Update user profile
app.put('/api/user/profile', authMiddleware, async (req, res) => {
  const { username, email } = req.body;
  const updates = [];
  const params = [];
  
  // Validate and prepare username update
  if (username !== undefined) {
    if (username.length < 2 || username.length > 30) {
      return res.status(400).json({ error: 'Username must be 2-30 characters' });
    }
    if (!/^[a-zA-Z0-9_-]+$/.test(username)) {
      return res.status(400).json({ error: 'Username can only contain letters, numbers, underscores, and hyphens' });
    }
    // Check if username is taken
    const existing = db.prepare('SELECT id FROM users WHERE username = ? AND id != ?').get(username, req.user.id);
    if (existing) {
      return res.status(400).json({ error: 'Username is already taken' });
    }
    updates.push('username = ?');
    params.push(username);
  }
  
  // Validate and prepare email update
  if (email !== undefined) {
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: 'Invalid email format' });
    }
    // Check if email is taken
    if (email) {
      const existing = db.prepare('SELECT id FROM users WHERE email = ? AND id != ?').get(email, req.user.id);
      if (existing) {
        return res.status(400).json({ error: 'Email is already in use by another account' });
      }
    }
    updates.push('email = ?');
    params.push(email || null);
  }
  
  if (updates.length === 0) {
    return res.status(400).json({ error: 'No valid fields to update' });
  }
  
  params.push(req.user.id);
  db.prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`).run(...params);
  
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  const { password_hash: _, ...safeUser } = user;
  res.json(safeUser);
});

// Change password
app.put('/api/user/password', authMiddleware, async (req, res) => {
  const { current_password, new_password } = req.body;
  
  if (!new_password || new_password.length < 6) {
    return res.status(400).json({ error: 'New password must be at least 6 characters' });
  }
  
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  
  // If user has existing password, verify current password
  if (user.password_hash) {
    if (!current_password) {
      return res.status(400).json({ error: 'Current password is required' });
    }
    const isMatch = await bcrypt.compare(current_password, user.password_hash);
    if (!isMatch) {
      return res.status(401).json({ error: 'Current password is incorrect' });
    }
  }
  
  // Hash new password
  const salt = await bcrypt.genSalt(10);
  const password_hash = await bcrypt.hash(new_password, salt);
  
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(password_hash, req.user.id);
  
  res.json({ success: true, message: 'Password updated successfully' });
});

// Unlink Lightning wallet
app.post('/api/user/unlink-lightning', authMiddleware, (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  
  // Ensure user has another login method before unlinking
  if (!user.email && !user.google_id) {
    return res.status(400).json({ 
      error: 'Cannot unlink Lightning wallet - you need email or Google login as backup' 
    });
  }
  
  db.prepare('UPDATE users SET lightning_pubkey = NULL WHERE id = ?').run(req.user.id);
  
  const updatedUser = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  const { password_hash: _, ...safeUser } = updatedUser;
  res.json(safeUser);
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
    SELECT o.*, m.title, m.type, g.name as grandmaster_name
    FROM orders o
    JOIN markets m ON o.market_id = m.id
    LEFT JOIN grandmasters g ON m.grandmaster_id = g.id
    WHERE o.user_id = ? AND o.status IN ('open', 'partial')
    ORDER BY o.created_at DESC
  `).all(req.user.id);
  res.json(orders);
});

// Get all transactions for user (full audit trail)
app.get('/api/user/transactions', authMiddleware, (req, res) => {
  const { limit = 50, offset = 0, type } = req.query;
  
  let query = `
    SELECT t.*, 
           CASE 
             WHEN t.reference_id IS NOT NULL AND t.type IN ('order_placed', 'order_cancelled') THEN o.market_id
             WHEN t.reference_id IS NOT NULL AND t.type = 'bet_won' THEN b.market_id
             ELSE NULL
           END as market_id,
           CASE 
             WHEN t.reference_id IS NOT NULL AND t.type IN ('order_placed', 'order_cancelled') THEN m1.title
             WHEN t.reference_id IS NOT NULL AND t.type = 'bet_won' THEN m2.title
             ELSE NULL
           END as market_title
    FROM transactions t
    LEFT JOIN orders o ON t.reference_id = o.id AND t.type IN ('order_placed', 'order_cancelled')
    LEFT JOIN markets m1 ON o.market_id = m1.id
    LEFT JOIN bets b ON t.reference_id = b.id AND t.type = 'bet_won'
    LEFT JOIN markets m2 ON b.market_id = m2.id
    WHERE t.user_id = ?
  `;
  
  const params = [req.user.id];
  
  if (type && ['deposit', 'withdrawal', 'order_placed', 'order_cancelled', 'bet_won', 'bet_lost'].includes(type)) {
    query += ' AND t.type = ?';
    params.push(type);
  }
  
  query += ' ORDER BY t.created_at DESC LIMIT ? OFFSET ?';
  params.push(parseInt(limit), parseInt(offset));
  
  const transactions = db.prepare(query).all(...params);
  
  // Get total count for pagination
  let countQuery = 'SELECT COUNT(*) as total FROM transactions WHERE user_id = ?';
  const countParams = [req.user.id];
  if (type) {
    countQuery += ' AND type = ?';
    countParams.push(type);
  }
  const { total } = db.prepare(countQuery).get(...countParams);
  
  res.json({ transactions, total, limit: parseInt(limit), offset: parseInt(offset) });
});

// Get trade history (completed bets with full details)
app.get('/api/user/trades', authMiddleware, (req, res) => {
  const { limit = 50, offset = 0 } = req.query;
  
  const trades = db.prepare(`
    SELECT b.*, 
           m.title as market_title, 
           m.type as market_type,
           m.status as market_status,
           m.resolution as market_resolution,
           g.name as grandmaster_name,
           CASE WHEN b.yes_user_id = ? THEN 'yes' ELSE 'no' END as user_side,
           CASE WHEN b.winner_user_id = ? THEN 'won' 
                WHEN b.winner_user_id IS NOT NULL THEN 'lost'
                ELSE 'pending' END as result
    FROM bets b
    JOIN markets m ON b.market_id = m.id
    LEFT JOIN grandmasters g ON m.grandmaster_id = g.id
    WHERE b.yes_user_id = ? OR b.no_user_id = ?
    ORDER BY b.created_at DESC
    LIMIT ? OFFSET ?
  `).all(req.user.id, req.user.id, req.user.id, req.user.id, parseInt(limit), parseInt(offset));
  
  const { total } = db.prepare(`
    SELECT COUNT(*) as total FROM bets WHERE yes_user_id = ? OR no_user_id = ?
  `).get(req.user.id, req.user.id);
  
  res.json({ trades, total, limit: parseInt(limit), offset: parseInt(offset) });
});

// ==================== LIGHTNING/WALLET ROUTES ====================

app.post('/api/wallet/deposit', authMiddleware, async (req, res) => {
  const { amount_sats } = req.body;
  if (!amount_sats || amount_sats < 1000) {
    return res.status(400).json({ error: 'Minimum deposit is 1000 sats' });
  }
  
  try {
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    const invoice = await lightning.createInvoice(amount_sats, `Deposit for ${user.email || user.username || 'user'}`);
    
    // Record pending transaction
    db.prepare(`
      INSERT INTO transactions (id, user_id, type, amount_sats, balance_after, lightning_invoice, lightning_payment_hash, status)
      VALUES (?, ?, 'deposit', ?, 0, ?, ?, 'pending')
    `).run(uuidv4(), req.user.id, amount_sats, invoice.payment_request, invoice.payment_hash);
    
    res.json({
      ...invoice,
      is_real: invoice.is_real, // Let frontend know if this is a real invoice
    });
  } catch (err) {
    console.error('Deposit error:', err);
    res.status(500).json({ error: err.message || 'Failed to create deposit invoice' });
  }
});

app.post('/api/wallet/check-deposit', authMiddleware, async (req, res) => {
  const { payment_hash } = req.body;
  
  try {
    const invoice = await lightning.checkInvoice(payment_hash);
    
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
        
        return res.json({ status: 'credited', balance_sats: newBalance, is_real: invoice.is_real });
      }
      
      // Already credited
      return res.json({ status: 'already_credited', is_real: invoice.is_real });
    }
    
    res.json({ status: invoice.status, is_real: invoice.is_real });
  } catch (err) {
    console.error('Check deposit error:', err);
    res.status(500).json({ error: err.message || 'Failed to check deposit status' });
  }
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
  
  // BOT SAFEGUARD: If user is admin with bot active, check if max_loss exceeds new balance
  // and proportionally reduce offers if needed
  let botAdjustment = null;
  if (req.user.is_admin) {
    try {
      const config = bot.getConfig();
      if (config && config.max_acceptable_loss > newBalance) {
        // Max loss now exceeds balance - need to reduce it to match new balance
        const oldMaxLoss = config.max_acceptable_loss;
        const ratio = newBalance / oldMaxLoss;
        
        // Update config to new max loss
        bot.updateConfig({ max_acceptable_loss: newBalance });
        
        // If there are active orders, cancel and redeploy with reduced amounts
        const activeOrders = db.prepare(`
          SELECT COUNT(*) as count FROM orders 
          WHERE user_id = ? AND status IN ('open', 'partial')
        `).get(req.user.id);
        
        if (activeOrders.count > 0) {
          // Withdraw all orders and let the user redeploy manually
          const withdrawResult = bot.withdrawAllOrders(req.user.id);
          botAdjustment = {
            reduced: true,
            old_max_loss: oldMaxLoss,
            new_max_loss: newBalance,
            ratio: ratio,
            orders_withdrawn: withdrawResult.ordersCancelled,
            refunded: withdrawResult.refund,
            message: 'Bot max_loss reduced to match new balance. Orders withdrawn - please redeploy.'
          };
        } else {
          botAdjustment = {
            reduced: true,
            old_max_loss: oldMaxLoss,
            new_max_loss: newBalance,
            ratio: ratio,
            message: 'Bot max_loss reduced to match new balance.'
          };
        }
      }
    } catch (err) {
      console.error('Bot adjustment on withdrawal failed:', err);
      // Continue with withdrawal even if bot adjustment fails
    }
  }
  
  res.json({ 
    success: true, 
    balance_sats: newBalance,
    bot_adjustment: botAdjustment
  });
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
  
  // Track if we matched with any bot orders (for atomic pullback)
  let matchedBotOrders = false;
  
  for (const matchOrder of matchingOrders) {
    if (remainingAmount <= 0) break;
    
    const matchAvailable = matchOrder.amount_sats - matchOrder.filled_sats;
    const matchAmount = Math.min(remainingAmount, matchAvailable);
    const tradePrice = matchOrder.price_cents; // Price from the resting order
    
    // Check if this is a bot order
    const isBotMatch = bot.isBotUser(matchOrder.user_id);
    if (isBotMatch) {
      matchedBotOrders = true;
    }
    
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
    matchedBets.push({ betId, amount: matchAmount, price: 100 - tradePrice, isBotOrder: isBotMatch });
  }
  
  // ATOMIC BOT PULLBACK - If we matched with bot orders, trigger pullback BEFORE returning
  let pullbackResult = null;
  if (matchedBotOrders) {
    pullbackResult = bot.atomicPullback(amount_sats - remainingAmount, market_id);
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

// ==================== BOT ADMIN ROUTES ====================

// Get bot statistics and status
app.get('/api/admin/bot/stats', authMiddleware, adminMiddleware, (req, res) => {
  try {
    const stats = bot.getStats();
    const worstCase = bot.calculateWorstCase();
    res.json({ ...stats, worstCase });
  } catch (err) {
    console.error('Bot stats error:', err);
    res.status(500).json({ error: 'Failed to get bot stats', message: err.message });
  }
});

// Get bot configuration
app.get('/api/admin/bot/config', authMiddleware, adminMiddleware, (req, res) => {
  try {
    const config = bot.getConfig();
    res.json(config);
  } catch (err) {
    res.status(500).json({ error: 'Failed to get bot config', message: err.message });
  }
});

// Update bot configuration
app.put('/api/admin/bot/config', authMiddleware, adminMiddleware, (req, res) => {
  try {
    const { max_acceptable_loss, total_liquidity, threshold_percent, global_multiplier, is_active } = req.body;
    
    // VALIDATION: max_acceptable_loss cannot exceed user's current balance
    if (max_acceptable_loss !== undefined) {
      const user = db.prepare('SELECT balance_sats FROM users WHERE id = ?').get(req.user.id);
      if (!user) {
        return res.status(400).json({ error: 'User not found' });
      }
      if (max_acceptable_loss > user.balance_sats) {
        return res.status(400).json({ 
          error: 'Max acceptable loss cannot exceed your balance',
          max_allowed: user.balance_sats,
          requested: max_acceptable_loss
        });
      }
    }
    
    const config = bot.updateConfig({
      max_acceptable_loss,
      total_liquidity,
      threshold_percent,
      global_multiplier,
      is_active
    });
    res.json({ success: true, config });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update bot config', message: err.message });
  }
});

// Get buy curve
app.get('/api/admin/bot/curves/buy', authMiddleware, adminMiddleware, (req, res) => {
  const { market_type = 'attendance' } = req.query;
  try {
    const curve = bot.getBuyCurve(market_type);
    res.json(curve);
  } catch (err) {
    res.status(500).json({ error: 'Failed to get buy curve', message: err.message });
  }
});

// Get sell curve
app.get('/api/admin/bot/curves/sell', authMiddleware, adminMiddleware, (req, res) => {
  const { market_type = 'attendance' } = req.query;
  try {
    const curve = bot.getSellCurve(market_type);
    res.json(curve);
  } catch (err) {
    res.status(500).json({ error: 'Failed to get sell curve', message: err.message });
  }
});

// Save buy curve
app.put('/api/admin/bot/curves/buy', authMiddleware, adminMiddleware, (req, res) => {
  const { market_type = 'attendance', price_points } = req.body;
  if (!Array.isArray(price_points)) {
    return res.status(400).json({ error: 'price_points must be an array' });
  }
  try {
    const id = bot.saveCurve(market_type, 'buy', price_points);
    res.json({ success: true, id });
  } catch (err) {
    res.status(500).json({ error: 'Failed to save buy curve', message: err.message });
  }
});

// Save sell curve
app.put('/api/admin/bot/curves/sell', authMiddleware, adminMiddleware, (req, res) => {
  const { market_type = 'attendance', price_points } = req.body;
  if (!Array.isArray(price_points)) {
    return res.status(400).json({ error: 'price_points must be an array' });
  }
  try {
    const id = bot.saveCurve(market_type, 'sell', price_points);
    res.json({ success: true, id });
  } catch (err) {
    res.status(500).json({ error: 'Failed to save sell curve', message: err.message });
  }
});

// Get market override
app.get('/api/admin/bot/markets/:marketId/override', authMiddleware, adminMiddleware, (req, res) => {
  try {
    const override = bot.getMarketOverride(req.params.marketId);
    res.json(override || { override_type: null });
  } catch (err) {
    res.status(500).json({ error: 'Failed to get market override', message: err.message });
  }
});

// Set market override
app.put('/api/admin/bot/markets/:marketId/override', authMiddleware, adminMiddleware, (req, res) => {
  const { override_type, multiplier, custom_curve } = req.body;
  try {
    const id = bot.setMarketOverride(req.params.marketId, override_type, { multiplier, customCurve: custom_curve });
    res.json({ success: true, id });
  } catch (err) {
    res.status(500).json({ error: 'Failed to set market override', message: err.message });
  }
});

// Get effective curve for a specific market
app.get('/api/admin/bot/markets/:marketId/effective-curve', authMiddleware, adminMiddleware, (req, res) => {
  const { curve_type = 'buy' } = req.query;
  try {
    const curve = bot.getEffectiveCurve(req.params.marketId, curve_type);
    res.json({ market_id: req.params.marketId, curve_type, curve });
  } catch (err) {
    res.status(500).json({ error: 'Failed to get effective curve', message: err.message });
  }
});

// Get all bot orders
app.get('/api/admin/bot/orders', authMiddleware, adminMiddleware, (req, res) => {
  try {
    const orders = bot.getBotOrders();
    res.json(orders);
  } catch (err) {
    res.status(500).json({ error: 'Failed to get bot orders', message: err.message });
  }
});

// Get bot holdings (NO shares acquired)
app.get('/api/admin/bot/holdings', authMiddleware, adminMiddleware, (req, res) => {
  try {
    const holdings = bot.getBotHoldings();
    res.json(holdings);
  } catch (err) {
    res.status(500).json({ error: 'Failed to get bot holdings', message: err.message });
  }
});

// Deploy orders for a single market (uses logged-in user's account)
app.post('/api/admin/bot/deploy/:marketId', authMiddleware, adminMiddleware, (req, res) => {
  try {
    const result = bot.deployMarketOrders(req.params.marketId, req.user.id);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: 'Failed to deploy market orders', message: err.message });
  }
});

// Deploy orders for all attendance markets (uses logged-in user's account)
app.post('/api/admin/bot/deploy-all', authMiddleware, adminMiddleware, (req, res) => {
  try {
    const result = bot.deployAllOrders(req.user.id);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: 'Failed to deploy all orders', message: err.message });
  }
});

// Get deployment preview (shows exactly what will be deployed)
app.get('/api/admin/bot/deployment-preview', authMiddleware, adminMiddleware, (req, res) => {
  try {
    const preview = bot.getDeploymentPreview(req.user.id);
    res.json(preview);
  } catch (err) {
    res.status(500).json({ error: 'Failed to get deployment preview', message: err.message });
  }
});

// Withdraw all bot orders (uses logged-in user's account)
app.post('/api/admin/bot/withdraw-all', authMiddleware, adminMiddleware, (req, res) => {
  try {
    const result = bot.withdrawAllOrders(req.user.id);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: 'Failed to withdraw all orders', message: err.message });
  }
});

// Cancel all orders for logged-in user (general portfolio function)
app.post('/api/orders/cancel-all', authMiddleware, (req, res) => {
  try {
    const result = bot.cancelAllUserOrders(req.user.id);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: 'Failed to cancel all orders', message: err.message });
  }
});

// Get bot activity log
app.get('/api/admin/bot/log', authMiddleware, adminMiddleware, (req, res) => {
  const { limit = 50 } = req.query;
  try {
    const log = bot.getActivityLog(parseInt(limit));
    res.json(log);
  } catch (err) {
    res.status(500).json({ error: 'Failed to get bot log', message: err.message });
  }
});

// Get worst case analysis
app.get('/api/admin/bot/worst-case', authMiddleware, adminMiddleware, (req, res) => {
  try {
    const worstCase = bot.calculateWorstCase();
    res.json(worstCase);
  } catch (err) {
    res.status(500).json({ error: 'Failed to calculate worst case', message: err.message });
  }
});

// Batch set market overrides
app.post('/api/admin/bot/batch-override', authMiddleware, adminMiddleware, (req, res) => {
  const { market_ids, override_type, multiplier } = req.body;
  if (!Array.isArray(market_ids)) {
    return res.status(400).json({ error: 'market_ids must be an array' });
  }
  
  try {
    let updated = 0;
    for (const marketId of market_ids) {
      bot.setMarketOverride(marketId, override_type, { multiplier });
      updated++;
    }
    res.json({ success: true, updated });
  } catch (err) {
    res.status(500).json({ error: 'Failed to batch override', message: err.message });
  }
});

// Get all markets with bot status
app.get('/api/admin/bot/markets', authMiddleware, adminMiddleware, (req, res) => {
  try {
    const markets = db.prepare(`
      SELECT m.id, m.title, m.type, m.status, g.name as grandmaster_name, g.fide_rating,
             bmo.override_type, bmo.multiplier
      FROM markets m
      LEFT JOIN grandmasters g ON m.grandmaster_id = g.id
      LEFT JOIN bot_market_overrides bmo ON bmo.market_id = m.id AND bmo.config_id = 'default'
      WHERE m.type = 'attendance' AND m.status = 'open'
      ORDER BY g.fide_rating DESC
    `).all();
    
    // Add effective curve info for each market
    const marketsWithCurves = markets.map(m => {
      const effectiveCurve = bot.getEffectiveCurve(m.id, 'buy');
      const totalOffered = effectiveCurve ? effectiveCurve.reduce((sum, p) => sum + p.amount, 0) : 0;
      return {
        ...m,
        bot_enabled: effectiveCurve !== null,
        total_offered: totalOffered,
        price_points: effectiveCurve ? effectiveCurve.length : 0
      };
    });
    
    res.json(marketsWithCurves);
  } catch (err) {
    res.status(500).json({ error: 'Failed to get bot markets', message: err.message });
  }
});

// ==================== CURVE SHAPE LIBRARY ROUTES ====================

// Generate a shape preview (without saving)
app.post('/api/admin/bot/shapes/preview', authMiddleware, adminMiddleware, (req, res) => {
  const { shape_type, params } = req.body;
  try {
    const shape = bot.generateShape(shape_type, params || {});
    res.json({ shape_type, params, normalized_points: shape });
  } catch (err) {
    res.status(500).json({ error: 'Failed to generate shape', message: err.message });
  }
});

// Get all saved shapes
app.get('/api/admin/bot/shapes', authMiddleware, adminMiddleware, (req, res) => {
  try {
    const shapes = bot.getShapes();
    res.json(shapes);
  } catch (err) {
    res.status(500).json({ error: 'Failed to get shapes', message: err.message });
  }
});

// Get default shape
app.get('/api/admin/bot/shapes/default', authMiddleware, adminMiddleware, (req, res) => {
  try {
    const shape = bot.getDefaultShape();
    res.json(shape);
  } catch (err) {
    res.status(500).json({ error: 'Failed to get default shape', message: err.message });
  }
});

// Save a new shape
app.post('/api/admin/bot/shapes', authMiddleware, adminMiddleware, (req, res) => {
  const { name, shape_type, params, normalized_points } = req.body;
  if (!name || !shape_type) {
    return res.status(400).json({ error: 'name and shape_type are required' });
  }
  try {
    const shape = bot.saveShape(name, shape_type, params || {}, normalized_points);
    res.json({ success: true, shape });
  } catch (err) {
    res.status(500).json({ error: 'Failed to save shape', message: err.message });
  }
});

// Get a specific shape
app.get('/api/admin/bot/shapes/:id', authMiddleware, adminMiddleware, (req, res) => {
  try {
    const shape = bot.getShape(req.params.id);
    if (!shape) {
      return res.status(404).json({ error: 'Shape not found' });
    }
    res.json(shape);
  } catch (err) {
    res.status(500).json({ error: 'Failed to get shape', message: err.message });
  }
});

// Update a shape's parameters
app.put('/api/admin/bot/shapes/:id', authMiddleware, adminMiddleware, (req, res) => {
  const { params, normalized_points } = req.body;
  try {
    const shape = bot.updateShape(req.params.id, { ...params, normalized_points });
    res.json({ success: true, shape });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update shape', message: err.message });
  }
});

// Set a shape as default
app.post('/api/admin/bot/shapes/:id/set-default', authMiddleware, adminMiddleware, (req, res) => {
  try {
    bot.setDefaultShape(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to set default shape', message: err.message });
  }
});

// Delete a shape
app.delete('/api/admin/bot/shapes/:id', authMiddleware, adminMiddleware, (req, res) => {
  try {
    bot.deleteShape(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ==================== MARKET WEIGHTS ROUTES ====================

// Initialize weights for all attendance markets
app.post('/api/admin/bot/weights/initialize', authMiddleware, adminMiddleware, (req, res) => {
  try {
    bot.initializeMarketWeights();
    const weights = bot.getMarketWeights();
    res.json({ success: true, weights });
  } catch (err) {
    res.status(500).json({ error: 'Failed to initialize weights', message: err.message });
  }
});

// Get all market weights
app.get('/api/admin/bot/weights', authMiddleware, adminMiddleware, (req, res) => {
  try {
    const weights = bot.getMarketWeights();
    res.json(weights);
  } catch (err) {
    res.status(500).json({ error: 'Failed to get weights', message: err.message });
  }
});

// Set weight for a specific market (auto-rebalances others)
app.put('/api/admin/bot/weights/:marketId', authMiddleware, adminMiddleware, (req, res) => {
  const { weight, lock } = req.body;
  if (weight === undefined || weight < 0 || weight > 1) {
    return res.status(400).json({ error: 'weight must be between 0 and 1' });
  }
  try {
    bot.setMarketWeight(req.params.marketId, weight, lock || false);
    const weights = bot.getMarketWeights();
    res.json({ success: true, weights });
  } catch (err) {
    res.status(500).json({ error: 'Failed to set weight', message: err.message });
  }
});

// Lock/unlock a market weight
app.put('/api/admin/bot/weights/:marketId/lock', authMiddleware, adminMiddleware, (req, res) => {
  const { locked } = req.body;
  try {
    bot.setWeightLock(req.params.marketId, !!locked);
    const weights = bot.getMarketWeights();
    res.json({ success: true, weights });
  } catch (err) {
    res.status(500).json({ error: 'Failed to set lock', message: err.message });
  }
});

// Set relative odds for a market
app.put('/api/admin/bot/weights/:marketId/odds', authMiddleware, adminMiddleware, (req, res) => {
  const { relative_odds } = req.body;
  if (relative_odds === undefined || relative_odds < 0) {
    return res.status(400).json({ error: 'relative_odds must be >= 0' });
  }
  try {
    bot.setRelativeOdds(req.params.marketId, relative_odds);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to set relative odds', message: err.message });
  }
});

// Apply relative odds to recalculate weights
app.post('/api/admin/bot/weights/apply-odds', authMiddleware, adminMiddleware, (req, res) => {
  try {
    bot.applyRelativeOdds();
    const weights = bot.getMarketWeights();
    res.json({ success: true, weights });
  } catch (err) {
    res.status(500).json({ error: 'Failed to apply relative odds', message: err.message });
  }
});

// Batch set relative odds (for importing a vector)
app.post('/api/admin/bot/weights/batch-odds', authMiddleware, adminMiddleware, (req, res) => {
  const { odds } = req.body;
  // odds should be array of { market_id, relative_odds }
  if (!Array.isArray(odds)) {
    return res.status(400).json({ error: 'odds must be an array of { market_id, relative_odds }' });
  }
  try {
    for (const item of odds) {
      if (item.market_id && item.relative_odds !== undefined) {
        bot.setRelativeOdds(item.market_id, item.relative_odds);
      }
    }
    bot.applyRelativeOdds();
    const weights = bot.getMarketWeights();
    res.json({ success: true, weights });
  } catch (err) {
    res.status(500).json({ error: 'Failed to batch set odds', message: err.message });
  }
});

// ==================== TIER MANAGEMENT ROUTES ====================

// Get tier summary (all tiers with budget percentages)
app.get('/api/admin/bot/tiers', authMiddleware, adminMiddleware, (req, res) => {
  try {
    const tiers = bot.getTierSummary();
    res.json(tiers);
  } catch (err) {
    res.status(500).json({ error: 'Failed to get tier summary', message: err.message });
  }
});

// Get markets in a specific tier
app.get('/api/admin/bot/tiers/:tier/markets', authMiddleware, adminMiddleware, (req, res) => {
  try {
    const markets = bot.getMarketsByTier(req.params.tier);
    res.json(markets);
  } catch (err) {
    res.status(500).json({ error: 'Failed to get tier markets', message: err.message });
  }
});

// Set budget percentage for a tier (auto-rebalances other tiers)
app.put('/api/admin/bot/tiers/:tier/budget', authMiddleware, adminMiddleware, (req, res) => {
  const { budget_percent } = req.body;
  if (budget_percent === undefined || budget_percent < 0 || budget_percent > 100) {
    return res.status(400).json({ error: 'budget_percent must be between 0 and 100' });
  }
  try {
    const tiers = bot.setTierBudget(req.params.tier, budget_percent);
    res.json({ success: true, tiers });
  } catch (err) {
    res.status(500).json({ error: 'Failed to set tier budget', message: err.message });
  }
});

// Initialize weights from likelihood scores
app.post('/api/admin/bot/tiers/initialize-from-scores', authMiddleware, adminMiddleware, (req, res) => {
  try {
    bot.initializeWeightsFromScores();
    const tiers = bot.getTierSummary();
    res.json({ success: true, tiers });
  } catch (err) {
    res.status(500).json({ error: 'Failed to initialize from scores', message: err.message });
  }
});

// ==================== HEALTH CHECK ====================
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Serve frontend for any non-API routes in production
if (process.env.NODE_ENV === 'production') {
  app.get('/{*splat}', (req, res) => {
    res.sendFile(path.join(__dirname, '../frontend/dist/index.html'));
  });
}

app.listen(PORT, () => {
  console.log(`Bitcoin Chess 960 Predictions API running on port ${PORT}`);
});
