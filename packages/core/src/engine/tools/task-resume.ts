/**
 * Resume прерванной/ошибочной дочерней сессии саб-агента (B2).
 *
 * Пользователь может продолжить оборванную (остановка по «Стоп») или
 * завершившуюся ошибкой провайдера дочернюю сессию:
 *  1. Валидация: сессия существует, имеет parent_id, не заблокирована,
 *     не активна (validateSubagentResume — до запуска, маппится в 400/404/409).
 *  2. В историю дочерней сессии добавляется synthetic user-маркер
 *     (task.resume_marker через SystemMessages + metadata.resume) — он
 *     восстанавливает контекст для LLM.
 *  3. Запускается общий tool-loop саб-агента (runSubagent из task.ts) —
 *     без дублирования цикла.
 *  4. По завершении итог записывается в РОДИТЕЛЬСКУЮ сессию как INFO-сообщение
 *     с metadata.type='subagent_resumed_result' + события в EventBus
 *     (message.added / session.updated у родителя, subagent.resume.* у обоих).
 *
 * Запуск — фоновый, МИМО родительского tool-loop и очереди (у дочерней
 * сессии нет своего QueueProcessor): блокировка через SessionManager
 * (acquireLock + currentStream) выполняет оркестратор (startSubagentResume),
 * поэтому повторный resume и abort через POST /sessions/:id/abort работают.
 */
import type { Message, Session, RouterConfig, PermissionConfig, SecurityConfig, EventType } from '@itphx/synth-shared';
import { MessageRole, nowISO, generateId, makeTextPart } from '@itphx/synth-shared';
import type { BaseProvider } from '../../providers/base.js';
import type { SessionManager } from '../../sessions/manager.js';
import type { EventBus } from '../../events/bus.js';
import type { AgentRegistry } from '../agents/registry.js';
import type { ToolRegistry } from './registry.js';
import { normalizeAgentModes } from '../agents/normalize.js';
import type { ContextConfig } from '../context/config.js';
import type { ContextOptimizer } from '../context/optimizer.js';
import type { ShellPolicy } from '../security/shell-guard.js';
import type { ProtectedPathsPolicy } from '../security/protected-paths.js';
import type { UsagePricing } from '../../providers/usage.js';
import { serializeMessage, serializeSession } from '../../server/serialize.js';
import { t as sm, i18n as i18nMeta } from '../system-messages.js';
import {
  messageToLLMMessage, publishMessageAdded, resolveSubagentPrompt, runSubagent,
  type SubagentRetryConfig, type TaskExtra,
} from './task.js';

/** Коды ошибок resume — route маппит их в HTTP-статусы (400/404/409). */
export type SubagentResumeErrorCode =
  | 'NOT_FOUND'
  | 'NO_PARENT'
  | 'PARENT_NOT_FOUND'
  | 'LOCKED'
  | 'AGENT_NOT_FOUND'
  | 'NO_PROVIDER';

export class SubagentResumeError extends Error {
  constructor(
    readonly code: SubagentResumeErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'SubagentResumeError';
  }

  get httpStatus(): number {
    switch (this.code) {
      case 'NOT_FOUND': return 404;
      case 'LOCKED': return 409;
      default: return 400;
    }
  }
}

/** Итог resume — возвращается в фоне, в API отдаётся стартовый ответ 202. */
export interface SubagentResumeResult {
  status: 'completed' | 'failed' | 'aborted';
  child_session_id: string;
  parent_session_id: string;
  summary?: string;
  error?: string;
}

