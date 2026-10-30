import type { Message, Project, Session } from '@itphx/synth-shared';
import { MessageRole } from '@itphx/synth-shared';
import type { SessionManager } from '../sessions/manager.js';
import type { SettingsRepository } from './ports/settings-repository.js';
import type { SessionProjectStoreLike } from '../sessions/manager.js';
import { warning } from '../logger.js';

/** Маркер разовой миграции снапшотов скоупа (идемпотентность). */
export const SESSION_SCOPE_SNAPSHOT_MIGRATION = 'session-scope-snapshots-v1';

export interface SessionScopeMigrationDeps {
  sessionManager: SessionManager;
  projectStore?: SessionProjectStoreLike;
  settingsStore: SettingsRepository;
  /** Системные дефолты для сессий без проекта (или проекта без настроек). */
  resolveSystemDefaults?: () => Promise<{ mcpDefaultOn?: string[]; skillsDefaultOn?: string[] } | undefined>;
}

/**
 * ADR-071 §2.4 / ADR-046 §4.5: разовая идемпотентная миграция. Материализует
 * снапшоты `mcpDefaultOn`/`skillsDefaultOn` у существующих сессий:
 * `project.mcp/skills.defaultOn` (при наличии настроек проекта) либо системный
 * дефолт. Guard — маркер `migrations.session-scope-snapshots-v1` в runtime settings.
 *
 * @returns число обновлённых сессий (0 — миграция уже выполнялась).
 */
export async function migrateSessionScopeSnapshots(deps: SessionScopeMigrationDeps): Promise<number> {
  if (await deps.settingsStore.getMigrationMarker(SESSION_SCOPE_SNAPSHOT_MIGRATION)) return 0;

  // ADR-089: миграция должна видеть и архивированные сессии (архив не влияет на скоуп).
  // Лёгкая выборка: для отбора кандидатов нужны только `settings`/`projectId`;
  // уже мигрированные сессии не читают историю вовсе.
  const sessions = await deps.sessionManager.listSessions(undefined, { includeArchived: true, light: true });
  const projects = new Map<string, Project | null>();
  let systemDefaults: { mcpDefaultOn?: string[]; skillsDefaultOn?: string[] } | undefined;
  const getSystemDefaults = async () => {
    if (systemDefaults === undefined && deps.resolveSystemDefaults) {
      systemDefaults = await deps.resolveSystemDefaults().catch(() => undefined) ?? {};
    }
    return systemDefaults ?? {};
  };
  const loadProject = async (id: string): Promise<Project | null> => {
    if (!deps.projectStore) return null;
    if (projects.has(id)) return projects.get(id) ?? null;
    const project = await deps.projectStore.load(id).catch(() => null);
    projects.set(id, project);
    return project;
  };

  let updated = 0;
  for (const session of sessions) {
    let mcpDefaultOn = session.settings.mcpDefaultOn;
    let skillsDefaultOn = session.settings.skillsDefaultOn;
    if (mcpDefaultOn !== undefined && skillsDefaultOn !== undefined) continue;

    const project: Project | null = session.projectId ? await loadProject(session.projectId) : null;
    if (mcpDefaultOn === undefined) mcpDefaultOn = project?.mcp?.defaultOn;
    if (skillsDefaultOn === undefined) skillsDefaultOn = project?.skills?.defaultOn;
    if (mcpDefaultOn === undefined || skillsDefaultOn === undefined) {
      const sys = await getSystemDefaults();
      if (mcpDefaultOn === undefined) mcpDefaultOn = sys.mcpDefaultOn;
      if (skillsDefaultOn === undefined) skillsDefaultOn = sys.skillsDefaultOn;
    }
    if (mcpDefaultOn === undefined && skillsDefaultOn === undefined) continue;

    // `saveSession` перезаписывает сессию целиком (включая `messages`), поэтому
    // обновляем только полную запись — лёгкая (`listLight`) потеряла бы историю.
    const full = await deps.sessionManager.getSession(session.id);
    if (!full) continue;

    const updatedSession: Session = {
      ...full,
      settings: {
        ...full.settings,
        ...(mcpDefaultOn !== undefined ? { mcpDefaultOn } : {}),
        ...(skillsDefaultOn !== undefined ? { skillsDefaultOn } : {}),
      },
    };
    await deps.sessionManager.saveSession(updatedSession);
    updated++;
  }

  await deps.settingsStore.setMigrationMarker(SESSION_SCOPE_SNAPSHOT_MIGRATION);
  return updated;
}

// ── ADR-118: миграция данных к модели «ход как последовательность шагов» ──

/**
 * Маркер разовой миграции данных к модели сообщений v2 (ADR-118 §9).
 * Идемпотентность — по этому маркеру в runtime-настройках; дополнительно
 * сама миграция построчно сравнивает текущие значения с планом и ничего не
 * меняет, если значения уже проставлены.
 */
export const MESSAGE_STREAM_V2_MIGRATION = 'message-stream-v2';

