import express from "express";
import cors from "cors";
import fs from "fs";
import path from "path";
import crypto from "crypto";

// ===== Environment guard =====
if (typeof fetch !== "function") {
  throw new Error("Native fetch not available — Node 18+ required");
}

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static("public"));

// ===== Paths =====
const GENESIS_PATH = path.join(process.cwd(), "genesis.json");
const CHART_PATH   = path.join(process.cwd(), "public", "lightweight-charts.esm.js");

// ===== Load frozen genesis =====
if (!fs.existsSync(GENESIS_PATH)) {
  throw new Error("genesis.json not found at project root");
}
const genesis = JSON.parse(fs.readFileSync(GENESIS_PATH, "utf8"));

// ===== Compute SHA256 helper =====
function sha256File(filePath) {
  if (!fs.existsSync(filePath)) return null;
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

// ===== Constants =====
const GOLD_G_PER_OZ = 31.1034768;
const UNIT_BASE_GOLD_G = 0.9823;
const GOLD_WEIGHT = 0.40;
const FX_WEIGHT   = 0.12;
const FX_LIST     = ["BRL", "RUB", "INR", "CNY", "ZAR"];
const TWAP_WINDOW_MS = 5000;

// ===== TWAP Storage =====
let goldHistory = [];
let fxHistory = {};
FX_LIST.forEach(c => (fxHistory[c] = []));

// ===== OHLC Storage =====
const candles = {}; // { timeframe_min: [ {time, open, high, low, close} ] }

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

function candleTime(tsSec, tfMin) {
  return Math.floor(tsSec / (tfMin * 60)) * tfMin * 60;
}

// ===== Market Fetch =====
async function fetchGold() {
  const r = await fetch("https://api.metals.live/v1/spot/gold");
  const j = await r.json();
  return j[0].gold;
}

async function fetchFX() {
  const r = await fetch(
    "https://api.exchangerate.host/latest?base=USD&symbols=" + FX_LIST.join(",")
  );
  const j = await r.json();
  return j.rates;
}

// ===== Core Computation =====
async function computeUnit() {
  const goldSpot = await fetchGold();
  const fxSpot   = await fetchFX();

  goldHistory = store(goldHistory, goldSpot);
  const goldTWAP = twap(goldHistory);

  let ci = 0;
  const fxTWAP = {};

  FX_LIST.forEach(c => {
    if (!fxSpot[c]) return;
    fxHistory[c] = store(fxHistory[c], fxSpot[c]);
    const fxt = twap(fxHistory[c]);
    fxTWAP[c] = fxt;
    ci += FX_WEIGHT * (fxt / genesis[c]);
  });

  const basketIndex = GOLD_WEIGHT + ci;
  const unitGoldG = UNIT_BASE_GOLD_G * basketIndex;
  const unitUSD   = unitGoldG * (goldTWAP / GOLD_G_PER_OZ);

  return { goldTWAP, unitGoldG, unitUSD, fxTWAP };
}

// ===== /latest.json =====
app.get("/latest.json", async (_, res) => {
  try {
    const d = await computeUnit();
    const ts = Date.now();
    const tsSec = Math.floor(ts / 1000);

    // ---- build candles for all timeframes ----
    Object.keys(candles).forEach(tf => {
      const t = candleTime(tsSec, tf);
      const arr = candles[tf];
      if (!arr.length || arr[arr.length - 1].time !== t) {
        arr.push({ time: t, open: d.unitUSD, high: d.unitUSD, low: d.unitUSD, close: d.unitUSD });
        if (arr.length > 1000) arr.shift();
      } else {
        const c = arr[arr.length - 1];
        c.high = Math.max(c.high, d.unitUSD);
        c.low  = Math.min(c.low, d.unitUSD);
        c.close = d.unitUSD;
      }
    });

    res.json({
      timestamp_utc: new Date(ts).toISOString(),
      gold_usd_per_oz_twap: d.goldTWAP,
      unit_gold_grams: d.unitGoldG,
      unit_usd: d.unitUSD,
      hundred_units_usd: d.unitUSD * 100,
      fx_usd_twap: d.fxTWAP
    });
  } catch (e) {
    console.error("Compute error:", e);
    res.status(500).json({ error: "feed unavailable" });
  }
});

// ===== /ohlc =====
app.get("/ohlc", (req, res) => {
  const tf = parseInt(req.query.timeframe || "1");
  const limit = parseInt(req.query.limit || "1000");

  candles[tf] ||= [];
  res.json(candles[tf].slice(-limit));
});

// ===== /meta.json =====
app.get("/meta.json", (_, res) => {
  const genesisHash = sha256File(GENESIS_PATH);
  const chartHash   = sha256File(CHART_PATH);

  res.json({
    index: "BRICS Unit Basket v1",
    methodology_frozen_utc: "2026-01-25T00:00:00Z",
    hashes: {
      genesis_json_sha256: genesisHash,
      lightweight_charts_esm_sha256: chartHash
    },
    files: {
      genesis: "/genesis.json",
      chart_library: "/lightweight-charts.esm.js"
    },
    notes: [
      "All hashes are computed from files actually served by this instance",
      "No CDN runtime dependencies",
      "Methodology frozen at publication",
      "Weaving spiders come not here"
    ],
    generated_utc: new Date().toISOString()
  });
});

// ===== Start server =====
app.listen(PORT, () => console.log(`BRICS Unit Basket v1 running on port ${PORT}`));

