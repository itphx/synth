import { defineConfig, type Plugin } from "vite"
import react from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"

const BACKEND_URL = process.env.VITE_BACKEND_URL || "http://localhost:5000"
const PORT = parseInt(process.env.VITE_PORT || "5002", 10)

/** Плейсхолдер версии в `public/sw.js`, заменяется при сборке. */
const SW_VERSION_PLACEHOLDER = "__SYNTH_VERSION__"

/**
 * Code-splitting бандла: до этого вся сборка была одним чанком ~2 МБ
 * (sourcemap 8 МБ), что плохо для кэширования и мобильного/PWA-трафика.
 * Вендоры разделяются по назначению, чтобы стабильные библиотеки
 * кэшировались отдельно от прикладного кода (который меняется в каждом релизе).
 */
const REACT_PACKAGES = new Set(["react", "react-dom", "scheduler"])

/** Мелкие спутники Radix/Base UI/Floating UI — держим вместе с примитивами. */
const UI_COMPANION_PACKAGES = new Set([
  "aria-hidden",
  "react-remove-scroll",
  "react-remove-scroll-bar",
  "react-style-singleton",
  "get-nonce",
  "use-callback-ref",
  "use-sidecar",
  "detect-node-es",
  "tabbable",
  "react-is",
])

const MARKDOWN_PACKAGES = new Set(["marked", "dompurify"])

/** Имя пакета по id модуля (`.../node_modules/<pkg>/...`, включая pnpm-путь). */
function packageNameFromId(id: string): string | null {
  const marker = "node_modules/"
  const index = id.lastIndexOf(marker)
  if (index === -1) return null
  const parts = id.slice(index + marker.length).split("/")
  if (!parts[0]) return null
  if (parts[0].startsWith("@")) {
    return parts[1] ? `${parts[0]}/${parts[1]}` : null
  }
  return parts[0]
}

/** Группа вендорного чанка для пакета. `null` — модуль не является вендором. */
function vendorGroupForPackage(pkg: string): string | null {
  if (REACT_PACKAGES.has(pkg)) return "vendor-react"
  if (
    pkg.startsWith("@radix-ui/") ||
    pkg.startsWith("@base-ui/") ||
    pkg.startsWith("@floating-ui/") ||
    UI_COMPANION_PACKAGES.has(pkg)
  ) {
    return "vendor-ui"
  }
  if (pkg === "@remixicon/react") return "vendor-icons"
  if (MARKDOWN_PACKAGES.has(pkg)) return "vendor-markdown"
  return "vendor-misc"
}

/** `codeSplitting.groups[].name`: вендорные модули → отдельные чанки, свои — в entry. */
function vendorChunkName(id: string): string | null {
  const pkg = packageNameFromId(id)
  return pkg ? vendorGroupForPackage(pkg) : null
}

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
  build: {
    outDir: "dist",
    sourcemap: true,
    rollupOptions: {
      output: {
        // Разделение по группам: вендоры по назначению (см. `vendorChunkName`) +
        // реестр тем отдельным чанком — он статически импортируется на старте, но
        // весит ~316 kB и меняется редко (кэш переживает релизы, entry уходит под
        // порог предупреждения Vite). Прикладной код остаётся в entry/ленивых
        // чанках (`import()` в App.tsx / RightPanel.tsx).
        codeSplitting: {
          groups: [
            { name: "themes", test: /[\\/]lib[\\/]theme[\\/]themes[\\/]/ },
            {
              name: vendorChunkName,
              test: /node_modules[\\/]/,
            },
          ],
        },
      },
    },
  },
})
