package com.zap;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonAlias;

/**
 * LedgerEntry — Blockchain block for ZAP file transfers.
 *
 * Uses boxed Long (not primitive long) so null values from old/partial
 * ledger.json entries don't cause Jackson deserialization errors (500).
 *
 * @JsonAlias handles old field names from previous versions.
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public class LedgerEntry {

    private String fileId;
    private String fileName;
    private Long   fileSize;      // boxed — handles null from old ledger entries
    private String fileType;

    @JsonAlias({"senderNodeId","senderId"})
    private String senderNodeId;

    @JsonAlias({"receiverNodeId","receiverId"})
    private String receiverNodeId;

    private String senderZapId;
    private String receiverZapId;
    private String direction;
    private String status;
    private String merkleRoot;
    private int    chunkCount;
    private String previousHash;
    private String blockHash;
    private Long   timestamp;    // boxed — handles null from old ledger entries

    public LedgerEntry() {}

    @Override
    public String toString() {
        return String.format("Block{file=%s, %sB, %s → %s, hash=%s…}",
            fileName, fileSize,
            senderZapId != null ? senderZapId : senderNodeId != null ? senderNodeId.substring(0, Math.min(8, senderNodeId.length())) : "?",
            receiverZapId != null ? receiverZapId : receiverNodeId != null ? receiverNodeId.substring(0, Math.min(8, receiverNodeId.length())) : "?",
            blockHash != null ? blockHash.substring(0, Math.min(16, blockHash.length())) : "pending");
    }

    public String getFileId()              { return fileId; }
    public void   setFileId(String v)      { this.fileId = v; }
    public String getFileName()            { return fileName; }
    public void   setFileName(String v)    { this.fileName = v; }
    public Long   getFileSize()            { return fileSize; }
    public void   setFileSize(Long v)      { this.fileSize = v; }
    public String getFileType()            { return fileType; }
    public void   setFileType(String v)    { this.fileType = v; }
    public String getSenderNodeId()        { return senderNodeId; }
    public void   setSenderNodeId(String v){ this.senderNodeId = v; }
    public String getReceiverNodeId()        { return receiverNodeId; }
    public void   setReceiverNodeId(String v){ this.receiverNodeId = v; }
    public String getSenderZapId()         { return senderZapId; }
    public void   setSenderZapId(String v) { this.senderZapId = v; }
    public String getReceiverZapId()         { return receiverZapId; }
    public void   setReceiverZapId(String v) { this.receiverZapId = v; }
    public String getDirection()           { return direction; }
    public void   setDirection(String v)   { this.direction = v; }
    public String getStatus()              { return status; }
    public void   setStatus(String v)      { this.status = v; }
    public String getMerkleRoot()          { return merkleRoot; }
    public void   setMerkleRoot(String v)  { this.merkleRoot = v; }
    public int    getChunkCount()          { return chunkCount; }
    public void   setChunkCount(int v)     { this.chunkCount = v; }
    public String getPreviousHash()        { return previousHash; }
    public void   setPreviousHash(String v){ this.previousHash = v; }
    public String getBlockHash()           { return blockHash; }
    public void   setBlockHash(String v)   { this.blockHash = v; }
    public Long   getTimestamp()           { return timestamp; }
    public void   setTimestamp(Long v)     { this.timestamp = v; }
}