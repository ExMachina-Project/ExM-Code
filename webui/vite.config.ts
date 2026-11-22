import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: Number(process.env.EXM_CODE_UI_PORT || 5174),
    strictPort: true,
    proxy: { "/api": { target: process.env.EXM_CODE_DEV_API || "http://127.0.0.1:4180" } },
  },
  build: {
    chunkSizeWarningLimit: 900,
    rollupOptions: { output: { manualChunks(id) {
      if (!id.includes("node_modules")) return;
      if (id.includes("codemirror") || id.includes("@lezer")) return "editor";
      if (id.includes("react-markdown") || id.includes("remark-") || id.includes("micromark") || id.includes("mdast-")) return "markdown";
    } } },
  },
});
