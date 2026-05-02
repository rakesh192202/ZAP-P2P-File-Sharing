package com.zap;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.web.bind.annotation.*;
import org.springframework.http.ResponseEntity;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.core.type.TypeReference;
import java.io.File;
import java.io.IOException;
import java.util.*;
import java.util.concurrent.ConcurrentHashMap;

@SpringBootApplication
@RestController
@RequestMapping("/api/jchain")
@CrossOrigin(origins = "*", allowedHeaders = "*")
public class JChainController {

    private static final String LEDGER_PATH = "ledger.json";
    private final ObjectMapper mapper = new ObjectMapper();

    private final RoutingTable routingTable;
    private final KRouter      router;
    private final byte[]       localNodeId;
    private final int          webPort;

    public JChainController(@Value("${server.port:8080}") int webPort) {
        this.webPort      = webPort;
        this.router       = new KRouter();
        this.localNodeId  = router.generateNodeId();
        this.routingTable = new RoutingTable(localNodeId);

        int udpPort = 8000 + (webPort % 1000) + 808;

        UDPListener listener = new UDPListener(udpPort, routingTable, localNodeId);
        listener.setRouter(router);
        new Thread(listener).start();

        if (webPort != 8080) {
            new Thread(() -> {
                try {
                    Thread.sleep(3000);
                    String seedIp = System.getProperty("seed.ip", "192.168.43.228");
                    KMessage ping = new KMessage("BOOTSTRAP", HashUtils.bytesToHex(localNodeId), udpPort, "JOIN");
                    new UDPSender().sendMessage(seedIp, 8888, ping);
                    System.out.println("[Bootstrap] Connecting to seed: " + seedIp);
                } catch (Exception ignored) {}
            }).start();
        }

        new KadRefreshService(routingTable, router, localNodeId, udpPort).start();

        System.out.printf("[ZAP] Started port=%d udp=%d nodeId=%s…%n",
            webPort, udpPort, HashUtils.bytesToHex(localNodeId).substring(0, 12));
    }

    public static void main(String[] args) {
        SpringApplication.run(JChainController.class, args);
    }
@GetMapping("/test")
public Map<String, String> test() {
    return Map.of("status", "Backend is working");
}
    // =========================================================================
    // DHT ENDPOINTS
    // =========================================================================

    /**
     * POST /api/jchain/dht/store
     * Stores identity registration.
     * Key format: "alice#3b9f" (username#hash — URL-safe, no Unicode issues)
     */
    @PostMapping("/dht/store")
    public ResponseEntity<?> dhtStore(@RequestBody Map<String, String> body) {
        try {
            String key   = body.get("key");
            String value = body.get("value");

            if (key == null || key.isBlank())   return ResponseEntity.badRequest().body(Map.of("error", "key required"));
            if (value == null || value.isBlank()) return ResponseEntity.badRequest().body(Map.of("error", "value required"));

            // Normalize key: lowercase, trim
            key = key.toLowerCase().trim();

            router.storeLocal(key, value);

            final String fKey = key, fVal = value;
            int udpPort = 8000 + (webPort % 1000) + 808;
            new Thread(() -> {
                try { router.iterativeStore(fKey, fVal, localNodeId, routingTable, udpPort); }
                catch (Exception e) { System.err.println("[DHT/STORE] Propagation: " + e.getMessage()); }
            }).start();

            System.out.printf("[DHT/STORE] key=%s len=%d%n", key, value.length());
            return ResponseEntity.ok(Map.of("status", "STORED", "key", key));
        } catch (Exception e) {
            return ResponseEntity.status(500).body(Map.of("error", e.getMessage()));
        }
    }

