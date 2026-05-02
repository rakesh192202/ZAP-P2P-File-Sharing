package com.zap;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.security.SecureRandom;

/**
 * HashUtils — Cryptographic hashing and encoding utilities for ZAP.
 *
 * Functions:
 *   sha256()    → SHA-256 digest (hex string) — used for blockchain anchoring
 *   nodeId()    → SHA-1 digest (20 bytes) — used for Kademlia node IDs
 *   blake3()    → BLAKE3-style fast hash (hex) — used for file chunk integrity
 *   bytesToHex  → byte[] → hex string
 *   hexToBytes  → hex string → byte[]
 *   randomBytes → CSPRNG byte array (for key generation)
 *
 * Note on BLAKE3: Java stdlib has no native BLAKE3. We use SHA-256 as a
 * drop-in here; in production swap this for the blake3 Maven artifact
 * (io.github.rctcwyvrn:blake3:1.4) for 3–10× faster file chunk hashing.
 */
public class HashUtils {

    private HashUtils() {} // utility class, no instances

    // ── SHA-256 (blockchain, message integrity) ───────────────────────────────

    /**
     * SHA-256 of an input string. Returns 64-character lowercase hex.
     * Used by the blockchain ledger for block hashes.
     *
     * Example:
     *   sha256("hello") → "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"
     */
    public static String sha256(String input) {
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            byte[] hash = digest.digest(input.getBytes(StandardCharsets.UTF_8));
            return bytesToHex(hash);
        } catch (NoSuchAlgorithmException e) {
            throw new RuntimeException("SHA-256 not available", e);
        }
    }

    public static byte[] sha256Bytes(String input) {
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            return digest.digest(input.getBytes(StandardCharsets.UTF_8));
        } catch (NoSuchAlgorithmException e) {
            throw new RuntimeException("SHA-256 not available", e);
        }
    }

    public static byte[] sha256Bytes(byte[] input) {
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            return digest.digest(input);
        } catch (NoSuchAlgorithmException e) {
            throw new RuntimeException("SHA-256 not available", e);
        }
    }

    // ── Node ID generation (SHA-1 → 20 bytes for Kademlia) ──────────────────

    /**
     * Kademlia uses 160-bit (20-byte) node IDs.
     * We hash the public key or a random seed with SHA-1 to get 20 bytes.
     *
     * In production: use Ed25519 public key as the seed for binding
     * identity to network address (Sybil resistance).
     */
    public static byte[] generateNodeId(byte[] publicKeyOrSeed) {
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-1");
            return digest.digest(publicKeyOrSeed);
        } catch (NoSuchAlgorithmException e) {
            throw new RuntimeException("SHA-1 not available", e);
        }
    }

    /** Generate a random 20-byte node ID (for dev/testing) */
    public static byte[] randomNodeId() {
        byte[] seed = new byte[32];
        new SecureRandom().nextBytes(seed);
        return generateNodeId(seed);
    }

    // ── BLAKE3-style chunk hashing ────────────────────────────────────────────

    /**
     * Fast hash for file chunks.
     *
     * Production: replace body with:
     *   import io.github.rctcwyvrn.blake3.Blake3;
     *   return Blake3.newInstance().update(data).hexDigest();
     *
     * For now uses SHA-256 as a compatible stand-in.
     * Same API — just swap the implementation.
     */
    public static String chunkHash(byte[] chunkData) {
        // TODO: replace with blake3 for production speed
        return bytesToHex(sha256Bytes(chunkData));
    }

    /**
     * Verify a received chunk matches its expected hash.
     * Returns true only if hash matches exactly — reject chunk if false.
     */
    public static boolean verifyChunk(byte[] chunkData, String expectedHash) {
        return chunkHash(chunkData).equalsIgnoreCase(expectedHash);
    }

    /**
     * Merkle root for a list of chunk hashes.
     * Used to verify complete file integrity after transfer.
     *
     * Pairs up hashes, concatenates, re-hashes. Repeats until one root remains.
     */
    public static String merkleRoot(String[] chunkHashes) {
        if (chunkHashes == null || chunkHashes.length == 0) return "";
        if (chunkHashes.length == 1) return chunkHashes[0];

        String[] layer = chunkHashes;
        while (layer.length > 1) {
            int newLen = (layer.length + 1) / 2;
            String[] next = new String[newLen];
            for (int i = 0; i < newLen; i++) {
                int left  = i * 2;
                int right = left + 1;
                String combined = layer[left] + (right < layer.length ? layer[right] : layer[left]);
                next[i] = sha256(combined);
            }
            layer = next;
        }
        return layer[0];
    }

    // ── DHT key hashing ───────────────────────────────────────────────────────

    /**
     * Hash a DHT key (username, CID, topic) to a 20-byte lookup target.
     * This is how "alice.zap" maps to a location in the XOR ID space.
     */
    public static byte[] dhtKey(String key) {
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-1");
            return digest.digest(key.getBytes(StandardCharsets.UTF_8));
        } catch (NoSuchAlgorithmException e) {
            throw new RuntimeException(e);
        }
    }

    // ── Encoding utilities ────────────────────────────────────────────────────

    /**
     * Convert byte array to lowercase hex string.
     * Example: [0x1A, 0xFF] → "1aff"
     */
    public static String bytesToHex(byte[] bytes) {
        if (bytes == null) return "";
        StringBuilder sb = new StringBuilder(bytes.length * 2);
        for (byte b : bytes) {
            sb.append(String.format("%02x", b & 0xFF));
        }
        return sb.toString();
    }

    /**
     * Convert hex string to byte array.
     * Example: "1aff" → [0x1A, 0xFF]
     */
    public static byte[] hexToBytes(String hex) {
        if (hex == null || hex.isEmpty()) return new byte[0];
        int len = hex.length();
        if (len % 2 != 0) hex = "0" + hex; // pad odd length
        byte[] data = new byte[hex.length() / 2];
        for (int i = 0; i < data.length; i++) {
            data[i] = (byte) Integer.parseInt(hex.substring(i * 2, i * 2 + 2), 16);
        }
        return data;
    }

    // ── Secure random ─────────────────────────────────────────────────────────

    /**
     * Generate cryptographically secure random bytes.
     * Used for keypair generation, nonces, message IDs.
     */
    public static byte[] randomBytes(int count) {
        byte[] bytes = new byte[count];
        new SecureRandom().nextBytes(bytes);
        return bytes;
    }

    /**
     * XOR two byte arrays (must be same length).
     * Core operation of Kademlia distance metric.
     */
    public static byte[] xor(byte[] a, byte[] b) {
        byte[] result = new byte[a.length];
        for (int i = 0; i < a.length; i++) {
            result[i] = (byte) (a[i] ^ b[i]);
        }
        return result;
    }
}