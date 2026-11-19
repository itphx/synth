/**
 * Обслуживание инстанса из чата: `synth_maintenance_*`, `synth_backup_*`,
 * `synth_restore_*`, `synth_restart_request`.
 *
 * Покрытие — паритет с HTTP-фабрикой `createMaintenanceRoutes`:
 * - чтения (статус/doctor/список архивов/журнал) на реальном временном каталоге
 *   данных + фейковом порту аудита;
 * - ADMIN-гейт write-тулов: роль `ADMIN`, локальный владелец standalone,
 *   отказы LEAD/USER и отсутствие принципала (fail-closed);
 * - `restore_request` без `confirm` → `maintenance.confirm_required`,
 *   `restart_request` без `confirm` → отказ;
 * - plan-режим: write-имена в `INSTANCE_WRITE_TOOLS` → `isPlanBlockedTool`,
 *   чтения разрешены (ADR-025/ADR-029);
 * - `backup_create` по умолчанию **не** включает секреты (флаг в манифесте);
 * - восстановление — планирование (запрос пишется файлом, данные не трогаются),
 *   отмена запроса; архив ищется только в `{dataDir}/backups`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ToolCapability, type ToolContext } from '@itphx/synth-shared';
import type { MaintenanceAuditEntry } from '@itphx/synth-shared';
import {
  synthMaintenanceStatusTool,
  synthMaintenanceDoctorTool,
  synthBackupListTool,
  synthBackupCreateTool,
  synthRestoreRequestTool,
  synthRestoreCancelTool,
  synthRestartRequestTool,
  synthMaintenanceAuditTool,
  type MaintenanceToolsDeps,
} from './instance-maintenance.js';
import { ALL_BUILTIN_TOOLS } from './index.js';
import { INSTANCE_READ_TOOLS, INSTANCE_WRITE_TOOLS } from '../permission/groups.js';
import { PermissionEvaluator, isPlanBlockedTool } from '../permission/evaluator.js';
import { configureRestart, resetRestartForTests } from '../../server/restart.js';
import type { InstanceRuntimeMeta } from '../instance/meta.js';
import type { ToolPrincipal } from './project-resolve.js';
import { LOCAL_USER_ID } from '../../server/local-owner.js';

interface FakeAudit {
  entries: MaintenanceAuditEntry[];
  append: ReturnType<typeof vi.fn>;
  list: ReturnType<typeof vi.fn>;
  clear: ReturnType<typeof vi.fn>;
}

function makeAudit(initial: MaintenanceAuditEntry[] = []): FakeAudit {
  const audit: FakeAudit = {
    entries: [...initial],
    append: vi.fn(async (entry: MaintenanceAuditEntry) => {
      audit.entries.push(entry);
    }),
    list: vi.fn(async (opts?: { limit?: number; op?: string }) => {
      const filtered = opts?.op ? audit.entries.filter((entry) => entry.op === opts.op) : audit.entries;
      return filtered.slice(0, opts?.limit ?? filtered.length);
    }),
    clear: vi.fn(async () => {
      const cleared = audit.entries.length;
      audit.entries = [];
      return cleared;
    }),
  };
  return audit;
}

const STANDALONE_META = { mode: 'standalone' } as unknown as InstanceRuntimeMeta;
const ADMIN_PRINCIPAL: ToolPrincipal = { userId: 'u1', roles: ['ADMIN'] };

interface CtxOptions {
  dataDir?: string;
  audit?: FakeAudit;
  /** `null` — принципала нет вовсе (fail-closed). */
  principal?: ToolPrincipal | null;
  instanceMeta?: InstanceRuntimeMeta;
  /** `false` — прокладки `extra.maintenance` нет (тул обязан отдать ошибку). */
  withDeps?: boolean;
}

function makeCtx(opts: CtxOptions = {}): ToolContext {
  const principal = opts.principal === undefined ? ADMIN_PRINCIPAL : opts.principal;
  const maintenance: MaintenanceToolsDeps | undefined = opts.withDeps === false
    ? undefined
    : {
      dataDir: opts.dataDir ?? '/data',
      env: {},
      storageBackend: 'file',
      ...(opts.audit ? { audit: opts.audit as unknown as MaintenanceToolsDeps['audit'] } : {}),
    };
  return {
    sessionId: 's1',
    messageId: 'm1',
    abortSignal: new AbortController().signal,
    workingDir: '/work',
    dataDir: opts.dataDir ?? '/data',
    extra: {
      instanceMeta: opts.instanceMeta,
      ...(principal ? { principal } : {}),
      ...(maintenance ? { maintenance } : {}),
    },
  } as unknown as ToolContext;
}

