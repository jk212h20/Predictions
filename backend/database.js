const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, 'predictions.db'));

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
`);

module.exports = db;
