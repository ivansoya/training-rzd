import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles/common.css";
import "./styles/datasets.css";
import "./styles/augment.css";
import "./styles/train.css";
import "./styles/inference.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
