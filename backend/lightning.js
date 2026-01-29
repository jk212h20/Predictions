/**
 * Lightning/Voltage integration with LNURL-auth support
 * Includes: Invoice creation via Voltage API, LNURL-auth, signature verification
 */

const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');
const secp256k1 = require('secp256k1');
const { bech32 } = require('bech32');

// ==================== LND REST API CONFIGURATION ====================

const LND_REST_URL = process.env.LND_REST_URL;
const LND_MACAROON = process.env.LND_MACAROON;

// Check if LND is configured
const isVoltageConfigured = () => {
  return !!(LND_REST_URL && LND_MACAROON);
};

// Make authenticated request to LND REST API
async function lndRequest(endpoint, options = {}) {
  const url = `${LND_REST_URL}${endpoint}`;
  
  const headers = {
    'Content-Type': 'application/json',
    'Grpc-Metadata-macaroon': LND_MACAROON,
  };
  
  const response = await fetch(url, {
    ...options,
    headers: {
      ...headers,
      ...options.headers,
    },
  });
  
  const data = await response.json();
  
  if (!response.ok) {
    console.error('LND API error:', data);
    throw new Error(data.message || data.error || `LND API error: ${response.status}`);
  }
  
  return data;
}

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

// ==================== LIGHTNING INVOICE FUNCTIONS (VOLTAGE) ====================

// In-memory store for mock invoices (used when Voltage is not configured)
const mockInvoices = new Map();
const mockPayments = new Map();

/**
 * Generate a Lightning invoice for deposits
 * Uses Voltage API if configured, otherwise falls back to mock
 * @param {number} amountSats - Amount in satoshis
 * @param {string} memo - Invoice description
 * @returns {Object} Invoice object with payment_request, payment_hash, etc.
 */
async function createInvoice(amountSats, memo = 'Deposit to Bitcoin Chess 960 Predictions') {
  // Use real LND API if configured
  if (isVoltageConfigured()) {
    try {
      console.log(`Creating LND invoice for ${amountSats} sats...`);
      
      // LND REST API: POST /v1/invoices
      const response = await lndRequest('/v1/invoices', {
        method: 'POST',
        body: JSON.stringify({
          value: amountSats.toString(), // LND expects string
          memo: memo,
          expiry: '3600', // 1 hour expiry
        }),
      });
      
      // LND returns r_hash as base64, we need to convert to hex for our use
      const paymentHashHex = Buffer.from(response.r_hash, 'base64').toString('hex');
      
      console.log('LND invoice created:', paymentHashHex);
      
      return {
        payment_hash: paymentHashHex,
        payment_request: response.payment_request,
        amount_sats: amountSats,
        memo,
        status: 'pending',
        created_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 3600000).toISOString(),
        is_real: true, // Flag to indicate this is a real invoice
      };
    } catch (err) {
      console.error('Failed to create LND invoice:', err);
      throw new Error(`Failed to create Lightning invoice: ${err.message}`);
    }
  }
  
  // Fallback to mock invoice for development
  console.log('Voltage not configured, using mock invoice');
  const paymentHash = uuidv4().replace(/-/g, '');
  const invoice = {
    payment_hash: paymentHash,
    payment_request: `lnbc${amountSats}n1mock${paymentHash.slice(0, 20)}`, // Fake invoice string
    amount_sats: amountSats,
    memo,
    status: 'pending',
    created_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 3600000).toISOString(),
    is_real: false,
  };
  
  mockInvoices.set(paymentHash, invoice);
  return invoice;
}

/**
 * Check if an invoice has been paid
 * Uses Voltage API if configured, otherwise checks mock store
 * @param {string} paymentHash - The payment hash of the invoice
 * @returns {Object} Invoice status object
 */
