/**
 * Создание дочерней сессии саб-агента с учётом режима контекста (ADR-026) и
 * наследованием permissions родителя (ADR-029).
 *
 * ADR-095 (шаг 5): вынесено из `task.ts` без изменения поведения. Ошибки внутри
 * по-прежнему не фатальны (проглатываются) — саб-агент продолжает без дочерней
 * сессии, а частично применённые мутации состояния сохраняются.
 */
import { MessageRole } from '@itphx/synth-shared';
import type { Message, Session, SessionSettings } from '@itphx/synth-shared';
import type { SessionManager } from '../../../sessions/manager.js';
import { serializeSession } from '../../../server/serialize.js';
import { deriveSubagentPermission } from '../../permission/derive.js';
import { t as sm } from '../../system-messages.js';
import { recordAuxUsage } from '../../usage-accounting.js';
import { toTodoItem } from '../todo.js';
import type { ContextMode, TaskExtra, TaskTodoSeed } from './types.js';

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
  /**
   * ADR-039: стартовый список задач дочерней сессии (`task.todos`).
   *
   * Записывается в `session.todos` ребёнка **до** публикации `session.created`;
   * id сохраняются (по ним родитель сверяет списки). `undefined` — список не
   * трогаем. Унаследованные от родителя state-сообщения `todos_updated` при
   * создании удаляются в любом случае — это derived state родительского списка.
   */
  todos?: TaskTodoSeed[];
}

/**
 * Сброс унаследованных runtime-флагов форка: ребёнок начинает прогон с
 * чистого состояния — ни «жду суммаризацию», ни состояние ретрая родителя
 * (они относятся к ходу родителя, а не к задаче ребёнка).
 */
function resetForkRuntimeFlags(session: Session): void {
  session.summarizationPending = false;
  session.retry = undefined;
}

/**
 * Перенести метаданные ребёнка после `forkSession` **точечной** мутацией
 * (`mutateMeta`, ADR-144): история остаётся той, что создал `forkSession`, а
 * параллельная дозапись сообщений (`appendMessage`) не теряется. Прежняя
 * связка «правка снимка + `updateSession`» писала документ целиком.
 *
 * Локальный объект `fork` обновляется теми же значениями: он нужен дальнейшему
 * коду (`summarize(fork)` читает `settings`/`mode`), а его `messages` — то, что
 * `forkSession` уже сохранил (мутация метаданных историю не трогает).
 */
