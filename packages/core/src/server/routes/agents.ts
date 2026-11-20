import { Hono } from 'hono';
import type { Context } from 'hono';
import type { createMiddleware } from 'hono/factory';
import type { AgentDefinition } from '@itphx/synth-shared';
import { SERVICE_SCOPE_SETS, EFFORT_LEVELS, isEffortLevel } from '@itphx/synth-shared';
import type { JsonStoreLike } from '../../storage/json-store.js';
import type { ContextFileRepository } from '../../storage/ports/context-file-repository.js';
import {
  loadSystemAgentDefinitions,
  normalizeAgentModes,
  DEFAULT_AGENT_ID,
  isAgentDefinitionChanged,
} from '../../engine/agents/index.js';
import type { AgentRegistry } from '../../engine/agents/index.js';
import type { AgentsChangedHook } from '../../events/agents-events.js';
import { requireScopeOrAdminRole } from '../service-scope.js';
import type { ScopeGuardFactory } from '../service-scope.js';
import type { ExecutionProfileCatalog } from '../../execution/profile-binding.js';
import { info, warning } from '../../logger.js';

/** Тип middleware, совпадающий с core/backend AuthKit (оба на createMiddleware). */
type Middleware = ReturnType<typeof createMiddleware>;

/** Минимальный auth-контракт фабрики: в core и backend общий (структурно). */
export interface AgentRoutesAuth {
  requireAuth: Middleware;
}

/** Локализуемые сообщения: backend передаёт t(), core — русские литералы по умолчанию. */
export interface AgentRouteMessages {
  idRequired: (c: Context) => string;
  invalidAgentId: (c: Context) => string;
  invalidRoleFile: (c: Context) => string;
  invalidEffort: (c: Context) => string;
  agentNotFound: (c: Context) => string;
  agentOverrideNotFound: (c: Context) => string;
}

/**
 * Порт файлов контекста для записи ролевого промпта агента.
 * Структурно совместим с `ContextFileRepository` (реализация — `ContextConfig`).
 */
export type AgentRoleFiles = Pick<ContextFileRepository, 'getFile' | 'saveFile'>;

/** Отчёт о записи ролевого промпта (аддитивное поле ответа `POST /agents`). */
export interface AgentRoleResult {
  /** Имя файла роли в `{dataDir}/context/roles/`. */
  file: string;
  /** Файл записан. */
  written: boolean;
  /**
   * Уже существовавший файл с другим содержимым перезаписан — это явная
   * установка/обновление роли (факт фиксируется в ответе и в логе).
   */
  replaced: boolean;
}

export interface AgentRoutesOptions {
  /** Guard для POST /, DELETE /:id, PATCH /:id/enabled (backend — requireAdmin, core — requireAuth). */
  writeGuard?: Middleware;
  /** Guard для GET /all (backend — requireAdmin, core — requireAuth). */
  allGuard?: Middleware;
  /** Guard для GET /:id (backend — requireAdmin, core — requireAuth). */
  detailGuard?: Middleware;
  /**
   * ADR-052: scope-гейт service-key для записи агентов (создание + ролевой
   * промпт + удаление/отключение). Достаточно любого из
   * `SERVICE_SCOPE_SETS.agentsWrite` — сейчас это зонтичный `automation:install`
   * (установщик пакетов расширений). Дефолт — `requireScopeOrAdminRole`:
   * для интерактивных кред — no-op, для service-key — scope **или** роль ADMIN.
   */
  scopeGuard?: ScopeGuardFactory;
  /** Переопределение сообщений (backend — i18n). */
  messages?: Partial<AgentRouteMessages>;
  /**
   * ADR-126/ADR-089: порт файлов контекста — запись ролевого промпта агента
   * вместе с агентом (поле `role_prompt` в теле `POST /`). Файл роли пишется
   * в `{dataDir}/context/roles/<contextFile>` и имеет приоритет над системным
   * `prompts/roles/` (резолв — `ContextConfig.getRolePrompt`).
   * Не задан — роль по HTTP не пишется, поведение прежнее.
   */
  roleFiles?: AgentRoleFiles;
  /**
   * PROP-135 Ф6a: каталог профилей исполнения (снимок `execution.remote`) —
   * проверка `executor_profile`/`allowed_profiles` при записи агента: профиль
   * обязан существовать в каталоге, потолок — быть его подмножеством.
   * Не задан (inline/instance-пул/тесты) — проверка пропускается, значения
   * сохраняются как есть.
   */
  executionProfileCatalog?: ExecutionProfileCatalog;
  /**
   * PROP-135 (браузерный контур): каталог **браузерных** профилей
   * (`execution.remote.browserProfiles`; пусто → `[browserProfile]`) —
   * проверка `browser_profile`/`allowed_browser_profiles`. Не задан — проверка
   * существования пропускается (inline/тесты).
   */
  browserProfileCatalog?: ExecutionProfileCatalog;
  /**
   * Реестр агентов изменился: создан/обновлён (`save`), удалён/сброшен override
   * (`delete`/`reset`), переключён `enabled` (`enable`).
   *
   * Вызывается **только после успешной записи** и только если запись реально
   * изменилась (сравнение `isAgentDefinitionChanged`): валидация с ответом 400
   * и повторное сохранение без правок событие не порождают.
   *
   * Точка сборки прокидывает сюда `publishAgentsUpdated` (`events/agents-events.ts`).
   * Не задан — фабрика работает как раньше (тесты, сторонние потребители).
   */
  onAgentsChanged?: AgentsChangedHook;
}

