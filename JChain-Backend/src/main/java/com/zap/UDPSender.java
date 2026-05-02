package com.zap;

import com.fasterxml.jackson.databind.ObjectMapper;
import java.net.*;
import java.nio.charset.StandardCharsets;

/**
 * UDPSender — Sends KMessages to other Kademlia peers over UDP.
 *
 * Design notes:
 *  - UDP is connectionless — no handshake overhead. Perfect for Kademlia
 *    where we send thousands of short RPCs.
 *  - Messages are JSON-serialized KMessage objects.
 *  - Max UDP payload = 65,507 bytes. For large WebRTC SDP strings this
 *    is sufficient; file chunks travel over WebRTC DataChannel, not here.
 *  - Fire-and-forget by default. Reliability is provided by the
 *    iterative lookup algorithm (retry with different peers).
 *  - For SIGNAL messages, the payload can be up to ~4KB (SDP offer).
 *    Still well within UDP limits.
 */
public class UDPSender {

    private static final int    DEFAULT_TIMEOUT_MS = 3_000;
    private static final int    MAX_PAYLOAD_BYTES  = 65_000;
    private final ObjectMapper  mapper = new ObjectMapper();

    // ── Send ──────────────────────────────────────────────────────────────────

    /**
     * Serialize msg to JSON and fire it as a UDP datagram to ip:port.
     *
     * @param ip   Destination IP address (IPv4 or IPv6)
     * @param port Destination UDP port
     * @param msg  KMessage to send
     * @throws Exception on network or serialization error
     */
    public void sendMessage(String ip, int port, KMessage msg) throws Exception {
        byte[] data = mapper.writeValueAsBytes(msg);

        if (data.length > MAX_PAYLOAD_BYTES) {
            throw new IllegalArgumentException(
                "KMessage too large for UDP: " + data.length + " bytes. " +
                "Use WebRTC DataChannel for large payloads.");
        }

        try (DatagramSocket socket = new DatagramSocket()) {
            socket.setSoTimeout(DEFAULT_TIMEOUT_MS);
            InetAddress address = InetAddress.getByName(ip);
            DatagramPacket packet = new DatagramPacket(data, data.length, address, port);
            socket.send(packet);

            System.out.printf("[UDPSender] → %s  %s:%d  (%d bytes)%n",
                msg.getType(), ip, port, data.length);
        }
    }

    /**
     * Send and wait for a response packet (request–response pattern).
     * Used for PING where we need to confirm liveness.
     *
     * @param timeoutMs How long to wait for reply
     * @return Parsed response KMessage, or null on timeout
     */
    public KMessage sendAndReceive(String ip, int port,
                                    KMessage msg, int timeoutMs) {
        byte[] data;
        try {
            data = mapper.writeValueAsBytes(msg);
        } catch (Exception e) {
            System.err.println("[UDPSender] Serialize error: " + e.getMessage());
            return null;
        }

        try (DatagramSocket socket = new DatagramSocket()) {
            socket.setSoTimeout(timeoutMs);
            InetAddress address = InetAddress.getByName(ip);

            // Send
            socket.send(new DatagramPacket(data, data.length, address, port));

            // Receive
            byte[] buf = new byte[65_507];
            DatagramPacket response = new DatagramPacket(buf, buf.length);
            socket.receive(response);

            String json = new String(response.getData(), 0, response.getLength(),
                StandardCharsets.UTF_8);
            KMessage reply = mapper.readValue(json, KMessage.class);
            reply.setSenderIp(response.getAddress().getHostAddress());
            return reply;

        } catch (SocketTimeoutException e) {
            System.out.printf("[UDPSender] TIMEOUT waiting for reply from %s:%d%n", ip, port);
            return null;
        } catch (Exception e) {
            System.err.printf("[UDPSender] Error to %s:%d → %s%n", ip, port, e.getMessage());
            return null;
        }
    }

    /**
     * Ping a node and return true if it responds within timeout.
     * Used by KBucket eviction logic to check if HEAD node is still alive.
     */
    public boolean ping(String ip, int port, String localNodeIdHex, int localUdpPort) {
        KMessage pingMsg = KMessage.ping(localNodeIdHex, localUdpPort);
        KMessage reply   = sendAndReceive(ip, port, pingMsg, 2_000);

        if (reply != null && KMessage.PONG.equals(reply.getType())) {
            System.out.printf("[UDPSender] PING ✓ %s:%d is alive%n", ip, port);
            return true;
        }
        System.out.printf("[UDPSender] PING ✗ %s:%d did not respond%n", ip, port);
        return false;
    }
}