/**
 * PROP-090 §«Точка `tools`»: namespace инструментов плагина.
 *
 * Модуль browser-safe (только типы и чистые функции) — его используют и ядро
 * (`ToolRegistry`, фасад `PluginHost`), и будущий пакет `@itphx/synth-plugin`.
 *
 * **Зачем namespace.** Общий `ToolRegistry` держит встроенные (`builtin`),
 * MCP- (`{serverName}_{toolName}`) и плагинные инструменты. Плагин — чужой
 * код: без префикса он мог бы занять имя встроенного тула (`read_file`) и
 * подменить его поведение. Поэтому имя тула плагина — всегда
 * `plugin_<pluginNamespace>_<toolName>`, а в манифесте (`provides.tools[]`)
 * объявляется **локальное** имя (без префикса) — так пример манифеста из
 * PROP-090 (`"tools": ["memory_search"]`) остаётся валидным.
 *
 * Сверка `provides.tools[]` ↔ фактические регистрации идёт по **локальным**
 * именам (`pluginToolLocalName`): префикс — деталь реестра, а не контракта.
 */

/** Префикс имени плагинного инструмента (`plugin_…`). */
export const PLUGIN_TOOL_NAME_PREFIX = 'plugin';

/**
 * Namespace плагина в имени тула: имя расширения в нижнем регистре, все
 * небуквенно-цифровые символы → `_`.
 *
 * Пример: `@acme/synth-plugin-memory` → `acme_synth_plugin_memory`,
 * `demo-plugin` → `demo_plugin`. Namespace не пуст даже для имени из
 * недопустимых символов (fallback — `plugin`) — имя тула обязано оставаться
 * валидным идентификатором.
 */
export function pluginToolNamespace(pluginName: string): string {
  const slug = (pluginName ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return slug || PLUGIN_TOOL_NAME_PREFIX;
}

/**
 * Полное имя тула плагина в `ToolRegistry`: `plugin_<namespace>_<toolName>`.
 *
 * @example pluginToolFullName('demo-plugin', 'memory_search')
 *   // 'plugin_demo_plugin_memory_search'
 */
export function pluginToolFullName(pluginName: string, toolName: string): string {
  return `${PLUGIN_TOOL_NAME_PREFIX}_${pluginToolNamespace(pluginName)}_${toolName}`;
}

/**
 * Локальное имя тула (без namespace) по полному имени реестра.
 *
 * `undefined` — имя не принадлежит этому плагину (чужой префикс): сверка
 * `provides.tools[]` такие имена не принимает.
 */
export function pluginToolLocalName(
  fullName: string,
  pluginName: string,
): string | undefined {
  const prefix = `${PLUGIN_TOOL_NAME_PREFIX}_${pluginToolNamespace(pluginName)}_`;
  const name = fullName ?? '';
  if (!name.startsWith(prefix)) return undefined;
  const local = name.slice(prefix.length);
  return local === '' ? undefined : local;
}

/**
 * Локальное имя тула плагина — допустимый идентификатор: латиница/цифры,
 * `_`/`-`, начинается с буквы или цифры. Пробелы, точки и `plugin_`-префикс
 * (зарезервированный namespace) недопустимы.
 */
export const PLUGIN_TOOL_LOCAL_NAME_REGEX = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/** Локальное имя тула плагина валидно (см. `PLUGIN_TOOL_LOCAL_NAME_REGEX`). */
export function isValidPluginToolLocalName(name: string): boolean {
  if (!PLUGIN_TOOL_LOCAL_NAME_REGEX.test(name ?? '')) return false;
  // Namespace зарезервирован: `plugin_` в локальном имени означал бы двойной
  // префикс и делал бы сверку `provides` неоднозначной.
  return !(name ?? '').toLowerCase().startsWith(`${PLUGIN_TOOL_NAME_PREFIX}_`);
}
