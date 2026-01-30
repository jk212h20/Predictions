# System Patterns - Market Maker Bot

## ⚡ CANONICAL PRICING MODEL

**There is ONE system. Everything uses sats. No "cents" anywhere.**

### Core Rules
```
1 share = 1,000 sats payout to winner
price_sats = what you pay per share (1-999 sats)
Matching: YES_price + NO_price >= 1000
```

### Database Storage
| Column | Type | Range | Description |
|--------|------|-------|-------------|
| `price_sats` | INTEGER | 1-999 | Sats per share this side pays |
| `shares` | INTEGER | 1+ | Number of shares |
| `amount_sats` | INTEGER | 1000+ | Total sats = shares × 1000 |

### Order Matching
```
YES @ 600 sats/share + NO @ 400 sats/share = 1000 ✓ MATCHES!
YES @ 700 sats/share + NO @ 400 sats/share = 1100 ✓ MATCHES! (surplus)
YES @ 500 sats/share + NO @ 400 sats/share = 900 ✗ No match (gap)

Rule for YES taker:
  Find NO orders where NO_price_sats >= (1000 - YES_price_sats)
  
Rule for NO taker:
  Find YES orders where YES_price_sats >= (1000 - NO_price_sats)
```

### Example Trade
```
Bob posts: NO @ 400 sats/share (5 shares) → pays 2,000 sats
Alice takes: YES @ 700 sats/share (5 shares) → offers up to 3,500 sats

Match: 700 + 400 = 1,100 >= 1,000 ✓

Execution:
  - Bob filled at HIS price: 400 sats/share
  - Alice pays complement: 1,000 - 400 = 600 sats/share
  - Alice actual cost: 5 × 600 = 3,000 sats
  - Alice refund: 3,500 - 3,000 = 500 sats (price improvement!)
  - Total locked: 2,000 + 3,000 = 5,000 sats
  - Winner gets: 5,000 sats (exactly 5 × 1,000)
```

### Implied Percentage (Display Only)
```javascript
// Only for display - never stored!
impliedPercent = price_sats / 10;

// Examples:
// 600 sats → 60%
// 350 sats → 35%
// 999 sats → 99.9%
```

### Money Conservation
```javascript
// Perfect conservation at all times
balance_total + locked_in_bets + locked_in_orders === initial_total

// All operations are integer arithmetic - no rounding!
cost = shares × price_sats
payout = shares × 1000
```

---

## Database Schema

### Orders Table
```sql
CREATE TABLE orders (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  market_id TEXT NOT NULL,
  side TEXT NOT NULL CHECK(side IN ('yes', 'no')),
  price_sats INTEGER NOT NULL CHECK(price_sats >= 1 AND price_sats <= 999),
  amount_sats INTEGER NOT NULL CHECK(amount_sats >= 1000),
  filled_sats INTEGER DEFAULT 0,
  status TEXT DEFAULT 'open' CHECK(status IN ('open', 'partial', 'filled', 'cancelled')),
  created_at TEXT DEFAULT (datetime('now'))
);
```

### Bets Table
```sql
CREATE TABLE bets (
  id TEXT PRIMARY KEY,
  market_id TEXT NOT NULL,
  yes_user_id TEXT NOT NULL,
  no_user_id TEXT NOT NULL,
  yes_order_id TEXT,
  no_order_id TEXT,
  trade_price_sats INTEGER NOT NULL,  -- What YES side paid per share
  amount_sats INTEGER NOT NULL,       -- Total sats in bet (shares × 1000)
  status TEXT DEFAULT 'active',
  settled_at TEXT
);
```

---

## REFACTOR TODO (Current Task)

### Files to Update
1. **database.js** - Rename `price_cents` → `price_sats`, constraint 1-99 → 1-999
2. **server.js** - Rename all `price_cents` → `price_sats`, fix matching/cost formulas
3. **bot.js** - Rename all `price_cents` → `price_sats`, update curves 5-50 → 50-500
4. **App.jsx** - Rename all `price_cents` → `price_sats`, remove ×10 conversions
5. **All test files** - Already use sats (testHelpers.js is canonical)

### Matching Logic Fix
```javascript
// OLD (WRONG - used complement math with percentages):
if (side === 'yes') {
  potentialMatches = orders WHERE NO.price_cents <= YES.price_cents
}

// NEW (CORRECT - use sats complement to 1000):
if (side === 'yes') {
  const minNoPrice = 1000 - price_sats;
  potentialMatches = orders WHERE NO.price_sats >= minNoPrice
}
```

### Cost Calculation Fix
```javascript
// OLD (WRONG - divided by 100 assuming percentage):
cost = Math.ceil(amount_sats * price_cents / 100);

// NEW (CORRECT - direct multiplication):
cost = shares * price_sats;
// Or if using amount_sats (which is shares × 1000):
cost = (amount_sats / 1000) * price_sats;
```

---

## Bot Market Maker

### Core Formula
```
deployable_budget = min(user_balance, max_acceptable_loss) × global_multiplier × pullback_ratio
```

### Pullback Formula
```javascript
pullback_ratio = (max_loss - current_exposure) / max_loss

// Example: 1M budget, 10× multiplier
// At 0% exposure:   Show 10M liquidity
// At 50% exposure:  Show 5M liquidity  
// At 100% exposure: Show 0 liquidity
```

### Curve Points (After Refactor)
Curves define distribution across price points in SATS:
```javascript
// Price points for curves (50 to 500 sats = 5% to 50% probability)
const PRICE_POINTS_SATS = [50, 100, 150, 200, 250, 300, 350, 400, 450, 500];
```

---

## Two-Sided Liquidity

### Crossover Point
```
Below crossover: Bot sells YES shares
Above crossover: Bot sells NO shares
At crossover: Gap/spread (no liquidity)

Example with crossover at 300 sats:
  Bot's YES offers: 50-250 sats
  Bot's NO offers: 350-500 sats
  Spread gap: 300 sats (no self-trade possible)
```

### YES/NO Annihilation
```
Bot holds: 100 YES + 50 NO in Market X

Annihilation:
  50 YES + 50 NO = 50 shares canceled = 50,000 sats returned
  Remaining: 50 YES shares

Net exposure = |YES shares - NO shares| × 1000 sats
```

---

## Future Improvements (Backlog)

- [ ] 3D Offers Landscape visualization
- [ ] Auto-initialize weights if empty
- [ ] Batch SQL updates for order scaling
- [x] On-chain withdrawal admin UI in BotAdmin.jsx
