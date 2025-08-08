#!/usr/bin/env node
"use strict";

/**
 * scripts/price.js
 * - Legge data/burn.json (totalUi)
 * - Prende il prezzo USD del mint BUMPER da Jupiter (v4 + vsToken=USDC)
 * - Scrive data/price.json con:
 *   {
 *     mint, priceUsd, burnTotalTokens, burnTotalUsd, updatedAt
 *   }
 *
 * Node 18+ (fetch built-in), nessuna dipendenza.
 */

const fs = require("fs");
const path = require("path");

const BUMPER_MINT = "5bp5PwTyu4i1hGyQsRwRYqiR2CmxyHt2cPJGEbXEbonk";

// ---- helpers ----
async function fetchJson(url) {
  const r = await fetch(url, { headers: { "accept": "application/json" } });
  if (!r.ok) throw new Error(`HTTP ${r.status} ${r.statusText} for ${url}`);
  return r.json();
}

// Jupiter v4 + vsToken=USDC (come nel tuo esempio bash)
// con retry semplice in caso di flakiness
async function getJupiterPriceUsd(mint, retries = 3) {
  const url = `https://price.jup.ag/v4/price?ids=${encodeURIComponent(mint)}&vsToken=USDC`;

  for (let i = 0; i < retries; i++) {
    try {
      const data = await fetchJson(url);
      if (data && data.data) {
        if (data.data[mint]?.price != null) {
          return Number(data.data[mint].price);
        }
        // fallback: se la chiave non è esattamente il mint ma c'è 1 solo item
        const keys = Object.keys(data.data);
        if (keys.length === 1 && data.data[keys[0]]?.price != null) {
          return Number(data.data[keys[0]].price);
        }
      }
      throw new Error("Struttura risposta Jupiter inattesa");
    } catch (err) {
      if (i === retries - 1) throw err;
      await new Promise(r => setTimeout(r, 1000 * (i + 1))); // backoff 1s,2s,...
    }
  }
}

function readBurnJson() {
  const burnPath = path.join(process.cwd(), "data", "burn.json");
  if (!fs.existsSync(burnPath)) {
    throw new Error("data/burn.json non trovato. Esegui prima scripts/burn.js");
  }
  const raw = fs.readFileSync(burnPath, "utf8");
  const j = JSON.parse(raw);
  const totalUi = parseFloat(j.totalUi || "0");
  if (!isFinite(totalUi)) throw new Error("totalUi non numerico in data/burn.json");
  return totalUi;
}

function writePriceJson(payload) {
  const outDir = path.join(process.cwd(), "data");
  const outPath = path.join(outDir, "price.json");
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(payload, null, 2));
  return outPath;
}

// ---- main ----
(async () => {
  const burnTotalTokens = readBurnJson();          // numero
  const priceUsd = await getJupiterPriceUsd(BUMPER_MINT); // numero
  const burnTotalUsd = burnTotalTokens * priceUsd;

  const out = {
    mint: BUMPER_MINT,
    priceUsd,
    burnTotalTokens,
    burnTotalUsd,
    updatedAt: new Date().toISOString(),
  };

  const outPath = writePriceJson(out);
  console.log(`Prezzo BUMPER (USD): ${priceUsd}`);
  console.log(`Totale bruciato (token): ${burnTotalTokens}`);
  console.log(`Totale bruciato (USD): ${burnTotalUsd}`);
  console.log(`Salvato: ${path.relative(process.cwd(), outPath)}`);
})().catch((e) => {
  console.error("Errore:", e.message);
  process.exit(1);
});
