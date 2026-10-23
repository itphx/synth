import { Hono } from 'hono';
import type { Context } from 'hono';
import type { createMiddleware } from 'hono/factory';
import {
  packManifestSchema,
  pipelineDefinitionSchema,
  summarizePackAuthority,
  validatePackManifest,
  parseFrontmatter,
  nowISO,
} from '@itphx/synth-shared';
import type {
  AgentDefinition,
  McpServerConfig,
  PackAgentProvide,
  PackAuthoritySummary,
  PackManifest,
  PackMcpProvide,
  PackPipelineProvide,
  PackSkillProvide,
  ToolCapability,
} from '@itphx/synth-shared';
import type { ContextFileRepository } from '../../storage/ports/context-file-repository.js';
import type { EventRouteRepository } from '../../storage/ports/event-route-repository.js';
import type { McpRegistryRepository } from '../../storage/ports/mcp-registry-repository.js';
import type {
  PackInstallation,
  PackInstallationProvides,
  PackRepository,
} from '../../storage/ports/pack-repository.js';
import type {
  PipelineDefinitionRecord,
  PipelineRepository,
} from '../../storage/ports/pipeline-repository.js';
import { requireScopeOrAdminRole } from '../service-scope.js';
import type { ScopeGuardFactory } from '../service-scope.js';
import { info } from '../../logger.js';

/**
 * ADR-086 §5 / PROP-068/PROP-090: **установка пакета расширения** — одна
 * операция доставляет в инстанс скиллы, MCP-серверы, агентов (с ролями) и
 * пайплайны (с порождаемыми правилами маршрутизации, ADR-089).
 *
 * Фабрика общая для core (standalone) и backend (managed): RBAC и scope-гейты
 * задаются через `opts`.
 *
 * ## Контракт `POST /api/v2/packs`
 *
 * ```json
 * { "manifest": { …synth.pack… },
 *   "files": { "agents/publisher/role.md": "…", "pipelines/publication.yaml": "…" } }
 * ```
 *
 * `files` — файлы пакета (относительные пути → содержимое), на которые
 * ссылается манифест: `provides.agents[].rolePrompt.path`,
 * `provides.pipelines[].path`, `provides.skills[].path` (каталог скилла, его
 * `SKILL.md` — `<path>/SKILL.md`). Если в манифесте указан `content` — берётся
 * он, иначе — файл из `files`.
 *
 * ## Порядок установки (идемпотентный upsert)
 *
 * 1. **скиллы** — `SKILL.md` (+ supporting-файлы), `metadata.synth.*` — через
 *    `updateInstance` (при create frontmatter пересобирается из name+description);
 * 2. **MCP** — запись реестра по имени: `origin:'instance'`, `enabledByDefault:true`
 *    (иначе сервер не попадёт в дефолты новых сессий — ADR-071 §2.4);
 * 3. **агенты** — **роль сначала, потом агент** (fail-closed: агент без роли —
 *    сломанный агент), роль — `{dataDir}/context/roles/<contextFile>`;
 * 4. **пайплайны** — определение (`definition` или файл `path`) → `saveDefinition`
 *    с `installedBy: {pack, version}`;
 * 5. **правила маршрутизации** — по шагам с `waitsFor` (ADR-089): id правила
 *    стабильный, поэтому повторная установка **обновляет** правило, а не плодит.
 *
 * ## Одобрение
 *
 * Пакет, дающий **capability-гранты** (непустые `capabilities` агента),
 * объявляющий пайплайны (порождаемые правила) или расписания, требует
 * подтверждения администратора: фактическая установка **не выполняется**, в
 * реестр пишется запись `status:'pending_approval'`, а `POST /packs/:name/approve`
 * (только ADMIN) доустанавливает пакет.
 */

/** Тип middleware, совпадающий с core/backend AuthKit (оба на createMiddleware). */
type Middleware = ReturnType<typeof createMiddleware>;

/** Минимальный auth-контракт фабрики: в core и backend общий (структурно). */
export interface PacksRoutesAuth {
  requireAuth: Middleware;
}

/** Локализуемые сообщения: backend передаёт t(), core — русские литералы. */
export interface PacksRouteMessages {
  invalidManifest: (c: Context) => string;
  missingFile: (c: Context) => string;
  packNotFound: (c: Context) => string;
  packNotPending: (c: Context) => string;
  packInvalid: (c: Context) => string;
  invalidBody: (c: Context) => string;
}

/**
 * Минимальный порт скиллов, нужный установщику пакета (ADR-046 §4/§9).
 * Структурно совместим с `SkillService`.
 */
export interface PackSkillsPort {
  instanceExists(name: string): Promise<boolean>;
  createInstance(input: {
    name: string;
    description: string;
    body?: string;
    files?: Record<string, string>;
  }): Promise<unknown>;
  updateInstance(
    name: string,
    patch: { description?: string; body?: string; metadata?: Record<string, unknown> },
  ): Promise<unknown>;
  writeInstanceFile(name: string, relPath: string, content: string): Promise<void>;
  removeInstance(name: string): Promise<boolean>;
}

/**
 * Порт файлов ролей агентов (`{dataDir}/context/roles/`) — запись и снятие
 * ролевого промпта. Структурно совместим с `ContextFileRepository`.
 */