    /**
     * GET /api/jchain/dht/find?key=alice%233b9f
     *
     * New key format uses # (encoded as %23) — standard URL-safe character.
     * No more Unicode middle-dot encoding issues.
     *
     * Also supports prefix search: ?key=alice (finds all alice#xxxx registrations)
     */
    @GetMapping("/dht/find")
    public ResponseEntity<?> dhtFind(@RequestParam String key) {
        try {
            key = key.toLowerCase().trim();
            System.out.printf("[DHT/FIND] Looking up: %s%n", key);

            int udpPort = 8000 + (webPort % 1000) + 808;

            // Direct lookup
            String value = router.getLocal(key);

            // If not found and key has no #, try prefix search among local entries
            if (value == null && !key.contains("#")) {
                // Search for username#xxxx pattern
                for (Map.Entry<String, String> entry : router.getAllLocalEntries().entrySet()) {
                    if (entry.getKey().startsWith(key + "#")) {
                        value = entry.getValue();
                        System.out.printf("[DHT/FIND] Prefix match: %s%n", entry.getKey());
                        break;
                    }
                }
            }

            // Network lookup if not local
            if (value == null) {
                value = router.iterativeFindValue(key, localNodeId, routingTable, udpPort);
            }

            if (value == null) {
                return ResponseEntity.status(404).body(
                    Map.of("error", "Peer not found. Make sure they opened ZAP first.", "key", key));
            }

            try {
                Object parsed = mapper.readValue(value, Object.class);
                return ResponseEntity.ok(parsed);
            } catch (Exception e) {
                return ResponseEntity.ok(Map.of("value", value));
            }
        } catch (Exception e) {
            System.err.println("[DHT/FIND] Error: " + e.getMessage());
            return ResponseEntity.status(500).body(Map.of("error", e.getMessage()));
        }
    }

    /**
     * POST /api/jchain/dht/signal
     * Routes WebRTC SDP/ICE signals.
     */
    @PostMapping("/dht/signal")
    public ResponseEntity<?> dhtSignal(@RequestBody Map<String, String> body) {
        try {
            String target = body.get("target");
            String signal = body.get("signal");
            String sender = body.get("sender");

            if (target == null || signal == null)
                return ResponseEntity.badRequest().body(Map.of("error", "target and signal required"));

            String senderHex = sender != null ? sender : HashUtils.bytesToHex(localNodeId);
            int    udpPort   = 8000 + (webPort % 1000) + 808;

            KMessage msg = new KMessage(KMessage.SIGNAL, senderHex, udpPort, signal);
            msg.setTargetNodeId(target);
            routingTable.pushSignal(msg);

            // UDP forward if peer is known
            try {
                routingTable.findClosestNode(HashUtils.hexToBytes(target)).ifPresent(node -> {
                    try { new UDPSender().sendMessage(node.getIpAddress(), node.getPort(), msg); }
                    catch (Exception ignored) {}
                });
            } catch (Exception ignored) {}

            System.out.printf("[DHT/SIGNAL] %s → %s%n",
                senderHex.substring(0, 8), target.substring(0, Math.min(8, target.length())));
            return ResponseEntity.ok(Map.of("status", "SIGNAL_QUEUED"));
        } catch (Exception e) {
            return ResponseEntity.status(500).body(Map.of("error", e.getMessage()));
        }
    }

    // =========================================================================
    // EXISTING ENDPOINTS
    // =========================================================================

    /**
     * GET /api/jchain/get-signals?nodeId=xxx
     *
     * FIXED: Now accepts optional nodeId parameter.
     * Returns only signals addressed to that specific node.
     * Without nodeId, falls back to returning everything (old behavior).
     *
     * This prevents Mac from consuming Phone's signals and vice versa.
     */
    @GetMapping("/get-signals")
    public ResponseEntity<List<KMessage>> getSignals(
            @RequestParam(value = "nodeId", required = false) String nodeId) {
        return ResponseEntity.ok(routingTable.popSignalsFor(nodeId));
    }

    @GetMapping("/peers")
    public ResponseEntity<List<Map<String, String>>> getPeers() {
        List<Map<String, String>> list = new ArrayList<>();
        for (KBucket bucket : routingTable.getBuckets()) {
            for (KNode node : bucket.getNodes()) {
                list.add(Map.of(
                    "nodeId", HashUtils.bytesToHex(node.getNodeId()),
                    "ip",     node.getIpAddress(),
                    "port",   String.valueOf(node.getPort())));
            }
        }
        return ResponseEntity.ok(list);
    }

