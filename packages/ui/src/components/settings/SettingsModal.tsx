import { Fragment, useEffect, useRef } from "react"
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
import { SecuritySettings } from "./SecuritySettings"
import { McpUserSettings } from "./McpUserSettings"
import { McpAdminSettings } from "./McpAdminSettings"
import { ToolsDisabledSettings } from "./ToolsDisabledSettings"
import { SkillsUserSettings } from "./SkillsUserSettings"
import { SkillsAdminSettings } from "./SkillsAdminSettings"
import { CommandsSettings } from "./CommandsSettings"
import { EventsAdminSettings } from "./EventsAdminSettings"
import { EventsSettings } from "./EventsSettings"
import { DecisionSettings } from "./DecisionSettings"
import { ServiceKeysSettings } from "./ServiceKeysSettings"
import { WebhooksSettings } from "./WebhooksSettings"
import { MaintenanceSettings } from "./MaintenanceSettings"
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

export const CATEGORIES: CategoryItem[] = [
  { id: "profile", labelKey: "settings.category.profile", icon: "user-smile" },
  { id: "appearance", labelKey: "settings.category.appearance", icon: "palette" },
  { id: "notifications", labelKey: "settings.category.notifications", icon: "alert" },
  { id: "chat", labelKey: "settings.category.chat", icon: "chat-new" },
  { id: "mcp", labelKey: "settings.category.mcp", icon: "tools" },
  { id: "skills", labelKey: "settings.category.skills", icon: "book-open" },
  { id: "eventsAdmin", labelKey: "settings.category.events", icon: "send-plane" },
  // Admin sections below
  { id: "dashboard", labelKey: "settings.category.dashboard", icon: "home", roles: ["ADMIN", "LEAD"] },
  { id: "security", labelKey: "settings.category.security", icon: "shield-keyhole", roles: ["ADMIN"] },
  { id: "mcpAdmin", labelKey: "settings.category.mcpAdmin", icon: "tools", roles: ["ADMIN"] },
  { id: "builtinTools", labelKey: "settings.category.builtinTools", icon: "terminal-box", roles: ["ADMIN"] },
  { id: "skillsAdmin", labelKey: "settings.category.skillsAdmin", icon: "book-open", roles: ["ADMIN"] },
  { id: "commands", labelKey: "settings.category.commands", icon: "terminal-box", roles: ["ADMIN"] },
  { id: "eventsConfig", labelKey: "settings.category.eventsConfig", icon: "settings-3", roles: ["ADMIN"] },
  { id: "decisionConfig", labelKey: "settings.category.decision", icon: "brain", roles: ["ADMIN"] },
  { id: "serviceKeys", labelKey: "settings.category.serviceKeys", icon: "key", roles: ["ADMIN"] },
  { id: "webhooks", labelKey: "settings.category.webhooks", icon: "send-plane", roles: ["ADMIN"] },
  { id: "maintenance", labelKey: "settings.category.maintenance", icon: "database-2", roles: ["ADMIN"] },
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

/**
 * Видимая активная категория. Если сохранённый `settingsPage` больше не доступен
 * роли (например, смена пользователя в одной SPA-сессии без перезагрузки),
 * показываем первую доступную категорию — содержимое скрытого ADMIN-раздела
 * рендериться не должно.
 */
export function resolveActiveSettingsPage(
  visibleCategories: CategoryItem[],
  settingsPage: string,
): string {
  if (visibleCategories.some((cat) => cat.id === settingsPage)) return settingsPage
  return visibleCategories[0]?.id ?? settingsPage
}

export const SettingsModal = () => {
  const { t } = useI18n()
  const user = useAuthStore(s => s.user)
  const isSettingsDialogOpen = useUIStore(s => s.isSettingsDialogOpen)
  const setSettingsDialogOpen = useUIStore(s => s.setSettingsDialogOpen)
  const settingsPage = useUIStore(s => s.settingsPage)
  const setSettingsPage = useUIStore(s => s.setSettingsPage)
  const { deviceType } = useDevice()
  const isPhone = deviceType === 'phone'

  const userRoles = user?.roles ?? []

  const visibleCategories = CATEGORIES.filter(
    (cat) => !cat.roles || cat.roles.some((r) => userRoles.includes(r))
  )

  const adminBoundaryIndex = visibleCategories.findIndex((c) => c.roles !== undefined)

  // Содержимое и подсветка навигации идут по доступной роли категории, а не по
  // «залипшему» `settingsPage` (см. `resolveActiveSettingsPage`).
  const activePage = resolveActiveSettingsPage(visibleCategories, settingsPage)

  const navRef = useRef<HTMLElement>(null)
  const activeRef = useRef<HTMLButtonElement>(null)

  // На телефоне меню категорий — горизонтальная скролл-полоса.
  // Прокручиваем её так, чтобы активная вкладка была видна (без scrollIntoView,
  // который может спровоцировать вертикальный скролл страницы).
  useEffect(() => {
    if (!isPhone) return
    const align = () => {
      const nav = navRef.current
      const btn = activeRef.current
      if (!nav || !btn) return
      const navRect = nav.getBoundingClientRect()
      const btnRect = btn.getBoundingClientRect()
      const PAD = 8
      const delta = btnRect.left - navRect.left - PAD
      const max = Math.max(0, nav.scrollWidth - nav.clientWidth)
      nav.scrollLeft = Math.min(Math.max(nav.scrollLeft + delta, 0), max)
    }
    const raf = requestAnimationFrame(align)
    // Второй проход после анимации входа DialogContent (~150ms): замер во время
    // анимации оставлял смещение активной вкладки ~13px от левого края.
    const timeout = window.setTimeout(align, 200)
    return () => {
      cancelAnimationFrame(raf)
      window.clearTimeout(timeout)
    }
  }, [activePage, isPhone, isSettingsDialogOpen])

  return (
    <Dialog open={isSettingsDialogOpen} onOpenChange={setSettingsDialogOpen}>
      <DialogContent
        className="p-0 gap-0 max-w-5xl w-[95vw] h-[90vh] max-h-[90vh] md:max-h-[85vh] shadow-xl"
        showCloseButton={false}
      >
        <div className={cn("flex h-full overflow-hidden overscroll-contain", isPhone ? "flex-col" : "md:flex-row")}>
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
              ref={navRef}
              className={cn(
                "p-2 gap-1",
                isPhone ? "flex flex-row overflow-x-auto" : "flex flex-1 flex-col overflow-y-auto",
              )}
              aria-label={t('settings.title')}
            >
              {visibleCategories.map((cat, idx) => (
                <Fragment key={cat.id}>
                  {idx === adminBoundaryIndex && (
                    <hr className="my-2 border-border hidden md:block" />
                  )}
                  <button
                    ref={activePage === cat.id ? activeRef : undefined}
                    onClick={() => setSettingsPage(cat.id)}
                    aria-current={activePage === cat.id ? 'page' : undefined}
                    className={cn(
                      "flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm text-left transition-[transform,color] duration-150 active:scale-[0.96] shrink-0",
                      activePage === cat.id
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
            {activePage === "profile" && <ProfileSettings />}
            {activePage === "appearance" && <AppearanceSettings />}
            {activePage === "notifications" && <NotificationSettings />}
            {activePage === "chat" && <ChatSettings />}
            {activePage === "routing" && <RoutingSettings />}
            {activePage === "mcp" && <McpUserSettings />}
            {activePage === "mcpAdmin" && <McpAdminSettings />}
            {activePage === "builtinTools" && <ToolsDisabledSettings />}
            {activePage === "skills" && <SkillsUserSettings />}
            {activePage === "skillsAdmin" && <SkillsAdminSettings />}
            {activePage === "commands" && <CommandsSettings />}
            {activePage === "eventsAdmin" && <EventsAdminSettings />}
            {activePage === "eventsConfig" && <EventsSettings />}
            {activePage === "decisionConfig" && <DecisionSettings />}
            {activePage === "serviceKeys" && <ServiceKeysSettings />}
            {activePage === "webhooks" && <WebhooksSettings />}
            {activePage === "maintenance" && <MaintenanceSettings />}
            {activePage === "security" && <SecuritySettings />}
            {activePage === "dashboard" && <DashboardPanel />}
            {activePage === "sessions" && <SessionsPanel />}
            {activePage === "projects" && <ProjectsPanel />}
            {activePage === "providers" && <ProvidersPanel />}
            {activePage === "models" && <ModelsPanel />}
            {activePage === "agents" && <AgentsPanel />}
            {activePage === "context" && <ContextPanel />}
            {activePage === "users" && <UsersPanel />}
            {activePage === "defaults" && <DefaultsPanel />}
            {activePage === "debug" && <DebugPanel />}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
