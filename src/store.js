import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { encrypt, decrypt } from "./crypto.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.join(__dirname, "..", "data");
const DB_FILE = path.join(DATA_DIR, "db.json");
const SETTINGS_FILE = path.join(DATA_DIR, "settings.json");
// 🔥 PENINGKATAN: Batas jumlah riwayat yang disimpan per domain
const MAX_RESULTS_PER_DOMAIN = 5;

function ensureDb() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DB_FILE)) {
    fs.writeFileSync(DB_FILE, JSON.stringify({ domains: [], results: [] }, null, 2));
  }
}
function readDb() { ensureDb(); return JSON.parse(fs.readFileSync(DB_FILE, "utf-8")); }
function writeDb(db) { fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2)); }

const defaultSettings = {
  enabled: false,
  endpoint: "https://api.eriarmedia.com/send-message",
  api_key: "DzTvGT02vuZdtxm3LLPNXuX0eAV2Tb",
  sender: "6287760470324",
  recipient: "",
  notification_delay_minutes: 2,
  dashboard_refresh_seconds: 15, 
  trigger_down: true,
  trigger_online: true,
  trigger_whois: true,
  whois_days: 90,
  trigger_rest_error: false,
  trigger_rest_ok: false,
  trigger_content_schedule: true,
  content_schedule_threshold: 5,
  trigger_homepage_auth_error: false,
  use_backup_checker: true, 
};

export function getSettings() {
  ensureDb();
  if (!fs.existsSync(SETTINGS_FILE)) {
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(defaultSettings, null, 2));
    return defaultSettings;
  }
  try {
    const settings = JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf-8"));
    return { ...defaultSettings, ...settings };
  } catch {
    return defaultSettings;
  }
}

export function saveSettings(newSettings) {
  ensureDb();
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(newSettings, null, 2));
  return newSettings;
}

// 🔥 PENINGKATAN: insertResult sekarang melakukan rotasi log
export async function insertResult(obj) {
  const db = readDb();
  
  // Tambahkan hasil baru
  const id = db.results.length ? Math.max(...db.results.map(r => r.id || 0)) + 1 : 1;
  db.results.push({ id, ...obj });

  // Ambil semua hasil untuk domain yang bersangkutan
  const domainResults = db.results
    .filter(r => r.domain_id === obj.domain_id)
    .sort((a, b) => new Date(b.checked_at) - new Date(a.checked_at));

  // Jika jumlah hasil melebihi batas, hapus yang paling lama
  if (domainResults.length > MAX_RESULTS_PER_DOMAIN) {
    const resultsToRemove = domainResults.slice(MAX_RESULTS_PER_DOMAIN);
    const idsToRemove = new Set(resultsToRemove.map(r => r.id));
    db.results = db.results.filter(r => !idsToRemove.has(r.id));
  }

  writeDb(db);
  return id;
}

export function listDomains() { return readDb().domains; }

export function getDomain(id) { 
  const db = readDb();
  const domain = db.domains.find(d => d.id === id) || null;
  if (domain && domain.wp_app_password) {
    domain.wp_app_password = decrypt(domain.wp_app_password);
  }
  return domain;
}

export async function createDomain(body) {
  const db = readDb();
  const id = db.domains.length ? Math.max(...db.domains.map(d => d.id)) + 1 : 1;
  const row = {
    id,
    label: body.label,
    url: body.url,
    wp_api_base: body.wp_api_base || "",
    wp_user: body.wp_user || "",
    wp_app_password: body.wp_app_password ? encrypt(body.wp_app_password) : "",
    bing_query_override: body.bing_query_override || "",
    check_interval_minutes: parseInt(body.check_interval_minutes || 30, 10),
    rest_check_interval_minutes: parseInt(body.rest_check_interval_minutes || 600, 10),
    is_enabled: (body.is_enabled === 1 || body.is_enabled === "1" || body.is_enabled === true) ? 1 : 0,
    whois_expiry: null,
    nameservers: null,
    last_general_check_at: null,
    last_rest_check_at: null,
  };
  db.domains.push(row);
  writeDb(db);
  return row;
}

