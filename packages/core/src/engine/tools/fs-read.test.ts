import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { readFileTool, listDirectoryTool, globTool, MEDIA_TRANSPORT_CAP } from './fs-read.js';
import {
  attachmentsConfigSchema,
  type AttachmentsConfig,
  type ToolContext,
} from '@itphx/synth-shared';
import { AttachmentError, type AttachmentService } from '../attachments/service.js';
import { sniffMime } from '../attachments/sniff-mime.js';
import {
  FsPathError,
  type ExecRequest,
  type ExecResult,
  type ExecutionFs,
  type ExecutionPort,
} from '../../execution/ports/index.js';

describe('fs-read tools — path resolution', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-fsread-'));
    await mkdir(join(tmpDir, 'src'), { recursive: true });
    await writeFile(join(tmpDir, 'src', 'a.ts'), 'export const a = 1;\n');
    await writeFile(join(tmpDir, 'README.md'), '# Hello\n');
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
    return {
      sessionId: 's1',
      messageId: 'm1',
      workingDir: tmpDir,
      ...overrides,
    };
  }

  it('read_file: относительный путь резолвится относительно рабочего каталога', async () => {
    const result = await readFileTool.execute({ file_path: 'src/a.ts' }, makeCtx());
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('export const a = 1');
  });

  it('read_file: абсолютный путь', async () => {
    const result = await readFileTool.execute({ file_path: join(tmpDir, 'src', 'a.ts') }, makeCtx());
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('a = 1');
  });

  it('read_file: абсолютный путь вне рабочего каталога разрешён', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'synth-fsread-out-'));
    try {
      await writeFile(join(outside, 'x.txt'), 'outside');
      const result = await readFileTool.execute({ file_path: join(outside, 'x.txt') }, makeCtx());
      expect(result.isError).toBeFalsy();
      expect(result.content).toContain('outside');
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('read_file: без пути — резолвится рабочий каталог (листинг, а не ошибка)', async () => {
    // аргументы проходят zod (file_path optional), резолвится workingDir;
    // путь-каталог отдаёт листинг (паритет с opencode)
    const result = await readFileTool.execute({}, makeCtx());
    expect(result.isError).toBeFalsy();
    expect(result.metadata?.type).toBe('directory');
    expect(result.content).toContain('README.md');
  });

  it('list_directory: относительный путь', async () => {
    const result = await listDirectoryTool.execute({ path: 'src' }, makeCtx());
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('a.ts');
  });

  it('list_directory: без пути — рабочий каталог', async () => {
    const result = await listDirectoryTool.execute({}, makeCtx());
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('src');
    expect(result.content).toContain('README.md');
  });

  it('glob: относительный путь', async () => {
    const result = await globTool.execute({ pattern: '*.ts', path: 'src' }, makeCtx());
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('a.ts');
  });
});

describe('fs-read tools — прерывание по «Стоп» (abortSignal)', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-fsread-abort-'));
    await mkdir(join(tmpDir, 'src'), { recursive: true });
    await writeFile(join(tmpDir, 'src', 'a.ts'), 'export const a = 1;\n');
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
    return {
      sessionId: 's1',
      messageId: 'm1',
      workingDir: tmpDir,
      ...overrides,
    };
  }

  it('read_file: pre-aborted — мгновенный маркер прерывания, файл не читается', async () => {
    const ac = new AbortController();
    ac.abort();

    const result = await readFileTool.execute(
      { file_path: 'src/a.ts' },
      makeCtx({ abortSignal: ac.signal }),
    );

    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('<status>stopped_by_user</status>');
    expect(result.content).not.toContain('export const a = 1');
    expect(result.metadata?.stopped_by).toBe('user');
    expect(result.metadata?.interrupted).toBe(true);
  });

  it('list_directory и glob: pre-aborted — мгновенный маркер прерывания', async () => {
    const ac = new AbortController();
    ac.abort();

    const listResult = await listDirectoryTool.execute({}, makeCtx({ abortSignal: ac.signal }));
    expect(listResult.metadata?.interrupted).toBe(true);

    const globResult = await globTool.execute({ pattern: '*.ts' }, makeCtx({ abortSignal: ac.signal }));
    expect(globResult.metadata?.interrupted).toBe(true);
  });

  it('без abortSignal — чтение работает как раньше (обратная совместимость)', async () => {
    const result = await readFileTool.execute({ file_path: 'src/a.ts' }, makeCtx());
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('export const a = 1');
    expect(result.metadata?.interrupted).toBeUndefined();
  });
});

