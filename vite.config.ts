import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: { "/api": "http://127.0.0.1:3001" },
    watch: {
      ignored: [
        "**/data/**",
        "**/artifacts/**",
        "**/*.sqlite*",
        "**/.superpowers/**",
        "**/dist-server/**",
      ],
    },
  },
  build: { target: "es2022", sourcemap: true, chunkSizeWarningLimit: 650 },
});
