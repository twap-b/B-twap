// server.js — BRICS Unit Basket v2 (working live simulation)
import express from "express";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.static(path.join(__dirname, "public")));

// ===== Constants =====
const GOLD_G_PER_OZ = 31.1034768;       // grams per troy ounce
const UNIT_BASE_GOLD_G = 0.9823;        // grams per unit

const GOLD_WEIGHT = 0.40;               // 40% USD contribution from gold
const FX_WEIGHT = 0.12;                 // 12% each BRICS currency
const FX_LIST = ["BRL","RUB","INR","CNY","ZAR"];

const TWAP_WINDOW_MS = 5000;            // TWAP over 5 seconds

// ===== Storage for TWAP =====
let goldHistory = [];
let fxHistory = {};
FX_LIST.forEach(c => fxHistory[c] = []);

// ===== Helpers =====
function store(history, value){
  const now = Date.now();
  history.push({ t: now, v: value });
  // keep only last TWAP_WINDOW_MS ms
  return history.filter(p => now - p.t <= TWAP_WINDOW_MS);
}

function twap(history){
  if(!history.length) return 0;
  return history.reduce((s,p)=>s+p.v,0)/history.length;
}

// ===== Simulated live market data =====
// Gold moves slowly +/- 50 around 1900 USD
function simulateGold() {
  return 1900 + Math.sin(Date.now()/60000)*50;
}

// FX currencies fluctuate slowly around typical USD rates
function simulateFX(){
  return {
    BRL: 5 + Math.sin(Date.now()/90000),
    RUB: 90 + Math.sin(Date.now()/80000),
    INR: 83 + Math.sin(Date.now()/70000),
    CNY: 7.2 + Math.sin(Date.now()/100000),
    ZAR: 18 + Math.sin(Date.now()/110000)
  };
}

// ===== Compute unit price =====
function computeUnitPrice(){
  const goldSpot = simulateGold();
  const fxSpot = simulateFX();

  goldHistory = store(goldHistory, goldSpot);
  const goldTWAP = twap(goldHistory);

  const fxTWAP = {};
  FX_LIST.forEach(c => {
    fxHistory[c] = store(fxHistory[c], fxSpot[c]);
    fxTWAP[c] = twap(fxHistory[c]);
  });

  // ----- Gold USD contribution -----
  // unit has fixed grams of gold, weighted 40% of USD basket
  const goldUSD = (UNIT_BASE_GOLD_G / GOLD_G_PER_OZ) * goldTWAP * GOLD_WEIGHT;

  // ----- FX USD contribution -----
  let fxUSD = 0;
  FX_LIST.forEach(c => {
    fxUSD += FX_WEIGHT * (goldUSD / GOLD_WEIGHT); // proportionate
  });

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
app.get("/latest.json", (_, res) => {
  try {
    const data = computeUnitPrice();
    res.json(data);
  } catch(e){
    console.error("Error generating unit:", e);
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

app.listen(PORT, () => console.log(`BRICS Unit Basket server running on ${PORT}`));
