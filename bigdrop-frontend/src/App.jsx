/**
 * ZAP App.jsx v7 — FINAL WORKING
 *
 * ROOT CAUSE FIXES:
 *  1. API_BASE: hardcoded MacBook IP — phone was calling localhost which is itself
 *  2. Signal poll: proper double-JSON unwrap + skip own signals
 *  3. setNewPeerHandler: ZAP.getNodeZapId / cacheNodeZapId now exist in webrtc.js
 *  4. Connection timeout was 60s but ICE needs time — increased + TURN servers added
 *  5. doPoll is a named function, no "poll is not a function" error
 */
import React, { useState, useEffect, useRef, useCallback } from "react";
import * as ZAP from "./webrtc/webrtc.js";
import {
  loadOrCreateIdentity, createIdentity,
  buildRegistrationPacket, verifyRegistrationPacket,
  zapIdToLookupKey, parseZapId,
} from "./webrtc/Identity.js";

// ── CHANGE THIS TO YOUR MACBOOK IP ────────────────────────────────────────────
// Find it: open Terminal → type: ipconfig getifaddr en0
// It looks like: 192.168.43.228
// Production: reads from VITE_BACKEND_URL env var (set in Vercel dashboard)
// Local dev: set in .env.local as VITE_BACKEND_URL=http://localhost:8080
const API_BASE = (
  import.meta.env.VITE_BACKEND_URL ||
  'https://zap-p2p-file-sharing.onrender.com'
).replace(/\/+$/, '') + '/api/jchain';
// ─────────────────────────────────────────────────────────────────────────────

const fmtBytes = b => {
  if (!b) return '0 B';
  if (b>=1099511627776) return (b/1099511627776).toFixed(2)+' TB';
  if (b>=1073741824)    return (b/1073741824).toFixed(2)+' GB';
  if (b>=1048576)       return (b/1048576).toFixed(1)+' MB';
  if (b>=1024)          return (b/1024).toFixed(0)+' KB';
  return b+' B';
};
const fmtDate = ts => ts ? new Date(ts).toLocaleString([],{dateStyle:'medium',timeStyle:'short'}) : '—';
const getExt  = n => (n?.split('.').pop()||'').toLowerCase();
const getType = n => {
  const e=getExt(n);
  return ({mp4:'VIDEO',mov:'VIDEO',avi:'VIDEO',mkv:'VIDEO',webm:'VIDEO',
    mp3:'AUDIO',flac:'AUDIO',wav:'AUDIO',aac:'AUDIO',m4a:'AUDIO',
    jpg:'IMAGE',jpeg:'IMAGE',png:'IMAGE',gif:'IMAGE',webp:'IMAGE',heic:'IMAGE',
    pdf:'PDF',doc:'DOC',docx:'DOC',xls:'SHEET',xlsx:'SHEET',
    zip:'ZIP',rar:'ZIP',tar:'ARCHIVE',gz:'ARCHIVE',
    apk:'APP',exe:'APP',dmg:'APP',
    js:'CODE',ts:'CODE',py:'CODE',java:'CODE',
    txt:'TEXT',csv:'TEXT',json:'TEXT',
  })[e]??'FILE';
};
const typeIcon = t => ({VIDEO:'🎬',AUDIO:'🎵',IMAGE:'🖼',PDF:'📄',DOC:'📝',
  SHEET:'📊',ZIP:'🗜',ARCHIVE:'📦',APP:'⚙',CODE:'💻',TEXT:'📃',FILE:'📎'})[t]??'📎';

