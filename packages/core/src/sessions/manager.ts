import type { Session, Message, SessionSettings, Checkpoint, SessionOrigin, SessionReference, McpServerToolSettings, Project } from '@itphx/synth-shared';
import { getForkedTitle, MessageRole } from '@itphx/synth-shared';
import { nowISO, generateId, makeTextPart, makePart, stripNullBytes, stripNullBytesDeep } from '@itphx/synth-shared';
import { t as sm, i18n as i18nMeta } from '../engine/system-messages.js';
import type { SessionRepository } from '../storage/ports/session-repository.js';
import type { ProjectRepository } from '../storage/ports/project-repository.js';
import type { HookBus } from '../engine/hooks/hook-bus.js';
import { mergeMcpToolSettings } from '../engine/mcp/settings.js';
import type { ActivityMeasure, AnalyticsRecorder } from '../analytics/recorder.js';
import { activityMeasureForMessage, sessionAxes } from '../analytics/recorder.js';

/** Структурный контракт загрузки проекта (для снапшотов скоупа). */
export type SessionProjectStoreLike = Pick<ProjectRepository, 'load'>;

export interface SessionManagerOptions {
  /** Поставщик глобальных настроек доступности MCP-серверов (runtime settings). */
  mcpSettingsProvider?: () => Promise<Record<string, McpServerToolSettings> | undefined>;
  /** ADR-071 §2.4 / ADR-046 §4.5: загрузка проекта — снапшот `defaultOn` при создании сессии. */
  projectStore?: SessionProjectStoreLike;
  /**
   * ADR-071 §2.4 / ADR-046 §4.5: системные дефолты для сессий БЕЗ проекта —
   * снапшоты `mcpDefaultOn`/`skillsDefaultOn` при создании.
   */
  systemDefaultsProvider?: () => Promise<{ mcpDefaultOn?: string[]; skillsDefaultOn?: string[] } | undefined>;
  /**
   * ADR-030: ядровая шина хуков — `session_start` (создание) и `session_end`
   * (удаление). Не задана — эмиты не выполняются, поведение менеджера не меняется.
   */
  hooks?: HookBus;
  /**
   * PROP-102: сборщик аналитики — точка персиста сообщения инкрементирует
   * `messages_assistant`/`messages_tool` (семейство `activity`). Не задан —
   * запись не выполняется (поведение прежнее).
   */
  analytics?: AnalyticsRecorder;
}

export interface SessionTree {
  session: Session | null;
  children: SessionTree[];
}

/**
 * Санитизация нового сообщения перед записью: PostgreSQL не принимает U+0000
 * ни в `text`, ни в `jsonb`, поэтому NUL-байты удаляются в доменном слое —
 * одинаково для file/memory/postgres backend'ов (история/UI тоже чистая).
 */
function sanitizeMessageNullBytes(message: Message): Message {
  if (typeof message.content === 'string') message.content = stripNullBytes(message.content);
  if (typeof message.reasoning === 'string') message.reasoning = stripNullBytes(message.reasoning);
  if (message.parts) message.parts = stripNullBytesDeep(message.parts);
  if (message.toolCalls) message.toolCalls = stripNullBytesDeep(message.toolCalls);
  if (message.metadata) message.metadata = stripNullBytesDeep(message.metadata);
  if (message.debugData) message.debugData = stripNullBytesDeep(message.debugData);
  if (message.promptMeta) message.promptMeta = stripNullBytesDeep(message.promptMeta);
  return message;
}

/**
 * Лёгкая проекция «свои сессии» (паритет с `listForUser`): владелец задан в
 * `userId`/`ownerIds`. Применяется к лёгкому списку (`listLight`), где сообщения
 * не нужны.
 */
function filterByUser(sessions: Session[], userId: string, ownerIds: string[]): Session[] {
  const ids = new Set<string>([userId, ...ownerIds]);
  return sessions.filter(
    (s) => (s.userId !== undefined && ids.has(s.userId))
      || (s.ownerId !== undefined && ids.has(s.ownerId)),
  );
}

/**
 * Лёгкая проекция «свои + сессии проектов участия» (паритет с `listForUserScope`,
 * ADR-089).
 */
function filterByUserScope(
  sessions: Session[],
  userId: string,
  projectIds: string[],
  ownerIds: string[],
): Session[] {
  const ids = new Set<string>([userId, ...ownerIds]);
  return sessions.filter(
    (s) => (s.userId !== undefined && ids.has(s.userId))
      || (s.ownerId !== undefined && ids.has(s.ownerId))
      || (s.projectId !== undefined && projectIds.includes(s.projectId)),
  );
}

export class SessionManager {
  private _locks = new Map<string, Promise<void>>();

  constructor(private store: SessionRepository, private _options: SessionManagerOptions = {}) {}

