const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const fs = require('fs');
const fetch = require('node-fetch');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(bodyParser.json());

// ===== Constants =====
const GOLD_G_PER_OZ = 31.1034768;
const UNIT_BASE_GOLD = 0.9823;
const GOLD_WEIGHT = 0.40;
const FX_WEIGHT = 0.12;
const FX_LIST = ["BRL","RUB","INR","CNY","ZAR"];
const TWAP_WINDOW_MS = 5 * 1000; // 5-second TWAP

// ===== Storage =====
let priceHistory = [];  // Stores recent raw prices for TWAP
let candlesStore = {};  // { timeframe_min: [ {time, open, high, low, close} ] }

// ===== Helpers =====
function getTWAP() {
    if (!priceHistory.length) return null;
    const sum = priceHistory.reduce((a,b)=>a+b.value,0);
    return sum / priceHistory.length;
}

function storePrice(value) {
    const ts = Date.now();
    priceHistory.push({ ts, value });
    priceHistory = priceHistory.filter(x => ts - x.ts <= TWAP_WINDOW_MS);
}

// Convert troy oz to USD per gram
async function getGoldUSDPerOz() {
    const res = await fetch("https://api.metals.live/v1/spot/gold");
    const data = await res.json();
    return data[0].gold;
}

// Fetch FX rates USD base
async function getFXRates() {
    const res = await fetch("https://api.exchangerate.host/latest?base=USD&symbols=" + FX_LIST.join(","));
    const json = await res.json();
    return json.rates;
}

// ===== Generate new Unit USD =====
async function generateUnitPrice() {
    const goldUSD = await getGoldUSDPerOz();
    const fx = await getFXRates();

    let basketIndex = GOLD_WEIGHT;
    for (let ccy of FX_LIST) {
        basketIndex += FX_WEIGHT * (fx[ccy] / fx[ccy]); // simplified ratio for demo
    }

    const unitGold = UNIT_BASE_GOLD * basketIndex;
    const unitUSD = unitGold * (goldUSD / GOLD_G_PER_OZ);

    // store TWAP
    storePrice(unitUSD);

    return {
        timestamp_utc: new Date().toISOString(),
        gold_usd_per_oz_twap: goldUSD,
        unit_gold_grams: unitGold,
        unit_usd: unitUSD,
        hundred_units_usd: unitUSD * 100,
    };
}

// ===== Routes =====
app.get('/latest.json', async (req,res) => {
    const unit = await generateUnitPrice();
    res.json(unit);
});

app.get('/ohlc', (req,res) => {
    const tf = parseInt(req.query.timeframe) || 1;
    const limit = parseInt(req.query.limit) || 1000;
    const data = candlesStore[tf] || [];
    res.json(data.slice(-limit));
});

app.post('/ohlc/update', (req,res) => {
    const candle = req.body;
    if (!candle || !candle.time) return res.status(400).send("Invalid candle");
    const tf = req.query.timeframe || 1;

    if (!candlesStore[tf]) candlesStore[tf] = [];
    candlesStore[tf].push(candle);

    // Limit to 1000 candles
    if (candlesStore[tf].length > 1000) candlesStore[tf] = candlesStore[tf].slice(-1000);

    res.json({ status: "ok" });
});

// ===== Start server =====
app.listen(PORT, () => {
    console.log(`BRICS TWAP server running on port ${PORT}`);
});
