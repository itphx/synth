/**
 * Типы микро-слоя (ADR-035).
 * Реэкспортирует базовые типы из @itphx/synth-shared, добавляет внутренние.
 */
import type { SessionSettings, TokenUsage } from '@itphx/synth-shared';

/**
 * Вид микро-модели: правила, embedding, decision-модель (ADR-084),
 * локальная LLM.
 */
export type MicroModelKind = 'rules' | 'embedding' | 'decision' | 'micro_llm';

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
  /** PROP-085 задел: изображения текущего хода (для decision-модели). */
  images?: string[];
  /** PROP-085 задел: видео текущего хода (для decision-модели). */
  videos?: string[];
}

/** Результат работы микро-слоя. */
export interface MicroResult {
  status: MicroStatus;
  taskClass: MicroTaskClass;
  label?: string;
  confidence: number; // 0-1
  answer?: string; // готовый ответ (если OK)
  /** Ключ SystemMessages для локализации ответа на UI (metadata.i18n). */
  i18nKey?: string;
  /** ADR-102: usage **ответившего** вызова (при `OK`). */
  usage?: TokenUsage;
  /** ADR-102: usage прочих опрошенных вызовов (отклонённые/UNSURE). */
  auxUsage?: TokenUsage;
  latencyMs: number;
  signals: string[]; // что сработало
}

/** Результат работы MicroPipeline. */
export interface PipelineResult {
  microResult: MicroResult | null;
  handled: boolean; // true если OK и НЕ надо звать LLM
  fallbackSignals?: string[];
  /** ADR-102: суммарный aux-usage всех опрошенных, но не ответивших вызовов. */
  auxUsage?: TokenUsage;
}
