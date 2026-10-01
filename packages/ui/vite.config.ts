import { defineConfig, type Plugin } from "vite"
import react from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"

const BACKEND_URL = process.env.VITE_BACKEND_URL || "http://localhost:5000"
const PORT = parseInt(process.env.VITE_PORT || "5002", 10)

/** Плейсхолдер версии в `public/sw.js`, заменяется при сборке. */
const SW_VERSION_PLACEHOLDER = "__SYNTH_VERSION__"

function resolveAllowedHosts(): true | string[] {
  const raw = process.env.VITE_ALLOWED_HOSTS
  if (!raw) return true
  const trimmed = raw.trim()
  if (trimmed === "true" || trimmed === "1") return true
  if (trimmed === "false" || trimmed === "0") return [".localhost", ".local"]
  return trimmed.split(",").map((h) => h.trim()).filter(Boolean)
}

/**
 * Подставляет реальную версию Synth в собранный service worker: имя кэша
 * (`synth-shell-<version>`) должно меняться при каждом релизе, иначе байты
 * `/sw.js` идентичны и браузер не увидит новую версию без ручной перезагрузки.
 * Источник версии — `packages/shared/package.json` (синхронизирован с SYNTH_VERSION).
 */
function serviceWorkerVersionPlugin(): Plugin {
  return {
    name: "synth-service-worker-version",
    apply: "build",
    closeBundle() {
      const swPath = path.resolve(__dirname, "dist/sw.js")
      if (!existsSync(swPath)) return
      const source = readFileSync(swPath, "utf8")
      if (!source.includes(SW_VERSION_PLACEHOLDER)) return
      const pkg = JSON.parse(
        readFileSync(path.resolve(__dirname, "../shared/package.json"), "utf8"),
      ) as { version: string }
      writeFileSync(swPath, source.replaceAll(SW_VERSION_PLACEHOLDER, pkg.version))
    },
  }
}

export default defineConfig({
  plugins: [react(), tailwindcss(), serviceWorkerVersionPlugin()],
  resolve: {
    alias: [{ find: "@", replacement: path.resolve(__dirname, "src") }],
  },
  server: {
    host: process.env.VITE_HOST || "0.0.0.0",
    port: PORT,
    allowedHosts: resolveAllowedHosts(),
    proxy: {
      "/api":    { target: BACKEND_URL, changeOrigin: true },
      "/ws":     { target: BACKEND_URL, ws: true, changeOrigin: true },
      "/auth":   { target: BACKEND_URL, changeOrigin: true },
      "/admin":  { target: BACKEND_URL, changeOrigin: true },
    },
  },
  build: { outDir: "dist", sourcemap: true },
})
