/**
 * Контекст терминала, приходящий с клиента **вместе с вопросом**
 * (`POST /api/v2/sessions/:id/prompt`, необязательное поле `context`).
 *
 * ## Зачем
 *
 * Клиент (UI/шлюз) может держать открытый интерактивный терминал и вместе с
 * вопросом прислать вывод этого терминала. Контекст доставляется **одним
 * запросом**: сервер кладёт его в историю **перед** вопросом, и модель видит
 * вывод терминала в том же ходе, что и сам вопрос.
 *
 * ## Формат
 *
 * Текст сообщения — **ровно тот же**, что у тула `terminal_read`: обрамление
 * `[CONTENT …]` … `[CONTENT END]` (`frameTerminalOutput`), атрибуты открывающего
 * маркера — только непустые. Нормализацию переводов строк и хвостовых пустых
 * строк делает сам `frameTerminalOutput` (`normalizeTerminalOutput`).
 *
 * ## Служебность
 *
 * Сообщение — **служебное** user-сообщение (`metadata.type =
 * 'background_run_result'`): это не реплика человека, поэтому оно не считается
 * репликой пользователя (авто-заголовок сессии, статистика реплик, границы
 * хода) — см. `sessions/user-messages.ts`.
 *
 * `metadata.kind = 'terminal'` называет вид служебного сообщения, а
 * `metadata.terminal_context = true` — **именно контекст** терминала: тот же
 * `kind` носит и уведомление о завершении команды в терминале
 * (`engine/terminal/runs.ts`), и по одному `kind` их не различить.
 *
 * ## Границы
 *
 * - **Предел вывода — 32 КиБ** (`MAX_TERMINAL_CONTEXT_BYTES`, UTF-8): вывод
 *   терминала не должен съедать бюджет контекста модели. Проверка — на границе
 *   (`parseTerminalContext`), до любой записи в историю.
 * - **Валидация — fail-closed**: невалидный контекст = `400 VALIDATION_ERROR`
 *   без частичной доставки (ни контекста, ни вопроса в историю не попадает).
 * - **Лишние поля тела игнорируются** — контракт расширяем аддитивно.
 */

import { MessageRole, generateId, makeTextPart, nowISO } from '@itphx/synth-shared';
import type { Message } from '@itphx/synth-shared';
import { frameTerminalOutput, normalizeTerminalOutput } from './output.js';

/**
 * Предел вывода терминала в контексте вопроса — 32 КиБ (UTF-8).
 *
 * Совпадает с капой `terminal_read` (`MAX_OUTPUT_BYTES` в
 * `engine/tools/terminals.ts`) и с пределом уведомления о фоновом запуске
 * (`MAX_RUN_NOTIFICATION_BYTES` в `engine/terminal/runs.ts`).
 */
export const MAX_TERMINAL_CONTEXT_BYTES = 32 * 1024;

/** Статусы терминала, допустимые в контексте. */
export const TERMINAL_CONTEXT_STATUSES = ['starting', 'running', 'exited'] as const;

/** Статус терминала в контексте (`starting` | `running` | `exited`). */
export type TerminalContextStatus = (typeof TERMINAL_CONTEXT_STATUSES)[number];

/** Разобранный контекст терминала (нормализованный вид). */
export interface TerminalContextInput {
  /** id терминала (`term_…`) — обязательное поле. */
  terminal_id: string;
  /** Сырой вывод терминала (нормализуется при обрамлении). */
  content: string;
  /** Рабочий каталог терминала. */
  cwd?: string;
  /** Оболочка терминала. */
  shell?: string;
  /** Статус терминала на момент снятия вывода. */
  status?: TerminalContextStatus;
  /** Сколько строк вывода реально передано. */
  lines?: number;
  /** Признак усечения вывода. */
  truncated?: boolean;
}

/** Результат разбора поля `context` тела промпта. */
export type TerminalContextParseResult =
  | { ok: true; value: TerminalContextInput }
  | { ok: false; message: string };

/**
 * Собрать служебное сообщение с контекстом терминала.
 *
 * Текст — обрамление `[CONTENT …]` … `[CONTENT END]` (как у `terminal_read`).
 * Атрибуты открывающего маркера — только непустые: `terminal`, `status`,
 * `cwd`, `shell`, `lines`, `bytes`. `bytes` — размер **нормализованного** вывода
 * в UTF-8 (как у `terminal_read`).
 *
 * `id` — `generateId`; `seq` — 0 (порядковый номер проставит порт хранения при
 * материализации записи в историю).
 */