const DEFAULT_MESSAGES: AgentRouteMessages = {
  idRequired: () => 'ID обязателен',
  invalidAgentId: () => 'ID агента может содержать только латиницу, цифры, дефис и подчёркивание',
  invalidRoleFile: () => 'Имя файла роли должно быть именем файла без путей и «..»',
  invalidEffort:
    () => `Некорректный тир усилия (effort): допустимые значения — ${EFFORT_LEVELS.join(', ')}`,
  agentNotFound: () => 'Агент не найден',
  agentOverrideNotFound: () => 'Override не найден',
};

const AGENT_ID_REGEX = /^[a-z0-9_-]+$/;

const AGENT_FIELDS = (a: AgentDefinition, isBuiltin: boolean) => ({
  id: a.id,
  display_name: a.displayName,
  capabilities: a.capabilities,
  enabled: a.enabled,
  icon: a.icon || null,
  color: a.color || null,
  description: a.description || null,
  available: true,
  mode: 'simple' as const,
  agent_mode: normalizeAgentModes(a.agentMode),
  max_steps: a.maxSteps ?? null,
  provider: a.provider || null,
  model: a.model || null,
  reasoning_level: a.reasoningLevel ?? null,
  // ADR-117: явный тир усилия агента (`xhigh`/`max` — только так); `null` — авто.
  effort: a.effort ?? null,
  context_file: a.contextFile || null,
  // ADR-126 §9: группы агента (привязка скиллов по `metadata.synth.groups`).
  groups: a.groups ?? null,
  // PROP-135 Ф6a: профиль исполнения агента и потолок разрешённых профилей.
  executor_profile: a.executorProfile ?? null,
  allowed_profiles: a.allowedProfiles ?? null,
  // PROP-135 (браузерный контур): профиль браузерного пула и его потолок.
  browser_profile: a.browserProfile ?? null,
  allowed_browser_profiles: a.allowedBrowserProfiles ?? null,
  is_builtin: isBuiltin,
  is_overridden: a.isOverridden,
});

/**
 * Имя файла роли агента — тот же дефолт, что в `ContextConfig.getRolePrompt`:
 * без явного `contextFile` — `<ID_АГЕНТА_UPPER>.md`. Файл должен совпадать
 * с тем, который ищет резолвер роли, иначе роль не подхватится.
 */
function roleFileName(agent: Pick<AgentDefinition, 'id' | 'contextFile'>): string {
  return agent.contextFile || `${agent.id.toUpperCase()}.md`;
}

/**
 * Имя файла роли — «плоское» (без путей и `..`): файл пишется в
 * `{dataDir}/context/roles/`, и имя с путём ушло бы за пределы каталога
 * (path traversal). Проверка по образцу `JsonStore` (ключ без `..` и `\`).
 */
