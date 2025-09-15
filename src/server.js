// server.js
import express from "express";
import cors from "cors";
import morgan from "morgan";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

import {
  listDomains, createDomain, updateDomain, deleteDomain,
  getDomain, getLatestResults, getHistory, insertResult, setDomainWhois,
  getSettings, saveSettings
} from "./store.js";

import {
  scanDomain, checkOnline, checkWPStats, bingIndexCount, sslInfo, whoisInfo, normalizeWpBase
} from "./scanner.js";

import { scheduleAll, rescheduleOne, cancelOne, sendWaNotification } from "./scheduler.js";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(cors());
app.use(morgan("dev"));

app.use("/", express.static(path.join(__dirname, "..", "public")));

const nowIso = () => new Date().toISOString();
const nowLog = () => new Date().toISOString().replace('T', ' ').substring(0, 19);

function labelFromUrl(urlStr){
  try{
    const h = new URL(urlStr).hostname.replace(/^www\./i, "");
    return h.split(".")[0] || h;
  }catch{ return "domain"; }
}

app.get("/api/settings", (req, res) => {
  res.json(getSettings());
});
app.post("/api/settings", (req, res) => {
  const newSettings = saveSettings(req.body);
  console.log(`[${nowLog()}] ⚙️ [SETTINGS] Settings updated.`);
  res.json(newSettings);
});
app.post("/api/settings/test", async (req, res) => {
  console.log(`[${nowLog()}] 🧪 [TEST NOTIFICATION] Sending test message...`);
  const message = `[Domain Monitor] Pesan Tes ✅\n\nIni adalah pesan tes dari aplikasi Domain Monitor Anda. Jika Anda menerima ini, konfigurasi notifikasi sudah benar.`;
  const result = await sendWaNotification(message);
  res.json(result);
});

function resultFromTestCache(test) {
  if (!test || !test.steps) return null;
  const online = test.steps.online || {};
  const wp = test.steps.wp || {};
  const bing = test.steps.bing || {};
  const whois = test.steps.whois || {};
  let error_message = null;
  const isOnline = online.online ? 1 : 0;
  if (isOnline !== 1) {
    const lines = [];
    if (online.botVerification || wp.wpBlocked) lines.push("Bot verification terdeteksi");
    lines.push("Online (Homepage 2xx–3xx): DOWN");
    lines.push(`HTTP Homepage: ${online.httpStatus ?? "-"}`);
    const restStatus = (wp.wpHttpStatus ?? wp.httpStatus ?? wp.status);
    lines.push(`HTTP REST API: ${restStatus ?? "-"}`);
    error_message = lines.join("\n");
  }
  const futureCount = (typeof wp.futureCount === "number") ? wp.futureCount : null;
  return {
    online: isOnline,
    http_status: (wp.wpHttpStatus ?? wp.httpStatus ?? wp.status ?? null),
    homepage_status: (online.httpStatus ?? null),
    response_time_ms: (online.responseTimeMs ?? null),
    posts_count: (typeof wp.postsCount === "number" ? wp.postsCount : null),
    future_count: (typeof futureCount === "number" ? futureCount : null),
    last_scheduled_post: futureCount === 0 ? null : (wp.lastScheduledPost ?? null),
    bing_index_count: (typeof bing.count === "number" ? bing.count : null),
    bot_verification: (online.botVerification || wp.wpBlocked) ? 1 : 0,
    error_message,
    whois_expiry: (whois.expiry ?? null),
    nameservers: (whois.nameservers ?? null)
  };
}

app.post("/api/test-connection", async (req, res) => {
  const p = req.body || {};
  if (!p.url) return res.status(400).json({ error: "url required" });
  const settings = getSettings();

  console.log(`[${nowLog()}] 🧪 [TEST] Starting connection test for: ${p.url}`);
  const url = p.url;
  let hostname = null;
  try { hostname = new URL(url).hostname; } catch {}
  const wpBase = normalizeWpBase(p.wp_api_base, url);
  const out = { ok: true, steps: {} };
  try {
    // out.steps.online = await checkOnline(url);
	out.steps.online = await checkOnline(url, settings);
    out.steps.wp = await checkWPStats(wpBase, p.wp_user || null, p.wp_app_password || null);
    if (hostname) {
      out.steps.bing = await bingIndexCount(hostname, process.env.BING_API_KEY, process.env.BING_ENDPOINT, p.bing_query_override);
      out.steps.ssl = await sslInfo(hostname);
      console.log(`[${nowLog()}] 🧪 [TEST] Checking WHOIS for: ${hostname}`);
      out.steps.whois = await whoisInfo(hostname);
    } else {
      out.steps.bing = { count: null, error: "invalid URL" };
    }
    res.json(out);
  } catch (e) {
    res.status(200).json({ ok: false, error: e.message, steps: out.steps });
  }
});

