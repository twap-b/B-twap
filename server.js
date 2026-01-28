// server.js — BRICS Unit Basket v1 (correct economic model)

import express from "express";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import fetch from "node-fetch";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());

// =====================
// FROZEN CONSTANTS
// =====================
const GOLD_G_PER_OZ = 31.1034768;
const UNIT_BASE_GOLD_G = 0.9823;

const GOLD_WEIGHT = 0.40;
const FX_WEIGHT = 0.12;
const FX_LIST = ["BRL", "RUB", "INR", "CNY", "ZAR"];

const TWAP_WINDOW_MS = 5000;

// =====================
// TWAP STORAGE
// =====================
let goldHistory = [];
let fxHistory = {};
FX_LIST.forEach(c => fxHistory[c] = []);

// =====================
// HELPERS
// =====================
function store(history, value) {
  const now = Date.now();
  history.push({ t: now, v: value });
  return history.filter(p => now - p.t <= TWAP_WINDOW_MS);
}

function twap(history, fallback) {
  if (!history.length) return fallback;
  return history.reduce((s,p)=>s+p.v,0) / history.length;
}

async function safeJSON(url, fallback) {
  try {
    const r = await fetch(url, { timeout: 4000 });
    if (!r.ok) throw new Error();
    return await r.json();
  } catch {
    return fallback;
  }
}

// =====================
// MARKET DATA
// =====================
async function fetchGoldUSD() {
  // primary
  const d = await safeJSON(
    "https://api.metals.live/v1/spot/gold",
    null
  );

  if (d && d[0]?.gold) return d[0].gold;

  // secondary fallback
  const alt = await safeJSON(
    "https://api.gold-api.com/price/XAU",
    { price: 1900 }
  );

  return alt.price;
}

async function fetchFX() {
  const d = await safeJSON(
    "https://api.exchangerate.host/latest?base=USD&symbols=" + FX_LIST.join(","),
    { rates: { BRL:5, RUB:90, INR:83, CNY:7.2, ZAR:18 } }
  );
  return d.rates;
}

// =====================
// CORE CALCULATION
// =====================
async function computeUnit() {
  // --- Fetch ---
  const goldSpot = await fetchGoldUSD(); // USD / oz
  const fxRates  = await fetchFX();      // USD → FX

  // --- TWAP ---
  goldHistory = store(goldHistory, goldSpot);
  const goldTWAP = twap(goldHistory, goldSpot);

  // --- Gold USD value ---
  const goldUSD =
    (UNIT_BASE_GOLD_G / GOLD_G_PER_OZ) *
    goldTWAP *
    GOLD_WEIGHT;

  // --- Total unit USD ---
  const unitUSD = goldUSD / GOLD_WEIGHT;

  // --- FX basket ---
  const fxUSDPerLeg = unitUSD * FX_WEIGHT;

  const fxTWAP = {};
  const fxBasket = {};

  FX_LIST.forEach(c => {
    fxHistory[c] = store(fxHistory[c], fxRates[c]);
    const rateTWAP = twap(fxHistory[c], fxRates[c]);

    fxTWAP[c] = rateTWAP;

    fxBasket[c] = {
      usd_share: fxUSDPerLeg,
      currency_amount: fxUSDPerLeg * rateTWAP
    };
  });

  return {
    timestamp_utc: new Date().toISOString(),

    unit_usd: unitUSD,
    hundred_units_usd: unitUSD * 100,
    unit_gold_grams: UNIT_BASE_GOLD_G,

    gold_usd_per_oz_twap: goldTWAP,

    // for frontend
    fx_usd_twap: fxTWAP,
    fx_basket: fxBasket
  };
}

// =====================
// ROUTES
// =====================
app.get("/latest.json", async (_req, res) => {
  try {
    res.json(await computeUnit());
  } catch (e) {
    console.error(e);
    res.json({
      timestamp_utc: new Date().toISOString(),
      unit_usd: 0,
      hundred_units_usd: 0,
      unit_gold_grams: UNIT_BASE_GOLD_G,
      gold_usd_per_oz_twap: 0,
      fx_usd_twap: {},
      fx_basket: {}
    });
  }
});

// =====================
// STATIC (AFTER API)
// =====================
app.use(express.static(path.join(__dirname, "public")));

app.listen(PORT, () =>
  console.log(`BRICS Unit Basket v1 running on ${PORT}`)
);
