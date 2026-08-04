/**
 * Интерфейс микро-модели (AD-035).
 * Единый контракт для всех вариантов: rules, embedding, micro_llm.
 */
import type { MicroInput, MicroModelKind, MicroResult, MicroTaskClass } from '../types.js';

export interface MicroModel {
  /** Вид модели: rules | embedding | micro_llm. */
  readonly kind: MicroModelKind;

  /** Человекочитаемое имя для логов/метрик. */
  readonly name: string;

  /**
   * Обрабатывает запрос. Возвращает OK если уверен, UNSURE если нужен следующий уровень.
   */
  handle(input: MicroInput, taskClass: MicroTaskClass): Promise<MicroResult>;

  /** Может ли эта модель обработать данный класс задачи? */
  canHandle(taskClass: MicroTaskClass): boolean;
}
