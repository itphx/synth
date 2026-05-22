import { Dialog, DialogContent } from "../ui/dialog"
import { Icon } from "../icon/Icon"
import { useUIStore } from "../../stores/useUIStore"
import { cn } from "@/lib/utils"
import { useI18n } from "@/lib/i18n"
import { DashboardPanel } from "./DashboardPanel"
import { SessionsPanel } from "./SessionsPanel"
import { ProjectsPanel } from "./ProjectsPanel"
import { ProvidersPanel } from "./ProvidersPanel"
import { ModelsPanel } from "./ModelsPanel"
import { AgentsPanel } from "./AgentsPanel"
import { ContextPanel } from "./ContextPanel"
import { UsersPanel } from "./UsersPanel"
import { DefaultsPanel } from "./DefaultsPanel"
import { DebugPanel } from "./DebugPanel"

const SECTIONS = [
  { id: "dashboard", label: "admin.section.dashboard", icon: "home" },
  { id: "sessions", label: "admin.section.sessions", icon: "chat-new" },
  { id: "projects", label: "admin.section.projects", icon: "briefcase" },
  { id: "providers", label: "admin.section.providers", icon: "server" },
  { id: "models", label: "admin.section.models", icon: "cpu" },
  { id: "agents", label: "admin.section.agents", icon: "robot-2" },
  { id: "context", label: "admin.section.context", icon: "book-open" },
  { id: "users", label: "admin.section.users", icon: "user-smile" },
  { id: "defaults", label: "admin.section.defaults", icon: "settings-3" },
  { id: "debug", label: "admin.section.debug", icon: "bug" },
] as const

export const AdminModal = () => {
  const { t } = useI18n()
  const { isAdminSettingsOpen, setAdminSettingsOpen, adminPage, setAdminPage } = useUIStore()

  return (
    <Dialog open={isAdminSettingsOpen} onOpenChange={setAdminSettingsOpen}>
      <DialogContent
        className="p-0 gap-0 max-w-5xl w-[95vw] h-[90vh] max-h-[90vh]"
        showCloseButton={false}
      >
        <div className="flex h-full overflow-hidden">
          {/* Left sidebar */}
          <div className="w-56 border-r border-border flex flex-col shrink-0">
            <div className="flex items-center gap-2 px-4 h-12 border-b border-border">
              <Icon name="admin" className="size-4 text-muted-foreground" />
              <span className="font-medium text-sm">{t('admin.title')}</span>
            </div>
            <nav className="flex-1 overflow-y-auto p-2 space-y-0.5">
              {SECTIONS.map((s) => (
                <button
                  key={s.id}
                  onClick={() => setAdminPage(s.id)}
                  className={cn(
                    "w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm text-left transition-colors",
                    adminPage === s.id
                      ? "bg-interactive-selection text-interactive-selection-foreground"
                      : "text-muted-foreground hover:bg-interactive-hover hover:text-foreground"
                  )}
                >
                  <Icon name={s.icon} className="size-4 shrink-0" />
                  {t(s.label as Parameters<typeof t>[0])}
                </button>
              ))}
            </nav>
          </div>

          {/* Right content */}
          <div className="flex-1 overflow-y-auto">
            <div className="flex items-center justify-between px-6 h-12 border-b border-border shrink-0 bg-background">
              <h2 className="font-medium text-sm">
                {SECTIONS.find((s) => s.id === adminPage) ? t(SECTIONS.find((s) => s.id === adminPage)!.label as Parameters<typeof t>[0]) : t('admin.title')}
              </h2>
              <button
                onClick={() => setAdminSettingsOpen(false)}
                className="rounded-md p-1.5 text-muted-foreground hover:bg-interactive-hover hover:text-foreground"
              >
                <Icon name="close" className="size-4" />
              </button>
            </div>
            <div className="p-6">
              {adminPage === "dashboard" && <DashboardPanel />}
              {adminPage === "sessions" && <SessionsPanel />}
              {adminPage === "projects" && <ProjectsPanel />}
              {adminPage === "providers" && <ProvidersPanel />}
              {adminPage === "models" && <ModelsPanel />}
              {adminPage === "agents" && <AgentsPanel />}
              {adminPage === "context" && <ContextPanel />}
              {adminPage === "users" && <UsersPanel />}
              {adminPage === "defaults" && <DefaultsPanel />}
              {adminPage === "debug" && <DebugPanel />}
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
