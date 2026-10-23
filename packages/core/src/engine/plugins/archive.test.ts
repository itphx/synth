/**
 * ADR-090 (долги Д1): тесты собственного tar-ридера и
 * распаковки архива плагина.
 *
 * Архивы **собираются в тестах** (общий сборщик `test-helpers/tar-fixture.ts`):
 * фикстуры-биты в репозитории пришлось бы обновлять при любом изменении
 * формата, а так каждый кейс явно показывает, **что** лежит в архиве —
 * симлинк, `../evil`, абсолютный путь, pax-заголовок, превышение лимита.
 *
 * Временные каталоги — реальные (`mkdtemp`), после теста убираются: проверяется
 * и файловая система (состав, байты, `cleanup`), а не только возвращённый объект.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildTarGz as buildTgz, paxRecord } from '../../test-helpers/tar-fixture.js';
import { extractPluginArchive, PluginArchiveError } from './archive.js';

/** Временные каталоги теста (убираются в `afterEach`). */
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** Создать временный каталог (учитывается в уборке). */
async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'synth-plugin-archive-test-'));
  tempDirs.push(dir);
  return dir;
}

/** Ожидаемый отказ разбора. */
async function expectArchiveError(promise: Promise<unknown>, fragment: string): Promise<void> {
  await expect(promise).rejects.toBeInstanceOf(PluginArchiveError);
  await expect(promise).rejects.toThrow(fragment);
}

describe('extractPluginArchive — обычные архивы', () => {
  it('два файла → распакованы байт-в-байт, состав и суммарный размер верны', async () => {
    const pack = '{"name":"demo"}\n';
    const code = 'export function apply() {}\n';
    const tgz = buildTgz([
      { name: 'synth.pack', content: pack },
      { name: 'dist/index.js', content: code },
    ]);

    const extracted = await extractPluginArchive(tgz);
    tempDirs.push(extracted.dir);

    expect(extracted.files.sort()).toEqual(['dist/index.js', 'synth.pack']);
    expect(extracted.totalBytes).toBe(pack.length + code.length);
    expect(await readFile(join(extracted.dir, 'synth.pack'), 'utf-8')).toBe(pack);

    await extracted.cleanup();
  });

  it('бинарь не портится: содержимое совпадает с исходным', async () => {
    const binary = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0xfe, 0x01]);
    const extracted = await extractPluginArchive(
      buildTgz([{ name: 'assets/logo.png', content: binary }]),
    );
    tempDirs.push(extracted.dir);

    const written = await readFile(join(extracted.dir, 'assets/logo.png'));
    expect(written.equals(binary)).toBe(true);
    await extracted.cleanup();
  });

  it('каталог с пустым путём («./») — допустим, файлы распаковываются', async () => {
    const extracted = await extractPluginArchive(
      buildTgz([
        { name: './', type: '5' },
        { name: './a.txt', content: 'A' },
      ]),
    );
    tempDirs.push(extracted.dir);

    expect(extracted.files).toEqual(['a.txt']);
    expect(await readFile(join(extracted.dir, 'a.txt'), 'utf-8')).toBe('A');
    await extracted.cleanup();
  });

  it('pax extended header (typeflag x) переопределяет путь и размер', async () => {
    const longName = `dist/${'x'.repeat(120)}.js`;
    const pax = Buffer.concat([paxRecord('path', longName), paxRecord('size', '3')]);
    const extracted = await extractPluginArchive(
      buildTgz([
        // Имя в заголовке — обрезанное ustar-поле, реальное приходит из pax.
        { name: 'dist/truncated.js', type: 'x', content: pax },
        { name: 'dist/truncated.js', content: 'abc' },
      ]),
    );
    tempDirs.push(extracted.dir);

    expect(extracted.files).toEqual([longName]);
    expect(await readFile(join(extracted.dir, longName), 'utf-8')).toBe('abc');
    await extracted.cleanup();
  });

  it('GNU long name (typeflag L) — длинный путь принимается', async () => {
    const longName = `dist/${'y'.repeat(150)}.js`;
    const extracted = await extractPluginArchive(
      buildTgz([
        { name: '././@LongLink', type: 'L', content: longName },
        { name: 'dist/short.js', content: 'ok' },
      ]),
    );
    tempDirs.push(extracted.dir);

    expect(extracted.files).toEqual([longName]);
    await extracted.cleanup();
  });
});

describe('extractPluginArchive — stripPrefix (npm-тарбол)', () => {
  it('все файлы под package/ → префикс срезается', async () => {
    const extracted = await extractPluginArchive(
      buildTgz([
        { name: 'package/', type: '5' },
        { name: 'package/synth.pack', content: '{}' },
        { name: 'package/dist/index.js', content: 'x' },
      ]),
      { stripPrefix: 'package' },
    );
    tempDirs.push(extracted.dir);

    expect(extracted.files.sort()).toEqual(['dist/index.js', 'synth.pack']);
    expect(existsSync(join(extracted.dir, 'package'))).toBe(false);
    await extracted.cleanup();
  });

  it('файл вне префикса → «неожиданная раскладка архива»', async () => {
    const tgz = buildTgz([
      { name: 'package/synth.pack', content: '{}' },
      { name: 'other/evil.js', content: 'x' },
    ]);

    await expectArchiveError(
      extractPluginArchive(tgz, { stripPrefix: 'package' }),
      'вне ожидаемого каталога',
    );
  });
});

