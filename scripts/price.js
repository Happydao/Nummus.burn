#!/usr/bin/env node
"use strict";

/**
 * scripts/price.js
 * - Legge data/burn.json (totalUi)
 * - Prende il prezzo USD del mint BUMPER da Jupiter
 *   (prima v4 + vsToken=USDC, poi fallback v6)
 * - Retry con backoff + fallback a `curl` se `fetch` fallisce
 * - Scrive data/price.json con { mint, priceUsd, burnTotalTokens, burnTotalUsd, updatedAt }
 */

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const BUMPER_MINT = "5bp5PwTyu4i1hGyQsRwRYqiR2CmxyHt2cPJGEbXEbonk";

const HEADERS = {
  "accept": "application/json",
  // qualche UA evita blocchi stupidi su alcuni CDN
  "user-agent": "BumperBurnBot/1.0 (+https://github.com/)"
};

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchJsonWithRetries(url, { retries = 5, timeoutMs = 10000 } = {}) {
  let lastErr;
  for (let i = 0; i < retries; i++) {
    try {
      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(), timeoutMs);
      const res = await fetch(url, { headers: HEADERS, signal: ac.signal });
      clearTimeout(t);
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      return await res.json();
    } catch (e) {
      lastErr = e;
      const backoff = Math.min(1000 * Math.pow(2, i), 8000); // 1s,2s,4s,8s,8s
      await sleep(backoff);
    }
  }
  throw lastErr || new Error("fetch failed");
}

function curlJson(url, timeoutSec = 10) {
  const args = ["-sS", "--max-time", String(timeoutSec), "-H", "accept: application/json", url];
  const out = spawnSync("curl", args, { encoding: "utf8" });
  if (out.status !== 0) {
    throw new Error(`curl failed: ${out.stderr || out.stdout || "unknown error"}`);
  }
  try {
    return JSON.parse(out.stdout);
  } catch (e) {
    throw new Error("curl JSON parse failed");
  }
}

function parseJupiterPrice(data, mint) {
  // atteso: { data: { "<mint>|<symbol>": { price: <number> } } }
  if (!data || typeof data !== "object" || !data.data) return null;
  if (data.data[mint]?.price != null) return Number(data.data[mint].price);
  const keys = Object.keys(data.data);
  if (keys.length === 1 && data.data[keys[0]]?.price != null) {
    return Number(data.data[keys[0]].price);
  }
  return null;
}

async function getJupiterPriceUsd(mint) {
  const urls = [
    `https://price.jup.ag/v4/price?ids=${encodeURIComponent(mint)}&vsToken=USDC`,
    `https://price.jup.ag/v6/price?ids=${encodeURIComponent(mint)}`
  ];

  // 1) tenta con fetch + retry
  for (const url of urls) {
    try {
      const j = await fetchJsonWithRetries(url, { retries: 5, timeoutMs: 10000 });
      const price = parseJupiterPrice(j, mint);
      if (price != null && isFinite(price)) return price;
    } catch (_) { /* prova il prossimo url */ }
  }

  // 2) fallback con curl
  for (const url of urls) {
    try {
      const j = curlJson(url, 10);
      const price = parseJupiterPrice(j, mint);
      if (price != null && isFinite(price)) return price;
    } catch (_) { /* prova il prossimo url */ }
  }

  throw new Error("Prezzo Jupiter non disponibile (fetch/curl falliti).");
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

(async () => {
  const burnTotalTokens = readBurnJson();

  let priceUsd;
  try {
    priceUsd = await getJupiterPriceUsd(BUMPER_MINT);
  } catch (e) {
    // fallback finale: se esiste un price.json precedente, riusa quel prezzo
    const prevPath = path.join(process.cwd(), "data", "price.json");
    if (fs.existsSync(prevPath)) {
      const prev = JSON.parse(fs.readFileSync(prevPath, "utf8"));
      if (prev && typeof prev.priceUsd === "number" && isFinite(prev.priceUsd)) {
        priceUsd = prev.priceUsd;
        console.warn("WARN: Jupiter non raggiungibile, riuso ultimo prezzo salvato:", priceUsd);
      } else {
        throw e;
      }
    } else {
      throw e;
    }
  }

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
  // NON usare exit 1 qui se vuoi che il workflow continui comunque.
  process.exit(1);
});
