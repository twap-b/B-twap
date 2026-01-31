import express from "express";
import cors from "cors";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import https from "https";
import { fileURLToPath } from "url";

/* ================= PATH FIX (ESM SAFE) ================= */

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/* ================= FETCH CHART LIB (ONCE) ================= */

const CHART_URL =
  "https://cdn.jsdelivr.net/npm/lightweight-charts@5.1.0/dist/lightweight-charts.esm.production.js";

const CHART_PATH = path.join(__dirname, "public", "lightweight-charts.esm.js");

if (!fs.existsSync(CHART_PATH)) {
  console.log("Fetching lightweight-charts…");

  fs.mkdirSync(path.dirname(CHART_PATH), { recursive: true });

  https.get(CHART_URL, res => {
    if (res.statusCode !== 200) {
      throw new Error("Failed to fetch lightweight-charts");
    }
    const file = fs.createWriteStream(CHART_PATH);
    res.pipe(file);
    file.on("finish", () => {
      file.close();
      console.log("✔ lightweight-charts saved");
    });
  });
}

/* ================= ENV GUARD ================= */

if (typeof fetch !== "function") {
  throw new Error("Native fetch not available — Node 18+ required");
}

/* ================= APP ================= */

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static("public"));

/* ================= GENESIS ================= */

const GENESIS_PATH = path.join(__dirname, "genesis.json");

if (!fs.existsSync(GENESIS_PATH)) {
  throw new Error("genesis.json not found at project root");
}

const genesis = JSON.parse(fs.readFileSync(GENESIS_PATH, "utf8"));

const genesisHash = crypto
  .createHash("sha256")
  .update(JSON.stringify(genesis))
  .digest("hex");

console.log("Genesis FX SHA256:", genesisHash);

/* ================= CONSTANTS ================= */

const GOLD_G_PER_OZ = 31.1034768;
const UNIT_BASE_GOLD_G = 0.9823;

const GOLD_WEIGHT = 0.40;
const FX_WEIGHT = 0.12;
const FX_LIST = ["BRL", "RUB", "INR", "CNY", "ZAR"];
const TWAP_WINDOW_MS = 5000;

/* ================= STORAGE ================= */

let goldHistory = [];
let fxHistory = {};
FX_LIST.forEach(c => (fxHistory[c] = []));

const candles = {}; // { timeframe: [ {time,open,high,low,close} ] }

/* ================= HELPERS ================= */

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

/* ================= MARKET FETCH ================= */

async function fetchGold() {
  const r = await fetch("https://api.metals.live/v1/spot/gold");
  const j = await r.json();
  return j[0].gold;
}

async function fetchFX() {
  const r = await fetch(
    "https://api.exchangerate.host/latest?base=USD&symbols=" +
      FX_LIST.join(",")
  );
  const j = await r.json();
  return j.rates;
}

/* ================= CORE COMPUTATION ================= */

async function computeUnit() {
  const goldSpot = await fetchGold();
  const fxSpot = await fetchFX();

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
  const unitUSD = unitGoldG * (goldTWAP / GOLD_G_PER_OZ);

  return { goldTWAP, unitGoldG, unitUSD, fxTWAP };
}

/* ================= ROUTES ================= */

app.get("/latest.json", async (_, res) => {
  try {
    const d = await computeUnit();
    const ts = Date.now();
    const tsSec = Math.floor(ts / 1000);

    Object.keys(candles).forEach(tf => {
      const t = candleTime(tsSec, tf);
      const arr = candles[tf];

      if (!arr.length || arr[arr.length - 1].time !== t) {
        arr.push({
          time: t,
          open: d.unitUSD,
          high: d.unitUSD,
          low: d.unitUSD,
          close: d.unitUSD
        });
        if (arr.length > 1000) arr.shift();
      } else {
        const c = arr[arr.length - 1];
        c.high = Math.max(c.high, d.unitUSD);
        c.low = Math.min(c.low, d.unitUSD);
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

app.get("/ohlc", (req, res) => {
  const tf = parseInt(req.query.timeframe || "1");
  const limit = parseInt(req.query.limit || "1000");
  candles[tf] ||= [];
  res.json(candles[tf].slice(-limit));
});

/* ================= START ================= */

app.listen(PORT, () =>
  console.log(`BRICS Unit Basket v1 running on port ${PORT}`)
);
