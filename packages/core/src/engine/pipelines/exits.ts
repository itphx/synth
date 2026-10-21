/**
 * ADR-101 §9: реальные обработчики выходов пайплайна.
 *
 * Выход — «что движок делает по завершении прогона» (ADR-101 §9):
 *
 * | Вид | Действие |
 * |---|---|
 * | `session` | создать/продолжить сессию проекта и передать в неё результат шага |
 * | `file` | записать артефакт в workspace проекта (containment, ADR-075) |
 * | `gateway` | опубликовать событие наружу (ADR-089/ADR-052/ADR-087) |
 * | `none` | ничего не делать |
 *
 * Обработчики **инъектируются** в `PipelineEngineDeps.exits` (никаких
 * глобальных синглтонов). Ошибка обработчика не роняет прогон: движок ловит
 * её и пишет в лог (ADR-101 §2.13).
 *
 * ## Правила
 *
 * - **владелец сессии** — владелец проекта (ADR-089): сессия, созданная
 *   выходом пайплайна, принадлежит проекту, а не «машине»;
 * - **containment файла** (ADR-075): путь относительный, итоговый путь внутри
 *   workspace проекта; абсолютный путь и выход за пределы — отказ;
 * - **санитизация** (инвариант 13): наружу уходит только очищенный результат
 *   шага (секреты вырезаны, глубина/длина ограничены).
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';

import { MessageRole, generateId, makeTextPart, nowISO } from '@itphx/synth-shared';
import type {
  EventType,
  Message,
  PipelineRunTrigger,
  Project,
  Session,
  SessionOrigin,
  SessionSettings,
} from '@itphx/synth-shared';

import { error as logError, warning as logWarning } from '../../logger.js';
import { sanitizeRecord } from './payload.js';
import { resolvePipelinePath } from './paths.js';
import type { PipelineProjectStoreLike } from './step-context.js';
import type {
  PipelineEngineLogger,
  PipelineExitContext,
  PipelineExitHandler,
  PipelineLlmDefaults,
} from './types.js';

/** Лог-группа обработчиков выходов. */
const LOG_GROUP = 'PIPELINE';

/**
 * Минимальный контракт менеджера сессий для выхода `session`.
 *
 * `SessionManager.createSession` — materialization-примитив (ADR-089,
 * инвариант 15): прямые запросы через него не создаются, но **выход пайплайна
 * материализует сессию** — это допустимое применение.
 */
export interface PipelineExitSessionManagerLike {
  /** Создание сессии (materialization). */
  createSession(data: {
    title?: string;
    projectId?: string;
    userId?: string;
    ownerId?: string;
    sessionOrigin?: SessionOrigin;
    settings?: Partial<SessionSettings>;
  }): Promise<Session>;
  /** Чтение сессии. */
  getSession(sessionId: string): Promise<Session | null>;
  /** Добавление сообщения в историю сессии. */
  addMessage(sessionId: string, message: Message): Promise<Session | null>;
}

/** Минимальный контракт шины для выхода `session` (публикация `session.created`). */
export interface PipelineExitEventBusLike {
  /** Публикация события в канал сессии. */
  publish(sessionId: string, type: EventType, data?: Record<string, unknown>): void;
  /** Публикация инстансного события (выход `gateway`). */
  publishInstance?(type: EventType, data?: Record<string, unknown>): void;
}

/** Минимальный контракт ingress'а внешних событий (выход `gateway`). */
export interface PipelineExitIngressLike {
  /** Приём внешнего события (нормализация → Router, ADR-089). */
  ingest(input: { source: string; type: string; payload?: unknown }): Promise<unknown>;
}

/**
 * Зависимости обработчиков выходов — собираются **в точке сборки**
 * (standalone/backend), а не внутри движка.
 */
