import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const apiTarget = process.env.INTYR_API_ORIGIN ?? "http://127.0.0.1:8787";
const proxied = ["/v1", "/sandbox", "/.well-known", "/llms.txt", "/openapi.json", "/healthz", "/version"];

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: Object.fromEntries(proxied.map((path) => [path, { target: apiTarget, changeOrigin: apiTarget.startsWith("https:"), secure: true }])),
  },
  build: {
    outDir: "dist",
    sourcemap: true,
    target: "es2022",
  },
});
