import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useI18n } from '@/lib/i18n'
import { synthApi } from '@/lib/api/synthApi'
import type { Snippet } from '@/lib/api/synthApi'
import { useSnippetsStore } from '@/stores/snippetsStore'
import { cn } from '@/lib/utils'
import { Icon } from '../icon/Icon'
import { Divider } from '../ui/Divider'

export interface SnippetAutocompleteProps {
  /** Текст после ведущего `#` (без него). */
  query: string
  position: { left: number }
  onSelect: (name: string) => void
  onClose: () => void
  /** Число совпавших сниппетов — родителю, чтобы не перехватывать Enter при пустом списке. */
  onMatchesChange?: (count: number) => void
  /** Проект сессии: включает project-уровень в списке (`GET /snippets?projectId=`). */
  projectId?: string | null
}

/**
 * Подъём поповера над якорем: 9px до рамки композера (border 1px + py-2 8px)
 * + 8px зазора. Позиционируем в CSS, а не по замеру высоты textarea: высота
 * внутри обработчика input измеряется недостоверно (DOM ещё не устоялся).
 */
const POPUP_LIFT = 'calc(100% + 17px)'

/** Бейдж уровня сниппета (ADR-126 §4 «Три уровня»). */
const SCOPE_BADGE: Record<string, string> = {
  instance: 'bg-primary/15 text-primary',
  project: 'bg-status-success/15 text-status-success',
  user: 'bg-muted text-muted-foreground',
}

/**
 * ADR-126 §4: `#`-пикер сниппетов над композером.
 *
 * Источник данных — реестр сниппетов (`GET /api/v2/snippets`): instance-,
 * user- и project-уровни (project — по `projectId` сессии). Ядро раскрывает
 * `#name` в сообщении **до отправки**,
 * поэтому пикер подставляет сам токен — тело сниппета пользователю не видно.
 *
 * Клавиатура, позиционирование и `data-testid` — как у `SkillAutocomplete`.
 */
export function SnippetAutocomplete({
  query,
  position,
  onSelect,
  onClose,
  onMatchesChange,
  projectId,
}: SnippetAutocompleteProps) {
  const { t } = useI18n()

  const ref = useRef<HTMLDivElement>(null)
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([])
  const [highlightedIdx, setHighlightedIdx] = useState(0)
  const [snippets, setSnippets] = useState<Snippet[] | null>(null)
  const [loading, setLoading] = useState(true)

  // Реестр сниппетов перечитывается на каждом открытии пикера и на каждое
  // событие `snippets.updated` (`snippetsRevision`): гейт «грузить только если
  // список пуст» держал бы старый состав до перезагрузки страницы — созданный,
  // изменённый или удалённый сниппет не появлялся бы (или не исчезал) в
  // подсказках. Как и у `SkillAutocomplete` (ADR-126 §3), перезапрос идёт
  // безусловно — один запрос на открытие/сигнал, а не N вызовов.
  const snippetsRevision = useSnippetsStore((s) => s.revision)
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    void synthApi
      .listSnippets(projectId ? { projectId } : undefined)
      .then((res) => {
        if (cancelled) return
        setSnippets(res.snippets ?? [])
        setLoading(false)
      })
      .catch(() => {
        // Ошибка списка — тихая: пикер просто не показывается (ввод не ломаем).
        if (cancelled) return
        setSnippets([])
        setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [projectId, snippetsRevision])

  const entries = useMemo<Snippet[]>(() => {
    const list = snippets ?? []
    return [...list].sort((a, b) => a.name.localeCompare(b.name))
  }, [snippets])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return entries
    return entries.filter(
      (entry) =>
        entry.name.toLowerCase().includes(q) ||
        (entry.description ?? '').toLowerCase().includes(q),
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

  // Пока реестр грузится или совпадений нет — ничего не рисуем. Иначе при
  // вводе `#` поповер успевал мигнуть пустым и исчезнуть.
  if (loading || filtered.length === 0) return null

  return (
    <div
      ref={ref}
      data-testid="snippet-autocomplete"
      className="absolute z-50 flex flex-col overflow-hidden rounded-xl bg-popover text-popover-foreground ring-1 ring-foreground/10 shadow-lg max-h-[min(24rem,60vh)]"
      style={{ bottom: POPUP_LIFT, left: position.left, width: '24rem', maxWidth: '100%' }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div className="px-3 py-1.5 text-[0.625rem] uppercase tracking-wide text-popover-foreground/60">
        {t('chat.snippetAutocomplete.title')}
      </div>
      <Divider inset tone="raised" />

      {loading && filtered.length === 0 ? (
        <div className="px-3 py-2 text-xs text-popover-foreground/70">{t('common.loading')}</div>
      ) : (
        <div className="flex-1 min-h-0 overflow-y-auto p-1" role="list">
          {filtered.map((entry, idx) => (
            <button
              key={entry.name}
              ref={(el) => {
                itemRefs.current[idx] = el
              }}
              type="button"
              role="listitem"
              data-testid={`snippet-autocomplete-item-${entry.name}`}
              onMouseEnter={() => setHighlightedIdx(idx)}
              onClick={() => onSelect(entry.name)}
              className={cn(
                'flex w-full min-h-10 items-start gap-2 rounded-lg px-2 py-1.5 text-left transition-colors',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                idx === highlightedIdx
                  ? 'bg-interactive-selection text-interactive-selection-foreground'
                  : 'hover:bg-interactive-hover',
                !entry.trusted && 'opacity-60',
              )}
            >
              <Icon name="file-text" className="mt-0.5 size-3.5 shrink-0 text-popover-foreground/70" />
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1.5 flex-wrap min-w-0">
                  <span className="font-mono text-xs font-medium break-words">#{entry.name}</span>
                  <span
                    className={cn(
                      'rounded px-1.5 py-0.5 text-[0.625rem] font-medium',
                      SCOPE_BADGE[entry.scope] ?? 'bg-muted text-muted-foreground',
                    )}
                  >
                    {t(`chat.snippetAutocomplete.scope.${entry.scope}`)}
                  </span>
                  {!entry.trusted && (
                    <span
                      data-testid={`snippet-autocomplete-untrusted-${entry.name}`}
                      className="rounded bg-muted px-1.5 py-0.5 text-[0.625rem] font-medium text-muted-foreground"
                    >
                      {t('chat.snippetAutocomplete.untrusted')}
                    </span>
                  )}
                </span>
                {entry.description && (
                  <span className="mt-0.5 block whitespace-normal break-words text-[0.6875rem] text-popover-foreground/70">
                    {entry.description}
                  </span>
                )}
              </span>
            </button>
          ))}
        </div>
      )}

      <Divider inset tone="raised" />
      <div className="px-3 py-1 text-[0.625rem] text-popover-foreground/60">
        {t('chat.snippetAutocomplete.keyboardHint')}
      </div>
    </div>
  )
}
