import { useState } from 'react'
import { useUIStore, type ChatDensity, type ChatViewMode } from '@/stores/useUIStore'
import { useI18n } from '@/lib/i18n'
import { profileService } from '@/lib/api/profileService'
import { Icon } from '../icon/Icon'
import { cn } from '@/lib/utils'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover'
import { SegmentedControl, type SegmentedControlOption } from '../ui/settings'

interface ChatViewControlsProps {
  /** Десктоп — компактная иконка в блоке контекста; телефон — тач-таргет хедера. */
  variant?: 'desktop' | 'mobile'
}

/**
 * Быстрый переключатель вида и плотности ленты в шапке чата.
 *
 * Значения берутся из `useUIStore`, изменение применяется сразу (стор
 * персистит его сам), а в профиль уезжает best-effort — ошибки глушит
 * `profileService` (managed; в standalone профиля нет).
 */
export const ChatViewControls = ({ variant = 'desktop' }: ChatViewControlsProps) => {
  const { t } = useI18n()
  const [isOpen, setIsOpen] = useState(false)
  const chatViewMode = useUIStore((s) => s.chatViewMode)
  const setChatViewMode = useUIStore((s) => s.setChatViewMode)
  const chatDensity = useUIStore((s) => s.chatDensity)
  const setChatDensity = useUIStore((s) => s.setChatDensity)

  const title = t('header.chatView.title')

  // Подписи переиспользуют раздел «Настройки → Чат»: новых формулировок не плодим.
  const viewOptions: SegmentedControlOption<ChatViewMode>[] = [
    { value: 'detailed', label: t('chatSettings.viewModeDetailed') },
    { value: 'feed', label: t('chatSettings.viewModeFeed') },
  ]
  const densityOptions: SegmentedControlOption<ChatDensity>[] = [
    { value: 'normal', label: t('chatSettings.densityNormal') },
    { value: 'compact', label: t('chatSettings.densityCompact') },
  ]

  const handleViewModeChange = (mode: ChatViewMode) => {
    setChatViewMode(mode)
    void profileService.syncChatViewModeToProfile(mode)
  }

  const handleDensityChange = (density: ChatDensity) => {
    setChatDensity(density)
    void profileService.syncChatDensityToProfile(density)
  }

  return (
    <Popover open={isOpen} onOpenChange={setIsOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            'shrink-0 text-muted-foreground transition-colors hover:bg-interactive-hover hover:text-foreground',
            variant === 'mobile'
              // Тач-таргет ≥40px на грубом указателе (ADR-044).
              ? 'flex h-9 w-9 items-center justify-center rounded-lg pointer-coarse:size-10'
              : 'flex items-center justify-center rounded p-1',
          )}
          title={title}
          aria-label={title}
          aria-haspopup="dialog"
          data-testid="chat-view-controls"
        >
          <Icon name="layout-masonry" className={variant === 'mobile' ? 'h-5 w-5' : 'size-3.5'} />
        </button>
      </PopoverTrigger>

      {/* `collisionPadding` у PopoverContent + ограничение ширины: поповер не
          вылезает за экран на телефоне. */}
      <PopoverContent align="end" sideOffset={4} className="w-64 max-w-[calc(100vw-1rem)] p-2">
        <div className="space-y-2.5">
          <div className="space-y-1">
            <span className="text-[0.6875rem] font-medium text-muted-foreground">
              {t('chatSettings.viewMode')}
            </span>
            <SegmentedControl
              value={chatViewMode}
              options={viewOptions}
              onChange={handleViewModeChange}
              ariaLabel={t('chatSettings.viewMode')}
              className="w-full"
            />
          </div>
          <div className="space-y-1">
            <span className="text-[0.6875rem] font-medium text-muted-foreground">
              {t('chatSettings.density')}
            </span>
            <SegmentedControl
              value={chatDensity}
              options={densityOptions}
              onChange={handleDensityChange}
              ariaLabel={t('chatSettings.density')}
              className="w-full"
            />
          </div>
        </div>
      </PopoverContent>
    </Popover>
  )
}
