/**
 * ADR-101: авторские операции над пайплайнами проекта.
 *
 * Операции над **черновиком**, **публикацией версии** и **удалением** —
 * чистые функции над портом `ProjectPipelineRepository` (ADR-096), без HTTP и
 * без знания о сессиях/очереди.
 *
 * ## Зачем отдельный модуль
 *
 * Те же операции нужны **двум** контурам: HTTP-роуту пайплайнов
 * (`server/routes/pipeline-project-routes.ts`) и встроенным тулам агента
 * (`engine/tools/pipeline-write.ts`). Дублировать правила версионирования
 * (bump черновика, идемпотентность публикации, префикс id) в двух местах —
 * значит получить два разных поведения; поэтому правила живут здесь, а оба
 * контура вызывают одни и те же функции.
 *
 * Серверные поля спецификации (`id`/`version`/`status`/`projectId`)
 * проставляются **здесь** — вызывающий не может подсунуть чужой проект или
 * «свою» версию.
 */

import { generateId, nowISO, validatePipelineSpec } from '@itphx/synth-shared';
import type { PipelineNode, PipelineSpec, PipelineStep } from '@itphx/synth-shared';
import type {
  PipelineRecord,
  PipelineVersionRecord,
  ProjectPipelineRepository,
} from '../../storage/ports/index.js';
import type {
  PipelineDefinitionRecord,
  PipelineRepository,
} from '../../storage/ports/pipeline-repository.js';

/** Префикс id пайплайна проекта (`pl_<uuid>`). */
export const PIPELINE_ID_PREFIX = 'pl_';

/**
 * Спецификация в том виде, как её присылает вызывающий: серверные поля
 * (`id`/`version`/`status`/`projectId`) необязательны — их проставляет сервер.
 */
export type PipelineDraftSpecInput = Omit<
  PipelineSpec,
  'id' | 'version' | 'status' | 'projectId'
> &
  Partial<Pick<PipelineSpec, 'id' | 'version' | 'status' | 'projectId'>>;

/**
 * Ошибка авторской операции — список проблем + машинный код.
 *
 * `invalid_spec` — спецификация не прошла валидацию графа
 * (`validatePipelineSpec`); `nothing_to_publish` — публиковать нечего
 * (черновика нет).
 */
export class PipelineAuthoringError extends Error {
  /** Список проблем (для 400-ответа и сообщения модели). */
  readonly problems: string[];
  /** Машинный код ошибки. */
  readonly code: 'invalid_spec' | 'nothing_to_publish';

  constructor(code: 'invalid_spec' | 'nothing_to_publish', problems: string[]) {
    super(problems.join('; '));
    this.name = 'PipelineAuthoringError';
    this.code = code;
    this.problems = problems;
  }
}

/**
 * Создание черновика пайплайна проекта.
 *
 * Версия черновика — `1`; опубликованной версии нет. Спецификация
 * валидируется (граф узлов/переходов/выходов) — невалидная → ошибка
 * `PipelineAuthoringError` со списком проблем.
 */
export async function createPipelineDraft(input: {
  /** Порт спецификаций (ADR-096). */
  pipelines: ProjectPipelineRepository;
  /** Проект-владелец пайплайна. */
  projectId: string;
  /** Имя пайплайна (по умолчанию — `spec.name`). */
  name?: string;
  /** Описание пайплайна (по умолчанию — `spec.description`). */
  description?: string;
  /** Спецификация (серверные поля проставляются здесь). */
  spec: PipelineDraftSpecInput;
  /** Id пайплайна (по умолчанию — `pl_<uuid>`). */
  pipelineId?: string;
}): Promise<PipelineRecord> {
  const pipelineId = input.pipelineId ?? `${PIPELINE_ID_PREFIX}${generateId()}`;
  const spec = toDraftSpec(input.spec, {
    pipelineId,
    projectId: input.projectId,
    version: 1,
  });
  const validation = validatePipelineSpec(spec);
  if (!validation.ok) throw new PipelineAuthoringError('invalid_spec', validation.problems);

  const now = nowISO();
  const description = input.description ?? spec.description;
  const record: PipelineRecord = {
    id: pipelineId,
    scope: 'project',
    projectId: input.projectId,
    name: input.name ?? spec.name,
    ...(description ? { description } : {}),
    draft: spec,
    draftVersion: 1,
    createdAt: now,
    updatedAt: now,
  };
  await input.pipelines.savePipeline(record);
  return record;
}

