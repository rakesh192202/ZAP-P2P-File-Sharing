/**
 * ZAP ReliableTransfer.js
 * 
 * Higher-level wrapper around webrtc.js sendFile.
 * Handles:
 *   - Queue (multiple files to same peer)
 *   - Retry on failure (3 attempts)
 *   - Progress events
 *   - Transfer history
 */

import { sendFile, isConnected, createPeerConnection } from './webrtc.js';

// ─── Transfer Queue ───────────────────────────────────────────────────────────

// Map<nodeId, QueueEntry[]>
const queues = new Map();

// Map<transferId, TransferRecord>
const history = new Map();

let _transferCounter = 0;

function makeTransferId() {
  return `txfr_${Date.now()}_${_transferCounter++}`;
}

// ─── Queue a file for sending ─────────────────────────────────────────────────

/**
 * Queue a file to send to a peer.
 * If peer not connected yet — connects first, then sends.
 * 
 * @param {File}     file           - Browser File object
 * @param {string}   remoteNodeId   - Target peer's NodeID (hex)
 * @param {Function} onProgress     - ({pct, speedMBps, chunk, totalChunks}) => void
 * @returns {string} transferId
 */
export async function queueFileTransfer(file, remoteNodeId, onProgress) {
  const transferId = makeTransferId();

  const record = {
    transferId,
    file,
    remoteNodeId,
    status:    'queued',   // queued | connecting | sending | done | failed
    attempts:  0,
    startedAt: null,
    doneAt:    null,
    error:     null,
  };
  history.set(transferId, record);

  if (!queues.has(remoteNodeId)) queues.set(remoteNodeId, []);
  queues.get(remoteNodeId).push({ transferId, file, onProgress });

  // Start draining if not already running
  _drainQueue(remoteNodeId);

  return transferId;
}

// Internal queue drain — processes one file at a time per peer
async function _drainQueue(remoteNodeId) {
  const queue = queues.get(remoteNodeId);
  if (!queue?.length) return;

  // Already draining — let it finish
  if (queue._draining) return;
  queue._draining = true;

  while (queue.length > 0) {
    const { transferId, file, onProgress } = queue[0];
    const record = history.get(transferId);

    record.status    = 'connecting';
    record.startedAt = Date.now();
    record.attempts++;

    try {
      // Connect if not already open
      if (!isConnected(remoteNodeId)) {
        await createPeerConnection(remoteNodeId);
        // Wait for channel to open — poll with timeout
        await _waitForConnection(remoteNodeId, 15_000);
      }

      record.status = 'sending';

      await sendFile(file, remoteNodeId, (progress) => {
        if (onProgress) onProgress({ ...progress, transferId });
      });

      record.status = 'done';
      record.doneAt = Date.now();
      console.log(`✅ Transfer done: ${file.name} → ${remoteNodeId.slice(0, 8)}...`);

    } catch (err) {
      record.error = err.message;

      if (record.attempts < 3) {
        console.warn(`Transfer failed (attempt ${record.attempts}/3), retrying...`);
        // Re-push to retry — don't shift yet
        await new Promise(r => setTimeout(r, 2000 * record.attempts));
        continue;
      } else {
        record.status = 'failed';
        console.error(`Transfer permanently failed: ${file.name}`, err);
      }
    }

    queue.shift(); // Remove processed entry
  }

  queue._draining = false;
}

// Poll until connection is open or timeout
function _waitForConnection(remoteNodeId, timeoutMs) {
  return new Promise((res, rej) => {
    const deadline = Date.now() + timeoutMs;
    const check = () => {
      if (isConnected(remoteNodeId)) return res();
      if (Date.now() > deadline) return rej(new Error('Connection timeout'));
      setTimeout(check, 200);
    };
    check();
  });
}

// ─── ACK processing (called from webrtc.js internally) ───────────────────────

// Map<nodeId, resolve fn> — webrtc.js calls this when ACK arrives
const _ackResolvers = new Map();

export function processAck(nodeId, lastIndex) {
  const resolve = _ackResolvers.get(nodeId);
  if (resolve) {
    _ackResolvers.delete(nodeId);
    resolve(lastIndex);
  }
}

// ─── Transfer Status ──────────────────────────────────────────────────────────

export function getTransferStatus(transferId) {
  return history.get(transferId) ?? null;
}

export function getAllTransfers() {
  return Array.from(history.values());
}

export function getPendingTransfers(remoteNodeId) {
  return queues.get(remoteNodeId)?.map(q => q.transferId) ?? [];
}