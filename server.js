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

// ===== Storage =====
let goldHistory = [];
let fxHistory = {};
FX_LIST.forEach(ccy => (fxHistory[ccy] = []));

// ===== Helpers =====
function twap(history) {
  if (!history.length) return 0;
  return history.reduce((a, b) => a + b.value, 0) / history.length;
}

function storePrice(history, value) {
  const ts = Date.now();
  history.push({ ts, value });
  return history.filter(p => ts - p.ts <= TWAP_WINDOW_MS);
}

// ===== Safe fetch with fallback =====
async function safeFetchJSON(url, fallback) {
  try {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 4000);
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error("Bad response");
    return await res.json();
  } catch {
    return fallback;
  }
}

// ===== Market Data =====
async function getGoldUSDPerOz() {
  // fallback 1900 USD/oz
  const data = await safeFetchJSON("https://api.metals.live/v1/spot/gold", [{ gold: 1900 }]);
  return data[0].gold;
}

async function getFXRates() {
  const data = await safeFetchJSON(
    "https://api.exchangerate.host/latest?base=USD&symbols=" + FX_LIST.join(","),
    { rates: { BRL: 5, RUB: 90, INR: 83, CNY: 7.2, ZAR: 18 } }
  );
  return data.rates;
}

// ===== Compute Unit Price =====
async function generateUnitPrice() {
  const goldUSDPerOz = await getGoldUSDPerOz();
  const fxRates = await getFXRates();

  goldHistory = storePrice(goldHistory, goldUSDPerOz);

  FX_LIST.forEach(ccy => {
    const v = 1 / (fxRates[ccy] || 1);
    fxHistory[ccy] = storePrice(fxHistory[ccy], v);
  });

  const goldTWAP = twap(goldHistory);
  const fxTWAP = {};
  FX_LIST.forEach(ccy => (fxTWAP[ccy] = twap(fxHistory[ccy])));

  const unitGold = UNIT_BASE_GOLD * (GOLD_WEIGHT + FX_LIST.length * FX_WEIGHT);
  const goldUSD = GOLD_WEIGHT * unitGold * (goldTWAP / GOLD_G_PER_OZ);

  let fxUSD = 0;
  FX_LIST.forEach(ccy => {
    fxUSD += FX_WEIGHT * unitGold * fxTWAP[ccy];
  });

  return {
    timestamp_utc: new Date().toISOString(),
    unitUSD: goldUSD + fxUSD,
    goldTWAP,
    fxTWAP,
    unitGold
  };
}

// ===== Routes =====
app.get("/latest.json", async (req, res) => {
  try {
    const unit = await generateUnitPrice();
    const fx_usd_twap = {};
    FX_LIST.forEach(ccy => fx_usd_twap[ccy] = unit.fxTWAP[ccy] || 0);

    res.json({
      timestamp_utc: unit.timestamp_utc,
      gold_usd_per_oz_twap: unit.goldTWAP || 0,
      fx_usd_twap,
      unit_gold_grams: unit.unitGold || 0,
      unit_usd: unit.unitUSD || 0,
      hundred_units_usd: unit.unitUSD ? unit.unitUSD * 100 : 0
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({
      timestamp_utc: new Date().toISOString(),
      gold_usd_per_oz_twap: 0,
      fx_usd_twap: FX_LIST.reduce((a,c)=>{a[c]=0;return a},{ }),
      unit_gold_grams: 0,
      unit_usd: 0,
      hundred_units_usd: 0
    });
  }
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