export type PackRoleFiles = Pick<ContextFileRepository, 'saveFile' | 'deleteFile'>;

/**
 * Минимальный порт реестра агентов: сохранение/удаление определения +
 * runtime-регистрация (`AgentRegistry.register`/`unregister`).
 */
export interface PackAgentsPort {
  save(id: string, value: AgentDefinition): Promise<void>;
  delete(id: string): Promise<void>;
}

export interface PacksRoutesDeps {
  /** Реестр установок пакетов (ADR-086 §5). */
  packs: PackRepository;
  /** Реестр пайплайнов (ADR-051/ADR-100). */
  pipelines: PipelineRepository;
  /** Скиллы инстанса (ADR-046). */
  skills: PackSkillsPort;
  /** Реестр MCP-серверов (ADR-071). */
  mcpRegistry: McpRegistryRepository;
  /** Реестр агентов (JsonStore-подобный порт). */
  agents: PackAgentsPort;
  /** Файлы ролей агентов (`context/roles`). */
  roleFiles?: PackRoleFiles;
  /** Правила маршрутизации внешних событий (ADR-089). */
  routes: EventRouteRepository;
  /** Runtime-регистрация агентов (AgentRegistry) — опционально. */
  registerAgent?: (agent: AgentDefinition) => void;
  /** Снятие агента из runtime-регистрации — опционально. */
  unregisterAgent?: (id: string) => void;
  /** id текущего пользователя (владелец установки) — опционально. */
  resolveUserId?: (c: Context) => string | undefined;
}

export interface PacksRoutesOptions {
  /** Guard на чтение реестра установок. */
  readGuard?: Middleware;
  /** Guard на установку пакета (core — `requireAuth`, backend — RBAC/scope). */
  writeGuard?: Middleware;
  /** Guard на одобрение пакета (только ADMIN). */
  approveGuard?: Middleware;
  /** Guard на снятие установки (только ADMIN). */
  uninstallGuard?: Middleware;
  /**
   * ADR-052: scope-гейт service-key для установки — зонтичный
   * `automation:install` (установщик пакета) или роль ADMIN.
   * Дефолт — `requireScopeOrAdminRole`: для интерактивных кред — no-op.
   */
  scopeGuard?: ScopeGuardFactory;
  /** Переопределение сообщений (backend — i18n). */
  messages?: Partial<PacksRouteMessages>;
}

const DEFAULT_MESSAGES: PacksRouteMessages = {
  invalidManifest: () => 'Некорректный манифест пакета',
  missingFile: () => 'Файл пакета не найден',
  packNotFound: () => 'Пакет не установлен',
  packNotPending: () => 'Пакет не ожидает подтверждения',
  packInvalid: () => 'Сохранённый манифест пакета не проходит валидацию',
  invalidBody: () => 'Некорректное тело запроса',
};

/** Ответ установки пакета. */
export interface PackInstallResult {
  /** Фактически установлено ли (false — пакет ждёт подтверждения). */
  installed: boolean;
  /** Требуется ли подтверждение администратора. */
  requiresApproval: boolean;
  /** Имя пакета. */
  name: string;
  /** Версия пакета. */
  version: string;
  /** Что пакет поставил (id'ы). */
  provides: PackInstallationProvides;
  /**
   * Сводка контента полномочий пакета (ADR-106 Ф5): роли/действия/цели/агенты,
   * которые пакет приносит. Поля нет, если пакет полномочий не приносит.
   */
  authority?: PackAuthoritySummary;
  /** Нефатальные замечания (пропущенные вклады и т.п.). */
  problems?: string[];
}

