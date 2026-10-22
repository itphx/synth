/**
 * PROP-090 §«Два режима исполнения» → «`inline`»: **загрузчик кода плагина**.
 *
 * Единственная задача — довести шаг `import` пайплайна `PluginHost` до
 * рабочего состояния: взять **уже распакованный** бандл (`installed/<name>@<version>/`,
 * PROP-090 §5), проверить его расположение/расширение/размер и импортировать
 * ESM-файл, вернув `apply(facade)`.
 *
 * **Bundle-only (PROP-090 §8).** Загрузчик **не** резолвит npm-зависимости и не
 * ходит в npm/registry: он просто делает `import()` файла бандла. Всё, кроме
 * `@itphx/*`, должно быть вшито в бандл сборкой плагина; `@itphx/*` — external
 * (peer): их резолвит Node из `node_modules` ядра — это **ожидаемое** поведение,
 * а не «дырка» (ядро и плагин видят один и тот же `@itphx/synth-shared`).
 *
 * **Fail-closed.** Все проверки бросают {@link PluginLoadError} с машиночитаемой
 * причиной; наружу «сырые» исключения `fs`/`import()` не уходят. `PluginHost`
 * превращает бросок в отказ активации: `plugin.loader_unavailable` (нет
 * `rootDir`, файл вне корня, не `.js`/`.mjs`, превышен размер, сбой `import()`)
 * либо `plugin.module_invalid` (модуль загружен, но контракт `PluginModule` не
 * выполнен).
 *
 * **Правила (Ф4а).**
 * 1. `descriptor.rootDir` обязателен — иначе загружать нечего.
 * 2. Точка входа — `join(rootDir, descriptor.entry ?? 'dist/index.js')`
 *    (`entry` из `plugins.lock.json`); **containment**: `realpath` каталога и
 *    файла, файл обязан лежать внутри `realpath(rootDir)` — отсекает `..`,
 *    абсолютные пути и симлинки наружу.
 * 3. Расширение входа — только `.js`/`.mjs` (бандл, а не `.ts`/`.cjs`).
 * 4. Размер файла ≤ `maxBundleBytes` (по умолчанию 8 МиБ) — защита от
 *    «случайного» гигабайта в каталоге установки.
 * 5. `import()` с cache-busting: `?v=<contentHash|mtimeMs>` — иначе после
 *    переустановки плагина ESM-кэш вернул бы старый модуль.
 * 6. Форма модуля: `module.apply` (функция) | `module.default.apply` |
 *    `module.default` (функция = `apply`); иначе `plugin.module_invalid`.
 */
