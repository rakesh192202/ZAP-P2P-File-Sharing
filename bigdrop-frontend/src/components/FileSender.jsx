import React, { useState } from "react";
// Assuming ConversionModal is in the same folder
import ConversionModal from "./ConversionModal";

/**
 * 🚀 FileSender.jsx
 * Optimized for ZAP Swarm - Secure Ingestion & Conversion UI
 */
export default function FileSender({
    selectedUser,
    onFileSelect,
    onSend,
    progress,
    file,
}) {
    const [isModalOpen, setIsModalOpen] = useState(false);

    function handleChooseFile(e) {
        const chosen = e.target.files[0];
        if (onFileSelect) onFileSelect(chosen);
    }

    function openModal() {
        if (!file) return;
        setIsModalOpen(true);
    }

    function handleConvertConfirm(options) {
        setIsModalOpen(false);
        if (onSend) onSend(options);
    }

    return (
        <div className="card">
            <h2 className="section-title" style={{ marginBottom: "20px" }}>Secure Ingestion</h2>

            {/* File Input Selection */}
            <div style={{ marginBottom: "20px" }}>
                <div className="file-drop-zone" style={{ padding: "20px" }}>
                    <input
                        type="file"
                        id="file-upload-input"
                        onChange={handleChooseFile}
                        style={{ display: "none" }}
                    />
                    <label htmlFor="file-upload-input" style={{ cursor: "pointer", display: "block" }}>
                        <div style={{ fontSize: "24px", marginBottom: "8px" }}>{file ? "📄" : "📁"}</div>
                        <div style={{ fontSize: "13px", color: file ? "#22c55e" : "#94a3b8" }}>
                            {file ? file.name : "Select Asset for Swarm"}
                        </div>
                    </label>
                </div>

                {file && (
                    <div className="hash-box" style={{ marginTop: "10px", display: "flex", justifyContent: "space-between" }}>
                        <span style={{ fontSize: "11px", fontWeight: "600" }}>SIZE:</span>
                        <span style={{ fontSize: "11px", fontFamily: "monospace" }}>
                            {(file.size / 1024).toFixed(1)} KB
                        </span>
                    </div>
                )}
            </div>

            {/* Conversion Options (Edge Processing) */}
            <button
                className="status receiving"
                style={{
                    width: "100%",
                    padding: "12px",
                    border: "1px solid rgba(56, 189, 248, 0.3)",
                    borderRadius: "12px",
                    marginBottom: "12px",
                    cursor: file ? "pointer" : "not-allowed",
                    opacity: file ? 1 : 0.4,
                    fontSize: "12px",
                    fontWeight: "700"
                }}
                disabled={!file}
                onClick={openModal}
            >
                ⚙️ CONVERSION OPTIONS
            </button>

            {/* Main Swarm Button */}
            <button
                className="swarm-btn"
                style={{
                    width: "100%",
                    padding: "16px",
                    opacity: file && selectedUser ? 1 : 0.5,
                    cursor: file && selectedUser ? "pointer" : "not-allowed",
                }}
                disabled={!file || !selectedUser}
                onClick={() => onSend({ mode: "original" })}
            >
                🚀 INITIATE TO NODE_{selectedUser?.slice(0, 6) || "---"}
            </button>

            {/* Streaming Progress */}
            {progress > 0 && (
                <div style={{ marginTop: "20px" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "8px" }}>
                        <span style={{ fontSize: "10px", color: "#94a3b8", fontWeight: "bold" }}>SWARM STATUS</span>
                        <span style={{ fontSize: "10px", color: "#38bdf8", fontWeight: "bold" }}>{Math.round(progress)}%</span>
                    </div>
                    <div style={{ height: "6px", background: "rgba(255,255,255,0.05)", borderRadius: "10px", overflow: "hidden" }}>
                        <div
                            style={{
                                height: "100%",
                                background: "linear-gradient(to right, #38bdf8, #22c55e)",
                                width: `${progress}%`,
                                transition: "width 0.3s ease"
                            }}
                        ></div>
                    </div>
                </div>
            )}

            {/* Conversion Modal Component */}
            {isModalOpen && (
                <ConversionModal
                    isOpen={isModalOpen}
                    onClose={() => setIsModalOpen(false)}
                    onConfirm={handleConvertConfirm}
                    file={file}
                />
            )}
        </div>
    );
}