/** Ключ i18n из результата тула (все сообщения — через `system-messages`). */
function i18nKey(result: { metadata?: Record<string, unknown> }): string | undefined {
  return (result.metadata?.i18n as { key?: string } | undefined)?.key;
}

let dataDir: string;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'synth-maint-'));
});

afterEach(async () => {
  resetRestartForTests();
  await rm(dataDir, { recursive: true, force: true });
});

describe('регистрация и группы', () => {
  const TOOLS = [
    synthMaintenanceStatusTool,
    synthMaintenanceDoctorTool,
    synthBackupListTool,
    synthBackupCreateTool,
    synthRestoreRequestTool,
    synthRestoreCancelTool,
    synthRestartRequestTool,
    synthMaintenanceAuditTool,
  ];

  it('все тулы зарегистрированы в ALL_BUILTIN_TOOLS с capability instance', () => {
    for (const tool of TOOLS) {
      const registered = ALL_BUILTIN_TOOLS.find((candidate) => candidate.name === tool.name);
      expect(registered, `${tool.name} не зарегистрирован`).toBeDefined();
      expect(registered?.capabilities).toEqual([ToolCapability.INSTANCE]);
    }
  });

  it('имена входят в группы instance (read/write) — правило permission.rules.instance', () => {
    for (const name of ['synth_maintenance_status', 'synth_maintenance_doctor', 'synth_backup_list', 'synth_maintenance_audit']) {
      expect(INSTANCE_READ_TOOLS, name).toContain(name);
      expect(INSTANCE_WRITE_TOOLS, name).not.toContain(name);
    }
    for (const name of ['synth_backup_create', 'synth_restore_request', 'synth_restore_cancel', 'synth_restart_request']) {
      expect(INSTANCE_WRITE_TOOLS, name).toContain(name);
    }
  });
});

describe('чтения: статус / doctor / архивы / журнал', () => {
  it('статус: версия, dataDir, схема, число архивов, pendingRestore, сводка doctor', async () => {
    const result = await synthMaintenanceStatusTool.execute({}, makeCtx({ dataDir }));

    expect(result.isError).toBeUndefined();
    expect(i18nKey(result)).toBe('maintenance.status');
    expect(result.metadata).toMatchObject({
      dataDir,
      backups: 0,
      pendingRestore: null,
    });
    const schema = result.metadata?.schema as Record<string, unknown>;
    expect(schema.backend).toBe('file');
    expect(typeof schema.current).toBe('number');
    expect(typeof schema.expected).toBe('number');
    expect(Array.isArray(schema.pending)).toBe(true);
    const doctor = result.metadata?.doctor as Record<string, unknown>;
    expect(doctor).toMatchObject({ ok: expect.any(Boolean), fail: expect.any(Number), warn: expect.any(Number) });
  });

  it('doctor: полный список проверок с ok/checks[]', async () => {
    const result = await synthMaintenanceDoctorTool.execute({}, makeCtx({ dataDir }));

    expect(result.isError).toBeUndefined();
    expect(i18nKey(result)).toBe('maintenance.doctor');
    expect(result.metadata?.ok).toBeTypeOf('boolean');
    const checks = result.metadata?.checks as Array<Record<string, unknown>>;
    expect(checks.length).toBeGreaterThan(0);
    expect(checks.map((check) => check.id)).toContain('data-dir');
    for (const check of checks) {
      expect(['ok', 'warn', 'fail', 'skipped']).toContain(check.status);
    }
  });

  it('список архивов пуст на пустом каталоге', async () => {
    const result = await synthBackupListTool.execute({}, makeCtx({ dataDir }));

    expect(result.isError).toBeUndefined();
    expect(i18nKey(result)).toBe('maintenance.backup.list');
    expect(result.metadata).toMatchObject({ count: 0, total: 0, backups: [] });
  });

  it('журнал: записи фейкового порта и фильтр по op', async () => {
    const audit = makeAudit([
      { id: 'ma_1', ts: '2026-01-01T00:00:00.000Z', op: 'backup.created', status: 'ok' },
      { id: 'ma_2', ts: '2026-01-02T00:00:00.000Z', op: 'restore.scheduled', status: 'scheduled' },
    ]);
    const ctx = makeCtx({ dataDir, audit });

    const all = await synthMaintenanceAuditTool.execute({}, ctx);
    expect(all.isError).toBeUndefined();
    expect(all.metadata).toMatchObject({ count: 2, available: true });

    const filtered = await synthMaintenanceAuditTool.execute({ op: 'restore.scheduled' }, ctx);
    expect((filtered.metadata?.entries as Array<Record<string, unknown>>).map((entry) => entry.id)).toEqual(['ma_2']);

    const limited = await synthMaintenanceAuditTool.execute({ limit: 1 }, ctx);
    expect(limited.metadata?.count).toBe(1);
  });

  it('журнал без порта аудита — пустой список, не ошибка', async () => {
    const result = await synthMaintenanceAuditTool.execute({}, makeCtx({ dataDir }));
    expect(result.isError).toBeUndefined();
    expect(result.metadata).toMatchObject({ count: 0, available: false });
  });

  it('чтения не требуют ADMIN (USER проходит)', async () => {
    const ctx = makeCtx({ dataDir, principal: { userId: 'u2', roles: ['USER'] } });
    for (const tool of [synthMaintenanceStatusTool, synthMaintenanceDoctorTool, synthBackupListTool]) {
      const result = await tool.execute({}, ctx);
      expect(result.isError, tool.name).toBeUndefined();
    }
  });

  it('без прокладки extra.maintenance — понятная ошибка зависимостей', async () => {
    for (const tool of [synthMaintenanceStatusTool, synthBackupListTool, synthMaintenanceAuditTool]) {
      const result = await tool.execute({}, makeCtx({ withDeps: false }));
      expect(result.isError, tool.name).toBe(true);
      expect(i18nKey(result), tool.name).toBe('maintenance.deps_unavailable');
    }
  });
});

