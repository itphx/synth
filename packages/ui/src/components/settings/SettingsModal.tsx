import { Fragment, useEffect, useRef, useState } from "react"
import { Dialog, DialogClose, DialogContent } from "../ui/dialog"
import { Button } from "../ui/button"
import { Icon } from "../icon/Icon"
import { useUIStore } from "../../stores/useUIStore"
import { useAuthStore } from "@/stores/authStore"
import { useI18n } from "@/lib/i18n"
import { cn } from "@/lib/utils"
import { useDevice } from "@/hooks/useDevice"
import {
  SETTINGS_CATEGORIES,
  SETTINGS_GROUPS,
  searchSettings,
  type SettingsCategoryMeta,
} from "@/lib/settings-catalog"
import { AppearanceSettings } from "./AppearanceSettings"
import { ProfileSettings } from "./ProfileSettings"
import { NotificationSettings } from "./NotificationSettings"
import { ChatSettings } from "./ChatSettings"
import { RoutingSettings } from "./RoutingSettings"
import { SecuritySettings } from "./SecuritySettings"
import { NetworkSettings } from "./NetworkSettings"
import { McpUserSettings } from "./McpUserSettings"
import { McpAdminSettings } from "./McpAdminSettings"
import { ToolsDisabledSettings } from "./ToolsDisabledSettings"
import { SkillsUserSettings } from "./SkillsUserSettings"
import { SkillsAdminSettings } from "./SkillsAdminSettings"
import { CommandsSettings } from "./CommandsSettings"
import { EventsAdminSettings } from "./EventsAdminSettings"
import { EventsSettings } from "./EventsSettings"
import { AuthoritySettings } from "./AuthoritySettings"
import { DecisionSettings } from "./DecisionSettings"
import { ServiceKeysSettings } from "./ServiceKeysSettings"
import { WebhooksSettings } from "./WebhooksSettings"
import { CredentialsSettings } from "./CredentialsSettings"
import { AddonsSettings } from "./AddonsSettings"
import { PluginsSettings } from "./PluginsSettings"
import { MaintenanceSettings } from "./MaintenanceSettings"
import { ObservabilitySettings } from "./ObservabilitySettings"
import { MemorySettings } from "./MemorySettings"
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

/**
 * Обратная совместимость для существующих тестов/импортов: источник истины —
 * `SETTINGS_CATEGORIES` (`lib/settings-catalog.ts`).
 */
export const CATEGORIES: SettingsCategoryMeta[] = SETTINGS_CATEGORIES

const CATEGORY_BY_ID = new Map(SETTINGS_CATEGORIES.map((category) => [category.id, category]))

/**
 * Видимая активная категория. Если сохранённый `settingsPage` больше не доступен
 * роли или скрыт режимом «Расширенные» (например, смена пользователя в одной
 * SPA-сессии без перезагрузки), показываем первую доступную категорию —
 * содержимое скрытого раздела рендериться не должно.
 */
