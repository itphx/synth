import { Dialog, DialogContent } from "../ui/dialog"
import { Icon } from "../icon/Icon"
import { useUIStore } from "../../stores/useUIStore"
import { useI18n } from "@/lib/i18n"
import { cn } from "@/lib/utils"
import { AppearanceSettings } from "./AppearanceSettings"
import { ProfileSettings } from "./ProfileSettings"
import { NotificationSettings } from "./NotificationSettings"
import { ChatSettings } from "./ChatSettings"
import { ProvidersPanel } from "../admin/ProvidersPanel"
import { ModelsPanel } from "../admin/ModelsPanel"
import { AgentsPanel } from "../admin/AgentsPanel"
import { McpSettings } from "./McpSettings"

const CATEGORIES = [
  { id: "profile", labelKey: "settings.category.profile" as const, icon: "user-smile" },
  { id: "appearance", labelKey: "settings.category.appearance" as const, icon: "palette" },
  { id: "notifications", labelKey: "settings.category.notifications" as const, icon: "alert" },
  { id: "chat", labelKey: "settings.category.chat" as const, icon: "chat-new" },
  { id: "providers", labelKey: "settings.category.providers" as const, icon: "server" },
  { id: "models", labelKey: "settings.category.models" as const, icon: "cpu" },
  { id: "agents", labelKey: "settings.category.agents" as const, icon: "robot-2" },
  { id: "mcp", labelKey: "settings.category.mcp" as const, icon: "tools" },
]

export const SettingsModal = () => {
  const { t } = useI18n()
  const { isSettingsDialogOpen, setSettingsDialogOpen, settingsPage, setSettingsPage } = useUIStore()

  return (
    <Dialog open={isSettingsDialogOpen} onOpenChange={setSettingsDialogOpen}>
      <DialogContent
        className="p-0 gap-0 max-w-5xl w-[95vw] h-[90vh] max-h-[90vh]"
        showCloseButton={false}
      >
        <div className="flex h-full overflow-hidden">
          {/* Left sidebar */}
          <div className="w-48 border-r border-border flex flex-col shrink-0">
            <div className="flex items-center gap-2 px-4 h-12 border-b border-border">
              <Icon name="settings" className="size-4 text-muted-foreground" />
              <span className="font-medium text-sm">{t('settings.title')}</span>
            </div>
            <nav className="flex-1 overflow-y-auto p-2">
              {CATEGORIES.map((cat) => (
                <button
                  key={cat.id}
                  onClick={() => setSettingsPage(cat.id)}
                  className={cn(
                    "w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm text-left transition-colors",
                    settingsPage === cat.id
                      ? "bg-interactive-selection text-interactive-selection-foreground"
                      : "text-muted-foreground hover:bg-interactive-hover hover:text-foreground"
                  )}
                >
                  <Icon name={cat.icon} className="size-4 shrink-0" />
                  {t(cat.labelKey)}
                </button>
              ))}
            </nav>
          </div>

          {/* Right content */}
          <div className="flex-1 overflow-y-auto p-6">
            {settingsPage === "profile" && <ProfileSettings />}
            {settingsPage === "appearance" && <AppearanceSettings />}
            {settingsPage === "notifications" && <NotificationSettings />}
            {settingsPage === "chat" && <ChatSettings />}
            {settingsPage === "providers" && <ProvidersPanel />}
            {settingsPage === "models" && <ModelsPanel />}
            {settingsPage === "agents" && <AgentsPanel />}
            {settingsPage === "mcp" && <McpSettings />}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}