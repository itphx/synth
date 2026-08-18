/**
 * Юнит-тесты обфускатора секретов (AD-036).
 * Плейсхолдер: ⟦SYNTH_SECRET_N⟧ (юникод-скобки U+27E6/27E7, префикс SYNTH_).
 */

import { describe, it, expect } from 'vitest';

import {
  obfuscateSecrets,
  deobfuscateSecrets,
  restoreSecrets,
  PLACEHOLDER_PATTERN,
  PLACEHOLDER_REGEX,
} from './obfuscator.js';

const SK1 = 'sk-aaaaaaaaaaaaaaaaaaaa';
const SK2 = 'sk-bbbbbbbbbbbbbbbbbbbb';

describe('obfuscateSecrets', () => {
  it('обфускация нового секрета создаёт ⟦SYNTH_SECRET_1⟧ и добавляет в карту', () => {
    const result = obfuscateSecrets(`мой ключ ${SK1}`, {});
    expect(result.text).toContain('⟦SYNTH_SECRET_1⟧');
    expect(result.text).not.toContain('sk-');
    expect(result.map).toEqual({ '⟦SYNTH_SECRET_1⟧': SK1 });
    expect(result.found).toEqual([SK1]);
  });

  it('повторный секрет → тот же плейсхолдер (карта не растёт)', () => {
    const first = obfuscateSecrets(`ключ ${SK1}`, {});
    const second = obfuscateSecrets(`снова ключ ${SK1}`, first.map);
    expect(second.text).toBe('снова ключ ⟦SYNTH_SECRET_1⟧');
    expect(second.map).toEqual(first.map); // размер не увеличился
  });

  it('несколько разных секретов → SECRET_1, SECRET_2...', () => {
    const result = obfuscateSecrets(`${SK1} и ${SK2}`, {});
    expect(result.text).toBe('⟦SYNTH_SECRET_1⟧ и ⟦SYNTH_SECRET_2⟧');
    expect(result.map).toEqual({
      '⟦SYNTH_SECRET_1⟧': SK1,
      '⟦SYNTH_SECRET_2⟧': SK2,
    });
  });

  it('одинаковый секрет в тексте несколько раз заменяется одним плейсхолдером', () => {
    const result = obfuscateSecrets(`${SK1} ... ${SK1} ... ${SK1}`, {});
    expect(result.text.match(/⟦SYNTH_SECRET_1⟧/g)).toHaveLength(3);
    expect(Object.keys(result.map)).toHaveLength(1);
  });

  it('текст без секретов → без изменений, карта пустая', () => {
    const result = obfuscateSecrets('обычный текст', {});
    expect(result.text).toBe('обычный текст');
    expect(result.map).toEqual({});
    expect(result.found).toEqual([]);
  });

  it('пустой текст → без изменений', () => {
    const result = obfuscateSecrets('', {});
    expect(result.text).toBe('');
    expect(result.map).toEqual({});
  });

  it('следующий свободный номер учитывает существующую карту', () => {
    const map = { '⟦SYNTH_SECRET_1⟧': SK1 };
    const result = obfuscateSecrets(`новый ${SK2}`, map);
    expect(result.text).toBe('новый ⟦SYNTH_SECRET_2⟧');
    expect(result.map['⟦SYNTH_SECRET_2⟧']).toBe(SK2);
  });
});

describe('deobfuscateSecrets', () => {
  const map = { '⟦SYNTH_SECRET_1⟧': SK1, '⟦SYNTH_SECRET_2⟧': SK2 };

  it('возвращает оригинал для известных плейсхолдеров', () => {
    expect(deobfuscateSecrets('Подключение с ⟦SYNTH_SECRET_1⟧ и ⟦SYNTH_SECRET_2⟧', map)).toBe(
      `Подключение с ${SK1} и ${SK2}`,
    );
  });

  it('неизвестный плейсхолдер (нет в карте) остаётся как есть', () => {
    expect(deobfuscateSecrets('⟦SYNTH_SECRET_99⟧', map)).toBe('⟦SYNTH_SECRET_99⟧');
  });

  it('текст без плейсхолдеров → без изменений', () => {
    expect(deobfuscateSecrets('просто текст', map)).toBe('просто текст');
  });

  it('пустой текст или пустая карта → без изменений', () => {
    expect(deobfuscateSecrets('', map)).toBe('');
    expect(deobfuscateSecrets('⟦SYNTH_SECRET_1⟧', {})).toBe('⟦SYNTH_SECRET_1⟧');
  });
});

describe('restoreSecrets', () => {
  const map = { '⟦SYNTH_SECRET_1⟧': SK1, '⟦SYNTH_SECRET_2⟧': SK2 };

  it('рекурсивно деобфусцирует вложенные объекты и массивы', () => {
    const input = {
      a: ['x ⟦SYNTH_SECRET_1⟧ y'],
      b: { c: '⟦SYNTH_SECRET_2⟧', d: [42, '⟦SYNTH_SECRET_1⟧'] },
      n: 42,
      flag: true,
      nil: null,
    };
    const restored = restoreSecrets(input, map) as typeof input;
    expect(restored.a[0]).toBe(`x ${SK1} y`);
    expect(restored.b.c).toBe(SK2);
    expect(restored.b.d[1]).toBe(SK1);
    expect(restored.n).toBe(42);
    expect(restored.flag).toBe(true);
    expect(restored.nil).toBeNull();
  });

  it('плоская строка восстанавливается как deobfuscateSecrets', () => {
    expect(restoreSecrets('⟦SYNTH_SECRET_1⟧', map)).toBe(SK1);
  });

  it('неизвестный плейсхолдер остаётся как есть', () => {
    expect(restoreSecrets({ x: '⟦SYNTH_SECRET_77⟧' }, map)).toEqual({ x: '⟦SYNTH_SECRET_77⟧' });
  });
});

describe('константы плейсхолдера', () => {
  it('PLACEHOLDER_PATTERN и PLACEHOLDER_REGEX матчат ⟦SYNTH_SECRET_N⟧', () => {
    expect('⟦SYNTH_SECRET_1⟧'.match(PLACEHOLDER_PATTERN)?.[1]).toBe('1');
    expect('a ⟦SYNTH_SECRET_12⟧ b'.replace(PLACEHOLDER_REGEX, 'X')).toBe('a X b');
  });

  it('PLACEHOLDER_PATTERN не матчит произвольный текст', () => {
    expect('обычный текст'.match(PLACEHOLDER_PATTERN)).toBeNull();
  });
});
