import React from "react";
import { createRoot } from "react-dom/client";
import { App as AntApp, ConfigProvider, theme } from "antd";
import App from "./App";
import "./styles.css";
import { initializeClient } from "./runtime";

void initializeClient().then(() => createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ConfigProvider theme={{ algorithm: theme.darkAlgorithm, token: { colorPrimary: "#b9ed83", colorBgBase: "#111216", borderRadius: 7, fontFamily: '"Inter", "SF Pro Display", "Segoe UI", sans-serif' } }}>
      <AntApp><App /></AntApp>
    </ConfigProvider>
  </React.StrictMode>,
)).catch((error: unknown) => {
  const root = document.getElementById("root")!;
  root.textContent = `无法初始化客户端：${String(error)}`;
});
