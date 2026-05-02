# ZAP-P2P-File-Sharing
ZAP is a decentralized, browser-native P2P file sharing system built with WebRTC DataChannels, Kademlia DHT for peer discovery, and a blockchain ledger for tamper-proof transfer records.

cat > ~/Desktop/ZAP/README.md << 'EOF'
# ⚡ ZAP — Decentralized P2P File Sharing

> Browser-native, serverless, cross-platform file transfer using WebRTC + Kademlia DHT + Blockchain

![ZAP Demo](https://img.shields.io/badge/Status-Working-brightgreen)
![WebRTC](https://img.shields.io/badge/WebRTC-DataChannel-blue)
![Java](https://img.shields.io/badge/Java-Spring%20Boot-orange)
![React](https://img.shields.io/badge/React-18-61DAFB)

## 🎯 What is ZAP?

ZAP transfers files **directly between browsers** — no cloud, no accounts, no size limits.

- 📱 **Works on**: Mac, Windows, Android, iOS (same WiFi)
- 💾 **Any file size**: Movies, folders, photos in original quality
- ⛓ **Blockchain record**: Every transfer logged with Merkle hash proof
- 🔒 **Private**: Files never touch any server

## 🏗 Architecture
Browser A ──────────────────────────── Browser B
(React + WebRTC)   Phase 2: Direct    (React + WebRTC)
│             P2P Transfer             │
│                                      │
└──── Java Spring Boot Backend ────────┘
Phase 1: Signaling only
(Kademlia DHT + Signal Relay)
## 🚀 Quick Start

### Requirements
- Node.js 18+
- Java 17+
- Maven 3.8+

### Start Backend
```bash
cd JChain-Backend
mvn spring-boot:run
# Runs on http://localhost:8080
# UDP Kademlia on port 8888
```

### Start Frontend
```bash
cd bigdrop-frontend
npm install
npm run dev
# Opens on http://localhost:5173
```

### Use on Phone
Open `http://YOUR_MAC_IP:5173` in phone browser.
Find your IP: `ifconfig | grep "192.168"`

## 📁 Project Structure
ZAP/
├── bigdrop-frontend/          # React + Vite frontend
│   └── src/
│       ├── App.jsx            # Main UI (1200 lines)
│       └── webrtc/
│           ├── webrtc.js      # WebRTC engine
│           └── identity.js    # Identity system
│
└── JChain-Backend/            # Java Spring Boot
└── src/main/java/com/zap/
├── JChainController.java   # REST API
├── KRouter.java            # Kademlia DHT
├── RoutingTable.java       # 160 K-Buckets
├── KBucket.java            # LRU Bucket
├── KMessage.java           # UDP Protocol
├── UDPListener.java        # UDP Server
├── UDPSender.java          # UDP Client
├── HashUtils.java          # Crypto utils
└── LedgerEntry.java        # Blockchain block

## ⚙️ How It Works

1. **Identity**: Each device gets `username#HASH` ID stored in IndexedDB
2. **Discovery**: Kademlia DHT finds peers by ZAP ID
3. **Signaling**: WebRTC SDP exchanged through DHT backend
4. **Transfer**: Direct DataChannel — server completely out of the loop
5. **Blockchain**: Each transfer anchored as immutable block

## 🔧 Tech Stack

| Layer | Technology |
|-------|-----------|
| UI | React 18 + Vite |
| P2P Transfer | WebRTC DataChannel |
| Peer Discovery | Kademlia DHT (custom Java) |
| Storage | IndexedDB + File System API |
| Backend | Java Spring Boot |
| Blockchain | SHA-256 hash chain + Merkle tree |

## 📊 Performance

| File Size | Time | Speed |
|-----------|------|-------|
| 10 MB | ~1 s | ~10 MB/s |
| 100 MB | ~9 s | ~11 MB/s |
| 500 MB | ~45 s | ~11 MB/s |

*Tested on local WiFi (802.11ac), Mac → Android*

## 👨‍💻 Author

**Rakesh Kumar** — B.E. Computer Science, [College Name]

## 📄 License

MIT License — free to use, modify, and distribute.
EOF
