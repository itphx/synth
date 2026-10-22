/**
 * PROP-090 §«Два режима исполнения» → «`out-of-process`»: wire-протокол плагина.
 *
 * Транспорт — HTTP/1.1 + JSON по образцу исполнителя
 * (`packages/executor/src/protocol.ts`, ADR-077): `POST /invoke` (вызов точки
 * расширения), `GET /capabilities` (что процесс умеет + версия протокола),
 * `GET /health` (без токена — процесс жив).
 *
 * **Где живёт контракт.** Решение владельца (2026-10-22): контракт протокола —
 * в `@itphx/synth-shared`, отдельный пакет `@itphx/synth-plugin-protocol`
 * **не создаётся**. Модуль browser-safe: только типы, константы и чистые
 * функции (без `node:*` и без `zod`).
 *
 * **Что пересекает границу.** Только сериализуемые DTO: вход/выход точек
 * `promptBlocks` (`PromptBlockContext` → `PromptBlockContent`) и `llmFilters`
 * (`LlmFilterInput` → `LlmFilterVerdict`). Порты хранилища, реестры ядра и
 * `GatewayProvider` наружу не отдаются (PROP-090 §«Что пересекает границу»).
 *
 * **Чего в протоколе нет (волна Ф4б-1).** Точки `tools` — её транспорт
 * появится в Ф4б-3; запуск/остановка процесса и файл токена — Ф4б-2.
 */
import { isLlmFilterFailMode, isLlmFilterPhase } from './llm-filters.js';
import type { LlmFilterFailMode, LlmFilterPhase } from './llm-filters.js';
import type { PromptManifestStatus } from './prompt.js';

/** Версия wire-протокола плагина (аналог `EXECUTOR_PROTOCOL_VERSION`). */
export const PLUGIN_PROTOCOL_VERSION = 1;

/** Пути эндпоинтов протокола (относительно базового адреса процесса). */
export const PLUGIN_PROTOCOL_PATHS = {
  /** `POST` — вызов точки расширения. */
  invoke: '/invoke',
  /** `GET` — список поддерживаемых точек + версия протокола. */
  capabilities: '/capabilities',
  /** `GET` — процесс жив (без токена). */
  health: '/health',
} as const;

/**
 * Точки, передаваемые по протоколу.
 *
 * В этой волне — только `promptBlocks` и `llmFilters`; `tools` появится
 * вместе с транспортом инструментов (Ф4б-3). Плагин, объявивший
 * `provides.tools` при `mode: 'remote'`, будет отклонён сверкой `provides`
 * (`plugin.provides_mismatch`) — это ожидаемое поведение до Ф4б-3.
 */
export const PLUGIN_PROTOCOL_POINTS = ['promptBlocks', 'llmFilters'] as const;
export type PluginProtocolPoint = (typeof PLUGIN_PROTOCOL_POINTS)[number];

/** Описание плагинного блока промпта в `/capabilities`. */
export interface PluginCapabilitiesPromptBlock {
  /** Ключ блока (`plugin.<pluginName>.<slot>`). */
  key: string;
  /** Тир блока: `stable` запрещён (граница prompt-cache, ADR-070). */
  tier: 'context' | 'volatile';
  /** Порядок внутри тира. */
  order: number;
  /** Подпись блока для манифеста промпта. */
  title?: string;
}

/** Описание фильтра LLM-вызовов в `/capabilities`. */
export interface PluginCapabilitiesLlmFilter {
  /** Идентификатор фильтра (`plugin:<pluginName>:<filterName>`). */
  id: string;
  /** Фаза вызова фильтра. */
  phase: LlmFilterPhase;
  /** Поведение при сбое/таймауте (не задано — по классу фильтра). */
  failMode?: LlmFilterFailMode;
  /** Бюджет времени на вызов фильтра, мс. */
  timeoutMs?: number;
}

/** Ответ `GET /capabilities`: версия протокола + поддерживаемые точки. */
export interface PluginCapabilities {
  /** Версия wire-протокола (`PLUGIN_PROTOCOL_VERSION`). */
  protocol: number;
  /** Имя плагина (сверяется с ожидаемым — процесс обязан быть тем же плагином). */
  name: string;
  /** Версия плагина (сверяется с ожидаемой). */
  version: string;
  /** Поддерживаемые точки расширения. */
  points: {
    promptBlocks?: PluginCapabilitiesPromptBlock[];
    llmFilters?: PluginCapabilitiesLlmFilter[];
  };
}

/** Тело запроса `POST /invoke`. */
export interface PluginInvokeRequest {
  /** Версия wire-протокола. */
  protocol: number;
  /** Точка расширения. */
  point: PluginProtocolPoint;
  /** `promptBlocks` — ключ блока; `llmFilters` — id фильтра. */
  id: string;
  /** Вход точки: `PromptBlockContext` | `LlmFilterInput` (валидирует плагин). */
  input: unknown;
}

