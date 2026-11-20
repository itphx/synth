/**
 * Перепись публикаций: «мутация видна другому клиенту ⇒ есть событие»
 * (инвариант 27 корневого `AGENTS.md`).
 *
 * ## Зачем
 *
 * Инвариант 27 держится на памяти: каждый write-путь реестра инстанса
 * (агенты, MCP, скиллы, пайплайны, провайдеры/модели) обязан после успешной
 * записи опубликовать своё событие в шину, иначе второй клиент видит устаревший
 * состав до перезагрузки страницы. Так было потеряно пять реестров подряд:
 * событие публиковал тул, но не HTTP-роут (или наоборот), либо молчал один из
 * нескольких путей одной фабрики.
 *
 * ## Что проверяем (статически, по исходникам)
 *
 * 1. **Перепись write-путей.** Из исходников собираются все write-обработчики
 *    (`app.post|put|patch|delete`) и все встроенные тулы (`ToolDefinition`)
 *    объявленных модулей. Каждый обязан быть в реестре `WRITE_PATHS` (публикует
 *    событие) либо в `OUT_OF_SCOPE_WRITE_PATHS` (с обоснованием, почему мутации
 *    реестра нет). Новый write-путь без записи роняет тест с diff'ом; запись без
 *    пути — тоже (перепись не гниёт).
 * 2. **Публикация — вызовом, а не импортом.** В теле обработчика должен быть
 *    вызов хука фабрики (`onAgentsChanged?.`, `onMcpChanged?.`, …) или помощника
 *    публикации (`notifyPipelineChanged(`). Транзитивная публикация через
 *    локальный хелпер (`upsertAgent`) объявляется явно и проверяется отдельно:
 *    тело хелпера обязано содержать вызов публикатора — иначе `via` превратится
 *    в фикцию.
 * 3. **Файлы контура.** Любой файл `packages/core/src`, ссылающийся на
 *    публикатор/хук ресурса, обязан быть либо файлом контура (есть в переписи),
 *    либо объявленной инфраструктурой (модуль события, точка сборки,
 *    реэкспорт): новый модуль мутации не может «появиться тихо».
 * 4. **Точки сборки.** `mount-routes` (core standalone и managed backend)
 *    обязаны прокидывать хук публикации в фабрики: без проводки роуты молчат
 *    даже при правильных вызовах (`onAgentsChanged` не задан → no-op).
 *
 * Проверяется именно **вызов** публикации в функции-обработчике: регулярки
 * требуют `?.`/`(`, поэтому импорт или упоминание в комментарии не проходят.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Корень репозитория (`<repo>/synth`): тест лежит в `packages/core/src/events`. */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
/** Корень исходников core. */
const CORE_SRC = join(REPO_ROOT, 'packages/core/src');

/** Каталоги, в которые не заходим. */
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'coverage', '.git', 'tmp', 'data']);

// ---------------------------------------------------------------------------
// Ресурсы: событие, публикаторы, маркеры вызова
// ---------------------------------------------------------------------------

/** Ресурс контура инварианта 27. */
type Resource = 'agents' | 'mcp' | 'skills' | 'models' | 'pipelines';

interface ResourceSpec {
  /** Тип события шины (инвариант 6: новых каналов не заводим). */
  readonly event: string;
  /** Идентификаторы публикатора/хука — по ним ищутся файлы контура. */
  readonly identifiers: readonly string[];
  /**
   * Маркеры **вызова** публикации в теле write-пути: хук фабрики
   * (`onAgentsChanged?.`) или помощник публикации (`publishAgentsUpdated(`).
   */
  readonly markers: readonly string[];
  /** Файлы определения события и реэкспорта (обязаны упоминать публикатор). */
  readonly infrastructure: readonly string[];
  /** Ожидаемая проводка в точке сборки: фрагмент + сколько раз встречается. */
  readonly wiring: { readonly snippet: string; readonly count: number };
}

