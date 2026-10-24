/**
 * М4a: тул `memory_consolidate` — консолидация фактов памяти (точка `tools`).
 *
 * Сливает похожие утверждения: дубли получают статус `superseded`, остаётся
 * один факт-канон (см. `engine/consolidate.ts` — правила выбора канона и
 * жадной кластеризации).
 *
 * **Скоуп — проект сессии.** Если ход идёт в проекте, консолидируются его
 * факты (и общие, как и в остальных тулах памяти); аргумент модели
 * `projectId` игнорируется. То же правило, что у `memory_write`
 * (ADR-107, docs/MEMORY.md §3) — одна реализация скоупа на весь плагин.
 *
 * **Пробный прогон (`dryRun`)** — только отчёт: агент может посмотреть план
 * слияния до того, как память изменится.
 */
import type { PluginToolDefinition } from '@itphx/synth-core';
import type { z } from 'zod';

import { consolidateFacts, type ConsolidateReport } from '../engine/consolidate.js';
import {
  ConsolidationError,
  MemoryUnavailableError,
  type MemoryProviderLite,
} from '../provider.js';
import { boolean, number, object, optional, string } from '../schema.js';
import { MAX_CONSOLIDATE_THRESHOLD, MIN_CONSOLIDATE_THRESHOLD } from '../settings.js';

/** Локальное имя тула (в реестре — с namespace'ом, его составляет хост). */
export const MEMORY_CONSOLIDATE_TOOL_NAME = 'memory_consolidate';

/**
 * Схема параметров — по ней хост валидирует аргументы.
 *
 * Валидатор — собственный (`schema.ts`): бандл плагина не должен тянуть
 * сторонние зависимости (иначе скан помечает его как `caution`).
 */
export const memoryConsolidateParameters = object({
  projectId: optional(string({ min: 1, max: 200 })),
  threshold: optional(number({ min: MIN_CONSOLIDATE_THRESHOLD, max: MAX_CONSOLIDATE_THRESHOLD })),
  dryRun: optional(boolean()),
});

/**
 * Явная JSON-схема параметров — то, что видит модель (ADR-090, §4.3).
 */
export const memoryConsolidateJsonSchema: Record<string, unknown> = {
  type: 'object',
  properties: {
    projectId: {
      type: 'string',
      description:
        'Проект-владелец фактов. Если сессия работает в проекте — параметр игнорируется: консолидируются факты проекта сессии.',
    },
    threshold: {
      type: 'number',
      minimum: MIN_CONSOLIDATE_THRESHOLD,
      maximum: MAX_CONSOLIDATE_THRESHOLD,
      description:
        'Порог похожести (косинус) для слияния фактов. По умолчанию — из настроек плагина (0.9): чем ниже, тем больше слияний.',
    },
    dryRun: {
      type: 'boolean',
      description: 'Только показать план слияния, ничего не меняя (по умолчанию — нет).',
    },
  },
  additionalProperties: false,
};

/** Сколько кластеров перечислять в тексте ответа. */
const DETAIL_LIMIT = 10;

/** Текст-сводка по отчёту консолидации. */
export function formatConsolidateReport(report: ConsolidateReport, dryRun: boolean): string {
  const lines = [
    `Кластеров: ${report.clusters}, заменено: ${report.superseded}, оставлено: ${report.kept}`,
  ];
  if (dryRun) lines.push('Пробный прогон: изменения не применялись.');
  for (const item of report.items.slice(0, DETAIL_LIMIT)) {
    lines.push(
      `- оставлен факт ${item.keptId}, заменены ${item.supersededIds.join(', ')} ` +
        `(похожесть ${item.similarity.toFixed(2)})`,
    );
  }
  if (report.items.length > DETAIL_LIMIT) {
    lines.push(`…ещё ${report.items.length - DETAIL_LIMIT} кластеров (см. metadata).`);
  }
  return lines.join('\n');
}

/**
 * Тул консолидации фактов памяти.
 *
 * Хранилище недоступно (`facade.memory === undefined`) → понятная ошибка
 * (`isError`), а не падение хода. Ошибка эмбеддингов (провайдер недоступен) —
 * тоже `isError`: текст из ошибки фасада и её машиночитаемый код
 * (`metadata.code`), если код есть.
 */
export function createMemoryConsolidateTool(provider: MemoryProviderLite): PluginToolDefinition {
  return {
    name: MEMORY_CONSOLIDATE_TOOL_NAME,
    description:
      'Консолидирует память: находит похожие утверждения (по косинусу эмбеддингов) и оставляет одно, помечая остальные заменёнными. Текст канона не переписывается. Можно сначала посмотреть план (dryRun).',
    // `PluginToolDefinition.parameters` типизирован хостом как `z.ZodTypeAny`
    // (ADR-090), а валидатор плагина — свой (без zod в бандле). Контракт
    // совпадает: хост зовёт `safeParse` и читает `error.issues`, поэтому
    // кастуем через `unknown` — типовой разрыв между двумя реализациями
    // одного контракта.
    parameters: memoryConsolidateParameters as unknown as z.ZodTypeAny,
    jsonSchema: memoryConsolidateJsonSchema,
    capabilities: ['memory'],
    async execute(params, ctx) {
      const parsed = memoryConsolidateParameters.safeParse(params);
      if (!parsed.success) {
        return {
          content: `Некорректные аргументы консолидации памяти: ${parsed.error.issues
            .map((issue) => `${issue.path.join('.') || 'threshold'} — ${issue.message}`)
            .join('; ')}`,
          isError: true,
        };
      }
      const { projectId, threshold, dryRun } = parsed.data;

      // Скоуп сессии важнее аргумента модели (то же правило, что у `memory_write`).
      const scopeProjectId = ctx.projectId?.trim() ? ctx.projectId : projectId;

      try {
        const report = await consolidateFacts(
          { provider },
          {
            ...(scopeProjectId ? { projectId: scopeProjectId } : {}),
            ...(threshold !== undefined ? { threshold } : {}),
            ...(dryRun !== undefined ? { dryRun } : {}),
          },
        );
        return {
          content: formatConsolidateReport(report, dryRun === true),
          metadata: {
            clusters: report.clusters,
            superseded: report.superseded,
            kept: report.kept,
            items: report.items,
          },
        };
      } catch (err) {
        if (err instanceof MemoryUnavailableError || err instanceof ConsolidationError) {
          return { content: err.message, isError: true };
        }
        // Ошибка сервиса фасада (эмбеддинги): текст ошибки + её код.
        const code = errorCode(err);
        if (code) {
          return {
            content: err instanceof Error ? err.message : String(err),
            isError: true,
            metadata: { code },
          };
        }
        throw err;
      }
    },
  };
}

/**
 * Машиночитаемый код ошибки (если есть) — у ошибок сервисов фасада
 * (`plugin.embed_*`) он нужен вызывающему, чтобы отличить «провайдер
 * эмбеддингов недоступен» от других сбоев.
 */
function errorCode(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const code = (err as { code?: unknown }).code;
  return typeof code === 'string' && code.length > 0 ? code : undefined;
}
