/**
 * ADR-115: тул `list_models` — каталог моделей инстанса для агента.
 *
 * ## Зачем
 *
 * Агент не видел каталога моделей вообще: он знал только пару своей сессии.
 * Из-за этого он не мог ни предложить пользователю модель под вложение
 * (модальность), ни выбрать подходящую модель саб-агенту — `task({provider,
 * model})` это умеет, но кандидатов взять неоткуда.
 *
 * ## Что отдаёт
 *
 * - **Без фильтров** — компактно: текущая модель сессии + все модели,
 *   назначенные aux-моделями в `attachments.modalityModels`. Полного дампа нет:
 *   у каталогов бывают сотни моделей (у routerai — 578), это забило бы контекст.
 * - **`modality`** — только модели, у которых `ModelConfig.modalities` содержит
 *   модальность. Модели без поля `modalities` (модальности неизвестны)
 *   пропускаются, их число сообщается в конце: «неизвестно» ≠ «не принимает».
 * - **`provider`** — только этот провайдер (можно вместе с `modality`).
 *
 * Помимо списка — текущая пара (`extra.parentSessionSettings.provider/model`,
 * у обычной сессии это её настройки), назначения по семействам
 * (`attachments.modalityModels`) и `defaultFor` у каждой модели — чтобы агент
 * видел не только «что есть», но и «что уже настроено».
 *
 * Только чтение: тул в группе `read`, в plan-режиме разрешён, к рабочему
 * каталогу проекта не привязан (capability `models` не входит в
 * `WORKSPACE_CAPABILITIES`).
 */
import { z } from 'zod';
import {
  ATTACHMENT_FAMILIES,
  ToolCapability,
  type AttachmentsConfig,
  type AttachmentFamily,
  type ModelConfig,
  type ToolContext,
  type ToolDefinition,
  type ToolResult,
} from '@itphx/synth-shared';
import { isAborted, abortedResult } from './abort.js';
import { t as sm, i18n as i18nMeta } from '../system-messages.js';

/** Имя тула (используется в текстах и в permission-группах). */
export const LIST_MODELS_TOOL = 'list_models';

/**
 * Предел строк в компактном ответе (без фильтров): текущая модель + назначенные
 * aux-модели. Семейств четыре, поэтому предел — страховка от мусорной записи
 * `modalityModels`, а не реальное ограничение.
 */
const COMPACT_LIMIT = 10;

/** Зависимости тула из `ToolContext.extra` (упаковка — оркестратор). */
export interface ListModelsExtra {
  /**
   * Каталог моделей инстанса (`modelStore.list()`). Не задан — тул отвечает
   * `models.list.deps_unavailable` (`list_models` есть, а данных нет).
   */
  listModels?: () => Promise<ModelConfig[]>;
  /**
   * Live-конфиг `attachments.*` — источник `modalityModels` для `defaultFor`
   * и компактного ответа. Не задан — назначений считаем нет.
   */
  attachmentsConfig?: () => AttachmentsConfig;
  /**
   * Настройки сессии (для обычной сессии — её собственные, для саб-агента —
   * родительские): `provider`/`model` дают «текущую» пару.
   */
  parentSessionSettings?: { provider?: string; model?: string };
}

/** Пара «провайдер/модель» — ключ каталога и вид в ответе. */
function pairOf(model: ModelConfig): string {
  return `${model.provider}/${model.name}`;
}

/** Список модальностей модели для строки ответа (`—` — неизвестны). */
function modalitiesOf(model: ModelConfig | undefined): string {
  return model?.modalities?.length ? model.modalities.join(', ') : '—';
}

/** Семейства вложений, где эта модель назначена aux-моделью. */
function defaultFamilies(model: ModelConfig, config?: AttachmentsConfig): AttachmentFamily[] {
  const assignments = config?.modalityModels;
  if (!assignments) return [];
  const out: AttachmentFamily[] = [];
  for (const family of ATTACHMENT_FAMILIES) {
    const ref = assignments[family];
    if (!ref) continue;
    if (ref.provider === model.provider && ref.model === model.name) out.push(family);
  }
  return out;
}

