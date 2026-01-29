# System Patterns - Market Maker Bot

## Overview

The bot is a market maker that provides liquidity to attendance prediction markets. It offers NO shares across all player markets, allowing users to bet YES on players attending.

## Core Formula

```
deployable_budget = min(user_balance, max_acceptable_loss) × global_multiplier × pullback_ratio
```

Where:
- `user_balance` = admin's current sats balance
- `max_acceptable_loss` = configured maximum loss (can never exceed balance)
- `global_multiplier` = liquidity amplification (e.g., 10× shows more liquidity than actually at risk)
- `pullback_ratio` = automatic reduction based on current exposure

## Data Flow: Settings → Orders

```
┌─────────────────┐
│   Bot Config    │  max_acceptable_loss, global_multiplier
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ Market Weights  │  % of budget per player (must sum to 100%)
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  Curve Shape    │  Distribution across price points (normalized to 100%)
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│    Orders       │  Actual NO orders placed in each market
└─────────────────┘
```

## Multiplier: Show More Than You Risk

**The Problem:** You want deep order books but don't want to risk your whole balance.

**The Solution:** Multiplier + Pullback

```
Example: 1M budget, 10× multiplier
- At 0% exposure: Show 10M liquidity
- At 50% exposure (500K booked): Show 5M liquidity  
- At 100% exposure (1M booked): Show 0 liquidity

The pullback GUARANTEES max loss = 1M regardless of multiplier.
```

**How it works:**
1. You set max_loss = 1M
2. Multiplier = 10× makes offers appear 10× larger
3. As orders get filled, exposure increases
4. Pullback ratio decreases proportionally
5. When exposure = max_loss, pullback = 0 (no more offers)

## Pullback Formula

```javascript
pullback_ratio = (max_loss - current_exposure) / max_loss
```

| Exposure | Pullback Ratio | Liquidity Shown (10× mult) |
|----------|---------------|---------------------------|
| 0        | 100%          | 10,000,000 sats           |
| 100,000  | 90%           | 9,000,000 sats            |
| 500,000  | 50%           | 5,000,000 sats            |
| 900,000  | 10%           | 1,000,000 sats            |
| 1,000,000| 0%            | 0 sats (stops offering)   |

**Threshold-based triggers:** Pullback recalculates every 1% of max_loss (not continuously). This means ~100 adjustment events from 0 to max exposure.

## Tier & Weight System

### The Problem
You have 170 players but want to allocate more budget to likely attendees.

### The Solution: Tiers + Weights

**Tiers** group players by likelihood score:
- S tier (70+): Most likely to attend
- A+ tier (60-69): Very likely
- A tier (50-59): Likely
- B+ tier (40-49): Above average
- B tier (25-39): Average
- C tier (0-24): Below average
- D tier (<0): Unlikely

**Weights** determine budget allocation:
- Each tier gets a % of total budget
- Within a tier, each player gets proportional share
- All weights sum to 100%

### Why Weights Might Be Empty

The `bot_market_weights` table doesn't auto-populate. Admin must:
1. Go to **Tiers** tab
2. Click **"Initialize from Scores"**

Without this step, `getEffectiveCurve()` returns `null` for every market → 0 orders deployed.

## Curve Shapes

Shapes define HOW budget is distributed across price points (5% to 50% YES probability).

**Shape types:**
- **Bell**: Gaussian curve, concentrate around a center point
- **Flat**: Equal at all prices
- **Exponential**: Heavy at low prices, fading higher
- **Custom**: Draw your own

**Key concept:** Shapes are NORMALIZED (weights sum to 1.0). The actual sats come from:
```
order_amount = deployable_budget × market_weight × shape_weight_at_price
```

### Active Curve

One shape is marked `is_default = 1` in `bot_curve_shapes`. This is the "active" curve used for all deployments.

## Database Schema