export interface PipelineExitDeps {
  /** Менеджер сессий (выход `session`). */
  sessionManager?: PipelineExitSessionManagerLike | null;
  /** Порт проектов (владелец сессии и workspace, ADR-014/ADR-075). */
  projectStore?: PipelineProjectStoreLike | null;
  /** Шина событий (публикация `session.created`, ADR-089). */
  eventBus?: PipelineExitEventBusLike | null;
  /** Ingress внешних событий (выход `gateway`, ADR-089). */
  ingress?: PipelineExitIngressLike | null;
  /**
   * Колбэк после материализации сессии — хабы подписывают владельца
   * (ADR-089/инвариант 18). Не задан — подписка остаётся на авто-пути
   * (`session.created` в канале сессии).
   */
  onSessionMaterialized?: (session: Session) => void | Promise<void>;
  /** Корень рабочих каталогов (ADR-075) — для относительного workspace. */
  workspacesRoot?: string;
  /** Дефолтные `provider`/`model` инстанса (ADR-089) — для новой сессии. */
  resolveLlmDefaults?: () => PipelineLlmDefaults | Promise<PipelineLlmDefaults>;
  /** Владелец инстанса, когда у прогона нет проекта (ADR-089). */
  resolveOwnerId?: () => string | Promise<string>;
  /** Логгер (по умолчанию — логгер ядра). */
  logger?: PipelineEngineLogger;
}

/** Логгер по умолчанию. */
const defaultLogger: PipelineEngineLogger = {
  info: (group, message) => logWarning(group, message),
  warning: (group, message) => logWarning(group, message),
  error: (group, message) => logError(group, message),
};

/**
 * Обработчик выходов пайплайна — **диспетчер по виду выхода**.
 *
 * Один обработчик обслуживает все виды: движок вызывает обработчики всех
 * подключённых выходов подряд, поэтому обработчик обязан сам отфильтровать
 * свой вид (`ctx.exit.kind`).
 */
export function createPipelineExitHandler(deps: PipelineExitDeps = {}): PipelineExitHandler {
  const logger = deps.logger ?? defaultLogger;
  return {
    async handle(ctx: PipelineExitContext): Promise<void> {
      switch (ctx.exit.kind) {
        case 'session':
          await handleSessionExit(ctx, deps, logger);
          return;
        case 'file':
          await handleFileExit(ctx, deps, logger);
          return;
        case 'gateway':
          await handleGatewayExit(ctx, deps, logger);
          return;
        case 'none':
          // Выход без внешнего следа — ничего не делаем.
          return;
      }
    },
  };
}

/**
 * Выход `session` — создать (или продолжить) сессию проекта и передать в неё
 * результат шага (ADR-101 §9).
 *
 * - **новая сессия**: владелец — владелец проекта (ADR-089), агент — из
 *   `exit.session.agent`, модель — дефолты инстанца;
 * - **продолжение**: `exit.session.sessionId` — результат добавляется в
 *   существующую сессию (владелец не меняется);
 * - результат шага кладётся сообщением пользователя (`author: 'Pipeline'`),
 *   чтобы агент продолжил работу с результатом.
 */
