const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
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
const TWAP_WINDOW_MS = 5000; // 5-second TWAP
const MAX_CANDLES = 1000;

// ===== Storage =====
let goldHistory = [];
let fxHistory = {};
FX_LIST.forEach(ccy => fxHistory[ccy] = []);

let candlesStore = {}; // { timeframe_min: [ {time, open, high, low, close} ] }
let currentCandle = {}; // { timeframe_min: candle }

// ===== Helpers =====
function twap(history) {
    if (!history.length) return null;
    const sum = history.reduce((acc, v) => acc + v.value, 0);
    return sum / history.length;
}

function storePrice(history, value) {
    const ts = Date.now();
    history.push({ ts, value });
    return history.filter(x => ts - x.ts <= TWAP_WINDOW_MS);
}

// Align timestamp to nearest candle start
function getCandleTime(ts, tf_min) {
    return Math.floor(ts / (tf_min * 60 * 1000)) * tf_min * 60;
}

// ===== Fetch Market Data =====
async function getGoldUSDPerOz() {
    const res = await fetch("https://api.metals.live/v1/spot/gold");
    const data = await res.json();
    return data[0].gold;
}

async function getFXRates() {
    const res = await fetch("https://api.exchangerate.host/latest?base=USD&symbols=" + FX_LIST.join(","));
    const json = await res.json();
    return json.rates;
}

// ===== Compute True-Market Unit Price =====
async function generateUnitPrice() {
    const goldUSDPerOz = await getGoldUSDPerOz();
    const fxRates = await getFXRates();

    // Update TWAP histories
    goldHistory = storePrice(goldHistory, goldUSDPerOz);
    FX_LIST.forEach(ccy => {
        const valueUSD = 1 / fxRates[ccy]; // 1 unit of currency in USD
        fxHistory[ccy] = storePrice(fxHistory[ccy], valueUSD);
    });

    const goldTWAP = twap(goldHistory);
    const fxTWAP = {};
    FX_LIST.forEach(ccy => fxTWAP[ccy] = twap(fxHistory[ccy]));

    // Compute Unit gold amount
    const unitGold = UNIT_BASE_GOLD * (GOLD_WEIGHT + FX_LIST.reduce((sum,_)=>sum+FX_WEIGHT,0));

    // Compute USD contributions
    const goldUSD = GOLD_WEIGHT * unitGold * (goldTWAP / GOLD_G_PER_OZ);
    let fxUSD = 0;
    FX_LIST.forEach(ccy => fxUSD += FX_WEIGHT * unitGold * fxTWAP[ccy]);

    const unitUSD = goldUSD + fxUSD;

    return { timestamp_utc: new Date().toISOString(), unitUSD, goldTWAP, fxTWAP, unitGold };
}

// ===== OHLC Candle Update =====
function updateCandle(tf_min, price) {
    const ts = Date.now();
    const candleTime = getCandleTime(ts, tf_min);

    if (!candlesStore[tf_min]) candlesStore[tf_min] = [];
    if (!currentCandle[tf_min] || currentCandle[tf_min].time !== candleTime) {
        if (currentCandle[tf_min]) {
            candlesStore[tf_min].push(currentCandle[tf_min]);
            if (candlesStore[tf_min].length > MAX_CANDLES) candlesStore[tf_min] = candlesStore[tf_min].slice(-MAX_CANDLES);
        }
        currentCandle[tf_min] = { time: candleTime, open: price, high: price, low: price, close: price };
    } else {
        const c = currentCandle[tf_min];
        c.high = Math.max(c.high, price);
        c.low = Math.min(c.low, price);
        c.close = price;
    }
}

// ===== Routes =====
app.get('/latest.json', async (req, res) => {
    try {
        const unit = await generateUnitPrice();

        // Update all candle timeframes with latest price
        const tfList = [1,15,30,60,180,1440,4320,10080,43200]; // in minutes
        tfList.forEach(tf => updateCandle(tf, unit.unitUSD));

        res.json({
            timestamp_utc: unit.timestamp_utc,
            gold_usd_per_oz_twap: unit.goldTWAP,
            fx_usd_twap: unit.fxTWAP,
            unit_gold_grams: unit.unitGold,
            unit_usd: unit.unitUSD,
            hundred_units_usd: unit.unitUSD * 100
        });
    } catch(e) {
        console.error(e);
        res.status(500).send("Failed to compute Unit price");
    }
});

app.get('/ohlc', (req,res) => {
    const tf = parseInt(req.query.timeframe) || 1;
    const limit = parseInt(req.query.limit) || MAX_CANDLES;
    const data = candlesStore[tf] || [];
    res.json(data.slice(-limit));
});

app.post('/ohlc/update', (req,res) => {
    // Optional: external POST updates (we already update internally)
    res.json({status:"ok"});
});

// ===== Start Server =====
app.listen(PORT, () => console.log(`BRICS TWAP server running on port ${PORT}`));
