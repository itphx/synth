import { describe, it, expect } from 'vitest';
import {
  fileKind,
  fileMime,
  INLINE_PREVIEW_KINDS,
  type FileKind,
} from './file-kind.js';

describe('fileKind (классификация файла по расширению)', () => {
  it('markdown: .md/.markdown/.mdown', () => {
    expect(fileKind('notes.md')).toBe('markdown');
    expect(fileKind('notes.markdown')).toBe('markdown');
    expect(fileKind('notes.mdown')).toBe('markdown');
  });

  it('image: растровые и векторные расширения', () => {
    for (const ext of ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'svg', 'avif', 'tif', 'tiff']) {
      expect(fileKind(`photo.${ext}`)).toBe('image');
    }
  });

  it('video: .mp4/.m4v/.webm/.mov/.ogv/.avi/.mkv', () => {
    for (const ext of ['mp4', 'm4v', 'webm', 'mov', 'ogv', 'avi', 'mkv']) {
      expect(fileKind(`clip.${ext}`)).toBe('video');
    }
  });

  it('audio: .mp3/.wav/.ogg/.oga/.flac/.m4a/.aac/.opus', () => {
    for (const ext of ['mp3', 'wav', 'ogg', 'oga', 'flac', 'm4a', 'aac', 'opus']) {
      expect(fileKind(`sound.${ext}`)).toBe('audio');
    }
  });

  it('pdf: .pdf', () => {
    expect(fileKind('doc.pdf')).toBe('pdf');
  });

  it('code: исходники и конфиги (в т.ч. html/css/js)', () => {
    for (const ext of ['js', 'ts', 'tsx', 'py', 'go', 'rs', 'java', 'sh', 'html', 'htm', 'css', 'scss', 'sql', 'yaml', 'yml', 'json', 'toml']) {
      expect(fileKind(`main.${ext}`)).toBe('code');
    }
  });

  it('text: .txt/.csv/.log/.env и прочие текстовые', () => {
    for (const ext of ['txt', 'csv', 'log', 'env', 'ini', 'conf', 'patch', 'diff', 'rst']) {
      expect(fileKind(`data.${ext}`)).toBe('text');
    }
  });

  it('binary: архивы, exe, шрифты, .bin и прочее неизвестное', () => {
    for (const ext of ['zip', 'gz', 'tar', 'exe', 'dll', 'so', 'woff2', 'ttf', 'bin', 'dat', 'iso', 'xyz']) {
      expect(fileKind(`blob.${ext}`)).toBe('binary');
    }
  });

  it('регистронезависимо: .PNG/.JPG/.Md', () => {
    expect(fileKind('PHOTO.PNG')).toBe('image');
    expect(fileKind('Photo.JpEg')).toBe('image');
    expect(fileKind('README.MD')).toBe('markdown');
    expect(fileKind('Main.TS')).toBe('code');
  });

  it('путь с директориями: расширение берётся из имени файла', () => {
    expect(fileKind('src/components/Button.tsx')).toBe('code');
    expect(fileKind('/abs/path/clip.mp4')).toBe('video');
    expect(fileKind('dir.with.dots/file.txt')).toBe('text');
  });

  it('без расширения и с неизвестным — binary (консервативно)', () => {
    expect(fileKind('Makefile')).toBe('binary');
    expect(fileKind('README')).toBe('binary');
    expect(fileKind('')).toBe('binary');
  });
});

describe('fileMime (MIME по расширению)', () => {
  it('изображения', () => {
    expect(fileMime('a.png')).toBe('image/png');
    expect(fileMime('a.jpg')).toBe('image/jpeg');
    expect(fileMime('a.jpeg')).toBe('image/jpeg');
    expect(fileMime('a.gif')).toBe('image/gif');
    expect(fileMime('a.webp')).toBe('image/webp');
    expect(fileMime('a.bmp')).toBe('image/bmp');
    expect(fileMime('a.ico')).toBe('image/x-icon');
    expect(fileMime('a.avif')).toBe('image/avif');
    expect(fileMime('a.tif')).toBe('image/tiff');
  });

  it('SVG — отдельный MIME (image/svg+xml), не бинарник', () => {
    expect(fileMime('a.svg')).toBe('image/svg+xml');
    expect(fileKind('a.svg')).toBe('image');
  });

  it('видео и аудио', () => {
    expect(fileMime('a.mp4')).toBe('video/mp4');
    expect(fileMime('a.m4v')).toBe('video/mp4');
    expect(fileMime('a.webm')).toBe('video/webm');
    expect(fileMime('a.mov')).toBe('video/quicktime');
    expect(fileMime('a.ogv')).toBe('video/ogg');
    expect(fileMime('a.mp3')).toBe('audio/mpeg');
    expect(fileMime('a.wav')).toBe('audio/wav');
    expect(fileMime('a.ogg')).toBe('audio/ogg');
    expect(fileMime('a.flac')).toBe('audio/flac');
    expect(fileMime('a.opus')).toBe('audio/opus');
  });

  it('pdf и текст', () => {
    expect(fileMime('a.pdf')).toBe('application/pdf');
    expect(fileMime('a.md')).toBe('text/markdown');
    expect(fileMime('a.txt')).toBe('text/plain');
    expect(fileMime('a.json')).toBe('application/json');
    expect(fileMime('a.csv')).toBe('text/csv');
  });

  it('binary/неизвестное → application/octet-stream', () => {
    expect(fileMime('a.zip')).toBe('application/octet-stream');
    expect(fileMime('a.exe')).toBe('application/octet-stream');
    expect(fileMime('a.unknownext')).toBe('application/octet-stream');
    expect(fileMime('Makefile')).toBe('application/octet-stream');
  });

  it('регистронезависимо', () => {
    expect(fileMime('A.PNG')).toBe('image/png');
    expect(fileMime('A.MP4')).toBe('video/mp4');
  });
});

describe('INLINE_PREVIEW_KINDS (allow-list inline-предпросмотра)', () => {
  it('содержит только media/pdf — текст, код и html исключены', () => {
    expect(INLINE_PREVIEW_KINDS).toEqual(['image', 'video', 'audio', 'pdf']);
    for (const kind of ['text', 'markdown', 'code', 'binary'] as FileKind[]) {
      expect(INLINE_PREVIEW_KINDS).not.toContain(kind);
    }
  });
});
