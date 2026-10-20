// PROP-032 (волна 5): тесты `synth storage migrate` — перенос данных между
// backend'ами через порты (`migrateStorageData`) и CLI-команда
// (`runStorageMigrateCommand`): идемпотентность, пропуски существующего,
// dry-run, `--yes`, аудит. Для логики достаточно file ↔ memory (без БД).
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { McpServerConfig, SkillBundle, SynthConfig } from '@itphx/synth-shared';
import { defaultConfig } from '@itphx/synth-shared';
import {
  createMemoryStorage,
  createStorageContextAsync,
  type StorageContext,
} from '../storage/storage-context.js';
import { MemoryMaintenanceAuditRepository } from '../storage/memory/index.js';
import { makeMessage, makeProfile, makeProject, makeSession } from '../storage/contract/helpers.js';
import {
  migrateStorageData,
  runStorageMigrateCommand,
  STORAGE_MIGRATION_ENTITIES,
  type StorageMigrationReport,
} from './storage-migrate.js';

/**
 * PROP-032: драйвер прогревается один раз на модуль — до первого теста.
 *
 * Тест «недоступный целевой backend» строит цель через `buildStorageContext`
 * → `createStorageContextAsync('postgres', …)`, а тот грузит модуль-драйвер
 * динамическим `import()` **в теле теста**: под параллельной нагрузкой
 * полного прогона загрузка занимает 10–70 с и съедает весь бюджет
 * `testTimeout` — тест падает по таймауту, хотя проверяемая логика
 * (деградация цели не маскируется под успех) отрабатывает за ~200 мс.
 * Top-level await не подчиняется `testTimeout`/`hookTimeout` — в этом и смысл
 * прогрева: после него `import()` в коде под тестом разрешается из кеша
 * модулей за миллисекунды.
 *
 * `.catch()` обязателен: драйвера может не быть (пакет опционален) — тогда
 * импорт не должен ронять файл, а код под тестом обязан классифицировать
 * неудачную загрузку как ошибку зависимости (fail-closed, см. ADR-098).
 */
const POSTGRES_DRIVER_PACKAGE: string = '@itphx/synth-storage-postgres';
await import(POSTGRES_DRIVER_PACKAGE).catch(() => undefined);

const ISO = '2026-01-02T03:04:05.000Z';

/** Минимальный конфиг инстанса (file-backend по умолчанию). */
function makeConfig(): SynthConfig {
  return { ...defaultConfig };
}

