// src/store.js

import { kv } from '@vercel/kv';
import { encrypt, decrypt } from './crypto.js';

const DB_KEY = 'domain_monitor_database';
const SETTINGS_KEY = 'domain_monitor_settings';

const defaultSettings = {
  enabled: false, endpoint: "https://api.eriarmedia.com/send-message", api_key: "DzTvGT02vuZdtxm3LLPNXuX0eAV2Tb", sender: "6287760470324", recipient: "",
  notification_delay_minutes: 2, dashboard_refresh_seconds: 15, trigger_down: true, trigger_online: true, trigger_whois: true, whois_days: 90, trigger_rest_error: false, trigger_rest_ok: false,
  trigger_content_schedule: true, content_schedule_threshold: 5, trigger_homepage_auth_error: false, use_backup_checker: true,
};

async function readDb() {
  let db = await kv.get(DB_KEY);
  if (!db) {
    const initialDb = { domains: [], results: [] };
    await kv.set(DB_KEY, initialDb);
    return initialDb;
  }
  return db;
}
async function writeDb(db) { await kv.set(DB_KEY, db); }
export async function getSettings() { const settings = await kv.get(SETTINGS_KEY); return { ...defaultSettings, ...(settings || {}) }; }
export async function saveSettings(newSettings) { await kv.set(SETTINGS_KEY, newSettings); return newSettings; }
export async function listDomains() { return (await readDb()).domains; }
export async function getDomain(id) {
  const domain = (await readDb()).domains.find(d => d.id === id) || null;
  if (domain && domain.wp_app_password) domain.wp_app_password = decrypt(domain.wp_app_password);
  return domain;
}
export async function createDomain(body) {
  const db = await readDb(); const id = db.domains.length ? Math.max(...db.domains.map(d => d.id)) + 1 : 1;
  const row = { id, label: body.label, url: body.url, wp_api_base: body.wp_api_base || "", wp_user: body.wp_user || "", wp_app_password: body.wp_app_password ? encrypt(body.wp_app_password) : "",
    bing_query_override: body.bing_query_override || "", check_interval_minutes: parseInt(body.check_interval_minutes || 30, 10), rest_check_interval_minutes: parseInt(body.rest_check_interval_minutes || 600, 10),
    is_enabled: (body.is_enabled === 1 || body.is_enabled === "1" || body.is_enabled === true) ? 1 : 0, whois_expiry: null, nameservers: null, last_general_check_at: null, last_rest_check_at: null,
  };
  db.domains.push(row); await writeDb(db); return row;
}
export async function updateDomain(id, body) {
  const db = await readDb(); const idx = db.domains.findIndex(d => d.id === id); if (idx === -1) return null;
  const orig = db.domains[idx]; const { whois_expiry, nameservers, ...safe } = body || {};
  safe.wp_app_password = (body.wp_app_password !== undefined) ? encrypt(body.wp_app_password) : orig.wp_app_password;
  const row = { ...orig, ...safe, id: orig.id, check_interval_minutes: parseInt((safe.check_interval_minutes ?? orig.check_interval_minutes) || 30, 10),
    rest_check_interval_minutes: parseInt((safe.rest_check_interval_minutes ?? orig.rest_check_interval_minutes) || 600, 10),
    is_enabled: (safe.is_enabled === 1 || safe.is_enabled === "1" || safe.is_enabled === true) ? 1 : 0,
  };
  db.domains[idx] = row; await writeDb(db); return row;
}
export async function deleteDomain(id) { const db = await readDb(); const before = db.domains.length; db.domains = db.domains.filter(d => d.id !== id); db.results = db.results.filter(r => r.domain_id !== id); await writeDb(db); return before !== db.domains.length; }
export async function getLatestResults() {
  const db = await readDb(); const latestByDomain = new Map();
  for (const r of db.results) { const prev = latestByDomain.get(r.domain_id); if (!prev || new Date(r.checked_at) > new Date(prev.checked_at)) latestByDomain.set(r.domain_id, r); }
  return db.domains.map(d => {
    const r = latestByDomain.get(d.id) || {};
    return { ...d, ...r, id: d.id, domain_id: d.id, wp_app_password: d.wp_app_password ? decrypt(d.wp_app_password) : "" };
  });
}
export async function insertResult(obj) {
  const MAX_RESULTS = 5; const db = await readDb(); const id = db.results.length ? Math.max(...db.results.map(r => r.id || 0)) + 1 : 1;
  db.results.push({ id, ...obj });
  const domainResults = db.results.filter(r => r.domain_id === obj.domain_id).sort((a, b) => new Date(b.checked_at) - new Date(a.checked_at));
  if (domainResults.length > MAX_RESULTS) {
    const idsToRemove = new Set(domainResults.slice(MAX_RESULTS).map(r => r.id));
    db.results = db.results.filter(r => !idsToRemove.has(r.id));
  }
  await writeDb(db); return id;
}
export async function updateLastCheckTime(id, type, time) { const db = await readDb(); const idx = db.domains.findIndex(d=>d.id===id); if(idx===-1) return; db.domains[idx][type === 'general' ? 'last_general_check_at' : 'last_rest_check_at'] = time; await writeDb(db); }
// Fungsi lainnya yang dibutuhkan server
export async function getHistory(id, limit=100) { return (await readDb()).results.filter(r=>r.domain_id===id).sort((a,b)=>new Date(b.checked_at)-new Date(a.checked_at)).slice(0,limit); }
export async function getLatestResult(id) { const r=(await readDb()).results.filter(r=>r.domain_id===id).sort((a,b)=>new Date(b.checked_at)-new Date(a.checked_at)); return r.length > 0 ? r[0] : null; }
export async function setDomainWhois(id, expiry, ns) { const db=await readDb(); const idx=db.domains.findIndex(d=>d.id===id); if(idx===-1)return null; db.domains[idx].whois_expiry=expiry??db.domains[idx].whois_expiry; db.domains[idx].nameservers=(ns&&ns.length?ns:db.domains[idx].nameservers); await writeDb(db); return db.domains[idx]; }
