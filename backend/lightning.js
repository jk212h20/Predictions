/**
 * Lightning/Voltage integration with LNURL-auth support
 * Includes: Invoice creation, LNURL-auth, signature verification
 */

const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');
const secp256k1 = require('secp256k1');
const { bech32 } = require('bech32');

// In-memory store for mock invoices (in production, this comes from Voltage/LND)
const mockInvoices = new Map();
const mockPayments = new Map();

// ==================== LNURL-AUTH CONFIGURATION ====================

// Challenge expiry time (5 minutes)
const CHALLENGE_EXPIRY_MS = 5 * 60 * 1000;

// Friendly username word lists
const ADJECTIVES = [
  'Swift', 'Bold', 'Bright', 'Cosmic', 'Crystal', 'Digital', 'Electric', 'Flash',
  'Golden', 'Happy', 'Iron', 'Jade', 'Keen', 'Lucky', 'Mighty', 'Noble',
  'Orange', 'Prime', 'Quick', 'Rapid', 'Silver', 'Storm', 'Thunder', 'Ultra',
  'Vivid', 'Wild', 'Xenon', 'Young', 'Zesty', 'Atomic', 'Blazing', 'Cyber',
  'Dynamic', 'Epic', 'Fierce', 'Galactic', 'Hyper', 'Infinite', 'Jet', 'Kinetic',
  'Lunar', 'Mega', 'Nova', 'Omega', 'Plasma', 'Quantum', 'Radiant', 'Sonic',
  'Turbo', 'Vertex', 'Warp', 'Zero', 'Alpha', 'Beta', 'Gamma', 'Delta'
];

const NOUNS = [
  'Satoshi', 'Hodler', 'Knight', 'Wizard', 'Phoenix', 'Dragon', 'Tiger', 'Eagle',
  'Falcon', 'Shark', 'Wolf', 'Bear', 'Lion', 'Hawk', 'Raven', 'Fox',
  'Pawn', 'Rook', 'Bishop', 'Queen', 'King', 'Castle', 'Tower', 'Crown',
  'Comet', 'Star', 'Moon', 'Sun', 'Planet', 'Nebula', 'Galaxy', 'Cosmos',
  'Node', 'Block', 'Chain', 'Hash', 'Miner', 'Stacker', 'Trader', 'Builder',
  'Spark', 'Bolt', 'Surge', 'Wave', 'Pulse', 'Stream', 'Flame', 'Frost',
  'Shadow', 'Light', 'Storm', 'Wind', 'Fire', 'Ice', 'Thunder', 'Rain'
];

/**
 * Generate a random friendly username
 * Format: AdjectiveNoun + 2-3 random digits
 * @returns {string} A friendly username like "SwiftSatoshi42"
 */
function generateFriendlyUsername() {
  const adjective = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
  const noun = NOUNS[Math.floor(Math.random() * NOUNS.length)];
  const number = Math.floor(Math.random() * 900) + 10; // 10-999
  return `${adjective}${noun}${number}`;
}

/**
 * Get the next account number for a new user
 * @param {Object} db - Database instance
 * @returns {number} The next sequential account number
 */
function getNextAccountNumber(db) {
  const result = db.prepare('SELECT MAX(account_number) as max_num FROM users').get();
  return (result.max_num || 0) + 1;
}

// ==================== LNURL-AUTH FUNCTIONS ====================

/**
 * Generate a cryptographically secure k1 challenge
 * @returns {string} 32-byte hex string
 */