export function resolveActiveSettingsPage(
  visibleCategories: Array<{ id: string }>,
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
  const settingsShowAdvanced = useUIStore(s => s.settingsShowAdvanced)
  const setSettingsShowAdvanced = useUIStore(s => s.setSettingsShowAdvanced)
  const focusSettings = useUIStore(s => s.focusSettings)
  const { deviceType } = useDevice()
  const isPhone = deviceType === 'phone'

  const [query, setQuery] = useState('')
  const hasQuery = query.trim().length > 0

  const userRoles = user?.roles ?? []

  // Продвинутые категории скрыты, пока не включён режим «Расширенные»; роли —
  // как раньше: пользователь без роли категорию не видит.
  const roleCategories = SETTINGS_CATEGORIES.filter(
    (cat) => !cat.roles || cat.roles.some((r) => userRoles.includes(r)),
  )
  const visibleCategories = roleCategories.filter((cat) => settingsShowAdvanced || !cat.advanced)

  // Содержимое и подсветка навигации идут по доступной роли категории, а не по
  // «залипшему» `settingsPage` (см. `resolveActiveSettingsPage`).
  const activePage = resolveActiveSettingsPage(visibleCategories, settingsPage)

  // Поиск идёт по всем категориям, доступным роли: скрытые advanced-разделы
  // должны находиться, даже когда тумблер «Расширенные» выключен.
  const roleCategoryIds = new Set(roleCategories.map((cat) => cat.id))
  const searchResult = hasQuery ? searchSettings(t, query) : { categories: [], entries: [] }
  const resultCategories = searchResult.categories.filter((cat) => roleCategoryIds.has(cat.id))
  const resultEntries = searchResult.entries.filter((entry) => roleCategoryIds.has(entry.categoryId))

  const navRef = useRef<HTMLElement>(null)
  const activeRef = useRef<HTMLButtonElement>(null)

  // Закрытие диалога сбрасывает поисковый запрос, чтобы следующее открытие
  // начиналось с обычного сгруппированного списка.
  useEffect(() => {
    if (!isSettingsDialogOpen) setQuery('')
  }, [isSettingsDialogOpen])

  // На телефоне меню категорий — горизонтальная скролл-полоса.
  // Прокручиваем её так, чтобы активная вкладка была видна (без scrollIntoView,
  // который может спровоцировать вертикальный скролл страницы).
  useEffect(() => {
    if (!isPhone || hasQuery) return
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
  }, [activePage, isPhone, isSettingsDialogOpen, hasQuery])

  const openCategory = (categoryId: string) => {
    // Осознанный выбор скрытого раздела из поиска включает режим «Расширенные»,
    // иначе содержимое advanced-категории не отобразится.
    if (CATEGORY_BY_ID.get(categoryId)?.advanced) setSettingsShowAdvanced(true)
    setSettingsPage(categoryId)
    setQuery('')
  }

  const openEntry = (entry: (typeof resultEntries)[number]) => {
    if (CATEGORY_BY_ID.get(entry.categoryId)?.advanced) setSettingsShowAdvanced(true)
    setSettingsPage(entry.categoryId)
    focusSettings({ categoryId: entry.categoryId, sectionId: entry.sectionId })
    setQuery('')
  }

  return (
    <Dialog open={isSettingsDialogOpen} onOpenChange={setSettingsDialogOpen}>
      <DialogContent
        className="p-0 gap-0 max-w-5xl w-[95vw] h-[90vh] max-h-[90vh] md:max-h-[85vh] shadow-xl"
        showCloseButton={false}
      >
        <div className={cn("flex h-full overflow-hidden overscroll-contain", isPhone ? "flex-col" : "md:flex-row")}>
          {/* Left sidebar (desktop) / mobile horizontal menu tabs */}
          <div className={cn("flex flex-col shrink-0", !isPhone && "w-56 md:w-60 border-r border-border")}>
            <div className="flex items-center gap-2 px-4 h-12 border-b border-border">
              <Icon name="settings" className="size-4 text-muted-foreground" />
              <span className="font-medium text-sm">{t('settings.title')}</span>
              <div className="ml-auto">
                <DialogClose
                  className="inline-flex size-[var(--control-height)] items-center justify-center rounded-lg opacity-70 transition-opacity hover:opacity-100 hover:bg-interactive-hover text-muted-foreground hover:text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                  aria-label={t('common.close')}
                >
                  <Icon name="close" className="size-4" />
                </DialogClose>
              </div>
            </div>

            {/* Режим «Расширенные» и поиск — над списком (на телефоне над вкладками). */}
            <div className="px-2 pt-2 pb-2 space-y-2">
              <Button
                variant={settingsShowAdvanced ? 'outline-primary' : 'ghost'}
                size="sm"
                className="w-full justify-start"
                aria-pressed={settingsShowAdvanced}
                aria-label={t('settings.advanced.toggle')}
                onClick={() => setSettingsShowAdvanced(!settingsShowAdvanced)}
                data-testid="settings-advanced-toggle"
              >
                <Icon name="settings-3" className="size-4" />
                {t('settings.advanced.toggle')}
              </Button>
              <div className="relative">
                <Icon
                  name="search"
                  className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
                />
                <input
                  type="search"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Escape') setQuery('')
                  }}
                  placeholder={t('settings.search.placeholder')}
                  aria-label={t('settings.search.placeholder')}
                  data-testid="settings-search-input"
                  className="h-[var(--control-height)] w-full rounded-lg border border-input bg-background pl-8 pr-2 text-sm text-foreground placeholder:text-muted-foreground outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
                />
              </div>
            </div>

            <nav
              ref={navRef}
              className={cn(
                "p-2 gap-1",
                isPhone
                  ? hasQuery
                    ? "flex flex-col overflow-y-auto max-h-[45vh]"
                    : "flex flex-row overflow-x-auto"
                  : "flex flex-1 flex-col overflow-y-auto",
              )}
              aria-label={t('settings.title')}
            >
              {hasQuery ? (
                <div className="space-y-1 min-w-0" data-testid="settings-search-results">
                  {resultCategories.map((cat) => (
                    <button
                      key={`category-${cat.id}`}
                      onClick={() => openCategory(cat.id)}
                      data-testid={`settings-search-category-${cat.id}`}
                      className={cn(
                        "flex w-full h-[var(--control-height)] items-center gap-2 px-3 rounded-lg text-sm text-left transition-[transform,color] duration-150 active:scale-[0.96] shrink-0",
                        activePage === cat.id
                          ? "bg-interactive-selection text-interactive-selection-foreground"
                          : "text-muted-foreground hover:bg-interactive-hover hover:text-foreground",
                      )}
                    >
                      <Icon name={cat.icon} className="size-4 shrink-0" />
                      <span className="min-w-0 truncate">{t(cat.labelKey)}</span>
                    </button>
                  ))}
                  {resultEntries.map((entry) => {
                    const category = CATEGORY_BY_ID.get(entry.categoryId)
                    return (
                      <button
                        key={`entry-${entry.id}`}
                        onClick={() => openEntry(entry)}
                        data-testid={`settings-search-entry-${entry.id}`}
                        className="flex w-full items-start gap-2 px-3 py-2 rounded-lg text-sm text-left text-muted-foreground transition-[transform,color] duration-150 hover:bg-interactive-hover hover:text-foreground active:scale-[0.96] min-w-0"
                      >
                        <Icon name={category?.icon ?? 'settings'} className="size-4 shrink-0 mt-0.5" />
                        <span className="min-w-0">
                          <span className="block truncate">{t(entry.labelKey)}</span>
                          <span className="block truncate text-[0.6875rem] text-muted-foreground">
                            {t('settings.search.categoryHint')}:{' '}
                            {category ? t(category.labelKey) : entry.categoryId}
                          </span>
                        </span>
                      </button>
                    )
                  })}
                  {resultCategories.length === 0 && resultEntries.length === 0 && (
                    <p className="px-3 py-4 text-sm text-muted-foreground">
                      {t('settings.search.empty')}
                    </p>
                  )}
                </div>
              ) : (
                SETTINGS_GROUPS.map((group) => {
                  const categories = visibleCategories.filter((cat) => cat.group === group.id)
                  if (categories.length === 0) return null
                  return (
                    <Fragment key={group.id}>
                      {!isPhone && group.id !== 'personal' && (
                        <>
                          {group.id === 'adminOverview' && (
                            <hr className="my-2 border-border" />
                          )}
                          <div className="px-3 pt-1 pb-0.5 text-[0.6875rem] font-medium uppercase tracking-wide text-muted-foreground">
                            {t(group.labelKey)}
                          </div>
                        </>
                      )}
                      {categories.map((cat) => (
                        <button
                          key={cat.id}
                          ref={activePage === cat.id ? activeRef : undefined}
                          onClick={() => openCategory(cat.id)}
                          title={t(cat.labelKey)}
                          aria-current={activePage === cat.id ? 'page' : undefined}
                          className={cn(
                            "flex h-[var(--control-height)] items-center gap-2 px-3 rounded-lg text-sm text-left transition-[transform,color] duration-150 active:scale-[0.96] shrink-0",
                            activePage === cat.id
                              ? "bg-interactive-selection text-interactive-selection-foreground"
                              : "text-muted-foreground hover:bg-interactive-hover hover:text-foreground",
                          )}
                        >
                          <Icon name={cat.icon} className="size-4 shrink-0" />
                          <span className="min-w-0 truncate">{t(cat.labelKey)}</span>
                        </button>
                      ))}
                    </Fragment>
                  )
                })
              )}
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
            {activePage === "authority" && <AuthoritySettings />}
            {activePage === "credentials" && <CredentialsSettings />}
            {activePage === "eventsConfig" && <EventsSettings />}
            {activePage === "decisionConfig" && <DecisionSettings />}
            {activePage === "serviceKeys" && <ServiceKeysSettings />}
            {activePage === "webhooks" && <WebhooksSettings />}
            {activePage === "addons" && <AddonsSettings />}
            {activePage === "plugins" && <PluginsSettings />}
            {activePage === "maintenance" && <MaintenanceSettings />}
            {activePage === "metrics" && <ObservabilitySettings />}
            {activePage === "memory" && <MemorySettings />}
            {activePage === "security" && <SecuritySettings />}
            {activePage === "network" && <NetworkSettings />}
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
