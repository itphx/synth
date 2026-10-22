/**
 * PROP-090 §«Точки расширения» (Ф3в): **контрактный suite расширений**.
 *
 * По образцу контрактных suite'ов слоя хранения
 * (`packages/core/src/storage/contract/*`): «паспорт» — набор проверок,
 * которым **обязан** удовлетворять плагин, реализующий точки расширения.
 * Фикстуры (`fixtures.ts`) дают эталонный плагин и по одному «плохому»
 * варианту на каждое нарушение.
 *
 * Что проверяется:
 * 1. точка `promptBlocks` — тир `stable` отклоняется; пустой ключ/нечисловой
 *    `order`/дубль ключа отклоняются; бюджет символов применяется;
 *    `status` корректен (`empty` для пустого, `truncated` при превышении);
 * 2. точка `llmFilters` — фазы валидируются; порядок = порядок регистрации;
 *    `failMode` по умолчанию соответствует доверию; неизвестный вердикт
 *    трактуется по `failMode`;
 * 3. точка `tools` — имя с namespace, нет коллизии с builtin/MCP,
 *    permission-слой видит инструмент и может его запретить, `deregister`
 *    работает;
 * 4. сверка `provides` ↔ фактические регистрации — все три вида вкладов;
 * 5. dispose-дисциплина: после `deactivate()` ни одной регистрации не остаётся;
 * 6. запрет обхода: неизвестная/зарезервированная capability, чужой namespace
 *    и заявленный trust выше фактического не проходят.
 *
 * Suite не знает, откуда берутся хост и реестры: харнесс строит вызывающая
 * сторона. Прогоняется на **двух** транспортах (Ф4б-3): `inline`
 * (`plugin-contract.test.ts`, загрузчик отдаёт модуль фикстуры) и
 * `out-of-process` (`plugin-contract-remote.test.ts`: `loaders.remote` +
 * процесс-заглушка по wire-протоколу). Проверки одни и те же; различается
 * только место отказа невалидного вклада (`harness.transport`).
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import type {
  PermissionDecision,
  PermissionRule,
  PromptManifest,
} from '@itphx/synth-shared';
import type { PluginActivationResult, PluginDeactivationResult } from '../activation.js';
import type { PluginHost } from '../plugin-host.js';
import type { PromptBlockRegistry } from '../../context/prompt-block-registry.js';
import type { LlmFilterRegistry } from '../../gateway/llm-filter-registry.js';
import type { ToolRegistry } from '../../tools/registry.js';
import {
  PLUGIN_CONTRACT_FIXTURES,
  PLUGIN_FIXTURE_SET,
  REFERENCE_EMPTY_BLOCK_KEY,
  REFERENCE_LONG_CONTENT,
  REFERENCE_PLUGIN,
  REFERENCE_REQUEST_FILTER,
  REFERENCE_RESPONSE_FILTER,
  REFERENCE_TOOL_FULL_NAME,
  REFERENCE_TOOL_NAME,
  type PluginContractFixtureName,
} from './fixtures.js';

/** Эталонные имена набора (что именно должно появиться в реестрах). */
export interface PluginContractReference {
  /** Имя плагина эталонной фикстуры. */
  plugin: string;
  /** Ключ блока с содержимым (`context`). */
  blockKey: string;
  /** Ключ пустого блока (`volatile`). */
  emptyBlockKey: string;
  /** Id фильтра `pre_request`. */
  requestFilterId: string;
  /** Id фильтра `post_response`. */
  responseFilterId: string;
  /** Локальное имя инструмента. */
  toolName: string;
  /** Полное имя инструмента в реестре. */
  fullToolName: string;
  /** Длинное содержимое блока (для проверки бюджета). */
  longContent: string;
}

/** Эталонные имена по умолчанию — из `fixtures.ts`. */
export const DEFAULT_PLUGIN_CONTRACT_REFERENCE: PluginContractReference = {
  plugin: REFERENCE_PLUGIN,
  blockKey: 'plugin.contract.recall',
  emptyBlockKey: REFERENCE_EMPTY_BLOCK_KEY,
  requestFilterId: REFERENCE_REQUEST_FILTER,
  responseFilterId: REFERENCE_RESPONSE_FILTER,
  toolName: REFERENCE_TOOL_NAME,
  fullToolName: REFERENCE_TOOL_FULL_NAME,
  longContent: REFERENCE_LONG_CONTENT,
};

