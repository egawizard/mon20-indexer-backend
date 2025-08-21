import express from "express";
import cors from "cors";
import sqlite3 from "sqlite3";
import { open } from "sqlite";
import { ethers } from "ethers";

const app = express();
app.use(cors());

let db;
const START_BLOCK = 32111409;
const BATCH_SIZE = 50;

// ==== RPC LIST ====
const RPCS = [
  "https://rpc.ankr.com/monad_testnet",
  "https://testnet-rpc.monad.xyz"
];
let rpcIndex = 0;
let provider = new ethers.JsonRpcProvider(RPCS[rpcIndex]);

function switchRPC() {
  rpcIndex = (rpcIndex + 1) % RPCS.length;
  provider = new ethers.JsonRpcProvider(RPCS[rpcIndex]);
  console.log(`🔄 Switched RPC to ${RPCS[rpcIndex]}`);
}

// ==== API ROUTES ====
app.get("/stats", async (req, res) => {
  const stats = await db.get("SELECT * FROM stats WHERE id = 1");
  res.json(stats || { totalMinted: 0, mintCount: 0, lastBlock: START_BLOCK });
});

app.get("/holders", async (req, res) => {
  const holders = await db.all(
    "SELECT * FROM holders ORDER BY balance DESC LIMIT 50"
  );
  res.json(holders);
});

// ==== MAIN INDEXER LOOP ====
async function mainLoop() {
  while (true) {
    try {
      const stats = await db.get("SELECT * FROM stats WHERE id = 1");
      let fromBlock = stats ? stats.lastBlock : START_BLOCK;
      const latestBlock = await provider.getBlockNumber();

      if (fromBlock >= latestBlock) {
        console.log("✅ Up to date, waiting 5s...");
        await new Promise(r => setTimeout(r, 5000));
        continue;
      }

      const toBlock = Math.min(fromBlock + BATCH_SIZE, latestBlock);
      console.log(`📡 Syncing from ${fromBlock} to ${toBlock}`);

      for (let b = fromBlock; b <= toBlock; b++) {
        try {
          const block = await provider.getBlock(b, true);

          if (!block || !block.transactions) continue;

          for (const tx of block.transactions) {
            if (!tx.input || tx.input === "0x") continue;
            const data = Buffer.from(tx.input.slice(2), "hex").toString("utf8");

            try {
              const parsed = JSON.parse(data);

              if (parsed.p && parsed.op) {
                if (parsed.op === "mint" && parsed.tick === "MONS") {
                  await db.run(
                    `INSERT INTO holders (address, balance)
                     VALUES (?, ?)
                     ON CONFLICT(address) DO UPDATE SET balance = balance + ?`,
                    [tx.from, parseInt(parsed.amt), parseInt(parsed.amt)]
                  );
                  await db.run(
                    `UPDATE stats SET totalMinted = totalMinted + ?, mintCount = mintCount + 1, lastBlock = ? WHERE id = 1`,
                    [parseInt(parsed.amt), b]
                  );
                  console.log(`✅ Mint detected from ${tx.from} amount ${parsed.amt}`);
                }
              }
            } catch {}
          }
        } catch (err) {
          // 🔄 Handle rate limit / RPC error
          if (
            err.message.includes("rate limit") ||
            err.message.includes("Too many requests")
          ) {
            console.log("⚠️ Rate limited! Switching RPC...");
            switchRPC();
            await new Promise(r => setTimeout(r, 10000));
            break; // keluar dari batch
          } else {
            console.log(`Block error ${b}:`, err.message);
          }
        }
      }
    } catch (e) {
      console.log("Main loop error:", e.message);
      switchRPC();
      await new Promise(r => setTimeout(r, 5000));
    }
  }
}

// ==== INIT ====
async function init() {
  db = await open({
    filename: "./db.sqlite",
    driver: sqlite3.Database
  });

  await db.exec(`
    CREATE TABLE IF NOT EXISTS stats (
      id INTEGER PRIMARY KEY,
      totalMinted INTEGER DEFAULT 0,
      mintCount INTEGER DEFAULT 0,
      lastBlock INTEGER DEFAULT ${START_BLOCK}
    )
  `);

  await db.exec(`
    CREATE TABLE IF NOT EXISTS holders (
      address TEXT PRIMARY KEY,
      balance INTEGER DEFAULT 0
    )
  `);

  const stats = await db.get("SELECT * FROM stats WHERE id = 1");
  if (!stats) {
    await db.run(
      "INSERT INTO stats (id, totalMinted, mintCount, lastBlock) VALUES (1, 0, 0, ?)",
      [START_BLOCK]
    );
  }

  app.listen(8080, () => {
    console.log("🚀 API running on :8080");
  });

  mainLoop();
}

init();
