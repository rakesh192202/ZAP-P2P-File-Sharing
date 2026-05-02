package com.zap;

import java.util.List;
import java.util.concurrent.*;

/**
 * KadRefreshService — Background maintenance for the Kademlia routing table.
 *
 * Runs three periodic tasks:
 *
 *  1. BUCKET REFRESH (every 1 hour, per Kademlia spec §2.3)
 *     For each bucket that hasn't had a lookup in the last hour,
 *     perform a FIND_NODE for a random ID in that bucket's range.
 *     This discovers new nodes and evicts truly-dead ones.
 *
 *  2. DATA REPUBLISH (every 1 hour, per Kademlia spec §2.5)
 *     Re-store all key→value pairs this node is responsible for.
 *     Prevents data from disappearing as nodes leave the network.
 *
 *  3. STALE NODE PING (every 15 minutes)
 *     For each bucket's HEAD (least-recently-seen) node, send a PING.
 *     If no PONG, evict it. Promotes any waiting pending nodes.
 */
public class KadRefreshService {

    private static final long BUCKET_REFRESH_INTERVAL_MS = 60 * 60_000L; // 1 hour
    private static final long REPUBLISH_INTERVAL_MS      = 60 * 60_000L; // 1 hour
    private static final long STALE_PING_INTERVAL_MS     = 15 * 60_000L; // 15 min

    private final RoutingTable routingTable;
    private final KRouter      router;
    private final byte[]       localNodeId;
    private final int          myUdpPort;
    private final UDPSender    sender = new UDPSender();

    private final ScheduledExecutorService scheduler =
        Executors.newScheduledThreadPool(3,
            r -> { Thread t = new Thread(r, "kademlia-refresh"); t.setDaemon(true); return t; });

    // ─────────────────────────────────────────────────────────────────────────
    public KadRefreshService(RoutingTable routingTable, KRouter router,
                              byte[] localNodeId, int myUdpPort) {
        this.routingTable = routingTable;
        this.router       = router;
        this.localNodeId  = localNodeId;
        this.myUdpPort    = myUdpPort;
    }

    public void start() {
        // Task 1: Bucket refresh
        scheduler.scheduleAtFixedRate(
            this::refreshStaleBuckets,
            5, 60, TimeUnit.MINUTES);

        // Task 2: Data republish
        scheduler.scheduleAtFixedRate(
            this::republishLocalData,
            10, 60, TimeUnit.MINUTES);

        // Task 3: Stale node ping
        scheduler.scheduleAtFixedRate(
            this::pingStaleNodes,
            2, 15, TimeUnit.MINUTES);

        System.out.println("[KadRefreshService] Started background maintenance tasks");
    }

    public void stop() {
        scheduler.shutdown();
    }

    // ── Task 1: Bucket refresh ────────────────────────────────────────────────

    private void refreshStaleBuckets() {
        List<Integer> stale = routingTable.bucketsNeedingRefresh();
        if (stale.isEmpty()) return;

        System.out.printf("[KadRefreshService] Refreshing %d stale buckets%n", stale.size());

        for (int bucketIdx : stale) {
            try {
                byte[] randomId = routingTable.randomIdInBucket(bucketIdx);
                // Perform iterative FIND_NODE for the random ID
                List<KNode> found = router.iterativeFindNode(
                    randomId, localNodeId, routingTable, myUdpPort);
                routingTable.markRefreshed(bucketIdx);
                System.out.printf("[KadRefreshService] Bucket[%d] refresh found %d nodes%n",
                    bucketIdx, found.size());
            } catch (Exception e) {
                System.err.printf("[KadRefreshService] Bucket[%d] refresh error: %s%n",
                    bucketIdx, e.getMessage());
            }
        }
    }

    // ── Task 2: Data republish ────────────────────────────────────────────────

    private void republishLocalData() {
        var entries = router.getAllLocalEntries();
        if (entries.isEmpty()) return;

        System.out.printf("[KadRefreshService] Republishing %d DHT entries%n", entries.size());

        for (var entry : entries.entrySet()) {
            try {
                router.iterativeStore(
                    entry.getKey(), entry.getValue(),
                    localNodeId, routingTable, myUdpPort);
            } catch (Exception e) {
                System.err.printf("[KadRefreshService] Republish error for key=%s: %s%n",
                    entry.getKey(), e.getMessage());
            }
        }
    }

    // ── Task 3: Stale node ping ───────────────────────────────────────────────

    private void pingStaleNodes() {
        String myIdHex = HashUtils.bytesToHex(localNodeId);
        int evicted = 0;

        for (KBucket bucket : routingTable.getBuckets()) {
            if (bucket.size() == 0) continue;

            bucket.getLeastRecentlySeen().ifPresent(head -> {
                if (head.isStale(KBucket.STALE_TIMEOUT)) {
                    boolean alive = sender.ping(
                        head.getIpAddress(), head.getPort(), myIdHex, myUdpPort);
                    if (!alive) {
                        bucket.evictHeadAndPromotePending();
                        System.out.printf("[KadRefreshService] Evicted dead node %s%n", head);
                    } else {
                        head.refreshLastSeen();
                    }
                }
            });
        }
    }
}