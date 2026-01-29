const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

// Use DATABASE_PATH env var for Railway volume, fallback to local for dev
const dbPath = process.env.DATABASE_PATH || path.join(__dirname, 'predictions.db');

// Ensure the directory exists (for Railway volume mount)
const dbDir = path.dirname(dbPath);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

console.log(`Database path: ${dbPath}`);
const db = new Database(dbPath);

// Enable WAL mode for better concurrency
db.pragma('journal_mode = WAL');

// Initialize database schema
db.exec(`
  -- Users table
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE,
    google_id TEXT UNIQUE,
    lightning_pubkey TEXT UNIQUE,
    username TEXT,
    avatar_url TEXT,
    balance_sats INTEGER DEFAULT 0,
    is_admin INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );

  -- Grandmasters table
  CREATE TABLE IF NOT EXISTS grandmasters (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    fide_id TEXT,
    fide_rating INTEGER,
    country TEXT,
    title TEXT DEFAULT 'GM',
    image_url TEXT,
    is_influencer INTEGER DEFAULT 0,
    tier TEXT,
    likelihood_score INTEGER,
    key_factors TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  -- Markets table
  CREATE TABLE IF NOT EXISTS markets (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL CHECK(type IN ('attendance', 'winner', 'event')),
    grandmaster_id TEXT,
    title TEXT NOT NULL,
    description TEXT,
    status TEXT DEFAULT 'open' CHECK(status IN ('open', 'pending_resolution', 'resolved', 'cancelled')),
    resolution TEXT CHECK(resolution IN ('yes', 'no', NULL)),
    resolution_time TEXT,
    resolved_by TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (grandmaster_id) REFERENCES grandmasters(id),
    FOREIGN KEY (resolved_by) REFERENCES users(id)
  );

  -- Orders table (order book)
  CREATE TABLE IF NOT EXISTS orders (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    market_id TEXT NOT NULL,
    side TEXT NOT NULL CHECK(side IN ('yes', 'no')),
    price_cents INTEGER NOT NULL CHECK(price_cents >= 1 AND price_cents <= 99),
    amount_sats INTEGER NOT NULL,
    filled_sats INTEGER DEFAULT 0,
    status TEXT DEFAULT 'open' CHECK(status IN ('open', 'partial', 'filled', 'cancelled')),
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id),
    FOREIGN KEY (market_id) REFERENCES markets(id)
  );

  -- Bets/Positions table (matched orders become bets)
  CREATE TABLE IF NOT EXISTS bets (
    id TEXT PRIMARY KEY,
    market_id TEXT NOT NULL,
    yes_user_id TEXT NOT NULL,
    no_user_id TEXT NOT NULL,
    yes_order_id TEXT NOT NULL,
    no_order_id TEXT NOT NULL,
    price_cents INTEGER NOT NULL,
    amount_sats INTEGER NOT NULL,
    status TEXT DEFAULT 'active' CHECK(status IN ('active', 'settled', 'refunded')),
    winner_user_id TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    settled_at TEXT,
    FOREIGN KEY (market_id) REFERENCES markets(id),
    FOREIGN KEY (yes_user_id) REFERENCES users(id),
    FOREIGN KEY (no_user_id) REFERENCES users(id)
  );

  -- Transactions table (deposits, withdrawals, bet settlements)
  CREATE TABLE IF NOT EXISTS transactions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    type TEXT NOT NULL CHECK(type IN ('deposit', 'withdrawal', 'bet_placed', 'bet_won', 'bet_lost', 'bet_refund', 'order_placed', 'order_cancelled')),
    amount_sats INTEGER NOT NULL,
    balance_after INTEGER NOT NULL,
    reference_id TEXT,
    lightning_invoice TEXT,
    lightning_payment_hash TEXT,
    status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'completed', 'failed')),
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  -- Resolution audit log (for safety)
  CREATE TABLE IF NOT EXISTS resolution_log (
    id TEXT PRIMARY KEY,
    market_id TEXT NOT NULL,
    admin_user_id TEXT NOT NULL,
    action TEXT NOT NULL CHECK(action IN ('initiated', 'confirmed', 'cancelled', 'emergency_resolved')),
    resolution TEXT CHECK(resolution IN ('yes', 'no')),
    scheduled_time TEXT,
    notes TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (market_id) REFERENCES markets(id),
    FOREIGN KEY (admin_user_id) REFERENCES users(id)
  );

  -- Create indexes for performance
  CREATE INDEX IF NOT EXISTS idx_orders_market ON orders(market_id, status);
  CREATE INDEX IF NOT EXISTS idx_orders_user ON orders(user_id, status);
  CREATE INDEX IF NOT EXISTS idx_bets_market ON bets(market_id, status);
  CREATE INDEX IF NOT EXISTS idx_bets_user_yes ON bets(yes_user_id);
  CREATE INDEX IF NOT EXISTS idx_bets_user_no ON bets(no_user_id);
  CREATE INDEX IF NOT EXISTS idx_markets_gm ON markets(grandmaster_id);
  CREATE INDEX IF NOT EXISTS idx_markets_type ON markets(type, status);

  -- ==================== BOT CONFIGURATION TABLES ====================

  -- Bot global configuration
  CREATE TABLE IF NOT EXISTS bot_config (
    id TEXT PRIMARY KEY DEFAULT 'default',
    bot_user_id TEXT NOT NULL,
    max_acceptable_loss INTEGER NOT NULL DEFAULT 10000000,
    total_liquidity INTEGER NOT NULL DEFAULT 100000000,
    threshold_percent REAL NOT NULL DEFAULT 1.0,
    global_multiplier REAL NOT NULL DEFAULT 1.0,
    is_active INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (bot_user_id) REFERENCES users(id)
  );

  -- Bot buy curves (for placing NO offers at various YES prices)
  -- This is the default curve for attendance markets
  CREATE TABLE IF NOT EXISTS bot_curves (
    id TEXT PRIMARY KEY,
    config_id TEXT NOT NULL DEFAULT 'default',
    market_type TEXT NOT NULL DEFAULT 'attendance' CHECK(market_type IN ('attendance', 'winner')),
    curve_type TEXT NOT NULL DEFAULT 'buy' CHECK(curve_type IN ('buy', 'sell')),
    price_points TEXT NOT NULL,
    is_active INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (config_id) REFERENCES bot_config(id)
  );

  -- Per-market overrides for the bot
  CREATE TABLE IF NOT EXISTS bot_market_overrides (
    id TEXT PRIMARY KEY,
    config_id TEXT NOT NULL DEFAULT 'default',
    market_id TEXT NOT NULL,
    override_type TEXT NOT NULL CHECK(override_type IN ('multiply', 'replace', 'disable')),
    multiplier REAL DEFAULT 1.0,
    custom_curve TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (config_id) REFERENCES bot_config(id),
    FOREIGN KEY (market_id) REFERENCES markets(id),
    UNIQUE(config_id, market_id)
  );

  -- Bot exposure tracking (updated atomically with order fills)
  CREATE TABLE IF NOT EXISTS bot_exposure (
    id TEXT PRIMARY KEY DEFAULT 'default',
    total_at_risk INTEGER DEFAULT 0,
    current_tier INTEGER DEFAULT 0,
    last_pullback_at TEXT,
    updated_at TEXT DEFAULT (datetime('now'))
  );

  -- Bot activity log for audit
  CREATE TABLE IF NOT EXISTS bot_log (
    id TEXT PRIMARY KEY,
    action TEXT NOT NULL,
    details TEXT,
    exposure_before INTEGER,
    exposure_after INTEGER,
    created_at TEXT DEFAULT (datetime('now'))
  );

  -- Index for bot log
  CREATE INDEX IF NOT EXISTS idx_bot_log_action ON bot_log(action, created_at);

  -- ==================== CURVE SHAPE LIBRARY ====================

  -- Saved curve shapes (normalized distributions)
  -- Shapes are stored as normalized values that sum to 1.0
  CREATE TABLE IF NOT EXISTS bot_curve_shapes (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    shape_type TEXT NOT NULL CHECK(shape_type IN ('flat', 'bell', 'exponential', 'logarithmic', 'sigmoid', 'parabolic', 'custom')),
    params TEXT NOT NULL DEFAULT '{}',
    normalized_points TEXT NOT NULL,
    is_default INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );

  -- Market weights for budget allocation (sum to 1.0 across all attendance markets)
  CREATE TABLE IF NOT EXISTS bot_market_weights (
    id TEXT PRIMARY KEY,
    market_id TEXT NOT NULL UNIQUE,
    weight REAL NOT NULL DEFAULT 0.02,
    relative_odds REAL DEFAULT 1.0,
    is_locked INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (market_id) REFERENCES markets(id)
  );

  -- Index for weights
  CREATE INDEX IF NOT EXISTS idx_bot_weights_market ON bot_market_weights(market_id);

  -- ==================== PENDING WITHDRAWALS ====================

  -- Pending withdrawals requiring admin approval
  CREATE TABLE IF NOT EXISTS pending_withdrawals (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    amount_sats INTEGER NOT NULL,
    payment_request TEXT NOT NULL,
    status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'approved', 'rejected', 'completed', 'failed')),
    rejection_reason TEXT,
    approved_by TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    processed_at TEXT,
    FOREIGN KEY (user_id) REFERENCES users(id),
    FOREIGN KEY (approved_by) REFERENCES users(id)
  );

  -- Index for pending withdrawals
  CREATE INDEX IF NOT EXISTS idx_pending_withdrawals_status ON pending_withdrawals(status);
  CREATE INDEX IF NOT EXISTS idx_pending_withdrawals_user ON pending_withdrawals(user_id);
`);

