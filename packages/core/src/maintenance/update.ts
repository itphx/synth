// ADR-092 + ADR-133: тело CLI-команды `synth update` — проверка, обновление и
// **откат** пакета по каналам. Переиспользуется dev-CLI (`packages/core/src/main.ts`)
// и публичным `synth` (`packages/synth/src/cli.ts`, паритет PROP-053); логики в
// CLI нет.
//
// Канал выводится из установленной версии (`-beta.` ⇒ beta), override —
// `--channel auto|stable|beta` / `updates.channel`. Реестр — по каналу
// (`updates.stableRegistry`/`updates.betaRegistry`), `--registry <url>`
// перебивает. Без флагов поведение прежнее: stable → npmjs.
//
// Без `--apply`/с `--check` команда только проверяет (текущая/целевая версия,
// что делать), `--dry-run` печатает план и **ничего не запускает**, `--apply`
// ставит `@itphx/synth@<version>` через `npm install -g … --registry …`.
// Целевая версия из `--to` валидируется (semver) и проверяется по списку
// реестра **этого** канала; beta → stable — откат («ОТКАТ на релиз»).
//
// Перед установкой (только `--apply`) — preflight user-level prefix:
// `npm prefix -g` должен быть внутри `$HOME`; root/системную установку не
// трогаем (иначе `npm install -g` пишет в системный каталог).
//
// Аудит (best-effort, ADR-092): `update.checked` — при проверке; успех —
// `update.applied`/`rollback.applied`, провал — `update.failed`
// (`details: {from, to, channel, registry, version}`).
import { spawn } from 'node:child_process';
import { SYNTH_VERSION, type UpdatesConfig } from '@itphx/synth-shared';
import type { MaintenanceAuditRepository } from '../storage/ports/maintenance-audit-repository.js';
import {
  DEFAULT_STABLE_REGISTRY,
  compareVersions,
  fetchAvailableVersions,
  fetchLatestVersion,
  isSemver,
  resolveUpdateChannel,
  resolveUpdatesRegistry,
  type UpdateChannel,
  type UpdateChannelChoice,
} from '../update-checker.js';
import { recordMaintenanceAudit } from './audit.js';
import { checkUserLevelPrefix } from './self-update.js';

/** Имя публикуемого пакета CLI (`@itphx/synth`, ADR-038). */
const PACKAGE_NAME = '@itphx/synth';

/** Тип операции обновления (ADR-092). */
export type UpdateOperation = 'update' | 'rollback' | 'none';

/** Человекочитаемые названия операций. */
const OPERATION_LABELS: Record<UpdateOperation, string> = {
  update: 'обновление',
  rollback: 'откат',
  none: 'без изменений',
};

/** Инъекция сети/установки (ADR-092/ADR-133) — тесты не ходят в реестр. */
export interface UpdateCommandDeps {
  /** Список версий из реестра канала. */
  fetchVersions?: (opts: { channel: UpdateChannel; registry: string }) => Promise<string[]>;
  /** Последняя версия канала (`dist-tags.latest`/`dist-tags.beta`). */
  fetchLatest?: (opts: { channel: UpdateChannel; registry: string }) => Promise<string>;
  /** Установка версии: код возврата (по умолчанию — `npm install -g`). */
  install?: (version: string, registry: string) => Promise<number>;
  /** Текущая версия (по умолчанию — `SYNTH_VERSION`). */
  currentVersion?: string;
  /**
   * Preflight user-level prefix: вернуть текст отказа или `null` (ок).
   * По умолчанию — реальная проверка `npm prefix -g` внутри `$HOME`; при
   * инъекции `install` (тесты/кастом) по умолчанию **не** выполняется.
   */
  preflight?: () => Promise<string | null>;
  /** `$HOME` для preflight (тесты). */
  home?: string;
  /** Канал из конфига (`updates.channel`), если флаг `--channel` не задан. */
  configChannel?: UpdateChannelChoice;
  /** Эффективная секция `updates` (реестры каналов). */
  updates?: Partial<UpdatesConfig>;
}