/** Зависимости resume — собираются оркестратором (приватные резолверы). */
export interface SubagentResumeDeps {
  sessionManager: SessionManager;
  eventBus: EventBus;
  agentRegistry: AgentRegistry;
  toolRegistry?: ToolRegistry;
  contextConfig?: ContextConfig;
  contextOptimizer?: ContextOptimizer;
  routerConfig?: RouterConfig;
  securityConfig?: SecurityConfig;
  /** Fallback permission (глобальный конфиг), если у дочерней сессии нет своей. */
  permissionConfig?: PermissionConfig;
  /** AD-071 §2.1: активные MCP-серверы — дочерняя сессия наследует скоуп родителя. */
  mcpServers?: string[];
  shellPolicy?: ShellPolicy | null;
  protectedPaths?: ProtectedPathsPolicy | null;
  protectedPathsEnabled?: boolean;
  /** AD-070: цены моделей для live-стоимости resumed-саб-агента (как в `task`). */
  modelPriceLoader?: (model: string) => UsagePricing | null;
  /** Резолв провайдера дочерней сессии (gateway/роутер оркестратора). */
  getProvider: (child: Session) => BaseProvider | null;
  /** Рабочий каталог дочерней сессии. */
  getWorkingDir: (child: Session) => Promise<string>;
}

export interface ValidatedResume {
  child: Session;
  parent: Session;
}

/**
 * Валидация resume: сессия существует, дочерняя (есть parent_id), родитель
 * жив, сессия не активна (blocked/currentStream). Бросает SubagentResumeError.
 */
export async function validateSubagentResume(
  deps: Pick<SubagentResumeDeps, 'sessionManager'>,
  childSessionId: string,
): Promise<ValidatedResume> {
  const child = await deps.sessionManager.getSession(childSessionId);
  if (!child) {
    throw new SubagentResumeError('NOT_FOUND', sm('task.resume_session_not_found', { id: childSessionId }));
  }
  if (!child.parentId) {
    throw new SubagentResumeError('NO_PARENT', sm('task.resume_no_parent', { id: childSessionId }));
  }
  if (child.status.blocked || child.currentStream) {
    throw new SubagentResumeError('LOCKED', sm('task.resume_locked', { id: childSessionId }));
  }
  const parent = await deps.sessionManager.getSession(child.parentId);
  if (!parent) {
    throw new SubagentResumeError('PARENT_NOT_FOUND', sm('task.resume_parent_not_found', { id: child.parentId }));
  }
  return { child, parent };
}

export interface SubagentResumeOptions {
  /** Валидированная дочерняя сессия (свежая — после установки блокировки). */
  child: Session;
  parent: Session;
  /** streamId resume-прогона (совпадает с currentStream дочерней сессии). */
  streamId: string;
  /** Сигнал отмены: абортируется при orchestrator.cancel(streamId) («Стоп»). */
  abortSignal: AbortSignal;
  retry?: SubagentRetryConfig;
}

/**
 * Фоновый resume дочерней сессии: маркер → общий цикл саб-агента → итог
 * в родительскую сессию. Не бросает исключений для ожидаемых исходов —
 * возвращает status; непредвиденные ошибки пробрасывает вызывающему.
 */
