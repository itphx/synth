import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import App from "./App"
import { ThemeSystemProvider } from "./contexts/ThemeSystemContext"
import { I18nProvider, initializeLocale } from "./lib/i18n"
import "react-toastify/dist/ReactToastify.css"
import "./styles/index.css"

initializeLocale()

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <I18nProvider>
      <ThemeSystemProvider>
        <App />
      </ThemeSystemProvider>
    </I18nProvider>
  </StrictMode>,
)