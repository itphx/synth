/**
 * Типы тула `task` (запуск саб-агента) и общего цикла саб-агента.
 *
 * ADR-095 (шаг 5): вынесено из `task.ts` без изменения поведения.
 */
import type { SessionSettings, RouterConfig, PermissionConfig, SecurityConfig, WorkspaceOutsideRootPolicy, ProfileStore } from '@itphx/synth-shared';
import type { AgentRegistry } from '../../agents/registry.js';
import type { BaseProvider } from '../../../providers/base.js';
import type { ToolRegistry } from '../registry.js';
import type { SessionManager } from '../../../sessions/manager.js';
import type { EventBus } from '../../../events/bus.js';
import type { HookBus } from '../../hooks/hook-bus.js';
import type { RequestSessionService } from '../../events/request-session.js';
import type { ContextOptimizer } from '../../context/optimizer.js';
import type { ContextFileRepository } from '../../../storage/ports/context-file-repository.js';
import type { ModelRouter } from '../../router/router.js';
import type { UsagePricing } from '../../../providers/usage.js';
import type { ShellPolicy } from '../../security/shell-guard.js';
import type { ProtectedPathsPolicy } from '../../security/protected-paths.js';
import type { RuntimeDeps } from '../runtime-deps.js';
import type { SkillRuntime, SkillScopeOptions } from '../../skills/types.js';
import type { ProjectStoreLike } from '../../../storage/project-store.js';
import type { SSHKeyRepository } from '../../../storage/ports/ssh-key-repository.js';
import type { GitService } from '../../../git/git-service.js';
// Этап 1 roadmap 0.13 (блок 3): сервис «вопрос пользователю».
import type { QuestionService } from '../../question/service.js';
// Этап 1 roadmap 0.13 (блок 4): единый реестр фоновых прогонов (PROP-096).
import type { BackgroundRunService } from '../../background/service.js';
import type { CancellationToken } from '../../../providers/base.js';

