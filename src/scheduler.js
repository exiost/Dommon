import { 
  insertResult, listDomains, getLatestResult, updateLastCheckTime, getSettings,
  getDomain
} from "./store.js";
import { scanHomepage, checkWPStats, normalizeWpBase } from "./scanner.js";

const generalTimers = new Map();
const restTimers = new Map();
const whoisTimers = new Map();
const contentTimers = new Map();

const nowLog = () => new Date().toISOString().replace('T', ' ').substring(0, 19);

const notificationQueue = new Map();

function normalizePhoneNumber(numberStr) {
  if (!numberStr) return "";
  let num = numberStr.trim().replace(/[- \+]/g, '');
  if (num.startsWith('0')) {
    return '62' + num.substring(1);
  }
  if (num.startsWith('62')) {
    return num;
  }
  return '62' + num;
}

async function sendWaNotification(message) {
  const settings = getSettings();
  if (!settings.enabled || !settings.endpoint || !settings.api_key || !settings.sender || !settings.recipient) {
    if (message.includes("pesan tes")) {
      return { ok: false, error: "Notifikasi nonaktif atau konfigurasi belum lengkap." };
    }
    return;
  }
  const recipient = normalizePhoneNumber(settings.recipient);
  const sender = normalizePhoneNumber(settings.sender);
  const url = new URL(settings.endpoint);
  url.searchParams.append('api_key', settings.api_key);
  url.searchParams.append('sender', sender);
  url.searchParams.append('number', recipient);
  url.searchParams.append('message', message);
  try {
    const response = await fetch(url.toString(), { method: 'GET' });
    const data = await response.json();
    if (response.ok && data.status) {
      console.log(`[${nowLog()}] 📱 [WHATSAPP] Notification sent successfully to ${recipient}.`);
      return { ok: true };
    } else {
      console.error(`[${nowLog()}] ❌ [WHATSAPP] Failed to send notification:`, data.msg || 'Unknown error');
      return { ok: false, error: data.msg || 'Unknown error' };
    }
  } catch (e) {
    console.error(`[${nowLog()}] ❌ [WHATSAPP] Network error sending notification:`, e.message);
    return { ok: false, error: e.message };
  }
}

// Fungsi yang memproses antrian dan mengirim pesan gabungan
async function processNotificationQueue(type) {
  const queued = notificationQueue.get(type);
  if (!queued || queued.domains.size === 0) { // Cek jika antrian kosong
    notificationQueue.delete(type);
    return;
  }

  const domains = [...queued.domains.values()];
  notificationQueue.delete(type);

  let message = '';
  const header = `[Domain Monitor]`;
  
  switch (type) {
    case 'DOWN':
      message = `${header} PERINGATAN! 🚨\n\n*${domains.length} domain* terdeteksi *DOWN*:\n`;
      domains.forEach(d => { message += `\n- *${d.label}* (${d.url})` });
      break;
    case 'ONLINE':
      message = `${header} INFO ✅\n\n*${domains.length} domain* telah kembali *ONLINE*:\n`;
      domains.forEach(d => { message += `\n- *${d.label}*` });
      break;
    case 'AUTH_ERROR':
      message = `${header} PERINGATAN AKSES! 🔐\n\n*${domains.length} domain* mengembalikan status *Akses Ditolak* (401/403):\n`;
      domains.forEach(d => { message += `\n- *${d.label}*` });
      break;
    // ... sisa switch case tidak berubah ...
    case 'REST_ERROR':
      message = `${header} PERINGATAN! 🛠️\n\n*${domains.length} domain* mengalami masalah pada *WordPress REST API*:\n`;
      domains.forEach(d => { message += `\n- *${d.label}*` });
      break;
    case 'REST_OK':
      message = `${header} INFO ✅\n\n*${domains.length} domain* terdeteksi *WordPress REST API* telah kembali normal:\n`;
      domains.forEach(d => { message += `\n- *${d.label}*` });
      break;
    // 🔥 PERUBAHAN: Pesan notifikasi sekarang lebih dinamis
    case 'CONTENT_SCHEDULE':
       const settings = getSettings();
       const threshold = settings.content_schedule_threshold ?? 0;
       message = `${header} INFO JADWAL KONTEN 📝\n\n*${domains.length} domain* terdeteksi memiliki jadwal posting menipis (sisa ≤ ${threshold} post):\n`;
       domains.forEach(d => {
         const postCountText = d.future_count === 0 ? 'Habis' : `${d.future_count} post`;
         message += `\n- *${d.label}* (Sisa: ${postCountText})`;
       });
       message += `\n\nSegera tambahkan post terjadwal baru.`;
      break;
    // 🔥 PERBAIKAN: Mengubah logika untuk mengirim notifikasi WHOIS gabungan
    case 'WHOIS':
      message = `${header} PERINGATAN WHOIS 🗓️\n\n*${domains.length} domain* akan segera kedaluwarsa:\n`;
      domains.forEach(d => {
        const expiryDate = new Date(d.whois_expiry);
        const daysLeft = Math.ceil((expiryDate.getTime() - Date.now()) / (1000 * 60 * 60 * 24));
        const formattedExpiry = expiryDate.toLocaleDateString('id-ID', {day:'numeric', month:'long', year:'numeric'});
        message += `\n- *${d.label}* (exp: ${formattedExpiry}, *${daysLeft} hari lagi*)`;
      });
      break;
  }
  
  if(message) await sendWaNotification(message);
}