describe('read_file — пагинация и усечение (паритет с opencode)', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-fsread-page-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
    return { sessionId: 's1', messageId: 'm1', workingDir: tmpDir, ...overrides };
  }

  it('offset/limit: возвращается только запрошенная страница, нумерация исходная 1-based', async () => {
    const lines = Array.from({ length: 10 }, (_, i) => `line-${i + 1}`);
    await writeFile(join(tmpDir, 'ten.txt'), lines.join('\n'));

    const result = await readFileTool.execute({ file_path: 'ten.txt', offset: 2, limit: 3 }, makeCtx());

    expect(result.isError).toBeFalsy();
    // offset 0-based → первая строка страницы имеет номер offset + 1;
    // за страницей есть ещё строки → маркер усечения
    const outLines = String(result.content).split('\n');
    expect(outLines.slice(0, 3)).toEqual(['3: line-3', '4: line-4', '5: line-5']);
    expect(outLines[3]).toContain('showing the first 3 lines');
    expect(result.metadata).toMatchObject({ type: 'file', totalLines: 10, offset: 2, limit: 3, truncated: true });
  });

  it('маркер усечения называет следующий offset (продолжение чтения)', async () => {
    const lines = Array.from({ length: 10 }, (_, i) => `line-${i + 1}`);
    await writeFile(join(tmpDir, 'ten2.txt'), lines.join('\n'));

    const result = await readFileTool.execute({ file_path: 'ten2.txt', offset: 2, limit: 3 }, makeCtx());
    const outLines = String(result.content).split('\n');

    expect(outLines[3]).toContain('continue with offset 5');
    // nextOffset = offset + показанных строк — с него можно продолжить
    expect(result.metadata?.nextOffset).toBe(5);

    // Продолжение с найденного offset действительно отдаёт следующие строки
    const next = await readFileTool.execute({ file_path: 'ten2.txt', offset: result.metadata?.nextOffset as number, limit: 2 }, makeCtx());
    expect(String(next.content).split('\n').slice(0, 2)).toEqual(['6: line-6', '7: line-7']);
  });

  it('offset без limit: читаем до конца файла', async () => {
    await writeFile(join(tmpDir, 'five.txt'), 'a\nb\nc\nd\ne\n');
    const result = await readFileTool.execute({ file_path: 'five.txt', offset: 3 }, makeCtx());
    expect(result.content.split('\n')).toEqual(['4: d', '5: e']);
    expect(result.metadata).toMatchObject({ totalLines: 5, truncated: false });
  });

  it('offset за концом файла → понятный маркер, а не пустой вывод', async () => {
    await writeFile(join(tmpDir, 'two.txt'), 'a\nb\n');
    const result = await readFileTool.execute({ file_path: 'two.txt', offset: 10 }, makeCtx());
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('out of range');
  });

  it('пустой файл → отдельный маркер (не «вне диапазона»)', async () => {
    await writeFile(join(tmpDir, 'empty.txt'), '');
    const result = await readFileTool.execute({ file_path: 'empty.txt' }, makeCtx());
    expect(result.isError).toBeFalsy();
    expect(result.content).toBe('(empty file)');
    expect(result.metadata).toMatchObject({ totalLines: 0, truncated: false });
  });

  it('дефолтный лимит — 2000 строк, при усечении маркер в конце', async () => {
    const lines = Array.from({ length: 2100 }, (_, i) => `row-${i + 1}`);
    await writeFile(join(tmpDir, 'big.txt'), lines.join('\n'));

    const out = await readFileTool.execute({ file_path: 'big.txt' }, makeCtx());
    const outLines = String(out.content).split('\n');

    expect(outLines).toHaveLength(2001); // 2000 строк + маркер
    expect(outLines[0]).toBe('1: row-1');
    expect(outLines[1999]).toBe('2000: row-2000');
    expect(outLines[2000]).toContain('showing the first 2000 lines');
    expect(out.metadata).toMatchObject({ totalLines: 2100, truncated: true });
  });

  it('limit больше максимума обрезается до 2000', async () => {
    const lines = Array.from({ length: 2100 }, (_, i) => `r${i + 1}`);
    await writeFile(join(tmpDir, 'big2.txt'), lines.join('\n'));

    const out = await readFileTool.execute({ file_path: 'big2.txt', limit: 5000 }, makeCtx());
    expect(out.metadata?.limit).toBe(2000);
    expect(String(out.content).split('\n')).toHaveLength(2001);
  });

  it('жёсткий cap 50 КБ: длинные строки не дают раздуть вывод', async () => {
    const line = 'x'.repeat(1000);
    const lines = Array.from({ length: 200 }, (_, i) => `${i + 1}-${line}`);
    await writeFile(join(tmpDir, 'wide.txt'), lines.join('\n'));

    const out = await readFileTool.execute({ file_path: 'wide.txt' }, makeCtx());
    const text = String(out.content);

    expect(out.metadata?.truncated).toBe(true);
    expect(Buffer.byteLength(text, 'utf-8')).toBeLessThanOrEqual(50 * 1024 + 200);
    expect(text).toContain('showing the first');
    // далеко не все 200 строк попали в вывод
    expect((out.metadata?.bytes as number)).toBeLessThanOrEqual(50 * 1024);
  });

  it('длинная строка обрезается до 2000 символов с суффиксом', async () => {
    const long = 'y'.repeat(5000);
    await writeFile(join(tmpDir, 'long.txt'), `${long}\nshort\n`);

    const out = await readFileTool.execute({ file_path: 'long.txt' }, makeCtx());
    const [first, second] = String(out.content).split('\n');

    expect(first).toContain('(line truncated)');
    // префикс "1: " + 2000 символов + суффикс
    expect(first!.length).toBeLessThan(2100);
    expect(second).toBe('2: short');
  });

  it('бинарный файл → isError с подсказкой, содержимое не декодируется', async () => {
    await writeFile(join(tmpDir, 'blob.bin'), Buffer.from([0x00, 0x01, 0x02, 0x00, 0xff, 0x00]));

    const out = await readFileTool.execute({ file_path: 'blob.bin' }, makeCtx());

    expect(out.isError).toBe(true);
    expect(out.content).toContain('binary file');
    expect(out.content).toContain('attach_workspace_file');
    expect(out.content).toContain('execute_shell');
    expect(out.metadata).toMatchObject({ type: 'binary' });
  });

  it('путь-каталог: листинг (сначала каталоги), offset/limit по записям', async () => {
    await mkdir(join(tmpDir, 'zdir'));
    await mkdir(join(tmpDir, 'adir'));
    await writeFile(join(tmpDir, 'b.txt'), 'bb');
    await writeFile(join(tmpDir, 'a.txt'), 'a');

    const all = await readFileTool.execute({ file_path: '.' }, makeCtx());
    expect(all.metadata).toMatchObject({ type: 'directory', totalEntries: 4, truncated: false });
    const names = String(all.content).split('\n').map((l) => l.split(' ')[0]);
    expect(names).toEqual(['adir/', 'zdir/', 'a.txt', 'b.txt']);

    const page = await readFileTool.execute({ file_path: '.', offset: 2, limit: 1 }, makeCtx());
    expect(String(page.content).split('\n')[0]).toBe('a.txt (1 bytes)');
    expect(page.metadata).toMatchObject({ offset: 2, limit: 1 });
  });

  it('каталог: усечение по limit даёт маркер', async () => {
    for (let i = 0; i < 5; i++) await writeFile(join(tmpDir, `f${i}.txt`), 'x');
    const out = await readFileTool.execute({ file_path: '.', limit: 2 }, makeCtx());
    const lines = String(out.content).split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[2]).toContain('showing the first 2 entries');
    expect(out.metadata).toMatchObject({ truncated: true, totalEntries: 5 });
  });

  it('каталог: маркер усечения называет следующий offset, nextOffset в metadata', async () => {
    for (let i = 0; i < 5; i++) await writeFile(join(tmpDir, `f${i}.txt`), 'x');

    const out = await readFileTool.execute({ file_path: '.', offset: 1, limit: 2 }, makeCtx());
    const lines = String(out.content).split('\n');

    expect(lines[2]).toContain('continue with offset 3');
    expect(out.metadata).toMatchObject({ offset: 1, limit: 2, nextOffset: 3, truncated: true });
  });

  it('list_directory: offset/limit листают записи каталога постранично', async () => {
    for (let i = 0; i < 5; i++) await writeFile(join(tmpDir, `f${i}.txt`), 'x');

    const first = await listDirectoryTool.execute({ path: '.', offset: 0, limit: 2 }, makeCtx());
    const firstLines = String(first.content).split('\n');

    expect(firstLines.slice(0, 2)).toEqual(['f0.txt (1 bytes)', 'f1.txt (1 bytes)']);
    expect(firstLines[2]).toContain('continue with offset 2');
    expect(first.metadata).toMatchObject({ offset: 0, limit: 2, nextOffset: 2, truncated: true, count: 5 });

    // Продолжение с найденного offset отдаёт следующие записи
    const second = await listDirectoryTool.execute(
      { path: '.', offset: first.metadata?.nextOffset as number, limit: 2 },
      makeCtx(),
    );
    expect(String(second.content).split('\n').slice(0, 2)).toEqual(['f2.txt (1 bytes)', 'f3.txt (1 bytes)']);
  });

  it('list_directory: без offset/limit — весь каталог, nextOffset на конце', async () => {
    await writeFile(join(tmpDir, 'only.txt'), 'x');

    const out = await listDirectoryTool.execute({}, makeCtx());

    expect(out.content).toContain('only.txt');
    expect(out.metadata).toMatchObject({ offset: 0, limit: 2000, truncated: false, nextOffset: 1 });
  });
});

