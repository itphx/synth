/**
 * Проба «что на переднем плане PTY» (протокол исполнителя 9).
 *
 * Тесты не читают настоящий `/proc`: подменены `readFile`/`readdir`/`execPs`.
 * Проверяются краевые случаи парсинга:
 *
 * - `comm` содержит пробелы и `)` — поля читаются после **последней** `)`;
 * - `tpgid <= 0` (терминала нет) и `tpgid === shellPid` — в фокусе оболочка;
 * - чужой `tpgid` — находится `comm` процесса с этим `pgrp`;
 * - нет `/proc` (macOS) — fallback `ps`, сравнение в JS;
 * - любая ошибка — `null` (fail-open), без исключений.
 */

import { describe, expect, it } from 'vitest';
import { inspectForeground, type ForegroundProbeDeps } from './foreground.js';

/**
 * Строка `/proc/<pid>/stat`: поле 2 — comm, 3 — state, 4 — ppid, 5 — pgrp,
 * 6 — session, 7 — tty_nr, 8 — tpgid.
 */
function statLine(opts: {
  pid: number;
  comm: string;
  pgrp: number;
  tpgid: number;
}): string {
  const { pid, comm, pgrp, tpgid } = opts;
  return `${pid} (${comm}) S 1 ${pgrp} ${pgrp} 0 ${tpgid} 4194560 0 0 0 0`;
}

/** `/proc` из карты «путь → содержимое»; чтение неизвестного пути — ошибка. */
function procDeps(
  files: Record<string, string>,
  entries: string[] = Object.keys(files).map((path) => path.split('/')[2] ?? ''),
  calls: { readdir: number } = { readdir: 0 },
): ForegroundProbeDeps {
  return {
    readFile: async (path) => {
      const value = files[path];
      if (value === undefined) throw new Error(`ENOENT: ${path}`);
      return value;
    },
    readdir: async () => {
      calls.readdir += 1;
      return entries;
    },
    execPs: async () => {
      throw new Error('ps не должен вызываться при живом /proc');
    },
  };
}

describe('inspectForeground: Linux (/proc)', () => {
  it('comm с пробелами и скобкой: поля не съезжают, tpgid == shellPid', async () => {
    const result = await inspectForeground(
      100,
      procDeps({
        '/proc/100/stat': statLine({ pid: 100, comm: 'weird) shell name', pgrp: 100, tpgid: 100 }),
      }),
    );
    expect(result).toEqual({
      shellPid: 100,
      foregroundPgid: 100,
      command: 'weird) shell name',
      isShell: true,
    });
  });

  it('tpgid <= 0 (терминала/фокуса нет) — в фокусе оболочка, без скана', async () => {
    const calls = { readdir: 0 };
    const result = await inspectForeground(
      100,
      procDeps(
        { '/proc/100/stat': statLine({ pid: 100, comm: 'bash', pgrp: 100, tpgid: -1 }) },
        ['100'],
        calls,
      ),
    );
    expect(result).toEqual({ shellPid: 100, isShell: true });
    expect(calls.readdir).toBe(0);
  });

  it('чужой tpgid — находит comm процесса с этим pgrp', async () => {
    const result = await inspectForeground(
      100,
      procDeps(
        {
          '/proc/100/stat': statLine({ pid: 100, comm: 'bash', pgrp: 100, tpgid: 555 }),
          '/proc/555/stat': statLine({ pid: 555, comm: 'vim', pgrp: 555, tpgid: 555 }),
        },
        ['100', '555', 'self', 'sys'],
      ),
    );
    expect(result).toEqual({
      shellPid: 100,
      foregroundPgid: 555,
      command: 'vim',
      isShell: false,
    });
  });

  it('процесс группы не найден (гонка с выходом) — pgid есть, имени нет', async () => {
    const result = await inspectForeground(
      100,
      procDeps(
        { '/proc/100/stat': statLine({ pid: 100, comm: 'bash', pgrp: 100, tpgid: 777 }) },
        ['100'],
      ),
    );
    expect(result).toEqual({ shellPid: 100, foregroundPgid: 777, isShell: false });
  });

  it('путь с каталогом в comm (macOS-стиль через ps) — только имя', async () => {
    const result = await inspectForeground(
      10,
      procDeps({
        '/proc/10/stat': statLine({ pid: 10, comm: '/bin/zsh', pgrp: 10, tpgid: 10 }),
      }),
    );
    expect(result?.command).toBe('zsh');
  });
});

