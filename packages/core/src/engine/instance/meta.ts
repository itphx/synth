/**
 * Workstream A1: снимок метаданных инстанса для read-only тула `synth_info`.
 *
 * Это **не** конфиг и не источник истины: снимок собирается один раз при
 * старте (`server/app/deps.ts` — standalone, `backend/app/deps.ts` — managed)
 * из уже резолвленных значений. Секретов здесь нет и быть не может: только
 * булевы признаки наличия ключей/настроек.
 */
export interface InstanceRuntimeMeta {
  /** Режим работы инстанса. */
  mode: 'standalone' | 'managed' | 'hybrid';
  /** Адрес сервера (host/port), если известен. */
  server?: { host?: string; port?: number };
  auth: {
    /**
     * Доминирующий способ аутентификации:
     * - `local-key` — авто-ключ standalone (`{dataDir}/secrets/api-key`);
     * - `api-key` — единый API-ключ (`auth.apiKey`/`SYNTH_API_KEY`);
     * - `oidc` — OIDC-провайдер;
     * - `debug` — debug-режим (тестовые ключи);
     * - `unknown` — не определено.
     */
    mode: 'local-key' | 'api-key' | 'oidc' | 'debug' | 'unknown';
    /** Файл `{dataDir}/secrets/api-key` существует (файл не читается). */
    localKeyPresent: boolean;
    /** API-ключ задан конфигом/env (значение не сохраняется). */
    apiKeyConfigured: boolean;
    oidcEnabled: boolean;
    debug: boolean;
  };
  storage: {
    backend: 'file' | 'memory' | 'postgres';
    /** Хранилище в деградированном read-only режиме (ADR-098). */
    degraded: boolean;
  };
  features: {
    mcp: boolean;
    metrics: boolean;
    memory: boolean;
    /** Режим перезапуска инстанса (`SYNTH_RESTART_MODE`, ADR-092). */
    restartMode: string;
  };
  /** Издание/редакция продукта, если известно (аддитивно). */
  edition?: string;
}