const RESOURCES: Readonly<Record<Resource, ResourceSpec>> = {
  agents: {
    event: 'agents.updated',
    identifiers: ['publishAgentsUpdated', 'agentsChangedPublisher', 'AgentsChangedHook'],
    markers: ['onAgentsChanged?.', 'publishAgentsUpdated(', 'agentsChangedPublisher('],
    infrastructure: ['events/agents-events.ts', 'index.ts'],
    wiring: { snippet: 'agentsChangedPublisher(eventBus)', count: 1 },
  },
  mcp: {
    event: 'mcp.updated',
    identifiers: ['publishMcpUpdated', 'mcpChangedPublisher', 'McpChangedHook'],
    markers: ['onMcpChanged?.', 'publishMcpUpdated(', 'mcpChangedPublisher('],
    infrastructure: ['events/mcp-events.ts', 'index.ts'],
    wiring: { snippet: 'mcpChangedPublisher(eventBus)', count: 2 },
  },
  skills: {
    event: 'skills.updated',
    identifiers: ['publishSkillsUpdated', 'skillsChangedPublisher', 'SkillsChangedHook'],
    markers: ['onSkillsChanged?.', 'publishSkillsUpdated(', 'skillsChangedPublisher('],
    infrastructure: ['events/skills-events.ts', 'index.ts'],
    wiring: { snippet: 'skillsChangedPublisher(eventBus)', count: 5 },
  },
  models: {
    event: 'models.updated',
    identifiers: ['publishModelsUpdated', 'modelsChangedPublisher', 'ModelsChangedHook'],
    markers: ['onModelsChanged?.', 'publishModelsUpdated(', 'modelsChangedPublisher('],
    infrastructure: ['events/models-events.ts', 'index.ts'],
    wiring: { snippet: 'modelsChangedPublisher(eventBus)', count: 2 },
  },
  pipelines: {
    event: 'pipeline.updated',
    identifiers: ['publishPipelineUpdated', 'notifyPipelineChanged', 'PipelineUpdatedEventData'],
    markers: ['notifyPipelineChanged(', 'publishPipelineUpdated('],
    infrastructure: [
      'engine/pipelines/events.ts',
      'engine/pipelines/index.ts',
      'engine/tools/automation-helpers.ts',
      'index.ts',
    ],
    wiring: { snippet: 'events: { eventBus, sessionStore: sessionManager }', count: 1 },
  },
};

// ---------------------------------------------------------------------------
// Перепись write-путей
// ---------------------------------------------------------------------------

/** Write-путь, который обязан опубликовать событие своего ресурса. */
interface WritePath {
  /** Файл от `packages/core/src`. */
  readonly file: string;
  /** Ключ: `createAgentRoutes POST /` для роута, `tool synth_agent_save` для тула. */
  readonly key: string;
  readonly resource: Resource;
  /**
   * Хелпер-публикатор, через который публикует обработчик. Объявляется явно:
   * сам факт вызова проверяется отдельно (тело хелпера обязано содержать
   * публикатор).
   */
  readonly via?: readonly string[];
}

/** Write-путь вне контура переписи — с обоснованием. */
interface SkippedWritePath {
  readonly file: string;
  readonly key: string;
  readonly why: string;
}

/** Хелпер, публикующий событие за обработчика (проверяется по телу функции). */
interface PublishingHelper {
  /** Файл от `packages/core/src`. */
  readonly file: string;
  /** Имя функции (`upsertAgent`). */
  readonly fn: string;
  readonly resource: Resource;
}