async function checkInvoice(paymentHash) {
  // Use real LND API if configured
  if (isVoltageConfigured()) {
    try {
      console.log(`Checking LND invoice status: ${paymentHash}`);
      
      // LND REST API: GET /v1/invoice/{r_hash_str}
      // r_hash needs to be hex or base64 URL-safe encoded
      const response = await lndRequest(`/v1/invoice/${paymentHash}`, {
        method: 'GET',
      });
      
      // LND returns: { settled: boolean, amt_paid_sat: string, ... }
      const status = response.settled ? 'paid' : 'pending';
      
      console.log(`Invoice ${paymentHash} status: ${status}`);
      
      return {
        payment_hash: paymentHash,
        status: status,
        amount_sats: parseInt(response.amt_paid_sat || response.value || '0'),
        settled_at: response.settle_date && response.settle_date !== '0' 
          ? new Date(parseInt(response.settle_date) * 1000).toISOString() 
          : null,
        is_real: true,
      };
    } catch (err) {
      console.error('Failed to check LND invoice:', err);
      // If not found, return not_found status
      if (err.message.includes('not found') || err.message.includes('404')) {
        return { status: 'not_found', payment_hash: paymentHash };
      }
      throw new Error(`Failed to check invoice: ${err.message}`);
    }
  }
  
  // Fallback to mock
  const invoice = mockInvoices.get(paymentHash);
  if (!invoice) {
    return { status: 'not_found' };
  }
  return { ...invoice, is_real: false };
}

/**
 * Simulate paying an invoice (for testing only)
 * Only works with mock invoices
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
 * Uses Voltage API if configured
 * @param {string} paymentRequest - The bolt11 invoice to pay
 * @param {number} amountSats - Expected amount (for validation)
 * @returns {Object} Payment result
 */
async function payInvoice(paymentRequest, amountSats) {
  if (isVoltageConfigured()) {
    try {
      console.log(`Paying invoice via LND: ${amountSats} sats`);
      
      // LND REST API: POST /v1/channels/transactions
      const response = await lndRequest('/v1/channels/transactions', {
        method: 'POST',
        body: JSON.stringify({
          payment_request: paymentRequest,
        }),
      });
      
      const paymentHashHex = response.payment_hash 
        ? Buffer.from(response.payment_hash, 'base64').toString('hex')
        : null;
      
      console.log('Payment sent:', paymentHashHex);
      
      return {
        id: paymentHashHex,
        payment_request: paymentRequest,
        amount_sats: parseInt(response.value_sat || amountSats),
        fee_sats: parseInt(response.fee_sat || '0'),
        status: response.payment_error ? 'failed' : 'completed',
        error: response.payment_error || null,
        created_at: new Date().toISOString(),
        is_real: true,
      };
    } catch (err) {
      console.error('Failed to pay invoice via LND:', err);
      throw new Error(`Payment failed: ${err.message}`);
    }
  }
  
  // Fallback to mock
  const paymentId = uuidv4();
  const payment = {
    id: paymentId,
    payment_request: paymentRequest,
    amount_sats: amountSats,
    status: 'completed', // Mock: instant success
    created_at: new Date().toISOString(),
    is_real: false,
  };
  
  mockPayments.set(paymentId, payment);
  return payment;
}

/**
 * Get node info
 * Returns Voltage node info if configured
 */
async function getNodeInfo() {
  if (isVoltageConfigured()) {
    try {
      // LND REST API: GET /v1/getinfo
      const response = await lndRequest('/v1/getinfo', {
        method: 'GET',
      });
      
      return {
        pubkey: response.identity_pubkey,
        alias: response.alias || 'Bitcoin Chess 960 Predictions',
        network: response.chains?.[0]?.network || 'mainnet',
        synced: response.synced_to_chain,
        block_height: response.block_height,
        is_real: true,
      };
    } catch (err) {
      console.error('Failed to get LND node info:', err);
      // Return mock info as fallback
    }
  }
  
  return {
    pubkey: 'mock_03' + 'a'.repeat(64),
    alias: 'Bitcoin Chess 960 Predictions',
    network: 'mainnet',
    is_real: false,
  };
}

// ==================== ON-CHAIN BITCOIN FUNCTIONS ====================

/**
 * Generate a new on-chain Bitcoin address
 * Uses LND's built-in wallet
 * @param {string} type - Address type: 'p2wkh' (default), 'np2wkh', 'p2tr'
 * @returns {Object} Object with address
 */
