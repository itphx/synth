/**
 * AD-069 §3.5 (R5) / AD-046 §8.3: тесты generic-подписей файлов — стабильность,
 * инвалидация по mtime/размеру, маркеры отсутствия, приоритет имён в каталоге.
 */

import { describe, it, expect } from 'vitest';
import { filesSignature, dirsSignature, MISSING_SIGNATURE_MARKER } from './file-signature.js';

describe('filesSignature', () => {
  it('идентична при неизменных файлах и не зависит от порядка входов', async () => {
    const statFn = async () => ({ mtimeMs: 1000.9, size: 10 });
    const a = await filesSignature(
      [
        { id: 'x', path: '/x' },
        { id: 'y', path: '/y' },
      ],
      statFn,
    );
    const b = await filesSignature(
      [
        { id: 'y', path: '/y' },
        { id: 'x', path: '/x' },
      ],
      statFn,
    );
    expect(a).toBe(b);
    expect(a).toBe('x:1000:10|y:1000:10');
  });

  it('изменение mtime и размера даёт другую подпись', async () => {
    const base = await filesSignature([{ id: 'x', path: '/x' }], async () => ({
      mtimeMs: 1000,
      size: 10,
    }));
    const mtimeChanged = await filesSignature([{ id: 'x', path: '/x' }], async () => ({
      mtimeMs: 2000,
      size: 10,
    }));
    const sizeChanged = await filesSignature([{ id: 'x', path: '/x' }], async () => ({
      mtimeMs: 1000,
      size: 11,
    }));
    expect(mtimeChanged).not.toBe(base);
    expect(sizeChanged).not.toBe(base);
  });

  it('отсутствующий файл помечается маркером и стабилен', async () => {
    const statFn = async (path: string) => {
      if (path.endsWith('/missing')) throw new Error('ENOENT');
      return { mtimeMs: 5, size: 1 };
    };
    const a = await filesSignature(
      [
        { id: 'present', path: '/present' },
        { id: 'gone', path: '/missing' },
      ],
      statFn,
    );
    const b = await filesSignature(
      [
        { id: 'present', path: '/present' },
        { id: 'gone', path: '/missing' },
      ],
      statFn,
    );
    expect(a).toBe(b);
    expect(a).toContain(`gone:${MISSING_SIGNATURE_MARKER}`);
    expect(a).toContain('present:5:1');
  });

  it('path: null — стабильный маркер отсутствующего кандидата', async () => {
    const sig = await filesSignature([{ id: 'dir', path: null }], async () => {
      throw new Error('stat не должен вызываться');
    });
    expect(sig).toBe(`dir:${MISSING_SIGNATURE_MARKER}`);
  });
});

describe('dirsSignature', () => {
  it('берёт первое существующее имя из списка (приоритет)', async () => {
    const statFn = async (path: string) => {
      if (path.endsWith('/AGENTS.override.md')) throw new Error('ENOENT');
      if (path.endsWith('/AGENTS.md')) return { mtimeMs: 7, size: 3 };
      throw new Error('ENOENT');
    };
    const sig = await dirsSignature(['/a'], ['AGENTS.override.md', 'AGENTS.md'], statFn);
    expect(sig).toBe('/a:AGENTS.md:7:3');
  });

  it('если ни одного имени нет — маркер каталога', async () => {
    const sig = await dirsSignature(['/a'], ['AGENTS.md'], async () => {
      throw new Error('ENOENT');
    });
    expect(sig).toBe(`/a:${MISSING_SIGNATURE_MARKER}`);
  });

  it('смена выбранного имени меняет подпись; результат отсортирован', async () => {
    const onlyAgents = async (path: string) => {
      if (path.endsWith('/AGENTS.override.md')) throw new Error('ENOENT');
      return { mtimeMs: 7, size: 3 };
    };
    const withOverride = async () => ({ mtimeMs: 9, size: 4 });
    const a = await dirsSignature(['/b', '/a'], ['AGENTS.override.md', 'AGENTS.md'], onlyAgents);
    const b = await dirsSignature(['/b', '/a'], ['AGENTS.override.md', 'AGENTS.md'], withOverride);
    expect(a).not.toBe(b);
    // отсортировано по строке каталога (a → b)
    expect(a.indexOf('/a:')).toBeLessThan(a.indexOf('/b:'));
  });
});
