# Progress - Predictions Market Maker Bot

## Latest Update: 2026-01-29 - On-Chain Bitcoin Support

### Latest Changes
1. **On-Chain Bitcoin Deposits** - Users can generate Bitcoin addresses, receive on-chain deposits
2. **On-Chain Bitcoin Withdrawals** - All go to admin queue for approval (first 10 free)
3. **Atomic Transactions** - On-chain withdrawals use SQLite transactions to prevent lost funds
4. **Wallet Type Toggle** - Lightning ⚡ / On-Chain ₿ tabs in wallet modal

### On-Chain Features
- **Deposits**: Generate fresh address per request, QR code display, auto-credit for small deposits (≤100k sats) or after 1 confirmation for larger
- **Withdrawals**: Min 10k sats, all go to admin queue, admin can approve (SendCoins) or reject (refund)
- **Admin Panel**: Endpoints for viewing/approving/rejecting pending on-chain withdrawals
- **Atomicity Fix**: Identified bug where balance could be deducted without creating withdrawal record - now uses db.transaction()

### Previous Updates

#### Build Time Optimizations (Earlier today)
1. **Optimized Dockerfile** - Eliminated redundant build stages and duplicate native module compilation
2. **Removed Build Tools from Production** - Production image no longer contains python3, make, g++ (smaller, faster)
3. **Vite Build Optimizations** - Added chunk splitting, esbuild minification, and ES2020 target
4. **Better Layer Caching** - Pre-built node_modules copied from builder stage for faster rebuilds

#### Withdrawal UI Enhancement (2026-01-28)
1. **Enhanced Withdrawal UI** - Complete wallet modal with proper withdrawal flow
2. **Pending Withdrawals** - Shows list of pending withdrawals with cancel option
3. **Auto-approval Logic** - Withdrawals ≤100k sats AND ≤total deposits are instant
4. **Feedback States** - Processing, completed, and pending states with proper UI

#### Budget Calculation Fix (Earlier)
1. **Deployment Preview/Actual Mismatch** - Fixed the core bug where deployment preview showed costs exceeding user balance
2. **Budget Calculation Formula** - Now correctly uses: `deployable = min(balance, max_loss) × multiplier × pullback_ratio`
3. **1% Threshold Pullback** - Changed from 10% tiers to 1% thresholds for smoother liquidity adjustment
4. **Set Active Curve** - Added "Set as Active" button for saved curves in the UI

### Key Formula
```
deployable_budget = min(user_balance, max_acceptable_loss) × global_multiplier × pullback_ratio

where:
  pullback_ratio = (max_loss - current_exposure) / max_loss
  
Example: 1M budget, 10x multiplier, 0% exposure
  = 1,000,000 × 10 × 1.0 = 10,000,000 displayed liquidity
  
At 50% exposure (500K):
  = 1,000,000 × 10 × 0.5 = 5,000,000 displayed liquidity
```

### What Works Now
- [x] Lightning Network deposits (real LND integration)
- [x] Lightning Network withdrawals (real LND integration with auto-approval)
- [x] Lightning Network login (LNURL-auth)
- [x] **On-Chain Bitcoin deposits** (address generation, auto-credit)
- [x] **On-Chain Bitcoin withdrawals** (admin queue, approve/reject)
- [x] Market creation and order matching
- [x] Market resolution with 3-minute delay
- [x] Bot market maker with configurable curves
- [x] Tier-based budget allocation
- [x] Curve shape library (bell, flat, exponential, etc.)
- [x] Deployment preview matches actual deployment
- [x] Budget capped at user balance
- [x] Multiplier for liquidity amplification
- [x] 1% threshold-based pullback
- [x] Active curve selection
- [x] Enhanced withdrawal UI with pending state tracking
- [x] Admin panel for Lightning withdrawal approval
- [x] Admin panel for On-Chain withdrawal approval
- [x] **Atomic transactions for on-chain withdrawals**

### What's Left
- [ ] Mobile UI polish
- [ ] Performance optimization for large order books
- [ ] More sophisticated pullback strategies (optional enhancement)
- [x] On-chain withdrawal admin UI in BotAdmin.jsx ✓ (verified 2026-01-29)

### Database Schema Notes
- `bot_config` - stores max_acceptable_loss, global_multiplier, threshold_percent, bot_user_id
- `bot_exposure` - tracks current exposure and tier (now 1-100 instead of 1-10)
- `bot_curve_shapes` - library of saved curves, is_default flag marks active curve
- `bot_market_weights` - per-market weight allocation
- `onchain_deposits` - tracks deposit addresses, amounts, confirmations, credited status
- `onchain_withdrawals` - tracks withdrawal requests, dest_address, status, txid

### Technical Debt
- Pullback currently scales all orders proportionally; could be smarter
- No batch SQL update for order scaling (done one-by-one)
- lastPullbackExposure tracking not implemented yet
