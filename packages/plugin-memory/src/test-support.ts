/**
 * Общие заготовки тестов плагина памяти.
 *
 * Хранилище — **настоящее** in-memory (`createMemoryStorage()` из
 * `@itphx/synth-core`), а не мок: плагин ходит в порты памяти так же, как в
 * инстансе. Мокается только **фасад** (то, что выдаёт хост): блоки и тулы
 * тестируются через тот же контракт, что и в бою.
 */
import type {
  PluginFacade,
  PluginToolDefinition,
  StorageContext,
} from '@itphx/synth-core';
import { createMemoryStorage, createScopedMemory } from '@itphx/synth-core';
import type { PromptBlockProvider } from '@itphx/synth-shared';

import type { MemoryTelemetryInput } from './telemetry.js';

/** Имя плагина в тестах (совпадает с именем манифеста `synth.pack`). */
export const TEST_PLUGIN_NAME = 'synth-plugin-memory';

/** Настоящее in-memory хранилище инстанса (порты фактов и индексов). */
export function createTestStorage(): StorageContext {
  return createMemoryStorage();
}

/** Фасад, собранный тестом: реестры вкладов + scoped-доступ к памяти. */
export interface TestFacade {
  /** Фасад в том же виде, что отдаёт хост плагину. */
  facade: PluginFacade;
  /** Зарегистрированные блоки промпта (в порядке регистрации). */
  promptBlocks: PromptBlockProvider[];
  /** Зарегистрированные тулы (в порядке регистрации). */
  tools: PluginToolDefinition[];
  /** Зарегистрированные disposer'ы. */
  disposers: Array<() => void>;
}

/** Опции сборки тестового фасада. */
export interface TestFacadeOptions {
  /** Хранилище инстанса (по умолчанию — новое in-memory). */
  storage?: StorageContext;
  /** Настройки плагина (`plugins[<имя>].settings`). */
  settings?: Record<string, unknown>;
  /** `false` — сервис памяти недоступен (`facade.memory === undefined`). */
  withMemory?: boolean;
  /** Функция эмбеддингов (по умолчанию — детерминированная заглушка). */
  embed?: (texts: readonly string[]) => Promise<number[][]>;
  /** Размерность вектора заглушки (по умолчанию — 8). */
  embedDimension?: number;
  /** Фактическая модель хоста (для фингерпринта индекса). */
  embedding?: { provider?: string; model?: string };
  /**
   * Телеметрия recall/search (ADR-107) — вызывается провайдером плагина.
   *
   * Не задана — фасад без телеметрии (как у хоста с выключенными метриками):
   * плагин обязан это переживать (фича-детект).
   */
  memoryTelemetry?: (input: MemoryTelemetryInput) => void;
}

/**
 * Детерминированный фейковый эмбеддер.
 *
 * Вектор — псевдо-вектор из суммы кодов символов: одинаковый текст →
 * одинаковый вектор, разный текст → разный вектор. Эмбеддинги в тестах не
 * должны зависеть от провайдера (в бою — только через шлюз, ADR-036).
 */
export function fakeEmbed(texts: readonly string[], dimension = 8): Promise<number[][]> {
  return Promise.resolve(
    texts.map((text) => {
      const vector = new Array<number>(dimension).fill(0);
      let sum = 0;
      for (let i = 0; i < text.length; i += 1) sum = (sum + text.charCodeAt(i)) % 100_003;
      for (let i = 0; i < dimension; i += 1) {
        vector[i] = ((sum + i * 31) % 97) / 97;
      }
      return vector;
    }),
  );
}

/** Хеш строки (FNV-1a) — для раскладки n-грамм по бакетам. */
function hashString(value: string): number {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash);
}

/**
 * Детерминированный эмбеддер по **n-граммам** (2 и 3 символа).
 *
 * Нужен там, где важна **похожесть** текстов, а не просто их различие:
 * - почти одинаковые утверждения (разница в пунктуации/регистре/одном слове)
 *   дают косинус ~0.9 и выше — их и сливает консолидация;
 * - разные утверждения дают низкий косинус — они не объединяются.
 *
 * `fakeEmbed` для этого не годится: он зависит только от суммы кодов, и
 * разные тексты с одинаковой суммой дают **одинаковый** вектор.
 */
export function fakeNgramEmbed(texts: readonly string[], dimension = 256): Promise<number[][]> {
  return Promise.resolve(
    texts.map((text) => {
      const vector = new Array<number>(dimension).fill(0);
      const lower = (text ?? '').toLowerCase();
      const grams = new Set<string>();
      for (const size of [2, 3]) {
        for (let i = 0; i + size <= lower.length; i += 1) grams.add(lower.slice(i, i + size));
      }
      for (const gram of grams) vector[hashString(gram) % dimension] = 1;
      return vector;
    }),
  );
}

/**
 * Тестовый фасад плагина.
 *
 * `facade.memory` — scoped-обёртка над портами storage'а (namespace
 * навязывает хост, ADR-107) — ровно то, что получает настоящий плагин.
 */
export function createTestFacade(options: TestFacadeOptions = {}): TestFacade {
  const storage = options.storage ?? createTestStorage();
  const promptBlocks: PromptBlockProvider[] = [];
  const tools: PluginToolDefinition[] = [];
  const disposers: Array<() => void> = [];

  const facade: PluginFacade = {
    registerDisposer: (disposer) => {
      disposers.push(disposer);
    },
    registerPromptBlock: (provider) => {
      promptBlocks.push(provider);
      return () => undefined;
    },
    registerLlmFilter: () => () => undefined,
    registerTool: (def) => {
      tools.push(def);
      return () => undefined;
    },
    ...(options.withMemory === false
      ? {}
      : {
          memory: createScopedMemory(TEST_PLUGIN_NAME, {
            facts: storage.memoryFacts,
            indexes: storage.memoryIndexes,
          }),
        }),
    embed: options.embed ?? ((texts) => fakeEmbed(texts, options.embedDimension ?? 8)),
    getSettings: <T extends Record<string, unknown> = Record<string, unknown>>(): Readonly<T> =>
      (options.settings ?? {}) as Readonly<T>,
    ...(options.embedding ? { embedding: options.embedding } : {}),
    ...(options.memoryTelemetry ? { memoryTelemetry: options.memoryTelemetry } : {}),
  };

  return { facade, promptBlocks, tools, disposers };
}

/** Контекст хода для блоков промпта. */
export function blockCtx(over: {
  sessionId?: string;
  projectId?: string;
  query?: string;
  turnId?: string;
} = {}): {
  sessionId: string;
  agentRole: string;
  language: string;
  projectId?: string;
  mode: 'act';
  query?: string;
  turnId?: string;
} {
  return {
    sessionId: over.sessionId ?? 's1',
    agentRole: 'assistant',
    language: 'ru',
    ...(over.projectId ? { projectId: over.projectId } : {}),
    mode: 'act',
    ...(over.query ? { query: over.query } : {}),
    ...(over.turnId ? { turnId: over.turnId } : {}),
  };
}

/**
 * Контекст исполнения тула (суженный контекст плагинного тула, ADR-107).
 *
 * `projectId` — проект сессии (ADR-107: хост прокидывает его в суженный
 * контекст); нужен тулу `memory_search`, чтобы ограничить поиск данными
 * своего проекта.
 */
export function toolCtx(sessionId = 's1', projectId?: string): {
  sessionId: string;
  messageId: string;
  workingDir: string;
  projectId?: string;
} {
  return {
    sessionId,
    messageId: 'm1',
    workingDir: '/ws',
    ...(projectId ? { projectId } : {}),
  };
}
