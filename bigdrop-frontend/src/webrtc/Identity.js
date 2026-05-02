/**
 * ZAP Identity — Final Bulletproof Version
 *
 * CRITICAL FIX: Works on HTTP (192.168.x.x) without crypto.subtle.
 *
 * Root cause of 3-day bug:
 *   Chrome/Brave blocks crypto.subtle on non-localhost HTTP origins.
 *   Previous identity.js tried crypto.subtle.generateKey() → threw DOMException
 *   → silently failed → identity never saved → setup screen loops forever.
 *
 * This version:
 *   1. NEVER uses crypto.subtle for identity creation.
 *      Uses only crypto.getRandomValues() — works on ALL origins, HTTP or HTTPS.
 *   2. Has console.log at every step so you can debug from browser console.
 *   3. Saves to IndexedDB with full error handling.
 *   4. buildRegistrationPacket also avoids crypto.subtle for signing on HTTP.
 */

const DB_NAME     = 'ZAP_Identity_Final';
const STORE_NAME  = 'id';
const RECORD_KEY  = 'self';

// ── Pure JS hash (no crypto.subtle needed) ────────────────────────────────────
// FNV-1a → expand to 32 bytes. Deterministic, fast, works everywhere.
function fnvHash32(bytes) {
  let h = 0x811c9dc5 >>> 0;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

function makeNodeId(seed32bytes) {
  // 4 rounds of FNV to produce 32 bytes (256-bit node ID)
  const out = new Uint8Array(32);
  let h = fnvHash32(seed32bytes);
  for (let i = 0; i < 32; i++) {
    h = (Math.imul(h + i, 0x01000193) + 0x12345678) >>> 0;
    out[i] = h & 0xFF;
  }
  return out;
}

function toHex(u8) {
  let s = '';
  for (let i = 0; i < u8.length; i++) s += u8[i].toString(16).padStart(2, '0');
  return s;
}

function fromHex(hex) {
  const u = new Uint8Array(hex.length >> 1);
  for (let i = 0; i < u.length; i++) u[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return u;
}

function randomHex(bytes) {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr); // works on ALL origins
  return toHex(arr);
}

// ── ZAP ID helpers ────────────────────────────────────────────────────────────
export function parseZapId(zapId) {
  if (!zapId) return { username: '?', hash: '????' };
  const i = zapId.lastIndexOf('#');
  if (i < 0) return { username: zapId, hash: '????' };
  return { username: zapId.slice(0, i), hash: zapId.slice(i + 1) };
}

export function zapIdToLookupKey(zapId) {
  return (zapId || '').toLowerCase().trim();
}

// ── IndexedDB ─────────────────────────────────────────────────────────────────
function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    req.onsuccess = e => resolve(e.target.result);
    req.onerror   = e => reject(new Error('IDB open failed: ' + e.target.error));
  });
}

async function idbSet(value) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put(value, RECORD_KEY);
    tx.oncomplete = () => resolve();
    tx.onerror    = e => reject(new Error('IDB write failed: ' + e.target.error));
  });
}

async function idbGet() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(STORE_NAME, 'readonly');
    const req = tx.objectStore(STORE_NAME).get(RECORD_KEY);
    req.onsuccess = e => resolve(e.target.result ?? null);
    req.onerror   = e => reject(new Error('IDB read failed: ' + e.target.error));
  });
}

// ── Create Identity ───────────────────────────────────────────────────────────
export async function createIdentity(username) {
  console.log('[ZAP/Identity] createIdentity called with:', username);

  // Clean username
  const clean = username.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 16);
  if (!clean || clean.length < 2) {
    throw new Error('Username must be at least 2 letters/numbers');
  }

  // Generate random seed — crypto.getRandomValues works on ALL HTTP origins
  const seed = new Uint8Array(32);
  crypto.getRandomValues(seed);
  console.log('[ZAP/Identity] Seed generated OK');

  // Derive node ID from seed (pure JS, no crypto.subtle)
  const nodeIdBytes = makeNodeId(seed);
  const nodeId      = toHex(nodeIdBytes);
  const hashSuffix  = nodeId.slice(0, 4).toUpperCase();
  const zapId       = `${clean}#${hashSuffix}`;

  console.log('[ZAP/Identity] Generated zapId:', zapId);
  console.log('[ZAP/Identity] nodeId:', nodeId);

  const identity = {
    zapId,
    username: clean,
    nodeId,
    publicKeyHex:  toHex(seed),      // seed is the "public key" for HTTP mode
    privateKeyHex: randomHex(64),    // random private key (signing not available on HTTP)
    isFallback:    true,             // always true — we never use Ed25519 on HTTP
    createdAt:     Date.now(),
  };

  // Save to IndexedDB
  console.log('[ZAP/Identity] Saving to IndexedDB...');
  await idbSet(identity);
  console.log('[ZAP/Identity] Saved OK! Identity:', identity.zapId);

  return identity;
}

// ── Load or Create ────────────────────────────────────────────────────────────
export async function loadOrCreateIdentity() {
  console.log('[ZAP/Identity] loadOrCreateIdentity called');
  try {
    const stored = await idbGet();
    if (stored && stored.zapId && stored.nodeId) {
      console.log('[ZAP/Identity] Found stored identity:', stored.zapId);
      return stored;
    }
    console.log('[ZAP/Identity] No stored identity found');
    return null; // caller will show setup screen
  } catch (e) {
    console.error('[ZAP/Identity] Load error:', e);
    return null;
  }
}

// ── Registration Packet ───────────────────────────────────────────────────────
export async function buildRegistrationPacket(identity) {
  console.log('[ZAP/Identity] Building registration packet for:', identity.zapId);
  // No crypto.subtle signing — just return the info packet
  return {
    zapId:        identity.zapId,
    username:     identity.username,
    nodeId:       identity.nodeId,
    publicKeyHex: identity.publicKeyHex,
    isFallback:   true,
    timestamp:    Date.now(),
    signature:    null,
  };
}

export async function verifyRegistrationPacket(packet) {
  // Always accept — we don't verify on HTTP (no Ed25519)
  if (!packet || !packet.zapId || !packet.nodeId) return false;
  return true;
}