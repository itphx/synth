/**
 * ADR-115: тесты тула `list_models` (`engine/tools/list-models.ts`).
 *
 * Каталог и конфиг вложений — подставные (тул не ходит в хранилище сам):
 * проверяются только фильтры, формат ответа и метаданные.
 *
 * Что проверяется:
 * - без фильтров — компактно: текущая модель + назначенные aux-модели (не дамп);
 * - `modality` — только модели с этой модальностью, модели без `modalities`
 *   пропущены и посчитаны;
 * - `provider` — только этот провайдер (и вместе с `modality`);
 * - `isCurrent`/`defaultFor`, `limit`, пустой результат, пустой каталог,
 *   неизвестный провайдер/модальность, отсутствие `listModels` и ошибка загрузки;
 * - permission: группа `read`, plan-режим разрешён, workspace не требуется.
 */
import { describe, it, expect } from 'vitest';
import {
  ToolCapability,
  attachmentsConfigSchema,
  generateId,
  type AttachmentsConfig,
  type ModelConfig,
  type ToolContext,
} from '@itphx/synth-shared';
import { LIST_MODELS_TOOL, listModelsTool } from './list-models.js';
import { ALL_BUILTIN_TOOLS } from './index.js';
import { getToolGroups } from '../permission/groups.js';
import { isPlanBlockedTool } from '../permission/evaluator.js';
import {
  computeToolAvailability,
  isWorkspaceDependentTool,
} from '../permission/availability.js';

const CURRENT: ModelConfig = {
  id: 'routerai/deepseek/deepseek-v4.1-flash-1017',
  name: 'deepseek/deepseek-v4.1-flash-1017',
  provider: 'routerai',
  enabled: true,
  modalities: ['text', 'image'],
};

const CATALOG: ModelConfig[] = [
  CURRENT,
  {
    id: 'routerai/qwen/qwen3-vl',
    name: 'qwen/qwen3-vl',
    provider: 'routerai',
    enabled: true,
    modalities: ['text', 'image', 'pdf'],
  },
  // Модальности неизвестны (нет поля) — пропускается при фильтре по модальности.
  {
    id: 'routerai/legacy-text',
    name: 'legacy-text',
    provider: 'routerai',
    enabled: true,
  },
  {
    id: 'ollama/llava',
    name: 'llava',
    provider: 'ollama',
    enabled: true,
    modalities: ['text', 'image'],
  },
  {
    id: 'ollama/whisper',
    name: 'whisper',
    provider: 'ollama',
    enabled: true,
    modalities: ['audio'],
  },
];

/** Назначения aux-моделей: image → qwen3-vl, audio → whisper. */
const CONFIG: AttachmentsConfig = attachmentsConfigSchema.parse({
  modalityModels: {
    image: { provider: 'routerai', model: 'qwen/qwen3-vl' },
    audio: { provider: 'ollama', model: 'whisper' },
  },
});

interface ExtraOptions {
  catalog?: ModelConfig[] | null;
  config?: AttachmentsConfig | null;
  provider?: string;
  model?: string;
  loadError?: string;
}

function makeCtx(opts: ExtraOptions = {}): ToolContext {
  const catalog = opts.catalog === null ? null : opts.catalog ?? CATALOG;
  const config = opts.config === null ? null : opts.config ?? CONFIG;
  return {
    sessionId: 'ses_test',
    messageId: generateId(),
    workingDir: '/tmp/workspace',
    extra: {
      ...(catalog ? { listModels: async () => catalog } : {}),
      ...(config ? { attachmentsConfig: () => config } : {}),
      parentSessionSettings: {
        provider: opts.provider ?? 'routerai',
        model: opts.model ?? CURRENT.name,
      },
    },
  };
}

async function run(args: Record<string, unknown>, ctx?: ToolContext) {
  return listModelsTool.execute(args, ctx ?? makeCtx());
}

