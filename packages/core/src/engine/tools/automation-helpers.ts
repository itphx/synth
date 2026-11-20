/**
 * ADR-101/ADR-051: общие хелперы встроенных тулов автоматизации.
 *
 * Тулы пайплайнов (`pipeline_*`) и расписаний (`schedule_*`) работают с
 * **проектом сессии** и с доменными портами слоя хранения (ADR-096). Три
 * проверки повторяются в каждом туле, поэтому живут здесь, а не дублируются:
 *
 * 1. **рантайм доступен** — `ctx.extra.automation` (late-bound геттер,
 *    `engine/tools/automation-runtime.ts`); без него портов нет → тул
 *    возвращает понятную ошибку, а не падает;
 * 2. **у сессии есть проект** — пайплайн/расписание принадлежат проекту
 *    (ADR-014), а не сессии; проект берётся **только** из сессии (аргумент
 *    `project_id` у тулов не принимается — подсунуть чужой проект нельзя);
 * 3. **право на изменение** — мутации (черновик, публикация, удаление)
 *    доступны владельцу/редактору проекта (`canEditProject`, ADR-075/D5);
 *    read-уровень доступа прав на изменение не даёт (инвариант 21).
 *
 * Тексты — только через ключи `shared/i18n` (ADR-041): `sm()` — текст для
 * модели (en), `i18nMeta()` — метаданные для UI-перевода.
 *
 * ## Расписания — отдельный scope
 *
 * У пайплайнов ресурс **проектный** (проект обязателен). У расписаний
 * (ADR-051) область шире: расписание доступно агенту, если оно **своё**
 * (`ownerId === userId` сессии) **или** его цель относится к проекту сессии
 * (`pipeline`/`ephemeral`/`bound`/`queue` — см. `isScheduleInScope`). Поэтому
 * здесь свой scope (`ScheduleScope`): проект — `null`, а не отказ, и правила
 * области/мутации — свои (`isScheduleInScope`/`ensureScheduleMutable`).
 */
import type { Project, Schedule, Session, ToolContext, ToolResult } from '@itphx/synth-shared';
import type { PipelineChangeAction } from '@itphx/synth-shared';
import type { AutomationRuntime } from './automation-runtime.js';
import { getSessionExtra, loadSessionProject } from './project-manage.js';
import { parentSessionIdOf } from './session-scope.js';
import { canEditProject, resolveSessionUserId } from './project-access.js';
import { principalGroups } from './project-resolve.js';
import { publishPipelineUpdated } from '../pipelines/events.js';
import { t as sm, i18n as i18nMeta } from '../system-messages.js';

/**
 * Рантайм автоматизации из контекста тула.
 *
 * Кладётся оркестратором в `ctx.extra.automation` (ADR-070 §2.9 — рантайм в
 * `extra`, как `skillRuntime`/`executionPort`); собирается в `deps.ts`.
 */
export function getAutomation(ctx: ToolContext): AutomationRuntime | undefined {
  const extra = ctx.extra as { automation?: AutomationRuntime } | undefined;
  return extra?.automation;
}

/**
 * Единый отказ «рантайм недоступен» (один текст для всех тулов
 * автоматизации — портов нет или они не собраны).
 */
export function depsUnavailable(toolName: string): ToolResult {
  const params = { tool: toolName };
  return {
    content: sm('pipeline.tool.deps_unavailable', params),
    isError: true,
    metadata: { i18n: i18nMeta('pipeline.tool.deps_unavailable', params) },
  };
}

/** Единый отказ «у сессии нет проекта» (пайплайн/расписание — ресурс проекта). */
export function noProject(): ToolResult {
  return {
    content: sm('pipeline.tool.no_project'),
    isError: true,
    metadata: { i18n: i18nMeta('pipeline.tool.no_project') },
  };
}

/** Единый отказ «нет права изменять проект» (владелец/редактор). */
export function forbidden(): ToolResult {
  return {
    content: sm('pipeline.tool.forbidden'),
    isError: true,
    metadata: { i18n: i18nMeta('pipeline.tool.forbidden') },
  };
}

/** Scope тула автоматизации: рантайм + сессия + проект сессии. */
export interface AutomationScope {
  /** Рантайм автоматизации (порты и движок). */
  automation: AutomationRuntime;
  /** Сессия тула. */
  session: Session;
  /** Проект сессии — единственный источник `projectId` для тулов. */
  project: Project;
  /**
   * ADR-140 Ф2: группы пользователя (снимок принципала хода) — для грантов
   * по группам (`canEditProject`). Нет — групп нет (fail-closed).
   */
  groups?: readonly string[];
}

