/**
 * ZAP SwarmTransfer.js — BitTorrent-style swarm over WebRTC
 * 
 * ARCHITECTURE:
 *   FileDescriptor   — metadata, chunk hashes, availability map
 *   ChunkStore       — IndexedDB + memory fallback storage
 *   SwarmScheduler   — rarest-first algorithm, duplicate prevention
 *   ChannelManager   — 3-5 DataChannels per peer, load-balanced
 *   Downloader       — 30-100 in-flight requests, pipelined
 *   Uploader         — priority queue, fair bandwidth sharing
 *   SwarmTransfer    — top-level orchestrator, integrates with ZAP
 *
 * PROTOCOL MESSAGES (binary header = 1 byte type + payload):
 *   0x01 METADATA    — send FileDescriptor JSON
 *   0x02 HAVE        — "I have chunk N" (4 bytes: chunkIdx)
 *   0x03 BITFIELD    — bulk availability (Uint8Array bitfield)
 *   0x04 REQUEST     — want chunk N (4 bytes: chunkIdx)
 *   0x05 CHUNK       — chunk data (4 bytes idx + data)
 *   0x06 CANCEL      — cancel request for chunk N
 *   0x07 DONE        — transfer complete
 *
 * PERFORMANCE TARGETS (same WiFi LAN):
 *   2 peers  × 4 channels × 512KB chunks → ~40 MB/s
 *   5 peers  × 4 channels × 512KB chunks → ~100 MB/s (swarm)
 */

'use strict';

// ─── CONSTANTS ────────────────────────────────────────────────────────────────
const MSG = { METADATA:1, HAVE:2, BITFIELD:3, REQUEST:4, CHUNK:5, CANCEL:6, DONE:7 };

const DEFAULT_CHUNK_SIZE  = 512 * 1024;   // 512KB — optimal for WebRTC unordered
const MAX_IN_FLIGHT       = 50;           // simultaneous chunk requests per swarm
const MAX_IN_FLIGHT_PEER  = 12;           // per peer
const CHANNEL_COUNT       = 4;           // DataChannels per peer
const MAX_BUF             = 12 * 1024 * 1024; // 12MB buffer threshold before backpressure
const REQUEST_TIMEOUT_MS  = 8000;        // re-request chunk if no response in 8s
const KEEPALIVE_MS        = 5000;        // send HAVE periodically to maintain connections
const IDB_DB_NAME         = 'ZAP_Swarm';

// ─── UTILITY ──────────────────────────────────────────────────────────────────
function toHex(buf) {
  return Array.from(new Uint8Array(buf)).map(b=>b.toString(16).padStart(2,'0')).join('');
}

