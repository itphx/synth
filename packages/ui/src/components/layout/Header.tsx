import { Icon } from '../icon/Icon'
import { useUIStore } from '../../stores/useUIStore'
import { useI18n } from '@/lib/i18n'
import { QuickSettingsPopup } from '../auth/QuickSettingsPopup'
import { NotificationPopup } from './NotificationPopup'

interface HeaderProps {
  onSettingsClick: () => void
}

export const Header = ({ onSettingsClick }: HeaderProps) => {
  const { t } = useI18n()
  const { leftPanel, rightPanel, toggleLeftPanel, toggleRightPanel, setSettingsDialogOpen } = useUIStore()

  return (
    <header className="flex h-9 items-center justify-between px-3 bg-background">
      <div className="flex items-center gap-3">
        {!leftPanel.isOpen && (
          <button
            onClick={toggleLeftPanel}
            className="rounded-lg p-2 text-muted-foreground transition-colors hover:bg-interactive-hover hover:text-foreground"
            title={t('header.showLeftPanel')}
          >
            <Icon name="layout-left" className="h-5 w-5" />
          </button>
        )}
        <span className="font-semibold text-foreground">Synth</span>
      </div>

      <div className="flex items-center gap-2">
        <NotificationPopup />
        <QuickSettingsPopup onSettingsClick={onSettingsClick} />

        <button
          onClick={() => setSettingsDialogOpen(true)}
          className="rounded-lg p-2 text-muted-foreground transition-colors hover:bg-interactive-hover hover:text-foreground"
          title={t('header.settings')}
        >
          <Icon name="settings-3" className="h-5 w-5" />
        </button>

        {!rightPanel.isOpen && (
          <button
            onClick={toggleRightPanel}
            className="rounded-lg p-2 text-muted-foreground transition-colors hover:bg-interactive-hover hover:text-foreground"
            title={t('header.showRightPanel')}
          >
            <Icon name="layout-right" className="h-5 w-5" />
          </button>
        )}
      </div>
    </header>
  )
}