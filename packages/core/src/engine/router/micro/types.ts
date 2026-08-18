/**
 * Типы микро-слоя (AD-035).
 * Реэкспортирует базовые типы из @itphx/synth-shared, добавляет внутренние.
 */
import type { SessionSettings } from '@itphx/synth-shared';

/** Вид микро-модели: правила, embedding, локальная LLM. */
export type MicroModelKind = 'rules' | 'embedding' | 'micro_llm';

/** Класс задачи после классификации. */
export type MicroTaskClass = 'small_talk' | 'classify' | 'enum_decision' | 'llm_task';

/** Статус уверенности микро-модели. */
export type MicroStatus = 'OK' | 'UNSURE';

/** Входные данные для микро-слоя. */
export interface MicroInput {
  userMessage: string;
  language?: string;
  sessionSettings: SessionSettings;
  /** Провайдер для embedding-модели (из session.settings). */
  embedProvider?: string;
  /** Модель для embedding (из session.settings). */
  embedModel?: string;
}

/** Результат работы микро-слоя. */
export interface MicroResult {
  status: MicroStatus;
  taskClass: MicroTaskClass;
  label?: string;
  confidence: number; // 0-1
  answer?: string; // готовый ответ (если OK)
  usage?: {
    inputTokens: number;
    outputTokens: number;
  };
  latencyMs: number;
  signals: string[]; // что сработало
}

/** Результат работы MicroPipeline. */
export interface PipelineResult {
  microResult: MicroResult | null;
  handled: boolean; // true если OK и НЕ надо звать LLM
  fallbackSignals?: string[];
}
