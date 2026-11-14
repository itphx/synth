import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useI18n } from '@/lib/i18n'
import { useSkillsStore } from '@/stores/skillsStore'
import { cn } from '@/lib/utils'
import { Icon } from '../icon/Icon'
import { Divider } from '../ui/Divider'

export interface SkillAutocompleteProps {
  /** Текст после ведущего `$` (без него). */
  query: string
  position: { left: number }
  onSelect: (name: string) => void
  onClose: () => void
  /** Число совпавших скиллов — родителю, чтобы не перехватывать Enter при пустом списке. */
  onMatchesChange?: (count: number) => void
}

/**
 * Подъём поповера над якорем: 9px до рамки композера (border 1px + py-2 8px)
 * + 8px зазора. Позиционируем в CSS, а не по замеру высоты textarea: высота
 * внутри обработчика input измеряется недостоверно (DOM ещё не устоялся).
 */
const POPUP_LIFT = 'calc(100% + 17px)'

/** Запись списка скиллов для пикера. */
interface SkillEntry {
  /** Имя скилла — именно его подставляет `$`-вызов (PROP-126 §3). */
  name: string
  description: string
}

/**
 * PROP-126 §3: `$`-пикер скиллов над композером.
 *
 * Источник данных — реестр скиллов (`GET /api/v2/skills`) и общий реестр
 * команд (`GET /api/v2/commands`, `kind:'skill'`). Имя берётся **из реестра
 * скиллов**: ядро резолвит `$`-токен по имени скилла
 * (`engine/commands/dollar-skills.ts` → `skillRuntime.get(name)`), а в
 * реестре команд у скилла может быть другое имя — `metadata.synth.command`
 * (`synth-pipelines` → команда `pipelines`). Поэтому запись команды — только
 * дополнение, если скилла с таким именем в реестре нет.
 *
 * Клавиатура, позиционирование и `data-testid` — как у `CommandAutocomplete`.
 */
export function SkillAutocomplete({
  query,
  position,
  onSelect,
  onClose,
  onMatchesChange,
}: SkillAutocompleteProps) {
  const { t } = useI18n()
  const commands = useSkillsStore((s) => s.commands)
  const skills = useSkillsStore((s) => s.skills)
  const fetchCommands = useSkillsStore((s) => s.fetchCommands)
  const fetchSkills = useSkillsStore((s) => s.fetchSkills)

  const ref = useRef<HTMLDivElement>(null)
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([])
  const [highlightedIdx, setHighlightedIdx] = useState(0)

  // Реестры тянутся один раз: пока данных нет — подгружаем.
  useEffect(() => {
    if (commands === null) void fetchCommands()
  }, [commands, fetchCommands])
  useEffect(() => {
    if (skills === null) void fetchSkills()
  }, [skills, fetchSkills])

  const entries = useMemo<SkillEntry[]>(() => {
    const fromRegistry = (skills ?? [])
      .filter((skill) => skill.userInvocable !== false && skill.available !== false)
      .map((skill) => ({ name: skill.name, description: skill.description ?? '' }))
    const known = new Set(fromRegistry.map((entry) => entry.name))
    const fromCommands = (commands ?? [])
      .filter((cmd) => cmd.kind === 'skill' && cmd.available !== false && !known.has(cmd.name))
      .map((cmd) => ({ name: cmd.name, description: cmd.description ?? '' }))
    return [...fromRegistry, ...fromCommands].sort((a, b) => a.name.localeCompare(b.name))
  }, [skills, commands])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return entries
    return entries.filter(
      (entry) =>
        entry.name.toLowerCase().includes(q) || entry.description.toLowerCase().includes(q),
    )
  }, [entries, query])

  useEffect(() => {
    setHighlightedIdx(0)
  }, [query, entries])

  useEffect(() => {
    onMatchesChange?.(filtered.length)
  }, [filtered.length, onMatchesChange])

  useEffect(() => {
    itemRefs.current[highlightedIdx]?.scrollIntoView?.({ behavior: 'smooth', block: 'nearest' })
  }, [highlightedIdx])

  const navigate = useCallback(
    (delta: number) => {
      setHighlightedIdx((prev) => (filtered.length ? (prev + delta + filtered.length) % filtered.length : 0))
    },
    [filtered.length],
  )

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
          const entry = filtered[highlightedIdx]
          if (entry) {
            e.preventDefault()
            onSelect(entry.name)
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

  // Пустой список — ничего не рисуем (пикер не мешает вводу).
  if (filtered.length === 0) return null

  return (
    <div
      ref={ref}
      data-testid="skill-autocomplete"
      className="absolute z-50 flex flex-col overflow-hidden rounded-xl bg-popover text-popover-foreground ring-1 ring-foreground/10 shadow-lg max-h-[min(24rem,60vh)]"
      style={{ bottom: POPUP_LIFT, left: position.left, width: '24rem', maxWidth: '100%' }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div className="px-3 py-1.5 text-[0.625rem] uppercase tracking-wide text-popover-foreground/60">
        {t('chat.skillAutocomplete.title')}
      </div>
      <Divider inset tone="raised" />

      <div className="flex-1 min-h-0 overflow-y-auto p-1" role="list">
        {filtered.map((entry, idx) => (
          <button
            key={entry.name}
            ref={(el) => {
              itemRefs.current[idx] = el
            }}
            type="button"
            role="listitem"
            data-testid={`skill-autocomplete-item-${entry.name}`}
            onMouseEnter={() => setHighlightedIdx(idx)}
            onClick={() => onSelect(entry.name)}
            className={cn(
              'flex w-full min-h-10 items-start gap-2 rounded-lg px-2 py-1.5 text-left transition-colors',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              idx === highlightedIdx
                ? 'bg-interactive-selection text-interactive-selection-foreground'
                : 'hover:bg-interactive-hover',
            )}
          >
            <Icon name="book-open" className="mt-0.5 size-3.5 shrink-0 text-popover-foreground/70" />
            <span className="min-w-0 flex-1">
              <span className="font-mono text-xs font-medium break-words">${entry.name}</span>
              {entry.description && (
                <span className="mt-0.5 block whitespace-normal break-words text-[0.6875rem] text-popover-foreground/70">
                  {entry.description}
                </span>
              )}
            </span>
          </button>
        ))}
      </div>

      <Divider inset tone="raised" />
      <div className="px-3 py-1 text-[0.625rem] text-popover-foreground/60">
        {t('chat.skillAutocomplete.keyboardHint')}
      </div>
    </div>
  )
}
