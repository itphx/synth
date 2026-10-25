/**
 * М1 + М2: блок «recall по вопросу хода» (точка `promptBlocks`, тир `volatile`).
 *
 * Retrieval по текущему вопросу. Два пути (docs/MEMORY.md §2.3):
 * - **есть пригодные индексы** (состояние `ready` или `stale`) → гибридный
 *   поиск по корпусу (keyword + вектор + RRF, `engine/search.ts`). Учитываются
 *   **и** проектные, **и** инстансные индексы (`scope: 'instance'` — общий
 *   корпус на инстанс, виден всем сессиям);
 * - индексов нет → keyword-скоринг по фактам (поведение М1).
 *
 * Блок появляется **только** при непустом `ctx.query`: у шага пайплайна и
 * саб-агента вопроса хода нет, вспоминать нечего (docs/MEMORY.md §7).
 *
 * Каждая **реальная** попытка вспоминания (сервис памяти доступен, вопрос
 * непустой) сообщается хосту телеметрией (`kind: 'recall'`): исход
 * (`hit`/`empty`/`error`), число найденных фрагментов и длительность
 * (ADR-107). Сервис памяти недоступен — блок не грузится, запроса не было,
 * телеметрии нет.
 *
 * Детерминированность обязательна (ADR-070, граница prompt-cache): один и тот
 * же вход → один и тот же текст блока.
 */
import type { PromptBlockProvider } from '@itphx/synth-shared';

import { mergeChunkItems, type SearchItem } from '../engine/search.js';
import { formatFactLine, type MemoryProviderLite } from '../provider.js';
import { elapsedMs, startTimer } from '../telemetry.js';

/** Ключ блока (совпадает с `provides.promptBlocks[]` манифеста). */
export const RECALL_BLOCK_KEY = 'plugin.synth-plugin-memory.recall';
/** Подпись блока в манифесте промпта. */
export const RECALL_BLOCK_TITLE = 'Воспоминание по вопросу хода';
/** Заголовок секции в тексте блока. */
export const RECALL_BLOCK_HEADER = '[MEMORY: recall for this turn]';
/**
 * Пометка устаревшего индекса.
 *
 * Индекс `stale` (сменилась модель/размерность эмбеддинга) — вектора
 * «похожи», но не те же: секция не выдаётся как «пусто», а помечается
 * (docs/MEMORY.md §4.1).
 */
export const RECALL_STALE_NOTICE = '[MEMORY: index stale, rebuild pending]';

/**
 * Строка найденного фрагмента корпуса: текст + источник + score.
 *
 * Источник — путь файла или id факта; диапазон строк — когда известен.
 */
export function formatRecallItem(item: SearchItem): string {
  const metadata = item.metadata ?? {};
  const path = typeof metadata.path === 'string' ? metadata.path : undefined;
  const factId = typeof metadata.factId === 'string' ? metadata.factId : undefined;
  const source = path ?? factId ?? item.documentId;
  const startLine = typeof metadata.startLine === 'number' ? metadata.startLine : undefined;
  const endLine = typeof metadata.endLine === 'number' ? metadata.endLine : undefined;
  const range =
    startLine !== undefined && endLine !== undefined ? `, ${startLine}-${endLine}` : '';
  return `- ${item.text} (src: ${source}${range}, score ${item.score.toFixed(2)})`;
}

/**
 * Провайдер блока «recall по вопросу хода».
 *
 * Факты, уже попавшие в блок «project facts», не дублируются: блок выбирает
 * их тем же правилом (уверенность → свежесть → id), поэтому результат не
 * зависит от порядка загрузки блоков композером. Для фрагментов индекса
 * дедуп — по `factId` в метаданных (источник `facts`).
 */
export function createRecallBlock(provider: MemoryProviderLite): PromptBlockProvider {
  return {
    key: RECALL_BLOCK_KEY,
    tier: 'volatile',
    order: 110,
    title: RECALL_BLOCK_TITLE,
    async load(ctx) {
      // Сервис памяти недоступен (`facade.memory === undefined`) — блок не
      // грузится: вспоминать нечего, телеметрии нет (запроса не было).
      if (!provider.available) return null;
      const query = ctx.query?.trim();
      if (!query) return null;
      const startedAt = startTimer();
      let hits = 0;
      let content: string | null = null;
      try {
        const scope = ctx.projectId ? { projectId: ctx.projectId } : {};
        const candidates = await provider.candidates(scope);
        const inFacts = new Set(provider.selectFacts(candidates).map((fact) => fact.id));
        const { recallLimit } = provider.settings();

        // Пригодные индексы (проектные + инстансные) — гибридный recall.
        const indexes = await provider.usableIndexes(ctx.projectId);
        if (indexes.length > 0) {
          const collected: SearchItem[] = [];
          let stale = false;
          for (const index of indexes) {
            if (index.state === 'stale') stale = true;
            const found = await provider.searchIndex(index.index.id, query, {
              topK: recallLimit,
            });
            collected.push(...found.items);
          }
          const merged = mergeChunkItems(collected);
          const lines = merged
            .slice(0, recallLimit)
            .filter((item) => !isFactInFacts(item, inFacts))
            .map((item) => formatRecallItem(item));
          // Хиты телеметрии — строки-фрагменты выдачи (после дедупа и среза,
          // без заголовков блока).
          hits = lines.length;
          // Пометка устаревания — если **хотя бы один** использованный индекс
          // `stale` (детерминированно: индексы перебираются в отсортированном
          // порядке).
          const notice = stale ? [RECALL_STALE_NOTICE] : [];
          if (lines.length > 0) {
            content = [RECALL_BLOCK_HEADER, ...notice, ...lines].join('\n');
          } else if (notice.length > 0) {
            content = [RECALL_BLOCK_HEADER, ...notice].join('\n');
          }
        }

        // Индексов нет (или выдача по ним пуста) — keyword-recall по фактам
        // (поведение М1). Хиты телеметрии — строки фактов.
        if (content === null) {
          const factHits = await provider.recall(candidates, query, inFacts);
          hits = factHits.length;
          if (factHits.length > 0) {
            content = [RECALL_BLOCK_HEADER, ...factHits.map(formatFactLine)].join('\n');
          }
        }
      } catch (err) {
        provider.recordRecall({
          kind: 'recall',
          outcome: 'error',
          hits: 0,
          durationMs: elapsedMs(startedAt),
        });
        throw err;
      }
      provider.recordRecall({
        kind: 'recall',
        outcome: hits > 0 ? 'hit' : 'empty',
        hits,
        durationMs: elapsedMs(startedAt),
      });
      return content;
    },
  };
}

/** Фрагмент индекса — это уже показанный в блоке фактов? */
function isFactInFacts(item: SearchItem, inFacts: ReadonlySet<string>): boolean {
  const factId = item.metadata?.factId;
  return typeof factId === 'string' && inFacts.has(factId);
}
