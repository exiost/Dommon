import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import dotenv from "dotenv";
dotenv.config();

const DB_PATH = process.env.DB_PATH || "./domain-monitor.db";

// Pastikan folder DB ada
const dir = path.dirname(DB_PATH);
if (dir && dir !== "." && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

export const db = new Database(DB_PATH);

db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

export function initSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS domains (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      label TEXT NOT NULL,
      url TEXT NOT NULL,
      wp_api_base TEXT,      -- override WP REST base (default: <url>/wp-json)
      wp_user TEXT,
      wp_app_password TEXT,  -- WordPress Application Password (gunakan HTTPS!)
      check_interval_minutes INTEGER NOT NULL DEFAULT 30,
      is_enabled INTEGER NOT NULL DEFAULT 1,
      bing_query_override TEXT, -- custom site: query (mis. "site:example.com -inurl:tag")
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS results (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      domain_id INTEGER NOT NULL,
      checked_at TEXT NOT NULL,
      online INTEGER,
      http_status INTEGER,
      response_time_ms INTEGER,
      posts_count INTEGER,
      last_scheduled_post TEXT,
      bing_index_count INTEGER,
      ssl_valid_to TEXT,
      whois_expiry TEXT,
      nameservers TEXT,
      ip_address TEXT,
      error_message TEXT,
      FOREIGN KEY(domain_id) REFERENCES domains(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_results_domain_time ON results(domain_id, checked_at DESC);
  `);
}

export function nowIso() {
  return new Date().toISOString();
}
