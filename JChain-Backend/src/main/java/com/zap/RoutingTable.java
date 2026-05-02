package com.zap;

import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.locks.ReentrantReadWriteLock;
import java.util.stream.Collectors;

/**
 * RoutingTable — The complete Kademlia routing table for a ZAP node.
 *
 * ┌─────────────────────────────────────────────────────────────────────┐
 * │  Structure: 160 KBuckets, indexed 0..159.                          │
 * │                                                                     │
 * │  Bucket i stores nodes where:                                       │
 * │    2^i  ≤ XOR(localId, nodeId) < 2^(i+1)                          │
 * │                                                                     │
 * │  FIND_NODE: return K closest nodes across all buckets.             │
 * │  ADD_NODE:  route to correct bucket, apply LRU eviction rules.     │
 * │  REFRESH:   periodically re-lookup random IDs in each bucket       │
 * │             to keep it populated.                                   │
 * │                                                                     │
 * │  Also manages the WebRTC signal queue used instead of a central    │
 * │  signaling server. Signals arrive via UDP and are popped by the    │
 * │  REST endpoint GET /api/jchain/get-signals.                        │
 * └─────────────────────────────────────────────────────────────────────┘
 */
public class RoutingTable {

    // ── Constants ─────────────────────────────────────────────────────────────
    public static final int    NUM_BUCKETS    = 160;   // one per bit of ID space
    public static final int    ALPHA          = 3;     // parallelism factor
    public static final int    K              = KBucket.K;
    public static final long   REFRESH_INTERVAL = 60 * 60_000L; // 1 hour

    // ── State ─────────────────────────────────────────────────────────────────
    private final byte[] localNodeId;
    private final KBucket[] buckets = new KBucket[NUM_BUCKETS];
    private final ReentrantReadWriteLock lock = new ReentrantReadWriteLock();

    /** Thread-safe queue for incoming WebRTC signaling messages */
    private final ConcurrentLinkedQueue<KMessage> signalQueue = new ConcurrentLinkedQueue<>();

    /** Tracks last-lookup time per bucket for refresh logic */
    private final long[] lastRefreshed = new long[NUM_BUCKETS];

    // ─────────────────────────────────────────────────────────────────────────
    public RoutingTable(byte[] localNodeId) {
        this.localNodeId = Arrays.copyOf(localNodeId, localNodeId.length);
        for (int i = 0; i < NUM_BUCKETS; i++) {
            buckets[i] = new KBucket(i);
            lastRefreshed[i] = System.currentTimeMillis();
        }
        System.out.printf("[RoutingTable] Initialized. Local node: %s%n",
            HashUtils.bytesToHex(localNodeId).substring(0, 16) + "…");
    }

    // ── Node management ───────────────────────────────────────────────────────

    /**
     * Add (or refresh) a node into the correct k-bucket.
     * Silently ignores ourselves.
     *
     * @param node The peer that just contacted us or was discovered
     */
    public KBucket.AddResult addNode(KNode node) {
        if (Arrays.equals(node.getNodeId(), localNodeId)) {
            return KBucket.AddResult.UPDATED; // never add ourselves
        }
        int idx = bucketIndex(node.getNodeId());
        if (idx < 0) return KBucket.AddResult.UPDATED; // same id, skip

        KBucket.AddResult result = buckets[idx].addNode(node);
        System.out.printf("[RoutingTable] addNode bucket[%d] → %s  %s%n",
            idx, result, node);
        return result;
    }

    /**
     * Remove a confirmed-dead node from the table.
     */
    public void removeNode(byte[] nodeId) {
        int idx = bucketIndex(nodeId);
        if (idx >= 0) buckets[idx].removeNode(nodeId);
    }

    // ── Lookup ────────────────────────────────────────────────────────────────

    /**
     * FIND_NODE: Return the K nodes closest to targetId across all buckets.
     *
     * Algorithm:
     *  1. Start from the bucket where targetId would live.
     *  2. Expand outward (±1, ±2, …) until we have K candidates.
     *  3. Sort all candidates by XOR distance to target.
     *  4. Return top K.
     */
    public List<KNode> findClosestNodes(byte[] targetId) {
        return findClosestNodes(targetId, K);
    }

    public List<KNode> findClosestNodes(byte[] targetId, int count) {
        lock.readLock().lock();
        try {
            List<KNode> candidates = new ArrayList<>();

            int start = bucketIndex(targetId);
            if (start < 0) start = 0;

            // Collect from closest bucket outward
            for (int distance = 0; distance < NUM_BUCKETS && candidates.size() < count * 2; distance++) {
                int low  = start - distance;
                int high = start + distance;
                if (low  >= 0 && low  < NUM_BUCKETS) candidates.addAll(buckets[low].getNodes());
                if (high != low && high >= 0 && high < NUM_BUCKETS)
                    candidates.addAll(buckets[high].getNodes());
            }

            // Sort by XOR distance to target
            candidates.sort((a, b) -> compareXorDistance(
                a.getNodeId(), b.getNodeId(), targetId));

            // Deduplicate and limit
            List<KNode> result = candidates.stream()
                .distinct()
                .limit(count)
                .collect(Collectors.toList());

            return result;
        } finally {
            lock.readLock().unlock();
        }
    }

    /**
     * Returns the single closest known node to targetId.
     * Used for direct routing decisions.
     */
    public Optional<KNode> findClosestNode(byte[] targetId) {
        List<KNode> closest = findClosestNodes(targetId, 1);
        return closest.isEmpty() ? Optional.empty() : Optional.of(closest.get(0));
    }

    // ── Bucket index calculation ───────────────────────────────────────────────