/** Нормализация пути файла пакета: без ведущих `./` и `/`. */
function normalizePackPath(path: string): string {
  return path.replace(/^\.\//, '').replace(/^\/+/, '');
}

/**
 * Стабильный id правила маршрутизации для шага пайплайна.
 *
 * Имя пакета может быть scoped npm-именем (`@scope/name`), а id правила не
 * допускает `/` и `\` (защита от path traversal в `RouteRuleStore`), поэтому
 * небезопасные символы заменяются на `-`. Человекочитаемое имя правила
 * (`pack:<pack>:<pipeline>:<step>`) сохраняется как есть — по нему же
 * выполняется каскадное удаление при снятии пакета.
 */
function packRuleId(packName: string, pipelineId: string, stepId: string): string {
  const safe = (value: string): string =>
    value
      .replace(/[^A-Za-z0-9._-]+/g, '-')
      .replace(/\.{2,}/g, '.')
      .replace(/^[-.]+/, '');
  return `pack-${safe(packName)}-${safe(pipelineId)}-${safe(stepId)}`;
}

/** Префикс имён правил, порождённых пакетом. */
function packRuleNamePrefix(packName: string): string {
  return `pack:${packName}:`;
}

/** Имя файла роли агента — тот же дефолт, что в `createAgentRoutes`. */
function roleFileName(agentId: string, contextFile?: string): string {
  return contextFile || `${agentId.toUpperCase()}.md`;
}

/**
 * Имя файла роли — «плоское» (без путей и `..`): файл пишется в
 * `{dataDir}/context/roles/`, и имя с путём ушло бы за пределы каталога.
 */
function isSafeRoleFileName(name: string): boolean {
  if (!name || name === '.' || name === '..') return false;
  if (name.includes('..') || name.includes('/') || name.includes('\\')) return false;
  return true;
}

/** Тело запроса установки (сырое). */
interface PackInstallBody {
  manifest?: unknown;
  files?: Record<string, unknown>;
}

/**
 * Разбор тела установки: манифест (сырой объект) + карта файлов.
 * Неизвестные/нестроковые файлы отбрасываются (в лог не попадают).
 */
function readInstallBody(body: unknown): { manifest: unknown; files: Record<string, string> } {
  const raw = (typeof body === 'object' && body !== null && !Array.isArray(body)
    ? body
    : {}) as PackInstallBody;
  const manifest = raw.manifest;
  const files: Record<string, string> = {};
  if (typeof raw.files === 'object' && raw.files !== null && !Array.isArray(raw.files)) {
    for (const [path, content] of Object.entries(raw.files)) {
      if (typeof content !== 'string') continue;
      files[normalizePackPath(path)] = content;
    }
  }
  return { manifest, files };
}

/**
 * Сырые (не схемой обрезанные) вклады пакета — нужны для полей, которых нет в
 * контракте манифеста (`provides.agents[].contextFile`, `provides.mcp[].command`).
 * Отсутствие — не ошибка (схема обязательных полей не требует).
 */
function rawProvides(manifest: unknown): Record<string, unknown> {
  if (typeof manifest !== 'object' || manifest === null || Array.isArray(manifest)) return {};
  const provides = (manifest as { provides?: unknown }).provides;
  if (typeof provides !== 'object' || provides === null || Array.isArray(provides)) return {};
  return provides as Record<string, unknown>;
}

/**
 * Массив объектов из сырого поля `provides`.
 *
 * Legacy-форма (`provides.mcp` — одиночный объект, как у уже выпущенных
 * манифестов `synth-media`/`synth-gateway-telegram`) разворачивается в массив
 * — так же, как это делает `normalizePackProvides` в shared.
 */
function rawList(provides: Record<string, unknown>, key: string): Record<string, unknown>[] {
  const value = provides[key];
  if (Array.isArray(value)) {
    return value.filter(
      (item): item is Record<string, unknown> =>
        typeof item === 'object' && item !== null && !Array.isArray(item),
    );
  }
  if (typeof value === 'object' && value !== null) {
    return [value as Record<string, unknown>];
  }
  return [];
}

/**
 * Подготовленный пакет: нормализованный манифест + сырые вклады.
 *
 * Нормализованный манифест — результат `packManifestSchema` (legacy-форма
 * `provides.mcp` уже развёрнута в массив, списки дополнены дефолтами).
 * Сырые вклады нужны для полей, которых нет в контракте манифеста
 * (`provides.agents[].contextFile`, `provides.mcp[].command`) — они
 * сопоставляются с нормализованными по индексу.
 */
interface PreparedPack {
  /** Нормализованный манифест (после zod-парсинга). */
  manifest: PackManifest;
  /** Сырые вклады `agents`/`mcp` (по индексу). */
  raw: { agents: Record<string, unknown>[]; mcp: Record<string, unknown>[] };
}

/**
 * Нормализация манифеста пакета. `null` — манифест не проходит схему
 * (проблемы уже перечислены вызывающей стороной).
 */
function preparePack(raw: unknown): PreparedPack | null {
  const parsed = packManifestSchema.safeParse(raw);
  if (!parsed.success) return null;
  const provides = rawProvides(raw);
  return {
    manifest: parsed.data as PackManifest,
    raw: {
      agents: rawList(provides, 'agents'),
      mcp: rawList(provides, 'mcp'),
    },
  };
}

/** Конфиг MCP-сервера из вклада пакета (`null` — запись невозможна). */
function buildMcpConfig(
  provide: PackMcpProvide,
  raw: Record<string, unknown> | undefined,
): { config: McpServerConfig } | { problem: string } {
  if (provide.transport === 'http') {
    const url = provide.url
      ?? (provide.port
        ? `http://127.0.0.1:${provide.port}${provide.path ?? ''}`
        : undefined);
    if (!url) {
      return { problem: `MCP «${provide.name}»: не задан url/port — запись пропущена` };
    }
    return {
      config: {
        type: 'http',
        url,
        ...(provide.description ? { description: provide.description } : {}),
        ...(provide.headers && Object.keys(provide.headers).length > 0
          ? { headers: provide.headers }
          : {}),
      },
    };
  }
  // stdio: команда в контракте манифеста отсутствует — берём из сырого вклада.
  const command = raw && typeof raw.command === 'string' ? raw.command : undefined;
  if (!command) {
    return {
      problem: `MCP «${provide.name}»: stdio-сервер без команды — запись пропущена`,
    };
  }
  const args = raw && Array.isArray(raw.args)
    ? raw.args.filter((a): a is string => typeof a === 'string')
    : undefined;
  const env = raw && typeof raw.env === 'object' && raw.env !== null && !Array.isArray(raw.env)
    ? Object.fromEntries(
        Object.entries(raw.env as Record<string, unknown>).filter(
          (entry): entry is [string, string] => typeof entry[1] === 'string',
        ),
      )
    : undefined;
  return {
    config: {
      type: 'stdio',
      command,
      ...(args && args.length > 0 ? { args } : {}),
      ...(env && Object.keys(env).length > 0 ? { env } : {}),
      ...(provide.description ? { description: provide.description } : {}),
    },
  };
}

/**
 * Определение пайплайна без служебных timestamps (то, что кладём в порт;
 * `createdAt`/`updatedAt` проставляются при сохранении).
 */
type PipelineDefinitionInput = Omit<PipelineDefinitionRecord, 'createdAt' | 'updatedAt'>;

/**
 * Определение пайплайна из вклада пакета: inline `definition` либо файл `path`.
 *
 * Файл — JSON или YAML. YAML разбирается **общим** frontmatter-парсером
 * (`parseFrontmatter` в shared, внутри — js-yaml): новой зависимости в core
 * нет (ADR-046 §7.3 — тот же приём у bundles).
 */
function resolvePipelineDefinition(
  provide: PackPipelineProvide,
  files: Record<string, string>,
): { definition: PipelineDefinitionInput } | { problem: string } {
  if (provide.definition) {
    return { definition: provide.definition as PipelineDefinitionInput };
  }
  if (!provide.path) {
    return { problem: `Пайплайн «${provide.id}»: не задан definition/path` };
  }
  const raw = files[normalizePackPath(provide.path)];
  if (raw === undefined) {
    return { problem: `Пайплайн «${provide.id}»: файл «${provide.path}» не найден в пакете` };
  }
  const parsed = parsePipelineFile(raw);
  if ('problem' in parsed) {
    return { problem: `Пайплайн «${provide.id}»: ${parsed.problem}` };
  }
  return { definition: parsed.definition };
}

/** Разбор файла определения пайплайна (JSON или YAML). */
function parsePipelineFile(
  raw: string,
): { definition: PipelineDefinitionInput } | { problem: string } {
  const trimmed = raw.trim();
  let data: unknown;
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      data = JSON.parse(trimmed);
    } catch (err) {
      return { problem: `некорректный JSON (${err instanceof Error ? err.message : String(err)})` };
    }
  } else {
    // YAML: общий frontmatter-парсер shared (js-yaml внутри) — новая зависимость
    // в core не появляется. Невалидный YAML → issues, а не исключение.
    const wrapped = trimmed.startsWith('---') ? raw : `---\n${raw}\n---\n`;
    const fm = parseFrontmatter(wrapped);
    if (fm.issues.length > 0) {
      return { problem: `некорректный YAML (${fm.issues[0]?.message ?? 'ошибка разбора'})` };
    }
    data = fm.data;
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return { problem: 'определение пайплайна — не объект' };
  }
  // Контракт определения — общий (`pipelineDefinitionSchema`, ADR-051/ADR-100).
  const parsed = pipelineDefinitionSchema.safeParse(data);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const path = first?.path.join('.') ?? '';
    return {
      problem: `некорректное определение пайплайна${path ? ` (${path})` : ''}: ${first?.message ?? 'ошибка валидации'}`,
    };
  }
  return { definition: parsed.data as PipelineDefinitionInput };
}

