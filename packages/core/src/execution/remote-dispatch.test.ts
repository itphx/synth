/**
 * Фаза 1 матрицы ADR-077: в remote-режиме агентские команды уходят
 * **исполнителю**, а не выполняются локально в control plane.
 *
 * Матрица фазы 1: `execute_shell` / `grep_files` / `python` (python — через
 * `execute_shell`, отдельного тула в ядре нет).
 *
 * ## Как доказывается маршрутизация
 *
 * Три независимых доказательства (каждое — самодостаточно):
 *
 * 1. **Containment-контраст.** Один и тот же вызов с `cwd` **вне** workspace
 *    исполнителя: inline-порт выполняет команду, удалённый — отказывает
 *    (`EWORKSPACE`). Значит, в remote-режиме команда ушла к исполнителю
 *    (локально такой отказ невозможен).
 * 2. **Эффект в окружении исполнителя.** Команда создаёт файл — он появляется
 *    в workspace исполнителя.
 * 3. **Исполнитель недоступен → локального исполнения нет.** С остановленным
 *    исполнителем те же вызовы **не выполняются локально**: команда падает с
 *    ошибкой недоступности, поиск не находит совпадения, `python` не запускается.
 *
 * Исполнитель поднимается **в процессе теста** (живой HTTP-сервер), порт —
 * настоящий удалённый порт пакета `@itphx/synth-executor` (динамический
 * `import()` по строке-константе — как драйвер хранилища).
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ToolContext } from '@itphx/synth-shared';
import { executeShellTool } from '../engine/tools/shell.js';
import { grepFilesTool } from '../engine/tools/search.js';
import { InlineExecutionPort } from './inline-execution-port.js';
import type { ExecutionPort } from './ports/index.js';
import { isExecutorPackageAvailable } from './remote.js';

/** Пакет исполнителя (сервер). Аннотация `string` намеренная — `import()` не резолвится на этапе типов. */
const EXECUTOR_PACKAGE: string = '@itphx/synth-executor';

/** Пакет исполнителя (клиент удалённого порта) — тот же приём. */
const EXECUTOR_CLIENT_PACKAGE: string = '@itphx/synth-executor/client';

interface ExecutorServerModule {
  startExecutorServer(opts: {
    token: string;
    workspaceRoot: string;
    host?: string;
    port?: number;
    toolchain?: Record<string, string>;
  }): Promise<{ url: string; close: () => Promise<void> }>;
}

interface ExecutorClientModule {
  createRemoteExecutionPort(opts: {
    urls: string[];
    token: string;
    timeoutMs?: number;
    concurrency?: number;
    failMode?: 'fail' | 'inline-fallback';
  }): ExecutionPort;
}

const TOKEN = 'executor-matrix-token-1234567890';

/** Загрузить модуль сервера исполнителя (однократно). */
async function loadServerModule(): Promise<ExecutorServerModule> {
  return (await import(EXECUTOR_PACKAGE)) as unknown as ExecutorServerModule;
}

/** Загрузить модуль клиента удалённого порта (однократно). */
async function loadClientModule(): Promise<ExecutorClientModule> {
  return (await import(EXECUTOR_CLIENT_PACKAGE)) as unknown as ExecutorClientModule;
}

/** Контекст тула с внедрённым портом исполнения. */
function makeCtx(port: ExecutionPort, workingDir: string): ToolContext {
  return { sessionId: 's1', messageId: 'm1', workingDir, extra: { executionPort: port } };
}

/**
 * Матрица — только при установленном пакете `@itphx/synth-executor`
 * (опциональная зависимость core). Без собранного пакета блоки пропускаются
 * явно (не молча) — как остальные проверки удалённого режима.
 */
const EXECUTOR_AVAILABLE = await isExecutorPackageAvailable();

