/**
 * ADR-071 §2.1 + ADR-090: реестр инструментов.
 *
 * Три источника (`ToolDefinition.source`):
 * - `builtin` — встроенные (слой `tools`, `stable`);
 * - `mcp` — инструменты MCP-серверов (`mcp.tools`, `volatile`);
 * - `plugin` — инструменты плагинов (ADR-090, Ф3в): регистрируются фасадом
 *   `PluginHost` с namespace-именем `plugin_<plugin>_<tool>` и снимаются
 *   disposer'ом при деактивации плагина.
 */
import type { ToolDefinition, ToolForLLM, ToolCapability, ToolSource } from '@itphx/synth-shared';
import {
  ToolCapability as ToolCapabilityValues,
  isValidPluginToolLocalName,
  pluginToolFullName,
  pluginToolLocalName,
} from '@itphx/synth-shared';
import { zodToJsonSchema } from './json-schema.js';

/** Известные capabilities (валидация вкладов плагина, ADR-090). */
const KNOWN_CAPABILITIES: ReadonlySet<string> = new Set(Object.values(ToolCapabilityValues));

/** Причина отказа регистрации плагинного инструмента. */
export type PluginToolRefusalReason =
  | 'invalid_name'
  | 'invalid_definition'
  | 'invalid_capability'
  | 'name_conflict';

/** Отказ регистрации плагинного инструмента (активация плагина не падает). */
export interface PluginToolRefusal {
  ok: false;
  reason: PluginToolRefusalReason;
  /** Человекочитаемая причина (в лог хоста плагинов). */
  message: string;
}

/** Итог регистрации плагинного инструмента. */
export type PluginToolRegistration = { ok: true; name: string } | PluginToolRefusal;

export class ToolRegistry {
  private readonly _tools = new Map<string, ToolDefinition>();

  register(tool: ToolDefinition): void {
    // ADR-071 §2.1: встроенные инструменты не тегируют источник явно — дефолт
    // `builtin` проставляется централизованно здесь; MCP-регистрация передаёт
    // `source: 'mcp'` + `mcpServer` и сохраняется как есть.
    this._tools.set(tool.name, { source: 'builtin', ...tool });
  }

  registerAll(tools: ToolDefinition[]): void {
    for (const tool of tools) {
      this.register(tool);
    }
  }