const CSS = `
@import url('https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap');
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg:#000;--bg1:#0a0a0a;--bg2:#111;--bg3:#1a1a1a;--bg4:#222;
  --gold:#FFB800;--gold2:#FFC933;--gold3:#FFDA66;
  --w:#fff;--gray:#888;--gray2:#555;
  --line:rgba(255,255,255,.07);--line2:rgba(255,255,255,.14);
  --grn:#22DD66;--red:#FF4444;
  --sans:'Space Grotesk',sans-serif;--mono:'JetBrains Mono',monospace;
}
html,body,#root{height:100%;background:var(--bg);color:var(--w);font-family:var(--sans);-webkit-text-size-adjust:100%;overflow:hidden}
::-webkit-scrollbar{width:3px}::-webkit-scrollbar-thumb{background:var(--bg4)}
@keyframes bolt{0%,100%{filter:drop-shadow(0 0 8px var(--gold))}50%{filter:drop-shadow(0 0 18px var(--gold))}}
@keyframes blink{0%,100%{opacity:1}50%{opacity:.4}}

.setup{min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px;
  background:radial-gradient(ellipse at 50% 30%,rgba(255,184,0,.08),transparent 65%)}
.setup-card{width:100%;max-width:420px;background:var(--bg1);border:1px solid rgba(255,184,0,.3);padding:36px 28px}
.setup-logo{display:flex;align-items:center;gap:10px;margin-bottom:28px}
.setup-bolt{font-size:32px;animation:bolt 2s ease-in-out infinite}
.setup-name{font-size:34px;font-weight:700;letter-spacing:-1px;background:linear-gradient(135deg,var(--gold),var(--gold3),#fff);-webkit-background-clip:text;-webkit-text-fill-color:transparent}
.setup-sub{font-size:12px;color:var(--gray);margin-bottom:22px;line-height:1.7}
.setup-sub strong{color:var(--gold)}
.setup-lbl{font-size:9px;color:var(--gray);letter-spacing:1.5px;text-transform:uppercase;margin-bottom:6px}
.setup-input{width:100%;background:var(--bg2);border:1px solid var(--line2);padding:12px 14px;color:var(--w);font-family:var(--mono);font-size:15px;outline:none;-webkit-appearance:none;transition:border-color .2s}
.setup-input:focus{border-color:var(--gold)}.setup-input::placeholder{color:var(--gray2)}
.setup-preview{margin-top:9px;padding:10px 14px;background:var(--bg2);border-left:3px solid var(--gold);font-family:var(--mono);font-size:16px;font-weight:600;color:var(--gold)}
.setup-preview-sub{font-size:9px;color:var(--gray);margin-top:2px;font-family:var(--sans)}
.setup-btn{width:100%;margin-top:20px;padding:13px;background:var(--gold);border:none;color:#000;font-family:var(--sans);font-size:14px;font-weight:700;cursor:pointer;letter-spacing:.5px;transition:background .15s}
.setup-btn:hover:not(:disabled){background:var(--gold2)}.setup-btn:disabled{opacity:.4;cursor:not-allowed}
.loading{min-height:100vh;display:flex;align-items:center;justify-content:center;font-family:var(--mono);font-size:12px;color:var(--gold);letter-spacing:3px}

.app{display:grid;grid-template-rows:50px 1fr;height:100vh;overflow:hidden}
.topbar{background:var(--bg1);border-bottom:1px solid var(--line);display:flex;align-items:center;padding:0 14px;gap:10px;flex-shrink:0}
.topbar-logo{display:flex;align-items:center;gap:6px;flex-shrink:0}
.topbar-bolt{font-size:18px;animation:bolt 2s ease-in-out infinite}
.topbar-zap{font-size:19px;font-weight:700;letter-spacing:-.5px;background:linear-gradient(135deg,var(--gold),var(--gold3));-webkit-background-clip:text;-webkit-text-fill-color:transparent}
.topbar-id{flex:1;min-width:0}
.topbar-zapid{font-size:12px;font-weight:600;color:var(--gold);font-family:var(--mono);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.topbar-nodeid{font-size:7px;color:var(--gray);font-family:var(--mono);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:1px}
.status-dot{width:7px;height:7px;border-radius:50%;flex-shrink:0}
.status-dot.on{background:var(--grn);box-shadow:0 0 5px var(--grn)}.status-dot.off{background:var(--red)}

.layout{display:grid;grid-template-columns:220px 1fr;overflow:hidden;height:100%}
@media(max-width:640px){.layout{grid-template-columns:1fr;grid-template-rows:auto 1fr}.sidebar{border-right:none!important;border-bottom:1px solid var(--line);max-height:200px}}

.sidebar{background:var(--bg1);border-right:1px solid var(--line);display:flex;flex-direction:column;overflow:hidden}
.add-row{display:flex;flex-shrink:0;border-bottom:1px solid var(--line)}
.add-input{flex:1;background:var(--bg2);border:none;padding:9px 10px;color:var(--w);font-family:var(--mono);font-size:11px;outline:none;min-width:0}
.add-input::placeholder{color:var(--gray2)}.add-input:focus{background:var(--bg3)}
.add-btn{padding:9px 11px;background:var(--gold);border:none;color:#000;font-family:var(--sans);font-size:10px;font-weight:700;cursor:pointer;letter-spacing:1px;flex-shrink:0}
.add-btn:hover{background:var(--gold2)}.add-btn:disabled{opacity:.4;cursor:not-allowed}
.peer-list{flex:1;overflow-y:auto}
.peer-empty{padding:14px 12px;font-size:10px;color:var(--gray);line-height:2}.peer-empty span{color:var(--gold)}
.peer-item{display:flex;align-items:center;gap:8px;padding:9px 10px;cursor:pointer;border-bottom:1px solid var(--line);transition:background .1s}
.peer-item:hover{background:var(--bg2)}.peer-item.active{background:rgba(255,184,0,.07);border-left:3px solid var(--gold);padding-left:7px}
.peer-av{width:28px;height:28px;border-radius:50%;background:var(--bg3);border:2px solid var(--gold);display:flex;align-items:center;justify-content:center;font-size:9px;font-weight:700;color:var(--gold);font-family:var(--mono);flex-shrink:0}
.peer-info{flex:1;min-width:0}
.peer-name{font-size:11px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.peer-node{font-size:8px;color:var(--gray);font-family:var(--mono);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:1px}
.peer-badge{font-size:8px;padding:1px 5px;border:1px solid;letter-spacing:1px;font-family:var(--mono);flex-shrink:0}
.peer-badge.on{color:var(--grn);border-color:var(--grn)}.peer-badge.off{color:var(--gray2);border-color:var(--gray2)}
.peer-badge.connecting{color:var(--gold);border-color:var(--gold);animation:blink 1s ease-in-out infinite}
.sidetabs{display:flex;border-top:1px solid var(--line);flex-shrink:0}
.sidetab{flex:1;padding:8px 0;background:transparent;border:none;color:var(--gray);font-family:var(--sans);font-size:9px;font-weight:600;cursor:pointer;letter-spacing:1px;transition:.15s;border-right:1px solid var(--line)}
.sidetab:last-child{border-right:none}.sidetab.on{color:var(--gold);background:rgba(255,184,0,.05)}

.main{display:flex;flex-direction:column;overflow:hidden}
.empty{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;padding:20px;text-align:center}
.empty-logo{display:flex;align-items:center;gap:8px}
.empty-bolt{font-size:48px;animation:bolt 2s ease-in-out infinite;filter:drop-shadow(0 0 14px var(--gold))}
.empty-text{font-size:48px;font-weight:700;letter-spacing:-3px;background:linear-gradient(135deg,var(--gold),var(--gold3),#fff);-webkit-background-clip:text;-webkit-text-fill-color:transparent}
.empty-sub{font-size:10px;color:var(--gray);letter-spacing:2px;text-transform:uppercase}
.empty-id{background:var(--bg1);border:1px solid rgba(255,184,0,.2);padding:11px 14px;width:100%;max-width:340px;text-align:left}
.empty-id-lbl{font-size:8px;color:var(--gray);letter-spacing:1.5px;text-transform:uppercase;margin-bottom:4px}
.empty-id-zap{font-size:13px;font-weight:700;color:var(--gold);font-family:var(--mono);margin-bottom:2px}
.empty-id-node{font-size:7px;color:var(--gray);font-family:var(--mono);word-break:break-all;line-height:1.7}
.feat-grid{display:grid;grid-template-columns:1fr 1fr;gap:6px;width:100%;max-width:340px}
.feat{background:var(--bg1);border:1px solid var(--line);padding:9px}
.feat-icon{font-size:14px;margin-bottom:3px}.feat-title{font-size:10px;font-weight:600;margin-bottom:2px}
.feat-desc{font-size:8px;color:var(--gray);line-height:1.5}

.txhead{padding:9px 12px;border-bottom:1px solid var(--line);background:var(--bg1);flex-shrink:0;display:flex;align-items:flex-start;gap:9px}
.txhead-av{width:34px;height:34px;border-radius:50%;background:var(--bg3);border:2px solid var(--gold);display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:700;color:var(--gold);font-family:var(--mono);flex-shrink:0}
.txhead-info{flex:1;min-width:0}
.txhead-name{font-size:13px;font-weight:600}.txhead-node{font-size:7px;color:var(--gray);font-family:var(--mono);word-break:break-all;line-height:1.5;margin-top:1px}
.conn-pill{font-size:8px;padding:2px 7px;border:1px solid;letter-spacing:1px;font-family:var(--mono);flex-shrink:0;margin-top:2px}
.conn-pill.on{color:var(--grn);border-color:var(--grn)}.conn-pill.wait{color:var(--gold);border-color:var(--gold);animation:blink 1s ease-in-out infinite}.conn-pill.off{color:var(--gray2);border-color:var(--gray2)}

.prog{padding:6px 12px;background:var(--bg1);border-bottom:1px solid var(--line);flex-shrink:0}
.prog-row{display:flex;justify-content:space-between;font-size:9px;color:var(--gray);font-family:var(--mono);margin-bottom:3px}
.prog-spd{color:var(--gold);font-weight:600}
.prog-track{height:2px;background:var(--bg3)}.prog-fill{height:100%;background:var(--gold);transition:width .2s}
.prog-fill.recv{background:var(--grn)}

.tabs{display:flex;border-bottom:1px solid var(--line);flex-shrink:0;background:var(--bg1)}
.tab-btn{flex:1;padding:8px 0;background:transparent;border:none;border-bottom:2px solid transparent;color:var(--gray);font-family:var(--sans);font-size:9px;font-weight:700;cursor:pointer;letter-spacing:1.5px;transition:.15s}
.tab-btn.on{color:var(--gold);border-bottom-color:var(--gold)}

.send-area{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:18px 14px;gap:12px;overflow-y:auto}
.dropzone{width:100%;max-width:480px;border:2px dashed rgba(255,184,0,.35);padding:36px 20px;text-align:center;cursor:pointer;transition:.2s;background:rgba(255,184,0,.01)}
.dropzone:hover,.dropzone.drag{border-color:var(--gold);background:rgba(255,184,0,.05)}
.dropzone-icon{font-size:38px;margin-bottom:10px}.dropzone-title{font-size:14px;font-weight:600;margin-bottom:4px}
.dropzone-sub{font-size:10px;color:var(--gray);line-height:1.8}.dropzone-sub strong{color:var(--gold)}
.send-btns{display:flex;gap:7px;flex-wrap:wrap;justify-content:center;width:100%;max-width:480px}
.send-btn{flex:1;min-width:110px;padding:10px 12px;background:var(--bg1);border:1px solid var(--line2);color:var(--w);font-family:var(--sans);font-size:11px;font-weight:500;cursor:pointer;transition:.15s;display:flex;align-items:center;justify-content:center;gap:5px}
.send-btn:hover:not(:disabled){border-color:var(--gold);color:var(--gold)}.send-btn:disabled{opacity:.3;cursor:not-allowed}
.send-btn.primary{background:var(--gold);border-color:var(--gold);color:#000;font-weight:700}.send-btn.primary:hover{background:var(--gold2)}
.info-box{width:100%;max-width:480px;padding:8px 11px;font-size:9px;line-height:1.8;border:1px solid}
.info-box.ok{background:rgba(34,221,102,.04);border-color:rgba(34,221,102,.2);color:var(--grn)}
.info-box.warn{background:rgba(255,184,0,.04);border-color:rgba(255,184,0,.2);color:var(--gold)}

.history{flex:1;overflow-y:auto}
.hist-empty{padding:24px;font-size:10px;color:var(--gray);text-align:center}
.hist-item{padding:9px 11px;border-bottom:1px solid var(--line)}
.hist-head{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-bottom:4px}
.hist-badge{font-size:7px;padding:2px 5px;border:1px solid;letter-spacing:1px;font-family:var(--mono)}
.badge-sent{color:var(--gold);border-color:var(--gold)}.badge-recv{color:var(--grn);border-color:var(--grn)}
.hist-name{font-size:12px;font-weight:600;flex:1;min-width:0;word-break:break-all}
.hist-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(110px,1fr));gap:2px 6px}
.hist-field{font-size:8px;color:var(--gray)}.hist-field span{color:var(--w);font-family:var(--mono)}
.hist-hash{font-size:7px;color:var(--gray);font-family:var(--mono);word-break:break-all;line-height:1.5;margin-top:3px;padding:3px 7px;background:var(--bg2);border-left:2px solid var(--gold)}
.dl-btn{display:inline-block;padding:3px 8px;border:1px solid var(--gold);color:var(--gold);font-size:7px;cursor:pointer;text-decoration:none;letter-spacing:1px;margin-top:3px;background:transparent}
.dl-btn:hover{background:rgba(255,184,0,.1)}

.chain-wrap{flex:1;display:flex;flex-direction:column;overflow:hidden}
.chain-toolbar{padding:7px 11px;background:var(--bg1);border-bottom:1px solid var(--line);flex-shrink:0;display:flex;align-items:center;gap:7px;flex-wrap:wrap}
.chain-title{font-size:9px;font-weight:700;color:var(--gold);letter-spacing:2px}
.chain-count{font-size:9px;color:var(--gray)}
.chain-search{flex:1;min-width:110px;background:var(--bg2);border:1px solid var(--line2);padding:4px 8px;color:var(--w);font-family:var(--mono);font-size:10px;outline:none}
.chain-search::placeholder{color:var(--gray2)}.chain-search:focus{border-color:var(--gold)}
.chain-filters{display:flex;gap:4px}
.cfilter{padding:2px 7px;background:transparent;border:1px solid var(--line2);color:var(--gray);font-family:var(--sans);font-size:8px;cursor:pointer;letter-spacing:.5px;transition:.15s}
.cfilter.on,.cfilter:hover{border-color:var(--gold);color:var(--gold)}
.chain-list{flex:1;overflow-y:auto;padding:7px}
.chain-empty{padding:20px;font-size:10px;color:var(--gray);text-align:center}

.block{background:var(--bg1);border:1px solid var(--line2);margin-bottom:7px;overflow:hidden}
.block-hdr{display:flex;align-items:center;gap:7px;padding:7px 9px;background:var(--bg2);border-bottom:1px solid var(--line)}
.block-num{font-size:8px;font-family:var(--mono);color:var(--gold);letter-spacing:1px;flex-shrink:0}
.block-dir{font-size:8px;padding:2px 6px;border:1px solid;letter-spacing:1px;font-family:var(--mono);flex-shrink:0}
.block-dir.sent{color:var(--gold);border-color:var(--gold)}.block-dir.recv{color:var(--grn);border-color:var(--grn)}
.block-icon{font-size:14px;flex-shrink:0}
.block-fn{font-size:12px;font-weight:700;flex:1;min-width:0;word-break:break-all}
.block-body{padding:9px}
.block-grid{display:grid;grid-template-columns:1fr 1fr;gap:0}
@media(max-width:480px){.block-grid{grid-template-columns:1fr}}
.block-row{display:flex;flex-direction:column;padding:4px 0;border-bottom:1px solid var(--line)}
.block-row:nth-child(odd){border-right:1px solid var(--line);padding-right:8px}
.block-row:nth-child(even){padding-left:8px}
.block-row:nth-last-child(-n+2){border-bottom:none}
.block-lbl{font-size:7px;color:var(--gray);letter-spacing:.8px;text-transform:uppercase;margin-bottom:2px}
.block-val{font-size:10px;color:var(--w);font-family:var(--mono);word-break:break-all}
.block-val.big{font-size:11px;font-weight:700;font-family:var(--sans)}
.block-val.gold{color:var(--gold)}.block-val.grn{color:var(--grn)}
.block-mk{padding:6px 9px;background:var(--bg2);border-top:1px solid var(--line)}
.block-mk-lbl{font-size:7px;color:var(--gold);letter-spacing:1.5px;text-transform:uppercase;margin-bottom:2px}
.block-mk-val{font-size:7px;font-family:var(--mono);color:var(--gray);word-break:break-all;line-height:1.5}
.block-chain{padding:4px 9px;border-top:1px solid var(--line);font-size:7px;font-family:var(--mono);color:var(--gray2);word-break:break-all;line-height:1.5}

.net-scroll{flex:1;overflow-y:auto;padding:8px;display:flex;flex-direction:column;gap:7px}
.ncard{background:var(--bg1);border:1px solid var(--line);padding:10px}
.ncard-t{font-size:8px;color:var(--gold);letter-spacing:2px;text-transform:uppercase;margin-bottom:7px}
.nr{display:flex;justify-content:space-between;align-items:flex-start;padding:3px 0;border-bottom:1px solid var(--line);font-size:9px;gap:5px}
.nr:last-child{border:none}.nr-l{color:var(--gray);flex-shrink:0}
.nr-v{color:var(--w);font-family:var(--mono);text-align:right;word-break:break-all;max-width:62%;font-size:8px}

.csidebar{flex:1;overflow-y:auto}
.csb-item{padding:7px 9px;border-bottom:1px solid var(--line);cursor:pointer;transition:.1s}
.csb-item:hover{background:var(--bg2)}
.csb-top{display:flex;align-items:center;gap:5px;margin-bottom:2px}
.csb-badge{font-size:7px;padding:1px 4px;border:1px solid;letter-spacing:1px;font-family:var(--mono)}
.csb-sent{color:var(--gold);border-color:var(--gold)}.csb-recv{color:var(--grn);border-color:var(--grn)}
.csb-fname{font-size:9px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.csb-meta{font-size:8px;color:var(--gray);font-family:var(--mono)}

.toasts{position:fixed;bottom:12px;right:12px;display:flex;flex-direction:column;gap:5px;z-index:9999;pointer-events:none;max-width:260px}
@media(max-width:640px){.toasts{left:12px;right:12px;max-width:100%}}
.toast{padding:7px 11px;border:1px solid;font-size:10px;display:flex;align-items:center;gap:7px;background:var(--bg1);pointer-events:all;animation:tin .2s ease}
.toast.success{border-color:var(--grn);color:var(--grn)}.toast.error{border-color:var(--red);color:var(--red)}.toast.info{border-color:var(--gold);color:var(--gold)}
@keyframes tin{from{opacity:0;transform:translateY(5px)}to{opacity:1;transform:translateY(0)}}
`;

