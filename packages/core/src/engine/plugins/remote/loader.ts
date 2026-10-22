/**
 * PROP-090 §«out-of-process»: загрузчик удалённых плагинов (Ф4б-1).
 *
 * Шаг `import` пайплайна `PluginHost` для `mode: 'remote' | 'both'`: вместо
 * `import()` бандла загрузчик подключается к уже запущенному процессу плагина
 * (`descriptor.remote.url`) и регистрирует **прокси-провайдеры** точек
 * `promptBlocks`/`llmFilters` через wire-протокол (`RemotePluginClient`).
 *
 * **Управление процессом** (Ф4б-2): загрузчик получает опциональный
 * `processManager`. Если `descriptor.remote` (адрес+токен) задан — транспорт
 * работает с уже запущенным процессом (внешний/тестовый сценарий) и процесс
 * не останавливает. Иначе процесс поднимается менеджером из `rootDir` +
 * `remoteEntry` (`dist/server.js`) и останавливается disposer'ом при
 * деактивации плагина; сбой активации после запуска процесс тоже гасит.
 * Без менеджера и без `remote` — отказ (fail-closed), а не «работаем без
 * плагина».
 *
 * **Границы волны Ф4б-1.** Точки `tools` в протоколе нет: плагин, объявивший
 * `provides.tools` при `mode: 'remote'`, будет отклонён сверкой `provides` в
 * хосте (`plugin.provides_mismatch`) — это ожидаемо до Ф4б-3.
 *
 * **Ошибки.** Сбой `capabilities()` (сеть, 401, чужая версия протокола) —
 * `PluginLoadError('plugin.loader_unavailable')`: активация отклоняется.
 * Ошибки **при вызове** точки (`load`/`inspect`) пробрасываются как есть —
 * композер деградирует блок, gateway применяет `failMode` фильтра.
 */
import {
  PLUGIN_PROTOCOL_MAX_PROMPT_BLOCK_CHARS,
  isLlmFilterVerdictKind,
  isPluginPromptBlockStatus,
} from '@itphx/synth-shared';
import type {
  LlmFilterVerdict,
  PromptBlockContent,
} from '@itphx/synth-shared';

import { PluginLoadError } from '../activation.js';
import type {
  PluginActivationDescriptor,
  PluginLoader,
  PluginLogger,
  PluginModule,
} from '../activation.js';
import { RemotePluginClient, type RemotePluginFetch } from './client.js';
import type { PluginProcessManager, RemotePluginProcess } from './process.js';

/** Опции загрузчика `out-of-process`. */
export interface RemotePluginLoaderOptions {
  /** Таймаут одного вызова протокола, мс (по умолчанию 5 000; client). */
  timeoutMs?: number;
  /** Инъекция fetch — тесты (по умолчанию глобальный `fetch`). */
  fetch?: RemotePluginFetch;
  /**
   * Менеджер процессов плагинов (Ф4б-2).
   *
   * Задан — загрузчик сам поднимает процесс из `descriptor.rootDir` +
   * `descriptor.remoteEntry`, если в дескрипторе нет готового `remote`
   * (адрес+токен). Не задан — транспорт принимает только **уже запущенный**
   * процесс (`descriptor.remote`), иначе отказ (fail-closed).
   */
  processManager?: PluginProcessManager;
  /** Логгер (по умолчанию `console.warn`). */
  logger?: PluginLogger;
}

/** Контекст нормализации ответа точки (для сообщений и лога). */
interface ResponseContext {
  plugin: string;
  /** Ключ блока / id фильтра. */
  id: string;
  logger: PluginLogger;
}

/**
 * Создать загрузчик `out-of-process` (`PluginLoader`).
 *
 * С заданным `processManager` загрузчик сам поднимает процесс и ждёт его
 * готовности/health (`PluginProcessManager.start`), а при деактивации плагина
 * останавливает его. Без менеджера — только протокол и регистрация
 * прокси-провайдеров для уже запущенного процесса (`descriptor.remote`).
 */
