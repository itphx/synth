/**
 * ADR-111/ADR-113: уведомление о завершении фонового прогона — служебный
 * (системный) блок в чате.
 *
 * Уведомление приходит сообщением роли USER (так его видит модель), поэтому в
 * UI его нельзя рисовать обычным user-пузырём: автор там — текущий
 * пользователь, а не фоновый прогон. Показываем системным блоком (как
 * сообщения планировщика, ADR-051).
 *
 * Конверт `<process …>…</process>` / `<subagent …>…</subagent>` нужен модели, но
 * в UI лишний: в блоке показывается только тело (лог/итог прогона).
 */

/** Вид фонового прогона. */
export type BackgroundNoticeKind = 'process' | 'subagent';

/** Терминальное состояние фонового прогона. */
export type BackgroundNoticeState = 'completed' | 'failed' | 'cancelled';

/** Максимальная длина имени прогона в подписи блока. */
const MAX_NAME_LENGTH = 80;

/**
 * Конверт целиком: `<process …>…</process>` / `<subagent …>…</subagent>`.
 * Захватывает тело (группа 2).
 */
const ENVELOPE_RE = /^\s*<(process|subagent)\b[^>]*>\n?([\s\S]*?)\n?<\/\1>\s*$/;

/**
 * Конверт без закрывающего тега: live-событие `message.added` несёт контент,
 * усечённый до 500 символов, поэтому закрывающего тега может не быть.
 */
const OPEN_ENVELOPE_RE = /^\s*<(process|subagent)\b[^>]*>\n?([\s\S]*)$/;

/** Вид прогона по `metadata.kind` (неизвестное → `process`). */
export function resolveBackgroundKind(
  metadata: Record<string, unknown> | null | undefined,
): BackgroundNoticeKind {
  return metadata?.kind === 'subagent' ? 'subagent' : 'process';
}

/** Терминальное состояние по `metadata.state` (неизвестное → `completed`). */
export function resolveBackgroundState(
  metadata: Record<string, unknown> | null | undefined,
): BackgroundNoticeState {
  const state = metadata?.state;
  if (state === 'failed' || state === 'cancelled') return state;
  return 'completed';
}

/**
 * Имя прогона для подписи: команда (процесс) или описание (саб-агент).
 * Длинные значения обрезаются — подпись не должна ломать вёрстку.
 */
export function backgroundNoticeName(
  metadata: Record<string, unknown> | null | undefined,
  kind: BackgroundNoticeKind,
): string {
  const raw =
    kind === 'subagent'
      ? typeof metadata?.description === 'string'
        ? metadata.description
        : ''
      : typeof metadata?.command === 'string'
        ? metadata.command
        : '';
  const name = raw.trim();
  if (name.length <= MAX_NAME_LENGTH) return name;
  return `${name.slice(0, MAX_NAME_LENGTH - 1)}…`;
}

/**
 * Тело уведомления без конверта модели.
 *
 * Снимается внешний конверт (`<process …>`/`<subagent …>`) и обёртка `<summary>`
 * (её использует уведомление о саб-агентате). Если конверт не распознан —
 * текст возвращается как есть.
 */
export function extractBackgroundBody(content: string): string {
  const full = content.match(ENVELOPE_RE);
  if (full) return stripSummary(full[2] ?? '');
  const partial = content.match(OPEN_ENVELOPE_RE);
  if (partial) return stripSummary(partial[2] ?? '');
  return content;
}

/** Снять обёртку `<summary>…</summary>` (в уведомлении о саб-агентате). */
function stripSummary(body: string): string {
  const trimmed = body.trim();
  if (!trimmed.startsWith('<summary>')) return trimmed;
  return trimmed
    .slice('<summary>'.length)
    .replace(/<\/summary>\s*$/, '')
    .trim();
}
