import { useState } from 'react'
import type { StickyNoteData } from '@/lib/api/synthApi'
import { Icon } from '@/components/icon/Icon'
import { useI18n } from '@/lib/i18n'
import { useStickyNotesLimitsState } from '@/lib/api/stickyNotesLimits'

interface StickyNotesPanelProps {
  notes: StickyNoteData[]
  onUpdate: (noteId: string, content: string) => void
  onToggle: (noteId: string, disabled: boolean) => void
  onDelete: (noteId: string) => void
}

export function StickyNotesPanel({ notes, onUpdate, onToggle, onDelete }: StickyNotesPanelProps) {
  const { t } = useI18n()
  const [collapsed, setCollapsed] = useState(true)
  const activeNotes = notes.filter((n) => !n.disabled)
  // instance-wide лимиты заметок: счётчик в заголовке и пометка у предела.
  const { limits, loaded } = useStickyNotesLimitsState()
  const atLimit = notes.length >= limits.maxCount

  if (notes.length === 0) return null

  return (
    <div className="shrink-0 mx-2 mt-2 rounded-lg border border-border/60 bg-surface-inset">
      <div className="flex items-center justify-between px-3 py-1.5">
        <button
          onClick={() => setCollapsed(!collapsed)}
          className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
        >
          <Icon
            name={collapsed ? 'arrow-right-s' : 'arrow-down-s'}
            className="size-3"
          />
          <Icon name="pushpin" className="size-3.5 text-status-warning/70" />
          <span data-testid="sticky-notes-counter">
            {loaded
              ? t('chat.notes.panelTitle', {
                  active: activeNotes.length,
                  maxCount: limits.maxCount,
                })
              : t('chat.notes.panelTitlePlain', { active: activeNotes.length })}
          </span>
          {loaded && atLimit && (
            <span
              data-testid="sticky-notes-limit-badge"
              title={t('chat.notes.limitHint', { maxCount: limits.maxCount })}
              className="rounded px-1 py-0.5 text-[0.625rem] font-medium bg-status-warning/15 text-status-warning"
            >
              {t('chat.notes.limitBadge')}
            </span>
          )}
        </button>
      </div>

      {!collapsed && (
        <div className="px-3 pb-2 space-y-1">
          {notes.map((note) => (
            <StickyNoteItem
              key={note.id}
              note={note}
              onUpdate={onUpdate}
              onToggle={onToggle}
              onDelete={onDelete}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function StickyNoteItem({
  note,
  onUpdate,
  onToggle,
  onDelete,
}: {
  note: StickyNoteData
  onUpdate: (noteId: string, content: string) => void
  onToggle: (noteId: string, disabled: boolean) => void
  onDelete: (noteId: string) => void
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(note.content)

  const handleSave = () => {
    const trimmed = draft.trim()
    if (trimmed && trimmed !== note.content) {
      onUpdate(note.id, trimmed)
    }
    setEditing(false)
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSave()
    }
    if (e.key === 'Escape') {
      setDraft(note.content)
      setEditing(false)
    }
  }

  return (
    <div
      className={`flex items-start gap-1.5 rounded px-2 py-1 text-xs group ${
        note.disabled
          ? 'opacity-40'
          : 'bg-surface-card border border-border/20'
      }`}
    >
      {editing ? (
        <textarea
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={handleKeyDown}
          onBlur={handleSave}
          className="flex-1 bg-transparent border border-border rounded px-1 py-0.5 text-xs text-foreground outline-none resize-none min-h-[1.5rem]"
          rows={1}
        />
      ) : (
        <span
          className={`flex-1 cursor-pointer whitespace-pre-wrap break-words ${
            note.disabled ? 'line-through' : ''
          }`}
          onDoubleClick={() => {
            if (note.disabled) return
            setDraft(note.content)
            setEditing(true)
          }}
        >
          {note.content}
        </span>
      )}
      <div className="flex items-center gap-0.5 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
        <button
          onClick={() => onToggle(note.id, !note.disabled)}
          className="inline-flex items-center justify-center p-0.5 rounded hover:bg-interactive-hover text-muted-foreground hover:text-foreground"
          title={note.disabled ? 'Включить' : 'Отключить'}
        >
          <Icon name={note.disabled ? 'eye-off' : 'eye'} className="size-3" />
        </button>
        <button
          onClick={() => onDelete(note.id)}
          className="inline-flex items-center justify-center p-0.5 rounded hover:bg-destructive/10 text-muted-foreground hover:text-destructive"
          title="Удалить"
        >
          <Icon name="close" className="size-3" />
        </button>
      </div>
    </div>
  )
}
