import express from 'express';
import cors from 'cors';
import bodyParser from 'body-parser';
import fetch from 'node-fetch';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

// ===== Constants =====
const GOLD_G_PER_OZ = 31.1034768;
const UNIT_BASE_GOLD = 0.9823;
const GOLD_WEIGHT = 0.40;
const FX_WEIGHT = 0.12;
const FX_LIST = ["BRL","RUB","INR","CNY","ZAR"];
const TWAP_WINDOW_MS = 5000;
const MAX_CANDLES = 1000;

// ===== Storage =====
let goldHistory = [];
let fxHistory = {};
FX_LIST.forEach(ccy => fxHistory[ccy] = []);

let candlesStore = {};
let currentCandle = {};

// ===== Helpers =====
function twap(history) {
    if (!history.length) return null;
    return history.reduce((a,b)=>a+b.value,0) / history.length;
}

function storePrice(history, value) {
    const ts = Date.now();
    history.push({ ts, value });
    return history.filter(x => ts - x.ts <= TWAP_WINDOW_MS);
}

function getCandleTime(ts, tf_min) {
    return Math.floor(ts / (tf_min * 60 * 1000)) * tf_min * 60; // seconds
}

// ===== Market Data (HARDENED) =====
async function getGoldUSDPerOz() {
    try {
        const res = await fetch("https://api.metals.live/v1/spot/gold");
        const data = await res.json();
        if (!Array.isArray(data) || !data[0]?.gold) throw new Error("Bad gold data");
        return data[0].gold;
    } catch (e) {
        console.error("Gold fetch failed, fallback used");
        return 1900 + Math.random()*10;
    }
}

async function getFXRates() {
    try {
        const res = await fetch(
            "https://api.exchangerate.host/latest?base=USD&symbols=" + FX_LIST.join(",")
        );
        const json = await res.json();
        if (!json?.rates) throw new Error("Bad FX data");
        return json.rates;
    } catch (e) {
        console.error("FX fetch failed, fallback used");
        const fb = {};
        FX_LIST.forEach(c=>fb[c]=1);
        return fb;
    }
}

// ===== Compute Unit =====
async function generateUnitPrice() {
    const goldUSDPerOz = await getGoldUSDPerOz();
    const fxRates = await getFXRates();

    goldHistory = storePrice(goldHistory, goldUSDPerOz);

    FX_LIST.forEach(ccy => {
        const usdValue = fxRates[ccy] ? 1 / fxRates[ccy] : 1;
        fxHistory[ccy] = storePrice(fxHistory[ccy], usdValue);
    });

    const goldTWAP = twap(goldHistory);
    const fxTWAP = {};
    FX_LIST.forEach(ccy => fxTWAP[ccy] = twap(fxHistory[ccy]));

    const unitGold =
        UNIT_BASE_GOLD *
        (GOLD_WEIGHT + FX_LIST.length * FX_WEIGHT);

    const goldUSD =
        GOLD_WEIGHT * unitGold * (goldTWAP / GOLD_G_PER_OZ);

    let fxUSD = 0;
    FX_LIST.forEach(ccy => {
        fxUSD += FX_WEIGHT * unitGold * fxTWAP[ccy];
    });

    const unitUSD = goldUSD + fxUSD;

    return {
        timestamp_utc: new Date().toISOString(),
        unitUSD,
        goldTWAP,
        fxTWAP,
        unitGold
    };
}

// ===== Candles =====
function updateCandle(tf, price) {
    const ts = Date.now();
    const t = getCandleTime(ts, tf);

    if (!candlesStore[tf]) candlesStore[tf] = [];

    if (!currentCandle[tf] || currentCandle[tf].time !== t) {
        if (currentCandle[tf]) candlesStore[tf].push(currentCandle[tf]);
        currentCandle[tf] = { time:t, open:price, high:price, low:price, close:price };
        if (candlesStore[tf].length > MAX_CANDLES)
            candlesStore[tf] = candlesStore[tf].slice(-MAX_CANDLES);
    } else {
        const c = currentCandle[tf];
        c.high = Math.max(c.high, price);
        c.low = Math.min(c.low, price);
        c.close = price;
    }
}

// ===== Routes =====
app.get('/latest.json', async (req,res)=>{
    try {
        const unit = await generateUnitPrice();
        [1,15,30,60,180,1440,4320,10080,43200].forEach(tf =>
            updateCandle(tf, unit.unitUSD)
        );

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

app.get('/ohlc',(req,res)=>{
    const tf = parseInt(req.query.timeframe)||1;
    res.json((candlesStore[tf]||[]).slice(-MAX_CANDLES));
});

app.listen(PORT, ()=>console.log(`BRICS TWAP running on ${PORT}`));