app.get("/api/domains", (req, res) => res.json(listDomains()));
app.post("/api/domains", async (req, res) => {
  const { label, url, __test_cache } = req.body || {};
  if (!label || !url) return res.status(400).json({ error: "label and url required" });
  const row = await createDomain(req.body);
  console.log(`[${nowLog()}] ➕ [ADD DOMAIN] '${label}' | Performing initial scan...`);
  try {
	const settings = getSettings();
  
    if (__test_cache && __test_cache.steps) {
      const scan = resultFromTestCache(__test_cache);
      if (scan) {
        await insertResult({ domain_id: row.id, checked_at: nowIso(), ...scan });
        if (scan.whois_expiry) await setDomainWhois(row.id, scan.whois_expiry, scan.nameservers || null);
      }
    } else {
      // const scan = await scanDomain(row, process.env, { withWhois: true });
	  const scan = await scanDomain(row, process.env, settings, { withWhois: true });

      await insertResult({ domain_id: row.id, checked_at: nowIso(), ...scan });
      if (scan.whois_expiry) await setDomainWhois(row.id, scan.whois_expiry, scan.nameservers || null);
    }
  } catch (e) {
    await insertResult({ domain_id: row.id, checked_at: nowIso(), online: 0, error_message: "first-scan:" + e.message });
  }
  if (row.is_enabled) rescheduleOne(row, process.env);
  res.json(await getDomain(row.id));
});
app.put("/api/domains/:id", async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const existing = await getDomain(id);
  if (!existing) return res.status(404).json({ error: "not found" });
  const { __test_cache, ...safe } = req.body || {};
  const row = await updateDomain(id, safe);
  rescheduleOne(row, process.env);
  try {
    if (__test_cache && __test_cache.steps) {
      const scan = resultFromTestCache(__test_cache);
      if (scan) {
        await insertResult({ domain_id: row.id, checked_at: nowIso(), ...scan });
        if (scan.whois_expiry) await setDomainWhois(row.id, scan.whois_expiry, scan.nameservers || null);
      }
    }
  } catch (e) {
    await insertResult({ domain_id: row.id, checked_at: nowIso(), online: 0, error_message: "update-scan:" + e.message });
  }
  res.json(row);
});
app.delete("/api/domains/:id", async (req, res) => {
  const id = parseInt(req.params.id, 10);
  cancelOne(id);
  const ok = await deleteDomain(id);
  res.json({ deleted: ok });
});
app.post("/api/domains/:id/scan", async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const dom = await getDomain(id);
  if (!dom) return res.status(404).json({ error: "not found" });
  const withWhois = String(req.query.withWhois || "") === "1";
  if (withWhois) {
    console.log(`[${nowLog()}] 🕵️  [MANUAL SCAN + WHOIS] '${dom.label}' | Starting...`);
  } else {
    console.log(`[${nowLog()}] 🔄 [MANUAL SCAN] '${dom.label}' | Starting...`);
  }
  try {
	const settings = getSettings();
    // const scan = await scanDomain(dom, process.env, { withWhois });
	const scan = await scanDomain(dom, process.env, settings, { withWhois });

    await insertResult({ domain_id: dom.id, checked_at: nowIso(), ...scan });
    if (withWhois && scan.whois_expiry) {
      await setDomainWhois(dom.id, scan.whois_expiry, scan.nameservers || null);
      console.log(`[${nowLog()}] 🕵️  [WHOIS RESULT] '${dom.label}' | Expiry: ${scan.whois_expiry}`);
    }
    res.json({ ok: true, saved: scan });
  } catch (e) {
    await insertResult({ domain_id: dom.id, checked_at: nowIso(), online: 0, error_message: "manual-scan:" + e.message });
    res.json({ ok: false, error: e.message });
  }
});

app.post("/api/import", async (req, res) => {
  const text = req.body.text || "";
  const lines = text.split("\n").map(l => l.trim()).filter(Boolean);
  const allDomains = listDomains();
  const results = [];
  let created = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const parts = line.split(";").map(p => p.trim());
    
    // 🔥 PERUBAHAN: Membaca 6 kolom, termasuk interval
    const [url, wp_user, wp_app_password, checkIntervalStr, restIntervalStr, enabledStr] = parts;

    if (!url || !url.startsWith("http")) {
      results.push({ line: i + 1, url, ok: false, skipped: true, reason: "Invalid URL" });
      continue;
    }
    if (allDomains.some(d => d.url === url)) {
      results.push({ line: i + 1, url, ok: false, skipped: true, reason: "Already exists" });
      continue;
    }
    try {
      const is_enabled = (enabledStr === "0") ? 0 : 1;
      
      // 🔥 PERUBAHAN: Menyertakan interval saat membuat domain baru
      const newDomain = {
        label: labelFromUrl(url),
        url,
        wp_user: wp_user || "",
        wp_app_password: wp_app_password || "",
        check_interval_minutes: checkIntervalStr, // Akan memakai default di createDomain jika kosong
        rest_check_interval_minutes: restIntervalStr, // Akan memakai default di createDomain jika kosong
        is_enabled
      };
      
      const row = await createDomain(newDomain);
      rescheduleOne(row, process.env);
      results.push({ line: i + 1, url, ok: true, id: row.id, enabled: row.is_enabled });
      created++;
      scanDomain(row, process.env, { withWhois: true }).then(scan => {
        insertResult({ domain_id: row.id, checked_at: nowIso(), ...scan });
        if (scan.whois_expiry) setDomainWhois(row.id, scan.whois_expiry, scan.nameservers || null);
      }).catch(()=>{});
    } catch (e) {
      results.push({ line: i + 1, url, ok: false, error: e.message });
    }
  }
  res.json({ created, total: lines.length, results });
});

app.get("/api/results/latest", (req, res) => res.json(getLatestResults()));
app.get("/api/domains/:id/history", (req, res) => {
  const id = parseInt(req.params.id, 10);
  const limit = Math.min(500, parseInt(req.query.limit || "100", 10));
  res.json(getHistory(id, limit));
});

/* ---------------- START ---------------- */
const PORT = parseInt(process.env.PORT || "5050", 10);
app.listen(PORT, () => {
  console.log(`Domain Monitor listening on http://localhost:${PORT}`);
  scheduleAll(process.env);
});