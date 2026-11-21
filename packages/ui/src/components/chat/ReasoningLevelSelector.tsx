import { useCallback, useRef, useState } from 'react'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import type { ReasoningLevel } from '@itphx/synth-shared'
import { useProvidersStore } from '@/stores/providersStore'
import { useSessionsStore } from '@/stores/sessionsStore'
import { useI18n } from '@/lib/i18n'
import { useDevice } from '@/hooks/useDevice'
import { useUIStore } from '@/stores/useUIStore'
import { synthApi } from '@/lib/api/synthApi'
import { Icon } from '../icon/Icon'
import {
  MobileMenuSheet,
  sheetTriggerHandlers,
  sheetTriggerOpenProps,
  useTriggerGap,
} from '../ui/MobileMenuSheet'

/** Доступные уровни размышлений по типу провайдера (Default — всегда первый). */
const REASONING_LEVELS_BY_PROVIDER_TYPE: Record<string, ReasoningLevel[]> = {
  openai: ['default', 'none', 'low', 'medium', 'high'],
  generic: ['default', 'none', 'low', 'medium', 'high'],
  anthropic: ['default', 'none', 'high'],
  ollama: ['default', 'none', 'low'],
}

/**
 * Классы пункта списка уровней. Общие для поппера (десктоп) и мобильного листа:
 * пункт Radix вне своего `Root` не рендерится, поэтому в листе это кнопка.
 */
const LEVEL_ITEM_CLASS =
  'text-xs flex items-center gap-2 px-2 py-1.5 rounded-lg cursor-pointer hover:bg-interactive-hover data-[highlighted]:bg-interactive-selection outline-none w-full text-left'

