/**
 * ADR-101 (Pipeline Engine): **встроенные шаблоны пайплайнов инстанса**.
 *
 * Шаблон инстанца (`scope:'instance'`) — источник для инстанцирования в
 * пайплайн проекта (`POST /api/v2/pipeline-templates/:tid/instantiate`,
 * §2.11.1 документации). Встроенные шаблоны объявлены **в коде** и
 * сидятся в порт при старте процесса — по образцу встроенных скиллов
 * (`engine/skills/builtin.ts`, ADR-046 §9.5): отдельного asset-каталога и
 * пакета расширения не нужно.
 *
 * ## Идемпотентность
 *
 * Сидирование **не перезаписывает** существующую запись: если шаблон с таким
 * id уже есть (пользователь отредактировал его в UI или удалил), запись
 * сохраняется как есть, в лог уходит только сообщение. Иначе правка
 * встроенного шаблона «слетала» бы при каждом рестарте.
 *
 * ## Триггер прогона
 *
 * В ADR-101 триггер — свойство **прогона** (`PipelineRunTrigger`, §2.3), а не
 * спецификации: `kind` задаёт тот, кто запустил прогон. Поэтому встроенный
 * шаблон объявляет **вход** (`io.input` + `vars`/`node.input`), а способ
 * запуска — вручную (`kind:'manual'`, дефолт HTTP-роута) или по расписанию
 * (`kind:'schedule'`, например, из внешнего планировщика/шедулера ADR-051,
 * который вызывает `POST …/runs`) — описан в описании шаблона и в
 * [docs/PIPELINES.md](../../../../../docs/PIPELINES.md).
 */

import { nowISO, pluginToolFullName } from '@itphx/synth-shared';
import type { PipelineSpec } from '@itphx/synth-shared';

import { MEMORY_PLUGIN_NAME } from '../plugins/memory-namespace.js';
import type {
  PipelineRecord,
  PipelineVersionRecord,
  ProjectPipelineRepository,
} from '../../storage/ports/project-pipeline-repository.js';

/** Идентификатор встроенного шаблона «Память: консолидация сессии». */
export const MEMORY_CONSOLIDATION_PIPELINE_ID = 'builtin:memory-consolidation';

/** Идентификатор встроенного шаблона «Память: слияние дублей фактов». */
export const MEMORY_CONSOLIDATE_FACTS_PIPELINE_ID = 'builtin:memory-consolidate-facts';

/** Идентификатор встроенного шаблона «Память: переиндексация проекта». */
export const MEMORY_REINDEX_PIPELINE_ID = 'builtin:memory-reindex';

/** Номер версии встроенного шаблона памяти (первая и единственная). */
export const MEMORY_CONSOLIDATION_PIPELINE_VERSION = 1;

/** Номер версии встроенных шаблонов памяти (все — версия 1). */
export const MEMORY_BUILTIN_PIPELINE_VERSION = 1;

/** Провенанс встроенных шаблонов: пакет `builtin`, версия `1`. */
export const BUILTIN_PIPELINE_PROVENANCE = { pack: 'builtin', version: '1' } as const;

/** Кто опубликовал встроенную версию. */
const BUILTIN_PUBLISHED_BY = 'system';

/**
 * Задание агентского шага — извлечение устойчивых утверждений из сессии и
 * запись их в память (факты).
 *
 * Правила (важны для качества памяти):
 * - читать сессию **тулом** `read_session_reference` (не выдумывать её
 *   содержимое по идентификатору);
 * - писать только **устойчивые** утверждения (решения, ограничения, ссылки,
 *   предпочтения) — разовые договорённости и рассуждения в память не идут;
 * - `kind` — по смыслу утверждения; `ttlDays` — только если в сессии явно
 *   назван срок;
 * - дубли не создавать;
 * - в конце — короткий отчёт `{candidates, written}` (итог шага читается из
 *   выхода агентского узла).
 */
const MEMORY_CONSOLIDATION_PROMPT = `Консолидация сессии в память: извлеки устойчивые утверждения и запиши их как факты.

Вход шага: идентификатор сессии (sessionId) — он передан в блоке [INPUT].

Шаги:
1. Прочитай сессию тулом \`read_session_reference\` (параметр \`session_id\` = sessionId из входа). Если сессии нет или она пустая — верни отчёт \`{"candidates": 0, "written": 0}\` и причину.
2. Выдели только УСТОЙЧИВЫЕ утверждения: принятые решения, ограничения и правила, ссылки на важные артефакты/системы, устойчивые предпочтения. Не бери разовые договорённости, вопросы, рассуждения и догадки. Ничего не выдумывай: в память идёт только то, что прямо следует из текста сессии.
3. Каждое утверждение запиши отдельным вызовом тула записи факта \`memory_write\` (в наборе инструментов он называется \`plugin_synth_plugin_memory_memory_write\`):
   - \`text\` — одно самодостаточное утверждение (не пересказ диалога);
   - \`kind\` — по смыслу: \`decision\` (решение), \`constraint\` (ограничение/правило), \`reference\` (ссылка на артефакт или систему), \`preference\` (устойчивое предпочтение), \`observation\` — только если ничего лучше не подходит;
   - \`confidence\` — 0..1, насколько утверждение устойчиво;
   - \`ttlDays\` — только если в сессии явно назван срок; иначе не указывай (факт бессрочный).
   Дубли не создавай: если такое утверждение уже есть в памяти, пропусти его.
4. Если тула записи факта нет в наборе инструментов — ничего не записывай и объясни это в отчёте.
5. В конце верни короткий отчёт одной строкой в формате JSON: \`{"candidates": <сколько кандидатов найдено>, "written": <сколько фактов записано>}\`.`;

