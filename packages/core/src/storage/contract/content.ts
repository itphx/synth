import { describe, expect, it } from 'vitest';
import type {
  ContextFileRepository,
  DictionaryRepository,
  DocumentRepository,
  McpRegistryRepository,
  ProtectedPathsRepository,
  SecretPatternRepository,
  SkillBundleRepository,
  SkillRepository,
} from '../ports/index.js';
import type { McpServerConfig, SkillBundle } from '@itphx/synth-shared';

const mcpConfig = { command: 'echo' } as unknown as McpServerConfig;

const bundle = (name: string): SkillBundle =>
  ({ name, description: `bundle ${name}`, skills: ['a'] }) as unknown as SkillBundle;

/** Паспорт порта `McpRegistryRepository`: уникальность имени, CRUD. */
export function describeMcpRegistryRepository(
  name: string,
  make: () => Promise<{ repo: McpRegistryRepository; dispose?: () => Promise<void> }>,
): void {
  describe(name, () => {
    it('add/get/getByName/update/remove; неизвестный — null/false; list пустого — []', async () => {
      const { repo } = await make();
      expect(await repo.list()).toEqual([]);
      expect(await repo.get('none')).toBeNull();
      expect(await repo.getByName('none')).toBeNull();
      expect(await repo.remove('none')).toBe(false);

      const entry = await repo.add({ name: 'srv', config: mcpConfig, origin: 'instance' });
      expect((await repo.get(entry.id))?.name).toBe('srv');
      expect((await repo.getByName('srv'))?.id).toBe(entry.id);

      const updated = await repo.update(entry.id, { enabled: false });
      expect(updated?.enabled).toBe(false);
      expect(await repo.remove(entry.id)).toBe(true);
    });

    it('дубль имени → ошибка; seedFromConfig идемпотентен', async () => {
      const { repo } = await make();
      await repo.add({ name: 'dup', config: mcpConfig, origin: 'instance' });
      await expect(
        repo.add({ name: 'dup', config: mcpConfig, origin: 'instance' }),
      ).rejects.toThrow();

      expect(await repo.seedFromConfig({ seeded: mcpConfig })).toBe(1);
      expect(await repo.seedFromConfig({ seeded: mcpConfig })).toBe(0);
    });
  });
}

/** Паспорт порта `SkillRepository`. */
export function describeSkillRepository(
  name: string,
  make: () => Promise<{ repo: SkillRepository; dispose?: () => Promise<void> }>,
): void {
  describe(name, () => {
    it('create/read/listNames/remove; listNames пустого — []', async () => {
      const { repo } = await make();
      expect(await repo.listNames()).toEqual([]);
      expect(await repo.readMarkdown('nope')).toBeNull();
      expect(await repo.remove('nope')).toBe(false);

      await repo.create({ name: 'alpha', description: 'первый' });
      expect(await repo.exists('alpha')).toBe(true);
      expect(await repo.listNames()).toEqual(['alpha']);
      expect(await repo.readMarkdown('alpha')).toContain('первый');

      await repo.updateMarkdown('alpha', { description: 'обновлён' });
      expect(await repo.readMarkdown('alpha')).toContain('обновлён');

      expect(await repo.remove('alpha')).toBe(true);
      expect(await repo.listNames()).toEqual([]);
    });

    it('дубль скилла → ошибка; supporting-файлы читаются/пишутся/удаляются', async () => {
      const { repo } = await make();
      await repo.create({ name: 'beta', description: 'd' });
      await expect(repo.create({ name: 'beta', description: 'd' })).rejects.toThrow();

      await repo.writeFile('beta', 'notes/readme.md', 'hello');
      expect(await repo.readFile('beta', 'notes/readme.md')).toBe('hello');
      expect(await repo.deleteFile('beta', 'notes/readme.md')).toBe(true);
      expect(await repo.readFile('beta', 'notes/readme.md')).toBeNull();
    });
  });
}

