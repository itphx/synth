// ADR-091 (этап 2): тесты портативного экспорта/импорта проекта на tmp-каталогах.
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MessageRole } from '@itphx/synth-shared';
import type { Message, Part } from '@itphx/synth-shared';
import { SessionManager } from '../sessions/manager.js';
import { createFileStorage } from '../storage/storage-context.js';
import { MemoryMaintenanceAuditRepository } from '../storage/memory/index.js';
import type { MaintenanceAuditRepository } from '../storage/ports/maintenance-audit-repository.js';
import { readFileFromTarGz, readTarGz, writeTarGz, type ArchiveSource } from '../maintenance/archive.js';
import { ProjectPortableError, exportProject, importProject } from './portable.js';

/** Реальный секрет в карте обфускации сессии (плейсхолдер → значение). */
const REAL_SECRET = 'sk-live-DO-NOT-LEAK';
const PLACEHOLDER = '⟦SYNTH_SECRET_1⟧';


/** Сообщение для фикстуры. */
function _msg(id: string, content: string, refSessionId?: string): Message {
  const parts: Part[] = [{ id: `${id}-p`, type: 'text', data: content }];
  if (refSessionId) {
    parts.push({ id: `${id}-r`, type: 'session_reference', data: { sessionId: refSessionId, label: 'ref' } });
  }
  return {
    id,
    role: MessageRole.USER,
    seq: 1,
    origin: 'local',
    parts,
    content,
    createdAt: '2026-01-01T00:00:00.000Z',
    disabled: false,
    pinned: false,
    hidden: false,
  };
}

interface Fixture {
  projectId: string;
  sessionIds: string[];
}

/** Проект с планом, двумя сессиями (сообщения, todo, ссылка) и «грязным» статусом. */
async function makeProject(dataDir: string, name: string): Promise<Fixture> {
  const storage = createFileStorage({ dataDir });
  const project = storage.projects.create(name, 'local', {
    description: 'описание проекта',
    icon: 'code',
    color: 'a2',
  });
  project.currentTask = 'текущая задача';
  project.invariants = 'инварианты проекта';
  project.plan = {
    version: 1,
    updatedAt: '2026-01-01T00:00:00.000Z',
    columns: [{ id: 'todo', name: 'К выполнению', order: 0 }],
    items: [
      {
        id: 'pi1',
        title: 'Пункт плана',
        columnId: 'todo',
        priority: 'high',
        order: 0,
        dependsOn: [],
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    ],
  };
  await storage.projects.save(project);

  const manager = new SessionManager(storage.sessions, { projectStore: storage.projects });
  const s1 = await manager.createSession({ title: 'Сессия 1', icon: 'chat', color: 'a1', projectId: project.id });
  s1.messages = [_msg('m1', 'привет')];
  // Карта обфускации LLM Gateway + раскрытые значения плейсхолдера в
  // metadata сообщения (ADR-036) — секреты, которые не должны уезжать в
  // портативный архив проекта по умолчанию (security-фикс 0.11.3).
  s1.obfuscationMap = { [PLACEHOLDER]: REAL_SECRET };
  s1.messages[0]!.metadata = { secrets: { [PLACEHOLDER]: REAL_SECRET } };
  s1.todos = [{ id: 't1', content: 'сделать', status: 'pending', priority: 'high' }];
  s1.status = { blocked: 'processor-1', blockedAt: '2026-01-01T00:00:00.000Z', cancelRequested: true };
  await manager.saveSession(s1);

  const s2 = await manager.createSession({ title: 'Сессия 2', projectId: project.id });
  s2.messages = [_msg('m2', 'ссылка', s1.id)];
  s2.references = [
    {
      type: 'session_reference',
      sessionId: s1.id,
      label: 'ref',
      messageRange: [1, 1],
      createdAt: '2026-01-01T00:00:00.000Z',
    },
  ];
  await manager.saveSession(s2);

  return { projectId: project.id, sessionIds: [s1.id, s2.id] };
}

/** Собирает архив вручную (для проверки битых архивов). */
async function craftArchive(
  dir: string,
  files: Array<{ path: string; content: string }>,
  manifest: Buffer | null,
): Promise<string> {
  const stage = join(dir, `stage-${Math.random().toString(36).slice(2)}`);
  await mkdir(stage, { recursive: true });
  const sources: ArchiveSource[] = [];
  for (const file of files) {
    const abs = join(stage, file.path);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, file.content, 'utf-8');
    sources.push({ path: file.path, type: 'file', absPath: abs, mode: 0o644 });
  }
  const out = join(dir, `crafted-${Math.random().toString(36).slice(2)}.synth-project.tar.gz`);
  await writeTarGz(out, sources, {
    ...(manifest ? { extraFile: { path: 'manifest.json', content: manifest } } : {}),
  });
  return out;
}