  private _getLock(sessionId: string): Promise<void> {
    if (!this._locks.has(sessionId)) {
      this._locks.set(sessionId, Promise.resolve());
    }
    return this._locks.get(sessionId)!;
  }

  private _setLock(sessionId: string, promise: Promise<void>): void {
    this._locks.set(sessionId, promise);
  }

  async withLock<T>(sessionId: string, fn: (session: Session) => Promise<T>): Promise<T> {
    const prevLock = this._getLock(sessionId);
    let release: () => void;
    const newLock = new Promise<void>((resolve) => { release = resolve; });
    this._setLock(sessionId, newLock);

    await prevLock;
    try {
      const session = await this.store.load(sessionId);
      if (!session) throw new Error(`Session ${sessionId} not found`);
      return await fn(session);
    } finally {
      release!();
    }
  }

  async getSession(sessionId: string): Promise<Session | null> {
    return this.store.load(sessionId);
  }

  async createSession(data: { title?: string; icon?: string; color?: string; projectId?: string; parentId?: string; sessionOrigin?: SessionOrigin; settings?: Partial<SessionSettings>; userId?: string; ownerId?: string; expiresAt?: string } = {}): Promise<Session> {
    const mcpToolSettings = await this._resolveMcpToolSettings(data.settings?.mcpToolSettings);
    const session: Session = {
      id: generateId(),
      title: data.title || sm('session.default_title'),
      icon: data.icon,
      color: data.color,
      sessionOrigin: data.sessionOrigin || 'user',
      parentId: data.parentId,
      userId: data.userId || '',
      // ADR-075/D5: владелец сессии нужен для атрибуции при RBAC проектных данных
      // (plan_write). Раньше поле объявлялось, но не проставлялось.
      ownerId: data.ownerId || data.userId || '',
      projectId: data.projectId,
      messages: [],
      pendingMessages: [],
      status: {},
      settings: {
        temperature: data.settings?.temperature ?? 0.7,
        maxTokens: data.settings?.maxTokens ?? 4096,
        debugEnabled: data.settings?.debugEnabled ?? true,
        streamEnabled: data.settings?.streamEnabled ?? true,
        contextOptimization: data.settings?.contextOptimization ?? 'none',
        slidingWindowMode: data.settings?.slidingWindowMode ?? 'messages',
        slidingWindowMessageLimit: data.settings?.slidingWindowMessageLimit ?? 10,
        slidingWindowTokenThreshold: data.settings?.slidingWindowTokenThreshold ?? 80,
        summarizationEnabled: data.settings?.summarizationEnabled ?? false,
        summarizationTriggerMode: data.settings?.summarizationTriggerMode ?? 'messages',
        summarizeAfterN: data.settings?.summarizeAfterN ?? 10,
        summarizeTokenThreshold: data.settings?.summarizeTokenThreshold ?? 50,
        summarizationHeadMessages: data.settings?.summarizationHeadMessages ?? 2,
        summarizationTailMessages: data.settings?.summarizationTailMessages ?? 3,
        showInterview: data.settings?.showInterview ?? true,
        websocketEnabled: data.settings?.websocketEnabled ?? true,
        // ADR-071 §2.1: активные MCP-серверы сессии. Раньше терялись при создании
        // (`POST /sessions` с `settings.mcpServers`) — сессия теряла их.
        mcpServers: data.settings?.mcpServers,
        // ADR-071 §2.4: явные opt-out сессии (включая системные) не теряются.
        mcpDisabledServers: data.settings?.mcpDisabledServers,
        // ADR-046 §4.5: session-level overrides скиллов (ранее терялись при создании).
        skills: data.settings?.skills,
        skillsDisabled: data.settings?.skillsDisabled,
        provider: data.settings?.provider,
        model: data.settings?.model,
        systemPrompt: data.settings?.systemPrompt,
        agentRole: data.settings?.agentRole,
        language: data.settings?.language,
        planMode: data.settings?.planMode,
        // ADR-071 §2.3: per-session override политик встроенных/MCP-инструментов
        // не теряется при создании.
        toolsPolicy: data.settings?.toolsPolicy,
        mcpPolicy: data.settings?.mcpPolicy,
        // ADR-029: per-session override гранулярных permissions не теряется при
        // создании. Раньше опускался в whitelist — none-режим саб-агента (создание
        // через `createSession`/funnel) терял унаследованные от родителя правила, а
        // resume (`child.settings.permission ?? deps.permissionConfig`) брал
        // глобальный конфиг вместо родительского.
        permission: data.settings?.permission,
        routingEnabled: data.settings?.routingEnabled ?? false,
        routingStrategy: data.settings?.routingStrategy ?? 'auto',
        routingContent: data.settings?.routingContent ?? { coding: { provider: '', model: '' }, chat: { provider: '', model: '' }, research: { provider: '', model: '' } },
        routingEscalation: data.settings?.routingEscalation ?? { enabled: false, fallbackProvider: '', fallbackModel: '', checks: ['min_length', 'constraint'], minLength: 10 },
        routingCost: data.settings?.routingCost ?? { enabled: false, cheapProvider: '', cheapModel: '', maxCheapTokens: 500 },
        subagentRouting: data.settings?.subagentRouting ?? { enabled: false },
        microFirst: data.settings?.microFirst ?? false,
        microConfidenceThreshold: data.settings?.microConfidenceThreshold ?? 0.8,
        embeddingEnabled: data.settings?.embeddingEnabled ?? false,
        embedProvider: data.settings?.embedProvider ?? 'ollama',
        embedModel: data.settings?.embedModel ?? 'local.nomic-embed-text:latest',
        mcpToolSettings,
      },
      checkpoints: [],
      stickyNotes: [],
      references: [],
      summarizationPending: false,
      canSummarize: false,
      inputCost: 0,
      outputCost: 0,
      cacheReadCost: 0,
      cacheWriteCost: 0,
      cacheHitRate: 0,
      createdAt: nowISO(),
      updatedAt: nowISO(),
      // ADR-089: ephemeral-сессия архивируется sweeper'ом по `expiresAt`.
      expiresAt: data.expiresAt,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
    };
    // ADR-071 §2.4 / ADR-046 §4.5: снапшоты скоупа на момент создания сессии.
    await this._materializeScopeSnapshots(session, data.projectId, data.settings);
    await this.store.save(session);
    // ADR-030: `session_start` — неблокирующий эмит после сохранения сессии.
    this._options.hooks?.emitAsync('session_start', {
      sessionId: session.id,
      ...(data.projectId ? { projectId: data.projectId } : {}),
      ...(session.settings.agentRole ? { agent: session.settings.agentRole } : {}),
      // PROP-102: ось `user` для сборщика `activity` — значение уже под рукой.
      ...(session.userId ? { userId: session.userId } : {}),
    });
    return session;
  }

