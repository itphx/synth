// Операции переноса проектов между мирами (гибридный режим, часть 8):
//   publish — локальный проект → удалённый backend (проект + сессии + файлы);
//   fork    — удалённый проект → локальный мир (проект + сессии + файлы).
// Файлы переносятся прямой синхронизацией (не git): текстовые — через fsWrite,
// бинарные — через fsUpload (publish) / fsDownload (fork).

import { readdir, readFile, stat, mkdir, writeFile } from 'node:fs/promises';
import { join, dirname, basename, isAbsolute, normalize, resolve } from 'node:path';
import type { Project, Session, Message, SessionSettings } from '@itphx/synth-shared';
import type { DirectoryListResult } from '@itphx/synth-shared';
import type { ProjectStore } from '../storage/project-store.js';
import type { SessionManager } from '../sessions/manager.js';
import type { RemoteBackendClient } from './client.js';

/** Каталоги, исключаемые из прямой синхронизации файлов. */
export const EXCLUDED_DIRS = new Set(['node_modules', '.git', '.synth']);

/** Преобразовать имя проекта в безопасное относительное имя workspace. */
export function slugify(name: string): string {
  const slug = (name || 'project')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-+/g, '-');
  return slug || 'project';
}

/** Резолв локального каталога workspace проекта (абсолютный — как есть, относительный — относительно workspacesRoot). */
export function resolveLocalWorkspace(
  project: Project,
  workspacesRoot: string,
  defaultWorkingDir: string,
): string {
  if (project.workspace) {
    return isAbsolute(project.workspace)
      ? normalize(project.workspace)
      : resolve(workspacesRoot, project.workspace);
  }
  return defaultWorkingDir;
}

/** true, если содержимое буфера выглядит бинарным (есть NUL-байт, без UTF-16 BOM). */
export function isBinaryBuffer(buf: Buffer): boolean {
  if (buf.length >= 2 && ((buf[0] === 0xff && buf[1] === 0xfe) || (buf[0] === 0xfe && buf[1] === 0xff))) {
    return false;
  }
  return buf.includes(0);
}

/**
 * Рекурсивный обход локального каталога. Возвращает отсортированный список
 * относительных POSIX-путей файлов. Исключаются: скрытые файлы/каталоги
 * (имя начинается с '.' — в т.ч. .git/.synth) и EXCLUDED_DIRS (node_modules).
 */
export async function walkDir(dir: string, relPrefix = ''): Promise<string[]> {
  const out: string[] = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out; // каталог не существует/не читается — нечего синхронизировать
  }
  for (const entry of entries) {
    const name = entry.name;
    if (name.startsWith('.')) continue;
    if (EXCLUDED_DIRS.has(name)) continue;
    const rel = relPrefix ? `${relPrefix}/${name}` : name;
    if (entry.isDirectory()) {
      out.push(...(await walkDir(join(dir, name), rel)));
    } else if (entry.isFile()) {
      out.push(rel);
    }
  }
  return out.sort();
}

/**
 * Рекурсивный обход workspace удалённого проекта через fsList. Возвращает
 * список относительных POSIX-путей файлов (аккумулятор acc передаётся по ссылке).
 * Применяются те же исключения, что и в walkDir.
 */
export async function remoteWalk(
  remoteClient: RemoteBackendClient,
  projectId: string,
  path: string,
  acc: string[],
): Promise<string[]> {
  const data = (await remoteClient.fsList({ projectId, path })) as DirectoryListResult | null;
  const entries = Array.isArray(data?.entries) ? data.entries : [];
  for (const entry of entries) {
    const name = entry.name;
    if (name.startsWith('.')) continue;
    if (EXCLUDED_DIRS.has(name)) continue;
    if (entry.isDirectory) {
      await remoteWalk(remoteClient, projectId, entry.path, acc);
    } else {
      acc.push(entry.path);
    }
  }
  return acc.sort();
}

