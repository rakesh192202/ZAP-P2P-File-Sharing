package com.zap;

import com.fasterxml.jackson.databind.ObjectMapper;
import java.util.*;
import java.util.concurrent.*;

/**
 * KRouter — The Kademlia iterative lookup engine.
 *
 * ┌──────────────────────────────────────────────────────────────────────┐
 * │  Implements the three core Kademlia RPCs as iterative algorithms:   │
 * │                                                                      │
 * │  1. FIND_NODE   → iteratively find K nodes closest to a target ID   │
 * │  2. STORE       → find K closest nodes then store key→value there   │
 * │  3. FIND_VALUE  → find key→value, stopping early on first hit       │
 * │                                                                      │
 * │  Iterative algorithm (not recursive — avoids trust issues):          │
 * │    a. Pick ALPHA closest nodes from routing table.                   │
 * │    b. Send FIND_NODE to all ALPHA in parallel.                       │
 * │    c. From responses, pick ALPHA new closest not-yet-queried.        │
 * │    d. Repeat until no closer node found OR K nodes confirmed.        │
 * │                                                                      │
 * │  Also owns: node ID generation, bootstrap, periodic refresh.        │
 * └──────────────────────────────────────────────────────────────────────┘
 */
public class KRouter {

    // ── Constants ─────────────────────────────────────────────────────────────
    private static final int    ALPHA           = 3;    // parallel RPCs per round
    private static final int    K               = KBucket.K;
    private static final long   RPC_TIMEOUT_MS  = 2_000; // per-RPC timeout
    private static final int    MAX_ROUNDS      = 20;   // prevent infinite loops

    // ── State ─────────────────────────────────────────────────────────────────
    private final ObjectMapper mapper = new ObjectMapper();
    private final UDPSender    sender = new UDPSender();

    // In-memory DHT storage (key → value)
    // In production: use persistent RocksDB or similar
    private final ConcurrentHashMap<String, String> localStore = new ConcurrentHashMap<>();

    // ── Node ID ───────────────────────────────────────────────────────────────

    /**
     * Generate a 20-byte random node ID.
     * In production: derive from Ed25519 public key for Sybil resistance.
     */
    public byte[] generateNodeId() {
        return HashUtils.randomNodeId();
    }

    // ── Iterative FIND_NODE ───────────────────────────────────────────────────

