/**
 * Контрактный suite порта исполнения — прогон против inline-реализации
 * (ADR-077, шаг 1). Удалённая реализация прогоняет тот же набор
 * (`execution/contract/remote.test.ts`).
 *
 * Реализация inline ограничений на `cwd` не имеет (команда исполняется в
 * процессе control plane) — это закреплено отдельным блоком проверок
 * «только inline» (`describeInlineOnlyExecutionChecks`).
 */

import { afterAll, beforeAll } from 'vitest';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InlineExecutionPort } from '../inline-execution-port.js';
import { describeExecutionPort, describeInlineOnlyExecutionChecks } from './index.js';

/** Каталог для проверок `cwd` (исполнение в процессе — любой путь допустим). */
let cwd: string;
/** Каталог «вне рабочего каталога проекта» — для inline-специфичных проверок. */
let cwdOutside: string;

beforeAll(async () => {
  cwd = await realpath(await mkdtemp(join(tmpdir(), 'synth-exec-inline-cwd-')));
  cwdOutside = await realpath(await mkdtemp(join(tmpdir(), 'synth-exec-inline-out-')));
});

afterAll(async () => {
  await rm(cwd, { recursive: true, force: true });
  await rm(cwdOutside, { recursive: true, force: true });
});

const harness = async () => ({
  port: new InlineExecutionPort(),
  cwd,
  cwdOutside,
  // `sh` есть в любом POSIX-окружении — программа, доступность которой
  // проверяется пробой порта (ADR-077).
  availableBinaries: ['sh'],
});

describeExecutionPort('InlineExecutionPort → ExecutionPort', harness);
describeInlineOnlyExecutionChecks('InlineExecutionPort → ExecutionPort', harness);
