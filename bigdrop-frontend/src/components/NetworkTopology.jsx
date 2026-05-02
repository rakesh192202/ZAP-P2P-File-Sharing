import React, { useState, useEffect, useMemo } from 'react';
import Graph from "react-vis-network-graph";
import { v4 as uuidv4 } from 'uuid'; // Useful for generating unique node IDs if needed

const NetworkTopology = ({ swarm, localNodeName, isJoined }) => {
  const [graphData, setGraphData] = useState({ nodes: [], edges: [] });

  // 🛡️ Data Transformation for Vis.js
  // Vis.js requires data in a specific format { nodes: [], edges: [] }.
  // We reconstruct this data whenever the 'swarm' state changes.
  const networkData = useMemo(() => {
    const nodes = [];
    const edges = [];

    if (!isJoined) return { nodes, edges };

    // 1. Add Local Node
    nodes.push({
      id: localNodeName,
      label: localNodeName,
      color: "#22c55e", // Use green for the local node
      shape: "dot",
      size: 30,
      font: { color: "#fff", face: "monospace", size: 16 }
    });

    // 2. Add Remote Nodes and Edges
    swarm.forEach(node => {
      // Add Remote Node
      nodes.push({
        id: node.nodeId,
        label: node.nodeId,
        color: "#3b82f6", // Use blue for remote nodes
        shape: "dot",
        size: 25,
        font: { color: "#fff", face: "monospace", size: 14 }
      });

      // Add Edge (Connecting Local to Remote)
      edges.push({
        from: localNodeName,
        to: node.nodeId,
        color: "#71717a", // Dark gray edges
        smooth: { type: "continuous" } // For nice curved lines
      });
    });

    return { nodes, edges };
  }, [swarm, localNodeName, isJoined]);


  // Update the graph data state whenever the processed networkData changes
  useEffect(() => {
    setGraphData(networkData);
  }, [networkData]);

  // Vis.js Network Options
  // Configures the physics simulation, interaction behavior, and overall look.
  const options = {
    layout: {
      hierarchical: false, // Turn off for force-directed layout
    },
    edges: {
      arrows: { to: { enabled: false } }, // Turn off arrows for undirected edges
      width: 2,
    },
    nodes: {
      borderWidth: 2,
      borderColor: "#27272a", // Darker border
    },
    physics: {
      enabled: true,
      barnesHut: {
        gravitationalConstant: -20000,
        centralGravity: 0.3,
        springLength: 200,
        springConstant: 0.04,
        damping: 0.09,
        avoidOverlap: 0.1
      },
      stabilization: { enabled: true, iterations: 1000 },
    },
    interaction: {
      hover: true,
      dragNodes: true, // Allow dragging nodes
      zoomView: true,  // Allow zooming
      dragView: true,  // Allow dragging the view
    },
    height: "100%", // Fit to parent container
    width: "100%",  // Fit to parent container
  };

  const events = {
    // Defines event handlers if needed
    // e.g., doubleClick: (event) => console.log("doubleClicked Node: ", event.nodes[0])
  };

  // Styles for the parent container
  const containerStyle = {
    background: '#09090b',
    border: '1px solid #27272a',
    borderRadius: '12px',
    marginTop: '30px',
    padding: '20px',
    height: '400px', // Set a reasonable height for the visualization
    overflow: 'hidden', // Prevent vis-network from spilling out
    fontFamily: 'monospace'
  };

  return (
    <div style={containerStyle}>
      <h3 style={{ color: '#22c55e', borderBottom: '1px solid #27272a', paddingBottom: '10px', marginBottom: '15px' }}>
        NETWORK TOPOLOGY
      </h3>
      <div style={{ position: 'relative', height: '100%', width: '100%' }}>
        <Graph
          graph={graphData}
          options={options}
          events={events}
        />
      </div>
    </div>
  );
};

export default NetworkTopology;