    /**
     * Iterative node lookup — the core of Kademlia.
     *
     * Finds the K nodes closest to targetId in the entire network,
     * contacting peers iteratively until convergence.
     *
     * @param targetId    20-byte target to find
     * @param localNodeId Our own node ID
     * @param routingTable Our routing table to seed initial contacts
     * @param myUdpPort   Our UDP port (for return address in messages)
     * @return List of up to K closest KNodes found
     */
    public List<KNode> iterativeFindNode(
            byte[] targetId,
            byte[] localNodeId,
            RoutingTable routingTable,
            int myUdpPort) {

        String myIdHex    = HashUtils.bytesToHex(localNodeId);
        String targetHex  = HashUtils.bytesToHex(targetId);

        // Shortlist: candidates sorted by XOR distance to target
        // Backed by TreeMap so nearest is always first
        TreeMap<String, KNode> shortlist = new TreeMap<>(
            (a, b) -> compareXorHex(a, b, targetHex));

        Set<String> queried = new HashSet<>();  // node IDs we've already asked
        Set<String> confirmed = new HashSet<>(); // nodes that responded

        // Seed shortlist from local routing table
        List<KNode> seeds = routingTable.findClosestNodes(targetId, ALPHA);
        for (KNode n : seeds) shortlist.put(HashUtils.bytesToHex(n.getNodeId()), n);

        if (shortlist.isEmpty()) {
            System.out.println("[KRouter] No seed nodes — routing table empty");
            return new ArrayList<>();
        }

        String closestSoFar = shortlist.firstKey();

        for (int round = 0; round < MAX_ROUNDS; round++) {
            // Pick ALPHA unqueried nodes from the front of shortlist
            List<KNode> toQuery = new ArrayList<>();
            for (Map.Entry<String, KNode> e : shortlist.entrySet()) {
                if (!queried.contains(e.getKey())) {
                    toQuery.add(e.getValue());
                    if (toQuery.size() >= ALPHA) break;
                }
            }

            if (toQuery.isEmpty()) break; // nothing new to query

            // Send FIND_NODE RPCs in parallel
            List<Future<List<KNode>>> futures = new ArrayList<>();
            ExecutorService pool = Executors.newFixedThreadPool(toQuery.size());

            for (KNode target : toQuery) {
                queried.add(HashUtils.bytesToHex(target.getNodeId()));
                futures.add(pool.submit(() ->
                    sendFindNode(target, targetHex, myIdHex, myUdpPort, routingTable)));
            }

            pool.shutdown();

            // Collect results and add to shortlist
            boolean gotCloser = false;
            for (Future<List<KNode>> f : futures) {
                try {
                    List<KNode> returned = f.get(RPC_TIMEOUT_MS + 500, TimeUnit.MILLISECONDS);
                    if (returned != null) {
                        for (KNode n : returned) {
                            String nIdHex = HashUtils.bytesToHex(n.getNodeId());
                            if (!shortlist.containsKey(nIdHex)) {
                                shortlist.put(nIdHex, n);
                                // Add to our routing table too
                                routingTable.addNode(n);
                            }
                        }
                        // Check if shortlist front got closer
                        if (!shortlist.isEmpty() && compareXorHex(
                                shortlist.firstKey(), closestSoFar, targetHex) < 0) {
                            closestSoFar = shortlist.firstKey();
                            gotCloser = true;
                        }
                    }
                } catch (TimeoutException | ExecutionException | InterruptedException ex) {
                    // Node didn't respond — will be evicted by routing table's stale check
                }
            }

            // Termination: no closer node found this round and K nodes confirmed
            if (!gotCloser && confirmed.size() >= K) break;
            confirmed.addAll(queried);
        }

        // Return top K from shortlist
        List<KNode> result = new ArrayList<>();
        for (KNode n : shortlist.values()) {
            result.add(n);
            if (result.size() >= K) break;
        }
        return result;
    }

    // ── Iterative STORE ───────────────────────────────────────────────────────

    /**
     * STORE: find the K nodes closest to hash(key), then store key→value there.
     *
     * Also stores locally (this node is in the network too).
     *
     * @param key         DHT key (e.g. username, CID, pending signal)
     * @param value       Value to store (JSON string)
     * @param localNodeId Our node ID
     * @param routingTable Our routing table
     * @param myUdpPort   Our UDP port
     */
    public void iterativeStore(String key, String value,
                               byte[] localNodeId, RoutingTable routingTable,
                               int myUdpPort) {
        byte[] keyId = HashUtils.dhtKey(key);

        // Store locally
        localStore.put(key, value);
        System.out.printf("[KRouter] STORE local: key=%s%n", key);

        // Find K closest nodes
        List<KNode> closest = iterativeFindNode(keyId, localNodeId, routingTable, myUdpPort);
        String myIdHex = HashUtils.bytesToHex(localNodeId);

        for (KNode node : closest) {
            try {
                KMessage storeMsg = KMessage.store(myIdHex, myUdpPort, key, value);
                sender.sendMessage(node.getIpAddress(), node.getPort(), storeMsg);
                System.out.printf("[KRouter] STORE → %s:%d key=%s%n",
                    node.getIpAddress(), node.getPort(), key);
            } catch (Exception e) {
                System.err.printf("[KRouter] STORE failed to %s: %s%n",
                    node, e.getMessage());
            }
        }
    }

    // ── Iterative FIND_VALUE ───────────────────────────────────────────────────