export function buildTerminalContextMessage(input: TerminalContextInput): Message {
  const body = normalizeTerminalOutput(input.content);
  const bytes = Buffer.byteLength(body, 'utf8');
  const content = frameTerminalOutput(input.content, {
    terminal: input.terminal_id,
    ...(input.status ? { status: input.status } : {}),
    ...(input.cwd ? { cwd: input.cwd } : {}),
    ...(input.shell ? { shell: input.shell } : {}),
    ...(input.lines !== undefined ? { lines: input.lines } : {}),
    bytes,
  });
  return {
    id: generateId(),
    role: MessageRole.USER,
    seq: 0,
    origin: 'local',
    parts: [makeTextPart(content)],
    content,
    createdAt: nowISO(),
    disabled: false,
    pinned: false,
    hidden: false,
    author: 'Terminal',
    metadata: {
      // Служебное сообщение (`isServiceUserMessage`): не реплика человека.
      type: 'background_run_result',
      kind: 'terminal',
      // Явный маркер «это контекст терминала»: уведомление о завершении
      // команды в терминале (`engine/terminal/runs.ts`) несёт тот же
      // `kind:'terminal'`, но без маркера — по нему UI отличает контекст
      // (карточка `terminal_read`) от уведомления о запуске (карточка
      // `execute_shell`).
      terminal_context: true,
      state: 'completed',
      terminal_id: input.terminal_id,
      ...(input.cwd ? { cwd: input.cwd } : {}),
      ...(input.shell ? { shell: input.shell } : {}),
      ...(input.lines !== undefined ? { lines: input.lines } : {}),
      bytes,
      ...(input.status ? { status: input.status } : {}),
      ...(input.truncated !== undefined ? { truncated: input.truncated } : {}),
    },
  };
}

/**
 * Разобрать поле `context` тела промпта.
 *
 * Проверяются: тип объекта, непустой `terminal_id`, строковый `content` и его
 * размер (≤ 32 КиБ UTF-8), строковые `cwd`/`shell`, `status` из списка,
 * целое неотрицательное `lines`, булево `truncated`. Лишние поля игнорируются.
 *
 * Невалидный контекст — `{ ok: false, message }`: вызывающий отвечает
 * `400 VALIDATION_ERROR` **до** любой записи в историю/очередь.
 */
export function parseTerminalContext(raw: unknown): TerminalContextParseResult {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, message: 'Поле context должно быть объектом' };
  }
  const source = raw as Record<string, unknown>;

  const terminalId = source.terminal_id;
  if (typeof terminalId !== 'string' || terminalId.trim() === '') {
    return {
      ok: false,
      message: 'Поле context.terminal_id обязательно и должно быть непустой строкой',
    };
  }

  const content = source.content;
  if (typeof content !== 'string') {
    return { ok: false, message: 'Поле context.content должно быть строкой' };
  }
  const bytes = Buffer.byteLength(content, 'utf8');
  if (bytes > MAX_TERMINAL_CONTEXT_BYTES) {
    return {
      ok: false,
      message: `Поле context.content больше ${MAX_TERMINAL_CONTEXT_BYTES} байт (${bytes})`,
    };
  }

  const value: TerminalContextInput = {
    terminal_id: terminalId.trim(),
    content,
  };

  if (source.cwd !== undefined) {
    if (typeof source.cwd !== 'string') {
      return { ok: false, message: 'Поле context.cwd должно быть строкой' };
    }
    const cwd = source.cwd.trim();
    if (cwd) value.cwd = cwd;
  }

  if (source.shell !== undefined) {
    if (typeof source.shell !== 'string') {
      return { ok: false, message: 'Поле context.shell должно быть строкой' };
    }
    const shell = source.shell.trim();
    if (shell) value.shell = shell;
  }

  if (source.status !== undefined) {
    if (
      typeof source.status !== 'string'
      || !(TERMINAL_CONTEXT_STATUSES as readonly string[]).includes(source.status)
    ) {
      return {
        ok: false,
        message: `Поле context.status должно быть одним из: ${TERMINAL_CONTEXT_STATUSES.join(', ')}`,
      };
    }
    value.status = source.status as TerminalContextStatus;
  }

  if (source.lines !== undefined) {
    if (typeof source.lines !== 'number' || !Number.isInteger(source.lines) || source.lines < 0) {
      return {
        ok: false,
        message: 'Поле context.lines должно быть целым неотрицательным числом',
      };
    }
    value.lines = source.lines;
  }

  if (source.truncated !== undefined) {
    if (typeof source.truncated !== 'boolean') {
      return { ok: false, message: 'Поле context.truncated должно быть булевым' };
    }
    value.truncated = source.truncated;
  }

  return { ok: true, value };
}