describe('бэкапы: создание и список', () => {
  it('backup_create по умолчанию НЕ включает секреты и пишет архив в {dataDir}/backups', async () => {
    await mkdir(join(dataDir, 'secrets'), { recursive: true });
    await writeFile(join(dataDir, 'secrets', 'master.key'), 'секрет', 'utf-8');

    const audit = makeAudit();
    const result = await synthBackupCreateTool.execute({}, makeCtx({ dataDir, audit }));

    expect(result.isError).toBeUndefined();
    expect(i18nKey(result)).toBe('maintenance.backup.created');
    expect(result.metadata).toMatchObject({ withSecrets: false, withWorkspace: false, encrypted: false });
    const name = result.metadata?.name as string;
    expect(name).toMatch(/\.tar\.gz$/);
    // Архив лежит в каталоге бэкапов инстанса, а не в рабочем каталоге.
    await expect(stat(join(dataDir, 'backups', name))).resolves.toBeTruthy();
    // Секреты не печатаются: в метаданных только флаг.
    expect(JSON.stringify(result.metadata)).not.toContain('мастер');
    // Аудит операции — через порт (ADR-092).
    expect(audit.append).toHaveBeenCalledTimes(1);
    expect(audit.entries[0]?.op).toBe('backup.created');
  });

  it('with_secrets: true фиксируется флагом в манифесте (содержимое архива не читается)', async () => {
    const result = await synthBackupCreateTool.execute(
      { with_secrets: true },
      makeCtx({ dataDir }),
    );
    expect(result.isError).toBeUndefined();
    expect(result.metadata?.withSecrets).toBe(true);
  });

  it('имя санитизируется и не перезаписывает существующий архив', async () => {
    const ctx = makeCtx({ dataDir });
    const first = await synthBackupCreateTool.execute({ name: '../my backup' }, ctx);
    expect(first.isError).toBeUndefined();
    expect(first.metadata?.name).toBe('my_backup.tar.gz');

    const second = await synthBackupCreateTool.execute({ name: 'my backup' }, ctx);
    expect(second.isError).toBeUndefined();
    expect(second.metadata?.name).toBe('my_backup-1.tar.gz');
  });

  it('список показывает созданный архив с размером и флагом шифрования', async () => {
    const created = await synthBackupCreateTool.execute({ name: 'listed' }, makeCtx({ dataDir }));
    const result = await synthBackupListTool.execute({}, makeCtx({ dataDir }));

    expect(result.metadata?.count).toBe(1);
    const backups = result.metadata?.backups as Array<Record<string, unknown>>;
    expect(backups[0]).toMatchObject({
      name: created.metadata?.name,
      bytes: created.metadata?.bytes,
      createdAt: created.metadata?.createdAt,
      encrypted: false,
    });
    expect(result.metadata?.total).toBe(1);
  });
});

