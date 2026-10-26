/**
 * Этап 1 roadmap 0.13 (блок 17): тесты встроенных тулов реестра фоновых
 * прогонов (`engine/tools/processes.ts`).
 *
 * Контекст — по образцу `schedules.test.ts`: настоящий `SessionManager` +
 * `FileStore` (сессия и её дети — для скоупа «своя сессия + дочерние»),
 * memory-порт реестра фоновых прогонов (`MemoryBackgroundRunRepository`) и
 * файловый `FileBlobStore` (логи фоновых процессов). Проверяются тулы, а не
 * хранилище: реестр и логи — настоящие, порт исполнения не нужен (лог
 * пишется напрямую в blob-хранилище).
 *
 * Что проверяется:
 * - `process_list` — пустой реестр, список прогонов (строки `key=value`),
 *   фильтры `status`/`kind`, `limit`, скоуп (чужой прогон не виден, прогон
 *   дочерней сессии виден), отсутствие `backgroundService`;
 * - `process_logs` — чтение лога из blob-хранилища (`offset`/`limit`/
 *   `truncated`), единый отказ «не найден» (неизвестный id и чужой прогон),
 *   прогон-саб-агент (summary + id дочерней сессии, без лога), отсутствие
 *   `processService`;
 * - permission-слой: `process_list`/`process_logs` разрешены в plan-режиме,
 *   группа `process` отключаема админом.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ToolContext } from '@itphx/synth-shared';
import { generateId } from '@itphx/synth-shared';
import { processListTool, processLogsTool } from './processes.js';
import { SessionManager } from '../../sessions/manager.js';
import { FileStore } from '../../storage/file-store.js';
import { MemoryBackgroundRunRepository } from '../../storage/memory/background-runs.js';
import { FileBlobStore } from '../../storage/file-blob-store.js';
import { EventBus } from '../../events/bus.js';
import { BackgroundRunService } from '../background/service.js';
import { ProcessService } from '../processes/service.js';
import type { ExecutionPort } from '../../execution/ports/index.js';
import { isPlanBlockedTool } from '../permission/evaluator.js';
import { getToolGroups } from '../permission/groups.js';

describe('Встроенные тулы реестра фоновых прогонов (processes.ts)', () => {
  let tmpDir: string;
  let sessionManager: SessionManager;
  let repository: MemoryBackgroundRunRepository;
  let background: BackgroundRunService;
  let processService: ProcessService;
  let blobs: FileBlobStore;
  let sessionId: string;
  let childSessionId: string;

  /** Порт исполнения — для чтения лога он не нужен (заглушка). */
  const unusedExecutionPort = {
    execute: async () => ({
      stdout: '',
      stderr: '',
      exitCode: 0,
      truncated: false,
      durationMs: 0,
    }),
  } as unknown as ExecutionPort;

  function makeCtx(extra: Record<string, unknown> = {}): ToolContext {
    return {
      sessionId,
      messageId: generateId(),
      abortSignal: new AbortController().signal,
      workingDir: tmpDir,
      extra: {
        backgroundService: background,
        processService,
        sessionManager,
        ...extra,
      },
    };
  }

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-process-tools-'));
    sessionManager = new SessionManager(new FileStore({ dataDir: tmpDir }));
    repository = new MemoryBackgroundRunRepository();
    background = new BackgroundRunService({
      repository,
      eventBus: new EventBus(),
      limits: {
        maxSubagentsPerSession: 0,
        maxProcessesPerSession: 0,
        maxRunsPerSession: 0,
      },
    });
    blobs = new FileBlobStore({ root: join(tmpDir, 'blobs') });
    processService = new ProcessService({
      executionPort: unusedExecutionPort,
      background,
      blobs,
      eventBus: new EventBus(),
      limits: { maxLogBytes: 0 },
    });

    const parent = await sessionManager.createSession({ title: 'Parent' });
    sessionId = parent.id;
    const child = await sessionManager.createSession({ title: 'Child', parentId: sessionId });
    childSessionId = child.id;
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  describe('process_list', () => {
    it('пустой реестр → process.tool.empty, metadata.runs = []', async () => {
      const result = await processListTool.execute({}, makeCtx());

      expect(result.isError).toBeUndefined();
      expect(result.content).toBe('No background runs');
      expect(result.metadata?.count).toBe(0);
      expect(result.metadata?.runs).toEqual([]);
    });

    it('два прогона (процесс завершён, саб-агент идёт) — оба видны, строки key=value', async () => {
      const process = await background.startProcess({
        sessionId,
        command: 'npm test',
        cwd: tmpDir,
      });
      await background.finish(process.id, { status: 'completed', exitCode: 0 });

      const subagent = await background.startSubagent({
        sessionId,
        childSessionId: childSessionId,
        agentRole: 'explore',
        description: 'разобрать репозиторий',
      });

      const result = await processListTool.execute({}, makeCtx());

      expect(result.isError).toBeUndefined();
      expect(result.metadata?.count).toBe(2);
      const runs = result.metadata?.runs as Array<{ id: string; status: string; kind: string }>;
      expect(runs.map((r) => r.id).sort()).toEqual([process.id, subagent.id].sort());

      // Строки — машиночитаемые `key=value`.
      expect(result.content).toContain(`- ${process.id}`);
      expect(result.content).toContain('kind=process');
      expect(result.content).toContain('status=completed');
      expect(result.content).toContain('cmd=npm test');
      expect(result.content).toContain(`- ${subagent.id}`);
      expect(result.content).toContain('kind=subagent');
      expect(result.content).toContain('status=running');
      expect(result.content).toContain('cmd=разобрать репозиторий');
    });

    it('фильтры status/kind и limit отсекают лишнее', async () => {
      const completed = await background.startProcess({
        sessionId,
        command: 'done-cmd',
        cwd: tmpDir,
      });
      await background.finish(completed.id, { status: 'completed', exitCode: 0 });
      const running = await background.startProcess({
        sessionId,
        command: 'run-cmd',
        cwd: tmpDir,
      });
      await background.startSubagent({
        sessionId,
        childSessionId: childSessionId,
        description: 'сабагент',
      });

      const byStatus = await processListTool.execute({ status: 'completed' }, makeCtx());
      expect(byStatus.metadata?.count).toBe(1);
      expect(byStatus.content).toContain('cmd=done-cmd');
      expect(byStatus.content).not.toContain('cmd=run-cmd');
      expect(byStatus.content).not.toContain(running.id);

      const byKind = await processListTool.execute({ kind: 'subagent' }, makeCtx());
      expect(byKind.metadata?.count).toBe(1);
      expect(byKind.content).toContain('kind=subagent');
      expect(byKind.content).not.toContain('kind=process');

      const limited = await processListTool.execute({ limit: 1 }, makeCtx());
      expect(limited.metadata?.count).toBe(1);
    });

    it('скоуп: прогон чужой сессии не виден, прогон дочерней сессии виден', async () => {
      const foreign = await background.startProcess({
        sessionId: 'session-of-another-user',
        command: 'foreign-cmd',
        cwd: tmpDir,
      });
      const inChild = await background.startProcess({
        sessionId: childSessionId,
        command: 'child-cmd',
        cwd: tmpDir,
      });

      const result = await processListTool.execute({}, makeCtx());

      expect(result.metadata?.count).toBe(1);
      expect(result.content).toContain('cmd=child-cmd');
      expect(result.content).not.toContain('cmd=foreign-cmd');
      expect(result.content).not.toContain(foreign.id);
      expect(result.content).toContain(inChild.id);
    });

    it('без backgroundService → ошибка process.tool.deps_unavailable', async () => {
      const result = await processListTool.execute({}, makeCtx({ backgroundService: undefined }));

      expect(result.isError).toBe(true);
      expect(result.content).toBe('The background run registry is unavailable in this build');
      expect(result.metadata?.i18n).toMatchObject({ key: 'process.tool.deps_unavailable' });
    });
  });

  describe('process_logs', () => {
    it('лог фонового процесса: содержимое, offset/limit, truncated', async () => {
      const record = await background.startProcess({
        sessionId,
        command: 'npm test',
        cwd: tmpDir,
      });
      await blobs.write(record.logPath!, 'первая строка\nвторая строка\nтретья строка\n');
      await background.finish(record.id, {
        status: 'completed',
        exitCode: 0,
        metadata: { truncated: true },
      });

      const full = await processLogsTool.execute({ process_id: record.id }, makeCtx());
      expect(full.isError).toBeUndefined();
      expect(full.content).toContain('первая строка');
      expect(full.content).toContain('третья строка');
      expect(full.metadata?.run_id).toBe(record.id);
      expect(full.metadata?.kind).toBe('process');
      expect(full.metadata?.total_bytes).toBeGreaterThan(0);
      expect(full.metadata?.truncated).toBe(true);

      // Отрезок лога: offset/limit в байтах.
      const slice = await processLogsTool.execute(
        { process_id: record.id, offset: 12, limit: 6 },
        makeCtx(),
      );
      expect(slice.isError).toBeUndefined();
      expect(slice.metadata?.next_offset).toBe(18);
      expect(slice.metadata?.total_bytes).toBe(full.metadata?.total_bytes);
      expect(slice.content).toContain('total_bytes=');
    });

    it('неизвестный id и чужой прогон — одинаковый отказ process.tool.not_found', async () => {
      const unknown = await processLogsTool.execute({ process_id: 'bgr_unknown' }, makeCtx());
      expect(unknown.isError).toBe(true);
      expect(unknown.content).toBe('Background run "bgr_unknown" not found');

      const foreign = await background.startProcess({
        sessionId: 'session-of-another-user',
        command: 'foreign-cmd',
        cwd: tmpDir,
      });
      const foreignResult = await processLogsTool.execute(
        { process_id: foreign.id },
        makeCtx(),
      );
      expect(foreignResult.isError).toBe(true);
      // Тот же текст: существование чужого прогона не раскрывается.
      expect(foreignResult.content.replace(foreign.id, 'bgr_unknown')).toBe(
        unknown.content,
      );
      expect(foreignResult.metadata?.i18n).toMatchObject({ key: 'process.tool.not_found' });
    });

    it('прогон-саб-агент: summary и child_session_id, лога нет', async () => {
      const record = await background.startSubagent({
        sessionId,
        childSessionId: childSessionId,
        agentRole: 'explore',
        description: 'разобрать репозиторий',
      });
      await background.finish(record.id, { status: 'completed', summary: 'Итог работы' });

      const result = await processLogsTool.execute({ process_id: record.id }, makeCtx());

      expect(result.isError).toBeUndefined();
      expect(result.content).toContain('There is no log for this background run');
      expect(result.content).toContain('Итог работы');
      expect(result.content).toContain(childSessionId);
      expect(result.metadata?.kind).toBe('subagent');
      expect(result.metadata?.child_session_id).toBe(childSessionId);
      expect(result.metadata?.run_id).toBe(record.id);
    });

    it('без processService → ошибка process.tool.deps_unavailable', async () => {
      const record = await background.startProcess({
        sessionId,
        command: 'npm test',
        cwd: tmpDir,
      });

      const result = await processLogsTool.execute(
        { process_id: record.id },
        makeCtx({ processService: undefined }),
      );

      expect(result.isError).toBe(true);
      expect(result.content).toBe('The background run registry is unavailable in this build');
      expect(result.metadata?.i18n).toMatchObject({ key: 'process.tool.deps_unavailable' });
    });
  });

  describe('permissions', () => {
    it('process_list/process_logs разрешены в plan-режиме', () => {
      expect(isPlanBlockedTool('process_list', processListTool.capabilities)).toBe(false);
      expect(isPlanBlockedTool('process_logs', processLogsTool.capabilities)).toBe(false);
    });

    it('группа process отключаема админом (тулы попадают в неё по capability)', () => {
      expect(getToolGroups('process_list', processListTool.capabilities)).toContain('process');
      expect(getToolGroups('process_logs', processLogsTool.capabilities)).toContain('process');
    });
  });
});
