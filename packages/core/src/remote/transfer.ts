// Операции переноса проектов между мирами (гибридный режим, часть 8):
//   publish — локальный проект → удалённый backend (проект + сессии + файлы);
//   fork    — удалённый проект → локальный мир (проект + сессии + файлы).
// Файлы переносятся прямой синхронизацией (не git): текстовые — через fsWrite,
// бинарные — через fsUpload (publish) / fsDownload (fork).

import { readdir, readFile, stat, mkdir, writeFile } from 'node:fs/promises';
import { join, dirname, basename, isAbsolute, normalize, resolve } from 'node:path';
import { slugifyWorkspaceName, normalizeIconKey, normalizeColorKey } from '@itphx/synth-shared';
import type { Project, Session, Message, SessionSettings } from '@itphx/synth-shared';
import type { DirectoryListResult } from '@itphx/synth-shared';
import type { ProjectStore } from '../storage/project-store.js';
import type { SessionManager } from '../sessions/manager.js';
import type { RemoteBackendClient } from './client.js';

/** Каталоги, исключаемые из прямой синхронизации файлов. */
export const EXCLUDED_DIRS = new Set(['node_modules', '.git', '.synth']);

/**
 * Преобразовать имя проекта в безопасное относительное имя workspace.
 * ADR-075: единая реализация — `slugifyWorkspaceName` (shared); имя сохранено
 * для обратной совместимости публичного экспорта `remote/index.ts`.
 */
export const slugify = slugifyWorkspaceName;

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

/** Минимальная форма сессии для анализа ссылок (Session или экспорт с camelCase). */
interface SessionRefsShape {
  id: string;
  parentId?: string;
  references?: Array<{ sessionId?: string | null }>;
  messages?: Array<{ parts?: Array<{ type?: string; data?: unknown }> }>;
}

/** Идентификаторы сессий, на которые ссылается сессия: parentId, references[].sessionId, session_reference-части сообщений. */
function collectReferencedSessionIds(session: SessionRefsShape): string[] {
  const out = new Set<string>();
  if (typeof session.parentId === 'string' && session.parentId) out.add(session.parentId);
  for (const ref of session.references ?? []) {
    if (typeof ref.sessionId === 'string' && ref.sessionId) out.add(ref.sessionId);
  }
  for (const m of session.messages ?? []) {
    for (const p of m.parts ?? []) {
      if (p.type !== 'session_reference' || !p.data || typeof p.data !== 'object') continue;
      const d = p.data as Record<string, unknown>;
      const sid = d.sessionId ?? d.session_id;
      if (typeof sid === 'string' && sid) out.add(sid);
    }
  }
  return [...out];
}

/**
 * Упорядочить сессии так, чтобы зависимости (parentId/references) импортировались
 * раньше ссылающихся на них. Нужно для publish/fork: remote-id создаётся в момент
 * импорта, поэтому к моменту переноса дочерней сессии mapping родителя уже известен.
 * Циклы (взаимные ссылки) добавляются в исходном порядке — их ссылки останутся локальными.
 */
function orderSessionsForTransfer<T extends SessionRefsShape>(sessions: T[]): T[] {
  if (sessions.length <= 1) return sessions;
  const byId = new Map(sessions.map((s) => [s.id, s]));
  const localIds = new Set(byId.keys());
  const deps = new Map<string, string[]>();
  const dependents = new Map<string, string[]>();
  for (const s of sessions) {
    const refs = collectReferencedSessionIds(s).filter((id) => localIds.has(id) && id !== s.id);
    deps.set(s.id, refs);
    for (const dep of refs) {
      const arr = dependents.get(dep) ?? [];
      arr.push(s.id);
      dependents.set(dep, arr);
    }
  }
  const indegree = new Map<string, number>();
  for (const s of sessions) indegree.set(s.id, (deps.get(s.id) ?? []).length);
  const originalIndex = new Map(sessions.map((s, i) => [s.id, i]));
  const queue = sessions.filter((s) => (indegree.get(s.id) ?? 0) === 0).map((s) => s.id);
  const order: string[] = [];
  while (queue.length > 0) {
    // Стабильный порядок: в рамках уровня — по исходному индексу.
    queue.sort((a, b) => (originalIndex.get(a) ?? 0) - (originalIndex.get(b) ?? 0));
    const id = queue.shift()!;
    order.push(id);
    for (const dependent of dependents.get(id) ?? []) {
      const deg = (indegree.get(dependent) ?? 0) - 1;
      indegree.set(dependent, deg);
      if (deg === 0) queue.push(dependent);
    }
  }
  if (order.length < sessions.length) {
    for (const s of sessions) if (!order.includes(s.id)) order.push(s.id);
  }
  return order.map((id) => byId.get(id)!);
}

