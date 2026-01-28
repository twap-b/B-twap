// server.js — BRICS Unit Basket v1 (final, stable)

import express from "express";
import cors from "cors";
import fetch from "node-fetch";

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());

// ================== CONSTANTS (FROZEN) ==================
const GOLD_G_PER_OZ = 31.1034768;
const UNIT_GOLD_GRAMS = 0.9823;

const GOLD_WEIGHT = 0.40;
const FX_WEIGHT = 0.12;

const FX_LIST = ["BRL", "RUB", "INR", "CNY", "ZAR"];
const TWAP_WINDOW_MS = 5000;

// ================== STORAGE ==================
let goldHistory = [];
let fxHistory = {};
FX_LIST.forEach(c => (fxHistory[c] = []));

// ================== HELPERS ==================
function store(history, value) {
  const now = Date.now();
  history.push({ t: now, v: value });
  return history.filter(p => now - p.t <= TWAP_WINDOW_MS);
}

function twap(history) {
  if (!history.length) return null;
  return history.reduce((s, p) => s + p.v, 0) / history.length;
}

async function safeJSON(url, fallback) {
  try {
    const r = await fetch(url, { timeout: 4000 });
    if (!r.ok) throw new Error("bad response");
    return await r.json();
  } catch {
    return fallback;
  }
}

// ================== MARKET DATA ==================
async function fetchGoldUSD() {
  const d = await safeJSON(
    "https://api.metals.live/v1/spot/gold",
    [{ gold: 1900 }]
  );
  return d[0].gold;
}

async function fetchFX() {
  const d = await safeJSON(
    "https://api.exchangerate.host/latest?base=USD&symbols=" + FX_LIST.join(","),
    { rates: { BRL: 5, RUB: 90, INR: 83, CNY: 7.2, ZAR: 18 } }
  );
  return d.rates;
}

// ================== CORE CALC ==================
async function computeUnit() {
  const goldUSDPerOz = await fetchGoldUSD();
  const fxRates = await fetchFX();

  goldHistory = store(goldHistory, goldUSDPerOz);
  const goldTWAP = twap(goldHistory);

  const fxTWAP = {};
  FX_LIST.forEach(c => {
    fxHistory[c] = store(fxHistory[c], fxRates[c]);
    fxTWAP[c] = twap(fxHistory[c]);
  });

  // Base unit value from gold anchor
  const baseGoldUSD =
    (UNIT_GOLD_GRAMS / GOLD_G_PER_OZ) * goldTWAP;

  // Unit USD (gold defines the scale)
  const unitUSD = baseGoldUSD / GOLD_WEIGHT;

  // Gold USD leg
  const goldLegUSD = unitUSD * GOLD_WEIGHT;

  // FX legs
  const fxLegs = {};
  FX_LIST.forEach(c => {
    const usdValue = unitUSD * FX_WEIGHT;
    const localAmount = usdValue * fxTWAP[c];

    fxLegs[c] = {
      usd: usdValue,
      amount: localAmount,
      rate: fxTWAP[c]
    };
  });

  return {
    timestamp_utc: new Date().toISOString(),

    unit_usd: unitUSD,
    hundred_units_usd: unitUSD * 100,

    gold: {
      usd_per_oz_twap: goldTWAP,
      grams: UNIT_GOLD_GRAMS,
      usd_value: goldLegUSD
    },

    fx: fxLegs
  };
}

// ================== ROUTE ==================
app.get("/latest.json", async (_, res) => {
  try {
    res.json(await computeUnit());
  } catch (err) {
    console.error(err);
    res.json({ error: "data unavailable" });
  }
});

app.listen(PORT, () =>
  console.log(`BRICS Unit Basket v1 server running on ${PORT}`)
);
