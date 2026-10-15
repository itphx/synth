import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CommandSummary } from '@itphx/synth-shared'
import { useI18n } from '@/lib/i18n'
import { useSkillsStore } from '@/stores/skillsStore'
import { cn } from '@/lib/utils'
import { Icon } from '../icon/Icon'
import { Divider } from '../ui/Divider'

export interface CommandAutocompleteProps {
  /** Текст после ведущего `/` (без него). */
  query: string
  position: { left: number }
  onSelect: (command: CommandSummary) => void
  onClose: () => void
  /** Число совпавших команд — родителю, чтобы не перехватывать Enter при пустом списке. */
  onMatchesChange?: (count: number) => void
}

/**
 * Подъём поповера над якорем: 9px до рамки композера (border 1px + py-2 8px)
 * + 8px зазора. Позиционируем в CSS, а не по замеру высоты textarea: высота
 * внутри обработчика input измеряется недостоверно (DOM ещё не устоялся).
 */
const POPUP_LIFT = 'calc(100% + 17px)'

const KIND_BADGE: Record<string, string> = {
  builtin: 'bg-status-success/15 text-status-success',
  template: 'bg-primary/15 text-primary',
  skill: 'bg-status-warning/15 text-status-warning',
  bundle: 'bg-muted text-muted-foreground',
}

/**
 * ADR-046 §7/§9.3: автокомплит `/`-команд над композером. Источник — единый
 * реестр команд core (`GET /api/v2/commands`): builtin/template/skill/bundle.
 * Визуальный референс — архив форка (`CommandAutocomplete`/`SkillAutocomplete`),
 * сторы форка не переиспользуются.
 */
