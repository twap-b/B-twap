import express from "express";
import cors from "cors";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;
app.use(cors());

// ===== Frozen Genesis =====
const genesis = JSON.parse(
  fs.readFileSync(path.join(__dirname, "genesis.json"), "utf8")
);

// ===== Constants =====
const GOLD_G_PER_OZ = 31.1034768;
const UNIT_BASE_GOLD_G = 0.9823;

const GOLD_WEIGHT = 0.40;
const FX_WEIGHT = 0.12;
const FX_LIST = ["BRL", "RUB", "INR", "CNY", "ZAR"];
const TWAP_WINDOW_MS = 5000;

// ===== TWAP Storage =====
let goldHistory = [];
let fxHistory = {};
FX_LIST.forEach(c => (fxHistory[c] = []));

// ===== OHLC Storage =====
const candles = {}; // { timeframe: [ {time,open,high,low,close} ] }

// ===== Helpers =====
function store(history, value) {
  const now = Date.now();
  history.push({ t: now, v: value });
  return history.filter(p => now - p.t <= TWAP_WINDOW_MS);
}

function twap(history) {
  if (!history.length) return 0;
  return history.reduce((s, p) => s + p.v, 0) / history.length;
}

function candleTime(tsSec, tfMin) {
  return Math.floor(tsSec / (tfMin * 60)) * tfMin * 60;
}

// ===== Market Fetch =====
async function fetchGold() {
  const r = await fetch("https://api.metals.live/v1/spot/gold");
  const j = await r.json();
  return j[0].gold;
}

async function fetchFX() {
  const r = await fetch(
    "https://api.exchangerate.host/latest?base=USD&symbols=" +
      FX_LIST.join(",")
  );
  const j = await r.json();
  return j.rates;
}

// ===== Core Computation =====
async function computeUnit() {
  const goldSpot = await fetchGold();
  const fxSpot = await fetchFX();

  goldHistory = store(goldHistory, goldSpot);
  const goldTWAP = twap(goldHistory);

  let ci = 0;
  const fxTWAP = {};

  FX_LIST.forEach(c => {
    fxHistory[c] = store(fxHistory[c], fxSpot[c]);
    const fxt = twap(fxHistory[c]);
    fxTWAP[c] = fxt;
    ci += FX_WEIGHT * (fxt / genesis[c]);
  });

  const basketIndex = GOLD_WEIGHT + ci;
  const unitGoldG = UNIT_BASE_GOLD_G * basketIndex;
  const unitUSD = unitGoldG * (goldTWAP / GOLD_G_PER_OZ);

  return { goldTWAP, unitGoldG, unitUSD, fxTWAP };
}

// ===== Routes =====
app.get("/latest.json", async (_, res) => {
  try {
    const d = await computeUnit();
    const ts = Date.now();
    const tsSec = Math.floor(ts / 1000);

    // build candles
    Object.keys(candles).forEach(tf => {
      const t = candleTime(tsSec, tf);
      let arr = candles[tf];

      if (!arr.length || arr[arr.length - 1].time !== t) {
        arr.push({
          time: t,
          open: d.unitUSD,
          high: d.unitUSD,
          low: d.unitUSD,
          close: d.unitUSD
        });
        if (arr.length > 1000) arr.shift();
      } else {
        const c = arr[arr.length - 1];
        c.high = Math.max(c.high, d.unitUSD);
        c.low = Math.min(c.low, d.unitUSD);
        c.close = d.unitUSD;
      }
    });

    res.json({
      timestamp_utc: new Date(ts).toISOString(),
      gold_usd_per_oz_twap: d.goldTWAP,
      unit_gold_grams: d.unitGoldG,
      unit_usd: d.unitUSD,
      hundred_units_usd: d.unitUSD * 100,
      fx_usd_twap: d.fxTWAP
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "feed unavailable" });
  }
});

app.get("/ohlc", (req, res) => {
  const tf = parseInt(req.query.timeframe || "1");
  const limit = parseInt(req.query.limit || "1000");

  candles[tf] ||= [];
  res.json(candles[tf].slice(-limit));
});

app.listen(PORT, () =>
  console.log(`BRICS Unit Basket v1 running on ${PORT}`)
);
