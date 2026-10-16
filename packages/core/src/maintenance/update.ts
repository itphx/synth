// ADR-092: тело CLI-команды `synth update` — обновление и **откат** пакета
// (`--to <version>`). Переиспользуется dev-CLI (`packages/core/src/main.ts`) и
// публичным `synth` (`packages/synth/src/cli.ts`, паритет PROP-053); логики в CLI нет.
//
// Без `--apply` команда только проверяет (текущая/целевая версия, что делать),
// `--dry-run` печатает план и **ничего не запускает**, `--apply` ставит
// `@itphx/synth@<version>` через `npm install -g`. Целевая версия из `--to`
// валидируется (semver) и проверяется по списку реестра; версия ниже текущей —
// откат (в приглашении явное «ОТКАТ»). Сеть/установка инжектируются через
// `deps` — тесты не делают реальных запросов.
//
// Аудит (best-effort, ADR-092): успех — `update.applied`/`rollback.applied`
// (`details: {from, to}`), несуществующая версия и провал/ошибка установки —
// `update.failed` с `error`. Ошибка проверки версий (сеть) записи не оставляет —
// операция не начиналась.
import { spawn } from 'node:child_process';
import { SYNTH_VERSION } from '@itphx/synth-shared';
import type { MaintenanceAuditRepository } from '../storage/ports/maintenance-audit-repository.js';
import { compareVersions, fetchAvailableVersions, fetchLatestVersion, isSemver } from '../update-checker.js';
import { recordMaintenanceAudit } from './audit.js';

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

/** Инъекция сети/установки (ADR-092) — тесты подменяют и не ходят в реестр. */
export interface UpdateCommandDeps {
  /** Список версий из реестра (по умолчанию — npm). */
  fetchVersions?: () => Promise<string[]>;
  /** Последняя версия (по умолчанию — `latest`-тег npm, совместимо с update-checker). */
  fetchLatest?: () => Promise<string>;
  /** Установка версии: код возврата (по умолчанию — `npm install -g`). */
  install?: (version: string) => Promise<number>;
  /** Текущая версия (по умолчанию — `SYNTH_VERSION`). */
  currentVersion?: string;
}

/** Опции CLI-команды `synth update` (ADR-092). */
export interface UpdateCommandOptions {
  /** Каталог данных инстанса (резолвится CLI: `--data-dir`/`--home`/config). */
  dataDir: string;
  /** Целевая версия (`--to`), без «v». `undefined` → последняя известная. */
  to?: string;
  /** Установить целевую версию (без него — только проверка). */
  apply?: boolean;
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
  /** Для тестов: инъекция сети/установки (по умолчанию — реальные). */
  deps?: UpdateCommandDeps;
}

/** Тип операции по сравнению целевой версии с текущей (ADR-092). */
export function operationOf(current: string, target: string): UpdateOperation {
  const cmp = compareVersions(target, current);
  if (cmp === 0) return 'none';
  return cmp > 0 ? 'update' : 'rollback';
}

/** Нормализует `--to` (снимает префикс `v`) и проверяет semver; иначе `null`. */
function _normalizeTarget(raw: string): string | null {
  const value = raw.trim().replace(/^v/, '');
  return isSemver(value) ? value : null;
}