  /**
   * ADR-071 §2.4 / ADR-046 §4.5: материализует `mcpDefaultOn`/`skillsDefaultOn`
   * сессии из `project.defaultOn` (или системного дефолта, если проекта нет).
   * Явно переданные в `settings` значения не перетираются. Не заданы нигде —
   * остаются `undefined` (legacy-режим каталога до миграции).
   */
  private async _materializeScopeSnapshots(
    session: Session,
    projectId: string | undefined,
    settings?: Partial<SessionSettings>,
  ): Promise<void> {
    let mcpDefaultOn = settings?.mcpDefaultOn;
    let skillsDefaultOn = settings?.skillsDefaultOn;
    if (mcpDefaultOn !== undefined && skillsDefaultOn !== undefined) {
      session.settings.mcpDefaultOn = mcpDefaultOn;
      session.settings.skillsDefaultOn = skillsDefaultOn;
      return;
    }

    let project: Project | null = null;
    if (projectId && this._options.projectStore) {
      project = await this._options.projectStore.load(projectId).catch(() => null);
    }
    if (project) {
      if (mcpDefaultOn === undefined) mcpDefaultOn = project.mcp?.defaultOn;
      if (skillsDefaultOn === undefined) skillsDefaultOn = project.skills?.defaultOn;
    }
    if ((mcpDefaultOn === undefined || skillsDefaultOn === undefined) && this._options.systemDefaultsProvider) {
      const systemDefaults = await this._options.systemDefaultsProvider().catch(() => undefined);
      if (mcpDefaultOn === undefined) mcpDefaultOn = systemDefaults?.mcpDefaultOn;
      if (skillsDefaultOn === undefined) skillsDefaultOn = systemDefaults?.skillsDefaultOn;
    }
    if (mcpDefaultOn !== undefined) session.settings.mcpDefaultOn = mcpDefaultOn;
    if (skillsDefaultOn !== undefined) session.settings.skillsDefaultOn = skillsDefaultOn;
  }

  private async _resolveMcpToolSettings(
    local?: Record<string, McpServerToolSettings>,
  ): Promise<Record<string, McpServerToolSettings> | undefined> {
    if (!local && !this._options.mcpSettingsProvider) return undefined;
    const global = this._options.mcpSettingsProvider
      ? await this._options.mcpSettingsProvider()
      : undefined;
    return mergeMcpToolSettings(global, local);
  }

  async deleteSession(sessionId: string): Promise<void> {
    await this.store.delete(sessionId);
    this._locks.delete(sessionId);
    // ADR-030: `session_end` — неблокирующий эмит после удаления сессии.
    this._options.hooks?.emitAsync('session_end', { sessionId });
  }