export function ReasoningLevelSelector({ sessionId }: { sessionId: string }) {
  const { t } = useI18n()
  const { deviceType } = useDevice()
  const centralNarrow = useUIStore((s) => s.centralNarrow)
  const isMobile = deviceType !== 'desktop' || centralNarrow
  const [open, setOpen] = useState(false)
  const providers = useProvidersStore((s) => s.providers)
  const selectedProviderName = useProvidersStore((s) => s.selectedProviderName)
  const session = useSessionsStore((s) => s.sessions.find((x) => x.id === sessionId))
  /**
   * Рамка кнопки — якорь мобильного листа: панель встаёт над **рамкой**, а не над
   * внутренней кнопкой (она ниже на толщину рамки и паддинга).
   */
  const frameRef = useRef<HTMLDivElement | null>(null)
  /**
   * `sideOffset` десктопного поппера = зазор под кнопкой (замер при открытии):
   * интервал над кнопкой равен интервалу под ней, как в мобильном листе. Якорь —
   * та же рамка кнопки, что и у листа (мобильной ветке зазор не нужен: его
   * считает лист, поэтому `open && !isMobile`).
   */
  const triggerGap = useTriggerGap(open && !isMobile, frameRef)

  const currentProvider = providers.find((p) => p.name === selectedProviderName)
  const availableLevels = REASONING_LEVELS_BY_PROVIDER_TYPE[currentProvider?.type ?? ''] ?? ['default', 'none']
  const currentLevel: ReasoningLevel = (session?.settings?.reasoningLevel as ReasoningLevel | undefined) ?? 'default'

  /**
   * Открытие/закрытие — стабильные колбэки, как у модели и агента: одна и та же
   * последовательность обработчиков во всех трёх списках (лист не должен
   * пересоздавать обработчик `Escape` на каждый рендер).
   */
  const openSheet = useCallback(() => setOpen(true), [])
  const closeSheet = useCallback(() => setOpen(false), [])

  const handleSelect = async (level: ReasoningLevel) => {
    if (level === currentLevel) {
      setOpen(false)
      return
    }
    setOpen(false)
    try {
      const updated = await synthApi.updateSession(sessionId, {
        settings: { ...(session?.settings ?? {}), reasoningLevel: level },
      })
      useSessionsStore.getState().upsertSession(updated)
    } catch {
      // ignore
    }
  }

  /**
   * Мобильная зона (телефон/планшет и узкая центральная колонка — `centralNarrow`):
   * тот же список уровней в общем мобильном листе (`MobileMenuSheet`) — панель
   * растёт вверх от кнопки, зазор над кнопкой равен зазору под ней. Ширина —
   * **по содержимому** (`widthMode="content"`, минимум 140px) с выравниванием по
   * правому краю кнопки: уровни — компактный список, растягивать его на всю
   * ширину композера (как модель и агент) не нужно, раньше это был компактный
   * поппер. Раньше здесь был поппер `side="top"`: при открытой клавиатуре тап по
   * кнопке скрывал её, поле ввода уезжало вниз, а список «повисал посреди
   * экрана». Десктопная ветка (ниже) остаётся прежним поппером.
   */
  if (isMobile) {
    const triggerOpen = sheetTriggerOpenProps(open)
    // Переключение по `pointerdown` с подавлением парного `click`: `click` на
    // Android после закрытия по backdrop открывал список заново («моргание»),
    // а при скрытии клавиатуры мог не прийти вовсе.
    const triggerHandlers = sheetTriggerHandlers({
      open,
      onOpen: openSheet,
      onClose: closeSheet,
    })
    return (
      // Рамка вокруг кнопки — тот же вид, что и на десктопе.
      <div
        ref={frameRef}
        className="flex shrink-0 items-center gap-0.5 rounded-lg border border-border/80 bg-surface-subtle p-0.5"
      >
        <button
          type="button"
          className={`flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[0.6875rem] font-medium text-foreground hover:bg-interactive-hover transition-colors cursor-pointer${triggerOpen.className ? ` ${triggerOpen.className}` : ''}`}
          title={t('chat.reasoning.title')}
          aria-label={t('chat.reasoning.title')}
          aria-haspopup="menu"
          aria-expanded={open}
          // Маркер открытого листа: подсветка триггера читается программно.
          data-sheet-open={triggerOpen['data-sheet-open']}
          {...triggerHandlers}
        >
          <Icon name="brain" className="size-3 shrink-0 text-muted-foreground" />
        </button>
        <MobileMenuSheet
          open={open}
          onClose={closeSheet}
          anchorRef={frameRef}
          ariaLabel={t('chat.reasoning.title')}
          widthMode="content"
          scrollClassName="p-1"
        >
          <div className="px-2 py-1 text-[0.625rem] font-medium uppercase tracking-wide text-muted-foreground">
            {t('chat.reasoning.title')}
          </div>
          {availableLevels.map((level) => {
            const active = currentLevel === level
            return (
              <button
                key={level}
                type="button"
                role="menuitem"
                onClick={() => void handleSelect(level)}
                className={LEVEL_ITEM_CLASS}
              >
                <span className={`font-medium truncate flex-1 ${active ? 'text-primary' : 'text-foreground'}`}>
                  {t(`chat.reasoning.${level}`)}
                </span>
                {active && <Icon name="check" className="size-3.5 text-primary shrink-0" />}
              </button>
            )
          })}
        </MobileMenuSheet>
      </div>
    )
  }

  return (
    <DropdownMenu.Root open={open} onOpenChange={setOpen}>
      <div
        ref={frameRef}
        className="flex shrink-0 items-center gap-0.5 rounded-lg border border-border/80 bg-surface-subtle p-0.5"
      >
        <DropdownMenu.Trigger asChild>
          <button
            type="button"
            className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[0.6875rem] font-medium text-foreground hover:bg-interactive-hover transition-colors cursor-pointer"
            title={t('chat.reasoning.title')}
            aria-label={t('chat.reasoning.title')}
          >
            <Icon name="brain" className="size-3 shrink-0 text-muted-foreground" />
            <span className="@max-[212px]:hidden">{t(`chat.reasoning.${currentLevel}`)}</span>
          </button>
        </DropdownMenu.Trigger>
      </div>

      <DropdownMenu.Portal>
        <DropdownMenu.Content
          side="top"
          sideOffset={triggerGap}
          align="end"
          collisionPadding={8}
          className="min-w-[8.75rem] p-1 bg-popover text-popover-foreground rounded-xl ring-1 ring-foreground/10 shadow-lg z-50"
        >
          <div className="px-2 py-1 text-[0.625rem] font-medium uppercase tracking-wide text-muted-foreground">
            {t('chat.reasoning.title')}
          </div>
          {availableLevels.map((level) => {
            const active = currentLevel === level
            return (
              <DropdownMenu.Item
                key={level}
                onSelect={() => handleSelect(level)}
                className={LEVEL_ITEM_CLASS}
              >
                <span className={`font-medium truncate flex-1 ${active ? 'text-primary' : 'text-foreground'}`}>
                  {t(`chat.reasoning.${level}`)}
                </span>
                {active && <Icon name="check" className="size-3.5 text-primary shrink-0" />}
              </DropdownMenu.Item>
            )
          })}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}