async function handleSessionExit(
  ctx: PipelineExitContext,
  deps: PipelineExitDeps,
  logger: PipelineEngineLogger,
): Promise<void> {
  const manager = deps.sessionManager;
  if (!manager) {
    logger.warning(
      LOG_GROUP,
      `прогон ${ctx.runId}: выход «session» пропущен — менеджер сессий не подключён`,
    );
    return;
  }

  const project = ctx.projectId ? await loadProject(ctx.projectId, deps) : undefined;
  const ownerId = project?.ownerId || (await resolveOwner(deps));

  let sessionId = ctx.exit.session?.sessionId?.trim() || undefined;
  if (!sessionId) {
    const defaults = await resolveDefaults(deps);
    const session = await manager.createSession({
      title: buildSessionTitle(ctx),
      ...(ctx.projectId ? { projectId: ctx.projectId } : {}),
      userId: ownerId,
      ownerId,
      sessionOrigin: 'user',
      settings: {
        ...(ctx.exit.session?.agent ? { agentRole: ctx.exit.session.agent } : {}),
        ...(defaults.provider ? { provider: defaults.provider } : {}),
        ...(defaults.model ? { model: defaults.model } : {}),
      },
    });
    sessionId = session.id;
    // Инвариант 18: путь, создающий сессию, публикует `session.created` —
    // хабы подписывают владельца сами.
    deps.eventBus?.publish(session.id, 'session.created', {
      id: session.id,
      owner_id: session.ownerId || session.userId || ownerId,
      user_id: session.userId || ownerId,
      project_id: session.projectId ?? null,
      name: session.title,
    });
    try {
      await deps.onSessionMaterialized?.(session);
    } catch (err) {
      logger.warning(
        LOG_GROUP,
        `прогон ${ctx.runId}: не удалось уведомить хаб о новой сессии: ${errorMessage(err)}`,
      );
    }
  }

  const message = buildResultMessage(ctx);
  await manager.addMessage(sessionId, message);
  logger.info(LOG_GROUP, `прогон ${ctx.runId}: результат передан в сессию «${sessionId}»`);
}

/**
 * Выход `file` — артефакт в workspace проекта (ADR-075).
 *
 * Containment: путь **относительный**, итоговый путь — внутри workspace
 * проекта. Абсолютный путь, `..` за пределы workspace и отсутствие
 * workspace — отказ (ошибка обработчика; прогон при этом не падает —
 * движок ловит ошибку и пишет в лог).
 */
async function handleFileExit(
  ctx: PipelineExitContext,
  deps: PipelineExitDeps,
  logger: PipelineEngineLogger,
): Promise<void> {
  const file = ctx.exit.file;
  const rawPath = file?.path?.trim();
  if (!rawPath) {
    throw new Error('выход «file»: не задан путь (file.path)');
  }
  if (isAbsolute(rawPath)) {
    throw new Error('выход «file»: абсолютный путь запрещён — путь относительно workspace проекта');
  }

  const workspace = await resolveWorkspace(ctx, deps);
  if (!workspace) {
    throw new Error('выход «file»: у проекта нет рабочего каталога (workspace)');
  }

  const target = resolve(workspace, rawPath);
  const rel = relative(workspace, target);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error('выход «file»: путь выходит за пределы рабочего каталога проекта');
  }

  const content = resolveFileContent(ctx, file?.contentFrom);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, content, 'utf8');
  logger.info(LOG_GROUP, `прогон ${ctx.runId}: артефакт записан в workspace проекта`);
}

/**
 * Выход `gateway` — публикация события наружу.
 *
 * Основной механизм — **ingress внешних событий** (ADR-089), тем же путём,
 * что и публикация `schedule_fired` шедулером: источник `pipeline`, тип — из
 * конфигурации выхода (`exit.gateway.event`, по умолчанию
 * `pipeline.completed`), payload — санитизированный результат шага.
 *
 * Дополнительно событие публикуется в **инстансный канал шины**: его видят
 * исходящие webhooks (ADR-052, `WebhookService` подписан на `subscribeAll`)
 * и UI. Адресная доставка по `exit.gateway.webhookId` не реализована —
 * подписки срабатывают по типу события.
 */
async function handleGatewayExit(
  ctx: PipelineExitContext,
  deps: PipelineExitDeps,
  logger: PipelineEngineLogger,
): Promise<void> {
  const type = ctx.exit.gateway?.event?.trim() || 'pipeline.completed';
  const payload = sanitizeRecord({
    runId: ctx.runId,
    pipelineId: ctx.pipelineId,
    version: ctx.version,
    ...(ctx.projectId ? { projectId: ctx.projectId } : {}),
    triggerKind: ctx.trigger?.kind,
    output: ctx.output,
  }) ?? {};

  if (deps.ingress) {
    await deps.ingress.ingest({ source: 'pipeline', type, payload });
  } else {
    logger.warning(
      LOG_GROUP,
      `прогон ${ctx.runId}: выход «gateway» — ingress не подключён, событие «${type}» не принято`,
    );
  }

  deps.eventBus?.publishInstance?.('pipeline.completed', {
    source: 'pipeline',
    type,
    ...payload,
  });
  logger.info(LOG_GROUP, `прогон ${ctx.runId}: событие «${type}» опубликовано наружу`);
}