/** Единый текст ошибки разбора аргументов (как у соседних тулов). */
function argsErrorResult(toolName: string, issues: string): ToolResult {
  return {
    content: sm('tool.args_error', { tool: toolName, issues }),
    isError: true,
    metadata: { i18n: i18nMeta('tool.args_error', { tool: toolName }) },
  };
}

/** Отказ с ключом i18n и (необязательным) блоком metadata. */
function failureResult(
  key: Parameters<typeof sm>[0],
  params: Record<string, string>,
  metadata: Record<string, unknown> = {},
): ToolResult {
  return {
    content: sm(key, params),
    isError: true,
    metadata: { ...metadata, i18n: i18nMeta(key, params) },
  };
}

export const listModelsTool: ToolDefinition = {
  name: LIST_MODELS_TOOL,
  description:
    'List the instance model catalog: provider/model ids with their input modalities (text, image, pdf, '
    + 'audio, video), the current session model, and which models are assigned as aux models for '
    + 'attachments (attachments.modalityModels). Use it to pick a model for an attachment or to pass '
    + 'provider/model to the task tool for a subagent. Without arguments it returns a compact answer '
    + '(current model + assigned aux models); filter by modality and/or provider to see more. '
    + 'Models whose modalities are unknown are skipped and counted.',
  parameters: z.object({
    modality: z
      .enum(ATTACHMENT_FAMILIES)
      .optional()
      .describe('Only models that accept this attachment modality'),
    provider: z
      .string()
      .min(1)
      .optional()
      .describe('Only models of this provider (combine with modality)'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(50)
      .default(20)
      .describe('Maximum number of models to show (1..50, default 20)'),
  }),
  capabilities: [ToolCapability.MODELS],
  async execute(args, ctx: ToolContext): Promise<ToolResult> {
    // «Стоп» пришёл до запуска — каталог не читаем (см. tools/abort.ts)
    if (isAborted(ctx)) return abortedResult(this.name);
    const parsed = this.parameters.safeParse(args ?? {});
    if (!parsed.success) {
      return argsErrorResult(
        this.name,
        parsed.error.issues.map((i) => `${i.path.join('.') || 'root'}: ${i.message}`).join('; '),
      );
    }
    const params = parsed.data as {
      modality?: AttachmentFamily;
      provider?: string;
      limit: number;
    };
    const extra = (ctx.extra ?? {}) as ListModelsExtra;

    const loader = extra.listModels;
    if (!loader) return failureResult('models.list.deps_unavailable', {});

    let catalog: ModelConfig[];
    try {
      catalog = await loader();
    } catch (err) {
      return failureResult(
        'models.list.unavailable',
        { reason: err instanceof Error ? err.message : String(err) },
      );
    }

    const config = extra.attachmentsConfig?.();
    const currentProvider = extra.parentSessionSettings?.provider;
    const currentModelId = extra.parentSessionSettings?.model;
    const currentPair =
      currentProvider && currentModelId ? `${currentProvider}/${currentModelId}` : null;

    // Фильтр в заголовке — то, что реально применили (для metadata и текста).
    const filterParts: string[] = [];
    if (params.modality) filterParts.push(params.modality);
    if (params.provider) filterParts.push(params.provider);
    const filterLabel = filterParts.length > 0 ? filterParts.join(', ') : null;

    if (catalog.length === 0) {
      return failureResult('models.list.empty', {}, {
        models: [],
        filtered: filterLabel,
        total: 0,
      });
    }

    // Провайдер, которого нет в каталоге, — ошибка фильтра, а не «пусто»:
    // иначе агент решил бы, что у провайдера просто нет подходящих моделей.
    if (params.provider && !catalog.some((m) => m.provider === params.provider)) {
      return failureResult('models.list.provider_unknown', { provider: params.provider }, {
        models: [],
        filtered: filterLabel,
        total: catalog.length,
      });
    }

    // Детерминированный порядок: каталог может отдавать модели в любом порядке
    // (файлы, БД), а ответ агента должен быть воспроизводим.
    const sorted = [...catalog].sort((a, b) => pairOf(a).localeCompare(pairOf(b)));

    let candidates: ModelConfig[];
    let skipped = 0;
    if (params.modality) {
      // Модели с неизвестными модальностями пропускаем и считаем: «неизвестно»
      // не значит «не принимает», но и обещать приём нельзя.
      candidates = [];
      for (const model of sorted) {
        if (params.provider && model.provider !== params.provider) continue;
        if (!model.modalities?.length) {
          skipped += 1;
          continue;
        }
        if (model.modalities.includes(params.modality)) candidates.push(model);
      }
    } else if (params.provider) {
      candidates = sorted.filter((model) => model.provider === params.provider);
    } else {
      // Компактный режим: текущая модель + назначенные aux-модели, без дампа.
      const assigned: ModelConfig[] = [];
      for (const family of ATTACHMENT_FAMILIES) {
        const ref = config?.modalityModels?.[family];
        if (!ref) continue;
        const model = sorted.find((m) => m.provider === ref.provider && m.name === ref.model);
        if (model && !assigned.includes(model)) assigned.push(model);
      }
      const current = currentPair ? sorted.find((m) => pairOf(m) === currentPair) : undefined;
      candidates = [];
      if (current) candidates.push(current);
      for (const model of assigned.slice(0, COMPACT_LIMIT)) {
        if (!candidates.includes(model)) candidates.push(model);
      }
    }

    const displayed = candidates.slice(0, params.limit);
    const currentModel = currentPair ? sorted.find((m) => pairOf(m) === currentPair) : undefined;

    const lines: string[] = [
      sm('models.list.header', {
        filter: filterLabel ?? '—',
        shown: String(displayed.length),
        total: String(catalog.length),
      }),
    ];
    if (displayed.length === 0) {
      lines.push(sm('models.list.empty'));
    }
    for (const model of displayed) {
      const modalities = model.modalities?.length ? ` — ${model.modalities.join(', ')}` : '';
      lines.push(`- ${pairOf(model)}${modalities}`);
    }

    // Текущая пара — из настроек сессии, даже если модели нет в каталоге
    // (удалена/переименована): агент должен видеть фактическую пару.
    if (currentPair) {
      lines.push(sm('models.list.current', {
        model: currentPair,
        modalities: modalitiesOf(currentModel),
      }));
    }

    const assignments: string[] = [];
    for (const family of ATTACHMENT_FAMILIES) {
      const ref = config?.modalityModels?.[family];
      if (ref) assignments.push(`${family} → ${ref.provider}/${ref.model}`);
    }
    if (assignments.length > 0) {
      lines.push(sm('models.list.defaults', { assignments: assignments.join(', ') }));
    }
    if (skipped > 0) {
      lines.push(sm('models.list.skipped', { count: String(skipped) }));
    }

    return {
      // Без metadata.i18n: блок многострочный (заголовок + строки моделей +
      // хвосты), а UI подменяет content переводом одного ключа — список бы
      // потерялся. Локализация хвостов — ключи `models.list.*` (en в LLM-канал).
      content: lines.join('\n'),
      metadata: {
        models: displayed.map((model) => ({
          provider: model.provider,
          model: model.name,
          modalities: model.modalities ?? null,
          isCurrent: currentPair !== null && pairOf(model) === currentPair,
          defaultFor: defaultFamilies(model, config),
        })),
        // Описание применённого фильтра (`null` — без фильтров).
        filtered: filterLabel,
        // Всего моделей в каталоге (не «показано» — предел строк виден в заголовке).
        total: catalog.length,
        skipped,
      },
    };
  },
};
