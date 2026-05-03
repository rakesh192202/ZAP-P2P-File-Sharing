package com.zap;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.web.bind.annotation.*;
import org.springframework.http.ResponseEntity;
import org.springframework.web.servlet.config.annotation.CorsRegistry;
import org.springframework.web.servlet.config.annotation.WebMvcConfigurer;
import org.springframework.context.annotation.Bean;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.core.type.TypeReference;
import java.io.File;
import java.io.IOException;
import java.util.*;
import java.util.concurrent.ConcurrentHashMap;

@SpringBootApplication
@RestController
@RequestMapping("/api/jchain")
public class JChainController {

    private static final String LEDGER_PATH = "ledger.json";
    private final ObjectMapper mapper = new ObjectMapper();

    private final RoutingTable routingTable;
    private final KRouter      router;
    private final byte[]       localNodeId;
    private final int          webPort;

    // ── PRODUCTION CORS: allow any origin (Vercel preview URLs change) ──────────
    @Bean
    public WebMvcConfigurer corsConfigurer() {
        return new WebMvcConfigurer() {
            @Override
            public void addCorsMappings(CorsRegistry registry) {
                registry.addMapping("/**")
                    .allowedOriginPatterns("*")   // allowedOriginPatterns = wildcard works with credentials
                    .allowedMethods("GET", "POST", "PUT", "DELETE", "OPTIONS")
                    .allowedHeaders("*")
                    .allowCredentials(false)
                    .maxAge(3600);
            }
        };
    }

    public JChainController(@Value("${server.port:10000}") int webPort) {
        this.webPort      = webPort;
        this.router       = new KRouter();
        this.localNodeId  = router.generateNodeId();
        this.routingTable = new RoutingTable(localNodeId);

        // Render uses port 10000 by default (set via PORT env var)
        int udpPort = 8000 + (webPort % 1000) + 808;
        // Note: Render free tier blocks UDP — DHT UDP only works locally
        // Signal queue via HTTP polling still works fine

        UDPListener listener = new UDPListener(udpPort, routingTable, localNodeId);
        listener.setRouter(router);
        new Thread(listener, "udp-listener").start();

        new KadRefreshService(routingTable, router, localNodeId, udpPort).start();

        System.out.printf("[ZAP] Started port=%d udp=%d nodeId=%s%n",
            webPort, udpPort, HashUtils.bytesToHex(localNodeId).substring(0, 12));
    }

    public static void main(String[] args) {
        SpringApplication.run(JChainController.class, args);
    }

    // ── DHT ENDPOINTS ─────────────────────────────────────────────────────────

    @PostMapping("/dht/store")
    public ResponseEntity<?> dhtStore(@RequestBody Map<String, String> body) {
        try {
            String key   = body.get("key");
            String value = body.get("value");
            if (key == null || key.isBlank())   return ResponseEntity.badRequest().body(Map.of("error", "key required"));
            if (value == null || value.isBlank()) return ResponseEntity.badRequest().body(Map.of("error", "value required"));
            key = key.toLowerCase().trim();
            router.storeLocal(key, value);
            System.out.printf("[DHT/STORE] key=%s%n", key);
            return ResponseEntity.ok(Map.of("status", "STORED", "key", key));
        } catch (Exception e) {
            return ResponseEntity.status(500).body(Map.of("error", e.getMessage()));
        }
    }

    @GetMapping("/dht/find")
    public ResponseEntity<?> dhtFind(@RequestParam String key) {
        try {
            key = key.toLowerCase().trim();
            String value = router.getLocal(key);

            // Prefix search if exact key not found
            if (value == null && !key.contains("#")) {
                for (Map.Entry<String, String> entry : router.getAllLocalEntries().entrySet()) {
                    if (entry.getKey().startsWith(key + "#")) {
                        value = entry.getValue();
                        break;
                    }
                }
            }

            if (value == null) {
                return ResponseEntity.status(404).body(
                    Map.of("error", "Peer not found. Open ZAP on their device first.", "key", key));
            }

            try {
                Object parsed = mapper.readValue(value, Object.class);
                return ResponseEntity.ok(parsed);
            } catch (Exception e) {
                return ResponseEntity.ok(Map.of("value", value));
            }
        } catch (Exception e) {
            return ResponseEntity.status(500).body(Map.of("error", e.getMessage()));
        }
    }

    @PostMapping("/dht/signal")
    public ResponseEntity<?> dhtSignal(@RequestBody Map<String, String> body) {
        try {
            String target = body.get("target");
            String signal = body.get("signal");
            String sender = body.get("sender");
            if (target == null || signal == null)
                return ResponseEntity.badRequest().body(Map.of("error", "target and signal required"));
            String senderHex = sender != null ? sender : HashUtils.bytesToHex(localNodeId);
            KMessage msg = new KMessage(KMessage.SIGNAL, senderHex, webPort, signal);
            msg.setTargetNodeId(target);
            routingTable.pushSignal(msg);
            return ResponseEntity.ok(Map.of("status", "SIGNAL_QUEUED"));
        } catch (Exception e) {
            return ResponseEntity.status(500).body(Map.of("error", e.getMessage()));
        }
    }

    @GetMapping("/get-signals")
    public ResponseEntity<List<KMessage>> getSignals() {
        return ResponseEntity.ok(routingTable.popSignals());
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
            "nodeId",     HashUtils.bytesToHex(localNodeId),
            "service",    "ZAP-v3",
            "active",     true,
            "port",       webPort,
            "dhtEntries", router.getAllLocalEntries().size(),
            "peers",      routingTable.totalPeerCount()
        );
    }

    // ── BLOCKCHAIN ────────────────────────────────────────────────────────────

    @PostMapping("/anchor")
    public synchronized ResponseEntity<?> anchorTransfer(@RequestBody LedgerEntry request) {
        try {
            List<LedgerEntry> ledger = loadLedger();
            String previousHash = ledger.isEmpty() ? "GENESIS" : ledger.get(ledger.size()-1).getBlockHash();
            long   timestamp    = System.currentTimeMillis();
            String blockHash    = HashUtils.sha256(
                (request.getFileId() != null ? request.getFileId() : "") + previousHash + timestamp);
            request.setPreviousHash(previousHash);
            request.setBlockHash(blockHash);
            request.setTimestamp(timestamp);
            ledger.add(request);
            saveLedger(ledger);
            return ResponseEntity.ok(Map.of("status", "BLOCK_ADDED", "blockHash", blockHash));
        } catch (Exception e) {
            return ResponseEntity.status(500).body(Map.of("error", e.getMessage()));
        }
    }

    @GetMapping("/history")
    public synchronized ResponseEntity<List<LedgerEntry>> getLedgerHistory() {
        try { return ResponseEntity.ok(loadLedger()); }
        catch (Exception e) { return ResponseEntity.status(500).body(new ArrayList<>()); }
    }

    private List<LedgerEntry> loadLedger() throws IOException {
        File f = new File(LEDGER_PATH);
        if (!f.exists() || f.length() == 0) return new ArrayList<>();
        return mapper.readValue(f, new TypeReference<List<LedgerEntry>>() {});
    }

    private void saveLedger(List<LedgerEntry> ledger) throws IOException {
        mapper.writerWithDefaultPrettyPrinter().writeValue(new File(LEDGER_PATH), ledger);
    }
}