/**
 * Транспорт исполнения, на котором прогоняется suite:
 * `inline` (код плагина в процессе core) или `remote` (`out-of-process`).
 *
 * Transport-difference ровно один: **где** отклоняется невалидный вклад.
 * `inline` регистрирует его через фасад и получает отказ от реестра (активация
 * при этом жива, если манифест не объявлял этот вклад); `remote` объявляет
 * вклад по проводу (`/capabilities`), и `checkPluginCapabilities` отклоняет
 * всё объявление целиком (fail-closed, активация отклоняется на шаге
 * `import`). В обоих случаях регистрации **не появляется**, а причина названа.
 */
export type PluginContractTransport = 'inline' | 'remote';

/**
 * Харнесс suite: хост плагинов с общими реестрами и вспомогательные операции.
 *
 * `make()` вызывается на каждый тест (изоляция: реестры и предупреждения не
 * переносятся между кейсами).
 */
export interface PluginContractHarness {
  /** Транспорт исполнения (различает только место отказа невалидного вклада). */
  transport: PluginContractTransport;
  /** Хост плагинов (активация/деактивация/журнал). */
  host: PluginHost;
  /** Общий реестр инструментов (точка `tools`). */
  tools: ToolRegistry;
  /** Реестр провайдеров блоков промпта (точка `promptBlocks`). */
  promptBlocks: PromptBlockRegistry;
  /** Реестр фильтров LLM-вызовов (точка `llmFilters`). */
  llmFilters: LlmFilterRegistry;
  /** Накопленные предупреждения хоста плагинов (отказы точек). */
  warnings: string[];
  /** Эталонные имена набора. */
  reference: PluginContractReference;
  /** Активировать фикстуру набора. */
  activate(fixture: PluginContractFixtureName): Promise<PluginActivationResult>;
  /** Деактивировать плагин (по умолчанию — эталонный). */
  deactivate(plugin?: string): Promise<PluginDeactivationResult>;
  /**
   * Манифест промпта (сборка Ф3а): `maxChars` — бюджет символов блока
   * (`plugins.promptBlockMaxChars`).
   */
  manifest(opts?: { maxChars?: number }): Promise<PromptManifest>;
  /** Собранный system-текст промпта (для проверки «блок не попал в промпт»). */
  composeSystem(opts?: { maxChars?: number }): Promise<string>;
  /** Прогнать фазу `pre_request` через gateway: сколько раз дошло до провайдера. */
  runPreRequest(): Promise<{ providerCalls: number }>;
  /** Оценка permission-слоя для инструмента (пустые правила — `allow`). */
  checkPermission(toolName: string, rules?: Record<string, PermissionRule>): PermissionDecision;
  /** Освободить ресурсы харнесса (временные каталоги и т. п.). */
  dispose(): Promise<void>;
}

/** Фабрика харнесса. */
export type PluginContractHarnessFactory = () =>
  | PluginContractHarness
  | Promise<PluginContractHarness>;

/** Запись манифеста промпта по ключу блока (`undefined` — блока нет). */
function entryOf(manifest: PromptManifest, key: string) {
  return manifest.entries.find((entry) => entry.key === key);
}

/**
 * Текст отказа транспорта: предупреждения хоста (отказ регистрации в `inline`)
 * **и** сообщение результата активации (отказ `/capabilities` в `remote`).
 *
 * Смысл проверки один — «причина названа»; канал, которым она пришла,
 * зависит от транспорта.
 */
function refusalText(
  h: PluginContractHarness,
  result: { message?: string },
): string {
  return [h.warnings.join('\n'), result.message ?? ''].join('\n');
}

/**
 * Контрактный suite расширений.
 *
 * @param name — подпись набора (реализация хоста/реестров).
 * @param make — фабрика харнесса (свежий на каждый тест).
 */
