/**
 * Контрактный suite порта исполнения — прогон против **удалённого исполнителя**
 * (ADR-077, шаг 7b).
 *
 * Эталон контракта живёт в core (`execution/contract/execution.ts`) — как
 * контракт портов слоя хранения; прогон против драйвера БД тоже в core
 * (`storage/contract/postgres.test.ts`). Дублировать набор проверок в пакете
 * исполнителя нельзя: источник истины один, иначе remote/inline разойдутся
 * по набору проверок.
 *
 * Исполнитель поднимается **в процессе теста** (живой HTTP-сервер на
 * 127.0.0.1), команда уходит по wire-протоколу и возвращается ответом
 * исполнителя — то есть проверяется ровно тот путь, что в бою.
 *
 * Пакет исполнителя тянется **динамическим** `import()` по строке-константе
 * (как драйвер хранилища): core не должен зависеть от `dist` исполнителя на
 * этапе типов.
 *
 * Отличие remote-режима, которого нет у inline: **containment `cwd`** —
 * каталог вне workspace исполнителя → отказ (`EWORKSPACE`). Эта проверка
 * вынесена в отдельный блок «только remote»
 * (`describeRemoteOnlyExecutionChecks`).
 */

import { afterAll, beforeAll, describe } from 'vitest';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExecutionPort } from '../ports/index.js';
import { isExecutorPackageAvailable } from '../remote.js';
import { describeExecutionPort, describeRemoteOnlyExecutionChecks } from './index.js';

/** Пакет исполнителя (сервер). Аннотация `string` намеренная — `import()` не резолвится на этапе типов. */
const EXECUTOR_PACKAGE: string = '@itphx/synth-executor';

/** Пакет исполнителя (клиент удалённого порта) — тот же приём. */
const EXECUTOR_CLIENT_PACKAGE: string = '@itphx/synth-executor/client';

/** Локальная форма модуля пакета (типы пакета не резолвятся статически). */
interface ExecutorServerModule {
  startExecutorServer(opts: {
    token: string;
    workspaceRoot: string;
    host?: string;
    port?: number;
    toolchain?: Record<string, string>;
  }): Promise<{ url: string; close: () => Promise<void> }>;
}

/** Локальная форма модуля клиента. */
interface ExecutorClientModule {
  createRemoteExecutionPort(opts: {
    urls: string[];
    token: string;
    timeoutMs?: number;
    concurrency?: number;
    failMode?: 'fail' | 'inline-fallback';
  }): ExecutionPort;
}

const TOKEN = 'executor-contract-token-1234567890';

let serverModule: ExecutorServerModule | undefined;
let clientModule: ExecutorClientModule | undefined;

/** Загрузить модуль сервера исполнителя (однократно). */
async function loadServerModule(): Promise<ExecutorServerModule> {
  serverModule ??= (await import(EXECUTOR_PACKAGE)) as unknown as ExecutorServerModule;
  return serverModule;
}

/** Загрузить модуль клиента удалённого порта (однократно). */
async function loadClientModule(): Promise<ExecutorClientModule> {
  clientModule ??= (await import(EXECUTOR_CLIENT_PACKAGE)) as unknown as ExecutorClientModule;
  return clientModule;
}

/** Корень workspace исполнителя (граница containment'а `cwd`). */
let workspace: string;
/** Каталог внутри workspace — валидный `cwd` для удалённого порта. */
let cwd: string;
/** Каталог вне workspace — проверка containment'а. */
let cwdOutside: string;

let handle: { url: string; close: () => Promise<void> };
let port: ExecutionPort;

/**
 * Контракт против удалённого исполнителя — только при установленном пакете
 * `@itphx/synth-executor` (опциональная зависимость core). Без собранного
 * пакета блок пропускается явно (не молча) — как остальные проверки
 * удалённого режима (`execution/remote.test.ts`, `execution/startup.test.ts`).
 */
describe.skipIf(!(await isExecutorPackageAvailable()))(
  'RemoteExecutionPort → ExecutionPort',
  () => {
    beforeAll(async () => {
      const mod = await loadServerModule();
      workspace = await realpath(await mkdtemp(join(tmpdir(), 'synth-executor-remote-')));
      cwd = join(workspace, 'contract-cwd');
      await mkdir(cwd, { recursive: true });
      cwdOutside = await realpath(await mkdtemp(join(tmpdir(), 'synth-executor-outside-')));

      handle = await mod.startExecutorServer({
        token: TOKEN,
        workspaceRoot: workspace,
        host: '127.0.0.1',
        port: 0,
        // Состав toolchain'а задан явно — без пробы бинарников при старте.
        toolchain: {},
      });

      const client = await loadClientModule();
      port = client.createRemoteExecutionPort({
        urls: [handle.url],
        token: TOKEN,
        timeoutMs: 20_000,
      });
    });

    afterAll(async () => {
      await handle?.close();
      await rm(workspace, { recursive: true, force: true });
      await rm(cwdOutside, { recursive: true, force: true });
    });

    const harness = async () => ({ port, cwd, cwdOutside });

    describeExecutionPort('RemoteExecutionPort → ExecutionPort', harness);
    describeRemoteOnlyExecutionChecks('RemoteExecutionPort → ExecutionPort', harness);
  },
);
