/**
 * Сериализация файловых правок по пути (in-process per-path lock).
 *
 * Зачем: `edit_file` и `patch` — это read-modify-write. Два параллельных
 * вызова одного файла (фоновые саб-агенты, два tool_call в одном ходе) могли
 * перетереть друг друга: оба прочитали одну версию файла, оба посчитали свою
 * правку от неё и оба записали — правка одного терялась без всякой ошибки.
 * Здесь правки одного пути выстраиваются в очередь: второй ждёт первый.
 *
 * Как устроено: реестр `Map<путь, очередь>`. Локи берутся в **отсортированном**
 * порядке путей (глобальный порядок), поэтому дедлока нет: цикл ожидания
 * требовал бы, чтобы каждый участник держал лок строго меньше того, который
 * ждёт, — по строго убывающему порядку это невозможно. Запись реестра удаляется,
 * когда очередь по пути опустела (реестр не растёт со временем).
 *
 * Ограничение: лок **in-process** — как per-path lock в opencode. Межпроцессная
 * сериализация им НЕ покрывается: удалённый исполнитель (ADR-077, split-режим)
 * или несколько реплик control plane пишут в общий том, а этот реестр живёт в
 * одном процессе. Для межпроцессного случая нужен общий лок на носителе
 * (`flock`/`O_EXCL`) — это отдельная задача.
 *
 * Ключ лока — лексический абсолютный путь (без разыменования симлинков):
 * путь через симлинк и его цель — разные ключи. Это осознанно (дешёвый и
 * детерминированный ключ); запись в симлинк идёт по цели (`writeFileAtomic`
 * разыменовывает симлинк), поэтому два разных ключа могут описывать один
 * файл — редкий крайний случай.
 */
import { isAbsolute, normalize, resolve } from 'node:path';

/** Очередь ожидания по одному пути. */
interface PathLockEntry {
  /** Хвост очереди: резолвится, когда все перед ним освободили путь. */
  tail: Promise<void>;
  /** Сколько участников стоят в очереди (включая текущего держателя). */
  refs: number;
}

/** Реестр локов: канонический путь → очередь. */
const registry = new Map<string, PathLockEntry>();

/**
 * Канонический ключ лока: абсолютный нормализованный путь.
 *
 * Относительный путь резолвится от текущего каталога процесса — вызывающие
 * (файловые тулы) передают уже абсолютные пути, так что это только страховка
 * от «одного и того же файла под двумя ключами».
 */
export function fileLockKey(path: string): string {
  return isAbsolute(path) ? normalize(path) : resolve(path);
}

/**
 * Поставить в очередь на путь.
 *
 * @returns `wait` — промис «путь свободен, можно идти» (никогда не
 *   отклоняется), `release` — освобождение пути (идемпотентно).
 */
function enqueue(key: string): { wait: Promise<void>; release: () => void } {
  let entry = registry.get(key);
  if (!entry) {
    entry = { tail: Promise.resolve(), refs: 0 };
    registry.set(key, entry);
  }
  const current = entry;
  current.refs += 1;

  const previous = current.tail;
  let releaseGate!: () => void;
  const mine = new Promise<void>((resolveGate) => {
    releaseGate = resolveGate;
  });
  // Следующий участник встанет в очередь за нашим «слотом» (`mine`).
  current.tail = previous.then(() => mine);

  let released = false;
  return {
    wait: previous,
    release: () => {
      if (released) return;
      released = true;
      releaseGate();
      current.refs -= 1;
      // Очередь опустела — запись реестра убираем (иначе он растёт).
      if (current.refs === 0 && registry.get(key) === current) {
        registry.delete(key);
      }
    },
  };
}

/**
 * Выполнить `fn`, взяв локи на все указанные пути.
 *
 * Локи берутся в отсортированном порядке (детерминированно, без дедлока) и
 * освобождаются в обратном — в `finally`, поэтому освобождаются даже при
 * исключении из `fn`.
 *
 * @param paths пути файлов (абсолютные или относительные); дубли схлопываются
 *   (иначе один вызов занял бы один путь дважды и ждал бы сам себя).
 * @param fn критическая секция.
 */
export async function withFileLocks<T>(paths: readonly string[], fn: () => Promise<T>): Promise<T> {
  const keys = [...new Set(paths.map(fileLockKey))].sort();
  if (keys.length === 0) return fn();

  const releases: Array<() => void> = [];
  try {
    // Ставим в очередь по всем путям сразу (порядок — отсортированный),
    // затем ждём каждый: так порядок в очереди по каждому пути одинаков для
    // всех вызовов.
    const waits: Array<Promise<void>> = [];
    for (const key of keys) {
      const slot = enqueue(key);
      releases.push(slot.release);
      waits.push(slot.wait);
    }
    for (const wait of waits) await wait;
    return await fn();
  } finally {
    // Освобождаем в обратном порядке — как брали.
    for (let i = releases.length - 1; i >= 0; i--) releases[i]!();
  }
}

/**
 * Размер реестра локов (число путей в очереди) — диагностика: после
 * завершения всех правок реестр пуст.
 */
export function fileLockRegistrySize(): number {
  return registry.size;
}