/** Собрать тело экспорта сессии из локального объекта Session (camelCase). */
export function buildSessionExport(session: Session): Record<string, unknown> {
  return { ...session };
}

export interface SyncProjectToRemoteOptions {
  localProject: Project;
  remoteClient: RemoteBackendClient;
  /** ID существующего проекта на сервере — обновление вместо создания. */
  remoteProjectId?: string;
  includeFiles: boolean;
  includeSessions: boolean;
  /** Локальный каталог workspace проекта (источник файлов). */
  localProjectDir: string;
  localSessions: Session[];
  log?: (msg: string) => void;
}

export interface ForkProjectToLocalOptions {
  remoteProjectId: string;
  remoteClient: RemoteBackendClient;
  localProjectStore: ProjectStore;
  localSessionManager: SessionManager;
  includeFiles: boolean;
  includeSessions: boolean;
  /** Корень локальных workspace (join(dataDir, 'workspaces')). */
  localWorkspacesRoot: string;
  /** Имя локального проекта (по умолчанию — имя удалённого). */
  localName?: string;
  log?: (msg: string) => void;
}

export interface TransferStats {
  projectId: string;
  sessionsImported: number;
  filesUploaded: number;
  filesDownloaded: number;
  created: boolean;
}

/**
 * Publish: локальный проект → сервер.
 * 1. Создать/обновить проект на сервере (без локального workspace-пути —
 *    на сервере задаётся свой workspace: slug(name) для нового, существующий
 *    для --remote-project). Каталог workspace создаётся через fs/workspace-root/mkdir.
 * 2. Сессии: каждая localSession → importSession({ ...export, import: { project_id } }).
 * 3. Файлы: walkDir(localProjectDir) → fsWrite (текст) / fsUpload (бинарные).
 */
export async function syncProjectToRemote(opts: SyncProjectToRemoteOptions): Promise<TransferStats> {
  const {
    localProject, remoteClient, remoteProjectId, includeFiles, includeSessions,
    localProjectDir, localSessions, log,
  } = opts;
  const logger = log ?? (() => {});

  let targetProjectId = remoteProjectId;
  let targetWorkspace: string | undefined;
  let created = false;

  if (targetProjectId) {
    const existing = (await remoteClient.getProject(targetProjectId)) as Record<string, unknown>;
    targetWorkspace = typeof existing.workspace === 'string' ? existing.workspace : undefined;
    await remoteClient.updateProject(targetProjectId, {
      name: localProject.name,
      description: localProject.description,
      icon: localProject.icon ?? null,
      color: localProject.color ?? null,
      repos: localProject.repos ?? null,
    });
    logger(`Проект обновлён на сервере: ${targetProjectId}`);
  } else {
    const workspace = slugify(localProject.name);
    // Backend валидирует workspace при создании проекта (каталог должен
    // существовать на диске) — создаём каталог в корне workspace до createProject.
    if (includeFiles) {
      await remoteClient.fsWorkspaceMkdir({ path: workspace }).catch(() => {
        // Каталог уже существует (409 ALREADY_EXISTS) — это не ошибка.
      });
    }
    const createdProj = (await remoteClient.createProject({
      name: localProject.name,
      description: localProject.description,
      icon: localProject.icon ?? null,
      color: localProject.color ?? null,
      repos: localProject.repos ?? null,
      workspace,
    })) as Record<string, unknown>;
    targetProjectId = String(createdProj.id ?? createdProj.project_id ?? '');
    targetWorkspace = workspace;
    created = true;
    logger(`Проект создан на сервере: ${targetProjectId}`);
  }

  if (!targetProjectId) {
    throw new Error('Не удалось определить ID проекта на сервере');
  }

  // fsWrite на сервере требует, чтобы каталог workspace существовал физически.
  if (includeFiles && targetWorkspace && !created) {
    await remoteClient.fsWorkspaceMkdir({ path: targetWorkspace }).catch(() => {
      // Каталог уже существует (409 ALREADY_EXISTS) — это не ошибка.
    });
  }

  let sessionsImported = 0;
  if (includeSessions) {
    for (const s of localSessions) {
      await remoteClient.importSession({
        ...buildSessionExport(s),
        import: { project_id: targetProjectId },
      });
      sessionsImported++;
      logger(`  сессия: ${s.title || s.id}`);
    }
  }

  let filesUploaded = 0;
  if (includeFiles) {
    try {
      const s = await stat(localProjectDir);
      if (!s.isDirectory()) {
        throw new Error(`Workspace не является директорией: ${localProjectDir}`);
      }
    } catch (err) {
      if (err instanceof Error && err.message.includes('не является директорией')) throw err;
      throw new Error(`Каталог workspace не найден: ${localProjectDir}`);
    }

    const files = await walkDir(localProjectDir);
    for (const rel of files) {
      const buf = await readFile(join(localProjectDir, rel));
      if (isBinaryBuffer(buf)) {
        const fd = new FormData();
        fd.append('project_id', targetProjectId);
        fd.append('path', dirname(rel));
        fd.append('file', new Blob([buf]), basename(rel));
        await remoteClient.fsUpload(fd);
      } else {
        await remoteClient.fsWrite({ projectId: targetProjectId, path: rel, content: buf.toString('utf-8') });
      }
      filesUploaded++;
      if (filesUploaded % 50 === 0) logger(`  файлов загружено: ${filesUploaded}`);
    }
  }

  return { projectId: targetProjectId, sessionsImported, filesUploaded, filesDownloaded: 0, created };
}