// Fungsi yang menambahkan notifikasi ke antrian
function queueNotification(type, domain) {
  const settings = getSettings();
  const delayMinutes = settings.notification_delay_minutes || 0;

  if (delayMinutes <= 0) {
    // Jika delay 0, buat pesan instan dan kirim
    // (Implementasi ini fokus pada batching, jadi kita bisa sederhanakan dengan menganggap delay minimal 1)
    console.log(`[${nowLog()}] 📲 [INSTANT NOTIFICATION] Bypassing queue for ${type} on ${domain.label}.`);
    // Untuk kesederhanaan, kita akan tetap proses seperti biasa, tapi Anda bisa tambahkan logika kirim instan di sini jika perlu.
  }
  
  const existing = notificationQueue.get(type);
  
  if (existing) {
    clearTimeout(existing.timer); // Hapus timer lama
    existing.domains.set(domain.id, domain); // Tambah/update domain di antrian (Map mencegah duplikat)
  } else {
    notificationQueue.set(type, {
      timer: null,
      domains: new Map([[domain.id, domain]]) // Gunakan Map untuk data domain agar unik
    });
  }
  
  const newTimer = setTimeout(() => {
    processNotificationQueue(type);
  }, delayMinutes * 60 * 1000);
  
  notificationQueue.get(type).timer = newTimer;
  console.log(`[${nowLog()}] 📥 [QUEUED] Notification '${type}' for '${domain.label}' is queued. Batch sending in ${delayMinutes} min.`);
}

// --- Worker yang Diperbarui untuk Memanggil Antrian ---

async function runGeneralScan(row, env) {
  try {
    const now = new Date().toISOString();
    const latestResult = await getLatestResult(row.id) || { online: -1 };
    const settings = getSettings();
    //const homepageScan = await scanHomepage(row);
	const homepageScan = await scanHomepage(row, settings);

    const wasOnline = latestResult.online === 1;
    const isOnline = homepageScan.online === 1;
    const isCheck = homepageScan.online === 2;
    

    // Logika Pembatalan Otomatis & Antrian
    const downQueue = notificationQueue.get('DOWN');

    if (wasOnline && homepageScan.online === 0 && settings.trigger_down) {
      queueNotification('DOWN', row);
    } 
    else if (!wasOnline && isOnline && settings.trigger_online) {
      // Jika domain kembali ONLINE, cek apakah ada di antrian DOWN
      if (downQueue && downQueue.domains.has(row.id)) {
        downQueue.domains.delete(row.id); // Hapus dari antrian DOWN
        console.log(`[${nowLog()}] ↩️ [CANCELLED] DOWN notification for '${row.label}' cancelled because it's back ONLINE.`);
      }
      queueNotification('ONLINE', row);
    } 
    else if (isCheck && settings.trigger_homepage_auth_error) {
       queueNotification('AUTH_ERROR', row);
    }
    
    // Proses penyimpanan hasil (tidak berubah)
    delete latestResult.id;
    const { http_status, ...safeHomepageScan } = homepageScan;
	const mergedResult = { 
		...latestResult, 
		...safeHomepageScan, 
		domain_id: row.id, 
		checked_at: now,
		used_backup: homepageScan.used_backup || 0, // Tambahkan baris ini
	};
    
    await insertResult(mergedResult);
    await updateLastCheckTime(row.id, 'general', now);
    
    const onlineStatus = isCheck ? 'CHECK' : (isOnline ? 'UP' : 'DOWN');
    console.log(`[${nowLog()}] 🌐 [HOMEPAGE CHECK] ${row.label} | Status: ${onlineStatus}, HTTP: ${homepageScan.homepage_status}, Resp: ${homepageScan.response_time_ms}ms`);
  } catch (e) {
    console.error(`[${nowLog()}] ❌ [HOMEPAGE FAILED] ${row.label} | Error: ${e.message}`);
  }
}

