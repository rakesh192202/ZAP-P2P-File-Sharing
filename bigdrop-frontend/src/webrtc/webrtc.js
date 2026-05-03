/**
 * ZAP WebRTC v9 — Hybrid Engine
 *
 * TWO modes:
 *   1. SIMPLE mode   — single file, 1-2 peers, <500MB → existing fast path
 *   2. SWARM mode    — large files, multiple peers, 500MB+ → SwarmTransfer engine
 *
 * Swarm mode is automatically activated when:
 *   - file.size > SWARM_THRESHOLD (500MB) OR
 *   - peers.size > 2 (multiple seeders available)
 *
 * Simple mode: 4 parallel DataChannels, ordered, 256KB chunks
 * Swarm mode:  SwarmTransfer.js handles everything (4 unordered channels, 512KB chunks)
 */

import { SwarmSession, FileDescriptor } from './SwarmTransfer.js';

const UA = navigator.userAgent;
const IS_IOS    = /iPhone|iPad|iPod/i.test(UA);
const IS_MOBILE = /Mobi|Android|iPhone|iPad/i.test(UA);

const PLATFORM = IS_IOS ? 'ios' : IS_MOBILE ? 'mobile' : 'desktop';
const PARAMS = {
  ios:     { chunkSize:  16*1024, numChan: 1, maxBuf:  512*1024 },
  mobile:  { chunkSize:  64*1024, numChan: 1, maxBuf: 1*1024*1024 },
  desktop: { chunkSize: 256*1024, numChan: 2, maxBuf: 3*1024*1024 },  // 2 channels + lower buf for internet
};
const P = PARAMS[PLATFORM];

export const CHUNK_SIZE   = P.chunkSize;
export const NUM_CHANNELS = P.numChan;
export const SWARM_THRESHOLD = 500 * 1024 * 1024;  // 500MB → use swarm

const HAS_FS  = typeof window !== 'undefined' && 'showSaveFilePicker' in window;
const CONN_TO = 120_000;  // 2 min — Render cold start can take 50s

const ICE_SERVERS = [
  // STUN servers (free, reliable)
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun2.l.google.com:19302' },
  { urls: 'stun:stun3.l.google.com:19302' },
  { urls: 'stun:stun.cloudflare.com:3478' },
  // Metered TURN — most reliable free option
  { urls: 'turn:openrelay.metered.ca:80',               username:'openrelayproject', credential:'openrelayproject' },
  { urls: 'turn:openrelay.metered.ca:443',              username:'openrelayproject', credential:'openrelayproject' },
  { urls: 'turn:openrelay.metered.ca:443?transport=tcp',username:'openrelayproject', credential:'openrelayproject' },
  // Backup TURN servers
  { urls: 'turn:relay1.expressturn.com:3478',           username:'efRXGDMKJ9VF5PRQKM', credential:'3XLbmVtVGfaXuYXZ' },
  { urls: 'turn:freestun.net:3478',                     username:'free',              credential:'free' },
  { urls: 'turn:freestun.net:5349',                     username:'free',              credential:'free' },
];

// ── NodeId ↔ ZapId Cache ──────────────────────────────────────────────────────
const nodeZapCache = new Map();
export function cacheNodeZapId(n, z) { nodeZapCache.set(n, z); }
export function getNodeZapId(n)      { return nodeZapCache.get(n) ?? null; }

// ── Global State ──────────────────────────────────────────────────────────────
const peers   = new Map();
const pending = new Map();

let _dhtSig    = null;
let _onNewPeer = null;
let _onStart   = null;
let _onReady   = null;
let _onProgress= null;
let _onConnect = null;
let _onDisconn = null;

export const setDHTSignaling      = fn => { _dhtSig    = fn; };
export const setNewPeerHandler    = fn => { _onNewPeer = fn; };
export const setFileStartHandler  = fn => { _onStart   = fn; };
export const setFileReadyHandler  = fn => { _onReady   = fn; };
export const setProgressHandler   = fn => { _onProgress= fn; };
export const setConnectHandler    = fn => { _onConnect = fn; };
export const setDisconnectHandler = fn => { _onDisconn = fn; };