function isSafeRoleFileName(name: string): boolean {
  if (!name || name === '.' || name === '..') return false;
  if (name.includes('..') || name.includes('/') || name.includes('\\')) return false;
  return true;
}

/**
 * ADR-126 §9: группы агента — массив непустых строк без дублей.
 * Не-массив → `undefined` (поле не меняется, приоритет `body → existing → builtin`).
 */
function normalizeGroups(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const groups: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const name = item.trim();
    if (!name || groups.includes(name)) continue;
    groups.push(name);
  }
  return groups;
}

/**
 * PROP-135 Ф6a: список профилей исполнения (`allowed_profiles`) — массив
 * непустых строк без дублей. Не массив → `undefined` (значение не меняется).
 */
function normalizeProfileList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const list: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const name = item.trim();
    if (!name || list.includes(name)) continue;
    list.push(name);
  }
  return list;
}

/**
 * Содержимое ролевого промпта из тела запроса (`role_prompt`/`rolePrompt`).
 * Пустая строка — «роли нет» (файл не пишется, поведение прежнее).
 */
function readRolePrompt(body: unknown): string | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const raw = body as Record<string, unknown>;
  const value = typeof raw.role_prompt === 'string'
    ? raw.role_prompt
    : typeof raw.rolePrompt === 'string'
      ? raw.rolePrompt
      : undefined;
  if (value === undefined) return undefined;
  return value.trim().length > 0 ? value : undefined;
}

/**
 * Запись ролевого промпта агента в файл роли (атомарно — порт файлов
 * контекста пишет tmp → rename). Существующий файл с другим содержимым
 * перезаписывается (явная установка/обновление роли) — факт фиксируется
 * в ответе (`role.replaced`) и в логе.
 */
async function writeRolePrompt(
  store: AgentRoleFiles | undefined,
  file: string,
  agentId: string,
  content: string,
): Promise<{ ok: true; result: AgentRoleResult } | { ok: false; message: string }> {
  if (!store) {
    return {
      ok: false,
      message: 'Запись ролевого промпта недоступна: порт файлов контекста не подключён',
    };
  }
  const previous = store.getFile(file, 'role');
  const replaced = previous !== null && previous.content !== content;
  const saved = await store.saveFile(file, content, 'role');
  if (!saved) {
    return { ok: false, message: `Не удалось сохранить ролевой промпт агента (${file})` };
  }
  if (replaced) {
    warning('AGENTS', `Ролевой промпт агента ${agentId} перезаписан: ${file}`);
  } else {
    info('AGENTS', `Ролевой промпт агента ${agentId} сохранён: ${file}`);
  }
  return { ok: true, result: { file, written: true, replaced } };
}

