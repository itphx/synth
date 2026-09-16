import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile, readFile, readdir, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DictionaryStore, DictionaryContentError } from './dictionary-store.js';

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

describe('DictionaryStore (API управления словарями)', () => {
  let root: string;
  let systemDir: string;
  let dataDir: string;
  let store: DictionaryStore;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'synth-dict-store-'));
    systemDir = join(root, 'system');
    dataDir = join(root, 'data');
    await mkdir(systemDir, { recursive: true });
    await writeFile(join(systemDir, 'coding.ru.yaml'), 'keywords:\n  - системное\n  - код\n');
    await writeFile(join(systemDir, 'coding.en.yaml'), 'keywords:\n  - system\n  - code\n');
    await writeFile(join(systemDir, 'research.ru.yaml'), 'keywords:\n  - исследуй\n');
    await writeFile(join(systemDir, 'coding.tools.yaml'), 'tools:\n  - write_file\n  - edit_file\n');
    store = new DictionaryStore(dataDir, systemDir);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  describe('isKnownCategory / isValidLanguage', () => {
    it('знает категории из системного каталога и не считает tools-файл категорией', () => {
      expect(store.isKnownCategory('coding')).toBe(true);
      expect(store.isKnownCategory('research')).toBe(true);
      expect(store.isKnownCategory('coding.tools')).toBe(false);
      expect(store.isKnownCategory('unknown')).toBe(false);
    });

    it('допускает только ru/en', () => {
      expect(store.isValidLanguage('ru')).toBe(true);
      expect(store.isValidLanguage('en')).toBe(true);
      expect(store.isValidLanguage('de')).toBe(false);
      expect(store.isValidLanguage('../../etc')).toBe(false);
    });
  });

  describe('getDictionary / listDictionaries', () => {
    it('отдаёт системный словарь с tools для coding', () => {
      const dict = store.getDictionary('coding', 'ru');
      expect(dict).toMatchObject({
        category: 'coding',
        language: 'ru',
        source: 'system',
      });
      expect(dict!.keywords).toEqual(['системное', 'код']);
      expect(dict!.tools).toEqual(['write_file', 'edit_file']);
    });

    it('возвращает null для неизвестной категории/языка', () => {
      expect(store.getDictionary('unknown', 'ru')).toBeNull();
      expect(store.getDictionary('coding', 'de')).toBeNull();
    });

    it('список содержит все известные категории × языки', () => {
      const list = store.listDictionaries();
      const pairs = list.map((d) => `${d.category}.${d.language}`);
      expect(pairs).toContain('coding.ru');
      expect(pairs).toContain('coding.en');
      expect(pairs).toContain('research.ru');
      expect(pairs).not.toContain('coding.tools');
      expect(list.every((d) => d.source === 'system')).toBe(true);
    });
  });

  describe('saveUserDictionary', () => {
    it('пишет переопределение и отдаёт source=user (приоритет над системным)', async () => {
      const saved = await store.saveUserDictionary('coding', 'ru', { keywords: ['моё', 'слово'] });
      expect(saved).toMatchObject({ category: 'coding', language: 'ru', source: 'user' });
      expect(saved!.keywords).toEqual(['моё', 'слово']);
      expect(store.getKeywords('coding', 'ru')).toEqual(['моё', 'слово']);
    });

    it('файл создаётся атомарно (tmp-хвостов нет) и в ожидаемом формате', async () => {
      await store.saveUserDictionary('coding', 'ru', { keywords: ['моё'] });
      const userPath = join(dataDir, 'dictionaries', 'coding.ru.yaml');
      const raw = await readFile(userPath, 'utf-8');
      expect(raw).toContain('keywords:');
      expect(raw).toContain('- моё');
      const files = await readdir(join(dataDir, 'dictionaries'));
      expect(files.filter((f) => f.includes('.tmp.'))).toEqual([]);
    });

    it('tools для coding зеркалятся в coding.tools.yaml и подхватываются getCodingTools', async () => {
      await store.saveUserDictionary('coding', 'ru', { keywords: ['моё'], tools: ['my_tool'] });
      expect(await exists(join(dataDir, 'dictionaries', 'coding.tools.yaml'))).toBe(true);
      expect(store.getCodingTools()).toEqual(['my_tool']);
      const dict = store.getDictionary('coding', 'ru');
      expect(dict!.source).toBe('user');
      expect(dict!.tools).toEqual(['my_tool']);
    });

    it('возвращает null для неизвестной категории/языка', async () => {
      expect(await store.saveUserDictionary('unknown', 'ru', { keywords: ['x'] })).toBeNull();
      expect(await store.saveUserDictionary('coding', 'de', { keywords: ['x'] })).toBeNull();
    });
  });

  describe('deleteUserDictionary', () => {
    it('удаляет переопределение → словарь возвращается к системному', async () => {
      await store.saveUserDictionary('coding', 'ru', { keywords: ['моё'], tools: ['my_tool'] });
      const restored = await store.deleteUserDictionary('coding', 'ru');
      expect(restored).toMatchObject({ source: 'system' });
      expect(restored!.keywords).toEqual(['системное', 'код']);
      expect(restored!.tools).toEqual(['write_file', 'edit_file']);
      expect(store.getKeywords('coding', 'ru')).toEqual(['системное', 'код']);
      expect(store.getCodingTools()).toEqual(['write_file', 'edit_file']);
      expect(await exists(join(dataDir, 'dictionaries', 'coding.ru.yaml'))).toBe(false);
      expect(await exists(join(dataDir, 'dictionaries', 'coding.tools.yaml'))).toBe(false);
    });

    it('идемпотентно: повторное удаление не падает', async () => {
      await expect(store.deleteUserDictionary('coding', 'ru')).resolves.toMatchObject({ source: 'system' });
    });

    it('возвращает null для неизвестной категории/языка', async () => {
      expect(await store.deleteUserDictionary('unknown', 'ru')).toBeNull();
    });
  });

  describe('getContent', () => {
    it('без переопределения отдаёт системный текст как есть', async () => {
      const expected = await readFile(join(systemDir, 'research.ru.yaml'), 'utf-8');
      expect(store.getContent('research', 'ru')).toBe(expected);
    });

    it('отдаёт пользовательский текст приоритетно', async () => {
      const content = 'keywords:\n  - моё\n';
      await store.saveUserContent('research', 'ru', content);
      expect(store.getContent('research', 'ru')).toBe(content);
    });

    it('возвращает пустую строку, если файла нет', () => {
      expect(store.getContent('unknown', 'ru')).toBe('');
    });
  });

  describe('saveUserContent', () => {
    it('парсит, нормализует и атомарно пишет YAML; source=user', async () => {
      const saved = await store.saveUserContent(
        'research',
        'ru',
        'keywords:\n  -  Моё  \n  - Слово\n  - моё\n',
      );
      expect(saved).toMatchObject({ category: 'research', language: 'ru', source: 'user' });
      // lowercase + дедупликация + trim
      expect(saved!.keywords).toEqual(['моё', 'слово']);
      expect(store.getContent('research', 'ru')).toBe('keywords:\n  - моё\n  - слово\n');

      const files = await readdir(join(dataDir, 'dictionaries'));
      expect(files.filter((f) => f.includes('.tmp.'))).toEqual([]);
    });

    it('для coding зеркалит tools в coding.tools.yaml', async () => {
      const content = 'keywords:\n  - моё\ntools:\n  - my_tool\n';
      const saved = await store.saveUserContent('coding', 'ru', content);
      expect(saved).toMatchObject({ source: 'user' });
      expect(saved!.tools).toEqual(['my_tool']);
      expect(store.getCodingTools()).toEqual(['my_tool']);
      expect(await exists(join(dataDir, 'dictionaries', 'coding.tools.yaml'))).toBe(true);
      expect(store.getContent('coding', 'ru')).toBe(content);
    });

    it('бросает DictionaryContentError на некорректный YAML', async () => {
      await expect(store.saveUserContent('research', 'ru', 'keywords: [a, b')).rejects.toThrow(
        DictionaryContentError,
      );
      await expect(store.saveUserContent('research', 'ru', 'мусор\n')).rejects.toThrow(
        DictionaryContentError,
      );
      // keywords обязателен
      await expect(store.saveUserContent('research', 'ru', 'tools:\n  - x\n')).rejects.toThrow(
        DictionaryContentError,
      );
      expect(await exists(join(dataDir, 'dictionaries', 'research.ru.yaml'))).toBe(false);
    });

    it('бросает DictionaryContentError при превышении лимитов', async () => {
      const many = `keywords:\n${Array.from({ length: 2001 }, (_, i) => `  - w${i}`).join('\n')}\n`;
      await expect(store.saveUserContent('research', 'ru', many)).rejects.toThrow(
        DictionaryContentError,
      );
    });

    it('возвращает null для неизвестной категории/языка', async () => {
      expect(await store.saveUserContent('unknown', 'ru', 'keywords:\n  - x\n')).toBeNull();
      expect(await store.saveUserContent('coding', 'de', 'keywords:\n  - x\n')).toBeNull();
    });

    it('не ломает getKeywords после записи из текста', async () => {
      await store.saveUserContent('research', 'ru', 'keywords:\n  - новый\n');
      expect(store.getKeywords('research', 'ru')).toEqual(['новый']);
    });
  });
});
