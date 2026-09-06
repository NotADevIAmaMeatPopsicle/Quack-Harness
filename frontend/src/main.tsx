import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import { sseHub } from "./sse/stream";
import "./index.css";

// Open the SSE feed at app boot. Components opt in to topics via
// sseHub.subscribe(); the hub keeps a single EventSource and reconnects
// on error.
sseHub.open();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
