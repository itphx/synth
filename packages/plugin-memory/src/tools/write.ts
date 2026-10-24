/**
 * М1: тул `memory_write` — явное запоминание факта (точка `tools`).
 *
 * Факт пишется через `facade.memory.facts`: ядро владеет данными памяти
 * (ADR-096), плагин — логикой (PROP-047). Namespace навязывает хост
 * (ADR-107) — плагин его не выбирает.
 *
 * **Скоуп записи — проект сессии.** Если ход идёт в проекте, факт
 * принадлежит ему: аргумент модели `projectId` игнорируется. Иначе факт
 * без проекта утекает во все проекты (виден каждому) — обратная утечка
 * к утечке в чужой проект. Сессия без проекта ведёт себя как раньше:
 * аргумент модели разрешён, без него факт общий.
 */
import type { PluginToolDefinition } from '@itphx/synth-core';
import type { z } from 'zod';

import {
  factKindSchema,
  MemoryUnavailableError,
  type MemoryProviderLite,
} from '../provider.js';
import { number, object, optional, string } from '../schema.js';

/** Локальное имя тула (в реестре — с namespace'ом, его составляет хост). */
export const MEMORY_WRITE_TOOL_NAME = 'memory_write';

/**
 * Схема параметров — по ней хост валидирует аргументы.
 *
 * Валидатор — собственный (`schema.ts`): бандл плагина не должен тянуть
 * сторонние зависимости (иначе скан помечает его как `caution`).
 */
export const memoryWriteParameters = object({
  text: string({ min: 1, max: 2000 }),
  kind: optional(factKindSchema),
  projectId: optional(string({ min: 1 })),
  confidence: optional(number({ min: 0, max: 1 })),
  ttlDays: optional(number({ int: true, min: 1, max: 3650 })),
});

/**
 * Явная JSON-схема параметров — то, что видит модель (ADR-090, §4.3).
 */
export const memoryWriteJsonSchema: Record<string, unknown> = {
  type: 'object',
  properties: {
    text: {
      type: 'string',
      minLength: 1,
      maxLength: 2000,
      description: 'Текст утверждения, которое нужно запомнить',
    },
    kind: {
      type: 'string',
      enum: ['decision', 'constraint', 'reference', 'preference', 'observation'],
      description: 'Вид факта (по умолчанию observation)',
    },
    projectId: {
      type: 'string',
      description:
        'Проект-владелец утверждения. Если сессия работает в проекте — параметр игнорируется: факт привязывается к проекту сессии автоматически.',
    },
    confidence: {
      type: 'number',
      minimum: 0,
      maximum: 1,
      description: 'Уверенность в утверждении (0..1)',
    },
    ttlDays: {
      type: 'integer',
      minimum: 1,
      maximum: 3650,
      description: 'Срок действия факта в днях (по умолчанию — бессрочно)',
    },
  },
  required: ['text'],
  additionalProperties: false,
};

/**
 * Тул записи факта.
 *
 * Хранилище недоступно (`facade.memory === undefined`) → понятная ошибка
 * (`isError`), а не падение хода.
 */
export function createMemoryWriteTool(provider: MemoryProviderLite): PluginToolDefinition {
  return {
    name: MEMORY_WRITE_TOOL_NAME,
    description:
      'Запоминает утверждение в память: решение, ограничение, договорённость или наблюдение. Факт автоматически привязывается к проекту сессии, если сессия в проекте — projectId указывать не нужно. Возвращает id и версию факта.',
    // `PluginToolDefinition.parameters` типизирован хостом как `z.ZodTypeAny`
    // (ADR-090), а валидатор плагина — свой (без zod в бандле). Контракт
    // совпадает: хост зовёт `safeParse` и читает `error.issues`, поэтому
    // кастуем через `unknown` — типовой разрыв между двумя реализациями
    // одного контракта.
    parameters: memoryWriteParameters as unknown as z.ZodTypeAny,
    jsonSchema: memoryWriteJsonSchema,
    capabilities: ['memory'],
    async execute(params, ctx) {
      const parsed = memoryWriteParameters.safeParse(params);
      if (!parsed.success) {
        return {
          content: `Некорректные аргументы записи в память: ${parsed.error.issues
            .map((issue) => `${issue.path.join('.') || 'text'} — ${issue.message}`)
            .join('; ')}`,
          isError: true,
        };
      }
      const { text, kind, projectId, confidence, ttlDays } = parsed.data;

      // Скоуп сессии важнее аргумента модели: факт, записанный в проекте A,
      // не должен ни попасть в проект B, ни стать «общим» (без projectId) —
      // иначе он станет виден каждому проекту (утечка в обратную сторону).
      // Аргумент модели учитывается только у сессии без проекта — там он
      // и задаёт владельца факта.
      const scopeProjectId = ctx.projectId?.trim() ? ctx.projectId : projectId;

      try {
        const result = await provider.write({
          text,
          ...(kind ? { kind } : {}),
          ...(scopeProjectId ? { projectId: scopeProjectId } : {}),
          ...(confidence !== undefined ? { confidence } : {}),
          ...(ttlDays !== undefined ? { ttlDays } : {}),
          sessionId: ctx.sessionId,
        });
        return {
          content: `Факт сохранён в память (id: ${result.factId}, версия ${result.version}).`,
          metadata: { factId: result.factId, version: result.version },
        };
      } catch (err) {
        if (err instanceof MemoryUnavailableError) {
          return { content: err.message, isError: true };
        }
        throw err;
      }
    },
  };
}
