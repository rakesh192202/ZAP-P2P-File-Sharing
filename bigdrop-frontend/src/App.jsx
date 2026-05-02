/**
 * ZAP — Decentralized P2P File Sharing
 * App.jsx — Complete working version
 *
 * FIXES IN THIS VERSION:
 *  1. "poll is not a function" — was caused by corrupted/incomplete previous file.
 *     Complete rewrite with clean structure.
 *  2. Phone→Mac: setNewPeerHandler fires when unknown peer connects,
 *     auto-adds them to sidebar using nodeId→zapId reverse cache.
 *  3. peersRef/identityRef/activeRef — useRef pattern prevents stale closures.
 *  4. Signal polling is sequential (for-of with await) preventing race conditions.
 *  5. Create Identity works on phone — no broken functions called during setup.
 *  6. Blockchain: full searchable blocks with all file info.
 *  7. No copy ZAP ID button.
 *  8. Responsive — works on phone, tablet, desktop.
 */
import React, { useState, useEffect, useRef, useCallback } from "react";
import * as ZAP from "./webrtc/webrtc.js";
import {
  loadOrCreateIdentity,
  createIdentity,
  buildRegistrationPacket,
  verifyRegistrationPacket,
  zapIdToLookupKey,
  parseZapId,
} from "./webrtc/identity.js";

const API_BASE = `http://${window.location.hostname}:8080/api/jchain`;

// ── Helpers ────────────────────────────────────────────────────────────────────
const fmtBytes = b => {
  if (!b || b === 0) return '0 B';
  if (b >= 1099511627776) return (b/1099511627776).toFixed(2)+' TB';
  if (b >= 1073741824)    return (b/1073741824).toFixed(2)+' GB';
  if (b >= 1048576)       return (b/1048576).toFixed(1)+' MB';
  if (b >= 1024)          return (b/1024).toFixed(0)+' KB';
  return b+' B';
};
const fmtDate  = ts => ts ? new Date(ts).toLocaleString([],{dateStyle:'medium',timeStyle:'short'}) : '—';
const fmtTime  = ts => ts ? new Date(ts).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}) : '—';
const getExt   = n  => (n?.split('.').pop()||'').toLowerCase();
const getType  = n  => {
  const e = getExt(n);
  return ({
    mp4:'VIDEO',mov:'VIDEO',avi:'VIDEO',mkv:'VIDEO',webm:'VIDEO',
    mp3:'AUDIO',flac:'AUDIO',wav:'AUDIO',aac:'AUDIO',ogg:'AUDIO',m4a:'AUDIO',
    jpg:'IMAGE',jpeg:'IMAGE',png:'IMAGE',gif:'IMAGE',webp:'IMAGE',heic:'IMAGE',avif:'IMAGE',
    pdf:'PDF',doc:'DOC',docx:'DOC',xls:'SHEET',xlsx:'SHEET',ppt:'SLIDES',pptx:'SLIDES',
    zip:'ZIP',rar:'ZIP',tar:'ARCHIVE',gz:'ARCHIVE','7z':'ARCHIVE',
    apk:'APP',exe:'APP',dmg:'APP',pkg:'APP',ipa:'APP',
    js:'CODE',ts:'CODE',py:'CODE',java:'CODE',cpp:'CODE',c:'CODE',
    txt:'TEXT',csv:'TEXT',json:'TEXT',xml:'TEXT',
  })[e] ?? 'FILE';
};
const typeIcon = t => ({
  VIDEO:'🎬',AUDIO:'🎵',IMAGE:'🖼',PDF:'📄',DOC:'📝',SHEET:'📊',
  SLIDES:'📑',ZIP:'🗜',ARCHIVE:'📦',APP:'⚙',CODE:'💻',TEXT:'📃',FILE:'📎',
})[t] ?? '📎';

