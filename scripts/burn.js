#!/usr/bin/env node
"use strict";

/**
 * scripts/burn.js
 * - Scansiona i burn del mint NUMMUS dal wallet burner
 * - Stampa i risultati a terminale
 * - Salva data/burn.json con:
 *   { count, totalUi, burns: [ { amountUi, url } ] }
 */

const fs = require("fs");
const path = require("path");

const BURNER_ADDRESS = "5G62fW1BuK6k9B6sGwvTBtoKRPseshj9SSYPzudSPUYE";
const NUMMUS_MINT    = "9JK2U7aEkp3tWaFNuaJowWRgNys5DVaKGxWk73VT5ray";

const API_KEY = process.env.HELIUS_API_KEY || process.env.HELIUS_APY_KEY;
if (!API_KEY) {
  console.error("Errore: imposta HELIUS_API_KEY (o HELIUS_APY_KEY).");
  process.exit(1);
}

const RPC_URL = `https://mainnet.helius-rpc.com/?api-key=${API_KEY}`;

const BATCH_LIMIT = parseInt(process.env.BATCH_LIMIT || "100", 10);
const MAX_PAGES   = parseInt(process.env.MAX_PAGES   || "20", 10);
const SLEEP_MS    = parseInt(process.env.SLEEP_MS    || "120", 10);

function sleep(ms) { return new Promise(res => setTimeout(res, ms)); }

async function rpc(method, params) {
  const r = await fetch(RPC_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!r.ok) throw new Error(`RPC HTTP ${r.status}`);
  const j = await r.json();
  if (j.error) throw new Error(`RPC ${j.error.code}: ${j.error.message}`);
  return j.result;
}

async function getDecimals(mint) {
  const res = await rpc("getTokenSupply", [mint]);
  return Number(res.value.decimals);
}

async function* iterSignatures(address, limit = 100, maxPages = 10) {
  let before;
  for (let page = 0; page < maxPages; page++) {
    const params = [address, { limit }];
    if (before) params[1].before = before;
    const out = await rpc("getSignaturesForAddress", params);
    if (!out || out.length === 0) return;
    for (const item of out) {
      if (item.err === null) yield item.signature; // solo tx riuscite
    }
    before = out[out.length - 1].signature;
  }
}

function normalizeRawAmount(raw, fromDecimals, toDecimals) {
  if (fromDecimals === toDecimals) return raw;
  if (fromDecimals < toDecimals) return raw * (10n ** BigInt(toDecimals - fromDecimals));
  return raw / (10n ** BigInt(fromDecimals - toDecimals));
}

function bigIntToDecimalString(raw, decimals) {
  const neg = raw < 0n;
  const v = neg ? -raw : raw;
  const base = 10n ** BigInt(decimals);
  const intPart = v / base;
  const fracPart = v % base;
  let s = intPart.toString();
  if (decimals > 0) {
    let frac = fracPart.toString().padStart(decimals, "0").replace(/0+$/, "");
    if (frac.length) s += `.${frac}`;
  }
  return neg ? `-${s}` : s;
}

function findBurnEvents(tx, mint, mintDecimals) {
  const burns = [];

  const scan = (ixs) => {
    if (!Array.isArray(ixs)) return;
    for (const ix of ixs) {
      const parsed = ix?.parsed;
      if (!parsed || typeof parsed !== "object") continue;
      const type = parsed.type;
      if (type !== "burn" && type !== "burnChecked") continue;

      const info = parsed.info || {};
      if (info.mint !== mint) continue;

      let rawStr = null;
      let decimals = mintDecimals;

      if (info.amount !== undefined) rawStr = String(info.amount);
      if (info.tokenAmount?.amount !== undefined) {
        rawStr = String(info.tokenAmount.amount);
        if (info.tokenAmount.decimals !== undefined) {
          decimals = Number(info.tokenAmount.decimals);
        }
      }

      if (rawStr != null) {
        try {
          let raw = BigInt(rawStr);
          raw = normalizeRawAmount(raw, decimals, mintDecimals);
          burns.push({ raw });
        } catch { /* ignore */ }
      }
    }
  };

  scan(tx?.transaction?.message?.instructions);
  const inner = tx?.meta?.innerInstructions;
  if (Array.isArray(inner)) for (const set of inner) scan(set?.instructions);

  return burns;
}

function writeJsonAtomic(outPath, obj) {
  const tmpPath = outPath + ".tmp";
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(tmpPath, JSON.stringify(obj, null, 2));
  fs.renameSync(tmpPath, outPath);
}

(async () => {
  const mintDecimals = await getDecimals(NUMMUS_MINT);
  let totalRaw = 0n;
  const result = { count: 0, totalUi: "0", burns: [] };

  for await (const sig of iterSignatures(BURNER_ADDRESS, BATCH_LIMIT, MAX_PAGES)) {
    const tx = await rpc("getTransaction", [sig, {
      encoding: "jsonParsed",
      maxSupportedTransactionVersion: 0,
      commitment: "confirmed",
    }]);
    if (!tx) continue;

    const burns = findBurnEvents(tx, NUMMUS_MINT, mintDecimals);
    for (const b of burns) {
      totalRaw += b.raw;
      result.count += 1;
      result.burns.push({
        amountUi: bigIntToDecimalString(b.raw, mintDecimals),
        url: `https://solscan.io/tx/${sig}`,
      });
      console.log(`${bigIntToDecimalString(b.raw, mintDecimals)} NUMMUS  |  https://solscan.io/tx/${sig}`);
    }

    await sleep(SLEEP_MS);
  }

  result.totalUi = bigIntToDecimalString(totalRaw, mintDecimals);

  if (result.count > 0) {
    console.log("-".repeat(80));
    console.log(`Totale burn trovato: ${result.totalUi} NUMMUS in ${result.count} transazioni`);
  } else {
    console.log("Nessun burn NUMMUS trovato nelle transazioni scansionate.");
  }

  const outPath = path.join(process.cwd(), "data", "burn.json");
  writeJsonAtomic(outPath, result);
  console.log(`Salvato: ${path.relative(process.cwd(), outPath)}`);
})().catch((e) => {
  console.error("Errore:", e.message);
  process.exit(1);
});