export function CommandAutocomplete({
  query,
  position,
  onSelect,
  onClose,
  onMatchesChange,
}: CommandAutocompleteProps) {
  const { t } = useI18n()
  const commands = useSkillsStore((s) => s.commands)
  const loading = useSkillsStore((s) => s.commandsLoading)
  const fetchCommands = useSkillsStore((s) => s.fetchCommands)

  const ref = useRef<HTMLDivElement>(null)
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([])
  const [highlightedIdx, setHighlightedIdx] = useState(0)

  useEffect(() => {
    void fetchCommands()
  }, [fetchCommands])

  const filtered = useMemo(() => {
    const list = commands ?? []
    const q = query.trim().toLowerCase()
    const matched = q
      ? list.filter(
          (cmd) =>
            cmd.name.toLowerCase().includes(q) ||
            cmd.description.toLowerCase().includes(q),
        )
      : list
    // Доступные — выше; далее по имени.
    return [...matched].sort((a, b) => {
      if (a.available !== b.available) return a.available ? -1 : 1
      return a.name.localeCompare(b.name)
    })
  }, [commands, query])

  useEffect(() => {
    setHighlightedIdx(0)
  }, [query, commands])

  useEffect(() => {
    onMatchesChange?.(filtered.length)
  }, [filtered.length, onMatchesChange])

  useEffect(() => {
    itemRefs.current[highlightedIdx]?.scrollIntoView?.({ behavior: 'smooth', block: 'nearest' })
  }, [highlightedIdx])

  const navigate = useCallback((delta: number) => {
    setHighlightedIdx((prev) => (filtered.length ? (prev + delta + filtered.length) % filtered.length : 0))
  }, [filtered.length])

  // Закрытие по клику/тапу вне списка (pointerdown покрывает мышь и тач).
  useEffect(() => {
    const handler = (e: MouseEvent | TouchEvent) => {
      const target = e.target as Node | null
      if (!target || !ref.current) return
      if (!ref.current.contains(target)) onClose()
    }
    document.addEventListener('pointerdown', handler, true)
    return () => document.removeEventListener('pointerdown', handler, true)
  }, [onClose])

  // Клавиатура: пишет в текст, но перехватываем до вставки. Enter/Tab — выбор,
  // Escape — закрытие; родитель не отправляет сообщение, пока список непуст.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault()
          navigate(1)
          break
        case 'ArrowUp':
          e.preventDefault()
          navigate(-1)
          break
        case 'Enter':
        case 'Tab': {
          const command = filtered[highlightedIdx]
          if (command) {
            e.preventDefault()
            onSelect(command)
          }
          break
        }
        case 'Escape':
          e.preventDefault()
          onClose()
          break
      }
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [navigate, filtered, highlightedIdx, onSelect, onClose])

  return (
    <div
      ref={ref}
      data-testid="command-autocomplete"
      className="absolute z-50 flex flex-col overflow-hidden rounded-xl bg-popover text-popover-foreground ring-1 ring-foreground/10 shadow-lg max-h-[min(24rem,60vh)]"
      style={{ bottom: POPUP_LIFT, left: position.left, width: '32rem', maxWidth: '100%' }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div className="px-3 py-1.5 text-[0.625rem] uppercase tracking-wide text-popover-foreground/60">
        {t('chat.commandAutocomplete.title')}
      </div>
      <Divider inset tone="raised" />

      {loading && (commands?.length ?? 0) === 0 ? (
        <div className="px-3 py-2 text-xs text-popover-foreground/70">{t('common.loading')}</div>
      ) : filtered.length === 0 ? (
        <div className="px-3 py-2 text-xs text-popover-foreground/70" data-testid="command-autocomplete-empty">
          {t('chat.commandAutocomplete.empty')}
        </div>
      ) : (
        <div className="flex-1 min-h-0 overflow-y-auto p-1" role="list">
          {filtered.map((command, idx) => (
            <button
              key={`${command.kind}-${command.name}`}
              ref={(el) => { itemRefs.current[idx] = el }}
              type="button"
              role="listitem"
              data-testid={`command-autocomplete-item-${command.name}`}
              onMouseEnter={() => setHighlightedIdx(idx)}
              onClick={() => onSelect(command)}
              className={cn(
                'flex w-full min-h-10 items-start gap-2 rounded-lg px-2 py-1.5 text-left transition-colors',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                idx === highlightedIdx ? 'bg-interactive-selection text-interactive-selection-foreground' : 'hover:bg-interactive-hover',
                !command.available && 'opacity-60',
              )}
            >
              <Icon name="terminal-box" className="mt-0.5 size-3.5 shrink-0 text-popover-foreground/70" />
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1.5 flex-wrap min-w-0">
                  <span className="font-mono text-xs font-medium break-words">/{command.name}</span>
                  <span className={cn('rounded px-1.5 py-0.5 text-[0.625rem] font-medium', KIND_BADGE[command.kind] ?? 'bg-muted text-muted-foreground')}>
                    {t(`commands.kind.${command.kind}`)}
                  </span>
                  {command.scope && (
                    <span className="rounded bg-muted px-1.5 py-0.5 text-[0.625rem] font-medium text-muted-foreground">
                      {t(`skills.scope.${command.scope}`)}
                    </span>
                  )}
                  {!command.available && (
                    <span
                      data-testid={`command-autocomplete-unavailable-${command.name}`}
                      className="rounded bg-muted px-1.5 py-0.5 text-[0.625rem] font-medium text-muted-foreground"
                    >
                      {t('chat.commandAutocomplete.unavailable')}
                    </span>
                  )}
                </span>
                {command.description && (
                  <span className="mt-0.5 block whitespace-normal break-words text-[0.6875rem] text-popover-foreground/70">
                    {command.description}
                  </span>
                )}
              </span>
              {command.argumentHint && (
                <span className="shrink-0 self-center font-mono text-[0.625rem] text-popover-foreground/60">
                  {command.argumentHint}
                </span>
              )}
            </button>
          ))}
        </div>
      )}

      <Divider inset tone="raised" />
      <div className="px-3 py-1 text-[0.625rem] text-popover-foreground/60">
        {t('chat.commandAutocomplete.keyboardHint')}
      </div>
    </div>
  )
}