// ── Peer State ────────────────────────────────────────────────────────────────
function mkState(id) {
  return {
    id, pc: null, ctrl: null, dataChs: [], status: 'init',
    recv: {
      meta: null, expected: 0, received: 0, bytes: 0,
      hashes: [], t0: 0, done: false,
      writable: null, useIDB: false,
      dbName: `ZAP9_${id.slice(0,12)}`, db: null,
    },
    send: { paused: false },
    timer: null,
  };
}

// ── Crypto ────────────────────────────────────────────────────────────────────
async function sha256hex(buf) {
  try { const h = await crypto.subtle.digest('SHA-256', buf); return Array.from(new Uint8Array(h)).map(b=>b.toString(16).padStart(2,'0')).join(''); }
  catch { return null; }
}
async function merkleRoot(hashes) {
  let l = hashes.filter(Boolean);
  if (!l.length) return null;
  while (l.length > 1) {
    const n = [];
    for (let i = 0; i < l.length; i += 2) {
      const h = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(l[i]+(l[i+1]??l[i])));
      n.push(Array.from(new Uint8Array(h)).map(b=>b.toString(16).padStart(2,'0')).join(''));
    }
    l = n;
  }
  return l[0];
}

// ── IDB ───────────────────────────────────────────────────────────────────────
function openIDB(state) {
  if (state.recv.db) return Promise.resolve(state.recv.db);
  return new Promise((res, rej) => {
    const r = indexedDB.open(state.recv.dbName, 1);
    r.onupgradeneeded = e => e.target.result.createObjectStore('c', {keyPath:'i'});
    r.onsuccess = e => { state.recv.db = e.target.result; res(e.target.result); };
    r.onerror   = e => rej(e.target.error);
  });
}
async function idbPut(state, buf, idx) {
  const db = await openIDB(state);
  return new Promise((res, rej) => {
    const tx = db.transaction('c','readwrite');
    tx.objectStore('c').put({ i: idx, d: buf instanceof ArrayBuffer ? buf.slice(0) : buf });
    tx.oncomplete = ()=>res(); tx.onerror = e=>rej(e.target.error);
  });
}
async function idbAssemble(state) {
  const db   = await openIDB(state);
  const rows = await new Promise((res,rej)=>{
    const r = db.transaction('c','readonly').objectStore('c').getAll();
    r.onsuccess = e=>res(e.target.result); r.onerror = e=>rej(e.target.error);
  });
  rows.sort((a,b)=>a.i-b.i);
  const ext  = state.recv.meta.name.split('.').pop()?.toLowerCase()||'';
  const mimes = {jpg:'image/jpeg',jpeg:'image/jpeg',png:'image/png',mp4:'video/mp4',
    mp3:'audio/mpeg',pdf:'application/pdf',zip:'application/zip',
    apk:'application/vnd.android.package-archive',
    docx:'application/vnd.openxmlformats-officedocument.wordprocessingml.document'};
  const mime  = mimes[ext] ?? state.recv.meta.fileType ?? 'application/octet-stream';
  const blob  = new Blob(rows.map(c=>new Uint8Array(c.d)), {type:mime});
  const url   = URL.createObjectURL(blob);
  db.transaction('c','readwrite').objectStore('c').clear();
  return { url, name:state.recv.meta.name, size:blob.size, mime, savedToDisk:false, isZip:ext==='zip' };
}

// ── Control Channel ───────────────────────────────────────────────────────────
function setupCtrl(dc, state) {
  dc.binaryType = 'arraybuffer';
  dc.onopen = () => {
    if (state.status !== 'open') {
      state.status = 'open'; clearTimeout(state.timer);
      console.log(`[ZAP] ✅ ${state.id.slice(0,12)} [${PLATFORM}]`);
      if (_onConnect) _onConnect(state.id);
    }
  };
  dc.onclose = () => {
    if (state.status === 'open') { state.status='closed'; if(_onDisconn)_onDisconn(state.id); }
  };
  dc.onerror = e => console.warn('[ZAP/ctrl]', e?.message ?? e);
  dc.onmessage = async ({data}) => {
    if (data instanceof ArrayBuffer) { await handleChunk(data, state); return; }
    if (typeof data !== 'string') return;
    let msg; try { msg = JSON.parse(data); } catch { return; }
    switch (msg.type) {
      case 'metadata': await handleMeta(msg, state); break;
      case 'EOF':      await finalizeFile(state);    break;
      case 'PAUSE':    state.send.paused = true;     break;
      case 'RESUME':   state.send.paused = false;    break;
    }
  };
}

