// server.js — Render-safe reference implementation
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
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ===== Constants (FROZEN) =====
const GOLD_G_PER_OZ = 31.1034768;
const UNIT_BASE_GOLD = 0.9823;
const GOLD_WEIGHT = 0.40;
const FX_WEIGHT = 0.12;
const FX_LIST = ["BRL", "RUB", "INR", "CNY", "ZAR"];
const TWAP_WINDOW_MS = 5000;

// ===== TWAP Storage =====
let goldHistory = [];
let fxHistory = {};
FX_LIST.forEach(c => fxHistory[c] = []);

// ===== Last Known Good (CRITICAL) =====
let LAST_GOOD = {
  gold: 1900,
  fx: { BRL:5, RUB:90, INR:83, CNY:7.2, ZAR:18 }
};

// ===== Helpers =====
function store(history, value) {
  const t = Date.now();
  history.push({ t, v: value });
  return history.filter(x => t - x.t <= TWAP_WINDOW_MS);
}

function twap(history) {
  if (!history.length) return null;
  return history.reduce((a,b)=>a+b.v,0) / history.length;
}

async function fetchJSON(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error("fetch failed");
  return r.json();
}

// ===== Market Data =====
async function getGold() {
  try {
    const d = await fetchJSON("https://api.metals.live/v1/spot/gold");
    const v = d?.[0]?.gold;
    if (!v) throw "bad gold";
    LAST_GOOD.gold = v;
    return v;
  } catch {
    return LAST_GOOD.gold;
  }
}

async function getFX() {
  try {
    const d = await fetchJSON(
      "https://api.exchangerate.host/latest?base=USD&symbols=" + FX_LIST.join(",")
    );
    if (!d?.rates) throw "bad fx";
    LAST_GOOD.fx = d.rates;
    return d.rates;
  } catch {
    return LAST_GOOD.fx;
  }
}

// ===== Core Calculation =====
async function computeUnit() {
  const gold = await getGold();
  const fx = await getFX();

  goldHistory = store(goldHistory, gold);
  const goldTWAP = twap(goldHistory) ?? gold;

  let fxTWAP = {};
  FX_LIST.forEach(c => {
    fxHistory[c] = store(fxHistory[c], fx[c]);
    fxTWAP[c] = twap(fxHistory[c]) ?? fx[c];
  });

  const unitGold =
    UNIT_BASE_GOLD * (GOLD_WEIGHT + FX_LIST.length * FX_WEIGHT);

  const goldUSD =
    GOLD_WEIGHT * unitGold * (goldTWAP / GOLD_G_PER_OZ);

  let fxUSD = 0;
  FX_LIST.forEach(c => {
    fxUSD += FX_WEIGHT * (goldUSD / GOLD_WEIGHT);
  });

  const unitUSD = goldUSD + fxUSD;

  return {
    timestamp_utc: new Date().toISOString(),
    unit_usd: unitUSD,
    unit_gold_grams: unitGold,
    gold_usd_per_oz_twap: goldTWAP,
    fx_usd_twap: fxTWAP,
    hundred_units_usd: unitUSD * 100
  };
}

// ===== Route =====
app.get("/latest.json", async (_, res) => {
  try {
    res.json(await computeUnit());
  } catch {
    res.json({
      timestamp_utc: new Date().toISOString(),
      unit_usd: LAST_GOOD.gold,
      unit_gold_grams: UNIT_BASE_GOLD,
      gold_usd_per_oz_twap: LAST_GOOD.gold,
      fx_usd_twap: LAST_GOOD.fx,
      hundred_units_usd: LAST_GOOD.gold * 100
    });
  }
});

app.listen(PORT, () =>
  console.log(`BRICS Unit Basket v1 running on ${PORT}`)
);
