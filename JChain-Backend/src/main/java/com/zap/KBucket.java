package com.zap;

import java.util.*;
import java.util.concurrent.locks.ReentrantReadWriteLock;

/**
 * KBucket — A fixed-size list of KNodes at a specific XOR-distance range.
 *
 * ┌─────────────────────────────────────────────────────────────────────┐
 * │  Kademlia uses 160 k-buckets (one per bit of the ID space).        │
 * │  Bucket i holds nodes whose XOR distance from us has its highest   │
 * │  bit at position i.                                                 │
 * │                                                                     │
 * │  Bucket 0  → nodes 1 hop away  (closest)                           │
 * │  Bucket 159→ nodes 2^159 away  (farthest)                          │
 * │                                                                     │
 * │  Each bucket holds at most K=20 nodes (Kademlia paper default).    │
 * │  Nodes are ordered LRU: head=least-recently-seen, tail=most-recent │
 * │                                                                     │
 * │  Eviction rule: when bucket is full and a NEW node arrives,        │
 * │    1. Ping the HEAD (oldest) node.                                  │
 * │    2. If it responds → keep it, discard new node.                  │
 * │    3. If it doesn't  → evict it, add new node to TAIL.            │
 * │  This prefers long-lived stable nodes (highly available).          │
 * └─────────────────────────────────────────────────────────────────────┘
 */
public class KBucket {

    // ── Constants ─────────────────────────────────────────────────────────────
    public static final int K               = 20;          // max nodes per bucket
    public static final long STALE_TIMEOUT  = 15 * 60_000; // 15 min stale threshold

    // ── State ─────────────────────────────────────────────────────────────────
    /** LRU ordered: index 0 = least recently seen, last = most recently seen */
    private final LinkedList<KNode> nodes = new LinkedList<>();

    /** Nodes that arrived when bucket was full, awaiting eviction check */
    private final Queue<KNode> pendingQueue = new LinkedList<>();

    private final int bucketIndex;
    private final ReentrantReadWriteLock lock = new ReentrantReadWriteLock();

    // ─────────────────────────────────────────────────────────────────────────
    public KBucket(int bucketIndex) {
        this.bucketIndex = bucketIndex;
    }

    // ── Core operations ───────────────────────────────────────────────────────

    /**
     * Add or update a node in this bucket.
     *
     * Rules (Kademlia §2.2):
     *  - If node already in bucket → move it to TAIL (most recently seen).
     *  - If bucket has space       → add to TAIL.
     *  - If bucket is full         → queue it, ping HEAD, evict if stale.
     *
     * @return AddResult describing what happened
     */
    public AddResult addNode(KNode newNode) {
        lock.writeLock().lock();
        try {
            // Case 1: node already known — refresh its position
            for (int i = 0; i < nodes.size(); i++) {
                if (nodes.get(i).equals(newNode)) {
                    nodes.remove(i);
                    newNode.refreshLastSeen();
                    nodes.addLast(newNode);
                    return AddResult.UPDATED;
                }
            }

            // Case 2: bucket has room
            if (nodes.size() < K) {
                newNode.refreshLastSeen();
                nodes.addLast(newNode);
                return AddResult.ADDED;
            }

            // Case 3: bucket full — check if HEAD is stale
            KNode head = nodes.getFirst();
            if (head.isStale(STALE_TIMEOUT)) {
                nodes.removeFirst();
                head.markInactive();
                newNode.refreshLastSeen();
                nodes.addLast(newNode);
                return AddResult.EVICTED_STALE;
            }

            // Case 4: HEAD is alive — queue new node for later consideration
            if (!pendingQueue.contains(newNode)) {
                pendingQueue.offer(newNode);
            }
            return AddResult.PENDING;

        } finally {
            lock.writeLock().unlock();
        }
    }

    /**
     * Called when a ping to the HEAD node fails.
     * Evict it and promote the oldest pending node.
     */
    public void evictHeadAndPromotePending() {
        lock.writeLock().lock();
        try {
            if (!nodes.isEmpty()) {
                KNode evicted = nodes.removeFirst();
                evicted.markInactive();
                System.out.printf("  [KBucket %d] Evicted stale node %s%n",
                    bucketIndex, evicted);
            }
            KNode promoted = pendingQueue.poll();
            if (promoted != null) {
                promoted.refreshLastSeen();
                nodes.addLast(promoted);
                System.out.printf("  [KBucket %d] Promoted pending node %s%n",
                    bucketIndex, promoted);
            }
        } finally {
            lock.writeLock().unlock();
        }
    }

    /**
     * Remove a node by its ID (e.g. after confirmed unreachable).
     */
    public boolean removeNode(byte[] nodeId) {
        lock.writeLock().lock();
        try {
            return nodes.removeIf(n -> Arrays.equals(n.getNodeId(), nodeId));
        } finally {
            lock.writeLock().unlock();
        }
    }

    /**
     * Returns up to `count` nodes closest to the target ID from this bucket.
     * Sorted by XOR distance ascending (closest first).
     */
    public List<KNode> getClosestNodes(byte[] targetId, int count) {
        lock.readLock().lock();
        try {
            List<KNode> copy = new ArrayList<>(nodes);
            copy.sort((a, b) -> compareXorDistance(a.getNodeId(), b.getNodeId(), targetId));
            return copy.subList(0, Math.min(count, copy.size()));
        } finally {
            lock.readLock().unlock();
        }
    }

    /**
     * Returns the least-recently-seen node (HEAD) for ping checking.
     */
    public Optional<KNode> getLeastRecentlySeen() {
        lock.readLock().lock();
        try {
            return nodes.isEmpty() ? Optional.empty() : Optional.of(nodes.getFirst());
        } finally {
            lock.readLock().unlock();
        }
    }

    // ── Utilities ─────────────────────────────────────────────────────────────

    /** XOR distance comparator: which of a or b is closer to target? */
    private int compareXorDistance(byte[] a, byte[] b, byte[] target) {
        for (int i = 0; i < KNode.ID_LENGTH_BYTES; i++) {
            int da = (a[i] ^ target[i]) & 0xFF;
            int db = (b[i] ^ target[i]) & 0xFF;
            if (da != db) return Integer.compare(da, db);
        }
        return 0;
    }

    // ── Getters ───────────────────────────────────────────────────────────────
    public List<KNode> getNodes() {
        lock.readLock().lock();
        try { return Collections.unmodifiableList(new ArrayList<>(nodes)); }
        finally { lock.readLock().unlock(); }
    }

    public int size() {
        lock.readLock().lock();
        try { return nodes.size(); }
        finally { lock.readLock().unlock(); }
    }

    public boolean isFull() {
        lock.readLock().lock();
        try { return nodes.size() >= K; }
        finally { lock.readLock().unlock(); }
    }

    public int getBucketIndex() { return bucketIndex; }

    // ── Result enum ───────────────────────────────────────────────────────────
    public enum AddResult {
        ADDED,          // New node added successfully
        UPDATED,        // Existing node refreshed (moved to tail)
        EVICTED_STALE,  // Stale head evicted, new node added
        PENDING         // Bucket full and head alive; new node queued
    }
}