  async listSessions(
    filter?: { projectId?: string; userId?: string; projectIds?: string[]; ownerIds?: string[] },
    options?: { includeArchived?: boolean; light?: boolean },
  ): Promise<Session[]> {
    // ADR-089: `projectIds` — командная видимость (свои + сессии проектов-участий),
    // `userId` — только свои. Оба заданы — `projectIds` приоритетнее (он шире).
    // `ownerIds` — доп. id владельца (standalone: legacy-UUID профиля `local`,
    // нормализованный при чтении, ADR-089).
    // `light` — метаданные без истории (`SessionRepository.listLight`): вызывающие,
    // которым нужны только id/статус/projectId/settings и т.п. Лёгкая выборка
    // получается целиком (без фильтра) и «свои/проектные» проекции считаются в
    // памяти — семантика идентична `listForUser`/`listForUserScope`, но без
    // загрузки `messages`/`checkpoints`.
    const light = options?.light === true;
    let sessions: Session[];
    if (filter?.projectIds) {
      sessions = light
        ? filterByUserScope(await this.store.listLight(), filter.userId ?? '', filter.projectIds, filter.ownerIds ?? [])
        : await this.store.listForUserScope(filter.userId ?? '', filter.projectIds, filter.ownerIds);
    } else if (filter?.userId) {
      sessions = light
        ? filterByUser(await this.store.listLight(), filter.userId, filter.ownerIds ?? [])
        : await this.store.listForUser(filter.userId, filter.ownerIds);
    } else {
      sessions = light ? await this.store.listLight(filter) : await this.store.list(filter);
    }
    // ADR-089: архивированные сессии скрыты из списков по умолчанию (доступ — getSession по id).
    if (options?.includeArchived) return sessions;
    return sessions.filter((s) => !s.archivedAt);
  }

  async listActiveSessions(options?: { includeArchived?: boolean }): Promise<Session[]> {
    // Лёгкая выборка: нужны только `status.blocked`/`currentStream` (без истории).
    const sessions = await this.listSessions(undefined, { ...options, light: true });
    return sessions.filter((s) => s.status.blocked || s.currentStream);
  }

  /**
   * ADR-089: архивирует сессию (идемпотентно). Уже архивированная или
   * отсутствующая — `null`. Успешный архив эмитит `session_end` (ADR-030).
   */
  async archiveSession(sessionId: string): Promise<Session | null> {
    const session = await this.store.load(sessionId);
    if (!session || session.archivedAt) return null;
    session.archivedAt = nowISO();
    session.updatedAt = nowISO();
    await this.store.save(session);
    // PROP-102: `archived:true` отличает архив от удаления (мера `sessions_archived`).
    this._options.hooks?.emitAsync('session_end', {
      sessionId,
      archived: true,
      ...sessionAxes(session),
    });
    return session;
  }

  /**
   * ADR-089: архивирует все ephemeral-сессии с истёкшим `expiresAt`
   * (`expiresAt <= now`, `archivedAt` не задан). Возвращает id архивированных.
   */
  async archiveExpired(now: Date = new Date()): Promise<string[]> {
    // Лёгкая выборка: нужны только `expiresAt`/`archivedAt`; архивация подгружает
    // сессию целиком (`archiveSession` → `store.load`), поэтому история не теряется.
    const sessions = await this.listSessions(undefined, { includeArchived: true, light: true });
    const archived: string[] = [];
    for (const session of sessions) {
      if (!session.expiresAt || session.archivedAt) continue;
      const expiresAt = Date.parse(session.expiresAt);
      if (Number.isNaN(expiresAt) || expiresAt > now.getTime()) continue;
      const result = await this.archiveSession(session.id);
      if (result) archived.push(session.id);
    }
    return archived;
  }

  async updateSession(session: Session): Promise<void> {
    session.updatedAt = nowISO();
    await this.store.save(session);
  }

  async saveSession(session: Session): Promise<void> {
    await this.store.save(session);
  }

  async acquireLock(sessionId: string, processId: string): Promise<boolean> {
    return this.withLock(sessionId, async (session) => {
      if (session.status.blocked) return false;
      session.status.blocked = processId;
      session.status.blockedAt = nowISO();
      await this.store.save(session);
      return true;
    });
  }

  async releaseLock(sessionId: string, processId: string): Promise<boolean> {
    return this.withLock(sessionId, async (session) => {
      if (session.status.blocked !== processId) return false;
      session.status.blocked = undefined;
      session.status.blockedAt = undefined;
      await this.store.save(session);
      return true;
    });
  }

  async forceReleaseLock(sessionId: string): Promise<boolean> {
    return this.withLock(sessionId, async (session) => {
      session.status.blocked = undefined;
      session.status.blockedAt = undefined;
      await this.store.save(session);
      return true;
    });
  }