export function createPacksRoutes(
  auth: PacksRoutesAuth,
  deps: PacksRoutesDeps,
  opts: PacksRoutesOptions = {},
): Hono {
  const app = new Hono();
  const messages: PacksRouteMessages = { ...DEFAULT_MESSAGES, ...opts.messages };
  const readGuard: Middleware = opts.readGuard ?? auth.requireAuth;
  const writeGuard: Middleware = opts.writeGuard ?? auth.requireAuth;
  const approveGuard: Middleware = opts.approveGuard ?? auth.requireAuth;
  const uninstallGuard: Middleware = opts.uninstallGuard ?? auth.requireAuth;
  // ADR-052: scope-гейт service-key (установщик пакета).
  const scoped = opts.scopeGuard ?? requireScopeOrAdminRole;

  /** Результат фактической установки (идемпотентный upsert). */
  interface InstallOutcome {
    provides: PackInstallationProvides;
    problems: string[];
  }

  /** Установка скиллов пакета (ADR-046 §4/§9). */
  async function installSkills(
    prepared: PreparedPack,
    files: Record<string, string>,
    problems: string[],
  ): Promise<string[]> {
    const manifest = prepared.manifest;
    const installed: string[] = [];
    for (const skill of manifest.provides.skills) {
      const dir = normalizePackPath(skill.path);
      const rawSkill = files[`${dir}/SKILL.md`];
      if (rawSkill === undefined) {
        problems.push(`Скилл «${skill.name}»: файл «${dir}/SKILL.md» не найден в пакете`);
        continue;
      }
      const fm = parseFrontmatter(rawSkill);
      const description =
        typeof fm.data.description === 'string' && fm.data.description.trim().length > 0
          ? fm.data.description.trim()
          : manifest.description || `Скилл ${skill.name}`;
      // supporting-файлы — всё под каталогом скилла, кроме `SKILL.md`.
      const supporting: Record<string, string> = {};
      const prefix = `${dir}/`;
      for (const [path, content] of Object.entries(files)) {
        if (!path.startsWith(prefix)) continue;
        const rel = path.slice(prefix.length);
        if (!rel || rel === 'SKILL.md') continue;
        supporting[rel] = content;
      }

      const exists = await deps.skills.instanceExists(skill.name);
      if (!exists) {
        await deps.skills.createInstance({
          name: skill.name,
          description,
          body: fm.body,
          files: supporting,
        });
      } else {
        await deps.skills.updateInstance(skill.name, { description, body: fm.body });
        for (const [rel, content] of Object.entries(supporting)) {
          await deps.skills.writeInstanceFile(skill.name, rel, content);
        }
      }
      // `metadata.synth.*` задаётся через updateInstance: при create frontmatter
      // пересобирается из name+description (ADR-046 §3.1).
      if (skill.metadata && Object.keys(skill.metadata).length > 0) {
        await deps.skills.updateInstance(skill.name, {
          metadata: skill.metadata as Record<string, unknown>,
        });
      }
      installed.push(skill.name);
    }
    return installed;
  }

  /** Установка MCP-серверов пакета (ADR-071 §2.5). */
  async function installMcp(
    prepared: PreparedPack,
    problems: string[],
  ): Promise<string[]> {
    const manifest = prepared.manifest;
    const installed: string[] = [];
    const rawMcp = prepared.raw.mcp;
    for (const [index, provide] of manifest.provides.mcp.entries()) {
      const raw = rawMcp[index];
      const built = buildMcpConfig(provide, raw);
      if ('problem' in built) {
        problems.push(built.problem);
        continue;
      }
      // `enabledByDefault: true` — иначе сервер не попадёт в дефолты новых
      // сессий (ADR-071 §2.4, `toDefaultServers`).
      const config = { ...built.config, enabledByDefault: true };
      const existing = await deps.mcpRegistry.getByName(provide.name);
      if (existing) {
        await deps.mcpRegistry.update(existing.id, {
          config,
          origin: 'instance',
          enabled: true,
          enabledByDefault: true,
        });
      } else {
        await deps.mcpRegistry.add({
          name: provide.name,
          config,
          origin: 'instance',
          enabled: true,
          enabledByDefault: true,
        });
      }
      installed.push(provide.name);
    }
    return installed;
  }

  /**
   * Установка агентов пакета: **роль сначала, потом агент** (fail-closed).
   * Роль — `{dataDir}/context/roles/<contextFile>` (ADR-046/ADR-089).
   */
  async function installAgents(
    prepared: PreparedPack,
    files: Record<string, string>,
    problems: string[],
  ): Promise<string[]> {
    const manifest = prepared.manifest;
    const installed: string[] = [];
    const rawAgents = prepared.raw.agents;
    for (const [index, agent] of manifest.provides.agents.entries()) {
      const raw = rawAgents[index];
      const rawContextFile =
        raw && typeof raw.contextFile === 'string' ? raw.contextFile : undefined;
      const contextFile = roleFileName(agent.id, rawContextFile);
      if (!isSafeRoleFileName(contextFile)) {
        problems.push(`Агент «${agent.id}»: недопустимое имя файла роли «${contextFile}»`);
        continue;
      }

      // Роль: inline `content` либо файл пакета.
      let role: string | undefined;
      if (agent.rolePrompt?.content !== undefined) {
        role = agent.rolePrompt.content;
      } else if (agent.rolePrompt?.path) {
        const raw2 = files[normalizePackPath(agent.rolePrompt.path)];
        if (raw2 === undefined) {
          problems.push(
            `Агент «${agent.id}»: файл роли «${agent.rolePrompt.path}» не найден в пакете`,
          );
          continue;
        }
        role = raw2;
      }
      if (role !== undefined) {
        if (!deps.roleFiles) {
          problems.push(
            `Агент «${agent.id}»: порт файлов ролей не подключён — агент пропущен`,
          );
          continue;
        }
        const saved = await deps.roleFiles.saveFile(contextFile, role, 'role');
        if (!saved) {
          problems.push(`Агент «${agent.id}»: не удалось записать роль «${contextFile}»`);
          continue;
        }
      }

      const definition: AgentDefinition = {
        id: agent.id,
        displayName: agent.displayName || agent.id,
        capabilities: (agent.capabilities ?? []) as ToolCapability[],
        enabled: true,
        contextFile,
        ...(agent.description ? { description: agent.description } : {}),
        ...(agent.agentMode ? { agentMode: agent.agentMode } : {}),
        ...(agent.icon ? { icon: agent.icon } : {}),
        ...(agent.color ? { color: agent.color } : {}),
        ...(agent.provider ? { provider: agent.provider } : {}),
        ...(agent.model ? { model: agent.model } : {}),
        ...(agent.groups && agent.groups.length > 0 ? { groups: agent.groups } : {}),
        ...(agent.maxSteps !== undefined ? { maxSteps: agent.maxSteps } : {}),
        isOverridden: true,
      };
      await deps.agents.save(agent.id, definition);
      deps.registerAgent?.(definition);
      installed.push(agent.id);
    }
    return installed;
  }

  /**
   * Установка пайплайнов пакета + порождаемых правил маршрутизации (ADR-089).
   *
   * Правило для шага с `waitsFor`: `match` = условие ожидания, `target` —
   * ephemeral-цель с агентом шага и ссылкой на пайплайн (`pipeline: {id, step}`).
   * Id правила стабильный → повторная установка обновляет правило, а не плодит.
   */
  async function installPipelines(
    prepared: PreparedPack,
    files: Record<string, string>,
    problems: string[],
  ): Promise<string[]> {
    const manifest = prepared.manifest;
    const installed: string[] = [];
    for (const provide of manifest.provides.pipelines) {
      const resolved = resolvePipelineDefinition(provide, files);
      if ('problem' in resolved) {
        problems.push(resolved.problem);
        continue;
      }
      const definition = resolved.definition;
      if (definition.id !== provide.id) {
        problems.push(
          `Пайплайн «${provide.id}»: id в определении (${definition.id}) не совпадает с манифестом`,
        );
      }
      const now = nowISO();
      const record: PipelineDefinitionRecord = {
        ...definition,
        installedBy: { pack: manifest.name, version: manifest.version },
        createdAt: now,
        updatedAt: now,
      };
      await deps.pipelines.saveDefinition(record);
      installed.push(record.id);

      // Правила маршрутизации — по шагам с `waitsFor`.
      for (const step of record.steps) {
        if (!step.waitsFor) continue;
        const source = step.waitsFor.source;
        const type = step.waitsFor.type;
        if (!source && !type) {
          problems.push(
            `Пайплайн «${record.id}», шаг «${step.id}»: пустое условие waitsFor — правило не создано`,
          );
          continue;
        }
        if (!step.agent) {
          problems.push(
            `Пайплайн «${record.id}», шаг «${step.id}»: нет агента — правило маршрутизации не создано`,
          );
          continue;
        }
        await deps.routes.upsert({
          id: packRuleId(manifest.name, record.id, step.id),
          name: `${packRuleNamePrefix(manifest.name)}${record.id}:${step.id}`,
          priority: 0,
          enabled: true,
          match: {
            ...(source ? { source } : {}),
            ...(type ? { type } : {}),
          },
          target: {
            mode: 'ephemeral',
            agentTemplate: step.agent,
            pipeline: { id: record.id, step: step.id },
          },
        });
      }
    }
    return installed;
  }

  /** Фактическая установка пакета (идемпотентный upsert по каждому вкладу). */
  async function performInstall(
    prepared: PreparedPack,
    files: Record<string, string>,
  ): Promise<InstallOutcome> {
    const problems: string[] = [];
    const skills = await installSkills(prepared, files, problems);
    const mcp = await installMcp(prepared, problems);
    const agents = await installAgents(prepared, files, problems);
    const pipelines = await installPipelines(prepared, files, problems);
    return { provides: { agents, skills, mcp, pipelines }, problems };
  }

  /**
   * Требуется ли подтверждение администратора (capability-гранты).
   *
   * Да, если пакет:
   * - выдаёт агенту непустые `capabilities` (группы инструментов);
   * - объявляет пайплайны (порождаемые правила маршрутизации — ADR-089);
   * - объявляет расписания (пакет может принести `provides.schedules`);
   * - приносит **контент полномочий** (`provides.authority`: роли/действия/
   *   цели/агенты) — ADR-106 Ф5: пакет с ролями идёт на одобрение ADMIN, и
   *   администратор видит **сводку** ролей/действий/целей, а не только факт
   *   «есть capabilities».
   */
  function needsApproval(prepared: PreparedPack): boolean {
    const manifest = prepared.manifest;
    const grantsCapabilities = manifest.provides.agents.some(
      (agent) => (agent.capabilities ?? []).length > 0,
    );
    const declaresPipelines = manifest.provides.pipelines.length > 0;
    const schedules = manifest.provides.schedules;
    const declaresSchedules = Array.isArray(schedules) && schedules.length > 0;
    const declaresAuthority = authoritySummaryOf(manifest.provides) !== undefined;
    return grantsCapabilities || declaresPipelines || declaresSchedules || declaresAuthority;
  }

  /**
   * Проверка манифеста: структура (zod) + целостность (`validatePackManifest`).
   * Возвращает список проблем (пустой — манифест корректен).
   */
  function manifestProblems(raw: unknown): string[] {
    const problems: string[] = [];
    const parsed = packManifestSchema.safeParse(raw);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        const path = issue.path.join('.');
        problems.push(path ? `${path}: ${issue.message}` : issue.message);
      }
    }
    problems.push(...validatePackManifest(raw));
    return problems;
  }

  /**
   * Проверка наличия файлов пакета, на которые ссылается манифест.
   * Отсутствующий файл — ошибка установки (400), а не «молчаливый пропуск».
   */
  function missingFiles(manifest: PackManifest, files: Record<string, string>): string[] {
    const missing: string[] = [];
    for (const agent of manifest.provides.agents) {
      const path = agent.rolePrompt?.path;
      if (path && files[normalizePackPath(path)] === undefined) {
        missing.push(`agents[${agent.id}].rolePrompt.path: ${path}`);
      }
    }
    for (const pipeline of manifest.provides.pipelines) {
      const path = pipeline.path;
      if (path && files[normalizePackPath(path)] === undefined) {
        missing.push(`pipelines[${pipeline.id}].path: ${path}`);
      }
    }
    for (const skill of manifest.provides.skills) {
      const path = `${normalizePackPath(skill.path)}/SKILL.md`;
      if (files[path] === undefined) {
        missing.push(`skills[${skill.name}]: ${path}`);
      }
    }
    return missing;
  }

  // GET /api/v2/packs — реестр установок пакетов.
  app.get('/', readGuard, async (c) => {
    const packs = await deps.packs.list();
    return c.json({
      packs: packs.map((pack) => {
        // ADR-106 Ф5: сводка контента полномочий пакета (роли/действия/цели).
        const authority = authoritySummaryOf(rawProvides(pack.manifest));
        return {
          name: pack.name,
          version: pack.version,
          kind: pack.kind,
          ...(pack.packType ? { packType: pack.packType } : {}),
          ...(pack.description ? { description: pack.description } : {}),
          status: pack.status,
          requiresApproval: pack.requiresApproval,
          provides: pack.provides,
          ...(authority ? { authority } : {}),
          installedAt: pack.installedAt,
          updatedAt: pack.updatedAt,
          ...(pack.installedBy ? { installedBy: pack.installedBy } : {}),
        };
      }),
    });
  });

  // GET /api/v2/packs/:name — одна установка.
  app.get('/:name', readGuard, async (c) => {
    const pack = await deps.packs.get(c.req.param('name'));
    if (!pack) {
      return c.json({ error: { code: 'NOT_FOUND', message: messages.packNotFound(c) } }, 404);
    }
    // ADR-106 Ф5: в деталях видно, какие роли/действия/цели приносит пакет.
    const authority = authoritySummaryOf(rawProvides(pack.manifest));
    return c.json(authority ? { ...pack, authority } : pack);
  });

  // POST /api/v2/packs — установка пакета расширения.
  app.post('/', writeGuard, scoped('automation:install'), async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const { manifest: rawManifest, files } = readInstallBody(body);

    const problems = manifestProblems(rawManifest);
    if (problems.length > 0) {
      return c.json(
        {
          error: {
            code: 'VALIDATION_ERROR',
            message: messages.invalidManifest(c),
            problems,
          },
        },
        400,
      );
    }
    const prepared = preparePack(rawManifest);
    if (!prepared) {
      return c.json(
        { error: { code: 'VALIDATION_ERROR', message: messages.invalidManifest(c) } },
        400,
      );
    }
    const manifest = prepared.manifest;

    const missing = missingFiles(manifest, files);
    if (missing.length > 0) {
      return c.json(
        {
          error: {
            code: 'VALIDATION_ERROR',
            message: messages.missingFile(c),
            problems: missing,
          },
        },
        400,
      );
    }

    const requiresApproval = needsApproval(prepared);
    const now = nowISO();
    const userId = deps.resolveUserId?.(c);

    if (requiresApproval) {
      // Фактическая установка НЕ выполняется — только запись в реестре.
      // В реестре хранится **сырой** манифест (порядок полей/legacy-форма
      // `provides.mcp` сохраняется) + файлы — их хватит для одобрения.
      const planned = planProvides(manifest);
      const record: PackInstallation = {
        name: manifest.name,
        version: manifest.version,
        kind: manifest.kind,
        ...(manifest.packType ? { packType: manifest.packType } : {}),
        ...(manifest.description ? { description: manifest.description } : {}),
        status: 'pending_approval',
        requiresApproval: true,
        provides: planned,
        manifest: rawManifest,
        files,
        installedAt: now,
        updatedAt: now,
        ...(userId ? { installedBy: userId } : {}),
      };
      await deps.packs.save(record);
      info('PACKS', `Пакет ${manifest.name}@${manifest.version} ожидает подтверждения`);
      const authority = authoritySummaryOf(manifest.provides);
      return c.json(
        {
          installed: false,
          requiresApproval: true,
          name: manifest.name,
          version: manifest.version,
          provides: planned,
          ...(authority ? { authority } : {}),
        } satisfies PackInstallResult,
        202,
      );
    }

    const outcome = await performInstall(prepared, files);
    const record: PackInstallation = {
      name: manifest.name,
      version: manifest.version,
      kind: manifest.kind,
      ...(manifest.packType ? { packType: manifest.packType } : {}),
      ...(manifest.description ? { description: manifest.description } : {}),
      status: 'active',
      requiresApproval: false,
      provides: outcome.provides,
      manifest: rawManifest,
      files,
      installedAt: now,
      updatedAt: now,
      ...(userId ? { installedBy: userId } : {}),
    };
    await deps.packs.save(record);
    info(
      'PACKS',
      `Пакет ${manifest.name}@${manifest.version} установлен: скиллы=${outcome.provides.skills.length}, ` +
        `mcp=${outcome.provides.mcp.length}, агенты=${outcome.provides.agents.length}, ` +
        `пайплайны=${outcome.provides.pipelines.length}`,
    );
    const authority = authoritySummaryOf(manifest.provides);
    return c.json(
      {
        installed: true,
        requiresApproval: false,
        name: manifest.name,
        version: manifest.version,
        provides: outcome.provides,
        ...(authority ? { authority } : {}),
        ...(outcome.problems.length > 0 ? { problems: outcome.problems } : {}),
      } satisfies PackInstallResult,
      201,
    );
  });

  // POST /api/v2/packs/:name/approve — одобрение пакета (только ADMIN).
  app.post('/:name/approve', approveGuard, async (c) => {
    const name = c.req.param('name');
    const record = await deps.packs.get(name);
    if (!record) {
      return c.json({ error: { code: 'NOT_FOUND', message: messages.packNotFound(c) } }, 404);
    }
    if (record.status !== 'pending_approval') {
      return c.json({ error: { code: 'CONFLICT', message: messages.packNotPending(c) } }, 409);
    }

    // Манифест в реестре хранится **сырым** (как пришёл) — нормализуем его
    // тем же preparePack, что и при установке, иначе approve установил бы
    // пакет по другой схеме, чем его ставил POST.
    const prepared = preparePack(record.manifest);
    if (!prepared) {
      return c.json({ error: { code: 'NOT_FOUND', message: messages.packNotFound(c) } }, 404);
    }
    const files = record.files ?? {};
    const outcome = await performInstall(prepared, files);
    const now = nowISO();
    await deps.packs.save({
      ...record,
      status: 'active',
      requiresApproval: false,
      provides: outcome.provides,
      updatedAt: now,
    });
    info('PACKS', `Пакет ${name} одобрен и установлен`);
    const authority = authoritySummaryOf(rawProvides(record.manifest));
    return c.json(
      {
        installed: true,
        requiresApproval: false,
        name: record.name,
        version: record.version,
        provides: outcome.provides,
        ...(authority ? { authority } : {}),
        ...(outcome.problems.length > 0 ? { problems: outcome.problems } : {}),
      } satisfies PackInstallResult,
    );
  });

  // DELETE /api/v2/packs/:name — снятие установки (только ADMIN).
  // Идемпотентно: отсутствующие артефакты — не ошибка.
  app.delete('/:name', uninstallGuard, async (c) => {
    const name = c.req.param('name');
    const record = await deps.packs.get(name);
    if (!record) {
      // Пакета нет — снятие уже выполнено (идемпотентно).
      return c.body(null, 204);
    }

    // Сырой манифест (как в реестре) — из него читаются поля, которых нет в
    // нормализованном контракте (contextFile агента, command MCP-сервера).
    const manifest = record.manifest;
    const provides = record.provides;

    // Агенты (+ роли).
    for (const agentId of provides.agents) {
      await deps.agents.delete(agentId).catch(() => undefined);
      deps.unregisterAgent?.(agentId);
      const contextFile = manifest
        ? roleFileName(
            agentId,
            rawList(rawProvides(manifest), 'agents').find(
              (a) => a.id === agentId && typeof a.contextFile === 'string',
            )?.contextFile as string | undefined,
          )
        : roleFileName(agentId);
      await deps.roleFiles?.deleteFile(contextFile, 'role').catch(() => undefined);
    }
    // Скиллы.
    for (const skill of provides.skills) {
      await deps.skills.removeInstance(skill).catch(() => undefined);
    }
    // MCP-серверы.
    for (const mcp of provides.mcp) {
      const entry = await deps.mcpRegistry.getByName(mcp).catch(() => null);
      if (entry) await deps.mcpRegistry.remove(entry.id).catch(() => undefined);
    }
    // Пайплайны.
    for (const pipeline of provides.pipelines) {
      await deps.pipelines.deleteDefinition(pipeline).catch(() => undefined);
    }
    // Правила маршрутизации, порождённые пакетом (по стабильному префиксу имени).
    const prefix = packRuleNamePrefix(name);
    const rules = await deps.routes.list().catch(() => []);
    for (const rule of rules) {
      if (rule.name?.startsWith(prefix)) {
        await deps.routes.remove(rule.id).catch(() => undefined);
      }
    }

    await deps.packs.delete(name);
    info('PACKS', `Пакет ${name} снят`);
    return c.body(null, 204);
  });

  return app;
}

