// src/server.js

import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { listDomains, createDomain, updateDomain, deleteDomain, getDomain, getLatestResults, getHistory, insertResult, setDomainWhois, getSettings, saveSettings, getLatestResult } from './store.js';
import { scanDomain, checkWPStats, normalizeWpBase } from './scanner.js';

dotenv.config();
const app = express();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
app.use(express.json({ limit: '2mb' }));
app.use(cors());
app.use(morgan('dev'));
app.use(express.static(path.join(__dirname, '..', 'public')));

const nowIso = () => new Date().toISOString();
const nowLog = () => new Date().toISOString().replace('T', ' ').substring(0, 19);

// --- Endpoint untuk CRON JOB dari Vercel ---
app.get('/api/cron', async (req, res) => {
  if (req.headers['authorization'] !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).send('Unauthorized');
  }
  console.log(`[${nowLog()}] ⏱️ [CRON] Triggered.`);
  const domains = await listDomains();
  const settings = await getSettings();
  const now = new Date();

  for (const domain of domains.filter(d => d.is_enabled)) {
    const decryptedDomain = await getDomain(domain.id);
    if (!decryptedDomain) continue;
    const lastCheck = domain.last_general_check_at ? new Date(domain.last_general_check_at).getTime() : 0;
    const intervalMs = (domain.check_interval_minutes || 30) * 60 * 1000;
    if (now.getTime() - lastCheck > intervalMs) {
      console.log(`[${nowLog()}] 🌐 [CRON] Scanning ${domain.label}`);
      scanDomain(decryptedDomain, process.env, settings, { withWhois: false })
        .then(scan => insertResult({ domain_id: domain.id, checked_at: nowIso(), ...scan }))
        .then(() => updateLastCheckTime(domain.id, 'general', nowIso()))
        .catch(e => console.error(`Scan error for ${domain.label}:`, e.message));
    }
  }
  res.status(200).send('Cron job finished.');
});

// --- API Endpoints (dibuat async) ---
app.get("/api/settings", async (req, res) => res.json(await getSettings()));
app.post("/api/settings", async (req, res) => res.json(await saveSettings(req.body)));
app.get("/api/domains", async (req, res) => res.json(await listDomains()));
app.get("/api/results/latest", async (req, res) => res.json(await getLatestResults()));
app.post("/api/domains", async (req, res) => res.json(await createDomain(req.body)));
app.put("/api/domains/:id", async (req, res) => res.json(await updateDomain(parseInt(req.params.id), req.body)));
app.delete("/api/domains/:id", async (req, res) => res.json({ deleted: await deleteDomain(parseInt(req.params.id)) }));
// Tambahkan endpoint lain jika ada dengan pola async/await yang sama

export default app;