const WRITE_PATHS: readonly WritePath[] = [
  // ── Агенты: `agents.updated` (инстансный канал) ─────────────────────────
  { file: 'server/routes/agents.ts', key: 'createAgentRoutes POST /', resource: 'agents' },
  { file: 'server/routes/agents.ts', key: 'createAgentRoutes DELETE /:id', resource: 'agents' },
  { file: 'server/routes/agents.ts', key: 'createAgentRoutes PATCH /:id/enabled', resource: 'agents' },
  { file: 'engine/tools/instance-agents.ts', key: 'tool synth_agent_save', resource: 'agents', via: ['upsertAgent'] },
  { file: 'engine/tools/instance-agents.ts', key: 'tool synth_agent_delete', resource: 'agents' },
  { file: 'engine/tools/instance-agents.ts', key: 'tool synth_agent_enable', resource: 'agents' },
  { file: 'engine/tools/instance-agents.ts', key: 'tool synth_agent_import', resource: 'agents', via: ['upsertAgent'] },

  // ── MCP: `mcp.updated` (инстансный канал) ───────────────────────────────
  { file: 'server/routes/mcp-registry.ts', key: 'createMcpRegistryRoutes POST /servers', resource: 'mcp' },
  { file: 'server/routes/mcp-registry.ts', key: 'createMcpRegistryRoutes PUT /servers/:name', resource: 'mcp' },
  { file: 'server/routes/mcp-registry.ts', key: 'createMcpRegistryRoutes DELETE /servers/:name', resource: 'mcp' },
  { file: 'server/routes/mcp-registry.ts', key: 'createMcpRegistryRoutes PUT /session/:sessionId', resource: 'mcp' },
  { file: 'server/routes/mcp-registry.ts', key: 'createMcpRegistryRoutes POST /registry', resource: 'mcp' },
  { file: 'server/routes/mcp-registry.ts', key: 'createMcpRegistryRoutes PUT /registry/:id', resource: 'mcp' },
  { file: 'server/routes/mcp-registry.ts', key: 'createMcpRegistryRoutes DELETE /registry/:id', resource: 'mcp' },
  // Проектный MCP-скоуп: мутация проекта → `project.updated` + `mcp.updated`
  // (`scope: 'project'`), панели MCP и вкладка проекта перечитывают состав.
  { file: 'server/routes/projects.ts', key: 'createProjectRoutes PUT /:id/mcp', resource: 'mcp' },
  { file: 'engine/tools/instance-mcp.ts', key: 'tool synth_mcp_add', resource: 'mcp' },
  { file: 'engine/tools/instance-mcp.ts', key: 'tool synth_mcp_update', resource: 'mcp' },
  { file: 'engine/tools/instance-mcp.ts', key: 'tool synth_mcp_remove', resource: 'mcp' },
  { file: 'engine/tools/instance-mcp.ts', key: 'tool synth_mcp_enable', resource: 'mcp' },

  // ── Скиллы: `skills.updated` (инстансный канал) ─────────────────────────
  { file: 'server/routes/skills.ts', key: 'createSkillRoutes POST /reload', resource: 'skills' },
  { file: 'server/routes/skills.ts', key: 'createSkillRoutes POST /', resource: 'skills' },
  { file: 'server/routes/skills.ts', key: 'createSkillRoutes PUT /:name/files/*', resource: 'skills' },
  { file: 'server/routes/skills.ts', key: 'createSkillRoutes DELETE /:name/files/*', resource: 'skills' },
  { file: 'server/routes/skills.ts', key: 'createSkillRoutes PATCH /:name', resource: 'skills' },
  { file: 'server/routes/skills.ts', key: 'createSkillRoutes DELETE /:name', resource: 'skills' },
  { file: 'server/routes/skill-bundles.ts', key: 'createSkillBundleRoutes POST /', resource: 'skills' },
  { file: 'server/routes/skill-bundles.ts', key: 'createSkillBundleRoutes PATCH /:name', resource: 'skills' },
  { file: 'server/routes/skill-bundles.ts', key: 'createSkillBundleRoutes DELETE /:name', resource: 'skills' },
  { file: 'server/routes/skill-scope.ts', key: 'createSessionSkillScopeRoutes PUT /:id/skills', resource: 'skills' },
  { file: 'server/routes/skill-scope.ts', key: 'createProjectSkillScopeRoutes PUT /:id/skills', resource: 'skills' },
  { file: 'server/routes/skill-scope.ts', key: 'createSkillSettingsRoutes PUT /skills', resource: 'skills' },
  { file: 'server/routes/skill-scope.ts', key: 'createSkillSettingsRoutes DELETE /skills', resource: 'skills' },

  // ── Провайдеры/модели: `models.updated` (инстансный канал) ──────────────
  { file: 'server/routes/providers.ts', key: 'createProviderRoutes POST /', resource: 'models' },
  { file: 'server/routes/providers.ts', key: 'createProviderRoutes PATCH /:name', resource: 'models' },
  { file: 'server/routes/providers.ts', key: 'createProviderRoutes DELETE /:name', resource: 'models' },
  { file: 'server/routes/models.ts', key: 'createModelRoutes POST /fetch', resource: 'models' },
  { file: 'server/routes/models.ts', key: 'createModelRoutes POST /', resource: 'models' },
  { file: 'server/routes/models.ts', key: 'createModelRoutes DELETE /:id', resource: 'models' },

  // ── Пайплайны: `pipeline.updated` (каналы сессий проекта) ──────────────
  { file: 'server/routes/pipeline-project-routes.ts', key: 'createPipelineProjectRoutes POST /projects/:id/pipelines', resource: 'pipelines' },
  { file: 'server/routes/pipeline-project-routes.ts', key: 'createPipelineProjectRoutes PUT /projects/:id/pipelines/:pid', resource: 'pipelines' },
  { file: 'server/routes/pipeline-project-routes.ts', key: 'createPipelineProjectRoutes DELETE /projects/:id/pipelines/:pid', resource: 'pipelines' },
  { file: 'server/routes/pipeline-project-routes.ts', key: 'createPipelineProjectRoutes POST /projects/:id/pipelines/:pid/publish', resource: 'pipelines' },
  { file: 'server/routes/pipeline-project-routes.ts', key: 'createPipelineProjectRoutes POST /pipeline-templates/:tid/instantiate', resource: 'pipelines' },
  { file: 'engine/tools/pipeline-authoring.ts', key: 'tool pipeline_save', resource: 'pipelines' },
  { file: 'engine/tools/pipeline-authoring.ts', key: 'tool pipeline_publish', resource: 'pipelines' },
  { file: 'engine/tools/pipeline-authoring.ts', key: 'tool pipeline_delete', resource: 'pipelines' },
  { file: 'engine/tools/pipeline-templates.ts', key: 'tool pipeline_instantiate', resource: 'pipelines' },
];

