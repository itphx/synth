import { describe, expect, it } from 'vitest';
import { Readable } from 'node:stream';
import type { BlobStore, DefaultsRepository } from '../ports/index.js';

/**
 * Паспорт порта `BlobStore`: round-trip, рекурсивный list, containment,
 * метаданные и потоковое чтение (ADR-115).
 */
export function describeBlobStore(
  name: string,
  make: () => Promise<{ repo: BlobStore; dispose?: () => Promise<void> }>,
): void {
  describe(name, () => {
    it('write/read/exists/delete; отсутствующий — null/false', async () => {
      const { repo } = await make();
      expect(await repo.read('missing.bin')).toBeNull();
      expect(await repo.exists('missing.bin')).toBe(false);

      await repo.write('a/b.txt', 'hello');
      expect(await repo.exists('a/b.txt')).toBe(true);
      expect((await repo.read('a/b.txt'))?.toString('utf-8')).toBe('hello');

      await repo.delete('a/b.txt');
      expect(await repo.exists('a/b.txt')).toBe(false);
      await expect(repo.delete('a/b.txt')).resolves.toBeUndefined();
    });

    it('list рекурсивен и детерминирован; пустой — []', async () => {
      const { repo } = await make();
      expect(await repo.list()).toEqual([]);

      await repo.write('dir/b.txt', 'bb');
      await repo.write('dir/a.txt', 'a');
      await repo.write('root.txt', 'r');

      const all = await repo.list();
      expect(all.map((e) => e.path)).toEqual(['dir/a.txt', 'dir/b.txt', 'root.txt']);
      expect(all.find((e) => e.path === 'dir/a.txt')?.size).toBe(1);

      const scoped = await repo.list('dir');
      expect(scoped.map((e) => e.path)).toEqual(['dir/a.txt', 'dir/b.txt']);
    });

    it('append дописывает в конец (файла нет — создаётся)', async () => {
      const { repo } = await make();
      await repo.append('log/run.log', 'first\n');
      await repo.append('log/run.log', 'second\n');
      expect((await repo.read('log/run.log'))?.toString('utf-8')).toBe('first\nsecond\n');

      // Дописывание к существующему файлу ничего не затирает.
      await repo.write('plain.txt', 'a');
      await repo.append('plain.txt', 'b');
      expect((await repo.read('plain.txt'))?.toString('utf-8')).toBe('ab');

      // Размер в `list` учитывает дописанное.
      const entry = (await repo.list('log')).find((e) => e.path === 'log/run.log');
      expect(entry?.size).toBe('first\nsecond\n'.length);
    });

    it('containment: `..` отклоняется', async () => {
      const { repo } = await make();
      await expect(repo.write('../escape.txt', 'x')).rejects.toThrow();
      await expect(repo.append('../escape.txt', 'x')).rejects.toThrow();
    });

    it('containment: абсолютный путь отклоняется', async () => {
      const { repo } = await make();
      await expect(repo.append('/etc/escape.txt', 'x')).rejects.toThrow();
    });

    // ADR-115: метаданные объекта — размер/mtime для ответа раздачи.
    it('stat: размер/mtime объекта; отсутствующий — null', async () => {
      const { repo } = await make();
      expect(await repo.stat('missing.bin')).toBeNull();

      await repo.write('a/b.txt', 'hello');
      const stat = await repo.stat('a/b.txt');
      expect(stat?.size).toBe(5);
      expect(typeof stat?.mtimeMs).toBe('number');

      await repo.delete('a/b.txt');
      expect(await repo.stat('a/b.txt')).toBeNull();
    });

    // ADR-115: потоковое чтение (раздача без чтения в память).
    it('readStream: содержимое объекта собирается из чанков', async () => {
      const { repo } = await make();
      await repo.write('a/b.txt', 'hello stream');

      const stream = await repo.readStream('a/b.txt');
      expect(stream).not.toBeNull();
      expect((await readStreamToBuffer(stream!)).toString('utf-8')).toBe('hello stream');
    });

    it('readStream: диапазон — включительно с обоих концов', async () => {
      const { repo } = await make();
      await repo.write('a/b.txt', '0123456789');

      const head = await repo.readStream('a/b.txt', { start: 0, end: 2 });
      expect((await readStreamToBuffer(head!)).toString('utf-8')).toBe('012');

      const tail = await repo.readStream('a/b.txt', { start: 7 });
      expect((await readStreamToBuffer(tail!)).toString('utf-8')).toBe('789');

      const middle = await repo.readStream('a/b.txt', { start: 2, end: 5 });
      expect((await readStreamToBuffer(middle!)).toString('utf-8')).toBe('2345');
    });

    it('readStream: отсутствующий объект — null (поток не создаётся)', async () => {
      const { repo } = await make();
      expect(await repo.readStream('missing.bin')).toBeNull();
    });

    // ADR-115: потоковая запись загрузки — крупный объект не буферизуется.
    it('writeStream: поток → объект (чанки склеиваются), перезапись целиком', async () => {
      const { repo } = await make();
      await repo.writeStream(
        'stream/a.bin',
        Readable.from([Buffer.from('hello '), Buffer.from('stream')]),
      );
      expect((await repo.read('stream/a.bin'))?.toString('utf-8')).toBe('hello stream');
      expect(await repo.stat('stream/a.bin')).toMatchObject({ size: 12 });

      await repo.writeStream('stream/a.bin', Readable.from([Buffer.from('new')]));
      expect((await repo.read('stream/a.bin'))?.toString('utf-8')).toBe('new');
    });

    it('writeStream: ошибка источника — прежний объект цел, временных не остаётся', async () => {
      const { repo } = await make();
      await repo.write('keep.bin', 'v1');

      await expect(repo.writeStream('keep.bin', failingStream())).rejects.toThrow('broken');
      expect((await repo.read('keep.bin'))?.toString('utf-8')).toBe('v1');
      expect((await repo.list()).map((e) => e.path)).toEqual(['keep.bin']);
    });

    it('writeStream: пустой поток — пустой объект (решение о «пустом файле» — у домена)', async () => {
      const { repo } = await make();
      await repo.writeStream('empty.bin', Readable.from([]));
      expect(await repo.stat('empty.bin')).toMatchObject({ size: 0 });
    });

    // ADR-115: перенос временного объекта в content-addressed путь.
    it('move: объект переносится, источник исчезает, цель перезаписывается', async () => {
      const { repo } = await make();
      await repo.write('tmp/upload.bin', 'payload');
      await repo.write('dst/target.bin', 'old');

      await repo.move('tmp/upload.bin', 'dst/target.bin');
      expect((await repo.read('dst/target.bin'))?.toString('utf-8')).toBe('payload');
      expect(await repo.exists('tmp/upload.bin')).toBe(false);

      // Перенос в новый подкаталог — каталоги создаются портом.
      await repo.move('dst/target.bin', 'deep/dir/moved.bin');
      expect((await repo.read('deep/dir/moved.bin'))?.toString('utf-8')).toBe('payload');
      expect(await repo.exists('dst/target.bin')).toBe(false);
    });

    it('move: отсутствующий источник — ошибка', async () => {
      const { repo } = await make();
      await expect(repo.move('missing.bin', 'dst.bin')).rejects.toThrow();
      expect(await repo.exists('dst.bin')).toBe(false);
    });

    it('move: containment ( `..` / абсолютный путь ) — отказ', async () => {
      const { repo } = await make();
      await repo.write('a.bin', 'x');
      await expect(repo.move('../a.bin', 'b.bin')).rejects.toThrow();
      await expect(repo.move('a.bin', '/abs/b.bin')).rejects.toThrow();
    });
  });
}

/** Поток, отдавший часть данных и затем падающий (обрыв загрузки). */
function failingStream(message = 'broken'): Readable {
  return Readable.from(
    (async function* () {
      yield Buffer.from('partial');
      throw new Error(message);
    })(),
  );
}

/** Собрать содержимое потока в буфер (чанки склеиваются). */
async function readStreamToBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk, 'utf-8') : (chunk as Buffer));
  }
  return Buffer.concat(chunks);
}

/** Паспорт порта `DefaultsRepository`. */
export function describeDefaultsRepository(
  name: string,
  make: () => Promise<{ repo: DefaultsRepository; dispose?: () => Promise<void> }>,
): void {
  describe(name, () => {
    it('пустые умолчания — {}; saveDefaults сливает патч поверх', async () => {
      const { repo } = await make();
      expect(await repo.loadDefaults()).toEqual({});

      const saved = await repo.saveDefaults({ locale: 'ru', themeMode: 'dark' });
      expect(saved.locale).toBe('ru');
      expect(saved.themeMode).toBe('dark');

      const merged = await repo.saveDefaults({ theme: 'synth' });
      expect(merged.locale).toBe('ru');
      expect(merged.theme).toBe('synth');
    });
  });
}