describe('extractPluginArchive — запрещённые пути и типы', () => {
  it('симлинк → отказ', async () => {
    await expectArchiveError(
      extractPluginArchive(
        buildTgz([
          { name: 'synth.pack', content: '{}' },
          { name: 'link', type: '2', linkname: '/etc/passwd' },
        ]),
      ),
      'символьную ссылку',
    );
  });

  it('жёсткая ссылка → отказ', async () => {
    await expectArchiveError(
      extractPluginArchive(
        buildTgz([{ name: 'link', type: '1', linkname: 'synth.pack' }]),
      ),
      'жёсткую ссылку',
    );
  });

  it('FIFO → отказ', async () => {
    await expectArchiveError(
      extractPluginArchive(buildTgz([{ name: 'pipe', type: '6' }])),
      'FIFO',
    );
  });

  it('«../evil» → отказ', async () => {
    await expectArchiveError(
      extractPluginArchive(buildTgz([{ name: '../evil.js', content: 'x' }])),
      'Выход за пределы',
    );
  });

  it('вложенный «..» → отказ', async () => {
    await expectArchiveError(
      extractPluginArchive(buildTgz([{ name: 'dist/../../evil.js', content: 'x' }])),
      'Выход за пределы',
    );
  });

  it('абсолютный путь → отказ', async () => {
    await expectArchiveError(
      extractPluginArchive(buildTgz([{ name: '/etc/passwd', content: 'x' }])),
      'Абсолютный путь',
    );
  });

  it('windows-диск («C:…») и обратные слэши → отказ', async () => {
    await expectArchiveError(
      extractPluginArchive(buildTgz([{ name: 'C:\\evil.js', content: 'x' }])),
      'windows-диском',
    );
    await expectArchiveError(
      extractPluginArchive(buildTgz([{ name: '\\etc\\passwd', content: 'x' }])),
      'Абсолютный путь',
    );
  });

  it('слишком длинный путь → отказ', async () => {
    await expectArchiveError(
      extractPluginArchive(buildTgz([{ name: `${'a'.repeat(40)}.js`, content: 'x' }]), {
        limits: { maxPathLength: 20 },
      }),
      'слишком длинный',
    );
  });

  it('пустое имя файла → отказ', async () => {
    await expectArchiveError(
      extractPluginArchive(buildTgz([{ name: './', content: 'x' }])),
      'пустым именем',
    );
  });
});

describe('extractPluginArchive — лимиты и битый gzip', () => {
  it('превышение maxFiles → отказ', async () => {
    await expectArchiveError(
      extractPluginArchive(
        buildTgz([
          { name: 'a.txt', content: 'a' },
          { name: 'b.txt', content: 'b' },
        ]),
        { limits: { maxFiles: 1 } },
      ),
      'больше записей',
    );
  });

  it('превышение maxFileBytes → отказ', async () => {
    await expectArchiveError(
      extractPluginArchive(buildTgz([{ name: 'a.txt', content: '0123456789' }]), {
        limits: { maxFileBytes: 5 },
      }),
      'больше допустимого',
    );
  });

  it('превышение maxTotalBytes → отказ', async () => {
    await expectArchiveError(
      extractPluginArchive(
        buildTgz([
          { name: 'a.txt', content: '012345' },
          { name: 'b.txt', content: '012345' },
        ]),
        { limits: { maxTotalBytes: 10 } },
      ),
      'Распакованный архив больше допустимого',
    );
  });

  it('не-gzip данные → понятный отказ', async () => {
    await expectArchiveError(
      extractPluginArchive(Buffer.from('это точно не gzip')),
      'не является корректным .tar.gz',
    );
  });

  it('обрезанный gzip → отказ', async () => {
    const tgz = buildTgz([{ name: 'a.txt', content: 'a'.repeat(2048) }]);
    await expectArchiveError(
      extractPluginArchive(tgz.subarray(0, tgz.length - 4)),
      '.tar.gz',
    );
  });

  it('ничего не пишется вне destDir (tar-slip не оставляет следов)', async () => {
    const parent = await makeTempDir();
    const dest = join(parent, 'dest');

    await expect(
      extractPluginArchive(buildTgz([{ name: '../evil.js', content: 'x' }]), { destDir: dest }),
    ).rejects.toBeInstanceOf(PluginArchiveError);

    expect(existsSync(join(parent, 'evil.js'))).toBe(false);
  });
});

describe('extractPluginArchive — cleanup', () => {
  it('cleanup удаляет каталог и идемпотентен', async () => {
    const extracted = await extractPluginArchive(buildTgz([{ name: 'a.txt', content: 'a' }]));
    expect(existsSync(extracted.dir)).toBe(true);

    await extracted.cleanup();
    expect(existsSync(extracted.dir)).toBe(false);
    // Повторный вызов — не ошибка.
    await expect(extracted.cleanup()).resolves.toBeUndefined();
  });

  it('destDir задан вызывающим — каталог используется и не удаляется модулем', async () => {
    const dest = join(await makeTempDir(), 'nested', 'dest');
    const extracted = await extractPluginArchive(buildTgz([{ name: 'a.txt', content: 'a' }]), {
      destDir: dest,
    });

    expect(extracted.dir).toBe(dest);
    expect(existsSync(join(dest, 'a.txt'))).toBe(true);
    await extracted.cleanup();
    expect(existsSync(dest)).toBe(false);
  });
});
