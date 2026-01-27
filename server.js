import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, "public")));

// ===== Constants =====
const GOLD_G_PER_OZ = 31.1034768;
const UNIT_BASE_GOLD = 0.9823;
const GOLD_WEIGHT = 0.40;
const FX_WEIGHT = 0.12;
const FX_LIST = ["BRL", "RUB", "INR", "CNY", "ZAR"];
const TWAP_WINDOW_MS = 5000;
const MAX_CANDLES = 1000;

// ===== Storage =====
let goldHistory = [];
let fxHistory = {};
FX_LIST.forEach(ccy => (fxHistory[ccy] = []));

let candlesStore = {};
let currentCandle = {};

// ===== Helpers =====
function twap(history) {
  if (!history.length) return null;
  return history.reduce((a, b) => a + b.value, 0) / history.length;
}

function storePrice(history, value) {
  const ts = Date.now();
  history.push({ ts, value });
  return history.filter(p => ts - p.ts <= TWAP_WINDOW_MS);
}

function getCandleTime(ts, tfMin) {
  return Math.floor(ts / (tfMin * 60 * 1000)) * tfMin * 60;
}

// ===== SAFE FETCH =====
async function safeFetchJSON(url, fallback) {
  try {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 4000);

    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error("Bad response");

    return await res.json();
  } catch (e) {
    console.warn("Fetch fallback:", url);
    return fallback;
  }
}

// ===== Market Data =====
async function getGoldUSDPerOz() {
  const data = await safeFetchJSON(
    "https://api.metals.live/v1/spot/gold",
    [{ gold: 1900 }]
  );
  return Number(data[0]?.gold || 1900);
}

async function getFXRates() {
  const data = await safeFetchJSON(
    "https://api.exchangerate.host/latest?base=USD&symbols=" +
      FX_LIST.join(","),
    { rates: { BRL: 5, RUB: 90, INR: 83, CNY: 7.2, ZAR: 18 } }
  );
  return data.rates;
}

// ===== Compute Unit =====
async function generateUnitPrice() {
  const goldUSDPerOz = await getGoldUSDPerOz();
  const fxRates = await getFXRates();

  goldHistory = storePrice(goldHistory, goldUSDPerOz);

  FX_LIST.forEach(ccy => {
    const v = 1 / fxRates[ccy];
    fxHistory[ccy] = storePrice(fxHistory[ccy], v);
  });

  const goldTWAP = twap(goldHistory);
  const fxTWAP = {};
  FX_LIST.forEach(ccy => (fxTWAP[ccy] = twap(fxHistory[ccy]) || 0));

  const unitGold =
    UNIT_BASE_GOLD *
    (GOLD_WEIGHT + FX_LIST.length * FX_WEIGHT);

  const goldUSD =
    GOLD_WEIGHT * unitGold * ((goldTWAP || goldUSDPerOz) / GOLD_G_PER_OZ);

  let fxUSD = 0;
  FX_LIST.forEach(ccy => {
    fxUSD += FX_WEIGHT * unitGold * (fxTWAP[ccy] || 0);
  });

  return {
    timestamp_utc: new Date().toISOString(),
    unitUSD: goldUSD + fxUSD,
    goldTWAP: goldTWAP || goldUSDPerOz,
    fxTWAP,
    unitGold
  };
}

// ===== Candles =====
function updateCandle(tfMin, price) {
  const ts = Date.now();
  const t = getCandleTime(ts, tfMin);

  if (!candlesStore[tfMin]) candlesStore[tfMin] = [];

  if (!currentCandle[tfMin] || currentCandle[tfMin].time !== t) {
    if (currentCandle[tfMin]) {
      candlesStore[tfMin].push(currentCandle[tfMin]);
      if (candlesStore[tfMin].length > MAX_CANDLES) {
        candlesStore[tfMin] = candlesStore[tfMin].slice(-MAX_CANDLES);
      }
    }

    currentCandle[tfMin] = {
      time: t,
      open: price,
      high: price,
      low: price,
      close: price
    };
  } else {
    const c = currentCandle[tfMin];
    c.high = Math.max(c.high, price);
    c.low = Math.min(c.low, price);
    c.close = price;
  }
}

// ===== Routes =====
app.get("/latest.json", async (req, res) => {
  try {
    const unit = await generateUnitPrice();

    [1, 15, 30, 60, 180, 1440, 4320, 10080, 43200].forEach(tf =>
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
  } catch (e) {
    console.error("Unit calc failed:", e);
    res.json({
      timestamp_utc: new Date().toISOString(),
      gold_usd_per_oz_twap: 0,
      fx_usd_twap: {},
      unit_gold_grams: 0,
      unit_usd: 0,
      hundred_units_usd: 0
    });
  }
});

// ===== Start =====
app.listen(PORT, () =>
  console.log(`BRICS TWAP server running on port ${PORT}`)
);
