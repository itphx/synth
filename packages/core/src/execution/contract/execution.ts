/**
 * Контрактный suite порта исполнения (PROP-077, шаги 1 и 7b).
 *
 * «Паспорт» порта — по образцу портов хранения (`storage/contract/`): один
 * набор проверок на ЛЮБУЮ реализацию (`InlineExecutionPort` — в процессе,
 * удалённый порт — HTTP к исполнителю). Проверяется:
 *
 *   - разделение stdout/stderr и код завершения;
 *   - обе формы команды: shell-строка и argv без shell;
 *   - ненулевой код выхода (ошибка с кодом и частичным выводом);
 *   - `cwd` — рабочий каталог команды;
 *   - `env` — мердж с базовым окружением (окружение не заменяется целиком);
 *   - таймаут и отмена по `AbortSignal`;
 *   - лимит вывода: флаг усечения;
 *   - отсутствующий бинарник (`ENOENT`);
 *   - `durationMs` заполнен.
 *
 * ## Что различается между реализациями
 *
 * **Содержательное различие remote-режима — containment `cwd`:** у удалённого
 * исполнителя `cwd` обязан лежать внутри его workspace (иначе команда не
 * запускается вовсе — `EWORKSPACE`), а у inline-реализации такого ограничения
 * нет вовсе. Поэтому проверки `cwd` разделены:
 *
 * - общий suite — `cwd` **внутри** границ реализации (каталог даёт harness);
 * - `describeInlineOnlyExecutionChecks` — ТОЛЬКО inline: `cwd` вне рабочего
 *   каталога проекта исполняется (локального ограничения нет);
 * - `describeRemoteOnlyExecutionChecks` — ТОЛЬКО remote: `cwd` вне workspace
 *   исполнителя → отказ (containment — граница безопасности).
 *
 * Для удалённой реализации каталог из `cwd` должен быть виден исполнителю
 * (общий том workspace) — контракт это предполагает.
 */

import { describe, expect, it } from 'vitest';
import { realpath } from 'node:fs/promises';
import { ExecutionError, type ExecutionPort } from '../ports/index.js';

/**
 * Окружение реализации порта для прогона контракта.
 *
 * - `port` — сам порт;
 * - `cwd` — каталог для проверок `cwd`; обязан быть валиден для реализации
 *   (для удалённого исполнителя — внутри его workspace);
 * - `cwdOutside` — каталог **вне** границ реализации (для remote-проверок
 *   containment'а; для inline — просто каталог вне рабочего каталога проекта);
 * - `dispose` — освобождение ресурсов реализации (опционально).
 */
export interface ExecutionPortHarness {
  port: ExecutionPort;
  cwd: string;
  cwdOutside?: string;
  dispose?: () => Promise<void>;
}

/** Фабрика реализации для прогона контракта. */
export type ExecutionPortHarnessFactory = () => Promise<ExecutionPortHarness>;

/** Ошибка исполнения, снятая с промиса (для проверки полей). */
async function captureError(promise: Promise<unknown>): Promise<ExecutionError> {
  try {
    await promise;
  } catch (err) {
    return err as ExecutionError;
  }
  throw new Error('ожидалась ошибка исполнения, а вызов завершился успешно');
}

/**
 * Паспорт порта `ExecutionPort` — общий набор проверок для любой реализации.
 *
 * @param name имя реализации (для `describe`)
 * @param make фабрика реализации (+ опциональный `dispose`)
 */
