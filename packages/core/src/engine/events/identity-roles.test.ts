import { describe, it, expect } from 'vitest';
import { resolveEffectiveRoles, normalizeRole } from './identity-roles.js';

describe('resolveEffectiveRoles (AD-089, этап 5)', () => {
  it('профиль отсутствует (null) → ролей нет, linked=false (fail-closed)', () => {
    expect(resolveEffectiveRoles(null, undefined)).toEqual({ roles: [], linked: false });
    expect(resolveEffectiveRoles(null, ['ADMIN'])).toEqual({ roles: [], linked: false });
    expect(resolveEffectiveRoles(null, [])).toEqual({ roles: [], linked: false });
  });

  it('профиль есть, identity.roles не заданы → база профиля', () => {
    expect(resolveEffectiveRoles(['USER'], undefined)).toEqual({ roles: ['USER'], linked: true });
    expect(resolveEffectiveRoles(['ADMIN', 'USER'], undefined)).toEqual({
      roles: ['ADMIN', 'USER'],
      linked: true,
    });
  });

  it('пустой identity.roles трактуется как «не задано» → база профиля', () => {
    expect(resolveEffectiveRoles(['LEAD'], [])).toEqual({ roles: ['LEAD'], linked: true });
  });

  it('identity.roles сужает до пересечения', () => {
    expect(resolveEffectiveRoles(['ADMIN', 'USER'], ['USER'])).toEqual({ roles: ['USER'], linked: true });
    expect(resolveEffectiveRoles(['ADMIN', 'LEAD', 'USER'], ['LEAD', 'USER'])).toEqual({
      roles: ['LEAD', 'USER'],
      linked: true,
    });
  });

  it('identity.roles НЕ повышают: профиль USER + ADMIN → пусто (сопознан)', () => {
    expect(resolveEffectiveRoles(['USER'], ['ADMIN'])).toEqual({ roles: [], linked: true });
  });

  it('пересечение пусто → сужение до нуля, но сопознан', () => {
    expect(resolveEffectiveRoles(['USER'], ['LEAD'])).toEqual({ roles: [], linked: true });
  });

  it('нормализация регистра: профиль lowercase, identity uppercase', () => {
    expect(resolveEffectiveRoles(['admin', 'user'], ['ADMIN'])).toEqual({ roles: ['ADMIN'], linked: true });
    expect(resolveEffectiveRoles(['ADMIN'], ['admin'])).toEqual({ roles: ['ADMIN'], linked: true });
  });

  it('дедупликация и отбрасывание пустых', () => {
    expect(resolveEffectiveRoles(['ADMIN', 'admin', ''], ['ADMIN', 'ADMIN'])).toEqual({
      roles: ['ADMIN'],
      linked: true,
    });
  });

  it('порядок определяется identity.roles при сужении (детерминизм)', () => {
    expect(resolveEffectiveRoles(['USER', 'ADMIN'], ['ADMIN', 'USER'])).toEqual({
      roles: ['ADMIN', 'USER'],
      linked: true,
    });
  });

  it('normalizeRole: trim + верхний регистр', () => {
    expect(normalizeRole('  admin ')).toBe('ADMIN');
    expect(normalizeRole('lead')).toBe('LEAD');
  });
});