    /**
     * FIND_VALUE: look for key→value in the DHT.
     *
     * Like FIND_NODE but stops early if any node returns the value directly.
     *
     * @return The stored value string, or null if not found
     */
    public String iterativeFindValue(String key,
                                     byte[] localNodeId,
                                     RoutingTable routingTable,
                                     int myUdpPort) {
        // Check local store first
        if (localStore.containsKey(key)) {
            System.out.printf("[KRouter] FIND_VALUE hit local: key=%s%n", key);
            return localStore.get(key);
        }

        byte[] keyId     = HashUtils.dhtKey(key);
        String myIdHex   = HashUtils.bytesToHex(localNodeId);
        String targetHex = HashUtils.bytesToHex(keyId);

        List<KNode> seeds = routingTable.findClosestNodes(keyId, ALPHA);
        Set<String>  queried  = new HashSet<>();

        for (int round = 0; round < MAX_ROUNDS && !seeds.isEmpty(); round++) {
            List<Future<String>> futures = new ArrayList<>();
            ExecutorService pool = Executors.newFixedThreadPool(Math.min(ALPHA, seeds.size()));
            List<KNode> batch = seeds.subList(0, Math.min(ALPHA, seeds.size()));

            for (KNode node : batch) {
                String nId = HashUtils.bytesToHex(node.getNodeId());
                if (queried.contains(nId)) continue;
                queried.add(nId);
                futures.add(pool.submit(() ->
                    sendFindValue(node, key, myIdHex, myUdpPort)));
            }
            pool.shutdown();

            for (Future<String> f : futures) {
                try {
                    String result = f.get(RPC_TIMEOUT_MS + 500, TimeUnit.MILLISECONDS);
                    if (result != null) {
                        localStore.put(key, result); // cache locally
                        return result;
                    }
                } catch (Exception ignored) {}
            }

            // Extend search to next wave
            seeds = routingTable.findClosestNodes(keyId, K);
            seeds.removeIf(n -> queried.contains(HashUtils.bytesToHex(n.getNodeId())));
        }

        return null; // not found
    }

    // ── Local store access ────────────────────────────────────────────────────

    public void storeLocal(String key, String value) {
        localStore.put(key, value);
    }

    public String getLocal(String key) {
        return localStore.get(key);
    }

    public Map<String, String> getAllLocalEntries() {
        return Collections.unmodifiableMap(localStore);
    }

    // ── Internal RPC helpers ──────────────────────────────────────────────────

    /**
     * Send a FIND_NODE RPC to a single node and parse its FOUND_NODES response.
     * Returns the list of nodes it returned, or empty list on timeout/error.
     */
    private List<KNode> sendFindNode(KNode target, String targetIdHex,
                                      String myIdHex, int myUdpPort,
                                      RoutingTable routingTable) {
        try {
            KMessage req = KMessage.findNode(myIdHex, myUdpPort, targetIdHex);
            sender.sendMessage(target.getIpAddress(), target.getPort(), req);

            // In production: use request-response matching via messageId.
            // Here we use a short wait and check the routing table for updates.
            Thread.sleep(300);

            // The UDPListener will have processed the FOUND_NODES reply
            // and called routingTable.addNode() for each returned peer.
            // We return what the routing table now knows closest to target.
            return routingTable.findClosestNodes(
                HashUtils.hexToBytes(targetIdHex), RoutingTable.ALPHA);

        } catch (Exception e) {
            return Collections.emptyList();
        }
    }

    /**
     * Send a FIND_VALUE RPC to a single node.
     * Returns the value string if found, null otherwise.
     */
    private String sendFindValue(KNode target, String key,
                                  String myIdHex, int myUdpPort) {
        try {
            KMessage req = KMessage.findValue(myIdHex, myUdpPort, key);
            sender.sendMessage(target.getIpAddress(), target.getPort(), req);
            Thread.sleep(400);
            // Response is handled by UDPListener → storeLocal()
            return localStore.get(key);
        } catch (Exception e) {
            return null;
        }
    }

    // ── XOR distance comparator for hex strings ───────────────────────────────

    /**
     * Compare XOR distance of hex IDs a and b relative to hex target.
     * Returns negative if a is closer, positive if b is closer.
     */
    private int compareXorHex(String aHex, String bHex, String targetHex) {
        byte[] a      = HashUtils.hexToBytes(aHex);
        byte[] b      = HashUtils.hexToBytes(bHex);
        byte[] target = HashUtils.hexToBytes(targetHex);
        for (int i = 0; i < Math.min(a.length, target.length); i++) {
            int da = (a[i] ^ target[i]) & 0xFF;
            int db = (b[i] ^ target[i]) & 0xFF;
            if (da != db) return Integer.compare(da, db);
        }
        return 0;
    }
}