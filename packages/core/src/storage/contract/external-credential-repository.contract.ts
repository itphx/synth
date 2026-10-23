import { readFile, stat } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import type { CreateExternalCredentialInput } from '@itphx/synth-shared';
import type { ExternalCredentialRepository } from '../ports/index.js';

/** Очевидный тестовый токен: его не должно быть видно ни в выдаче, ни на диске. */
const ACCESS_TOKEN = 'ya29.test-access-token-do-not-leak';
const REFRESH_TOKEN = 'refresh-token-do-not-leak';

/** Вход создания доступа с правками по умолчанию. */
function input(over: Partial<CreateExternalCredentialInput> = {}): CreateExternalCredentialInput {
  return {
    provider: 'google',
    clientId: 'client-123',
    scopes: ['calendar.read'],
    owner: { kind: 'user', id: 'user-1' },
    accessToken: ACCESS_TOKEN,
    createdBy: 'user-1',
    ...over,
  };
}

/**
 * Паспорт порта `ExternalCredentialRepository` (ADR-105 Ф1, ADR-096).
 *
 * Проверки, обязательные для ЛЮБОЙ реализации:
 * - **уникальность id** — два создания дают разные id, явный дубль → отказ;
 * - **идемпотентность revoke** — повторный отзыв не меняет `revokedAt`;
 * - **нет plaintext в выдаче** — ни `list`/`get`, ни сериализация метаданных не
 *   содержат токен (только маска);
 * - **статус после ошибки refresh** — `markError` → `status:'error'`, успешное
 *   обновление токенов → снова `active`;
 * - **отозванный доступ не «оживает»** — обновление токенов и `markError` не
 *   снимают отзыв;
 * - **фильтры** — по владельцу/коннектору/провайдеру/статусу;
 * - **reveal** — возвращает исходный токен (единственный путь наружу к секрету,
 *   и только для подстановки в транспорт).
 *
 * Кейсы с `filePath` — файл-специфичные (на диске только `enc:v1:…`, права
 * `0600`); для in-memory/БД-реализации `filePath` не задаётся и они пропускаются.
 *
 * Деградация хранилища (ADR-098) — **общий HTTP-механизм**
 * (`server/storage-degraded.ts`: мутирующий метод → `503
 * STORAGE_DEGRADED_READONLY`), порт проверок не дублирует; её прогон —
 * существующий `server/storage-degraded.test.ts`.
 */
