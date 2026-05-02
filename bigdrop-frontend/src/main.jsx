// 1. MUST BE LINE 1: Polyfill Buffer for Blockchain Libraries
import { Buffer } from 'buffer';
window.Buffer = Buffer;
window.global = window; // Some legacy libs look for 'global'

import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App.jsx";
import "./index.css";

const root = ReactDOM.createRoot(document.getElementById("root"));

root.render(
  <App />
);