function generateK1() {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * Encode a URL as LNURL (bech32 with 'lnurl' prefix)
 * @param {string} url - The URL to encode
 * @returns {string} Bech32-encoded LNURL string
 */
function encodeLnurl(url) {
  const words = bech32.toWords(Buffer.from(url, 'utf8'));
  return bech32.encode('lnurl', words, 2000).toUpperCase();
}

/**
 * Generate an LNURL-auth challenge for login
 * @param {Object} db - Database instance
 * @param {string} baseUrl - Base URL for callback (e.g., https://yoursite.com)
 * @returns {Object} Challenge object with k1, encoded LNURL, and QR data
 */
function generateAuthChallenge(db, baseUrl) {
  const k1 = generateK1();
  const expiresAt = new Date(Date.now() + CHALLENGE_EXPIRY_MS).toISOString();
  
  // Store challenge in database
  db.prepare(`
    INSERT INTO lnurl_auth_challenges (k1, expires_at, status)
    VALUES (?, ?, 'pending')
  `).run(k1, expiresAt);
  
  // Build callback URL (wallet will call this)
  const callbackUrl = `${baseUrl}/api/auth/lnurl/callback`;
  
  // Build full LNURL (what gets encoded in QR)
  const lnurlParams = new URLSearchParams({
    tag: 'login',
    k1: k1,
    action: 'login'
  });
  const fullUrl = `${callbackUrl}?${lnurlParams.toString()}`;
  
  // Encode as LNURL (bech32)
  const encoded = encodeLnurl(fullUrl);
  
  return {
    k1,
    encoded, // The LNURL string (for QR code)
    callback: callbackUrl,
    expires_at: expiresAt,
    // For mobile deep-linking
    uri: `lightning:${encoded}`
  };
}

/**
 * Verify a signature from a Lightning wallet
 * @param {string} k1 - The challenge (hex)
 * @param {string} sig - The signature (hex, DER encoded)
 * @param {string} key - The public key (hex, 33 bytes compressed)
 * @returns {boolean} True if signature is valid
 */
function verifySignature(k1, sig, key) {
  try {
    // Convert hex strings to Buffers
    const messageHash = Buffer.from(k1, 'hex');
    const signatureDER = Buffer.from(sig, 'hex');
    const publicKey = Buffer.from(key, 'hex');
    
    // Validate public key format (must be 33 bytes, compressed)
    if (publicKey.length !== 33) {
      console.error('Invalid public key length:', publicKey.length);
      return false;
    }
    
    // Validate message hash (must be 32 bytes)
    if (messageHash.length !== 32) {
      console.error('Invalid k1 length:', messageHash.length);
      return false;
    }
    
    // Convert DER signature to compact format (64 bytes)
    // DER format: 0x30 [total-len] 0x02 [r-len] [r] 0x02 [s-len] [s]
    let signature;
    if (signatureDER[0] === 0x30) {
      // DER encoded - need to parse
      const rLen = signatureDER[3];
      const rStart = 4;
      const sLen = signatureDER[5 + rLen];
      const sStart = 6 + rLen;
      
      // Extract r and s, padding/trimming to 32 bytes each
      let r = signatureDER.slice(rStart, rStart + rLen);
      let s = signatureDER.slice(sStart, sStart + sLen);
      
      // Remove leading zeros if present (DER adds them for sign bit)
      if (r.length === 33 && r[0] === 0) r = r.slice(1);
      if (s.length === 33 && s[0] === 0) s = s.slice(1);
      
      // Pad to 32 bytes if needed
      if (r.length < 32) r = Buffer.concat([Buffer.alloc(32 - r.length), r]);
      if (s.length < 32) s = Buffer.concat([Buffer.alloc(32 - s.length), s]);
      
      signature = Buffer.concat([r, s]);
    } else if (signatureDER.length === 64) {
      // Already compact format
      signature = signatureDER;
    } else {
      console.error('Unknown signature format, length:', signatureDER.length);
      return false;
    }
    
    // Verify the signature
    return secp256k1.ecdsaVerify(signature, messageHash, publicKey);
  } catch (err) {
    console.error('Signature verification error:', err);
    return false;
  }
}

/**
 * Process a callback from a Lightning wallet (LNURL-auth)
 * @param {Object} db - Database instance
 * @param {string} k1 - The challenge
 * @param {string} sig - The signature
 * @param {string} key - The public key (linking key)
 * @returns {Object} Result object with status and any errors
 */
function processAuthCallback(db, k1, sig, key) {
  // Check if challenge exists and is valid
  const challenge = db.prepare(`
    SELECT * FROM lnurl_auth_challenges WHERE k1 = ?
  `).get(k1);
  
  if (!challenge) {
    return { ok: false, error: 'Invalid k1 challenge' };
  }
  
  if (challenge.status !== 'pending') {
    return { ok: false, error: `Challenge already ${challenge.status}` };
  }
  
  if (new Date(challenge.expires_at) < new Date()) {
    db.prepare('UPDATE lnurl_auth_challenges SET status = ? WHERE k1 = ?')
      .run('expired', k1);
    return { ok: false, error: 'Challenge expired' };
  }
  
  // Verify the signature
  if (!verifySignature(k1, sig, key)) {
    return { ok: false, error: 'Invalid signature' };
  }
  
  // Signature valid! Mark challenge as verified
  db.prepare(`
    UPDATE lnurl_auth_challenges 
    SET status = 'verified', lightning_pubkey = ?, signature = ?, verified_at = datetime('now')
    WHERE k1 = ?
  `).run(key, sig, k1);
  
  return { ok: true };
}

/**
 * Check the status of an LNURL-auth challenge
 * @param {Object} db - Database instance
 * @param {string} k1 - The challenge
 * @returns {Object} Status object
 */
function getAuthStatus(db, k1) {
  const challenge = db.prepare(`
    SELECT * FROM lnurl_auth_challenges WHERE k1 = ?
  `).get(k1);
  
  if (!challenge) {
    return { status: 'not_found' };
  }
  
  // Check expiry
  if (challenge.status === 'pending' && new Date(challenge.expires_at) < new Date()) {
    db.prepare('UPDATE lnurl_auth_challenges SET status = ? WHERE k1 = ?')
      .run('expired', k1);
    return { status: 'expired' };
  }
  
  return {
    status: challenge.status,
    lightning_pubkey: challenge.lightning_pubkey,
    verified_at: challenge.verified_at
  };
}

/**
 * Mark a challenge as used (after JWT is issued)
 * @param {Object} db - Database instance
 * @param {string} k1 - The challenge
 */
function markChallengeUsed(db, k1) {
  db.prepare('UPDATE lnurl_auth_challenges SET status = ? WHERE k1 = ?')
    .run('used', k1);
}

/**
 * Clean up expired challenges (call periodically)
 * @param {Object} db - Database instance
 * @returns {number} Number of deleted challenges
 */
function cleanupExpiredChallenges(db) {
  const result = db.prepare(`
    DELETE FROM lnurl_auth_challenges 
    WHERE status = 'expired' OR (status = 'pending' AND expires_at < datetime('now'))
  `).run();
  return result.changes;
}

// ==================== MOCK LIGHTNING FUNCTIONS ====================

/**
 * Generate a mock Lightning invoice for deposits
 * In production: Call Voltage API to create real invoice
 */
function createInvoice(amountSats, memo = 'Deposit to Bitcoin Chess 960 Predictions') {
  const paymentHash = uuidv4().replace(/-/g, '');
  const invoice = {
    payment_hash: paymentHash,
    payment_request: `lnbc${amountSats}n1mock${paymentHash.slice(0, 20)}`, // Fake invoice string
    amount_sats: amountSats,
    memo,
    status: 'pending',
    created_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 3600000).toISOString(), // 1 hour expiry
  };
  
  mockInvoices.set(paymentHash, invoice);
  return invoice;
}