/**
 * Правка черновика пайплайна (версия **не** bump'ается — ADR-101 §2.8).
 *
 * Имя/описание: переданное значение побеждает; не переданное — остаётся
 * прежним (для описания) / берётся из спецификации (для имени).
 */
export async function updatePipelineDraft(input: {
  /** Порт спецификаций (ADR-096). */
  pipelines: ProjectPipelineRepository;
  /** Текущая запись пайплайна. */
  record: PipelineRecord;
  /** Новая спецификация черновика. */
  spec: PipelineDraftSpecInput;
  /** Новое имя (опционально). */
  name?: string;
  /** Новое описание (опционально; `undefined` — оставить прежнее). */
  description?: string;
}): Promise<PipelineRecord> {
  const { record } = input;
  const spec = toDraftSpec(input.spec, {
    pipelineId: record.id,
    projectId: record.projectId ?? '',
    version: record.draftVersion,
  });
  const validation = validatePipelineSpec(spec);
  if (!validation.ok) throw new PipelineAuthoringError('invalid_spec', validation.problems);

  const updated: PipelineRecord = {
    ...record,
    name: input.name ?? spec.name,
    ...(input.description !== undefined
      ? { description: input.description }
      : {}),
    draft: spec,
    updatedAt: nowISO(),
  };
  await input.pipelines.savePipeline(updated);
  return updated;
}

/**
 * Публикация версии пайплайна.
 *
 * Опубликованная версия **неизменяема**; после публикации черновик получает
 * следующий номер версии (`draftVersion + 1`) — он становится заготовкой
 * следующей публикации.
 *
 * Идемпотентность: повторная публикация **без изменений** черновика версии
 * не плодит — возвращается та же опубликованная версия.
 */
export async function publishPipeline(input: {
  /** Порт спецификаций (ADR-096). */
  pipelines: ProjectPipelineRepository;
  /** Текущая запись пайплайна. */
  record: PipelineRecord;
  /** Кто публикует (идентификатор пользователя/системы). */
  publishedBy?: string;
}): Promise<{ pipeline: PipelineRecord; published: PipelineVersionRecord }> {
  const { pipelines, record } = input;
  if (!record.draft) {
    throw new PipelineAuthoringError('nothing_to_publish', [
      'draft: у пайплайна нет черновика для публикации',
    ]);
  }

  // Повторная публикация без изменений — идемпотентный ответ: версии не плодим.
  const lastPublished = record.publishedVersion
    ? await pipelines.getVersion(record.id, record.publishedVersion)
    : null;
  if (lastPublished && sameSpecContent(lastPublished.spec, record.draft)) {
    return { pipeline: record, published: lastPublished };
  }

  const version = record.draftVersion;
  const publishedSpec: PipelineSpec = {
    ...record.draft,
    version,
    status: 'published',
  };
  const versionRecord: PipelineVersionRecord = {
    pipelineId: record.id,
    version,
    spec: publishedSpec,
    publishedAt: nowISO(),
    ...(input.publishedBy !== undefined ? { publishedBy: input.publishedBy } : {}),
  };
  await pipelines.saveVersion(versionRecord);

  const nextVersion = version + 1;
  const updated: PipelineRecord = {
    ...record,
    draftVersion: nextVersion,
    publishedVersion: version,
    draft: { ...record.draft, version: nextVersion, status: 'draft' },
    updatedAt: nowISO(),
  };
  await pipelines.savePipeline(updated);
  return { pipeline: updated, published: versionRecord };
}

/**
 * Удаление пайплайна (прогоны остаются — прогон самодостаточен, ADR-101 §7).
 *
 * `true` — пайплайн удалён; `false` — такого пайплайна не было.
 */