/** Результат `loadAutomationScope`: готовый scope либо готовый отказ. */
export type AutomationScopeResult =
  | { ok: true; automation: AutomationRuntime; session: Session; project: Project; groups?: readonly string[] }
  | { ok: false; result: ToolResult };

/**
 * Загрузить scope тула автоматизации: рантайм + сессия + проект сессии.
 *
 * Отказ (готовый `isError`-результат) в двух случаях:
 * - рантайм недоступен → `pipeline.tool.deps_unavailable`;
 * - у сессии нет проекта → `pipeline.tool.no_project`.
 */
export async function loadAutomationScope(
  ctx: ToolContext,
  toolName: string,
): Promise<AutomationScopeResult> {
  const automation = getAutomation(ctx);
  if (!automation) return { ok: false, result: depsUnavailable(toolName) };

  const { session, project } = await loadSessionProject(ctx);
  if (!session || !project) return { ok: false, result: noProject() };

  const groups = principalGroups(ctx);
  return { ok: true, automation, session, project, ...(groups ? { groups } : {}) };
}

/**
 * Проверка права на **изменение** содержимого проекта (ADR-075/D5).
 *
 * `null` — право есть; иначе — готовый `isError`-результат с отказом.
 *
 * Имя тула в сигнатуре оставлено для единообразия с остальными проверками
 * (и для будущих различающихся текстов): текст отказа от тула не зависит.
 */
export function ensureCanEdit(
  scope: { session: Session; project: Project; groups?: readonly string[] },
  _toolName: string,
): ToolResult | null {
  if (canEditProject(scope.session, scope.project, scope.groups)) return null;
  return forbidden();
}

/**
 * Уведомить клиентов, что сущность пайплайна проекта изменилась
 * (`pipeline.updated`).
 *
 * Вызывается **после успешной записи** и только на успешном пути: ошибки
 * валидации, «пайплайн не найден» и отказы прав событие не порождают (один
 * вызов тула — максимум одно событие). Пайплайн — ресурс проекта (ADR-014),
 * поэтому событие идёт в каналы **сессий проекта** — тем же путём, что
 * `worktree.updated`/`project.updated` (инвариант 27): в managed инстансный
 * канал не дошёл бы до обычного `USER`.
 *
 * Шина и источник сессий берутся из `ctx.extra` (там же, где `eventBus` у
 * `synth_mcp_*`/`synth_agent_*`); не заданы — помощник молча ничего не делает.
 */
export async function notifyPipelineChanged(
  ctx: ToolContext,
  info: { projectId: string; pipelineId: string; action: PipelineChangeAction },
): Promise<void> {
  const extra = getSessionExtra(ctx);
  await publishPipelineUpdated(
    { eventBus: extra.eventBus, sessionStore: extra.sessionManager },
    info,
  );
}

// ─────────────────────────────── Расписания (ADR-051) ───────────────────────────────

/**
 * Scope тула расписаний: рантайм + сессия + проект сессии + пользователь.
 *
 * В отличие от пайплайнов, проект у расписания **не обязателен**: сессия без
 * проекта (ADR-040) работает со «своими» расписаниями (владелец — `ownerId`).
 * Поэтому `project` здесь — `null`, а не отказ.
 */
export interface ScheduleScope {
  /** Рантайм автоматизации (порты и планировщик). */
  automation: AutomationRuntime;
  /** Сессия тула. */
  session: Session;
  /** Проект сессии — `null`, если сессия живёт без проекта. */
  project: Project | null;
  /** Пользователь сессии (`userId`/`ownerId`); пустая строка — атрибуции нет. */
  userId: string;
  /**
   * ADR-140 Ф2: группы пользователя (снимок принципала хода) — для грантов
   * по группам. Нет — групп нет (fail-closed).
   */
  groups?: readonly string[];
}

/** Результат `loadScheduleScope`: готовый scope либо готовый отказ. */
export type ScheduleScopeResult =
  | { ok: true; scope: ScheduleScope }
  | { ok: false; result: ToolResult };

/** Единый отказ «рантайм расписаний недоступен» (порты/планировщик не собраны). */
export function scheduleDepsUnavailable(toolName: string): ToolResult {
  const params = { tool: toolName };
  return {
    content: sm('schedule.tool.deps_unavailable', params),
    isError: true,
    metadata: { i18n: i18nMeta('schedule.tool.deps_unavailable', params) },
  };
}