/** Наполняет контекст по одной записи каждого переносимого вида. */
async function seed(ctx: StorageContext): Promise<void> {
  const message = { ...makeMessage('привет мир'), seq: 1 };
  await ctx.sessions.save(
    makeSession({
      id: 'sess-1',
      title: 'первая сессия',
      projectId: 'project-1',
      updatedAt: ISO,
      messages: [message],
      references: [
        {
          type: 'session_reference',
          sessionId: 'sess-2',
          label: 'ref',
          messageRange: [1, 2],
          createdAt: ISO,
        },
      ],
      checkpoints: [{ id: 'cp-1', sessionId: 'sess-1', messages: [message], createdAt: ISO }],
      stickyNotes: [{ id: 'sn-1', content: 'заметка', createdAt: ISO, updatedAt: ISO, disabled: false }],
    }),
  );
  await ctx.projects.save(
    makeProject('project-1', { members: { 'owner-1': 'OWNER', 'u-2': 'EDITOR' } as never }),
  );
  await ctx.profiles.saveProfile(makeProfile('local'));

  await ctx.settings.setWorkspace('/tmp/ws');
  await ctx.settings.setDefaultAgent('assistant');
  await ctx.settings.setTokenRatio('gpt-4o', 3.5);
  await ctx.settings.setMigrationMarker('session-scope-snapshots-v1');
  await ctx.defaults.saveDefaults({ locale: 'ru', themeMode: 'dark' });

  await ctx.providers.save('itphx', { name: 'itphx', type: 'openai' });
  await ctx.models.save('itphx/gpt-4o', {
    id: 'itphx/gpt-4o',
    name: 'gpt-4o',
    provider: 'itphx',
    enabled: true,
  });
  await ctx.agents.save('assistant', { id: 'assistant', name: 'Assistant' } as never);

  await ctx.eventBindings.upsert({
    id: 'bnd-1',
    source: 'telegram',
    chatKey: 'chat-1',
    mode: 'bound',
    sessionId: 'sess-1',
  });
  await ctx.eventRoutes.upsert({
    id: 'rule-1',
    priority: 10,
    enabled: true,
    match: { source: 'telegram' },
    target: { mode: 'ephemeral' },
  });
  await ctx.eventApiKeys.create({ bindingId: 'bnd-1', label: 'tg-key', createdBy: 'local' });
  await ctx.eventJournal.record({
    ts: ISO,
    event: { id: 'evt-1', source: 'telegram', type: 'message', payload: {}, identity: {}, dedupKey: 'd1', ts: ISO },
  });
  await ctx.identityClaims.create({ provider: 'tg', externalId: '42', principalId: 'tg:42' });
  await ctx.schedules.create({
    name: 'nightly',
    enabled: true,
    cron: '0 3 * * *',
    target: { mode: 'ephemeral' },
  });
  await ctx.jobs.append({
    id: 'job-1',
    scheduleId: 'sch-1',
    scheduleName: 'nightly',
    trigger: 'cron',
    status: 'ok',
    startedAt: ISO,
    finishedAt: ISO,
    durationMs: 5,
    target: { mode: 'ephemeral' },
  });
  await ctx.webhooks.create({ label: 'hook', url: 'https://example.com/hook', events: ['event.*'] }, 'local');
  await ctx.webhookDeliveries.record({
    id: 'whd-1',
    subscriptionId: 'whk-1',
    eventType: 'event.a',
    status: 'ok',
    attempts: 1,
    createdAt: ISO,
  });
  await ctx.sshKeys.create({ name: 'deploy', privateKey: 'PRIVATE-KEY' });
  await ctx.serviceKeys.create({ label: 'svc', scopes: ['events:read'] }, 'local');
  await ctx.mcpRegistry.add({
    name: 'srv',
    config: { command: 'echo' } as unknown as McpServerConfig,
    origin: 'instance',
  });
  await ctx.skillBundles.set({ name: 'bundle-1', description: 'b', skills: ['a'] } as unknown as SkillBundle);
  await ctx.maintenanceAudit.append({ id: 'ma-1', ts: ISO, op: 'backup.created', status: 'ok' });
}

/** Счётчики сущности из отчёта. */
function entity(report: StorageMigrationReport, name: string): { copied: number; skipped: number; note?: string } {
  const found = report.entities.find((item) => item.entity === name);
  if (!found) throw new Error(`нет сущности ${name} в отчёте`);
  return found;
}

