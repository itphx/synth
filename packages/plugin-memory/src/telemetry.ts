/**
 * Телеметрия recall/search-запросов памяти (ADR-107) — вспомогательный модуль
 * плагина.
 *
 * Плагин **только сообщает** хосту: вид запроса, исход, число найденных
 * фрагментов и длительность. Метрики (`synth_memory_recall_*`) ведёт хост
 * (ADR-094) — здесь ни реестра, ни зависимостей.
 *
 * Содержимое выдачи памяти наружу не уходит: только счётчики.
 */
import type { PluginFacade } from '@itphx/synth-core';

/**
 * Вход телеметрии памяти — контракт фасада (`facade.memoryTelemetry`).
 *
 * Тип выводится из фасада, чтобы плагин не дублировал контракт ядра: смена
 * контракта в ядре ломает сборку плагина, а не молча типизирует расхождение.
 */
export type MemoryTelemetryInput = Parameters<
  NonNullable<PluginFacade['memoryTelemetry']>
>[0];

/** Начать замер длительности (монотонное время, мс). */
export function startTimer(): number {
  return performance.now();
}

/**
 * Длительность с момента старта замера, мс.
 *
 * Целое неотрицательное число: метрики ждут «мс» (не дробные секунды), а
 * часы иногда идут назад — такое значение приводим к нулю.
 */
export function elapsedMs(startedAt: number): number {
  return Math.max(0, Math.round(performance.now() - startedAt));
}