describe('glob — hidden/limit/сортировка (через rg --files)', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-glob-'));
    await mkdir(join(tmpDir, 'src'), { recursive: true });
    await mkdir(join(tmpDir, '.git'), { recursive: true });
    await writeFile(join(tmpDir, 'b.ts'), 'b');
    await writeFile(join(tmpDir, 'a.ts'), 'a');
    await writeFile(join(tmpDir, 'src', 'c.ts'), 'c');
    await writeFile(join(tmpDir, '.hidden.ts'), 'h');
    await writeFile(join(tmpDir, '.git', 'config'), 'gitconfig');
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
    return { sessionId: 's1', messageId: 'm1', workingDir: tmpDir, ...overrides };
  }

  it('скрытые файлы по умолчанию не попадают в вывод', async () => {
    const out = await globTool.execute({ pattern: '*.ts' }, makeCtx());
    expect(out.isError).toBeFalsy();
    expect(out.content).not.toContain('.hidden.ts');
  });

  it('hidden=true включает скрытые, но не .git', async () => {
    const out = await globTool.execute({ pattern: '**/*', hidden: true }, makeCtx());
    const lines = String(out.content).split('\n');
    expect(lines).toContain('.hidden.ts');
    expect(lines.some((l) => l.startsWith('.git/'))).toBe(false);
  });

  it('результат отсортирован по возрастанию', async () => {
    const out = await globTool.execute({ pattern: '*.ts' }, makeCtx());
    const lines = String(out.content).split('\n');
    expect(lines).toEqual([...lines].sort());
    expect(lines).toEqual(['a.ts', 'b.ts', 'src/c.ts']);
  });

  it('limit обрезает вывод и добавляет маркер', async () => {
    const out = await globTool.execute({ pattern: '*.ts', limit: 2 }, makeCtx());
    const lines = String(out.content).split('\n');
    expect(lines).toHaveLength(3);
    expect(lines.slice(0, 2)).toEqual(['a.ts', 'b.ts']);
    expect(lines[2]).toContain('showing the first 2 of 3 files');
    expect(out.metadata).toMatchObject({ count: 2, total: 3, truncated: true });
  });

  it('нет совпадений → сообщение, а не ошибка', async () => {
    const out = await globTool.execute({ pattern: '*.nope' }, makeCtx());
    expect(out.isError).toBeFalsy();
    expect(out.content).toContain('no files found');
    expect(out.metadata).toMatchObject({ count: 0, total: 0 });
    expect(out.metadata?.i18n).toEqual({ key: 'fsread.no_files' });
  });

  it('описание не обещает сортировку по mtime', async () => {
    expect(globTool.description ?? '').not.toContain('modification time');
    expect(globTool.description ?? '').toContain('sorted by name');
  });
});

