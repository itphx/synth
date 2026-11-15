/**
 * PROP-132 (Ф3в): композиция сервиса терминалов — один экземпляр на процесс,
 * мастер-выключатель на старте и остановка на graceful shutdown.
 *
 * Проверяем:
 * - `deps.terminalService` — **тот же** экземпляр, что у роутов
 *   `/api/v2/terminals*` и `/api/v2/settings/terminal` (собирается в `deps.ts`,
 *   а не в `mount-routes.ts`);
 * - runtime-override `terminal.enabled` применяется **на старте** процесса
 *   (env > runtime > config > default);
 * - `deps.stopTerminalService()` гасит сервис: живые PTY закрываются, а
 *   создание нового терминала после остановки — отказ (`disposed`).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExecutionPort, PtyHandle } from '../../execution/ports/index.js';
import { TerminalUnavailableError } from '../../engine/terminal/types.js';
import { createTerminalService } from './terminal-service.js';
import { createStandaloneDeps, createStandaloneStorage } from './deps.js';
import type { StandaloneConfig } from '../app.js';

const dirs: string[] = [];

afterEach(async () => {
  while (dirs.length > 0) {
    const dir = dirs.pop()!;
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

async function makeDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'synth-core-deps-terminal-'));
  dirs.push(dir);
  return dir;
}

const ACCESSORS = {
  getActiveRemoteProviderNames: () => new Set<string>(),
  isBlockLocalProviders: () => false,
};

/** Мок порта исполнения с PTY: считает закрытия хэндлов. */
function createFakePort(): { port: ExecutionPort; state: { closed: number } } {
  const state = { closed: 0 };
  const handle: PtyHandle = {
    id: 'pty_test',
    write: () => {},
    resize: () => {},
    onData: () => () => {},
    onExit: () => () => {},
    close: async () => {
      state.closed += 1;
    },
  };
  const port = {
    isRemote: false,
    pty: true,
    execute: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
    openPty: async () => handle,
  } as unknown as ExecutionPort;
  return { port, state };
}

describe('createTerminalService (композиция)', () => {
  it('dispose() закрывает живые терминалы', async () => {
    const { port, state } = createFakePort();
    const service = createTerminalService({ port });

    const terminal = await service.create({
      projectId: 'proj_1',
      ownerId: 'local',
      cwd: await makeDir(),
      cols: 80,
      rows: 24,
    });
    expect(terminal.status).toBe('running');
    expect(state.closed).toBe(0);

    service.dispose();
    expect(state.closed).toBe(1);
    // После остановки сервис не принимает новых терминалов.
    await expect(
      service.create({ projectId: 'proj_1', ownerId: 'local', cwd: await makeDir(), cols: 80, rows: 24 }),
    ).rejects.toBeInstanceOf(TerminalUnavailableError);
  });

  it('параметры выполнения из wiring применяются к сервису', async () => {
    const { port } = createFakePort();
    const service = createTerminalService({
      port,
      defaultShell: '/bin/zsh',
      auditInput: false,
    });
    expect(service.getDefaultShell()).toBe('/bin/zsh');
    expect(service.isAuditInput()).toBe(false);
    service.dispose();
  });

  it('setEnabled(false) закрывает живые терминалы и запрещает новые', async () => {    const { port, state } = createFakePort();
    const service = createTerminalService({ port });
    expect(service.isEnabled()).toBe(true);

    await service.create({
      projectId: 'proj_1',
      ownerId: 'local',
      cwd: await makeDir(),
      cols: 80,
      rows: 24,
    });
    service.setEnabled(false);

    expect(service.isEnabled()).toBe(false);
    expect(state.closed).toBe(1);
    await expect(
      service.create({ projectId: 'proj_1', ownerId: 'local', cwd: await makeDir(), cols: 80, rows: 24 }),
    ).rejects.toMatchObject({ code: 'TERMINAL_DISABLED' });
  });
});

describe('createStandaloneDeps: сервис терминалов (Ф3в)', () => {
  it('сервис один на процесс; runtime-override применяется на старте; stop гасит его', async () => {
    const dataDir = await makeDir();
    const config: StandaloneConfig = {
      port: 0,
      dataDir,
      apiKey: 'test-key',
      storageBackend: 'memory',
    };

    const storage = await createStandaloneStorage(config);
    // Runtime-override в `settings.json`/PG — выключатель терминалов.
    await storage.settings.setTerminal({ enabled: false });

    const deps = await createStandaloneDeps(config, ACCESSORS, storage);
    try {
      // Один экземпляр на процесс — его же получают роуты терминалов и
      // настроек (`deps.terminalService`).
      expect(deps.terminalService).toBeDefined();
      expect(deps.terminalService.isEnabled()).toBe(false);

      // `stopTerminalService()` гасит **этот же** экземпляр.
      deps.stopTerminalService();
      await expect(
        deps.terminalService.create({
          projectId: 'proj_1',
          ownerId: 'local',
          cwd: dataDir,
          cols: 80,
          rows: 24,
        }),
      ).rejects.toBeInstanceOf(TerminalUnavailableError);
    } finally {
      deps.stopEphemeralSweeper();
      deps.stopEventJournalPruner();
      deps.stopWebhookDeliveryPruner();
    }
  });

  it('по умолчанию терминалы включены (default=true)', async () => {
    const dataDir = await makeDir();
    const config: StandaloneConfig = {
      port: 0,
      dataDir,
      apiKey: 'test-key',
      storageBackend: 'memory',
    };

    const storage = await createStandaloneStorage(config);
    const deps = await createStandaloneDeps(config, ACCESSORS, storage);
    try {
      expect(deps.terminalService.isEnabled()).toBe(true);
    } finally {
      deps.stopTerminalService();
      deps.stopEphemeralSweeper();
      deps.stopEventJournalPruner();
      deps.stopWebhookDeliveryPruner();
    }
  });
});