### bot_config
```sql
id, bot_user_id, max_acceptable_loss, total_liquidity, threshold_percent, global_multiplier, is_active
```
- `bot_user_id`: The admin who deployed orders (their balance is used)
- `max_acceptable_loss`: Cannot exceed bot_user's balance
- `global_multiplier`: Liquidity amplification factor
- `threshold_percent`: Pullback trigger (default 1%)
- `is_active`: Master on/off switch

### bot_exposure
```sql
id, total_at_risk, current_tier, last_pullback_at
```
- `total_at_risk`: Current exposure (sum of all active bets where bot is NO side)
- `current_tier`: Number of 1% thresholds crossed (0-100)

### bot_curve_shapes
```sql
id, name, shape_type, params, normalized_points, is_default
```
- `normalized_points`: JSON array of {price, weight} summing to 1.0
- `is_default`: Only one can be default (the active curve)

### bot_market_weights
```sql
id, market_id, weight, relative_odds, is_locked
```
- `weight`: Fraction of budget (all weights sum to 1.0)
- `is_locked`: If true, won't be auto-adjusted when other tiers change

## Prerequisites for Deployment

1. ✅ **Weights initialized**: Run "Initialize from Scores" in Tiers tab
2. ✅ **Active curve set**: One curve must have is_default = 1
3. ✅ **Bot active**: is_active = 1 in bot_config
4. ✅ **Balance sufficient**: max_acceptable_loss ≤ user balance
5. ✅ **Markets exist**: At least one open attendance market

## Common Issues

### "265 orders deployed but none were"
- Weights not initialized → all `getEffectiveCurve()` return null
- Fix: Initialize weights from Tiers tab

### "Total Deployment Cost exceeds Effective Balance"
- Config has high max_loss but user balance is low
- Fix: max_loss is now capped at user balance automatically

### "Pullback ratio is 0"
- Exposure equals max_loss → all offers withdrawn
- This is correct behavior (max loss reached)

## Admin Workflow

1. **Configure**: Set max_loss, multiplier in Configuration tab
2. **Initialize Weights**: Go to Tiers → "Initialize from Scores"
3. **Set Curve**: Go to Buy Curve → draw/select → Save as Custom → Set as Active
4. **Preview**: Go to Deploy → verify numbers look right
5. **Deploy**: Click Deploy All Orders
6. **Monitor**: Check Overview tab for exposure levels

## Withdrawal System

### Overview
The withdrawal system supports both **instant auto-approval** and **manual admin approval** for larger withdrawals.

### Auto-Approval Rules
```javascript
canAutoApprove = 
  amount_sats <= 100,000 (100k limit) &&
  amount_sats <= user's total completed deposits &&
  channel has sufficient outbound liquidity
```

If ALL conditions are met → withdrawal processes immediately via Lightning.

### Pending Withdrawal Flow
If auto-approval fails:
1. Funds are deducted from user balance (held)
2. `pending_withdrawals` record created with status = 'pending'
3. Transaction record created with status = 'pending'
4. User sees pending withdrawal in their wallet modal (can cancel)
5. Admin sees pending withdrawal in Bot Admin → Withdrawals tab
6. Admin can approve (pays invoice) or reject (refunds user)

### Database: pending_withdrawals
```sql
id, user_id, amount_sats, payment_request, status, rejection_reason, approved_by, created_at, processed_at
```
- `status`: 'pending', 'completed', 'rejected', 'failed'
- `approved_by`: admin user_id who processed it
- `payment_request`: the Lightning invoice to pay

### Admin Endpoints
- `GET /api/admin/withdrawals/pending` - list pending with user info
- `POST /api/admin/withdrawals/:id/approve` - pay invoice via LND
- `POST /api/admin/withdrawals/:id/reject` - refund to user balance
- `GET /api/admin/channel-balance` - check outbound liquidity

### User Endpoints
- `POST /api/wallet/withdraw` - request withdrawal (auto or pending)
- `POST /api/wallet/withdraw/cancel` - cancel pending (self-refund)
- `GET /api/wallet/pending-withdrawals` - list own pending

