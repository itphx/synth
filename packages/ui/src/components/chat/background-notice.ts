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

/**
 * Вид служебного блока по результату фоновой работы.
 *
 * `terminal` — сообщение-контекст терминала (PROP-132, Ф4б): сервер сохраняет
 * его отдельным сообщением **до** вопроса агента, в UI это карточка вывода
 * терминала, а не «фоновый процесс». Отличается маркером
 * `metadata.terminal_context === true` (у уведомления о завершении команды
 * в терминале маркера нет — это фоновый процесс).
 */
export type BackgroundNoticeKind = 'process' | 'subagent' | 'terminal';

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

/**
 * Конверт контекста терминала.
 *
 * Канонический вид backend'а (`frameTerminalOutput`): открывающий маркер
 * `[CONTENT key=value …]` и закрывающий **`[CONTENT END]`**. Закрывающий
 * `[/CONTENT]` — на всякий случай (прежний вариант), как и прежний конверт
 * `<terminal_context …>…</terminal_context>`.
 *
 * В UI конверт лишний — в карточке только сам вывод.
 *
 * `(?!\s*END\])` в открывающем маркере: закрывающий `[CONTENT END]` не должен
 * приниматься за открывающий (иначе пустой конверт съел бы весь текст).
 */
const TERMINAL_ENVELOPE_RES = [
  /^\s*\[CONTENT(?!\s*END\])[^\]]*\]\r?\n?([\s\S]*?)\r?\n?\[CONTENT END\]\s*$/,
  /^\s*\[CONTENT(?!\s*END\])[^\]]*\]\r?\n?([\s\S]*?)\r?\n?\[\/CONTENT\]\s*$/,
  /^\s*<terminal_context\b[^>]*>\r?\n?([\s\S]*?)\r?\n?<\/terminal_context>\s*$/,
];

/** Конверт контекста терминала без закрывающего маркера (обрезанный контент). */
const OPEN_TERMINAL_ENVELOPE_RES = [
  /^\s*\[CONTENT(?!\s*END\])[^\]]*\]\r?\n?([\s\S]*)$/,
  /^\s*<terminal_context\b[^>]*>\r?\n?([\s\S]*)$/,
];

/**
 * Вид прогона по `metadata` (неизвестное → `process`).
 *
 * `terminal` — **только** сообщение-контекст терминала (PROP-132, Ф4б):
 * сервер помечает его явным маркером `metadata.terminal_context === true`
 * рядом с `kind:'terminal'`. Уведомление о завершении команды в терминале
 * (`engine/terminal/runs.ts`) носит **тот же** `kind:'terminal'`, но маркера
 * не имеет — значит, это обычный фоновый процесс (карточка `execute_shell`),
 * а не вывод терминала (карточка `terminal_read`).
 */
export function resolveBackgroundKind(
  metadata: Record<string, unknown> | null | undefined,
): BackgroundNoticeKind {
  if (metadata?.kind === 'terminal' && metadata?.terminal_context === true) return 'terminal';
  return metadata?.kind === 'subagent' ? 'subagent' : 'process';
}

/**
 * Сколько строк вывода терминала ушло в контекст (`metadata.lines`).
 *
 * `undefined` — строки неизвестны (подпись без счётчика).
 */
export function backgroundTerminalLines(
  metadata: Record<string, unknown> | null | undefined,
): number | undefined {
  const lines = metadata?.lines;
  return typeof lines === 'number' && Number.isFinite(lines) ? lines : undefined;
}

/**
 * Снять конверт контекста терминала — вернуть сам вывод.
 *
 * Закрывающий маркер backend'а — `[CONTENT END]` (канон); `[/CONTENT]` и
 * `<terminal_context …>` принимаются для совместимости. Если конверт не
 * распознан — текст возвращается как есть.
 */
export function extractTerminalContent(content: string): string {
  const trimmed = content.trim();
  for (const re of TERMINAL_ENVELOPE_RES) {
    const full = trimmed.match(re);
    if (full) return full[1] ?? '';
  }
  for (const re of OPEN_TERMINAL_ENVELOPE_RES) {
    const partial = trimmed.match(re);
    if (partial) return partial[1] ?? '';
  }
  return content;
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
 *
 * Для контекста терминала — **число строк** вывода (без слова: слово
 * подставляет локализованная подпись `chat.notice.terminalContextLines`).
 * Длинные значения обрезаются — подпись не должна ломать вёрстку.
 */
export function backgroundNoticeName(
  metadata: Record<string, unknown> | null | undefined,
  kind: BackgroundNoticeKind,
): string {
  if (kind === 'terminal') {
    const lines = backgroundTerminalLines(metadata);
    return lines === undefined ? '' : String(lines);
  }
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
 * ADR-111/ADR-113: ретранслированное уведомление — подпись «где запускалось».
 * `undefined` — обычное (неретранслированное) уведомление.
 */
export function backgroundNoticeRelayedFrom(
  metadata: Record<string, unknown> | null | undefined,
): string | undefined {
  if (metadata?.relayed !== true) return undefined;
  return metaString(metadata.relayed_from_title)
    ?? metaString(metadata.relayed_from_session_id);
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
 * `kind:'terminal'` → карточка `terminal_read` (аргументы — терминал, каталог
 * и оболочка, тело — вывод терминала без конверта `[CONTENT …]…[CONTENT END]`).
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

  if (kind === 'terminal') {
    // Контекст терминала: конверт модели (`[CONTENT …]…[CONTENT END]`) в UI лишний.
    const output = extractTerminalContent(content) || metaString(metadata?.content) || '';
    return {
      name: 'terminal_read',
      args: {
        terminal_id: metaString(metadata?.terminal_id) ?? '',
        cwd: metaString(metadata?.cwd) ?? '',
        shell: metaString(metadata?.shell) ?? '',
      },
      result: { content: output, isError: false },
      status: 'done',
    };
  }

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