export async function runSubagentResume(
  deps: SubagentResumeDeps,
  options: SubagentResumeOptions,
): Promise<SubagentResumeResult> {
  const { child, parent, streamId, abortSignal, retry } = options;

  const resumeEvent = (type: 'subagent.resume.started' | 'subagent.resume.finished', data: Record<string, unknown>) => {
    deps.eventBus.publish(child.id, type, data);
    deps.eventBus.publish(parent.id, type, data);
  };

  resumeEvent('subagent.resume.started', {
    child_session_id: child.id,
    parent_session_id: parent.id,
    stream_id: streamId,
  });

  try {
    // ─── 1. Агент и провайдер дочерней сессии ──────────────────────
    const agentRole = child.settings.agentRole || '';
    const agentDef = agentRole ? deps.agentRegistry.get(agentRole) : undefined;
    if (!agentDef || !normalizeAgentModes(agentDef.agentMode).includes('subagent')) {
      throw new SubagentResumeError('AGENT_NOT_FOUND', sm('task.resume_agent_not_found', { type: agentRole }));
    }
    const provider = deps.getProvider(child);
    if (!provider) {
      throw new SubagentResumeError('NO_PROVIDER', sm('task.resume_provider_unavailable', { id: child.id }));
    }
    const workingDir = await deps.getWorkingDir(child);

    // ─── 2. Synthetic user-маркер resume в историю дочерней сессии ──
    const markerText = sm('task.resume_marker');
    const markerMsg: Message = {
      id: generateId(),
      role: MessageRole.USER,
      seq: 0,
      origin: 'local',
      parts: [makeTextPart(markerText)],
      content: markerText,
      createdAt: nowISO(),
      disabled: false,
      pinned: false,
      hidden: false,
      author: 'user',
      metadata: {
        resume: true,
        stream_id: streamId,
        i18n: i18nMeta('task.resume_marker'),
      },
    };
    const updatedChild = await deps.sessionManager.addMessage(child.id, markerMsg);
    if (updatedChild) {
      const idx = updatedChild.messages.length - 1;
      await publishMessageAdded(deps.eventBus, parent.id, child.id, updatedChild.messages[idx]!, idx, updatedChild);
    }

    // ─── 3. История дочерней сессии → LLM-сообщения (system добавит runSubagent) ──
    const freshChild = updatedChild ?? (await deps.sessionManager.getSession(child.id)) ?? child;
    const initialMessages = freshChild.messages
      .filter((m) => !m.hidden && !m.disabled)
      .map(messageToLLMMessage);

    const systemPrompt = resolveSubagentPrompt(
      agentDef,
      agentRole,
      child.settings.language,
      deps.contextConfig?.systemPromptsDir,
    );

    const extra: TaskExtra = {
      provider,
      agentRegistry: deps.agentRegistry,
      toolRegistry: deps.toolRegistry,
      sessionManager: deps.sessionManager,
      eventBus: deps.eventBus,
      contextOptimizer: deps.contextOptimizer,
      parentSessionSettings: child.settings,
      routerConfig: deps.routerConfig,
      contextConfig: deps.contextConfig,
      // События resume — в EventBus дочерней сессии (родительского стрима нет)
      publish: (type, data) => deps.eventBus.publish(child.id, type as EventType, data),
      streamId,
      sessionId: child.id,
      callerAgentRole: agentRole,
      permissionConfig: child.settings.permission ?? deps.permissionConfig,
      securityConfig: deps.securityConfig,
      language: child.settings.language || 'ru',
      shellPolicy: deps.shellPolicy ?? undefined,
      protectedPaths: deps.protectedPaths ?? undefined,
      protectedPathsEnabled: deps.protectedPathsEnabled,
      // AD-071 §2.1: дочерняя сессия наследует MCP-скоуп родителя.
      mcpServers: deps.mcpServers,
      // AD-070: live-стоимость resumed-саб-агента тем же загрузчиком цен.
      modelPriceLoader: deps.modelPriceLoader,
      retry,
    };

    const result = await runSubagent({
      subagentType: agentRole,
      description: child.title ?? '',
      contextMode: 'none',
      maxSteps: agentDef.maxSteps,
      llmSystemPrompt: systemPrompt,
      initialMessages,
      provider,
      tools: deps.agentRegistry.getToolsForAgent(agentDef.id, deps.mcpServers),
      childSessionId: child.id,
      parentSessionId: parent.id,
      extra,
      ctx: {
        sessionId: child.id,
        messageId: streamId,
        abortSignal,
        workingDir,
        agentRole,
      },
      retry,
    });

    // ─── 4. Итог — в родительскую сессию ───────────────────────────
    const status: SubagentResumeResult['status'] = result.isError
      ? 'failed'
      : (result.metadata?.stopped_by === 'user' ? 'aborted' : 'completed');
    const summary = typeof result.metadata?.final_content === 'string' && result.metadata.final_content
      ? result.metadata.final_content as string
      : (status === 'completed' ? result.content : '');

    let content: string;
    let i18nKey: 'task.resume_result' | 'task.resume_aborted' | 'task.resume_failed';
    let i18nParams: Record<string, string>;
    const summaryOrEmpty = summary || sm('task.empty_response');
    if (status === 'completed') {
      content = sm('task.resume_result', { type: agentRole, summary: summaryOrEmpty });
      i18nKey = 'task.resume_result';
      i18nParams = { type: agentRole, summary: summaryOrEmpty };
    } else if (status === 'aborted') {
      content = sm('task.resume_aborted', { type: agentRole });
      i18nKey = 'task.resume_aborted';
      i18nParams = { type: agentRole };
    } else {
      content = sm('task.resume_failed', { type: agentRole, error: result.content });
      i18nKey = 'task.resume_failed';
      i18nParams = { type: agentRole, error: result.content };
    }

    const parentMsg: Message = {
      id: generateId(),
      role: MessageRole.INFO,
      seq: 0,
      origin: 'local',
      parts: [makeTextPart(content)],
      content,
      createdAt: nowISO(),
      disabled: false,
      pinned: false,
      hidden: false,
      metadata: {
        type: 'subagent_resumed_result',
        child_session_id: child.id,
        resume_status: status,
        stream_id: streamId,
        i18n: i18nMeta(i18nKey, i18nParams),
      },
    };
    const updatedParent = await deps.sessionManager.addMessage(parent.id, parentMsg);
    if (updatedParent) {
      const idx = updatedParent.messages.length - 1;
      deps.eventBus.publish(parent.id, 'message.added', {
        message: serializeMessage(updatedParent.messages[idx]!, idx),
        index: idx,
      });
      deps.eventBus.publish(parent.id, 'session.updated', serializeSession(updatedParent));
    }

    resumeEvent('subagent.resume.finished', {
      child_session_id: child.id,
      parent_session_id: parent.id,
      status,
      stream_id: streamId,
    });

    return {
      status,
      child_session_id: child.id,
      parent_session_id: parent.id,
      summary: status === 'completed' ? (summary || undefined) : undefined,
      error: status === 'failed' ? result.content : undefined,
    };
  } catch (err) {
    if (err instanceof SubagentResumeError) {
      // Ожидаемая ошибка (агент/провайдер недоступны) — фиксируем в родителе
      const content = sm('task.resume_failed', { type: 'resume', error: err.message });
      const parentMsg: Message = {
        id: generateId(),
        role: MessageRole.INFO,
        seq: 0,
        origin: 'local',
        parts: [makeTextPart(content)],
        content,
        createdAt: nowISO(),
        disabled: false,
        pinned: false,
        hidden: false,
        metadata: {
          type: 'subagent_resumed_result',
          child_session_id: child.id,
          resume_status: 'failed',
          error_code: err.code,
          stream_id: streamId,
          i18n: i18nMeta('task.resume_failed', { type: 'resume', error: err.message }),
        },
      };
      const updatedParent = await deps.sessionManager.addMessage(parent.id, parentMsg).catch(() => null);
      if (updatedParent) {
        const idx = updatedParent.messages.length - 1;
        deps.eventBus.publish(parent.id, 'message.added', {
          message: serializeMessage(updatedParent.messages[idx]!, idx),
          index: idx,
        });
      }
      deps.eventBus.publish(child.id, 'stream.error', {
        stream_id: streamId,
        error: err.message,
        error_type: 'resume_failed',
        can_retry: false,
      });
      resumeEvent('subagent.resume.finished', {
        child_session_id: child.id,
        parent_session_id: parent.id,
        status: 'failed',
        error_code: err.code,
        stream_id: streamId,
      });
      return {
        status: 'failed',
        child_session_id: child.id,
        parent_session_id: parent.id,
        error: err.message,
      };
    }
    throw err;
  }
}
