# Progress - Bitcoin Chess 960 Predictions

## Current Status: Market Maker Bot Implemented ✓

### What Works
- **Core Platform**: Complete prediction market for Bitcoin Chess 960 Championship
- **Authentication**: Email/password + Google OAuth login
- **Markets**: Event market + 50+ grandmaster attendance/winner markets
- **Order Book**: Full limit order matching engine
- **Portfolio**: Positions, orders, trades, transactions tracking
- **Admin Panel**: Market resolution with 24-hour delay safety

### Market Maker Bot (NEW - Jan 27, 2026)
Complete bot implementation with guaranteed max loss protection:

**Backend (`backend/bot.js`)**:
- **Curve-Based Liquidity**: Configurable buy/sell curves with price points
- **Atomic Pullback**: Triggered within same transaction as order fill
- **Tier-Based Risk**: Automatic reduction when exposure crosses thresholds
- **Market Overrides**: Per-market multipliers, disable, or custom curves
- **Activity Logging**: Full audit trail of bot actions

**Database Tables**:
- `bot_config`: Max loss, threshold %, global multiplier, active status
- `bot_curves`: Buy/sell curves stored as JSON price points
- `bot_market_overrides`: Per-market customizations
- `bot_exposure`: Current exposure, tier, last pullback time
- `bot_log`: Activity audit trail

**API Endpoints** (`/api/admin/bot/*`):
- GET/PUT `/config` - Bot configuration
- GET/PUT `/curves/buy|sell` - Curve management
- GET `/markets` - All markets with bot status
- PUT `/markets/:id/override` - Per-market settings
- POST `/deploy-all` - Deploy orders to all markets
- POST `/withdraw-all` - Cancel all bot orders
- GET `/stats` - Real-time risk metrics
- GET `/log` - Activity history

**Frontend (`frontend/src/BotAdmin.jsx`)**:
- Risk dashboard with exposure/tier/pullback metrics
- Curve editor with visual chart
- Market override management
- Deploy/withdraw controls
- Activity log viewer

**Key Design Decisions**:
1. **Atomic Pullback**: Guaranteed - runs in same transaction as order fill
2. **Bot takes NO side**: Provides YES liquidity, limits exposure
3. **Tiered reduction**: Exposure ÷ Max Loss = reduction percentage
4. **Per-market control**: Disable, multiply, or replace curves per market

### Deployment
- **Hosted**: Railway (backend + frontend)
- **Database**: SQLite with better-sqlite3
- **Lightning**: Mock implementation (ready for LNbits integration)

### What's Left
- [ ] Adversarial test suite for bot
- [ ] Real Lightning Network integration (LNbits)
- [ ] Email verification
- [ ] Mobile responsiveness improvements

### LNURL-Auth Login (NEW - Jan 28, 2026)
Complete "Login with Lightning" implementation:

**Backend (`backend/lightning.js`)**:
- `generateAuthChallenge()` - Creates k1 challenge, stores in DB
- `verifySignature()` - secp256k1 signature verification
- `processAuthCallback()` - Handles wallet callback
- `getAuthStatus()` - Status polling
- `generateFriendlyUsername()` - Creates usernames like "SwiftSatoshi42"

**Database Table**: `lnurl_auth_challenges`

**API Endpoints**:
- `GET /api/auth/lnurl` - Generate challenge
- `GET /api/auth/lnurl/callback` - Wallet callback (LNURL spec)
- `GET /api/auth/lnurl/status/:k1` - Status polling
- `POST /api/auth/lnurl/complete` - Complete login, issue JWT

**Frontend (`frontend/src/App.jsx`)**:
- `LightningLoginModal` component with QR code
- Polling for signature verification
- "Open in Wallet App" deep link
- Copy LNURL button
- Success/error states with animations
- "⚡ Login with Lightning" button in LoginModal

### Technical Stack
- **Backend**: Node.js, Express, better-sqlite3
- **Frontend**: React + Vite
- **Auth**: JWT + bcrypt + Google OAuth
- **Styling**: Custom CSS (dark theme, Bitcoin orange accent)

## Bot Architecture

```
                    ┌─────────────────┐
                    │   Buy Curve     │
                    │ [5%: 50k sats]  │
                    │ [10%: 100k]     │
                    │ [20%: 200k]     │
                    └────────┬────────┘
                             │
                             ▼
┌──────────────┐    ┌─────────────────┐    ┌──────────────┐
│ User buys    │───▶│  Order Match    │───▶│ Bot Exposure │
│ YES shares   │    │  (atomic tx)    │    │   Updated    │
└──────────────┘    └────────┬────────┘    └──────┬───────┘
                             │                     │
                             │                     ▼
                             │            ┌─────────────────┐
                             │            │  Tier Changed?  │
                             │            └────────┬────────┘
                             │                     │ yes
                             ▼                     ▼
                    ┌─────────────────┐    ┌─────────────────┐
                    │  Return to      │◀───│ ATOMIC PULLBACK │
                    │  User           │    │ (reduce orders) │
                    └─────────────────┘    └─────────────────┘
```

## Configuration

**Default Settings**:
- Max Acceptable Loss: 10M sats (~$1000 at current rates)
- Threshold Percent: 1% (pullback every 1% of max loss booked)
- Global Multiplier: 1.0
- Bot Status: Inactive (must manually activate)

**Default Buy Curve**:
- 5%: 50,000 sats
- 10%: 100,000 sats
- 15%: 150,000 sats
- 20%: 200,000 sats
- 25%: 200,000 sats
- 30%: 150,000 sats
- 40%: 100,000 sats
- 50%: 50,000 sats

## Files Changed (Jan 27, 2026)

### Backend
- `backend/database.js` - Added bot tables + curve shape library + market weights tables
- `backend/bot.js` - New bot module with curve shape generators (bell, exponential, sigmoid, parabolic, etc.) and market weight auto-rebalancing
- `backend/server.js` - Bot import, atomic hook, admin endpoints + shape library + weights routes

### Frontend
- `frontend/src/api.js` - Bot API functions + shape library + market weights APIs
- `frontend/src/BotAdmin.jsx` - New bot admin component with mathematically meaningful curve presets
- `frontend/src/App.jsx` - Bot admin integration
- `frontend/src/App.css` - Bot admin styles

## Curve Shape System (NEW)

**Shape Types Available:**
| Shape | Formula | Use Case |
|-------|---------|----------|
| Bell (Gaussian) | `e^(-(p-μ)²/2σ²)` | Concentrate around expected probability |
| Flat | `k` (constant) | No opinion on fill location |
| Exponential Decay | `e^(-bp)` | Heavy at low prices, fade at higher |
| Logarithmic | `ln(101-p)` | Decreasing returns |
| Sigmoid | `1/(1+e^(-k(p-mid)))` | Threshold thinking |
| Parabolic | `(max-p)²` | Strongly favor low prices |

**Key Concepts:**
- Shapes are **normalized** (sum to 1.0) and **scaled** by budget/weight
- Saved shapes can be reused across all markets
- Market weights auto-rebalance when you adjust any single market
- Relative odds vector support for bulk weight adjustment