describe('inspectForeground: fallback ps (нет /proc)', () => {
  it('tpgid оболочки — isShell, команда из строки pgid/comm', async () => {
    const result = await inspectForeground(100, {
      readFile: async () => {
        throw new Error('ENOENT');
      },
      readdir: async () => [],
      execPs: async (args) => {
        if (args.join(' ') === '-o tpgid= -p 100') return ' 100\n';
        if (args.join(' ') === '-eo pgid=,comm=') return '  100 bash\n  100 -zsh\n';
        throw new Error(`неожиданный вызов ps: ${args.join(' ')}`);
      },
    });
    expect(result).toEqual({
      shellPid: 100,
      foregroundPgid: 100,
      command: 'bash',
      isShell: true,
    });
  });

  it('чужой tpgid — команда из таблицы pgid/comm (имя с пробелом)', async () => {
    const result = await inspectForeground(100, {
      readFile: async () => {
        throw new Error('ENOENT');
      },
      readdir: async () => [],
      execPs: async (args) => {
        if (args.join(' ') === '-o tpgid= -p 100') return '555\n';
        if (args.join(' ') === '-eo pgid=,comm=') return '  100 bash\n  555 ssh host name\n';
        throw new Error('unexpected');
      },
    });
    expect(result).toEqual({
      shellPid: 100,
      foregroundPgid: 555,
      command: 'ssh host name',
      isShell: false,
    });
  });

  it('tpgid <= 0 — в фокусе оболочка', async () => {
    const result = await inspectForeground(100, {
      readFile: async () => {
        throw new Error('ENOENT');
      },
      execPs: async (args) =>
        args.join(' ') === '-o tpgid= -p 100' ? '-1\n' : '  100 bash\n',
    });
    expect(result).toEqual({ shellPid: 100, isShell: true });
  });
});

describe('inspectForeground: ошибки и границы', () => {
  it('pid не задан/невалиден — null без проб', async () => {
    let called = false;
    const deps: ForegroundProbeDeps = {
      readFile: async () => {
        called = true;
        return '';
      },
      execPs: async () => {
        called = true;
        return '';
      },
    };
    expect(await inspectForeground(undefined, deps)).toBeNull();
    expect(await inspectForeground(0, deps)).toBeNull();
    expect(await inspectForeground(-5, deps)).toBeNull();
    expect(called).toBe(false);
  });

  it('и /proc, и ps недоступны — null (fail-open)', async () => {
    const result = await inspectForeground(100, {
      readFile: async () => {
        throw new Error('EACCES');
      },
      execPs: async () => {
        throw new Error('ps: not found');
      },
    });
    expect(result).toBeNull();
  });

  it('ps вернул пустой tpgid (процесса нет) — null', async () => {
    const result = await inspectForeground(100, {
      readFile: async () => {
        throw new Error('ENOENT');
      },
      execPs: async () => '\n',
    });
    expect(result).toBeNull();
  });

  it('битый /proc/stat — fallback ps, а не исключение', async () => {
    const result = await inspectForeground(100, {
      readFile: async () => 'мусор без скобок',
      readdir: async () => [],
      execPs: async (args) =>
        args.join(' ') === '-o tpgid= -p 100' ? '100\n' : '  100 bash\n',
    });
    expect(result?.isShell).toBe(true);
    expect(result?.command).toBe('bash');
  });
});