/**
 * Write-пути объявленных модулей, которые **не** мутируют реестр контура.
 *
 * Записи обязательны: перепись сверяется в обе стороны, поэтому такой путь
 * нельзя «пропустить молча» — только объявить с причиной.
 */
const OUT_OF_SCOPE_WRITE_PATHS: readonly SkippedWritePath[] = [
  // MCP: переподключение и проба — состав реестра не меняется.
  { file: 'server/routes/mcp-registry.ts', key: 'createMcpRegistryRoutes POST /servers/:name/reconnect', why: 'только переподключение: конфиг/состав реестра не меняются' },
  { file: 'server/routes/mcp-registry.ts', key: 'createMcpRegistryRoutes POST /servers/:name/test', why: 'проба соединения (POST по природе операции), записи нет' },
  { file: 'engine/tools/instance-mcp.ts', key: 'tool synth_mcp_reconnect', why: 'только переподключение: конфиг/состав реестра не меняются' },
  // Провайдеры: загрузка иконки и проба — записи нет.
  { file: 'server/routes/providers.ts', key: 'createProviderRoutes POST /fetch-icon', why: 'загрузка иконки провайдера, в каталог не пишет' },
  { file: 'server/routes/providers.ts', key: 'createProviderRoutes POST /:name/test', why: 'проба соединения (POST по природе операции), записи нет' },

  // Проекты: остальные мутации — свои события (`project.updated`,
  // `worktree.updated`), в контур MCP они не входят.
  { file: 'server/routes/projects.ts', key: 'createProjectRoutes POST /', why: 'контур `project.updated` (создание проекта)' },
  { file: 'server/routes/projects.ts', key: 'createProjectRoutes PUT /:id', why: 'контур `project.updated`' },
  { file: 'server/routes/projects.ts', key: 'createProjectRoutes POST /:id/transfer', why: 'контур `project.updated` (передача владения)' },
  { file: 'server/routes/projects.ts', key: 'createProjectRoutes DELETE /:id', why: 'контур `project.updated` (удаление)' },
  { file: 'server/routes/projects.ts', key: 'createProjectRoutes POST /:id/worktrees', why: 'контур `worktree.updated` (ADR-114)' },
  { file: 'server/routes/projects.ts', key: 'createProjectRoutes POST /:id/worktrees/prune', why: 'контур `worktree.updated` (ADR-114)' },
  { file: 'server/routes/projects.ts', key: 'createProjectRoutes DELETE /:id/worktrees/:wid', why: 'контур `worktree.updated` (ADR-114)' },

  // Пайплайны: прогоны — своё семейство событий (`pipeline.run.*`,
  // инстансный канал), авторство пайплайна не меняется.
  { file: 'server/routes/pipeline-project-routes.ts', key: 'createPipelineProjectRoutes POST /projects/:id/pipelines/:pid/runs', why: 'прогон → `pipeline.run.*`, не авторство' },
  { file: 'server/routes/pipeline-project-routes.ts', key: 'createPipelineProjectRoutes POST /pipeline-runs/:runId/resume', why: 'прогон → `pipeline.run.*`, не авторство' },
  { file: 'server/routes/pipeline-project-routes.ts', key: 'createPipelineProjectRoutes POST /pipeline-runs/:runId/cancel', why: 'прогон → `pipeline.run.*`, не авторство' },

  // Read-only пути, зарегистрированные ToolDefinition'ом (тул есть — записи нет).
  { file: 'engine/tools/instance-agents.ts', key: 'tool synth_agent_list', why: 'только чтение' },
  { file: 'engine/tools/instance-agents.ts', key: 'tool synth_agent_get', why: 'только чтение' },
  { file: 'engine/tools/pipeline-authoring.ts', key: 'tool pipeline_list', why: 'только чтение' },
  { file: 'engine/tools/pipeline-authoring.ts', key: 'tool pipeline_get', why: 'только чтение' },
  { file: 'engine/tools/pipeline-templates.ts', key: 'tool pipeline_templates', why: 'только чтение' },
];