/** Опции CLI-команды `synth update` (ADR-092/ADR-133). */
export interface UpdateCommandOptions {
  /** Каталог данных инстанса (резолвится CLI: `--data-dir`/`--home`/config). */
  dataDir: string;
  /** Целевая версия (`--to`), без «v». `undefined` → последняя версия канала. */
  to?: string;
  /** Установить целевую версию (без него — только проверка). */
  apply?: boolean;
  /** Только проверка, без установки (даже если передан `--apply`). */
  check?: boolean;
  /** Канал проверки: `auto` (по версии) | `stable` | `beta`. */
  channel?: UpdateChannelChoice;
  /** Реестр, перебивающий реестр канала. */
  registry?: string;
  /** Предпросмотр: показать план, ничего не устанавливать. */
  dryRun?: boolean;
  /** Пропустить интерактивное подтверждение. */
  yes?: boolean;
  /** Вывод в JSON вместо человекочитаемого. */
  json?: boolean;
  /** ADR-092: аудит-журнал обслуживания (best-effort). */
  audit?: MaintenanceAuditRepository;
  /** Канал вывода (по умолчанию `console.log`). */
  log?: (msg: string) => void;
  /** Канал ошибок (по умолчанию `console.error`). */
  error?: (msg: string) => void;
  /** Для тестов: замена интерактивного подтверждения (по умолчанию — `readline`). */
  confirm?: (question: string) => Promise<boolean>;
  /** Для тестов: инъекция сети/установки/preflight (по умолчанию — реальные). */
  deps?: UpdateCommandDeps;
}

/**
 * Тип операции по сравнению версий (ADR-133): переход beta → stable — откат
 * (даже если семвер стабильной версии выше), stable → beta — обновление.
 * Каналы не переданы — по семвер-сравнению (совместимо с ADR-092).
 */
export function operationOf(
  current: string,
  target: string,
  channels?: { current?: UpdateChannel; target?: UpdateChannel },
): UpdateOperation {
  const cmp = compareVersions(target, current);
  if (cmp === 0) return 'none';
  if (channels?.current && channels.target) {
    if (channels.current === 'beta' && channels.target === 'stable') return 'rollback';
    if (channels.current === 'stable' && channels.target === 'beta') return 'update';
  }
  return cmp > 0 ? 'update' : 'rollback';
}

/** Нормализует `--to` (снимает префикс `v`) и проверяет semver; иначе `null`. */
function _normalizeTarget(raw: string): string | null {
  const value = raw.trim().replace(/^v/, '');
  return isSemver(value) ? value : null;
}

/**
 * Аргументы `npm install` (без shell): пакет, версия, опционально реестр.
 *
 * Реестр задаётся **scoped-ключом** `--@itphx:registry`, а не `--registry`:
 * иначе npm тянет из беты/зеркала и публичные зависимости (`hono`, `commander`…)
 * и падает с 404 — в реестре Gitea их нет.
 */
export function buildUpdateInstallArgs(
  version: string,
  registry: string,
  includeRegistry: boolean,
): string[] {
  const args = ['install', '-g', `${PACKAGE_NAME}@${version}`];
  if (includeRegistry) args.push(`--@itphx:registry=${registry}`);
  return args;
}

/** Установка целевой версии через npm (`npm install -g … [--registry …]`). */
function _defaultInstall(version: string, registry: string): Promise<number> {
  const includeRegistry = registry !== DEFAULT_STABLE_REGISTRY;
  return new Promise<number>((resolveCode, reject) => {
    const child = spawn('npm', buildUpdateInstallArgs(version, registry, includeRegistry), {
      stdio: 'inherit',
      env: { ...process.env },
    });
    child.on('error', reject);
    child.on('close', (code) => resolveCode(code ?? 1));
  });
}

/** Интерактивное подтверждение `[y/N]` (да — `y`/`yes`/`д`/`да`). */
async function _defaultConfirm(question: string): Promise<boolean> {
  const readline = await import('node:readline');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await new Promise<string>((resolve) => rl.question(question, resolve));
    return ['y', 'yes', 'д', 'да'].includes(answer.trim().toLowerCase());
  } finally {
    rl.close();
  }
}

