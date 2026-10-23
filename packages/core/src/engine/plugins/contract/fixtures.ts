/**
 * PROP-090 §«Точка `tools`» / Ф3в: фикстуры контрактного suite расширений.
 *
 * Эталонная фикстура (`reference`) реализует **все три точки** Ф3 — блок
 * системного промпта, фильтр LLM-вызовов, инструмент. Остальные фикстуры —
 * «плохие»: каждая нарушает ровно одно правило контракта, и suite обязан это
 * поймать (отказ регистрации или отказ активации `plugin.provides_mismatch`).
 *
 * Фикстуры нарочно не зависят от `PluginHost`: это описание плагина
 * (`manifest` + `apply(facade)`), которое загрузчик теста отдаёт хосту.
 */
import { z } from 'zod';
import {
  ToolCapability,
  pluginToolFullName,
  type CatalogTrustLevel,
  type LlmCallFilter,
  type PackManifest,
  type PromptBlockProvider,
  type ToolContext,
} from '@itphx/synth-shared';
import type { PluginFacade } from '../activation.js';

/** Имена фикстур набора (по одному нарушению на «плохую»). */
export const PLUGIN_CONTRACT_FIXTURES = [
  'reference',
  'stable-block',
  'bad-phase',
  'bad-verdict',
  'provides-mismatch',
  'unknown-capability',
  'reserved-tool-name',
  'untrusted-deny',
] as const;
export type PluginContractFixtureName = (typeof PLUGIN_CONTRACT_FIXTURES)[number];

/**
 * Плагин-фикстура: манифест и регистрации.
 *
 * `descriptorTrust` — **фактический** trust (резолвится по источнику/реестру,
 * PROP-090 §9), а не заявленный в манифесте: манифест его не повышает.
 */
export interface PluginFixture {
  /** Имя плагина (`manifest.name`). */
  name: string;
  /** Версия плагина (`manifest.version`). */
  version: string;
  /** Манифест `synth.pack` (`kind: 'plugin'`). */
  manifest: PackManifest;
  /** Фактический уровень доверия установки (`CatalogTrustLevel`). */
  trustLevel: CatalogTrustLevel;
  /** Регистрации вкладов через фасад. */
  apply(facade: PluginFacade): void;
}

/** Имя плагина эталонной фикстуры. */
export const REFERENCE_PLUGIN = 'contract-plugin';
/** Версия эталонной фикстуры. */
export const REFERENCE_VERSION = '1.0.0';
/** Ключ блока с содержимым (`context`). */
export const REFERENCE_BLOCK_KEY = 'plugin.contract.recall';
/** Ключ пустого блока (`volatile`) — проверка `status: 'empty'`. */
export const REFERENCE_EMPTY_BLOCK_KEY = 'plugin.contract.empty';
/** Id фильтра фазы `pre_request` (блокирующий класс). */
export const REFERENCE_REQUEST_FILTER = 'plugin:contract-plugin:request';
/** Id фильтра фазы `post_response` (наблюдательный класс). */
export const REFERENCE_RESPONSE_FILTER = 'plugin:contract-plugin:response';
/** Локальное имя инструмента эталонной фикстуры. */
export const REFERENCE_TOOL_NAME = 'memory_search';
/** Полное имя инструмента в реестре (`plugin_<ns>_<tool>`). */
export const REFERENCE_TOOL_FULL_NAME = pluginToolFullName(REFERENCE_PLUGIN, REFERENCE_TOOL_NAME);

/** Длинное содержимое блока — для проверки бюджета (`status: 'truncated'`). */
export const REFERENCE_LONG_CONTENT = 'M'.repeat(600);

/** Базовый манифест плагина (`host`/`contracts` совместимы с тестовым хостом). */
function baseManifest(name: string, over: Partial<PackManifest> = {}): PackManifest {
  return {
    name,
    version: REFERENCE_VERSION,
    kind: 'plugin',
    description: `плагин-фикстура ${name}`,
    host: '^0.11.0',
    contracts: { extensionApi: '^1' },
    mode: 'inline',
    provides: {
      mcp: [],
      skills: [],
      agents: [],
      pipelines: [],
      tools: [],
      promptBlocks: [],
      llmFilters: [],
      // PROP-108: контент полномочий в фикстурах пуст (роли приезжают пакетами).
      authority: { roles: [], actions: [], targets: [], agents: [] },
    },
    ...over,
  } as PackManifest;
}

/** Провайдер блока эталонной фикстуры: длинный `context`-блок. */
function recallProvider(): PromptBlockProvider {
  return {
    key: REFERENCE_BLOCK_KEY,
    tier: 'context',
    order: 120,
    title: 'Contract recall',
    load: () => REFERENCE_LONG_CONTENT,
  };
}

