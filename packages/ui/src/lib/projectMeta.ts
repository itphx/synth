import type { IconName } from '@/components/icon/icons'

export const PROJECT_ICONS: Array<{ key: string; icon: IconName; label: string }> = [
  { key: 'code',      icon: 'code-box',      label: 'Code' },
  { key: 'terminal',  icon: 'terminal-box',   label: 'Terminal' },
  { key: 'rocket',    icon: 'rocket',        label: 'Rocket' },
  { key: 'flask',     icon: 'flask',         label: 'Lab' },
  { key: 'gamepad',   icon: 'gamepad',       label: 'Game' },
  { key: 'briefcase', icon: 'briefcase',     label: 'Work' },
  { key: 'home',      icon: 'home',          label: 'Home' },
  { key: 'globe',     icon: 'global',        label: 'Web' },
  { key: 'leaf',      icon: 'leaf',          label: 'Nature' },
  { key: 'shield',    icon: 'shield',        label: 'Security' },
  { key: 'palette',   icon: 'palette',       label: 'Design' },
  { key: 'server',    icon: 'server',        label: 'Server' },
  { key: 'phone',     icon: 'smartphone',    label: 'Mobile' },
  { key: 'database',  icon: 'database-2',     label: 'Data' },
  { key: 'lightbulb', icon: 'lightbulb',     label: 'Idea' },
  { key: 'music',     icon: 'music',         label: 'Music' },
  { key: 'camera',    icon: 'camera',        label: 'Media' },
  { key: 'book',      icon: 'book-open',      label: 'Docs' },
  { key: 'heart',     icon: 'heart',         label: 'Favorite' },
]

export const PROJECT_ICON_MAP: Record<string, IconName> = Object.fromEntries(
  PROJECT_ICONS.map((i) => [i.key, i.icon])
)

export const PROJECT_COLORS: Array<{ key: string; label: string; cssVar: string }> = [
  { key: 'keyword',  label: 'Фиолетовый', cssVar: 'var(--syntax-keyword)' },
  { key: 'string',   label: 'Зелёный',    cssVar: 'var(--syntax-string)' },
  { key: 'number',   label: 'Розовый',    cssVar: 'var(--syntax-number)' },
  { key: 'type',     label: 'Золотой',    cssVar: 'var(--syntax-type)' },
  { key: 'comment',  label: 'Серый',      cssVar: 'var(--syntax-comment)' },
  { key: 'error',    label: 'Красный',    cssVar: 'var(--status-error)' },
  { key: 'primary',  label: 'Синий',      cssVar: 'var(--primary)' },
  { key: 'success',  label: 'Зелёный',    cssVar: 'var(--status-success)' },
]

export const PROJECT_COLOR_MAP: Record<string, string> = Object.fromEntries(
  PROJECT_COLORS.map((c) => [c.key, c.cssVar])
)