// Migration: Add avatar_url column if it doesn't exist
try {
  db.exec(`ALTER TABLE users ADD COLUMN avatar_url TEXT`);
} catch (e) {
  // Column already exists, ignore
}

// Migration: Add password_hash column for email authentication
try {
  db.exec(`ALTER TABLE users ADD COLUMN password_hash TEXT`);
} catch (e) {
  // Column already exists, ignore
}

// Migration: Add email_verified column
try {
  db.exec(`ALTER TABLE users ADD COLUMN email_verified INTEGER DEFAULT 0`);
} catch (e) {
  // Column already exists, ignore
}

// Migration: Add account_number column (permanent, sequential ID for referential integrity)
try {
  db.exec(`ALTER TABLE users ADD COLUMN account_number INTEGER`);
  // Backfill existing accounts with sequential numbers
  const users = db.prepare('SELECT id FROM users ORDER BY created_at ASC').all();
  users.forEach((user, index) => {
    db.prepare('UPDATE users SET account_number = ? WHERE id = ?').run(index + 1, user.id);
  });
} catch (e) {
  // Column already exists, ignore
}

// Migration: Add tier columns to grandmasters table
try {
  db.exec(`ALTER TABLE grandmasters ADD COLUMN tier TEXT`);
} catch (e) {
  // Column already exists, ignore
}
try {
  db.exec(`ALTER TABLE grandmasters ADD COLUMN likelihood_score INTEGER`);
} catch (e) {
  // Column already exists, ignore
}
try {
  db.exec(`ALTER TABLE grandmasters ADD COLUMN key_factors TEXT`);
} catch (e) {
  // Column already exists, ignore
}

// Create LNURL auth challenges table (for tracking login attempts)
db.exec(`
  CREATE TABLE IF NOT EXISTS lnurl_auth_challenges (
    k1 TEXT PRIMARY KEY,
    created_at TEXT DEFAULT (datetime('now')),
    expires_at TEXT NOT NULL,
    status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'verified', 'expired', 'used')),
    lightning_pubkey TEXT,
    signature TEXT,
    verified_at TEXT
  );

  -- Index for cleanup of expired challenges
  CREATE INDEX IF NOT EXISTS idx_lnurl_challenges_expires ON lnurl_auth_challenges(expires_at);
  CREATE INDEX IF NOT EXISTS idx_lnurl_challenges_status ON lnurl_auth_challenges(status);
`);

module.exports = db;