describe.skipIf(!EXECUTOR_AVAILABLE)(
  'ADR-077 фаза 1: в remote-режиме команды уходят исполнителю',
  () => {
    let workspace: string;
    /** Каталог проекта внутри workspace исполнителя — валидный `cwd`. */
    let projectDir: string;
    /** Каталог вне workspace исполнителя — `cwd`, который исполнитель не примет. */
    let outsideDir: string;
    let handle: { url: string; close: () => Promise<void> };
    let port: ExecutionPort;

    beforeAll(async () => {
      const server = await loadServerModule();
      const client = await loadClientModule();

      workspace = await realpath(await mkdtemp(join(tmpdir(), 'synth-executor-matrix-')));
      projectDir = join(workspace, 'project');
      await mkdir(projectDir, { recursive: true });
      await writeFile(join(projectDir, 'notes.txt'), 'the needle is here\n', 'utf-8');
      outsideDir = await realpath(await mkdtemp(join(tmpdir(), 'synth-executor-matrix-out-')));

      handle = await server.startExecutorServer({
        token: TOKEN,
        workspaceRoot: workspace,
        host: '127.0.0.1',
        port: 0,
        toolchain: {},
      });
      port = client.createRemoteExecutionPort({ urls: [handle.url], token: TOKEN, timeoutMs: 20_000 });
    });

    afterAll(async () => {
      await handle?.close();
      await rm(workspace, { recursive: true, force: true });
      await rm(outsideDir, { recursive: true, force: true });
    });

    it('execute_shell: тот же вызов, что inline — исполняется, а remote — отказывает (значит, ушёл к исполнителю)', async () => {
      const command = 'printf routed > marker.txt';

      // Контроль: inline-порт выполняет команду в каталоге вне workspace исполнителя.
      const inline = await executeShellTool.execute(
        { command },
        makeCtx(new InlineExecutionPort(), outsideDir),
      );
      expect(inline.isError).toBeFalsy();

      // Remote: тот же каталог вне workspace исполнителя → containment-отказ.
      const remote = await executeShellTool.execute({ command }, makeCtx(port, outsideDir));
      expect(remote.isError).toBe(true);
      expect(remote.metadata?.exitCode).toBe('EWORKSPACE');
    });

    it('execute_shell: эффект команды появляется в окружении исполнителя', async () => {
      const result = await executeShellTool.execute(
        { command: 'printf routed > marker.txt && pwd' },
        makeCtx(port, projectDir),
      );

      expect(result.isError).toBeFalsy();
      expect(result.content).toContain(await realpath(projectDir));
      // Файл создан исполнителем — в его workspace, а не в локальном каталоге тула.
      expect(await readFile(join(projectDir, 'marker.txt'), 'utf-8')).toBe('routed');
    });

    it('grep_files: поиск исполняется исполнителем (совпадения найдены)', async () => {
      const result = await grepFilesTool.execute({ pattern: 'needle' }, makeCtx(port, projectDir));

      expect(result.isError).toBeFalsy();
      expect(result.content).toContain('needle');
      expect(result.metadata?.matches).toBe(1);
    });

    it('python: команда через execute_shell исполняется исполнителем', async () => {
      const result = await executeShellTool.execute(
        { command: 'python3 -c "print(6 * 7)"' },
        makeCtx(port, projectDir),
      );

      expect(result.isError).toBeFalsy();
      expect(result.content).toContain('42');
    });
  },
);

describe.skipIf(!EXECUTOR_AVAILABLE)(
  'ADR-077 фаза 1: без исполнителя локального исполнения нет (fail-closed)',
  () => {
    let outsideDir: string;
    let port: ExecutionPort;

    beforeAll(async () => {
      const server = await loadServerModule();
      const client = await loadClientModule();

      outsideDir = await realpath(await mkdtemp(join(tmpdir(), 'synth-executor-down-')));
      const handle = await server.startExecutorServer({
        token: TOKEN,
        workspaceRoot: outsideDir,
        host: '127.0.0.1',
        port: 0,
        toolchain: {},
      });
      port = client.createRemoteExecutionPort({ urls: [handle.url], token: TOKEN, timeoutMs: 5_000 });
      // Исполнитель остановлен — порт остаётся, но адрес недоступен.
      await handle.close();
    });

    afterAll(async () => {
      await rm(outsideDir, { recursive: true, force: true });
    });

    it('execute_shell: команда НЕ выполняется локально (исполнитель недоступен)', async () => {
      const result = await executeShellTool.execute(
        { command: 'printf local-fallback > local-marker.txt' },
        makeCtx(port, outsideDir),
      );

      expect(result.isError).toBe(true);
      // Локального исполнения не было — файл в локальном каталоге не создан.
      await expect(readFile(join(outsideDir, 'local-marker.txt'), 'utf-8')).rejects.toThrow();
    });

    it('grep_files: поиск НЕ выполняется локально (исполнитель недоступен)', async () => {
      await writeFile(join(outsideDir, 'local.txt'), 'the needle is here\n', 'utf-8');
      const result = await grepFilesTool.execute({ pattern: 'needle' }, makeCtx(port, outsideDir));

      expect(result.isError).toBe(true);
      expect(result.content).not.toContain('the needle is here');
    });

    it('python: команда НЕ выполняется локально (исполнитель недоступен)', async () => {
      const result = await executeShellTool.execute(
        { command: 'python3 -c "print(6 * 7)"' },
        makeCtx(port, outsideDir),
      );

      expect(result.isError).toBe(true);
      expect(result.content).not.toContain('42');
    });
  },
);