export function describeExecutionPort(name: string, make: ExecutionPortHarnessFactory): void {
  describe(name, () => {
    it('shell: stdout/stderr раздельно, exitCode 0, durationMs заполнен', async () => {
      const { port } = await make();
      const res = await port.execute({
        command: { kind: 'shell', command: 'printf out; printf err 1>&2' },
      });
      expect(res.stdout).toBe('out');
      expect(res.stderr).toBe('err');
      expect(res.exitCode).toBe(0);
      expect(res.truncated).toBe(false);
      expect(res.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('argv: бинарник запускается без shell', async () => {
      const { port } = await make();
      const res = await port.execute({
        command: { kind: 'argv', file: 'sh', args: ['-c', 'printf argv'] },
      });
      expect(res.stdout).toBe('argv');
      expect(res.stderr).toBe('');
      expect(res.exitCode).toBe(0);
    });

    it('ненулевой код выхода — ошибка с кодом, stdout и stderr', async () => {
      const { port } = await make();
      const err = await captureError(
        port.execute({ command: { kind: 'shell', command: 'printf o; printf e 1>&2; exit 3' } }),
      );
      expect(err).toBeInstanceOf(ExecutionError);
      expect(err.reason).toBe('nonzero_exit');
      expect(err.code).toBe(3);
      expect(err.stdout).toBe('o');
      expect(err.stderr).toBe('e');
    });

    it('cwd — команда выполняется в указанном каталоге', async () => {
      const { port, cwd } = await make();
      const res = await port.execute({ command: { kind: 'shell', command: 'pwd' }, cwd });
      expect(res.stdout.trim()).toBe(await realpath(cwd));
    });

    it('env — переменные запроса видны процессу, базовое окружение наследуется', async () => {
      const { port } = await make();
      const res = await port.execute({
        command: { kind: 'shell', command: 'printf "%s|%s" "$SYNTH_EXEC_CONTRACT_VAR" "$PATH"' },
        env: { SYNTH_EXEC_CONTRACT_VAR: 'contract' },
      });
      const [value = '', path = ''] = res.stdout.split('|');
      expect(value).toBe('contract');
      // Базовое окружение не заменено запросом (PATH остался на месте).
      expect(path.length).toBeGreaterThan(0);
    });

    it('таймаут — ошибка (процесс прерывается)', async () => {
      const { port } = await make();
      const err = await captureError(
        port.execute({ command: { kind: 'shell', command: 'sleep 5' }, timeoutMs: 300 }),
      );
      expect(err).toBeInstanceOf(ExecutionError);
      expect(err.reason).toBe('timeout');
    });

    it('отмена по сигналу — ошибка (aborted)', async () => {
      const { port } = await make();
      const ac = new AbortController();
      const promise = port.execute({
        command: { kind: 'shell', command: 'sleep 5' },
        signal: ac.signal,
      });
      setTimeout(() => ac.abort(), 100);
      const err = await captureError(promise);
      expect(err).toBeInstanceOf(ExecutionError);
      expect(err.reason).toBe('aborted');
    });

    it('превышение лимита вывода — ошибка с признаком усечения', async () => {
      const { port } = await make();
      const err = await captureError(
        port.execute({
          command: { kind: 'shell', command: 'yes abcdefgh | head -c 4096' },
          maxOutputBytes: 256,
        }),
      );
      expect(err).toBeInstanceOf(ExecutionError);
      expect(err.reason).toBe('max_output');
      expect(err.truncated).toBe(true);
    });

    it('отсутствующий бинарник — ошибка ENOENT', async () => {
      const { port } = await make();
      const err = await captureError(
        port.execute({ command: { kind: 'argv', file: 'synth-exec-contract-missing-binary' } }),
      );
      expect(err).toBeInstanceOf(ExecutionError);
      expect(err.reason).toBe('spawn_failed');
      expect(err.code).toBe('ENOENT');
    });
  });
}

/**
 * Проверки, применимые **ТОЛЬКО к inline-реализации** (исполнение в процессе
 * control plane).
 *
 * У inline нет границы workspace: команда исполняется в любом каталоге, даже
 * за пределами рабочего каталога проекта. Для удалённого исполнителя это
 * запрещено (containment) — проверка вынесена в
 * `describeRemoteOnlyExecutionChecks`.
 */
export function describeInlineOnlyExecutionChecks(
  name: string,
  make: ExecutionPortHarnessFactory,
): void {
  describe(`${name} — только inline`, () => {
    it('cwd вне рабочего каталога проекта — команда исполняется (ограничения нет)', async () => {
      const { port, cwdOutside } = await make();
      const dir = cwdOutside ?? (await realpath('/tmp'));
      const res = await port.execute({ command: { kind: 'shell', command: 'pwd' }, cwd: dir });
      expect(res.stdout.trim()).toBe(await realpath(dir));
    });
  });
}

/**
 * Проверки, применимые **ТОЛЬКО к удалённому исполнителю** (PROP-077, шаг 7b).
 *
 * Containment `cwd` — граница безопасности исполнителя: команда вне его
 * workspace не запускается вовсе (протокольная причина `cwd_outside_workspace`,
 * клиент переносит её как `reason: 'spawn_failed'` с кодом `EWORKSPACE`).
 */
export function describeRemoteOnlyExecutionChecks(
  name: string,
  make: ExecutionPortHarnessFactory,
): void {
  describe(`${name} — только remote`, () => {
    it('cwd вне workspace исполнителя — отказ (EWORKSPACE), команда не запускается', async () => {
      const { port, cwdOutside } = await make();
      const dir = cwdOutside ?? (await realpath('/tmp'));
      const err = await captureError(
        port.execute({ command: { kind: 'shell', command: 'pwd' }, cwd: dir }),
      );
      expect(err).toBeInstanceOf(ExecutionError);
      expect(err.reason).toBe('spawn_failed');
      expect(err.code).toBe('EWORKSPACE');
    });
  });
}