describe('migrateStorageData — перенос данных через порты (file ↔ memory)', () => {
  let tmpDir: string;
  let targetDir: string;
  let source: StorageContext;
  let target: StorageContext | undefined;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-storage-migrate-'));
    targetDir = join(tmpDir, 'target');
    await mkdir(targetDir, { recursive: true });
    source = createMemoryStorage();
    await seed(source);
    target = await createStorageContextAsync('file', { dataDir: targetDir });
  });

  afterEach(async () => {
    await target?.close?.().catch(() => {});
    target = undefined;
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('переносит все сущности: сессии целиком, проекты (members), профили, settings, словари, события', async () => {
    const report = await migrateStorageData({ source, target: target! });

    expect(report.from).toBe('memory');
    expect(report.to).toBe('file');
    expect(report.dryRun).toBe(false);
    expect(report.entities.map((item) => item.entity)).toEqual([...STORAGE_MIGRATION_ENTITIES]);
    expect(report.copied).toBeGreaterThan(0);
    expect(entity(report, 'sessions')).toMatchObject({ copied: 1, skipped: 0 });

    // Сессия — целиком: история, ссылки, чекпоинты, стикеры.
    const session = await target!.sessions.load('sess-1');
    expect(session?.title).toBe('первая сессия');
    expect(session?.messages).toHaveLength(1);
    expect(session?.messages[0]?.content).toBe('привет мир');
    expect(session?.references).toHaveLength(1);
    expect(session?.checkpoints).toHaveLength(1);
    expect(session?.stickyNotes).toHaveLength(1);

    // Проект с участниками; профиль.
    const project = await target!.projects.load('project-1');
    expect(project?.members).toMatchObject({ 'owner-1': 'OWNER', 'u-2': 'EDITOR' });
    expect(await target!.profiles.loadProfile('local')).not.toBeNull();

    // Настройки (мапинг `load()` → сеттеры порта) и умолчания оформления.
    expect(await target!.settings.getWorkspace()).toBe('/tmp/ws');
    expect(await target!.settings.getDefaultAgent()).toBe('assistant');
    expect((await target!.settings.getTokenRatios())['gpt-4o']).toBe(3.5);
    expect(await target!.settings.getMigrationMarker('session-scope-snapshots-v1')).toBe(true);
    expect(await target!.defaults.loadDefaults()).toMatchObject({ locale: 'ru', themeMode: 'dark' });

    // Конфиг-словари.
    expect((await target!.providers.load('itphx'))?.type).toBe('openai');
    expect((await target!.models.load('itphx/gpt-4o'))?.name).toBe('gpt-4o');
    expect((await target!.agents.load('assistant'))?.id).toBe('assistant');

    // Внешние события и шедулер.
    expect((await target!.eventBindings.get('bnd-1'))?.sessionId).toBe('sess-1');
    expect((await target!.eventRoutes.get('rule-1'))?.priority).toBe(10);
    expect((await target!.eventApiKeys.listByBinding('bnd-1')).map((key) => key.label)).toEqual(['tg-key']);
    expect((await target!.eventJournal.list()).map((entry) => entry.event.id)).toEqual(['evt-1']);
    expect((await target!.identityClaims.list(true)).map((claim) => claim.externalId)).toEqual(['42']);
    expect((await target!.schedules.list()).map((schedule) => schedule.name)).toEqual(['nightly']);
    expect((await target!.jobs.list()).map((job) => job.id)).toEqual(['job-1']);
    expect((await target!.webhooks.list()).map((item) => item.label)).toEqual(['hook']);
    expect((await target!.webhookDeliveries.list()).map((item) => item.id)).toEqual(['whd-1']);

    // Секреты/контент/аудит.
    expect((await target!.sshKeys.list()).map((key) => key.name)).toEqual(['deploy']);
    expect((await target!.serviceKeys.list()).map((key) => key.label)).toEqual(['svc']);
    expect((await target!.mcpRegistry.getByName('srv'))?.name).toBe('srv');
    expect(await target!.skillBundles.exists('bundle-1')).toBe(true);
    expect((await target!.maintenanceAudit.list()).map((entry) => entry.id)).toEqual(['ma-1']);

    // service-key и ключи привязок переносятся как есть (hash/prefix/id), webhooks — нет.
    expect(entity(report, 'serviceKeys').note).toBeUndefined();
    expect(entity(report, 'eventApiKeys').note).toBeUndefined();
    expect(entity(report, 'webhooks').note).toContain('перевыпущен');
  });

  it('идемпотентность: повторный прогон — всё пропущено, дубликатов нет', async () => {
    await migrateStorageData({ source, target: target! });
    const second = await migrateStorageData({ source, target: target! });

    expect(second.copied).toBe(0);
    expect(second.skipped).toBeGreaterThan(0);
    expect(second.entities.every((item) => item.copied === 0)).toBe(true);

    // Списки не раздулись.
    expect(await target!.sessions.list()).toHaveLength(1);
    expect(await target!.jobs.list()).toHaveLength(1);
    expect(await target!.webhooks.list()).toHaveLength(1);
    expect(await target!.schedules.list()).toHaveLength(1);
    expect(await target!.maintenanceAudit.list()).toHaveLength(1);
    expect(await target!.eventBindings.list()).toHaveLength(1);
  });

  it('service-key и event-ключ переносятся с исходными id/hash/prefix — выданные токены работают', async () => {
    const src = createMemoryStorage();
    const dst = createMemoryStorage();
    await src.eventBindings.upsert({ id: 'bnd-9', source: 'telegram', chatKey: 'chat-9', mode: 'bound' });
    const eventKey = await src.eventApiKeys.create({ bindingId: 'bnd-9', label: 'gateway', createdBy: 'local' });
    const serviceKey = await src.serviceKeys.create(
      { label: 'installer-x', scopes: ['events:ingest'] },
      'local',
    );
    const srcEvent = (await src.eventApiKeys.exportAll()).find((key) => key.id === eventKey.id)!;
    const srcService = (await src.serviceKeys.exportAll()).find((key) => key.id === serviceKey.id)!;

    await migrateStorageData({ source: src, target: dst });

    // Токены, выданные до миграции, резолвятся на цели (регрессия 401).
    const dstEvent = await dst.eventApiKeys.resolveBySecret(eventKey.key);
    expect(dstEvent?.key.id).toBe(eventKey.id);
    expect(dstEvent?.key.prefix).toBe(eventKey.prefix);
    const dstService = await dst.serviceKeys.resolveBySecret(serviceKey.key);
    expect(dstService?.key.id).toBe(serviceKey.id);
    expect(dstService?.key.prefix).toBe(serviceKey.prefix);

    // at-rest хеш перенесён без перегенерации.
    expect((await dst.eventApiKeys.exportAll()).find((key) => key.id === eventKey.id)?.hash).toBe(
      srcEvent.hash,
    );
    expect((await dst.serviceKeys.exportAll()).find((key) => key.id === serviceKey.id)?.hash).toBe(
      srcService.hash,
    );

    // Повторный прогон ничего не дублирует.
    const second = await migrateStorageData({ source: src, target: dst });
    expect(second.copied).toBe(0);
    expect(await dst.eventApiKeys.listByBinding('bnd-9')).toHaveLength(1);
    expect((await dst.serviceKeys.list()).filter((key) => key.label === 'installer-x')).toHaveLength(1);
  });

  it('dry-run: счётчики считаются, цель не меняется', async () => {
    const report = await migrateStorageData({ source, target: target!, dryRun: true });

    expect(report.dryRun).toBe(true);
    expect(report.copied).toBeGreaterThan(0);
    expect(await target!.sessions.list()).toEqual([]);
    expect(await target!.projects.list()).toEqual([]);
    expect(await target!.settings.getWorkspace()).toBeUndefined();
    expect(await target!.skillBundles.list()).toEqual([]);
  });

  it('существующие записи в цели не перезаписываются (пропуск по id)', async () => {
    // Цель уже содержит ту же сессию с другим заголовком.
    await target!.sessions.save(makeSession({ id: 'sess-1', title: 'целевой заголовок' }));

    const report = await migrateStorageData({ source, target: target! });

    expect(entity(report, 'sessions')).toMatchObject({ copied: 0, skipped: 1 });
    expect((await target!.sessions.load('sess-1'))?.title).toBe('целевой заголовок');
  });

  it('обратное направление (file → memory) — те же счётчики и данные', async () => {
    // Сначала наполняем файловую цель (memory → file), затем гоняем обратно.
    await migrateStorageData({ source, target: target! });
    const memoryTarget = createMemoryStorage();

    const report = await migrateStorageData({ source: target!, target: memoryTarget });

    expect(report.from).toBe('file');
    expect(report.to).toBe('memory');
    expect((await memoryTarget.sessions.load('sess-1'))?.messages).toHaveLength(1);
    expect((await memoryTarget.projects.load('project-1'))?.id).toBe('project-1');
    expect(entity(report, 'projects')).toMatchObject({ copied: 1, skipped: 0 });
  });
});