export async function deletePipeline(input: {
  /** Порт спецификаций (ADR-096). */
  pipelines: ProjectPipelineRepository;
  /** Идентификатор пайплайна. */
  pipelineId: string;
}): Promise<boolean> {
  return input.pipelines.deletePipeline(input.pipelineId);
}

/**
 * Черновик с серверными полями (`id`/`version`/`status`/`projectId`).
 */
export function toDraftSpec(
  spec: PipelineDraftSpecInput,
  ctx: { pipelineId: string; projectId: string; version: number },
): PipelineSpec {
  return {
    ...spec,
    id: ctx.pipelineId,
    version: ctx.version,
    status: 'draft',
    projectId: ctx.projectId,
  };
}

/** Каноничный JSON (ключи отсортированы) — для сравнения спецификаций. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`);
  return `{${entries.join(',')}}`;
}

/**
 * Сравнение спецификаций **по содержанию**: `version`/`status` игнорируются
 * (черновик и опубликованная версия отличаются ими по построению).
 */
export function sameSpecContent(a: PipelineSpec, b: PipelineSpec): boolean {
  const strip = (spec: PipelineSpec): unknown => ({ ...spec, version: 0, status: 'draft' });
  return canonicalJson(strip(a)) === canonicalJson(strip(b));
}

// ───────────────────────────── Шаблоны инстанца ─────────────────────────────

/**
 * Краткое представление шаблона инстанца (ADR-101 §2.11.1).
 *
 * Шаблоны живут в **двух** местах (миграции данных нет):
 * 1. записи `scope:'instance'` нового порта `ProjectPipelineRepository`
 *    (формат `adr-101` — спецификация движка);
 * 2. legacy-реестр ADR-100 `PipelineRepository` (формат `adr-100` —
 *    определение пакета расширения).
 */
export interface PipelineTemplateSummary {
  /** Формат шаблона: `adr-101` — запись инстанса, `adr-100` — legacy-определение. */
  format: 'adr-101' | 'adr-100';
  /** Идентификатор шаблона. */
  id: string;
  /** Человекочитаемое имя. */
  name: string;
  /** Краткое описание. */
  description?: string;
  /** Версия: номер (adr-101) или semver-строка (adr-100). */
  version?: string | number;
  /** Провенанс установки (пакет/версия). */
  installedBy?: { pack: string; version: string };
  /** Спецификация шаблона (только формат `adr-101`). */
  spec?: PipelineSpec;
  /** Шаги шаблона (только формат `adr-100`). */
  steps?: PipelineStep[];
}

/**
 * Список шаблонов инстанца — **оба** источника, порядок как в HTTP-роуте:
 * сначала записи нового формата (`adr-101`), затем legacy-определения
 * (`adr-100`).
 */
export async function listPipelineTemplates(input: {
  /** Порт спецификаций пайплайнов (ADR-096) — записи `scope:'instance'`. */
  pipelines: ProjectPipelineRepository;
  /** Legacy-реестр шаблонов инстанца (ADR-100) — необязателен. */
  templates?: PipelineRepository;
}): Promise<PipelineTemplateSummary[]> {
  const instanceTemplates = await input.pipelines.listPipelines({ scope: 'instance' });
  const legacyDefinitions = (await input.templates?.listDefinitions()) ?? [];
  return [
    ...instanceTemplates.map((record) => ({
      format: 'adr-101' as const,
      id: record.id,
      name: record.name,
      ...(record.description ? { description: record.description } : {}),
      ...(record.draft?.version !== undefined ? { version: record.draft.version } : {}),
      ...(record.installedBy ? { installedBy: record.installedBy } : {}),
      ...(record.draft ? { spec: record.draft } : {}),
    })),
    ...legacyDefinitions.map((definition) => ({
      format: 'adr-100' as const,
      id: definition.id,
      name: definition.name,
      ...(definition.description ? { description: definition.description } : {}),
      ...(definition.version !== undefined ? { version: definition.version } : {}),
      ...(definition.installedBy ? { installedBy: definition.installedBy } : {}),
      steps: definition.steps,
    })),
  ];
}

