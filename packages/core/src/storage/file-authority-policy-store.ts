import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import type { AuthorityPolicy } from '@itphx/synth-shared';
import { AsyncLock, atomicWrite, authorityPolicySchema } from '@itphx/synth-shared';
import type { AuthorityPolicyRepository } from './ports/authority-policy-repository.js';

export interface FileAuthorityPolicyStoreConfig {
  dataDir: string;
}

/**
 * PROP-108 Ф0: политика полномочий инстанса — один JSON-документ
 * `{dataDir}/authority/policy.json` (атомарная запись tmp→rename, ADR-005).
 *
 * Документа нет → `getPolicy()` возвращает `null` («политика не задана», ось
 * инстанса не применима). Документ с пустыми списками → «политика задана и
 * ничего не разрешает» (ось сужает до нуля). При чтении документ
 * **валидируется** схемой (`authorityPolicySchema`): битый/чужой формат не
 * превращается в «политику без грантов» молча — читается как отсутствие
 * политики, а решение остаётся fail-closed на оси «user».
 */
export class FileAuthorityPolicyStore implements AuthorityPolicyRepository {
  private _lock = new AsyncLock();

  constructor(private _config: FileAuthorityPolicyStoreConfig) {}

  private _filePath(): string {
    return join(this._config.dataDir, 'authority', 'policy.json');
  }

  /** Политика инстанца; `null` — документа нет или он невалиден. */
  async getPolicy(): Promise<AuthorityPolicy | null> {
    let raw: string;
    try {
      raw = await readFile(this._filePath(), 'utf8');
    } catch {
      return null;
    }
    let document: unknown;
    try {
      document = JSON.parse(raw) as unknown;
    } catch (err) {
      // Документ не разбирается — политика считается незаданной (fail-closed
      // на оси «user», а не «политика без грантов»).
      console.warn(
        `[FileAuthorityPolicyStore] документ политики Authority не разобран — считается отсутствующим: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return null;
    }
    const parsed = authorityPolicySchema.safeParse(document);
    if (!parsed.success) {
      console.warn(
        `[FileAuthorityPolicyStore] документ политики Authority невалиден — считается отсутствующим: ${
          parsed.error.issues
            .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
            .join('; ')
        }`,
      );
      return null;
    }
    return parsed.data;
  }

  /** Полная замена политики (атомарно). */
  async savePolicy(policy: AuthorityPolicy): Promise<void> {
    const validated = authorityPolicySchema.parse(policy);
    await this._lock.acquire();
    try {
      const path = this._filePath();
      await mkdir(dirname(path), { recursive: true });
      await atomicWrite(
        (p, d) => writeFile(p, d, 'utf-8'),
        (o, n) => rename(o, n),
        path,
        `${JSON.stringify(validated, null, 2)}\n`,
      );
    } finally {
      this._lock.release();
    }
  }
}
