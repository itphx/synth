import { useMemo, useEffect, useRef, useState, useCallback } from 'react'
import { Icon } from '../icon/Icon'
import { Divider } from '../ui/Divider'
import { useI18n } from '@/lib/i18n'
import { cn, resolveColor } from '@/lib/utils'
import type { AgentInfo } from '@/lib/api/synthApi'

/** Участник сессии, доступный для упоминания (`@user`, ADR-126 §2.1). */
export interface MentionUserEntry {
  /** id пользователя — именно он подставляется в текст (`@<id>`). */
  id: string
  /** Подпись в списке (имя; если имени нет — id). */
  label: string
}

/** Файл рабочего каталога (`@file`, ADR-126 §2). */
export interface MentionFileEntry {
  /** Путь относительно корня workspace — именно он подставляется. */
  path: string
  /** Подпись в списке (путь файла). */
  label: string
}

/** Вид упоминания. */
export type MentionKind = 'agent' | 'user' | 'file'

/** Выбранный элемент пикера: вид + идентификатор (для файла — путь). */
export interface MentionSelection {
  kind: MentionKind
  id: string
}

interface MentionPopupProps {
  query: string
  agents: AgentInfo[]
  users: MentionUserEntry[]
  files: MentionFileEntry[]
  position: { left: number }
  onSelect: (item: MentionSelection) => void
  onClose: () => void
  /** Число совпавших элементов — родителю, чтобы не перехватывать Enter при пустом списке. */
  onMatchesChange?: (count: number) => void
}

/**
 * Подъём поповера над якорем: 9px до рамки композера (border 1px + py-2 8px)
 * + 8px зазора. Позиционируем в CSS, а не по замеру высоты textarea: высота
 * внутри обработчика input измеряется недостоверно (DOM ещё не устоялся).
 */
const POPUP_LIFT = 'calc(100% + 17px)'

/**
 * Строка пикера — плоский элемент общего списка: индекс навигации (стрелки)
 * общий для всех секций, поэтому строки разных видов лежат в одном массиве.
 */
type MentionRow =
  | { kind: 'agent'; id: string; label: string; agent: AgentInfo }
  | { kind: 'user'; id: string; label: string }
  | { kind: 'file'; id: string; label: string }

/**
 * ADR-126 §2: `@`-пикер над композером — агенты, участники сессии и файлы
 * рабочего каталога.
 *
 * Источники данных приходят от родителя (`ChatInput`): агенты — из реестра
 * агентов, пользователи — из участников сессии (`participants`), файлы — из
 * листинга workspace проекта. Пикер только фильтрует и показывает: окончательное
 * разрешение (`@agent` / `@user` / `@file`) делает ядро.
 */
