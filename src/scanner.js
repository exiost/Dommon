// scanner.js
import { URL } from "url";
// TIDAK ADA import getDomain di sini.

async function timedFetch(input, init = {}, timeoutMs = 15000) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(input, { ...init, signal: controller.signal });
    return res;
  } finally {
    clearTimeout(t);
  }
}

// =================================================================
// ▼▼▼ PENAMBAHAN BAGIAN BARU ▼▼▼
// =================================================================

// Fungsi baru yang khusus memanggil API cadangan di Vercel.
// Tujuannya jelas: hanya untuk mengecek status URL.
async function runBackupCheck(targetUrl) {
  const backupApiUrl = `https://cek-status-api.vercel.app/api/check?url=${encodeURIComponent(targetUrl)}`;
  try {
    console.log(`[${new Date().toISOString().replace('T', ' ').substring(0, 19)}] ✨ [BACKUP CHECK] Mencoba checker cadangan untuk ${targetUrl}...`);
    const response = await timedFetch(backupApiUrl, {}, 20000); // Timeout 20 detik
    if (response.ok) {
      const data = await response.json();
      return {
        // Kita hanya butuh 2 informasi ini dari API cadangan
        status_code: data.status_code,
        status_text: data.status_text,
      };
    }
    // Jika API cadangan error, kembalikan null
    return null;
  } catch (error) {
    console.error(`[${new Date().toISOString().replace('T', ' ').substring(0, 19)}] ❌ [BACKUP CHECK] Gagal: ${error.message}`);
    return null;
  }
}

// =================================================================
// ▲▲▲ AKHIR DARI BAGIAN BARU ▲▲▲
// =================================================================

// Fungsi baru yang khusus memanggil API cadangan untuk REST check.
async function runBackupRestCheck(targetUrl, user, pass) {
  const backupApiUrl = `https://cek-status-api.vercel.app/api/check-rest`;
  try {
    console.log(`[${new Date().toISOString().replace('T', ' ').substring(0, 19)}] ✨ [BACKUP REST CHECK] Mencoba checker cadangan untuk ${targetUrl}...`);
    
    // Siapkan headers untuk request POST
    const headers = {
      'x-target-url': targetUrl,
    };
    if (user) headers['x-wp-user'] = user;
    if (pass) headers['x-wp-app-password'] = pass;

    const response = await timedFetch(backupApiUrl, {
      method: 'POST',
      headers: headers,
    }, 25000); // Timeout 25 detik

    if (response.ok) {
      const data = await response.json();
      return {
        wpHttpStatus: data.status_code,
        postsCount: data.posts_count,
        futureCount: data.future_count,
        lastScheduledPost: data.last_scheduled_post,
      };
    }
    return null;
  } catch (error) {
    console.error(`[${new Date().toISOString().replace('T', ' ').substring(0, 19)}] ❌ [BACKUP REST CHECK] Gagal: ${error.message}`);
    return null;
  }
}

function detectBotVerification(htmlSnippet = "") {
  const re = /(wait while we verify|request is being verified|solve the recaptcha below to verify)/i;
  const m = htmlSnippet.match(re);
  return { bot: !!m, reason: m ? m[0] : null };
}