async function generateOnchainAddress(type = 'p2wkh') {
  if (isVoltageConfigured()) {
    try {
      console.log('Generating new on-chain address...');
      
      // LND REST API: GET /v1/newaddress
      // type: ADDRESS_TYPE - 0=WITNESS_PUBKEY_HASH (p2wkh), 1=NESTED_PUBKEY_HASH (np2wkh), 4=TAPROOT_PUBKEY (p2tr)
      const typeMap = {
        'p2wkh': 0,
        'np2wkh': 1,
        'p2tr': 4
      };
      
      const response = await lndRequest(`/v1/newaddress?type=${typeMap[type] || 0}`, {
        method: 'GET',
      });
      
      console.log('Generated on-chain address:', response.address);
      
      return {
        address: response.address,
        type: type,
        is_real: true,
      };
    } catch (err) {
      console.error('Failed to generate on-chain address:', err);
      throw new Error(`Failed to generate address: ${err.message}`);
    }
  }
  
  // Mock for development
  const mockAddress = 'bc1q' + crypto.randomBytes(20).toString('hex');
  return {
    address: mockAddress,
    type: type,
    is_real: false,
  };
}

/**
 * Get on-chain wallet balance
 * @returns {Object} Balance info with confirmed and unconfirmed sats
 */
async function getOnchainBalance() {
  if (isVoltageConfigured()) {
    try {
      // LND REST API: GET /v1/balance/blockchain
      const response = await lndRequest('/v1/balance/blockchain', {
        method: 'GET',
      });
      
      return {
        confirmed_sats: parseInt(response.confirmed_balance || 0),
        unconfirmed_sats: parseInt(response.unconfirmed_balance || 0),
        total_sats: parseInt(response.total_balance || 0),
        is_real: true,
      };
    } catch (err) {
      console.error('Failed to get on-chain balance:', err);
      return { confirmed_sats: 0, unconfirmed_sats: 0, total_sats: 0, error: err.message, is_real: true };
    }
  }
  
  // Mock for development
  return {
    confirmed_sats: 5000000, // 5M sats mock
    unconfirmed_sats: 0,
    total_sats: 5000000,
    is_real: false,
  };
}

/**
 * Get on-chain transactions (for checking deposits)
 * @returns {Array} List of on-chain transactions
 */
async function getOnchainTransactions() {
  if (isVoltageConfigured()) {
    try {
      // LND REST API: GET /v1/transactions
      const response = await lndRequest('/v1/transactions', {
        method: 'GET',
      });
      
      return (response.transactions || []).map(tx => ({
        txid: tx.tx_hash,
        amount_sats: parseInt(tx.amount || 0),
        confirmations: parseInt(tx.num_confirmations || 0),
        block_height: parseInt(tx.block_height || 0),
        timestamp: tx.time_stamp ? new Date(parseInt(tx.time_stamp) * 1000).toISOString() : null,
        dest_addresses: tx.dest_addresses || [],
        is_real: true,
      }));
    } catch (err) {
      console.error('Failed to get on-chain transactions:', err);
      return [];
    }
  }
  
  // Mock for development
  return [];
}

/**
 * Send on-chain Bitcoin transaction
 * @param {string} address - Destination Bitcoin address
 * @param {number} amountSats - Amount in satoshis
 * @param {number} satPerVbyte - Fee rate (sat/vbyte), optional - uses LND estimate if not provided
 * @returns {Object} Transaction result with txid
 */
