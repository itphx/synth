import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import App from "./App"
import { ThemeSystemProvider } from "./contexts/ThemeSystemContext"
import { I18nProvider, initializeLocale } from "./lib/i18n"
import { initDeviceClasses } from "./lib/device"
import { applyChatScale, readChatScale } from "./lib/uiScale"
import "react-toastify/dist/ReactToastify.css"
import "@xyflow/react/dist/style.css"
import "./styles/index.css"

initializeLocale()
initDeviceClasses()
// Pre-paint поставил `--chat-scale` сырым клампом (0.75…1.5); здесь — финальная
// нормализация с учётом мобильного минимума (тач-эргономика). Без персиста.
applyChatScale(readChatScale())

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <I18nProvider>
      <ThemeSystemProvider>
        <App />
      </ThemeSystemProvider>
    </I18nProvider>
  </StrictMode>,
)