const PUBLISHING_HELPERS: readonly PublishingHelper[] = [
  { file: 'engine/tools/instance-agents.ts', fn: 'upsertAgent', resource: 'agents' },
  { file: 'engine/tools/automation-helpers.ts', fn: 'notifyPipelineChanged', resource: 'pipelines' },
];

// ---------------------------------------------------------------------------
// Разбор исходников
// ---------------------------------------------------------------------------

/** Регистрация роута: `app.<method>('<path>'`. */
const ROUTE_RE = /app\.(get|post|put|patch|delete)\(\s*['"]([^'"]+)['"]/g;
/** Начало фабрики роутов (`export function createXxxRoutes`). */
const FACTORY_RE = /^export function (\w+)/gm;
/** Начало определения встроенного тула. */
const TOOL_RE = /^export const \w+: ToolDefinition = \{/gm;
/** Имя тула внутри его определения. */
const TOOL_NAME_RE = /^\s{2}name: '([^']+)'/m;
/** Write-методы HTTP (мутируют состояние). */
const WRITE_METHODS = new Set(['post', 'put', 'patch', 'delete']);

/** Кэш содержимого файлов: перепись читает одни и те же исходники несколько раз. */
const fileCache = new Map<string, string>();

/**
 * Исходник без комментариев (строки сохраняются — номера строк не съезжают).
 *
 * Без этого шага закомментированная публикация проходила бы проверку: маркер
 * находится в тексте комментария, а не в теле обработчика — ровно та тихая
 * дыра, ради которой тест написан.
 */
function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (chunk) => chunk.replace(/[^\n]/g, ''))
    .replace(/^[ \t]*\/\/.*$/gm, '');
}

function readCore(rel: string): string {
  const cached = fileCache.get(rel);
  if (cached !== undefined) return cached;
  const text = stripComments(readFileSync(join(CORE_SRC, rel), 'utf8'));
  fileCache.set(rel, text);
  return text;
}

/** Номер строки (1-based) по смещению. */
function lineOf(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i += 1) {
    if (text.charCodeAt(i) === 10) line += 1;
  }
  return line;
}

/** Размеченный участок исходника (тело обработчика/тула). */
interface Segment {
  /** Ключ write-пути: `createAgentRoutes POST /` или `tool synth_agent_save`. */
  readonly key: string;
  /** Тело участка. */
  readonly text: string;
  /** Строка начала. */
  readonly line: number;
}