/** План миграции одного сообщения (ADR-118 §9). */
export interface MessageStreamMigrationPlan {
  /** Позиция сообщения в истории сессии (0-based). */
  index: number;
  /** Id сообщения (в legacy-данных id могут повторяться — опора на `index`). */
  messageId: string;
  /** Монотонный порядок записи (ADR-118 §2). */
  ord: number;
  /** Идентификатор хода (`turn_<sessionId>_<n>`). */
  turnId: string;
  /** Индекс шага внутри хода (только у assistant-сообщений). */
  stepIndex?: number;
}

/** Зависимости миграции данных ADR-118. */
export interface MessageStreamMigrationDeps {
  sessionManager: SessionManager;
  settingsStore: SettingsRepository;
}

/**
 * Признаки итерации (номера шага LLM-вызова) в персисте сообщения.
 *
 * ADR-118 §9: старые ответы разбиваются по уже персистящимся признакам
 * итерации — `tool_calls[].iteration` и `intermediate_text_blocks[].iteration`
 * (вместе с `metadata.tool_results[].iteration` — тем же признаком в
 * персисте результатов тулов). Реальная форма — `engine/orchestrator/**`:
 * `metadata.intermediate_text_blocks: Array<{text, iteration}>` и
 * `metadata.tool_results: Array<{name, id, result, iteration, …}>`.
 *
 * @returns отсортированный список номеров итераций (пустой — признаков нет).
 */
export function messageIterationMarks(message: Message): number[] {
  const marks = new Set<number>();
  const push = (value: unknown): void => {
    if (typeof value === 'number' && Number.isFinite(value)) marks.add(value);
  };

  for (const call of message.toolCalls ?? []) {
    push((call as { iteration?: unknown } | undefined)?.iteration);
  }
  const metadata = message.metadata as
    | { intermediate_text_blocks?: unknown; tool_results?: unknown }
    | undefined;
  for (const block of Array.isArray(metadata?.intermediate_text_blocks) ? metadata.intermediate_text_blocks : []) {
    push((block as { iteration?: unknown } | undefined)?.iteration);
  }
  for (const result of Array.isArray(metadata?.tool_results) ? metadata.tool_results : []) {
    push((result as { iteration?: unknown } | undefined)?.iteration);
  }

  return [...marks].sort((a, b) => a - b);
}

/**
 * План миграции истории сессии (ADR-118 §9) — **чистая функция**: план
 * считается без обращения к хранилищу (тестируется на синтетическом наборе).
 *
 * Правила:
 *   - `ord` — монотонный счётчик сессии: уже выданные значения **не
 *     перенумеровываются**, новые идут строго после максимума по истории;
 *   - `turnId` — ход = реплика пользователя и следующие за ней
 *     assistant/tool-сообщения до следующей реплики пользователя. Идентификатор
 *     детерминированный: `turn_<sessionId>_<n>` (`n` — порядковый номер хода в
 *     сессии; `0` — предходовая группа сообщений до первой реплики);
 *   - `stepIndex` — шаг внутри хода (0-based). Шаг = один вызов LLM = одно
 *     assistant-сообщение. Номер шага выводится из персистящихся признаков
 *     итерации: если у сообщения они есть и указывают на вызовы, ещё не
 *     учтённые в ходе, — шаг равен номеру последнего из них (сообщение
 *     «свёрнуто» из нескольких вызовов); иначе шаг — очередной по порядку.
 *     Признаков нет — сообщение остаётся **одним** сегментом (`stepIndex` —
 *     очередной номер шага хода; в простом ходе это `0`).
 *
 * Уже заполненные поля **не переписываются**: сообщения, созданные уже по
 * модели ADR-118 (движок проставляет `ord`/`turnId`/`stepIndex` сам), сохраняют
 * свои значения — миграция их не трогает.
 */
export function planMessageStreamMigration(
  sessionId: string,
  messages: Message[],
): MessageStreamMigrationPlan[] {
  const plan: MessageStreamMigrationPlan[] = [];

  // `ord` — счётчик сессии: старт от максимума уже выданных значений.
  let ord = messages.reduce((acc, message) => {
    const value = Number.isFinite(message.ord) ? (message.ord as number) : 0;
    return value > acc ? value : acc;
  }, 0);

  let turnIndex = 0; // 0 — предходовая группа (до первой user-реплики)
  let step = 0; // счётчик шагов текущего хода

  messages.forEach((message, index) => {
    if (message.role === MessageRole.USER) {
      turnIndex += 1;
      step = 0;
    }
    const turnId = message.turnId ?? `turn_${sessionId}_${turnIndex}`;

    let stepIndex: number | undefined = message.stepIndex;
    if (message.role === MessageRole.ASSISTANT) {
      if (stepIndex === undefined) {
        const marks = messageIterationMarks(message);
        const lastMark = marks.length > 0 ? marks[marks.length - 1]! : undefined;
        if (lastMark !== undefined && lastMark >= step) {
          // Сообщение свёрнуто из вызовов, которых в ходе ещё не было.
          stepIndex = lastMark;
          step = lastMark + 1;
        } else {
          stepIndex = step;
          step += 1;
        }
      } else if (stepIndex + 1 > step) {
        // Уже проставленный шаг (движок, ADR-118) — учитываем его в счётчике.
        step = stepIndex + 1;
      }
    }

    const currentOrd = Number.isFinite(message.ord) ? (message.ord as number) : undefined;
    const nextOrd = currentOrd ?? ord + 1;
    if (nextOrd > ord) ord = nextOrd;

    plan.push({ index, messageId: message.id, ord: nextOrd, turnId, stepIndex });
  });

  return plan;
}

