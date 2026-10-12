import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { randomInt } from 'node:crypto';
import { AsyncLock, atomicWrite, safeJsonParse } from '@itphx/synth-shared';

/** AD-089 (claim-flow): версия схемы файла claim-кодов (для будущей миграции AD-032). */
export const IDENTITY_CLAIMS_SCHEMA_VERSION = 1;

/**
 * AD-089 (claim-flow): TTL claim-кода по умолчанию — 10 минут. Короткий срок
 * жизни ограничивает окно подбора кода и «устаревание» привязки.
 */
export const IDENTITY_CLAIM_TTL_SEC = 600;

/**
 * AD-089 (claim-flow): алфавит кода — base32 **без похожих символов**
 * (`0/O/1/I` исключены), чтобы код было удобно вводить в чат/UI. 32 символа.
 */
export const IDENTITY_CLAIM_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';

/** AD-089: длина значимой части кода (без дефиса). `32^6 ≈ 2^30` — пространство подбора. */
export const IDENTITY_CLAIM_LENGTH = 6;

/** AD-089: дней до удаления потреблённых/истёкших claim'ов при `cleanup`. */
const CONSUMED_RETENTION_SEC = IDENTITY_CLAIM_TTL_SEC;

/** AD-089 (claim-flow): запись одноразового кода подтверждения владения id. */
export interface IdentityClaimRecord {
  /** Человековводимый код `XXX-XXX` (канонический вид, с дефисом). */
  code: string;
  /** Префикс principalId (напр. `tg`) — берётся из события ingest. */
  provider: string;
  /** Числовой id в источнике (строкой) — берётся из события ingest. */
  externalId: string;
  /** Ключ чата источника (если задан) — для диагностики «переноса» кода. */
  chatKey?: string;
  /** Полный principalId отправителя (для аудита). */
  principalId: string;
  /** ISO-8601. */
  createdAt: string;
  /** ISO-8601 — после этого момента код недействителен. */
  expiresAt: string;
  /** ISO-8601 — момент использования (одноразовость); заполнен → код мёртв. */
  consumedAt?: string;
}

export interface IdentityClaimStoreConfig {
  dataDir: string;
}

interface ClaimsFile {
  schemaVersion: number;
  claims: IdentityClaimRecord[];
}

/**
 * AD-089 (claim-flow): хранилище одноразовых claim-кодов — подтверждение
 * владения внешней идентичностью (`provider`+`externalId`).
 *
 * Поток: ingest неизвестного отправителя создаёт код (`create`) и возвращает его
 * шлюзу; пользователь вводит код в профиле; `POST /me/identities/claim` вызывает
 * `consume`, после чего ядро привязывает идентичность к профилю (`linkIdentity`).
 *
 * Хранится одним JSON-файлом `{dataDir}/events/identity-claims.json` (AD-005,
 * атомарная запись tmp→rename). `provider`/`externalId` берутся из **серверной**
 * записи, а не из тела запроса на подтверждение, — подставить чужой id нельзя.
 * Код одноразовый: `consume` помечает `consumedAt` и повторно не срабатывает.
 */
export class IdentityClaimStore {
  private _lock = new AsyncLock();

  constructor(private _config: IdentityClaimStoreConfig) {}

  private _filePath(): string {
    return join(this._config.dataDir, 'events', 'identity-claims.json');
  }

  /**
   * Нормализация вводимого кода: верхний регистр, удаление дефисов и пробелов.
   * Регистронезависимый и «прощающий» ввод (`abc-def`, ` ABC DEF `, `abcdef`).
   */
  static normalizeCode(code: string): string {
    return code.toUpperCase().replace(/[^0-9A-Z]/g, '');
  }

  /** Канонический вид кода с дефисом: `ABCDEF` → `ABC-DEF`. */
  private static _formatCode(raw: string): string {
    const mid = Math.floor(raw.length / 2);
    return `${raw.slice(0, mid)}-${raw.slice(mid)}`;
  }

  /** Генерация одного «сырого» кода (без дефиса) из алфавита без похожих символов. */
  private static _generateRaw(): string {
    let out = '';
    for (let i = 0; i < IDENTITY_CLAIM_LENGTH; i += 1) {
      out += IDENTITY_CLAIM_ALPHABET[randomInt(IDENTITY_CLAIM_ALPHABET.length)];
    }
    return out;
  }

  private async _load(): Promise<ClaimsFile> {
    try {
      const raw = await readFile(this._filePath(), 'utf-8');
      const parsed = safeJsonParse<ClaimsFile | null>(raw, null);
      if (!parsed || !Array.isArray(parsed.claims)) {
        return { schemaVersion: IDENTITY_CLAIMS_SCHEMA_VERSION, claims: [] };
      }
      return {
        schemaVersion: parsed.schemaVersion ?? IDENTITY_CLAIMS_SCHEMA_VERSION,
        claims: parsed.claims.filter(
          (c): c is IdentityClaimRecord => !!c && typeof c.code === 'string' && typeof c.principalId === 'string',
        ),
      };
    } catch {
      return { schemaVersion: IDENTITY_CLAIMS_SCHEMA_VERSION, claims: [] };
    }
  }

