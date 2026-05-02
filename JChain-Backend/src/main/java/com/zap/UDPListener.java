package com.zap;

import com.fasterxml.jackson.databind.ObjectMapper;
import java.net.*;
import java.util.*;

/**
 * UDPListener — Listens for incoming Kademlia DHT messages over UDP.
 *
 * ┌──────────────────────────────────────────────────────────────────────┐
 * │  Runs as a background thread. Every ZAP node starts one of these.  │
 * │                                                                      │
 * │  For each incoming packet it:                                        │
 * │    1. Deserializes the JSON → KMessage                               │
 * │    2. Updates the sender's entry in the routing table               │
 * │       (all contact = implicit PING response)                         │
 * │    3. Dispatches to the correct handler based on message type        │
 * │                                                                      │
 * │  Handlers:                                                           │
 * │    PING        → send PONG back                                      │
 * │    BOOTSTRAP   → send back K closest nodes we know                  │
 * │    FIND_NODE   → send back K closest nodes to requested target       │
 * │    FOUND_NODES → parse returned nodes, add to routing table         │
 * │    STORE       → save key→value in KRouter's local store            │
 * │    FIND_VALUE  → return value if we have it, else FOUND_NODES       │
 * │    VALUE       → save returned value in KRouter's local store       │
 * │    SIGNAL      → push WebRTC SDP/ICE into routing table signal queue│
 * └──────────────────────────────────────────────────────────────────────┘
 */
public class UDPListener implements Runnable {

    // ── Config ────────────────────────────────────────────────────────────────
    private static final int    BUFFER_SIZE = 65_507; // max UDP payload
    private static final int    SO_TIMEOUT  = 1_000;  // ms receive timeout

    // ── State ─────────────────────────────────────────────────────────────────
    private final int          port;
    private final RoutingTable routingTable;
    private final byte[]       localNodeId;
    private final ObjectMapper mapper = new ObjectMapper();
    private final UDPSender    sender = new UDPSender();

    // KRouter reference for local store (STORE / VALUE messages)
    private KRouter router;

    private volatile boolean running = true;
    private DatagramSocket socket;

    // ─────────────────────────────────────────────────────────────────────────
    public UDPListener(int port, RoutingTable routingTable, byte[] localNodeId) {
        this.port         = port;
        this.routingTable = routingTable;
        this.localNodeId  = localNodeId;
    }

    public void setRouter(KRouter router) {
        this.router = router;
    }

    // ── Main loop ─────────────────────────────────────────────────────────────

    @Override
    public void run() {
        try {
            socket = new DatagramSocket(port);
            socket.setSoTimeout(SO_TIMEOUT);
            System.out.printf("[UDPListener] Listening on UDP port %d  nodeId=%s%n",
                port, HashUtils.bytesToHex(localNodeId).substring(0, 16) + "…");

            byte[] buffer = new byte[BUFFER_SIZE];

            while (running) {
                try {
                    DatagramPacket packet = new DatagramPacket(buffer, buffer.length);
                    socket.receive(packet);

                    String json = new String(packet.getData(), 0, packet.getLength());
                    String senderIp   = packet.getAddress().getHostAddress();
                    int    senderPort = packet.getPort();

                    // Parse off the thread pool to keep receive loop fast
                    // In production use a ThreadPoolExecutor here
                    String finalJson    = json;
                    String finalIp      = senderIp;
                    int    finalPort    = senderPort;
                    new Thread(() -> handleMessage(finalJson, finalIp, finalPort)).start();

                } catch (SocketTimeoutException ignored) {
                    // Normal — loop continues, allows checking running flag
                } catch (Exception e) {
                    if (running) {
                        System.err.println("[UDPListener] Receive error: " + e.getMessage());
                    }
                }
            }
        } catch (SocketException e) {
            System.err.println("[UDPListener] Could not bind to port " + port + ": " + e.getMessage());
        } finally {
            if (socket != null && !socket.isClosed()) socket.close();
        }
    }

    // ── Message dispatch ──────────────────────────────────────────────────────