export function MentionPopup({
  query,
  agents,
  users,
  files,
  position,
  onSelect,
  onClose,
  onMatchesChange,
}: MentionPopupProps) {
  const { t } = useI18n()
  const ref = useRef<HTMLDivElement>(null)
  const [highlightedIdx, setHighlightedIdx] = useState(0)

  const sections = useMemo(() => {
    const q = query.trim().toLowerCase()
    const agentRows: Extract<MentionRow, { kind: 'agent' }>[] = agents
      .filter((a) => a.enabled && (a.agent_mode == null || a.agent_mode.includes('primary')))
      .filter(
        (a) =>
          !q ||
          a.id.toLowerCase().includes(q) ||
          a.display_name.toLowerCase().includes(q),
      )
      .map((a) => ({ kind: 'agent', id: a.id, label: a.display_name, agent: a }))
    const userRows: Extract<MentionRow, { kind: 'user' }>[] = users
      .filter((u) => !q || u.id.toLowerCase().includes(q) || u.label.toLowerCase().includes(q))
      .map((u) => ({ kind: 'user', id: u.id, label: u.label }))
    const fileRows: Extract<MentionRow, { kind: 'file' }>[] = files
      .filter((f) => !q || f.path.toLowerCase().includes(q) || f.label.toLowerCase().includes(q))
      .map((f) => ({ kind: 'file', id: f.path, label: f.label }))
    return { agentRows, userRows, fileRows }
  }, [agents, users, files, query])

  const rows = useMemo<MentionRow[]>(
    () => [...sections.agentRows, ...sections.userRows, ...sections.fileRows],
    [sections],
  )

  useEffect(() => {
    setHighlightedIdx(0)
  }, [query])

  // Список мог сократиться без смены запроса (догрузились данные) — держим
  // индекс в границах списка, иначе Enter выбирал бы «ничего».
  useEffect(() => {
    setHighlightedIdx((prev) => (rows.length ? Math.min(prev, rows.length - 1) : 0))
  }, [rows.length])

  useEffect(() => {
    onMatchesChange?.(rows.length)
  }, [rows.length, onMatchesChange])

  const navigate = useCallback(
    (delta: number) => {
      setHighlightedIdx((prev) =>
        rows.length ? (prev + delta + rows.length) % rows.length : 0,
      )
    },
    [rows.length],
  )

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onClose()
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [onClose])

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
        case 'Enter': {
          const row = rows[highlightedIdx]
          // Пустой список — Enter не перехватываем: сообщение должно уходить.
          if (!row) break
          e.preventDefault()
          onSelect({ kind: row.kind, id: row.id })
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
  }, [onClose, navigate, rows, highlightedIdx, onSelect])

  if (rows.length === 0) return null

  const rowClass = (idx: number) =>
    cn(
      'flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-xs text-foreground transition-colors text-left group',
      idx === highlightedIdx ? 'bg-interactive-hover' : 'hover:bg-interactive-hover',
    )

  const renderAgentRow = (row: Extract<MentionRow, { kind: 'agent' }>, idx: number) => (
    <button
      key={`agent:${row.id}`}
      type="button"
      role="listitem"
      data-testid="mention-item"
      data-mention-kind="agent"
      data-mention-id={row.id}
      className={rowClass(idx)}
      onMouseEnter={() => setHighlightedIdx(idx)}
      onClick={() => onSelect({ kind: 'agent', id: row.id })}
    >
      {row.agent.icon ? (
        <Icon
          name={row.agent.icon}
          className="size-3.5 shrink-0"
          style={row.agent.color ? { color: resolveColor(row.agent.color) } : undefined}
        />
      ) : (
        <div
          className="h-1 w-1 rounded-full shrink-0"
          style={row.agent.color ? { backgroundColor: resolveColor(row.agent.color) } : undefined}
        />
      )}
      <span className="font-medium">{row.agent.display_name}</span>
      {row.agent.capabilities.length > 0 && (
        <span className="text-[0.625rem] text-muted-foreground/50 ml-auto hidden group-hover:block">
          {row.agent.capabilities.slice(0, 2).join(', ')}
        </span>
      )}
      <span className="text-muted-foreground/50 ml-auto font-mono group-hover:hidden">@{row.id}</span>
    </button>
  )

  const renderUserRow = (row: Extract<MentionRow, { kind: 'user' }>, idx: number) => (
    <button
      key={`user:${row.id}`}
      type="button"
      role="listitem"
      data-testid="mention-item"
      data-mention-kind="user"
      data-mention-id={row.id}
      className={rowClass(idx)}
      onMouseEnter={() => setHighlightedIdx(idx)}
      onClick={() => onSelect({ kind: 'user', id: row.id })}
    >
      <Icon name="user-3" className="size-3.5 shrink-0 text-muted-foreground/70" />
      <span className="font-medium truncate">{row.label}</span>
      {row.label !== row.id && (
        <span className="text-muted-foreground/50 ml-auto font-mono">@{row.id}</span>
      )}
    </button>
  )

  const renderFileRow = (row: Extract<MentionRow, { kind: 'file' }>, idx: number) => (
    <button
      key={`file:${row.id}`}
      type="button"
      role="listitem"
      data-testid="mention-item"
      data-mention-kind="file"
      data-mention-id={row.id}
      className={rowClass(idx)}
      onMouseEnter={() => setHighlightedIdx(idx)}
      onClick={() => onSelect({ kind: 'file', id: row.id })}
    >
      <Icon name="file-3" className="size-3.5 shrink-0 text-muted-foreground/70" />
      <span className="font-mono truncate">{row.label}</span>
    </button>
  )

  const userOffset = sections.agentRows.length
  const fileOffset = userOffset + sections.userRows.length

  return (
    <div
      ref={ref}
      data-testid="mention-popup"
      className="absolute z-50 rounded-xl bg-popover text-popover-foreground ring-1 ring-foreground/10 shadow-lg overflow-hidden"
      style={{ bottom: POPUP_LIFT, left: position.left, minWidth: '12.5rem' }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div className="px-3 py-1.5 text-[0.625rem] text-muted-foreground/60 uppercase tracking-wide">
        {t('chat.input.mentionHint')}
      </div>
      <Divider inset tone="raised" />
      <div className="max-h-72 overflow-y-auto p-1" role="list">
        {sections.agentRows.length > 0 && (
          <>
            <SectionHeader label={t('chat.mention.sectionAgents')} testId="mention-section-agents" />
            {sections.agentRows.map((row, idx) => renderAgentRow(row, idx))}
          </>
        )}
        {sections.userRows.length > 0 && (
          <>
            <SectionHeader label={t('chat.mention.sectionUsers')} testId="mention-section-users" />
            {sections.userRows.map((row, idx) => renderUserRow(row, userOffset + idx))}
          </>
        )}
        {sections.fileRows.length > 0 && (
          <>
            <SectionHeader label={t('chat.mention.sectionFiles')} testId="mention-section-files" />
            {sections.fileRows.map((row, idx) => renderFileRow(row, fileOffset + idx))}
          </>
        )}
      </div>
    </div>
  )
}

/** Заголовок секции списка («Агенты» / «Пользователи» / «Файлы»). */
function SectionHeader({ label, testId }: { label: string; testId: string }) {
  return (
    <div
      data-testid={testId}
      className="px-2 pt-1.5 pb-0.5 text-[0.625rem] text-muted-foreground/60 uppercase tracking-wide"
    >
      {label}
    </div>
  )
}