/**
 * Fork: удалённый проект → локально.
 * 1. getProject → создать локальный проект (workspace = {workspacesRoot}/{slug}).
 * 2. Сессии: listSessions(remoteProjectId) → exportSession → createSession + история.
 * 3. Файлы: remoteWalk → fsDownload → запись в локальный workspace.
 */
export async function forkProjectToLocal(opts: ForkProjectToLocalOptions): Promise<TransferStats> {
  const {
    remoteProjectId, remoteClient, localProjectStore, localSessionManager,
    includeFiles, includeSessions, localWorkspacesRoot, localName, log,
  } = opts;
  const logger = log ?? (() => {});

  const remote = (await remoteClient.getProject(remoteProjectId)) as Record<string, unknown>;
  const name = localName || String(remote.name || 'remote-project');
  const workspaceRel = slugify(name);
  const workspaceAbs = join(localWorkspacesRoot, workspaceRel);

  const localProject = localProjectStore.create(name, 'local', {
    description: typeof remote.description === 'string' ? remote.description : '',
    icon: typeof remote.icon === 'string' && remote.icon ? remote.icon : undefined,
    color: typeof remote.color === 'string' && remote.color ? remote.color : undefined,
    workspace: workspaceRel,
    repos: Array.isArray(remote.repos) ? (remote.repos as Project['repos']) : undefined,
  });
  // Переносим контентные поля проекта: план (AD-039), лог, инварианты, текущую задачу.
  if (remote.plan && typeof remote.plan === 'object') localProject.plan = remote.plan as Project['plan'];
  if (Array.isArray(remote.log)) localProject.log = remote.log as Project['log'];
  if (typeof remote.current_task === 'string') localProject.currentTask = remote.current_task;
  if (typeof remote.invariants === 'string') localProject.invariants = remote.invariants;
  await localProjectStore.save(localProject);

  await mkdir(workspaceAbs, { recursive: true });
  logger(`Проект создан локально: ${localProject.id} (${name}) → ${workspaceAbs}`);

  let sessionsImported = 0;
  if (includeSessions) {
    const remoteSessions = (await remoteClient.listSessions(remoteProjectId)) as Array<Record<string, unknown>>;
    // Backend может не отфильтровать по project_id — фильтруем сами.
    const sessionsForProject = remoteSessions.filter(
      (s) => s.project_id === remoteProjectId || s.projectId === remoteProjectId,
    );
    for (const rs of sessionsForProject) {
      const id = String(rs.id ?? '');
      const exportData = (await remoteClient.exportSession(id)) as Record<string, unknown>;

      const session = await localSessionManager.createSession({
        title: typeof exportData.title === 'string' ? exportData.title : undefined,
        projectId: localProject.id,
        engine: typeof exportData.engine === 'string'
          ? (exportData.engine as Session['engine'])
          : undefined,
        sessionOrigin: (exportData.session_origin ?? exportData.sessionOrigin) as Session['sessionOrigin'] | undefined,
        settings: (exportData.settings ?? {}) as Partial<SessionSettings>,
      });

      const messages: Message[] = Array.isArray(exportData.messages)
        ? (exportData.messages as Message[]).map((m) => ({ ...structuredClone(m), seq: 0 }))
        : [];
      messages.forEach((m, i) => { m.seq = i + 1; });
      session.messages = messages;
      session.pendingMessages = [];
      session.todos = (exportData.todos ?? undefined) as Session['todos'];
      session.stickyNotes = Array.isArray(exportData.sticky_notes ?? exportData.stickyNotes)
        ? ((exportData.sticky_notes ?? exportData.stickyNotes) as Session['stickyNotes'])
        : [];
      session.references = Array.isArray(exportData.references) ? exportData.references as Session['references'] : [];
      session.checkpoints = Array.isArray(exportData.checkpoints) ? exportData.checkpoints as Session['checkpoints'] : [];
      session.mode = (exportData.mode ?? undefined) as Session['mode'];
      session.planApproved = (exportData.plan_approved ?? exportData.planApproved ?? false) as boolean | undefined;
      session.branchPoint = (exportData.branch_point ?? exportData.branchPoint) as string | undefined;
      session.obfuscationMap = (exportData.obfuscation_map ?? exportData.obfuscationMap) as Session['obfuscationMap'];
      const createdAt = exportData.created_at ?? exportData.createdAt;
      session.createdAt = typeof createdAt === 'string' ? createdAt : session.createdAt;
      session.status = {};
      session.currentStream = undefined;
      session.summarizationPending = false;
      session.canSummarize = false;

      const num = (v: unknown, def = 0): number => (typeof v === 'number' ? v : def);
      session.inputTokens = num(exportData.input_tokens ?? exportData.inputTokens);
      session.outputTokens = num(exportData.output_tokens ?? exportData.outputTokens);
      session.totalTokens = num(exportData.total_tokens ?? exportData.totalTokens);
      session.cacheReadTokens = num(exportData.cache_read_tokens ?? exportData.cacheReadTokens);
      session.cacheWriteTokens = num(exportData.cache_write_tokens ?? exportData.cacheWriteTokens);
      session.reasoningTokens = num(exportData.reasoning_tokens ?? exportData.reasoningTokens);
      session.inputCost = num(exportData.input_cost ?? exportData.inputCost);
      session.outputCost = num(exportData.output_cost ?? exportData.outputCost);
      session.cacheReadCost = num(exportData.cache_read_cost ?? exportData.cacheReadCost);
      session.cacheWriteCost = num(exportData.cache_write_cost ?? exportData.cacheWriteCost);

      await localSessionManager.saveSession(session);
      sessionsImported++;
      logger(`  сессия: ${session.title || session.id}`);
    }
  }

  let filesDownloaded = 0;
  if (includeFiles) {
    const files = await remoteWalk(remoteClient, remoteProjectId, '', []);
    for (const rel of files) {
      const res = await remoteClient.fsDownload({ projectId: remoteProjectId, path: rel });
      const buf = Buffer.from(await res.arrayBuffer());
      const abs = join(workspaceAbs, rel);
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, buf);
      filesDownloaded++;
      if (filesDownloaded % 50 === 0) logger(`  файлов скачано: ${filesDownloaded}`);
    }
  }

  return { projectId: localProject.id, sessionsImported, filesUploaded: 0, filesDownloaded, created: true };
}