export default function App() {
  const [screen,   setScreen]   = useState('loading');
  const [identity, setIdentity] = useState(null);
  const [uname,    setUname]    = useState('');
  const [online,   setOnline]   = useState(false);
  const [dhtCount, setDhtCount] = useState(0);
  const [peers,    setPeers]    = useState([]);
  const [active,   setActive]   = useState(null);
  const [txMap,    setTxMap]    = useState({});
  const [sendProg, setSendProg] = useState(null);
  const [recvProg, setRecvProg] = useState(null);
  const [chain,    setChain]    = useState([]);
  const [chainQ,   setChainQ]   = useState('');
  const [chainDir, setChainDir] = useState('all');
  const [tab,      setTab]      = useState('send');
  const [stab,     setStab]     = useState('peers');
  const [adding,   setAdding]   = useState(false);
  const [addInput, setAddInput] = useState('');
  const [toasts,   setToasts]   = useState([]);
  const [drag,     setDrag]     = useState(false);
  const [creating, setCreating] = useState(false);

  const peersRef    = useRef(peers);
  const identRef    = useRef(identity);
  const activeRef   = useRef(active);
  useEffect(()=>{peersRef.current=peers;},[peers]);
  useEffect(()=>{identRef.current=identity;},[identity]);
  useEffect(()=>{activeRef.current=active;},[active]);

  const fileRef   = useRef(null);
  const folderRef = useRef(null);
  const seenSigs  = useRef(new Set());

  const toast = useCallback((msg,type='info')=>{
    const id=Date.now()+Math.random();
    setToasts(t=>[...t,{id,msg,type}]);
    setTimeout(()=>setToasts(t=>t.filter(x=>x.id!==id)),5000);
  },[]);

  const addTx = useCallback((nodeId,entry)=>{
    setTxMap(m=>({...m,[nodeId]:[entry,...(m[nodeId]??[])]}));
  },[]);

  // Load identity
  useEffect(()=>{
    loadOrCreateIdentity()
      .then(id=>{ if(id){setIdentity(id);setScreen('app');}else setScreen('setup'); })
      .catch(()=>setScreen('setup'));
  },[]);

  // Main effect
 useEffect(() => {
    if (!identity || screen !== 'app') return;
 
    // ── Register on DHT ──────────────────────────────────────────────────────
    (async () => {
      try {
        const pkt = await buildRegistrationPacket(identity);
        const key = zapIdToLookupKey(identity.zapId);
        const r   = await fetch(`${API_BASE}/dht/store`, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ key, value: JSON.stringify(pkt) }),
        });
        setOnline(r.ok);
        if (r.ok) {
          // FIX: tell webrtc.js our zapId so IDENTIFY works without DHT lookup
          ZAP.setMyZapId(identity.zapId);
          toast(`Online as ${identity.zapId}`, 'success');
        } else {
          toast('DHT store failed', 'error');
        }
      } catch {
        setOnline(false);
        toast('Backend offline — check Render is awake', 'error');
      }
    })();
 
    // ── Keep Render free tier warm (ping every 4 min) ────────────────────────
    // Without this, Render spins down → 50s cold start → ICE candidates expire
    const keepAlive = setInterval(() => {
      fetch(`${API_BASE}/status`).catch(() => {});
    }, 4 * 60 * 1000);
 
    // ── ZAP signaling ────────────────────────────────────────────────────────
    ZAP.setDHTSignaling(async (targetId, sig) => {
      try {
        await fetch(`${API_BASE}/dht/signal`, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({
            target: targetId,
            signal: JSON.stringify(sig),
            sender: identity.nodeId,
          }),
        });
      } catch {}
    });
 
    // ── Incoming peer handler — FIX: no DHT lookup, uses IDENTIFY message ───
    // Old code: fetch(`/dht/find?key=${fromId}`) → always 404 (nodeId ≠ zapId key)
    // New code: webrtc.js sends IDENTIFY on ctrl open, calls this with resolvedZapId
    ZAP.setNewPeerHandler((fromId, resolvedZapId) => {
      const zapId = resolvedZapId ?? ZAP.getNodeZapId(fromId) ?? (fromId.slice(0, 8) + '…');
 
      setPeers(ps => {
        const existing = ps.find(p => p.nodeId === fromId);
        if (existing) {
          if (resolvedZapId && existing.zapId !== zapId) {
            return ps.map(p => p.nodeId === fromId ? { ...p, zapId } : p);
          }
          return ps;
        }
        return [...ps, { zapId, nodeId: fromId, status: 'connecting' }];
      });
 
      if (!activeRef.current) {
        setActive({ zapId, nodeId: fromId, status: 'connecting' });
        setStab('peers');
      }
 
      if (resolvedZapId) {
        toast(`${resolvedZapId} connected`, 'success');
      } else {
        toast(`Peer connecting…`, 'info');
      }
    });
 
    // ── File start ───────────────────────────────────────────────────────────
    ZAP.setFileStartHandler((fromId, meta) => {
      setRecvProg({ name: meta.name, pct: 0, speed: '0', nodeId: fromId, bytes: 0, total: meta.size });
    });
 
    // ── File ready ───────────────────────────────────────────────────────────
    ZAP.setFileReadyHandler((fromId, result) => {
      const peer  = peersRef.current.find(p => p.nodeId === fromId);
      //const myId  = identityRef.current?.zapId ?? 'me';
      const myId = identRef.current?.zapId ?? 'me';
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
      setTab('history');
      if (!activeRef.current || activeRef.current.nodeId !== fromId) {
        const p = peersRef.current.find(x => x.nodeId === fromId);
        if (p) setActive(p);
      }
      const saved = result.savedToDisk ? ' — saved to disk' : '';
      toast(`✅ Received: ${result.name} (${fmtBytes(result.size)})${saved}`, 'success');
      anchorBlock({ ...entry, senderNodeId: fromId, receiverNodeId: identityRef.current?.nodeId });
    });
 
    // ── Progress ─────────────────────────────────────────────────────────────
    ZAP.setProgressHandler((fromId, p) => {
      setRecvProg({ name: p.name, pct: p.pct, speed: p.speed, nodeId: fromId, bytes: p.bytes, total: p.total });
    });
 
    // ── Connect / Disconnect ─────────────────────────────────────────────────
    ZAP.setConnectHandler(nodeId => {
      setPeers(ps => ps.map(p => p.nodeId === nodeId ? { ...p, status: 'online' } : p));
      setActive(a => a?.nodeId === nodeId ? { ...a, status: 'online' } : a);
    });
    ZAP.setDisconnectHandler(nodeId => {
      setPeers(ps => ps.map(p => p.nodeId === nodeId ? { ...p, status: 'offline' } : p));
      setActive(a => a?.nodeId === nodeId ? { ...a, status: 'offline' } : a);
    });
 
    // ── Signal poll — adaptive interval ──────────────────────────────────────
    // FIX: adaptive back-off instead of fixed 2s
    //   Active handshake → 500ms polls (ICE needs to be fast)
    //   Idle            → backs off to 4s  (saves battery / bandwidth)
    let polling      = true;
    let pollInterval = 800;
 
    const doPoll = async () => {
      if (!polling) return;
      let hadSignals = false;
 
      try {
        const r = await fetch(`${API_BASE}/get-signals?nodeId=${encodeURIComponent(identity.nodeId)}`);
        if (r.ok) {
          const sigs = await r.json();
          if (Array.isArray(sigs) && sigs.length > 0) {
            hadSignals = true;
            for (const s of sigs) {
              if (!polling) break;
              const fromId  = s.senderId || s.sender;
              let   payload = s.payload  || s.signal;
              if (!fromId || !payload) continue;
 
              const target = s.targetNodeId || s.target;
              if (target && target !== identity.nodeId) continue;
              if (fromId === identity.nodeId) continue;
 
              if (typeof payload === 'string') { try { payload = JSON.parse(payload); } catch {} }
              if (typeof payload === 'string') { try { payload = JSON.parse(payload); } catch {} }
              if (!payload?.type) continue;
 
              console.log(`[ZAP/poll] ← ${payload.type} from ${fromId.slice(0, 10)}`);
              await ZAP.handleIncomingSignal(fromId, payload);
            }
          }
        }
      } catch {}
 
      // Peer count — poll every 15s only
      if (!doPoll._lastPeer || Date.now() - doPoll._lastPeer > 15_000) {
        doPoll._lastPeer = Date.now();
        try {
          const r2 = await fetch(`${API_BASE}/peers`);
          if (r2.ok) {
            const p = await r2.json();
            setDhtCount(Array.isArray(p) ? p.length : 0);
          }
        } catch {}
      }
 
      // Adaptive interval
      pollInterval = hadSignals ? 500 : Math.min(pollInterval * 1.3, 4000);
      if (polling) setTimeout(doPoll, pollInterval);
    };
 
    doPoll();
 
    return () => {
      polling = false;
      clearInterval(keepAlive);
    };
  }, [identity, screen]);

  const loadChain=useCallback(async()=>{
    try{const r=await fetch(`${API_BASE}/history`);if(r.ok){const d=await r.json();setChain(Array.isArray(d)?[...d].reverse():[]);}}catch{}
  },[]);
  useEffect(()=>{if(stab==='chain')loadChain();},[stab,loadChain]);

  const anchorBlock=useCallback(async(entry)=>{
    const id=identRef.current; if(!id) return;
    try{
      await fetch(`${API_BASE}/anchor`,{
        method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({
          fileId:(entry.name??'')+(entry.size??''),
          fileName:entry.name,fileSize:entry.size,fileType:entry.fileType,
          senderId:entry.direction==='sent'?id.nodeId:entry.senderNodeId,
          receiverId:entry.direction==='sent'?entry.receiverNodeId:id.nodeId,
          senderZapId:entry.from,receiverZapId:entry.to,
          direction:entry.direction,status:entry.direction?.toUpperCase(),
          merkleRoot:entry.merkleRoot,
        })
      });
      if(stab==='chain') loadChain();
    }catch{}
  },[stab,loadChain]);

  const doAdd=async()=>{
    const raw=addInput.trim().toLowerCase();
    if(!raw.includes('#')){toast('Format: username#HASH','error');return;}
    if(peersRef.current.find(p=>p.zapId===raw)){toast('Already added');return;}
    setAdding(true);setAddInput('');
    try{
      const key=zapIdToLookupKey(raw);
      const r=await fetch(`${API_BASE}/dht/find?key=${encodeURIComponent(key)}`);
      if(!r.ok) throw new Error('Peer not found — make sure they opened ZAP first');
      const data=await r.json();
      if(!data?.nodeId) throw new Error('Invalid peer data from DHT');
      // Cache for reverse lookup
      ZAP.cacheNodeZapId(data.nodeId, data.zapId||raw);
      const np={zapId:data.zapId||raw,nodeId:data.nodeId,status:'connecting'};
      setPeers(ps=>[...ps,np]);setActive(np);
      toast(`Found ${np.zapId} — connecting…`);
      await ZAP.createPeerConnection(data.nodeId);
      let tries=0;
      const chk=setInterval(()=>{
        if(ZAP.isConnected(data.nodeId)){
          clearInterval(chk);
          setPeers(ps=>ps.map(p=>p.nodeId===data.nodeId?{...p,status:'online'}:p));
          toast(`Connected to ${np.zapId} ✓`,'success');
        } else if(++tries>80){
          clearInterval(chk);
          setPeers(ps=>ps.map(p=>p.nodeId===data.nodeId?{...p,status:'offline'}:p));
          toast('Timeout — both devices need same WiFi','error');
        }
      },500);
    }catch(e){toast(e.message,'error');}
    finally{setAdding(false);}
  };

  const doSend=async(fileList,isFolder=false)=>{
    if(!active||!ZAP.isConnected(active.nodeId)){toast('Peer not connected','error');return;}
    const files=Array.from(fileList);if(!files.length)return;
    const snap=active;
    const onP=p=>{setSendProg({...p,nodeId:snap.nodeId});if(p.pct>=100)setTimeout(()=>setSendProg(null),2500);};
    if(isFolder){
      const name=files[0].webkitRelativePath?.split('/')[0]??'folder';
      try{
        await ZAP.sendFolder(files,name,snap.nodeId,onP);
        const e={direction:'sent',name:name+'.zip',size:files.reduce((a,f)=>a+f.size,0),fileType:'ZIP',ext:'zip',from:identity.zapId,to:snap.zapId,timestamp:Date.now()};
        addTx(snap.nodeId,e);anchorBlock({...e,receiverNodeId:snap.nodeId});
        toast(`Sent folder: ${name}`,'success');
      }catch(e){toast('Folder failed: '+e.message,'error');}
    } else {
      for(const file of files){
        try{
          await ZAP.sendFile(file,snap.nodeId,onP);
          const e={direction:'sent',name:file.name,size:file.size,fileType:getType(file.name),ext:getExt(file.name),from:identity.zapId,to:snap.zapId,timestamp:Date.now()};
          addTx(snap.nodeId,e);anchorBlock({...e,receiverNodeId:snap.nodeId});
          toast(`Sent: ${file.name}`,'success');
        }catch(e){toast(`Failed ${file.name}: `+e.message,'error');}
      }
    }
  };

  const doSetup=async()=>{
    const clean=uname.trim().toLowerCase().replace(/[^a-z0-9]/g,'').slice(0,16);
    if(!clean||clean.length<2){toast('Min 2 chars, letters/numbers','error');return;}
    if(creating)return;
    setCreating(true);
    try{
      const id=await createIdentity(clean);
      if(!id?.zapId||!id?.nodeId) throw new Error('Identity creation failed');
      setIdentity(id);setScreen('app');
    }catch(e){toast('Error: '+e.message,'error');}
    finally{setCreating(false);}
  };

  const filteredChain=chain.filter(b=>{
    if(chainDir!=='all'){
      const s=(b.direction||b.status||'').toLowerCase().includes('sent');
      if(chainDir==='sent'&&!s)return false;
      if(chainDir==='received'&&s)return false;
    }
    if(!chainQ)return true;
    const q=chainQ.toLowerCase();
    return [(b.fileName||''),(b.senderZapId||''),(b.receiverZapId||''),(b.fileType||''),(b.merkleRoot||''),(b.blockHash||''),fmtBytes(b.fileSize||0),fmtDate(b.timestamp)]
      .some(f=>f.toLowerCase().includes(q));
  });

  if(screen==='loading') return <><style>{CSS}</style><div className="loading">LOADING…</div></>;

  if(screen==='setup'){
    const clean=uname.trim().toLowerCase().replace(/[^a-z0-9]/g,'');
    return(
      <><style>{CSS}</style>
      <div className="setup"><div className="setup-card">
        <div className="setup-logo"><span className="setup-bolt">⚡</span><span className="setup-name">ZAP</span></div>
        <div className="setup-sub">Pure P2P file sharing.<br/><strong>No servers · No limits</strong> · Direct device-to-device.</div>
        <div className="setup-lbl">Choose username</div>
        <input className="setup-input" placeholder="alice" maxLength={16} value={uname}
          onChange={e=>setUname(e.target.value)} onKeyDown={e=>e.key==='Enter'&&doSetup()}
          autoFocus autoCapitalize="none" autoCorrect="off"/>
        {clean&&<div className="setup-preview">{clean}#????<div className="setup-preview-sub">4-char hash auto-added</div></div>}
        <button className="setup-btn" onClick={doSetup} disabled={!clean||clean.length<2||creating}>
          {creating?'⏳ Creating…':'⚡ Create Identity'}
        </button>
      </div></div></>
    );
  }

  const isConn=active?ZAP.isConnected(active.nodeId):false;
  const activeTx=active?(txMap[active.nodeId]??[]):[];

  return(
    <><style>{CSS}</style>
    <div className="app">
      <header className="topbar">
        <div className="topbar-logo"><span className="topbar-bolt">⚡</span><span className="topbar-zap">ZAP</span></div>
        <div className="topbar-id">
          <div className="topbar-zapid">{identity?.zapId}</div>
          <div className="topbar-nodeid">{identity?.nodeId}</div>
        </div>
        <span className={`status-dot ${online?'on':'off'}`} title={online?`${dhtCount} peers`:'Offline'}/>
      </header>

      <div className="layout">
        <aside className="sidebar">
          <div className="add-row">
            <input className="add-input" placeholder="username#HASH" value={addInput}
              onChange={e=>setAddInput(e.target.value)} onKeyDown={e=>e.key==='Enter'&&doAdd()}
              autoCapitalize="none" autoCorrect="off"/>
            <button className="add-btn" onClick={doAdd} disabled={adding||!addInput.trim()}>
              {adding?'…':'ADD'}
            </button>
          </div>

          {stab==='peers'&&(
            <div className="peer-list">
              {peers.length===0&&<div className="peer-empty">No peers.<br/>Enter <span>username#HASH</span><br/>or wait for auto-connect.</div>}
              {peers.map(p=>(
                <div key={p.nodeId} className={`peer-item${active?.nodeId===p.nodeId?' active':''}`} onClick={()=>setActive(p)}>
                  <div className="peer-av">{parseZapId(p.zapId).username?.slice(0,2).toUpperCase()}</div>
                  <div className="peer-info">
                    <div className="peer-name">{p.zapId}</div>
                    <div className="peer-node">{p.nodeId.slice(0,16)}…</div>
                  </div>
                  <span className={`peer-badge ${p.status==='online'?'on':p.status==='connecting'?'connecting':'off'}`}>
                    {p.status==='online'?'ON':p.status==='connecting'?'…':'OFF'}
                  </span>
                </div>
              ))}
            </div>
          )}

          {stab==='chain'&&(
            <div className="csidebar">
              {chain.length===0&&<div className="peer-empty">No blocks yet.</div>}
              {chain.map((b,i)=>{
                const s=(b.direction||b.status||'').toLowerCase().includes('sent');
                return(
                  <div key={i} className="csb-item" onClick={()=>{setTab('chain');loadChain();}}>
                    <div className="csb-top">
                      <span className={`csb-badge ${s?'csb-sent':'csb-recv'}`}>{s?'↑':'↓'}</span>
                      <span style={{fontSize:8,color:'var(--gray)',fontFamily:'var(--mono)'}}>{new Date(b.timestamp).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})}</span>
                    </div>
                    <div className="csb-fname">{typeIcon(b.fileType||getType(b.fileName||''))} {b.fileName||'—'}</div>
                    <div className="csb-meta">{fmtBytes(b.fileSize||0)} · {b.senderZapId||'?'} → {b.receiverZapId||'?'}</div>
                  </div>
                );
              })}
            </div>
          )}

          {stab==='net'&&(
            <div className="net-scroll">
              <div className="ncard">
                <div className="ncard-t">Network</div>
                <div className="nr"><span className="nr-l">Status</span><span className="nr-v" style={{color:online?'var(--grn)':'var(--red)'}}>{online?'ONLINE':'OFFLINE'}</span></div>
                <div className="nr"><span className="nr-l">DHT peers</span><span className="nr-v">{dhtCount}</span></div>
                <div className="nr"><span className="nr-l">Connected</span><span className="nr-v">{peers.filter(p=>p.status==='online').length}</span></div>
                <div className="nr"><span className="nr-l">Backend</span><span className="nr-v" style={{fontSize:7}}>{API_BASE}</span></div>
              </div>
              <div className="ncard">
                <div className="ncard-t">Identity</div>
                <div className="nr"><span className="nr-l">ZAP ID</span><span className="nr-v">{identity?.zapId}</span></div>
                <div className="nr" style={{flexDirection:'column',gap:3}}><span className="nr-l">Node ID</span>
                  <span style={{color:'var(--w)',fontFamily:'var(--mono)',fontSize:7,wordBreak:'break-all',lineHeight:1.7}}>{identity?.nodeId}</span>
                </div>
                <div className="nr"><span className="nr-l">Crypto</span><span className="nr-v">Fallback (HTTP)</span></div>
              </div>
              <div className="ncard">
                <div className="ncard-t">Engine</div>
                <div className="nr"><span className="nr-l">Chunk</span><span className="nr-v">{/iPhone|iPad/i.test(navigator.userAgent)?'16 KB':/Mobi|Android/i.test(navigator.userAgent)?'64 KB':'256 KB'}</span></div>
                <div className="nr"><span className="nr-l">Max file</span><span className="nr-v">Unlimited</span></div>
                <div className="nr"><span className="nr-l">FS API</span><span className="nr-v" style={{color:'showSaveFilePicker' in window?'var(--grn)':'var(--gold)'}}>{'showSaveFilePicker' in window?'✓ Disk':'IDB fallback'}</span></div>
              </div>
            </div>
          )}

          <div className="sidetabs">
            {[['peers','PEERS'],['chain','CHAIN'],['net','NET']].map(([id,lbl])=>(
              <button key={id} className={`sidetab${stab===id?' on':''}`} onClick={()=>setStab(id)}>{lbl}</button>
            ))}
          </div>
        </aside>

        <main className="main">
          {!active?(
            <div className="empty">
              <div className="empty-logo"><span className="empty-bolt">⚡</span><span className="empty-text">ZAP</span></div>
              <div className="empty-sub">Ultra-Fast · Decentralized · P2P</div>
              <div className="empty-id">
                <div className="empty-id-lbl">Your ZAP ID — share this</div>
                <div className="empty-id-zap">{identity?.zapId}</div>
                <div className="empty-id-node">{identity?.nodeId}</div>
              </div>
              <div className="feat-grid">
                {[['⚡','Ultra-Fast','256KB chunks, TURN relay for any network'],
                  ['💾','Any Size','15GB+ direct to disk, no RAM crash'],
                  ['📁','Folders','Auto-zip, original quality'],
                  ['⛓','Blockchain','Merkle verified, searchable ledger'],
                ].map(([icon,t,d])=>(
                  <div key={t} className="feat"><div className="feat-icon">{icon}</div><div className="feat-title">{t}</div><div className="feat-desc">{d}</div></div>
                ))}
              </div>
            </div>
          ):(<>
            <div className="txhead">
              <div className="txhead-av">{parseZapId(active.zapId).username?.slice(0,2).toUpperCase()}</div>
              <div className="txhead-info">
                <div className="txhead-name">{active.zapId}</div>
                <div className="txhead-node">{active.nodeId}</div>
              </div>
              <span className={`conn-pill ${isConn?'on':active.status==='connecting'?'wait':'off'}`}>
                {isConn?'● CONNECTED':active.status==='connecting'?'◌ CONNECTING…':'○ OFFLINE'}
              </span>
            </div>

            {sendProg&&sendProg.nodeId===active.nodeId&&(
              <div className="prog">
                <div className="prog-row"><span>↑ {sendProg.name} — {fmtBytes(sendProg.bytes||0)}/{fmtBytes(sendProg.total||0)}</span><span className="prog-spd">{sendProg.speed} MB/s · {sendProg.pct}%</span></div>
                <div className="prog-track"><div className="prog-fill" style={{width:sendProg.pct+'%'}}/></div>
              </div>
            )}
            {recvProg&&recvProg.nodeId===active.nodeId&&(
              <div className="prog">
                <div className="prog-row"><span>↓ {recvProg.name} — {fmtBytes(recvProg.bytes||0)}/{fmtBytes(recvProg.total||0)}</span><span style={{color:'var(--grn)',fontFamily:'var(--mono)',fontWeight:600}}>{recvProg.speed} MB/s · {recvProg.pct}%</span></div>
                <div className="prog-track"><div className="prog-fill recv" style={{width:recvProg.pct+'%'}}/></div>
              </div>
            )}

            <div className="tabs">
              {[['send','SEND'],['history','HISTORY'],['chain','CHAIN']].map(([id,lbl])=>(
                <button key={id} className={`tab-btn${tab===id?' on':''}`}
                  onClick={()=>{setTab(id);if(id==='chain')loadChain();}}>{lbl}</button>
              ))}
            </div>

            {tab==='send'&&(
              <div className="send-area">
                <div className={`dropzone${drag?' drag':''}`}
                  onDragOver={e=>{e.preventDefault();setDrag(true)}}
                  onDragLeave={()=>setDrag(false)}
                  onDrop={e=>{e.preventDefault();setDrag(false);doSend(e.dataTransfer.files)}}
                  onClick={()=>isConn&&fileRef.current?.click()}>
                  <div className="dropzone-icon">⚡</div>
                  <div className="dropzone-title">{isConn?'Drop files here to send':'Waiting for connection…'}</div>
                  <div className="dropzone-sub">{isConn?<><strong>Any file type · No size limit</strong><br/>Movies, photos, apps, folders — original quality</>:'Connecting via WebRTC + TURN relay…'}</div>
                </div>
                <div className="send-btns">
                  <button className="send-btn primary" disabled={!isConn} onClick={()=>fileRef.current?.click()}>📄 Select Files</button>
                  <button className="send-btn" disabled={!isConn} onClick={()=>folderRef.current?.click()}>📁 Send Folder</button>
                </div>
                {'showSaveFilePicker' in window
                  ?<div className="info-box ok">✓ FS API — files write direct to disk. 15GB+ supported.</div>
                  :<div className="info-box warn">⚠ No FS API — use Chrome/Edge for 15GB+ files.</div>}
              </div>
            )}

            {tab==='history'&&(
              <div className="history">
                {activeTx.length===0&&<div className="hist-empty">No transfers yet.</div>}
                {activeTx.map((tx,i)=>(
                  <div key={i} className="hist-item">
                    <div className="hist-head">
                      <span className={`hist-badge ${tx.direction==='sent'?'badge-sent':'badge-recv'}`}>{tx.direction==='sent'?'↑ SENT':'↓ RECV'}</span>
                      <span className="hist-badge" style={{color:'var(--gray)',borderColor:'var(--gray2)'}}>{typeIcon(tx.fileType)} {tx.fileType}</span>
                      <span className="hist-name">{tx.name}</span>
                      {tx.url&&<a className="dl-btn" href={tx.url} download={tx.name}>DOWNLOAD</a>}
                    </div>
                    <div className="hist-grid">
                      <div className="hist-field">Size <span>{fmtBytes(tx.size)}</span></div>
                      <div className="hist-field">From <span>{tx.from}</span></div>
                      <div className="hist-field">To <span>{tx.to}</span></div>
                      <div className="hist-field">Time <span>{fmtDate(tx.timestamp)}</span></div>
                      {tx.savedToDisk&&<div className="hist-field">Disk <span style={{color:'var(--grn)'}}>✓</span></div>}
                    </div>
                    {tx.merkleRoot&&<div className="hist-hash"><strong style={{color:'var(--gold)'}}>Merkle: </strong>{tx.merkleRoot}</div>}
                  </div>
                ))}
              </div>
            )}

            {tab==='chain'&&(
              <div className="chain-wrap">
                <div className="chain-toolbar">
                  <span className="chain-title">⛓ CHAIN</span>
                  <span className="chain-count">{filteredChain.length}/{chain.length}</span>
                  <input className="chain-search" placeholder="Search name, user, hash…" value={chainQ} onChange={e=>setChainQ(e.target.value)}/>
                  <div className="chain-filters">
                    {[['all','ALL'],['sent','↑'],['received','↓']].map(([v,l])=>(
                      <button key={v} className={`cfilter${chainDir===v?' on':''}`} onClick={()=>setChainDir(v)}>{l}</button>
                    ))}
                  </div>
                </div>
                <div className="chain-list">
                  {filteredChain.length===0&&<div className="chain-empty">{chain.length===0?'No blocks yet. Send a file.':'No matches.'}</div>}
                  {filteredChain.map((b,i)=>{
                    const isSent=(b.direction||b.status||'').toLowerCase().includes('sent');
                    const ft=b.fileType||getType(b.fileName||'');
                    const bn=chain.indexOf(b);
                    return(
                      <div key={i} className="block">
                        <div className="block-hdr">
                          <span className="block-num">#{chain.length-bn}</span>
                          <span className={`block-dir ${isSent?'sent':'recv'}`}>{isSent?'↑ SENT':'↓ RECV'}</span>
                          <span className="block-icon">{typeIcon(ft)}</span>
                          <span className="block-fn">{b.fileName||'—'}</span>
                        </div>
                        <div className="block-body">
                          <div className="block-grid">
                            <div className="block-row"><div className="block-lbl">File Name</div><div className="block-val big">{b.fileName||'—'}</div></div>
                            <div className="block-row"><div className="block-lbl">Type</div><div className="block-val big">{typeIcon(ft)} {ft}</div></div>
                            <div className="block-row"><div className="block-lbl">Size</div><div className="block-val big gold">{fmtBytes(b.fileSize||0)}</div></div>
                            <div className="block-row"><div className="block-lbl">Date &amp; Time</div><div className="block-val">{fmtDate(b.timestamp)}</div></div>
                            <div className="block-row">
                              <div className="block-lbl">{isSent?'Sent To':'From'}</div>
                              <div className={`block-val big ${isSent?'gold':'grn'}`}>{isSent?(b.receiverZapId||b.receiverNodeId?.slice(0,12)||'?'):(b.senderZapId||b.senderNodeId?.slice(0,12)||'?')}</div>
                            </div>
                            <div className="block-row">
                              <div className="block-lbl">{isSent?'From':'Saved To'}</div>
                              <div className="block-val">{isSent?(b.senderZapId||b.senderNodeId?.slice(0,12)||'?'):(b.receiverZapId||b.receiverNodeId?.slice(0,12)||'?')}</div>
                            </div>
                            <div className="block-row"><div className="block-lbl">Status</div><div className="block-val" style={{color:isSent?'var(--gold)':'var(--grn)'}}>{b.status||'—'}</div></div>
                            <div className="block-row"><div className="block-lbl">Direction</div><div className="block-val">{b.direction||b.status||'—'}</div></div>
                          </div>
                        </div>
                        {b.merkleRoot&&<div className="block-mk"><div className="block-mk-lbl">⚡ Merkle Root</div><div className="block-mk-val">{b.merkleRoot}</div></div>}
                        {b.blockHash&&<div className="block-chain"><span style={{color:'var(--gold)'}}>⛓ HASH  </span>{b.blockHash}</div>}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </>)}
        </main>
      </div>
    </div>

    <input ref={fileRef} type="file" multiple style={{display:'none'}} onChange={e=>{doSend(e.target.files);e.target.value='';}}/>
    <input ref={folderRef} type="file" multiple style={{display:'none'}} webkitdirectory="" onChange={e=>{doSend(e.target.files,true);e.target.value='';}}/>

    <div className="toasts">
      {toasts.map(t=>(
        <div key={t.id} className={`toast ${t.type}`}>
          <span>{t.type==='success'?'✓':t.type==='error'?'✗':'⚡'}</span>{t.msg}
        </div>
      ))}
    </div>
    </>
  );
}