  private async _save(file: ClaimsFile): Promise<void> {
    const path = this._filePath();
    await mkdir(dirname(path), { recursive: true });
    const data = JSON.stringify(
      { schemaVersion: IDENTITY_CLAIMS_SCHEMA_VERSION, claims: file.claims },
      null,
      2,
    );
    await atomicWrite(
      (p, d) => writeFile(p, d, 'utf-8'),
      (o, n) => rename(o, n),
      path,
      data,
    );
  }

  /**
   * Создаёт claim-код для пары `provider`+`externalId`. Код генерируется заново
   * при коллизии (включая уже потреблённые/истёкшие записи — они ещё в файле).
   * `ttlSec` — срок жизни в секундах (по умолчанию {@link IDENTITY_CLAIM_TTL_SEC}).
   */
  async create(input: {
    provider: string;
    externalId: string;
    chatKey?: string;
    principalId: string;
    ttlSec?: number;
  }): Promise<IdentityClaimRecord> {
    await this._lock.acquire();
    try {
      const file = await this._load();
      const existing = new Set(file.claims.map((c) => c.code));

      let code = '';
      for (let attempt = 0; attempt < 20; attempt += 1) {
        const candidate = IdentityClaimStore._formatCode(IdentityClaimStore._generateRaw());
        if (!existing.has(candidate)) {
          code = candidate;
          break;
        }
      }
      if (!code) throw new Error('не удалось сгенерировать уникальный claim-код');

      const ttlSec = input.ttlSec ?? IDENTITY_CLAIM_TTL_SEC;
      const now = Date.now();
      const claim: IdentityClaimRecord = {
        code,
        provider: input.provider,
        externalId: input.externalId,
        ...(input.chatKey ? { chatKey: input.chatKey } : {}),
        principalId: input.principalId,
        createdAt: new Date(now).toISOString(),
        expiresAt: new Date(now + ttlSec * 1000).toISOString(),
      };
      file.claims.push(claim);
      await this._save(file);
      return claim;
    } finally {
      this._lock.release();
    }
  }

  /**
   * Потребляет код (одноразово). Возвращает запись и помечает `consumedAt`.
   *
   * Валидация: код нормализуется (регистр/дефисы/пробелы), должен существовать,
   * быть не потреблённым и не истёкшим; при заданных `provider`/`externalId`
   * проверяется, что код выдан ровно для этой пары. Так код нельзя
   * «переиспользовать» между чатами/идентичностями: он гасится при первом
   * успешном подтверждении, а привязка берётся из серверной записи.
   */
  async consume(
    code: string,
    opts: { userId: string; provider?: string; externalId?: string },
  ): Promise<IdentityClaimRecord | null> {
    void opts.userId; // аудит подтвердившего — по `linkedBy` при linkIdentity
    const normalized = IdentityClaimStore.normalizeCode(code);
    if (!normalized) return null;

    await this._lock.acquire();
    try {
      const file = await this._load();
      const now = Date.now();
      const claim = file.claims.find(
        (c) => IdentityClaimStore.normalizeCode(c.code) === normalized,
      );
      if (!claim) return null;
      if (claim.consumedAt) return null;
      if (Date.parse(claim.expiresAt) <= now) return null;

      // Скоуп: код привязан к серверной паре provider+externalId — при заданных
      // ожиданиях проверяем совпадение (защита от подстановки из тела запроса).
      if (opts.provider && opts.provider !== claim.provider) return null;
      if (opts.externalId && opts.externalId !== claim.externalId) return null;

      claim.consumedAt = new Date(now).toISOString();
      await this._save(file);
      return claim;
    } finally {
      this._lock.release();
    }
  }

  /**
   * Удаляет мёртвые записи: истёкшие и потреблённые старше `retention` (по
   * умолчанию {@link IDENTITY_CLAIM_TTL_SEC}). Возвращает число удалённых.
   */
  async cleanup(now: number = Date.now()): Promise<number> {
    await this._lock.acquire();
    try {
      const file = await this._load();
      const next = file.claims.filter((c) => {
        if (Date.parse(c.expiresAt) <= now) return false;
        if (c.consumedAt && now - Date.parse(c.consumedAt) > CONSUMED_RETENTION_SEC * 1000) return false;
        return true;
      });
      const removed = file.claims.length - next.length;
      if (removed === 0) return 0;
      file.claims = next;
      await this._save(file);
      return removed;
    } finally {
      this._lock.release();
    }
  }

  /** Все записи (для тестов/аудита); при `activeOnly` — только живые. */
  async list(activeOnly = false): Promise<IdentityClaimRecord[]> {
    const file = await this._load();
    if (!activeOnly) return [...file.claims];
    const now = Date.now();
    return file.claims.filter((c) => !c.consumedAt && Date.parse(c.expiresAt) > now);
  }
}