// ── CSS ────────────────────────────────────────────────────────────────────────
const CSS = `
@import url('https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap');
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg:#000;--bg1:#0a0a0a;--bg2:#111;--bg3:#1a1a1a;--bg4:#222;
  --gold:#FFB800;--gold2:#FFC933;--gold3:#FFDA66;
  --w:#fff;--gray:#888;--gray2:#555;
  --line:rgba(255,255,255,.07);--line2:rgba(255,255,255,.14);
  --grn:#22DD66;--red:#FF4444;
  --sans:'Space Grotesk',sans-serif;
  --mono:'JetBrains Mono',monospace;
}
html,body,#root{height:100%;background:var(--bg);color:var(--w);font-family:var(--sans);-webkit-text-size-adjust:100%;overflow:hidden}
::-webkit-scrollbar{width:3px}::-webkit-scrollbar-thumb{background:var(--bg4)}
::selection{background:rgba(255,184,0,.25)}
@keyframes bolt{
  0%,100%{filter:drop-shadow(0 0 8px var(--gold)) drop-shadow(0 0 20px rgba(255,184,0,.4))}
  50%{filter:drop-shadow(0 0 16px var(--gold)) drop-shadow(0 0 40px rgba(255,184,0,.7))}
}
@keyframes spin{to{transform:rotate(360deg)}}

/* ── SETUP SCREEN ── */
.setup{min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px;
  background:radial-gradient(ellipse at 50% 30%,rgba(255,184,0,.08) 0%,transparent 65%)}
.setup-card{width:100%;max-width:420px;background:var(--bg1);border:1px solid rgba(255,184,0,.3);padding:36px 28px}
.setup-logo{display:flex;align-items:center;gap:10px;margin-bottom:28px}
.setup-bolt{font-size:32px;animation:bolt 2s ease-in-out infinite}
.setup-name{font-size:34px;font-weight:700;letter-spacing:-1px;
  background:linear-gradient(135deg,var(--gold) 0%,var(--gold3) 60%,#fff 100%);
  -webkit-background-clip:text;-webkit-text-fill-color:transparent;line-height:1}
.setup-sub{font-size:13px;color:var(--gray);margin-bottom:24px;line-height:1.7}
.setup-sub strong{color:var(--gold)}
.setup-lbl{font-size:10px;color:var(--gray);letter-spacing:1.5px;text-transform:uppercase;margin-bottom:7px}
.setup-input{width:100%;background:var(--bg2);border:1px solid var(--line2);padding:13px 14px;
  color:var(--w);font-family:var(--mono);font-size:16px;outline:none;border-radius:0;
  -webkit-appearance:none;transition:border-color .2s}
.setup-input:focus{border-color:var(--gold)}
.setup-input::placeholder{color:var(--gray2)}
.setup-preview{margin-top:10px;padding:11px 14px;background:var(--bg2);border-left:3px solid var(--gold);
  font-family:var(--mono);font-size:17px;font-weight:600;color:var(--gold)}
.setup-preview-sub{font-size:10px;color:var(--gray);margin-top:3px;font-family:var(--sans)}
.setup-btn{width:100%;margin-top:22px;padding:14px;background:var(--gold);border:none;
  color:#000;font-family:var(--sans);font-size:14px;font-weight:700;cursor:pointer;
  letter-spacing:.5px;transition:background .15s;-webkit-tap-highlight-color:transparent}
.setup-btn:hover:not(:disabled){background:var(--gold2)}
.setup-btn:disabled{opacity:.4;cursor:not-allowed}
.loading{min-height:100vh;display:flex;align-items:center;justify-content:center;
  font-family:var(--mono);font-size:13px;color:var(--gold);letter-spacing:3px}

/* ── APP SHELL ── */
.app{display:grid;grid-template-rows:50px 1fr;height:100vh;overflow:hidden}

/* ── TOPBAR ── */
.topbar{background:var(--bg1);border-bottom:1px solid var(--line);
  display:flex;align-items:center;padding:0 14px;gap:10px;flex-shrink:0}
.topbar-logo{display:flex;align-items:center;gap:6px;flex-shrink:0}
.topbar-bolt{font-size:18px;filter:drop-shadow(0 0 6px var(--gold));animation:bolt 2s ease-in-out infinite}
.topbar-zap{font-size:19px;font-weight:700;letter-spacing:-.5px;
  background:linear-gradient(135deg,var(--gold),var(--gold3));
  -webkit-background-clip:text;-webkit-text-fill-color:transparent}
.topbar-id{flex:1;min-width:0}
.topbar-zapid{font-size:12px;font-weight:600;color:var(--gold);font-family:var(--mono);
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.topbar-nodeid{font-size:8px;color:var(--gray);font-family:var(--mono);
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:1px}
.status-dot{width:7px;height:7px;border-radius:50%;flex-shrink:0}
.status-dot.on{background:var(--grn);box-shadow:0 0 6px var(--grn)}
.status-dot.off{background:var(--red)}

/* ── MAIN LAYOUT ── */
.layout{display:grid;grid-template-columns:220px 1fr;overflow:hidden;height:100%}
@media(max-width:640px){
  .layout{grid-template-columns:1fr;grid-template-rows:auto 1fr}
  .sidebar{border-right:none!important;border-bottom:1px solid var(--line);max-height:210px}
}

/* ── SIDEBAR ── */
.sidebar{background:var(--bg1);border-right:1px solid var(--line);
  display:flex;flex-direction:column;overflow:hidden}
.add-row{display:flex;flex-shrink:0;border-bottom:1px solid var(--line)}
.add-input{flex:1;background:var(--bg2);border:none;padding:9px 10px;color:var(--w);
  font-family:var(--mono);font-size:11px;outline:none;min-width:0}
.add-input::placeholder{color:var(--gray2)}.add-input:focus{background:var(--bg3)}
.add-btn{padding:9px 11px;background:var(--gold);border:none;color:#000;
  font-family:var(--sans);font-size:10px;font-weight:700;cursor:pointer;
  letter-spacing:1px;flex-shrink:0;-webkit-tap-highlight-color:transparent}
.add-btn:hover{background:var(--gold2)}.add-btn:disabled{opacity:.4;cursor:not-allowed}
.peer-list{flex:1;overflow-y:auto}
.peer-empty{padding:16px 12px;font-size:10px;color:var(--gray);line-height:2}
.peer-empty span{color:var(--gold)}
.peer-item{display:flex;align-items:center;gap:8px;padding:9px 10px;cursor:pointer;
  border-bottom:1px solid var(--line);transition:background .1s;
  -webkit-tap-highlight-color:transparent}
.peer-item:hover{background:var(--bg2)}
.peer-item.active{background:rgba(255,184,0,.07);border-left:3px solid var(--gold);padding-left:7px}
.peer-av{width:28px;height:28px;border-radius:50%;background:var(--bg3);border:2px solid var(--gold);
  display:flex;align-items:center;justify-content:center;font-size:9px;font-weight:700;
  color:var(--gold);font-family:var(--mono);flex-shrink:0}
.peer-info{flex:1;min-width:0}
.peer-name{font-size:11px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.peer-node{font-size:8px;color:var(--gray);font-family:var(--mono);white-space:nowrap;
  overflow:hidden;text-overflow:ellipsis;margin-top:1px}
.peer-badge{font-size:8px;padding:1px 5px;border:1px solid;letter-spacing:1px;
  font-family:var(--mono);flex-shrink:0}
.peer-badge.on{color:var(--grn);border-color:var(--grn)}
.peer-badge.off{color:var(--gray2);border-color:var(--gray2)}
.peer-badge.connecting{color:var(--gold);border-color:var(--gold)}
.sidetabs{display:flex;border-top:1px solid var(--line);flex-shrink:0}
.sidetab{flex:1;padding:8px 0;background:transparent;border:none;color:var(--gray);
  font-family:var(--sans);font-size:9px;font-weight:600;cursor:pointer;letter-spacing:1px;
  transition:.15s;border-right:1px solid var(--line);-webkit-tap-highlight-color:transparent}
.sidetab:last-child{border-right:none}
.sidetab.on{color:var(--gold);background:rgba(255,184,0,.05)}
.sidetab:hover:not(.on){color:var(--w)}

/* ── MAIN PANEL ── */
.main{display:flex;flex-direction:column;overflow:hidden}

/* Empty state */
.empty{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;
  gap:16px;padding:24px;text-align:center}
.empty-logo{display:flex;align-items:center;gap:8px}
.empty-bolt{font-size:48px;animation:bolt 2s ease-in-out infinite;
  filter:drop-shadow(0 0 14px var(--gold)) drop-shadow(0 0 28px rgba(255,184,0,.5))}
.empty-text{font-size:48px;font-weight:700;letter-spacing:-3px;
  background:linear-gradient(135deg,var(--gold),var(--gold3),#fff);
  -webkit-background-clip:text;-webkit-text-fill-color:transparent}
.empty-sub{font-size:11px;color:var(--gray);letter-spacing:2px;text-transform:uppercase}
.empty-id{background:var(--bg1);border:1px solid rgba(255,184,0,.25);
  padding:12px 14px;width:100%;max-width:360px;text-align:left}
.empty-id-lbl{font-size:8px;color:var(--gray);letter-spacing:1.5px;text-transform:uppercase;margin-bottom:4px}
.empty-id-zap{font-size:14px;font-weight:700;color:var(--gold);font-family:var(--mono);margin-bottom:3px}
.empty-id-node{font-size:7px;color:var(--gray);font-family:var(--mono);word-break:break-all;line-height:1.7}
.feat-grid{display:grid;grid-template-columns:1fr 1fr;gap:7px;width:100%;max-width:360px}
.feat{background:var(--bg1);border:1px solid var(--line);padding:10px}
.feat-icon{font-size:14px;margin-bottom:4px}
.feat-title{font-size:10px;font-weight:600;margin-bottom:2px}
.feat-desc{font-size:9px;color:var(--gray);line-height:1.5}

/* Transfer header */
.txhead{padding:9px 12px;border-bottom:1px solid var(--line);background:var(--bg1);
  flex-shrink:0;display:flex;align-items:flex-start;gap:9px}
.txhead-av{width:34px;height:34px;border-radius:50%;background:var(--bg3);border:2px solid var(--gold);
  display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:700;
  color:var(--gold);font-family:var(--mono);flex-shrink:0}
.txhead-info{flex:1;min-width:0}
.txhead-name{font-size:13px;font-weight:600}
.txhead-node{font-size:7px;color:var(--gray);font-family:var(--mono);word-break:break-all;
  line-height:1.6;margin-top:2px}
.conn-pill{font-size:8px;padding:2px 7px;border:1px solid;letter-spacing:1px;
  font-family:var(--mono);flex-shrink:0;margin-top:2px}
.conn-pill.on{color:var(--grn);border-color:var(--grn)}
.conn-pill.wait{color:var(--gold);border-color:var(--gold)}
.conn-pill.off{color:var(--gray2);border-color:var(--gray2)}

/* Progress bars */
.prog{padding:6px 12px;background:var(--bg1);border-bottom:1px solid var(--line);flex-shrink:0}
.prog-row{display:flex;justify-content:space-between;font-size:9px;color:var(--gray);
  font-family:var(--mono);margin-bottom:4px}
.prog-speed{color:var(--gold);font-weight:600}
.prog-track{height:2px;background:var(--bg3);border-radius:1px}
.prog-fill{height:100%;background:var(--gold);transition:width .2s;border-radius:1px;
  box-shadow:0 0 6px rgba(255,184,0,.6)}
.prog-fill.recv{background:var(--grn);box-shadow:0 0 6px rgba(34,221,102,.5)}

/* Tabs */
.tabs{display:flex;border-bottom:1px solid var(--line);flex-shrink:0;background:var(--bg1)}
.tab-btn{flex:1;padding:8px 0;background:transparent;border:none;
  border-bottom:2px solid transparent;color:var(--gray);font-family:var(--sans);
  font-size:9px;font-weight:700;cursor:pointer;letter-spacing:1.5px;transition:.15s;
  -webkit-tap-highlight-color:transparent}
.tab-btn.on{color:var(--gold);border-bottom-color:var(--gold)}
.tab-btn:hover:not(.on){color:var(--w)}

/* ── SEND TAB ── */
.send-area{flex:1;display:flex;flex-direction:column;align-items:center;
  justify-content:center;padding:20px 16px;gap:14px;overflow-y:auto}
.dropzone{width:100%;max-width:480px;border:2px dashed rgba(255,184,0,.35);
  padding:36px 20px;text-align:center;cursor:pointer;transition:.2s;
  background:rgba(255,184,0,.02);-webkit-tap-highlight-color:transparent}
.dropzone:hover,.dropzone.drag{border-color:var(--gold);background:rgba(255,184,0,.06)}
.dropzone-icon{font-size:40px;margin-bottom:12px}
.dropzone-title{font-size:14px;font-weight:600;margin-bottom:5px}
.dropzone-sub{font-size:11px;color:var(--gray);line-height:1.8}
.dropzone-sub strong{color:var(--gold)}
.send-btns{display:flex;gap:8px;flex-wrap:wrap;justify-content:center;width:100%;max-width:480px}
.send-btn{flex:1;min-width:110px;padding:11px 14px;background:var(--bg1);border:1px solid var(--line2);
  color:var(--w);font-family:var(--sans);font-size:11px;font-weight:500;cursor:pointer;
  transition:.15s;display:flex;align-items:center;justify-content:center;gap:6px;
  -webkit-tap-highlight-color:transparent}
.send-btn:hover:not(:disabled){border-color:var(--gold);color:var(--gold)}
.send-btn:disabled{opacity:.3;cursor:not-allowed}
.send-btn.primary{background:var(--gold);border-color:var(--gold);color:#000;font-weight:700}
.send-btn.primary:hover{background:var(--gold2)}
.info-box{width:100%;max-width:480px;padding:9px 12px;font-size:10px;line-height:1.8;border:1px solid}
.info-box.ok{background:rgba(34,221,102,.04);border-color:rgba(34,221,102,.25);color:var(--grn)}
.info-box.warn{background:rgba(255,184,0,.04);border-color:rgba(255,184,0,.2);color:var(--gold)}

/* ── HISTORY TAB ── */
.history{flex:1;overflow-y:auto}
.hist-empty{padding:28px;font-size:11px;color:var(--gray);text-align:center}
.hist-item{padding:10px 12px;border-bottom:1px solid var(--line)}
.hist-head{display:flex;align-items:center;gap:7px;flex-wrap:wrap;margin-bottom:5px}
.hist-badge{font-size:7px;padding:2px 6px;border:1px solid;letter-spacing:1px;font-family:var(--mono)}
.badge-sent{color:var(--gold);border-color:var(--gold)}
.badge-recv{color:var(--grn);border-color:var(--grn)}
.hist-name{font-size:12px;font-weight:600;flex:1;min-width:0;word-break:break-all}
.hist-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(120px,1fr));gap:2px 8px}
.hist-field{font-size:9px;color:var(--gray)}.hist-field span{color:var(--w);font-family:var(--mono)}
.hist-hash{font-size:7px;color:var(--gray);font-family:var(--mono);word-break:break-all;
  line-height:1.6;margin-top:4px;padding:4px 7px;background:var(--bg2);border-left:2px solid var(--gold)}
.dl-btn{display:inline-block;padding:3px 9px;border:1px solid var(--gold);color:var(--gold);
  font-size:8px;cursor:pointer;text-decoration:none;letter-spacing:1px;margin-top:4px;
  background:transparent;font-family:var(--sans);transition:.15s}
.dl-btn:hover{background:rgba(255,184,0,.1)}

/* ── CHAIN TAB ── */
.chain-container{flex:1;display:flex;flex-direction:column;overflow:hidden}
.chain-toolbar{padding:8px 12px;background:var(--bg1);border-bottom:1px solid var(--line);
  flex-shrink:0;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.chain-title{font-size:10px;font-weight:600;color:var(--gold);letter-spacing:2px;white-space:nowrap}
.chain-count{font-size:9px;color:var(--gray)}
.chain-search{flex:1;min-width:120px;background:var(--bg2);border:1px solid var(--line2);
  padding:5px 9px;color:var(--w);font-family:var(--mono);font-size:10px;outline:none;border-radius:0}
.chain-search::placeholder{color:var(--gray2)}.chain-search:focus{border-color:var(--gold)}
.chain-filter-row{display:flex;gap:5px;flex-wrap:wrap}
.chain-filter{padding:3px 8px;background:transparent;border:1px solid var(--line2);
  color:var(--gray);font-family:var(--sans);font-size:8px;cursor:pointer;letter-spacing:.5px;
  transition:.15s;-webkit-tap-highlight-color:transparent}
.chain-filter.on,.chain-filter:hover{border-color:var(--gold);color:var(--gold)}
.chain-list{flex:1;overflow-y:auto;padding:8px}
.chain-empty{padding:24px;font-size:11px;color:var(--gray);text-align:center}

/* Block card */
.block-card{background:var(--bg1);border:1px solid var(--line2);margin-bottom:8px;overflow:hidden}
.block-header{display:flex;align-items:center;gap:8px;padding:8px 10px;background:var(--bg2);
  border-bottom:1px solid var(--line)}
.block-num{font-size:8px;font-family:var(--mono);color:var(--gold);letter-spacing:1px;flex-shrink:0}
.block-dir{font-size:8px;padding:2px 7px;border:1px solid;letter-spacing:1px;font-family:var(--mono);flex-shrink:0}
.block-dir.sent{background:rgba(255,184,0,.08);color:var(--gold);border-color:var(--gold)}
.block-dir.received{background:rgba(34,221,102,.08);color:var(--grn);border-color:var(--grn)}
.block-icon{font-size:16px;flex-shrink:0}
.block-fname{font-size:12px;font-weight:700;flex:1;min-width:0;word-break:break-all}
.block-body{padding:10px}
.block-grid{display:grid;grid-template-columns:1fr 1fr;gap:0}
@media(max-width:480px){.block-grid{grid-template-columns:1fr}}
.block-row{display:flex;flex-direction:column;padding:5px 0;border-bottom:1px solid var(--line)}
.block-row:nth-child(odd){border-right:1px solid var(--line);padding-right:10px}
.block-row:nth-child(even){padding-left:10px}
.block-row:nth-last-child(-n+2){border-bottom:none}
.block-label{font-size:8px;color:var(--gray);letter-spacing:.8px;text-transform:uppercase;margin-bottom:2px}
.block-val{font-size:11px;color:var(--w);font-family:var(--mono);word-break:break-all}
.block-val.big{font-size:12px;font-weight:700;font-family:var(--sans)}
.block-val.gold{color:var(--gold)}.block-val.grn{color:var(--grn)}
.block-merkle{padding:7px 10px;background:var(--bg2);border-top:1px solid var(--line)}
.block-merkle-lbl{font-size:7px;color:var(--gold);letter-spacing:1.5px;text-transform:uppercase;margin-bottom:2px}
.block-merkle-val{font-size:7px;font-family:var(--mono);color:var(--gray);word-break:break-all;line-height:1.6}
.block-chain{padding:5px 10px;border-top:1px solid var(--line);display:flex;gap:6px;align-items:flex-start}
.block-chain-icon{color:var(--gold);font-size:9px;flex-shrink:0;margin-top:1px}
.block-chain-val{font-size:7px;font-family:var(--mono);color:var(--gray2);word-break:break-all;line-height:1.5;flex:1}

/* Net tab */
.net-scroll{flex:1;overflow-y:auto;padding:10px;display:flex;flex-direction:column;gap:8px}
.net-card{background:var(--bg1);border:1px solid var(--line);padding:12px}
.net-card-title{font-size:8px;color:var(--gold);letter-spacing:2px;text-transform:uppercase;margin-bottom:8px}
.net-row{display:flex;justify-content:space-between;align-items:flex-start;
  padding:4px 0;border-bottom:1px solid var(--line);font-size:9px;gap:6px}
.net-row:last-child{border:none}
.net-lbl{color:var(--gray);flex-shrink:0}
.net-val{color:var(--w);font-family:var(--mono);text-align:right;word-break:break-all;max-width:62%}

/* Chain sidebar */
.csidebar{flex:1;overflow-y:auto}
.csb-item{padding:8px 10px;border-bottom:1px solid var(--line);cursor:pointer;transition:.1s;
  -webkit-tap-highlight-color:transparent}
.csb-item:hover{background:var(--bg2)}
.csb-top{display:flex;align-items:center;gap:5px;margin-bottom:2px}
.csb-badge{font-size:7px;padding:1px 5px;border:1px solid;letter-spacing:1px;font-family:var(--mono)}
.csb-sent{color:var(--gold);border-color:var(--gold)}.csb-recv{color:var(--grn);border-color:var(--grn)}
.csb-fname{font-size:10px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.csb-meta{font-size:8px;color:var(--gray);font-family:var(--mono)}

/* Toasts */
.toasts{position:fixed;bottom:12px;right:12px;display:flex;flex-direction:column;gap:5px;
  z-index:9999;pointer-events:none;max-width:280px}
@media(max-width:640px){.toasts{left:12px;right:12px;max-width:100%}}
.toast{padding:8px 12px;border:1px solid;font-size:10px;display:flex;align-items:center;gap:8px;
  background:var(--bg1);pointer-events:all;animation:toastin .2s ease}
.toast.success{border-color:var(--grn);color:var(--grn)}
.toast.error{border-color:var(--red);color:var(--red)}
.toast.info{border-color:var(--gold);color:var(--gold)}
@keyframes toastin{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:translateY(0)}}
`;