/**
 * Сводка контента полномочий пакета (`provides.authority`, ADR-106 Ф5).
 *
 * `undefined` — пакет полномочий **не** приносит (в ответе поля нет, чтобы не
 * шуметь в списке установок). Иначе — данные (роли/действия/цели/агенты и
 * итоги), из которых видно, **что именно** пакет добавит в политику инстанса.
 */
function authoritySummaryOf(provides: unknown): PackAuthoritySummary | undefined {
  const summary = summarizePackAuthority(provides);
  const totals = summary.totals;
  if (totals.roles === 0 && totals.actions === 0 && totals.targets === 0 && totals.agents === 0) {
    return undefined;
  }
  return summary;
}

/**
 * Планируемые вклады пакета (для записи `pending_approval`): что пакет
 * поставит после одобрения. Фактические id установленных сущностей
 * фиксируются при фактической установке.
 */
function planProvides(manifest: PackManifest): PackInstallationProvides {
  return {
    agents: manifest.provides.agents.map((agent: PackAgentProvide) => agent.id),
    skills: manifest.provides.skills.map((skill: PackSkillProvide) => skill.name),
    mcp: manifest.provides.mcp.map((mcp: PackMcpProvide) => mcp.name),
    pipelines: manifest.provides.pipelines.map((p: PackPipelineProvide) => p.id),
  };
}