/**
 * Спецификация встроенного шаблона «Память: консолидация сессии».
 *
 * Черновик (`status:'draft'`) — источник для инстанцирования; опубликованная
 * версия 1 кладётся рядом (см. `ensureBuiltinPipelines`), чтобы шаблон можно
 * было запускать и как инстансный.
 */
export function buildMemoryConsolidationPipelineSpec(): PipelineSpec {
  return {
    id: MEMORY_CONSOLIDATION_PIPELINE_ID,
    name: 'Память: консолидация сессии',
    description:
      'Извлекает устойчивые утверждения из сессии (вход: sessionId в payload триггера) и записывает их в память как факты. ' +
      'Запуск: вручную (trigger.kind=manual, по умолчанию) или по расписанию (trigger.kind=schedule) — триггер задаётся при запуске прогона.',
    version: MEMORY_CONSOLIDATION_PIPELINE_VERSION,
    status: 'draft',
    mode: 'act',
    io: {
      input: {
        type: 'object',
        properties: {
          sessionId: {
            type: 'string',
            description: 'Идентификатор сессии, из которой извлекаются факты',
          },
        },
        required: ['sessionId'],
      },
    },
    // Явная переменная спецификации: `sessionId` ← payload триггера.
    vars: { sessionId: 'trigger.payload.sessionId' },
    nodes: [
      {
        id: 'consolidate',
        kind: 'agent',
        title: 'Консолидация сессии в память',
        agent: 'assistant',
        prompt: MEMORY_CONSOLIDATION_PROMPT,
        input: ['trigger.payload.sessionId'],
        timeoutSec: 600,
      },
    ],
    exits: [{ kind: 'none' }],
  };
}

/**
 * Полное имя админ-тула плагина памяти в реестре (ADR-090/ADR-107):
 * имя составляет хост (`plugin_<namespace>_<tool>`), поэтому в шаблоне его
 * не дублируем строкой.
 */
export const MEMORY_CONSOLIDATE_TOOL_NAME = pluginToolFullName(
  MEMORY_PLUGIN_NAME,
  'memory_consolidate',
);

/** Полное имя тула индексов памяти в реестре (`memory_index`). */
export const MEMORY_INDEX_TOOL_NAME = pluginToolFullName(MEMORY_PLUGIN_NAME, 'memory_index');

/**
 * Спецификация встроенного шаблона «Память: слияние дублей фактов».
 *
 * Один узел вида `tool` — вызов админ-тула плагина памяти `memory_consolidate`
 * без пробного прогона (`dryRun: false`): находит похожие утверждения и
 * оставляет по одному. Вход шаблону не нужен (пустая схема).
 */
export function buildMemoryConsolidateFactsPipelineSpec(): PipelineSpec {
  return {
    id: MEMORY_CONSOLIDATE_FACTS_PIPELINE_ID,
    name: 'Память: слияние дублей фактов',
    description:
      'Находит дубли среди фактов памяти и сливает их (оставляет одно утверждение, остальные помечает заменёнными). ' +
      'Запуск: вручную (trigger.kind=manual, по умолчанию) или по расписанию (trigger.kind=schedule).',
    version: MEMORY_BUILTIN_PIPELINE_VERSION,
    status: 'draft',
    mode: 'act',
    io: { input: { type: 'object', properties: {} } },
    nodes: [
      {
        id: 'consolidate-facts',
        kind: 'tool',
        title: 'Слияние дублей фактов',
        tool: MEMORY_CONSOLIDATE_TOOL_NAME,
        toolArgs: { dryRun: false },
        timeoutSec: 600,
      },
    ],
    exits: [{ kind: 'none' }],
  };
}

/**
 * Спецификация встроенного шаблона «Память: переиндексация проекта».
 *
 * Один узел вида `tool` — `memory_index` с `action: 'rebuild_all'` и
 * `wait: true` (дождаться завершения сборки в рамках шага). Проект берётся
 * из контекста прогона (`ctx.projectId`), отдельного входа не нужно.
 */