function setupData(dc, state) {
  dc.binaryType = 'arraybuffer';
  dc.onmessage  = ({data}) => { if (data instanceof ArrayBuffer) handleChunk(data, state); };
  dc.onerror    = e => console.warn('[ZAP/data]', e?.message ?? e);
}

async function handleMeta(msg, state) {
  if (state.recv.writable) try { state.recv.writable.close(); } catch {}
  Object.assign(state.recv, {
    meta: msg, expected: msg.totalChunks, received: 0, bytes: 0,
    hashes: new Array(msg.totalChunks).fill(null), t0: Date.now(),
    done: false, writable: null, useIDB: false,
  });
  console.log(`[ZAP] 📥 ${msg.name} (${(msg.size/1048576).toFixed(1)}MB) — ${msg.totalChunks} chunks`);
  if (_onStart) _onStart(state.id, msg);
  if (HAS_FS) {
    try {
      const h = await window.showSaveFilePicker({ suggestedName: msg.name });
      state.recv.writable = await h.createWritable();
      console.log('[ZAP] FS API — direct disk streaming ✓');
      return;
    } catch {}
  }
  state.recv.useIDB = true;
}

async function handleChunk(data, state) {
  if (!state.recv.meta || state.recv.done) return;
  if (data.byteLength < 4) return;
  const idx = new DataView(data, 0, 4).getUint32(0, false);
  const buf = data.slice(4);
  state.recv.received++;
  state.recv.bytes += buf.byteLength;
  sha256hex(buf).then(h => { if (state.recv.hashes && idx < state.recv.hashes.length) state.recv.hashes[idx] = h; });
  if (!state.recv.useIDB && state.recv.writable) {
    try { await state.recv.writable.write({ type:'write', position: idx * CHUNK_SIZE, data: new Uint8Array(buf) }); }
    catch (e) { console.warn('[ZAP] FS fail→IDB:', e.message); state.recv.useIDB=true; state.recv.writable=null; await idbPut(state,buf,idx); }
  } else { await idbPut(state, buf, idx); }

  const pct   = Math.min(Math.round(state.recv.received/state.recv.expected*100), 99);
  const speed = (state.recv.bytes/((Date.now()-state.recv.t0)/1000||1)/1048576).toFixed(2);
  if (state.recv.received % Math.max(1, Math.floor(state.recv.expected/200)) === 0) {
    if (_onProgress) _onProgress(state.id, { pct, speed, name:state.recv.meta.name, bytes:state.recv.bytes, total:state.recv.meta.size });
  }
  if (state.recv.received >= state.recv.expected) await finalizeFile(state);
}

async function finalizeFile(state) {
  if (!state.recv.meta || state.recv.done) return;
  state.recv.done = true;
  await new Promise(r => setTimeout(r, 50));
  const mk   = await merkleRoot(state.recv.hashes).catch(()=>null);
  const meta = state.recv.meta;
  let result;
  if (!state.recv.useIDB && state.recv.writable) {
    try { await state.recv.writable.close(); } catch {}
    result = { name:meta.name, size:meta.size, savedToDisk:true, merkleRoot:mk, url:null, isZip:meta.name.endsWith('.zip') };
  } else {
    result = await idbAssemble(state);
    result.merkleRoot = mk;
  }
  if (_onProgress) _onProgress(state.id, { pct:100, speed:'0', name:meta.name, bytes:meta.size, total:meta.size });
  if (_onReady) _onReady(state.id, result);
  console.log(`[ZAP] ✅ ${meta.name} merkle=${mk?.slice(0,12)}`);
  Object.assign(state.recv, { meta:null, done:false, received:0, bytes:0, hashes:[], writable:null, useIDB:false });
}