export function createAgentRoutes(
  auth: AgentRoutesAuth,
  agentStore: JsonStoreLike<AgentDefinition>,
  agentRegistry?: AgentRegistry,
  getDefaultAgentId?: () => string | Promise<string>,
  opts?: AgentRoutesOptions,
): Hono {
  const app = new Hono();
  const BUILTIN_AGENTS = loadSystemAgentDefinitions();
  const BUILTIN_IDS = new Set(BUILTIN_AGENTS.map((a) => a.id));

  const writeGuard = opts?.writeGuard ?? auth.requireAuth;
  const allGuard = opts?.allGuard ?? auth.requireAuth;
  const detailGuard = opts?.detailGuard ?? auth.requireAuth;
  // ADR-052: scope-гейт записи агентов (установщик пакета — `automation:install`).
  const scoped = opts?.scopeGuard ?? requireScopeOrAdminRole;
  const messages: AgentRouteMessages = { ...DEFAULT_MESSAGES, ...opts?.messages };

  const fields = (a: AgentDefinition) => AGENT_FIELDS(a, BUILTIN_IDS.has(a.id));

  async function resolveAgents(): Promise<AgentDefinition[]> {
    const overrides = await agentStore.list();
    const agents = BUILTIN_AGENTS.map((builtin) => {
      const override = overrides.find((o) => o.id === builtin.id);
      return override ? { ...builtin, ...override, isOverridden: true } : builtin;
    });

    for (const o of overrides) {
      if (!BUILTIN_IDS.has(o.id)) {
        agents.push({ ...o, isOverridden: true });
      }
    }
    return agents;
  }

  // Все агенты (для админки) — регистрируем до /:id-подобных маршрутов
  app.get('/all', allGuard, async (c) => {
    return c.json({
      agents: (await resolveAgents()).map(fields),
      default_agent: (await getDefaultAgentId?.()) ?? DEFAULT_AGENT_ID,
    });
  });

  // Только основные агенты (класс primary) — для чата
  app.get('/', auth.requireAuth, async (c) => {
    const agents = (await resolveAgents())
      .filter((a) => normalizeAgentModes(a.agentMode).includes('primary'));

    return c.json({
      agents: agents.map(fields),
      default_agent: (await getDefaultAgentId?.()) ?? DEFAULT_AGENT_ID,
    });
  });

  // Создать/обновить агента (custom или override builtin)
  // ADR-052: для service-key — scope `automation:install` (установщик пакета)
  // или роль ADMIN; интерактивные креды — no-op.
  app.post('/', writeGuard, scoped(...SERVICE_SCOPE_SETS.agentsWrite), async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const id = body.id?.trim();
    if (!id) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: messages.idRequired(c) } }, 400);
    }
    if (!AGENT_ID_REGEX.test(id)) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: messages.invalidAgentId(c) } }, 400);
    }

    // ADR-117: тир усилия агента (`xhigh`/`max` задаются только явно). `null` —
    // сброс в «авто» (тир из уровня размышлений), невалидное значение — 400:
    // контракт запроса, а не «тихий» игнор.
    const effortInput = body.effort;
    if (effortInput !== undefined && effortInput !== null && !isEffortLevel(effortInput)) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: messages.invalidEffort(c) } }, 400);
    }

    const builtin = BUILTIN_AGENTS.find((a) => a.id === id);
    const existing = await agentStore.load(id);

    // PROP-135 Ф6a: профиль исполнения агента и потолок разрешённых профилей.
    // `undefined` (поле не передано) — сохраняем прежнее значение записи;
    // `null`/`''` — сброс профиля; `[]` — «профилей нет» (ADR-135, аддендум:
    // пустой список = ничего не разрешено), `null` у списка — потолок не задан.
    // При заданном каталоге профиль обязан в нём существовать, список — быть
    // его подмножеством (иначе 400: контракт запроса, а не «тихий» игнор).
    const catalog = opts?.executionProfileCatalog;
    const knownProfile = (name: string): boolean =>
      !catalog || catalog.profiles.length === 0 || catalog.profiles.includes(name);

    const executorProfileInput = body.executor_profile !== undefined
      ? body.executor_profile
      : body.executorProfile;
    let executorProfile: string | undefined;
    if (executorProfileInput === undefined) {
      executorProfile = existing?.executorProfile ?? builtin?.executorProfile;
    } else if (executorProfileInput === null) {
      executorProfile = undefined;
    } else if (typeof executorProfileInput !== 'string') {
      return c.json(
        {
          error: {
            code: 'VALIDATION_ERROR',
            message: 'executor_profile должен быть строкой или null',
          },
        },
        400,
      );
    } else {
      const profile = executorProfileInput.trim();
      if (profile === '') {
        executorProfile = undefined;
      } else if (!knownProfile(profile)) {
        return c.json({
          error: {
            code: 'VALIDATION_ERROR',
            message: `Профиль исполнения не найден: "${profile}". Доступные: ${catalog!.profiles.join(', ')}`,
          },
        }, 400);
      } else {
        executorProfile = profile;
      }
    }

    const allowedProfilesInput = body.allowed_profiles !== undefined
      ? body.allowed_profiles
      : body.allowedProfiles;
    let allowedProfiles: string[] | undefined;
    if (allowedProfilesInput === undefined) {
      allowedProfiles = existing?.allowedProfiles ?? builtin?.allowedProfiles;
    } else if (allowedProfilesInput === null) {
      allowedProfiles = undefined;
    } else {
      const list = normalizeProfileList(allowedProfilesInput);
      if (list === undefined) {
        return c.json(
          {
            error: {
              code: 'VALIDATION_ERROR',
              message: 'allowed_profiles должен быть массивом строк или null',
            },
          },
          400,
        );
      }
      const unknown = list.filter((name) => !knownProfile(name));
      if (unknown.length > 0) {
        return c.json({
          error: {
            code: 'VALIDATION_ERROR',
            message: `Профили исполнения не найдены: ${unknown.join(', ')}. Доступные: ${catalog!.profiles.join(', ')}`,
          },
        }, 400);
      }
      // ADR-135 (аддендум): пустой список — **«профилей нет»** (fail-closed),
      // а не «без ограничения»: список сохраняется как есть (`[]`).
      allowedProfiles = list;
    }

    // PROP-135 (браузерный контур): профиль браузерного пула агента и потолок.
    // Правила как у exec: `undefined` — сохраняем прежнее; `null`/`''` — сброс;
    // `[]` — «профилей нет». Валидация — по **браузерному** каталогу (exec-имена
    // сюда не попадают и наоборот).
    const browserCatalog = opts?.browserProfileCatalog;
    const knownBrowserProfile = (name: string): boolean =>
      !browserCatalog || browserCatalog.profiles.length === 0 || browserCatalog.profiles.includes(name);

    const browserProfileInput = body.browser_profile !== undefined
      ? body.browser_profile
      : body.browserProfile;
    let browserProfile: string | undefined;
    if (browserProfileInput === undefined) {
      browserProfile = existing?.browserProfile ?? builtin?.browserProfile;
    } else if (browserProfileInput === null) {
      browserProfile = undefined;
    } else if (typeof browserProfileInput !== 'string') {
      return c.json(
        {
          error: {
            code: 'VALIDATION_ERROR',
            message: 'browser_profile должен быть строкой или null',
          },
        },
        400,
      );
    } else {
      const profile = browserProfileInput.trim();
      if (profile === '') {
        browserProfile = undefined;
      } else if (!knownBrowserProfile(profile)) {
        return c.json({
          error: {
            code: 'VALIDATION_ERROR',
            message: `Профиль браузера не найден: "${profile}". Доступные: ${browserCatalog!.profiles.join(', ')}`,
          },
        }, 400);
      } else {
        browserProfile = profile;
      }
    }

    const allowedBrowserProfilesInput = body.allowed_browser_profiles !== undefined
      ? body.allowed_browser_profiles
      : body.allowedBrowserProfiles;
    let allowedBrowserProfiles: string[] | undefined;
    if (allowedBrowserProfilesInput === undefined) {
      allowedBrowserProfiles = existing?.allowedBrowserProfiles ?? builtin?.allowedBrowserProfiles;
    } else if (allowedBrowserProfilesInput === null) {
      allowedBrowserProfiles = undefined;
    } else {
      const list = normalizeProfileList(allowedBrowserProfilesInput);
      if (list === undefined) {
        return c.json(
          {
            error: {
              code: 'VALIDATION_ERROR',
              message: 'allowed_browser_profiles должен быть массивом строк или null',
            },
          },
          400,
        );
      }
      const unknown = list.filter((name) => !knownBrowserProfile(name));
      if (unknown.length > 0) {
        return c.json({
          error: {
            code: 'VALIDATION_ERROR',
            message: `Профили браузера не найдены: ${unknown.join(', ')}. Доступные: ${browserCatalog!.profiles.join(', ')}`,
          },
        }, 400);
      }
      // ADR-135 (аддендум): пустой список — «профилей нет» (fail-closed).
      allowedBrowserProfiles = list;
    }

    // ADR-135 (аддендум «пустой список = ничего; дефолт должен быть в списке»):
    // профиль обязан входить в список разрешённых, а инстанс-дефолт —
    // **не исключение** (иначе кандидат не выбирается).
    if (executorProfile !== undefined && allowedProfiles !== undefined
      && !allowedProfiles.includes(executorProfile)) {
      return c.json({
        error: {
          code: 'VALIDATION_ERROR',
          message: `Профиль исполнения должен входить в список разрешённых: ${executorProfile}`,
        },
      }, 400);
    }
    if (executorProfile === undefined && allowedProfiles !== undefined && allowedProfiles.length > 0
      && catalog?.defaultProfile && !allowedProfiles.includes(catalog.defaultProfile)) {
      return c.json({
        error: {
          code: 'VALIDATION_ERROR',
          message: `Профиль по умолчанию должен входить в список разрешённых: ${catalog.defaultProfile}`,
        },
      }, 400);
    }
    if (browserProfile !== undefined && allowedBrowserProfiles !== undefined
      && !allowedBrowserProfiles.includes(browserProfile)) {
      return c.json({
        error: {
          code: 'VALIDATION_ERROR',
          message: `Профиль браузера должен входить в список разрешённых: ${browserProfile}`,
        },
      }, 400);
    }
    if (browserProfile === undefined && allowedBrowserProfiles !== undefined
      && allowedBrowserProfiles.length > 0 && browserCatalog?.defaultProfile
      && !allowedBrowserProfiles.includes(browserCatalog.defaultProfile)) {
      return c.json({
        error: {
          code: 'VALIDATION_ERROR',
          message: `Профиль браузера по умолчанию должен входить в список разрешённых: ${browserCatalog.defaultProfile}`,
        },
      }, 400);
    }

    const agent: AgentDefinition = {
      id,
      displayName: body.display_name ?? body.displayName ?? existing?.displayName ?? builtin?.displayName ?? id,
      contextFile: body.context_file ?? body.contextFile ?? existing?.contextFile,
      capabilities: body.capabilities ?? existing?.capabilities ?? builtin?.capabilities ?? [],
      enabled: body.enabled ?? existing?.enabled ?? builtin?.enabled ?? true,
      provider: body.provider ?? existing?.provider,
      model: body.model ?? existing?.model,
      temperature:
        // `null` — явный сброс в Auto (дефолт модели): поле не задано, а не
        // унаследовано от прежней записи (UI: чекбокс «Auto (model default)»).
        body.temperature === null
          ? undefined
          : (body.temperature ?? existing?.temperature),
      topP: body.top_p ?? body.topP ?? existing?.topP,
      topK: body.top_k ?? body.topK ?? existing?.topK,
      reasoningLevel: body.reasoning_level ?? body.reasoningLevel ?? existing?.reasoningLevel ?? builtin?.reasoningLevel,
      // `null` — сброс в «авто» (тир из уровня размышлений), undefined —
      // «не передано» (сохраняем прежнее значение записи).
      effort: effortInput === null
        ? undefined
        : (isEffortLevel(effortInput) ? effortInput : (existing?.effort ?? builtin?.effort)),
      isOverridden: true,
      icon: body.icon ?? existing?.icon,
      color: body.color ?? existing?.color,
      description: body.description ?? existing?.description,
      agentMode: normalizeAgentModes(body.agent_mode ?? body.agentMode ?? existing?.agentMode ?? builtin?.agentMode),
      maxSteps: body.max_steps ?? body.maxSteps ?? existing?.maxSteps,
      // ADR-126 §9: группы агента (привязка скиллов по `metadata.synth.groups`).
      groups: normalizeGroups(body.groups) ?? existing?.groups ?? builtin?.groups,
      // PROP-135 Ф6a: профиль исполнения и потолок разрешённых профилей.
      executorProfile,
      allowedProfiles,
      // PROP-135 (браузерный контур): отдельные поля, отдельный каталог.
      browserProfile,
      allowedBrowserProfiles,
    };

    // ADR-126/ADR-089: ролевой промпт агента — содержимое (не путь) в теле
    // запроса. Файл роли пишется ДО сохранения агента: агент без роли —
    // сломанный агент, а «лишний» файл роли перезапишется следующей установкой.
    const rolePrompt = readRolePrompt(body);
    let role: AgentRoleResult | undefined;
    if (rolePrompt !== undefined) {
      const file = roleFileName(agent);
      if (!isSafeRoleFileName(file)) {
        return c.json(
          { error: { code: 'VALIDATION_ERROR', message: messages.invalidRoleFile(c) } },
          400,
        );
      }
      const written = await writeRolePrompt(opts?.roleFiles, file, id, rolePrompt);
      if (!written.ok) {
        return c.json({ error: { code: 'INTERNAL_ERROR', message: written.message } }, 500);
      }
      role = written.result;
    }

    // Состояние реестра до записи (`before`): запись стора поверх встроенного
    // определения либо само встроенное — нужно для сравнения «было/стало»
    // перед публикацией события.
    const before = existing ? { ...builtin, ...existing } : builtin;

    await agentStore.save(id, agent);
    agentRegistry?.register(agent);
    // Реестр изменился → инстансное событие `agents.updated` (админ-панель и
    // селекты агента перечитывают состав без перезагрузки страницы).
    // Правка **только** роли (агент без изменений) — тоже изменение реестра:
    // `role.replaced` = содержимое файла роли реально другое.
    if (isAgentDefinitionChanged(before, agent) || role?.replaced === true) {
      opts?.onAgentsChanged?.({ id, action: 'save' });
    }
    return c.json(role ? { ...agent, role } : agent, existing ? 200 : 201);
  });

  // Получить агента (override/builtin)
  app.get('/:id', detailGuard, async (c) => {
    const id = c.req.param('id');
    const override = await agentStore.load(id);
    const builtin = BUILTIN_AGENTS.find((a) => a.id === id);
    if (!override && !builtin) {
      return c.json({ error: { code: 'NOT_FOUND', message: messages.agentNotFound(c) } }, 404);
    }
    const agent = override ? { ...builtin, ...override } : builtin;
    return c.json(agent);
  });

  // Удалить custom / сбросить built-in (override)
  app.delete('/:id', writeGuard, scoped(...SERVICE_SCOPE_SETS.agentsWrite), async (c) => {
    const id = c.req.param('id');
    const isBuiltin = BUILTIN_IDS.has(id);
    const exists = await agentStore.exists(id);

    if (isBuiltin) {
      if (exists) {
        await agentStore.delete(id);
        const builtin = BUILTIN_AGENTS.find((a) => a.id === id);
        if (builtin) agentRegistry?.register(builtin);
        // Override снят — встроенное определение восстановлено (тоже мутация).
        opts?.onAgentsChanged?.({ id, action: 'reset' });
        return c.json({ status: 'reset' });
      }
      return c.json({ error: { code: 'NOT_FOUND', message: messages.agentOverrideNotFound(c) } }, 404);
    }

    if (exists) {
      await agentStore.delete(id);
      agentRegistry?.unregister(id);
      opts?.onAgentsChanged?.({ id, action: 'delete' });
      return c.json({ status: 'deleted' });
    }
    return c.json({ error: { code: 'NOT_FOUND', message: messages.agentNotFound(c) } }, 404);
  });

  // Переключить enabled (override builtin или custom)
  app.patch('/:id/enabled', writeGuard, scoped(...SERVICE_SCOPE_SETS.agentsWrite), async (c) => {
    const id = c.req.param('id');
    const body = await c.req.json().catch(() => ({}));
    const enabled = body.enabled ?? true;

    const builtin = BUILTIN_AGENTS.find((a) => a.id === id);
    const existing = await agentStore.load(id);

    if (!builtin && !existing) {
      return c.json({ error: { code: 'NOT_FOUND', message: messages.agentNotFound(c) } }, 404);
    }

    const agent: AgentDefinition = existing
      ? { ...existing, enabled }
      : { ...builtin!, enabled, isOverridden: true };
    await agentStore.save(id, agent);
    agentRegistry?.register(agent);
    // Событие — только при реальной смене признака: PATCH тем же значением
    // ничего не меняет (лишний `GET /agents/all` в открытых админках — шум).
    if ((existing?.enabled ?? builtin!.enabled) !== enabled) {
      opts?.onAgentsChanged?.({ id, action: 'enable' });
    }
    return c.json({ id, enabled });
  });

  return app;
}
