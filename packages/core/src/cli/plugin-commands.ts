/**
 * ADR-090, фаза Ф5б (часть 3): группа команд
 * управления плагинами — установка, подтверждение из карантина, список,
 * включение/выключение, снятие и dry-run скан.
 *
 * Модуль **общий для двух CLI**: `packages/core/src/main.ts` (dev/standalone) и
 * `packages/synth/src/cli.ts` (публичная обёртка — импорт из
 * `@itphx/synth-core/cli/plugin-commands.js`, ADR-038). Оба объявляют группу
 * через {@link createPluginCommand}, поэтому состав команд и коды выхода не
 * расходятся.
 *
 * **Что делает контекст ({@link createPluginCliContext}).** Резолвинг путей —
 * теми же резолверами, что остальные команды (`loadConfig` →
 * `resolveDataDir`/`resolveHome`, ADR-023/ADR-079), слой хранения — общим
 * каскадом `buildStorageContext` (`file`/`memory`/`postgres`, ADR-096/098),
 * поэтому порты `pluginAudit`/`pluginLock` и runtime-настройки (`plugins.json`)
 * читаются так же, как у сервера. Раскладка (`<home>/plugin` или
 * `{dataDir}/plugin`) — `resolvePluginLayout`; её `plugins.lock.json`
 * передаётся в контекст хранения явно (`pluginLockPath`), иначе при `--home`
 * порт смотрел бы не туда. Реестры вкладов (`promptBlocks`/`llmFilters`/`tools`)
 * в CLI-процессе свои: команда проверяет активацию (гейты + аудит), но не
 * обслуживает сессии.
 *
 * **Почему CLI — standalone-инструмент.** Он работает с **локальными** файлами
 * инстанса (`installed/`, `quarantine/`, `plugins.lock.json`, `audit/
 * plugins.jsonl`). Управление работающим managed-инстансом — через HTTP API
 * (`/api/v2/plugins*`, Ф5б-2) и UI: CLI ничего не переинициализирует в чужом
 * процессе (инвариант 24). При `storage.backend=postgres` контекст собирается
 * тем же путём, что `synth doctor`/`synth backup`; недоступная БД — внятная
 * ошибка, а не «тихий» файловый фоллбек.
 *
 * **Коды выхода.** `0` — операция выполнена (в т.ч. `approval_required` —
 * бандл в карантине, и «не установлен» для `remove`); `1` — отказ по гейту,
 * ошибка ввода или отсутствующий артефакт. Ошибки печатаются в `stderr`
 * (`message` без стектрейса), результат — в `stdout`.
 */
import { resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';

import { Command } from 'commander';
import {
  catalogTrustLevelSchema,
  ensureDataDir,
  loadConfig,
  resolveDataDir,
  resolveHome,
  resolveStorageBackend,
  SYNTH_VERSION,
} from '@itphx/synth-shared';
import type { CatalogTrustLevel, PluginAuditReason } from '@itphx/synth-shared';

import type {
  PluginActivationResult,
  PluginDeactivationResult,
} from '../engine/plugins/activation.js';
import { computePluginContentHash } from '../engine/plugins/integrity.js';
import type { PluginInstallOutcome } from '../engine/plugins/installer.js';
import type { PluginRollbackOutcome, PluginUpdateOutcome } from '../engine/plugins/installer.js';
import { collectBundleFiles, readPluginManifest } from '../engine/plugins/installer.js';
import type { PluginInstallSourceKind } from '../engine/plugins/sources.js';
import {
  PLUGIN_INSTALL_SOURCE_KINDS,
  inferPluginSourceKind,
  isPluginInstallSourceKind,
} from '../engine/plugins/sources.js';
import type { PluginLayout } from '../engine/plugins/layout.js';
import { resolvePluginLayout } from '../engine/plugins/layout.js';
import type { PluginRuntimeEntry } from '../engine/plugins/runtime.js';
import { PluginRuntime } from '../engine/plugins/runtime.js';
import { scanPluginDirectory } from '../engine/plugins/scan/scanner.js';
import { PromptBlockRegistry } from '../engine/context/prompt-block-registry.js';
import { LlmFilterRegistry } from '../engine/gateway/llm-filter-registry.js';
import { createToolRegistry } from '../engine/tools/index.js';
import { mergePluginsConfig } from '../storage/runtime-settings.js';
import type { StorageContext } from '../storage/storage-context.js';
import { buildStorageContext } from '../storage/storage-context.js';

/** Инициатор операций CLI (аудит плагинов). */
const ACTOR = 'cli';

/** Опции CLI-контекста (`--data-dir`, `--home`, `--config`). */
export interface PluginCliOptions {
  /** Явный каталог данных (`--data-dir`, приоритетнее config.yaml). */
  dataDir?: string;
  /** Локальный home-каталог (ADR-079; `null` — не задан). */
  home?: string | null;
  /** Путь к `config.yaml`. */
  configPath?: string;
  /** Источник env (`SYNTH_*`); по умолчанию — `process.env`. */
  env?: NodeJS.ProcessEnv;
}

/**
 * Собранный контекст команды: рантайм плагинов (хост + установщик), раскладка
 * и освобождение ресурсов (деактивация вкладов + закрытие backend'а
 * хранилища — пул PG).
 */
export interface PluginCliContext {
  /** Рантайм плагинов (Ф5б-1): `list`/`activate`/`deactivate`/`installer`. */
  runtime: PluginRuntime;
  /** Раскладка слоя плагинов (`installed/`/`quarantine/`/lock). */
  layout: PluginLayout;
  /** Освободить контекст (идемпотентно; вызывается в `finally`). */
  dispose(): Promise<void>;
}

/** Зависимости группы команд (фабрика контекста — для тестов подменяется). */
export interface PluginCommandDeps {
  createContext: (opts: PluginCliOptions) => Promise<PluginCliContext>;
}

/**
 * Собрать контекст из CLI-флагов (`--data-dir`, `--home`, `--config`).
 *
 * Резолвинг — общими резолверами (`@itphx/synth-shared`), сборка хранилища —
 * общим каскадом (`buildStorageContext`, ADR-096), поэтому поведение при
 * `backend=postgres` совпадает с `synth doctor`/`synth backup` (схема не
 * мигрируется — `postgresSchemaMode: 'skip'`).
 */
export async function createPluginCliContext(
  opts: PluginCliOptions = {},
): Promise<PluginCliContext> {
  const env = opts.env ?? process.env;
  const home = resolveHome(opts.home ?? null, env);
  const synth = await loadConfig({
    ...(opts.configPath ? { configPath: opts.configPath } : {}),
    ...(home ? { home } : {}),
    env,
  });
  const dataDir = resolve(opts.dataDir || resolveDataDir(synth, env, home));
  await ensureDataDir(dataDir);

  const layout = resolvePluginLayout({ home, dataDir, env });

  let storage: StorageContext;
  try {
    storage = await buildStorageContext({
      dataDir,
      config: synth,
      env,
      home,
      // Схема БД не мигрируется: команда не обслуживает схему (это `synth migrate`).
      postgresSchemaMode: 'skip',
      // Lock-файл — по раскладке (при `--home` это `<home>/plugin/…`, а не `{dataDir}/plugin/…`).
      pluginLockPath: layout.lockPath,
    });
  } catch (err) {
    const backend = resolveStorageBackend(synth, env);
    throw new Error(
      `не удалось открыть хранилище инстанса (storage.backend=${backend}): ` +
        `${err instanceof Error ? err.message : String(err)}. ` +
        '`synth plugin` работает с локальными файлами инстанса: проверьте доступность БД ' +
        'или управляйте плагинами работающего инстанса через API/UI.',
    );
  }

  // Эффективный конфиг слоя: config.yaml (+env) поверх runtime-настроек
  // (`settings.json`/PG) — тот же приоритет, что у сервера (`server/app/deps.ts`).
  const config = mergePluginsConfig(synth.plugins, await storage.settings.getPlugins());

  const runtime = new PluginRuntime({
    layout,
    config,
    hostVersion: SYNTH_VERSION,
    audit: storage.pluginAudit,
    lock: storage.pluginLock,
    // Реестры вкладов — свои: CLI проверяет активацию, но не обслуживает сессии.
    promptBlocks: new PromptBlockRegistry(),
    llmFilters: new LlmFilterRegistry(),
    tools: createToolRegistry(),
  });

  let disposed = false;
  return {
    runtime,
    layout,
    dispose: async () => {
      if (disposed) return;
      disposed = true;
      await runtime.dispose();
      await storage.close?.();
    },
  };
}

// ── Вывод ──────────────────────────────────────────────────────────────

/** Человекочитаемая подсказка к коду отказа (в `stderr`, рядом с ошибкой). */
function writeReasonHint(reason: PluginAuditReason | undefined): void {
  switch (reason) {
    case 'plugin.execution_disabled':
      console.error(
        '  Подсказка: исполнение кода плагинов выключено — включите plugins.executionEnabled ' +
          '(config.yaml или Настройки → «Плагины») и перезапустите инстанс.',
      );
      break;
    case 'plugin.runtime_install_denied':
      console.error(
        '  Подсказка: установка во время работы запрещена (plugins.runtimeInstall=deny) — ' +
          'включите plugins.runtimeInstall=allow и перезапустите инстанс.',
      );
      break;
    case 'plugin.approval_required':
      console.error('  Подсказка: подтвердите установку: synth plugin approve <name>');
      break;
    case 'plugin.trust_below_floor':
      console.error(
        '  Подсказка: уровень доверия ниже plugins.trustFloor — политика инстанса запрещает установку.',
      );
      break;
    case 'plugin.scan_disabled_with_execution':
      console.error(
        '  Подсказка: скан выключен, а исполнение включено (fail-closed) — включите plugins.scan=enable.',
      );
      break;
    case 'plugin.not_found':
      console.error('  Подсказка: плагин не установлен — synth plugin list');
      break;
    case 'plugin.not_active':
      console.error('  Подсказка: плагин не активен в этом процессе.');
      break;
    case 'plugin.source_unavailable':
      console.error(
        '  Подсказка: источник недоступен — проверьте путь/архив, доступность npm-пакета ' +
          'и совпадение контрольной суммы (SRI/sha256).',
      );
      break;
    case 'plugin.rollback_unavailable':
      console.error(
        '  Подсказка: откатываться некуда — плагин не обновлялся (нет ступени previous) ' +
          'или каталог предыдущей версии удалён; поставьте нужную версию: synth plugin install <ref>.',
      );
      break;
    case 'plugin.already_active':
      console.error('  Подсказка: плагин уже активен в этом процессе.');
      break;
    case 'plugin.managed_readonly':
      console.error(
        '  Подсказка: плагин управляется развёртыванием (plugins.deployDir) — снять или ' +
          'переустановить его через API/CLI нельзя. Новый образ/переразвёртывание каталога — ' +
          'единственный способ изменить такой плагин (plugins.managedReadonly).',
      );
      break;
    default:
      break;
  }
}

/** Итог установки/подтверждения → код выхода и сообщение человеку. */
function printInstallOutcome(outcome: PluginInstallOutcome): number {
  if (outcome.outcome === 'installed') {
    console.log(`Установлен: ${outcome.name}@${outcome.version}`);
    console.log(`  каталог: ${outcome.dir}`);
    console.log(`  content-hash: ${outcome.contentHash}`);
    const activation = outcome.activated;
    if (activation) {
      if (activation.outcome === 'activated') {
        console.log('  активация: активен (проверка в процессе CLI; инстанс применит после перезапуска)');
      } else {
        console.log(
          `  активация: отклонена (${activation.reason ?? 'без кода'})` +
            (activation.message ? ` — ${activation.message}` : ''),
        );
        writeReasonHint(activation.reason);
      }
    }
    return 0;
  }
  if (outcome.outcome === 'approval_required') {
    console.log(`В карантине: ${outcome.name}@${outcome.version}`);
    console.log(`  ${outcome.reason}`);
    console.log(`  Подтвердите установку: synth plugin approve ${outcome.name}`);
    return 0;
  }
  console.error(`Отклонено${outcome.name ? ` (${outcome.name})` : ''}: ${outcome.reason}`);
  console.error(`  ${outcome.message}`);
  writeReasonHint(outcome.reason);
  return 1;
}

/** Итог обновления → код выхода и сообщение человеку. */
function printUpdateOutcome(outcome: PluginUpdateOutcome): number {
  if (outcome.outcome === 'unchanged') {
    console.log(`Уже актуален: ${outcome.name} v${outcome.version}`);
    return 0;
  }
  if (outcome.outcome === 'updated') {
    console.log(
      `Обновлён: ${outcome.name} v${outcome.previousVersion} → v${outcome.version}`,
    );
    console.log(`  каталог: ${outcome.dir}`);
    console.log(`  content-hash: ${outcome.contentHash}`);
    const activation = outcome.activated;
    if (activation) {
      if (activation.outcome === 'activated') {
        console.log(
          '  активация: активен (проверка в процессе CLI; инстанс применит после перезапуска)',
        );
      } else {
        console.log(
          `  активация: отклонена (${activation.reason ?? 'без кода'})` +
            (activation.message ? ` — ${activation.message}` : ''),
        );
        writeReasonHint(activation.reason);
      }
    }
    return 0;
  }
  if (outcome.reason === 'plugin.approval_required') {
    console.log(`Обновление отложено (карантин): ${outcome.name}`);
    console.log(`  ${outcome.message}`);
    console.log(`  Подтвердите установку: synth plugin approve ${outcome.name}`);
    return 0;
  }
  console.error(`Обновление отклонено (${outcome.name}): ${outcome.reason}`);
  console.error(`  ${outcome.message}`);
  writeReasonHint(outcome.reason);
  return 1;
}

/** Итог отката → код выхода и сообщение человеку. */
function printRollbackOutcome(outcome: PluginRollbackOutcome): number {
  if (outcome.outcome === 'rolled_back') {
    console.log(
      `Откат: ${outcome.name} v${outcome.previousVersion} → v${outcome.version}`,
    );
    const activation = outcome.activated;
    if (activation) {
      if (activation.outcome === 'activated') {
        console.log(
          '  активация: активен (проверка в процессе CLI; инстанс применит после перезапуска)',
        );
      } else {
        console.log(
          `  активация: отклонена (${activation.reason ?? 'без кода'})` +
            (activation.message ? ` — ${activation.message}` : ''),
        );
        writeReasonHint(activation.reason);
      }
    }
    return 0;
  }
  console.error(`Откат отклонён (${outcome.name}): ${outcome.reason}`);
  console.error(`  ${outcome.message}`);
  writeReasonHint(outcome.reason);
  return 1;
}

/** Итог активации (`enable`). */
function printActivationResult(result: PluginActivationResult): number {
  if (result.outcome === 'activated') {
    console.log(`Включён: ${result.plugin}@${result.version}`);
    console.log(
      '  (проверка активации в процессе CLI; работающий инстанс — через API/UI, ' +
        'изменения применяются после перезапуска)',
    );
    return 0;
  }
  console.error(`Не включён: ${result.reason ?? 'без кода'}`);
  if (result.message) console.error(`  ${result.message}`);
  writeReasonHint(result.reason);
  return 1;
}

/** Итог деактивации (`disable`). */
function printDeactivationResult(result: PluginDeactivationResult): number {
  if (result.outcome === 'ok') {
    console.log(
      `Выключен: ${result.plugin}@${result.version} (снято вкладов: ${result.disposed})`,
    );
    console.log(
      '  (проверка деактивации в процессе CLI; работающий инстанс — через API/UI, ' +
        'изменения применяются после перезапуска)',
    );
    return 0;
  }
  console.error(`Не выключен: ${result.reason ?? 'без кода'}`);
  if (result.message) console.error(`  ${result.message}`);
  writeReasonHint(result.reason);
  return 1;
}

/** Строка таблицы `list` (ширины фиксированы, чтобы вывод читался в терминале). */
function formatListRow(entry: PluginRuntimeEntry): string {
  return [
    entry.name.padEnd(30),
    entry.version.padEnd(10),
    entry.trustLevel.padEnd(10),
    entry.scanVerdict.padEnd(10),
    entry.active ? 'да' : 'нет',
  ].join(' ');
}

// ── Подтверждение ──────────────────────────────────────────────────────

/**
 * Подтвердить активацию (исполняет код плагина).
 *
 * `--yes` — без вопросов (для автоматизации). Без TTY подтверждение получить
 * нельзя: отказ с подсказкой, а не «тихое исполнение» кода.
 */
async function confirmActivation(label: string, yes: boolean): Promise<boolean> {
  if (yes) return true;
  if (!process.stdin.isTTY) {
    console.error(
      'Ошибка: активация исполняет код плагина — для неинтерактивного запуска добавьте --yes.',
    );
    return false;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(
      `Активировать «${label}»? Код плагина будет исполнен в процессе CLI. [y/N] `,
    );
    return /^(y|yes|д|да)$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

// ── Исполнение команды ────────────────────────────────────────────────

/** Общие флаги путей — как у остальных групп CLI (`session`, `secrets`). */
function addCommonOptions(cmd: Command): Command {
  return cmd
    .option('--data-dir <path>', 'каталог данных')
    .option('--config <path>', 'путь к config.yaml')
    .option('--home <path>', 'локальный home-каталог (config/data/profiles/credentials)');
}

/** Опции команды → опции контекста. */
function contextOptions(options: Record<string, unknown>): PluginCliOptions {
  return {
    ...(typeof options.dataDir === 'string' ? { dataDir: options.dataDir } : {}),
    ...(typeof options.home === 'string' ? { home: options.home } : {}),
    ...(typeof options.config === 'string' ? { configPath: options.config } : {}),
  };
}

/**
 * Выполнить действие в контексте: собрать, выполнить, **всегда** освободить.
 *
 * Код выхода выставляется через `process.exitCode` (не `process.exit`), чтобы
 * `finally` успел закрыть хранилище и снять вклады плагинов.
 */
async function withContext(
  deps: PluginCommandDeps,
  options: Record<string, unknown>,
  fn: (ctx: PluginCliContext) => Promise<number>,
): Promise<void> {
  let ctx: PluginCliContext | undefined;
  let code = 1;
  try {
    ctx = await deps.createContext(contextOptions(options));
    code = await fn(ctx);
  } catch (err) {
    console.error(`Ошибка: ${err instanceof Error ? err.message : String(err)}`);
    code = 1;
  } finally {
    if (ctx) {
      try {
        await ctx.dispose();
      } catch (err) {
        console.error(
          `Ошибка освобождения контекста: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }
  process.exitCode = code;
}

/** `synth plugin list [--json]` — установленные плагины и статус активации. */
function createListCommand(deps: PluginCommandDeps): Command {
  const cmd = new Command('list').description('Установленные плагины и статус активации');
  addCommonOptions(cmd.option('--json', 'машиночитаемый вывод (JSON)'));
  return cmd.action(async (options: Record<string, unknown>) => {
    await withContext(deps, options, async ({ runtime }) => {
      const entries = await runtime.list();
      if (options.json) {
        console.log(JSON.stringify(entries, null, 2));
        return 0;
      }
      if (entries.length === 0) {
        console.log('Плагины не установлены.');
        return 0;
      }
      console.log(
        ['ИМЯ'.padEnd(30), 'ВЕРСИЯ'.padEnd(10), 'ДОВЕРИЕ'.padEnd(10), 'СКАН'.padEnd(10), 'АКТИВЕН'].join(
          ' ',
        ),
      );
      for (const entry of entries) console.log(formatListRow(entry));
      return 0;
    });
  });
}

/** `synth plugin install <ref>` — установка из источника (dir/archive/npm/url). */
function createInstallCommand(deps: PluginCommandDeps): Command {
  const cmd = new Command('install').description(
    'Установить плагин из источника: каталог, .tgz/.tar.gz, npm-пакет или https-URL ' +
      '(манифест → скан → install-policy)',
  );
  // `.argument()` до опций: commander ожидает аргументы в объявленном порядке.
  cmd.argument('<ref>', 'путь (каталог или архив), npm-имя пакета либо https-URL архива');
  addCommonOptions(
    cmd
      .option('--source <kind>', 'вид источника: dir | archive | npm | url (по умолчанию — по <ref>)')
      .option('--version <version>', 'npm: точная версия или latest (по умолчанию latest)')
      .option('--sha256 <hex>', 'url: обязательный pin — sha256 архива (64 hex-символа)')
      .option(
        '--trust <level>',
        'уровень доверия: builtin | verified | trusted | community',
        'community',
      )
      .option('--activate', 'активировать после установки (исполняет код — спросит подтверждение)')
      .option('--yes', 'не спрашивать подтверждение активации'),
  );
  return cmd.action(async (ref: string, options: Record<string, unknown>) => {
    const rawRef = typeof ref === 'string' ? ref.trim() : '';
    if (!rawRef) {
      console.error('Ошибка: укажите источник — путь, npm-имя пакета или https-URL.');
      process.exitCode = 1;
      return;
    }

    // Вид источника: явный `--source` или вывод по ссылке (путь → dir/archive,
    // https → url, иначе npm-имя; не опознали — dir: ошибка будет про манифест).
    let kind: PluginInstallSourceKind;
    if (options.source !== undefined) {
      if (!isPluginInstallSourceKind(options.source)) {
        console.error(
          `Ошибка: неизвестный вид источника «${String(options.source)}» — ожидается ` +
            `${PLUGIN_INSTALL_SOURCE_KINDS.join(' | ')}.`,
        );
        process.exitCode = 1;
        return;
      }
      kind = options.source;
    } else {
      kind = inferPluginSourceKind(rawRef);
    }
    // Локальные источники — абсолютный путь (одинаково для CLI и lock-записи).
    const sourceRef =
      kind === 'dir' || kind === 'archive' ? resolve(rawRef) : rawRef;

    const sha256 = typeof options.sha256 === 'string' ? options.sha256.trim().toLowerCase() : '';
    if (kind === 'url' && !/^[0-9a-f]{64}$/.test(sha256)) {
      console.error(
        'Ошибка: для источника url обязателен pin --sha256 <hex> (64 hex-символа) — ' +
          'произвольный адрес без контрольной суммы не устанавливается.',
      );
      process.exitCode = 1;
      return;
    }

    const trustParsed = catalogTrustLevelSchema.safeParse(options.trust);
    if (!trustParsed.success) {
      console.error(
        `Ошибка: неизвестный уровень доверия «${String(options.trust)}» — ожидается ` +
          `${catalogTrustLevelSchema.options.join(' | ')}.`,
      );
      process.exitCode = 1;
      return;
    }
    const trustLevel: CatalogTrustLevel = trustParsed.data;
    const version = typeof options.version === 'string' ? options.version.trim() : '';
    const activate = options.activate === true;
    if (activate && !(await confirmActivation(sourceRef, options.yes === true))) {
      console.error('Отменено: активация не подтверждена.');
      process.exitCode = 1;
      return;
    }
    await withContext(deps, options, async ({ runtime }) => {
      const outcome = await runtime.installer.installFromSource({
        kind,
        ref: sourceRef,
        ...(version ? { version } : {}),
        ...(sha256 ? { sha256 } : {}),
        trustLevel,
        // CLI — офлайн-операция оператора на файлах инстанса, а не установка
        // «во время работы» через API: политика `plugins.runtimeInstall`
        // (`deny` по умолчанию) к ней не применяется — иначе CLI был бы
        // неработоспособен на дефолтном конфиге. Применение — после рестарта
        // инстанса (инвариант 24).
        installKind: 'deploy',
        ...(activate ? { activate: true } : {}),
        actor: ACTOR,
      });
      return printInstallOutcome(outcome);
    });
  });
}

/** `synth plugin update <name>` — обновление из источника записи lock (Д2). */
function createUpdateCommand(deps: PluginCommandDeps): Command {
  const cmd = new Command('update').description(
    'Обновить плагин из источника записи lock (npm/local/url; гейты те же, что у установки)',
  );
  cmd.argument('<name>', 'имя плагина');
  addCommonOptions(
    cmd
      .option('--version <version>', 'npm: точная версия или latest (по умолчанию latest)')
      .option('--sha256 <hex>', 'url: обязательный новый pin — sha256 архива (64 hex-символа)')
      .option('--activate', 'активировать после обновления (исполняет код — спросит подтверждение)')
      .option('--yes', 'не спрашивать подтверждение активации'),
  );
  return cmd.action(async (name: string, options: Record<string, unknown>) => {
    const activate = options.activate === true;
    if (activate && !(await confirmActivation(name, options.yes === true))) {
      console.error('Отменено: активация не подтверждена.');
      process.exitCode = 1;
      return;
    }
    await withContext(deps, options, async ({ runtime }) => {
      const outcome = await runtime.installer.update(name, {
        ...(typeof options.version === 'string' && options.version.trim()
          ? { version: options.version.trim() }
          : {}),
        ...(typeof options.sha256 === 'string' && options.sha256.trim()
          ? { sha256: options.sha256.trim().toLowerCase() }
          : {}),
        ...(activate ? { activate: true } : {}),
        // CLI — офлайн-операция оператора (как `install`): политика
        // `plugins.runtimeInstall` к ней не применяется (инвариант 24).
        installKind: 'deploy',
        actor: ACTOR,
      });
      return printUpdateOutcome(outcome);
    });
  });
}

/** `synth plugin rollback <name>` — откат на предыдущую версию (Д2). */
function createRollbackCommand(deps: PluginCommandDeps): Command {
  const cmd = new Command('rollback').description(
    'Откатить плагин на предыдущую версию (ступень `previous` записи lock)',
  );
  cmd.argument('<name>', 'имя плагина');
  addCommonOptions(cmd);
  return cmd.action(async (name: string, options: Record<string, unknown>) => {
    await withContext(deps, options, async ({ runtime }) => {
      const outcome = await runtime.installer.rollback(name, { actor: ACTOR });
      return printRollbackOutcome(outcome);
    });
  });
}

/** `synth plugin approve <name>` — подтверждение бандла из карантина. */
function createApproveCommand(deps: PluginCommandDeps): Command {
  const cmd = new Command('approve').description(
    'Подтвердить бандл из карантина (install-policy ask → установка)',
  );
  cmd.argument('<name>', 'имя плагина');
  addCommonOptions(
    cmd
      .option('--version <version>', 'версия карантина (если их несколько)')
      .option('--activate', 'активировать после установки (исполняет код — спросит подтверждение)')
      .option('--yes', 'не спрашивать подтверждение активации'),
  );
  return cmd.action(async (name: string, options: Record<string, unknown>) => {
    const activate = options.activate === true;
    if (activate && !(await confirmActivation(name, options.yes === true))) {
      console.error('Отменено: активация не подтверждена.');
      process.exitCode = 1;
      return;
    }
    await withContext(deps, options, async ({ runtime }) => {
      const outcome = await runtime.installer.approve(name, {
        ...(typeof options.version === 'string' ? { version: options.version } : {}),
        ...(activate ? { activate: true } : {}),
        actor: ACTOR,
      });
      return printInstallOutcome(outcome);
    });
  });
}

/** `synth plugin enable <name>` — активация установленного плагина. */
function createEnableCommand(deps: PluginCommandDeps): Command {
  const cmd = new Command('enable').description('Активировать установленный плагин (шаги §10)');
  cmd.argument('<name>', 'имя плагина');
  addCommonOptions(cmd);
  return cmd.action(async (name: string, options: Record<string, unknown>) => {
    await withContext(deps, options, async ({ runtime }) => {
      const result = await runtime.activate(name, { actor: ACTOR });
      return printActivationResult(result);
    });
  });
}

/** `synth plugin disable <name>` — деактивация (обратная прокрутка disposers). */
function createDisableCommand(deps: PluginCommandDeps): Command {
  const cmd = new Command('disable').description('Деактивировать плагин (снять его вклады)');
  cmd.argument('<name>', 'имя плагина');
  addCommonOptions(cmd);
  return cmd.action(async (name: string, options: Record<string, unknown>) => {
    await withContext(deps, options, async ({ runtime }) => {
      const result = await runtime.deactivate(name, { actor: ACTOR });
      if (result.outcome === 'ok') return printDeactivationResult(result);

      // CLI — одноразовый процесс: активных вкладов в нём по определению нет
      // (активация живёт в процессе инстанса). `plugin.not_active` для
      // **установленного** плагина — штатный исход «снимать нечего», а не
      // ошибка: иначе команда всегда падала бы с кодом 1. Не установлен —
      // по-прежнему ошибка ввода.
      if (result.reason === 'plugin.not_active') {
        const installed = await runtime.installer.list();
        if (installed.some((entry) => entry.name === name)) {
          console.log(
            `Плагин «${name}» не активен в процессе CLI — снимать нечего. ` +
              '(Состояние активации живёт в процессе инстанса: работающий инстанс — через API/UI, ' +
              'при перезапуске плагины активируются по plugins.lock.json.)',
          );
          return 0;
        }
        // Не установлен: `deactivate` не различает «не активен» и «нет записи»,
        // поэтому уточняем по lock — это ошибка ввода, а не штатный no-op.
        console.error('Не выключен: plugin.not_found');
        console.error(`  Плагин «${name}» не установлен — выключать нечего.`);
        writeReasonHint('plugin.not_found');
        return 1;
      }
      return printDeactivationResult(result);
    });
  });
}

/** `synth plugin remove <name>` — снятие установки (деструктивно → `--yes`). */
function createRemoveCommand(deps: PluginCommandDeps): Command {
  const cmd = new Command('remove').description(
    'Снять установку плагина (lock + каталог; деструктивно — требует --yes)',
  );
  cmd.argument('<name>', 'имя плагина');
  addCommonOptions(
    cmd
      .option('--keep-files', 'оставить каталог бандла (снять только запись lock)')
      .option('--yes', 'подтвердить деструктивную операцию'),
  );
  return cmd.action(async (name: string, options: Record<string, unknown>) => {
    if (options.yes !== true) {
      console.error(
        'Ошибка: снятие плагина удаляет каталог бандла и запись lock — ' +
          'повторите с --yes (или --keep-files, чтобы сохранить файлы).',
      );
      process.exitCode = 1;
      return;
    }
    await withContext(deps, options, async ({ runtime }) => {
      const result = await runtime.installer.uninstall(name, {
        removeFiles: options.keepFiles !== true,
        actor: ACTOR,
      });
      if (result.rejected) {
        console.error(`Не снят (${name}): ${result.rejected.reason}`);
        console.error(`  ${result.rejected.message}`);
        writeReasonHint(result.rejected.reason);
        return 1;
      }
      if (!result.removed) {
        console.log(`Плагин «${name}» не установлен.`);
        return 0;
      }
      console.log(
        `Снят: ${name}` + (options.keepFiles === true ? ' (файлы бандла сохранены)' : ''),
      );
      if (result.deactivated) console.log('  (был активен в процессе CLI — деактивирован)');
      return 0;
    });
  });
}

/**
 * `synth plugin scan <path>` — dry-run: манифест + скан каталога **без записи
 * на диск** (контекст не собирается, `installed/`/lock/аудит не трогаются).
 */
function createScanCommand(): Command {
  const cmd = new Command('scan').description(
    'Проверить бандл без установки (манифест + вердикт сканера, ничего не пишет)',
  );
  cmd.argument('<path>', 'каталог распакованного бандла (synth.pack + dist/)');
  cmd.option('--json', 'машиночитаемый вывод (JSON)');
  return cmd.action(async (path: string, options: Record<string, unknown>) => {
    try {
      process.exitCode = await runScan(resolve(path), options.json === true);
    } catch (err) {
      console.error(`Ошибка: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    }
  });
}

/** Тело `scan`: вердикт сканера и content-hash; `1` только при `dangerous`. */
async function runScan(dir: string, json: boolean): Promise<number> {
  const manifestRead = await readPluginManifest(dir);
  if (!manifestRead.ok) {
    console.error(`Ошибка: ${manifestRead.message}`);
    return 1;
  }
  const manifest = manifestRead.manifest;
  const { files, binaryFiles } = await collectBundleFiles(dir);
  const contentHash = computePluginContentHash(files);
  const report = await scanPluginDirectory(dir);

  if (json) {
    console.log(
      JSON.stringify(
        {
          path: dir,
          manifest: {
            name: manifest.name,
            version: manifest.version,
            kind: manifest.kind,
            ...(manifest.description ? { description: manifest.description } : {}),
          },
          verdict: report.verdict,
          findings: report.findings,
          contentHash,
          scannedFiles: report.scannedFiles,
          binaryFiles,
          performed: report.performed,
        },
        null,
        2,
      ),
    );
  } else {
    console.log(`Плагин: ${manifest.name}@${manifest.version} (${manifest.kind})`);
    console.log(`Вердикт: ${report.verdict}`);
    console.log(`  content-hash: ${contentHash}`);
    console.log(
      `  файлов: ${report.scannedFiles}, из них бинарных: ${binaryFiles.length}` +
        (report.truncated ? ' (обход прерван по квоте)' : ''),
    );
    if (report.findings.length === 0) {
      console.log('  находок нет');
    } else {
      for (const finding of report.findings) {
        console.log(
          `  - ${finding.category}/${finding.severity}: ${finding.file}` +
            (finding.line > 0 ? `:${finding.line}` : '') +
            ` — ${finding.description}`,
        );
      }
    }
    if (report.verdict === 'caution') {
      console.log(`  Установка потребует подтверждения: synth plugin approve ${manifest.name}`);
    }
  }
  return report.verdict === 'dangerous' ? 1 : 0;
}

// ── Группа команд ──────────────────────────────────────────────────────

/**
 * Собрать группу `synth plugin …` для подключения в обоих CLI
 * (`main.ts` и `packages/synth/src/cli.ts`).
 *
 * `deps.createContext` — фабрика контекста; в CLI это
 * {@link createPluginCliContext}, в тестах — подмена (герметичный `dataDir`).
 */
export function createPluginCommand(deps: PluginCommandDeps): Command {
  return new Command('plugin')
    .description('Плагины (ADR-090): установка, проверка, обновление, откат, снятие')
    .addCommand(createListCommand(deps))
    .addCommand(createInstallCommand(deps))
    .addCommand(createUpdateCommand(deps))
    .addCommand(createRollbackCommand(deps))
    .addCommand(createApproveCommand(deps))
    .addCommand(createEnableCommand(deps))
    .addCommand(createDisableCommand(deps))
    .addCommand(createRemoveCommand(deps))
    .addCommand(createScanCommand());
}