export function describePluginContract(
  name: string,
  make: PluginContractHarnessFactory,
): void {
  describe(`контракт расширений (PROP-090): ${name}`, () => {
    let h: PluginContractHarness;

    beforeEach(async () => {
      h = await make();
    });

    afterEach(async () => {
      await h.dispose();
    });

    // ── 1. Точка `promptBlocks` ──────────────────────────────────────────

    describe('точка promptBlocks', () => {
      it('эталонный плагин: блок зарегистрирован с provenance и попадает в промпт', async () => {
        const result = await h.activate('reference');
        expect(result.outcome).toBe('activated');

        const registration = h.promptBlocks.get(h.reference.blockKey);
        expect(registration).toBeDefined();
        expect(registration!.provenance).toBe(`plugin:${h.reference.plugin}`);

        const system = await h.composeSystem();
        expect(system).toContain(h.reference.longContent.slice(0, 32));
      });

      it('тир stable отклоняется (не тихое понижение), блок в промпт не попадает', async () => {
        const result = await h.activate('stable-block');
        if (h.transport === 'inline') {
          // Inline: регистрация отклонена реестром, активация плагина жива.
          expect(result.outcome).toBe('activated');
        } else {
          // Out-of-process: невалидное объявление точки отклоняет /capabilities
          // (fail-closed до регистрации) — сильнее, но блок так же не появился.
          expect(result.outcome).toBe('rejected');
          expect(result.step).toBe('import');
        }
        expect(h.promptBlocks.list().map((entry) => entry.provider.key)).not.toContain(
          'plugin.contract.stable',
        );
        expect(await h.composeSystem()).not.toContain('НЕ ДОЛЖНО БЫТЬ В STABLE');
        expect(refusalText(h, result)).toContain('stable');
      });

      it('пустой ключ, нечисловой order и дубль ключа отклоняются регистрацией', () => {
        expect(() =>
          h.promptBlocks.register({
            key: '   ',
            tier: 'context',
            order: 10,
            load: () => '',
          }),
        ).toThrow();

        expect(() =>
          h.promptBlocks.register({
            key: 'plugin.contract.nan',
            tier: 'context',
            order: Number.NaN,
            load: () => '',
          }),
        ).toThrow();

        const provider = {
          key: 'plugin.contract.dup',
          tier: 'context',
          order: 10,
          load: () => '',
        } as const;
        h.promptBlocks.register(provider);
        expect(() => h.promptBlocks.register(provider)).toThrow();
        h.promptBlocks.unregister(provider.key);
      });

      it('бюджет применяется: status truncated при превышении, empty для пустого блока', async () => {
        await h.activate('reference');

        // Бюджет меньше блока → хост обрезает (голова+хвост) и ставит `truncated`.
        const tight = await h.manifest({ maxChars: 120 });
        const recall = entryOf(tight, h.reference.blockKey);
        expect(recall).toBeDefined();
        expect(recall!.status).toBe('truncated');
        expect(recall!.chars).toBeLessThan(h.reference.longContent.length);

        // Пустой блок — `status: 'empty'` и в system-текст не попадает.
        const empty = entryOf(tight, h.reference.emptyBlockKey);
        expect(empty).toBeDefined();
        expect(empty!.status).toBe('empty');
        expect(empty!.chars).toBe(0);

        // Щедрый бюджет — блок целиком, `loaded`.
        const roomy = await h.manifest({ maxChars: 5_000 });
        const loaded = entryOf(roomy, h.reference.blockKey);
        expect(loaded!.status).toBe('loaded');
        expect(loaded!.chars).toBe(h.reference.longContent.length);
      });
    });

    // ── 2. Точка `llmFilters` ────────────────────────────────────────────

    describe('точка llmFilters', () => {
      it('эталонный плагин: фильтры зарегистрированы в порядке регистрации, обе фазы', async () => {
        await h.activate('reference');

        expect(h.llmFilters.list().map((entry) => entry.filter.id)).toEqual([
          h.reference.requestFilterId,
          h.reference.responseFilterId,
        ]);
        // Порядок фильтров фазы — тоже порядок регистрации.
        expect(h.llmFilters.list('pre_request').map((entry) => entry.filter.id)).toEqual([
          h.reference.requestFilterId,
        ]);
        // Владельца подставил хост.
        const request = h.llmFilters.get(h.reference.requestFilterId)!;
        expect(request.pluginName).toBe(h.reference.plugin);
        expect(request.pluginVersion).toBe('1.0.0');
        expect(request.trustLevel).toBe('trusted');
      });

      it('failMode по умолчанию — по классу фильтра и доверию владельца', async () => {
        await h.activate('reference');
        // Блокирующая фаза + доверенный владелец → closed.
        expect(h.llmFilters.get(h.reference.requestFilterId)!.failMode).toBe('closed');
        // Наблюдательная фаза → open (буферов и задержек нет, ADR-036).
        expect(h.llmFilters.get(h.reference.responseFilterId)!.failMode).toBe('open');

        await h.deactivate();

        // Недоверенный владелец в блокирующей фазе → open (права вето нет).
        await h.activate('untrusted-deny');
        const untrusted = h.llmFilters.get('plugin:contract-untrusted:block')!;
        expect(untrusted.trustLevel).toBe('community');
        expect(untrusted.failMode).toBe('open');
      });

      it('неизвестная фаза отклоняется, фильтр не регистрируется', async () => {
        const result = await h.activate('bad-phase');
        if (h.transport === 'inline') {
          // Inline: регистрация отклонена (предупреждение), активация жива —
          // `provides` фильтр не объявляет.
          expect(result.outcome).toBe('activated');
        } else {
          // Out-of-process: невалидная фаза в /capabilities — отказ импорта.
          expect(result.outcome).toBe('rejected');
        }
        expect(h.llmFilters.list()).toHaveLength(0);
        // Inline: «неизвестную фазу»; remote: `points.llmFilters[i].phase`.
        expect(refusalText(h, result)).toMatch(/фаз|phase/i);
      });

      it('неизвестный вердикт трактуется как сбой фильтра по failMode (fail-closed)', async () => {
        await h.activate('bad-verdict');
        const { providerCalls } = await h.runPreRequest();
        // Фильтр доверенного плагина в блокирующей фазе: сбой → `closed`.
        expect(providerCalls).toBe(0);
      });

      it('deny недоверенного плагина понижается до allow: вызов уходит провайдеру', async () => {
        await h.activate('untrusted-deny');
        const { providerCalls } = await h.runPreRequest();
        expect(providerCalls).toBe(1);
      });
    });

    // ── 3. Точка `tools` ─────────────────────────────────────────────────

    describe('точка tools', () => {
      it('эталонный плагин: инструмент в реестре под namespace, источник plugin', async () => {
        await h.activate('reference');

        const tool = h.tools.get(h.reference.fullToolName);
        expect(tool).toBeDefined();
        expect(tool!.source).toBe('plugin');
        expect(tool!.pluginName).toBe(h.reference.plugin);
        expect(tool!.name).not.toBe(h.reference.toolName);
        expect(h.tools.pluginLocalNames(h.reference.plugin)).toEqual([h.reference.toolName]);
        // Выборка сессии: плагинный слой отдельно от builtin/MCP.
        expect(h.tools.selectForSession([]).plugin.map((t) => t.function.name)).toEqual([
          h.reference.fullToolName,
        ]);
        await expect(
          tool!.execute({ query: 'x' }, { sessionId: 's1', messageId: 'm1', workingDir: '/ws' }),
        ).resolves.toEqual({ content: 'memory:{"query":"x"}' });
      });

      it('инструмент виден permission-слою и может быть запрещён', async () => {
        await h.activate('reference');
        // По умолчанию — allow.
        expect(h.checkPermission(h.reference.fullToolName).action).toBe('allow');
        // Групповое правило `plugin` накрывает плагинные инструменты.
        const denied = h.checkPermission(h.reference.fullToolName, { plugin: 'deny' });
        expect(denied.action).toBe('deny');
        expect(denied.matchedRule).toBe('plugin');
        // Правило по имени тула тоже работает.
        expect(
          h.checkPermission(h.reference.fullToolName, {
            plugin: 'allow',
            [h.reference.fullToolName]: 'deny',
          }).action,
        ).toBe('deny');
      });

      it('коллизия с builtin/MCP невозможна: имя с namespace, чужой тул не перезаписан', async () => {
        await h.activate('reference');
        // Встроенные инструменты набора не пострадали: их имена не в plugin-слое.
        for (const builtin of h.tools.listBuiltin()) {
          expect(builtin.source ?? 'builtin').toBe('builtin');
        }
        expect(h.tools.get('read_file')?.source ?? 'builtin').toBe('builtin');
        // Инструмент плагина не выдаёт себя за MCP (слой mcp пуст).
        expect(h.tools.listMcp(['contract-plugin'])).toHaveLength(0);
      });

      it('локальное имя в зарезервированном namespace отклоняется', async () => {
        const result = await h.activate('reserved-tool-name');
        // Регистрация отклонена → объявленный тул не появился → provides не сходится.
        expect(result.outcome).toBe('rejected');
        expect(result.reason).toBe('plugin.provides_mismatch');
        expect(h.tools.listPlugin()).toHaveLength(0);
        expect(h.warnings.join('\n')).toContain('plugin_');
      });
    });

    // ── 4. Сверка `provides` ─────────────────────────────────────────────

    describe('сверка provides ↔ фактические регистрации', () => {
      it('расхождение (объявлено ≠ зарегистрировано) — отказ активации с откатом', async () => {
        const result = await h.activate('provides-mismatch');
        expect(result.outcome).toBe('rejected');
        expect(result.reason).toBe('plugin.provides_mismatch');
        expect(result.step).toBe('facade');
        expect(result.message).toContain('declared_only');

        // Отклонённый плагин не оставил вкладов ни в одном реестре.
        expect(h.tools.listPlugin()).toHaveLength(0);
        expect(h.promptBlocks.size).toBe(0);
        expect(h.llmFilters.size).toBe(0);
        expect(h.host.isActive('contract-mismatch')).toBe(false);
      });

      it('эталонный плагин проходит сверку по всем трём видам вкладов', async () => {
        const result = await h.activate('reference');
        expect(result.outcome).toBe('activated');

        // Манифест фикстуры объявляет ровно то, что реально зарегистрировано.
        const provides = PLUGIN_FIXTURE_SET.reference.manifest.provides;
        expect(h.tools.pluginLocalNames(h.reference.plugin)).toEqual(provides.tools);
        expect(h.promptBlocks.list().map((entry) => entry.provider.key).sort()).toEqual(
          provides.promptBlocks.map((block) => block.key).sort(),
        );
        expect(h.llmFilters.list().map((entry) => entry.filter.id).sort()).toEqual(
          provides.llmFilters.map((filter) => filter.id).sort(),
        );
      });
    });

    // ── 5. Dispose-дисциплина ────────────────────────────────────────────

    describe('dispose-дисциплина', () => {
      it('после deactivate() не остаётся ни одной регистрации', async () => {
        await h.activate('reference');
        expect(h.promptBlocks.size).toBe(2);
        expect(h.llmFilters.size).toBe(2);
        expect(h.tools.listPlugin()).toHaveLength(1);

        const deactivated = await h.deactivate();
        expect(deactivated.outcome).toBe('ok');
        expect(deactivated.failures).toHaveLength(0);

        expect(h.promptBlocks.size).toBe(0);
        expect(h.llmFilters.size).toBe(0);
        expect(h.tools.listPlugin()).toHaveLength(0);
        expect(h.host.isActive(h.reference.plugin)).toBe(false);
        // Промпт больше не содержит плагинного блока.
        expect(await h.composeSystem()).not.toContain(h.reference.longContent.slice(0, 32));
      });

      it('повторная активация после деактивации проходит (disposers не копятся)', async () => {
        await h.activate('reference');
        await h.deactivate();
        const again = await h.activate('reference');
        expect(again.outcome).toBe('activated');
        expect(h.tools.listPlugin()).toHaveLength(1);
        expect(h.promptBlocks.size).toBe(2);
        expect(h.llmFilters.size).toBe(2);
      });
    });

    // ── 6. Запрет обхода ─────────────────────────────────────────────────

    describe('запрет обхода', () => {
      it('неизвестная capability инструмента — отказ, регистрации нет', async () => {
        const result = await h.activate('unknown-capability');
        expect(result.outcome).toBe('rejected');
        // Inline: реестр отверг тул → `provides` не сошёлся. Remote: тул с
        // неизвестной capability не проходит проверку /capabilities.
        expect(result.reason).toBe(
          h.transport === 'inline' ? 'plugin.provides_mismatch' : 'plugin.loader_unavailable',
        );
        expect(h.tools.listPlugin()).toHaveLength(0);
        expect(refusalText(h, result)).toContain('capability');
      });

      it('заявленный в манифесте trust не повышает фактический', async () => {
        await h.activate('untrusted-deny');
        const activation = h.host.getActivation('contract-untrusted');
        expect(activation).toBeDefined();
        // Манифест заявлял `trusted`, фактический уровень — community.
        expect(activation!.trustLevel).toBe('community');
        expect(h.llmFilters.get('plugin:contract-untrusted:block')!.trustLevel).toBe('community');
      });
    });

    // ── Набор фикстур ────────────────────────────────────────────────────

    it('набор фикстур полон: эталон + по одному нарушению на правило', () => {
      expect([...PLUGIN_CONTRACT_FIXTURES]).toContain('reference');
      expect(PLUGIN_CONTRACT_FIXTURES.length).toBeGreaterThanOrEqual(4);
      // Каждая фикстура — самостоятельный плагин (своё имя и манифест).
      for (const fixtureName of PLUGIN_CONTRACT_FIXTURES) {
        const fixture = PLUGIN_FIXTURE_SET[fixtureName];
        expect(fixture.name).toBe(fixture.manifest.name);
        expect(fixture.manifest.kind).toBe('plugin');
        expect(typeof fixture.apply).toBe('function');
      }
    });
  });
}