describe('Тул list_models (ADR-115)', () => {
  it('зарегистрирован во встроенных тулах с capability models', () => {
    const tool = ALL_BUILTIN_TOOLS.find((t) => t.name === LIST_MODELS_TOOL);
    expect(tool, 'list_models не зарегистрирован в ALL_BUILTIN_TOOLS').toBeDefined();
    expect(tool!.capabilities).toContain(ToolCapability.MODELS);
  });

  it('без фильтров — компактно: текущая модель + назначенные aux-модели', async () => {
    const result = await run({});
    expect(result.isError).toBeFalsy();
    // Только три строки моделей: текущая + две назначенные (не весь каталог).
    expect(result.content).toContain('- routerai/deepseek/deepseek-v4.1-flash-1017 — text, image');
    expect(result.content).toContain('- routerai/qwen/qwen3-vl — text, image, pdf');
    expect(result.content).toContain('- ollama/whisper — audio');
    expect(result.content).not.toContain('ollama/llava');
    expect(result.content).not.toContain('routerai/legacy-text');
    expect(result.content).toContain('Models (filter: —; shown 3 of 5):');
    expect(result.content).toContain('Current: routerai/deepseek/deepseek-v4.1-flash-1017 (text, image)');
    expect(result.content).toContain(
      'Assigned by modality: image → routerai/qwen/qwen3-vl, audio → ollama/whisper',
    );

    const meta = result.metadata!;
    expect(meta.filtered).toBeNull();
    expect(meta.total).toBe(5);
    const models = meta.models as Array<Record<string, unknown>>;
    expect(models).toHaveLength(3);
    expect(models[0]).toMatchObject({
      provider: 'routerai',
      model: 'deepseek/deepseek-v4.1-flash-1017',
      isCurrent: true,
      defaultFor: [],
    });
    expect(models.find((m) => m.model === 'qwen/qwen3-vl')).toMatchObject({
      isCurrent: false,
      defaultFor: ['image'],
    });
    expect(models.find((m) => m.model === 'whisper')).toMatchObject({
      isCurrent: false,
      defaultFor: ['audio'],
    });
  });

  it('фильтр по модальности: только принимающие, неизвестные пропущены и посчитаны', async () => {
    const result = await run({ modality: 'image' });
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('Models (filter: image; shown 3 of 5):');
    expect(result.content).toContain('- routerai/deepseek/deepseek-v4.1-flash-1017 — text, image');
    expect(result.content).toContain('- routerai/qwen/qwen3-vl — text, image, pdf');
    expect(result.content).toContain('- ollama/llava — text, image');
    expect(result.content).not.toContain('- ollama/whisper');
    expect(result.content).toContain('Skipped models with unknown modalities: 1');
    expect(result.metadata!.filtered).toBe('image');
    expect(result.metadata!.skipped).toBe(1);
  });

  it('фильтр по модальности pdf: только явно принимающие', async () => {
    const result = await run({ modality: 'pdf' });
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('- routerai/qwen/qwen3-vl — text, image, pdf');
    const models = result.metadata!.models as Array<Record<string, unknown>>;
    expect(models.map((m) => m.model)).toEqual(['qwen/qwen3-vl']);
  });

  it('фильтр по провайдеру: только этот провайдер', async () => {
    const result = await run({ provider: 'ollama' });
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('Models (filter: ollama; shown 2 of 5):');
    expect(result.content).toContain('- ollama/llava — text, image');
    expect(result.content).toContain('- ollama/whisper — audio');
    expect(result.metadata!.filtered).toBe('ollama');
    const models = result.metadata!.models as Array<Record<string, unknown>>;
    expect(models.map((m) => m.provider)).toEqual(['ollama', 'ollama']);
  });

  it('провайдер + модальность вместе', async () => {
    const result = await run({ provider: 'ollama', modality: 'image' });
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('Models (filter: image, ollama; shown 1 of 5):');
    expect(result.content).toContain('- ollama/llava — text, image');
    const models = result.metadata!.models as Array<Record<string, unknown>>;
    expect(models.map((m) => m.model)).toEqual(['llava']);
    expect(result.metadata!.skipped).toBe(0);
  });

  it('limit ограничивает число строк (и метаданные)', async () => {
    const result = await run({ modality: 'image', limit: 1 });
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('Models (filter: image; shown 1 of 5):');
    const models = result.metadata!.models as unknown[];
    expect(models).toHaveLength(1);
  });

  it('limit по умолчанию — 20 (весь результат при малом каталоге)', async () => {
    const result = await run({ modality: 'image' });
    expect(result.content).toContain('shown 3 of 5');
  });

  it('пустой результат фильтра — не ошибка, «No models found»', async () => {
    const result = await run({ provider: 'ollama', modality: 'pdf' });
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('No models found');
    expect(result.metadata!.models).toEqual([]);
  });

  it('пустой каталог — ошибка (не пустой список)', async () => {
    const result = await run({}, makeCtx({ catalog: [] }));
    expect(result.isError).toBe(true);
    expect(result.content).toContain('No models found');

    const resultWithFilter = await run({ modality: 'image' }, makeCtx({ catalog: [] }));
    expect(resultWithFilter.isError).toBe(true);
  });

  it('неизвестный провайдер — понятная ошибка, а не пустой список', async () => {
    const result = await run({ provider: 'nope' });
    expect(result.isError).toBe(true);
    expect(result.content).toContain('Provider "nope" not found');
    expect(result.metadata!.total).toBe(5);
  });

  it('неизвестная модальность — ошибка разбора аргументов', async () => {
    const result = await run({ modality: 'hologram' });
    expect(result.isError).toBe(true);
    expect(result.content).toContain('modality');
  });

  it('нет listModels в extra — ошибка deps', async () => {
    const result = await run({}, makeCtx({ catalog: null }));
    expect(result.isError).toBe(true);
    expect(result.content).toContain('model catalog is unavailable in this build');
  });

  it('ошибка загрузки каталога — понятная ошибка, не бросок', async () => {
    const ctx: ToolContext = {
      sessionId: 'ses_test',
      messageId: generateId(),
      workingDir: '/tmp/workspace',
      extra: {
        listModels: async () => {
          throw new Error('storage down');
        },
      },
    };
    const result = await run({}, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('storage down');
  });

  it('текущая модель вне каталога — показывается из настроек сессии', async () => {
    const result = await run(
      {},
      makeCtx({ provider: 'routerai', model: 'removed-model' }),
    );
    expect(result.content).toContain('Current: routerai/removed-model (—)');
    const models = result.metadata!.models as Array<Record<string, unknown>>;
    expect(models.some((m) => m.isCurrent)).toBe(false);
  });

  it('без attachmentsConfig — назначений нет, компактный ответ пуст', async () => {
    const result = await run({}, makeCtx({ config: null }));
    expect(result.isError).toBeFalsy();
    // Текущая модель в каталоге есть — она и попадает в список.
    expect(result.content).toContain('shown 1 of 5');
    expect(result.content).not.toContain('Assigned by modality');
  });
});

describe('list_models — permission-слой (ADR-025/ADR-029/ADR-075)', () => {
  it('группа read, в plan-режиме разрешён', () => {
    expect(getToolGroups(LIST_MODELS_TOOL, [ToolCapability.MODELS])).toContain('read');
    expect(isPlanBlockedTool(LIST_MODELS_TOOL, [ToolCapability.MODELS])).toBe(false);

    expect(computeToolAvailability(LIST_MODELS_TOOL, [ToolCapability.MODELS], {
      sessionMode: 'plan',
      planMode: 'strict',
      agentCapabilities: [ToolCapability.MODELS],
    })).toEqual({ available: true });
  });

  it('не зависит от workspace (каталог доступен без проекта)', () => {
    expect(isWorkspaceDependentTool([ToolCapability.MODELS])).toBe(false);
    expect(computeToolAvailability(LIST_MODELS_TOOL, [ToolCapability.MODELS], {
      sessionMode: 'act',
      agentCapabilities: [ToolCapability.MODELS],
      workspaceReady: false,
    })).toEqual({ available: true });
  });

  it('доступен только агенту с capability models', () => {
    expect(computeToolAvailability(LIST_MODELS_TOOL, [ToolCapability.MODELS], {
      sessionMode: 'act',
      agentCapabilities: [ToolCapability.FILE_READ],
    })).toEqual({ available: false, reason: 'role' });
  });
});
