/**
 * М2: тул `memory_index` — управление индексами памяти (точка `tools`).
 *
 * Жизненный цикл корпуса проекта: создать, собрать, пересобрать, удалить,
 * посмотреть статус. Сборка — **фоновая** (docs/MEMORY.md §2.3): ответ
 * содержит id индекса и состояние `building`, прогресс — по состоянию
 * индекса (`building → ready`/`failed`).
 *
 * Скоуп — проект сессии (`ctx.projectId`): индексы чужих проектов не видны и
 * не трогаются (то же правило, что у фактов и у тула `memory_write`).
 */
import type { PluginToolDefinition } from '@itphx/synth-core';
import type { z } from 'zod';

import {
  IndexBusyError,
  IndexNotFoundError,
  MemoryUnavailableError,
  type MemoryProviderLite,
} from '../provider.js';
import { boolean, enumOf, object, optional, string } from '../schema.js';

/** Локальное имя тула (в реестре — с namespace'ом, его составляет хост). */
export const MEMORY_INDEX_TOOL_NAME = 'memory_index';

/**
 * Схема параметров — по ней хост валидирует аргументы.
 *
 * Валидатор — собственный (`schema.ts`): бандл плагина не должен тянуть
 * сторонние зависимости (иначе скан помечает его как `caution`).
 */
export const memoryIndexParameters = object({
  action: enumOf(['status', 'create', 'build', 'rebuild', 'delete']),
  indexId: optional(string({ min: 1, max: 200 })),
  name: optional(string({ min: 1, max: 120 })),
  source: optional(
    object({
      kind: enumOf(['files', 'facts']),
      filter: optional(string({ min: 1, max: 500 })),
    }),
  ),
  projectId: optional(string({ min: 1, max: 200 })),
  force: optional(boolean()),
});

/** Явная JSON-схема параметров — то, что видит модель (ADR-090, §4.3). */
export const memoryIndexJsonSchema: Record<string, unknown> = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: ['status', 'create', 'build', 'rebuild', 'delete'],
      description: 'Действие: статус, создать, собрать, пересобрать, удалить',
    },
    indexId: {
      type: 'string',
      description: 'Индекс (id). Для build/rebuild/delete можно не указывать, если известно имя.',
    },
    name: {
      type: 'string',
      description: 'Имя индекса (по умолчанию — project)',
    },
    source: {
      type: 'object',
      properties: {
        kind: {
          type: 'string',
          enum: ['files', 'facts'],
          description: 'Источник корпуса: файлы рабочего каталога или факты памяти',
        },
        filter: { type: 'string', description: 'Фильтр источника (необязательно)' },
      },
      additionalProperties: false,
      description: 'Источник корпуса индекса (по умолчанию — files)',
    },
    projectId: {
      type: 'string',
      description:
        'Проект-владелец индекса. Если сессия работает в проекте — параметр игнорируется.',
    },
    force: {
      type: 'boolean',
      description: 'Пересобрать даже если сборка уже идёт (по умолчанию — нет)',
    },
  },
  required: ['action'],
  additionalProperties: false,
};

/** Статус индекса одной строкой — для человека. */
function formatIndexLine(status: {
  index: {
    id: string;
    name: string;
    source: { kind: string };
    generation: number;
    stats: { documents: number; chunks: number };
  };
  state: string;
}): string {
  const { index, state } = status;
  const stale = state === 'stale' ? ' (устарел — нужна пересборка)' : '';
  return (
    `- ${index.name} (${index.id}): ${state}${stale}, поколение ${index.generation}, ` +
    `документов ${index.stats.documents}, чанков ${index.stats.chunks}`
  );
}

/**
 * Тул управления индексами памяти.
 *
 * Хранилище недоступно (`facade.memory === undefined`) → понятная ошибка
 * (`isError`), а не падение хода.
 */
