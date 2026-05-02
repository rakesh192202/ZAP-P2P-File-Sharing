import React from "react";

/**
 * 🛰️ DeviceList.jsx
 * Optimized for ZAP Swarm - Dark Glassmorphism Edition
 */
export default function DeviceList({
    users = [],
    selectedUser,
    onSelect,
    swarmTable = {},
    bestRoute
}) {
    return (
        <div className="device-container">
            <h2 className="section-title" style={{ marginBottom: "15px" }}>
                Available Swarm Nodes
            </h2>

            {users.length === 0 && (
                <p style={{ color: "#64748b", fontSize: "12px", textAlign: "center", padding: "20px" }}>
                    Scanning for active nodes...
                </p>
            )}

            <div className="peer-selection-list">
                {users.map((u) => {
                    const score = swarmTable[u.id] || 0;
                    const isBest = bestRoute === u.id;
                    const isSelected = selectedUser === u.id;

                    return (
                        <div
                            key={u.id}
                            className={`peer-item ${isSelected ? 'selected' : ''}`}
                            style={{
                                background: isBest ? "rgba(56, 189, 248, 0.15)" : "rgba(255, 255, 255, 0.03)",
                                border: isBest ? "1px solid #38bdf8" : isSelected ? "1px solid #22c55e" : "1px solid transparent",
                                position: "relative",
                                padding: "16px",
                                cursor: "pointer",
                                transition: "0.3s cubic-bezier(0.4, 0, 0.2, 1)"
                            }}
                            onClick={() => onSelect(u.id)}
                        >
                            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                                <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                                    <span style={{ fontSize: "18px" }}>{isBest ? "🚀" : "👤"}</span>
                                    <span className="peer-id-label" style={{ fontWeight: isBest ? "700" : "500" }}>
                                        {u.deviceName || `Node_${u.id.slice(0, 6)}`}
                                    </span>
                                </div>

                                {/* Swarm Score Badge (Pheromone Level) */}
                                <div style={{ textAlign: "right" }}>
                                    <span
                                        className="status"
                                        style={{
                                            background: isBest ? "#38bdf8" : "rgba(255,255,255,0.1)",
                                            color: isBest ? "#020617" : "#94a3b8",
                                            borderRadius: "8px",
                                            padding: "4px 8px",
                                            fontSize: "10px"
                                        }}
                                    >
                                        {score.toFixed(1)} PHO
                                    </span>
                                </div>
                            </div>

                            {isBest && (
                                <div style={{ 
                                    marginTop: "8px", 
                                    fontSize: "10px", 
                                    color: "#38bdf8", 
                                    fontWeight: "800", 
                                    letterSpacing: "0.5px",
                                    display: "flex",
                                    alignItems: "center",
                                    gap: "4px"
                                }}>
                                    <span style={{ width: "6px", height: "6px", background: "#38bdf8", borderRadius: "50%", display: "inline-block" }}></span>
                                    OPTIMAL SWARM ROUTE
                                </div>
                            )}
                        </div>
                    );
                })}
            </div>
        </div>
    );
}