async function applyForkedChildMeta(
  manager: SessionManager,
  fork: Session,
  parent: Session,
  childSettingsPatch: Partial<SessionSettings>,
): Promise<void> {
  fork.sessionOrigin = 'subagent';
  fork.userId = parent.userId;
  fork.ownerId = parent.ownerId;
  fork.mode = parent.mode;
  fork.settings = { ...fork.settings, ...childSettingsPatch };
  resetForkRuntimeFlags(fork);

  const result = await manager.mutateMeta(fork.id, (meta) => {
    meta.sessionOrigin = 'subagent';
    meta.userId = parent.userId;
    meta.ownerId = parent.ownerId;
    meta.mode = parent.mode;
    meta.settings = { ...meta.settings, ...childSettingsPatch };
    meta.summarizationPending = false;
    meta.retry = undefined;
  });
  if (!result.found) throw new Error(`Session ${fork.id} not found`);
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
  const { extra, description, subagentType, contextMode, contextCount, childRoutingOverrides, temperature, provider, model, todos } = opts;

  // ─── Permissions дочерней сессии (ADR-029, chain-no-copy): только deny-дополнения роли ──
  // Правила родителя в ребёнка **не копируются**: они читаются живым резолвом
  // по цепочке `parentId` (`resolveEffectivePermission`), которую ребёнок
  // получает при создании (`forkSession`/`createSession` с `parentId`).
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
    // Ребёнок — задача, а не продолжение диалога (как в opencode): режим
    // оптимизации контекста **родителя** не наследуется. Иначе после первого
    // сообщения/форка мог сработать `shouldSummarize`/`summarizationPending`
    // родителя.
    //
    // Но собственной компактизации у ребёнка теперь есть (ADR-119): длинный
    // прогон саб-агента без неё упирается в окно модели (или в
    // предохранитель `agents.subagentMaxInputTokens`, который завершает
    // прогон детерминированным отчётом). Режим ребёнка — `compaction`
    // (рабочее состояние по коду/проекту), а не `summarization`.
    contextOptimization: 'compaction',
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
          await applyForkedChildMeta(extra.sessionManager, fork, parentSession, childSettingsPatch);
          state.childSessionId = fork.id;
          state.childMessages = fork.messages;
        } else if (effectiveMode === 'last_n') {
          const startIdx = Math.max(0, parentSession.messages.length - contextCount);
          const fork = await extra.sessionManager.forkSession(extra.sessionId, {
            messageIndex: startIdx,
            title: sm('session.subtask_title', { description }),
          });
          await applyForkedChildMeta(extra.sessionManager, fork, parentSession, childSettingsPatch);
          state.childSessionId = fork.id;
          state.childMessages = fork.messages;
        } else if (effectiveMode === 'summary') {
          const fork = await extra.sessionManager.forkSession(extra.sessionId, {
            title: sm('session.subtask_title', { description }),
          });
          await applyForkedChildMeta(extra.sessionManager, fork, parentSession, childSettingsPatch);
          state.childSessionId = fork.id;
          state.childMessages = fork.messages;

          try {
            const summaryMsg = await extra.contextOptimizer!.summarize(fork);
            // SUMMARY-сообщение в историю ребёнка не пишем: сжатие — разовый
            // контекст первого запуска и уходит в системный промпт (`[PARENT SUMMARY]`).
            if (summaryMsg.content) state.parentSummaryText = summaryMsg.content;
            // ADR-102: usage суммаризации — aux под дочерней (fork) сессией.
            if (summaryMsg.usage) {
              await recordAuxUsage(
                {
                  sessionManager: extra.sessionManager,
                  analytics: extra.analytics,
                  modelPriceLoader: extra.modelPriceLoader,
                },
                {
                  sessionId: fork.id,
                  usage: summaryMsg.usage,
                  ...(summaryMsg.model ? { model: summaryMsg.model } : {}),
                  source: 'fork-summary',
                },
              );
            }
          } catch {
            // fallback: без саммари, только prompt с полной историей
          }

          // Всегда отключаем унаследованные сообщения — в summary-режиме
          // они заменены суммаризацией в системном промпте (или мы fallback-нули без неё).
          // Правка — точечная (`mutateHistory`, ADR-144): свежий документ
          // читается под локом, отключение применяется к нему же, полная
          // перезапись снимка не затирает параллельную дозапись сообщений.
          {
            const disabled = await extra.sessionManager.mutateHistory(state.childSessionId, (session) => {
              let changed = false;
              for (const msg of session.messages) {
                if (msg.role !== MessageRole.SUMMARY && !msg.disabled) {
                  msg.disabled = true;
                  changed = true;
                }
              }
              return { changed, messages: session.messages };
            }, { shouldWrite: (value) => value.changed });
            if (disabled.ok) state.childMessages = disabled.value.messages;
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
          // Метаданные ребёнка — точечно (`mutateMeta`, ADR-144): полная
          // перезапись снимка (`updateSession`) затирала бы параллельную
          // дозапись сообщений.
          const metaResult = await extra.sessionManager.mutateMeta(child.id, (meta) => {
            meta.userId = parentSession.userId;
            meta.ownerId = parentSession.ownerId;
            meta.mode = parentSession.mode;
            // Новый инстанс и так чистый (`createSession`/funnel не наследуют
            // runtime-флаги родителя) — но сброс делаем явно: «жду суммаризацию»
            // и состояние ретрая родителя к задаче ребёнка отношения не имеют.
            meta.summarizationPending = false;
            meta.retry = undefined;
          });
          if (!metaResult.found) throw new Error(`Session ${child.id} not found`);
          state.childSessionId = child.id;
        }

        // ADR-039: список задач ребёнка — его собственный. Унаследованные от
        // родителя state-сообщения `todos_updated` (derived state родительского
        // списка) при создании удаляем; переданный `todos` — стартовый список
        // (id сохраняются). Делается ДО публикации `session.created`, чтобы
        // сессия уходила в хаб уже с seeded `todos`.
        const manager = extra.sessionManager;
        if (state.childSessionId && manager) {
          const seeded = todos !== undefined ? todos.map(toTodoItem) : undefined;
          try {
            // Правка истории/метаданных ребёнка точечно (`mutateHistory`,
            // ADR-144): `updatedAt` не двигаем — паритет с прежним
            // `saveSession` (создание сессии время уже проставило).
            const seededResult = await manager.mutateHistory(state.childSessionId, (session) => {
              const messages = session.messages.filter(
                (m) => !(m.metadata?.state === true && m.metadata?.type === 'todos_updated'),
              );
              let changed = messages.length !== session.messages.length;
              if (changed) session.messages = messages;
              if (seeded !== undefined) {
                session.todos = seeded;
                changed = true;
              }
              return { changed, messages: session.messages };
            }, { touchUpdatedAt: false, shouldWrite: (value) => value.changed });
            if (seededResult.ok) state.childMessages = seededResult.value.messages;
          } catch {
            // не фатально — продолжаем без сида/очистки
          }
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
