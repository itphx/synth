/**
 * Подсистема роутинга моделей (ADR-034, ADR-035).
 * Реэкспорт всех публичных классов и типов.
 */

export { ContentClassifier } from './content-classifier.js';
export type { ContentCategory, ClassifyRequest, ClassifyResult } from './content-classifier.js';

export { DecisionContentClassifier, DECISION_CATEGORY_QUESTION_ID } from './decision-content-classifier.js';

export { DictionaryStore, DICTIONARY_LANGUAGES } from './dictionary-store.js';
export type { StoredDictionary, DictionaryLanguage } from './dictionary-store.js';

export { ProviderPool } from './provider-pool.js';

export { QualityChecker } from './quality-checker.js';
export type { QualityCheckInput, QualityCheckResult } from './quality-checker.js';

export { ModelRouter } from './router.js';
export type { RoutingRequest, RoutingDecision } from './router.js';

export { toCoreProviderConfig } from './utils.js';

// Micro-first (ADR-035)
export { MicroPipeline } from './micro/index.js';
export type { MicroInput, MicroResult, MicroStatus, MicroTaskClass, PipelineResult } from './micro/types.js';
export { TaskClassifier } from './micro/task-classifier.js';
export type { ClassifyOut } from './micro/task-classifier.js';
export { RulesModel, EmbeddingModel, MicroLlmModel } from './micro/models/index.js';
export type { MicroModel } from './micro/models/base.js';
export type { MicroLlmConfig } from './micro/models/micro-llm-model.js';
