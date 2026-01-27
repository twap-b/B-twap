// server.js
import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import path from "path";
import { fileURLToPath } from "url";
import fetch from "node-fetch";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, "public")));

// ===== Constants (frozen) =====
const GOLD_G_PER_OZ = 31.1034768;
const UNIT_BASE_GOLD = 0.9823;
const GOLD_WEIGHT = 0.40;
const FX_WEIGHT = 0.12;
const FX_LIST = ["BRL", "RUB", "INR", "CNY", "ZAR"];
const TWAP_WINDOW_MS = 5000;

// ===== Storage =====
let goldHistory = [];
let fxHistory = {};
FX_LIST.forEach(c => fxHistory[c] = []);

// ===== Helpers =====
function twap(history) {
  if (!history.length) return 0;
  return history.reduce((a,b)=>a+b.value,0) / history.length;
}

function store(history, value) {
  const now = Date.now();
  history.push({ ts: now, value });
  return history.filter(p => now - p.ts <= TWAP_WINDOW_MS);
}

async function safeFetchJSON(url, fallback) {
  try {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 4000);
    const r = await fetch(url, { signal: controller.signal });
    if (!r.ok) throw new Error();
    return await r.json();
  } catch {
    return fallback;
  }
}

// ===== Market Data =====
async function getGoldUSDPerOz() {
  const d = await safeFetchJSON(
    "https://api.metals.live/v1/spot/gold",
    [{ gold: 1900 }]
  );
  return d[0].gold;
}

async function getFXRates() {
  const d = await safeFetchJSON(
    "https://api.exchangerate.host/latest?base=USD&symbols=" + FX_LIST.join(","),
    { rates: { BRL:5, RUB:90, INR:83, CNY:7.2, ZAR:18 } }
  );
  return d.rates;
}

// ===== Core Calculation =====
async function generateUnitPrice() {
  const gold = await getGoldUSDPerOz();
  const fx = await getFXRates();

  goldHistory = store(goldHistory, gold);
  const goldTWAP = twap(goldHistory);

  const fxTWAP = {};
  FX_LIST.forEach(c => {
    fxHistory[c] = store(fxHistory[c], fx[c]);
    fxTWAP[c] = twap(fxHistory[c]);
  });

  // ---- White paper compliant pricing ----
  const unitGold = UNIT_BASE_GOLD;

  const unitUSD =
    unitGold * (goldTWAP / GOLD_G_PER_OZ);

  return {
    timestamp_utc: new Date().toISOString(),
    unit_usd: unitUSD,
    unit_gold_grams: unitGold,
    hundred_units_usd: unitUSD * 100,
    gold_usd_per_oz_twap: goldTWAP,
    fx_usd_twap: fxTWAP
  };
}

// ===== Route =====
app.get("/latest.json", async (_, res) => {
  try {
    res.json(await generateUnitPrice());
  } catch {
    res.json({
      timestamp_utc: new Date().toISOString(),
      unit_usd: 0,
      unit_gold_grams: UNIT_BASE_GOLD,
      hundred_units_usd: 0,
      gold_usd_per_oz_twap: 0,
      fx_usd_twap: FX_LIST.reduce((a,c)=>{a[c]=0;return a;},{})
    });
  }
});

app.listen(PORT, () =>
  console.log(`BRICS Unit server running on ${PORT}`)
);