export interface TaskExtra {
  provider: BaseProvider;
  agentRegistry: AgentRegistry;
  toolRegistry?: ToolRegistry;
  sessionManager?: SessionManager;
  /**
   * ADR-089: late-bound funnel создания дочерней сессии. Задан — «none»-режим
   * создаёт сессию через `request` (единые правила/аудит, `initiator:'agent'`),
   * иначе — прямой `createSession` (поведение прежнее). Fork-режимы контекста
   * всегда идут через `forkSession` (материализация копии истории).
   */
  getRequestSessionService?: () => RequestSessionService | undefined;
  eventBus?: EventBus;
  /** ADR-030: ядровая шина хуков — agent_spawned/agent_completed/agent_failed саб-агента. */
  hooks?: HookBus;
  contextOptimizer?: ContextOptimizer;
  parentSessionSettings?: SessionSettings;
  /** ADR-071 §2.1: активные MCP-серверы родительской сессии — скоуп тулов саб-агента. */
  mcpServers?: string[];
  modelRouter?: ModelRouter;
  routerConfig?: RouterConfig;
  contextConfig?: ContextFileRepository;
  publish?: (type: string, data: Record<string, unknown>) => void;
  streamId?: string;
  sessionId?: string;
  /** ID собственного tool-вызова `task` — как parent_call_id для внутренних вызовов саб-агента. */
  callId?: string;
  callerAgentRole?: string;
  /** Permissions родительской сессии (ADR-029) — наследуются саб-агентом с deny-дополнениями. */
  permissionConfig?: PermissionConfig;
  /**
   * ADR-070 §2.9.1: доступность внешних программ окружения (git/rg/sh) родителя.
   * Передаётся в permission-слой саб-агента (enforce `dependency`) и в секцию
   * `[НЕДОСТУПНЫЕ ТУЛЫ]` его системного промпта. Не задана — fail-open.
   */
  runtimeDeps?: RuntimeDeps;
  /**
   * ADR-075: задан ли рабочий каталог проекта у родителя. Передаётся в
   * permission-слой саб-агента — file/shell/git-тулы заблокированы с причиной
   * `workspace`, если у проекта нет рабочего каталога. `undefined` — fail-open.
   */
  workspaceReady?: boolean;
  /** Секция безопасности (защита от Indirect Prompt Injection) из config.yaml. */
  securityConfig?: SecurityConfig;
  /** Язык сессии (для локализованных сообщений безопасности). */
  language?: string;
  /** Политика безопасности execute_shell (денлист путей/команд) родительской сессии. */
  shellPolicy?: ShellPolicy;
  /** Единая политика защищённых путей (СКВОЗНАЯ проверка файловых тулов) родительской сессии. */
  protectedPaths?: ProtectedPathsPolicy;
  /** Тумблер полного отключения защищённых путей (default true). */
  protectedPathsEnabled?: boolean;
  /** Override retry-параметров саб-агента (по умолчанию 3 попытки, backoff 5/15/30с). */
  retry?: SubagentRetryConfig;
  /** ADR-070: цены моделей для live-стоимости саб-агента (как в оркестраторе). */
  modelPriceLoader?: (model: string) => UsagePricing | null;
  /**
   * ADR-069 §7: уже резолвленные оркестратором проектные инструкции
   * (`[PROJECT INSTRUCTIONS] …`) — добавляются в конец базового промпта
   * саб-агента. Не резолвятся повторно в ребёнке.
   */
  projectInstructions?: string;
  /**
   * ADR-046 §5/§6.2: рантайм скиллов — каталог саб-агенту (binding родителя) и
   * тул `skill` (тот же объект уходит в ToolContext.extra).
   */
  skillRuntime?: SkillRuntime;
  /**
   * Этап 1 roadmap 0.13 (блок 3): сервис «вопрос пользователю».
   *
   * Саб-агенту вопросы недоступны (permission `question: deny`,
   * `engine/permission/derive.ts`), но сервис в `extra` прокидывается —
   * чтобы дочерняя сессия, созданная тулой `task`, могла задавать вопрос
   * пользователю в своём ходе (если право будет выдано).
   */
  questionService?: QuestionService;
  /**
   * Этап 1 roadmap 0.13 (блок 4): реестр фоновых прогонов (PROP-096).
   *
   * Тул `task` с `background: true` регистрирует фонового саб-агента в
   * реестре (лимиты, запись, уведомление родителя). Не задан — фоновый
   * запуск недоступен (`task.background_disabled`).
   */
  backgroundService?: BackgroundRunService;
  /**
   * Этап 1 roadmap 0.13 (блок 4): фоновые прогоны разрешены инстансом
   * (`background.enabled`). `false` — тул `task` с `background: true`
   * отказывает (`task.background_disabled`). Не задан — разрешены.
   */
  backgroundEnabled?: boolean;
  /**
   * Этап 1 roadmap 0.13 (блок 4): регистрация cancel-токена фонового прогона
   * в оркестраторе — чтобы `POST /sessions/<child>/abort` останавливал фонового
   * ребёнка (`orchestrator.cancel(streamId)`).
   */
  registerCancelToken?: (streamId: string, token: CancellationToken) => void;
  /** Снятие cancel-токена фонового прогона (по завершении прогона). */
  unregisterCancelToken?: (streamId: string) => void;
  /** ADR-046 §4.5: scope-гейты скиллов родительского контекста. */
  skillScope?: SkillScopeOptions;
  /**
   * ADR-075/ADR-076: проектные зависимости для тулов саб-агента (управление
   * проектом, workspace, реестр репозиториев, SSH-окружение сетевых git-тулов).
   * Обычный путь передаёт их целиком; resume-путь — из `SubagentResumeDeps`.
   * Контейнер гарантирует только чтение (`load`); в рантайме оркестратор передаёт
   * полный `ProjectStore`, а проектные тулы объявляют свой контракт сами.
   */
  projectStore?: ProjectStoreLike;
  /** Онбординг: хранилище профилей — тул `profile_update` у саб-агента. */
  profilesStore?: ProfileStore;
  workspacesRoot?: string;
  sshKeyStore?: SSHKeyRepository;
  gitService?: GitService;
  workspaceManaged?: boolean;
  getWorkspaceOutsideRootPolicy?: () => WorkspaceOutsideRootPolicy | Promise<WorkspaceOutsideRootPolicy>;
}

export type ContextMode = 'none' | 'inherit' | 'summary' | 'last_n';

/** Параметры retry-цикла LLM-вызова саб-агента. */
export interface SubagentRetryConfig {
  /** Максимум попыток (включая первую). */
  maxRetries: number;
  /** Задержки между попытками, мс (index = попытка - 1). */
  delaysMs: number[];
}