export function createRemotePluginLoader(
  options: RemotePluginLoaderOptions = {},
): PluginLoader {
  const logger: PluginLogger = options.logger ?? {
    warn: (message: string) => {
      console.warn(`[plugin-remote] ${message}`);
    },
  };

  return async (descriptor: PluginActivationDescriptor): Promise<PluginModule> => {
    const mode = descriptor.manifest.mode;
    if (mode !== 'remote' && mode !== 'both') {
      throw new PluginLoadError(
        `Плагин «${descriptor.name}»: режим исполнения «${mode ?? 'inline'}», а удалённый ` +
        `загрузчик обслуживает только remote|both — активация отклонена.`,
      );
    }

    const remote = descriptor.remote;
    let process: RemotePluginProcess | undefined;
    let url: string;
    let token: string;

    if (remote && isNonEmptyString(remote.url) && isNonEmptyString(remote.token)) {
      // Явный адрес+токен приоритетнее: процесс уже запущен (внешний или
      // тестовый), загрузчик его не поднимает и не останавливает.
      url = remote.url;
      token = remote.token;
    } else if (options.processManager) {
      if (!isNonEmptyString(descriptor.rootDir)) {
        throw new PluginLoadError(
          `Плагин «${descriptor.name}»: не задан каталог бандла (rootDir) — ` +
            'поднять процесс out-of-process неоткуда.',
        );
      }
      try {
        process = await options.processManager.start({
          name: descriptor.name,
          rootDir: descriptor.rootDir,
          ...(descriptor.remoteEntry ? { entry: descriptor.remoteEntry } : {}),
        });
      } catch (err) {
        throw new PluginLoadError(describeProcessFailure(descriptor, err));
      }
      url = process.url;
      token = process.token;
    } else {
      throw new PluginLoadError(
        `Плагин «${descriptor.name}»: не задан адрес/токен удалённого процесса ` +
          '(descriptor.remote) и не подключён менеджер процессов — загрузчик ' +
          'out-of-process не угадывает адрес и не поднимает процесс.',
      );
    }

    let client: RemotePluginClient;
    try {
      client = new RemotePluginClient({
        baseUrl: url,
        token,
        name: descriptor.name,
        version: descriptor.version,
        ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
        ...(options.fetch ? { fetch: options.fetch } : {}),
      });
    } catch (err) {
      await process?.stop();
      throw new PluginLoadError(describeLoadFailure(descriptor, token, err));
    }

    let capabilities;
    try {
      capabilities = await client.capabilities();
    } catch (err) {
      // Активация не состоялась — процесс, поднятый нами, останавливаем:
      // иначе он остался бы висеть без владельца.
      await process?.stop();
      throw new PluginLoadError(describeLoadFailure(descriptor, token, err));
    }

    const plugin = descriptor.name;

    return {
      apply: async (facade) => {
        // Процесс, поднятый загрузчиком, живёт ровно столько, сколько активен
        // плагин: деактивация (обратная прокрутка disposers) его останавливает.
        if (process) {
          const running = process;
          facade.registerDisposer(() => running.stop());
        }

        for (const block of capabilities.points.promptBlocks ?? []) {
          const ctx: ResponseContext = { plugin, id: block.key, logger };
          facade.registerPromptBlock({
            key: block.key,
            tier: block.tier,
            order: block.order,
            ...(block.title ? { title: block.title } : {}),
            load: async (input) =>
              normalizePromptBlockContent(
                await client.invoke('promptBlocks', block.key, input),
                ctx,
              ),
          });
        }

        for (const filter of capabilities.points.llmFilters ?? []) {
          const ctx: ResponseContext = { plugin, id: filter.id, logger };
          facade.registerLlmFilter({
            id: filter.id,
            phase: filter.phase,
            ...(filter.failMode ? { failMode: filter.failMode } : {}),
            ...(filter.timeoutMs !== undefined ? { timeoutMs: filter.timeoutMs } : {}),
            inspect: async (input) =>
              normalizeLlmFilterVerdict(
                await client.invoke('llmFilters', filter.id, input),
                ctx,
              ),
          });
        }
      },
    };
  };
}

// ── Нормализация ответов точек (fail-closed) ─────────────────────────────

/**
 * Ответ точки `promptBlocks` → `PromptBlockContent`.
 *
 * Допустимы строка и объект с `content: string` (PROP-090 §«Что пересекает
 * границу»). Всё прочее — ошибка: композер зафиксирует предупреждение и
 * сделает блок пустым (ход не падает). Содержимое ограничено
 * `PLUGIN_PROTOCOL_MAX_PROMPT_BLOCK_CHARS` (64 КиБ) — защита от «случайного»
 * мегабайта на проводе (дальше блок всё равно обрезается бюджетом
 * `plugins.promptBlockMaxChars`).
 */
