#!/usr/bin/env node
"use strict";

/**
 * scripts/burn.js
 * - Scansiona i burn del mint BUMPER fatti dal wallet burner
 * - Salva i risultati in data/burn.json con:
 *   { count, totalUi, burns: [ { amountUi, url } ] }
 *
 * Env:
 *   HELIUS_API_KEY  (supporta anche HELIUS_APY_KEY per compatibilità col tuo .env)
 * Opzionale:
 *   BATCH_LIMIT (default 100), MAX_PAGES (default 20), SLEEP_MS (default 120 ms)
 */

const BURNER_ADDRESS = "5G62fW1BuK6k9B6sGwvTBtoKRPseshj9SSYPzudSPUYE";
const BUMPER_MINT    = "5bp5PwTyu4i1hGyQsRwRYqiR2CmxyHt2cPJGEbXEbonk";

const API_KEY = process.env.HELIUS_API_KEY || process.env.HELIUS_APY_KEY;
if (!API_KEY) {
  console.error("Errore: imposta HELIUS_API_KEY (o HELIUS_APY_KEY) nell'ambiente.");
  process.exit(1);
}

const RPC_URL = `https://mainnet.helius-rpc.com/?api-key=${API_KEY}`;

const BATCH_LIMIT = parseInt(process.env.BATCH_LIMIT || "100", 10);
const MAX_PAGES   = parseInt(process.env.MAX_PAGES   || "20", 10);
const SLEEP_MS    = parseInt(process.env.SLEEP_MS    || "120", 10);

const fs   = require("fs");
const path = require("path");

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
  if (fromDecimals < toDecimals) {
    return raw * (10n ** BigInt(toDecimals - fromDecimals));
  } else {
    return raw / (10n ** BigInt(fromDecimals - toDecimals));
  }
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

  // istruzioni top-level
  scan(tx?.transaction?.message?.instructions);
  // inner instructions
  const inner = tx?.meta?.innerInstructions;
  if (Array.isArray(inner)) for (const set of inner) scan(set?.instructions);

  return burns;
}

(async () => {
  const mintDecimals = await getDecimals(BUMPER_MINT);
  let totalRaw = 0n;
  const result = { count: 0, totalUi: "0", burns: [] };

  for await (const sig of iterSignatures(BURNER_ADDRESS, BATCH_LIMIT, MAX_PAGES)) {
    const tx = await rpc("getTransaction", [sig, {
      encoding: "jsonParsed",
      maxSupportedTransactionVersion: 0,
      commitment: "confirmed",
    }]);
    if (!tx) continue;

    const burns = findBurnEvents(tx, BUMPER_MINT, mintDecimals);
    for (const b of burns) {
      totalRaw += b.raw;
      result.count += 1;
      result.burns.push({
        amountUi: bigIntToDecimalString(b.raw, mintDecimals),
        url: `https://solscan.io/tx/${sig}`,
      });
    }

    await sleep(SLEEP_MS); // anti-rate-limit
  }

  result.totalUi = bigIntToDecimalString(totalRaw, mintDecimals);

  // stampa a terminale
  if (result.count === 0) {
    console.log("Nessun burn BUMPER trovato nelle transazioni scansionate.");
  } else {
    for (const row of result.burns) {
      console.log(`${row.amountUi} BUMPER  |  ${row.url}`);
    }
    console.log("-".repeat(80));
    console.log(`Totale burn trovato: ${result.totalUi} BUMPER in ${result.count} transazioni`);
  }

  // salva data/burn.json
  const outDir = path.join(process.cwd(), "data");
  const outPath = path.join(outDir, "burn.json");
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(result, null, 2));
  console.log(`Salvato: ${path.relative(process.cwd(), outPath)}`);
})().catch((e) => {
  console.error("Errore:", e.message);
  process.exit(1);
});

