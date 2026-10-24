/**
 * М1: тул `memory_forget` — коррекция и отзыв факта (точка `tools`).
 *
 * Два режима (docs/MEMORY.md §4.1):
 * - `supersede` — утверждение исправлено: заводим **новую версию** факта
 *   (`version` + 1), старый помечаем `superseded` и связываем `supersededBy`;
 * - `retract` — утверждение снято: факт переводится в статус `retracted`.
 *
 * Факта нет (или он чужого namespace'а — порт отдаёт «не найдено») → ошибка
 * с текстом «Факт не найден».
 */
import type { PluginToolDefinition } from '@itphx/synth-core';
import { z } from 'zod';

import {
  FactNotFoundError,
  MemoryUnavailableError,
  SupersedeTextRequiredError,
  type MemoryProviderLite,
} from '../provider.js';

/** Локальное имя тула (в реестре — с namespace'ом, его составляет хост). */
export const MEMORY_FORGET_TOOL_NAME = 'memory_forget';

/** Схема параметров (zod) — по ней хост валидирует аргументы. */
export const memoryForgetParameters = z.object({
  factId: z.string().min(1),
  mode: z.enum(['supersede', 'retract']),
  text: z.string().min(1).max(2000).optional(),
});

/**
 * Явная JSON-схема параметров — то, что видит модель (ADR-090, §4.3).
 */
export const memoryForgetJsonSchema: Record<string, unknown> = {
  type: 'object',
  properties: {
    factId: { type: 'string', minLength: 1, description: 'id факта, который отзываем' },
    mode: {
      type: 'string',
      enum: ['supersede', 'retract'],
      description:
        'supersede — исправить утверждение (нужен новый текст), retract — снять утверждение целиком',
    },
    text: {
      type: 'string',
      minLength: 1,
      maxLength: 2000,
      description: 'Новый текст факта — обязателен для режима supersede',
    },
  },
  required: ['factId', 'mode'],
  additionalProperties: false,
};

/**
 * Тул отзыва факта.
 *
 * Хранилище недоступно (`facade.memory === undefined`) → понятная ошибка
 * (`isError`), а не падение хода.
 */
export function createMemoryForgetTool(provider: MemoryProviderLite): PluginToolDefinition {
  return {
    name: MEMORY_FORGET_TOOL_NAME,
    description:
      'Отзывает факт из памяти: supersede — исправляет утверждение новой версией, retract — снимает утверждение.',
    parameters: memoryForgetParameters,
    jsonSchema: memoryForgetJsonSchema,
    capabilities: ['memory'],
    async execute(params, ctx) {
      const parsed = memoryForgetParameters.safeParse(params);
      if (!parsed.success) {
        return {
          content: `Некорректные аргументы отзыва факта: ${parsed.error.issues
            .map((issue) => `${issue.path.join('.') || 'factId'} — ${issue.message}`)
            .join('; ')}`,
          isError: true,
        };
      }
      const { factId, mode, text } = parsed.data;

      try {
        const result = await provider.forget({
          factId,
          mode,
          ...(text ? { text } : {}),
          sessionId: ctx.sessionId,
        });
        if (mode === 'supersede') {
          return {
            content:
              `Утверждение заменено: новая версия ${result.version} (id: ${result.factId}), ` +
              `прежняя версия помечена как заменённая.`,
            metadata: {
              factId: result.factId,
              version: result.version,
              supersededId: result.supersededId ?? '',
            },
          };
        }
        return {
          content: `Утверждение отозвано (id: ${result.factId}).`,
          metadata: { factId: result.factId, version: result.version },
        };
      } catch (err) {
        if (
          err instanceof MemoryUnavailableError ||
          err instanceof FactNotFoundError ||
          err instanceof SupersedeTextRequiredError
        ) {
          return { content: err.message, isError: true };
        }
        throw err;
      }
    },
  };
}