function normalizePromptBlockContent(
  raw: unknown,
  ctx: ResponseContext,
): PromptBlockContent {
  if (typeof raw === 'string') {
    assertBlockLength(raw, ctx);
    return { content: raw };
  }

  if (isRecord(raw) && typeof raw.content === 'string') {
    assertBlockLength(raw.content, ctx);
    return {
      content: raw.content,
      ...(typeof raw.provenance === 'string' && raw.provenance.length > 0
        ? { provenance: raw.provenance }
        : {}),
      ...(isPluginPromptBlockStatus(raw.status) ? { status: raw.status } : {}),
    };
  }

  throw responseError(ctx, 'ожидается строка или объект { content: string }');
}

/** Длина содержимого блока в пределах провода. */
function assertBlockLength(content: string, ctx: ResponseContext): void {
  if (content.length > PLUGIN_PROTOCOL_MAX_PROMPT_BLOCK_CHARS) {
    throw responseError(
      ctx,
      `содержимое ${content.length} символов превышает предел ` +
      `${PLUGIN_PROTOCOL_MAX_PROMPT_BLOCK_CHARS} — ответ отклонён`,
    );
  }
}

/**
 * Ответ точки `llmFilters` → `LlmFilterVerdict`.
 *
 * Минимальная проверка формы: `verdict` из `LLM_FILTER_VERDICTS`,
 * `redactedContent` — строка, `redactedTexts` — массив строк. Право вето и
 * согласованность вердикта с фазой решает хост/`GatewayProvider`; ошибка здесь
 * означает «фильтр ответил не по контракту» — gateway применит `failMode`.
 */
function normalizeLlmFilterVerdict(
  raw: unknown,
  ctx: ResponseContext,
): LlmFilterVerdict {
  if (!isRecord(raw)) throw responseError(ctx, 'вердикт — не JSON-объект');
  if (!isLlmFilterVerdictKind(raw.verdict)) {
    throw responseError(ctx, 'поле verdict отсутствует или неизвестно (allow|deny|redact)');
  }
  if (raw.reason !== undefined && typeof raw.reason !== 'string') {
    throw responseError(ctx, 'поле reason должно быть строкой');
  }
  if (raw.code !== undefined && typeof raw.code !== 'string') {
    throw responseError(ctx, 'поле code должно быть строкой');
  }
  if (raw.redactedContent !== undefined && typeof raw.redactedContent !== 'string') {
    throw responseError(ctx, 'поле redactedContent должно быть строкой');
  }
  if (raw.redactedTexts !== undefined) {
    const texts = raw.redactedTexts;
    if (!Array.isArray(texts) || !texts.every((text) => typeof text === 'string')) {
      throw responseError(ctx, 'поле redactedTexts должно быть массивом строк');
    }
  }

  return {
    verdict: raw.verdict,
    ...(typeof raw.reason === 'string' ? { reason: raw.reason } : {}),
    ...(typeof raw.code === 'string' ? { code: raw.code } : {}),
    ...(typeof raw.redactedContent === 'string'
      ? { redactedContent: raw.redactedContent }
      : {}),
    ...(Array.isArray(raw.redactedTexts)
      ? { redactedTexts: raw.redactedTexts as string[] }
      : {}),
  };
}

/** Ошибка «ответ точки не по контракту»: лог (без полезной нагрузки) + throw. */
function responseError(ctx: ResponseContext, reason: string): Error {
  const message =
    `плагин «${ctx.plugin}»: ответ точки «${ctx.id}» не по контракту — ${reason}.`;
  ctx.logger.warn(message);
  return new Error(message);
}

/** Ошибка запуска процесса плагина (текст уже без токена — его чистит менеджер). */
function describeProcessFailure(
  descriptor: PluginActivationDescriptor,
  err: unknown,
): string {
  const detail = err instanceof Error ? err.message : String(err);
  return `Плагин «${descriptor.name}»: процесс out-of-process не запущен — ${detail}`;
}

/** Ошибка загрузки: сообщение без токена (и без «сырого» стека процесса). */
function describeLoadFailure(
  descriptor: PluginActivationDescriptor,
  token: string,
  err: unknown,
): string {
  const detail = err instanceof Error ? err.message : String(err);
  const safe = token.length > 0 ? detail.split(token).join('***') : detail;
  return (
    `Плагин «${descriptor.name}»: удалённый процесс недоступен — ${safe}`
  );
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