export function buildMemoryReindexPipelineSpec(): PipelineSpec {
  return {
    id: MEMORY_REINDEX_PIPELINE_ID,
    name: 'Память: переиндексация проекта',
    description:
      'Пересобирает все индексы памяти проекта (файлы и факты). ' +
      'Запуск: вручную (trigger.kind=manual, по умолчанию) или по расписанию (trigger.kind=schedule).',
    version: MEMORY_BUILTIN_PIPELINE_VERSION,
    status: 'draft',
    mode: 'act',
    io: { input: { type: 'object', properties: {} } },
    nodes: [
      {
        id: 'reindex',
        kind: 'tool',
        title: 'Переиндексация проекта',
        tool: MEMORY_INDEX_TOOL_NAME,
        toolArgs: { action: 'rebuild_all', wait: true },
        timeoutSec: 900,
      },
    ],
    exits: [{ kind: 'none' }],
  };
}

/** Зависимости сидирования встроенных шаблонов. */
export interface EnsureBuiltinPipelinesDeps {
  /** Порт спецификаций пайплайнов (ADR-096). */
  pipelines: ProjectPipelineRepository;
  /** Логгер (best-effort; сообщения — только технические, без секретов). */
  logger?: {
    info?: (message: string) => void;
    warn?: (message: string) => void;
  };
}

/** Итог сидирования встроенных шаблонов. */
export interface EnsureBuiltinPipelinesResult {
  /** id созданных шаблонов. */
  created: string[];
  /** id уже существовавших шаблонов (не перезаписаны). */
  skipped: string[];
  /** id шаблонов, которые не удалось записать (ошибка — в лог). */
  failed: string[];
}

/** Встроенный шаблон: запись (`scope:'instance'`) + опубликованная версия. */
interface BuiltinTemplate {
  /** id шаблона. */
  id: string;
  /** Имя шаблона (в списке шаблонов инстанца). */
  name: string;
  /** Описание шаблона. */
  description: string;
  /** Черновик спецификации. */
  draft: PipelineSpec;
  /** Номер версии. */
  version: number;
}

/** Список встроенных шаблонов памяти (три; список, а не одна запись). */
function builtinTemplates(): BuiltinTemplate[] {
  const consolidation = buildMemoryConsolidationPipelineSpec();
  const consolidateFacts = buildMemoryConsolidateFactsPipelineSpec();
  const reindex = buildMemoryReindexPipelineSpec();
  return [
    {
      id: MEMORY_CONSOLIDATION_PIPELINE_ID,
      name: consolidation.name,
      description: consolidation.description ?? '',
      draft: consolidation,
      version: MEMORY_CONSOLIDATION_PIPELINE_VERSION,
    },
    {
      id: MEMORY_CONSOLIDATE_FACTS_PIPELINE_ID,
      name: consolidateFacts.name,
      description: consolidateFacts.description ?? '',
      draft: consolidateFacts,
      version: MEMORY_BUILTIN_PIPELINE_VERSION,
    },
    {
      id: MEMORY_REINDEX_PIPELINE_ID,
      name: reindex.name,
      description: reindex.description ?? '',
      draft: reindex,
      version: MEMORY_BUILTIN_PIPELINE_VERSION,
    },
  ];
}

/**
 * Сидирование встроенных шаблонов пайплайнов инстанца.
 *
 * Идемпотентно: существующая запись **не перезаписывается** (правка
 * встроенного шаблона в UI переживает рестарт). Ошибка записи одного шаблона
 * не мешает остальным и **не пробрасывается** — она попадает в лог
 * (`warn`), старт процесса не падает.
 *
 * @param deps — порт спецификаций и логгер.
 * @param now — источник времени (тесты подставляют свой).
 */
export async function ensureBuiltinPipelines(
  deps: EnsureBuiltinPipelinesDeps,
  now: () => string = nowISO,
): Promise<EnsureBuiltinPipelinesResult> {
  const result: EnsureBuiltinPipelinesResult = { created: [], skipped: [], failed: [] };

  for (const template of builtinTemplates()) {
    try {
      const existing = await deps.pipelines.getPipeline(template.id);
      if (existing) {
        result.skipped.push(template.id);
        deps.logger?.info?.(
          `[pipelines] встроенный шаблон «${template.id}» уже есть — не перезаписываем`,
        );
        continue;
      }

      const ts = now();
      const publishedSpec: PipelineSpec = {
        ...template.draft,
        version: template.version,
        status: 'published',
      };
      const record: PipelineRecord = {
        id: template.id,
        scope: 'instance',
        name: template.name,
        description: template.description,
        draft: template.draft,
        draftVersion: template.version,
        publishedVersion: template.version,
        installedBy: { ...BUILTIN_PIPELINE_PROVENANCE },
        createdAt: ts,
        updatedAt: ts,
      };
      await deps.pipelines.savePipeline(record);
      const version: PipelineVersionRecord = {
        pipelineId: template.id,
        version: template.version,
        spec: publishedSpec,
        publishedAt: ts,
        publishedBy: BUILTIN_PUBLISHED_BY,
      };
      await deps.pipelines.saveVersion(version);

      result.created.push(template.id);
      deps.logger?.info?.(
        `[pipelines] создан встроенный шаблон «${template.id}» (версия ${template.version})`,
      );
    } catch (err) {
      result.failed.push(template.id);
      deps.logger?.warn?.(
        `[pipelines] не удалось засеять встроенный шаблон «${template.id}»: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  return result;
}
