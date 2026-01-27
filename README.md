# BRICS Unit Basket Server

Minimal Node.js server for TWAP and OHLC data for BRICS Unit Basket.

## Endpoints

- `/latest.json` – Returns latest TWAP data  
- `/ohlc?timeframe=1&limit=100` – Returns historical candle data  

## Deploy

1. Push to GitHub.
2. Create Web Service on Render:
   - Build Command: `npm install`
   - Start Command: `npm start`
3. Open the URL provided by Render.
