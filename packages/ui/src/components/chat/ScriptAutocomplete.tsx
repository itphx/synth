import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useI18n } from '@/lib/i18n'
import { synthApi } from '@/lib/api/synthApi'
import type { ScriptSummary } from '@/lib/api/synthApi'
import { cn } from '@/lib/utils'
import { Icon } from '../icon/Icon'
import { Divider } from '../ui/Divider'

export interface ScriptAutocompleteProps {
  /** Текст после ведущего `!` (без него). */
  query: string
  position: { left: number }
  /** Сессия-владелец: реестр скриптов проекта/инстанса (ADR-126 §5). */
  sessionId: string
  onSelect: (name: string) => void
  onClose: () => void
  /** Число выбираемых совпадений — родителю, чтобы не перехватывать Enter при пустом списке. */
  onMatchesChange?: (count: number) => void
}

/**
 * Подъём поповера над якорем: 9px до рамки композера (border 1px + py-2 8px)
 * + 8px зазора. Позиционируем в CSS, а не по замеру высоты textarea: высота
 * внутри обработчика input измеряется недостоверно (DOM ещё не устоялся).
 */
const POPUP_LIFT = 'calc(100% + 17px)'

/** Бейдж источника скрипта (ADR-126 §5 «Реестр»: project > instance > config). */
const ORIGIN_BADGE: Record<string, string> = {
  project: 'bg-status-success/15 text-status-success',
  instance: 'bg-primary/15 text-primary',
  config: 'bg-muted text-muted-foreground',
}

/**
 * ADR-126 §5: `!`-пикер скриптов над композером.
 *
 * Источник данных — реестр скриптов сессии (`GET /api/v2/sessions/:id/scripts`):
 * project-каталог `.synth/scripts`, инстанс-каталог и `config.scripts.paths`.
 * Ядро само резолвит `!name` в сообщении, поэтому пикер только **подставляет
 * текст** — запуск здесь не происходит.
 *
 * Скрипт с `available: false` виден, но не запускается (недоверенный проектный
 * каталог или правило прав) — он показывается с причиной и не выбирается.
 *
 * Клавиатура, позиционирование и `data-testid` — как у `SnippetAutocomplete`.
 */
