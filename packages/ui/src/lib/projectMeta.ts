import type { IconName } from '@/components/icon/icons'
import {
  PROJECT_ICON_KEYS,
  PROJECT_COLOR_KEYS,
  type ProjectIconKey,
  type ProjectColorKey,
} from '@itphx/synth-shared/types'

/**
 * Реестр иконок проектов/сессий. Состав и порядок ключей — строго из shared
 * (`PROJECT_ICON_KEYS`), чтобы UI-регистр не разъезжался с серверной валидацией.
 * `icon` — имя из реестра `components/icon/Icon`.
 */
const ICON_META: Record<ProjectIconKey, { icon: IconName; label: string }> = {
  code:        { icon: 'code-box',          label: 'Code' },
  terminal:    { icon: 'terminal-box',      label: 'Terminal' },
  rocket:      { icon: 'rocket',            label: 'Rocket' },
  flask:       { icon: 'flask',             label: 'Lab' },
  gamepad:     { icon: 'gamepad',           label: 'Game' },
  briefcase:   { icon: 'briefcase',         label: 'Work' },
  home:        { icon: 'home',              label: 'Home' },
  globe:       { icon: 'global',            label: 'Web' },
  leaf:        { icon: 'leaf',              label: 'Nature' },
  shield:      { icon: 'shield',            label: 'Security' },
  palette:     { icon: 'palette',           label: 'Design' },
  server:      { icon: 'server',            label: 'Server' },
  phone:       { icon: 'smartphone',        label: 'Mobile' },
  database:    { icon: 'database-2',        label: 'Data' },
  lightbulb:   { icon: 'lightbulb',         label: 'Idea' },
  music:       { icon: 'music',             label: 'Music' },
  camera:      { icon: 'camera',            label: 'Media' },
  book:        { icon: 'book-open',         label: 'Docs' },
  heart:       { icon: 'heart',             label: 'Favorite' },
  folder:      { icon: 'folder-3',          label: 'Project' },
  chat:        { icon: 'chat-new',          label: 'Chat' },
  cpu:         { icon: 'cpu',               label: 'Agent' },
  file:        { icon: 'file-3',            label: 'File' },
  'file-code': { icon: 'file-code',         label: 'Source' },
  docs:        { icon: 'file-text',         label: 'Docs' },
  task:        { icon: 'task',              label: 'Task' },
  todo:        { icon: 'todo',              label: 'Todo' },
  bug:         { icon: 'bug',               label: 'Bug' },
  robot:       { icon: 'robot-2',           label: 'Robot' },
  brain:       { icon: 'brain',             label: 'AI' },
  git:         { icon: 'git-branch',        label: 'Git' },
  repo:        { icon: 'git-repository',    label: 'Repo' },
  test:        { icon: 'test-tube',         label: 'Test' },
  chart:       { icon: 'bar-chart-2',       label: 'Chart' },
  star:        { icon: 'star',              label: 'Star' },
  image:       { icon: 'image',             label: 'Images' },
  calendar:    { icon: 'calendar-schedule', label: 'Calendar' },
}

export const PROJECT_ICONS: Array<{ key: ProjectIconKey; icon: IconName; label: string }> =
  PROJECT_ICON_KEYS.map((key) => ({ key, ...ICON_META[key] }))

export const PROJECT_ICON_MAP: Record<string, IconName> = Object.fromEntries(
  PROJECT_ICONS.map((i) => [i.key, i.icon]),
)

/**
 * Палитра проектов/сессий. Состав и порядок — из shared `PROJECT_COLOR_KEYS`.
 * `cssVar` — ссылка на CSS-переменную (инлайн-цвет только через переменные).
 */
const COLOR_META: Record<ProjectColorKey, { label: string; cssVar: string }> = {
  keyword: { label: 'Фиолетовый', cssVar: 'var(--syntax-keyword)' },
  string:  { label: 'Зелёный',    cssVar: 'var(--syntax-string)' },
  number:  { label: 'Розовый',    cssVar: 'var(--syntax-number)' },
  type:    { label: 'Золотой',    cssVar: 'var(--syntax-type)' },
  comment: { label: 'Серый',      cssVar: 'var(--syntax-comment)' },
  error:   { label: 'Красный',    cssVar: 'var(--status-error)' },
  primary: { label: 'Синий',      cssVar: 'var(--primary)' },
  success: { label: 'Зелёный',    cssVar: 'var(--status-success)' },
}

export const PROJECT_COLORS: Array<{ key: ProjectColorKey; label: string; cssVar: string }> =
  PROJECT_COLOR_KEYS.map((key) => ({ key, ...COLOR_META[key] }))

export const PROJECT_COLOR_MAP: Record<string, string> = Object.fromEntries(
  PROJECT_COLORS.map((c) => [c.key, c.cssVar]),
)