describe('восстановление: планирование и отмена', () => {
  async function withArchive(): Promise<{ name: string; ctx: ToolContext }> {
    const created = await synthBackupCreateTool.execute({ name: 'restore-src' }, makeCtx({ dataDir }));
    return { name: created.metadata?.name as string, ctx: makeCtx({ dataDir, audit: makeAudit() }) };
  }

  it('restore_request без confirm → maintenance.confirm_required', async () => {
    const { name, ctx } = await withArchive();
    const result = await synthRestoreRequestTool.execute({ archive: name }, ctx);

    expect(result.isError).toBe(true);
    expect(i18nKey(result)).toBe('maintenance.confirm_required');
  });

  it('restore_request с confirm планирует восстановление (данные не трогаются)', async () => {
    const { name, ctx } = await withArchive();
    const result = await synthRestoreRequestTool.execute({ archive: name, confirm: true }, ctx);

    expect(result.isError).toBeUndefined();
    expect(i18nKey(result)).toBe('maintenance.restore.scheduled');
    expect(result.metadata).toMatchObject({ appliesOnNextStart: true, warnings: [] });
    const pending = result.metadata?.pending as Record<string, unknown>;
    expect(pending.archive).toBe(join(dataDir, 'backups', name));
    expect(pending.requestedBy).toBe('u1');
    // Запрос — файл обслуживания; каталог данных живого процесса не чистится.
    const written = JSON.parse(
      await readFile(join(dataDir, 'maintenance', 'restore-request.json'), 'utf-8'),
    ) as Record<string, unknown>;
    expect(written.archive).toBe(join(dataDir, 'backups', name));
  });

  it('небезопасное имя архива → maintenance.invalid_archive, неизвестный архив → maintenance.not_found', async () => {
    const ctx = makeCtx({ dataDir });

    const unsafe = await synthRestoreRequestTool.execute(
      { archive: '../../etc/passwd', confirm: true },
      ctx,
    );
    expect(unsafe.isError).toBe(true);
    expect(i18nKey(unsafe)).toBe('maintenance.invalid_archive');

    const missing = await synthRestoreRequestTool.execute({ archive: 'nope.tar.gz', confirm: true }, ctx);
    expect(missing.isError).toBe(true);
    expect(i18nKey(missing)).toBe('maintenance.not_found');
  });

  it('restore_cancel отменяет запрос; повторная отмена — не ошибка', async () => {
    const { name, ctx } = await withArchive();
    await synthRestoreRequestTool.execute({ archive: name, confirm: true }, ctx);

    const cancelled = await synthRestoreCancelTool.execute({}, ctx);
    expect(cancelled.isError).toBeUndefined();
    expect(cancelled.metadata?.cancelled).toBe(true);

    const again = await synthRestoreCancelTool.execute({}, ctx);
    expect(again.isError).toBeUndefined();
    expect(again.metadata?.cancelled).toBe(false);
  });
});

describe('рестарт инстанса', () => {
  it('restart_request без confirm → maintenance.confirm_required', async () => {
    configureRestart({ mode: 'process', request: () => {} });
    const result = await synthRestartRequestTool.execute({}, makeCtx({ dataDir }));

    expect(result.isError).toBe(true);
    expect(i18nKey(result)).toBe('maintenance.confirm_required');
  });

  it('режим disabled → maintenance.restart_unsupported с причиной', async () => {
    resetRestartForTests();
    const result = await synthRestartRequestTool.execute({ confirm: true }, makeCtx({ dataDir }));

    expect(result.isError).toBe(true);
    expect(i18nKey(result)).toBe('maintenance.restart_unsupported');
    expect(result.metadata?.i18n).toMatchObject({ params: { mode: 'disabled' } });
  });

  it('в режиме process запрос принимается: режим и предупреждение о прерывании хода', async () => {
    const request = vi.fn();
    configureRestart({ mode: 'process', request, delayMs: 0 });
    const audit = makeAudit();

    const result = await synthRestartRequestTool.execute(
      { confirm: true, reason: 'после смены TLS' },
      makeCtx({ dataDir, audit }),
    );

    expect(result.isError).toBeUndefined();
    expect(i18nKey(result)).toBe('maintenance.restart.requested');
    expect(result.metadata).toMatchObject({
      status: 'restarting',
      mode: 'process',
      turnInterrupted: true,
      alreadyRequested: false,
    });
    expect(result.metadata?.restartId).toMatch(/^rst_/);
    // Аудит `restart.requested` с причиной — до инициации shutdown.
    expect(audit.entries[0]).toMatchObject({
      op: 'restart.requested',
      status: 'scheduled',
      actor: 'u1',
      details: { mode: 'process', source: 'agent', reason: 'после смены TLS' },
    });
  });
});

