// server.js
import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import path from "path";
import { fileURLToPath } from "url";
import fetch from "node-fetch"; // ensure fetch works in Node <18

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

// ===== Storage =====
let goldHistory = [];
let fxHistory = {};
FX_LIST.forEach(ccy => (fxHistory[ccy] = []));

// ===== Helpers =====
function twap(history) {
  if (!history || !history.length) return 0;
  return history.reduce((sum, p) => sum + (p.value || 0), 0) / history.length;
}

function storePrice(history, value) {
  const ts = Date.now();
  history.push({ ts, value });
  return history.filter(p => ts - p.ts <= TWAP_WINDOW_MS);
}

// ===== SAFE FETCH with timeout =====
async function safeFetchJSON(url, fallback) {
  try {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 4000);

    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`Bad response: ${res.status}`);
    return await res.json();
  } catch (err) {
    console.warn("Fetch failed:", url, err.message);
    return fallback;
  }
}

// ===== Market Data =====
async function getGoldUSDPerOz() {
  const data = await safeFetchJSON(
    "https://api.metals.live/v1/spot/gold",
    [{ gold: 1900 }] // fallback
  );
  return data?.[0]?.gold || 1900;
}

async function getFXRates() {
  const data = await safeFetchJSON(
    "https://api.exchangerate.host/latest?base=USD&symbols=" + FX_LIST.join(","),
    { rates: { BRL: 5, RUB: 90, INR: 83, CNY: 7.2, ZAR: 18 } } // fallback
  );
  return data?.rates || { BRL: 5, RUB: 90, INR: 83, CNY: 7.2, ZAR: 18 };
}

// ===== Compute Unit =====
async function generateUnitPrice() {
  const goldUSDPerOz = await getGoldUSDPerOz();
  const fxRates = await getFXRates();

  goldHistory = storePrice(goldHistory, goldUSDPerOz);

  const fxTWAP = {};
  FX_LIST.forEach(ccy => {
    const rate = fxRates[ccy] || 1;
    const inverted = 1 / rate;
    fxHistory[ccy] = storePrice(fxHistory[ccy] || [], inverted);
    fxTWAP[ccy] = twap(fxHistory[ccy]);
  });

  const goldTWAP = twap(goldHistory);
  const unitGold = UNIT_BASE_GOLD * (GOLD_WEIGHT + FX_LIST.length * FX_WEIGHT);
  const goldUSD = GOLD_WEIGHT * unitGold * (goldTWAP / GOLD_G_PER_OZ);

  let fxUSD = 0;
  FX_LIST.forEach(ccy => {
    fxUSD += FX_WEIGHT * unitGold * (fxTWAP[ccy] || 0);
  });

  const unitUSD = goldUSD + fxUSD;
  return {
    timestamp_utc: new Date().toISOString(),
    unit_usd: unitUSD || 0,
    gold_usd_per_oz_twap: goldTWAP || 0,
    fx_usd_twap: fxTWAP,
    unit_gold_grams: unitGold || 0,
    hundred_units_usd: unitUSD ? unitUSD * 100 : 0
  };
}

// ===== Routes =====
app.get("/latest.json", async (req, res) => {
  try {
    const unit = await generateUnitPrice();
    res.json(unit);
  } catch (err) {
    console.error("Unexpected server error:", err);
    // guaranteed fallback
    res.status(200).json({
      timestamp_utc: new Date().toISOString(),
      unit_usd: 0,
      gold_usd_per_oz_twap: 0,
      fx_usd_twap: FX_LIST.reduce((a, c) => { a[c] = 0; return a; }, {}),
      unit_gold_grams: 0,
      hundred_units_usd: 0
    });
  }
});

// ===== Start Server =====
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