async function sendOnchain(address, amountSats, satPerVbyte = null) {
  if (isVoltageConfigured()) {
    try {
      console.log(`Sending on-chain: ${amountSats} sats to ${address}`);
      
      // LND REST API: POST /v1/transactions
      const body = {
        addr: address,
        amount: amountSats.toString(),
        target_conf: 6, // Target 6 block confirmation (if no fee specified)
      };
      
      if (satPerVbyte) {
        body.sat_per_vbyte = satPerVbyte.toString();
      }
      
      const response = await lndRequest('/v1/transactions', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      
      console.log('On-chain transaction sent:', response.txid);
      
      return {
        txid: response.txid,
        amount_sats: amountSats,
        address: address,
        status: 'completed',
        is_real: true,
      };
    } catch (err) {
      console.error('Failed to send on-chain transaction:', err);
      throw new Error(`On-chain send failed: ${err.message}`);
    }
  }
  
  // Mock for development
  const mockTxid = crypto.randomBytes(32).toString('hex');
  return {
    txid: mockTxid,
    amount_sats: amountSats,
    address: address,
    status: 'completed',
    is_real: false,
  };
}

/**
 * Estimate on-chain transaction fee
 * @param {number} targetConf - Target confirmation blocks (default 6)
 * @returns {Object} Fee estimate in sat/vbyte
 */
async function estimateOnchainFee(targetConf = 6) {
  if (isVoltageConfigured()) {
    try {
      // LND REST API: GET /v1/transactions/fee
      // This endpoint estimates fee for a transaction
      const response = await lndRequest(`/v1/transactions/fee?target_conf=${targetConf}`, {
        method: 'GET',
      });
      
      return {
        sat_per_vbyte: parseInt(response.sat_per_vbyte || response.fee_sat || 10),
        is_real: true,
      };
    } catch (err) {
      console.error('Failed to estimate fee:', err);
      // Return a reasonable default if estimation fails
      return { sat_per_vbyte: 10, is_real: true, error: err.message };
    }
  }
  
  // Mock for development
  return {
    sat_per_vbyte: 10,
    is_real: false,
  };
}

/**
 * Check for deposits to specific addresses
 * Returns transactions that sent to any of the provided addresses
 * @param {Array<string>} addresses - List of addresses to check
 * @returns {Array} Matching transactions with address info
 */
async function checkAddressesForDeposits(addresses) {
  const transactions = await getOnchainTransactions();
  
  const deposits = [];
  for (const tx of transactions) {
    // Only consider incoming transactions (positive amount)
    if (tx.amount_sats <= 0) continue;
    
    // Check if any of our addresses are in dest_addresses
    for (const addr of addresses) {
      if (tx.dest_addresses && tx.dest_addresses.includes(addr)) {
        deposits.push({
          ...tx,
          matched_address: addr,
        });
        break;
      }
    }
  }
  
  return deposits;
}

/**
 * Get channel balance info (for checking outbound liquidity before withdrawals)
 * @returns {Object} Channel balance info
 */
async function getChannelBalance() {
  if (isVoltageConfigured()) {
    try {
      const result = await lndRequest('/v1/channels', { method: 'GET' });
      const channels = result.channels || [];
      
      let totalLocal = 0;
      let totalRemote = 0;
      let totalCapacity = 0;
      
      for (const ch of channels) {
        if (ch.active) {
          totalLocal += parseInt(ch.local_balance || 0);
          totalRemote += parseInt(ch.remote_balance || 0);
          totalCapacity += parseInt(ch.capacity || 0);
        }
      }
      
      return {
        outbound_sats: totalLocal, // Available for withdrawals/payments
        inbound_sats: totalRemote, // Available for receiving deposits
        total_capacity: totalCapacity,
        active_channels: channels.filter(c => c.active).length,
        is_real: true,
      };
    } catch (err) {
      console.error('Failed to get channel balance:', err);
      return { outbound_sats: 0, inbound_sats: 0, error: err.message, is_real: true };
    }
  }
  
  // Mock: unlimited for development
  return {
    outbound_sats: 10000000, // 10M sats mock
    inbound_sats: 10000000,
    total_capacity: 20000000,
    active_channels: 1,
    is_real: false,
  };
}

/**
 * Check Voltage connection status
 * @returns {Object} Connection status
 */
async function checkVoltageConnection() {
  if (!isVoltageConfigured()) {
    return {
      connected: false,
      reason: 'Voltage API not configured',
      using_mock: true,
    };
  }
  
  try {
    const nodeInfo = await getNodeInfo();
    return {
      connected: true,
      node_pubkey: nodeInfo.pubkey,
      alias: nodeInfo.alias,
      network: nodeInfo.network,
      using_mock: false,
    };
  } catch (err) {
    return {
      connected: false,
      reason: err.message,
      using_mock: true,
    };
  }
}

module.exports = {
  // Invoice functions
  createInvoice,
  checkInvoice,
  simulatePayment,
  payInvoice,
  getNodeInfo,
  getChannelBalance,
  mockInvoices,
  
  // On-chain Bitcoin functions
  generateOnchainAddress,
  getOnchainBalance,
  getOnchainTransactions,
  sendOnchain,
  estimateOnchainFee,
  checkAddressesForDeposits,
  
  // Voltage helpers
  isVoltageConfigured,
  checkVoltageConnection,
  
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
