// PROP-032 (W2.4): специфика in-memory `DocumentRepository` — детерминированный
// порядок `list()`, глубокая изоляция значений и независимость экземпляров.
// Общий паспорт порта — `contract/memory.test.ts` (`describeDocumentRepository`).
import { describe, it, expect } from 'vitest';
import { MemoryDocumentRepository } from './document-repository.js';

interface Doc {
  id: string;
  nested: { n: number };
}

describe('MemoryDocumentRepository (PROP-032, W2.4)', () => {
  it('list детерминирован по ключу', async () => {
    const repo = new MemoryDocumentRepository<Doc>();
    await repo.save('zeta', { id: 'zeta', nested: { n: 1 } });
    await repo.save('alpha', { id: 'alpha', nested: { n: 2 } });
    await repo.save('mid', { id: 'mid', nested: { n: 3 } });

    expect((await repo.list()).map((d) => d.id)).toEqual(['alpha', 'mid', 'zeta']);
  });

  it('глубокая изоляция: мутация входа/выхода не меняет стор', async () => {
    const repo = new MemoryDocumentRepository<Doc>();
    const value: Doc = { id: 'a', nested: { n: 1 } };
    await repo.save('a', value);
    value.nested.n = 99;
    expect((await repo.load('a'))?.nested.n).toBe(1);

    const loaded = await repo.load('a');
    loaded!.nested.n = 42;
    expect((await repo.load('a'))?.nested.n).toBe(1);
  });

  it('два экземпляра не делят данные', async () => {
    const a = new MemoryDocumentRepository<Doc>();
    const b = new MemoryDocumentRepository<Doc>();
    await a.save('k', { id: 'k', nested: { n: 1 } });
    expect(await b.load('k')).toBeNull();
    expect(await b.list()).toEqual([]);
  });
});