/**
 * Check if an invoice has been paid
 * In production: Query Voltage/LND for invoice status
 */
function checkInvoice(paymentHash) {
  const invoice = mockInvoices.get(paymentHash);
  if (!invoice) {
    return { status: 'not_found' };
  }
  return invoice;
}

/**
 * Simulate paying an invoice (for testing)
 * In production: This would be triggered by webhook from Voltage
 */
function simulatePayment(paymentHash) {
  const invoice = mockInvoices.get(paymentHash);
  if (invoice && invoice.status === 'pending') {
    invoice.status = 'paid';
    invoice.paid_at = new Date().toISOString();
    return { success: true, invoice };
  }
  return { success: false, error: 'Invoice not found or already paid' };
}

/**
 * Send a Lightning payment for withdrawals
 * In production: Call Voltage API to pay invoice
 */
function payInvoice(paymentRequest, amountSats) {
  const paymentId = uuidv4();
  const payment = {
    id: paymentId,
    payment_request: paymentRequest,
    amount_sats: amountSats,
    status: 'completed', // Mock: instant success
    created_at: new Date().toISOString(),
  };
  
  mockPayments.set(paymentId, payment);
  return payment;
}

/**
 * Get node info
 * In production: Return actual node pubkey and alias
 */
function getNodeInfo() {
  return {
    pubkey: 'mock_03' + 'a'.repeat(64),
    alias: 'Bitcoin Chess 960 Predictions',
    network: 'mainnet',
  };
}

module.exports = {
  // Invoice functions
  createInvoice,
  checkInvoice,
  simulatePayment,
  payInvoice,
  getNodeInfo,
  mockInvoices,
  
  // LNURL-auth functions
  generateAuthChallenge,
  verifySignature,
  processAuthCallback,
  getAuthStatus,
  markChallengeUsed,
  cleanupExpiredChallenges,
  
  // Username generation
  generateFriendlyUsername,
  getNextAccountNumber,
  
  // Utilities
  encodeLnurl,
  generateK1,
};