/** Манифест экспорта проекта для подделки. */
function craftManifest(
  entries: Array<{ path: string; size: number; sha256: string }>,
  overrides: Partial<{ withWorkspace: boolean; sessions: number }> = {},
): Buffer {
  return Buffer.from(
    JSON.stringify({
      tool: 'synth-project-export',
      formatVersion: 1,
      exportedAt: '2026-01-01T00:00:00.000Z',
      instanceVersion: '0.0.0',
      project: { id: 'p-source', name: 'Источник' },
      sessions: 0,
      withWorkspace: false,
      entries,
      ...overrides,
    }),
    'utf-8',
  );
}

/** Читает все файлы архива (путь → содержимое). */
async function readArchiveFiles(archive: string): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  await readTarGz(archive, (entry) => {
    if (entry.type === 'file') files.set(entry.path, entry.content.toString('utf-8'));
  });
  return files;
}

/** Тексты payload'ов сессий из архива. */
function sessionPayloads(files: Map<string, string>): string[] {
  return [...files.entries()]
    .filter(([path]) => path.startsWith('sessions/') && path.endsWith('.json'))
    .map(([, content]) => content);
}

describe('portable export/import проекта (ADR-091)', () => {
  let tmpDir: string;
  let src: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-portable-'));
    src = join(tmpDir, 'src');
    await mkdir(src, { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('round-trip: новый проект и новые id, сообщения/todos/план сохранены, статус сброшен', async () => {
    const fixture = await makeProject(src, 'Проект A');
    const out = tmpDir;
    const exported = await exportProject({ dataDir: src, projectId: fixture.projectId, out });

    expect(exported.sessions).toBe(2);
    expect(exported.entries).toBeGreaterThanOrEqual(3); // project.json + 2 sessions
    expect(exported.path.endsWith('.synth-project.tar.gz')).toBe(true);

    // Архив читаем, содержит манифест и project.json.
    const manifestRaw = await readFileFromTarGz(exported.path, 'manifest.json');
    expect(manifestRaw).toBeTruthy();
    const manifest = JSON.parse(manifestRaw?.toString('utf-8') ?? '{}') as { tool: string; sessions: number };
    expect(manifest.tool).toBe('synth-project-export');
    expect(manifest.sessions).toBe(2);
    expect(await readFileFromTarGz(exported.path, 'project.json')).toBeTruthy();

    const dst = join(tmpDir, 'dst');
    await mkdir(dst, { recursive: true });
    const result = await importProject({ dataDir: dst, archive: exported.path, yes: true });

    expect(result.projectId).not.toBe(fixture.projectId);
    expect(result.sessionsImported).toBe(2);
    expect(result.messagesImported).toBe(2);
    expect(Object.keys(result.idMap)).toHaveLength(2);

    const dstStorage = createFileStorage({ dataDir: dst });
    const dstProject = await dstStorage.projects.load(result.projectId);
    expect(dstProject?.name).toBe('Проект A');
    expect(dstProject?.description).toBe('описание проекта');
    expect(dstProject?.icon).toBe('code');
    expect(dstProject?.color).toBe('a2');
    expect(dstProject?.plan?.items).toHaveLength(1);
    expect(dstProject?.plan?.items[0]?.title).toBe('Пункт плана');

    const sessions = await new SessionManager(dstStorage.sessions).listSessions({ projectId: result.projectId });
    expect(sessions).toHaveLength(2);
    expect(new Set(sessions.map((s) => s.id)).size).toBe(2);
    for (const session of sessions) {
      expect(session.projectId).toBe(result.projectId);
      // Безопасный статус: без блокировки/отмены/активного стрима.
      expect(session.status.blocked).toBeUndefined();
      expect(session.status.cancelRequested).toBeFalsy();
      expect(session.currentStream).toBeUndefined();
    }

    const s1New = sessions.find((s) => s.title === 'Сессия 1');
    expect(s1New).toBeTruthy();
    expect(s1New?.messages).toHaveLength(1);
    expect(s1New?.messages[0]?.content).toBe('привет');
    expect(s1New?.todos?.[0]?.content).toBe('сделать');
    expect(result.idMap[fixture.sessionIds[0] as string]).toBe(s1New?.id);

    // Ссылка в сессии 2 переписана на новый id сессии 1.
    const s2New = sessions.find((s) => s.title === 'Сессия 2');
    expect(s2New?.references[0]?.sessionId).toBe(s1New?.id);
    const refPart = s2New?.messages[0]?.parts.find((p) => p.type === 'session_reference');
    expect((refPart?.data as Record<string, unknown>).sessionId).toBe(s1New?.id);
  });

  it('--merge-into: сессии попадают в существующий проект (project_id переписан)', async () => {
    const fixture = await makeProject(src, 'Проект A');
    const exported = await exportProject({ dataDir: src, projectId: fixture.projectId, out: tmpDir });

    const dst = join(tmpDir, 'merge-dst');
    await mkdir(dst, { recursive: true });
    const dstStorage = createFileStorage({ dataDir: dst });
    const target = dstStorage.projects.create('Цель', 'local');
    await dstStorage.projects.save(target);

    const result = await importProject({
      dataDir: dst,
      archive: exported.path,
      mergeInto: target.id,
      yes: true,
    });

    expect(result.projectId).toBe(target.id);
    const sessions = await new SessionManager(dstStorage.sessions).listSessions({ projectId: target.id });
    expect(sessions).toHaveLength(2);
    // Новый проект не создавался — только целевой.
    expect((await dstStorage.projects.list()).map((p) => p.name)).toEqual(['Цель']);
  });

  it('--dry-run: валидирует архив, печатает план и ничего не создаёт', async () => {
    const fixture = await makeProject(src, 'Проект A');
    const exported = await exportProject({ dataDir: src, projectId: fixture.projectId, out: tmpDir });

    const dst = join(tmpDir, 'dry-dst');
    await mkdir(dst, { recursive: true });
    const logs: string[] = [];
    const result = await importProject({
      dataDir: dst,
      archive: exported.path,
      dryRun: true,
      log: (m) => logs.push(m),
    });

    expect(result.sessionsImported).toBe(2);
    expect(result.messagesImported).toBe(2);
    expect(logs.join('\n')).toContain('dry-run');

    const dstStorage = createFileStorage({ dataDir: dst });
    expect(await dstStorage.projects.list()).toHaveLength(0);
    expect(await dstStorage.sessions.list()).toHaveLength(0);
  });

  it('без --dry-run и без --yes: отказ, ничего не создано', async () => {
    const fixture = await makeProject(src, 'Проект A');
    const exported = await exportProject({ dataDir: src, projectId: fixture.projectId, out: tmpDir });

    const dst = join(tmpDir, 'noyes');
    await mkdir(dst, { recursive: true });

    const error = await importProject({ dataDir: dst, archive: exported.path }).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(ProjectPortableError);
    expect((error as ProjectPortableError).code).toBe('confirmation-required');

    const dstStorage = createFileStorage({ dataDir: dst });
    expect(await dstStorage.projects.list()).toHaveLength(0);
    expect(await dstStorage.sessions.list()).toHaveLength(0);
  });

  it('битый архив: испорченный байт → invalid-archive/checksum-mismatch', async () => {
    const fixture = await makeProject(src, 'Проект A');
    const exported = await exportProject({ dataDir: src, projectId: fixture.projectId, out: tmpDir });

    const buffer = await readFile(exported.path);
    const middle = Math.floor(buffer.length / 2);
    buffer[middle] = (buffer[middle] as number) ^ 0xff;
    const corrupted = join(tmpDir, 'corrupted.synth-project.tar.gz');
    await writeFile(corrupted, buffer);

    const dst = join(tmpDir, 'corrupt-dst');
    const error = await importProject({ dataDir: dst, archive: corrupted, yes: true }).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(ProjectPortableError);
    expect(['invalid-archive', 'checksum-mismatch']).toContain((error as ProjectPortableError).code);
  });

  it('sha256 в манифесте не совпадает → checksum-mismatch', async () => {
    const archive = await craftArchive(
      tmpDir,
      [{ path: 'project.json', content: '{}' }],
      craftManifest([{ path: 'project.json', size: 2, sha256: 'deadbeef'.repeat(8) }]),
    );
    const error = await importProject({ dataDir: join(tmpDir, 'cs-dst'), archive, yes: true }).catch(
      (err: unknown) => err,
    );
    expect(error).toBeInstanceOf(ProjectPortableError);
    expect((error as ProjectPortableError).code).toBe('checksum-mismatch');
  });

  it('manifest.json не JSON → invalid-archive', async () => {
    const archive = await craftArchive(
      tmpDir,
      [{ path: 'project.json', content: '{}' }],
      Buffer.from('{ это не json', 'utf-8'),
    );
    const error = await importProject({ dataDir: join(tmpDir, 'bad-manifest'), archive, yes: true }).catch(
      (err: unknown) => err,
    );
    expect(error).toBeInstanceOf(ProjectPortableError);
    expect((error as ProjectPortableError).code).toBe('invalid-archive');
  });

  it('архив без manifest.json → invalid-archive', async () => {
    const archive = await craftArchive(tmpDir, [{ path: 'project.json', content: '{}' }], null);
    const error = await importProject({ dataDir: join(tmpDir, 'no-manifest'), archive, yes: true }).catch(
      (err: unknown) => err,
    );
    expect(error).toBeInstanceOf(ProjectPortableError);
    expect((error as ProjectPortableError).code).toBe('invalid-archive');
  });

  it('секреты не попадают в архив', async () => {
    const fixture = await makeProject(src, 'Проект A');
    await mkdir(join(src, 'secrets'), { recursive: true, mode: 0o700 });
    await writeFile(join(src, 'secrets', 'master.key'), 'TOPSECRETVALUE', 'utf-8');

    const exported = await exportProject({ dataDir: src, projectId: fixture.projectId, out: tmpDir });

    const files: Array<{ path: string; content: string }> = [];
    await readTarGz(exported.path, (entry) => {
      if (entry.type === 'file') files.push({ path: entry.path, content: entry.content.toString('utf-8') });
    });

    expect(files.some((f) => f.path === 'secrets' || f.path.startsWith('secrets/'))).toBe(false);
    expect(files.some((f) => f.path === 'master.key' || f.path.endsWith('/master.key'))).toBe(false);
    expect(files.some((f) => f.content.includes('TOPSECRETVALUE'))).toBe(false);
  });

  it('security-фикс 0.11.3: по умолчанию карта обфускации и metadata.secrets вырезаны из payload сессий', async () => {
    const fixture = await makeProject(src, 'Проект A');

    const exported = await exportProject({ dataDir: src, projectId: fixture.projectId, out: tmpDir });
    const files = await readArchiveFiles(exported.path);
    const payloads = sessionPayloads(files);

    expect(payloads.length).toBe(2);
    for (const payload of payloads) {
      // Ни camelCase (переносимый payload), ни snake_case (файловое хранилище).
      expect(payload).not.toContain('obfuscationMap');
      expect(payload).not.toContain('obfuscation_map');
      // Реальные значения плейсхолдеров в metadata сообщения.
      expect(payload).not.toContain(REAL_SECRET);
      expect(payload).not.toContain('"secrets"');
    }
  });

  it('security-фикс 0.11.3: --with-secrets возвращает карту обфускации; факт — в аудите export.created', async () => {
    const fixture = await makeProject(src, 'Проект A');
    const audit = new MemoryMaintenanceAuditRepository();

    const exported = await exportProject({
      dataDir: src,
      projectId: fixture.projectId,
      out: tmpDir,
      withSecrets: true,
      audit,
      actor: 'cli',
    });

    const files = await readArchiveFiles(exported.path);
    const payloads = sessionPayloads(files);
    expect(payloads.some((p) => p.includes(REAL_SECRET))).toBe(true);
    expect(payloads.some((p) => p.includes('obfuscationMap'))).toBe(true);

    const created = (await audit.list()).find((e) => e.op === 'export.created');
    expect(created?.details?.withSecrets).toBe(true);
  });

  it('security-фикс 0.11.3: в аудите export.created без opt-in — withSecrets=false', async () => {
    const fixture = await makeProject(src, 'Проект A');
    const audit = new MemoryMaintenanceAuditRepository();

    await exportProject({ dataDir: src, projectId: fixture.projectId, out: tmpDir, audit, actor: 'cli' });

    const created = (await audit.list()).find((e) => e.op === 'export.created');
    expect(created?.details?.withSecrets).toBe(false);
  });

  it('импорт архива с картой обфускации (привилегированный opt-in) — карта восстанавливается', async () => {
    const fixture = await makeProject(src, 'Проект A');
    const exported = await exportProject({
      dataDir: src,
      projectId: fixture.projectId,
      out: tmpDir,
      withSecrets: true,
    });

    const dst = join(tmpDir, 'secrets-dst');
    await mkdir(dst, { recursive: true });
    const result = await importProject({ dataDir: dst, archive: exported.path, yes: true });

    const sessions = await new SessionManager(createFileStorage({ dataDir: dst }).sessions)
      .listSessions({ projectId: result.projectId });
    const withMap = sessions.find((s) => s.obfuscationMap);
    expect(withMap?.obfuscationMap?.[PLACEHOLDER]).toBe(REAL_SECRET);
  });

  it('сессии с origin remote не экспортируются (счётчик/предупреждение)', async () => {
    const fixture = await makeProject(src, 'Проект A');
    const storage = createFileStorage({ dataDir: src });
    const manager = new SessionManager(storage.sessions);
    const remote = await manager.createSession({ title: 'Remote', projectId: fixture.projectId });
    const originalId = remote.id;
    remote.id = 'remote:xyz';
    (remote as unknown as { origin?: string }).origin = 'remote';
    await storage.sessions.save(remote);
    await storage.sessions.delete(originalId);

    const logs: string[] = [];
    const exported = await exportProject({
      dataDir: src,
      projectId: fixture.projectId,
      out: tmpDir,
      log: (m) => logs.push(m),
    });

    expect(exported.sessions).toBe(2);
    expect(logs.join('\n')).toContain('удалённ');
  });

  it('--with-workspace: файл восстанавливается; без флага workspace не создаётся', async () => {
    const fixture = await makeProject(src, 'Проект A');
    const srcStorage = createFileStorage({ dataDir: src });
    const project = await srcStorage.projects.load(fixture.projectId);
    project!.workspace = 'proj-a';
    await srcStorage.projects.save(project!);
    await mkdir(join(src, 'workspaces', 'proj-a'), { recursive: true });
    await writeFile(join(src, 'workspaces', 'proj-a', 'readme.txt'), 'hello', 'utf-8');

    const exported = await exportProject({
      dataDir: src,
      projectId: fixture.projectId,
      out: tmpDir,
      withWorkspace: true,
    });
    expect(exported.withWorkspace).toBe(true);

    const dst = join(tmpDir, 'ws-dst');
    await mkdir(dst, { recursive: true });
    const result = await importProject({
      dataDir: dst,
      archive: exported.path,
      withWorkspace: true,
      yes: true,
    });
    expect(result.workspaceRestored).toBe(true);

    const dstStorage = createFileStorage({ dataDir: dst });
    const dstProject = await dstStorage.projects.load(result.projectId);
    expect(dstProject?.workspace).toBeTruthy();
    const restored = await readFile(join(dst, 'workspaces', dstProject!.workspace as string, 'readme.txt'), 'utf-8');
    expect(restored).toBe('hello');

    // Без флага workspace не создаётся.
    const dst2 = join(tmpDir, 'ws-dst-2');
    await mkdir(dst2, { recursive: true });
    const result2 = await importProject({ dataDir: dst2, archive: exported.path, yes: true });
    expect(result2.workspaceRestored).toBe(false);
    const dst2Storage = createFileStorage({ dataDir: dst2 });
    const dst2Project = await dst2Storage.projects.load(result2.projectId);
    expect(dst2Project?.workspace).toBeUndefined();
    await expect(stat(join(dst2, 'workspaces'))).rejects.toThrow();
  });

  it('security-фикс 0.11.3 (R3): запись workspace через симлинк в каталоге отклоняется, файл вне workspace не создан', async () => {
    const dst = join(tmpDir, 'symlink-dir-dst');
    await mkdir(dst, { recursive: true });
    const dstStorage = createFileStorage({ dataDir: dst });
    const target = dstStorage.projects.create('Target', 'local');
    target.workspace = 'ws-target';
    await dstStorage.projects.save(target);

    // Каталог вне workspace + симлинк на него внутри workspace.
    const outsideDir = join(tmpDir, 'outside-dir');
    await mkdir(outsideDir, { recursive: true });
    const wsDir = join(dst, 'workspaces', 'ws-target');
    await mkdir(wsDir, { recursive: true });
    await symlink(outsideDir, join(wsDir, 'escape'));

    const payload = 'PWNED';
    const archive = await craftArchive(
      tmpDir,
      [
        { path: 'project.json', content: '{}' },
        { path: 'workspace/escape/pwned.txt', content: payload },
      ],
      craftManifest(
        [
          { path: 'project.json', size: 2, sha256: createHash('sha256').update('{}').digest('hex') },
          {
            path: 'workspace/escape/pwned.txt',
            size: payload.length,
            sha256: createHash('sha256').update(payload).digest('hex'),
          },
        ],
        { withWorkspace: true },
      ),
    );

    const error = await importProject({
      dataDir: dst,
      archive,
      mergeInto: target.id,
      withWorkspace: true,
      yes: true,
    }).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(ProjectPortableError);
    expect((error as ProjectPortableError).code).toBe('invalid-archive');
    // Файл ВНЕ workspace не создан.
    await expect(stat(join(outsideDir, 'pwned.txt'))).rejects.toThrow();
  });

  it('security-фикс 0.11.3 (R3): симлинк в качестве финальной цели отклоняется', async () => {
    const dst = join(tmpDir, 'symlink-file-dst');
    await mkdir(dst, { recursive: true });
    const dstStorage = createFileStorage({ dataDir: dst });
    const target = dstStorage.projects.create('Target', 'local');
    target.workspace = 'ws-target';
    await dstStorage.projects.save(target);

    const outsideDir = join(tmpDir, 'outside-file');
    await mkdir(outsideDir, { recursive: true });
    const wsDir = join(dst, 'workspaces', 'ws-target');
    await mkdir(wsDir, { recursive: true });
    await symlink(join(outsideDir, 'target.txt'), join(wsDir, 'link.txt'));

    const payload = 'PWNED';
    const archive = await craftArchive(
      tmpDir,
      [
        { path: 'project.json', content: '{}' },
        { path: 'workspace/link.txt', content: payload },
      ],
      craftManifest(
        [
          { path: 'project.json', size: 2, sha256: createHash('sha256').update('{}').digest('hex') },
          {
            path: 'workspace/link.txt',
            size: payload.length,
            sha256: createHash('sha256').update(payload).digest('hex'),
          },
        ],
        { withWorkspace: true },
      ),
    );

    const error = await importProject({
      dataDir: dst,
      archive,
      mergeInto: target.id,
      withWorkspace: true,
      yes: true,
    }).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(ProjectPortableError);
    expect((error as ProjectPortableError).code).toBe('invalid-archive');
    await expect(stat(join(outsideDir, 'target.txt'))).rejects.toThrow();
  });

  it('конфликт имён: авто-имя получает суффикс, явное --name → project-name-conflict', async () => {
    const fixture = await makeProject(src, 'Проект A');
    const exported = await exportProject({ dataDir: src, projectId: fixture.projectId, out: tmpDir });

    const dst = join(tmpDir, 'name-dst');
    await mkdir(dst, { recursive: true });
    const dstStorage = createFileStorage({ dataDir: dst });
    await dstStorage.projects.save(dstStorage.projects.create('Проект A', 'local'));

    const result = await importProject({ dataDir: dst, archive: exported.path, yes: true });
    const created = await dstStorage.projects.load(result.projectId);
    expect(created?.name).toBe('Проект A (2)');

    const error = await importProject({
      dataDir: dst,
      archive: exported.path,
      name: 'Проект A',
      yes: true,
    }).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(ProjectPortableError);
    expect((error as ProjectPortableError).code).toBe('project-name-conflict');
  });

  it('аудит: export.created/import.applied пишутся; ошибка порта не ломает операцию', async () => {
    const fixture = await makeProject(src, 'Проект A');
    const exportAudit = new MemoryMaintenanceAuditRepository();
    const exported = await exportProject({
      dataDir: src,
      projectId: fixture.projectId,
      out: tmpDir,
      audit: exportAudit,
      actor: 'cli',
    });
    const exportedEntries = await exportAudit.list();
    const created = exportedEntries.find((e) => e.op === 'export.created');
    expect(created?.status).toBe('ok');
    expect(created?.actor).toBe('cli');
    expect(created?.details?.sessions).toBe(2);

    const dst = join(tmpDir, 'audit-dst');
    await mkdir(dst, { recursive: true });
    const importAudit = new MemoryMaintenanceAuditRepository();
    const result = await importProject({
      dataDir: dst,
      archive: exported.path,
      yes: true,
      audit: importAudit,
      actor: 'cli',
    });
    const applied = (await importAudit.list()).find((e) => e.op === 'import.applied');
    expect(applied?.status).toBe('ok');
    expect(applied?.details?.projectId).toBe(result.projectId);
    expect(applied?.details?.sessions).toBe(2);

    const broken: MaintenanceAuditRepository = {
      append: async () => {
        throw new Error('audit down');
      },
      list: async () => [],
      clear: async () => 0,
    };
    const robustDir = join(tmpDir, 'robust');
    await mkdir(robustDir, { recursive: true });
    const robust = await exportProject({
      dataDir: src,
      projectId: fixture.projectId,
      out: robustDir,
      audit: broken,
    });
    expect(robust.bytes).toBeGreaterThan(0);
    expect(createHash('sha256').update(await readFile(robust.path)).digest('hex')).toBeTruthy();
  });
});
