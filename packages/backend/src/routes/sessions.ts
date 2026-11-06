import { Hono } from 'hono';
import type { AuthKit } from '../auth/middleware.js';
import type { SessionManager } from '@itphx/synth-core';
import type { EventBus } from '@itphx/synth-core';
import type { QueueProcessorManager } from '@itphx/synth-core';
import type { ChatOrchestrator } from '@itphx/synth-core';
import type { ContextOptimizer } from '@itphx/synth-core';
import type { RequestSessionService } from '@itphx/synth-core';
import type { AnalyticsRecorder } from '@itphx/synth-core';
import {
  MessageRole,
  generateStreamId,
  nowISO,
  sessionMcpUpdateSchema,
  normalizeIconKey,
  normalizeColorKey,
} from '@itphx/synth-shared';
import type { Message, Session, SessionSettings } from '@itphx/synth-shared';
import type { ProfileStore } from '@itphx/synth-shared';
import { createRateLimiter } from '../middleware/rate-limiter.js';
import { scopeGuard, serviceProjectProjection } from '../auth/service-scope.js';
import {
  enqueueUserMessage,
  serializeSession,
  createSessionAccessGuard,
  createSessionAccessPredicate,
  createSessionExportGuard,
  getSessionExportDecision,
  isSessionExportPath,
  createSessionRoutes as createCoreSessionRoutes,
  stripSessionSecrets,
  resolveUserPrincipal,
} from '@itphx/synth-core';
import { t } from '../lib/i18n.js';
import type { EventHub } from '../events/hub.js';
import type { ProjectRepository } from '@itphx/synth-core';
import type { MemoryFactRepository, MemoryIndexRepository } from '@itphx/synth-core';
import type { BlobRefRepository, BlobStore } from '@itphx/synth-core';
import type { AttachmentThumbnailProvider } from '@itphx/synth-core';
import type { AttachmentsConfig, StickyNotesLimits } from '@itphx/synth-shared';
// Этап 1 roadmap 0.13 (блок 3): сервис «вопрос пользователю» (`ask_user`).
import type { QuestionService } from '@itphx/synth-core';
// ADR-114: сервис worktree'ов — привязка сессии к worktree.
import type { WorktreeService } from '@itphx/synth-core';
// ADR-111/ADR-113: реестр фоновых прогонов — «Стоп» останавливает и детей
// (решение 2026-10-28).
import type { BackgroundRunService } from '@itphx/synth-core';
// ADR-106 Ф3: реестр подтверждений — HTTP-ответ на подтверждение.
import type { ApprovalRegistry } from '@itphx/synth-core';
import { createProjectAccess } from './projects.js';

/**
 * Backend-обёртка над core-фабрикой сессий (ТД-1, фаза B2). Здесь остаются только
 * backend-специфичные роуты (MCP-скоуп сессии и секреты — более строгая политика
 * managed, export/import, отладка). Общая логика (список/создание/чтение/изменение/
 * удаление, status/prompt/stats, заметки (`notes`), очередь+SSE, children/tree/
 * fork, references, merge, оптимизация контекста, core-версии MCP-скоупа и
 * секретов для standalone/гибрида) — в `createSessionRoutes` из `@itphx/synth-core`.
 *
 * RBAC: core-фабрика параметризуется `resolveUserId`/`resolveOwner`/`resolveAuthor`,
 * `canAccess` (владелец|ADMIN) и EventHub-хуками; remote/hybrid-ветки отключены
 * (getRemoteClient не передаётся). Сессионного SSE нет: наблюдение за ходом —
 * единственный глобальный канал `GET /api/v2/events` (ADR-118).
 *
 * Исключения из общего prefix-guard'а (собственные правила, роуты зарегистрированы
 * до guard'а): `/:id/mcp` (владелец|ADMIN, ADR-071 §2.4) и `/:id/secrets`
 * (ADMIN|AUDITOR — карта обфускации). В core-фабрике есть версии этих маршрутов
 * для standalone/гибрида; здесь они регистрируются раньше и потому выигрывают,
 * сохраняя прежнюю политику. `/:id/export` — ПОД guard'ом: доступ к
 * сессии решает ЕДИНЫЙ prefix-guard, а привилегию карты обфускации — отдельный
 * route-level guard (`createSessionExportGuard`, ADR-036); в обработчике проверок
 * доступа нет (инвариант 16).
 */
