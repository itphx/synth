/**
 * ADR-090, фаза **Ф5в**: каталог бандлов, поставленных
 * **образом/развёртыванием** (`plugins.deployDir`).
 *
 * ```text
 * deployDir/                  ← /opt/synth/plugins (образ) либо PVC
 *   ├── analytics/            ← подкаталог = бандл
 *   │   ├── synth.pack
 *   │   └── dist/index.js
 *   └── notes/
 *       ├── synth.pack
 *       └── dist/index.js
 * ```
 *
 * **Только разбор каталога.** Модуль ничего не устанавливает и на диск не
 * пишет: установка — `PluginRuntime.installDeployPlugins` (манифест → скан →
 * trust-floor → install-policy → раскладка/lock — тот же конвейер, что у
 * ручной установки, `PluginInstaller`). Образ — **доверенный источник кода, но
 * не повод отключать проверку содержимого**: скан и install-policy
 * применяются к deploy-бандлам без исключений.
 *
 * **Fail-soft.** Каталог не задан/отсутствует → пустой список (это норма:
 * standalone и образы без плагинов). Подкаталог без читаемого манифеста
 * (`synth.pack` отсутствует/битый/не прошёл валидацию) или с `kind !==
 * 'plugin'` **пропускается с предупреждением** — один испорченный бандл не
 * должен ломать разбор остальных и старт инстанса. Симлинки не читаются
 * (как в сканере и сборщике бандла): бандл — реальный каталог.
 *
 * Порядок — детерминированный (по имени подкаталога): установка идемпотентна,
 * а журнал/результат старта не «прыгают» между перезапусками.
 */
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

import type { PackManifest } from '@itphx/synth-shared';

import type { PluginLogger } from './activation.js';
import { readPluginManifest } from './installer.js';

/** Один бандл deploy-каталога (разобранный, но ещё не установленный). */
export interface PluginDeployScanEntry {
  /** Имя плагина из манифеста (`synth.pack`). */
  name: string;
  /** Версия плагина из манифеста. */
  version: string;
  /** Каталог бандла (`<deployDir>/<подкаталог>`). */
  dir: string;
  /** Разобранный и провалидированный манифест. */
  manifest: PackManifest;
}

/** Опции разбора (логгер — предупреждения о пропущенных бандлах). */
export interface ListDeployPluginsOptions {
  /** Логгер (по умолчанию — `console.warn` с префиксом `[plugin-deploy]`). */
  logger?: PluginLogger;
}

/**
 * Прочитать deploy-каталог: каждый подкаталог — бандл с `synth.pack`.
 *
 * Не бросает: нет каталога/нет доступа — пустой список; битый манифест —
 * запись пропускается с предупреждением, остальные разбираются.
 */
export async function listDeployPlugins(
  dir: string,
  opts: ListDeployPluginsOptions = {},
): Promise<PluginDeployScanEntry[]> {
  const logger: PluginLogger = opts.logger ?? {
    warn: (message: string) => {
      console.warn(`[plugin-deploy] ${message}`);
    },
  };

  const root = dir.trim();
  if (!root) return [];

  let items;
  try {
    items = await readdir(root, { withFileTypes: true });
  } catch {
    // Каталога нет — deploy-плагинов не поставлено (штатный случай).
    return [];
  }
  items.sort((a, b) => a.name.localeCompare(b.name));

  const entries: PluginDeployScanEntry[] = [];
  for (const item of items) {
    // Бандл — реальный каталог: симлинк наружу не читаем (containment).
    if (!item.isDirectory() || item.isSymbolicLink()) continue;
    const bundleDir = join(root, item.name);
    const manifestRead = await readPluginManifest(bundleDir);
    if (!manifestRead.ok) {
      logger.warn(
        `deploy-бандл «${item.name}» пропущен: ${manifestRead.message}`,
      );
      continue;
    }
    entries.push({
      name: manifestRead.manifest.name,
      version: manifestRead.manifest.version,
      dir: bundleDir,
      manifest: manifestRead.manifest,
    });
  }
  return entries;
}