async function runRestScan(row, env) {
  try {
    const now = new Date().toISOString();
    const domainData = getDomain(row.id);
    if (!domainData) { return; }

    const wpBase = normalizeWpBase(domainData.wp_api_base, domainData.url);
    const wpStats = await checkWPStats(wpBase, domainData.wp_user, domainData.wp_app_password);
    
    const latestResult = await getLatestResult(row.id) || {};
    
    // Tentukan validitas data secara terpisah
    const isPostsDataValid = wpStats.postsCount !== null;
    const isFutureDataValid = wpStats.futureCount !== null;
    const isRestConnectionOk = wpStats.wpHttpStatus >= 200 && wpStats.wpHttpStatus < 400;
    const isRestCheckFullySuccessful = isRestConnectionOk && isPostsDataValid && isFutureDataValid;

    // Logika Notifikasi
    const wasRestOk = (latestResult.http_status >= 200 && latestResult.http_status < 400);
    const settings = getSettings();
    if (wasRestOk && !isRestCheckFullySuccessful && settings.trigger_rest_error) {
       queueNotification('REST_ERROR', row);
    } else if (!wasRestOk && isRestCheckFullySuccessful && settings.trigger_rest_ok) {
       queueNotification('REST_OK', row);
    }
    
    delete latestResult.id;

    // Tentukan status HTTP yang akan disimpan. Jika koneksi OK tapi ada data yg null, beri tanda.
    let statusToSave = wpStats.wpHttpStatus;
    if (isRestConnectionOk && !isRestCheckFullySuccessful) {
      statusToSave = -200; // Kode khusus untuk UI agar menampilkan ikon '!'
    }

    const newResult = {
      ...latestResult,
      domain_id: row.id,
      checked_at: now,
      http_status: statusToSave ?? latestResult.http_status,
      
      // Update data secara granular: hanya update jika data baru valid.
      posts_count: isPostsDataValid ? wpStats.postsCount : latestResult.posts_count,
      future_count: isFutureDataValid ? wpStats.futureCount : latestResult.future_count,
      last_scheduled_post: isFutureDataValid 
        ? (wpStats.futureCount === 0 ? null : wpStats.lastScheduledPost) 
        : latestResult.last_scheduled_post,
      
      bot_verification: (latestResult.bot_verification || wpStats.wpBlocked) ? 1 : 0,

      // 🔥 LANGKAH 1: Tambahkan baris ini untuk menyimpan flag 'rest_fallback'
      rest_fallback: wpStats.rest_fallback || 0,
	  // used_rest_backup: wpStats.used_rest_backup || 0,
    };
    
    await insertResult(newResult);
    await updateLastCheckTime(row.id, 'rest', now);

    console.log(`[${nowLog()}] 🔄 [REST CHECK] ${row.label} | Posts: ${wpStats.postsCount}, Future: ${wpStats.futureCount}, REST HTTP: ${wpStats.wpHttpStatus}`);
  } catch (e) {
    console.error(`[${nowLog()}] ❌ [REST FAILED] ${row.label} | Error: ${e.message}`);
  }
}