    /**
     * Which bucket does this node belong in?
     *
     * Kademlia bucket i stores nodes at XOR distance [2^i, 2^(i+1)).
     * We find the position of the most significant bit in XOR(local, target).
     *
     * Returns -1 if nodeId == localNodeId (same node, distance 0).
     */
    public int bucketIndex(byte[] nodeId) {
        for (int i = 0; i < KNode.ID_LENGTH_BYTES; i++) {
            int xorByte = (localNodeId[i] ^ nodeId[i]) & 0xFF;
            if (xorByte != 0) {
                // Highest set bit position within this byte
                int bitPos = 7 - Integer.numberOfLeadingZeros(xorByte) + 24;
                return (i * 8) + bitPos;
            }
        }
        return -1; // distance = 0
    }

    // ── Refresh ───────────────────────────────────────────────────────────────

    /**
     * Returns the list of bucket indices that need refreshing
     * (no lookup performed in the last REFRESH_INTERVAL).
     * The caller should perform a random-ID lookup in each returned bucket.
     */
    public List<Integer> bucketsNeedingRefresh() {
        long now = System.currentTimeMillis();
        List<Integer> stale = new ArrayList<>();
        for (int i = 0; i < NUM_BUCKETS; i++) {
            if (now - lastRefreshed[i] > REFRESH_INTERVAL && buckets[i].size() > 0) {
                stale.add(i);
            }
        }
        return stale;
    }

    public void markRefreshed(int bucketIdx) {
        lastRefreshed[bucketIdx] = System.currentTimeMillis();
    }

    /**
     * Generate a random node ID that falls in bucket i.
     * Used to pick a lookup target for bucket refresh.
     */
    public byte[] randomIdInBucket(int bucketIdx) {
        byte[] id = Arrays.copyOf(localNodeId, KNode.ID_LENGTH_BYTES);
        // Flip bit at position bucketIdx to land in that bucket
        int bytePos = bucketIdx / 8;
        int bitPos  = 7 - (bucketIdx % 8);
        id[bytePos] ^= (byte) (1 << bitPos);
        // Randomize all lower bits
        Random rnd = new Random();
        for (int i = bytePos + 1; i < KNode.ID_LENGTH_BYTES; i++) {
            id[i] = (byte) rnd.nextInt(256);
        }
        return id;
    }

    // ── WebRTC signal queue ───────────────────────────────────────────────────

    /**
     * FIXED: Per-target signal queues.
     * Old: one global queue — Mac would consume Phone's signals and vice versa.
     * New: signals stored by targetNodeId, each device only gets its own signals.
     */
    private final ConcurrentHashMap<String, ConcurrentLinkedQueue<KMessage>>
        signalQueues = new ConcurrentHashMap<>();

    /**
     * Push a signal into the target's personal queue.
     * Falls back to global queue for backward compat if no targetNodeId set.
     */
    public void pushSignal(KMessage signal) {
        String target = signal.getTargetNodeId();
        if (target != null && !target.isBlank()) {
            signalQueues
                .computeIfAbsent(target, k -> new ConcurrentLinkedQueue<>())
                .offer(signal);
            System.out.printf("[RoutingTable] Signal queued for target %s from %s%n",
                target.substring(0, Math.min(8, target.length())),
                signal.getSenderId() != null ? signal.getSenderId().substring(0, Math.min(8, signal.getSenderId().length())) : "?");
        } else {
            // No target set — keep in legacy global queue
            signalQueue.offer(signal);
        }
    }

    /**
     * Called by GET /api/jchain/get-signals?nodeId=xxx
     * Returns only signals addressed to this specific node.
     * Falls back to returning everything (old behavior) if no nodeId given.
     */
    public List<KMessage> popSignalsFor(String targetNodeId) {
        List<KMessage> result = new ArrayList<>();

        // Pop from this node's personal queue
        if (targetNodeId != null && !targetNodeId.isBlank()) {
            ConcurrentLinkedQueue<KMessage> q = signalQueues.get(targetNodeId);
            if (q != null) {
                KMessage msg;
                while ((msg = q.poll()) != null) result.add(msg);
            }
        }

        // Also drain legacy global queue (backward compat)
        KMessage msg;
        while ((msg = signalQueue.poll()) != null) result.add(msg);

        return result;
    }

    /** Legacy: drain all signals (used by old callers) */
    public List<KMessage> popSignals() {
        List<KMessage> drained = new ArrayList<>();
        // Drain all per-target queues
        for (ConcurrentLinkedQueue<KMessage> q : signalQueues.values()) {
            KMessage msg;
            while ((msg = q.poll()) != null) drained.add(msg);
        }
        // Drain global legacy queue
        KMessage msg;
        while ((msg = signalQueue.poll()) != null) drained.add(msg);
        return drained;
    }

    // ── Summary info ──────────────────────────────────────────────────────────

    /** Total number of known peers across all buckets */
    public int totalPeerCount() {
        int count = 0;
        for (KBucket b : buckets) count += b.size();
        return count;
    }

    public KBucket[] getBuckets() {
        return buckets;
    }

    /** Returns only non-empty buckets for display/debugging */
    public List<KBucket> getActiveBuckets() {
        List<KBucket> active = new ArrayList<>();
        for (KBucket b : buckets) {
            if (b.size() > 0) active.add(b);
        }
        return active;
    }

    public byte[] getLocalNodeId() {
        return Arrays.copyOf(localNodeId, localNodeId.length);
    }

    // ── XOR comparator ────────────────────────────────────────────────────────
    private int compareXorDistance(byte[] a, byte[] b, byte[] target) {
        for (int i = 0; i < KNode.ID_LENGTH_BYTES; i++) {
            int da = (a[i] ^ target[i]) & 0xFF;
            int db = (b[i] ^ target[i]) & 0xFF;
            if (da != db) return Integer.compare(da, db);
        }
        return 0;
    }
}