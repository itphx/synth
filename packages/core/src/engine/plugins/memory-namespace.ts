/**
 * ADR-107 / PROP-047 §3: имя плагина памяти и namespace его памяти.
 *
 * Константы живут здесь, а не в HTTP-слое (`server/routes/memory.ts`):
 * ими пользуются и портал памяти, и коллектор метрик (`metrics/collectors/
 * memory.ts`) — зависимость наблюдаемости от HTTP-слоя лишняя. HTTP-слой
 * реэкспортирует их, поэтому публичный API ядра не изменился.
 *
 * Namespace навязывает хост (ADR-107): плагин памяти его не выбирает, а
 * портал/метрики читают ровно этот namespace.
 */
import { pluginMemoryNamespace } from './scoped-memory.js';

/** Имя плагина памяти (PROP-047 §3, манифест `synth.pack`). */
export const MEMORY_PLUGIN_NAME = 'synth-plugin-memory';

/**
 * Namespace памяти плагина памяти.
 *
 * Тот же формат, что навязывает хост плагинам (`plugin:<имя плагина>`,
 * `engine/plugins/scoped-memory.ts`) — правило одно, дублировать нельзя.
 */
export const MEMORY_NAMESPACE = pluginMemoryNamespace(MEMORY_PLUGIN_NAME);