/** Паспорт порта `SkillBundleRepository`. */
export function describeSkillBundleRepository(
  name: string,
  make: () => Promise<{ repo: SkillBundleRepository; dispose?: () => Promise<void> }>,
): void {
  describe(name, () => {
    it('set/get/list/remove; неизвестный — undefined/false; list пустого — []', async () => {
      const { repo } = await make();
      expect(await repo.list()).toEqual([]);
      expect(await repo.get('none')).toBeUndefined();
      expect(await repo.remove('none')).toBe(false);

      await repo.set(bundle('one'));
      expect((await repo.get('one'))?.description).toBe('bundle one');
      expect((await repo.list()).map((b) => b.name)).toEqual(['one']);
      expect(await repo.remove('one')).toBe(true);
      expect(await repo.list()).toEqual([]);
    });
  });
}

/** Паспорт порта `DictionaryRepository`: система + пользовательский override. */
export function describeDictionaryRepository(
  name: string,
  make: () => Promise<{ repo: DictionaryRepository; dispose?: () => Promise<void> }>,
): void {
  describe(name, () => {
    it('системные словари читаются, категории/языки валидируются', async () => {
      const { repo } = await make();
      expect(repo.isValidLanguage('ru')).toBe(true);
      expect(repo.isValidLanguage('xx')).toBe(false);
      expect(repo.isKnownCategory('coding')).toBe(true);
      expect(repo.isKnownCategory('unknown-category')).toBe(false);
      expect(Array.isArray(repo.getKeywords('coding', 'ru'))).toBe(true);
      expect(repo.getDictionary('unknown-category', 'ru')).toBeNull();
    });

    it('saveUserDictionary создаёт override, deleteUserDictionary его снимает', async () => {
      const { repo } = await make();
      const saved = await repo.saveUserDictionary('coding', 'ru', { keywords: ['synthkey'] });
      expect(saved?.source).toBe('user');
      expect(repo.getKeywords('coding', 'ru')).toContain('synthkey');

      const reset = await repo.deleteUserDictionary('coding', 'ru');
      expect(reset?.source).toBe('system');
      expect(repo.getKeywords('coding', 'ru')).not.toContain('synthkey');
    });
  });
}

/**
 * Паспорт порта `DocumentRepository<T>` (PROP-032, W2.4): round-trip по ключу,
 * `list`/`delete`, вложенные ключи (`provider/model`), независимость значений.
 */
export function describeDocumentRepository<T>(
  name: string,
  make: () => Promise<{ repo: DocumentRepository<T>; dispose?: () => Promise<void> }>,
  makeValue: (key: string) => T,
): void {
  describe(name, () => {
    it('load отсутствующего — null, exists — false; save/load round-trip', async () => {
      const { repo } = await make();
      expect(await repo.load('missing')).toBeNull();
      expect(await repo.exists('missing')).toBe(false);

      await repo.save('alpha', makeValue('alpha'));
      expect(await repo.exists('alpha')).toBe(true);
      expect(await repo.load('alpha')).toEqual(makeValue('alpha'));
    });

    it('list пустого — []; delete идемпотентен', async () => {
      const { repo } = await make();
      expect(await repo.list()).toEqual([]);

      await repo.save('a', makeValue('a'));
      await repo.save('b', makeValue('b'));
      expect((await repo.list()).length).toBe(2);

      await repo.delete('a');
      expect(await repo.load('a')).toBeNull();
      expect(await repo.exists('a')).toBe(false);
      await expect(repo.delete('a')).resolves.toBeUndefined();
      expect((await repo.list()).length).toBe(1);
    });

    it('вложенные ключи (`provider/model`) поддерживаются', async () => {
      const { repo } = await make();
      await repo.save('ollama/llama3', makeValue('ollama/llama3'));
      expect(await repo.load('ollama/llama3')).toEqual(makeValue('ollama/llama3'));
      expect((await repo.list()).length).toBe(1);
    });

    it('значение независимо от стора: load возвращает новую копию', async () => {
      const { repo } = await make();
      const value = makeValue('c');
      await repo.save('c', value);
      const first = await repo.load('c');
      const second = await repo.load('c');
      expect(first).toEqual(value);
      if (first !== null && typeof first === 'object') {
        expect(first).not.toBe(second);
        expect(first).not.toBe(value);
      }
    });
  });
}

