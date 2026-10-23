// ADR-105 (Ф3): право привязки внешнего доступа к коннектору проверяется
// **на границе** (инвариант 16), а не размазывается по обработчикам: правило —
// в `engine/oauth/credential-binding.ts`, здесь — только сбор актора, чтение
// доступа из порта и маппинг решения в код ответа.
//
// Один факт нарушения доступа → один код (403), отсутствие доступа → 404:
// смешения 403/404 для «чужой/несуществующий» нет.
import type { Context } from 'hono';
import type { McpServerConfig } from '@itphx/synth-shared';
import { evaluateCredentialBind } from '../engine/oauth/credential-binding.js';
import type { CredentialBindActor } from '../engine/oauth/credential-binding.js';
import type { ExternalCredentialRepository } from '../storage/ports/external-credential-repository.js';

/** Локализуемые сообщения (core — литералы, backend — i18n). */
export interface CredentialBindGuardMessages {
  notFound: (c: Context) => string;
  forbidden: (c: Context) => string;
}

export interface CredentialBindGuardOptions {
  /**
   * Порт слоя доступов (ADR-096). Не задан — право проверить нечем →
   * привязка запрещена (fail-closed).
   */
  credentials?: ExternalCredentialRepository;
  /** Актор запроса: пользователь инстанса или service-key (ADR-052). */
  resolveActor: (c: Context) => CredentialBindActor | Promise<CredentialBindActor>;
  /**
   * Право участника проекта **изменять содержимое** проекта (`OWNER`/`EDITOR`,
   * а также `LEAD`/`ADMIN`). Не задано — проектный доступ привязать нельзя.
   */
  canEditProject?: (c: Context, projectId: string) => boolean | Promise<boolean>;
  /** Сообщения об отказе. */
  messages?: Partial<CredentialBindGuardMessages>;
}

/** Нарушение права привязки: код ответа + текст для оператора. */
export interface CredentialBindViolation {
  code: 'NOT_FOUND' | 'FORBIDDEN';
  message: string;
}

const DEFAULT_MESSAGES: CredentialBindGuardMessages = {
  notFound: () => 'Внешний доступ не найден',
  forbidden: () => 'Привязать этот внешний доступ нельзя',
};

/**
 * Проверка права привязки доступа к коннектору.
 *
 * Возвращает нарушение (`NOT_FOUND`/`FORBIDDEN`) или `null`, если привязка
 * разрешена. Вызывается в точке записи `auth` в коннектор (реестр MCP).
 *
 * - привязки в конфиге нет (`auth` не задан) — проверять нечего;
 * - привязка не меняется (тот же `credentialId`) — право уже проверено при
 *   первой записи;
 * - порт доступов не подключён — отказ (fail-closed).
 */
export function createCredentialBindGuard(
  opts: CredentialBindGuardOptions,
): (
  c: Context,
  config: McpServerConfig | undefined | null,
  previousCredentialId?: string,
) => Promise<CredentialBindViolation | null> {
  const messages: CredentialBindGuardMessages = { ...DEFAULT_MESSAGES, ...opts.messages };

  return async (c, config, previousCredentialId) => {
    const credentialId =
      config?.auth?.kind === 'credential' ? config.auth.credentialId : undefined;
    if (!credentialId) return null;
    if (credentialId === previousCredentialId) return null;

    if (!opts.credentials) {
      return { code: 'FORBIDDEN', message: messages.forbidden(c) };
    }

    const credential = await opts.credentials.get(credentialId);
    const actor = await opts.resolveActor(c);
    const decision = await evaluateCredentialBind({
      credential,
      actor,
      ...(opts.canEditProject
        ? { canEditProject: (projectId: string) => opts.canEditProject!(c, projectId) }
        : {}),
    });

    if (decision.allowed) return null;
    return {
      code: decision.code,
      message: decision.code === 'NOT_FOUND' ? messages.notFound(c) : messages.forbidden(c),
    };
  };
}