async function runDailyWhoisCheck() {
  const settings = getSettings();
  if (!settings.enabled || !settings.trigger_whois) return;
  console.log(`[${nowLog()}] 🗓️  [WHOIS CHECK] Starting daily check for expiring domains...`);
  const domains = listDomains().filter(d => d.is_enabled === 1 && d.whois_expiry);
  for (const domain of domains) {
    try {
      const expiryDate = new Date(domain.whois_expiry);
      const daysLeft = Math.ceil((expiryDate.getTime() - Date.now()) / (1000 * 60 * 60 * 24));
      if (daysLeft > 0 && daysLeft <= settings.whois_days) {
        queueNotification('WHOIS', domain);
      }
    } catch (e) {
      console.error(`[${nowLog()}] ❌ [WHOIS FAILED] Error checking expiry for ${domain.label}: ${e.message}`);
    }
  }
}

async function runDailyContentCheck() {
  const settings = getSettings();
  if (!settings.enabled || !settings.trigger_content_schedule) return;
  
  const threshold = settings.content_schedule_threshold ?? 0;
  console.log(`[${nowLog()}] 📝 [CONTENT CHECK] Starting daily check for domains with <= ${threshold} scheduled posts...`);
  
  const domains = listDomains().filter(d => d.is_enabled);
  let domainsToNotify = [];

  for (const domain of domains) {
      const latestResult = getLatestResult(domain.id);
      // Cek jika future_count valid (bukan null) dan di bawah atau sama dengan ambang batas
      if (latestResult && latestResult.future_count !== null && latestResult.future_count <= threshold && latestResult.posts_count !== null) {
          // Sertakan future_count saat ini untuk digunakan di pesan notifikasi
          const domainWithInfo = { ...domain, future_count: latestResult.future_count };
          domainsToNotify.push(domainWithInfo);
      }
  }

  if (domainsToNotify.length > 0) {
    // Masukkan semua domain yang memenuhi kriteria ke antrian
    domainsToNotify.forEach(d => {
      queueNotification('CONTENT_SCHEDULE', d);
    });
  }
}

export { sendWaNotification };

export function scheduleAll(env) {
  [generalTimers, restTimers, whoisTimers, contentTimers].forEach(timerMap => {
    for (const h of timerMap.values()) clearInterval(h);
    timerMap.clear();
  });
  const rows = listDomains().filter(d => d.is_enabled === 1);
  console.log(`[${nowLog()}] 🚀 Scheduler starting for ${rows.length} enabled domains...`);
  for (const row of rows) {
    scheduleDomain(row, env);
  }
  const dailyCheckInterval = 24 * 60 * 60 * 1000;
  setTimeout(runDailyWhoisCheck, 5 * 60 * 1000);
  setTimeout(runDailyContentCheck, 5 * 60 * 1000 + 10000);
  const whoisHandle = setInterval(runDailyWhoisCheck, dailyCheckInterval);
  whoisTimers.set('daily', whoisHandle);
  const contentHandle = setInterval(runDailyContentCheck, dailyCheckInterval);
  contentTimers.set('daily', contentHandle);
}

function scheduleDomain(row, env) {
  if (!row || row.is_enabled !== 1) return;
  const generalMinutes = Math.max(1, parseInt(row.check_interval_minutes || 30, 10));
  if (generalTimers.has(row.id)) clearInterval(generalTimers.get(row.id));
  const initialGeneralDelay = Math.floor(Math.random() * 20000);
  setTimeout(() => runGeneralScan(row, env), initialGeneralDelay);
  const generalHandle = setInterval(() => runGeneralScan(row, env), generalMinutes * 60 * 1000);
  generalTimers.set(row.id, generalHandle);
  const restMinutes = Math.max(1, parseInt(row.rest_check_interval_minutes || 600, 10));
  if (restTimers.has(row.id)) clearInterval(restTimers.get(row.id));
  const initialRestDelay = Math.floor(Math.random() * 30000);
  setTimeout(() => runRestScan(row, env), initialRestDelay);
  const restHandle = setInterval(() => runRestScan(row, env), restMinutes * 60 * 1000);
  restTimers.set(row.id, restHandle);
}

export function rescheduleOne(row, env) {
  cancelOne(row.id);
  if (row.is_enabled) {
    scheduleDomain(row, env);
    console.log(`[${nowLog()}] 🗓️ RESCHEDULED: ${row.label}`);
  }
}

export function cancelOne(id) {
  if (generalTimers.has(id)) {
    clearInterval(generalTimers.get(id));
    generalTimers.delete(id);
  }
  if (restTimers.has(id)) {
    clearInterval(restTimers.get(id));
    restTimers.delete(id);
  }
}