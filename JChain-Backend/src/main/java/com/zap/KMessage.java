package com.zap;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonInclude;
import java.io.Serializable;

/**
 * KMessage — The wire protocol for all Kademlia DHT communication in ZAP.
 *
 * Every UDP packet between ZAP nodes is a JSON-serialized KMessage.
 *
 * ┌───────────────────────────────────────────────────────────────┐
 * │  Message types (type field):                                  │
 * │                                                               │
 * │  PING        → "Are you alive?" Health check                 │
 * │  PONG        → "Yes, I'm alive." Response to PING            │
 * │  FIND_NODE   → "Who are the K nodes closest to this ID?"     │
 * │  FOUND_NODES → Response to FIND_NODE with peer list          │
 * │  STORE       → "Store this key→value pair"                   │
 * │  FIND_VALUE  → "Do you have value for this key?"             │
 * │  VALUE       → Response to FIND_VALUE with the value         │
 * │  SIGNAL      → WebRTC SDP offer/answer/ICE candidate         │
 * │  BOOTSTRAP   → Initial join request to a seed node           │
 * └───────────────────────────────────────────────────────────────┘
 */
@JsonIgnoreProperties(ignoreUnknown = true)
@JsonInclude(JsonInclude.Include.NON_NULL)
public class KMessage implements Serializable {

    // ── Message type constants ────────────────────────────────────────────────
    public static final String PING         = "PING";
    public static final String PONG         = "PONG";
    public static final String FIND_NODE    = "FIND_NODE";
    public static final String FOUND_NODES  = "FOUND_NODES";
    public static final String STORE        = "STORE";
    public static final String FIND_VALUE   = "FIND_VALUE";
    public static final String VALUE        = "VALUE";
    public static final String SIGNAL       = "SIGNAL";
    public static final String BOOTSTRAP    = "BOOTSTRAP";
    public static final String BOOTSTRAP_ACK= "BOOTSTRAP_ACK";

    // ── Core fields (always present) ──────────────────────────────────────────

    /** Message type — one of the constants above */
    private String type;

    /** Hex-encoded 20-byte node ID of the sender */
    private String senderId;

    /** UDP port the sender is listening on */
    private int senderPort;

    /** 
     * Payload — meaning depends on type:
     *   PING/PONG/BOOTSTRAP → sender's display info or "OK"
     *   FIND_NODE           → hex target node ID to look up
     *   FOUND_NODES         → JSON array of KNodeInfo objects
     *   STORE               → "key::value" pair
     *   FIND_VALUE          → key to look up
     *   VALUE               → the stored value string
     *   SIGNAL              → WebRTC SDP/ICE JSON string
     */
    private String payload;

    // ── Optional fields ───────────────────────────────────────────────────────

    /** Unique message ID for request–response matching (random UUID) */
    private String messageId;

    /** 
     * For SIGNAL messages: the target peer's node ID (hex).
     * The DHT routes the signal to the right node.
     */
    private String targetNodeId;

    /** Sender's IP (filled in by receiver from UDP packet source, or by sender) */
    private String senderIp;

    /** Epoch-ms when this message was created (for TTL/replay protection) */
    private long timestamp;

    // ── Constructors ─────────────────────────────────────────────────────────

    /** Default no-arg constructor for Jackson deserialization */
    public KMessage() {
        this.timestamp = System.currentTimeMillis();
        this.messageId = java.util.UUID.randomUUID().toString();
    }

    /**
     * Primary constructor used throughout the codebase.
     *
     * @param type       Message type (use constants above)
     * @param senderId   Hex node ID of this node
     * @param senderPort UDP port this node listens on
     * @param payload    Type-specific payload string
     */
    public KMessage(String type, String senderId, int senderPort, String payload) {
        this();
        this.type       = type;
        this.senderId   = senderId;
        this.senderPort = senderPort;
        this.payload    = payload;
    }

    // ── Factory methods ───────────────────────────────────────────────────────

    public static KMessage ping(String senderId, int senderPort) {
        return new KMessage(PING, senderId, senderPort, "PING");
    }

    public static KMessage pong(String senderId, int senderPort, String inReplyTo) {
        KMessage m = new KMessage(PONG, senderId, senderPort, "PONG");
        m.messageId = inReplyTo;
        return m;
    }

    public static KMessage findNode(String senderId, int senderPort, String targetHexId) {
        return new KMessage(FIND_NODE, senderId, senderPort, targetHexId);
    }

    public static KMessage foundNodes(String senderId, int senderPort, String nodesJson) {
        return new KMessage(FOUND_NODES, senderId, senderPort, nodesJson);
    }

    public static KMessage store(String senderId, int senderPort, String key, String value) {
        return new KMessage(STORE, senderId, senderPort, key + "::" + value);
    }

    public static KMessage findValue(String senderId, int senderPort, String key) {
        return new KMessage(FIND_VALUE, senderId, senderPort, key);
    }

    public static KMessage value(String senderId, int senderPort, String val) {
        return new KMessage(VALUE, senderId, senderPort, val);
    }

    public static KMessage signal(String senderId, int senderPort,
                                   String targetNodeId, String sdpOrIce) {
        KMessage m = new KMessage(SIGNAL, senderId, senderPort, sdpOrIce);
        m.targetNodeId = targetNodeId;
        return m;
    }

    public static KMessage bootstrap(String senderId, int senderPort) {
        return new KMessage(BOOTSTRAP, senderId, senderPort, "JOIN");
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    /** Parses STORE payload into {key, value} pair */
    public String[] parseStorePayload() {
        if (payload == null) return new String[]{"", ""};
        String[] parts = payload.split("::", 2);
        return parts.length == 2 ? parts : new String[]{payload, ""};
    }

    /** Returns true if this message has not expired (5-minute TTL) */
    public boolean isFresh() {
        return (System.currentTimeMillis() - timestamp) < 5 * 60_000L;
    }

    @Override
    public String toString() {
        return String.format("KMessage{type=%s, from=%s:%d, msgId=%s}",
            type,
            senderId != null ? senderId.substring(0, Math.min(8, senderId.length())) + "…" : "?",
            senderPort,
            messageId != null ? messageId.substring(0, 8) : "?");
    }

    // ── Getters / Setters ────────────────────────────────────────────────────
    public String getType()         { return type; }
    public void   setType(String t) { this.type = t; }

    public String getSenderId()          { return senderId; }
    public void   setSenderId(String id) { this.senderId = id; }

    public int  getSenderPort()        { return senderPort; }
    public void setSenderPort(int p)   { this.senderPort = p; }

    public String getPayload()           { return payload; }
    public void   setPayload(String p)   { this.payload = p; }

    public String getMessageId()         { return messageId; }
    public void   setMessageId(String m) { this.messageId = m; }

    public String getTargetNodeId()          { return targetNodeId; }
    public void   setTargetNodeId(String id) { this.targetNodeId = id; }

    public String getSenderIp()          { return senderIp; }
    public void   setSenderIp(String ip) { this.senderIp = ip; }

    public long getTimestamp()        { return timestamp; }
    public void setTimestamp(long t)  { this.timestamp = t; }
}