/**
 * ADR-115: `read_file` для изображений/PDF — приём файла как вложения
 * текущего хода (по образцу opencode: бинарный файл-картинка отдаётся модели,
 * а не отказом с подсказкой).
 *
 * Сервис вложений — объектный мок: проверяется поведение тула, а не
 * `AttachmentService` (у него свой suite). MIME в моке считается тем же
 * детектором по сигнатуре, что и в сервисе (`attachments/sniff-mime.ts`).
 */
describe('read_file — изображение/PDF как вложение текущего хода (ADR-115)', () => {
  let tmpDir: string;
  let uploads: Array<{ bytes: Buffer; name?: string }>;

  /** PNG-сигнатура + хвост (файл бинарный — как текст не читается). */
  const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0x02, 0x03]);
  /** PDF с бинарным хвостом. */
  const PDF_BYTES = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.from([0x00, 0x01, 0x02])]);

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-fsread-media-'));
    uploads = [];
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  /** Мок сервиса вложений: content-addressed путь и MIME по сигнатуре. */
  function makeService(overrides: Record<string, unknown> = {}): AttachmentService {
    return {
      upload: vi.fn(async ({ bytes, name }: { bytes: Buffer; name?: string }) => {
        uploads.push({ bytes, ...(name ? { name } : {}) });
        const sha256 = createHash('sha256').update(bytes).digest('hex');
        const blobPath = `attachments/${sha256.slice(0, 2)}/${sha256}`;
        return {
          id: blobPath,
          blobPath,
          sha256,
          mime: sniffMime(bytes) ?? 'application/octet-stream',
          size: bytes.length,
          ...(name ? { name } : {}),
        };
      }),
      ...overrides,
    } as unknown as AttachmentService;
  }

  /** Live-конфиг вложений (по умолчанию — дефолты схемы). */
  function config(overrides: Partial<AttachmentsConfig> = {}): () => AttachmentsConfig {
    return () => ({ ...attachmentsConfigSchema.parse({}), ...overrides });
  }

  function makeCtx(extra: Record<string, unknown> = {}): ToolContext {
    return { sessionId: 's1', messageId: 'm1', workingDir: tmpDir, extra };
  }

  /** Ключ i18n отказа (машинный код проверки — без текста). */
  function errorKey(result: { metadata?: Record<string, unknown> }): string | undefined {
    return (result.metadata?.i18n as { key?: string } | undefined)?.key;
  }

  it('image/png (по сигнатуре) → вложение текущего хода + текстовый результат', async () => {
    await writeFile(join(tmpDir, 'shot.png'), PNG_BYTES);
    const service = makeService();

    const out = await readFileTool.execute(
      { file_path: 'shot.png' },
      makeCtx({ attachmentService: service, attachmentsConfig: config() }),
    );

    expect(out.isError).toBeFalsy();
    expect(out.attachments).toHaveLength(1);
    expect(out.attachments?.[0]).toMatchObject({ mime: 'image/png', size: PNG_BYTES.length });
    expect(out.attachments?.[0]?.blobPath).toMatch(/^attachments\/[0-9a-f]{2}\/[0-9a-f]{64}$/);
    expect(out.attachments?.[0]?.sha256).toMatch(/^[0-9a-f]{64}$/);
    // Текст результата — краткая сводка (путь, mime, размер).
    expect(out.content).toContain('shot.png');
    expect(out.content).toContain('image/png');
    expect(out.content).toContain(String(PNG_BYTES.length));
    expect(out.metadata).toMatchObject({ type: 'media', mime: 'image/png', size: PNG_BYTES.length });
    // Байты ушли в сервис вложений (единственная точка записи) — с именем файла.
    expect(uploads).toHaveLength(1);
    expect(uploads[0]?.name).toBe('shot.png');
  });

  it('application/pdf → вложение текущего хода', async () => {
    await writeFile(join(tmpDir, 'doc.pdf'), PDF_BYTES);
    const service = makeService();

    const out = await readFileTool.execute(
      { file_path: 'doc.pdf' },
      makeCtx({ attachmentService: service, attachmentsConfig: config() }),
    );

    expect(out.isError).toBeFalsy();
    expect(out.attachments).toHaveLength(1);
    expect(out.attachments?.[0]).toMatchObject({ mime: 'application/pdf', size: PDF_BYTES.length });
    expect(out.content).toContain('application/pdf');
    expect(out.metadata).toMatchObject({ type: 'media', mime: 'application/pdf' });
  });

  it('текстовый PDF (без бинарных байт) тоже принимается — важна сигнатура', async () => {
    await writeFile(join(tmpDir, 'text.pdf'), '%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n');
    const service = makeService();

    const out = await readFileTool.execute(
      { file_path: 'text.pdf' },
      makeCtx({ attachmentService: service, attachmentsConfig: config() }),
    );

    expect(out.isError).toBeFalsy();
    expect(out.attachments?.[0]).toMatchObject({ mime: 'application/pdf' });
    expect(uploads).toHaveLength(1);
  });

  it('вложения выключены → прежняя ошибка с подсказкой (файл не загружен)', async () => {
    await writeFile(join(tmpDir, 'shot.png'), PNG_BYTES);
    const service = makeService();

    const out = await readFileTool.execute(
      { file_path: 'shot.png' },
      makeCtx({ attachmentService: service, attachmentsConfig: config({ enabled: false }) }),
    );

    expect(out.isError).toBe(true);
    expect(out.content).toContain('binary file');
    expect(out.content).toContain('attach_workspace_file');
    expect(out.metadata?.type).toBe('binary');
    expect(out.attachments).toBeUndefined();
    expect(uploads).toHaveLength(0);
  });

  it('сервис вложений недоступен → прежняя ошибка (без падения)', async () => {
    await writeFile(join(tmpDir, 'shot.png'), PNG_BYTES);

    const out = await readFileTool.execute(
      { file_path: 'shot.png' },
      makeCtx({ attachmentsConfig: config() }),
    );

    expect(out.isError).toBe(true);
    expect(out.content).toContain('binary file');
    expect(out.attachments).toBeUndefined();
    expect(uploads).toHaveLength(0);
  });

  it('неизвестный бинарь → прежнее поведение (ошибка, без вложения)', async () => {
    await writeFile(join(tmpDir, 'blob.bin'), Buffer.from([0x00, 0x01, 0x02, 0x00, 0xff, 0x00]));
    const service = makeService();

    const out = await readFileTool.execute(
      { file_path: 'blob.bin' },
      makeCtx({ attachmentService: service, attachmentsConfig: config() }),
    );

    expect(out.isError).toBe(true);
    expect(out.content).toContain('binary file');
    expect(out.metadata?.type).toBe('binary');
    expect(out.attachments).toBeUndefined();
    expect(uploads).toHaveLength(0);
  });

  it('превышение лимита размера → понятная ошибка (файл не читается)', async () => {
    await writeFile(join(tmpDir, 'shot.png'), PNG_BYTES);
    const service = makeService();

    const out = await readFileTool.execute(
      { file_path: 'shot.png' },
      makeCtx({ attachmentService: service, attachmentsConfig: config({ maxBytesPerFile: 4 }) }),
    );

    expect(out.isError).toBe(true);
    expect(out.content).toContain(String(PNG_BYTES.length));
    expect(out.content).toContain('4');
    expect(errorKey(out)).toBe('attach.tool.too_large');
    expect(out.attachments).toBeUndefined();
    expect(uploads).toHaveLength(0);
  });

  it('запрещённый MIME сервисом → понятная ошибка (без падения)', async () => {
    await writeFile(join(tmpDir, 'shot.png'), PNG_BYTES);
    const service = makeService({
      upload: vi.fn(async () => {
        throw new AttachmentError('unsupported_mime', 'Type image/png is not allowed');
      }),
    });

    const out = await readFileTool.execute(
      { file_path: 'shot.png' },
      makeCtx({ attachmentService: service, attachmentsConfig: config() }),
    );

    expect(out.isError).toBe(true);
    expect(errorKey(out)).toBe('attach.tool.unsupported_mime');
    expect(out.content).toContain('not allowed');
    expect(out.attachments).toBeUndefined();
  });

  it('SVG остаётся текстом (его запрещает сервис вложений)', async () => {
    await writeFile(join(tmpDir, 'icon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>');
    const service = makeService();

    const out = await readFileTool.execute(
      { file_path: 'icon.svg' },
      makeCtx({ attachmentService: service, attachmentsConfig: config() }),
    );

    expect(out.isError).toBeFalsy();
    expect(out.content).toContain('<svg');
    expect(out.attachments).toBeUndefined();
    expect(uploads).toHaveLength(0);
  });

  it('текстовый файл — прежнее поведение (текст, без вложения)', async () => {
    await writeFile(join(tmpDir, 'a.txt'), 'hello\n');
    const service = makeService();

    const out = await readFileTool.execute(
      { file_path: 'a.txt' },
      makeCtx({ attachmentService: service, attachmentsConfig: config() }),
    );

    expect(out.isError).toBeFalsy();
    expect(out.content).toContain('hello');
    expect(out.metadata?.type).toBe('file');
    expect(out.attachments).toBeUndefined();
    expect(uploads).toHaveLength(0);
  });
});