    @GetMapping("/status")
    public Map<String, Object> getStatus() {
        return Map.of(
            "nodeId",  HashUtils.bytesToHex(localNodeId),
            "service", "ZAP-v3",
            "active",  true,
            "port",    webPort,
            "dhtEntries", router.getAllLocalEntries().size(),
            "peers",   routingTable.totalPeerCount()
        );
    }

    @GetMapping("/network-info")
    public ResponseEntity<Map<String, Object>> getNetworkInfo() {
        return ResponseEntity.ok(Map.of(
            "nodeId",     HashUtils.bytesToHex(localNodeId),
            "peerCount",  routingTable.totalPeerCount(),
            "dhtEntries", router.getAllLocalEntries().size(),
            "port",       webPort
        ));
    }

    // ── Blockchain Ledger ─────────────────────────────────────────────────────

    @PostMapping("/anchor")
    public synchronized ResponseEntity<?> anchorTransfer(@RequestBody LedgerEntry request) {
        try {
            List<LedgerEntry> ledger      = loadLedger();
            String previousHash = ledger.isEmpty() ? "GENESIS" : ledger.get(ledger.size()-1).getBlockHash();
            long   timestamp    = System.currentTimeMillis();
            String blockHash    = HashUtils.sha256(
                (request.getFileId() != null ? request.getFileId() : "") + previousHash + timestamp);

            request.setPreviousHash(previousHash);
            request.setBlockHash(blockHash);
            request.setTimestamp(timestamp);
            ledger.add(request);
            saveLedger(ledger);

            System.out.printf("[CHAIN] Block added: %s file=%s%n",
                blockHash.substring(0, 16), request.getFileName());
            return ResponseEntity.ok(Map.of("status", "BLOCK_ADDED", "blockHash", blockHash));
        } catch (Exception e) {
            return ResponseEntity.status(500).body(Map.of("error", e.getMessage()));
        }
    }

    @GetMapping("/history")
    public synchronized ResponseEntity<List<LedgerEntry>> getLedgerHistory() {
        try {
            return ResponseEntity.ok(loadLedger());
        } catch (Exception e) {
            return ResponseEntity.status(500).body(new ArrayList<>());
        }
    }

    // Legacy send-signal (kept for backward compat)
    @PostMapping("/send-signal")
    public ResponseEntity<?> sendSignal(@RequestBody Map<String, Object> body) {
        try {
            String ip    = (String) body.get("ip");
            int    port  = Integer.parseInt(body.get("port").toString());
            String data  = (String) body.get("signal");
            int    udp   = 8000 + (webPort % 1000) + 808;
            new UDPSender().sendMessage(ip, port, new KMessage("SIGNAL", HashUtils.bytesToHex(localNodeId), udp, data));
            return ResponseEntity.ok(Map.of("status", "SIGNAL_SENT"));
        } catch (Exception e) {
            return ResponseEntity.status(500).body(Map.of("error", e.getMessage()));
        }
    }

    private List<LedgerEntry> loadLedger() {
        File f = new File(LEDGER_PATH);
        if (!f.exists() || f.length() == 0) return new ArrayList<>();
        try {
            return mapper.readValue(f, new TypeReference<List<LedgerEntry>>() {});
        } catch (Exception e) {
            // ledger.json has old/corrupt format — back it up and start fresh
            System.err.printf("[CHAIN] ledger.json unreadable (%s) — backing up and starting fresh%n", e.getMessage());
            f.renameTo(new File(LEDGER_PATH + ".bak." + System.currentTimeMillis()));
            return new ArrayList<>();
        }
    }

    private void saveLedger(List<LedgerEntry> ledger) throws IOException {
        mapper.writerWithDefaultPrettyPrinter().writeValue(new File(LEDGER_PATH), ledger);
    }
}