/**
 * Итог инстанцирования шаблона в пайплайн проекта.
 *
 * `ok: false` + `reason:'template_not_found'` — шаблона нет ни в одном
 * источнике; `reason:'unsupported'` — шаблон не конвертируется в спецификацию
 * движка (список проблем — в `problems`).
 */
export type PipelineTemplateInstantiation =
  | { ok: true; pipeline: PipelineRecord; created: boolean }
  | { ok: false; reason: 'template_not_found' | 'unsupported'; problems?: string[] };

/**
 * Инстанцирование шаблона инстанца в **черновик** пайплайна проекта.
 *
 * Логика общая для HTTP-роута (`POST /pipeline-templates/:tid/instantiate`)
 * и встроенных тулов агента (`pipeline_instantiate`) — иначе два контура
 * разошлись бы (ADR-101 §2.11.1).
 *
 * Порядок: поиск шаблона → идемпотентность (`ensure`) → конвертация →
 * валидация → запись черновика с провенансом `installedBy.templateId`.
 */
export async function instantiatePipelineFromTemplate(input: {
  /** Порт спецификаций пайплайнов (ADR-096). */
  pipelines: ProjectPipelineRepository;
  /** Legacy-реестр шаблонов инстанца (ADR-100) — необязателен. */
  templates?: PipelineRepository;
  /** Идентификатор шаблона-источника. */
  templateId: string;
  /** Проект-владелец нового пайплайна. */
  projectId: string;
  /** Имя нового пайплайна (по умолчанию — имя шаблона). */
  name?: string;
  /**
   * Идемпотентное инстанцирование: если в проекте уже есть пайплайн,
   * инстанцированный из этого шаблона (`installedBy.templateId`), новый не
   * создаётся — возвращается существующий (`created: false`).
   */
  ensure?: boolean;
  /**
   * Спецификации шаблонов по id (швов для тестов и встроенных шаблонов,
   * объявленных в коде): если id есть в карте — шаблон берётся из неё
   * (формат `adr-101`), минуя порт.
   */
  specById?: Record<string, PipelineSpec>;
}): Promise<PipelineTemplateInstantiation> {
  const { pipelines, templateId, projectId } = input;

  const inlineSpec = input.specById?.[templateId];
  const instance = inlineSpec ? null : await pipelines.getPipeline(templateId);
  const record = instance && instance.scope === 'instance' ? instance : null;
  const definition =
    !inlineSpec && !record ? await input.templates?.getDefinition(templateId) : undefined;

  if (!inlineSpec && !record && !definition) {
    return { ok: false, reason: 'template_not_found' };
  }

  // `ensure: true` — идемпотентное инстанцирование: повторный вызов не
  // плодит копии шаблона, а возвращает уже созданный пайплайн проекта.
  if (input.ensure === true) {
    const existing = (
      await pipelines.listPipelines({ scope: 'project', projectId })
    ).find((item) => item.installedBy?.templateId === templateId);
    if (existing) return { ok: true, pipeline: existing, created: false };
  }

  const pipelineId = `${PIPELINE_ID_PREFIX}${generateId()}`;
  const built = inlineSpec
    ? buildDraftFromSpec(inlineSpec, { pipelineId, projectId })
    : record
      ? buildDraftFromRecord(record, { pipelineId, projectId })
      : legacyDefinitionToPipelineSpec(definition as PipelineDefinitionRecord, {
          pipelineId,
          projectId,
        });
  if (!built.ok) {
    return { ok: false, reason: 'unsupported', problems: built.problems };
  }

  const provenance =
    (record?.installedBy ?? definition?.installedBy) ?? { pack: 'instance', version: '1' };
  const now = nowISO();
  const pipeline: PipelineRecord = {
    id: pipelineId,
    scope: 'project',
    projectId,
    name: input.name ?? built.spec.name,
    ...(built.spec.description ? { description: built.spec.description } : {}),
    draft: built.spec,
    draftVersion: 1,
    installedBy: { ...provenance, templateId },
    createdAt: now,
    updatedAt: now,
  };
  await pipelines.savePipeline(pipeline);
  return { ok: true, pipeline, created: true };
}