export async function updateDomain(id, body) {
  const db = readDb();
  const idx = db.domains.findIndex(d => d.id === id);
  if (idx === -1) return null;
  const orig = db.domains[idx];
  const { whois_expiry, nameservers, ...safe } = body || {};

  // 🔥 PERBAIKAN: Logika untuk menangani pembaruan password
  // Cek apakah properti wp_app_password ada di body yang dikirim dari form.
  // Ini akan bernilai 'true' bahkan jika nilainya string kosong "".
  if (body.wp_app_password !== undefined) {
      // Jika ada, berarti pengguna mengubah atau sengaja mengosongkan password.
      // Kita enkripsi nilai barunya (termasuk string kosong).
      safe.wp_app_password = encrypt(body.wp_app_password);
  } else {
      // Jika properti ini tidak ada sama sekali di body,
      // artinya pengguna tidak menyentuh kolom password. Pertahankan password lama.
      safe.wp_app_password = orig.wp_app_password;
  }

  const row = {
    ...orig,
    ...safe,
    id: orig.id,
    check_interval_minutes: parseInt((safe.check_interval_minutes ?? orig.check_interval_minutes) || 30, 10),
    rest_check_interval_minutes: parseInt((safe.rest_check_interval_minutes ?? orig.rest_check_interval_minutes) || 600, 10),
    is_enabled: (safe.is_enabled === 1 || safe.is_enabled === "1" || safe.is_enabled === true) ? 1 : 0,
  };
  db.domains[idx] = row;
  writeDb(db);
  return row;
}
export async function updateLastCheckTime(domainId, checkType, timestamp) {
  const db = readDb();
  const idx = db.domains.findIndex(d => d.id === domainId);
  if (idx === -1) return;
  if (checkType === 'general') {
    db.domains[idx].last_general_check_at = timestamp;
  } else if (checkType === 'rest') {
    db.domains[idx].last_rest_check_at = timestamp;
  }
  writeDb(db);
}
export async function setDomainWhois(id, expiry, ns) {
  const db = readDb();
  const idx = db.domains.findIndex(d => d.id === id);
  if (idx === -1) return null;
  db.domains[idx].whois_expiry = expiry ?? db.domains[idx].whois_expiry;
  db.domains[idx].nameservers = (ns && ns.length ? ns : db.domains[idx].nameservers);
  writeDb(db);
  return db.domains[idx];
}
export async function deleteDomain(id) {
  const db = readDb();
  const before = db.domains.length;
  db.domains = db.domains.filter(d => d.id !== id);
  db.results = db.results.filter(r => r.domain_id !== id);
  writeDb(db);
  return before !== db.domains.length;
}
export function getHistory(domainId, limit = 100) {
  const db = readDb();
  return db.results
    .filter(r => r.domain_id === domainId)
    .sort((a, b) => new Date(b.checked_at) - new Date(a.checked_at))
    .slice(0, limit);
}
export function getLatestResult(domainId) {
  const db = readDb();
  const results = db.results
    .filter(r => r.domain_id === domainId)
    .sort((a, b) => new Date(b.checked_at) - new Date(a.checked_at));
  return results.length > 0 ? results[0] : null;
}
export function getLatestResults() {
  const db = readDb();
  const latestByDomain = new Map();
  for (const r of db.results) {
    const prev = latestByDomain.get(r.domain_id);
    if (!prev || new Date(r.checked_at) > new Date(prev.checked_at)) {
      latestByDomain.set(r.domain_id, r);
    }
  }
  const out = [];
  for (const d of db.domains) {
    const r = latestByDomain.get(d.id);
    out.push({
      id: d.id,
      domain_id: d.id,
      label: d.label,
      url: d.url,
      is_enabled: d.is_enabled,
      check_interval_minutes: d.check_interval_minutes,
      rest_check_interval_minutes: d.rest_check_interval_minutes,
      whois_expiry: d.whois_expiry ?? null,
      nameservers: d.nameservers ?? null,
      last_general_check_at: d.last_general_check_at ?? null,
      last_rest_check_at: d.last_rest_check_at ?? null,
      wp_api_base: d.wp_api_base,
      wp_user: d.wp_user,
      wp_app_password: d.wp_app_password ? decrypt(d.wp_app_password) : "",
      bing_query_override: d.bing_query_override,
      checked_at: r?.checked_at ?? null,
      online: r?.online ?? 0,
      http_status: r?.http_status ?? null,
      homepage_status: r?.homepage_status ?? null,
      response_time_ms: r?.response_time_ms ?? null,
      posts_count: r?.posts_count ?? null,
      future_count: r?.future_count ?? null,
      last_scheduled_post: r?.last_scheduled_post ?? null,
      bing_index_count: r?.bing_index_count ?? null,
      bot_verification: r?.bot_verification ?? 0,
      
      // 🔥 LANGKAH 2: Tambahkan baris ini untuk mengirim flag ke frontend
      rest_fallback: r?.rest_fallback ?? 0,
	  used_backup: r?.used_backup ?? 0, // Tambahkan baris ini
	  // used_rest_backup: r?.used_rest_backup ?? 0,
	  
      ip_address: r?.ip_address ?? null,
      error_message: r?.error_message ?? null,
      // Menambahkan raw_error_body ke data yang dikirim ke UI
      raw_error_body: r?.raw_error_body ?? null,
    });
  }
  return out;
}