// ── Build PC ──────────────────────────────────────────────────────────────────
function buildPC(nodeId, state, isInitiator) {
  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS, iceTransportPolicy:'all', iceCandidatePoolSize:10, bundlePolicy:'max-bundle' });
  state.pc = pc; state.status = 'connecting';
  state.timer = setTimeout(() => { if(state.status!=='open'){console.warn('[ZAP] timeout',nodeId.slice(0,12));closeConnection(nodeId);} }, CONN_TO);

  pc.onicecandidate = ({candidate}) => { if(candidate&&_dhtSig) _dhtSig(nodeId,{type:'candidate',candidate:candidate.toJSON()}); };
  pc.onicegatheringstatechange = () => console.log(`[ZAP/ICE gather] ${nodeId.slice(0,12)}: ${pc.iceGatheringState}`);
  pc.oniceconnectionstatechange = () => {
    const s = pc.iceConnectionState;
    console.log(`[ZAP/ICE conn]  ${nodeId.slice(0,12)}: ${s}`);
    if (s==='failed') { try{pc.restartIce();}catch{closeConnection(nodeId);} }
    if (s==='disconnected') setTimeout(()=>{ if(peers.get(nodeId)?.status!=='open') closeConnection(nodeId); }, 10_000);
  };
  pc.onconnectionstatechange = () => {
    const s = pc.connectionState;
    console.log(`[ZAP] ${nodeId.slice(0,12)} → ${s}`);
    if (s==='connected'&&state.status!=='open') { state.status='open'; clearTimeout(state.timer); if(_onConnect)_onConnect(nodeId); }
    if (s==='closed') { state.status='closed'; if(_onDisconn)_onDisconn(nodeId); }
  };

  if (isInitiator) {
    const ctrl = pc.createDataChannel('ctrl', { ordered: true, maxRetransmits: 30 });
    state.ctrl = ctrl; setupCtrl(ctrl, state);
    state.dataChs = [];
    for (let i = 1; i < P.numChan; i++) {
      const dc = pc.createDataChannel(`d${i}`, { ordered: true, maxRetransmits: 30 });
      state.dataChs.push(dc); setupData(dc, state);
    }
  } else {
    pc.ondatachannel = ({channel}) => {
      if (channel.label === 'ctrl') { state.ctrl = channel; setupCtrl(channel, state); }
      else { state.dataChs.push(channel); setupData(channel, state); }
    };
  }
  return pc;
}

// ── Connection ────────────────────────────────────────────────────────────────
export async function createPeerConnection(remoteId) {
  const ex = peers.get(remoteId);
  if (ex?.status==='open'||ex?.status==='connecting') return ex;
  const state = mkState(remoteId);
  peers.set(remoteId, state);
  buildPC(remoteId, state, true);
  try {
    const offer = await state.pc.createOffer();
    await state.pc.setLocalDescription(offer);
    if (_dhtSig) await _dhtSig(remoteId, { type:'offer', sdp:state.pc.localDescription });
    console.log(`[ZAP] offer → ${remoteId.slice(0,12)}`);
  } catch(e) { console.error('[ZAP/createPC]', e); closeConnection(remoteId); }
  return state;
}

export async function handleIncomingSignal(fromId, rawSignal) {
  let data = rawSignal;
  if (typeof data==='string') try{data=JSON.parse(data);}catch{}
  if (typeof data==='string') try{data=JSON.parse(data);}catch{}
  if (!data?.type) return;

  let state = peers.get(fromId);
  if (!state) {
    state = mkState(fromId); peers.set(fromId, state);
    buildPC(fromId, state, false);
    if (_onNewPeer) _onNewPeer(fromId);
  }
  const pc = state.pc; if (!pc) return;
  try {
    if (data.type==='offer') {
      if (pc.signalingState!=='stable') return;
      await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
      for (const c of pending.get(fromId)??[]) await pc.addIceCandidate(c).catch(()=>{});
      pending.delete(fromId);
      const ans = await pc.createAnswer();
      await pc.setLocalDescription(ans);
      if (_dhtSig) await _dhtSig(fromId, { type:'answer', sdp:pc.localDescription });
      console.log(`[ZAP] answer → ${fromId.slice(0,12)}`);
    } else if (data.type==='answer') {
      if (pc.signalingState==='have-local-offer') {
        await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
        for (const c of pending.get(fromId)??[]) await pc.addIceCandidate(c).catch(()=>{});
        pending.delete(fromId);
      }
    } else if (data.type==='candidate') {
      const c = new RTCIceCandidate(data.candidate);
      if (pc.remoteDescription) await pc.addIceCandidate(c).catch(()=>{});
      else { if(!pending.has(fromId))pending.set(fromId,[]); pending.get(fromId).push(c); }
    }
  } catch(e) { console.error('[ZAP/signal]', e.message); }
}

