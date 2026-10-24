/**
 * М4a: движок консолидации фактов памяти.
 *
 * Консолидация — **слияние похожих утверждений**: память копится, и в ней
 * появляются дубли («деплой через Fleet» и «деплой в test через Fleet»).
 * Консолидация находит такие дубли по векторам и оставляет **один** факт
 * (канон), а остальные помечает заменёнными (`superseded`) — как и делает
 * явная правка факта (тул `memory_forget`, ADR-107, docs/MEMORY.md §4.1).
 *
 * **Что консолидация НЕ делает.** Текст канона **не переписывается**: без LLM
 * нельзя выдумывать формулировки (инвариант 3 — любой вызов модели идёт через
 * шлюз; консолидация deliberately обходится без модели). Канон — один из
 * существующих фактов, просто выбранный по правилам; в его `metadata` падает
 * список id слитых фактов (`consolidatedFrom`).
 *
 * **Алгоритм (жадная кластеризация).**
 * - векторы текстов — батчами через `facade.embed` (ADR-107/ADR-036);
 * - факты идут в детерминированном порядке (по id); для каждого ищем **уже
 *   открытый** кластер с максимальной похожестью (косинус) ≥ порога;
 *   подходящего кластера нет — факт открывает новый;
 * - канон кластера выбирается по строгому порядку: выше `confidence` → длиннее
 *   текст → свежее `updatedAt` → меньше `id`. Порядок зафиксирован, чтобы
 *   прогон был воспроизводим (один вход → один отчёт);
 * - порог — из настроек плагина (`consolidateThreshold`, дефолт 0.9), из
 *   аргумента тула он только **сужает/расширяет** в допустимых границах
 *   (0.5..0.99).
 *
 * **Записи — только после расчёта плана.** Сначала считаются эмбеддинги и
 * кластеры, потом применяются изменения: ошибка эмбеддингов (провайдер
 * эмбеддингов недоступен) не должна оставить память наполовину переписанной.
 * Ошибки фасада пробрасываются как есть — их видит вызывающий (у них есть
 * машиночитаемый код).
 */
import type { MemoryFactRecord } from '@itphx/synth-core';

import { ConsolidationError } from '../errors.js';
import type { MemoryProviderLite } from '../provider.js';
import { clampNumber, MAX_CONSOLIDATE_THRESHOLD, MIN_CONSOLIDATE_THRESHOLD } from '../settings.js';
import { cosine } from './search.js';

/** Потолок выборки фактов за прогон (потолок порта памяти — 1000). */
export const CONSOLIDATE_FACT_LIMIT = 1000;

/** Сколько кластеров показывать в отчёте (остальные — счётчиком). */
export const CONSOLIDATE_ITEMS_LIMIT = 50;

/** Зависимости движка консолидации. */
export interface ConsolidateDeps {
  /** Провайдер памяти — единственная точка доступа к портам и эмбеддингам. */
  provider: MemoryProviderLite;
}

/** Параметры прогона консолидации. */
export interface ConsolidateOptions {
  /** Проект-владелец фактов (не задан — только факты без проекта). */
  projectId?: string;
  /** Порог похожести (косинус); не задан — из настроек плагина. */
  threshold?: number;
  /** Только посчитать план, ничего не меняя. */
  dryRun?: boolean;
}

/** Один кластер слияния в отчёте. */
export interface ConsolidateCluster {
  /** id факта-канона (остаётся активным). */
  keptId: string;
  /** id фактов, помеченных заменёнными. */
  supersededIds: string[];
  /** Похожесть кластера: минимальный косинус «канон ↔ слитый факт». */
  similarity: number;
}

/** Отчёт консолидации. */
export interface ConsolidateReport {
  /** Число кластеров-слияний (групп из двух и более похожих фактов). */
  clusters: number;
  /** Число фактов, помеченных заменёнными. */
  superseded: number;
  /** Число оставшихся активных фактов (всего минус заменённые). */
  kept: number;
  /** Кластеры (максимум {@link CONSOLIDATE_ITEMS_LIMIT}), по убыванию похожести. */
  items: ConsolidateCluster[];
}

