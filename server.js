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

// Serve frontend from /public
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

let candlesStore = {};     // { timeframe: [candles] }
let currentCandle = {};   // { timeframe: candle }

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

// ===== Fetch Market Data (Native fetch) =====
async function getGoldUSDPerOz() {
  try {
    const res = await fetch("https://api.metals.live/v1/spot/gold");
    const data = await res.json();
    return data[0].gold;
  } catch (e) {
    console.error("Gold fetch failed, using fallback", e);
    return 1900 + Math.random() * 5;
  }
}

async function getFXRates() {
  try {
    const res = await fetch(
      "https://api.exchangerate.host/latest?base=USD&symbols=" +
        FX_LIST.join(",")
    );
    const json = await res.json();
    return json.rates;
  } catch (e) {
    console.error("FX fetch failed, using fallback", e);
    const fallback = {};
    FX_LIST.forEach(ccy => (fallback[ccy] = 1));
    return fallback;
  }
}

// ===== Compute Unit Price =====
async function generateUnitPrice() {
  const goldUSDPerOz = await getGoldUSDPerOz();
  const fxRates = await getFXRates();

  goldHistory = storePrice(goldHistory, goldUSDPerOz);

  FX_LIST.forEach(ccy => {
    const valueUSD = 1 / fxRates[ccy];
    fxHistory[ccy] = storePrice(fxHistory[ccy], valueUSD);
  });

  const goldTWAP = twap(goldHistory);
  const fxTWAP = {};
  FX_LIST.forEach(ccy => (fxTWAP[ccy] = twap(fxHistory[ccy])));

  const unitGold =
    UNIT_BASE_GOLD *
    (GOLD_WEIGHT + FX_LIST.reduce((s, _) => s + FX_WEIGHT, 0));

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

// ===== Candle Engine =====
function updateCandle(tfMin, price) {
  const ts = Date.now();
  const candleTime = getCandleTime(ts, tfMin);

  if (!candlesStore[tfMin]) candlesStore[tfMin] = [];

  if (!currentCandle[tfMin] || currentCandle[tfMin].time !== candleTime) {
    if (currentCandle[tfMin]) {
      candlesStore[tfMin].push(currentCandle[tfMin]);
      if (candlesStore[tfMin].length > MAX_CANDLES) {
        candlesStore[tfMin] = candlesStore[tfMin].slice(-MAX_CANDLES);
      }
    }

    currentCandle[tfMin] = {
      time: candleTime,
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
    const tfList = [1, 15, 30, 60, 180, 1440, 4320, 10080, 43200];

    tfList.forEach(tf => updateCandle(tf, unit.unitUSD));

    res.json({
      timestamp_utc: unit.timestamp_utc,
      gold_usd_per_oz_twap: unit.goldTWAP,
      fx_usd_twap: unit.fxTWAP,
      unit_gold_grams: unit.unitGold,
      unit_usd: unit.unitUSD,
      hundred_units_usd: unit.unitUSD * 100
    });
  } catch (e) {
    console.error(e);
    res.status(500).send("Failed to compute Unit price");
  }
});

app.get("/ohlc", (req, res) => {
  const tf = parseInt(req.query.timeframe) || 1;
  const limit = parseInt(req.query.limit) || MAX_CANDLES;
  res.json((candlesStore[tf] || []).slice(-limit));
});

// ===== Root fallback (fixes Cannot GET /) =====
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ===== Start Server =====
app.listen(PORT, () =>
  console.log(`BRICS TWAP server running on port ${PORT}`)
);