export function createMemoryIndexTool(provider: MemoryProviderLite): PluginToolDefinition {
  return {
    name: MEMORY_INDEX_TOOL_NAME,
    description:
      'Управляет индексами памяти проекта: создать, собрать, пересобрать, удалить, посмотреть статус. Сборка идёт в фоне — состояние индекса меняется с building на ready или failed.',
    // `PluginToolDefinition.parameters` типизирован хостом как `z.ZodTypeAny`
    // (ADR-090), а валидатор плагина — свой (без zod в бандле). Контракт
    // совпадает: хост зовёт `safeParse` и читает `error.issues`, поэтому
    // кастуем через `unknown` — типовой разрыв между двумя реализациями
    // одного контракта.
    parameters: memoryIndexParameters as unknown as z.ZodTypeAny,
    jsonSchema: memoryIndexJsonSchema,
    capabilities: ['memory'],
    async execute(params, ctx) {
      const parsed = memoryIndexParameters.safeParse(params);
      if (!parsed.success) {
        return {
          content: `Некорректные аргументы управления индексами: ${parsed.error.issues
            .map((issue) => `${issue.path.join('.') || 'action'} — ${issue.message}`)
            .join('; ')}`,
          isError: true,
        };
      }
      const { action, indexId, name, source, projectId, force } = parsed.data;

      // Скоуп сессии важнее аргумента модели (то же правило, что у `memory_write`).
      const scopeProjectId = ctx.projectId?.trim() ? ctx.projectId : projectId;

      try {
        if (action === 'status') {
          const statuses = await provider.listIndexes(
            scopeProjectId ? { projectId: scopeProjectId } : {},
          );
          if (statuses.length === 0) {
            return {
              content: 'Индексов памяти пока нет.',
              metadata: { indexes: [] },
            };
          }
          return {
            content: ['Индексы памяти:', ...statuses.map((status) => formatIndexLine(status))].join(
              '\n',
            ),
            metadata: {
              indexes: statuses.map((status) => ({
                indexId: status.index.id,
                name: status.index.name,
                state: status.state,
                generation: status.index.generation,
                stats: status.index.stats,
              })),
            },
          };
        }

        if (action === 'create') {
          const created = await provider.createIndex({
            ...(name ? { name } : {}),
            ...(source ? { source } : {}),
            ...(scopeProjectId ? { projectId: scopeProjectId } : {}),
            workingDir: ctx.workingDir,
          });
          return {
            content:
              `Индекс создан (id: ${created.index.id}), сборка запущена в фоне. ` +
              'Состояние индекса: building → ready или failed.',
            metadata: {
              indexId: created.index.id,
              state: created.state,
              generation: created.index.generation,
              stats: created.index.stats,
            },
          };
        }

        // build / rebuild / delete — индекс по id или по имени (+ проект).
        const target = await resolveTarget(provider, {
          indexId,
          name,
          projectId: scopeProjectId,
        });
        if (!target) {
          return {
            content:
              'Индекс не найден. Укажите indexId или имя индекса (см. action: status).',
            isError: true,
          };
        }

        if (action === 'delete') {
          const removed = await provider.deleteIndex(target.id);
          return {
            content: removed
              ? `Индекс удалён (id: ${target.id}).`
              : `Индекс не найден (id: ${target.id}).`,
            metadata: { indexId: target.id, deleted: removed },
            ...(removed ? {} : { isError: true }),
          };
        }

        const rebuilt = await provider.rebuildIndex(target.id, {
          ...(force !== undefined ? { force } : {}),
          workingDir: ctx.workingDir,
        });
        return {
          content:
            `Пересборка индекса ${target.id} запущена в фоне ` +
            `(поколение ${rebuilt.index.generation}).`,
          metadata: {
            indexId: rebuilt.index.id,
            state: rebuilt.state,
            generation: rebuilt.index.generation,
            stats: rebuilt.index.stats,
          },
        };
      } catch (err) {
        if (
          err instanceof MemoryUnavailableError ||
          err instanceof IndexNotFoundError ||
          err instanceof IndexBusyError
        ) {
          return { content: err.message, isError: true };
        }
        throw err;
      }
    },
  };
}

/**
 * Найти индекс в скоупе проекта — по id или по имени.
 *
 * Поиск идёт **по скоупу**: индекс чужого проекта не находится (и не
 * удаляется) — id из аргументов модели не даёт доступа к чужому индексу.
 */
async function resolveTarget(
  provider: MemoryProviderLite,
  opts: { indexId?: string; name?: string; projectId?: string },
): Promise<{ id: string; name: string } | null> {
  const statuses = await provider.listIndexes(
    opts.projectId ? { projectId: opts.projectId } : {},
  );
  const found = opts.indexId
    ? statuses.find((status) => status.index.id === opts.indexId)
    : opts.name
      ? statuses.find((status) => status.index.name === opts.name)
      : undefined;
  return found ? { id: found.index.id, name: found.index.name } : null;
}
