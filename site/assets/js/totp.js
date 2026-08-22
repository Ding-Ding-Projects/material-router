/* Local RFC 6238 TOTP for site tab locks. Secrets live only in this
   browser's localStorage under the site namespace and never leave the
   machine. The desktop app's authenticator renders pairing QR codes; this
   static, zero-dependency site supports manual base32 entry and pasted
   otpauth:// URIs instead (stated in the lock dialog). */

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Decode(input) {
  const clean = String(input || '').toUpperCase().replace(/[\s-]/g, '').replace(/=+$/, '');
  if (!clean.length || /[^A-Z2-7]/.test(clean)) return null;
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of clean) {
    value = (value << 5) | BASE32_ALPHABET.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

export function base32Encode(bytes) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32ALPHABET_PAD((value << (5 - bits)) & 31);
  return out;
}
function BASE32ALPHABET_PAD(v) { return BASE32_ALPHABET[v]; }

/* Parse an otpauth:// URI; returns {secret, digits, period} or null. */
export function parseOtpauth(uri) {
  try {
    if (!/^otpauth:\/\/totp\//i.test(uri)) return null;
    const url = new URL(uri.replace(/^otpauth:/i, 'https:'));
    const secret = url.searchParams.get('secret');
    if (!secret) return null;
    const digits = Number(url.searchParams.get('digits') || 6);
    const period = Number(url.searchParams.get('period') || 30);
    return {
      secret,
      digits: [6, 7, 8].includes(digits) ? digits : 6,
      period: Math.max(15, Math.min(120, period)),
    };
  } catch {
    return null;
  }
}

async function hmacSha1(keyBytes, messageBytes) {
  const key = await crypto.subtle.importKey(
    'raw',
    keyBytes.buffer.slice(keyBytes.byteOffset, keyBytes.byteOffset + keyBytes.byteLength),
    { name: 'HMAC', hash: 'SHA-1' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, messageBytes);
  return new Uint8Array(sig);
}

/* Current TOTP code for a base32 secret. */
export async function totpNow(secretB32, { digits = 6, period = 30, atMs = Date.now() } = {}) {
  const keyBytes = base32Decode(secretB32);
  if (!keyBytes || !keyBytes.length) throw new Error('invalid secret');
  const counter = Math.floor(atMs / 1000 / period);
  const msg = new Uint8Array(8);
  for (let i = 7; i >= 0; i -= 1) {
    msg[i] = counter % 256;
    counter /= 256;
  }
  const mac = await hmacSha1(keyBytes, msg);
  const offset = mac[mac.length - 1] & 0x0f;
  const bin = ((mac[offset] & 0x7f) << 24)
    | ((mac[offset + 1] & 0xff) << 16)
    | ((mac[offset + 2] & 0xff) << 8)
    | (mac[offset + 3] & 0xff);
  return String(bin % (10 ** digits)).padStart(digits, '0');
}

/* Verify with a small clock-skew window of one period on either side. */
export async function verifyTotp(secretB32, code, { digits = 6, period = 30 } = {}) {
  const now = Date.now();
  for (const drift of [-period, 0, period]) {
    let expected;
    try {
      expected = await totpNow(secretB32, { digits, period, atMs: now + drift * 1000 });
    } catch {
      return false;
    }
    if (timingSafeEqual(expected, String(code))) return true;
  }
  return false;
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/* PBKDF2-SHA256 password verifier for password locks. */
export async function hashPassword(password, saltHex, iterations = 150000) {
  const enc = new TextEncoder();
  const salt = hexToBytes(saltHex);
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256);
  return bytesToHex(new Uint8Array(bits));
}
export function randomSalt() {
  const b = crypto.getRandomValues(new Uint8Array(16));
  return bytesToHex(b);
}
function hexToBytes(hexStr) {
  const out = new Uint8Array(hexStr.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = parseInt(hexStr.slice(i * 2, i * 2 + 2), 16);
  return out;
}
function bytesToHex(bytes) {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}
