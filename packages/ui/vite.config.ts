import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"
import path from "node:path"

const BACKEND_URL = process.env.VITE_BACKEND_URL || "http://localhost:5000"
const PORT = parseInt(process.env.VITE_PORT || "5002", 10)

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: [{ find: "@", replacement: path.resolve(__dirname, "src") }],
  },
  server: {
    host: "0.0.0.0",
    port: PORT,
    proxy: {
      "/api":    { target: BACKEND_URL, changeOrigin: true },
      "/ws":     { target: BACKEND_URL, ws: true, changeOrigin: true },
      "/auth":   { target: BACKEND_URL, changeOrigin: true },
      "/admin":  { target: BACKEND_URL, changeOrigin: true },
    },
  },
  build: { outDir: "dist", sourcemap: true },
})