  /**
   * ADR-090: зарегистрировать инструмент плагина под
   * namespace-именем `plugin_<plugin>_<tool>`.
   *
   * Регистрация **атомарна и проверяема**: имя составляется хостом (не
   * плагином), capabilities валидируются по известному набору, коллизия с
   * builtin/MCP/другим плагином — отказ (иначе плагин подменил бы встроенный
   * тул). Отказ не бросает исключение: вызывающий (фасад) пишет
   * предупреждение и продолжает активацию.
   *
   * @param tool — определение с **локальным** именем (без префикса).
   * @param pluginName — имя плагина-владельца (источник namespace).
   */
  registerPlugin(tool: ToolDefinition, pluginName: string): PluginToolRegistration {
    const owner = pluginName?.trim() ?? '';
    if (!owner) {
      return {
        ok: false,
        reason: 'invalid_name',
        message: 'Инструмент плагина без имени плагина-владельца — регистрация отклонена.',
      };
    }
    const localName = tool?.name?.trim() ?? '';
    if (!localName || !isValidPluginToolLocalName(localName)) {
      return {
        ok: false,
        reason: 'invalid_name',
        message:
          `Инструмент плагина «${owner}»: недопустимое имя «${tool?.name ?? ''}» — `
          + 'ожидается локальное имя ([A-Za-z0-9_-], без префикса plugin_).',
      };
    }

    const capabilities = tool.capabilities ?? [];
    if (typeof tool.execute !== 'function') {
      return {
        ok: false,
        reason: 'invalid_definition',
        message:
          `Инструмент плагина «${owner}» («${localName}»): не задан исполнитель (execute) — `
          + 'регистрация отклонена.',
      };
    }
    if (!tool.parameters || typeof (tool.parameters as { safeParse?: unknown }).safeParse !== 'function') {
      return {
        ok: false,
        reason: 'invalid_definition',
        message:
          `Инструмент плагина «${owner}» («${localName}»): параметры не являются zod-схемой — `
          + 'регистрация отклонена.',
      };
    }
    if (capabilities.length === 0) {
      return {
        ok: false,
        reason: 'invalid_capability',
        message:
          `Инструмент плагина «${owner}» («${localName}»): не задана ни одна capability — `
          + 'тул был бы невидим permission-правилам и admin-отключению.',
      };
    }
    const unknown = capabilities.find((capability) => !KNOWN_CAPABILITIES.has(capability));
    if (unknown !== undefined) {
      return {
        ok: false,
        reason: 'invalid_capability',
        message:
          `Инструмент плагина «${owner}» («${localName}»): неизвестная capability `
          + `«${String(unknown)}» — регистрация отклонена.`,
      };
    }
    if (capabilities.includes('mcp')) {
      // Слой `mcp.tools` и его настройки (per-server) — только для MCP-серверов;
      // плагин не может выдать свой тул за MCP-инструмент.
      return {
        ok: false,
        reason: 'invalid_capability',
        message:
          `Инструмент плагина «${owner}» («${localName}»): capability «mcp» зарезервирована `
          + 'за инструментами MCP-серверов — регистрация отклонена.',
      };
    }
    if (capabilities.includes('runtime')) {
      // `runtime` — примитивы ядра (`plan_*`/`todo_*`/`classify_conversation`),
      // они **неотключаемы** админом (`tools.disabled`). Плагин с этой
      // capability завёл бы в инстансе тул, который владелец не сможет снять, —
      // эскалация прав, поэтому отказ (fail-closed).
      return {
        ok: false,
        reason: 'invalid_capability',
        message:
          `Инструмент плагина «${owner}» («${localName}»): capability «runtime» зарезервирована `
          + 'за примитивами ядра (неотключаемы админом) — регистрация отклонена.',
      };
    }

    const fullName = pluginToolFullName(owner, localName);
    const existing = this._tools.get(fullName);
    if (existing) {
      const existingSource: ToolSource = existing.source ?? 'builtin';
      return {
        ok: false,
        reason: 'name_conflict',
        message:
          `Инструмент плагина «${owner}» («${localName}») конфликтует с уже `
          + `зарегистрированным «${fullName}» (источник: ${existingSource}) — регистрация отклонена.`,
      };
    }

    this._tools.set(fullName, {
      ...tool,
      name: fullName,
      source: 'plugin',
      pluginName: owner,
      capabilities: [...capabilities] as ToolCapability[],
    });
    return { ok: true, name: fullName };
  }

  deregister(name: string): boolean {
    return this._tools.delete(name);
  }

  deregisterAll(names: string[]): void {
    for (const name of names) {
      this._tools.delete(name);
    }
  }

  deregisterByCapability(capability: ToolCapability): number {
    let count = 0;
    for (const [name, tool] of this._tools) {
      if (tool.capabilities.includes(capability)) {
        this._tools.delete(name);
        count++;
      }
    }
    return count;
  }

  get(name: string): ToolDefinition | undefined {
    return this._tools.get(name);
  }

  list(): ToolDefinition[] {
    return [...this._tools.values()];
  }

  /** ADR-071 §2.1: встроенные инструменты (слой `tools`, stable). */
  listBuiltin(): ToolDefinition[] {
    return [...this._tools.values()].filter((tool) => (tool.source ?? 'builtin') === 'builtin');
  }

  /**
   * ADR-071 §2.1: MCP-инструменты указанных серверов (per-session выборка).
   * Пустой набор → пустой список (safety против утечки чужих MCP-тулов).
   */
  listMcp(serverNames: Iterable<string>): ToolDefinition[] {
    const allowed = new Set(serverNames);
    return [...this._tools.values()].filter((tool) => {
      if ((tool.source ?? 'builtin') !== 'mcp') return false;
      return tool.mcpServer != null && allowed.has(tool.mcpServer);
    });
  }