// ── sendFile — Auto-selects simple or swarm mode ──────────────────────────────
export async function sendFile(file, remoteId, onProgress) {
  const state = peers.get(remoteId);
  if (!state||state.status!=='open') throw new Error('Not connected');

  // SWARM MODE for large files
  if (file.size >= SWARM_THRESHOLD) {
    console.log(`[ZAP] 🌊 SWARM MODE — ${file.name} (${(file.size/1073741824).toFixed(2)}GB)`);
    return _sendSwarm(file, remoteId, onProgress);
  }

  // SIMPLE MODE for smaller files
  console.log(`[ZAP] ⚡ SIMPLE MODE — ${file.name} (${(file.size/1048576).toFixed(1)}MB)`);
  return _sendSimple(file, remoteId, onProgress);
}

// ── Simple mode (< 500MB) ─────────────────────────────────────────────────────
async function _sendSimple(file, remoteId, onProgress) {
  const state    = peers.get(remoteId);
  const dataChs  = state.dataChs.filter(dc => dc.readyState === 'open');
  const allChs   = dataChs.length > 0 ? dataChs : [state.ctrl];
  const ctrl     = state.ctrl;
  const total    = Math.ceil(file.size / CHUNK_SIZE);

  ctrl.send(JSON.stringify({ type:'metadata', name:file.name, fileType:file.type, size:file.size, totalChunks:total, ts:Date.now() }));
  await new Promise(r => setTimeout(r, IS_MOBILE ? 800 : 300));

  const t0 = Date.now(); let sent = 0;
  let nextIdx = 0;

  async function worker(ch) {
    while (true) {
      const i = nextIdx++;
      if (i >= total) break;
      while (state.send.paused) await new Promise(r=>setTimeout(r,50));
      while (ch.readyState==='open' && ch.bufferedAmount > P.maxBuf) await new Promise(r=>setTimeout(r,15));
      if (ch.readyState!=='open') { ch = ctrl; if(ctrl.readyState!=='open') throw new Error('All channels closed'); }
      const buf    = await file.slice(i*CHUNK_SIZE,(i+1)*CHUNK_SIZE).arrayBuffer();
      const tagged = new ArrayBuffer(4+buf.byteLength);
      new DataView(tagged).setUint32(0,i,false);
      new Uint8Array(tagged).set(new Uint8Array(buf),4);
      ch.send(tagged);
      sent += buf.byteLength;
      if (onProgress && i % Math.max(1,Math.floor(total/200))===0) {
        onProgress({ pct:Math.min(Math.round((i+1)/total*100),99), speed:((sent/((Date.now()-t0)/1000||0.001))/1048576).toFixed(2), name:file.name, bytes:sent, total:file.size });
      }
    }
  }

  await Promise.all(allChs.map(ch => worker(ch)));
  await Promise.all([...allChs,ctrl].map(ch => new Promise(res=>{
    const chk=()=>ch.readyState!=='open'||ch.bufferedAmount===0?res():setTimeout(chk,25); chk();
  })));
  // Small delay — let receiver process last chunks before EOF
  await new Promise(r => setTimeout(r, 400));
  ctrl.send(JSON.stringify({ type:'EOF', totalChunks:total }));
  // Send twice — internet connections can drop single messages
  await new Promise(r => setTimeout(r, 300));
  if (ctrl.readyState === 'open') ctrl.send(JSON.stringify({ type:'EOF', totalChunks:total }));
  if (onProgress) onProgress({ pct:100, speed:'0', name:file.name, bytes:sent, total:file.size });
  const el = ((Date.now()-t0)/1000).toFixed(1);
  console.log(`[ZAP] ✅ Sent ${file.name} in ${el}s @ ${(file.size/1048576/parseFloat(el)).toFixed(1)} MB/s`);
}