  async cleanupStaleLocks(timeoutMinutes = 15): Promise<string[]> {
    // ADR-089: архивированные сессии тоже могут держать устаревший lock — проходим все.
    // Лёгкая выборка: нужен только `status.blocked`/`blockedAt`.
    const sessions = await this.listSessions(undefined, { includeArchived: true, light: true });
    const stale: string[] = [];
    const now = new Date();

    for (const s of sessions) {
      if (!s.status.blocked) continue;
      if (!s.status.blockedAt) {
        stale.push(s.id);
        await this.forceReleaseLock(s.id);
        continue;
      }
      const blockedAt = new Date(s.status.blockedAt);
      if (now.getTime() - blockedAt.getTime() > timeoutMinutes * 60_000) {
        stale.push(s.id);
        await this.forceReleaseLock(s.id);
      }
    }
    return stale;
  }

  async addMessage(sessionId: string, message: Message): Promise<Session | null> {
    return this.withLock(sessionId, async (session) => {
      if (!message.id) message.id = generateId();
      if (!message.seq) message.seq = session.messages.length + 1;
      if (!message.origin) message.origin = 'local';
      if (!message.parts || message.parts.length === 0) {
        message.parts = [makeTextPart(message.content)];
      }
      sanitizeMessageNullBytes(message);
      session.messages.push(message);
      session.updatedAt = nowISO();
      await this.store.save(session);
      // PROP-102: точка персиста сообщения — инкремент `activity`
      // (`messages_assistant`/`messages_tool`); пользовательские сообщения
      // персистит `QueueProcessor` (своя точка записи). Скрытые промежуточные
      // assistant-сообщения tool-chain не считаем (паритет с `computeSessionStats`).
      // Запись best-effort: рекордер не пробрасывает ошибки и не блокирует сохранение.
      const measure =
        message.metadata?.tool_chain === true ? null : activityMeasureForMessage(message.role);
      if (measure) {
        void this._options.analytics?.recordActivity(measure, sessionAxes(session));
      }
      return session;
    });
  }

  /**
   * PROP-032: точечная дозапись сообщения (без чтения/перезаписи всей истории).
   * `id`/`seq`/`origin` назначает порт (`SessionRepository.appendMessage`),
   * здесь — NUL-санитайзинг и best-effort аналитика (та же, что в `addMessage`).
   */
  async appendMessage(sessionId: string, message: Message): Promise<Message | null> {
    sanitizeMessageNullBytes(message);
    const saved = await this.store.appendMessage(sessionId, message);
    if (!saved) return null;

    // Черновик частичного стрима (`metadata.streaming`) — промежуточный:
    // активность запишет финальный `updateMessage(..., { recordActivity: true })`
    // (или сообщение останется прерванным). Иначе один и тот же ответ
    // посчитался бы дважды — при создании черновика и при его финализации.
    const measure =
      saved.metadata?.tool_chain === true || saved.metadata?.streaming === true
        ? null
        : activityMeasureForMessage(saved.role);
    if (measure) {
      void this._recordAppendActivity(sessionId, measure);
    }
    return saved;
  }

  /**
   * PROP-032: точечное обновление существующего сообщения (без перезаписи
   * истории). По умолчанию аналитика не инкрементируется — нового сообщения
   * нет. `recordActivity` нужен финализации черновика частичного стрима
   * (шаг 2б): само сообщение уже создано `appendMessage` (там активность не
   * писалась), поэтому финальный `updateMessage` — единственная точка учёта.
   */
  async updateMessage(
    sessionId: string,
    message: Message,
    opts?: { recordActivity?: boolean },
  ): Promise<Message | null> {
    sanitizeMessageNullBytes(message);
    const saved = await this.store.updateMessage(sessionId, message);
    if (!saved) return null;

    if (opts?.recordActivity && saved.metadata?.tool_chain !== true) {
      const measure = activityMeasureForMessage(saved.role);
      if (measure) {
        void this._recordAppendActivity(sessionId, measure);
      }
    }
    return saved;
  }

