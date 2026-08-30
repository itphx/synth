import { describe, it, expect } from 'vitest';
import { extractUser, extractUserFromTokens } from './oidc.js';

describe('oidc extractUser', () => {
  it('берёт роли из realm_access id_token (ADMIN)', () => {
    const user = extractUser({ realm_access: { roles: ['admin'] } });
    expect(user.roles).toEqual(['ADMIN']);
  });

  it('нормализует регистр и отбрасывает неизвестные роли', () => {
    const user = extractUser({ realm_access: { roles: ['Admin', 'superadmin', 'user'] } });
    expect(user.roles).toEqual(['ADMIN', 'USER']);
  });

  it('учитывает client roles из resource_access.<clientId>.roles', () => {
    const user = extractUser(
      { resource_access: { synth: { roles: ['lead'] } } },
      'synth',
    );
    expect(user.roles).toEqual(['LEAD']);
  });

  it('объединяет realm и client роли без дубликатов', () => {
    const user = extractUser(
      { realm_access: { roles: ['admin'] }, resource_access: { synth: { roles: ['admin', 'user'] } } },
      'synth',
    );
    expect(user.roles).toEqual(['ADMIN', 'USER']);
  });

  it('возвращает дефолт USER при отсутствии известных ролей', () => {
    const user = extractUser({ sub: 'x', preferred_username: 'ivan' });
    expect(user.roles).toEqual(['USER']);
  });
});

describe('oidc extractUserFromTokens', () => {
  it('берёт роли из access_token, если в id_token их нет', () => {
    const user = extractUserFromTokens(
      { sub: 'x', preferred_username: 'ivan' },
      { realm_access: { roles: ['admin'] } },
    );
    expect(user.roles).toEqual(['ADMIN']);
  });

  it('приоритет отдаёт ролям из id_token', () => {
    const user = extractUserFromTokens(
      { realm_access: { roles: ['user'] } },
      { realm_access: { roles: ['admin'] } },
    );
    expect(user.roles).toEqual(['USER']);
  });

  it('возвращает дефолт USER, когда ролей нет ни в одном токене', () => {
    const user = extractUserFromTokens({}, {});
    expect(user.roles).toEqual(['USER']);
  });
});
