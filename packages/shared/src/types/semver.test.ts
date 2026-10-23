import { describe, it, expect } from 'vitest';
import { isSemverRange, parseSemver, satisfiesSemverRange } from './semver.js';
import { checkExtensionCompatibility } from './pack.js';

describe('isSemverRange — грамматика диапазонов (ADR-090)', () => {
  it('принимает поддерживаемые формы', () => {
    for (const range of ['^1.2.3', '~1.2.3', '>=1.0.0 <2.0.0', '1.x', '*', '1.2.3', '=1.2.3', '>1.0', '1']) {
      expect(isSemverRange(range), range).toBe(true);
    }
  });

  it('отклоняет мусор и дизъюнкцию (fail-closed)', () => {
    for (const range of ['', '  ', 'не-диапазон', '^1.2.3 || ^2.0.0', '>=', '1.2.3.4', 'v1.2.3']) {
      expect(isSemverRange(range), range).toBe(false);
    }
  });

  it('пробельная конъюнкция допускается', () => {
    expect(isSemverRange('>=1.0.0   <2.0.0')).toBe(true);
  });
});

describe('parseSemver', () => {
  it('разбирает полный semver, пре-релиз/сборка отбрасываются', () => {
    expect(parseSemver('1.2.3')).toEqual({ major: 1, minor: 2, patch: 3 });
    expect(parseSemver('1.2.3-beta.1+build.7')).toEqual({ major: 1, minor: 2, patch: 3 });
  });

  it('короткая форма и мусор → null', () => {
    expect(parseSemver('1.2')).toBeNull();
    expect(parseSemver('1')).toBeNull();
    expect(parseSemver('x.y.z')).toBeNull();
  });
});

describe('satisfiesSemverRange — операторы', () => {
  it('^1.2.3: >=1.2.3 <2.0.0', () => {
    expect(satisfiesSemverRange('1.2.3', '^1.2.3')).toBe(true);
    expect(satisfiesSemverRange('1.9.0', '^1.2.3')).toBe(true);
    expect(satisfiesSemverRange('1.2.2', '^1.2.3')).toBe(false);
    expect(satisfiesSemverRange('2.0.0', '^1.2.3')).toBe(false);
  });

  it('^0.2.3: >=0.2.3 <0.3.0 (мажор 0 — фиксирован минор)', () => {
    expect(satisfiesSemverRange('0.2.3', '^0.2.3')).toBe(true);
    expect(satisfiesSemverRange('0.2.9', '^0.2.3')).toBe(true);
    expect(satisfiesSemverRange('0.3.0', '^0.2.3')).toBe(false);
  });

  it('~1.2.3: >=1.2.3 <1.3.0', () => {
    expect(satisfiesSemverRange('1.2.3', '~1.2.3')).toBe(true);
    expect(satisfiesSemverRange('1.2.9', '~1.2.3')).toBe(true);
    expect(satisfiesSemverRange('1.3.0', '~1.2.3')).toBe(false);
  });

  it('>=1.0.0 <2.0.0 — конъюнкция', () => {
    expect(satisfiesSemverRange('1.0.0', '>=1.0.0 <2.0.0')).toBe(true);
    expect(satisfiesSemverRange('1.99.0', '>=1.0.0 <2.0.0')).toBe(true);
    expect(satisfiesSemverRange('2.0.0', '>=1.0.0 <2.0.0')).toBe(false);
    expect(satisfiesSemverRange('0.9.9', '>=1.0.0 <2.0.0')).toBe(false);
  });

  it('1.x — весь мажор', () => {
    expect(satisfiesSemverRange('1.0.0', '1.x')).toBe(true);
    expect(satisfiesSemverRange('1.42.7', '1.x')).toBe(true);
    expect(satisfiesSemverRange('2.0.0', '1.x')).toBe(false);
  });

  it('* — любая валидная версия', () => {
    expect(satisfiesSemverRange('0.0.1', '*')).toBe(true);
    expect(satisfiesSemverRange('9.9.9', '*')).toBe(true);
  });

  it('точное совпадение и границы', () => {
    expect(satisfiesSemverRange('1.2.3', '1.2.3')).toBe(true);
    expect(satisfiesSemverRange('1.2.4', '1.2.3')).toBe(false);
    expect(satisfiesSemverRange('1.2.3', '=1.2.3')).toBe(true);
    expect(satisfiesSemverRange('1.2.3', '>1.2.3')).toBe(false);
    expect(satisfiesSemverRange('1.2.4', '>1.2.3')).toBe(true);
    expect(satisfiesSemverRange('1.2.3', '<=1.2.3')).toBe(true);
    expect(satisfiesSemverRange('1.2.3', '<1.2.3')).toBe(false);
  });

  it('мажор выше/ниже: границы inclusive/exclusive', () => {
    expect(satisfiesSemverRange('2.0.0', '>=2.0.0')).toBe(true);
    expect(satisfiesSemverRange('1.9.9', '>=2.0.0')).toBe(false);
    expect(satisfiesSemverRange('1.9.9', '<2.0.0')).toBe(true);
    expect(satisfiesSemverRange('2.0.0', '<2.0.0')).toBe(false);
  });

  it('невалидный диапазон/версия → false (fail-closed)', () => {
    expect(satisfiesSemverRange('1.2.3', 'не-диапазон')).toBe(false);
    expect(satisfiesSemverRange('v1.2.3', '^1.0.0')).toBe(false);
    expect(satisfiesSemverRange('1.2.3', '')).toBe(false);
  });
});

