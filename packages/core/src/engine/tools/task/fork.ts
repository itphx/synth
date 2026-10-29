/**
 * Создание дочерней сессии саб-агента с учётом режима контекста (ADR-026) и
 * наследованием permissions родителя (ADR-029).
 *
 * ADR-095 (шаг 5): вынесено из `task.ts` без изменения поведения. Ошибки внутри
 * по-прежнему не фатальны (проглатываются) — саб-агент продолжает без дочерней
 * сессии, а частично применённые мутации состояния сохраняются.
 */
import { MessageRole } from '@itphx/synth-shared';
import type { Message, SessionSettings } from '@itphx/synth-shared';
import { serializeSession } from '../../../server/serialize.js';
import { deriveSubagentPermission } from '../../permission/derive.js';
import { t as sm } from '../../system-messages.js';
import type { ContextMode, TaskExtra } from './types.js';

/** Мутабельное состояние дочерней сессии, собираемое `prepareChildSession`. */
export interface PreparedChildSession {
  childSessionId?: string;
  childMessages: Message[];
  parentNotesText: string;
  /**
   * Сжатие родительской истории (`context_mode: 'summary'`).
   *
   * В историю ребёнка SUMMARY-сообщение **не пишется** (как в opencode):
   * сжатие — разовый контекст первого запуска и уходит в системный промпт
   * (`[PARENT SUMMARY]`), а не в видимую историю дочерней сессии.
   */
  parentSummaryText?: string;
}

export interface PrepareChildSessionOptions {
  extra: TaskExtra;
  description: string;
  subagentType: string;
  contextMode: ContextMode;
  contextCount: number;
  childRoutingOverrides: Partial<SessionSettings>;
  /**
   * Температура саб-агента (`agent.temperature` → `session.settings.temperature`).
   * `undefined` — не перетирать настройки ребёнка (наследуется температура
   * родителя/форка, дальше — дефолт модели).
   */
  temperature?: number;
  /**
   * Фактическая пара прогона (`resolution.providerName`/`resolution.modelName`):
   * дочерняя сессия должна указывать на модель, которой реально шёл прогон.
   * Не задано — пара не перетирается (наследуется от родителя).
   */
  provider?: string;
  model?: string;
}

/**
 * Создать дочернюю сессию саб-агента и заполнить историю/заметки родителя.
 * Мутации — в `state` (переживают частичный сбой так же, как локальные
 * переменные прежнего инлайн-блока).
 */