/** Разбор `--registry`: нормализация без хвостового `/`. */
function _normalizeRegistryFlag(raw: string): string {
  return raw.trim().replace(/\/+$/, '');
}

/**
 * Выполняет `synth update` (ADR-092/ADR-133): проверка, предпросмотр
 * (`--dry-run`) или установка/откат (`--apply [--to <version>]`).
 *
 * @returns код выхода процесса (0 — успех/предпросмотр/отмена, 1 — ошибка).
 */
export async function runUpdateCommand(opts: UpdateCommandOptions): Promise<number> {
  const log = opts.log ?? ((msg: string) => console.log(msg));
  const error = opts.error ?? ((msg: string) => console.error(msg));
  const deps = opts.deps ?? {};
  const current = deps.currentVersion ?? SYNTH_VERSION;
  const apply = !!opts.apply && !opts.check;
  const dryRun = !!opts.dryRun;

  // 1. Канал и реестр: флаг > конфиг > установленная версия; `--registry`
  //    перебивает реестр канала.
  const channelChoice = opts.channel ?? deps.configChannel ?? 'auto';
  const channel = resolveUpdateChannel(current, channelChoice);
  const registry = opts.registry !== undefined
    ? _normalizeRegistryFlag(opts.registry)
    : resolveUpdatesRegistry(channel, deps.updates);
  const includeRegistry = opts.registry !== undefined
    || channel === 'beta'
    || registry !== DEFAULT_STABLE_REGISTRY;

  // 2. Целевая версия: `--to` (валидация формата) либо последняя версия канала.
  let target = '';
  if (opts.to !== undefined) {
    const normalized = _normalizeTarget(opts.to);
    if (!normalized) {
      error(
        `Ошибка: --to «${opts.to}» — не semver (ожидается X.Y.Z; префикс v допустим). ` +
        'dist-tag и имена каналов (например beta) не принимаются: устанавливается только точная версия.',
      );
      return 1;
    }
    target = normalized;
  }

  // 3. Сеть: список версий канала (для `--to`) либо последняя версия. Ошибка сети — без аудита.
  try {
    if (target) {
      const versions = await (deps.fetchVersions ?? ((o) => fetchAvailableVersions(o.registry)))({
        channel,
        registry,
      });
      if (!versions.includes(target)) {
        const message = `версия ${target} не найдена в реестре канала ${channel} (${registry})`;
        await recordMaintenanceAudit(opts.audit, {
          op: 'update.failed',
          status: 'failed',
          actor: 'cli',
          details: { from: current, to: target, channel, registry, version: target },
          error: message,
        });
        const newest = versions.length > 0 ? versions[versions.length - 1] : '—';
        error(`Ошибка: ${message} (последняя известная — ${newest}).`);
        return 1;
      }
    } else {
      target = await (deps.fetchLatest ?? ((o) => fetchLatestVersion(o.channel, o.registry)))({
        channel,
        registry,
      });
    }
  } catch (err) {
    error(`Ошибка проверки версий: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }

  const operation = operationOf(current, target, {
    current: resolveUpdateChannel(current),
    target: resolveUpdateChannel(target),
  });
  const installCommand = `npm ${buildUpdateInstallArgs(target, registry, includeRegistry).join(' ')}`;

  // 4. `--dry-run` — печать плана, установка не запускается, аудита нет.
  if (dryRun) {
    if (opts.json) {
      log(
        JSON.stringify(
          {
            currentVersion: current,
            targetVersion: target,
            operation,
            channel,
            registry,
            apply,
            dryRun: true,
            installCommand,
          },
          null,
          2,
        ),
      );
    } else {
      log(`[dry-run] План обновления пакета ${PACKAGE_NAME}`);
      log(`  сейчас: ${current}`);
      log(`  станет: ${target}`);
      log(`  канал: ${channel} (${registry})`);
      log(`  тип операции: ${OPERATION_LABELS[operation]}`);
      log(`  команда: ${installCommand}`);
      log('(dry-run: установка не выполнялась)');
    }
    return 0;
  }

  // 5. Без `--apply`/с `--check` — только проверка: что установлено, что доступно и что делать.
  if (!apply) {
    await recordMaintenanceAudit(opts.audit, {
      op: 'update.checked',
      status: 'ok',
      actor: 'cli',
      details: { from: current, to: target, channel, registry, version: target },
    });

    if (opts.json) {
      log(
        JSON.stringify(
          {
            currentVersion: current,
            targetVersion: target,
            operation,
            channel,
            registry,
            apply: false,
            installCommand,
          },
          null,
          2,
        ),
      );
      return 0;
    }
    log(`Текущая версия: ${current}`);
    log(`Канал: ${channel} (${registry})`);
    log(`Целевая версия: ${target}`);
    log(`Тип операции: ${OPERATION_LABELS[operation]}`);
    if (operation === 'none') {
      log('Обновление не требуется.');
    } else {
      log(`Для установки выполните: synth update --apply --to ${target} --channel ${channel}`);
    }
    return 0;
  }

  // 6. Целевая версия совпадает с текущей — устанавливать нечего.
  if (operation === 'none') {
    log(`Версия ${target} уже установлена — установка не требуется.`);
    return 0;
  }

  // 7. Preflight user-level prefix (только реальная установка; при инъекции
  //    `install` в тестах проверка не выполняется, если не задана явно).
  const preflight = deps.preflight ?? (deps.install ? undefined : () => checkUserLevelPrefix({ home: deps.home }));
  if (preflight) {
    const refusal = await preflight();
    if (refusal) {
      error(`Ошибка: ${refusal}`);
      return 1;
    }
  }

  // 8. Подтверждение (при откате — явное «ОТКАТ»).
  if (!opts.yes) {
    const confirm = opts.confirm ?? _defaultConfirm;
    const action =
      operation === 'rollback'
        ? `ОТКАТ на версию ${target}${resolveUpdateChannel(target) === 'stable' && resolveUpdateChannel(current) === 'beta' ? ' (релиз)' : ' (более старую)'}`
        : `установка ${target}`;
    const ok = await confirm(`Выполнить ${action} (сейчас ${current})? [y/N] `);
    if (!ok) {
      log('Отменено.');
      return 0;
    }
  }

  // 9. Установка (по умолчанию — `npm install -g … --registry …`).
  log(`Установка ${PACKAGE_NAME}@${target} (канал ${channel}, реестр ${registry})...`);
  let code: number;
  try {
    code = await (deps.install ?? _defaultInstall)(target, registry);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await recordMaintenanceAudit(opts.audit, {
      op: 'update.failed',
      status: 'failed',
      actor: 'cli',
      details: { from: current, to: target, channel, registry, version: target },
      error: message,
    });
    error(`Ошибка установки ${PACKAGE_NAME}@${target}: ${message}`);
    return 1;
  }

  if (code !== 0) {
    const message = `npm install завершился с кодом ${code}`;
    await recordMaintenanceAudit(opts.audit, {
      op: 'update.failed',
      status: 'failed',
      actor: 'cli',
      details: { from: current, to: target, channel, registry, version: target },
      error: message,
    });
    error(`Ошибка установки ${PACKAGE_NAME}@${target}: ${message}`);
    return 1;
  }

  // 10. Аудит успеха: обновление или откат.
  await recordMaintenanceAudit(opts.audit, {
    op: operation === 'rollback' ? 'rollback.applied' : 'update.applied',
    status: 'ok',
    actor: 'cli',
    details: { from: current, to: target, channel, registry, version: target },
  });

  if (opts.json) {
    log(
      JSON.stringify(
        {
          currentVersion: current,
          targetVersion: target,
          operation,
          channel,
          registry,
          applied: true,
        },
        null,
        2,
      ),
    );
  }
  log('');
  log(`${operation === 'rollback' ? 'Откат выполнен' : 'Обновление установлено'}: ${PACKAGE_NAME}@${target}.`);
  log(`Канал: ${channel} (реестр ${registry}).`);
  log('Перезапустите инстанс: synth service restart (или «Перезапустите инстанс» в UI).');
  log('Миграции схемы данных применятся при старте автоматически.');
  log('После запуска проверьте состояние инстанса: synth doctor');
  return 0;
}