export function normalizeWpBase(wpBase, siteUrl) {
  if (wpBase && /^https?:\/\//i.test(wpBase)) return wpBase.replace(/\/+$/, "");
  const u = new URL(siteUrl);
  return `${u.origin}/wp-json`;
}

export async function checkOnline(url, settings = {}) {
//export async function checkOnline(url) {
  const t0 = Date.now();
  let status = 0, text = "", ok = 0, used_backup = 0; // Tambahkan used_backup di sini
  
  // --- Pengecekan Lokal (Utama) ---
  try {
    const r = await timedFetch(url, {
      method: "GET",
      headers: { "accept": "text/html,*/*;q=0.9", "user-agent": "DomainMonitor/1.0" },
      redirect: "follow",
    }, 15000);
    status = r.status;
    ok = (status >= 200 && status < 400) ? 1 : 0;
    // Hanya baca body jika koneksi tidak OK, untuk efisiensi
    if (!ok) {
        try { text = await r.text(); } catch {}
    }
  } catch (e) {
    status = 0;
    ok = 0;
    text = `Gagal melakukan koneksi dari server lokal. Error: ${e.message}`;
  }

  // =================================================================
  // ▼▼▼ PENAMBAHAN LOGIKA FALLBACK (CADANGAN) ▼▼▼
  // =================================================================

  // Jika pengecekan lokal GAGAL (ok bukan 1), maka kita jalankan backup.
  if (settings.use_backup_checker && ok !== 1) {
    const backupResult = await runBackupCheck(url);
    
    // Jika backup-nya berhasil, kita pakai hasilnya.
    if (backupResult) {
      used_backup = 1; // 🔥 Nah, di sini kita tandai bahwa backup dipakai
      status = backupResult.status_code;
      ok = (status >= 200 && status < 400) ? 1 : 0; // Tentukan status OK baru
      text = `[Backup Check] Server merespons dengan status ${status} (${backupResult.status_text})`;
    }
  }

  // =================================================================
  // ▲▲▲ AKHIR DARI LOGIKA FALLBACK ▲▲▲
  // =================================================================

  const { bot, reason } = detectBotVerification(String(text || "").slice(0, 4000));
  return {
    online: ok,
    httpStatus: status,
    responseTimeMs: Date.now() - t0,
    botVerification: bot,
    botReason: reason,
    rawBody: text,
    used_backup: used_backup, // 🔥 Kirim sinyal ini keluar dari fungsi
  };
}

export async function scanHomepage(domainRow, settings = {}) {
  const onlineCheck = await checkOnline(domainRow.url, settings);
//export async function scanHomepage(domainRow) {
  //const onlineCheck = await checkOnline(domainRow.url);
  let error_message = null;
  let onlineStatus = 0;

  if (onlineCheck.httpStatus === 401 || onlineCheck.httpStatus === 403) {
    onlineStatus = 2;
    const lines = [];
    if (onlineCheck.botVerification) {
      lines.push("Bot verification terdeteksi");
      if (onlineCheck.botReason) lines.push(`Matched: ${onlineCheck.botReason}`);
    } else {
      lines.push(`Akses Ditolak (HTTP ${onlineCheck.httpStatus}).`);
      lines.push(`\nHomepage mungkin memerlukan otentikasi (login) atau IP server Anda diblokir oleh firewall.`);
    }
    error_message = lines.join("\n");
  } else if (onlineCheck.online === 1) {
    onlineStatus = 1;
  } else {
    onlineStatus = 0;
    const lines = [];
    if (onlineCheck.botVerification) {
      lines.push("Bot verification terdeteksi");
      if (onlineCheck.botReason) lines.push(`Matched: ${onlineCheck.botReason}`);
    }
    lines.push("Online (Homepage 2xx–3xx): DOWN");
    lines.push(`HTTP Homepage: ${onlineCheck.httpStatus ?? "-"}`);
    error_message = lines.join("\n");
  }

  return {
    online: onlineStatus,
    homepage_status: onlineCheck.httpStatus ?? null,
    response_time_ms: onlineCheck.responseTimeMs ?? null,
    bot_verification: onlineCheck.botVerification ? 1 : 0,
    error_message,
    // 🔥 PERBAIKAN: Hanya simpan raw_body jika terjadi error (online status bukan 1)
    raw_error_body: onlineStatus !== 1 ? onlineCheck.rawBody : null,
	used_backup: onlineCheck.used_backup, // 🔥 TAMBAHKAN BARIS INI
  };
}

export async function checkWPStats(wpBase, user = null, appPass = null) {
  let postsCount = null, futureCount = null, lastScheduledPost = null;
  let wpHttpStatus = null, wpBlocked = false, wpBlockedReason = null, wpRawErrorBody = null;
  let fallback_occurred = 0; // 🔥 FLAG BARU: Untuk menandai jika fallback terjadi
  
  // let used_rest_backup = 0;

  const baseHeaders = {
    "accept": "application/json",
    "user-agent": "DomainMonitor/1.0",
  };

  // --- PERCOBAAN PERTAMA: Dengan Otentikasi (jika ada) ---
  if (user && appPass) {
    const authHeaders = { ...baseHeaders };
    const token = Buffer.from(`${user}:${appPass}`).toString("base64");
    authHeaders["authorization"] = `Basic ${token}`;

    // Cek post publish dengan otentikasi
    try {
      const r = await timedFetch(`${wpBase}/wp/v2/posts?per_page=1&status=publish&_fields=id`, { headers: authHeaders }, 30000);
      wpHttpStatus = r.status;
      if (r.ok) {
        postsCount = Number(r.headers.get("x-wp-total") || 0);
      } else {
        // Jika gagal, catat errornya
        wpBlocked = true;
        wpBlockedReason = `HTTP ${r.status}`;
        try { wpRawErrorBody = await r.text(); } catch {}
        const { bot, reason } = detectBotVerification(wpRawErrorBody);
        if(bot) wpBlockedReason = `Bot verification: ${reason || "detected"}`;
      }
    } catch (e) {
      wpBlocked = true;
      wpBlockedReason = `fetch-error: ${e.message}`;
    }

    // Cek post future dengan otentikasi
    try {
      const r2 = await timedFetch(`${wpBase}/wp/v2/posts?per_page=1&status=future&orderby=date&order=desc&_fields=id,date`, { headers: authHeaders }, 15000);
      if (r2.ok) {
        futureCount = Number(r2.headers.get("x-wp-total") || 0);
        if (futureCount > 0) {
          const arr = await r2.json();
          if (Array.isArray(arr) && arr[0]?.date) lastScheduledPost = arr[0].date;
        }
      }
    } catch {}
  }

  // --- LOGIKA FALLBACK ---
  // Jika percobaan pertama (dengan otentikasi) gagal total, lakukan percobaan kedua tanpa otentikasi
  const authAttemptFailed = (user && appPass && postsCount === null && futureCount === null);
  
  if (authAttemptFailed || (!user || !appPass)) {
    if (authAttemptFailed) {
      console.log(`[${new Date().toISOString().replace('T', ' ').substring(0, 19)}] ⚠️  [REST FALLBACK] Auth check failed for ${wpBase}. Retrying without auth.`);
      fallback_occurred = 1; // Set flag fallback
      // Reset error dari percobaan otentikasi agar tidak salah lapor
      wpBlocked = false;
      wpBlockedReason = null;
      wpRawErrorBody = null;
    }

    // Cek post publish tanpa otentikasi (sebagai fallback atau jika memang tidak ada kredensial)
    try {
      const r = await timedFetch(`${wpBase}/wp/v2/posts?per_page=1&status=publish&_fields=id`, { headers: baseHeaders }, 30000);
      wpHttpStatus = r.status; // Timpa status HTTP dengan hasil terbaru
      if (r.ok) {
        postsCount = Number(r.headers.get("x-wp-total") || 0);
      } else if (!r.ok) {
        // Jika request publik pun gagal, ini adalah error sungguhan
        wpBlocked = true;
        wpBlockedReason = `Public HTTP ${r.status}`;
        try { wpRawErrorBody = await r.text(); } catch {}
      }
    } catch (e) {
        wpBlocked = true;
        wpBlockedReason = `public-fetch-error: ${e.message}`;
    }
    // futureCount dan lastScheduledPost sengaja dibiarkan null karena tidak bisa diakses tanpa otentikasi
    futureCount = null;
    lastScheduledPost = null;
  }

	// ▼▼▼ TAMBAHKAN KODE BARU DI SINI ▼▼▼
  // --- LOGIKA FALLBACK EKSTERNAL (CADANGAN) ---
  /*const isLocalCheckOk = wpHttpStatus >= 200 && wpHttpStatus < 400;
  
  if (!isLocalCheckOk) {
    console.log(`[${new Date().toISOString().replace('T', ' ').substring(0, 19)}] ⚠️  [REST FALLBACK] Cek lokal gagal (status: ${wpHttpStatus}). Mencoba backup checker...`);
    const backupResult = await runBackupRestCheck(wpBase, user, appPass);
    
    if (backupResult && backupResult.wpHttpStatus >= 200 && backupResult.wpHttpStatus < 300) {
      used_rest_backup = 1; // Tandai bahwa backup dipakai
      wpHttpStatus = backupResult.wpHttpStatus;
      postsCount = backupResult.postsCount;
      futureCount = backupResult.futureCount;
      lastScheduledPost = backupResult.lastScheduledPost;
      wpBlocked = false; wpBlockedReason = null; wpRawErrorBody = null; // Reset error lokal
    }
  }*/
  // ▲▲▲ SAMPAI DI SINI ▲▲▲

  return {
    postsCount, futureCount, lastScheduledPost, wpHttpStatus, wpBlocked, wpBlockedReason, wpRawErrorBody,
    rest_fallback: fallback_occurred, // Kembalikan flag fallback
	// used_rest_backup: used_rest_backup,
  };
}

export async function bingIndexCount(hostname, key, endpoint = "https://api.bing.microsoft.com/v7.0/search", overrideQuery) {
  try {
    if (!key) return { count: null, note: "no-key" };
    const q = overrideQuery && overrideQuery.trim().length ? overrideQuery : `site:${hostname}`;
    const r = await timedFetch(`${endpoint}?q=${encodeURIComponent(q)}&count=0`, { headers: { "Ocp-Apim-Subscription-Key": key } }, 15000);
    if (!r.ok) return { count: null, error: `bing ${r.status}` };
    const js = await r.json();
    return { count: js?.webPages?.totalEstimatedMatches ?? null };
  } catch (e) {
    return { count: null, error: String(e.message || e) };
  }
}
export async function whoisInfo(hostname) {
  try {
    const r = await timedFetch(`https://rdap.org/domain/${encodeURIComponent(hostname)}`, {}, 15000);
    if (!r.ok) return { expiry: null, nameservers: null, error: `rdap ${r.status}` };
    const js = await r.json();
    const events = js?.events || [];
    const expEvent = events.find(ev => (ev.eventAction || "").toLowerCase() === "expiration");
    const expiry = expEvent?.eventDate || null;
    const ns = (js?.nameservers || []).map(n => n.ldhName).filter(Boolean).join(", ") || null;
    return { expiry, nameservers: ns };
  } catch (e) {
    return { expiry: null, nameservers: null, error: String(e.message || e) };
  }
}
export async function sslInfo() {
  return { validTo: null };
}

// 🔥 PERBAIKAN: Fungsi ini sekarang hanya menggunakan `domainRow` yang sudah didekripsi
export async function scanDomain(domainRow, env, opts = {}) {
  const url = domainRow.url;
  const hostname = new URL(url).hostname;
  //const online = await scanHomepage(domainRow);
  const online = await scanHomepage(domainRow, settings); // Teruskan settings
  const wpBase = normalizeWpBase(domainRow.wp_api_base, url);
  
  // Kode di sini sudah benar, langsung menggunakan `domainRow` yang datanya sudah siap pakai
  const wp = await checkWPStats(wpBase, domainRow.wp_user, domainRow.wp_app_password);

  let bing = { count: null };
  try {
    bing = await bingIndexCount(hostname, env.BING_API_KEY, env.BING_ENDPOINT, domainRow.bing_query_override);
  } catch {}
  let whois = {};
  if (opts.withWhois) {
    whois = await whoisInfo(hostname);
  }
  let error_message = online.error_message;
  if (!error_message) {
    if (online.online !== 1) {
      error_message = `HTTP Homepage: ${online.homepage_status ?? "-"}, HTTP REST API: ${wp.wpHttpStatus ?? "-"}`;
    }
  }
  return {
    online: online.online,
    http_status: wp.wpHttpStatus ?? null,
    homepage_status: online.homepage_status ?? null,
    response_time_ms: online.response_time_ms ?? null,
    posts_count: wp.postsCount ?? null,
    future_count: wp.futureCount ?? null,
    last_scheduled_post: wp.futureCount === 0 ? null : (wp.lastScheduledPost ?? null),
    bing_index_count: bing.count ?? null,
    bot_verification: (online.bot_verification || wp.wpBlocked) ? 1 : 0,
    error_message,
    // 🔥 PERBAIKAN: Pastikan raw_error_body dari hasil scan homepage diteruskan
    raw_error_body: online.raw_error_body, 
    whois_expiry: whois.expiry ?? null,
    nameservers: whois.nameservers ?? null,
    used_backup: online.used_backup ?? 0,
    rest_fallback: wp.rest_fallback ?? 0,
    // used_rest_backup: wp.used_rest_backup ?? 0,
  };
}
