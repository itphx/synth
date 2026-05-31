import { useState } from 'react'
import type { StickyNoteData } from '@/lib/api/synthApi'
import { Icon } from '@/components/icon/Icon'

interface StickyNotesPanelProps {
  notes: StickyNoteData[]
  onUpdate: (noteId: string, content: string) => void
  onToggle: (noteId: string, disabled: boolean) => void
  onDelete: (noteId: string) => void
}

export function StickyNotesPanel({ notes, onUpdate, onToggle, onDelete }: StickyNotesPanelProps) {
  const [collapsed, setCollapsed] = useState(true)
  const activeNotes = notes.filter((n) => !n.disabled)

  if (notes.length === 0) return null

  return (
    <div className="shrink-0 mx-2 mt-2 rounded-lg border border-border/60 bg-surface-subtle/50">
      <div className="flex items-center justify-between px-3 py-1.5">
        <button
          onClick={() => setCollapsed(!collapsed)}
          className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
        >
          <Icon
            name={collapsed ? 'arrow-right-s' : 'arrow-down-s'}
            className="size-3"
          />
          <Icon name="pushpin" className="size-3.5 text-amber-600/70 dark:text-amber-400/70" />
          <span>Заметки ({activeNotes.length})</span>
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
          : 'bg-interactive/50'
      }`}
    >
      {editing ? (
        <textarea
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={handleKeyDown}
          onBlur={handleSave}
          className="flex-1 bg-transparent border border-border rounded px-1 py-0.5 text-xs text-foreground outline-none resize-none min-h-[24px]"
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
          className="p-0.5 rounded hover:bg-interactive-hover text-muted-foreground hover:text-foreground"
          title={note.disabled ? 'Включить' : 'Отключить'}
        >
          <Icon name={note.disabled ? 'eye-off' : 'eye'} className="size-3" />
        </button>
        <button
          onClick={() => onDelete(note.id)}
          className="p-0.5 rounded hover:bg-destructive/10 text-muted-foreground hover:text-destructive"
          title="Удалить"
        >
          <Icon name="close" className="size-3" />
        </button>
      </div>
    </div>
  )
}