/** Установка целевой версии через npm (`npm install -g @itphx/synth@<version>`). */
function _defaultInstall(version: string): Promise<number> {
  return new Promise<number>((resolveCode, reject) => {
    const child = spawn('npm', ['install', '-g', `${PACKAGE_NAME}@${version}`], {
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

/**
 * Выполняет `synth update` (ADR-092): проверка, предпросмотр (`--dry-run`) или
 * установка/откат (`--apply [--to <version>]`).
 *
 * @returns код выхода процесса (0 — успех/предпросмотр/отмена, 1 — ошибка).
 */
export async function runUpdateCommand(opts: UpdateCommandOptions): Promise<number> {
  const log = opts.log ?? ((msg: string) => console.log(msg));
  const error = opts.error ?? ((msg: string) => console.error(msg));
  const deps = opts.deps ?? {};
  const current = deps.currentVersion ?? SYNTH_VERSION;
  const apply = !!opts.apply;
  const dryRun = !!opts.dryRun;

  // 1. Целевая версия: `--to` (валидация формата) либо последняя известная (сеть ниже).
  let target = '';
  if (opts.to !== undefined) {
    const normalized = _normalizeTarget(opts.to);
    if (!normalized) {
      error(`Ошибка: --to «${opts.to}» — не semver (ожидается X.Y.Z; префикс v допустим).`);
      return 1;
    }
    target = normalized;
  }

  // 2. Сеть: список версий (для `--to`) либо последняя версия. Ошибка сети — без аудита.
  try {
    if (target) {
      const versions = await (deps.fetchVersions ?? fetchAvailableVersions)();
      if (!versions.includes(target)) {
        const message = `версия ${target} не найдена в реестре npm`;
        await recordMaintenanceAudit(opts.audit, {
          op: 'update.failed',
          status: 'failed',
          actor: 'cli',
          details: { from: current, to: target },
          error: message,
        });
        const newest = versions.length > 0 ? versions[versions.length - 1] : '—';
        error(`Ошибка: ${message} (последняя известная — ${newest}).`);
        return 1;
      }
    } else {
      target = await (deps.fetchLatest ?? fetchLatestVersion)();
    }
  } catch (err) {
    error(`Ошибка проверки версий: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }

  const operation = operationOf(current, target);
  const installCommand = `npm install -g ${PACKAGE_NAME}@${target}`;

  // 3. `--dry-run` — печать плана, установка не запускается, аудита нет.
  if (dryRun) {
    if (opts.json) {
      log(
        JSON.stringify(
          { currentVersion: current, targetVersion: target, operation, apply, dryRun: true, installCommand },
          null,
          2,
        ),
      );
    } else {
      log(`[dry-run] План обновления пакета ${PACKAGE_NAME}`);
      log(`  сейчас: ${current}`);
      log(`  станет: ${target}`);
      log(`  тип операции: ${OPERATION_LABELS[operation]}`);
      log(`  команда: ${installCommand}`);
      log('(dry-run: установка не выполнялась)');
    }
    return 0;
  }

  // 4. Без `--apply` — только проверка: что установлено, что доступно и что делать.
  if (!apply) {
    if (opts.json) {
      log(
        JSON.stringify(
          { currentVersion: current, targetVersion: target, operation, apply: false, installCommand },
          null,
          2,
        ),
      );
      return 0;
    }
    log(`Текущая версия: ${current}`);
    log(`Целевая версия: ${target}`);
    log(`Тип операции: ${OPERATION_LABELS[operation]}`);
    if (operation === 'none') {
      log('Обновление не требуется.');
    } else {
      log(`Для установки выполните: synth update --apply --to ${target}`);
    }
    return 0;
  }

  // 5. Целевая версия совпадает с текущей — устанавливать нечего.
  if (operation === 'none') {
    log(`Версия ${target} уже установлена — установка не требуется.`);
    return 0;
  }

  // 6. Подтверждение (при откате — явное «ОТКАТ на более старую версию»).
  if (!opts.yes) {
    const confirm = opts.confirm ?? _defaultConfirm;
    const action =
      operation === 'rollback'
        ? `ОТКАТ на более старую версию ${target}`
        : `установка ${target}`;
    const ok = await confirm(`Выполнить ${action} (сейчас ${current})? [y/N] `);
    if (!ok) {
      log('Отменено.');
      return 0;
    }
  }

  // 7. Установка (по умолчанию — `npm install -g`).
  log(`Установка ${PACKAGE_NAME}@${target}...`);
  let code: number;
  try {
    code = await (deps.install ?? _defaultInstall)(target);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await recordMaintenanceAudit(opts.audit, {
      op: 'update.failed',
      status: 'failed',
      actor: 'cli',
      details: { from: current, to: target },
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
      details: { from: current, to: target },
      error: message,
    });
    error(`Ошибка установки ${PACKAGE_NAME}@${target}: ${message}`);
    return 1;
  }

  // 8. Аудит успеха: обновление или откат.
  await recordMaintenanceAudit(opts.audit, {
    op: operation === 'rollback' ? 'rollback.applied' : 'update.applied',
    status: 'ok',
    actor: 'cli',
    details: { from: current, to: target },
  });

  if (opts.json) {
    log(JSON.stringify({ currentVersion: current, targetVersion: target, operation, applied: true }, null, 2));
  }
  log('');
  log(`${operation === 'rollback' ? 'Откат выполнен' : 'Обновление установлено'}: ${PACKAGE_NAME}@${target}.`);
  log('Перезапустите инстанс — миграции схемы данных применятся при старте автоматически.');
  log('После запуска проверьте состояние инстанса: synth doctor');
  return 0;
}