describe('runStorageMigrateCommand — CLI-команда (PROP-032)', () => {
  let tmpDir: string;
  let dataDir: string;
  let targetDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-storage-migrate-cli-'));
    dataDir = join(tmpDir, 'data');
    targetDir = join(tmpDir, 'target');
    await mkdir(dataDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('без --yes и без --dry-run — отказ (код 1), данные не переносятся', async () => {
    const errors: string[] = [];
    const code = await runStorageMigrateCommand({
      dataDir,
      config: makeConfig(),
      to: 'file',
      targetDataDir: targetDir,
      env: { ...process.env, SYNTH_STORAGE_BACKEND: 'memory' },
      log: () => {},
      error: (msg) => errors.push(msg),
    });

    expect(code).toBe(1);
    expect(errors.join('\n')).toContain('--yes');
    await expect(stat(targetDir)).rejects.toThrow();
  });

  it('источник и цель совпадают — отказ', async () => {
    const errors: string[] = [];
    const code = await runStorageMigrateCommand({
      dataDir,
      config: makeConfig(),
      to: 'file',
      yes: true,
      env: { ...process.env, SYNTH_STORAGE_BACKEND: 'file' },
      log: () => {},
      error: (msg) => errors.push(msg),
    });

    expect(code).toBe(1);
    expect(errors.join('\n')).toContain('совпадают');
  });

  it('недоступный целевой backend: деградация цели не маскируется под успех — отказ (код 1)', async () => {
    const errors: string[] = [];
    // Источник — memory; цель — postgres, но БД недоступна (порт 1): сборка цели
    // уходит в деградированный файловый фоллбек (`target.kind='file'`). Команда
    // обязана отказать, а не молча переносить данные в чужой каталог.
    const env: NodeJS.ProcessEnv = { ...process.env, SYNTH_STORAGE_BACKEND: 'memory' };
    delete env.SYNTH_POSTGRES_DSN;
    delete env.SYNTH_POSTGRES_PASSWORD;
    env.SYNTH_POSTGRES_HOST = '127.0.0.1';
    env.SYNTH_POSTGRES_PORT = '1';
    env.SYNTH_POSTGRES_DATABASE = 'nonexistent';
    env.SYNTH_POSTGRES_USER = 'nonexistent';
    env.SYNTH_STORAGE_FALLBACK_DIR = join(tmpDir, 'fallback');

    const code = await runStorageMigrateCommand({
      dataDir,
      config: makeConfig(),
      to: 'postgres',
      yes: true,
      env,
      log: () => {},
      error: (msg) => errors.push(msg),
    });

    expect(code).toBe(1);
    expect(errors.join('\n')).toContain('недоступ');
  });

  it('dry-run: цель берётся из --to (env не перебивает), предупреждает о непустом каталоге, аудит не пишет', async () => {
    await mkdir(targetDir, { recursive: true });
    await writeFile(join(targetDir, 'settings.json'), '{}', 'utf-8');
    const lines: string[] = [];
    const warnings: string[] = [];
    const audit = new MemoryMaintenanceAuditRepository();

    const code = await runStorageMigrateCommand({
      dataDir,
      config: makeConfig(),
      to: 'file',
      targetDataDir: targetDir,
      dryRun: true,
      // Источник — memory (env), цель обязана быть file (флаг `--to`).
      env: { ...process.env, SYNTH_STORAGE_BACKEND: 'memory' },
      audit,
      log: (msg) => lines.push(msg),
      error: (msg) => warnings.push(msg),
    });

    expect(code).toBe(0);
    const out = lines.join('\n');
    expect(out).toContain('memory → file');
    expect(out).toContain('итого: скопировано 0');
    expect(out).toContain('(dry-run: изменения не записаны)');
    expect(warnings.join('\n')).toContain('уже есть данные');
    expect(await audit.list()).toEqual([]);
    // Целевой каталог не тронут (осталась только наша запись).
    expect(JSON.parse(await readFile(join(targetDir, 'settings.json'), 'utf-8'))).toEqual({});
  });

  it('--yes: пишет аудит migrate.applied с backend-парами; цель не затронута при пустом источнике', async () => {
    const audit = new MemoryMaintenanceAuditRepository();
    const lines: string[] = [];

    const code = await runStorageMigrateCommand({
      dataDir,
      config: makeConfig(),
      to: 'file',
      targetDataDir: targetDir,
      yes: true,
      env: { ...process.env, SYNTH_STORAGE_BACKEND: 'memory' },
      audit,
      log: (msg) => lines.push(msg),
      error: () => {},
    });

    expect(code).toBe(0);
    expect(lines.join('\n')).toContain('memory → file');
    const entries = await audit.list();
    expect(entries.map((entry) => entry.op)).toEqual(['migrate.applied']);
    expect(entries[0]?.details).toMatchObject({
      storageBackend: { from: 'memory', to: 'file' },
      trigger: 'cli',
    });
  });
});
