import "@xyflow/react/dist/style.css";
import "./styles.css";

import { ReactFlowProvider } from "@xyflow/react";
import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ReactFlowProvider>
      <App />
    </ReactFlowProvider>
  </React.StrictMode>,
);