/** Загрузка проекта-владельца (ошибка порта не роняет выход). */
async function loadProject(
  projectId: string,
  deps: PipelineExitDeps,
): Promise<Project | undefined> {
  const store = deps.projectStore;
  if (!store) return undefined;
  try {
    return (await store.load(projectId)) ?? undefined;
  } catch {
    return undefined;
  }
}

/** Владелец инстанса (когда у прогона нет проекта). */
async function resolveOwner(deps: PipelineExitDeps): Promise<string> {
  try {
    return (await deps.resolveOwnerId?.()) ?? '';
  } catch {
    return '';
  }
}

/** Дефолтные `provider`/`model` инстанса (ADR-089). */
async function resolveDefaults(deps: PipelineExitDeps): Promise<PipelineLlmDefaults> {
  try {
    return (await deps.resolveLlmDefaults?.()) ?? {};
  } catch {
    return {};
  }
}

/**
 * Workspace проекта (ADR-075): абсолютный — как есть, относительный — от
 * `workspacesRoot`. Каталог не создаётся — provisioning за общей подсистемой.
 */
async function resolveWorkspace(
  ctx: PipelineExitContext,
  deps: PipelineExitDeps,
): Promise<string | undefined> {
  const project = ctx.projectId ? await loadProject(ctx.projectId, deps) : undefined;
  const raw = project?.workspace?.trim();
  if (!raw) return undefined;
  if (isAbsolute(raw)) return resolve(raw);
  const root = deps.workspacesRoot;
  if (!root) return undefined;
  return resolve(root, raw);
}

/** Заголовок новой сессии — по имени пайплайна. */
function buildSessionTitle(ctx: PipelineExitContext): string {
  const name = ctx.spec?.name?.trim();
  return name ? `Пайплайн: ${name}` : `Пайплайн ${ctx.pipelineId}`;
}

/**
 * Сообщение с результатом шага — вход сессии (ADR-101 §9).
 *
 * Текст результата — `output.text`, иначе — JSON выхода шага. Секреты из
 * результата вырезаны санитизацией (инвариант 13).
 */
function buildResultMessage(ctx: PipelineExitContext): Message {
  const sanitized = sanitizeRecord(ctx.output) ?? {};
  const text = typeof sanitized.text === 'string' && sanitized.text.trim()
    ? sanitized.text
    : JSON.stringify(sanitized);
  const content = [
    `Пайплайн «${ctx.spec?.name ?? ctx.pipelineId}» (${ctx.pipelineId}@${ctx.version}) завершён.`,
    '',
    text,
  ].join('\n');
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
    author: 'Pipeline',
    metadata: {
      pipeline: { runId: ctx.runId, pipelineId: ctx.pipelineId, version: ctx.version },
    },
  };
}

/**
 * Содержимое файла выхода `file`: путь `contentFrom` (`prev.output.*` и т.п.)
 * либо весь выход шага.
 */
function resolveFileContent(ctx: PipelineExitContext, contentFrom?: string): string {
  if (contentFrom) {
    const value = resolvePipelinePath(contentFrom, {
      prev: { status: 'ok', output: ctx.output, attempt: 1 },
      trigger: ctx.trigger as PipelineRunTrigger,
      vars: ctx.vars,
    });
    if (typeof value === 'string') return value;
    if (value !== undefined && value !== null) return JSON.stringify(value, null, 2);
  }
  return JSON.stringify(sanitizeRecord(ctx.output) ?? {}, null, 2);
}

/** Текст ошибки (для лога). */
function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