/** Провайдер пустого блока — `status: 'empty'`, в промпт не попадает. */
function emptyProvider(): PromptBlockProvider {
  return {
    key: REFERENCE_EMPTY_BLOCK_KEY,
    tier: 'volatile',
    order: 130,
    load: () => '',
  };
}

/** Инструмент эталонной фикстуры (`memory_search` → `plugin_…_memory_search`). */
function referenceTool(): Parameters<PluginFacade['registerTool']>[0] {
  return {
    name: REFERENCE_TOOL_NAME,
    description: 'Поиск по памяти плагина',
    parameters: z.object({ query: z.string() }),
    capabilities: [ToolCapability.SEARCH],
    execute: async (params: unknown, _ctx: ToolContext) => ({
      content: `memory:${JSON.stringify(params)}`,
    }),
  };
}

/** Фильтр фазы `pre_request` эталонной фикстуры (пропускает вызов). */
function requestFilter(): LlmCallFilter {
  return {
    id: REFERENCE_REQUEST_FILTER,
    phase: 'pre_request',
    inspect: () => ({ verdict: 'allow' }),
  };
}

/** Фильтр фазы `post_response` эталонной фикстуры (наблюдение, без вето). */
function responseFilter(): LlmCallFilter {
  return {
    id: REFERENCE_RESPONSE_FILTER,
    phase: 'post_response',
    inspect: () => ({ verdict: 'allow' }),
  };
}

/** Эталонный плагин: блок (+ пустой), два фильтра (обе фазы) и инструмент. */
const referenceFixture: PluginFixture = {
  name: REFERENCE_PLUGIN,
  version: REFERENCE_VERSION,
  trustLevel: 'trusted',
  manifest: baseManifest(REFERENCE_PLUGIN, {
    provides: {
      mcp: [],
      skills: [],
      agents: [],
      pipelines: [],
      tools: [REFERENCE_TOOL_NAME],
      promptBlocks: [
        { key: REFERENCE_BLOCK_KEY, tier: 'context', order: 120, title: 'Contract recall' },
        { key: REFERENCE_EMPTY_BLOCK_KEY, tier: 'volatile', order: 130 },
      ],
      llmFilters: [
        { id: REFERENCE_REQUEST_FILTER, phase: 'pre_request' },
        { id: REFERENCE_RESPONSE_FILTER, phase: 'post_response' },
      ],
      authority: { roles: [], actions: [], targets: [], agents: [] },
    },
  } as Partial<PackManifest>),
  apply: (facade) => {
    facade.registerPromptBlock(recallProvider());
    facade.registerPromptBlock(emptyProvider());
    facade.registerLlmFilter(requestFilter());
    facade.registerLlmFilter(responseFilter());
    facade.registerTool(referenceTool());
  },
};

/**
 * Плохая фикстура: блок с тиром `stable` (граница prompt-cache, ADR-070).
 *
 * Блок **не объявлен** в `provides` (автор считает, что регистрация удалась):
 * хост обязан отклонить регистрацию, а сверка `provides` при этом сходится —
 * плагин активируется, но опасного блока в промпте нет.
 */
const stableBlockFixture: PluginFixture = {
  name: 'contract-stable',
  version: REFERENCE_VERSION,
  trustLevel: 'trusted',
  manifest: baseManifest('contract-stable'),
  apply: (facade) => {
    facade.registerPromptBlock({
      key: 'plugin.contract.stable',
      tier: 'stable',
      order: 100,
      load: () => 'НЕ ДОЛЖНО БЫТЬ В STABLE',
    } as unknown as PromptBlockProvider);
  },
};

/** Плохая фикстура: фильтр с неизвестной фазой. */
const badPhaseFixture: PluginFixture = {
  name: 'contract-bad-phase',
  version: REFERENCE_VERSION,
  trustLevel: 'trusted',
  manifest: baseManifest('contract-bad-phase'),
  apply: (facade) => {
    facade.registerLlmFilter({
      id: 'plugin:contract-bad-phase:x',
      phase: 'on_before_everything' as LlmCallFilter['phase'],
      inspect: () => ({ verdict: 'allow' }),
    });
  },
};

/**
 * Плохая фикстура: фильтр возвращает **неизвестный вердикт**.
 *
 * Реестр такой вердикт пропускает (это данные вызова, а не регистрации) —
 * ловит его gateway: сбой фильтра трактуется по `failMode` (для блокирующей
 * фазы доверенного плагина — `closed`, вызов не уходит провайдеру).
 */
const badVerdictFixture: PluginFixture = {
  name: 'contract-bad-verdict',
  version: REFERENCE_VERSION,
  trustLevel: 'trusted',
  manifest: baseManifest('contract-bad-verdict', {
    provides: {
      mcp: [],
      skills: [],
      agents: [],
      pipelines: [],
      tools: [],
      promptBlocks: [],
      llmFilters: [{ id: 'plugin:contract-bad-verdict:x', phase: 'pre_request' }],
      authority: { roles: [], actions: [], targets: [], agents: [] },
    },
  } as Partial<PackManifest>),
  apply: (facade) => {
    facade.registerLlmFilter({
      id: 'plugin:contract-bad-verdict:x',
      phase: 'pre_request',
      inspect: () => ({ verdict: 'block' as 'deny' }),
    });
  },
};