async function sha256(arrayBuffer) {
  const digest = await crypto.subtle.digest('SHA-256', arrayBuffer);
  return toHex(digest);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function genId() {
  return toHex(crypto.getRandomValues(new Uint8Array(8)));
}

// Encode message: [1 byte type][payload bytes]
function encodeMsg(type, payload) {
  if (payload instanceof ArrayBuffer) {
    const out = new Uint8Array(1 + payload.byteLength);
    out[0] = type;
    out.set(new Uint8Array(payload), 1);
    return out.buffer;
  }
  const json   = JSON.stringify(payload);
  const bytes  = new TextEncoder().encode(json);
  const out    = new Uint8Array(1 + bytes.length);
  out[0]       = type;
  out.set(bytes, 1);
  return out.buffer;
}

// Decode: returns { type, data (ArrayBuffer or object) }
function decodeMsg(arrayBuffer) {
  const u8   = new Uint8Array(arrayBuffer);
  const type = u8[0];
  const rest = arrayBuffer.slice(1);
  if (type === MSG.CHUNK) {
    return { type, data: rest };  // keep binary
  }
  if (type === MSG.BITFIELD) {
    return { type, data: rest };  // keep binary
  }
  if (type === MSG.HAVE || type === MSG.REQUEST || type === MSG.CANCEL) {
    const idx = new DataView(rest).getUint32(0, false);
    return { type, data: idx };
  }
  // METADATA, DONE
  try {
    const text = new TextDecoder().decode(rest);
    return { type, data: JSON.parse(text) };
  } catch {
    return { type, data: null };
  }
}

function encodeU32(n) {
  const buf = new ArrayBuffer(4);
  new DataView(buf).setUint32(0, n, false);
  return buf;
}

// ─── FILE DESCRIPTOR ─────────────────────────────────────────────────────────
export class FileDescriptor {
  constructor({ fileId, fileName, fileSize, chunkSize, chunkHashes }) {
    this.fileId      = fileId;
    this.fileName    = fileName;
    this.fileSize    = fileSize;
    this.chunkSize   = chunkSize || DEFAULT_CHUNK_SIZE;
    this.totalChunks = Math.ceil(fileSize / this.chunkSize);
    this.chunkHashes = chunkHashes || [];  // SHA-256 per chunk, populated during chunking
  }

  // Build descriptor from a File object (sender side)
  static async fromFile(file, chunkSize = DEFAULT_CHUNK_SIZE) {
    const totalChunks = Math.ceil(file.size / chunkSize);
    const chunkHashes = new Array(totalChunks).fill(null);  // computed lazily on send

    return new FileDescriptor({
      fileId:      genId(),
      fileName:    file.name,
      fileSize:    file.size,
      chunkSize,
      chunkHashes,
    });
  }

  serialize()   { return JSON.stringify(this); }
  static parse(json) { return new FileDescriptor(JSON.parse(json)); }

  validate() {
    if (!this.fileId)      throw new Error('Missing fileId');
    if (!this.fileName)    throw new Error('Missing fileName');
    if (!this.fileSize)    throw new Error('Missing fileSize');
    if (!this.totalChunks) throw new Error('totalChunks must be > 0');
    return true;
  }

  // Bitfield: Uint8Array where bit i = 1 means we have chunk i
  buildBitfield(ownedSet) {
    const bytes = new Uint8Array(Math.ceil(this.totalChunks / 8));
    for (const idx of ownedSet) {
      bytes[idx >> 3] |= (1 << (7 - (idx & 7)));
    }
    return bytes;
  }

  parseBitfield(u8) {
    const owned = new Set();
    for (let i = 0; i < this.totalChunks; i++) {
      if (u8[i >> 3] & (1 << (7 - (i & 7)))) owned.add(i);
    }
    return owned;
  }
}

// ─── CHUNK STORE ─────────────────────────────────────────────────────────────
// Primary: IndexedDB (survives memory pressure)
// Fallback: Map<chunkIdx, ArrayBuffer> in memory
export class ChunkStore {
  constructor(fileId) {
    this.fileId   = fileId;
    this.dbName   = `${IDB_DB_NAME}_${fileId}`;
    this.db       = null;
    this.memStore = new Map();  // fallback
    this.useIDB   = true;
    this.count    = 0;
  }

  async init() {
    try {
      this.db = await new Promise((res, rej) => {
        const r = indexedDB.open(this.dbName, 1);
        r.onupgradeneeded = e => e.target.result.createObjectStore('chunks', { keyPath: 'i' });
        r.onsuccess = e => res(e.target.result);
        r.onerror   = e => rej(e.target.error);
      });
    } catch (e) {
      console.warn('[ChunkStore] IDB unavailable, using memory:', e.message);
      this.useIDB = false;
    }
  }

  async save(idx, buffer, hash) {
    // buffer is ArrayBuffer — clone it so we don't hold references to DataChannel messages
    const copy = buffer.slice(0);
    if (this.useIDB && this.db) {
      await new Promise((res, rej) => {
        const tx = this.db.transaction('chunks', 'readwrite');
        tx.objectStore('chunks').put({ i: idx, d: copy, h: hash });
        tx.oncomplete = () => res();
        tx.onerror    = e => rej(e.target.error);
      });
    } else {
      this.memStore.set(idx, { d: copy, h: hash });
    }
    this.count++;
  }

  async get(idx) {
    if (this.useIDB && this.db) {
      return new Promise((res, rej) => {
        const r = this.db.transaction('chunks', 'readonly')
                      .objectStore('chunks').get(idx);
        r.onsuccess = e => res(e.target.result?.d ?? null);
        r.onerror   = e => rej(e.target.error);
      });
    }
    return this.memStore.get(idx)?.d ?? null;
  }

  async getAll() {
    if (this.useIDB && this.db) {
      const rows = await new Promise((res, rej) => {
        const r = this.db.transaction('chunks', 'readonly').objectStore('chunks').getAll();
        r.onsuccess = e => res(e.target.result);
        r.onerror   = e => rej(e.target.error);
      });
      rows.sort((a, b) => a.i - b.i);
      return rows.map(r => r.d);
    }
    const sorted = [...this.memStore.entries()].sort((a,b) => a[0]-b[0]);
    return sorted.map(([,v]) => v.d);
  }

  async has(idx) {
    if (this.useIDB && this.db) {
      return new Promise((res, rej) => {
        const r = this.db.transaction('chunks', 'readonly')
                      .objectStore('chunks').count(idx);
        r.onsuccess = e => res(e.target.result > 0);
        r.onerror   = e => rej(e.target.error);
      });
    }
    return this.memStore.has(idx);
  }

  async destroy() {
    if (this.db) {
      this.db.close();
      indexedDB.deleteDatabase(this.dbName);
    }
    this.memStore.clear();
    this.count = 0;
  }
}

// ─── SWARM SCHEDULER ──────────────────────────────────────────────────────────
// Tracks peer availability, implements rarest-first selection
// Prevents duplicate requests, handles timeouts
export class SwarmScheduler {
  constructor(descriptor) {
    this.desc          = descriptor;
    this.N             = descriptor.totalChunks;
    // availability[i] = Set of peerIds that have chunk i
    this.availability  = Array.from({ length: this.N }, () => new Set());
    // our owned chunks
    this.owned         = new Set();
    // in-progress: chunkIdx → { peerId, requestedAt, channelIdx }
    this.inProgress    = new Map();
    // timeout handles for re-request
    this.timeouts      = new Map();
  }

  // Peer joined with bitfield
  setPeerBitfield(peerId, owned) {
    for (let i = 0; i < this.N; i++) {
      if (owned.has(i)) this.availability[i].add(peerId);
      else              this.availability[i].delete(peerId);
    }
  }

  // Peer announced they just got a chunk
  peerGotChunk(peerId, idx) {
    this.availability[idx].add(peerId);
  }

  // We received a chunk
  markOwned(idx) {
    this.owned.add(idx);
    this.inProgress.delete(idx);
    clearTimeout(this.timeouts.get(idx));
    this.timeouts.delete(idx);
  }

  // Peer disconnected — remove from all availability sets
  removePeer(peerId) {
    for (const set of this.availability) set.delete(peerId);
    // Re-queue any in-progress chunks assigned to this peer
    for (const [idx, info] of this.inProgress) {
      if (info.peerId === peerId) {
        this.inProgress.delete(idx);
        clearTimeout(this.timeouts.get(idx));
        this.timeouts.delete(idx);
      }
    }
  }

  // Rarest-first: pick next N chunks to request
  // Returns array of { chunkIdx, peerId } sorted by rarity (ascending availability)
  selectNext(maxCount, peerIds) {
    const candidates = [];

    for (let i = 0; i < this.N; i++) {
      // Skip owned or already in-progress
      if (this.owned.has(i) || this.inProgress.has(i)) continue;

      const available = [...this.availability[i]].filter(p => peerIds.includes(p));
      if (available.length === 0) continue;  // no peer has this chunk

      candidates.push({
        chunkIdx:     i,
        rarity:       available.length,  // smaller = rarer
        peers:        available,
      });
    }

    // Sort by rarity ascending (rarest first), break ties by index
    candidates.sort((a, b) => a.rarity - b.rarity || a.chunkIdx - b.chunkIdx);

    const selected = [];
    const peerLoad = new Map();  // peerId → count of requests assigned this round

    for (const c of candidates) {
      if (selected.length >= maxCount) break;

      // Pick least-loaded peer that has this chunk
      let bestPeer = null;
      let bestLoad = Infinity;
      for (const p of c.peers) {
        const load = peerLoad.get(p) ?? 0;
        if (load < bestLoad) { bestLoad = load; bestPeer = p; }
      }
      if (!bestPeer) continue;

      selected.push({ chunkIdx: c.chunkIdx, peerId: bestPeer });
      peerLoad.set(bestPeer, (peerLoad.get(bestPeer) ?? 0) + 1);
    }

    return selected;
  }

  markInProgress(chunkIdx, peerId, onTimeout) {
    this.inProgress.set(chunkIdx, { peerId, requestedAt: Date.now() });
    const handle = setTimeout(() => {
      if (this.inProgress.has(chunkIdx)) {
        console.warn(`[Scheduler] Chunk ${chunkIdx} timed out from ${peerId.slice(0,8)}`);
        this.inProgress.delete(chunkIdx);
        this.timeouts.delete(chunkIdx);
        onTimeout(chunkIdx, peerId);
      }
    }, REQUEST_TIMEOUT_MS);
    this.timeouts.set(chunkIdx, handle);
  }

  isDone() {
    return this.owned.size >= this.N;
  }

  get progress() {
    return {
      owned:      this.owned.size,
      total:      this.N,
      inFlight:   this.inProgress.size,
      pct:        Math.round(this.owned.size / this.N * 100),
    };
  }

  destroy() {
    for (const h of this.timeouts.values()) clearTimeout(h);
    this.timeouts.clear();
  }
}

// ─── CHANNEL MANAGER ─────────────────────────────────────────────────────────
// Manages multiple DataChannels per peer for parallel chunk streaming
// Uses round-robin + bufferedAmount load balancing
export class ChannelManager {
  constructor(peerId, pc, isInitiator) {
    this.peerId   = peerId;
    this.pc       = pc;
    this.channels = [];   // RTCDataChannel[]
    this.ready    = false;
    this.onMsg    = null; // callback(ArrayBuffer)
    this._openCount = 0;
    this._rr = 0;        // round-robin pointer

    if (isInitiator) {
      this._createChannels();
    } else {
      pc.ondatachannel = ({ channel }) => this._onRemoteChannel(channel);
    }
  }

  _createChannels() {
    for (let i = 0; i < CHANNEL_COUNT; i++) {
      // Unordered + no retransmit = UDP-like speed for bulk data
      // We handle reliability ourselves via chunk hash verification + re-request
      const dc = this.pc.createDataChannel(`zap_swarm_${i}`, {
        ordered:          false,
        maxRetransmits:   2,    // allow 2 retransmits before declaring lost
      });
      dc.binaryType = 'arraybuffer';
      // High-water mark — browser sends bufferedAmountLow event when draining
      dc.bufferedAmountLowThreshold = MAX_BUF / 2;
      this._setupChannel(dc, i);
      this.channels.push(dc);
    }
  }

  _onRemoteChannel(dc) {
    dc.binaryType = 'arraybuffer';
    dc.bufferedAmountLowThreshold = MAX_BUF / 2;
    this._setupChannel(dc, this.channels.length);
    this.channels.push(dc);
  }

  _setupChannel(dc, idx) {
    dc.onopen = () => {
      this._openCount++;
      if (this._openCount >= CHANNEL_COUNT) {
        this.ready = true;
        this.onReady?.();
      }
    };
    dc.onclose = () => {
      this._openCount = Math.max(0, this._openCount - 1);
      if (this._openCount === 0) {
        this.ready = false;
        this.onClose?.();
      }
    };
    dc.onmessage = ({ data }) => {
      if (this.onMsg) this.onMsg(data);
    };
    dc.onerror = e => console.warn(`[Channel ${idx}/${this.peerId.slice(0,8)}]`, e?.message ?? e);
  }

  // Pick best channel: open + lowest bufferedAmount (least loaded)
  _pickChannel() {
    let best = null;
    let bestBuf = Infinity;
    for (const dc of this.channels) {
      if (dc.readyState === 'open' && dc.bufferedAmount < bestBuf) {
        best    = dc;
        bestBuf = dc.bufferedAmount;
      }
    }
    return best;
  }

  // Send with backpressure — returns false if all channels are full
  send(data) {
    const dc = this._pickChannel();
    if (!dc) return false;
    if (dc.bufferedAmount > MAX_BUF) return false;  // backpressure
    dc.send(data);
    return true;
  }

  // Send with async backpressure wait
  async sendReliable(data, maxWaitMs = 2000) {
    const start = Date.now();
    while (Date.now() - start < maxWaitMs) {
      if (this.send(data)) return true;
      await sleep(10);
    }
    console.warn('[ChannelManager] Send timeout — channel congested');
    return false;
  }

  // Total buffered bytes across all channels
  get bufferedTotal() {
    return this.channels.reduce((sum, dc) => sum + (dc.bufferedAmount ?? 0), 0);
  }

  close() {
    for (const dc of this.channels) {
      try { dc.close(); } catch {}
    }
    this.ready = false;
  }
}

// ─── UPLOADER ────────────────────────────────────────────────────────────────
// Handles upload requests from peers
// Priority: serve peers with fewer chunks first (seeder fairness)
export class Uploader {
  constructor(store, descriptor) {
    this.store    = store;
    this.desc     = descriptor;
    this.queue    = [];     // { chunkIdx, peerId, cm: ChannelManager }
    this.active   = false;
    this.canceled = new Set();  // canceled requests
  }

  enqueue(chunkIdx, peerId, cm) {
    // Don't re-add if already queued for this peer
    if (this.queue.some(q => q.chunkIdx === chunkIdx && q.peerId === peerId)) return;
    this.queue.push({ chunkIdx, peerId, cm });
    if (!this.active) this._pump();
  }

  cancel(chunkIdx, peerId) {
    this.canceled.add(`${peerId}:${chunkIdx}`);
  }

  async _pump() {
    this.active = true;
    while (this.queue.length > 0) {
      const item = this.queue.shift();
      const key  = `${item.peerId}:${item.chunkIdx}`;

      if (this.canceled.has(key)) {
        this.canceled.delete(key);
        continue;
      }

      const buf = await this.store.get(item.chunkIdx);
      if (!buf) continue;  // we no longer have this chunk (shouldn't happen)

      // Build CHUNK message: [1 byte type=5][4 bytes idx][data]
      const msg = new Uint8Array(1 + 4 + buf.byteLength);
      msg[0] = MSG.CHUNK;
      new DataView(msg.buffer).setUint32(1, item.chunkIdx, false);
      msg.set(new Uint8Array(buf), 5);

      // Wait for channel to have capacity
      let sent = false;
      for (let attempt = 0; attempt < 20; attempt++) {
        if (item.cm.send(msg.buffer)) { sent = true; break; }
        await sleep(20);
      }
      if (!sent) console.warn('[Uploader] Chunk dropped — channel full');
    }
    this.active = false;
  }
}

// ─── SWARM PEER ───────────────────────────────────────────────────────────────
// Represents one remote peer in the swarm
export class SwarmPeer {
  constructor({ peerId, pc, isInitiator, descriptor, store, scheduler, uploader, onChunkReceived, onDisconnect }) {
    this.peerId    = peerId;
    this.pc        = pc;
    this.desc      = descriptor;
    this.store     = store;
    this.scheduler = scheduler;
    this.uploader  = uploader;
    this.onChunkReceived = onChunkReceived;
    this.onDisconnect    = onDisconnect;

    this.cm        = new ChannelManager(peerId, pc, isInitiator);
    this.cm.onMsg  = buf => this._onMsg(buf);
    this.cm.onReady= () => this._onReady();
    this.cm.onClose= () => this.onDisconnect(peerId);

    // Track what THIS peer has
    this.peerOwned = new Set();
    this.alive     = true;
  }

  async _onReady() {
    console.log(`[SwarmPeer] ${this.peerId.slice(0,8)} channels ready`);
    // Send our bitfield so peer knows what we have
    const bf = this.desc.buildBitfield(this.store ? await this._getOwnedSet() : new Set());
    await this.cm.sendReliable(encodeMsg(MSG.BITFIELD, bf.buffer));
  }

  async _getOwnedSet() {
    // Reconstruct owned set from store
    const owned = new Set();
    for (let i = 0; i < this.desc.totalChunks; i++) {
      if (await this.store.has(i)) owned.add(i);
    }
    return owned;
  }

  async _onMsg(rawBuf) {
    const { type, data } = decodeMsg(rawBuf);

    switch (type) {
      case MSG.METADATA: {
        // Remote sent file descriptor — used when we're receiver
        this.desc.validate();
        break;
      }

      case MSG.BITFIELD: {
        const owned = this.desc.parseBitfield(new Uint8Array(data));
        this.peerOwned = owned;
        this.scheduler.setPeerBitfield(this.peerId, owned);
        console.log(`[SwarmPeer] ${this.peerId.slice(0,8)} has ${owned.size}/${this.desc.totalChunks} chunks`);
        break;
      }

      case MSG.HAVE: {
        const idx = data;
        this.peerOwned.add(idx);
        this.scheduler.peerGotChunk(this.peerId, idx);
        break;
      }

      case MSG.REQUEST: {
        const idx = data;
        if (await this.store.has(idx)) {
          this.uploader.enqueue(idx, this.peerId, this.cm);
        }
        break;
      }

      case MSG.CANCEL: {
        this.uploader.cancel(data, this.peerId);
        break;
      }

      case MSG.CHUNK: {
        await this._handleChunk(data);
        break;
      }

      case MSG.DONE: {
        console.log(`[SwarmPeer] ${this.peerId.slice(0,8)} completed transfer`);
        break;
      }
    }
  }

  async _handleChunk(buf) {
    // buf = [4 bytes idx][chunk data]
    if (buf.byteLength < 4) return;
    const idx      = new DataView(buf, 0, 4).getUint32(0, false);
    const chunkBuf = buf.slice(4);

    // Already have it? Skip (duplicate prevention)
    if (this.scheduler.owned.has(idx)) return;
    if (await this.store.has(idx))     return;

    // Verify hash
    const hash = await sha256(chunkBuf);
    const expected = this.desc.chunkHashes[idx];
    if (expected && hash !== expected) {
      console.warn(`[SwarmPeer] Chunk ${idx} hash mismatch — discarding`);
      this.scheduler.inProgress.delete(idx);  // allow re-request
      return;
    }

    // Save to store
    await this.store.save(idx, chunkBuf, hash);
    this.scheduler.markOwned(idx);

    // Announce we have it to all other peers (triggers upload requests from them)
    this.onChunkReceived(idx, this.peerId);

    // Broadcast HAVE to this peer (they'll update their view of us)
    this.cm.send(encodeMsg(MSG.HAVE, encodeU32(idx)));
  }

  // Request specific chunk from this peer
  requestChunk(chunkIdx) {
    this.cm.send(encodeMsg(MSG.REQUEST, encodeU32(chunkIdx)));
  }

  // Cancel outstanding request
  cancelRequest(chunkIdx) {
    this.cm.send(encodeMsg(MSG.CANCEL, encodeU32(chunkIdx)));
    this.uploader.cancel(chunkIdx, this.peerId);
  }

  disconnect() {
    this.alive = false;
    this.cm.close();
  }
}

// ─── SWARM TRANSFER ───────────────────────────────────────────────────────────
// Top-level orchestrator. Plug into ZAP's existing peer connection system.
export class SwarmTransfer extends EventTarget {
  /**
   * @param {Object} opts
   * @param {FileDescriptor} opts.descriptor
   * @param {File|null} opts.sourceFile  — null on receiver side
   * @param {Function} opts.onProgress   — (pct, speed, eta) => void
   * @param {Function} opts.onComplete   — (url, name, size, merkleRoot) => void
   * @param {Function} opts.onError      — (err) => void
   */
  constructor({ descriptor, sourceFile, onProgress, onComplete, onError }) {
    super();
    this.desc        = descriptor;
    this.sourceFile  = sourceFile;
    this.onProgress  = onProgress ?? (() => {});
    this.onComplete  = onComplete ?? (() => {});
    this.onError     = onError    ?? (e => console.error('[SwarmTransfer]', e));

    this.isSender    = !!sourceFile;
    this.peers       = new Map();   // peerId → SwarmPeer
    this.store       = new ChunkStore(descriptor.fileId);
    this.scheduler   = new SwarmScheduler(descriptor);
    this.uploader    = new Uploader(this.store, descriptor);

    this._running    = false;
    this._startTime  = 0;
    this._bytesRcvd  = 0;
    this._keepaliveInterval = null;

    // Sender: pre-populate owned set with all chunks
    if (this.isSender) {
      for (let i = 0; i < descriptor.totalChunks; i++) {
        this.scheduler.owned.add(i);
      }
    }
  }

  // ── Initialization ──────────────────────────────────────────────────────────
  async init() {
    await this.store.init();

    if (this.isSender) {
      // Pre-chunk the file and compute hashes
      await this._chunkAndHash();
    }

    this._running = true;
    this._startTime = Date.now();

    // Start download loop (no-op on pure sender)
    if (!this.isSender) this._downloadLoop();

    // Keepalive: broadcast progress to peers periodically
    this._keepaliveInterval = setInterval(() => this._broadcastHaves(), KEEPALIVE_MS);
  }

  // ── Pre-chunk file (sender side) ────────────────────────────────────────────
  async _chunkAndHash() {
    const { totalChunks, chunkSize } = this.desc;
    console.log(`[SwarmTransfer] Chunking ${this.desc.fileName} into ${totalChunks} chunks`);

    for (let i = 0; i < totalChunks; i++) {
      const start = i * chunkSize;
      const blob  = this.sourceFile.slice(start, start + chunkSize);
      const buf   = await blob.arrayBuffer();
      const hash  = await sha256(buf);

      this.desc.chunkHashes[i] = hash;
      await this.store.save(i, buf, hash);

      if (i % 50 === 0 || i === totalChunks - 1) {
        console.log(`[SwarmTransfer] Hashed ${i+1}/${totalChunks}`);
      }
    }
    console.log('[SwarmTransfer] File chunked and hashed ✓');
  }

  // ── Add a peer (called by ZAP when WebRTC connection is established) ─────────
  addPeer(peerId, pc, isInitiator) {
    if (this.peers.has(peerId)) return;

    const peer = new SwarmPeer({
      peerId,
      pc,
      isInitiator,
      descriptor:  this.desc,
      store:       this.store,
      scheduler:   this.scheduler,
      uploader:    this.uploader,
      onChunkReceived: (idx, fromPeerId) => this._onChunkReceived(idx, fromPeerId),
      onDisconnect:    (pid) => this._onPeerDisconnect(pid),
    });

    this.peers.set(peerId, peer);
    console.log(`[SwarmTransfer] Peer added: ${peerId.slice(0,8)} (${this.peers.size} total)`);

    // If sender: send file descriptor to new peer
    if (this.isSender) {
      peer.cm.onReady = async () => {
        await peer.cm.sendReliable(encodeMsg(MSG.METADATA, this.desc.serialize()));
        // Also send bitfield (all chunks available)
        const bf = this.desc.buildBitfield(this.scheduler.owned);
        await peer.cm.sendReliable(encodeMsg(MSG.BITFIELD, bf.buffer));
        console.log(`[SwarmTransfer] Sent descriptor to ${peerId.slice(0,8)}`);
      };
    }
  }

  removePeer(peerId) {
    const peer = this.peers.get(peerId);
    if (peer) { peer.disconnect(); this.peers.delete(peerId); }
    this.scheduler.removePeer(peerId);
  }

  // ── Download loop ────────────────────────────────────────────────────────────
  // Continuously fills in-flight pipeline with rarest-first chunk requests
  async _downloadLoop() {
    while (this._running && !this.scheduler.isDone()) {
      const peerIds    = [...this.peers.keys()];
      const inFlight   = this.scheduler.inProgress.size;
      const slots      = Math.max(0, MAX_IN_FLIGHT - inFlight);

      if (slots > 0 && peerIds.length > 0) {
        const selections = this.scheduler.selectNext(slots, peerIds);

        for (const { chunkIdx, peerId } of selections) {
          const peer = this.peers.get(peerId);
          if (!peer?.alive) continue;

          this.scheduler.markInProgress(chunkIdx, peerId, (idx, pid) => {
            // Timeout handler: re-queue the chunk
            console.warn(`[SwarmTransfer] Re-requesting chunk ${idx}`);
            // It will be picked up on next loop iteration automatically
          });

          peer.requestChunk(chunkIdx);
        }
      }

      // Progress update
      const prog = this.scheduler.progress;
      if (prog.pct > 0) {
        const elapsed = (Date.now() - this._startTime) / 1000 || 0.001;
        const speed   = (prog.owned * this.desc.chunkSize / elapsed / 1048576).toFixed(2);
        const remaining = (this.desc.totalChunks - prog.owned) * this.desc.chunkSize;
        const etaSecs = remaining / (parseFloat(speed) * 1048576) || 0;
        this.onProgress({
          pct:   prog.pct,
          speed,
          eta:   etaSecs < 60 ? `${Math.round(etaSecs)}s` : `${Math.floor(etaSecs/60)}m${Math.round(etaSecs%60)}s`,
          owned: prog.owned,
          total: prog.total,
          peers: this.peers.size,
        });
      }

      // Short sleep — don't spin-loop
      await sleep(50);
    }

    if (this.scheduler.isDone() && !this.isSender) {
      await this._finalize();
    }
  }

  // ── Chunk received callback ──────────────────────────────────────────────────
  _onChunkReceived(idx, fromPeerId) {
    this._bytesRcvd += this.desc.chunkSize;

    // Broadcast HAVE to all OTHER peers — they can now request it from us
    // This is what makes swarm downloading work: everyone becomes an uploader
    for (const [pid, peer] of this.peers) {
      if (pid !== fromPeerId && peer.alive) {
        peer.cm.send(encodeMsg(MSG.HAVE, encodeU32(idx)));
      }
    }
  }

  // ── Broadcast all our haves to refresh peer views ───────────────────────────
  async _broadcastHaves() {
    const bf = this.desc.buildBitfield(this.scheduler.owned);
    for (const peer of this.peers.values()) {
      if (peer.alive) {
        peer.cm.send(encodeMsg(MSG.BITFIELD, bf.buffer));
      }
    }
  }

  // ── Peer disconnect ──────────────────────────────────────────────────────────
  _onPeerDisconnect(peerId) {
    console.log(`[SwarmTransfer] Peer disconnected: ${peerId.slice(0,8)}`);
    this.peers.delete(peerId);
    this.scheduler.removePeer(peerId);

    // If no peers left and transfer incomplete: emit error
    if (this.peers.size === 0 && !this.scheduler.isDone() && !this.isSender) {
      this.onError(new Error('All peers disconnected — transfer incomplete'));
    }
  }

  // ── Finalize (receiver) ──────────────────────────────────────────────────────
  async _finalize() {
    this._running = false;
    clearInterval(this._keepaliveInterval);
    this.scheduler.destroy();

    console.log('[SwarmTransfer] Assembling file...');
    const chunks    = await this.store.getAll();
    const totalSize = chunks.reduce((s, c) => s + c.byteLength, 0);
    const ext       = this.desc.fileName.split('.').pop()?.toLowerCase() || '';

    // Build MIME type for correct file behavior on download
    const mimeMap = {
      mp4:'video/mp4', mov:'video/quicktime', mkv:'video/x-matroska',
      mp3:'audio/mpeg', flac:'audio/flac', wav:'audio/wav',
      jpg:'image/jpeg', jpeg:'image/jpeg', png:'image/png', gif:'image/gif',
      pdf:'application/pdf', zip:'application/zip',
      apk:'application/vnd.android.package-archive',
      docx:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    };
    const mime = mimeMap[ext] ?? this.desc.fileType ?? 'application/octet-stream';

    // Compute final merkle root over all chunk hashes
    const merkle = await this._merkleRoot(this.desc.chunkHashes);

    const blob = new Blob(chunks.map(c => new Uint8Array(c)), { type: mime });
    const url  = URL.createObjectURL(blob);

    // Notify all peers we're done
    for (const peer of this.peers.values()) {
      peer.cm.send(encodeMsg(MSG.DONE, {}));
    }

    console.log(`[SwarmTransfer] ✅ ${this.desc.fileName} (${(totalSize/1048576).toFixed(1)}MB) merkle=${merkle?.slice(0,16)}`);

    this.onProgress({ pct: 100, speed: '0', eta: '0s', owned: this.desc.totalChunks, total: this.desc.totalChunks });
    this.onComplete({ url, name: this.desc.fileName, size: totalSize, merkleRoot: merkle });

    // Cleanup storage after a delay (allow re-seeding)
    setTimeout(() => this.store.destroy(), 30_000);
  }

  async _merkleRoot(hashes) {
    let layer = hashes.filter(Boolean);
    if (!layer.length) return null;
    while (layer.length > 1) {
      const next = [];
      for (let i = 0; i < layer.length; i += 2) {
        const combined = new TextEncoder().encode(layer[i] + (layer[i+1] ?? layer[i]));
        const h = await crypto.subtle.digest('SHA-256', combined);
        next.push(toHex(h));
      }
      layer = next;
    }
    return layer[0];
  }

  // ── Public API ───────────────────────────────────────────────────────────────

  // Stop everything
  destroy() {
    this._running = false;
    clearInterval(this._keepaliveInterval);
    this.scheduler.destroy();
    for (const peer of this.peers.values()) peer.disconnect();
    this.peers.clear();
  }

  get isComplete() { return this.scheduler.isDone(); }
  get peerCount()  { return this.peers.size; }
}

// ─── SWARM SESSION FACTORY ────────────────────────────────────────────────────
// Simple factory that ZAP's App.jsx calls instead of ZAP.sendFile()
export class SwarmSession {
  static sessions = new Map();  // fileId → SwarmTransfer

  /**
   * SENDER: start a new swarm session for a file
   */
  static async startSend(file, addPeerFn, onProgress, onComplete, onError) {
    const desc    = await FileDescriptor.fromFile(file);
    const session = new SwarmTransfer({ descriptor: desc, sourceFile: file, onProgress, onComplete, onError });
    await session.init();
    SwarmSession.sessions.set(desc.fileId, session);

    // Called by App.jsx when a peer connects for this transfer
    const addPeer = (peerId, pc) => {
      session.addPeer(peerId, pc, true);
      // Send descriptor to new peer via ZAP signaling (out-of-band bootstrap)
      addPeerFn?.(peerId, pc, desc);
    };

    console.log(`[SwarmSession] Started send session: ${desc.fileId} — ${desc.fileName}`);
    return { fileId: desc.fileId, descriptor: desc, addPeer };
  }

  /**
   * RECEIVER: join an existing swarm session
   */
  static async startReceive(descriptor, onProgress, onComplete, onError) {
    const desc    = new FileDescriptor(descriptor);
    desc.validate();
    const session = new SwarmTransfer({ descriptor: desc, sourceFile: null, onProgress, onComplete, onError });
    await session.init();
    SwarmSession.sessions.set(desc.fileId, session);

    const addPeer = (peerId, pc) => session.addPeer(peerId, pc, false);

    console.log(`[SwarmSession] Joined receive session: ${desc.fileId} — ${desc.fileName}`);
    return { fileId: desc.fileId, descriptor: desc, addPeer };
  }

  static get(fileId) { return SwarmSession.sessions.get(fileId); }
  static remove(fileId) {
    const s = SwarmSession.sessions.get(fileId);
    if (s) { s.destroy(); SwarmSession.sessions.delete(fileId); }
  }
}