## On-Chain Bitcoin System

### Overview
In addition to Lightning Network, the platform supports on-chain Bitcoin deposits and withdrawals.

### On-Chain Deposits

**Flow:**
1. User clicks "On-Chain" tab in wallet modal
2. User clicks "Generate Address" → API creates new P2WPKH address via LND
3. Address stored in `onchain_deposits` table
4. QR code displayed for scanning
5. User sends Bitcoin to address
6. App polls `checkAddressesForDeposits()` to detect incoming funds
7. Auto-credit rules:
   - ≤100k sats: Credit immediately (0-conf)
   - >100k sats: Wait for 1 confirmation

**Database: onchain_deposits**
```sql
id, user_id, address, amount_sats, txid, confirmations, credited, created_at, detected_at, confirmed_at
```
- `address`: Unique per deposit request
- `credited`: 0 = waiting, 1 = balance updated

### On-Chain Withdrawals

**Flow:**
1. User enters Bitcoin address and amount (min 10k sats)
2. Validation: balance check, address format, no unconfirmed deposits
3. **ATOMIC TRANSACTION**: Deduct balance, create withdrawal record, create transaction record
4. Withdrawal goes to admin queue (no auto-approval)
5. Admin reviews and approves (SendCoins via LND) or rejects (refund to user)

**Why admin queue?** On-chain fees are significant, and there's no easy way to validate the address belongs to the user. Manual review prevents abuse.

**Atomicity Fix (2026-01-29):**
```javascript
const createWithdrawal = db.transaction(() => {
  db.prepare('UPDATE users SET balance_sats = ? WHERE id = ?').run(newBalance, userId);
  db.prepare('INSERT INTO onchain_withdrawals ...').run(...);
  db.prepare('INSERT INTO transactions ...').run(...);
  return { withdrawalId, newBalance };
});
```
If any statement fails, all roll back. User's balance is never affected without a corresponding record.

**Database: onchain_withdrawals**
```sql
id, user_id, amount_sats, dest_address, fee_sats, user_pays_fee, status, txid, rejection_reason, approved_by, created_at, processed_at
```
- `user_pays_fee`: 0 = free (first 10), 1 = user covers fee
- `status`: 'pending', 'completed', 'rejected', 'failed'
- `txid`: Set when admin approves and broadcast succeeds

### Admin Endpoints (On-Chain)
- `GET /api/admin/onchain/withdrawals/pending` - View all pending
- `POST /api/admin/onchain/withdrawals/:id/approve` - Send via LND SendCoins
- `POST /api/admin/onchain/withdrawals/:id/reject` - Refund to user balance
- `GET /api/admin/onchain/balance` - Check on-chain wallet balance

### User Endpoints (On-Chain)
- `POST /api/wallet/onchain/deposit` - Generate new deposit address
- `GET /api/wallet/onchain/deposit/status` - Check/credit pending deposits
- `GET /api/wallet/onchain/deposits` - List deposit history
- `POST /api/wallet/onchain/withdraw` - Request on-chain withdrawal
- `POST /api/wallet/onchain/withdraw/cancel` - Cancel pending (self-refund)
- `GET /api/wallet/onchain/pending-withdrawals` - List pending withdrawals

### LND Integration (lightning.js)
```javascript
// Address generation
generateOnchainAddress('p2wkh') → { address, is_real }

// Check for deposits
checkAddressesForDeposits(addresses) → [{ matched_address, amount_sats, confirmations, txid }]

// Send on-chain
sendOnchain(address, amount_sats) → { txid }

// Balance check
getOnchainBalance() → { confirmed_sats, unconfirmed_sats }
```

## Future Improvements (Backlog)

- [ ] 3D Offers Landscape visualization
- [ ] Auto-initialize weights if empty
- [ ] Batch SQL updates for order scaling
- [ ] On-chain withdrawal admin UI in BotAdmin.jsx
