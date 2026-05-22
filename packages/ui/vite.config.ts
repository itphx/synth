import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"
import path from "node:path"

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: [{ find: "@", replacement: path.resolve(__dirname, "src") }],
  },
  server: {
    host: "0.0.0.0",
    port: 5002,
    proxy: {
      "/api":    { target: "http://localhost:5000", changeOrigin: true },
      "/ws":     { target: "http://localhost:5000", ws: true, changeOrigin: true },
      "/auth":   { target: "http://localhost:5000", changeOrigin: true },
      "/admin":  { target: "http://localhost:5000", changeOrigin: true },
    },
  },
  build: { outDir: "dist", sourcemap: true },
})