/** Переписать sessionId в session_reference-части сообщения по mapping (не перенесено → null). */
function rewriteReferencePart(p: unknown, mapping: Map<string, string>): Record<string, unknown> {
  if (!p || typeof p !== 'object') return p as Record<string, unknown>;
  const part = p as Record<string, unknown>;
  if (part.type !== 'session_reference' || !part.data || typeof part.data !== 'object') return part;
  const d = { ...(part.data as Record<string, unknown>) };
  const sid = d.sessionId ?? d.session_id;
  if (typeof sid === 'string') {
    d.sessionId = mapping.get(sid) ?? null;
    delete d.session_id;
  }
  return { ...part, data: d };
}

/**
 * Переписать ссылки экспорта сессии при publish: parentId/references[].sessionId
 * и session_reference-части сообщений получают новые remote-id из mapping.
 * Ссылки на сессии вне переносимого набора зануляются (иначе битые ссылки на
 * несуществующие id). sourceMsgId валиден только если сообщение есть в переносимом
 * наборе (id сообщений при импорте сохраняются) — иначе зануляется.
 */
function rewriteSessionExportForRemote(
  session: Session,
  mapping: Map<string, string>,
  transferredMessageIds: Set<string>,
): Record<string, unknown> {
  const out = buildSessionExport(session) as Record<string, unknown>;

  if (typeof out.parentId === 'string') {
    out.parentId = mapping.get(out.parentId) ?? null;
  }

  if (Array.isArray(out.references)) {
    out.references = out.references.map((ref) => {
      if (ref && typeof ref === 'object') {
        const r = { ...(ref as Record<string, unknown>) };
        if (typeof r.sessionId === 'string') r.sessionId = mapping.get(r.sessionId) ?? null;
        return r;
      }
      return ref;
    });
  }

  if (Array.isArray(out.messages)) {
    out.messages = out.messages.map((m) => {
      const mm = { ...(m as Record<string, unknown>) };
      if (typeof mm.sourceMsgId === 'string' && !transferredMessageIds.has(mm.sourceMsgId)) {
        mm.sourceMsgId = null;
      }
      if (Array.isArray(mm.parts)) {
        mm.parts = (mm.parts as Array<Record<string, unknown>>).map((p) => rewriteReferencePart(p, mapping));
      }
      return mm;
    });
  }

  return out;
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
      ...(localProject.plan ? { plan: localProject.plan } : {}),
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
      ...(localProject.plan ? { plan: localProject.plan } : {}),
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
    // Mapping локальный id → remote id: remote-id создаётся в момент импорта,
    // поэтому сессии переносим в топологическом порядке (зависимости раньше) и
    // переписываем parentId/references уже известными remote-id.
    const mapping = new Map<string, string>();
    const transferredMessageIds = new Set<string>();
    for (const s of localSessions) {
      for (const m of s.messages ?? []) transferredMessageIds.add(m.id);
    }
    const ordered = orderSessionsForTransfer(localSessions);

    for (const s of ordered) {
      const exportBody = rewriteSessionExportForRemote(s, mapping, transferredMessageIds);
      const created = (await remoteClient.importSession({
        ...exportBody,
        import: { project_id: targetProjectId },
      })) as Record<string, unknown> | null;
      const remoteId = String(created?.id ?? '');
      if (remoteId) {
        mapping.set(s.id, remoteId);
      } else {
        logger(`  сессия ${s.title || s.id}: не получен remote-id — ссылки на неё будут занулены`);
      }
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
    icon: normalizeIconKey(remote.icon),
    color: normalizeColorKey(remote.color),
    workspace: workspaceRel,
    repos: Array.isArray(remote.repos) ? (remote.repos as Project['repos']) : undefined,
  });
  // Переносим контентные поля проекта: план (ADR-039), лог, инварианты, текущую задачу.
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

    // Сначала экспортируем ВСЕ сессии: нужны их ссылки для упорядочивания (remote-id
    // локальных сессий создаётся в момент createSession) и набор message-id для sourceMsgId.
    const exports = new Map<string, Record<string, unknown>>();
    for (const rs of sessionsForProject) {
      const id = String(rs.id ?? '');
      exports.set(id, (await remoteClient.exportSession(id)) as Record<string, unknown>);
    }

    const remoteShapes: SessionRefsShape[] = sessionsForProject.map((rs) => {
      const id = String(rs.id ?? '');
      const exp = exports.get(id) ?? {};
      return {
        id,
        parentId: typeof exp.parentId === 'string' ? exp.parentId : undefined,
        references: Array.isArray(exp.references)
          ? (exp.references as Array<{ sessionId?: string | null }>)
          : [],
        messages: Array.isArray(exp.messages)
          ? (exp.messages as Array<{ parts?: Array<{ type?: string; data?: unknown }> }>)
          : [],
      };
    });
    const orderedIds = orderSessionsForTransfer(remoteShapes).map((s) => s.id);

    const transferredMessageIds = new Set<string>();
    for (const exp of exports.values()) {
      for (const m of (Array.isArray(exp.messages) ? exp.messages : []) as Message[]) {
        if (typeof m.id === 'string') transferredMessageIds.add(m.id);
      }
    }

    // Mapping remote id → локальный id для переписывания parentId/references.
    const mapping = new Map<string, string>();

    for (const id of orderedIds) {
      const exportData = exports.get(id)!;

      // ADR-089: materialization (перенос истории publish/fork), не request —
      // прямой `createSession`; funnel применяется только к явному созданию.
      const session = await localSessionManager.createSession({
        title: typeof exportData.title === 'string' ? exportData.title : undefined,
        icon: normalizeIconKey(exportData.icon),
        color: normalizeColorKey(exportData.color),
        projectId: localProject.id,
        engine: typeof exportData.engine === 'string'
          ? (exportData.engine as Session['engine'])
          : undefined,
        sessionOrigin: (exportData.session_origin ?? exportData.sessionOrigin) as Session['sessionOrigin'] | undefined,
        settings: (exportData.settings ?? {}) as Partial<SessionSettings>,
      });

      // parentId: ссылка на переносимую сессию → новый локальный id; иначе убираем.
      if (typeof exportData.parentId === 'string' && exportData.parentId) {
        session.parentId = mapping.get(exportData.parentId) ?? undefined;
      }

      const messages: Message[] = Array.isArray(exportData.messages)
        ? (exportData.messages as Message[]).map((m) => ({ ...structuredClone(m), seq: 0 }))
        : [];
      messages.forEach((m, i) => { m.seq = i + 1; });
      // Переписываем ссылки в сообщениях: session_reference-части — по mapping,
      // sourceMsgId — только если сообщение есть в переносимом наборе.
      for (const m of messages) {
        if (typeof m.sourceMsgId === 'string' && !transferredMessageIds.has(m.sourceMsgId)) {
          m.sourceMsgId = undefined;
        }
        m.parts = m.parts.map((p) => rewriteReferencePart(p, mapping) as unknown as Message['parts'][number]);
      }
      session.messages = messages;
      session.pendingMessages = [];
      session.todos = (exportData.todos ?? undefined) as Session['todos'];
      session.stickyNotes = Array.isArray(exportData.sticky_notes ?? exportData.stickyNotes)
        ? ((exportData.sticky_notes ?? exportData.stickyNotes) as Session['stickyNotes'])
        : [];
      session.references = Array.isArray(exportData.references)
        ? (exportData.references as Session['references']).map((ref) => ({
            ...ref,
            sessionId: typeof ref.sessionId === 'string'
              ? (mapping.get(ref.sessionId) ?? null)
              : ref.sessionId,
          })) as unknown as Session['references']
        : [];
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

      // Локальные сессии принадлежат локальному пользователю (в standalone core — 'local'):
      // иначе их не вернёт GET /api/v2/sessions (список сессий фильтруется по userId).
      session.userId = 'local';
      session.ownerId = 'local';

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
      mapping.set(id, session.id);
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