/**
 * Черновик из спецификации шаблона — с серверными полями
 * (`id`/`version`/`projectId`) и проверкой графа.
 */
function buildDraftFromSpec(
  spec: PipelineSpec,
  ctx: { pipelineId: string; projectId: string },
): { ok: true; spec: PipelineSpec } | { ok: false; problems: string[] } {
  const draft = toDraftSpec(spec, {
    pipelineId: ctx.pipelineId,
    projectId: ctx.projectId,
    version: 1,
  });
  const validation = validatePipelineSpec(draft);
  if (!validation.ok) return { ok: false, problems: validation.problems };
  return { ok: true, spec: draft };
}

/**
 * Черновик из записи шаблона инстанца нового формата
 * (`scope:'instance'`): копия спецификации с серверными полями.
 */
function buildDraftFromRecord(
  record: PipelineRecord,
  ctx: { pipelineId: string; projectId: string },
): { ok: true; spec: PipelineSpec } | { ok: false; problems: string[] } {
  if (!record.draft) {
    return { ok: false, problems: ['template: у шаблона нет спецификации'] };
  }
  return buildDraftFromSpec(record.draft, ctx);
}

/**
 * Конвертация legacy-определения ADR-100 (`PipelineDefinition`) в спецификацию
 * движка ADR-101 (`PipelineSpec`) — **best-effort**, без миграции данных.
 *
 * Правила (задокументированы в `docs/PIPELINES.md` §2.11):
 * - шаг вида `agent` → узел вида `agent` (`agent`/`skill`/`prompt`/`timeoutSec`
 *   переносятся как есть);
 * - шаг вида `loop` **не конвертируется** (Loop Engine вне объёма, PROP-057) —
 *   шаблон с такими шагами не инстанцируется (409 со списком проблем);
 * - шаг без `agent` — не конвертируется (узел движка вида `agent` требует агента);
 * - `waitsFor` (событие-триггер/гейт автомата ADR-100) **не переносится**: в
 *   ADR-101 триггер задаётся при запуске прогона, а HITL-гейт выражается узлом
 *   вида `human` — его добавляет владелец пайплайна в черновике;
 * - выход пайплайна — `none` (выходы ADR-101 задаются вручную).
 */
export function legacyDefinitionToPipelineSpec(
  definition: PipelineDefinitionRecord,
  ctx: { pipelineId: string; projectId: string },
): { ok: true; spec: PipelineSpec } | { ok: false; problems: string[] } {
  const problems: string[] = [];
  const nodes: PipelineNode[] = [];

  definition.steps.forEach((step, index) => {
    if (step.kind === 'loop') {
      problems.push(
        `steps[${index}] («${step.id}»): шаг вида «loop» не поддерживается движком (PROP-057)`,
      );
      return;
    }
    if (!step.agent?.trim()) {
      problems.push(
        `steps[${index}] («${step.id}»): шаг без поля «agent» — узел движка вида «agent» требует агента`,
      );
      return;
    }
    nodes.push({
      id: step.id,
      kind: 'agent',
      ...(step.title ? { title: step.title } : {}),
      agent: step.agent,
      ...(step.skill ? { skill: step.skill } : {}),
      ...(step.prompt ? { prompt: step.prompt } : {}),
      ...(step.timeoutSec !== undefined ? { timeoutSec: step.timeoutSec } : {}),
    });
  });

  if (problems.length > 0) return { ok: false, problems };
  if (nodes.length === 0) {
    return { ok: false, problems: ['steps: у шаблона нет шагов, конвертируемых в узлы движка'] };
  }

  const spec: PipelineSpec = {
    id: ctx.pipelineId,
    name: definition.name,
    ...(definition.description ? { description: definition.description } : {}),
    version: 1,
    status: 'draft',
    mode: 'act',
    projectId: ctx.projectId,
    nodes,
    exits: [{ kind: 'none' }],
  };

  const validation = validatePipelineSpec(spec);
  if (!validation.ok) return { ok: false, problems: validation.problems };
  return { ok: true, spec };
}
