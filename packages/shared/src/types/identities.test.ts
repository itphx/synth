import { describe, it, expect } from 'vitest';
import { buildPrincipalId, parsePrincipalId } from './index.js';

describe('buildPrincipalId (AD-089)', () => {
  it('собирает principalId из провайдера и внешнего id', () => {
    expect(buildPrincipalId('tg', '450316139')).toBe('tg:450316139');
    expect(buildPrincipalId('synth-media', 'u-1')).toBe('synth-media:u-1');
  });
});

describe('parsePrincipalId (AD-089)', () => {
  it('делит по первому ":"', () => {
    expect(parsePrincipalId('tg:450316139')).toEqual({ provider: 'tg', externalId: '450316139' });
    // Внешний id может сам содержать ":" — всё после первого разделителя идёт в externalId.
    expect(parsePrincipalId('web:a:b:c')).toEqual({ provider: 'web', externalId: 'a:b:c' });
  });

  it('возвращает null для невалидного значения', () => {
    expect(parsePrincipalId('no-colon')).toBeNull();
    expect(parsePrincipalId(':123')).toBeNull();
    expect(parsePrincipalId('tg:')).toBeNull();
    expect(parsePrincipalId('')).toBeNull();
  });

  it('round-trip с buildPrincipalId', () => {
    const principalId = buildPrincipalId('tg', '42');
    expect(parsePrincipalId(principalId)).toEqual({ provider: 'tg', externalId: '42' });
  });
});
