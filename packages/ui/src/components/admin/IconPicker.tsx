import { useState } from 'react'
import { Icon, type IconName } from '@/components/icon/Icon'
import { cn } from '@/lib/utils'
import { useI18n } from '@/lib/i18n'

const ICONS: IconName[] = [
  'admin', 'robot-2', 'code-s-slash', 'code-box', 'search-eye', 'server',
  'shield-keyhole', 'test-tube', 'task', 'chat-new', 'bug', 'tools',
  'lightbulb', 'rocket', 'brain', 'shield-check', 'shield', 'star',
  'heart', 'leaf', 'flask', 'gamepad', 'music', 'camera',
  'smartphone', 'global', 'home', 'briefcase', 'book-open',
  'file-text', 'file-3', 'folder-3', 'database-2', 'terminal-box',
  'cpu', 'git-branch', 'bar-chart-2', 'calendar-schedule',
  'notification-3', 'palette', 'pencil-ai', 'eye', 'search',
  'settings', 'settings-3', 'user-smile', 'attachment-2',
  'send-plane', 'fullscreen', 'layout-left', 'layout-right',
  'checkbox-multiple', 'file-copy', 'folder-add', 'folder-received',
  'refresh', 'delete-bin', 'edit-2', 'check', 'close',
  'alert', 'error-warning', 'stop', 'arrow-go-back',
]

interface IconPickerProps {
  value: string | null
  onChange: (icon: string) => void
}

export const IconPicker = ({ value, onChange }: IconPickerProps) => {
  const { t } = useI18n()
  const [search, setSearch] = useState('')

  const filtered = search
    ? ICONS.filter((i) => i.includes(search.toLowerCase()))
    : ICONS

  return (
    <div className="space-y-2">
      <input
        type="text"
        placeholder={t('admin.iconPicker.searchPlaceholder')}
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        className="w-full px-2.5 py-1 rounded-md border bg-background text-xs focus:outline-none focus:ring-2 focus:ring-ring"
      />
      <div className="flex flex-wrap gap-1 max-h-48 overflow-y-auto">
        {filtered.map((name) => (
          <button
            key={name}
            type="button"
            onClick={() => onChange(name)}
            title={name}
            className={cn(
              'p-1.5 rounded-md border transition-colors',
              value === name
                ? 'border-primary bg-primary/10'
                : 'border-border hover:bg-interactive-hover',
            )}
          >
            <Icon name={name} className="size-4" />
          </button>
        ))}
      </div>
    </div>
  )
}