export function describeExternalCredentialRepository(
  name: string,
  make: () => Promise<{
    repo: ExternalCredentialRepository;
    dispose?: () => Promise<void>;
    /** Путь к JSON-файлу — только для файловой реализации. */
    filePath?: string;
  }>,
): void {
  describe(name, () => {
    it('пустой список — []; create → запись видна в get/list', async () => {
      const { repo } = await make();
      expect(await repo.list()).toEqual([]);

      const created = await repo.create(input());
      expect(created.provider).toBe('google');
      expect(created.clientId).toBe('client-123');
      expect(created.status).toBe('active');
      expect(created.owner).toEqual({ kind: 'user', id: 'user-1' });
      expect(created.scopes).toEqual(['calendar.read']);
      expect(created.hasRefreshToken).toBe(false);

      expect((await repo.get(created.id))?.id).toBe(created.id);
      const list = await repo.list();
      expect(list).toHaveLength(1);
      expect(list[0]!.id).toBe(created.id);
    });

    it('уникальность id: два создания — разные id; явный дубль — отказ', async () => {
      const { repo } = await make();
      const first = await repo.create(input());
      const second = await repo.create(input());
      expect(first.id).not.toBe(second.id);

      await expect(repo.create(input({ id: first.id }))).rejects.toThrow(/уже существует/);
      expect(await repo.list()).toHaveLength(2);
    });

    it('идемпотентность revoke: повторный отзыв не меняет revokedAt', async () => {
      const { repo } = await make();
      const created = await repo.create(input());

      const revoked = await repo.revoke(created.id);
      expect(revoked?.status).toBe('revoked');
      expect(revoked?.revokedAt).toBeTruthy();

      const revokedAgain = await repo.revoke(created.id);
      expect(revokedAgain?.status).toBe('revoked');
      expect(revokedAgain?.revokedAt).toBe(revoked?.revokedAt);
    });

    it('в метаданных и их сериализации нет plaintext-токена', async () => {
      const { repo } = await make();
      await repo.create(input({ refreshToken: REFRESH_TOKEN }));

      const list = await repo.list();
      const serialized = JSON.stringify(list);
      expect(serialized).not.toContain(ACCESS_TOKEN);
      expect(serialized).not.toContain(REFRESH_TOKEN);
      // В метаданных нет полей с секретом вовсе.
      expect(Object.keys(list[0]!)).not.toContain('secretEnc');
      expect(Object.keys(list[0]!)).not.toContain('refreshEnc');
      // Маска — необратимая сводка, секрет не раскрывает.
      expect(list[0]!.secretMask.startsWith('mask:')).toBe(true);
      expect(list[0]!.secretMask).not.toContain(ACCESS_TOKEN);
    });

    it('ошибка refresh переводит доступ в status=error; новый токен — снова active', async () => {
      const { repo } = await make();
      const created = await repo.create(input());

      // `invalid_grant` на стороне провайдера — требуется переавторизация.
      const failed = await repo.markError(created.id);
      expect(failed?.status).toBe('error');

      const refreshed = await repo.updateTokens(created.id, { accessToken: 'new-access-token' });
      expect(refreshed?.status).toBe('active');
      expect((await repo.reveal(created.id))?.accessToken).toBe('new-access-token');
    });

    it('отозванный доступ не «оживает» (обновление токенов и markError)', async () => {
      const { repo } = await make();
      const created = await repo.create(input());
      await repo.revoke(created.id);

      const afterUpdate = await repo.updateTokens(created.id, { accessToken: 'another-token' });
      expect(afterUpdate?.status).toBe('revoked');

      const afterError = await repo.markError(created.id);
      expect(afterError?.status).toBe('revoked');
    });

    it('reveal отдаёт исходные токены; неизвестный id — null', async () => {
      const { repo } = await make();
      const created = await repo.create(input({ refreshToken: REFRESH_TOKEN }));

      const revealed = await repo.reveal(created.id);
      expect(revealed?.accessToken).toBe(ACCESS_TOKEN);
      expect(revealed?.refreshToken).toBe(REFRESH_TOKEN);
      expect(await repo.reveal('missing')).toBeNull();
    });

    it('фильтры list: владелец, коннектор, провайдер, статус', async () => {
      const { repo } = await make();
      const mine = await repo.create(input({ connectorId: 'mcp_1' }));
      await repo.create(
        input({
          provider: 'github',
          connectorId: 'mcp_2',
          owner: { kind: 'instance', id: 'instance' },
        }),
      );

      expect(
        (await repo.list({ owner: { kind: 'user', id: 'user-1' } })).map((c) => c.id),
      ).toEqual([mine.id]);
      expect((await repo.list({ connectorId: 'mcp_2' })).map((c) => c.id)).toHaveLength(1);
      expect((await repo.list({ provider: 'github' })).map((c) => c.id)).toHaveLength(1);
      expect((await repo.list({ status: 'active' })).map((c) => c.id)).toHaveLength(2);
      expect((await repo.list({ status: 'revoked' })).map((c) => c.id)).toHaveLength(0);
    });

    it('touch отмечает использование (lastUsedAt)', async () => {
      const { repo } = await make();
      const created = await repo.create(input());
      expect((await repo.get(created.id))?.lastUsedAt).toBeUndefined();

      await repo.touch(created.id);
      expect((await repo.get(created.id))?.lastUsedAt).toBeTruthy();
      // Неизвестный id — no-op, без ошибки.
      await expect(repo.touch('missing')).resolves.toBeUndefined();
    });

    it('операции с неизвестным id возвращают null (без исключения)', async () => {
      const { repo } = await make();
      expect(await repo.get('missing')).toBeNull();
      expect(await repo.updateTokens('missing', { accessToken: 'x' })).toBeNull();
      expect(await repo.markError('missing')).toBeNull();
      expect(await repo.revoke('missing')).toBeNull();
    });

    it('listRaw отдаёт зашифрованные секреты, но не plaintext', async () => {
      const { repo } = await make();
      await repo.create(input());

      const raw = await repo.listRaw();
      expect(raw).toHaveLength(1);
      expect(raw[0]!.secretEnc.startsWith('enc:v1:')).toBe(true);
      expect(JSON.stringify(raw)).not.toContain(ACCESS_TOKEN);
    });

    it('файловая реализация: на диске только enc:v1:…, plaintext отсутствует', async () => {
      const { repo, filePath } = await make();
      if (!filePath) return;

      await repo.create(input({ refreshToken: REFRESH_TOKEN }));
      const raw = await readFile(filePath, 'utf-8');
      expect(raw).not.toContain(ACCESS_TOKEN);
      expect(raw).not.toContain(REFRESH_TOKEN);
      expect(raw).toContain('enc:v1:');
    });

    it('файловая реализация: файл доступов лежит в secrets/ и имеет права 0600', async () => {
      const { repo, filePath } = await make();
      if (!filePath) return;

      await repo.create(input());
      const info = await stat(filePath);
      expect(info.isFile()).toBe(true);
      // Права файла: 0600 (только владелец).
      expect(info.mode & 0o777).toBe(0o600);
      // Файл внутри `secrets/` — обычный бэкап без `--with-secrets` его не берёт.
      expect(filePath.replace(/\\/g, '/')).toContain('/secrets/');
    });
  });
}