export function ScriptAutocomplete({
  query,
  position,
  sessionId,
  onSelect,
  onClose,
  onMatchesChange,
}: ScriptAutocompleteProps) {
  const { t } = useI18n()

  const ref = useRef<HTMLDivElement>(null)
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([])
  const [highlightedIdx, setHighlightedIdx] = useState(0)
  const [scripts, setScripts] = useState<ScriptSummary[] | null>(null)
  const [loading, setLoading] = useState(true)
  /** Реестр не загрузился — список не показываем вовсе (ввод не ломаем). */
  const [failed, setFailed] = useState(false)

  // Реестр тянется один раз на открытие пикера: пока пикер открыт, список
  // фильтруется локально (запрос на каждый keystroke не нужен).
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    void synthApi
      .listSessionScripts(sessionId)
      .then((res) => {
        if (cancelled) return
        setScripts(res.scripts ?? [])
        setLoading(false)
      })
      .catch((err) => {
        // Ошибка списка — тихая: ввод не ломаем, список не рисуем.
        if (!import.meta.env.PROD) {
          console.warn('[scripts] не удалось загрузить реестр скриптов', err)
        }
        if (cancelled) return
        setScripts([])
        setFailed(true)
        setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [sessionId])

  const entries = useMemo<ScriptSummary[]>(() => {
    return [...(scripts ?? [])].sort((a, b) => a.name.localeCompare(b.name))
  }, [scripts])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return entries
    return entries.filter(
      (entry) =>
        entry.name.toLowerCase().includes(q) ||
        (entry.description ?? '').toLowerCase().includes(q),
    )
  }, [entries, query])

  /** Выбираемые скрипты: недоступные (`available: false`) в выбор не попадают. */
  const selectable = useMemo(() => filtered.filter((entry) => entry.available), [filtered])

  useEffect(() => {
    setHighlightedIdx(0)
  }, [query, entries])

  useEffect(() => {
    onMatchesChange?.(selectable.length)
  }, [selectable.length, onMatchesChange])

  useEffect(() => {
    itemRefs.current[highlightedIdx]?.scrollIntoView?.({ behavior: 'smooth', block: 'nearest' })
  }, [highlightedIdx])

  const navigate = useCallback(
    (delta: number) => {
      setHighlightedIdx((prev) =>
        selectable.length ? (prev + delta + selectable.length) % selectable.length : 0,
      )
    },
    [selectable.length],
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
          const entry = selectable[highlightedIdx]
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
  }, [navigate, selectable, highlightedIdx, onSelect, onClose])

  // Пока реестр грузится — ничего не рисуем (иначе при вводе `!` поповер
  // мигал пустым и исчезал). Ошибка загрузки — тоже без списка.
  if (loading || failed) return null

  return (
    <div
      ref={ref}
      data-testid="script-autocomplete"
      className="absolute z-50 flex flex-col overflow-hidden rounded-xl bg-popover text-popover-foreground ring-1 ring-foreground/10 shadow-lg max-h-[min(24rem,60vh)]"
      style={{ bottom: POPUP_LIFT, left: position.left, width: '24rem', maxWidth: '100%' }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div className="px-3 py-1.5 text-[0.625rem] uppercase tracking-wide text-popover-foreground/60">
        {t('scripts.autocomplete.title')}
      </div>
      <Divider inset tone="raised" />

      {filtered.length === 0 ? (
        <div className="px-3 py-2" data-testid="script-autocomplete-empty">
          <div className="text-xs text-popover-foreground/80">{t('scripts.autocomplete.empty')}</div>
          <div className="mt-0.5 text-[0.6875rem] text-popover-foreground/60">
            {t('scripts.autocomplete.hint')}
          </div>
        </div>
      ) : (
        <div className="flex-1 min-h-0 overflow-y-auto p-1" role="list">
          {filtered.map((entry) => {
            const selectableIdx = selectable.indexOf(entry)
            const highlighted = entry.available && selectableIdx === highlightedIdx
            return (
              <button
                key={entry.name}
                ref={(el) => {
                  if (entry.available) itemRefs.current[selectableIdx] = el
                }}
                type="button"
                role="listitem"
                aria-disabled={!entry.available}
                data-testid={`script-autocomplete-item-${entry.name}`}
                onMouseEnter={() => {
                  if (entry.available) setHighlightedIdx(selectableIdx)
                }}
                onClick={() => {
                  // Недоступный скрипт не выбирается (недоверенный каталог/права).
                  if (!entry.available) return
                  onSelect(entry.name)
                }}
                className={cn(
                  'flex w-full min-h-10 items-start gap-2 rounded-lg px-2 py-1.5 text-left transition-colors',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  highlighted
                    ? 'bg-interactive-selection text-interactive-selection-foreground'
                    : 'hover:bg-interactive-hover',
                  !entry.available && 'cursor-default opacity-60',
                )}
              >
                <Icon name="terminal-box" className="mt-0.5 size-3.5 shrink-0 text-popover-foreground/70" />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5 flex-wrap min-w-0">
                    <span className="font-mono text-xs font-medium break-words">!{entry.name}</span>
                    <span
                      className={cn(
                        'rounded px-1.5 py-0.5 text-[0.625rem] font-medium',
                        ORIGIN_BADGE[entry.origin] ?? 'bg-muted text-muted-foreground',
                      )}
                    >
                      {t(`scripts.autocomplete.origin.${entry.origin}`)}
                    </span>
                    {!entry.available && (
                      <span
                        data-testid={`script-autocomplete-unavailable-${entry.name}`}
                        className="rounded bg-muted px-1.5 py-0.5 text-[0.625rem] font-medium text-muted-foreground"
                      >
                        {entry.unavailableReason === 'denied'
                          ? t('scripts.unavailable.denied')
                          : t('scripts.unavailable.trusted')}
                      </span>
                    )}
                  </span>
                  {entry.description && (
                    <span className="mt-0.5 block whitespace-normal break-words text-[0.6875rem] text-popover-foreground/70">
                      {entry.description}
                    </span>
                  )}
                </span>
                {entry.argumentHint && (
                  <span className="shrink-0 self-center font-mono text-[0.625rem] text-popover-foreground/60">
                    {entry.argumentHint}
                  </span>
                )}
              </button>
            )
          })}
        </div>
      )}

      <Divider inset tone="raised" />
      <div className="px-3 py-1 text-[0.625rem] text-popover-foreground/60">
        {t('scripts.autocomplete.keyboardHint')}
      </div>
    </div>
  )
}
