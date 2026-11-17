/**
 * PROP-141 (Часть D): уведомление о переносе сессии между проектами.
 *
 * Ядро (`packages/core/src/sessions/move-service.ts`) кладёт в историю
 * корневой сессии служебное сообщение `role: 'user'`, `author: 'Session'`,
 * `metadata.type === 'session_moved'` с фактами переноса:
 * `from_project_id`/`to_project_id`, `effects[]` (что остановили/закрыли/
 * отменили) и `moved_sessions` (id поддерева). Ход при этом **не запускается**.
 *
 * Здесь — разбор метаданных и локализация эффектов: тело `Notice` — список
 * последствий переноса человеческим языком (fallback — конверт `content`).
 */

/** Эффект переноса в форме UI (зеркало `SessionMoveEffect` ядра). */
export interface SessionMoveEffectDto {
  kind: string
  action: string
  id?: string
  name?: string
}

/**
 * Ключ i18n по виду и действию эффекта.
 *
 * `session:moved` разбирается отдельно (эффектов столько же, сколько
 * перенесено сессий, — их сворачиваем в одну строку со счётчиком).
 */
const EFFECT_KEYS: Record<string, string> = {
  'process:stopped': 'chat.notice.sessionMovedEffects.processStopped',
  'subagent:stopped': 'chat.notice.sessionMovedEffects.subagentStopped',
  'terminal:closed': 'chat.notice.sessionMovedEffects.terminalClosed',
  'terminal:left_in_old_project': 'chat.notice.sessionMovedEffects.terminalLeft',
  'timer:cancelled': 'chat.notice.sessionMovedEffects.timerCancelled',
  'alarm:cancelled': 'chat.notice.sessionMovedEffects.alarmCancelled',
  'schedule:disabled': 'chat.notice.sessionMovedEffects.scheduleDisabled',
  'worktree:detached': 'chat.notice.sessionMovedEffects.worktreeDetached',
  'session:reattributed': 'chat.notice.sessionMovedEffects.sessionReattributed',
}

/**
 * Эффекты переноса из метаданных сообщения.
 *
 * Метаданные приходят извне (DTO/история) — разбор defensive: не-массив,
 * не-объект или запись без `kind`/`action` пропускаются.
 */
export function sessionMovedEffects(
  metadata: Record<string, unknown> | null | undefined,
): SessionMoveEffectDto[] {
  const raw = metadata?.effects
  if (!Array.isArray(raw)) return []
  const effects: SessionMoveEffectDto[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const effect = item as Record<string, unknown>
    if (typeof effect.kind !== 'string' || typeof effect.action !== 'string') continue
    effects.push({
      kind: effect.kind,
      action: effect.action,
      ...(typeof effect.id === 'string' ? { id: effect.id } : {}),
      ...(typeof effect.name === 'string' ? { name: effect.name } : {}),
    })
  }
  return effects
}

/** Переводчик i18n (сигнатура как у `useI18n().t`). */
type Translate = (key: string, params?: Record<string, string | number | boolean | null | undefined>) => string

/**
 * Локализованные строки эффектов переноса.
 *
 * Неизвестный эффект показывается как есть (`вид.действие id`) — факт
 * переноса не должен теряться из-за отсутствия перевода.
 */
export function sessionMovedEffectLines(
  effects: SessionMoveEffectDto[],
  t: Translate,
): string[] {
  const lines: string[] = []
  let movedCount = 0

  const flushMoved = () => {
    if (movedCount === 0) return
    lines.push(t('chat.notice.sessionMovedEffects.moved', { count: movedCount }))
    movedCount = 0
  }

  for (const effect of effects) {
    if (effect.kind === 'session' && effect.action === 'moved') {
      movedCount += 1
      continue
    }
    flushMoved()
    const key = EFFECT_KEYS[`${effect.kind}:${effect.action}`]
    if (key) {
      lines.push(t(key, { id: effect.id ?? '' }))
      continue
    }
    lines.push(`${effect.kind}.${effect.action}${effect.id ? ` ${effect.id}` : ''}`)
  }
  flushMoved()

  return lines
}
