# ₿ Bitcoin Chess 960 Championship Predictions

A real-money Bitcoin prediction market for the Bitcoin Chess 960 Championship in Prospera, March 16-22, 2026.

## Features

- 🏆 **Event Market** - Bet on whether the championship will happen
- ♟️ **Attendance Markets** - Will each grandmaster attend?
- 👑 **Winner Markets** - Will each grandmaster win?
- ⚡ **Lightning Payments** - Instant Bitcoin deposits/withdrawals
- 📊 **Order Book Trading** - Place limit orders at any price
- 🔐 **Admin Controls** - Safe resolution with 24-hour delay

## Quick Start

### Prerequisites
- Node.js 18+
- npm

### Development

1. Clone the repository:
```bash
git clone https://github.com/jk212h20/Predictions.git
cd Predictions
```

2. Install backend dependencies:
```bash
cd backend
npm install
```

3. Start the backend:
```bash
npm start
# API runs on http://localhost:3001
```

4. In a new terminal, install and start frontend:
```bash
cd frontend
npm install
npm run dev
# App runs on http://localhost:5173
```

### Demo Login
Enter any email to create an account with 100,000 sats for testing.

Admin account: `admin@chess960.btc`

## Tech Stack

- **Frontend**: React + Vite
- **Backend**: Express.js
- **Database**: SQLite (better-sqlite3)
- **Auth**: JWT (Google OAuth + LNURL-auth planned)
- **Payments**: Lightning Network (Voltage - mock for testing)

## Market Mechanics

### Order Types
- **YES** - Betting the outcome will happen
- **NO** - Betting the outcome won't happen

### Pricing
- Prices are in cents (1-99)
- At 50¢, you risk 50 sats to win 50 sats
- At 10¢ YES, you risk 10 sats to win 90 sats
- Prices represent implied probability

### Resolution
1. Admin initiates resolution (YES or NO)
2. 24-hour delay for review
3. Admin confirms or cancels
4. Winners receive payouts automatically
5. Emergency code available for instant resolution

## Project Structure

```
Predictions/
├── backend/
│   ├── server.js      # Express API
│   ├── database.js    # SQLite schema
│   ├── lightning.js   # Mock Lightning integration
│   └── seed.js        # Top 100 GMs data
├── frontend/
│   └── src/
│       ├── App.jsx    # React components
│       ├── App.css    # Styling
│       └── api.js     # API client
└── memory-bank/       # Project documentation
```

## Deployment

Hosted on Railway.app

### Environment Variables
```
PORT=3001
JWT_SECRET=your-secret-key
EMERGENCY_CODE=your-emergency-code
API_URL=https://your-api-domain.com
```

## Roadmap

- [x] MVP UI and trading
- [x] Mock Lightning integration
- [ ] Real Voltage integration
- [ ] Google OAuth
- [ ] LNURL-auth
- [ ] Liquidity bot
- [ ] Mobile optimization

## License

MIT

## Contact

Bitcoin Chess 960 Championship - Prospera 2026