/**
 * Тело успешного ответа `POST /invoke`.
 *
 * `output` — `PromptBlockContent` (или строка) для `promptBlocks`,
 * `LlmFilterVerdict` для `llmFilters`.
 */
export type PluginInvokeResponse =
  | { ok: true; output: unknown }
  | { ok: false; error: PluginProtocolError };

/** Ошибка протокола в теле ответа (`{ error: { reason, code?, message? } }`). */
export interface PluginProtocolError {
  /** Машиночитаемая причина. */
  reason: PluginProtocolErrorReason;
  /** Код плагина (свободная строка, в журнал не пишется). */
  code?: string;
  /** Человекочитаемое сообщение (без секретов). */
  message?: string;
}

/** Причины отказа протокола. */
export const PLUGIN_PROTOCOL_ERROR_REASONS = [
  /** Тело запроса невалидно (не JSON-объект, нет полей, неверные типы). */
  'invalid_request',
  /** Точка расширения не поддерживается процессом. */
  'unknown_point',
  /** Точка поддерживается, но запрошенного блока/фильтра в ней нет. */
  'unknown_id',
  /** Нет или неверный bearer-токен. */
  'unauthorized',
  /** Процесс не ответил в бюджет времени. */
  'timeout',
  /** Прочие ошибки процесса/плагина. */
  'internal_error',
  /** Версия протокола или идентичность плагина (имя/версия) не совпали. */
  'protocol_mismatch',
] as const;
export type PluginProtocolErrorReason = (typeof PLUGIN_PROTOCOL_ERROR_REASONS)[number];

/**
 * HTTP-код ответа по причине отказа (как в исполнителе, ADR-077).
 *
 * - `400` — некорректный запрос, неизвестная точка/версия протокола;
 * - `401` — нет/неверный токен;
 * - `404` — неизвестный блок/фильтр;
 * - `500` — таймаут и прочие ошибки процесса.
 */
export const PLUGIN_PROTOCOL_ERROR_STATUS: Record<PluginProtocolErrorReason, number> = {
  invalid_request: 400,
  unknown_point: 400,
  unknown_id: 404,
  unauthorized: 401,
  timeout: 500,
  internal_error: 500,
  protocol_mismatch: 400,
};

/** Значение — известная причина отказа протокола. */
export function isPluginProtocolErrorReason(value: unknown): value is PluginProtocolErrorReason {
  return (PLUGIN_PROTOCOL_ERROR_REASONS as readonly unknown[]).includes(value);
}

/** Значение — известная точка протокола. */
export function isPluginProtocolPoint(value: unknown): value is PluginProtocolPoint {
  return (PLUGIN_PROTOCOL_POINTS as readonly unknown[]).includes(value);
}

/** Статусы блока промпта, допустимые в ответе провайдера (`PromptManifestStatus`). */
const PROMPT_BLOCK_STATUSES: readonly PromptManifestStatus[] = [
  'loaded',
  'truncated',
  'empty',
  'blocked',
  'suppressed',
];

/** Предел символов содержимого блока в ответе (защита от «случайного» мегабайта). */
export const PLUGIN_PROTOCOL_MAX_PROMPT_BLOCK_CHARS = 64 * 1024;

/** Итог проверки ответа `/capabilities`. */
export type PluginCapabilitiesCheck =
  | { ok: true; capabilities: PluginCapabilities }
  | { ok: false; reason: PluginProtocolErrorReason; message: string };

/**
 * Проверить ответ `GET /capabilities`.
 *
 * **Fail-closed:** мусор в ответе, чужая версия протокола и чужой плагин
 * (имя/версия) — отказ. Успех возвращает **нормализованный** снимок: только
 * известные поля, проверенные типы, без дублей ключей/идентификаторов.
 *
 * @param payload — распарсенное тело ответа (неизвестной формы).
 * @param expected — ожидаемые имя и версия плагина.
 */
