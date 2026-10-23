/**
 * ADR-105 (Ф4): запись операций со слоем доступов в append-only журнал.
 *
 * Единая точка записи для всех операций над доступом (`issue`/`refresh`/
 * `revoke`/`bind`/`use`) — порт `CredentialAuditRepository`
 * (`packages/core/src/storage/ports/credential-audit-repository.ts`).
 *
 * **Что в записи есть:** id доступа, провайдер, операция, исход, код ошибки
 * (машинно-читаемый) и — для `bind`/`use` — id MCP-коннектора.
 *
 * **Чего в записи нет (никогда):** значение access/refresh-токена, `secretEnc`,
 * `code_verifier`/`client_secret`, сырые пути, id сессий и id пользователей
 * (ADR-105 §7, §10). Поэтому `actor` (id пользователя) и `projectId` в этом
 * контуре **не заполняются** — журнал отвечает на вопрос «каким доступом и с
 * каким исходом оперировали», а не «кто именно».
 *
 * Запись — **best-effort**: сбой журналирования не ломает саму операцию
 * (доступ уже выдан/отозван — это состояние хранилища).
 */
import type {
  ExternalCredentialAuditEntry,
  ExternalCredentialAuditOp,
  ExternalCredentialAuditOutcome,
} from '@itphx/synth-shared';
import { generateId } from '@itphx/synth-shared';
import type { CredentialAuditRepository } from '../../storage/ports/credential-audit-repository.js';

/** Префикс id записи журнала операций со слоем доступов. */
export const CREDENTIAL_AUDIT_ID_PREFIX = 'ca_';

/** Вход записи журнала (без id/времени — их формирует сам журнал). */
export interface CredentialAuditInput {
  /** Вид операции. */
  op: ExternalCredentialAuditOp;
  /** id доступа. */
  credentialId: string;
  /** Ключ OAuth-провайдера. */
  provider: string;
  /** Исход операции. */
  outcome: ExternalCredentialAuditOutcome;
  /** Машинно-читаемый код ошибки (без текста секрета). */
  errorCode?: string;
  /** id MCP-коннектора (для `bind`/`use`). */
  connectorId?: string;
}

/**
 * Записать операцию в журнал (best-effort).
 *
 * Порт не задан (сборка без хранилища) — операция не падает. Ошибка записи
 * (деградация хранилища, недоступность БД) — тоже не ломает операцию.
 */
export async function recordCredentialAudit(
  audit: CredentialAuditRepository | undefined,
  input: CredentialAuditInput,
): Promise<void> {
  if (!audit) return;
  const entry: ExternalCredentialAuditEntry = {
    id: `${CREDENTIAL_AUDIT_ID_PREFIX}${generateId()}`,
    ts: new Date().toISOString(),
    op: input.op,
    credentialId: input.credentialId,
    provider: input.provider,
    outcome: input.outcome,
    ...(input.errorCode !== undefined ? { errorCode: input.errorCode } : {}),
    ...(input.connectorId !== undefined ? { connectorId: input.connectorId } : {}),
  };
  try {
    await audit.append(entry);
  } catch {
    // Журналирование — best-effort: сбой записи не должен ломать операцию.
  }
}

/**
 * Машинно-читаемый код ошибки для журнала.
 *
 * Берётся код `OAuthError` (без текста: текст может содержать детали
 * провайдера), для прочих ошибок — имя класса-конструктора.
 */
export function credentialAuditErrorCode(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && code.length > 0) return code;
  if (err instanceof Error && err.name) return err.name;
  return 'unknown_error';
}
