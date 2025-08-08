#!/usr/bin/env node
"use strict";

/**
 * scripts/price.js
 * - Legge data/burn.json (totalUi)
 * - Prende il prezzo USD del mint BUMPER da Jupiter
 * - Scrive data/price.json con { priceUsd, burnTotalTokens, burnTotalUsd, updatedAt }
 */

const fs = require("fs");
const path = require("path");

// Stesso mint del token BUMPER usato nello script burn.js
const BUMPER_MINT = "5bp5PwTyu4i1hGyQsRwRYqiR2CmxyHt2cPJGEbXEbonk";

// ------- Helpers -------
async function fetchJson(url) {
  const r = await fetch(url, { headers: { "accept": "application/json" } });
  if (!r.ok) throw new Error(`HTTP ${r.status} ${r.statusText} for ${url}`);
  return r.json();
}

/**
 * Prova a prendere il prezzo da Jupiter. Tenta v6 e poi v4.
 * Ritorna un Number (USD).
 */
async function getJupiterPriceUsd(mint) {
  const tryUrls = [
    `https://price.jup.ag/v6/price?ids=${encodeURIComponent(mint)}`,
    `https://price.jup.ag/v4/price?ids=${encodeURIComponent(mint)}`
  ];

  for (const url of tryUrls) {
    try {
      const data = await fetchJson(url);
      // Struttura attesa: { data: { "<key>": { price: <number>, ... } } }
      if (data && data.data && typeof data.data === "object") {
        // prova la chiave col mint
        if (data.data[mint]?.price != null) return Number(data.data[mint].price);

        // altrimenti, se c'è una sola chiave, prendila
        const keys = Object.keys(data.data);
        if (keys.length === 1 && data.data[keys[0]]?.price != null) {
          return Number(data.data[keys[0]].price);
        }
      }
    } catch (e) {
      // passa al prossimo url
    }
  }
  throw new Error("Prezzo Jupiter non disponibile per il mint specificato.");
}

function readBurnJson() {
  const burnPath = path.join(process.cwd(), "data", "burn.json");
  if (!fs.existsSync(burnPath)) {
    throw new Error("data/burn.json non trovato. Esegui prima scripts/burn.js");
  }
  const raw = fs.readFileSync(burnPath, "utf8");
  const j = JSON.parse(raw);
  // totalUi è una string; convertiamo a Number (va bene per dashboard/hype)
  const totalUi = Number(j.totalUi || 0);
  return { totalUi, rawObject: j };
}

function writePriceJson(payload) {
  const outDir = path.join(process.cwd(), "data");
  const outPath = path.join(outDir, "price.json");
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(payload, null, 2));
  return outPath;
}

// ------- Main -------
(async () => {
  const { totalUi } = readBurnJson();
  const priceUsd = await getJupiterPriceUsd(BUMPER_MINT);

  const burnTotalUsd = totalUi * priceUsd;

  const out = {
    mint: BUMPER_MINT,
    priceUsd,                 // prezzo attuale 1 BUMPER in USD
    burnTotalTokens: totalUi, // alias di totalUi
    burnTotalUsd: burnTotalUsd, // totale USD bruciato
    updatedAt: new Date().toISOString()
  };

  const outPath = writePriceJson(out);

  console.log(`Prezzo BUMPER (USD): ${priceUsd}`);
  console.log(`Totale bruciato (token): ${totalUi}`);
  console.log(`Totale bruciato (USD): ${burnTotalUsd}`);
  console.log(`Salvato: ${path.relative(process.cwd(), outPath)}`);
})().catch((e) => {
  console.error("Errore:", e.message);
  process.exit(1);
});

