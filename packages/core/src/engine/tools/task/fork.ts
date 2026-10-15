/**
 * Создание дочерней сессии саб-агента с учётом режима контекста (ADR-026) и
 * наследованием permissions родителя (ADR-029).
 *
 * ADR-095 (шаг 5): вынесено из `task.ts` без изменения поведения. Ошибки внутри
 * по-прежнему не фатальны (проглатываются) — саб-агент продолжает без дочерней
 * сессии, а частично применённые мутации состояния сохраняются.
 */
import { MessageRole, generateId } from '@itphx/synth-shared';
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
}

export interface PrepareChildSessionOptions {
  extra: TaskExtra;
  description: string;
  subagentType: string;
  contextMode: ContextMode;
  contextCount: number;
  childRoutingOverrides: Partial<SessionSettings>;
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
  const { extra, description, subagentType, contextMode, contextCount, childRoutingOverrides } = opts;

  // ─── Permissions дочерней сессии (ADR-029): наследуем родителя + deny-дополнения ──
  const derivedPermission = deriveSubagentPermission(extra.permissionConfig);

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
          fork.settings = { ...fork.settings, agentRole: subagentType, permission: derivedPermission, planMode: 'auto', ...childRoutingOverrides };
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
          fork.settings = { ...fork.settings, agentRole: subagentType, permission: derivedPermission, planMode: 'auto', ...childRoutingOverrides };
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
          fork.settings = { ...fork.settings, agentRole: subagentType, permission: derivedPermission, planMode: 'auto', ...childRoutingOverrides };
          await extra.sessionManager.updateSession(fork);
          state.childSessionId = fork.id;
          state.childMessages = fork.messages;

          try {
            const summaryMsg = await extra.contextOptimizer!.summarize(fork);
            if (summaryMsg.content) {
              await extra.sessionManager.addMessage(state.childSessionId, {
                ...summaryMsg,
                id: generateId(),
                origin: 'local',
                hidden: false,
              });
            }
          } catch {
            // fallback: без саммари, только prompt с полной историей
          }

          // Всегда отключаем унаследованные сообщения — в summary-режиме
          // они заменены суммаризацией (или мы fallback-нули без неё)
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
            agentRole: subagentType,
            permission: derivedPermission,
            planMode: 'auto',
            ...childRoutingOverrides,
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
                  engine: parentSession.engine,
                  parentId: extra.sessionId,
                  sessionOrigin: 'subagent',
                  settings: childSettings,
                },
                { userId: parentSession.userId, ownerId: parentSession.ownerId },
              )
            : await extra.sessionManager.createSession({
                title: sm('session.subtask_title', { description }),
                projectId: parentSession.projectId,
                engine: parentSession.engine,
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
