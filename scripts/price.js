#!/usr/bin/env node
"use strict";

/**
 * scripts/price.js
 * - Legge data/burn.json -> totalUi
 * - Prende il prezzo USD di BUMPER da Jupiter (v4 + vsToken=USDC, fallback v6/curl)
 * - Scrive data/price.json:
 *   { mint, priceUsd, burnTotalTokens, burnTotalUsd, updatedAt }
 */

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const BUMPER_MINT = "5bp5PwTyu4i1hGyQsRwRYqiR2CmxyHt2cPJGEbXEbonk";

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// --- Lettura burn.json con retry (evita JSON troncati) ---
async function readBurnTotalUiWithRetry(file, attempts = 8, delayMs = 250) {
  for (let i = 0; i < attempts; i++) {
    try {
      const raw = fs.readFileSync(file, "utf8");
      if (!raw || raw.trim().length === 0) throw new Error("file vuoto");
      const j = JSON.parse(raw);
      const totalUi = parseFloat(j.totalUi || "0");
      if (!isFinite(totalUi)) throw new Error("totalUi non numerico");
      return totalUi;
    } catch (e) {
      if (i === attempts - 1) throw new Error(`Errore burn.json: ${e.message}`);
      await sleep(delayMs);
    }
  }
}

// --- HTTP helpers ---
const HEADERS = { "accept": "application/json", "user-agent": "BumperBurnBot/1.0 (+https://github.com/)" };

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
      await sleep(Math.min(1000 * Math.pow(2, i), 8000)); // 1s,2s,4s,8s,8s
    }
  }
  throw lastErr || new Error("fetch failed");
}

function curlJson(url, timeoutSec = 10) {
  const args = ["-sS", "--max-time", String(timeoutSec), "-H", "accept: application/json", url];
  const out = spawnSync("curl", args, { encoding: "utf8" });
  if (out.status !== 0) throw new Error(`curl failed: ${out.stderr || out.stdout || "unknown error"}`);
  return JSON.parse(out.stdout);
}

function parseJupiterPrice(data, mint) {
  if (!data || typeof data !== "object" || !data.data) return null;
  if (data.data[mint]?.price != null) return Number(data.data[mint].price);
  const keys = Object.keys(data.data);
  if (keys.length === 1 && data.data[keys[0]]?.price != null) return Number(data.data[keys[0]].price);
  return null;
}

async function getJupiterPriceUsd(mint) {
  const urls = [
    `https://price.jup.ag/v4/price?ids=${encodeURIComponent(mint)}&vsToken=USDC`,
    `https://price.jup.ag/v6/price?ids=${encodeURIComponent(mint)}`
  ];

  // fetch con retry
  for (const url of urls) {
    try {
      const j = await fetchJsonWithRetries(url, { retries: 5, timeoutMs: 10000 });
      const price = parseJupiterPrice(j, mint);
      if (price != null && isFinite(price)) return price;
    } catch (_) {}
  }

  // fallback curl
  for (const url of urls) {
    try {
      const j = curlJson(url, 10);
      const price = parseJupiterPrice(j, mint);
      if (price != null && isFinite(price)) return price;
    } catch (_) {}
  }

  throw new Error("Prezzo Jupiter non disponibile.");
}

// --- scrittura atomica (coerente con burn.js) ---
function writeJsonAtomic(outPath, obj) {
  const tmpPath = outPath + ".tmp";
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(tmpPath, JSON.stringify(obj, null, 2));
  fs.renameSync(tmpPath, outPath);
}

(async () => {
  const burnPath = path.join(process.cwd(), "data", "burn.json");
  const burnTotalTokens = await readBurnTotalUiWithRetry(burnPath);

  let priceUsd;
  try {
    priceUsd = await getJupiterPriceUsd(BUMPER_MINT);
  } catch (e) {
    // ultimo fallback: riusa l'ultimo prezzo salvato, se esiste
    const prevPath = path.join(process.cwd(), "data", "price.json");
    if (fs.existsSync(prevPath)) {
      const prev = JSON.parse(fs.readFileSync(prevPath, "utf8"));
      if (prev && typeof prev.priceUsd === "number" && isFinite(prev.priceUsd)) {
        priceUsd = prev.priceUsd;
        console.warn("WARN: Jupiter non raggiungibile, riuso ultimo prezzo:", priceUsd);
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

  const outPath = path.join(process.cwd(), "data", "price.json");
  writeJsonAtomic(outPath, out);

  console.log(`Prezzo BUMPER (USD): ${priceUsd}`);
  console.log(`Totale bruciato (token): ${burnTotalTokens}`);
  console.log(`Totale bruciato (USD): ${burnTotalUsd}`);
  console.log(`Salvato: ${path.relative(process.cwd(), outPath)}`);
})().catch((e) => {
  console.error("Errore:", e.message);
  process.exit(1);
});