/** Паспорт порта `ContextFileRepository`. */
export function describeContextFileRepository(  name: string,
  make: () => Promise<{ repo: ContextFileRepository; dispose?: () => Promise<void> }>,
): void {
  describe(name, () => {
    it('listAllFiles — массив; enabled-файлы round-trip', async () => {
      const { repo } = await make();
      expect(Array.isArray(repo.listAllFiles())).toBe(true);
      repo.setEnabledFiles(['SOUL.md']);
      expect(repo.getEnabledFiles()).toEqual(['SOUL.md']);
    });

    it('saveFile/getFile/deleteFile для user-категории', async () => {
      const { repo } = await make();
      expect(repo.getFile('CUSTOM.md', 'user')).toBeNull();
      expect(await repo.saveFile('CUSTOM.md', '# custom', 'user')).toBe(true);
      const read = repo.getFile('CUSTOM.md', 'user');
      expect(read?.content).toBe('# custom');
      expect(await repo.deleteFile('CUSTOM.md', 'user')).toBe(true);
      expect(repo.getFile('CUSTOM.md', 'user')).toBeNull();
    });
  });
}

/** Паспорт порта `SecretPatternRepository`: дефолт / override / сброс. */
export function describeSecretPatternRepository(
  name: string,
  make: () => Promise<{ repo: SecretPatternRepository; dispose?: () => Promise<void> }>,
): void {
  describe(name, () => {
    it('дефолтные паттерны непусты; savePatterns включает override; reset снимает', async () => {
      const { repo } = await make();
      expect(repo.getDefaultPatterns().length).toBeGreaterThan(0);
      expect(repo.hasOverride()).toBe(false);
      expect(repo.getPatterns()).toEqual(repo.getDefaultPatterns());

      expect(await repo.savePatterns([{ type: 'custom', regex: 'SECRET_[A-Z]+' }])).toBe(true);
      expect(repo.hasOverride()).toBe(true);
      expect(repo.getPatterns()).toEqual([{ type: 'custom', regex: 'SECRET_[A-Z]+' }]);
      expect(repo.getRawPatterns().isOverridden).toBe(true);

      expect(await repo.reset()).toBe(true);
      expect(repo.hasOverride()).toBe(false);
      expect(await repo.reset()).toBe(false);
    });
  });
}

/** Паспорт порта `ProtectedPathsRepository`: базовая/эффективная политика и сброс. */
export function describeProtectedPathsRepository(
  name: string,
  make: () => Promise<{ repo: ProtectedPathsRepository; dispose?: () => Promise<void> }>,
): void {
  describe(name, () => {
    it('getBase/getPolicy/getRaw без override; reset без override — false', async () => {
      const { repo } = await make();
      expect(repo.hasOverride()).toBe(false);
      expect(await repo.reset()).toBe(false);
      expect(repo.getOverride()).toBeNull();

      const base = repo.getBase();
      expect(Array.isArray(base.deniedPaths)).toBe(true);
      expect(Array.isArray(repo.getPolicy().deniedPaths)).toBe(true);
      expect(repo.getRaw().isOverridden).toBe(false);
    });

    it('savePolicy добавляет путь; reset возвращает к базе', async () => {
      const { repo } = await make();
      const base = repo.getBase();
      const effective = { ...base, deniedPaths: [...base.deniedPaths, '/tmp/secret-blob'] };
      expect(await repo.savePolicy(effective)).toBe(true);
      expect(repo.hasOverride()).toBe(true);
      expect(repo.getPolicy().deniedPaths).toContain('/tmp/secret-blob');

      expect(await repo.reset()).toBe(true);
      expect(repo.getPolicy().deniedPaths).not.toContain('/tmp/secret-blob');
    });
  });
}