/** Все write-обработчики файла (по регистрациям `app.<write>`). */
function routeSegments(file: string): Segment[] {
  const text = readCore(file);
  const marks: { index: number; method: string; path: string }[] = [];
  for (const match of text.matchAll(ROUTE_RE)) {
    const index = match.index ?? 0;
    marks.push({ index, method: (match[1] ?? '').toLowerCase(), path: match[2] ?? '' });
  }
  const factories: { index: number; name: string }[] = [];
  for (const match of text.matchAll(FACTORY_RE)) {
    factories.push({ index: match.index ?? 0, name: match[1] ?? '' });
  }
  const factoryAt = (index: number): string => {
    let name = '(вне фабрики)';
    for (const factory of factories) {
      if (factory.index <= index) name = factory.name;
      else break;
    }
    return name;
  };

  const result: Segment[] = [];
  for (let i = 0; i < marks.length; i += 1) {
    const mark = marks[i]!;
    if (!WRITE_METHODS.has(mark.method)) continue;
    const end = i + 1 < marks.length ? marks[i + 1]!.index : text.length;
    result.push({
      key: `${factoryAt(mark.index)} ${mark.method.toUpperCase()} ${mark.path}`,
      text: text.slice(mark.index, end),
      line: lineOf(text, mark.index),
    });
  }
  return result;
}

/** Все определения встроенных тулов файла. */
function toolSegments(file: string): Segment[] {
  const text = readCore(file);
  const marks: { index: number }[] = [];
  for (const match of text.matchAll(TOOL_RE)) marks.push({ index: match.index ?? 0 });
  const result: Segment[] = [];
  for (let i = 0; i < marks.length; i += 1) {
    const start = marks[i]!.index;
    const end = i + 1 < marks.length ? marks[i + 1]!.index : text.length;
    const body = text.slice(start, end);
    const name = TOOL_NAME_RE.exec(body)?.[1];
    if (!name) continue;
    result.push({ key: `tool ${name}`, text: body, line: lineOf(text, start) });
  }
  return result;
}

/** Все write-пути файла (роуты + тулы). */
function segmentsOf(file: string): Segment[] {
  return [...routeSegments(file), ...toolSegments(file)];
}

/**
 * Точки сборки: хук публикации прокидывается здесь, но самого публикатора файл
 * не называет (передаёт `deps`/хук в фабрику). Проверяются отдельным тестом
 * проводки, поэтому в «файлы контура» входят на равных.
 */
const WIRING_FILES: readonly string[] = ['server/app/mount-routes.ts'];

/** Объявленные файлы переписи (обе стороны сверки идут по ним). */
const DECLARED_FILES: readonly string[] = [
  ...new Set([
    ...WRITE_PATHS.map((entry) => entry.file),
    ...OUT_OF_SCOPE_WRITE_PATHS.map((entry) => entry.file),
  ]),
].sort();

/** Рекурсивный обход исходников core (без тестов и артефактов сборки). */
function listCoreSources(dir = CORE_SRC, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      listCoreSources(full, acc);
      continue;
    }
    if (!entry.name.endsWith('.ts')) continue;
    if (entry.name.endsWith('.test.ts')) continue;
    acc.push(relative(CORE_SRC, full).split('\\').join('/'));
  }
  return acc;
}

// ---------------------------------------------------------------------------
// Прогон
// ---------------------------------------------------------------------------

