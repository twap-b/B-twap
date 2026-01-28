// server.js — BRICS Unit Basket v1 (locked, corrected)

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

// ===============================
// FROZEN CONSTANTS (WHITE PAPER)
// ===============================
const GOLD_G_PER_OZ = 31.1034768;
const UNIT_BASE_GOLD_G = 0.9823;

const GOLD_WEIGHT = 0.40;
const FX_WEIGHT = 0.12;
const FX_LIST = ["BRL", "RUB", "INR", "CNY", "ZAR"];

const TWAP_WINDOW_MS = 5000;

// ===============================
// STORAGE (IN-MEMORY TWAP)
// ===============================
let goldHistory = [];
let fxHistory = {};
FX_LIST.forEach(c => fxHistory[c] = []);

// ===============================
// HELPERS
// ===============================
function store(history, value) {
  const now = Date.now();
  history.push({ t: now, v: value });
  return history.filter(p => now - p.t <= TWAP_WINDOW_MS);
}

function twap(history, fallback) {
  if (!history.length) return fallback;
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

// ===============================
// MARKET DATA
// ===============================
async function fetchGoldUSDPerOz() {
  const d = await safeJSON(
    "https://api.metals.live/v1/spot/gold",
    [{ gold: 1900 }]
  );
  return d?.[0]?.gold ?? 1900;
}

async function fetchFX() {
  const d = await safeJSON(
    "https://api.exchangerate.host/latest?base=USD&symbols=" + FX_LIST.join(","),
    { rates: { BRL:5, RUB:90, INR:83, CNY:7.2, ZAR:18 } }
  );
  return d?.rates ?? { BRL:5, RUB:90, INR:83, CNY:7.2, ZAR:18 };
}

// ===============================
// CORE CALCULATION (CORRECTED)
// ===============================
async function computeUnit() {
  // --- Fetch ---
  const goldSpot = await fetchGoldUSDPerOz(); // USD / oz
  const fxRates  = await fetchFX();           // USD → FX

  // --- Store TWAP inputs ---
  goldHistory = store(goldHistory, goldSpot);
  const goldTWAP = twap(goldHistory, goldSpot);

  const fxTWAP = {};
  FX_LIST.forEach(c => {
    fxHistory[c] = store(fxHistory[c], fxRates[c]);
    fxTWAP[c] = twap(fxHistory[c], fxRates[c]);
  });

  // --- Gold USD contribution ---
  const goldUSD =
    (UNIT_BASE_GOLD_G / GOLD_G_PER_OZ) *
    goldTWAP *
    GOLD_WEIGHT;

  // --- FX USD contribution ---
  // FX basket is 60% of unit, expressed in USD terms
  const fxUSD = goldUSD * ((1 - GOLD_WEIGHT) / GOLD_WEIGHT);

  const unitUSD = goldUSD + fxUSD;

  return {
    timestamp_utc: new Date().toISOString(),

    // headline values
    unit_usd: unitUSD,
    hundred_units_usd: unitUSD * 100,
    unit_gold_grams: UNIT_BASE_GOLD_G,

    // TWAP inputs
    gold_usd_per_oz_twap: goldTWAP,
    fx_usd_twap: fxTWAP
  };
}

// ===============================
// API ROUTE (MUST COME FIRST)
// ===============================
app.get("/latest.json", async (_req, res) => {
  try {
    const data = await computeUnit();
    res.json(data);
  } catch (err) {
    console.error("computeUnit failure:", err);
    res.json({
      timestamp_utc: new Date().toISOString(),
      unit_usd: 0,
      hundred_units_usd: 0,
      unit_gold_grams: UNIT_BASE_GOLD_G,
      gold_usd_per_oz_twap: 0,
      fx_usd_twap: FX_LIST.reduce((o,c)=>(o[c]=0,o),{})
    });
  }
});

// ===============================
// STATIC FILES (AFTER ROUTES)
// ===============================
app.use(express.static(path.join(__dirname, "public")));

// ===============================
// START
// ===============================
app.listen(PORT, () => {
  console.log(`BRICS Unit Basket v1 server running on port ${PORT}`);
});
