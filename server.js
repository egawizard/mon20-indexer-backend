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
const db = new sqlite3.Database("./db.sqlite");

db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS stats (
      id INTEGER PRIMARY KEY,
      totalMinted INTEGER,
      mintCount INTEGER,
      lastBlock INTEGER
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS holders (
      address TEXT PRIMARY KEY,
      balance INTEGER
    )
  `);

  db.get("SELECT * FROM stats WHERE id=1", (err, row) => {
    if (!row) {
      db.run(
        "INSERT INTO stats (id,totalMinted,mintCount,lastBlock) VALUES (1,0,0,?)",
        DEPLOY_BLOCK - 1
      );
    }
  });
});

// ===== API =====
app.use(cors());

app.get("/", (req, res) => {
  res.json({ status: "ok", msg: "MON20 Indexer API" });
});

app.get("/stats", (req, res) => {
  db.get("SELECT * FROM stats WHERE id=1", (err, row) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(row || {});
  });
});

app.get("/holders", (req, res) => {
  db.all(
    "SELECT address, balance FROM holders ORDER BY balance DESC LIMIT 20",
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(rows);
    }
  );
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
          db.get("SELECT * FROM stats WHERE id=1", (err, stats) => {
            if (!stats || stats.totalMinted + MINT_LIMIT > MAX_SUPPLY) return;

            const addr = tx.from.toLowerCase();
            db.get(
              "SELECT balance FROM holders WHERE address=?",
              [addr],
              (err, prev) => {
                if (prev) {
                  db.run("UPDATE holders SET balance=? WHERE address=?", [
                    prev.balance + MINT_LIMIT,
                    addr
                  ]);
                } else {
                  db.run(
                    "INSERT INTO holders (address,balance) VALUES (?,?)",
                    [addr, MINT_LIMIT]
                  );
                }

                db.run(
                  "UPDATE stats SET totalMinted=?, mintCount=?, lastBlock=? WHERE id=1",
                  stats.totalMinted + MINT_LIMIT,
                  stats.mintCount + 1,
                  bn
                );
              }
            );
          });
        }
      } catch {}
    }

    db.run("UPDATE stats SET lastBlock=? WHERE id=1", bn);
  } catch (e) {
    console.log("Block error", bn, e.message);
  }
}

async function mainLoop() {
  while (true) {
    try {
      db.get("SELECT * FROM stats WHERE id=1", async (err, stats) => {
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
      });
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

app.listen(PORT, () => {
  console.log(`🚀 API running on :${PORT}`);
  mainLoop();
});