  /**
   * Шаг 2б: восстановление сообщений, «зависших» после падения/рестарта.
   *
   * - `metadata.streaming === true` → `streaming:false`, `interrupted:true`,
   *   `metadata.status='error'` (частичный текст остаётся в истории);
   * - assistant с `toolCalls`, для которого хотя бы у одного `id` нет
   *   последующего tool-сообщения с этим `toolCallId`, помечается
   *   `disabled:true` + `metadata.interrupted:true` — `sessionMessagesToLlm`
   *   не отдаст провайдеру assistant(tool_calls) без пары (осиротевшие
   *   tool-сообщения он и так превращает в user-текст).
   *
   * Запись — одна, под `withLock`, и только если что-то изменилось.
   * Возвращает число исправленных сообщений.
   */
  async recoverStreamingMessages(sessionId: string): Promise<number> {
    return this.withLock(sessionId, async (session) => {
      let changed = 0;

      for (const message of session.messages) {
        if (message.metadata?.streaming === true) {
          message.metadata = {
            ...message.metadata,
            streaming: false,
            interrupted: true,
            status: 'error',
          };
          changed++;
        }
      }

      for (let i = 0; i < session.messages.length; i++) {
        const message = session.messages[i]!;
        if (message.role !== MessageRole.ASSISTANT || !message.toolCalls || message.toolCalls.length === 0) {
          continue;
        }
        const callIds = message.toolCalls
          .map((call) => (typeof call.id === 'string' ? call.id : null))
          .filter((id): id is string => id !== null);
        if (callIds.length === 0) continue;

        // Пары ищем только среди последующих tool-сообщений: tool обязан идти
        // после своего assistant(tool_calls) в OpenAI-совместимой истории.
        const laterToolIds = new Set<string>();
        for (let j = i + 1; j < session.messages.length; j++) {
          const candidate = session.messages[j]!;
          if (candidate.role === MessageRole.TOOL && candidate.toolCallId) {
            laterToolIds.add(candidate.toolCallId);
          }
        }

        const hasOrphan = callIds.some((id) => !laterToolIds.has(id));
        if (!hasOrphan) continue;
        if (message.disabled === true && message.metadata?.interrupted === true) continue;

        message.disabled = true;
        message.metadata = { ...(message.metadata ?? {}), interrupted: true };
        changed++;
      }

      if (changed > 0) {
        session.updatedAt = nowISO();
        await this.store.save(session);
      }
      return changed;
    });
  }

  /**
   * PROP-102: `activity` для дозаписанного сообщения. Оси `user`/`project`
   * берутся из **метаданных** сессии (`loadLight`), а не из полной истории:
   * запись остаётся дешёвой и best-effort — ошибки чтения/рекордера не всплывают.
   */
  private async _recordAppendActivity(sessionId: string, measure: ActivityMeasure): Promise<void> {
    const analytics = this._options.analytics;
    if (!analytics) return;
    try {
      const meta = await this.store.loadLight(sessionId);
      await analytics.recordActivity(measure, sessionAxes(meta));
    } catch {
      // best-effort: аналитика не должна ломать персист сообщения
    }
  }

  async addPendingMessage(sessionId: string, message: Message, maxPending = 5): Promise<Session | null> {
    return this.withLock(sessionId, async (session) => {
      if (session.pendingMessages.length >= maxPending) return null;
      if (!message.id) message.id = generateId();
      if (!message.origin) message.origin = 'local';
      if (!message.parts || message.parts.length === 0) {
        message.parts = [makeTextPart(message.content)];
      }
      sanitizeMessageNullBytes(message);
      session.pendingMessages.push(message);
      session.updatedAt = nowISO();
      await this.store.save(session);
      return session;
    });
  }

  async createCheckpoint(sessionId: string): Promise<Session | null> {
    return this.withLock(sessionId, async (session) => {
      const checkpoint: Checkpoint = {
        id: generateId(),
        sessionId: session.id,
        messages: JSON.parse(JSON.stringify(session.messages)),
        createdAt: nowISO(),
      };
      session.checkpoints.push(checkpoint);
      session.updatedAt = nowISO();
      await this.store.save(session);
      return session;
    });
  }

  async restoreCheckpoint(sessionId: string, checkpointId: string): Promise<Session | null> {
    return this.withLock(sessionId, async (session) => {
      const checkpoint = session.checkpoints.find((c) => c.id === checkpointId);
      if (!checkpoint) throw new Error(`Checkpoint ${checkpointId} not found`);
      session.messages = JSON.parse(JSON.stringify(checkpoint.messages));
      session.updatedAt = nowISO();
      await this.store.save(session);
      return session;
    });
  }

  async safeUpdate(sessionId: string, updateFn: (session: Session) => Promise<void> | void): Promise<void> {
    await this.withLock(sessionId, async (stored) => {
      await updateFn(stored);
      stored.updatedAt = nowISO();
      await this.store.save(stored);
    });
  }

  async renameSession(sessionId: string, title: string): Promise<Session | null> {
    return this.withLock(sessionId, async (s) => {
      s.title = title;
      s.updatedAt = nowISO();
      await this.store.save(s);
      return s;
    });
  }

  /**
   * Дочерние сессии. `options.light` — метаданные без истории (нужны только
   * `id`/`title`/`parentId`): оптимизация для дерева (`getSessionTree`) и
   * fork (уникализация title). По умолчанию — полная сессия (роут
   * `GET /:id/children` и CLI `children` сериализуют/считают сообщения).
   */
  async getChildren(parentId: string, options?: { light?: boolean }): Promise<Session[]> {
    return options?.light === true
      ? this.store.listLight({ parentId })
      : this.store.list({ parentId });
  }

