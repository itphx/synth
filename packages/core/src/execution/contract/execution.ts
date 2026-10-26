/**
 * Контрактный suite порта исполнения (ADR-077, шаги 1 и 7b).
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
 *   - `durationMs` заполнен;
 *   - фоновый запуск (PROP-097): поток вывода, код завершения, `stop()`,
 *     таймаут — отдельным блоком `describeBackgroundExecutionChecks` (только
 *     для реализаций, которые фоновый запуск поддерживают).
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
 *
 * ## Проверка типа ошибки — структурная
 *
 * Ошибка проверяется предикатом `isExecutionError`, а не `instanceof`:
 * клиент удалённого порта создаёт `ExecutionError` через динамический
 * `import('@itphx/synth-core')` (то есть из `dist`), а контракт импортирует
 * класс из исходников core — это два разных объекта класса, и `instanceof`
 * не срабатывает. Структурная проверка (признак типа `name` + форма ошибки)
 * работает с любой копией класса и не ослабляет сами проверки.
 */

import { describe, expect, it } from 'vitest';
import { realpath } from 'node:fs/promises';
import { isExecutionError, type ExecutionError, type ExecutionPort } from '../ports/index.js';

/**
 * Окружение реализации порта для прогона контракта.
 *
 * - `port` — сам порт;
 * - `cwd` — каталог для проверок `cwd`; обязан быть валиден для реализации
 *   (для удалённого исполнителя — внутри его workspace);
 * - `cwdOutside` — каталог **вне** границ реализации (для remote-проверок
 *   containment'а; для inline — просто каталог вне рабочего каталога проекта);
 * - `availableBinaries` — программы, которые гарантированно есть в окружении
 *   реализации (для проверок `probe`/`requires`; пустой список — проверки
 *   возможностей неприменимы);
 * - `dispose` — освобождение ресурсов реализации (опционально).
 */
export interface ExecutionPortHarness {
  port: ExecutionPort;
  cwd: string;
  cwdOutside?: string;
  availableBinaries?: string[];
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
      expect(isExecutionError(err)).toBe(true);
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
      expect(isExecutionError(err)).toBe(true);
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
      expect(isExecutionError(err)).toBe(true);
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
      expect(isExecutionError(err)).toBe(true);
      expect(err.reason).toBe('max_output');
      expect(err.truncated).toBe(true);
    });

    it('отсутствующий бинарник — ошибка ENOENT', async () => {
      const { port } = await make();
      const err = await captureError(
        port.execute({ command: { kind: 'argv', file: 'synth-exec-contract-missing-binary' } }),
      );
      expect(isExecutionError(err)).toBe(true);
      expect(err.reason).toBe('spawn_failed');
      expect(err.code).toBe('ENOENT');
    });

    it('probe: заведомо отсутствующая программа → false', async () => {
      const { port } = await make();
      if (typeof port.probe !== 'function') return;
      expect(await port.probe('synth-exec-contract-missing-binary')).toBe(false);
    });

    it('probe: программа из состава окружения → true', async () => {
      const { port, availableBinaries = [] } = await make();
      if (typeof port.probe !== 'function') return;
      for (const bin of availableBinaries) {
        expect(await port.probe(bin), bin).toBe(true);
      }
    });

    it('requires: команда с бинарным требованием уходит в среду, где программа есть', async () => {
      const { port, availableBinaries = [] } = await make();
      const bin = availableBinaries[0];
      if (!bin) return;
      const res = await port.execute({
        command: { kind: 'shell', command: 'printf ok' },
        requires: [bin],
      });
      expect(res.stdout).toBe('ok');
      expect(res.exitCode).toBe(0);
    });
  });
}

/**
 * Проверки фонового запуска (PROP-097) — для реализаций, которые его
 * поддерживают (inline и remote — обе, ADR-077 шаг 7c).
 *
 * Фоновый процесс — не то же, что `execute`: он не ждёт завершения, вывод
 * приходит потоком, а отмена делается через `stop()` хэндла. Проверяется:
 *
 *   - поток вывода раздельно по `stdout`/`stderr`;
 *   - код завершения (`exitCode`), в том числе ненулевой;
 *   - остановка через `stop()` — процесс завершается по сигналу;
 *   - таймаут (`timeoutMs`) — процесс убивается по таймеру;
 *   - `timeoutMs: 0` — без таймаута: процесс живёт и завершается сам;
 *   - `processId`/`pid` заполнены, `exited` резолвится один раз.
 *
 * Блок подключается только там, где метод есть: реализация без
 * `spawnBackground` этот набор не проходит (проверки пропускаются).
 */