/**
 * PROP-135 (Ф1): `list_directory` читает каталог **через порт исполнения**.
 *
 * В remote-режиме рабочий каталог лежит на исполнителе, поэтому листинг
 * уезжает туда; control plane лишь спрашивает канонический путь для проверки
 * периметра. Здесь порт подменяется — проверяется контракт тула: записи
 * берутся у порта, ошибки FS различимы, а «FS недоступна» и «симлинк-побег»
 * отличаются друг от друга.
 */
describe('list_directory — работа через порт исполнения (PROP-135 Ф1)', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-fsread-port-'));
    await mkdir(join(tmpDir, 'src'), { recursive: true });
    await writeFile(join(tmpDir, 'src', 'a.ts'), 'export const a = 1;\n');
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  /** Порт с подменённой FS-реализацией (записи и ошибки — из порта). */
  class FakeFsPort implements ExecutionPort {
    readonly requests: ExecRequest[] = [];
    readonly fs?: ExecutionFs;

    constructor(fs?: Partial<ExecutionFs>) {
      // Методы по умолчанию — «порта нет»: их подменяет конкретный тест.
      this.fs = fs
        ? {
            realpath: async (path) => path,
            stat: async () => ({ kind: 'file', size: 0, mtimeMs: 0 }),
            readdir: async () => [],
            readText: async () => ({ lines: [], totalLines: 0, truncated: false, bytes: 0 }),
            sniff: async () => ({ binary: false }),
            readBytes: async () => ({ dataBase64: '', size: 0 }),
            writeFile: async () => undefined,
            mkdir: async () => undefined,
            remove: async () => undefined,
            readRawText: async () => ({ text: '', size: 0 }),
            rename: async () => undefined,
            download: async () => Buffer.alloc(0),
            upload: async () => undefined,
            hash: async () => '',
            ...fs,
          }
        : undefined;
    }

    async execute(req: ExecRequest): Promise<ExecResult> {
      this.requests.push(req);
      return { stdout: '', stderr: '', exitCode: 0, truncated: false, durationMs: 0 };
    }
  }

  function makeCtx(port: ExecutionPort, overrides: Partial<ToolContext> = {}): ToolContext {
    return {
      sessionId: 's1',
      messageId: 'm1',
      workingDir: tmpDir,
      extra: { executionPort: port },
      ...overrides,
    };
  }

  it('каталог читается через порт: записи — из FS-реализации порта', async () => {
    const calls: string[] = [];
    const port = new FakeFsPort({
      realpath: async (path) => {
        calls.push(`realpath:${path}`);
        return path;
      },
      stat: async () => ({ kind: 'directory', size: 0, mtimeMs: 0 }),
      readdir: async () => [
        { name: 'remote-dir', kind: 'directory', size: 4096 },
        { name: 'remote.txt', kind: 'file', size: 7 },
      ],
    });

    const result = await listDirectoryTool.execute({ path: '.' }, makeCtx(port));

    expect(result.isError).toBeFalsy();
    // Записи пришли из порта, а не из локальной ФС.
    expect(result.content).toContain('remote-dir/ (4096 bytes)');
    expect(result.content).toContain('remote.txt (7 bytes)');
    expect(result.content).not.toContain('src/');
    expect(calls.some((call) => call.startsWith('realpath:'))).toBe(true);
  });

  it('сортировка — каталоги первыми, затем по имени (формат прежний)', async () => {
    const port = new FakeFsPort({
      realpath: async (path) => path,
      stat: async () => ({ kind: 'directory', size: 0, mtimeMs: 0 }),
      readdir: async () => [
        { name: 'b.txt', kind: 'file', size: 1 },
        { name: 'zdir', kind: 'directory', size: 2 },
        { name: 'a.txt', kind: 'file', size: 3 },
        { name: 'adir', kind: 'directory', size: 4 },
      ],
    });

    const result = await listDirectoryTool.execute({ path: '.' }, makeCtx(port));

    expect(String(result.content).split('\n')).toEqual([
      'adir/ (4 bytes)',
      'zdir/ (2 bytes)',
      'a.txt (3 bytes)',
      'b.txt (1 bytes)',
    ]);
  });

  it('ошибка FS — isError с различимым кодом', async () => {
    const port = new FakeFsPort({
      realpath: async (path) => path,
      stat: async () => ({ kind: 'directory', size: 0, mtimeMs: 0 }),
      readdir: async () => {
        throw new FsPathError('not_found', '/nope', 'путь не найден: /nope');
      },
    });

    const result = await listDirectoryTool.execute({ path: 'nope' }, makeCtx(port));

    expect(result.isError).toBe(true);
    expect(result.content).toContain('путь не найден');
    expect(result.metadata?.code).toBe('not_found');
    expect(result.metadata?.path).toBe(join(tmpDir, 'nope'));
  });

  it('порт без FS (исполнитель не объявил features.fs) — понятная ошибка', async () => {
    const port = new FakeFsPort(undefined);
    const result = await listDirectoryTool.execute({ path: '.' }, makeCtx(port));

    expect(result.isError).toBe(true);
    expect(result.content).toContain('Filesystem operations are unavailable');
  });

  it('симлинк-побег (realpath вне корней) — отказ, каталог не листится', async () => {
    const port = new FakeFsPort({
      // Корень — сам по себе, кандидат — «наружу».
      realpath: async (path) => (path === tmpDir ? path : '/etc/evil'),
      stat: async () => ({ kind: 'directory', size: 0, mtimeMs: 0 }),
      readdir: async () => [{ name: 'secret', kind: 'file', size: 1 }],
    });

    const result = await listDirectoryTool.execute({ path: 'link' }, makeCtx(port));

    expect(result.isError).toBe(true);
    expect(result.content).not.toContain('secret');
    expect((result.metadata?.i18n as { key?: string })?.key).toBe('permission.external_directory_default');
  });
});