// ── Swarm mode (≥ 500MB) ──────────────────────────────────────────────────────
async function _sendSwarm(file, remoteId, onProgress) {
  const { fileId, descriptor, addPeer } = await SwarmSession.startSend(
    file,
    null,  // addPeerFn — we handle it below
    (p) => onProgress?.({ ...p, mode: 'swarm' }),
    (result) => {
      if (_onReady) _onReady(remoteId, result);
    },
    (err) => console.error('[ZAP/swarm]', err)
  );

  // Add the existing peer to this swarm
  const state = peers.get(remoteId);
  if (state?.pc) addPeer(remoteId, state.pc);

  // Signal peer that a swarm transfer is starting
  const ctrl = state?.ctrl;
  if (ctrl?.readyState === 'open') {
    ctrl.send(JSON.stringify({
      type:       'swarm_start',
      descriptor: JSON.parse(descriptor.serialize()),
    }));
  }

  // The SwarmTransfer takes over from here
}

export async function sendFolder(files, folderName, remoteId, onProgress) {
  const { default: JSZip } = await import('https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js');
  const zip = new JSZip().folder(folderName);
  for (const f of Array.from(files)) {
    const rel = f.webkitRelativePath ? f.webkitRelativePath.split('/').slice(1).join('/') : f.name;
    zip.file(rel, f);
  }
  onProgress?.({ pct:3, speed:'—', name:folderName+'.zip' });
  const blob = await zip.generateAsync(
    { type:'blob', compression:'DEFLATE', compressionOptions:{level:1} },
    ({percent}) => onProgress?.({ pct:Math.round(percent*.4), speed:'—', name:folderName+'.zip' })
  );
  const zf = new File([blob], folderName+'.zip', { type:'application/zip' });
  return sendFile(zf, remoteId, p => onProgress?.({ ...p, pct: 40+Math.round(p.pct*.6) }));
}

// ── Swarm receive (called from App.jsx when swarm_start message arrives) ───────
export async function startSwarmReceive(descriptor, peerId, onProgress, onComplete, onError) {
  const state = peers.get(peerId);
  if (!state?.pc) { onError?.(new Error('No active peer connection')); return; }

  const { addPeer } = await SwarmSession.startReceive(
    descriptor,
    (p) => {
      onProgress?.({ ...p, mode: 'swarm' });
      if (_onProgress) _onProgress(peerId, p);
    },
    (result) => {
      onComplete?.(result);
      if (_onReady) _onReady(peerId, result);
    },
    onError ?? (e => console.error('[ZAP/swarm recv]', e))
  );

  addPeer(peerId, state.pc);
}

// ── Connection management ─────────────────────────────────────────────────────
export function closeConnection(id) {
  const s = peers.get(id); if (!s) return;
  clearTimeout(s.timer);
  try{s.ctrl?.close();}catch{}
  s.dataChs.forEach(dc=>{try{dc.close();}catch{}});
  try{s.pc?.close();}catch{}
  if(s.recv.writable)try{s.recv.writable.close();}catch{}
  if(s.recv.db){try{s.recv.db.close();}catch{}try{indexedDB.deleteDatabase(s.recv.dbName);}catch{}}
  s.status='closed'; peers.delete(id);
  if(_onDisconn)_onDisconn(id);
}

export const isConnected = id => peers.get(id)?.status === 'open';
export const getStatus   = id => peers.get(id)?.status ?? 'none';
export const closeAll    = () => [...peers.keys()].forEach(closeConnection);
export const getAllConns  = () => [...peers.entries()].map(([id,s])=>({nodeId:id,status:s.status}));