  async getSessionTree(rootId: string): Promise<SessionTree> {
    const root = await this.getSession(rootId);
    // Дети нужны только для рекурсии по `id`; сами сессии загружаются `getSession`.
    const children = await this.getChildren(rootId, { light: true });
    const childTrees = await Promise.all(
      children.map((c) => this.getSessionTree(c.id)),
    );
    return { session: root, children: childTrees };
  }

  async addReference(
    targetSessionId: string,
    sourceSessionId: string,
    options: { label?: string; messageRange?: [number, number]; autoSummarize?: boolean; position?: 'after' | 'before' },
  ): Promise<SessionReference> {
    return this.withLock(targetSessionId, async (target) => {
      const source = await this.getSession(sourceSessionId);
      if (!source) throw new Error(`Source session ${sourceSessionId} not found`);

      const range: [number, number] = options.messageRange || [1, source.messages.length];
      const label = options.label || source.title || sm('session.reference_label');

      let autoSummary: string | undefined;
      if (options.autoSummarize && range[0] <= range[1]) {
        const msgsInRange = source.messages
          .filter((m: Message) => m.seq >= range[0] && m.seq <= range[1] && !m.hidden && !m.disabled);
        autoSummary = msgsInRange
          .map((m: Message) => `[${m.role}]: ${m.content.slice(0, 200)}${m.content.length > 200 ? '...' : ''}`)
          .join(' | ');
      }

      const ref: SessionReference = {
        type: 'session_reference',
        sessionId: sourceSessionId,
        label,
        messageRange: range,
        autoSummary,
        createdAt: nowISO(),
      };

      if (!target.references) target.references = [];
      const existingIdx = target.references.findIndex((r) => r.sessionId === sourceSessionId);
      if (existingIdx >= 0) {
        target.references[existingIdx] = ref;
      } else {
        target.references.push(ref);
      }

      const refMessage: Message = {
        id: generateId(),
        role: MessageRole.INFO,
        seq: target.messages.length + 1,
        origin: 'local',
        parts: [makePart('session_reference', {
          sessionId: ref.sessionId,
          label: ref.label,
          messageRange: ref.messageRange,
          autoSummary: ref.autoSummary,
        })],
        content: sm('session.reference_link', { label, id: sourceSessionId, from: String(range[0]), to: String(range[1]) }),
        createdAt: nowISO(),
        disabled: false,
        pinned: false,
        hidden: false,
        metadata: {
          type: 'session_reference',
          session_id: sourceSessionId,
          i18n: i18nMeta('session.reference_link', { label, id: sourceSessionId, from: String(range[0]), to: String(range[1]) }),
        },
      };
      if (options.position === 'before') {
        target.messages.unshift(refMessage);
      } else {
        target.messages.push(refMessage);
      }
      target.messages.forEach((m, i) => { m.seq = i + 1; });

      target.updatedAt = nowISO();
      await this.store.save(target);
      return ref;
    });
  }

  async batchMessageOperation(
    sessionId: string,
    action: 'pin' | 'toggle' | 'delete',
    indices: number[],
    state?: boolean,
  ): Promise<{ results: Array<{ index: number; success: boolean; state?: boolean }> }> {
    return this.withLock(sessionId, async (session) => {
      const results: Array<{ index: number; success: boolean; state?: boolean }> = [];
      const sorted = action === 'delete'
        ? [...indices].sort((a, b) => b - a)
        : [...indices].sort((a, b) => a - b);

      for (const idx of sorted) {
        const msg = session.messages[idx];
        if (!msg) { results.push({ index: idx, success: false }); continue; }

        if (action === 'pin') {
          msg.pinned = state !== undefined ? state : !msg.pinned;
          results.push({ index: idx, success: true, state: msg.pinned });
        } else if (action === 'toggle') {
          msg.disabled = state !== undefined ? state : !msg.disabled;
          results.push({ index: idx, success: true, state: msg.disabled });
        } else if (action === 'delete') {
          session.messages.splice(idx, 1);
          results.push({ index: idx, success: true });
        }
      }

      session.messages.forEach((m, i) => { m.seq = i + 1; });
      session.updatedAt = new Date().toISOString();
      await this.store.save(session);
      return { results };
    });
  }

  async removeReference(targetSessionId: string, refSessionId: string): Promise<void> {
    return this.withLock(targetSessionId, async (session) => {
      if (session.references) {
        session.references = session.references.filter((r) => r.sessionId !== refSessionId);
      }
      session.messages = session.messages.filter(
        (m) => m.metadata?.type !== 'session_reference' || m.metadata?.session_id !== refSessionId,
      );
      session.updatedAt = nowISO();
      await this.store.save(session);
    });
  }

  async getReferences(sessionId: string): Promise<SessionReference[]> {
    return this.store.getReferences(sessionId);
  }