    private void handleMessage(String json, String senderIp, int udpSourcePort) {
        KMessage msg;
        try {
            msg = mapper.readValue(json, KMessage.class);
        } catch (Exception e) {
            System.err.println("[UDPListener] Bad JSON from " + senderIp + ": " + e.getMessage());
            return;
        }

        // Fill in sender IP (they may not know their external IP)
        msg.setSenderIp(senderIp);

        // ── 1. Always update routing table with sender ────────────────────────
        if (msg.getSenderId() != null && !msg.getSenderId().isEmpty()) {
            try {
                byte[] senderId = HashUtils.hexToBytes(msg.getSenderId());
                // The sender's "senderPort" is their DHT listen port (not the UDP source port)
                int dhtPort = msg.getSenderPort() > 0 ? msg.getSenderPort() : udpSourcePort;
                KNode sender = new KNode(senderId, senderIp, dhtPort);
                routingTable.addNode(sender);
            } catch (Exception e) {
                System.err.println("[UDPListener] Bad sender ID: " + e.getMessage());
            }
        }

        // ── 2. Dispatch ───────────────────────────────────────────────────────
        System.out.printf("[UDPListener] ← %s from %s:%d%n",
            msg.getType(), senderIp, msg.getSenderPort());

        switch (msg.getType() != null ? msg.getType() : "") {
            case KMessage.PING       -> handlePing(msg, senderIp);
            case KMessage.PONG       -> handlePong(msg);
            case KMessage.BOOTSTRAP  -> handleBootstrap(msg, senderIp);
            case KMessage.BOOTSTRAP_ACK -> handleBootstrapAck(msg, senderIp);
            case KMessage.FIND_NODE  -> handleFindNode(msg, senderIp);
            case KMessage.FOUND_NODES-> handleFoundNodes(msg);
            case KMessage.STORE      -> handleStore(msg);
            case KMessage.FIND_VALUE -> handleFindValue(msg, senderIp);
            case KMessage.VALUE      -> handleValue(msg);
            case KMessage.SIGNAL     -> handleSignal(msg);
            default -> System.err.println("[UDPListener] Unknown type: " + msg.getType());
        }
    }

    // ── Handlers ──────────────────────────────────────────────────────────────

    private void handlePing(KMessage msg, String senderIp) {
        KMessage pong = KMessage.pong(
            HashUtils.bytesToHex(localNodeId),
            port,
            msg.getMessageId());
        trySend(senderIp, msg.getSenderPort(), pong);
    }

    private void handlePong(KMessage msg) {
        System.out.printf("[UDPListener] PONG from %s ✓%n",
            truncate(msg.getSenderId()));
    }

    private void handleBootstrap(KMessage msg, String senderIp) {
        // Send back our K closest nodes so the joining node can populate its table
        byte[] targetId = HashUtils.hexToBytes(msg.getSenderId());
        List<KNode> closest = routingTable.findClosestNodes(targetId, RoutingTable.K);

        List<Map<String, Object>> nodeInfos = new ArrayList<>();
        for (KNode n : closest) {
            nodeInfos.add(Map.of(
                "nodeId", HashUtils.bytesToHex(n.getNodeId()),
                "ip",     n.getIpAddress(),
                "port",   n.getPort()
            ));
        }

        try {
            String nodesJson = mapper.writeValueAsString(nodeInfos);
            KMessage ack = new KMessage(
                KMessage.BOOTSTRAP_ACK,
                HashUtils.bytesToHex(localNodeId),
                port,
                nodesJson);
            trySend(senderIp, msg.getSenderPort(), ack);
            System.out.printf("[UDPListener] BOOTSTRAP_ACK → %s with %d nodes%n",
                senderIp, closest.size());
        } catch (Exception e) {
            System.err.println("[UDPListener] BOOTSTRAP response error: " + e.getMessage());
        }
    }

    @SuppressWarnings("unchecked")
    private void handleBootstrapAck(KMessage msg, String senderIp) {
        parseAndAddNodes(msg.getPayload(), senderIp);
    }

