/**
 * Единый слой фильтрации контента инструментов (защита от Indirect Prompt
 * Injection).
 *
 * Одна точка для **всех** циклов Tool Use (основной ход, саб-агент, шаг
 * пайплайна): обёртка по матрице доверия, экранирование маркеров блока,
 * словарная детекция и политика `flag`/`sanitize`/`block`. Второй копии
 * логики быть не должно — иначе правила расходятся между циклами.
 *
 * Порядок:
 * 1. `config.enabled === false` → без изменений;
 * 2. `getToolTrust(...) === null` (системный/неизвестный тул) → без изменений;
 * 3. экранирование маркеров (`escapeContentMarkers`) — **всегда**;
 * 4. словарная детекция ru+en → `applyPolicy(config.mode, detection)`;
 *    блокировка — **только** по словарю (подделка маркера не блокирует);
 * 5. `blocked` → текст `security.injection_blocked`, `isError: true`;
 * 6. иначе контент (экранированный) в `wrapContent` при `config.wrapContent`,
 *    а при `mode: 'flag'` и словарных совпадениях — WARN-строка ПЕРЕД блоком.
 *
 * `isError`-результаты проходят слой наравне с обычными (кроме системных
 * тулов и выключенной защиты): текст ошибки тоже может нести недоверенный
 * фрагмент (аргументы вызова в отказе, эхо команды).
 */
import type { PromptInjectionConfig, ToolDefinition } from '@itphx/synth-shared';
import type { DictionaryRepository } from '../../storage/ports/dictionary-repository.js';
import { i18n as i18nMeta, t as sm } from '../system-messages.js';
import { getToolTrust } from './trust.js';
import {
  applyPolicy,
  buildWarnLine,
  detectPromptInjection,
  escapeContentMarkers,
  wrapContent,
  type InjectionDetection,
} from './prompt-injection.js';

/** Вход слоя фильтрации контента инструмента. */
export interface ToolContentFilterInput {
  /** Имя тула (для матрицы доверия и текста блокировки). */
  toolName: string;
  /** Определение тула (capabilities, источник, уровень доверия плагина). */
  toolDef?: ToolDefinition;
  /** Аргументы вызова (атрибуты маркера, путь для file-тулов). */
  args: Record<string, unknown>;
  /** Текст результата тула. */
  content: string;
  /** Признак ошибки результата (сохраняется, кроме блокировки). */
  isError: boolean;
  /** Метаданные результата (чужие поля сохраняются). */
  metadata?: Record<string, unknown>;
  /** Рабочий каталог сессии/шага (база относительных путей в trust-матрице). */
  workingDir: string;
  /** Дополнительные корни периметра доверия (ADR-114: корень проекта). */
  allowedRoots?: readonly string[];
  /** Эффективная секция `security.promptInjection`. */
  config: PromptInjectionConfig;
  /** Порт словарей — источник ключевых слов категории `injection`. */
  dictionaryStore: DictionaryRepository;
  /** Язык сессии/шага (порядок словарей: основной, затем второй). */
  language: string;
}

/** Результат фильтрации контента инструмента. */
export interface ToolContentFilterResult {
  content: string;
  isError: boolean;
  metadata?: Record<string, unknown>;
}

/** Детекция по обоим словарям (ru+en): контент бывает на любом языке. */
function detectBothLanguages(
  content: string,
  dictionaryStore: DictionaryRepository,
  language: string,
): InjectionDetection {
  const langs = language === 'en' ? ['en', 'ru'] : ['ru', 'en'];
  let detection: InjectionDetection = { suspicious: false, matches: [] };
  for (const lang of langs) {
    const found = detectPromptInjection(content, dictionaryStore, lang);
    if (found.suspicious) {
      detection = { suspicious: true, matches: [...detection.matches, ...found.matches] };
    }
  }
  return detection;
}

/**
 * Применяет фильтр IPI к результату инструмента.
 *
 * Не бросает: детекция/политика — чистые функции, словарь читается через
 * порт (ошибка порта — исключение вызывающего, как и раньше).
 */
export function applyToolContentFilter(input: ToolContentFilterInput): ToolContentFilterResult {
  const {
    toolName, toolDef, args, content, isError, metadata,
    workingDir, allowedRoots, config, dictionaryStore, language,
  } = input;

  // 1. Защита выключена — поведение прежнее.
  if (!config.enabled) {
    return { content, isError, ...(metadata ? { metadata } : {}) };
  }

  // 2. Системные/неизвестные тулы не оборачиваем.
  const trustInfo = getToolTrust(
    toolName,
    args,
    workingDir,
    toolDef?.capabilities,
    allowedRoots,
    {
      ...(toolDef?.pluginTrust ? { pluginTrust: toolDef.pluginTrust } : {}),
      ...(toolDef?.source ? { toolSource: toolDef.source } : {}),
      // Метаданные результата нужны веткам доверия: терминал берёт из них
      // атрибуты маркера (`terminal_id`/`bytes`/`run`/…), плагин — `pluginName`
      // (определение важнее результата).
      metadata: {
        ...(metadata ?? {}),
        ...(toolDef?.pluginName ? { pluginName: toolDef.pluginName } : {}),
      },
    },
  );
  if (!trustInfo) {
    return { content, isError, ...(metadata ? { metadata } : {}) };
  }

  // 3. Маркеры блока контента — экранируются всегда (подделка `[CONTENT END]`
  //    не закрывает блок), независимо от режима политики.
  const markered = escapeContentMarkers(content);

  // 4. Словарная детекция → политика.
  const detection = detectBothLanguages(markered.content, dictionaryStore, language);
  const applied = applyPolicy(markered.content, config.mode, detection);

  const injectionMetadata: Record<string, unknown> = {};
  if (detection.suspicious) {
    injectionMetadata.injection_suspicious = true;
    injectionMetadata.injection_matches = detection.matches;
  }
  if (markered.escaped) {
    // Подделка/эхо маркера — сигнал, но не причина блокировки.
    injectionMetadata.injection_suspicious = true;
    injectionMetadata.injection_marker_escaped = true;
  }

  // 5. Блокировка — только по словарю.
  if (applied.blocked) {
    const matches = detection.matches.slice(0, 5).join(', ');
    return {
      content: sm('security.injection_blocked', { tool: toolName, matches }),
      isError: true,
      metadata: {
        ...(metadata ?? {}),
        i18n: i18nMeta('security.injection_blocked', { tool: toolName, matches }),
        ...injectionMetadata,
        injection_blocked: true,
      },
    };
  }

  // 6. Обёртка (сам `wrapContent` тоже экранирует тело — идемпотентно).
  const wrapped = config.wrapContent
    ? wrapContent(applied.content, trustInfo.source, trustInfo.attrs, trustInfo.trust)
    : applied.content;
  // WARN-строка ставится ПЕРЕД блоком [CONTENT | ...] — как и раньше.
  const text = detection.suspicious && config.mode === 'flag'
    ? `${buildWarnLine(detection.matches)}\n${wrapped}`
    : wrapped;

  const mergedMetadata = metadata !== undefined || Object.keys(injectionMetadata).length > 0
    ? { ...(metadata ?? {}), ...injectionMetadata }
    : undefined;
  return {
    content: text,
    isError,
    ...(mergedMetadata !== undefined ? { metadata: mergedMetadata } : {}),
  };
}