export function createSessionRoutes(
  kit: AuthKit,
  sessionManager: SessionManager,
  eventBus: EventBus,
  queueManager: QueueProcessorManager,
  processMessage: ReturnType<ChatOrchestrator['createProcessMessage']>,
  orchestrator: ChatOrchestrator,
  eventHub: EventHub,
  contextOptimizer?: ContextOptimizer,
  projectStore?: ProjectRepository,
  /** Профили пользователей: display name для статистики (fallback — username). */
  profilesStore?: ProfileStore,
  /** Агент по умолчанию для новых сессий без `settings.agentRole` (runtime-настройка). */
  resolveDefaultAgent?: () => string | Promise<string>,
  /**
   * ADR-089: единый funnel создания сессий (прокидывается в core-фабрику).
   * Не задан — core-фабрика использует прямой `SessionManager.createSession`.
   */
  requestSessionService?: RequestSessionService,
  /** ADR-102: сборщик `activity` (меры `aborts`/`messages_*`) для core-фабрики. */
  analytics?: AnalyticsRecorder,
  /** ADR-107: агрегаты памяти сессии для `GET /:id/memory` (вкладка «Память»). */
  memory?: {
    facts: MemoryFactRepository;
    indexes: MemoryIndexRepository;
    isPluginActive: () => boolean;
  },
  /**
   * Этап 1 roadmap 0.13 (блок 3): сервис «вопрос пользователю» (`ask_user`).
   *
   * Не задан — маршруты вопросов отвечают 503 (подсистема не подключена).
   */
  questionService?: QuestionService,
  /**
   * ADR-114: сервис worktree'ов — привязка сессии к worktree
   * (`PATCH /api/v2/sessions/:id { worktreeId }`).
   *
   * Не задан — поле `worktreeId` в PATCH игнорируется (привязка недоступна).
   */
  worktreeService?: WorktreeService,
  /**
   * ADR-115: вложения сообщений — blob-порт, учёт ссылок и лимиты
   * (прокидывается в core-фабрику: загрузка/раздача + `attachments` в промпте).
   */
  attachments?: {
    blobs: BlobStore;
    blobRefs?: BlobRefRepository;
    /**
     * Настройки вложений: снимок **или** резолвер (ADR-115) — runtime-настройки
     * из админки (`/api/v2/settings/attachments`) применяются на каждый вызов.
     */
    config: AttachmentsConfig | (() => AttachmentsConfig);
    /** ADR-115: провайдер серверных миниатюр (`?variant=thumb`). */
    thumbnails?: AttachmentThumbnailProvider;
  },
  /**
   * ADR-111/ADR-113: единый реестр фоновых прогонов — «Стоп» сессии
   * останавливает и живые дочерние прогоны (фоновые саб-агенты и их процессы),
   * решение 2026-10-28. Не задан — прежнее поведение (только свой стрим/очередь).
   */
  backgroundService?: BackgroundRunService,
  /**
   * ADR-106 Ф3: реестр подтверждений — HTTP-ответ на подтверждение
   * (`POST /:id/permissions/:approvalId`) принимает решение через него, как и
   * WS-кадр `permission_reply`. Не задан — слой Authority выключен/в shadow.
   */
  approvalRegistry?: ApprovalRegistry,
  /**
   * Instance-wide лимиты заметок сессии (`context.stickyNotes`, live-резолвер)
   * — прокидывается в core-фабрику: роуты заметок живут там (единая реализация).
   */
  getStickyNoteLimits?: () => StickyNotesLimits,
  /**
   * Доступность пары провайдер/модель **до постановки в очередь** (каталог
   * инстанса). Не задана — проверка выключена.
   */
  llmAvailability?: {
    isProviderEnabled?: (name: string) => boolean | undefined
    isModelEnabled?: (provider: string, model: string) => boolean | undefined
  },
): Hono {
  const app = new Hono();
  const agentRegistry = orchestrator.agentRegistry;
  const { canReadProject, canEditProjectContent } = createProjectAccess(kit);

  // ADR-071 §2.4: владелец сессии — обычный пользователь, управляющий её MCP-скоупом.
  const isSessionOwner = (session: Session, userId: string): boolean =>
    (session.ownerId ?? session.userId) === userId;

  /**
   * Rate limit на тяжёлые/неинтерактивные операции ресурса сессий (import/export/
   * fork/merge): 10 запросов / 60 с на креду — тот же in-memory `createRateLimiter`,
   * что у `POST /:id/prompt` (30/60) и `schedules/:id/run` (10/60). Значение ниже
   * prompt: операции не частые в живом UI, но дорогие (полный объект сессии,
   * создание форка, копирование сообщений) — защита от всплесков/выкачивания.
   */
  const importRateLimit = createRateLimiter(10, 60_000);
  const exportRateLimit = createRateLimiter(10, 60_000);
  const forkRateLimit = createRateLimiter(10, 60_000);
  const mergeRateLimit = createRateLimiter(10, 60_000);

  /**
   * Единое правило доступа к сессии (читать/писать) — ОДНА точка на весь ресурс
   * `/api/v2/sessions`, включая backend-only маршруты (export/debug/optimization/
   * notes) и core-маршруты. Правило:
   * - elevated (ADMIN/LEAD) → всё (осознанное решение: мутации чужих сессий
   *   у LEAD/ADMIN сохранены как есть);
   * - владелец сессии или сессия без владельца → всё;
   * - иначе — роль в проекте: чтение (`GET`/`HEAD`) — проектное чтение
   *   (`canReadProject`: owner проекта или любой участник), мутация — проектное
   *   редактирование (`canEditProjectContent`: owner/EDITOR).
   * Разделение read/write делает prefix-guard по HTTP-методу (единая точка).
   */
  const sessionAccessPredicate = createSessionAccessPredicate({
    canAccess: (session, c, userId) => {
      const owner = session.ownerId ?? session.userId;
      return !owner || owner === userId
        || (typeof kit.isAdmin === 'function' && kit.isAdmin(c as Parameters<typeof kit.isAdmin>[0]));
    },
    resolveCanAccessExtra: async (session, c, userId, access) => {
      if (!projectStore || !session.projectId) return false;
      const project = await projectStore.load(session.projectId);
      if (!project) return false;
      const ctx = c as Parameters<typeof kit.isAdmin>[0];
      return access === 'read'
        ? canReadProject(ctx, project, userId)
        : canEditProjectContent(ctx, project, userId);
    },
    localUserId: 'local',
  });

  /**
   * `GET /:id/export` — единственный `:id`-маршрут, где роль аудита инстанса
   * (`AUDITOR`) является **читателем** сессии: карта обфускации ЛЮБОЙ сессии ему
   * и так доступна (`GET /:id/secrets` — `ADMIN`/`AUDITOR`), поэтому экспорт
   * сессии для него не привилегия сверх того, что у него уже есть. На остальных
   * `:id`-маршрутах правило доступа не меняется (см. матрицу
   * `session-idor-matrix.test.ts`).
   */
  const isSessionExportRequest = (c: { req: { method: string; path: string } }): boolean =>
    c.req.method === 'GET' && isSessionExportPath(c.req.path);

  const sessionAccessGuard = createSessionAccessGuard({
    param: 'id',
    resolveSession: (id) => sessionManager.getSession(id),
    resolveUserId: async (c) => (await kit.getCurrentUser(c))?.id ?? '',
    isAllowed: async (session, c, userId, access) => {
      // Мок-AuthKit в тестах может не иметь isAdmin/hasRole — защищаем typeof.
      const isAdmin =
        typeof kit.isAdmin === 'function' && kit.isAdmin(c as Parameters<typeof kit.isAdmin>[0]);
      const isLead =
        typeof kit.hasRole === 'function' && kit.hasRole(c as Parameters<typeof kit.hasRole>[0], 'LEAD');
      if (isAdmin || isLead) return true;
      // Роль аудита инстанса — читатель сессии на маршруте экспорта (см. выше).
      if (access === 'read' && isSessionExportRequest(c)) {
        const isAuditor =
          typeof kit.hasRole === 'function' && kit.hasRole(c as Parameters<typeof kit.hasRole>[0], 'AUDITOR');
        if (isAuditor) return true;
      }
      return sessionAccessPredicate(session, c, userId, access);
    },
    messages: {
      sessionNotFound: (c) => t('errors.notFound.session', undefined, c),
      forbidden: (c) => t('auth.forbidden', undefined, c),
    },
    // `/import` — статический сегмент (не id сессии).
    skipForId: (id) => id === 'import',
  });

  /**
   * Привилегия карты обфускации при экспорте сессии (ADR-036, security-фикс
   * 0.11.3) — отдельный route-level guard: он резолвит сессию, решает «полный
   * экспорт или очищенный» и кладёт решение в контекст Hono. Обработчик
   * `/export` только форматирует ответ по этому решению — копии правила доступа
   * в обработчике нет (инвариант 16).
   */
  const sessionExportGuard = createSessionExportGuard({
    param: 'id',
    resolveSession: (id) => sessionManager.getSession(id),
    resolveUserId: async (c) => (await kit.getCurrentUser(c))?.id ?? '',
    isAdmin: (c) =>
      typeof kit.isAdmin === 'function' && kit.isAdmin(c as Parameters<typeof kit.isAdmin>[0]),
    isAuditor: (c) =>
      typeof kit.hasRole === 'function' && kit.hasRole(c as Parameters<typeof kit.hasRole>[0], 'AUDITOR'),
    messages: {
      sessionNotFound: (c) => t('errors.notFound.session', undefined, c),
    },
  });

  /** ADR-071 §2.4: эффективный MCP-скоуп сессии (включая отключённые с причиной). */
  const buildSessionMcpPayload = async (session: Session) => {
    const servers = await orchestrator.resolveMcpServers(session);
    return {
      servers,
      enabled: servers.filter((s) => s.enabled).map((s) => s.name),
      disabled: servers.filter((s) => !s.enabled).map((s) => s.name),
      mcpServers: session.settings.mcpServers ?? [],
      mcpDisabledServers: session.settings.mcpDisabledServers ?? [],
    };
  };

  // GET /api/v2/sessions/:id/mcp — эффективный MCP-скоуп (ADR-071 §2.4).
  // Показывает все серверы, включая отключённые (reason). RBAC: владелец сессии/ADMIN.
  app.get('/:id/mcp', kit.requireAuth, async (c) => {
    const session = await sessionManager.getSession(c.req.param('id'));
    if (!session) {
      return c.json({ error: { code: 'NOT_FOUND', message: t('errors.notFound.session', undefined, c) } }, 404);
    }
    const user = (await kit.getCurrentUser(c))!;
    if (!isSessionOwner(session, user.id) && !kit.isAdmin(c)) {
      return c.json({ error: { code: 'FORBIDDEN', message: t('auth.forbidden', undefined, c) } }, 403);
    }
    return c.json(await buildSessionMcpPayload(session));
  });

  // PUT /api/v2/sessions/:id/mcp — переключение MCP пользователем (ADR-071 §2.4),
  // включая opt-out системных серверов. RBAC: владелец сессии/ADMIN.
  app.put('/:id/mcp', kit.requireAuth, async (c) => {
    const session = await sessionManager.getSession(c.req.param('id'));
    if (!session) {
      return c.json({ error: { code: 'NOT_FOUND', message: t('errors.notFound.session', undefined, c) } }, 404);
    }
    const user = (await kit.getCurrentUser(c))!;
    if (!isSessionOwner(session, user.id) && !kit.isAdmin(c)) {
      return c.json({ error: { code: 'FORBIDDEN', message: t('auth.forbidden', undefined, c) } }, 403);
    }

    const body = await c.req.json().catch(() => ({}));
    const parsed = sessionMcpUpdateSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: parsed.error.message } }, 400);
    }

    const { name, enabled, mcpServers, mcpDisabledServers } = parsed.data;
    const known = new Set((await orchestrator.resolveMcpServers(session)).map((s) => s.name));
    const toValidate = name !== undefined
      ? [name]
      : [...(mcpServers ?? []), ...(mcpDisabledServers ?? [])];
    for (const serverName of toValidate) {
      if (!known.has(serverName)) {
        return c.json({
          error: { code: 'VALIDATION_ERROR', message: `MCP-сервер "${serverName}" не найден` },
        }, 400);
      }
    }

    if (name !== undefined) {
      // Точечный toggle: enabled → session.enabled; disabled → opt-out.
      const enabledList = new Set(session.settings.mcpServers ?? []);
      const disabledList = new Set(session.settings.mcpDisabledServers ?? []);
      if (enabled === false) {
        enabledList.delete(name);
        disabledList.add(name);
      } else {
        enabledList.add(name);
        disabledList.delete(name);
      }
      session.settings.mcpServers = [...enabledList];
      session.settings.mcpDisabledServers = [...disabledList];
    } else {
      if (mcpServers !== undefined) session.settings.mcpServers = mcpServers;
      if (mcpDisabledServers !== undefined) session.settings.mcpDisabledServers = mcpDisabledServers;
    }

    await sessionManager.updateSession(session);
    eventBus.publish(session.id, 'session.updated', serializeSession(session, { agentRegistry }));
    return c.json(await buildSessionMcpPayload(session));
  });

  // GET /api/v2/sessions/:id/secrets — карта обфускации LLM Gateway (ADR-036).
  // RBAC: только ADMIN/AUDITOR — сама карта является секретом.
  app.get('/:id/secrets', kit.requirePermission('ADMIN', 'AUDITOR'), async (c) => {
    const session = await sessionManager.getSession(c.req.param('id'));
    if (!session) {
      return c.json({ error: { code: 'NOT_FOUND', message: t('errors.notFound.session', undefined, c) } }, 404);
    }
    return c.json({ sessionId: session.id, secrets: session.obfuscationMap ?? {} });
  });

  // Единый prefix-guard ресурса сессий: вешается ПОСЛЕ `/:id/mcp` и `/:id/secrets`
  // (у них собственные задокументированные правила) и покрывает отладку,
  // оптимизацию (реализация — в core-фабрике, регистрируется ниже), заметки,
  // ЭКСПОРТ и все core-маршруты (core-фабрика регистрируется с
  // registerAccessGuard:false — иначе был бы второй источник правил).
  // `/import` пропускается через guard.skipForId (статический сегмент,
  // не сессия).
  app.use('/:id', kit.requireAuth, sessionAccessGuard as never);
  app.use('/:id/*', kit.requireAuth, sessionAccessGuard as never);

  // GET /api/v2/sessions/:id/export — полный экспорт сессии для переноса между
  // мирами (publish/fork). Внутренний формат: объект Session (camelCase) из
  // SessionManager — история сообщений, todos, настройки, заметки, ссылки,
  // чекпоинты, план-флаг и карта обфускации. Не публичный DTO.
  //
  // ВАЖНО (инвариант 16): маршрут зарегистрирован ПОСЛЕ prefix-guard'а —
  // доступ к сессии (404/403) решает ЕДИНЫЙ guard (`sessionAccessGuard`), и
  // второй копии правила в обработчике быть не должно: иначе правила
  // расходятся (было: ложный 403 у `LEAD`, «правило в двух местах»).
  //
  // ПРАВИЛО ОТВЕТА (security-фикс 0.11.3): экспорт переносит СЕКРЕТЫ — карту
  // обфускации LLM Gateway (`obfuscationMap`: плейсхолдер → РЕАЛЬНЫЙ секрет) и
  // реальные значения плейсхолдеров в `metadata.secrets` (ADR-036). Ответ
  // зависит от отдельной привилегии, которую решает route-level guard
  // (`sessionExportGuard`), а не обработчик:
  //
  // - **владелец сессии** (`ownerId ?? userId` === текущий пользователь),
  //   **ADMIN**, **AUDITOR** → полный экспорт с картой: это его собственные
  //   секреты (ADMIN/AUDITOR — тот же набор привилегий, что у `GET /:id/secrets`);
  // - **прочие читатели сессии** (участник проекта VIEWER/EDITOR, владелец
  //   проекта, который не владеет сессией, LEAD) → 200, но ответ **очищен**:
  //   без `obfuscationMap` и без `metadata.secrets`. Переносится разговор,
  //   который этот пользователь и так видит в UI, — но не чужие секреты (смысл
  //   «выгрузки секретов» не теряется, а publish/fork не ломается: форк чужой
  //   сессии в проекте остаётся рабочим);
  // - **нет доступа на чтение** (посторонний) → 403 FORBIDDEN (prefix-guard).
  //
  // Очистка — на КОПИИ: сохранённая сессия не мутируется. Формат ответа не
  // меняется (тот же объект Session), очищенный экспорт остаётся валидным
  // payload'ом переноса — импорт его принимает.
  app.get('/:id/export', kit.requireAuth, exportRateLimit, sessionExportGuard as never, async (c) => {
    const decision = getSessionExportDecision(c);
    if (!decision) {
      // Fail-closed: guard не отработал — отдаём полный экспорт нельзя.
      return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Не удалось подготовить экспорт сессии' } }, 500);
    }
    return c.json(decision.withSecrets ? decision.session : stripSessionSecrets(decision.session));
  });

  // POST /api/v2/sessions/import — создать сессию из экспорта другой сессии
  // (перенос истории между мирами). Тело: объект экспорта + import.project_id
  // (целевой проект; если не задан — берётся из экспорта). LLM не запускается.
  // ADR-089: это materialization-операция (создание-как-факт переноса истории),
  // а не request — идёт прямым `createSession`, минуя funnel `session.requested`.
  app.post('/import', kit.requireAuth, importRateLimit, async (c) => {
    const user = (await kit.getCurrentUser(c))!;
    const body = await c.req.json().catch(() => ({}));

    const targetProjectId = body.import?.project_id
      ?? body.import?.projectId
      ?? body.project_id
      ?? body.projectId
      ?? undefined;

    if (targetProjectId) {
      if (!projectStore) {
        return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Хранилище проектов недоступно' } }, 500);
      }
      const existing = await projectStore.load(targetProjectId);
      if (!existing) {
        return c.json({ error: { code: 'PROJECT_NOT_FOUND', message: 'Проект не найден' } }, 400);
      }
      // Безопасность: импорт привязывает сессию к проекту и выдаёт агенту его
      // workspace — без проверки доступа к проекту получается IDOR (чтение/запись
      // файлов чужого проекта).
      //
      // Импорт сессии В ПРОЕКТ — это ЗАПИСЬ в проект (инвариант 21: read-уровень
      // доступа не расширяет права на изменение), поэтому нужен уровень
      // «редактирование контента проекта» (`canEditProjectContent`: owner /
      // EDITOR / LEAD / ADMIN) — тот же, что у импорта проекта целиком
      // (`core/server/routes/project-portable.ts`, `deps.canEdit`). Участник с
      // ролью VIEWER получает 403.
      if (!canEditProjectContent(c as Parameters<typeof kit.isAdmin>[0], existing, user.id)) {
        return c.json({ error: { code: 'FORBIDDEN', message: t('auth.forbidden', undefined, c) } }, 403);
      }
    }

    // ADR-089: materialization (перенос истории), не request — прямой createSession.
    const session = await sessionManager.createSession({
      title: typeof body.title === 'string' ? body.title : undefined,
      projectId: targetProjectId,
      sessionOrigin: (body.session_origin ?? body.sessionOrigin) as Session['sessionOrigin'] | undefined,
      settings: (body.settings ?? {}) as Partial<SessionSettings>,
      userId: user.id,
      ownerId: user.id,
    });

    // Переносим историю и состояние из экспорта.
    // parentId: publish переписывает ссылки на новые remote-id до импорта — сохраняем.
    session.parentId = (body.parent_id ?? body.parentId) as string | undefined;
    const messages: Message[] = Array.isArray(body.messages) ? body.messages as Message[] : [];
    session.messages = messages.map((m) => ({ ...structuredClone(m), seq: 0 }));
    session.messages.forEach((m, i) => { m.seq = i + 1; });
    // pendingMessages — runtime-очередь, переносить бессмысленно.
    session.pendingMessages = [];
    session.todos = (body.todos ?? undefined) as Session['todos'];
    session.stickyNotes = Array.isArray(body.sticky_notes ?? body.stickyNotes)
      ? (body.sticky_notes ?? body.stickyNotes) as Session['stickyNotes']
      : [];
    session.references = Array.isArray(body.references) ? body.references as Session['references'] : [];
    session.checkpoints = Array.isArray(body.checkpoints) ? body.checkpoints as Session['checkpoints'] : [];
    session.mode = (body.mode ?? undefined) as Session['mode'];
    session.planApproved = body.plan_approved ?? body.planApproved ?? false;
    session.branchPoint = body.branch_point ?? body.branchPoint;
    // Метаданные сессии (иконка/цвет) — нормализуем legacy при импорте.
    session.icon = normalizeIconKey(body.icon);
    session.color = normalizeColorKey(body.color);
    session.obfuscationMap = (body.obfuscation_map ?? body.obfuscationMap) as Session['obfuscationMap'];
    session.createdAt = typeof (body.created_at ?? body.createdAt) === 'string'
      ? (body.created_at ?? body.createdAt)
      : session.createdAt;
    session.updatedAt = nowISO();

    // Сбрасываем runtime-состояние: блокировки/стримы с другого хоста не переносим.
    session.status = {};
    session.currentStream = undefined;
    session.summarizationPending = false;
    session.canSummarize = false;

    const num = (v: unknown, def = 0): number => (typeof v === 'number' ? v : def);
    session.inputTokens = num(body.input_tokens ?? body.inputTokens);
    session.outputTokens = num(body.output_tokens ?? body.outputTokens);
    session.totalTokens = num(body.total_tokens ?? body.totalTokens);
    session.cacheReadTokens = num(body.cache_read_tokens ?? body.cacheReadTokens);
    session.cacheWriteTokens = num(body.cache_write_tokens ?? body.cacheWriteTokens);
    session.reasoningTokens = num(body.reasoning_tokens ?? body.reasoningTokens);
    session.inputCost = num(body.input_cost ?? body.inputCost);
    session.outputCost = num(body.output_cost ?? body.outputCost);
    session.cacheReadCost = num(body.cache_read_cost ?? body.cacheReadCost);
    session.cacheWriteCost = num(body.cache_write_cost ?? body.cacheWriteCost);

    await sessionManager.saveSession(session);

    // Автоматически подписываем активных клиентов на новую сессию
    eventHub.subscribeToSession(user.id, session.id).catch((e: unknown) =>
      console.warn('subscribeToSession failed:', e),
    );
    eventBus.publish(session.id, 'session.created', serializeSession(session, { agentRegistry }));

    return c.json(serializeSession(session, { agentRegistry }), 201);
  });

  // POST /api/v2/sessions/:id/debug-system-message — отправить отладочное системное сообщение
  // RBAC: владелец сессии / elevated (ADMIN/LEAD) / участник проекта (ADR-089).
  app.post('/:id/debug-system-message', kit.requireAuth, async (c) => {
    const session = await sessionManager.getSession(c.req.param('id'));
    if (!session) {
      return c.json({ error: { code: 'NOT_FOUND', message: t('errors.notFound.session', undefined, c) } }, 404);
    }

    const user = (await kit.getCurrentUser(c))!;
    // Доступ — у единого prefix-guard'а выше (владелец/elevated/роль в проекте).

    const streamId = generateStreamId();

    const sysMsg: import('@itphx/synth-shared').Message = {
      id: streamId,
      role: MessageRole.SYSTEM,
      seq: 0,
      origin: 'local',
      parts: [{ id: generateStreamId(), type: 'text' as const, data: '' }],
      content: '',
      createdAt: nowISO(),
      disabled: false,
      pinned: false,
      hidden: false,
      author: user.username,
      metadata: { type: 'debug_system_message', reason: 'manual', stream_id: streamId },
    };

    // ADR-106 Ф4: принципал инициатора (ввод от пользователя, не системный ход).
    const turnPrincipal = resolveUserPrincipal(user.id);
    const result = await enqueueUserMessage(
      sessionManager, eventBus, session.id, sysMsg, queueManager, processMessage,
      undefined,
      turnPrincipal ? { principal: turnPrincipal } : undefined,
    );
    if (!result) {
      return c.json({ error: { code: 'QUEUE_FULL', message: 'Queue is full' } }, 429);
    }

    return c.json({ status: 'enqueued', stream_id: streamId });
  });

  // GET /api/v2/sessions/:id/optimization — настройки оптимизации контекста
  // (ADR-119). Реализация — в core-фабрике (нужна standalone/гибриду): backend
  // монтирует её ниже, единый prefix-guard покрывает доступ (инвариант 16).

  // Общая логика — в core-фабрике (backend-специфика выше). Регистрируем её
  // последней: статические/backend-only сегменты должны матчиться раньше.
  // Оптимизация контекста (ADR-119), MCP-скоуп сессии и карта обфускации живут
  // в core-фабрике — они нужны standalone/гибриду (`remote:`-сессии
  // форвардятся на backend). Свои `/:id/mcp` и `/:id/secrets` зарегистрированы
  // ВЫШЕ и сохраняют более строгую политику managed (владелец|ADMIN и
  // ADMIN|AUDITOR соответственно) — порядок регистрации оставляет её в силе.
  app.route('/', createCoreSessionRoutes(
    { requireAuth: kit.requireAuth },
    { sessionManager, eventBus, queueManager, processMessage, orchestrator, contextOptimizer, projectStore, profilesStore, requestSessionService, analytics, ...(memory ? { memory } : {}), ...(questionService ? { questionService } : {}), ...(worktreeService ? { worktreeService } : {}), ...(attachments ? { attachments } : {}), ...(backgroundService ? { backgroundService } : {}), ...(approvalRegistry ? { approvalRegistry } : {}), ...(llmAvailability ? { llmAvailability } : {}) },
    {
      resolveUserId: async (c) => (await kit.getCurrentUser(c))!.id,
      resolveOwner:  async (c) => (await kit.getCurrentUser(c))!.id,
      forkWithOwner: true,
      // Доступ к сессии обеспечивает единый prefix-guard ресурса (см. выше):
      // `registerAccessGuard: false` отключает собственный guard core-фабрики,
      // чтобы не появился второй источник правил.
      registerAccessGuard: false,
      // ADR-089: сквозной обзор сессий для ADMIN/LEAD (`GET /` — список всех).
      // Вызовы `kit.isAdmin`/`hasRole` защищены `typeof` — у мок-AuthKit в тестах
      // они могут отсутствовать.
      resolveElevated: (c) => {
        const isAdmin = typeof kit.isAdmin === 'function' && kit.isAdmin(c as Parameters<typeof kit.isAdmin>[0]);
        const isLead = typeof kit.hasRole === 'function' && kit.hasRole(c as Parameters<typeof kit.hasRole>[0], 'LEAD');
        return isAdmin || isLead;
      },
      // ADR-089: проекты-участия пользователя — проектные сессии видны участникам.
      resolveMemberProjectIds: async (_c, userId) => {
        if (!projectStore) return [];
        const projects = await projectStore.list(userId);
        return projects.map((p) => p.id);
      },
      resolveAuthor: async (c) => (await kit.getCurrentUser(c))!.username,
      // ADR-106 Ф3: принципал ответа на подтверждение — аутентифицированный
      // пользователь запроса (клиенту не доверяем) и его роли инстанса.
      resolvePermissionResponder: async (c) => {
        const user = await kit.getCurrentUser(c);
        return { kind: 'user', id: user?.id ?? '', roles: user?.roles ?? [] };
      },
      publishRenamed: false,
      publishDeletedBefore: false,
      // Instance-wide лимиты заметок сессии (`context.stickyNotes`): роуты
      // заметок — в core-фабрике, лимиты читаются резолвером (live).
      ...(getStickyNoteLimits ? { getStickyNoteLimits } : {}),
      onSessionCreated: (userId, sessionId) => { void eventHub.subscribeToSession(userId, sessionId).catch((e: unknown) => console.warn('subscribeToSession failed:', e)); },
      onSessionDeleted: (userId, sessionId) => { eventHub.unsubscribeFromSession(userId, sessionId); },
      onSessionForked:  (userId, sessionId) => { void eventHub.subscribeToSession(userId, sessionId).catch((e: unknown) => console.warn('subscribeToSession failed:', e)); },
      promptMiddleware: [createRateLimiter(30, 60_000)],
      forkMiddleware: [forkRateLimit],
      mergeMiddleware: [mergeRateLimit],
      resolveDefaultAgent,
      // ADR-036: право видеть РЕАЛЬНЫЕ значения секретов (плейсхолдер → значение)
      // в обычном чтении сессии (`GET /sessions/:id`, `GET /sessions/:id/messages`,
      // список сессий): владелец сессии + `ADMIN`/`AUDITOR` — тот же набор
      // привилегий, что у `GET /:id/secrets` и у полного экспорта сессии
      // (`createSessionExportGuard`). Остальным читателям (участник проекта
      // VIEWER/EDITOR, владелец проекта, LEAD без владения) значения
      // вычищаются из ответа — ключи-плейсхолдеры остаются.
      canRevealSecrets: async (c, session) => {
        const user = await kit.getCurrentUser(c);
        if (!user) return false;
        const ctx = c as Parameters<typeof kit.isAdmin>[0];
        if (typeof kit.isAdmin === 'function' && kit.isAdmin(ctx)) return true;
        if (typeof kit.hasRole === 'function' && kit.hasRole(ctx, 'AUDITOR')) return true;
        return (session.ownerId ?? session.userId) === user.id;
      },
      // ADR-052 (этап I): scope-гейт и проектная проекция service-key (i18n-403).
      scopeGuard,
      serviceProjectProjection,
      messages: {
        sessionNotFound: (c) => t('errors.notFound.session', undefined, c),
        forbidden: (c) => t('auth.forbidden', undefined, c),
        contentRequired: (c) => t('errors.validation.contentRequired', undefined, c),
        queueFull: (c, max) => t('errors.chat.queueFull', { max }, c),
        steerLimitExceeded: (c, max) => t('errors.chat.steerLimitExceeded', { max }, c),
        // Отключённые провайдер/модель — понятные 400 до постановки в очередь.
        providerDisabled: (c, provider) => t('errors.chat.providerDisabled', { provider }, c),
        modelDisabled: (c, provider, model) => t('errors.chat.modelDisabled', { provider, model }, c),
        // Лимиты заметок сессии (`context.stickyNotes`) — instance-wide.
        noteNotFound: (c) => t('errors.notFound.note', undefined, c),
        noteLimitReached: (c, max) => t('errors.conflict.noteLimitReached', { max }, c),
        noteTooLong: (c, max) => t('errors.validation.noteTooLong', { max }, c),
      },
    },
  ));

  return app;
}
