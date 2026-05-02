import React, { useState, useEffect } from 'react';

const LedgerViewer = ({ apiUrl }) => {
  const [history, setHistory] = useState([]);
  const [isSyncing, setIsSyncing] = useState(false);

  const fetchHistory = async () => {
    try {
      setIsSyncing(true);
      // 🚀 THE FIX: Use the proxied URL. 
      // Because of vite.config.js, this hits http://localhost:8080/api/ledger/history
      const res = await fetch(`${apiUrl}/history`);
      
      if (!res.ok) throw new Error(`HTTP Error: ${res.status}`);
      
      const finalData = await res.json(); // Only call .json() ONCE
      
      // Sort to show the latest blocks at the top
      const sortedData = [...finalData].sort((a, b) => b.timestamp - a.timestamp);
      setHistory(sortedData);
      setIsSyncing(false);
    } catch (err) {
      // Quietly log errors to avoid console flooding during dev
      console.warn("J-Chain Sync Pending...", err.message);
      setIsSyncing(false);
    }
  };

  useEffect(() => {
    fetchHistory();
    // Auto-refresh every 5 seconds to show new blocks as they are anchored
    const interval = setInterval(fetchHistory, 5000); 
    return () => clearInterval(interval);
  }, [apiUrl]);

  return (
    <div style={{ marginTop: '30px', background: '#09090b', padding: '25px', borderRadius: '12px', border: '1px solid #27272a' }}>
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid #27272a', paddingBottom: '15px', marginBottom: '15px' }}>
        <h3 style={{ color: '#22c55e', margin: 0, fontSize: '14px', letterSpacing: '1px' }}>
          J-CHAIN IMMUTABLE LEDGER
        </h3>
        {isSyncing && <div style={{ fontSize: '10px', color: '#71717a' }}>SYNCING...</div>}
      </header>

      <div style={{ maxHeight: '400px', overflowY: 'auto', paddingRight: '10px' }}>
        {history.length === 0 ? (
          <p style={{ color: '#3f3f46', fontSize: '13px', textAlign: 'center', padding: '20px' }}>
            No blocks anchored to the ledger yet.
          </p>
        ) : (
          history.map((block, i) => (
            <div key={block.blockHash || i} style={{ 
              padding: '15px', 
              background: '#111113', 
              borderRadius: '8px', 
              marginBottom: '10px', 
              border: '1px solid #18181b',
              fontSize: '11px',
              fontFamily: 'monospace' 
            }}>
              <div style={{ marginBottom: '8px' }}>
                <span style={{ color: '#71717a' }}>BLOCK_HASH:</span> 
                <span style={{ color: '#e4e4e7', marginLeft: '10px' }}>{block.blockHash}</span>
              </div>
              <div style={{ marginBottom: '8px' }}>
                <span style={{ color: '#71717a' }}>MERKLE_ROOT:</span> 
                <span style={{ color: '#22c55e', marginLeft: '10px' }}>{block.fileId}</span>
              </div>
              <div style={{ marginBottom: '8px' }}>
                <span style={{ color: '#71717a' }}>GUARDIANS:</span> 
                <span style={{ color: '#3b82f6', marginLeft: '10px' }}>{Array.isArray(block.nodes) ? block.nodes.join(' → ') : 'N/A'}</span>
              </div>
              <div style={{ color: '#52525b', textAlign: 'right', fontSize: '10px' }}>
                {new Date(block.timestamp).toLocaleString()}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
};

export default LedgerViewer;