/** Способ адресации сообщения портом `updateMessage`. */
type MessageAddressing = 'seq' | 'id' | null;

/**
 * Способ адресации сообщения: порт ищет цель по `seq`, затем по `id`.
 * `seq` уникален в сессии — но в legacy-данных у всех сообщений мог быть
 * `seq = 0` (или он дублировался), а `id` в legacy-данных тоже может
 * повторяться. Поэтому:
 *   - `seq` уникален → адресуем по `seq` (обычный путь);
 *   - иначе `id` уникален → адресуем по `id` (нечисловой `seq` заставляет
 *     порт перейти к поиску по `id`);
 *   - иначе сессию пропускаем (адресовать нечего — писать в чужую запись
 *     нельзя).
 */
function resolveAddressing(messages: Message[]): MessageAddressing {
  const unique = (key: (message: Message) => string | number | undefined): boolean => {
    const seen = new Set<string | number>();
    for (const message of messages) {
      const value = key(message);
      if (value === undefined || !Number.isFinite(value as number)) return false;
      if (seen.has(value)) return false;
      seen.add(value);
    }
    return true;
  };

  if (unique((message) => message.seq)) return 'seq';
  if (unique((message) => message.id)) return 'id';
  return null;
}

/**
 * ADR-118 §9: разовая идемпотентная миграция данных — старым сообщениям
 * проставляются `ord` (монотонный порядок записи), `turn_id` (ход) и
 * `step_index` (шаг внутри хода).
 *
 * Миграция **построчная**: сессия целиком не перезаписывается (`saveSession`
 * не вызывается) — каждое сообщение обновляется точечно через порт
 * `updateMessage` (ADR-096). Повторный прогон ничего не меняет: план
 * совпадает с уже проставленными значениями, а маркер
 * `migrations.message-stream-v2` в runtime-настройках закрывает повтор.
 *
 * @returns число обновлённых сообщений (0 — миграция уже выполнялась).
 */
export async function migrateMessageStreamV2(deps: MessageStreamMigrationDeps): Promise<number> {
  if (await deps.settingsStore.getMigrationMarker(MESSAGE_STREAM_V2_MIGRATION)) return 0;

  // ADR-089: миграция видит и архивированные сессии (архив не влияет на порядок).
  // Лёгкая выборка — чтобы не тянуть всю историю в память; полная история
  // читается по одной сессии.
  const sessions = await deps.sessionManager.listSessions(undefined, { includeArchived: true, light: true });

  let updated = 0;
  for (const session of sessions) {
    const full = await deps.sessionManager.getSession(session.id);
    if (!full) continue;
    const messages = full.messages ?? [];
    if (messages.length === 0) continue;

    const plan = planMessageStreamMigration(full.id, messages);
    const pending = plan.filter((entry) => {
      const message = messages[entry.index]!;
      return message.ord !== entry.ord
        || message.turnId !== entry.turnId
        || message.stepIndex !== entry.stepIndex;
    });
    if (pending.length === 0) continue;

    const addressing = resolveAddressing(messages);
    if (!addressing) {
      warning(
        'MIGRATION',
        `Сессия ${full.id}: миграция ADR-118 пропущена — сообщения не адресуются уникально (дубли seq и id)`,
      );
      continue;
    }

    for (const entry of pending) {
      const message = messages[entry.index]!;
      const migrated: Message = {
        ...message,
        ord: entry.ord,
        turnId: entry.turnId,
        ...(entry.stepIndex !== undefined ? { stepIndex: entry.stepIndex } : {}),
      };
      // Адресация по `id`: порт ищет цель по `seq`, затем по `id`; нечисловой
      // `seq` переключает порт на поиск по `id` (у legacy-сессий `seq` мог
      // быть не уникален — иначе обновилась бы чужая запись).
      const target = addressing === 'id' ? { ...migrated, seq: Number.NaN } : migrated;
      const saved = await deps.sessionManager.updateMessage(full.id, target);
      if (!saved || saved.id !== message.id) {
        warning(
          'MIGRATION',
          `Сессия ${full.id}: сообщение ${message.id} не обновлено миграцией ADR-118 (адресация не сработала)`,
        );
        continue;
      }
      if (saved.ord !== entry.ord) {
        warning(
          'MIGRATION',
          `Сессия ${full.id}: сообщение ${message.id} не получило ord `
            + `(порт не выдаёт ord при обновлении — проверьте prepareMessageForUpdate)`,
        );
      }
      updated++;
    }
  }

  await deps.settingsStore.setMigrationMarker(MESSAGE_STREAM_V2_MIGRATION);
  return updated;
}
