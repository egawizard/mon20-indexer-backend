import express from "express";
import cors from "cors";
import sqlite3 from "sqlite3";
import { ethers } from "ethers";

const app = express();
const PORT = process.env.PORT || 8080;

// RPC list
const RPCS = [
  "https://rpc.ankr.com/monad_testnet",
  "https://testnet-rpc.monad.xyz"
];
let provider = new ethers.JsonRpcProvider(RPCS[0]);

// Token config
const DEPLOY_BLOCK = 32111409;
const BATCH_SIZE = 50;
const TICK = "MONS";
const MINT_LIMIT = 1000;
const MAX_SUPPLY = 21_000_000;

// ===== DB INIT =====
let db;
(async () => {
  db = await open({
    filename: "./db.sqlite",
    driver: sqlite3.Database
  });

  await db.exec(`
    CREATE TABLE IF NOT EXISTS stats (
      id INTEGER PRIMARY KEY,
      totalMinted INTEGER,
      mintCount INTEGER,
      lastBlock INTEGER
    );
  `);

  await db.exec(`
    CREATE TABLE IF NOT EXISTS holders (
      address TEXT PRIMARY KEY,
      balance INTEGER
    );
  `);

  const row = await db.get("SELECT * FROM stats WHERE id=1");
  if (!row) {
    await db.run(
      "INSERT INTO stats (id,totalMinted,mintCount,lastBlock) VALUES (1,0,0,?)",
      DEPLOY_BLOCK - 1
    );
  }
})();

app.use(cors());

// ===== API =====
app.get("/", (req, res) => {
  res.json({ status: "ok", msg: "MON20 Indexer API" });
});

app.get("/stats", async (req, res) => {
  try {
    const row = await db.get("SELECT * FROM stats WHERE id=1");
    res.json(row || {});
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/holders", async (req, res) => {
  try {
    const rows = await db.all(
      "SELECT address, balance FROM holders ORDER BY balance DESC LIMIT 20"
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ===== Indexer =====
async function processBlock(bn) {
  try {
    const block = await provider.send("eth_getBlockByNumber", [
      ethers.toBeHex(bn),
      true
    ]);
    if (!block || !block.transactions) return;

    for (const tx of block.transactions) {
      if (!tx.input || tx.input === "0x") continue;
      if (tx.from.toLowerCase() !== tx.to?.toLowerCase()) continue;

      try {
        const hex = tx.input.startsWith("0x") ? tx.input.slice(2) : tx.input;
        let str = "";
        for (let i = 0; i < hex.length; i += 2) {
          str += String.fromCharCode(parseInt(hex.substr(i, 2), 16));
        }
        const json = JSON.parse(str);

        if (
          (json.p || "").toUpperCase() === "MON-20" &&
          (json.op || "").toLowerCase() === "mint" &&
          (json.tick || "") === TICK &&
          String(json.amt || "") === String(MINT_LIMIT)
        ) {
          const stats = await db.get("SELECT * FROM stats WHERE id=1");
          if (stats.totalMinted + MINT_LIMIT > MAX_SUPPLY) return;

          const addr = tx.from.toLowerCase();
          const prev = await db.get(
            "SELECT balance FROM holders WHERE address=?",
            addr
          );
          if (prev) {
            await db.run("UPDATE holders SET balance=? WHERE address=?", [
              prev.balance + MINT_LIMIT,
              addr
            ]);
          } else {
            await db.run("INSERT INTO holders (address,balance) VALUES (?,?)", [
              addr,
              MINT_LIMIT
            ]);
          }

          await db.run(
            "UPDATE stats SET totalMinted=?, mintCount=?, lastBlock=? WHERE id=1",
            stats.totalMinted + MINT_LIMIT,
            stats.mintCount + 1,
            bn
          );
        }
      } catch {}
    }
    await db.run("UPDATE stats SET lastBlock=? WHERE id=1", bn);
  } catch (e) {
    console.log("Block error", bn, e.message);
  }
}

async function mainLoop() {
  while (true) {
    try {
      const stats = await db.get("SELECT * FROM stats WHERE id=1");
      const latest = await provider.getBlockNumber();

      if (latest > stats.lastBlock) {
        console.log(`📡 Syncing from ${stats.lastBlock + 1} to ${latest}`);
        for (let b = stats.lastBlock + 1; b <= latest; b += BATCH_SIZE) {
          const end = Math.min(b + BATCH_SIZE - 1, latest);
          for (let x = b; x <= end; x++) {
            await processBlock(x);
          }
          console.log(`📦 Synced block ${end}`);
          await new Promise((r) => setTimeout(r, 500));
        }
      }
      await new Promise((r) => setTimeout(r, 5000));
    } catch (e) {
      console.log("Main loop error", e.message);
      provider = new ethers.JsonRpcProvider(
        RPCS[Math.floor(Math.random() * RPCS.length)]
      );
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

// Start server + indexer
app.listen(PORT, () => {
  console.log(`🚀 API running on :${PORT}`);
  mainLoop();
});

