import fs from "fs";
import path from "path";
import https from "https";

const URL =
  "https://cdn.jsdelivr.net/npm/lightweight-charts@5.1.0/dist/lightweight-charts.esm.production.js";

const OUT = path.join("public", "lightweight-charts.esm.js");

if (fs.existsSync(OUT)) {
  console.log("✔ lightweight-charts already present");
  process.exit(0);
}

console.log("Fetching lightweight-charts ESM…");

https.get(URL, res => {
  if (res.statusCode !== 200) {
    throw new Error("Failed to fetch lightweight-charts");
  }

  const file = fs.createWriteStream(OUT);
  res.pipe(file);

  file.on("finish", () => {
    file.close();
    console.log("✔ Saved public/lightweight-charts.esm.js");
  });
});