import { realpath, stat } from 'node:fs/promises';
import { extname, isAbsolute, join, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

import { PluginLoadError } from './activation.js';
import type {
  PluginActivationDescriptor,
  PluginFacade,
  PluginLoader,
  PluginLogger,
  PluginModule,
} from './activation.js';

/** Точка входа бандла по умолчанию (`plugins.lock.json` → `entry`). */
export const DEFAULT_PLUGIN_ENTRY = 'dist/index.js';

/** Предел размера бандла по умолчанию — 8 МиБ. */
export const DEFAULT_MAX_PLUGIN_BUNDLE_BYTES = 8 * 1024 * 1024;

/** Допустимые расширения точки входа (ESM-бандл; не `.ts`/`.cjs`). */
export const PLUGIN_BUNDLE_EXTENSIONS = ['.js', '.mjs'] as const;

/** Опции `inline`-загрузчика. */
export interface InlinePluginLoaderOptions {
  /** Максимальный размер бандла (по умолчанию 8 МиБ) — защита от «случайного» гигабайта. */
  maxBundleBytes?: number;
  /** Логгер (по умолчанию `console.warn`). */
  logger?: PluginLogger;
  /** Переопределение `import()` — для тестов (по умолчанию динамический import). */
  importModule?: (url: string) => Promise<unknown>;
}

/** Вид `apply`, который обязан предоставить модуль плагина. */
type PluginApply = (facade: PluginFacade) => void | Promise<void>;

/**
 * Создать `inline`-загрузчик плагинов (`PluginLoader`).
 *
 * Загрузчик не вызывает `apply` — это делает `PluginHost` на шаге `facade`
 * (иначе фасад собирался бы до проверки соответствия `provides`).
 */
export function createInlinePluginLoader(
  options: InlinePluginLoaderOptions = {},
): PluginLoader {
  const maxBundleBytes = options.maxBundleBytes ?? DEFAULT_MAX_PLUGIN_BUNDLE_BYTES;
  const logger: PluginLogger = options.logger ?? {
    warn: (message: string) => {
      console.warn(`[plugin-loader] ${message}`);
    },
  };
  const importModule = options.importModule ?? ((url: string) => import(url));

  return async (descriptor: PluginActivationDescriptor): Promise<PluginModule> => {
    const rootDir = descriptor.rootDir?.trim();
    if (!rootDir) {
      throw new PluginLoadError(
        `Плагин «${descriptor.name}»: каталог бандла (rootDir) не задан — загружать нечего.`,
      );
    }

    const entry = descriptor.entry?.trim() || DEFAULT_PLUGIN_ENTRY;
    if (isAbsolute(entry)) {
      throw new PluginLoadError(
        `Плагин «${descriptor.name}»: точка входа «${entry}» задана абсолютным путём — ` +
        `допустим только относительный путь внутри каталога бандла.`,
      );
    }

    const entryPath = join(rootDir, entry);
    const rootReal = await realpathOrFail(rootDir, `каталог бандла «${rootDir}»`, descriptor.name);
    const fileReal = await realpathOrFail(entryPath, `точка входа «${entry}»`, descriptor.name);

    // Containment по realpath: и `..`, и симлинк наружу дают путь вне корня.
    if (!isInside(rootReal, fileReal)) {
      throw new PluginLoadError(
        `Плагин «${descriptor.name}»: точка входа «${entry}» ведёт за пределы каталога бандла ` +
        `(«${fileReal}» вне «${rootReal}») — загрузка запрещена.`,
      );
    }

    const extension = extname(fileReal);
    if (!(PLUGIN_BUNDLE_EXTENSIONS as readonly string[]).includes(extension)) {
      throw new PluginLoadError(
        `Плагин «${descriptor.name}»: точка входа «${entry}» имеет расширение «${extension || '—'}», ` +
        `а загружается только собранный бандл (${PLUGIN_BUNDLE_EXTENSIONS.join('/')}).`,
      );
    }

    const info = await statOrFail(fileReal, entry, descriptor.name);
    if (!info.isFile()) {
      throw new PluginLoadError(
        `Плагин «${descriptor.name}»: точка входа «${entry}» — не файл.`,
      );
    }
    if (info.size > maxBundleBytes) {
      throw new PluginLoadError(
        `Плагин «${descriptor.name}»: бандл «${entry}» больше предела ` +
        `(${info.size} > ${maxBundleBytes} байт) — загрузка запрещена.`,
      );
    }

    // Cache-busting: после переустановки (новый `?v=`) ESM-кэш не отдаёт старый модуль.
    const version = descriptor.contentHash ?? String(info.mtimeMs);
    if (!descriptor.contentHash) {
      logger.warn(
        `плагин «${descriptor.name}»: content-hash не задан — cache-busting по mtime ` +
        `(${version}); после переустановки возможен устаревший модуль в кэше ESM.`,
      );
    }
    const url = `${pathToFileURL(fileReal).href}?v=${encodeURIComponent(version)}`;

    let imported: unknown;
    try {
      imported = await importModule(url);
    } catch (err) {
      throw new PluginLoadError(
        `Плагин «${descriptor.name}»: загрузка модуля «${entry}» завершилась ошибкой: ` +
        `${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const apply = resolveApply(imported);
    if (!apply) {
      throw new PluginLoadError(
        `Плагин «${descriptor.name}»: модуль «${entry}» не выполнил контракт PluginModule — ` +
        `нет apply(facade) (ожидается export function apply, export default { apply } ` +
        `или export default function).`,
        'plugin.module_invalid',
      );
    }

    return { apply };
  };
}

/** Лежит ли `target` внутри `root` (или совпадает с ним). */
function isInside(root: string, target: string): boolean {
  if (target === root) return true;
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
  return target.startsWith(prefix);
}

/** `realpath` с понятной ошибкой (`plugin.loader_unavailable`). */
async function realpathOrFail(
  path: string,
  what: string,
  plugin: string,
): Promise<string> {
  try {
    return await realpath(path);
  } catch (err) {
    throw new PluginLoadError(
      `Плагин «${plugin}»: ${what} недоступен(а): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/** `stat` с понятной ошибкой (`plugin.loader_unavailable`). */
async function statOrFail(path: string, entry: string, plugin: string) {
  try {
    return await stat(path);
  } catch (err) {
    throw new PluginLoadError(
      `Плагин «${plugin}»: точка входа «${entry}» недоступна: ` +
      `${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Достать `apply` из импортированного модуля.
 *
 * Принимаются три формы (PROP-090 §«`inline`»): `module.apply`,
 * `module.default.apply`, `module.default` (функция = `apply`). Namespace
 * модуля — всегда объект; функция вместо namespace контрактом не
 * предусмотрена (иначе `Function.prototype.apply` был бы принят за `apply`).
 */
function resolveApply(imported: unknown): PluginApply | undefined {
  if (typeof imported !== 'object' || imported === null) return undefined;
  const namespace = imported as Record<string, unknown>;

  const direct = namespace.apply;
  if (typeof direct === 'function') return direct as PluginApply;

  const fallback = namespace.default;
  if (typeof fallback === 'function') return fallback as PluginApply;
  if (typeof fallback === 'object' && fallback !== null) {
    const nested = (fallback as Record<string, unknown>).apply;
    if (typeof nested === 'function') return nested as PluginApply;
  }
  return undefined;
}
