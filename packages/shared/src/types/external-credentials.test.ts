import { describe, expect, it } from 'vitest';
import {
  createExternalCredentialInputSchema,
  externalCredentialMetaSchema,
  externalCredentialSchema,
  maskExternalSecret,
  toExternalCredentialMeta,
  updateExternalCredentialTokensSchema,
  type ExternalCredential,
} from './external-credentials.js';

/** Запись доступа с зашифрованными токенами (как её хранит бэкенд). */
function credential(over: Partial<ExternalCredential> = {}): ExternalCredential {
  return {
    id: 'extc_1',
    provider: 'google',
    clientId: 'client-123',
    scopes: ['calendar.read'],
    owner: { kind: 'user', id: 'user-1' },
    secretEnc: 'enc:v1:iv:tag:cipher',
    status: 'active',
    createdBy: 'user-1',
    createdAt: '2026-10-23T10:00:00.000Z',
    ...over,
  };
}

describe('externalCredentialSchema (ADR-105 Ф0)', () => {
  it('принимает запись из §1 документа', () => {
    const parsed = externalCredentialSchema.parse({
      id: 'extc_1',
      provider: 'google',
      connectorId: 'mcp_1',
      clientId: 'client-123',
      scopes: ['calendar.read'],
      owner: { kind: 'user', id: 'user-1' },
      projectId: 'p1',
      secretEnc: 'enc:v1:iv:tag:cipher',
      refreshEnc: 'enc:v1:iv:tag:cipher2',
      status: 'active',
      expiresAt: '2026-10-23T11:00:00.000Z',
      createdBy: 'user-1',
      createdAt: '2026-10-23T10:00:00.000Z',
      lastUsedAt: '2026-10-23T10:30:00.000Z',
      scopesGranted: ['calendar.read'],
    });
    expect(parsed.owner).toEqual({ kind: 'user', id: 'user-1' });
    expect(parsed.status).toBe('active');
    expect(parsed.refreshEnc).toBe('enc:v1:iv:tag:cipher2');
  });

  it('отклоняет неизвестный статус и неизвестный вид владения', () => {
    expect(
      externalCredentialSchema.safeParse({ ...credential(), status: 'unknown' }).success,
    ).toBe(false);
    expect(
      externalCredentialSchema.safeParse({
        ...credential(),
        owner: { kind: 'robot', id: 'x' },
      }).success,
    ).toBe(false);
  });

  it('требует непустые id/provider/clientId', () => {
    expect(externalCredentialSchema.safeParse({ ...credential(), id: '' }).success).toBe(false);
    expect(externalCredentialSchema.safeParse({ ...credential(), provider: '' }).success).toBe(false);
    expect(externalCredentialSchema.safeParse({ ...credential(), clientId: '' }).success).toBe(false);
  });
});

describe('createExternalCredentialInputSchema (ADR-105 Ф0)', () => {
  it('принимает вход с plaintext-токеном и опциональными полями', () => {
    const parsed = createExternalCredentialInputSchema.parse({
      provider: 'google',
      clientId: 'client-123',
      scopes: ['calendar.read'],
      owner: { kind: 'local', id: 'local' },
      accessToken: 'ya29.token',
      refreshToken: 'refresh-token',
      createdBy: 'local',
    });
    expect(parsed.accessToken).toBe('ya29.token');
    expect(parsed.owner.kind).toBe('local');
  });

  it('отклоняет пустой access-токен и пустого владельца', () => {
    expect(
      createExternalCredentialInputSchema.safeParse({
        provider: 'google',
        clientId: 'client-123',
        owner: { kind: 'user', id: 'u' },
        accessToken: '',
        createdBy: 'u',
      }).success,
    ).toBe(false);
    expect(
      createExternalCredentialInputSchema.safeParse({
        provider: 'google',
        clientId: 'client-123',
        owner: { kind: 'user', id: '' },
        accessToken: 'token',
        createdBy: 'u',
      }).success,
    ).toBe(false);
  });
});

describe('updateExternalCredentialTokensSchema (ADR-105 Ф0)', () => {
  it('все поля опциональны; статус ограничен списком', () => {
    expect(updateExternalCredentialTokensSchema.parse({})).toEqual({});
    expect(updateExternalCredentialTokensSchema.safeParse({ status: 'error' }).success).toBe(true);
    expect(updateExternalCredentialTokensSchema.safeParse({ status: 'nope' }).success).toBe(false);
  });
});

describe('маска секрета и маппер метаданных (ADR-105 Ф0)', () => {
  it('маска необратима и стабильна для одного значения', () => {
    const mask = maskExternalSecret('enc:v1:iv:tag:cipher');
    expect(mask).toBe(maskExternalSecret('enc:v1:iv:tag:cipher'));
    expect(mask.startsWith('mask:')).toBe(true);
    expect(mask).not.toContain('cipher');
  });

  it('маска разная для разных секретов', () => {
    expect(maskExternalSecret('enc:v1:a:b:c')).not.toBe(maskExternalSecret('enc:v1:a:b:d'));
  });

  it('маппер убирает секреты и добавляет маску/признак refresh-токена', () => {
    const meta = toExternalCredentialMeta(
      credential({ refreshEnc: 'enc:v1:iv:tag:cipher2', connectorId: 'mcp_1' }),
    );
    expect(meta).not.toHaveProperty('secretEnc');
    expect(meta).not.toHaveProperty('refreshEnc');
    expect(meta.hasRefreshToken).toBe(true);
    expect(meta.secretMask).toBe(maskExternalSecret('enc:v1:iv:tag:cipher'));
    expect(meta.connectorId).toBe('mcp_1');
    expect(externalCredentialMetaSchema.safeParse(meta).success).toBe(true);
  });

  it('без refresh-токена признак hasRefreshToken=false', () => {
    expect(toExternalCredentialMeta(credential()).hasRefreshToken).toBe(false);
  });

  it('метаданные не содержат plaintext-секрета даже при сериализации', () => {
    const meta = toExternalCredentialMeta(credential({ secretEnc: 'enc:v1:iv:tag:plaintext' }));
    expect(JSON.stringify(meta)).not.toContain('plaintext');
  });
});