/** Единый отказ «нет прав на изменение расписания». */
export function scheduleForbidden(): ToolResult {
  return {
    content: sm('schedule.tool.forbidden'),
    isError: true,
    metadata: { i18n: i18nMeta('schedule.tool.forbidden') },
  };
}

/**
 * Загрузить scope тула расписаний: рантайм + сессия + проект (может отсутствовать).
 *
 * Отказ (готовый `isError`-результат) — когда нельзя определить область
 * доступа: нет рантайма (`schedule.tool.deps_unavailable`) либо нет
 * `sessionManager`/`projectStore`/самой сессии (тот же отказ — область
 * вычислить нечем).
 */
export async function loadScheduleScope(
  ctx: ToolContext,
  toolName: string,
): Promise<ScheduleScopeResult> {
  const automation = getAutomation(ctx);
  if (!automation) return { ok: false, result: scheduleDepsUnavailable(toolName) };

  const extra = getSessionExtra(ctx);
  const sessionManager = extra.sessionManager;
  const projectStore = extra.projectStore;
  if (!sessionManager || !projectStore) {
    return { ok: false, result: scheduleDepsUnavailable(toolName) };
  }
  // Automation-скоуп — сессия разговора (у саб-агента родительская):
  // расписание, созданное агентом, должно жить в проекте человека, а не в
  // исчезающей дочерней сессии (ADR-051/ADR-141).
  const sessionId = parentSessionIdOf(ctx);
  if (!sessionId) return { ok: false, result: scheduleDepsUnavailable(toolName) };

  const session = await sessionManager.getSession(sessionId);
  if (!session) return { ok: false, result: scheduleDepsUnavailable(toolName) };

  // Проект может отсутствовать (сессия без проекта — ADR-040).
  const project = session.projectId ? await projectStore.load(session.projectId) : null;
  const userId = resolveSessionUserId(session) ?? '';
  const groups = principalGroups(ctx);

  return { ok: true, scope: { automation, session, project, userId, ...(groups ? { groups } : {}) } };
}

/**
 * Расписание в области доступа сессии (ADR-051).
 *
 * Доступ есть в двух случаях:
 * - **(а) своё** — `schedule.ownerId` совпадает с пользователем сессии;
 * - **(б) проектное** — цель относится к проекту сессии:
 *   - `pipeline` → `target.projectId === project.id`;
 *   - `ephemeral` → проект цели не задан **или** равен `project.id`;
 *   - `bound`/`queue` → сессия-цель лежит в том же проекте.
 *
 * Если у сессии нет проекта, работает только правило (а) — «свои» расписания
 * доступны и без проекта.
 */
export async function isScheduleInScope(
  schedule: Schedule,
  scope: ScheduleScope,
  ctx: ToolContext,
): Promise<boolean> {
  // (а) своё расписание — по владельцу.
  if (scope.userId && schedule.ownerId && schedule.ownerId === scope.userId) return true;

  // (б) проектная цель — только если у сессии есть проект.
  const project = scope.project;
  if (!project) return false;
  const target = schedule.target;
  if (target.mode === 'pipeline') return target.projectId === project.id;
  if (target.mode === 'ephemeral') return !target.project || target.project === project.id;

  // `bound`/`queue` — сессия-цель должна лежать в том же проекте.
  const sessionManager = getSessionExtra(ctx).sessionManager;
  if (!sessionManager) return false;
  const targetSession = await sessionManager.getSession(target.sessionId);
  return targetSession?.projectId === project.id;
}

/**
 * Проверка права на **изменение** расписания.
 *
 * `null` — право есть; иначе — готовый `isError`-результат с отказом.
 *
 * - владелец расписания (`ownerId === userId`) мутирует своё расписание всегда;
 * - проектное расписание — только с правом изменения содержимого проекта
 *   (`canEditProject`): read-уровень (`VIEWER`) не даёт прав на изменение
 *   (инвариант 21).
 */
export async function ensureScheduleMutable(
  schedule: Schedule,
  scope: ScheduleScope,
  ctx: ToolContext,
): Promise<ToolResult | null> {
  if (scope.userId && schedule.ownerId && schedule.ownerId === scope.userId) return null;
  if (!(await isScheduleInScope(schedule, scope, ctx))) return scheduleForbidden();
  const project = scope.project;
  if (!project) return scheduleForbidden();
  if (!canEditProject(scope.session, project, scope.groups)) return scheduleForbidden();
  return null;
}
