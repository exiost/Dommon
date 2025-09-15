// src/crypto.js
import crypto from 'crypto';
import dotenv from 'dotenv';
dotenv.config();

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;

if (!process.env.ENCRYPTION_KEY || process.env.ENCRYPTION_KEY.length !== 64) {
  throw new Error('ENCRYPTION_KEY tidak ada atau formatnya salah. Harus berupa 64 karakter hex. Jalankan `node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"` untuk membuatnya.');
}
const KEY = Buffer.from(process.env.ENCRYPTION_KEY, 'hex');

export function encrypt(text) {
  if (!text) return text;
  try {
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(ALGORITHM, KEY, iv);
    const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([iv, tag, encrypted]).toString('hex');
  } catch (error) {
    console.error("Encryption failed:", error);
    return text;
  }
}

export function decrypt(hash) {
  if (!hash) return hash;

  // 🔥 PERBAIKAN UTAMA: Cek apakah hash terlihat seperti data terenkripsi atau tidak.
  // Data terenkripsi kita selalu dalam format hex dan panjangnya lebih dari 64 karakter.
  // Jika tidak sesuai, anggap itu password lama (teks biasa) dan kembalikan apa adanya.
  const isLikelyEncrypted = /^[0-9a-fA-F]{66,}$/.test(hash);
  if (!isLikelyEncrypted) {
    return hash; // Ini adalah password lama, jangan coba dekripsi.
  }

  try {
    const buffer = Buffer.from(hash, 'hex');
    const iv = buffer.slice(0, IV_LENGTH);
    const tag = buffer.slice(IV_LENGTH, IV_LENGTH + 16);
    const encrypted = buffer.slice(IV_LENGTH + 16);
    const decipher = crypto.createDecipheriv(ALGORITHM, KEY, iv);
    decipher.setAuthTag(tag);
    const decrypted = decipher.update(encrypted, 'hex', 'utf8') + decipher.final('utf8');
    return decrypted;
  } catch (error) {
    // Log error ini sekarang hanya akan muncul jika ada masalah dekripsi SUNGGUHAN, bukan karena password lama.
    console.error("Decryption failed for hash:", hash, error.message);
    return hash;
  }
}