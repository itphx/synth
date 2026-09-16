import { Fragment } from "react"
import { Dialog, DialogClose, DialogContent } from "../ui/dialog"
import { Icon } from "../icon/Icon"
import { useUIStore } from "../../stores/useUIStore"
import { useAuthStore } from "@/stores/authStore"
import { useI18n } from "@/lib/i18n"
import { cn } from "@/lib/utils"
import { useDevice } from "@/hooks/useDevice"
import { AppearanceSettings } from "./AppearanceSettings"
import { ProfileSettings } from "./ProfileSettings"
import { NotificationSettings } from "./NotificationSettings"
import { ChatSettings } from "./ChatSettings"
import { RoutingSettings } from "./RoutingSettings"
import { MicroFirstDefaults } from "./MicroFirstDefaults"
import { SecuritySettings } from "./SecuritySettings"
import { McpSettings } from "./McpSettings"
import { DashboardPanel } from "../admin/DashboardPanel"
import { SessionsPanel } from "../admin/SessionsPanel"
import { ProjectsPanel } from "../admin/ProjectsPanel"
import { ProvidersPanel } from "../admin/ProvidersPanel"
import { ModelsPanel } from "../admin/ModelsPanel"
import { AgentsPanel } from "../admin/AgentsPanel"
import { ContextPanel } from "../admin/ContextPanel"
import { UsersPanel } from "../admin/UsersPanel"
import { DefaultsPanel } from "../admin/DefaultsPanel"
import { DebugPanel } from "../admin/DebugPanel"

interface CategoryItem {
  id: string
  labelKey: string
  icon: string
  roles?: string[]
}

const CATEGORIES: CategoryItem[] = [
  { id: "profile", labelKey: "settings.category.profile", icon: "user-smile" },
  { id: "appearance", labelKey: "settings.category.appearance", icon: "palette" },
  { id: "notifications", labelKey: "settings.category.notifications", icon: "alert" },
  { id: "chat", labelKey: "settings.category.chat", icon: "chat-new" },
  { id: "microFirst", labelKey: "settings.category.microFirst", icon: "cpu" },
  { id: "mcp", labelKey: "settings.category.mcp", icon: "tools" },
  // Admin sections below
  { id: "dashboard", labelKey: "settings.category.dashboard", icon: "home", roles: ["ADMIN", "LEAD"] },
  { id: "security", labelKey: "settings.category.security", icon: "shield-keyhole", roles: ["ADMIN"] },
  { id: "sessions", labelKey: "settings.category.sessions", icon: "chat-new", roles: ["ADMIN", "LEAD"] },
  { id: "projects", labelKey: "settings.category.projects", icon: "briefcase", roles: ["ADMIN", "LEAD"] },
  { id: "providers", labelKey: "settings.category.providers", icon: "server", roles: ["ADMIN"] },
  { id: "models", labelKey: "settings.category.models", icon: "cpu", roles: ["ADMIN"] },
  { id: "agents", labelKey: "settings.category.agents", icon: "robot-2", roles: ["ADMIN"] },
  { id: "routing", labelKey: "settings.category.routing", icon: "git-branch", roles: ["ADMIN"] },
  { id: "context", labelKey: "settings.category.context", icon: "book-open", roles: ["ADMIN"] },
  { id: "users", labelKey: "settings.category.users", icon: "user-smile", roles: ["ADMIN"] },
  { id: "defaults", labelKey: "settings.category.defaults", icon: "settings-3", roles: ["ADMIN"] },
  { id: "debug", labelKey: "settings.category.debug", icon: "bug", roles: ["ADMIN"] },
]

export const SettingsModal = () => {
  const { t } = useI18n()
  const { user } = useAuthStore()
  const { isSettingsDialogOpen, setSettingsDialogOpen, settingsPage, setSettingsPage } = useUIStore()
  const { deviceType } = useDevice()
  const isPhone = deviceType === 'phone'

  const userRoles = user?.roles ?? []

  const visibleCategories = CATEGORIES.filter(
    (cat) => !cat.roles || cat.roles.some((r) => userRoles.includes(r))
  )

  const adminBoundaryIndex = visibleCategories.findIndex((c) => c.roles !== undefined)

  return (
    <Dialog open={isSettingsDialogOpen} onOpenChange={setSettingsDialogOpen}>
      <DialogContent
        className="p-0 gap-0 max-w-5xl w-[95vw] h-[90vh] max-h-[90vh] md:max-h-[85vh] shadow-xl"
        showCloseButton={false}
      >
        <div className={cn("flex h-full overflow-hidden overscroll-behavior-contain", isPhone ? "flex-col" : "md:flex-row")}>
          {/* Left sidebar (desktop) / mobile horizontal menu tabs */}
          <div className={cn("flex flex-col shrink-0", !isPhone && "w-48 md:w-52 border-r border-border")}>
            <div className="flex items-center gap-2 px-4 h-12 border-b border-border">
              <Icon name="settings" className="size-4 text-muted-foreground" />
              <span className="font-medium text-sm">{t('settings.title')}</span>
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
              aria-label={t('settings.title')}
            >
              {visibleCategories.map((cat, idx) => (
                <Fragment key={cat.id}>
                  {idx === adminBoundaryIndex && (
                    <hr className="my-2 border-border hidden md:block" />
                  )}
                  <button
                    onClick={() => setSettingsPage(cat.id)}
                    aria-current={settingsPage === cat.id ? 'page' : undefined}
                    className={cn(
                      "flex items-center gap-2 px-3 py-2 rounded-lg text-sm text-left transition-[transform,color] duration-150 active:scale-[0.96]",
                      isPhone && "shrink-0",
                      settingsPage === cat.id
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
          <div className="flex-1 overflow-y-auto p-6 overscroll-behavior-contain">
            {settingsPage === "profile" && <ProfileSettings />}
            {settingsPage === "appearance" && <AppearanceSettings />}
            {settingsPage === "notifications" && <NotificationSettings />}
            {settingsPage === "chat" && <ChatSettings />}
            {settingsPage === "routing" && <RoutingSettings />}
            {settingsPage === "microFirst" && <MicroFirstDefaults />}
            {settingsPage === "mcp" && <McpSettings />}
            {settingsPage === "security" && <SecuritySettings />}
            {settingsPage === "dashboard" && <DashboardPanel />}
            {settingsPage === "sessions" && <SessionsPanel />}
            {settingsPage === "projects" && <ProjectsPanel />}
            {settingsPage === "providers" && <ProvidersPanel />}
            {settingsPage === "models" && <ModelsPanel />}
            {settingsPage === "agents" && <AgentsPanel />}
            {settingsPage === "context" && <ContextPanel />}
            {settingsPage === "users" && <UsersPanel />}
            {settingsPage === "defaults" && <DefaultsPanel />}
            {settingsPage === "debug" && <DebugPanel />}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
