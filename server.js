import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import genesis from "./genesis.json" assert { type: "json" };

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());

// ===== Constants (FROZEN) =====
const GOLD_G_PER_OZ = 31.1034768;
const UNIT_BASE_GOLD_G = 0.9823;

const GOLD_WEIGHT = 0.40;
const FX_WEIGHT = 0.12;
const FX_LIST = ["BRL", "RUB", "INR", "CNY", "ZAR"];

const TWAP_WINDOW_MS = 5000;

// ===== TWAP Storage =====
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
  if (!history.length) return 0;
  return history.reduce((s, p) => s + p.v, 0) / history.length;
}

// ===== Live Market Fetch =====
async function fetchGold() {
  const r = await fetch("https://api.metals.live/v1/spot/gold");
  const j = await r.json();
  return j[0].gold; // USD / oz
}

async function fetchFX() {
  const r = await fetch(
    "https://api.exchangerate.host/latest?base=USD&symbols=" +
    FX_LIST.join(",")
  );
  const j = await r.json();
  return j.rates; // USD → FX
}

// ===== Compute Unit =====
async function computeUnit() {
  const goldSpot = await fetchGold();
  const fxSpot = await fetchFX();

  goldHistory = store(goldHistory, goldSpot);
  const goldTWAP = twap(goldHistory);

  let ci = 0;
  const fxTWAP = {};

  FX_LIST.forEach(c => {
    fxHistory[c] = store(fxHistory[c], fxSpot[c]);
    const fxT = twap(fxHistory[c]);
    fxTWAP[c] = fxT;

    ci += FX_WEIGHT * (fxT / genesis[c]);
  });

  const basketIndex = GOLD_WEIGHT + ci;

  const unitGoldG = UNIT_BASE_GOLD_G * basketIndex;
  const unitUSD =
    unitGoldG * (goldTWAP / GOLD_G_PER_OZ);

  return {
    timestamp_utc: new Date().toISOString(),
    gold_usd_per_oz_twap: goldTWAP,
    unit_gold_grams: unitGoldG,
    unit_usd: unitUSD,
    hundred_units_usd: unitUSD * 100,
    fx_usd_twap: fxTWAP
  };
}

// ===== Route =====
app.get("/latest.json", async (_, res) => {
  try {
    res.json(await computeUnit());
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "feed unavailable" });
  }
});

app.listen(PORT, () =>
  console.log(`BRICS Unit Basket v1 live on ${PORT}`)
);
