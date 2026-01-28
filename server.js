// server.js — BRICS Unit Basket v1 (locked)

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
app.use(express.static(path.join(__dirname, "public")));

// ===== Constants (FROZEN) =====
const GOLD_G_PER_OZ = 31.1034768;
const UNIT_BASE_GOLD_G = 0.9823;

const GOLD_WEIGHT = 0.40;
const FX_WEIGHT = 0.12;
const FX_LIST = ["BRL", "RUB", "INR", "CNY", "ZAR"];

const TWAP_WINDOW_MS = 5000;

// ===== Storage =====
let goldHistory = [];
let fxHistory = {};
FX_LIST.forEach(c => fxHistory[c] = []);

// ===== Helpers =====
function store(history, value) {
  const now = Date.now();
  history.push({ t: now, v: value });
  return history.filter(p => now - p.t <= TWAP_WINDOW_MS);
}

function twap(history) {
  if (!history.length) return null;
  return history.reduce((s, p) => s + p.v, 0) / history.length;
}

// ===== Safe fetch =====
async function safeJSON(url, fallback) {
  try {
    const r = await fetch(url, { timeout: 4000 });
    if (!r.ok) throw new Error();
    return await r.json();
  } catch {
    return fallback;
  }
}

// ===== Market data =====
async function fetchGold() {
  const d = await safeJSON(
    "https://api.metals.live/v1/spot/gold",
    [{ gold: 1900 }]
  );
  return d[0].gold;
}

async function fetchFX() {
  const d = await safeJSON(
    "https://api.exchangerate.host/latest?base=USD&symbols=" + FX_LIST.join(","),
    { rates: { BRL:5, RUB:90, INR:83, CNY:7.2, ZAR:18 } }
  );
  return d.rates;
}

// ===== Core calculation =====
async function computeUnit() {
  const gold = await fetchGold();
  const fx = await fetchFX();

  goldHistory = store(goldHistory, gold);
  const goldTWAP = twap(goldHistory);

  const fxTWAP = {};
  FX_LIST.forEach(c => {
    fxHistory[c] = store(fxHistory[c], fx[c]);
    fxTWAP[c] = twap(fxHistory[c]);
  });

  // Gold USD contribution
  const goldUSD =
    (UNIT_BASE_GOLD_G / GOLD_G_PER_OZ) *
    goldTWAP *
    GOLD_WEIGHT;

  // FX USD contribution (fixed weights)
  const fxUSD = FX_LIST.length * FX_WEIGHT * (goldUSD / GOLD_WEIGHT);

  const unitUSD = goldUSD + fxUSD;

  return {
    timestamp_utc: new Date().toISOString(),
    gold_usd_per_oz_twap: goldTWAP,
    unit_gold_grams: UNIT_BASE_GOLD_G,
    unit_usd: unitUSD,
    hundred_units_usd: unitUSD * 100,
    fx_usd_twap: fxTWAP
  };
}

// ===== Route =====
app.get("/latest.json", async (_, res) => {
  try {
    res.json(await computeUnit());
  } catch {
    res.json({
      timestamp_utc: new Date().toISOString(),
      unit_usd: 0,
      gold_usd_per_oz_twap: 0,
      unit_gold_grams: UNIT_BASE_GOLD_G,
      hundred_units_usd: 0,
      fx_usd_twap: FX_LIST.reduce((o,c)=>(o[c]=0,o),{})
    });
  }
});

app.listen(PORT, () =>
  console.log(`BRICS Unit Basket v1 server running on ${PORT}`)
);