  async mergeMessages(
    targetSessionId: string,
    sourceSessionId: string,
    options: {
      sourceRange: [number, number];
      position: 'after' | 'before';
      anchorMessageId?: string;
      summarize?: boolean;
    },
  ): Promise<Message[]> {
    return this.withLock(targetSessionId, async (target) => {
      const source = await this.getSession(sourceSessionId);
      if (!source) throw new Error(`Source session ${sourceSessionId} not found`);

      const [fromSeq, toSeq] = options.sourceRange;
      const sourceMsgs = source.messages.filter(
        (m) => m.seq >= fromSeq && m.seq <= toSeq && !m.hidden && !m.disabled,
      );

      if (sourceMsgs.length === 0) return [];

      let messagesToInsert: Message[];
      if (options.summarize) {
        const combined = sourceMsgs.map((m) => `[${m.role}]: ${m.content}`).join('\n\n');
        const summaryMsg: Message = {
          id: generateId(),
          role: MessageRole.SUMMARY,
          seq: 0,
          origin: 'merged',
          sourceMsgId: sourceSessionId,
          parts: [makeTextPart(combined.slice(0, 4000))],
          content: combined.slice(0, 4000),
          createdAt: nowISO(),
          disabled: false,
          pinned: false,
          hidden: false,
          metadata: { type: 'merged_summary', source_session_id: sourceSessionId, source_range: [fromSeq, toSeq] },
        };
        messagesToInsert = [summaryMsg];
      } else {
        messagesToInsert = sourceMsgs.map((m) => ({
          ...structuredClone(m),
          id: generateId(),
          origin: 'merged' as const,
          sourceMsgId: m.id,
          seq: 0,
        }));
      }

      let anchorIdx = target.messages.length;
      if (options.anchorMessageId) {
        const found = target.messages.findIndex((m) => m.id === options.anchorMessageId);
        if (found >= 0) {
          anchorIdx = options.position === 'after' ? found + 1 : found;
        }
      } else if (options.position === 'before') {
        anchorIdx = 0;
      }

      target.messages.splice(anchorIdx, 0, ...messagesToInsert);
      for (let i = 0; i < target.messages.length; i++) {
        const msg = target.messages[i];
        if (msg) msg.seq = i + 1;
      }
      target.updatedAt = nowISO();
      await this.store.save(target);
      return messagesToInsert;
    });
  }

  async forkSession(
    sourceSessionId: string,
    options: { messageId?: string; messageIndex?: number; title?: string; userId?: string; ownerId?: string },
  ): Promise<Session> {
    return this.withLock(sourceSessionId, async (source) => {
      // Нужны только заголовки детей (уникализация title) — метаданные без истории.
      const siblings = await this.getChildren(sourceSessionId, { light: true });
      const existingTitles = siblings.map((s) => s.title || '');
      const forkedTitle = options.title || getForkedTitle(source.title, existingTitles);

      // ADR-089: materialization (ветвление как факт копии истории), не request —
      // прямой `createSession`; funnel `session.requested` сюда не применяется.
      const forked = await this.createSession({
        title: forkedTitle,
        icon: source.icon,
        color: source.color,
        projectId: source.projectId,
        sessionOrigin: 'fork' as SessionOrigin,
        parentId: sourceSessionId,
        settings: { ...source.settings },
        // ADR-075/D5: при отсутствии явной атрибуции наследуем владельца источника,
        // иначе форк терял владельца и выпадал из RBAC проектных данных.
        userId: options.userId ?? source.userId,
        ownerId: options.ownerId ?? source.ownerId,
      });

      const cutoffIdx = options.messageIndex != null
        ? options.messageIndex
        : options.messageId
          ? source.messages.findIndex((m) => m.id === options.messageId)
          : source.messages.length;

      forked.branchPoint = options.messageId
        ?? (options.messageIndex != null && cutoffIdx >= 0 ? source.messages[cutoffIdx]?.id : undefined);

      const includeBranchMsg = cutoffIdx >= 0 && source.messages[cutoffIdx]?.role === MessageRole.ASSISTANT;
      const allSourceMsgs = cutoffIdx >= 0
        ? source.messages.slice(0, cutoffIdx + (includeBranchMsg ? 1 : 0))
        : [...source.messages];

      // Копируем только не скрытые и не отключенные сообщения
      const msgsToCopy = allSourceMsgs.filter((m) => !m.hidden && !m.disabled);

      forked.messages = msgsToCopy.map((m, i) => ({
        ...structuredClone(m),
        id: generateId(),
        seq: i + 1,
        origin: 'inherited' as const,
        sourceMsgId: m.id,
      }));

      // Копируем активные заметки родительской сессии
      forked.stickyNotes = source.stickyNotes
        .filter((n) => !n.disabled)
        .map((n) => ({ ...structuredClone(n), id: generateId() }));

      forked.pendingMessages = [];

      await this.store.save(forked);
      return forked;
    });
  }
}
