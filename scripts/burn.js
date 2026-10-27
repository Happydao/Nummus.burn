#!/usr/bin/env node
"use strict";

/**
 * scripts/burn.js
 * - Scansiona i burn del mint NUMMUS dal wallet burner
 * - Stampa i risultati a terminale
 * - Salva data/burn.json con:
 *   { count, totalUi, burns: [ { amountUi, url, timestamp } ] }
 */

const fs = require("fs");
const path = require("path");

// ------------ CONFIG ------------
const BURNER_ADDRESS = "5G62fW1BuK6k9B6sGwvTBtoKRPseshj9SSYPzudSPUYE";
const NUMMUS_MINT    = "9JK2U7aEkp3tWaFNuaJowWRgNys5DVaKGxWk73VT5ray";

const API_KEY = process.env.HELIUS_API_KEY || process.env.HELIUS_APY_KEY;
if (!API_KEY) {
  console.error("Errore: imposta HELIUS_API_KEY (o HELIUS_APY_KEY).");
  process.exit(1);
}

const RPC_URL = `https://mainnet.helius-rpc.com/?api-key=${API_KEY}`;

// parametri regolabili da workflow
const BATCH_LIMIT = parseInt(process.env.BATCH_LIMIT || "100", 10);
const MAX_PAGES   = parseInt(process.env.MAX_PAGES   || "20", 10);
// un po' di pausa tra le tx per ridurre 429
const SLEEP_MS    = parseInt(process.env.SLEEP_MS    || "200", 10);

// ------------ UTILS ------------
function sleep(ms) {
  return new Promise((res) => setTimeout(res, ms));
}

/**
 * RPC helper con retry + backoff.
 * Un errore definitivo interrompe la raccolta: pubblicare dati parziali
 * farebbe sparire burn già verificati.
 */
async function rpc(method, params, maxRetries = 4) {
  let lastError = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetch(RPC_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method,
          params,
        }),
      });

      // rate limit o errori temporanei → backoff e retry
      if (res.status === 429 || res.status >= 500) {
        const retryAfter = res.headers.get("retry-after");
        const retrySec = retryAfter ? parseInt(retryAfter, 10) || 0 : 0;
        const backoffSec = retrySec || Math.pow(2, attempt); // 1,2,4,8,...
        const backoffMs = Math.max(backoffSec * 1000, 1000);

        console.warn(
          `RPC ${method}: HTTP ${res.status} (tentativo ${
            attempt + 1
          }/${maxRetries + 1}) – aspetto ${backoffMs}ms`
        );
        await sleep(backoffMs);
        lastError = new Error(`HTTP ${res.status}`);
        continue;
      }

      if (!res.ok) {
        // errore non temporaneo (400, 403, ecc.)
        const msg = `RPC ${method}: HTTP ${res.status}`;
        throw new Error(msg);
      }

      const json = await res.json();
      if (json.error) {
        throw new Error(`RPC ${method} errore: ${json.error.code} ${json.error.message}`);
      }
      return json.result;
    } catch (e) {
      lastError = e;
      console.warn(
        `RPC ${method}: errore di rete (tentativo ${
          attempt + 1
        }/${maxRetries + 1}) – ${e.message || e}`
      );
      await sleep(Math.max(1000, Math.pow(2, attempt) * 1000));
    }
  }

  throw new Error(`RPC ${method} fallita dopo ${maxRetries + 1} tentativi: ${lastError?.message || lastError}`);
}

async function getDecimals(mint) {
  const res = await rpc("getTokenSupply", [mint]);
  if (!res || !res.value) {
    throw new Error(`Impossibile ottenere i decimals per ${mint}`);
  }
  return Number(res.value.decimals);
}

async function* iterSignatures(address, limit = 100, maxPages = 10) {
  let before;

  for (let page = 0; page < maxPages; page++) {
    const params = [address, { limit }];
    if (before) params[1].before = before;

    const out = await rpc("getSignaturesForAddress", params);
    if (!out || out.length === 0) {
      return;
    }

    for (const item of out) {
      if (item.err === null) {
        yield item.signature; // solo tx riuscite
      }
    }

    before = out[out.length - 1].signature;

    // leggero delay tra le pagine
    await sleep(SLEEP_MS);
  }
}

function normalizeRawAmount(raw, fromDecimals, toDecimals) {
  if (fromDecimals === toDecimals) return raw;
  if (fromDecimals < toDecimals) {
    return raw * (10n ** BigInt(toDecimals - fromDecimals));
  }
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

      if (info.amount !== undefined) {
        rawStr = String(info.amount);
      }

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
        } catch {
          // ignora parse error
        }
      }
    }
  };

  // istruzioni "normali"
  scan(tx?.transaction?.message?.instructions);

  // inner instructions
  const inner = tx?.meta?.innerInstructions;
  if (Array.isArray(inner)) {
    for (const set of inner) {
      scan(set?.instructions);
    }
  }

  return burns;
}

function writeJsonAtomic(outPath, obj) {
  const tmpPath = outPath + ".tmp";
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(tmpPath, JSON.stringify(obj, null, 2));
  fs.renameSync(tmpPath, outPath);
}

// ------------ MAIN ------------
(async () => {
  const mintDecimals = await getDecimals(NUMMUS_MINT);

  let totalRaw = 0n;
  const result = { count: 0, totalUi: "0", burns: [] };

  for await (const sig of iterSignatures(BURNER_ADDRESS, BATCH_LIMIT, MAX_PAGES)) {
    const tx = await rpc("getTransaction", [
      sig,
      {
        encoding: "jsonParsed",
        maxSupportedTransactionVersion: 0,
        commitment: "confirmed",
      },
    ]);

    if (!tx) throw new Error(`Impossibile leggere tx ${sig}`);

    const burns = findBurnEvents(tx, NUMMUS_MINT, mintDecimals);
    for (const b of burns) {
      totalRaw += b.raw;
      result.count += 1;
      const amountUi = bigIntToDecimalString(b.raw, mintDecimals);
      const url = `https://solscan.io/tx/${sig}`;
      const timestamp = Number.isFinite(tx.blockTime)
        ? new Date(tx.blockTime * 1000).toISOString()
        : null;

      result.burns.push({ amountUi, url, timestamp });
      console.log(`${amountUi} NUMMUS  |  ${url}`);
    }

    // pausa tra le getTransaction per ridurre il rate limit
    await sleep(SLEEP_MS);
  }

  result.totalUi = bigIntToDecimalString(totalRaw, mintDecimals);

  console.log("-".repeat(80));
  if (result.count > 0) {
    console.log(
      `Totale burn trovato: ${result.totalUi} NUMMUS in ${result.count} transazioni`
    );
  } else {
    console.log("Nessun burn NUMMUS trovato nelle transazioni scansionate.");
  }

  const outPath = path.join(process.cwd(), "data", "burn.json");
  if (fs.existsSync(outPath)) {
    const previous = JSON.parse(fs.readFileSync(outPath, "utf8"));
    const currentUrls = new Set(result.burns.map((burn) => burn.url));
    const missing = (previous.burns || []).filter((burn) => !currentUrls.has(burn.url));
    if (missing.length) {
      throw new Error(`Raccolta incompleta: mancano ${missing.length} burn già pubblicati`);
    }
  }
  writeJsonAtomic(outPath, result);
  console.log(`Salvato: ${path.relative(process.cwd(), outPath)}`);
})().catch((e) => {
  console.error("Errore in burn.js:", e.message || e);
  process.exitCode = 1;
});
