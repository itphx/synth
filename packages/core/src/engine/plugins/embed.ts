/**
 * ADR-090 (WP-F): сервис эмбеддингов фасада (`facade.embed`).
 *
 * Плагин не дёргает провайдера сам (инвариант 3: любой LLM-вызов — через
 * `GatewayProvider`). Хост получает **инъецированную** функцию
 * (`PluginEmbedFn`), собранную в точке сборки приложения
 * (`server/app/deps.ts`/`backend/app/deps.ts`): там провайдер создаётся и
 * оборачивается в `GatewayProvider` — тем же путём, что и остальные
 * LLM-вызовы (guard, обфускация, rate-limit, аудит, embedding-фаза фильтров
 * `llmFilters`).
 *
 * Здесь — только политика вызова:
 *
 * - **лимиты** (защита от злоупотребления): не более
 *   {@link MAX_PLUGIN_EMBED_BATCH} текстов за вызов, не более
 *   {@link MAX_PLUGIN_EMBED_TEXT_CHARS} символов в одном тексте и не более
 *   {@link MAX_PLUGIN_EMBED_TOTAL_CHARS} символов суммарно; превышение →
 *   `plugin.embed_limit`;
 * - **провайдер/модель**: `opts` перекрывают конфиг инстанца
 *   (`plugins.embeddingProvider`/`plugins.embeddingModel`) по каждому полю
 *   отдельно; провайдера нет → `plugin.embedding_not_configured`;
 * - **валидация результата**: векторов должно быть столько же, сколько
 *   текстов, и все векторы — одной длины; иначе `plugin.embed_invalid_result`.
 *
 * Ошибки провайдера **не глотаются** — они пробрасываются как есть: плагин
 * видит причину (секретов в текстах нет — gateway это обеспечивает).
 */
import type { PluginsConfig } from '@itphx/synth-shared';

import {
  PluginFacadeError,
  type PluginEmbedFn,
  type PluginEmbedOptions,
} from './activation.js';

/** Максимум текстов за один вызов эмбеддингов. */
export const MAX_PLUGIN_EMBED_BATCH = 64;

/** Максимум символов в одном тексте эмбеддинга. */
export const MAX_PLUGIN_EMBED_TEXT_CHARS = 8_000;

/** Максимум символов суммарно за один вызов эмбеддингов. */
export const MAX_PLUGIN_EMBED_TOTAL_CHARS = 64_000;

/** Параметры сборки сервиса эмбеддингов фасада. */
export interface PluginEmbedServiceOptions {
  /** Имя плагина (только для текстов ошибок). */
  plugin: string;
  /** Эффективная конфигурация слоя плагинов (провайдер/модель по умолчанию). */
  config: PluginsConfig;
  /** Инъецированная функция эмбеддингов (нет — сервис недоступен). */
  embed?: PluginEmbedFn;
}

/**
 * Собрать метод фасада `embed`.
 *
 * Метод **всегда** присутствует в фасаде: если сервис не сконфигурирован, он
 * бросает ошибку с кодом (`plugin.embedding_not_configured`/
 * `plugin.embed_unavailable`) — хост при этом не падает, решает плагин.
 */
export function createPluginEmbedService(
  options: PluginEmbedServiceOptions,
): (texts: readonly string[], opts?: PluginEmbedOptions) => Promise<number[][]> {
  const { plugin, config, embed } = options;

  return async (texts, opts) => {
    const list = [...texts];

    // ── Лимиты (до обращения к провайдеру) ─────────────────────────────
    if (list.length > MAX_PLUGIN_EMBED_BATCH) {
      throw new PluginFacadeError(
        'plugin.embed_limit',
        `Плагин «${plugin}»: за один вызов эмбеддингов не более ${MAX_PLUGIN_EMBED_BATCH} текстов ` +
          `(передано ${list.length}).`,
      );
    }
    let total = 0;
    for (const [index, text] of list.entries()) {
      if (text.length > MAX_PLUGIN_EMBED_TEXT_CHARS) {
        throw new PluginFacadeError(
          'plugin.embed_limit',
          `Плагин «${plugin}»: текст #${index} длиннее ${MAX_PLUGIN_EMBED_TEXT_CHARS} символов ` +
            `(${text.length}).`,
        );
      }
      total += text.length;
    }
    if (total > MAX_PLUGIN_EMBED_TOTAL_CHARS) {
      throw new PluginFacadeError(
        'plugin.embed_limit',
        `Плагин «${plugin}»: суммарный объём текстов превышает ${MAX_PLUGIN_EMBED_TOTAL_CHARS} символов ` +
          `(${total}).`,
      );
    }
    // Пустой запрос — без обращения к провайдеру.
    if (list.length === 0) return [];

    // ── Сервис эмбеддингов доступен? ──────────────────────────────────
    if (!embed) {
      throw new PluginFacadeError(
        'plugin.embed_unavailable',
        `Плагин «${plugin}»: сервис эмбеддингов недоступен в этом инстансе.`,
      );
    }

    // ── Провайдер/модель: opts перекрывают конфиг (по полям) ──────────
    const provider = opts?.provider?.trim() || config.embeddingProvider?.trim() || '';
    const model = opts?.model?.trim() || config.embeddingModel?.trim() || '';
    if (!provider) {
      throw new PluginFacadeError(
        'plugin.embedding_not_configured',
        `Плагин «${plugin}»: эмбеддинги не сконфигурированы — задайте ` +
          'plugins.embeddingProvider (или передайте провайдера в вызове).',
      );
    }

    // ── Вызов (ошибки провайдера пробрасываются как есть) ──────────────
    const vectors = await embed(list, { provider, model });

    // ── Валидация результата ───────────────────────────────────────────
    if (!Array.isArray(vectors) || vectors.length !== list.length) {
      throw new PluginFacadeError(
        'plugin.embed_invalid_result',
        `Плагин «${plugin}»: провайдер вернул ${Array.isArray(vectors) ? vectors.length : 0} векторов ` +
          `вместо ${list.length}.`,
      );
    }
    const dimension = vectors[0]?.length ?? 0;
    for (const [index, vector] of vectors.entries()) {
      if (!Array.isArray(vector) || vector.length !== dimension) {
        throw new PluginFacadeError(
          'plugin.embed_invalid_result',
          `Плагин «${plugin}»: вектор #${index} имеет длину ` +
            `${Array.isArray(vector) ? vector.length : 0}, ожидалась ${dimension} — ` +
            'все векторы должны быть одной длины.',
        );
      }
    }
    return vectors.map((vector) => [...vector]);
  };
}
