/**
 * Параллельное исполнение батча вызовов инструментов (PROP-127, этап T1).
 *
 * Три цикла шага (оркестратор, цикл саб-агента, агентский шаг пайплайна) нуждаются
 * в одном и том же примитиве: запустить вызовы **одновременно**, вернуть результаты
 * в порядке вызовов модели и не ронять батч из-за одного упавшего вызова.
 *
 * Инварианты модуля:
 * - **Конкурентность**: все исполнители стартуют до завершения первого. Иначе
 *   «параллельный» батч — это последовательный цикл с `await` внутри.
 * - **Порядок результатов = порядок вызовов модели**: слот исхода — по исходной
 *   позиции вызова, а не по порядку завершения. Порядок завершения виден отдельно
 *   (`settleOrder`) — по нему публикуются события по мере готовности.
 * - **Изоляция ошибок**: исключение (или отказ промиса) одного вызова даёт
 *   `ok: false` в его слоте; остальные вызовы доходят до конца, батч не
 *   отклоняется целиком.
 * - **Нет unhandled rejection**: обработчик отказа цепляется синхронно, в том же
 *   проходе, где вызов стартовал, поэтому отказ не всплывает наружу как
 *   необработанный.
 *
 * Модуль чистый: без состояния, без зависимостей, без строк для пользователя
 * (тексты ошибок тулов собирает вызывающий — ADR-041).
 */

/** Описание одного вызова в батче. */
export interface ToolBatchItem<T> {
  /** Стабильный id вызова (диагностика/трейс; результат привязывается к нему). */
  readonly id: string;
  /** Исполнение вызова. Бросок перехватывается батчем и не роняет остальные. */
  readonly run: () => Promise<T>;
}

/** Исход одного вызова: успех или изолированная ошибка. */
export type ToolBatchOutcome<T> =
  | { readonly ok: true; readonly id: string; readonly value: T }
  | { readonly ok: false; readonly id: string; readonly error: unknown };

/** Опции батча. */
export interface ToolBatchOptions<T> {
  /**
   * Колбэк завершения вызова — вызывается в порядке завершения, сразу после
   * фиксации исхода.
   *
   * Нужен там, где результат публикуется по мере готовности (события шага),
   * а не после завершения всего батча. Ошибка колбэка не влияет на батч:
   * это наблюдение, а не часть исполнения.
   */
  readonly onSettled?: (outcome: ToolBatchOutcome<T>) => void;
}

/** Результат батча. */
export interface ToolBatchResult<T> {
  /** Исходы в порядке входных вызовов (`outcomes[i]` соответствует `items[i]`). */
  readonly outcomes: ReadonlyArray<ToolBatchOutcome<T>>;
  /** Индексы вызовов в порядке их завершения (диагностика/события). */
  readonly settleOrder: ReadonlyArray<number>;
  /** Число упавших вызовов. */
  readonly errorCount: number;
}

/**
 * Исполняет батч вызовов параллельно и возвращает исходы в порядке входных
 * вызовов.
 *
 * Порядок завершения не влияет на порядок результатов: слот заводится по
 * исходной позиции вызова. Это то, что требует провайдерский контракт: один
 * `tool`-результат на каждый `tool_call`, иначе следующий запрос модели падает.
 *
 * Батч **не отклоняется**: ошибка вызова — это `ok: false` в его слоте.
 */
export async function runToolBatch<T>(
  items: readonly ToolBatchItem<T>[],
  options: ToolBatchOptions<T> = {},
): Promise<ToolBatchResult<T>> {
  const outcomes: ToolBatchOutcome<T>[] = new Array<ToolBatchOutcome<T>>(items.length);
  const settleOrder: number[] = [];
  let errorCount = 0;

  /** Фиксация исхода: слот — по исходной позиции вызова в батче. */
  const settle = (index: number, outcome: ToolBatchOutcome<T>): void => {
    outcomes[index] = outcome;
    settleOrder.push(index);
    if (!outcome.ok) errorCount++;
    try {
      options.onSettled?.(outcome);
    } catch {
      // Колбэк — наблюдение: его падение не должно ломать исполнение батча.
    }
  };

  await Promise.all(
    items.map((item, index) => {
      // Вызов стартует СИНХРОННО в этом проходе: все исполнители поднимаются
      // до того, как завершится первый. Обработчики отказа цепляются здесь же,
      // поэтому отказ промиса не становится unhandled rejection.
      let started: Promise<T>;
      try {
        started = Promise.resolve(item.run());
      } catch (error) {
        // Синхронный бросок — тот же исход, что и отказ промиса.
        settle(index, { ok: false, id: item.id, error });
        return Promise.resolve();
      }
      return started.then(
        (value) => {
          settle(index, { ok: true, id: item.id, value });
        },
        (error) => {
          settle(index, { ok: false, id: item.id, error });
        },
      );
    }),
  );

  return { outcomes, settleOrder, errorCount };
}

/**
 * Значения успешных вызовов в порядке батча.
 *
 * Удобно, когда батч целиком успешен. Если часть вызовов упала, соответствие
 * позициям теряется — для привязки к конкретному вызову используйте `outcomes`.
 */
export function toolBatchValues<T>(outcomes: readonly ToolBatchOutcome<T>[]): T[] {
  const values: T[] = [];
  for (const outcome of outcomes) {
    if (outcome.ok) values.push(outcome.value);
  }
  return values;
}

/**
 * Упавшие вызовы батча: id и ошибка — для сводной диагностики шага.
 */
export function toolBatchFailures<T>(
  outcomes: readonly ToolBatchOutcome<T>[],
): Array<{ id: string; error: unknown }> {
  const failures: Array<{ id: string; error: unknown }> = [];
  for (const outcome of outcomes) {
    if (!outcome.ok) failures.push({ id: outcome.id, error: outcome.error });
  }
  return failures;
}