export function describeBackgroundExecutionChecks(
  name: string,
  make: ExecutionPortHarnessFactory,
): void {
  describe(`${name} — фоновый запуск`, () => {
    it('вывод приходит потоком: stdout и stderr раздельно, exitCode 0', async () => {
      const { port } = await make();
      if (typeof port.spawnBackground !== 'function') return;
      const bg = await port.spawnBackground({
        command: { kind: 'shell', command: 'printf hi; printf err >&2' },
      });
      expect(bg.processId).toMatch(/^proc_/);
      expect(bg.pid).toBeGreaterThan(0);

      const chunks: Array<{ stream: string; data: string }> = [];
      for await (const chunk of bg.output) {
        chunks.push({ stream: chunk.stream, data: chunk.data });
      }

      const stdout = chunks
        .filter((c) => c.stream === 'stdout')
        .map((c) => c.data)
        .join('');
      const stderr = chunks
        .filter((c) => c.stream === 'stderr')
        .map((c) => c.data)
        .join('');
      expect(stdout).toContain('hi');
      expect(stderr).toContain('err');

      const exit = await bg.exited;
      expect(exit.exitCode).toBe(0);
      expect(exit.signal).toBeNull();
      expect(exit.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('ненулевой код завершения — в exitCode', async () => {
      const { port } = await make();
      if (typeof port.spawnBackground !== 'function') return;
      const bg = await port.spawnBackground({
        command: { kind: 'shell', command: 'exit 3' },
      });
      const exit = await bg.exited;
      expect(exit.exitCode).toBe(3);
      expect(exit.signal).toBeNull();
    });

    it('stop() — процесс завершается по сигналу', async () => {
      const { port } = await make();
      if (typeof port.spawnBackground !== 'function') return;
      const bg = await port.spawnBackground({
        command: { kind: 'shell', command: 'sleep 5' },
      });
      bg.stop();
      const exit = await bg.exited;
      expect(exit.signal).not.toBeNull();
      expect(exit.exitCode).toBeNull();
      // Повторный `stop()` не бросает (процесс уже завершён).
      expect(() => bg.stop()).not.toThrow();
    });

    it('timeoutMs — процесс убивается по таймеру', async () => {
      const { port } = await make();
      if (typeof port.spawnBackground !== 'function') return;
      const bg = await port.spawnBackground({
        command: { kind: 'shell', command: 'sleep 5' },
        timeoutMs: 200,
      });
      const exit = await bg.exited;
      expect(exit.signal).not.toBeNull();
      expect(exit.exitCode).toBeNull();
    });

    it('timeoutMs 0 — без таймаута: процесс живёт и завершается сам', async () => {
      const { port } = await make();
      if (typeof port.spawnBackground !== 'function') return;
      // Фоновый процесс по умолчанию **без таймаута** — домен передаёт `0`.
      // Удалённый исполнитель обязан такой запрос принять (иначе первый
      // вызов `execute_shell({background:true})` падает с 400).
      const bg = await port.spawnBackground({
        command: { kind: 'shell', command: 'sleep 0.3; printf done' },
        timeoutMs: 0,
      });
      const exit = await bg.exited;
      expect(exit.exitCode).toBe(0);
      expect(exit.signal).toBeNull();
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
 * Проверки, применимые **ТОЛЬКО к удалённому исполнителю** (ADR-077, шаг 7b).
 *
 * Containment `cwd` — граница безопасности исполнителя: команда вне его
 * workspace не запускается вовсе (протокольная причина `cwd_outside_workspace`,
 * клиент переносит её как `reason: 'spawn_failed'` с кодом `EWORKSPACE`).
 *
 * Фоновый запуск в remote-режиме **поддержан** (ADR-077, шаг 7c): клиент
 * удалённого порта реализует `spawnBackground` (опрос состояния и журнала).
 * Проверяется, что метод есть и что containment действует и для фонового
 * запуска.
 */
export function describeRemoteOnlyExecutionChecks(
  name: string,
  make: ExecutionPortHarnessFactory,
): void {
  describe(`${name} — только remote`, () => {
    it('фоновый запуск поддержан: метод реализован', async () => {
      const { port } = await make();
      expect(typeof port.spawnBackground).toBe('function');
    });

    it('cwd вне workspace исполнителя — отказ (EWORKSPACE), команда не запускается', async () => {
      const { port, cwdOutside } = await make();
      const dir = cwdOutside ?? (await realpath('/tmp'));
      const err = await captureError(
        port.execute({ command: { kind: 'shell', command: 'pwd' }, cwd: dir }),
      );
      expect(isExecutionError(err)).toBe(true);
      expect(err.reason).toBe('spawn_failed');
      expect(err.code).toBe('EWORKSPACE');
    });

    it('фоновый запуск: cwd вне workspace исполнителя — отказ (EWORKSPACE)', async () => {
      const { port, cwdOutside } = await make();
      const spawn = port.spawnBackground;
      if (!spawn) throw new Error('ожидалась поддержка фонового запуска');
      const dir = cwdOutside ?? (await realpath('/tmp'));
      const err = await captureError(
        spawn.call(port, { command: { kind: 'shell', command: 'pwd' }, cwd: dir }),
      );
      expect(isExecutionError(err)).toBe(true);
      expect(err.reason).toBe('spawn_failed');
      expect(err.code).toBe('EWORKSPACE');
    });

    it('requires: программы нет ни у одного адреса — различимая ошибка', async () => {
      const { port } = await make();
      const err = await captureError(
        port.execute({
          command: { kind: 'shell', command: 'printf ok' },
          requires: ['synth-exec-contract-missing-binary'],
        }),
      );
      expect(isExecutionError(err)).toBe(true);
      expect(err.reason).toBe('dependency_missing');
      expect(err.code).toBe('EDEPENDENCY');
      expect(err.message).toContain('synth-exec-contract-missing-binary');
    });
  });
}