describe('ADMIN-гейт write-тулов (isInstanceAdmin)', () => {
  const CASES: Array<{ tool: (typeof synthBackupCreateTool); args: Record<string, unknown> }> = [
    { tool: synthBackupCreateTool, args: {} },
    { tool: synthRestoreRequestTool, args: { archive: 'x.tar.gz', confirm: true } },
    { tool: synthRestoreCancelTool, args: {} },
    { tool: synthRestartRequestTool, args: { confirm: true } },
  ];

  const run = (
    tool: (typeof synthBackupCreateTool),
    args: Record<string, unknown>,
    principal: ToolPrincipal | null,
    instanceMeta?: InstanceRuntimeMeta,
  ) => tool.execute(args, makeCtx({ dataDir, principal, instanceMeta }));

  it('роль ADMIN → операция разрешена (не forbidden) и каждый ран завершается без исключения', async () => {
    configureRestart({ mode: 'process', request: () => {} });
    for (const { tool, args } of CASES) {
      const result = await run(tool, args, ADMIN_PRINCIPAL);
      expect(i18nKey(result), tool.name).not.toBe('maintenance.forbidden');
    }
  });

  it('локальный владелец standalone → разрешено', async () => {
    configureRestart({ mode: 'process', request: () => {} });
    for (const { tool, args } of CASES) {
      const result = await run(tool, args, { userId: LOCAL_USER_ID, roles: [] }, STANDALONE_META);
      expect(i18nKey(result), tool.name).not.toBe('maintenance.forbidden');
    }
  });

  it('локальный литерал вне standalone → отказ (роли приходят с сервера)', async () => {
    for (const { tool, args } of CASES) {
      const result = await run(
        tool,
        args,
        { userId: LOCAL_USER_ID, roles: [] },
        { mode: 'managed' } as unknown as InstanceRuntimeMeta,
      );
      expect(result.isError, tool.name).toBe(true);
      expect(i18nKey(result), tool.name).toBe('maintenance.forbidden');
    }
  });

  it('LEAD и USER → отказ', async () => {
    for (const roles of [['LEAD'], ['USER']]) {
      for (const { tool, args } of CASES) {
        const result = await run(tool, args, { userId: 'u2', roles }, STANDALONE_META);
        expect(result.isError, `${roles.join()} → ${tool.name}`).toBe(true);
        expect(i18nKey(result), `${roles.join()} → ${tool.name}`).toBe('maintenance.forbidden');
      }
    }
  });

  it('нет принципала → отказ (fail-closed)', async () => {
    for (const { tool, args } of CASES) {
      const result = await run(tool, args, null, STANDALONE_META);
      expect(result.isError, tool.name).toBe(true);
      expect(i18nKey(result), tool.name).toBe('maintenance.forbidden');
    }
  });

  it('ADMIN без прокладки зависимостей → maintenance.deps_unavailable, а не падение', async () => {
    const result = await synthBackupCreateTool.execute({}, makeCtx({ withDeps: false }));
    expect(result.isError).toBe(true);
    expect(i18nKey(result)).toBe('maintenance.deps_unavailable');
  });
});

describe('plan-режим (ADR-025/ADR-029)', () => {
  it('write-имена блокируются, чтения — нет', () => {
    for (const name of ['synth_backup_create', 'synth_restore_request', 'synth_restore_cancel', 'synth_restart_request']) {
      expect(INSTANCE_WRITE_TOOLS, name).toContain(name);
      expect(isPlanBlockedTool(name), name).toBe(true);
    }
    for (const name of ['synth_maintenance_status', 'synth_maintenance_doctor', 'synth_backup_list', 'synth_maintenance_audit']) {
      expect(isPlanBlockedTool(name, [ToolCapability.INSTANCE]), name).toBe(false);
    }
  });

  it('PermissionEvaluator: plan → deny на мутацию, allow на чтение', () => {
    const evaluator = new PermissionEvaluator({ rules: {}, askTimeoutMs: 0 });

    const denied = evaluator.check({
      toolName: 'synth_backup_create',
      params: {},
      workingDir: '/work',
      capabilities: [ToolCapability.INSTANCE],
      sessionMode: 'plan',
    });
    expect(denied.action).toBe('deny');
    expect(denied.unavailable?.reason).toBe('mode');

    const allowed = evaluator.check({
      toolName: 'synth_backup_list',
      params: {},
      workingDir: '/work',
      capabilities: [ToolCapability.INSTANCE],
      sessionMode: 'plan',
    });
    expect(allowed.action).toBe('allow');
  });
});