/**
 * PROP-135 (Ф1, слайс 2): `read_file` читает **содержимое** файла через порт
 * исполнения.
 *
 * В remote-топологии рабочий каталог живёт на исполнителе, поэтому текст,
 * признак «бинарь» и байты медиа приходят оттуда; control plane лишь
 * спрашивает канонический путь для проверки периметра. Порт подменяется —
 * проверяется контракт тула: запросы уходят в порт, ошибки FS различимы,
 * а «FS недоступна» не путается с «пути нет».
 */
describe('read_file — чтение содержимого через порт исполнения (PROP-135 Ф1)', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-fsread-content-'));
    await mkdir(join(tmpDir, 'sub'), { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  /** Порт с подменённой FS-реализацией (содержимое — из порта). */
  class FakeFsPort implements ExecutionPort {
    readonly requests: ExecRequest[] = [];
    readonly fs?: ExecutionFs;

    constructor(fs?: Partial<ExecutionFs>) {
      this.fs = fs
        ? {
            realpath: async (path) => path,
            stat: async () => ({ kind: 'file', size: 0, mtimeMs: 0 }),
            readdir: async () => [],
            readText: async () => ({ lines: [], totalLines: 0, truncated: false, bytes: 0 }),
            sniff: async () => ({ binary: false }),
            readBytes: async () => ({ dataBase64: '', size: 0 }),
            writeFile: async () => undefined,
            mkdir: async () => undefined,
            remove: async () => undefined,
            readRawText: async () => ({ text: '', size: 0 }),
            rename: async () => undefined,
            download: async () => Buffer.alloc(0),
            upload: async () => undefined,
            hash: async () => '',
            ...fs,
          }
        : undefined;
    }

    async execute(req: ExecRequest): Promise<ExecResult> {
      this.requests.push(req);
      return { stdout: '', stderr: '', exitCode: 0, truncated: false, durationMs: 0 };
    }
  }

  function makeCtx(port: ExecutionPort, overrides: Partial<ToolContext> = {}): ToolContext {
    return {
      sessionId: 's1',
      messageId: 'm1',
      workingDir: tmpDir,
      extra: { executionPort: port },
      ...overrides,
    };
  }

  it('текст читается через порт: строки и метаданные — из FS-реализации', async () => {
    const calls: string[] = [];
    const port = new FakeFsPort({
      stat: async () => ({ kind: 'file', size: 12, mtimeMs: 0 }),
      sniff: async () => ({ binary: false }),
      readText: async (_path, opts) => {
        calls.push(`readText:${JSON.stringify(opts)}`);
        return {
          lines: ['1: первая', '2: вторая'],
          totalLines: 2,
          truncated: false,
          bytes: 20,
        };
      },
    });

    const result = await readFileTool.execute({ file_path: 'a.txt', offset: 0, limit: 2 }, makeCtx(port));

    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('1: первая');
    expect(result.content).toContain('2: вторая');
    expect(result.metadata).toMatchObject({ type: 'file', totalLines: 2, truncated: false, bytes: 20 });
    // Смещение/потолок уходят в порт — он решает, что читать.
    expect(calls).toEqual(['readText:{"offset":0,"limit":2}']);
  });

  it('бинарный файл — отказ с подсказкой (признак пришёл из порта)', async () => {
    const port = new FakeFsPort({
      stat: async () => ({ kind: 'file', size: 6, mtimeMs: 0 }),
      sniff: async () => ({ binary: true }),
    });

    const result = await readFileTool.execute({ file_path: 'blob.bin' }, makeCtx(port));

    expect(result.isError).toBe(true);
    expect(result.content).toContain('binary file');
    expect(result.metadata).toMatchObject({ type: 'binary' });
  });

  it('медиа: байты берутся из порта (readBytes) и уходят в сервис вложений', async () => {
    const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);
    const uploads: Array<{ bytes: Buffer; name?: string }> = [];
    const service = {
      upload: vi.fn(async ({ bytes, name }: { bytes: Buffer; name?: string }) => {
        uploads.push({ bytes, ...(name ? { name } : {}) });
        const sha256 = createHash('sha256').update(bytes).digest('hex');
        return {
          id: `attachments/${sha256}`,
          blobPath: `attachments/${sha256.slice(0, 2)}/${sha256}`,
          sha256,
          mime: 'image/png',
          size: bytes.length,
          ...(name ? { name } : {}),
        };
      }),
    } as unknown as AttachmentService;

    let asked: number | undefined;
    const port = new FakeFsPort({
      stat: async () => ({ kind: 'file', size: PNG_BYTES.length, mtimeMs: 0 }),
      sniff: async () => ({ binary: true, mime: 'image/png' }),
      readBytes: async (_path, maxBytes) => {
        asked = maxBytes;
        return { dataBase64: PNG_BYTES.toString('base64'), size: PNG_BYTES.length };
      },
    });

    const result = await readFileTool.execute(
      { file_path: 'shot.png' },
      makeCtx(port, { extra: { executionPort: port, attachmentService: service } }),
    );

    expect(result.isError).toBeFalsy();
    expect(result.attachments).toHaveLength(1);
    expect(result.attachments?.[0]).toMatchObject({ mime: 'image/png' });
    expect(uploads).toHaveLength(1);
    expect(uploads[0]?.bytes.equals(PNG_BYTES)).toBe(true);
    // Потолок перевозки медиа — константа тула (временное ограничение Ф1).
    expect(asked).toBe(MEDIA_TRANSPORT_CAP);
  });

  it('медиа больше потолка перевозки — too_large (файл не читается)', async () => {
    const port = new FakeFsPort({
      stat: async () => ({ kind: 'file', size: MEDIA_TRANSPORT_CAP + 1, mtimeMs: 0 }),
      sniff: async () => ({ binary: true, mime: 'image/png' }),
      readBytes: async () => {
        throw new FsPathError('too_large', '/big.png', 'файл больше лимита');
      },
    });

    const result = await readFileTool.execute({ file_path: 'big.png' }, makeCtx(port));

    expect(result.isError).toBe(true);
    expect(result.metadata).toMatchObject({ type: 'media', reason: 'too_large', limit: MEDIA_TRANSPORT_CAP });
    expect(result.content).toContain(String(MEDIA_TRANSPORT_CAP));
  });

  it('ошибка FS (пути нет) — isError с различимым кодом', async () => {
    const port = new FakeFsPort({
      stat: async () => {
        throw new FsPathError('not_found', '/nope', 'путь не найден: /nope');
      },
    });

    const result = await readFileTool.execute({ file_path: 'nope.txt' }, makeCtx(port));

    expect(result.isError).toBe(true);
    expect(result.content).toContain('путь не найден');
    expect(result.metadata?.code).toBe('not_found');
    expect(result.metadata?.path).toBe(join(tmpDir, 'nope.txt'));
  });

  it('каталог читается через порт (readdir), а не локально', async () => {
    const port = new FakeFsPort({
      stat: async () => ({ kind: 'directory', size: 0, mtimeMs: 0 }),
      readdir: async () => [{ name: 'remote.txt', kind: 'file', size: 7 }],
    });

    const result = await readFileTool.execute({ file_path: '.' }, makeCtx(port));

    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('remote.txt (7 bytes)');
    expect(result.metadata).toMatchObject({ type: 'directory', totalEntries: 1 });
  });

  it('порт без FS (исполнитель не объявил features.fs) — понятная ошибка', async () => {
    const port = new FakeFsPort(undefined);
    const result = await readFileTool.execute({ file_path: 'a.txt' }, makeCtx(port));

    expect(result.isError).toBe(true);
    expect(result.content).toContain('Filesystem operations are unavailable');
  });

  it('симлинк-побег (realpath вне корней) — отказ, файл не читается', async () => {
    let read = false;
    const port = new FakeFsPort({
      realpath: async (path) => (path === tmpDir ? path : '/etc/evil'),
      stat: async () => ({ kind: 'file', size: 3, mtimeMs: 0 }),
      sniff: async () => ({ binary: false }),
      readText: async () => {
        read = true;
        return { lines: ['1: secret'], totalLines: 1, truncated: false, bytes: 8 };
      },
    });

    const result = await readFileTool.execute({ file_path: 'link' }, makeCtx(port));

    expect(result.isError).toBe(true);
    expect(result.content).not.toContain('secret');
    expect(read).toBe(false);
  });
});