  /**
   * ADR-090: инструменты плагинов (все активные плагины).
   *
   * Плагины инстанс-локальны (не per-session): список отдаётся целиком, а
   * доступность/режимы решает permission-слой (группа `plugin`, ADR-029).
   * Не задан `pluginName` — все плагинные тулы.
   */
  listPlugin(pluginName?: string): ToolDefinition[] {
    return [...this._tools.values()].filter((tool) => {
      if ((tool.source ?? 'builtin') !== 'plugin') return false;
      return pluginName === undefined || tool.pluginName === pluginName;
    });
  }

  /**
   * ADR-071 §2.1 + ADR-090: per-session выборка инструментов — встроенные,
   * плагинные и MCP только активных серверов сессии. Порядок: встроенные →
   * плагинные → MCP (кэш-брейкпоинт ставится после встроенных, см.
   * `stableToolCount`: плагинные и MCP-тулы вне stable-префикса — их состав
   * меняется в runtime).
   *
   * ADR-071 §2.3: фильтр отбирает только доступные тулы (режим `available`) —
   * на уровне `ToolDefinition`, до конвертации в LLM-формат (capabilities
   * теряются в `ToolForLLM`). Слои фильтруются **независимо**: объектная форма
   * задаёт предикат на слой (`builtin`/`plugin`/`mcp`).
   */
  selectForSession(
    mcpServers: Iterable<string> = [],
    predicate?: {
      builtin?: (tool: ToolDefinition) => boolean;
      plugin?: (tool: ToolDefinition) => boolean;
      mcp?: (tool: ToolDefinition) => boolean;
    },
  ): { builtin: ToolForLLM[]; plugin: ToolForLLM[]; mcp: ToolForLLM[] } {
    const allowBuiltin = predicate?.builtin ?? (() => true);
    const allowPlugin = predicate?.plugin ?? (() => true);
    const allowMcp = predicate?.mcp ?? (() => true);
    return {
      builtin: this.listBuiltin().filter(allowBuiltin).map((tool) => this._toolToLLM(tool)),
      plugin: this.listPlugin().filter(allowPlugin).map((tool) => this._toolToLLM(tool)),
      // Без набора серверов MCP-слой пуст (не «все MCP»): safety против утечки.
      mcp: this.listMcp(mcpServers).filter(allowMcp).map((tool) => this._toolToLLM(tool)),
    };
  }

  toLLMFormat(): ToolForLLM[] {
    const result: ToolForLLM[] = [];
    for (const tool of this._tools.values()) {
      result.push(this._toolToLLM(tool));
    }
    return result;
  }

  /**
   * ADR-071 §2.1 + ADR-090: инструменты для сессии — встроенные, плагинные и
   * MCP активных серверов. Без `mcpServers` MCP-слой пуст (safety: не отдавать
   * чужие MCP-тулы); плагинные тулы инстанс-локальны и отдаются всегда.
   */
  toLLMFormatForSession(mcpServers?: Iterable<string>): ToolForLLM[] {
    const selection = this.selectForSession(mcpServers);
    return [...selection.builtin, ...selection.plugin, ...selection.mcp];
  }

  /**
   * ADR-071 §2.6: LLM-представление одного тула — для расчёта `chars`/`estTokens`
   * (тот же формат, что уходит в слой `tools`/`mcp.tools` манифеста).
   */
  toLLM(tool: ToolDefinition): ToolForLLM {
    return this._toolToLLM(tool);
  }

  /**
   * ADR-090: локальные имена тулов плагина (для сверки
   * `provides.tools[]` — префикс namespace в манифест не входит).
   */
  pluginLocalNames(pluginName: string): string[] {
    return this.listPlugin(pluginName)
      .map((tool) => pluginToolLocalName(tool.name, pluginName))
      .filter((name): name is string => name !== undefined);
  }

  private _toolToLLM(tool: ToolDefinition): ToolForLLM {
    const jsonSchema = tool.jsonSchema ?? zodToJsonSchema(tool.parameters);
    return {
      type: 'function' as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: jsonSchema,
      },
    };
  }
}