export async function prepareChildSession(
  state: PreparedChildSession,
  opts: PrepareChildSessionOptions,
): Promise<void> {
  const { extra, description, subagentType, contextMode, contextCount, childRoutingOverrides, temperature, provider, model } = opts;

  // ─── Permissions дочерней сессии (ADR-029): наследуем родителя + deny-дополнения ──
  const derivedPermission = deriveSubagentPermission(extra.permissionConfig);

  /**
   * Переопределения настроек ребёнка, общие для всех режимов контекста.
   * Температура агента идёт последней: она приоритетнее настроек родителя
   * (`agent.temperature` → `session.settings.temperature` → дефолт модели).
   * `undefined` — настройку ребёнка не трогаем (температура остаётся
   * родительской/форка).
   */
  const childSettingsPatch: Partial<SessionSettings> = {
    agentRole: subagentType,
    permission: derivedPermission,
    planMode: 'auto',
    // Ребёнок — задача, а не продолжение диалога (как в opencode): авто-оптимизация
    // контекста и авто-суммаризация родителя не наследуются. Иначе после первого
    // сообщения/форка мог сработать `shouldSummarize`/`summarizationPending` родителя.
    contextOptimization: 'none',
    summarizationEnabled: false,
    ...childRoutingOverrides,
    // Фактическая пара прогона — последней: ребёнок видит модель, на которой
    // шёл прогон (даже если childRoutingOverrides пришёл без пары).
    ...(provider ? { provider } : {}),
    ...(model ? { model } : {}),
    ...(temperature !== undefined ? { temperature } : {}),
  };

  // ─── Создание дочерней сессии с контекстом ───────────────────────
  if (extra.sessionManager && extra.sessionId) {
    try {
      const parentSession = await extra.sessionManager.getSession(extra.sessionId);
      if (parentSession) {
        // Извлекаем активные заметки родителя для передачи саб-агенту
        const activeNotes = parentSession.stickyNotes.filter((n) => !n.disabled);
        if (activeNotes.length > 0) {
          state.parentNotesText = activeNotes.map((n) => n.content).join('\n\n---\n\n');
        }
        const effectiveMode = contextMode === 'summary' && !extra.contextOptimizer ? 'none' : contextMode;

        if (effectiveMode === 'inherit') {
          const fork = await extra.sessionManager.forkSession(extra.sessionId, {
            title: sm('session.subtask_title', { description }),
          });
          fork.sessionOrigin = 'subagent';
          fork.userId = parentSession.userId;
          fork.ownerId = parentSession.ownerId;
          fork.mode = parentSession.mode;
          fork.settings = { ...fork.settings, ...childSettingsPatch };
          await extra.sessionManager.updateSession(fork);
          state.childSessionId = fork.id;
          state.childMessages = fork.messages;
        } else if (effectiveMode === 'last_n') {
          const startIdx = Math.max(0, parentSession.messages.length - contextCount);
          const fork = await extra.sessionManager.forkSession(extra.sessionId, {
            messageIndex: startIdx,
            title: sm('session.subtask_title', { description }),
          });
          fork.sessionOrigin = 'subagent';
          fork.userId = parentSession.userId;
          fork.ownerId = parentSession.ownerId;
          fork.mode = parentSession.mode;
          fork.settings = { ...fork.settings, ...childSettingsPatch };
          await extra.sessionManager.updateSession(fork);
          state.childSessionId = fork.id;
          state.childMessages = fork.messages;
        } else if (effectiveMode === 'summary') {
          const fork = await extra.sessionManager.forkSession(extra.sessionId, {
            title: sm('session.subtask_title', { description }),
          });
          fork.sessionOrigin = 'subagent';
          fork.userId = parentSession.userId;
          fork.ownerId = parentSession.ownerId;
          fork.mode = parentSession.mode;
          fork.settings = { ...fork.settings, ...childSettingsPatch };
          await extra.sessionManager.updateSession(fork);
          state.childSessionId = fork.id;
          state.childMessages = fork.messages;

          try {
            const summaryMsg = await extra.contextOptimizer!.summarize(fork);
            // SUMMARY-сообщение в историю ребёнка не пишем: сжатие — разовый
            // контекст первого запуска и уходит в системный промпт (`[PARENT SUMMARY]`).
            if (summaryMsg.content) state.parentSummaryText = summaryMsg.content;
          } catch {
            // fallback: без саммари, только prompt с полной историей
          }

          // Всегда отключаем унаследованные сообщения — в summary-режиме
          // они заменены суммаризацией в системном промпте (или мы fallback-нули без неё)
          {
            const child = await extra.sessionManager.getSession(state.childSessionId);
            if (child) {
              let changed = false;
              for (const msg of child.messages) {
                if (msg.role !== MessageRole.SUMMARY && !msg.disabled) {
                  msg.disabled = true;
                  changed = true;
                }
              }
              if (changed) {
                await extra.sessionManager.updateSession(child);
              }
              state.childMessages = child.messages;
            }
          }
        } else {
          // none mode (default)
          const childSettings: Partial<SessionSettings> = {
            ...parentSession.settings,
            ...childSettingsPatch,
          };
          // ADR-089: создание дочерней сессии — через funnel (`initiator:'agent'`),
          // если он передан; иначе прямой `createSession` (прежнее поведение).
          const requestService = extra.getRequestSessionService?.();
          const child = requestService
            ? await requestService.request(
                {
                  initiator: 'agent',
                  intent: 'explicit',
                  title: sm('session.subtask_title', { description }),
                  projectId: parentSession.projectId,
                  parentId: extra.sessionId,
                  sessionOrigin: 'subagent',
                  settings: childSettings,
                },
                { userId: parentSession.userId, ownerId: parentSession.ownerId },
              )
            : await extra.sessionManager.createSession({
                title: sm('session.subtask_title', { description }),
                projectId: parentSession.projectId,
                parentId: extra.sessionId,
                sessionOrigin: 'subagent',
                settings: childSettings,
              });
          if (!child) throw new Error('failed to create subagent child session');
          child.userId = parentSession.userId;
          child.ownerId = parentSession.ownerId;
          child.mode = parentSession.mode;
          await extra.sessionManager.updateSession(child);
          state.childSessionId = child.id;
        }

        if (extra.eventBus && state.childSessionId) {
          const child = await extra.sessionManager.getSession(state.childSessionId);
          if (child) {
            extra.eventBus.publish(extra.sessionId, 'session.created', serializeSession(child));
          }
        }

        // ADR-030: `agent_spawned` — неблокирующий эмит при создании дочерней
        // сессии саб-агента (agentId — id дочерней сессии).
        if (extra.hooks && state.childSessionId) {
          extra.hooks.emitAsync('agent_spawned', {
            agentId: state.childSessionId,
            agentType: subagentType,
            ...(extra.sessionId ? { parentId: extra.sessionId } : {}),
          });
        }
      }
    } catch {
      // не фатально — продолжаем без дочерней сессии
    }
  }
}
