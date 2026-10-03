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
 * Палитра проектов/сессий — 16 цветов темы (`PROJECT_COLOR_KEYS` = `a1..a16`).
 * `labelKey` — i18n-ключ подписи (`entityColor.<key>`); `cssVar` — ссылка на
 * CSS-переменную `--palette-<index+1>` (инлайн-цвет только через переменные).
 * Порядок ключей совпадает с `palette.colors`.
 */
const COLOR_META: Record<ProjectColorKey, { labelKey: string; cssVar: string }> = {
  a1:  { labelKey: 'entityColor.a1',  cssVar: 'var(--palette-1)' },
  a2:  { labelKey: 'entityColor.a2',  cssVar: 'var(--palette-2)' },
  a3:  { labelKey: 'entityColor.a3',  cssVar: 'var(--palette-3)' },
  a4:  { labelKey: 'entityColor.a4',  cssVar: 'var(--palette-4)' },
  a5:  { labelKey: 'entityColor.a5',  cssVar: 'var(--palette-5)' },
  a6:  { labelKey: 'entityColor.a6',  cssVar: 'var(--palette-6)' },
  a7:  { labelKey: 'entityColor.a7',  cssVar: 'var(--palette-7)' },
  a8:  { labelKey: 'entityColor.a8',  cssVar: 'var(--palette-8)' },
  a9:  { labelKey: 'entityColor.a9',  cssVar: 'var(--palette-9)' },
  a10: { labelKey: 'entityColor.a10', cssVar: 'var(--palette-10)' },
  a11: { labelKey: 'entityColor.a11', cssVar: 'var(--palette-11)' },
  a12: { labelKey: 'entityColor.a12', cssVar: 'var(--palette-12)' },
  a13: { labelKey: 'entityColor.a13', cssVar: 'var(--palette-13)' },
  a14: { labelKey: 'entityColor.a14', cssVar: 'var(--palette-14)' },
  a15: { labelKey: 'entityColor.a15', cssVar: 'var(--palette-15)' },
  a16: { labelKey: 'entityColor.a16', cssVar: 'var(--palette-16)' },
}

export const PROJECT_COLORS: Array<{ key: ProjectColorKey; labelKey: string; cssVar: string }> =
  PROJECT_COLOR_KEYS.map((key) => ({ key, ...COLOR_META[key] }))

export const PROJECT_COLOR_MAP: Record<string, string> = Object.fromEntries(
  PROJECT_COLORS.map((c) => [c.key, c.cssVar]),
)
