import express from "express";
import { Pool } from "pg";

// La connexion est entièrement configurée par variables d'environnement
// (PGHOST, PGPORT, PGUSER, PGPASSWORD, PGDATABASE) : rien n'est codé en dur.
const pool = new Pool();
const app = express();
const port = Number(process.env.PORT ?? 3000);

async function init(): Promise<void> {
  await pool.query(
    "CREATE TABLE IF NOT EXISTS visits (id SERIAL PRIMARY KEY, at TIMESTAMPTZ DEFAULT now())"
  );
}

app.get("/", async (_req, res) => {
  await pool.query("INSERT INTO visits DEFAULT VALUES");
  const { rows } = await pool.query("SELECT count(*)::int AS total FROM visits");
  res.json({ message: "Bonjour depuis le TP7", visits: rows[0].total, host: process.env.HOSTNAME });
});

// Utilisée par le HEALTHCHECK Docker et, plus tard, par les probes Kubernetes.
app.get("/health", async (_req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ status: "ok" });
  } catch {
    res.status(503).json({ status: "db-unavailable" });
  }
});

init()
  .then(() => app.listen(port, () => console.log(`visits-app écoute sur le port ${port}`)))
  .catch((err) => {
    console.error("Initialisation impossible :", err.message);
    process.exit(1);
  });
// modification test cache
// modification 2
// mesure naive
// mesure multistage
// mesure naive
