import { Fragment } from "react"
import { Dialog, DialogClose, DialogContent } from "../ui/dialog"
import { Icon } from "../icon/Icon"
import { useUIStore } from "../../stores/useUIStore"
import { useAuthStore } from "@/stores/authStore"
import { useI18n } from "@/lib/i18n"
import { cn } from "@/lib/utils"
import { useDevice } from "@/hooks/useDevice"
import { LogFilePanel } from "./LogFilePanel"
import { AuditLogPanel } from "./AuditLogPanel"
import { LlmPayloadPanel } from "./LlmPayloadPanel"

interface CategoryItem {
  id: string
  labelKey: string
  icon: string
}

const CATEGORIES: CategoryItem[] = [
  { id: "core", labelKey: "logs.category.core", icon: "terminal-box" },
  { id: "ui", labelKey: "logs.category.ui", icon: "file-text" },
  { id: "backend", labelKey: "logs.category.backend", icon: "server" },
  { id: "llm", labelKey: "logs.category.llm", icon: "file-code" },
  { id: "audit", labelKey: "logs.category.audit", icon: "shield-keyhole" },
]

/** Модальное окно «Логи и аудит»: логи сервисов core/ui/backend + журнал аудита LLM Gateway. */
export const LogsModal = () => {
  const { t } = useI18n()
  const user = useAuthStore(s => s.user)
  const isLogsDialogOpen = useUIStore(s => s.isLogsDialogOpen)
  const setLogsDialogOpen = useUIStore(s => s.setLogsDialogOpen)
  const logsPage = useUIStore(s => s.logsPage)
  const setLogsPage = useUIStore(s => s.setLogsPage)
  const { deviceType } = useDevice()
  const isPhone = deviceType === 'phone'

  const userRoles = user?.roles ?? []
  const visibleCategories = CATEGORIES.filter(
    () => userRoles.includes('ADMIN') || userRoles.includes('AUDITOR')
  )

  return (
    <Dialog open={isLogsDialogOpen} onOpenChange={setLogsDialogOpen}>
      <DialogContent
        className="p-0 gap-0 max-w-5xl w-[95vw] h-[90vh] max-h-[90vh] md:max-h-[85vh] shadow-xl"
        showCloseButton={false}
      >
        <div className={cn("flex h-full overflow-hidden overscroll-contain", isPhone ? "flex-col" : "md:flex-row")}>
          {/* Left sidebar (desktop) / mobile horizontal menu tabs */}
          <div className={cn("flex flex-col shrink-0", !isPhone && "w-48 md:w-52 border-r border-border")}>
            <div className="flex items-center gap-2 px-4 h-12 border-b border-border">
              <Icon name="terminal-box" className="size-4 text-muted-foreground" />
              <span className="font-medium text-sm">{t('logs.title')}</span>
              <div className="ml-auto">
                <DialogClose
                  className="rounded-lg p-1.5 opacity-70 transition-opacity hover:opacity-100 hover:bg-interactive-hover text-muted-foreground hover:text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                  aria-label={t('common.close')}
                >
                  <Icon name="close" className="size-4" />
                </DialogClose>
              </div>
            </div>
            <nav
              className={cn(
                "p-2 gap-1",
                isPhone ? "flex flex-row overflow-x-auto" : "flex-1 overflow-y-auto flex-col",
              )}
              aria-label={t('logs.title')}
            >
              {visibleCategories.map((cat) => (
                <Fragment key={cat.id}>
                  <button
                    onClick={() => setLogsPage(cat.id)}
                    aria-current={logsPage === cat.id ? 'page' : undefined}
                    className={cn(
                      "flex items-center gap-2 px-3 py-2 rounded-lg text-sm text-left transition-[transform,color] duration-150 active:scale-[0.96]",
                      isPhone && "shrink-0",
                      logsPage === cat.id
                        ? "bg-interactive-selection text-interactive-selection-foreground"
                        : "text-muted-foreground hover:bg-interactive-hover hover:text-foreground",
                    )}
                  >
                    <Icon name={cat.icon} className="size-4 shrink-0" />
                    {t(cat.labelKey as Parameters<typeof t>[0])}
                  </button>
                </Fragment>
              ))}
            </nav>
          </div>

          {/* Right content */}
          <div className="flex-1 overflow-y-auto p-6 overscroll-contain">
            {logsPage === "core" && (
              <LogFilePanel
                logName="core"
                title={t('logs.core.title')}
                description={t('logs.core.description')}
              />
            )}
            {logsPage === "ui" && (
              <LogFilePanel
                logName="ui"
                title={t('logs.ui.title')}
                description={t('logs.ui.description')}
              />
            )}
            {logsPage === "backend" && (
              <LogFilePanel
                logName="backend"
                title={t('logs.backend.title')}
                description={t('logs.backend.description')}
              />
            )}
            {logsPage === "llm" && <LlmPayloadPanel />}
            {logsPage === "audit" && <AuditLogPanel />}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
