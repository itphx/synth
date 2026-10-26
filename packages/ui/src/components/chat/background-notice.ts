/**
 * ADR-111/ADR-113: уведомление о завершении фонового прогона.
 *
 * Уведомление приходит сообщением роли USER (так его видит модель), поэтому в
 * UI его нельзя рисовать обычным user-пузырём: автор там — текущий
 * пользователь, а не фоновый прогон. Показываем **системным блоком**
 * (`Notice`, как сообщения планировщика), внутри которого — сворачиваемая
 * **карточка результата**: как у результата тула `execute_shell`/`task` в
 * ответе агента (`ToolCallPart`): ряд-детализация (иконка + подпись +
 * длительность), тело — вкладки «Аргументы»/«Результат» с логом/итогом
 * прогона.
 *
 * Конверт `<process …>…</process>` / `<subagent …>…</subagent>` нужен модели,
 * но в UI лишний: в карточке показывается только тело (лог/итог прогона).
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
 * Успешное терминальное состояние прогона.
 *
 * Для шелл-процесса успех в конверте модели обозначен как «exited», в
 * `metadata` — как «completed» (единая нормализация).
 */
export function isBackgroundSuccess(state: BackgroundNoticeState): boolean {
  return state === 'completed';
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
 * Снять конверт модели (`<process …>`/`<subagent …>`) — вернуть тело.
 *
 * Если конверт не распознан — текст возвращается как есть.
 */
export function stripBackgroundEnvelope(content: string): string {
  const full = content.match(ENVELOPE_RE);
  if (full) return full[2] ?? '';
  const partial = content.match(OPEN_ENVELOPE_RE);
  if (partial) return partial[2] ?? '';
  return content;
}

/**
 * Тело уведомления без конверта модели.
 *
 * Снимается внешний конверт (`<process …>`/`<subagent …>`) и обёртка `<summary>`
 * (её использует уведомление о саб-агентате). Если конверт не распознан —
 * текст возвращается как есть.
 */
export function extractBackgroundBody(content: string): string {
  return stripSummary(stripBackgroundEnvelope(content));
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

/** Строка из `metadata` (непустая). */
function metaString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/**
 * Данные карточки результата фонового прогона — та же форма, что у
 * `ToolCallPart` (результат тула в ответе агента).
 */
export interface BackgroundToolCall {
  /** Имя тула-источника: `execute_shell` (процесс) / `task` (саб-агент). */
  name: string;
  /** Аргументы карточки (команда/рабочий каталог либо описание). */
  args: Record<string, unknown>;
  /** Результат — тело прогона без конверта модели. */
  result: { content: string; isError?: boolean };
  /** Статус вызова (прогон завершён — карточка не «бежит»). */
  status: 'done';
  /** Начало прогона (ISO-8601) — для длительности в шапке карточки. */
  startedAt?: string;
  /** Финиш прогона (ISO-8601) — для длительности в шапке карточки. */
  completedAt?: string;
}

/**
 * Собрать данные карточки результата фонового прогона.
 *
 * `kind:'process'` → карточка результата `execute_shell` (аргументы — команда
 * и рабочий каталог, тело — хвост лога). `kind:'subagent'` → карточка
 * результата `task` (аргументы — описание, тело — итог саб-агента).
 */
export function backgroundToolCall(
  metadata: Record<string, unknown> | null | undefined,
  content: string,
): BackgroundToolCall {
  const kind = resolveBackgroundKind(metadata);
  const state = resolveBackgroundState(metadata);
  const body = extractBackgroundBody(content);
  const startedAt = metaString(metadata?.started_at);
  const completedAt = metaString(metadata?.finished_at);
  const isError = !isBackgroundSuccess(state);

  if (kind === 'subagent') {
    return {
      name: 'task',
      args: { description: metaString(metadata?.description) ?? '' },
      result: { content: body, isError },
      status: 'done',
      ...(startedAt ? { startedAt } : {}),
      ...(completedAt ? { completedAt } : {}),
    };
  }

  return {
    name: 'execute_shell',
    args: {
      command: metaString(metadata?.command) ?? '',
      cwd: metaString(metadata?.cwd) ?? '',
    },
    result: { content: body, isError },
    status: 'done',
    ...(startedAt ? { startedAt } : {}),
    ...(completedAt ? { completedAt } : {}),
  };
}
