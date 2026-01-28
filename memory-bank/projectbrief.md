# Bitcoin Chess 960 Championship Prediction Market

## Project Overview
A real-money Bitcoin prediction market platform for the Bitcoin Chess 960 Championship in Prospera, March 16-22, 2026.

## Core Requirements
1. **Bitcoin-denominated trading** - All transactions in satoshis via Lightning Network
2. **Two market types per grandmaster**:
   - Will [GM] attend the championship?
   - Will [GM] win the championship?
3. **Event market** - Will the championship happen at all?
4. **Order book trading** - Users can place limit orders
5. **Admin resolution** - Manual resolution with 24-hour safety delay
6. **Liquidity provision** - Market maker bot for NO side liquidity

## Target Users
- Chess players who might attend (betting YES on themselves)
- Spectators betting on attendance/winners
- Event organizers (providing liquidity, building awareness)

## Business Model
- Platform takes no fees initially (liquidity provision is the revenue model)
- Organizer provides NO side liquidity at favorable odds
- Players betting YES essentially commit to attending

## Technical Constraints
- Must be operational by January 29, 2026
- Hosted on Railway.app
- GitHub repo: https://github.com/jk212h20/Predictions
- Lightning payments via Voltage (to be integrated)
