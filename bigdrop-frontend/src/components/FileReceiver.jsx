import React from "react";

/**
 * 📥 FileReceiver.jsx
 * Optimized for ZAP Swarm - Real-time Integrity Verification UI
 */
export default function FileReceiver({ fileName, progress, isReceiving, status = "Waiting" }) {
    return (
        <div className="card" style={{ marginTop: "20px", border: isReceiving ? "1px solid #38bdf8" : "1px solid rgba(255,255,255,0.08)" }}>
            <div className="card-header" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "15px" }}>
                <h2 className="section-title" style={{ margin: 0 }}>Incoming Stream</h2>
                {isReceiving && <span className="status receiving" style={{ animation: "pulse 2s infinite" }}>VERIFYING...</span>}
            </div>

            {/* Idle State */}
            {!isReceiving && (
                <div style={{ textAlign: "center", padding: "20px" }}>
                    <div style={{ fontSize: "24px", opacity: 0.2, marginBottom: "10px" }}>📡</div>
                    <p style={{ fontSize: "12px", color: "#64748b", margin: 0 }}>Listening for Swarm broadcast...</p>
                </div>
            )}

            {/* Receiving State */}
            {isReceiving && (
                <>
                    {/* File Info Box */}
                    <div className="hash-box" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "15px", background: "rgba(56, 189, 248, 0.05)" }}>
                        <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                            <span style={{ fontSize: "18px" }}>📄</span>
                            <span style={{ color: "#e2e8f0", fontWeight: "600", fontSize: "13px" }}>
                                {fileName || "Unknown Asset"}
                            </span>
                        </div>
                        <span style={{ color: "#38bdf8", fontWeight: "800", fontSize: "12px" }}>
                            {Math.round(progress)}%
                        </span>
                    </div>

                    {/* Progress Track */}
                    <div style={{ width: "100%", height: "8px", background: "rgba(255,255,255,0.05)", borderRadius: "10px", overflow: "hidden" }}>
                        <div
                            style={{
                                height: "100%",
                                background: "linear-gradient(to right, #38bdf8, #22c55e)",
                                width: `${progress}%`,
                                transition: "width 0.3s cubic-bezier(0.4, 0, 0.2, 1)",
                                boxShadow: "0 0 10px rgba(56, 189, 248, 0.5)"
                            }}
                        />
                    </div>
                    
                    <p style={{ fontSize: "10px", color: "#94a3b8", marginTop: "10px", textAlign: "center", fontFamily: "monospace" }}>
                        {progress === 100 ? "✓ INTEGRITY CHECK PASSED" : "ASSEMBLING BINARY CHUNKS..."}
                    </p>
                </>
            )}
        </div>
    );
}