export function checkPluginCapabilities(
  payload: unknown,
  expected: { name: string; version: string },
): PluginCapabilitiesCheck {
  if (!isRecord(payload)) {
    return fail('invalid_request', 'ответ /capabilities — не JSON-объект');
  }

  const protocol = payload.protocol;
  if (typeof protocol !== 'number' || !Number.isFinite(protocol)) {
    return fail('invalid_request', 'в ответе /capabilities нет числового поля protocol');
  }
  if (protocol !== PLUGIN_PROTOCOL_VERSION) {
    return fail(
      'protocol_mismatch',
      `плагин говорит по протоколу ${protocol}, а Synth — по протоколу ${PLUGIN_PROTOCOL_VERSION}`,
    );
  }

  const name = payload.name;
  const version = payload.version;
  if (!isNonEmptyString(name) || !isNonEmptyString(version)) {
    return fail('invalid_request', 'в ответе /capabilities нет имени/версии плагина');
  }
  if (name !== expected.name || version !== expected.version) {
    return fail(
      'protocol_mismatch',
      `процесс обслуживает плагин «${name}@${version}», ожидается «${expected.name}@${expected.version}»`,
    );
  }

  const pointsRaw = payload.points;
  if (pointsRaw !== undefined && !isRecord(pointsRaw)) {
    return fail('invalid_request', 'поле points в /capabilities должно быть объектом');
  }
  const points: PluginCapabilities['points'] = {};

  if (pointsRaw) {
    for (const key of Object.keys(pointsRaw)) {
      if (!isPluginProtocolPoint(key)) {
        return fail('unknown_point', `процесс объявил неизвестную точку «${key}»`);
      }
    }

    if (pointsRaw.promptBlocks !== undefined) {
      if (!Array.isArray(pointsRaw.promptBlocks)) {
        return fail('invalid_request', 'points.promptBlocks должен быть массивом');
      }
      const blocks: PluginCapabilitiesPromptBlock[] = [];
      const seen = new Set<string>();
      for (const [index, raw] of pointsRaw.promptBlocks.entries()) {
        if (!isRecord(raw)) {
          return fail('invalid_request', `points.promptBlocks[${index}] — не объект`);
        }
        const blockKey = raw.key;
        if (!isNonEmptyString(blockKey)) {
          return fail('invalid_request', `points.promptBlocks[${index}].key обязателен`);
        }
        if (seen.has(blockKey)) {
          return fail('invalid_request', `points.promptBlocks: ключ «${blockKey}» объявлен дважды`);
        }
        if (raw.tier !== 'context' && raw.tier !== 'volatile') {
          return fail(
            'invalid_request',
            `points.promptBlocks[${index}].tier: допустимы только context|volatile ` +
            `(тир stable запрещён — граница prompt-cache, ADR-070)`,
          );
        }
        if (typeof raw.order !== 'number' || !Number.isFinite(raw.order)) {
          return fail('invalid_request', `points.promptBlocks[${index}].order должен быть числом`);
        }
        if (raw.title !== undefined && typeof raw.title !== 'string') {
          return fail('invalid_request', `points.promptBlocks[${index}].title должен быть строкой`);
        }
        seen.add(blockKey);
        blocks.push({
          key: blockKey,
          tier: raw.tier,
          order: raw.order,
          ...(raw.title ? { title: raw.title } : {}),
        });
      }
      points.promptBlocks = blocks;
    }

    if (pointsRaw.llmFilters !== undefined) {
      if (!Array.isArray(pointsRaw.llmFilters)) {
        return fail('invalid_request', 'points.llmFilters должен быть массивом');
      }
      const filters: PluginCapabilitiesLlmFilter[] = [];
      const seen = new Set<string>();
      for (const [index, raw] of pointsRaw.llmFilters.entries()) {
        if (!isRecord(raw)) {
          return fail('invalid_request', `points.llmFilters[${index}] — не объект`);
        }
        const id = raw.id;
        if (!isNonEmptyString(id)) {
          return fail('invalid_request', `points.llmFilters[${index}].id обязателен`);
        }
        if (seen.has(id)) {
          return fail('invalid_request', `points.llmFilters: идентификатор «${id}» объявлен дважды`);
        }
        if (!isLlmFilterPhase(raw.phase)) {
          return fail('invalid_request', `points.llmFilters[${index}].phase неизвестна`);
        }
        if (raw.failMode !== undefined && !isLlmFilterFailMode(raw.failMode)) {
          return fail('invalid_request', `points.llmFilters[${index}].failMode: допустимы open|closed`);
        }
        if (
          raw.timeoutMs !== undefined &&
          (typeof raw.timeoutMs !== 'number' || !Number.isInteger(raw.timeoutMs) || raw.timeoutMs <= 0)
        ) {
          return fail('invalid_request', `points.llmFilters[${index}].timeoutMs должно быть целым > 0`);
        }
        seen.add(id);
        filters.push({
          id,
          phase: raw.phase,
          ...(raw.failMode ? { failMode: raw.failMode } : {}),
          ...(raw.timeoutMs !== undefined ? { timeoutMs: raw.timeoutMs } : {}),
        });
      }
      points.llmFilters = filters;
    }
  }

  return {
    ok: true,
    capabilities: { protocol, name, version, points },
  };
}

/** Ответ `promptBlocks` — допустимый статус манифеста (экспорт для загрузчика core). */
export function isPluginPromptBlockStatus(value: unknown): value is PromptManifestStatus {
  return (
    typeof value === 'string' &&
    (PROMPT_BLOCK_STATUSES as readonly string[]).includes(value)
  );
}

function fail(reason: PluginProtocolErrorReason, message: string): PluginCapabilitiesCheck {
  return { ok: false, reason, message };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}
