#!/usr/bin/env node
"use strict";

/**
 * scripts/price.js
 * - Prezzo USD di BUMPER da DexScreener (sceglie il pair con più liquidità)
 * - Total supply via Helius getTokenSupply
 * - Legge data/burn.json -> totalUi e calcola burnTotalUsd = priceUsd * totalUi
 * - Scrive atomicamente data/price.json:
 *   {
 *     mint, priceUsd,
 *     totalSupplyTokens, totalSupplyTokensNum, supplyRaw, decimals,
 *     burnTotalTokens, burnTotalUsd,
 *     updatedAt
 *   }
 */

const fs = require("fs");
const path = require("path");

const BUMPER_MINT = "5bp5PwTyu4i1hGyQsRwRYqiR2CmxyHt2cPJGEbXEbonk";

const API_KEY = process.env.HELIUS_API_KEY || process.env.HELIUS_APY_KEY;
if (!API_KEY) {
  console.error("Errore: devi impostare HELIUS_API_KEY (o HELIUS_APY_KEY).");
  process.exit(1);
}
const RPC_URL = `https://mainnet.helius-rpc.com/?api-key=${API_KEY}`;

/* ---------- Utils ---------- */
function writeJsonAtomic(outPath, obj) {
  const tmp = outPath + ".tmp";
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, outPath);
}

async function fetchJson(url, { timeoutMs = 10000 } = {}) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  const res = await fetch(url, {
    headers: { "accept": "application/json", "user-agent": "BumperBurnBot/1.0 (+https://github.com/)" },
    signal: ac.signal
  });
  clearTimeout(t);
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  return res.json();
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/* ---------- Prezzo: DexScreener ---------- */
function pickBestPair(pairs) {
  if (!Array.isArray(pairs) || pairs.length === 0) return null;
  let best = null, bestLiq = -1;
  for (const p of pairs) {
    const liq = p?.liquidity?.usd ?? p?.liquidityUsd ?? 0;
    const v = Number(liq) || 0;
    if (v > bestLiq) { bestLiq = v; best = p; }
  }
  return best;
}

async function getPriceFromDexScreener(mint) {
  const url = `https://api.dexscreener.com/latest/dex/tokens/${encodeURIComponent(mint)}`;
  const j = await fetchJson(url, { timeoutMs: 10000 });
  const best = pickBestPair(j?.pairs);
  if (!best) return 0;
  const price = Number(best.priceUsd ?? best.price?.usd ?? 0);
  return Number.isFinite(price) ? price : 0;
}

/* ---------- Supply: Helius ---------- */
async function heliusRpc(method, params) {
  const res = await fetch(RPC_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })
  });
  if (!res.ok) throw new Error(`RPC HTTP ${res.status}`);
  const j = await res.json();
  if (j.error) throw new Error(`RPC ${j.error.code}: ${j.error.message}`);
  return j.result;
}

function bigIntToDecimalString(rawStr, decimals) {
  const raw = BigInt(rawStr);
  const base = 10n ** BigInt(decimals);
  const intPart = raw / base;
  const fracPart = raw % base;
  let s = intPart.toString();
  if (decimals > 0) {
    let frac = fracPart.toString().padStart(decimals, "0").replace(/0+$/, "");
    if (frac.length) s += `.${frac}`;
  }
  return s;
}

async function getTotalSupply(mint) {
  const res = await heliusRpc("getTokenSupply", [mint]);
  const amount = res?.value?.amount;
  const decimals = res?.value?.decimals;
  if (amount == null || decimals == null) throw new Error("Risposta inattesa da getTokenSupply");
  const uiStr = bigIntToDecimalString(amount, Number(decimals)); // string precisa
  const uiNum = Number.parseFloat(uiStr);                         // numero per grafici/UI
  return { supplyRaw: String(amount), decimals: Number(decimals), supplyUiStr: uiStr, supplyUiNum: uiNum };
}

/* ---------- Lettura burn.json con retry ---------- */
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
      if (i === attempts - 1) {
        console.warn("WARN:", e.message, "- userò 0 per burnTotalTokens");
        return 0;
      }
      await sleep(delayMs);
    }
  }
  return 0;
}

/* ---------- Main ---------- */
(async () => {
  // 1) prezzo USD
  const priceUsd = await getPriceFromDexScreener(BUMPER_MINT);

  // 2) supply totale
  const supply = await getTotalSupply(BUMPER_MINT);

  // 3) totale bruciato in token (dal file data/burn.json)
  const burnJsonPath = path.join(process.cwd(), "data", "burn.json");
  const burnTotalTokens = await readBurnTotalUiWithRetry(burnJsonPath); // numero

  // 4) valore USD bruciato
  const burnTotalUsd = burnTotalTokens * priceUsd;

  // 5) scrivi output
  const payload = {
    mint: BUMPER_MINT,
    priceUsd,
    totalSupplyTokens: supply.supplyUiStr,
    totalSupplyTokensNum: supply.supplyUiNum,
    supplyRaw: supply.supplyRaw,
    decimals: supply.decimals,
    burnTotalTokens,   // <-- letto da burn.json (totalUi)
    burnTotalUsd,      // <-- nuovo campo richiesto
    updatedAt: new Date().toISOString()
  };

  const outPath = path.join(process.cwd(), "data", "price.json");
  writeJsonAtomic(outPath, payload);

  console.log(`Prezzo USD BUMPER (DexScreener): ${priceUsd}`);
  console.log(`Total supply (tokens): ${supply.supplyUiStr}`);
  console.log(`Totale bruciato (token): ${burnTotalTokens}`);
  console.log(`Valore bruciato (USD): ${burnTotalUsd}`);
  console.log(`Salvato: ${path.relative(process.cwd(), outPath)}`);
})().catch((e) => {
  console.error("Errore:", e.message);
  process.exit(1);
});