/** Участник кластера: факт и его вектор. */
interface ClusterMember {
  /** Факт памяти. */
  fact: MemoryFactRecord;
  /** Вектор текста факта. */
  vector: number[];
}

/** Кластер (группа похожих фактов). */
interface Cluster {
  /** Участники кластера. */
  members: ClusterMember[];
}

/** План слияния: канон и факты, которые ему уступают. */
interface MergePlan {
  /** Канон кластера (остаётся активным). */
  canon: ClusterMember;
  /** Остальные участники кластера (будут помечены заменёнными). */
  superseded: ClusterMember[];
  /** Минимальный косинус «канон ↔ слитый факт» по кластеру. */
  similarity: number;
}

/** Пустой отчёт (фактов нечего сливать). */
function emptyReport(kept: number): ConsolidateReport {
  return { clusters: 0, superseded: 0, kept, items: [] };
}

/** Округление похожести — в отчёте достаточно четырёх знаков. */
function roundSimilarity(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

/**
 * Порядок выбора канона: выше `confidence` → длиннее текст → свежее
 * `updatedAt` → меньше `id`.
 *
 * Строго заданный порядок — прогон должен быть воспроизводим: тот же вход →
 * тот же канон → тот же отчёт.
 */
function compareCanon(a: ClusterMember, b: ClusterMember): number {
  if (b.fact.confidence !== a.fact.confidence) return b.fact.confidence - a.fact.confidence;
  const lengthA = a.fact.text.length;
  const lengthB = b.fact.text.length;
  if (lengthA !== lengthB) return lengthB - lengthA;
  const byUpdated = Date.parse(b.fact.updatedAt) - Date.parse(a.fact.updatedAt);
  if (!Number.isNaN(byUpdated) && byUpdated !== 0) return byUpdated;
  return a.fact.id.localeCompare(b.fact.id);
}

/**
 * Жадная кластеризация: для каждого факта — уже открытый кластер с
 * максимальной похожестью ≥ порога; подходящего нет — новый кластер.
 *
 * Похожесть факта с кластером — максимум по его участникам (уже присоединённым
 * фактам). При равенстве похожести выигрывает **самый ранний** открытый
 * кластер (порядок обхода фиксирован) — результат детерминирован.
 */
function clusterFacts(members: readonly ClusterMember[], threshold: number): Cluster[] {
  const clusters: Cluster[] = [];
  for (const member of members) {
    let bestIndex = -1;
    let bestSimilarity = Number.NEGATIVE_INFINITY;
    for (let index = 0; index < clusters.length; index += 1) {
      const cluster = clusters[index]!;
      let similarity = Number.NEGATIVE_INFINITY;
      for (const other of cluster.members) {
        const value = cosine(member.vector, other.vector);
        if (value > similarity) similarity = value;
      }
      if (similarity > bestSimilarity) {
        bestSimilarity = similarity;
        bestIndex = index;
      }
    }
    if (bestIndex >= 0 && bestSimilarity >= threshold) {
      clusters[bestIndex]!.members.push(member);
    } else {
      clusters.push({ members: [member] });
    }
  }
  return clusters;
}

/** План слияния для кластера (пустой — если сливать нечего). */
function planForCluster(cluster: Cluster): MergePlan | null {
  if (cluster.members.length < 2) return null;
  const canon = [...cluster.members].sort(compareCanon)[0]!;
  const superseded = cluster.members
    .filter((member) => member.fact.id !== canon.fact.id)
    .sort((a, b) => a.fact.id.localeCompare(b.fact.id));
  // Похожесть кластера — **самая слабая пара** «канон ↔ слитый факт»: отчёт
  // показывает, насколько уверенно факты лежат рядом (жадная кластеризация
  // могла присоединить факт через промежуточный, а не через канон).
  let similarity = 1;
  for (const member of superseded) {
    const value = cosine(canon.vector, member.vector);
    if (value < similarity) similarity = value;
  }
  return { canon, superseded, similarity };
}

/**
 * Консолидация фактов памяти.
 *
 * Порядок работы: прочитать активные факты скоупа → посчитать эмбеддинги →
 * разложить по кластерам → составить план → применить план (если не
 * `dryRun`). Эмбеддинги считаются **до** любых записей: ошибка провайдера
 * эмбеддингов не должна оставить память изменённой наполовину.
 */
export async function consolidateFacts(
  deps: ConsolidateDeps,
  options: ConsolidateOptions = {},
): Promise<ConsolidateReport> {
  const { provider } = deps;
  // Порог: аргумент → настройка плагина. Значение вне допустимых границ
  // приводится к границе (fail-soft, как и остальные настройки плагина):
  // слишком низкий порог слил бы несвязанные утверждения.
  const settings = provider.settings();
  const threshold = clampNumber(
    options.threshold ?? settings.consolidateThreshold,
    MIN_CONSOLIDATE_THRESHOLD,
    MAX_CONSOLIDATE_THRESHOLD,
    settings.consolidateThreshold,
  );

  const facts = await provider.listFacts({
    status: 'active',
    limit: CONSOLIDATE_FACT_LIMIT,
    ...(options.projectId ? { projectId: options.projectId } : {}),
  });

  // Фактов меньше двух — сливать нечего (пустой отчёт, не ошибка).
  if (facts.length < 2) return emptyReport(facts.length);

  // Детерминированный порядок: порт отдаёт «свежие первыми», но кластеризация
  // не должна зависеть от порядка выдачи — порядок по id.
  const ordered = [...facts].sort((a, b) => a.id.localeCompare(b.id));

  // Эмбеддинги — батчами (движок эмбеддера режет по лимитам фасада).
  // Ошибка фасада пробрасывается как есть (до любых записей).
  const vectors = await provider.embed(ordered.map((fact) => fact.text));
  if (vectors.length !== ordered.length) {
    throw new ConsolidationError(
      `Эмбеддинги вернули ${vectors.length} векторов на ${ordered.length} фактов — консолидация прервана`,
    );
  }

  const members: ClusterMember[] = ordered.map((fact, index) => ({
    fact,
    vector: vectors[index] ?? [],
  }));

  const plans = clusterFacts(members, threshold)
    .map((cluster) => planForCluster(cluster))
    .filter((plan): plan is MergePlan => plan !== null)
    .sort((a, b) => {
      if (b.similarity !== a.similarity) return b.similarity - a.similarity;
      return a.canon.fact.id.localeCompare(b.canon.fact.id);
    });

  const supersededCount = plans.reduce((sum, plan) => sum + plan.superseded.length, 0);
  const report: ConsolidateReport = {
    clusters: plans.length,
    superseded: supersededCount,
    kept: facts.length - supersededCount,
    items: plans.slice(0, CONSOLIDATE_ITEMS_LIMIT).map((plan) => ({
      keptId: plan.canon.fact.id,
      supersededIds: plan.superseded.map((member) => member.fact.id),
      similarity: roundSimilarity(plan.similarity),
    })),
  };

  // Пробный прогон — только отчёт, память не трогаем.
  if (options.dryRun) return report;

  for (const plan of plans) {
    for (const member of plan.superseded) {
      const ok = await provider.supersede(member.fact.id, plan.canon.fact.id);
      if (!ok) {
        throw new ConsolidationError(
          `Не удалось пометить факт ${member.fact.id} как заменённый — консолидация прервана`,
        );
      }
    }
    // Канон: текст и версия не меняются — меняется только метаданные
    // (список слитых фактов). Версия факта растёт только при смене текста.
    // Канон перечитывается перед записью: параллельная правка (замена
    // текста, отзыв) не должна быть затёрта снимком из плана.
    const canon = await provider.getFact(plan.canon.fact.id);
    if (!canon) continue;
    const merged = plan.superseded.map((member) => member.fact.id);
    const previous = Array.isArray(canon.metadata?.consolidatedFrom)
      ? canon.metadata.consolidatedFrom.filter((id): id is string => typeof id === 'string')
      : [];
    const consolidatedFrom = [...new Set([...previous, ...merged])].sort();
    await provider.save({
      ...canon,
      metadata: { ...(canon.metadata ?? {}), consolidatedFrom },
    });
  }

  return report;
}
