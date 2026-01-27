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
const TWAP_WINDOW_MS = 5 * 1000; // 5-second TWAP
const UPDATE_INTERVAL_MS = 1000; // 1-second fetch interval

// ===== Storage =====
let goldHistory = [];           // { ts, price_usd_per_oz }
let fxHistory = { };            // { BRL: [{ts,value}], ... for all 5 currencies }
FX_LIST.forEach(ccy => fxHistory[ccy] = []);

// ===== Helpers =====
function twap(history) {
    if (!history.length) return null;
    const sum = history.reduce((acc, v) => acc + v.value, 0);
    return sum / history.length;
}

function storePrice(history, value) {
    const ts = Date.now();
    history.push({ ts, value });
    // Keep only last TWAP_WINDOW_MS
    return history.filter(x => ts - x.ts <= TWAP_WINDOW_MS);
}

// ===== Fetch Market Data =====
async function getGoldUSDPerOz() {
    const res = await fetch("https://api.metals.live/v1/spot/gold");
    const data = await res.json();
    return data[0].gold; // USD per troy oz
}

async function getFXRates() {
    const res = await fetch("https://api.exchangerate.host/latest?base=USD&symbols=" + FX_LIST.join(","));
    const json = await res.json();
    return json.rates; // USD base
}

// ===== Compute Unit Price =====
async function generateUnitPrice() {
    // 1️⃣ Get market data
    const goldUSDPerOz = await getGoldUSDPerOz();
    const fxRates = await getFXRates(); // USD per currency

    // 2️⃣ Update histories (TWAP)
    goldHistory = storePrice(goldHistory, goldUSDPerOz);
    FX_LIST.forEach(ccy => {
        const valueUSD = 1 / fxRates[ccy]; // 1 unit of currency in USD
        fxHistory[ccy] = storePrice(fxHistory[ccy], valueUSD);
    });

    // 3️⃣ Compute TWAPs
    const goldTWAP = twap(goldHistory);
    const fxTWAP = {};
    FX_LIST.forEach(ccy => fxTWAP[ccy] = twap(fxHistory[ccy]));

    // 4️⃣ Compute Unit Gold Amount
    const unitGold = UNIT_BASE_GOLD * (
        GOLD_WEIGHT +
        FX_LIST.reduce((sum, ccy) => sum + FX_WEIGHT, 0)
    );

    // 5️⃣ Compute USD per Unit
    const goldComponentUSD = GOLD_WEIGHT * unitGold * (goldTWAP / GOLD_G_PER_OZ);
    let fxComponentUSD = 0;
    FX_LIST.forEach(ccy => {
        fxComponentUSD += FX_WEIGHT * unitGold * fxTWAP[ccy]; 
    });

    const unitUSD = goldComponentUSD + fxComponentUSD;

    return {
        timestamp_utc: new Date().toISOString(),
        gold_usd_per_oz_twap: goldTWAP,
        fx_usd_twap: fxTWAP,             // TWAP of all 5 currencies
        unit_gold_grams: unitGold,
        unit_usd: unitUSD,
        hundred_units_usd: unitUSD * 100,
    };
}

// ===== Routes =====
app.get('/latest.json', async (req, res) => {
    try {
        const unit = await generateUnitPrice();
        res.json(unit);
    } catch (e) {
        console.error(e);
        res.status(500).send("Failed to compute Unit price");
    }
});

// ===== Start Server =====
app.listen(PORT, () => {
    console.log(`BRICS TWAP server running on port ${PORT}`);
});

