// Хелпер пересылки ответа на подтверждение прав в удалённый backend (гибрид).
// Покрывает WS-ветку: нормализацию кадра и исход пересылки (успех/4xx/сеть).
import { describe, it, expect, vi } from 'vitest';
import {
  buildRemotePermissionReplyBody,
  relayRemotePermissionReply,
} from './permission-relay.js';
import type { RemoteBackendClient } from '../../remote/client.js';
import { RemoteError } from '../../remote/types.js';

function fakeClient(impl: () => Promise<{ status: number; body: unknown }>) {
  return { permissionReply: vi.fn(impl) } as unknown as RemoteBackendClient;
}

describe('buildRemotePermissionReplyBody', () => {
  it('новый формат action', () => {
    expect(buildRemotePermissionReplyBody({ action: 'deny', once: true, turn_id: 't1', digest: 'd1' }))
      .toEqual({ action: 'deny', once: true, turn_id: 't1', digest: 'd1' });
  });

  it('старый формат approved — совместимость', () => {
    expect(buildRemotePermissionReplyBody({ approved: true })).toEqual({ action: 'allow' });
    expect(buildRemotePermissionReplyBody({ approved: false })).toEqual({ action: 'deny' });
  });

  it('невалидные аддитивные поля не публикуются', () => {
    expect(buildRemotePermissionReplyBody({ action: 'allow', once: 'yes', turn_id: '  ', digest: 42 }))
      .toEqual({ action: 'allow' });
  });
});

describe('relayRemotePermissionReply', () => {
  it('успех — отдаёт status и тело', async () => {
    const client = fakeClient(async () => ({ status: 200, body: { status: 'ok' } }));
    const result = await relayRemotePermissionReply(client, 'rs-1', 'ap-1', { action: 'allow' });
    expect(result).toEqual({ ok: true, status: 200, body: { status: 'ok' } });
    expect((client.permissionReply as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith('rs-1', 'ap-1', { action: 'allow' });
  });

  it('4xx — ok:false с кодом и текстом удалённой стороны', async () => {
    const client = fakeClient(async () => ({
      status: 403,
      body: { error: { code: 'APPROVAL_DENIED', message: 'нет гранта' } },
    }));
    const result = await relayRemotePermissionReply(client, 'rs-1', 'ap-1', { action: 'deny' });
    expect(result).toEqual({
      ok: false,
      status: 403,
      error: 'нет гранта',
      code: 'APPROVAL_DENIED',
    });
  });

  it('4xx без тела — запасное сообщение', async () => {
    const client = fakeClient(async () => ({ status: 500, body: null }));
    const result = await relayRemotePermissionReply(client, 'rs-1', 'ap-1', { action: 'hold' });
    expect(result).toEqual({ ok: false, status: 500, error: 'Ошибка удалённого сервера' });
  });

  it('сетевая ошибка — ok:false с текстом, без броска', async () => {
    const client = fakeClient(async () => { throw new Error('Сервер недоступен'); });
    const result = await relayRemotePermissionReply(client, 'rs-1', 'ap-1', { action: 'allow' });
    expect(result).toEqual({ ok: false, error: 'Сервер недоступен' });
  });

  it('RemoteError — код сохраняется (401 UNAUTHORIZED в WS-кадре)', async () => {
    const client = fakeClient(async () => {
      throw new RemoteError('Не авторизован на удалённом сервере', 'UNAUTHORIZED');
    });
    const result = await relayRemotePermissionReply(client, 'rs-1', 'ap-1', { action: 'allow' });
    expect(result).toEqual({
      ok: false,
      error: 'Не авторизован на удалённом сервере',
      code: 'UNAUTHORIZED',
    });
  });
});