describe('перепись публикаций: мутация видна клиенту ⇒ есть событие', () => {
  it('каждый write-обработчик объявленных модулей записан в перепись', () => {
    const declared = new Set([
      ...WRITE_PATHS.map((entry) => `${entry.file} → ${entry.key}`),
      ...OUT_OF_SCOPE_WRITE_PATHS.map((entry) => `${entry.file} → ${entry.key}`),
    ]);
    const undeclared: string[] = [];
    for (const file of DECLARED_FILES) {
      for (const segment of segmentsOf(file)) {
        const key = `${file} → ${segment.key}`;
        if (!declared.has(key)) undeclared.push(`${key} (строка ${segment.line})`);
      }
    }
    // Новый write-путь обязан появиться здесь вместе с публикацией события.
    expect(undeclared, 'write-путь вне переписи публикаций').toEqual([]);
  });

  it('перепись не содержит мёртвых записей (путь всё ещё существует)', () => {
    const actual = new Set<string>();
    for (const file of DECLARED_FILES) {
      for (const segment of segmentsOf(file)) actual.add(`${file} → ${segment.key}`);
    }
    const declared = [
      ...WRITE_PATHS.map((entry) => `${entry.file} → ${entry.key}`),
      ...OUT_OF_SCOPE_WRITE_PATHS.map((entry) => `${entry.file} → ${entry.key}`),
    ];
    // Дубликаты в переписи скрывают расхождение — это тоже ошибка.
    expect(declared.length).toBe(new Set(declared).size);
    expect(declared.filter((key) => !actual.has(key)), 'запись переписи без write-пути').toEqual([]);
  });

  it('каждый write-путь контура публикует событие своего ресурса', () => {
    const silent: string[] = [];
    for (const entry of WRITE_PATHS) {
      const spec = RESOURCES[entry.resource];
      const segment = segmentsOf(entry.file).find((item) => item.key === entry.key);
      if (!segment) continue; // отсутствие пути ловит сверка переписи
      const markers = [
        ...spec.markers,
        ...(entry.via ?? []).map((fn) => `${fn}(`),
      ];
      const published = markers.some((marker) => segment.text.includes(marker));
      if (!published) {
        silent.push(
          `${entry.file}:${segment.line} ${entry.key} — нет вызова публикации `
          + `${spec.event} (ожидался один из: ${markers.join(', ')})`,
        );
      }
    }
    expect(silent, 'write-путь без публикации события (инвариант 27)').toEqual([]);
  });

  it('хелперы, объявленные как публикующие, действительно публикуют', () => {
    const fake: string[] = [];
    for (const helper of PUBLISHING_HELPERS) {
      const text = readCore(helper.file);
      const spec = RESOURCES[helper.resource];
      const declaration = text.match(new RegExp(`^(?:export )?(?:async )?function ${helper.fn}\\(`, 'm'));
      expect(declaration, `${helper.file}: не найдено объявление функции ${helper.fn}`).not.toBeNull();
      const start = declaration!.index ?? 0;
      // Тело top-level функции: до закрывающей скобки в нулевой колонке.
      const rest = text.slice(start);
      const endMatch = rest.match(/^\}$/m);
      const body = endMatch ? rest.slice(0, endMatch.index ?? rest.length) : rest;
      const publishers = spec.identifiers.filter((id) => id.startsWith('publish'));
      const publishes = publishers.some((id) => body.includes(`${id}(`));
      if (!publishes) {
        fake.push(
          `${helper.file}:${lineOf(text, start)} ${helper.fn} — объявлен публикующим `
          + `${spec.event}, но не вызывает ${publishers.join('/')}`,
        );
      }
    }
    expect(fake, 'хелпер-публикатор не публикует').toEqual([]);
  });

  it('файлы контура совпадают с переписью', () => {
    const sources = listCoreSources();
    const problems: string[] = [];
    for (const [resource, spec] of Object.entries(RESOURCES) as [Resource, ResourceSpec][]) {
      const contour = new Set(
        WRITE_PATHS.filter((entry) => entry.resource === resource).map((entry) => entry.file),
      );
      const allowed = new Set([...contour, ...spec.infrastructure, ...WIRING_FILES]);
      const hits = sources.filter((file) => {
        const text = readCore(file);
        return spec.identifiers.some((id) => text.includes(id));
      });
      for (const file of hits) {
        if (!allowed.has(file)) {
          problems.push(
            `${file} ссылается на публикатор/хук ${spec.event}, но не объявлен `
            + `(добавь файл в перепись write-путей или в infrastructure события)`,
          );
        }
      }
      for (const file of spec.infrastructure) {
        if (!hits.includes(file)) {
          problems.push(`${file} объявлен infrastructure ${spec.event}, но публикатор не упоминает`);
        }
      }
    }
    expect(problems, 'файл контура вне переписи').toEqual([]);
  });

  it('точки сборки прокидывают хук публикации в фабрики', () => {
    const mounts = [
      join(CORE_SRC, 'server/app/mount-routes.ts'),
      join(REPO_ROOT, 'packages/backend/src/app/mount-routes.ts'),
    ];
    const problems: string[] = [];
    for (const mount of mounts) {
      const text = readFileSync(mount, 'utf8');
      const rel = relative(REPO_ROOT, mount).split('\\').join('/');
      for (const spec of Object.values(RESOURCES)) {
        const actual = text.split(spec.wiring.snippet).length - 1;
        if (actual !== spec.wiring.count) {
          problems.push(
            `${rel}: «${spec.wiring.snippet}» встречается ${actual} раз(а), `
            + `в переписи ${spec.wiring.count} — новый/удалённый mount-пункт ${spec.event}`,
          );
        }
      }
    }
    expect(problems, 'проводка хука публикации в точке сборки').toEqual([]);
  });
});