// ── APP COMPONENT ──────────────────────────────────────────────────────────────
export default function App() {
  const [screen,   setScreen]   = useState('loading');
  const [identity, setIdentity] = useState(null);
  const [uname,    setUname]    = useState('');
  const [online,   setOnline]   = useState(false);
  const [dhtCount, setDhtCount] = useState(0);
  const [peers,    setPeers]    = useState([]);
  const [active,   setActive]   = useState(null);
  const [txMap,    setTxMap]    = useState({});    // nodeId → transfer[]
  const [sendProg, setSendProg] = useState(null);
  const [recvProg, setRecvProg] = useState(null);
  const [chain,    setChain]    = useState([]);
  const [chainQ,   setChainQ]   = useState('');   // search query
  const [chainDir, setChainDir] = useState('all'); // all|sent|received
  const [tab,      setTab]      = useState('send');
  const [stab,     setStab]     = useState('peers');
  const [adding,   setAdding]   = useState(false);
  const [addInput, setAddInput] = useState('');
  const [toasts,   setToasts]   = useState([]);
  const [drag,     setDrag]     = useState(false);

  // CRITICAL: Refs for fresh values in closures
  const peersRef    = useRef(peers);
  const identityRef = useRef(identity);
  const activeRef   = useRef(active);
  useEffect(() => { peersRef.current    = peers;    }, [peers]);
  useEffect(() => { identityRef.current = identity; }, [identity]);
  useEffect(() => { activeRef.current   = active;   }, [active]);

  const fileInputRef   = useRef(null);
  const folderInputRef = useRef(null);

  // ── Toast ──────────────────────────────────────────────────────────────────
  const toast = useCallback((msg, type = 'info') => {
    const id = Date.now() + Math.random();
    setToasts(t => [...t, { id, msg, type }]);
    setTimeout(() => setToasts(t => t.filter(x => x.id !== id)), 5000);
  }, []);

  const addTx = useCallback((nodeId, entry) => {
    setTxMap(m => ({ ...m, [nodeId]: [entry, ...(m[nodeId] ?? [])] }));
  }, []);

  // ── Load identity ──────────────────────────────────────────────────────────
  useEffect(() => {
    loadOrCreateIdentity()
      .then(id => {
        if (id) { setIdentity(id); setScreen('app'); }
        else setScreen('setup');
      })
      .catch(() => setScreen('setup'));
  }, []);

  // ── Main effect: register, setup ZAP handlers, poll ───────────────────────
  useEffect(() => {
    if (!identity || screen !== 'app') return;

    // Register on DHT
    (async () => {
      try {
        const pkt = await buildRegistrationPacket(identity);
        const key = zapIdToLookupKey(identity.zapId);
        const r = await fetch(`${API_BASE}/dht/store`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ key, value: JSON.stringify(pkt) }),
        });
        setOnline(r.ok);
        if (r.ok) toast(`Online as ${identity.zapId}`, 'success');
        else toast('DHT store failed', 'error');
      } catch (e) {
        setOnline(false);
        toast('Backend offline — start Java :8080', 'error');
      }
    })();

    // ── ZAP signaling ────────────────────────────────────────────────────────
    ZAP.setDHTSignaling(async (targetId, sig) => {
      try {
        await fetch(`${API_BASE}/dht/signal`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            target: targetId,
            signal: JSON.stringify(sig),
            sender: identity.nodeId,
          }),
        });
      } catch {}
    });

    // ── Incoming peer (phone→mac fix) ────────────────────────────────────────
    ZAP.setNewPeerHandler(async (fromId) => {
      // Try to get their ZAP ID from cache first, then DHT
      let zapId = ZAP.getNodeZapId(fromId) ?? null;

      if (!zapId) {
        try {
          const r = await fetch(`${API_BASE}/dht/find?key=${encodeURIComponent(fromId)}`);
          if (r.ok) {
            const d = await r.json();
            if (d?.zapId) { zapId = d.zapId; ZAP.cacheNodeZapId(fromId, zapId); }
          }
        } catch {}
      }

      const displayId = zapId || (fromId.slice(0, 8) + '…');

      setPeers(ps => {
        const exists = ps.find(p => p.nodeId === fromId);
        if (exists) {
          // Already in list — update zapId if we now have the real one
          if (zapId && exists.zapId !== zapId) {
            return ps.map(p => p.nodeId === fromId ? { ...p, zapId } : p);
          }
          return ps; // already there, no change
        }
        // New peer — add to list
        return [...ps, { zapId: displayId, nodeId: fromId, status: 'connecting' }];
      });

      // Auto-switch to this peer if no active peer
      if (!activeRef.current) {
        setActive({ zapId: displayId, nodeId: fromId, status: 'connecting' });
        setStab('peers');
      }

      toast(`📱 ${displayId} is connecting…`, 'info');
    });

    // ── File start ───────────────────────────────────────────────────────────
    ZAP.setFileStartHandler((fromId, meta) => {
      setRecvProg({ name: meta.name, pct: 0, speed: '0', nodeId: fromId, bytes: 0, total: meta.size });
    });

    // ── File ready ───────────────────────────────────────────────────────────
    ZAP.setFileReadyHandler((fromId, result) => {
      const peer  = peersRef.current.find(p => p.nodeId === fromId);
      const myId  = identityRef.current?.zapId ?? 'me';
      const entry = {
        direction:   'received',
        name:        result.name,
        size:        result.size,
        fileType:    getType(result.name),
        ext:         getExt(result.name),
        from:        peer?.zapId ?? (fromId.slice(0, 10) + '…'),
        to:          myId,
        timestamp:   Date.now(),
        merkleRoot:  result.merkleRoot,
        savedToDisk: result.savedToDisk,
        url:         result.url,
      };
      addTx(fromId, entry);
      setRecvProg(null);
      // Auto-switch to History tab so user can see the received file
      setTab('history');
      // Auto-select this peer if not already active
      if (!activeRef.current || activeRef.current.nodeId !== fromId) {
        const p = peersRef.current.find(x => x.nodeId === fromId);
        if (p) setActive(p);
      }
      toast(`✅ Received: ${result.name} (${fmtBytes(result.size)})${result.savedToDisk ? ' — saved to disk' : ''}`, 'success');
      anchorBlock({ ...entry, senderNodeId: fromId, receiverNodeId: identityRef.current?.nodeId });
    });

    // ── Progress ─────────────────────────────────────────────────────────────
    ZAP.setProgressHandler((fromId, p) => {
      setRecvProg({ name: p.name, pct: p.pct, speed: p.speed, nodeId: fromId, bytes: p.bytes, total: p.total });
    });

    // ── Connect/Disconnect ───────────────────────────────────────────────────
    ZAP.setConnectHandler(nodeId => {
      setPeers(ps => ps.map(p => p.nodeId === nodeId ? { ...p, status: 'online' } : p));
      // Also update active state so CONNECTED pill shows immediately
      setActive(a => a?.nodeId === nodeId ? { ...a, status: 'online' } : a);
      toast('Peer connected ✓', 'success');
    });
    ZAP.setDisconnectHandler(nodeId => {
      setPeers(ps => ps.map(p => p.nodeId === nodeId ? { ...p, status: 'offline' } : p));
      setActive(a => a?.nodeId === nodeId ? { ...a, status: 'offline' } : a);
    });

    // ── Signal poll — SEQUENTIAL, filtered by targetNodeId ─────────────────
    // CRITICAL FIX: The Java backend returns ALL signals in one global queue.
    // Without filtering, Mac processes Phone's outgoing signals (and vice versa),
    // creating self-loops that prevent real connections from forming.
    // We only process signals where targetNodeId === our own nodeId.
    let polling = true;
    const doPoll = async () => {
      if (!polling) return;
      try {
        const r = await fetch(`${API_BASE}/get-signals?nodeId=${encodeURIComponent(identity.nodeId)}`);
        if (r.ok) {
          const sigs = await r.json();
          if (Array.isArray(sigs)) {
            for (const s of sigs) {
              if (!polling) break;

              // Must have a sender and a payload
              const fromId  = s.senderId || s.sender;
              let   payload = s.payload  || s.signal;
              if (!fromId || !payload) continue;

              // FILTER: skip signals not addressed to us
              const target = s.targetNodeId || s.target;
              if (target && target !== identity.nodeId) {
                console.log(`[ZAP/poll] skip signal for ${target?.slice(0,10)} (not us)`);
                continue;
              }

              // Skip signals WE sent (senderId === our nodeId)
              if (fromId === identity.nodeId) continue;

              // Unwrap double-stringified payload (Java backend quirk)
              if (typeof payload === 'string') {
                try { payload = JSON.parse(payload); } catch {}
              }
              if (typeof payload === 'string') {
                try { payload = JSON.parse(payload); } catch {}
              }
              if (!payload?.type) continue;

              console.log(`[ZAP/poll] ← ${payload.type} from ${fromId.slice(0,10)}`);
              await ZAP.handleIncomingSignal(fromId, payload);
            }
          }
        }
      } catch {}
      // Also poll DHT peer count
      try {
        const r2 = await fetch(`${API_BASE}/peers`);
        if (r2.ok) {
          const p = await r2.json();
          setDhtCount(Array.isArray(p) ? p.length : 0);
        }
      } catch {}
      if (polling) setTimeout(doPoll, 2000);
    };
    doPoll();

    return () => { polling = false; };
  }, [identity, screen]);

  // ── Chain load ─────────────────────────────────────────────────────────────
  const loadChain = useCallback(async () => {
    try {
      const r = await fetch(`${API_BASE}/history`);
      if (r.ok) {
        const d = await r.json();
        setChain(Array.isArray(d) ? [...d].reverse() : []);
      }
    } catch {}
  }, []);

  useEffect(() => {
    if (stab === 'chain') loadChain();
  }, [stab, loadChain]);

  // ── Anchor block ───────────────────────────────────────────────────────────
  const anchorBlock = useCallback(async (entry) => {
    try {
      await fetch(`${API_BASE}/anchor`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fileId:        (entry.name ?? '') + (entry.size ?? ''),
          fileName:      entry.name,
          fileSize:      entry.size,
          fileType:      entry.fileType,
          senderNodeId:  entry.direction === 'sent' ? identityRef.current?.nodeId : entry.senderNodeId,
          receiverNodeId:entry.direction === 'sent' ? entry.receiverNodeId : identityRef.current?.nodeId,
          senderZapId:   entry.from,
          receiverZapId: entry.to,
          direction:     entry.direction,
          status:        entry.direction?.toUpperCase(),
          merkleRoot:    entry.merkleRoot,
          chunkCount:    entry.chunkCount ?? 0,
        }),
      });
      if (stab === 'chain') loadChain();
    } catch {}
  }, [stab, loadChain]);

  // ── Add peer ───────────────────────────────────────────────────────────────
  const doAdd = async () => {
    const raw = addInput.trim().toLowerCase();
    if (!raw.includes('#')) { toast('Format: username#HASH', 'error'); return; }
    if (peersRef.current.find(p => p.zapId === raw)) { toast('Already added'); return; }
    setAdding(true); setAddInput('');
    try {
      const key = zapIdToLookupKey(raw);
      const r   = await fetch(`${API_BASE}/dht/find?key=${encodeURIComponent(key)}`);
      if (!r.ok) throw new Error('Peer not found — ensure they opened ZAP first');
      const data  = await r.json();
      const valid = await verifyRegistrationPacket(data);
      if (!valid) throw new Error('Verification failed');
      // Cache nodeId → zapId for reverse lookup
      ZAP.cacheNodeZapId(data.nodeId, data.zapId);
      const np = { zapId: data.zapId, nodeId: data.nodeId, status: 'connecting' };
      // DEDUP: if peer already exists by nodeId (auto-added with truncated zapId), UPDATE it
      setPeers(ps => {
        const existing = ps.find(p => p.nodeId === data.nodeId);
        if (existing) {
          // Update zapId to full version, keep status
          return ps.map(p => p.nodeId === data.nodeId ? { ...p, zapId: data.zapId } : p);
        }
        return [...ps, np];
      });
      setActive(np);
      toast(`Found ${data.zapId} — connecting…`);
      // Only create connection if not already connecting/connected
      if (!ZAP.isConnected(data.nodeId) && ZAP.getStatus(data.nodeId) !== 'connecting') {
        await ZAP.createPeerConnection(data.nodeId);
      }
      // Poll for connection
      let tries = 0;
      const chk = setInterval(() => {
        if (ZAP.isConnected(data.nodeId)) {
          clearInterval(chk);
          setPeers(ps => ps.map(p => p.nodeId === data.nodeId ? { ...p, status: 'online', zapId: data.zapId } : p));
          setActive(a => a?.nodeId === data.nodeId ? { ...a, status: 'online', zapId: data.zapId } : a);
          toast(`Connected to ${data.zapId} ✓`, 'success');
        } else if (++tries > 80) {
          clearInterval(chk);
          setPeers(ps => ps.map(p => p.nodeId === data.nodeId ? { ...p, status: 'offline' } : p));
          toast('Connection timeout — retry', 'error');
        }
      }, 500);
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      setAdding(false);
    }
  };

  // ── Send files ─────────────────────────────────────────────────────────────
  const doSend = async (fileList, isFolder = false) => {
    if (!active || !ZAP.isConnected(active.nodeId)) {
      toast('Peer not connected', 'error');
      return;
    }
    const files = Array.from(fileList);
    if (!files.length) return;
    const activeSnap = active; // capture active at time of send

    const onProg = p => {
      setSendProg({ ...p, nodeId: activeSnap.nodeId });
      if (p.pct >= 100) setTimeout(() => setSendProg(null), 2500);
    };

    if (isFolder) {
      const name = files[0].webkitRelativePath?.split('/')[0] ?? 'folder';
      try {
        await ZAP.sendFolder(files, name, activeSnap.nodeId, onProg);
        const e = { direction: 'sent', name: name + '.zip', size: files.reduce((a, f) => a + f.size, 0), fileType: 'ZIP', ext: 'zip', from: identity.zapId, to: activeSnap.zapId, timestamp: Date.now() };
        addTx(activeSnap.nodeId, e);
        anchorBlock({ ...e, receiverNodeId: activeSnap.nodeId });
        toast(`Sent folder: ${name}`, 'success');
      } catch (e) { toast('Folder failed: ' + e.message, 'error'); }
    } else {
      for (const file of files) {
        try {
          await ZAP.sendFile(file, activeSnap.nodeId, onProg);
          const e = { direction: 'sent', name: file.name, size: file.size, fileType: getType(file.name), ext: getExt(file.name), from: identity.zapId, to: activeSnap.zapId, timestamp: Date.now() };
          addTx(activeSnap.nodeId, e);
          anchorBlock({ ...e, receiverNodeId: activeSnap.nodeId });
          toast(`Sent: ${file.name}`, 'success');
        } catch (e) { toast(`Failed ${file.name}: ` + e.message, 'error'); }
      }
    }
  };

  // ── Setup ──────────────────────────────────────────────────────────────────
  const [creatingId, setCreatingId] = useState(false);
  const doSetup = async () => {
    const clean = uname.trim().toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 16);
    if (!clean || clean.length < 2) { toast('Min 2 characters, letters/numbers only', 'error'); return; }
    if (creatingId) return;
    setCreatingId(true);
    try {
      console.log('[ZAP] Creating identity for:', clean);
      const id = await createIdentity(clean);
      console.log('[ZAP] Identity created:', id?.zapId, id);
      if (!id || !id.zapId || !id.nodeId) throw new Error('Identity creation returned empty result');
      setIdentity(id);
      setScreen('app');
    } catch (e) {
      console.error('[ZAP] createIdentity error:', e);
      toast('Error: ' + (e.message || String(e)), 'error');
    } finally {
      setCreatingId(false);
    }
  };

  // ── Chain filtering ────────────────────────────────────────────────────────
  const filteredChain = chain.filter(b => {
    const q = chainQ.toLowerCase();
    if (chainDir !== 'all') {
      const isSent = (b.direction || b.status || '').toLowerCase().includes('sent');
      if (chainDir === 'sent' && !isSent) return false;
      if (chainDir === 'received' && isSent) return false;
    }
    if (!q) return true;
    return (
      (b.fileName || '').toLowerCase().includes(q) ||
      (b.senderZapId || '').toLowerCase().includes(q) ||
      (b.receiverZapId || '').toLowerCase().includes(q) ||
      (b.fileType || '').toLowerCase().includes(q) ||
      (b.merkleRoot || '').toLowerCase().includes(q) ||
      (b.blockHash || '').toLowerCase().includes(q) ||
      fmtBytes(b.fileSize || 0).toLowerCase().includes(q) ||
      fmtDate(b.timestamp).toLowerCase().includes(q)
    );
  });

  // ── Render: Loading ────────────────────────────────────────────────────────
  if (screen === 'loading') {
    return (
      <>
        <style>{CSS}</style>
        <div className="loading">LOADING…</div>
      </>
    );
  }

  // ── Render: Setup ──────────────────────────────────────────────────────────
  if (screen === 'setup') {
    const clean = uname.trim().toLowerCase().replace(/[^a-z0-9]/g, '');
    return (
      <>
        <style>{CSS}</style>
        <div className="setup">
          <div className="setup-card">
            <div className="setup-logo">
              <span className="setup-bolt">⚡</span>
              <span className="setup-name">ZAP</span>
            </div>
            <div className="setup-sub">
              Pure P2P file sharing.<br/>
              <strong>No servers · No limits</strong> · Files go direct.<br/>
              Works on any device on the same WiFi.
            </div>
            <div className="setup-lbl">Choose username</div>
            <input
              className="setup-input"
              placeholder="alice"
              maxLength={16}
              value={uname}
              onChange={e => setUname(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && doSetup()}
              autoFocus
              autoCapitalize="none"
              autoCorrect="off"
            />
            {clean && (
              <div className="setup-preview">
                {clean}#????
                <div className="setup-preview-sub">4-char hash added automatically</div>
              </div>
            )}
            <button className="setup-btn" onClick={doSetup} disabled={!clean || clean.length < 2 || creatingId}>
              {creatingId ? '⏳ Creating…' : '⚡ Create Identity'}
            </button>
          </div>
        </div>
      </>
    );
  }

  // ── Render: App ────────────────────────────────────────────────────────────
  const isConn   = active ? ZAP.isConnected(active.nodeId) : false;
  const connStatus = active ? (isConn ? 'online' : ZAP.getStatus(active.nodeId)) : 'none';
  // Deduplicate peers by nodeId at render time (safety net for any race conditions)
  const dedupedPeers = peers.filter((p, i, arr) => arr.findIndex(x => x.nodeId === p.nodeId) === i);
  const activeTx = active ? (txMap[active.nodeId] ?? []) : [];
  const isMobile = /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent);

  return (
    <>
      <style>{CSS}</style>
      <div className="app">

        {/* ── TOPBAR ── */}
        <header className="topbar">
          <div className="topbar-logo">
            <span className="topbar-bolt">⚡</span>
            <span className="topbar-zap">ZAP</span>
          </div>
          <div className="topbar-id">
            <div className="topbar-zapid">{identity?.zapId}</div>
            <div className="topbar-nodeid">{identity?.nodeId}</div>
          </div>
          <span className={`status-dot ${online ? 'on' : 'off'}`} title={online ? `Online · ${dhtCount} peers` : 'Offline'} />
        </header>

        <div className="layout">

          {/* ── SIDEBAR ── */}
          <aside className="sidebar">
            <div className="add-row">
              <input
                className="add-input"
                placeholder="username#HASH"
                value={addInput}
                onChange={e => setAddInput(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && doAdd()}
                autoCapitalize="none"
                autoCorrect="off"
              />
              <button className="add-btn" onClick={doAdd} disabled={adding || !addInput.trim()}>
                {adding ? '…' : 'ADD'}
              </button>
            </div>

            {/* Peers tab */}
            {stab === 'peers' && (
              <div className="peer-list">
                {peers.length === 0 && (
                  <div className="peer-empty">
                    No peers yet.<br/>
                    Enter <span>username#HASH</span> above.<br/>
                    Or wait — others will auto-appear.
                  </div>
                )}
                {dedupedPeers.map(p => (
                  <div
                    key={p.nodeId}
                    className={`peer-item${active?.nodeId === p.nodeId ? ' active' : ''}`}
                    onClick={() => setActive(p)}
                  >
                    <div className="peer-av">
                      {parseZapId(p.zapId).username?.slice(0, 2).toUpperCase()}
                    </div>
                    <div className="peer-info">
                      <div className="peer-name">{p.zapId}</div>
                      <div className="peer-node">{p.nodeId.slice(0, 16)}…</div>
                    </div>
                    <span className={`peer-badge ${p.status === 'online' ? 'on' : p.status === 'connecting' ? 'connecting' : 'off'}`}>
                      {p.status === 'online' ? 'ON' : p.status === 'connecting' ? '…' : 'OFF'}
                    </span>
                  </div>
                ))}
              </div>
            )}

            {/* Chain sidebar */}
            {stab === 'chain' && (
              <div className="csidebar">
                {chain.length === 0 && <div className="peer-empty">No blocks yet.</div>}
                {chain.map((b, i) => {
                  const isSent = (b.direction || b.status || '').toLowerCase().includes('sent');
                  return (
                    <div key={i} className="csb-item" onClick={() => { setTab('chain'); if (active) loadChain(); }}>
                      <div className="csb-top">
                        <span className={`csb-badge ${isSent ? 'csb-sent' : 'csb-recv'}`}>
                          {isSent ? '↑' : '↓'} {(b.direction || b.status || '?').toUpperCase()}
                        </span>
                        <span style={{ fontSize: 8, color: 'var(--gray)', fontFamily: 'var(--mono)' }}>{fmtTime(b.timestamp)}</span>
                      </div>
                      <div className="csb-fname">{typeIcon(b.fileType || getType(b.fileName || ''))} {b.fileName || '—'}</div>
                      <div className="csb-meta">{fmtBytes(b.fileSize || 0)} · {b.senderZapId || '?'} → {b.receiverZapId || '?'}</div>
                    </div>
                  );
                })}
              </div>
            )}

            {/* Net sidebar */}
            {stab === 'net' && (
              <div className="net-scroll">
                <div className="net-card">
                  <div className="net-card-title">Network</div>
                  <div className="net-row"><span className="net-lbl">Status</span><span className="net-val" style={{ color: online ? 'var(--grn)' : 'var(--red)' }}>{online ? 'ONLINE' : 'OFFLINE'}</span></div>
                  <div className="net-row"><span className="net-lbl">DHT peers</span><span className="net-val">{dhtCount}</span></div>
                  <div className="net-row"><span className="net-lbl">Connected</span><span className="net-val">{peers.filter(p => p.status === 'online').length}</span></div>
                  <div className="net-row"><span className="net-lbl">Backend</span><span className="net-val" style={{ fontSize: 7 }}>{API_BASE}</span></div>
                </div>
                <div className="net-card">
                  <div className="net-card-title">Identity</div>
                  <div className="net-row"><span className="net-lbl">ZAP ID</span><span className="net-val">{identity?.zapId}</span></div>
                  <div className="net-row" style={{ flexDirection: 'column', gap: 3 }}>
                    <span className="net-lbl">Node ID (full)</span>
                    <span style={{ color: 'var(--w)', fontFamily: 'var(--mono)', fontSize: 7, wordBreak: 'break-all', lineHeight: 1.7 }}>{identity?.nodeId}</span>
                  </div>
                  <div className="net-row"><span className="net-lbl">Crypto</span><span className="net-val">{identity?.isFallback ? 'Fallback (HTTP)' : 'Ed25519 ✓'}</span></div>
                </div>
                <div className="net-card">
                  <div className="net-card-title">Transfer Engine</div>
                  <div className="net-row"><span className="net-lbl">Channels</span><span className="net-val">{isMobile ? 2 : 4} parallel</span></div>
                  <div className="net-row"><span className="net-lbl">Chunk size</span><span className="net-val">{isMobile ? '64' : '256'} KB</span></div>
                  <div className="net-row"><span className="net-lbl">Max file</span><span className="net-val">Unlimited</span></div>
                  <div className="net-row"><span className="net-lbl">Disk write</span><span className="net-val" style={{ color: 'showSaveFilePicker' in window ? 'var(--grn)' : 'var(--gold)' }}>{'showSaveFilePicker' in window ? 'FS API ✓' : 'IDB fallback'}</span></div>
                </div>
              </div>
            )}

            <div className="sidetabs">
              {[['peers', 'PEERS'], ['chain', 'CHAIN'], ['net', 'NET']].map(([id, lbl]) => (
                <button key={id} className={`sidetab${stab === id ? ' on' : ''}`} onClick={() => setStab(id)}>{lbl}</button>
              ))}
            </div>
          </aside>

          {/* ── MAIN PANEL ── */}
          <main className="main">
            {!active ? (
              <div className="empty">
                <div className="empty-logo">
                  <span className="empty-bolt">⚡</span>
                  <span className="empty-text">ZAP</span>
                </div>
                <div className="empty-sub">Ultra-Fast · Decentralized · P2P</div>
                <div className="empty-id">
                  <div className="empty-id-lbl">Your ZAP ID</div>
                  <div className="empty-id-zap">{identity?.zapId}</div>
                  <div className="empty-id-node">{identity?.nodeId}</div>
                </div>
                <div className="feat-grid">
                  <div className="feat"><div className="feat-icon">⚡</div><div className="feat-title">Ultra-Fast</div><div className="feat-desc">4 parallel channels, up to 40 MB/s on LAN</div></div>
                  <div className="feat"><div className="feat-icon">💾</div><div className="feat-title">Any Size</div><div className="feat-desc">15GB+ files write direct to disk, no RAM crash</div></div>
                  <div className="feat"><div className="feat-icon">📁</div><div className="feat-title">Folders</div><div className="feat-desc">Auto-zipped, original quality preserved</div></div>
                  <div className="feat"><div className="feat-icon">⛓</div><div className="feat-title">Blockchain</div><div className="feat-desc">Merkle-verified block per transfer, searchable</div></div>
                </div>
              </div>
            ) : (
              <>
                {/* Transfer header */}
                <div className="txhead">
                  <div className="txhead-av">{parseZapId(active.zapId).username?.slice(0, 2).toUpperCase()}</div>
                  <div className="txhead-info">
                    <div className="txhead-name">{active.zapId}</div>
                    <div className="txhead-node">{active.nodeId}</div>
                  </div>
                  <span className={`conn-pill ${isConn ? 'on' : connStatus === 'connecting' ? 'wait' : 'off'}`}>
                    {isConn ? '● CONNECTED' : connStatus === 'connecting' ? '◌ CONNECTING…' : '○ OFFLINE'}
                  </span>
                </div>

                {/* Send progress */}
                {sendProg && sendProg.nodeId === active.nodeId && (
                  <div className="prog">
                    <div className="prog-row">
                      <span>↑ {sendProg.name} — {fmtBytes(sendProg.bytes || 0)} / {fmtBytes(sendProg.total || 0)}</span>
                      <span className="prog-speed">{sendProg.speed} MB/s · {sendProg.pct}%</span>
                    </div>
                    <div className="prog-track"><div className="prog-fill" style={{ width: sendProg.pct + '%' }} /></div>
                  </div>
                )}

                {/* Recv progress */}
                {recvProg && recvProg.nodeId === active.nodeId && (
                  <div className="prog">
                    <div className="prog-row">
                      <span>↓ {recvProg.name} — {fmtBytes(recvProg.bytes || 0)} / {fmtBytes(recvProg.total || 0)}</span>
                      <span style={{ color: 'var(--grn)', fontFamily: 'var(--mono)', fontWeight: 600 }}>{recvProg.speed} MB/s · {recvProg.pct}%</span>
                    </div>
                    <div className="prog-track"><div className="prog-fill recv" style={{ width: recvProg.pct + '%' }} /></div>
                  </div>
                )}

                {/* Tab bar */}
                <div className="tabs">
                  {[['send', 'SEND'], ['history', 'HISTORY'], ['chain', 'CHAIN']].map(([id, lbl]) => (
                    <button
                      key={id}
                      className={`tab-btn${tab === id ? ' on' : ''}`}
                      onClick={() => { setTab(id); if (id === 'chain') loadChain(); }}
                    >{lbl}</button>
                  ))}
                </div>

                {/* ── SEND TAB ── */}
                {tab === 'send' && (
                  <div className="send-area">
                    <div
                      className={`dropzone${drag ? ' drag' : ''}`}
                      onDragOver={e => { e.preventDefault(); setDrag(true); }}
                      onDragLeave={() => setDrag(false)}
                      onDrop={e => { e.preventDefault(); setDrag(false); doSend(e.dataTransfer.files); }}
                      onClick={() => isConn && fileInputRef.current?.click()}
                    >
                      <div className="dropzone-icon">⚡</div>
                      <div className="dropzone-title">{isConn ? 'Drop files here to send' : 'Waiting for connection…'}</div>
                      <div className="dropzone-sub">
                        {isConn ? (
                          <>Any file type · <strong>No size limit</strong> · Movies, photos, music, apps<br /><strong>Original quality</strong> — zero compression, zero servers</>
                        ) : 'Peer connection establishing, please wait…'}
                      </div>
                    </div>
                    <div className="send-btns">
                      <button className="send-btn primary" disabled={!isConn} onClick={() => fileInputRef.current?.click()}>📄 Select Files</button>
                      <button className="send-btn" disabled={!isConn} onClick={() => folderInputRef.current?.click()}>📁 Send Folder</button>
                    </div>
                    {'showSaveFilePicker' in window
                      ? <div className="info-box ok">✓ File System API active — files write direct to disk. Safe for 15GB+.</div>
                      : <div className="info-box warn">⚠ No FS API — files buffered in memory (max ~2GB). Use Chrome/Edge for large files.</div>}
                  </div>
                )}

                {/* ── HISTORY TAB ── */}
                {tab === 'history' && (
                  <div className="history">
                    {activeTx.length === 0 && <div className="hist-empty">No transfers with this peer yet.</div>}
                    {activeTx.map((tx, i) => (
                      <div key={i} className="hist-item">
                        <div className="hist-head">
                          <span className={`hist-badge ${tx.direction === 'sent' ? 'badge-sent' : 'badge-recv'}`}>
                            {tx.direction === 'sent' ? '↑ SENT' : '↓ RECEIVED'}
                          </span>
                          <span className="hist-badge" style={{ color: 'var(--gray)', borderColor: 'var(--gray2)' }}>
                            {typeIcon(tx.fileType)} {tx.fileType}
                          </span>
                          <span className="hist-name">{tx.name}</span>
                          {tx.url && <a className="dl-btn" href={tx.url} download={tx.name}>DOWNLOAD</a>}
                        </div>
                        <div className="hist-grid">
                          <div className="hist-field">Size <span>{fmtBytes(tx.size)}</span></div>
                          <div className="hist-field">Type <span>{tx.fileType}</span></div>
                          <div className="hist-field">From <span>{tx.from}</span></div>
                          <div className="hist-field">To <span>{tx.to}</span></div>
                          <div className="hist-field">Time <span>{fmtDate(tx.timestamp)}</span></div>
                          {tx.savedToDisk && <div className="hist-field">Storage <span style={{ color: 'var(--grn)' }}>Disk ✓</span></div>}
                        </div>
                        {tx.merkleRoot && (
                          <div className="hist-hash"><strong style={{ color: 'var(--gold)' }}>Merkle: </strong>{tx.merkleRoot}</div>
                        )}
                      </div>
                    ))}
                  </div>
                )}

                {/* ── CHAIN TAB ── */}
                {tab === 'chain' && (
                  <div className="chain-container">
                    <div className="chain-toolbar">
                      <span className="chain-title">⛓ J-CHAIN</span>
                      <span className="chain-count">{filteredChain.length}/{chain.length} blocks</span>
                      <input
                        className="chain-search"
                        placeholder="Search filename, user, hash, size, date…"
                        value={chainQ}
                        onChange={e => setChainQ(e.target.value)}
                      />
                      <div className="chain-filter-row">
                        {[['all', 'ALL'], ['sent', '↑ SENT'], ['received', '↓ RECV']].map(([v, l]) => (
                          <button key={v} className={`chain-filter${chainDir === v ? ' on' : ''}`} onClick={() => setChainDir(v)}>{l}</button>
                        ))}
                      </div>
                    </div>
                    <div className="chain-list">
                      {filteredChain.length === 0 && (
                        <div className="chain-empty">
                          {chain.length === 0 ? 'No blocks yet. Send a file to create one.' : 'No blocks match your search.'}
                        </div>
                      )}
                      {filteredChain.map((b, i) => {
                        const isSent   = (b.direction || b.status || '').toLowerCase().includes('sent');
                        const ft       = b.fileType || getType(b.fileName || '');
                        const blockNum = chain.indexOf(b);
                        return (
                          <div key={i} className="block-card">
                            <div className="block-header">
                              <span className="block-num">BLOCK #{chain.length - blockNum}</span>
                              <span className={`block-dir ${isSent ? 'sent' : 'received'}`}>{isSent ? '↑ SENT' : '↓ RECEIVED'}</span>
                              <span className="block-icon">{typeIcon(ft)}</span>
                              <span className="block-fname">{b.fileName || '—'}</span>
                            </div>
                            <div className="block-body">
                              <div className="block-grid">
                                <div className="block-row">
                                  <div className="block-label">File Name</div>
                                  <div className="block-val big">{b.fileName || '—'}</div>
                                </div>
                                <div className="block-row">
                                  <div className="block-label">File Type</div>
                                  <div className="block-val big">{typeIcon(ft)} {ft}</div>
                                </div>
                                <div className="block-row">
                                  <div className="block-label">Size</div>
                                  <div className="block-val big gold">{fmtBytes(b.fileSize || 0)}</div>
                                </div>
                                <div className="block-row">
                                  <div className="block-label">Date &amp; Time</div>
                                  <div className="block-val">{fmtDate(b.timestamp)}</div>
                                </div>
                                <div className="block-row">
                                  <div className="block-label">{isSent ? '📤 Sent To' : '📥 Received From'}</div>
                                  <div className={`block-val big ${isSent ? 'gold' : 'grn'}`}>
                                    {isSent ? (b.receiverZapId || b.receiverNodeId?.slice(0, 12) || '?') : (b.senderZapId || b.senderNodeId?.slice(0, 12) || '?')}
                                  </div>
                                </div>
                                <div className="block-row">
                                  <div className="block-label">{isSent ? '📤 Sent From' : '📥 Saved To'}</div>
                                  <div className="block-val">
                                    {isSent ? (b.senderZapId || b.senderNodeId?.slice(0, 12) || '?') : (b.receiverZapId || b.receiverNodeId?.slice(0, 12) || '?')}
                                  </div>
                                </div>
                                <div className="block-row">
                                  <div className="block-label">Status</div>
                                  <div className="block-val" style={{ color: isSent ? 'var(--gold)' : 'var(--grn)' }}>{b.status || '—'}</div>
                                </div>
                                <div className="block-row">
                                  <div className="block-label">Direction</div>
                                  <div className="block-val">{b.direction || b.status || '—'}</div>
                                </div>
                              </div>
                            </div>
                            {b.merkleRoot && (
                              <div className="block-merkle">
                                <div className="block-merkle-lbl">⚡ Merkle Root — File Integrity Proof</div>
                                <div className="block-merkle-val">{b.merkleRoot}</div>
                              </div>
                            )}
                            <div className="block-chain">
                              <span className="block-chain-icon">⛓</span>
                              <div className="block-chain-val">
                                <span style={{ color: 'var(--gold)', fontSize: 7, letterSpacing: 1 }}>BLOCK HASH  </span>
                                {b.blockHash || '—'}
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
              </>
            )}
          </main>
        </div>
      </div>

      {/* Hidden file inputs */}
      <input ref={fileInputRef} type="file" multiple style={{ display: 'none' }}
        onChange={e => { doSend(e.target.files); e.target.value = ''; }} />
      <input ref={folderInputRef} type="file" multiple style={{ display: 'none' }}
        // @ts-ignore
        webkitdirectory=""
        onChange={e => { doSend(e.target.files, true); e.target.value = ''; }} />

      {/* Toasts */}
      <div className="toasts">
        {toasts.map(t => (
          <div key={t.id} className={`toast ${t.type}`}>
            <span>{t.type === 'success' ? '✓' : t.type === 'error' ? '✗' : '⚡'}</span>
            {t.msg}
          </div>
        ))}
      </div>
    </>
  );
}