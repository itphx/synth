/**
 * PROP-090 §5: раскладка слоя плагинов на диске + карантин.
 *
 * ```text
 * <home>/plugin/                    # без home — {dataDir}/plugin/
 * ├── installed/
 * │   └── <name>@<version>/
 * │       ├── synth.pack            # манифест (kind: plugin)
 * │       ├── dist/index.js         # бандл
 * │       └── PLUGIN_INTEGRITY.json # { sha256, source, fetched_at }
 * ├── quarantine/                   # всё скачанное распаковывается и сканируется здесь
 * ├── plugins.lock.json             # провенанс — источник истины для update/uninstall
 * └── plugins.json                  # runtime-override включений/настроек
 * ```
 *
 * Приоритет корня (ADR-079, home-модель): явный флаг home > env `SYNTH_HOME` >
 * `{dataDir}/plugin`. Резолвер home — общий `resolveHome`
 * (`@itphx/synth-shared/config`), чтобы пути не расходились с остальным
 * локальным инстансом (`<home>/profiles.json`, `<home>/credentials.json`).
 *
 * **Карантин.** Всё распакованное попадает в `quarantine/` и сканируется там;
 * при решении install-policy `allow` бандл переносится в `installed/`, при
 * `ask`/`block` — остаётся изолированным в карантине и в `installed/` **не
 * попадает** (PROP-090 §5). Сам путь скачивания/доставки — Ф5; здесь только
 * раскладка и запись lock.
 */
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type { InstallPolicyAction } from '@itphx/synth-shared';
import { resolveHome } from '@itphx/synth-shared/config';

import { computePluginContentHash } from './integrity.js';

/** Раскладка слоя плагинов (пути). */
export interface PluginLayout {
  /** Корень раскладки (`<home>/plugin` или `{dataDir}/plugin`). */
  root: string;
  /** Каталог установленных плагинов. */
  installedDir: string;
  /** Каталог карантина. */
  quarantineDir: string;
  /** Путь к lock-файлу (`plugins.lock.json`). */
  lockPath: string;
  /** Путь к файлу runtime-override (`plugins.json`). */
  settingsPath: string;
}

/**
 * Разрешить раскладку слоя плагинов.
 *
 * @param home явный home-каталог (CLI `--home`); `null`/`undefined` — берётся
 *   env `SYNTH_HOME` (ADR-079).
 * @param dataDir каталог данных инстанса (без home раскладка живёт в нём).
 */
export function resolvePluginLayout(opts: {
  home?: string | null;
  dataDir: string;
  env?: NodeJS.ProcessEnv;
}): PluginLayout {
  const home = resolveHome(opts.home, opts.env);
  const root = home ? join(home, 'plugin') : join(opts.dataDir, 'plugin');
  return {
    root,
    installedDir: join(root, 'installed'),
    quarantineDir: join(root, 'quarantine'),
    lockPath: join(root, 'plugins.lock.json'),
    settingsPath: join(root, 'plugins.json'),
  };
}

/** Имя каталога бандла — `<name>@<version>`. */
export function pluginBundleDirName(name: string, version: string): string {
  return `${name}@${version}`;
}

/** Каталог установленного бандла (`installed/<name>@<version>`). */
export function pluginInstalledDir(layout: PluginLayout, name: string, version: string): string {
  return join(layout.installedDir, pluginBundleDirName(name, version));
}

/** Каталог карантина (`quarantine/<name>@<version>`). */
export function pluginQuarantineDir(layout: PluginLayout, name: string, version: string): string {
  return join(layout.quarantineDir, pluginBundleDirName(name, version));
}

/** Создать каталоги раскладки (`installed/`, `quarantine/`). */
export async function ensurePluginLayout(layout: PluginLayout): Promise<void> {
  await mkdir(layout.installedDir, { recursive: true });
  await mkdir(layout.quarantineDir, { recursive: true });
}

/** Содержимое `PLUGIN_INTEGRITY.json` (PROP-090 §5). */
export interface PluginIntegrityFile {
  /** sha256 бандла (content-hash). */
  sha256: string;
  /** Источник установки. */
  source?: string;
  /** Время получения бандла (ISO-8601). */
  fetched_at: string;
}

/** Вход раскладки бандла. */
export interface PluginBundleStageInput {
  /** Имя плагина. */
  name: string;
  /** Версия плагина. */
  version: string;
  /** Файлы бандла (относительный путь → содержимое). */
  files: Record<string, string>;
  /** Решение install-policy (`allow` → в `installed/`, иначе — карантин). */
  action: InstallPolicyAction;
  /** Источник установки (пишется в `PLUGIN_INTEGRITY.json`). */
  source?: string;
  /** Content-hash (по умолчанию — считается из файлов). */
  contentHash?: string;
  /** Момент получения бандла (ISO-8601; по умолчанию — сейчас). */
  fetchedAt?: string;
}

/** Результат раскладки бандла. */
export interface PluginBundleStageResult {
  /** Каталог, в котором лежит бандл. */
  dir: string;
  /** Бандл установлен (в `installed/`)? */
  installed: boolean;
  /** Причина, если бандл не установлен. */
  reason?: 'approval_required' | 'blocked';
  /** Content-hash бандла. */
  contentHash: string;
}

/**
 * Разложить бандл по раскладке.
 *
 * `allow` → бандл уезжает в `installed/<name>@<version>/`; `ask`/`block` →
 * остаётся в `quarantine/<name>@<version>/` (в `installed/` не попадает).
 *
 * Файл `PLUGIN_INTEGRITY.json` пишется в обоих случаях — он нужен и для
 * разбора карантина, и для сверки целостности при активации.
 */
export async function stagePluginBundle(
  layout: PluginLayout,
  input: PluginBundleStageInput,
): Promise<PluginBundleStageResult> {
  await ensurePluginLayout(layout);
  const contentHash = input.contentHash ?? computePluginContentHash(input.files);
  const installed = input.action === 'allow';
  const dir = installed
    ? pluginInstalledDir(layout, input.name, input.version)
    : pluginQuarantineDir(layout, input.name, input.version);

  // Карантин → установка: каталог мог остаться от прошлой попытки.
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });

  for (const [relPath, content] of Object.entries(input.files)) {
    const target = join(dir, relPath);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content, 'utf-8');
  }

  const integrity: PluginIntegrityFile = {
    sha256: contentHash,
    ...(input.source ? { source: input.source } : {}),
    fetched_at: input.fetchedAt ?? new Date().toISOString(),
  };
  await writeFile(join(dir, 'PLUGIN_INTEGRITY.json'), `${JSON.stringify(integrity, null, 2)}\n`, 'utf-8');

  return {
    dir,
    installed,
    ...(installed
      ? {}
      : { reason: input.action === 'ask' ? ('approval_required' as const) : ('blocked' as const) }),
    contentHash,
  };
}

/**
 * Перенести бандл из карантина в `installed/` (после подтверждения владельца).
 *
 * Каталог карантина удаляется — бандл уходит из изоляции.
 */
export async function releaseFromQuarantine(
  layout: PluginLayout,
  name: string,
  version: string,
): Promise<string> {
  const from = pluginQuarantineDir(layout, name, version);
  const to = pluginInstalledDir(layout, name, version);
  await mkdir(layout.installedDir, { recursive: true });
  await rm(to, { recursive: true, force: true });
  await rename(from, to);
  return to;
}
