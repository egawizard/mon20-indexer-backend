import express from "express";
import cors from "cors";
import sqlite3 from "sqlite3";
import { open } from "sqlite";

const app = express();
const PORT = process.env.PORT || 8080;

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
      "INSERT INTO stats (id,totalMinted,mintCount,lastBlock) VALUES (1,0,0,32111408)"
    );
  }
})();

app.use(cors());

// ===== ROUTES =====
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

app.listen(PORT, () => {
  console.log(`🚀 API running on :${PORT}`);
});
