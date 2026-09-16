import { useState } from 'react'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import type { ReasoningLevel } from '@itphx/synth-shared'
import { useProvidersStore } from '@/stores/providersStore'
import { useSessionsStore } from '@/stores/sessionsStore'
import { useI18n } from '@/lib/i18n'
import { useDevice } from '@/hooks/useDevice'
import { useUIStore } from '@/stores/useUIStore'
import { synthApi } from '@/lib/api/synthApi'
import { Icon } from '../icon/Icon'

/** Доступные уровни размышлений по типу провайдера (Default — всегда первый). */
const REASONING_LEVELS_BY_PROVIDER_TYPE: Record<string, ReasoningLevel[]> = {
  openai: ['default', 'none', 'low', 'medium', 'high'],
  generic: ['default', 'none', 'low', 'medium', 'high'],
  anthropic: ['default', 'none', 'high'],
  ollama: ['default', 'none', 'low'],
}

export function ReasoningLevelSelector({ sessionId }: { sessionId: string }) {
  const { t } = useI18n()
  const { deviceType } = useDevice()
  const centralNarrow = useUIStore((s) => s.centralNarrow)
  const isMobile = deviceType !== 'desktop' || centralNarrow
  const [open, setOpen] = useState(false)
  const providers = useProvidersStore((s) => s.providers)
  const selectedProviderName = useProvidersStore((s) => s.selectedProviderName)
  const session = useSessionsStore((s) => s.sessions.find((x) => x.id === sessionId))

  const currentProvider = providers.find((p) => p.name === selectedProviderName)
  const availableLevels = REASONING_LEVELS_BY_PROVIDER_TYPE[currentProvider?.type ?? ''] ?? ['default', 'none']
  const currentLevel: ReasoningLevel = (session?.settings?.reasoningLevel as ReasoningLevel | undefined) ?? 'default'

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

  return (
    <DropdownMenu.Root open={open} onOpenChange={setOpen}>
      <div className="flex shrink-0 items-center gap-0.5 rounded-lg border border-border/80 bg-surface-subtle p-0.5">
        <DropdownMenu.Trigger asChild>
          <button
            type="button"
            className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[0.6875rem] font-medium text-foreground hover:bg-interactive-hover/50 transition-colors cursor-pointer"
            title={t('chat.reasoning.title')}
            aria-label={t('chat.reasoning.title')}
          >
            <Icon name="brain" className="size-3 shrink-0 text-muted-foreground" />
            {!isMobile && <span className="@max-[212px]:hidden">{t(`chat.reasoning.${currentLevel}`)}</span>}
          </button>
        </DropdownMenu.Trigger>
      </div>

      <DropdownMenu.Portal>
        <DropdownMenu.Content
          side="top"
          sideOffset={4}
          align="end"
          collisionPadding={8}
          className="min-w-[8.75rem] p-1 bg-popover border border-border rounded-lg shadow-lg z-50"
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
                className="text-xs flex items-center gap-2 px-2 py-1.5 rounded-md cursor-pointer hover:bg-interactive-hover/50 data-[highlighted]:bg-interactive-selection outline-none"
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
