import type { IconName } from '@/components/icon/icons'
import { normalizeIconKey, normalizeColorKey } from '@itphx/synth-shared/schemas'
import { PROJECT_ICON_MAP, PROJECT_COLOR_MAP } from '@/lib/projectMeta'

/**
 * Единый резолвер иконки сущности (проект/сессия) из серверного значения.
 *
 * Сервер хранит канонический ключ реестра (`PROJECT_ICON_KEYS`, AD-075). Всё, что
 * не является каноническим ключом (старое значение, эмодзи, произвольная строка,
 * `null`/`undefined`), даёт `undefined` — вызывающий код подставляет свой фоллбек
 * (`?? 'folder-3'`), а не рендерит «дырку» (`<Icon name={rawKey}>` → `null`).
 */
export function resolveIconName(value?: string | null): IconName | undefined {
  const key = normalizeIconKey(value)
  return key ? PROJECT_ICON_MAP[key] : undefined
}

/**
 * Единый резолвер цвета сущности: канонический ключ палитры (или legacy-алиас)
 * → CSS-переменная для инлайн-стиля; всё прочее → `undefined`.
 */
export function resolveIconColor(value?: string | null): string | undefined {
  const key = normalizeColorKey(value)
  return key ? PROJECT_COLOR_MAP[key] : undefined
}
