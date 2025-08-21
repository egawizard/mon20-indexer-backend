import express from "express";
import cors from "cors";
import sqlite3pkg from "sqlite3";
import { ethers } from "ethers";

const sqlite3 = sqlite3pkg.verbose();
const app = express();
app.use(cors());
app.use(express.json());

// ---------------- CONFIG ----------------
const PORT = process.env.PORT || 8080;

// MON-20 constants
const START_BLOCK = 32111409;          // blok deploy pertama kamu
const BATCH_SIZE  = 50;                // kecilin biar aman dari rate-limit
const TICK        = "MONS";
const MINT_AMT    = 1000;

// RPC rotation untuk tahan rate-limit
const RPCS = [
  "https://rpc.ankr.com/monad_testnet",
  "https://testnet-rpc.monad.xyz"
];
let rpcIndex = 0;
let provider = new ethers.JsonRpcProvider(RPCS[rpcIndex]);

function switchRPC(reason = "") {
  rpcIndex = (rpcIndex + 1) % RPCS.length;
  provider = new ethers.JsonRpcProvider(RPCS[rpcIndex]);
  console.log(`🔄 Switched RPC to ${RPCS[rpcIndex]}${reason ? ` (${reason})` : ""}`);
}

// ---------------- SQLITE3 (tanpa 'sqlite') ----------------
const db = new sqlite3.Database("./db.sqlite");

// Helpers promisified
const runAsync = (sql, params = []) =>
  new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve(this);
    });
  });

const getAsync = (sql, params = []) =>
  new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });

const allAsync = (sql, params = []) =>
  new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });

// ---------------- INIT DB ----------------
async function initDB() {
  await runAsync(`
    CREATE TABLE IF NOT EXISTS stats (
      id INTEGER PRIMARY KEY,
      totalMinted INTEGER DEFAULT 0,
      mintCount  INTEGER DEFAULT 0,
      lastBlock  INTEGER DEFAULT ${START_BLOCK}
    );
  `);

  await runAsync(`
    CREATE TABLE IF NOT EXISTS holders (
      address TEXT PRIMARY KEY,
      balance INTEGER DEFAULT 0
    );
  `);

  const s = await getAsync(`SELECT 1 FROM stats WHERE id = 1`);
  if (!s) {
    await runAsync(
      `INSERT INTO stats (id, totalMinted, mintCount, lastBlock) VALUES (1, 0, 0, ?)`,
      [START_BLOCK]
    );
  }
}

// ---------------- UTIL JSON-RPC (aman untuk tx lengkap) ----------------
function toBlockTag(n) {
  // pastikan tanpa leading zero -> "0x" + hex tanpa padding
  return "0x" + n.toString(16);
}
async function getBlockWithTxs(blockNumber) {
  // pakai raw call agar pasti dapat transaksi lengkap
  return await provider.send("eth_getBlockByNumber", [toBlockTag(blockNumber), true]);
}

// ---------------- INDEXER ----------------
async function mainLoop() {
  while (true) {
    try {
      const stats = await getAsync(`SELECT * FROM stats WHERE id = 1`);
      let fromBlock = stats ? stats.lastBlock : START_BLOCK;
      const latestBlock = await provider.getBlockNumber();

      if (fromBlock >= latestBlock) {
        // idle supaya hemat RPC
        await sleep(5000);
        continue;
      }

      const toBlock = Math.min(fromBlock + BATCH_SIZE, latestBlock);
      console.log(`📡 Syncing from ${fromBlock} to ${toBlock}`);

      for (let b = fromBlock; b <= toBlock; b++) {
        try {
          const block = await getBlockWithTxs(b);
          if (!block || !Array.isArray(block.transactions)) {
            // simpan progress meski block kosong
            await runAsync(`UPDATE stats SET lastBlock = ? WHERE id = 1`, [b]);
            continue;
          }

          for (const tx of block.transactions) {
            // filter basic
            if (!tx.input || tx.input === "0x") continue;
            if (!tx.from || !tx.to) continue;
            if (tx.from.toLowerCase() !== tx.to.toLowerCase()) continue; // self-transfer only

            // decode & parse JSON
            const hex = tx.input.startsWith("0x") ? tx.input.slice(2) : tx.input;
            let utf8 = "";
            for (let i = 0; i < hex.length; i += 2) {
              utf8 += String.fromCharCode(parseInt(hex.substr(i, 2), 16) || 0);
            }

            try {
              const j = JSON.parse(utf8);

              const p   = (j.p  || j.P  || "").toString();
              const op  = (j.op || j.OP || "").toString();
              const tick= (j.tick||j.TICK||"").toString();
              const amt = (j.amt||j.AMT||"").toString();

              // ignore deploy (supply fixed)
              if (p.toUpperCase() === "MON-20" && op.toLowerCase() === "deploy") {
                // just move lastBlock forward below
              }

              // mint valid
              if (p.toUpperCase() === "MON-20" && op.toLowerCase() === "mint" && tick === TICK && amt === String(MINT_AMT)) {
                await runAsync(
                  `INSERT INTO holders (address, balance)
                   VALUES (?, ?)
                   ON CONFLICT(address) DO UPDATE SET balance = balance + ?`,
                  [tx.from.toLowerCase(), MINT_AMT, MINT_AMT]
                );
                await runAsync(
                  `UPDATE stats
                     SET totalMinted = totalMinted + ?, mintCount = mintCount + 1, lastBlock = ?
                   WHERE id = 1`,
                  [MINT_AMT, b]
                );
                console.log(`✅ Mint: ${tx.from} +${MINT_AMT} @${b}`);
              }
            } catch {
              // skip tx yang bukan JSON valid
            }
          }

          // simpan progress minimal
          await runAsync(`UPDATE stats SET lastBlock = ? WHERE id = 1`, [b]);

        } catch (err) {
          const msg = (err && err.message) || String(err);
          if (msg.includes("Too many requests") || msg.includes("rate limit")) {
            console.log("⚠️ Rate-limited. Throttling 10s & rotate RPC…");
            switchRPC("rate-limit");
            await sleep(10000);
            break; // keluar batch, re-loop
          } else if (msg.includes("Invalid params") || msg.includes("403")) {
            console.log("⚠️ RPC rejected call. Rotate RPC & delay 5s…");
            switchRPC("invalid-params/403");
            await sleep(5000);
            break;
          } else {
            console.log(`Block error ${b}: ${msg}`);
            // backoff ringan
            await sleep(1000);
          }
        }
      }

      // throttle antar batch untuk aman
      await sleep(1500);

    } catch (e) {
      console.log("Main loop error:", e?.message || e);
      switchRPC("loop-error");
      await sleep(5000);
    }
  }
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ---------------- API ----------------
app.get("/", (req, res) => res.send("OK"));
app.get("/stats", async (req, res) => {
  try {
    const s = await getAsync(`SELECT * FROM stats WHERE id = 1`);
    res.json(s || { totalMinted: 0, mintCount: 0, lastBlock: START_BLOCK });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/holders", async (req, res) => {
  try {
    const holders = await allAsync(
      `SELECT address, balance FROM holders ORDER BY balance DESC LIMIT 100`
    );
    res.json(holders);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------------- STARTUP ----------------
(async () => {
  await initDB();
  app.listen(PORT, () => {
    console.log(`🚀 API running on :${PORT} — using RPC ${RPCS[rpcIndex]}`);
  });
  mainLoop();
})();

// supaya tidak mati gara2 promise unhandled
process.on("unhandledRejection", (r) => {
  console.error("UNHANDLED", r);
});
