import { Icon } from '../icon/Icon'
import { usePwaInstall } from '../../hooks/usePwaInstall'

/**
 * Кнопка «Установить приложение» для PWA. Показывается только когда браузер
 * предлагает установку (см. usePwaInstall). Стиль — как у остальных кнопок шапки.
 */
export function PwaInstallButton() {
  const { canInstall, promptInstall } = usePwaInstall()

  if (!canInstall) return null

  return (
    <button
      onClick={() => void promptInstall()}
      className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-interactive-hover hover:text-foreground"
      title="Установить приложение"
      aria-label="Установить приложение"
    >
      <Icon name="download" className="h-5 w-5" />
    </button>
  )
}