describe('checkExtensionCompatibility — вердикт семвер-гейта (ADR-090)', () => {
  const base = { hostVersion: '1.4.2', contractVersion: '1.0.0' };

  it('совместим: контракт и host проходят', () => {
    expect(
      checkExtensionCompatibility({
        ...base,
        contracts: { extensionApi: '^1' },
        host: '^1.0.0',
      }),
    ).toEqual({ ok: true });
  });

  it('contract_mismatch: мажор контракта не тот', () => {
    expect(
      checkExtensionCompatibility({
        ...base,
        contracts: { extensionApi: '^2' },
        host: '^1.0.0',
      }),
    ).toEqual({
      ok: false,
      reason: 'contract_mismatch',
      expected: '^2',
      actual: '1.0.0',
    });
  });

  it('host_mismatch: версия Synth вне диапазона', () => {
    expect(
      checkExtensionCompatibility({
        ...base,
        contracts: { extensionApi: '^1' },
        host: '^0.9.0',
      }),
    ).toEqual({
      ok: false,
      reason: 'host_mismatch',
      expected: '^0.9.0',
      actual: '1.4.2',
    });
  });

  it('сначала проверяется контракт, затем host', () => {
    const verdict = checkExtensionCompatibility({
      ...base,
      contracts: { extensionApi: '^2' },
      host: '^0.9.0',
    });
    expect(verdict.reason).toBe('contract_mismatch');
  });

  it('точное исключение host обходит диапазон host, но не контракт', () => {
    expect(
      checkExtensionCompatibility({
        ...base,
        host: '^0.9.0',
        exactHostExceptions: ['1.4.2'],
      }),
    ).toEqual({ ok: true });
    expect(
      checkExtensionCompatibility({
        ...base,
        contracts: { extensionApi: '^2' },
        host: '^0.9.0',
        exactHostExceptions: ['1.4.2'],
      }).reason,
    ).toBe('contract_mismatch');
  });

  it('без объявлений контракта/host — совместим', () => {
    expect(checkExtensionCompatibility(base)).toEqual({ ok: true });
  });

  it('имя контракта настраивается (contractName)', () => {
    expect(
      checkExtensionCompatibility({
        ...base,
        contracts: { promptBlocks: '^2' },
        contractName: 'promptBlocks',
      }).reason,
    ).toBe('contract_mismatch');
  });
});
