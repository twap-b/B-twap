// server.js — BRICS Unit Basket v3 (simulation + multi-leg)
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
const GOLD_G_PER_OZ = 31.1034768;
const UNIT_BASE_GOLD_G = 0.9823;
const GOLD_WEIGHT = 0.40;
const FX_WEIGHT = 0.12;
const FX_LIST = ["BRL","RUB","INR","CNY","ZAR"];
const TWAP_WINDOW_MS = 5000;

// ===== Storage =====
let goldHistory = [];
let fxHistory = {};
FX_LIST.forEach(c => fxHistory[c] = []);

// ===== Helpers =====
function store(history, value){
  const now = Date.now();
  history.push({ t: now, v: value });
  return history.filter(p => now - p.t <= TWAP_WINDOW_MS);
}

function twap(history){
  if(!history.length) return 0;
  return history.reduce((s,p)=>s+p.v,0)/history.length;
}

// ===== Simulated market data =====
function simulateGold(){ return 1900 + Math.sin(Date.now()/60000)*50; }
function simulateFX(){ 
  return {
    BRL: 5 + Math.sin(Date.now()/90000),
    RUB: 90 + Math.sin(Date.now()/80000),
    INR: 83 + Math.sin(Date.now()/70000),
    CNY: 7.2 + Math.sin(Date.now()/100000),
    ZAR: 18 + Math.sin(Date.now()/110000)
  };
}

// ===== Compute full unit basket =====
function computeUnit(){
  const goldSpot = simulateGold();
  const fxSpot = simulateFX();

  goldHistory = store(goldHistory, goldSpot);
  const goldTWAP = twap(goldHistory);

  const fxTWAP = {};
  FX_LIST.forEach(c=>{
    fxHistory[c] = store(fxHistory[c], fxSpot[c]);
    fxTWAP[c] = twap(fxHistory[c]);
  });

  // Gold leg USD contribution
  const goldUSD = (UNIT_BASE_GOLD_G / GOLD_G_PER_OZ) * goldTWAP;
  const goldLegUSD = goldUSD * GOLD_WEIGHT;

  // FX legs USD contributions
  const fxLegs = {};
  FX_LIST.forEach(c=>{
    const usdValue = goldUSD * FX_WEIGHT / GOLD_WEIGHT;  // proportional to gold scale
    fxLegs[c] = {
      usd: usdValue,
      local: usdValue * fxTWAP[c],
      rate: fxTWAP[c]
    };
  });

  // BRICS Unit USD (sum of legs + gold)
  const unitUSD = goldLegUSD + FX_LIST.reduce((sum,c)=>sum+fxLegs[c].usd,0);

  return {
    timestamp_utc: new Date().toISOString(),
    gold: {
      grams: UNIT_BASE_GOLD_G,
      usd_per_oz_twap: goldTWAP,
      usd_value: goldLegUSD
    },
    fx: fxLegs,
    unit_usd: unitUSD,
    hundred_units_usd: unitUSD*100
  };
}

// ===== Routes =====
app.get("/latest.json", (_, res) => {
  try {
    res.json(computeUnit());
  } catch(e){
    console.error(e);
    res.json({ error: "data unavailable" });
  }
});

app.listen(PORT, ()=>console.log(`BRICS Unit Basket v3 running on port ${PORT}`));
