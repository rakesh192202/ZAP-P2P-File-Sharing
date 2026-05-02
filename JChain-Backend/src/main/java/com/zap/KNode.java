package com.zap;

import java.util.Arrays;

/**
 * KNode — A single peer in the Kademlia DHT network.
 *
 * Every device running ZAP is a KNode. Each node has:
 *   - A 160-bit (20-byte) node ID (SHA-1 of its public key or random)
 *   - An IP address and UDP port so other peers can reach it
 *   - A last-seen timestamp so stale nodes can be evicted
 *
 * Node IDs live in a 160-bit XOR metric space. Distance between
 * two nodes = XOR of their IDs. Closer = smaller XOR value.
 */
public class KNode {

    // ── Identity ──────────────────────────────────────────────────────────────
    private final byte[] nodeId;      // 20-byte unique identifier
    private final String ipAddress;   // IPv4 or IPv6
    private final int port;           // UDP port this node listens on

    // ── Liveness ──────────────────────────────────────────────────────────────
    private long lastSeen;            // epoch-ms of last successful contact
    private boolean active;           // false once evicted from a bucket

    // ── Constants ─────────────────────────────────────────────────────────────
    public static final int ID_LENGTH_BYTES = 20; // 160-bit IDs

    // ─────────────────────────────────────────────────────────────────────────
    public KNode(byte[] nodeId, String ipAddress, int port) {
        if (nodeId == null || nodeId.length != ID_LENGTH_BYTES) {
            throw new IllegalArgumentException(
                "Node ID must be exactly " + ID_LENGTH_BYTES + " bytes");
        }
        this.nodeId    = Arrays.copyOf(nodeId, ID_LENGTH_BYTES);
        this.ipAddress = ipAddress;
        this.port      = port;
        this.lastSeen  = System.currentTimeMillis();
        this.active    = true;
    }

    // ── XOR distance ─────────────────────────────────────────────────────────

    /**
     * XOR distance between this node and another.
     * Returns a 20-byte array. Lexicographic comparison gives magnitude.
     * Smaller XOR = closer in Kademlia space.
     */
    public byte[] xorDistance(KNode other) {
        return xorDistance(other.nodeId);
    }

    public byte[] xorDistance(byte[] targetId) {
        byte[] distance = new byte[ID_LENGTH_BYTES];
        for (int i = 0; i < ID_LENGTH_BYTES; i++) {
            distance[i] = (byte) (this.nodeId[i] ^ targetId[i]);
        }
        return distance;
    }

    /**
     * Returns the index of the highest set bit in the XOR distance.
     * This determines which k-bucket this node falls into.
     * Bucket 0 = same prefix (closest), bucket 159 = max distance.
     */
    public int bucketIndex(byte[] targetId) {
        byte[] dist = xorDistance(targetId);
        for (int i = 0; i < ID_LENGTH_BYTES; i++) {
            if (dist[i] != 0) {
                int byteVal = dist[i] & 0xFF;
                // Find highest set bit in this byte
                return (i * 8) + (7 - Integer.numberOfLeadingZeros(byteVal) + 24);
            }
        }
        return -1; // same node ID — distance = 0
    }

    // ── Comparator helpers ───────────────────────────────────────────────────

    /**
     * Compares XOR distance from this node to two candidates.
     * Returns negative if nodeA is closer than nodeB to this node.
     */
    public int compareDistanceTo(byte[] nodeA, byte[] nodeB) {
        for (int i = 0; i < ID_LENGTH_BYTES; i++) {
            int da = (nodeId[i] ^ nodeA[i]) & 0xFF;
            int db = (nodeId[i] ^ nodeB[i]) & 0xFF;
            if (da != db) return Integer.compare(da, db);
        }
        return 0;
    }

    // ── Lifecycle ────────────────────────────────────────────────────────────

    /** Called whenever we receive a message from this node. */
    public void refreshLastSeen() {
        this.lastSeen = System.currentTimeMillis();
        this.active   = true;
    }

    /** True if we have NOT heard from this node within the given timeout (ms). */
    public boolean isStale(long timeoutMs) {
        return (System.currentTimeMillis() - lastSeen) > timeoutMs;
    }

    public void markInactive() {
        this.active = false;
    }

    // ── Equality ─────────────────────────────────────────────────────────────

    @Override
    public boolean equals(Object obj) {
        if (this == obj) return true;
        if (!(obj instanceof KNode)) return false;
        return Arrays.equals(this.nodeId, ((KNode) obj).nodeId);
    }

    @Override
    public int hashCode() {
        return Arrays.hashCode(nodeId);
    }

    @Override
    public String toString() {
        return String.format("KNode{id=%s, addr=%s:%d, active=%b}",
            HashUtils.bytesToHex(nodeId).substring(0, 8) + "…",
            ipAddress, port, active);
    }

    // ── Getters ───────────────────────────────────────────────────────────────
    public byte[] getNodeId()    { return Arrays.copyOf(nodeId, ID_LENGTH_BYTES); }
    public String getIpAddress() { return ipAddress; }
    public int    getPort()      { return port; }
    public long   getLastSeen()  { return lastSeen; }
    public boolean isActive()    { return active; }
}