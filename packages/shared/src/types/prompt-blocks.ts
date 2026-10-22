/**
 * PROP-090 §«Точка `promptBlocks`»: контракт провайдера блока системного
 * промпта.
 *
 * Модуль browser-safe (только типы и чистые функции) — его используют и ядро
 * (`SystemPromptComposer`), и будущий пакет `@itphx/synth-plugin`.
 *
 * **Граница prompt-cache.** Тир `stable` провайдеру **запрещён**: `stablePrefix`
 * — склейка только stable-блоков (ADR-070 §2.1), а плагинный блок в `stable`
 * ломал бы prompt-cache и инвалидировал бы префикс на каждой сборке. Поэтому
 * тир провайдера ограничен `context|volatile` **на уровне типа**, а не только
 * проверкой в рантайме.
 *
 * **Контекст — узкий.** Провайдер получает DTO (`PromptBlockContext`), а не
 * историю сессии: иначе контракт перестаёт быть сериализуемым (PROP-090 §7) и
 * провайдер получал бы весь диалог вместо вопроса хода.
 */
import type { PromptManifestStatus } from './prompt.js';

/**
 * Тиры блока, доступные провайдеру точки `promptBlocks`.
 *
 * `stable` **не входит** — см. шапку модуля (граница prompt-cache, ADR-070).
 */
export const PROMPT_BLOCK_PROVIDER_TIERS = ['context', 'volatile'] as const;
export type PromptBlockProviderTier = (typeof PROMPT_BLOCK_PROVIDER_TIERS)[number];

/**
 * Префикс ключа блока, зарегистрированного плагином: `plugin.<pluginName>.<slot>`.
 *
 * По префиксу видно источник блока (в манифесте промпта и в состоянии
 * промпта) без отдельного реестра.
 */
export const PLUGIN_PROMPT_BLOCK_KEY_PREFIX = 'plugin.';

/**
 * Бюджет символов одного блока промпта по умолчанию (`plugins.promptBlockMaxChars`).
 *
 * Единый источник истины для конфига (`config/defaults.ts`) и для хоста
 * (обрезка блока, когда провайдер не уложился в бюджет).
 */
export const DEFAULT_PROMPT_BLOCK_MAX_CHARS = 4000;

/**
 * Контекст вызова провайдера блока (узкий DTO — без портов и функций).
 *
 * Все «ходовые» поля **опциональные**: шаг пайплайна (ADR-101) и саб-агент
 * (`task`) работают с суженным контрактом, и «вопроса хода» у них нет.
 */
export interface PromptBlockContext {
  /** Идентификатор сессии (для шага пайплайна — `pipeline:<runId>:<nodeId>`). */
  readonly sessionId: string;
  /** Эффективная роль агента. */
  readonly agentRole: string;
  /** Язык сессии (`ru`/`en`). */
  readonly language: string;
  /** Проект сессии (не задан — сессия без проекта, ADR-040). */
  readonly projectId?: string;
  /** Режим сессии (ADR-025). */
  readonly mode: 'plan' | 'act' | 'yolo';
  /**
   * Текст последнего сообщения пользователя — «вопрос хода», по которому идёт
   * retrieval. Не задан — вопроса хода нет (шаг пайплайна, саб-агент).
   */
  readonly query?: string;
  /** Идентификатор хода (`streamId`) — для мемоизации/кэша провайдера. */
  readonly turnId?: string;
  /** Метка времени хода (ISO 8601) — для оценки «свежести» фактов. */
  readonly timestamp?: string;
}

/**
 * Содержимое блока, возвращаемое провайдером (расширенная форма).
 *
 * `provenance` — источник блока (для плагина — `plugin:<name>`), `status` —
 * статус манифеста (`loaded`/`empty`/`truncated`).
 */
export interface PromptBlockContent {
  content: string;
  provenance?: string;
  status?: PromptManifestStatus;
}

/**
 * Провайдер блока системного промпта (точка расширения `promptBlocks`).
 *
 * Провайдер вызывается **раз в ход** при сборке промпта (`compose()`) и при
 * построении манифеста (`manifest()`).
 */
export interface PromptBlockProvider {
  /**
   * Ключ блока. Уникален в инстансе; для плагина — `plugin.<pluginName>.<slot>`.
   */
  readonly key: string;
  /** Тир блока: только `context`/`volatile` (`stable` запрещён). */
  readonly tier: PromptBlockProviderTier;
  /** Порядок внутри тира (для плагинов рекомендуется `>= 100`). */
  readonly order: number;
  /** Человекочитаемая подпись для манифеста промпта. */
  readonly title?: string;
  /**
   * Содержимое блока. `null`/`''` — блок пуст (`status: 'empty'`, в промпт
   * не попадает). Ошибка провайдера деградирует: блок пустой, ход не падает.
   */
  load(
    ctx: PromptBlockContext,
  ): Promise<PromptBlockContent | string | null> | PromptBlockContent | string | null;
}

/** Ключ блока относится к плагину (по префиксу `plugin.`). */
export function isPluginPromptBlockKey(key: string): boolean {
  return key.startsWith(PLUGIN_PROMPT_BLOCK_KEY_PREFIX);
}