    private void handleFindNode(KMessage msg, String senderIp) {
        String targetHex = msg.getPayload();
        if (targetHex == null || targetHex.isEmpty()) return;

        byte[]      targetId = HashUtils.hexToBytes(targetHex);
        List<KNode> closest  = routingTable.findClosestNodes(targetId, RoutingTable.K);

        List<Map<String, Object>> nodeInfos = new ArrayList<>();
        for (KNode n : closest) {
            nodeInfos.add(Map.of(
                "nodeId", HashUtils.bytesToHex(n.getNodeId()),
                "ip",     n.getIpAddress(),
                "port",   n.getPort()
            ));
        }

        try {
            String nodesJson = mapper.writeValueAsString(nodeInfos);
            KMessage resp = KMessage.foundNodes(
                HashUtils.bytesToHex(localNodeId), port, nodesJson);
            resp.setMessageId(msg.getMessageId()); // reply token
            trySend(senderIp, msg.getSenderPort(), resp);
        } catch (Exception e) {
            System.err.println("[UDPListener] FIND_NODE response error: " + e.getMessage());
        }
    }

    @SuppressWarnings("unchecked")
    private void handleFoundNodes(KMessage msg) {
        parseAndAddNodes(msg.getPayload(), msg.getSenderIp());
    }

    private void handleStore(KMessage msg) {
        String[] kv = msg.parseStorePayload();
        if (router != null) {
            router.storeLocal(kv[0], kv[1]);
            System.out.printf("[UDPListener] STORE: key=%s%n", kv[0]);
        }
    }

    private void handleFindValue(KMessage msg, String senderIp) {
        String key = msg.getPayload();
        String val = router != null ? router.getLocal(key) : null;

        if (val != null) {
            // We have it — send VALUE directly
            KMessage resp = KMessage.value(HashUtils.bytesToHex(localNodeId), port, val);
            resp.setMessageId(msg.getMessageId());
            trySend(senderIp, msg.getSenderPort(), resp);
        } else {
            // We don't have it — send K closest nodes (like FIND_NODE)
            handleFindNode(msg, senderIp);
        }
    }

    private void handleValue(KMessage msg) {
        String val = msg.getPayload();
        System.out.printf("[UDPListener] VALUE received (len=%d)%n",
            val != null ? val.length() : 0);
        // KRouter.sendFindValue() picks this up from localStore after sleep
    }

    /**
     * WebRTC signaling over DHT — the replacement for a central signaling server.
     *
     * When Alice wants to call Bob:
     *   1. Alice sends KMessage(SIGNAL, payload=sdpOffer, targetNodeId=BobId)
     *   2. UDPListener receives it → pushes to routingTable.signalQueue
     *   3. Bob's browser polls GET /api/jchain/get-signals every 2 seconds
     *   4. Bob gets the SDP offer, creates answer, sends back via same path
     *   5. WebRTC connection established — all future data is direct P2P
     */
    private void handleSignal(KMessage msg) {
        System.out.printf("[UDPListener] SIGNAL from %s → %s%n",
            truncate(msg.getSenderId()),
            truncate(msg.getTargetNodeId()));
        routingTable.pushSignal(msg);
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    @SuppressWarnings("unchecked")
    private void parseAndAddNodes(String payload, String fallbackIp) {
        if (payload == null || payload.isEmpty()) return;
        try {
            List<Map<String, Object>> nodes = mapper.readValue(
                payload, new com.fasterxml.jackson.core.type.TypeReference<>() {});
            for (Map<String, Object> info : nodes) {
                try {
                    byte[] id   = HashUtils.hexToBytes((String) info.get("nodeId"));
                    String ip   = (String) info.getOrDefault("ip", fallbackIp);
                    int    port = Integer.parseInt(info.get("port").toString());
                    routingTable.addNode(new KNode(id, ip, port));
                } catch (Exception e) {
                    System.err.println("[UDPListener] Bad node info: " + e.getMessage());
                }
            }
        } catch (Exception e) {
            System.err.println("[UDPListener] parseAndAddNodes error: " + e.getMessage());
        }
    }

    private void trySend(String ip, int port, KMessage msg) {
        try {
            sender.sendMessage(ip, port, msg);
        } catch (Exception e) {
            System.err.printf("[UDPListener] Send to %s:%d failed: %s%n",
                ip, port, e.getMessage());
        }
    }

    private String truncate(String hex) {
        if (hex == null || hex.length() < 8) return String.valueOf(hex);
        return hex.substring(0, 8) + "…";
    }

    public void stop() {
        running = false;
        if (socket != null) socket.close();
    }
}