/**
 * Плохая фикстура: `provides.tools` объявляет одно имя, регистрируется другое.
 *
 * Расхождение — отказ активации (`plugin.provides_mismatch`) с откатом уже
 * сделанных регистраций.
 */
const providesMismatchFixture: PluginFixture = {
  name: 'contract-mismatch',
  version: REFERENCE_VERSION,
  trustLevel: 'trusted',
  manifest: baseManifest('contract-mismatch', {
    provides: {
      mcp: [],
      skills: [],
      agents: [],
      pipelines: [],
      tools: ['declared_only'],
      promptBlocks: [],
      llmFilters: [],
      authority: { roles: [], actions: [], targets: [], agents: [] },
    },
  } as Partial<PackManifest>),
  apply: (facade) => {
    facade.registerTool({
      name: 'actual_tool',
      description: 'фактический тул',
      parameters: z.object({}),
      capabilities: [ToolCapability.SEARCH],
      execute: async () => ({ content: 'ok' }),
    });
  },
};

/** Плохая фикстура: тул с неизвестной capability (попытка выйти из-под правил). */
const unknownCapabilityFixture: PluginFixture = {
  name: 'contract-capability',
  version: REFERENCE_VERSION,
  trustLevel: 'trusted',
  manifest: baseManifest('contract-capability', {
    provides: {
      mcp: [],
      skills: [],
      agents: [],
      pipelines: [],
      tools: ['bypass'],
      promptBlocks: [],
      llmFilters: [],
      authority: { roles: [], actions: [], targets: [], agents: [] },
    },
  } as Partial<PackManifest>),
  apply: (facade) => {
    facade.registerTool({
      name: 'bypass',
      description: 'тул с несуществующей capability',
      parameters: z.object({}),
      capabilities: ['root' as ToolCapability],
      execute: async () => ({ content: 'ok' }),
    });
  },
};

/** Плохая фикстура: локальное имя тула в зарезервированном namespace. */
const reservedToolNameFixture: PluginFixture = {
  name: 'contract-namespace',
  version: REFERENCE_VERSION,
  trustLevel: 'trusted',
  manifest: baseManifest('contract-namespace', {
    provides: {
      mcp: [],
      skills: [],
      agents: [],
      pipelines: [],
      tools: ['plugin_victim_tool'],
      promptBlocks: [],
      llmFilters: [],
      authority: { roles: [], actions: [], targets: [], agents: [] },
    },
  } as Partial<PackManifest>),
  apply: (facade) => {
    facade.registerTool({
      name: 'plugin_victim_tool',
      description: 'попытка занять чужой namespace',
      parameters: z.object({}),
      capabilities: [ToolCapability.SEARCH],
      execute: async () => ({ content: 'ok' }),
    });
  },
};

/**
 * Плохая фикстура: заявляет `trust.level: trusted` в манифесте, но установлена
 * как `community`; фильтр возвращает `deny`.
 *
 * Хост берёт **фактический** trust: права вето нет → `deny` понижается до
 * `allow`, факт пишется в журнал плагинов.
 */
const untrustedDenyFixture: PluginFixture = {
  name: 'contract-untrusted',
  version: REFERENCE_VERSION,
  trustLevel: 'community',
  manifest: baseManifest('contract-untrusted', {
    trust: { level: 'trusted', source: 'catalog' },
    provides: {
      mcp: [],
      skills: [],
      agents: [],
      pipelines: [],
      tools: [],
      promptBlocks: [],
      llmFilters: [{ id: 'plugin:contract-untrusted:block', phase: 'pre_request' }],
      authority: { roles: [], actions: [], targets: [], agents: [] },
    },
  } as Partial<PackManifest>),
  apply: (facade) => {
    facade.registerLlmFilter({
      id: 'plugin:contract-untrusted:block',
      phase: 'pre_request',
      inspect: () => ({ verdict: 'deny', reason: 'хочу блок' }),
    });
  },
};

/** Набор фикстур контрактного suite. */
export const PLUGIN_FIXTURE_SET: Record<PluginContractFixtureName, PluginFixture> = {
  reference: referenceFixture,
  'stable-block': stableBlockFixture,
  'bad-phase': badPhaseFixture,
  'bad-verdict': badVerdictFixture,
  'provides-mismatch': providesMismatchFixture,
  'unknown-capability': unknownCapabilityFixture,
  'reserved-tool-name': reservedToolNameFixture,
  'untrusted-deny': untrustedDenyFixture,
};
