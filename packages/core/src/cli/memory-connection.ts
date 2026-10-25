/**
 * ADR-107 / PROP-047 §2.1: подключение CLI `synth memory …` к инстансу —
 * адрес и API-ключ.
 *
 * Один резолвер для обоих entry point'ов CLI (`packages/core/src/main.ts` —
 * dev/standalone, `packages/synth/src/cli.ts` — публикуемый `synth`): правила
 * не должны расходиться, иначе `synth memory` ведёт себя по-разному в
 * зависимости от способа установки.
 *
 * **Адрес:** `--url` → `remote.backendUrl` (если `remote.enabled`) →
 * `http://127.0.0.1:<port>`, где порт — `SYNTH_PORT` → `core.port` → 5000.
 *
 * **Ключ:** `--token` → `SYNTH_API_KEY` → `core.apiKey` → файл
 * `{dataDir}/secrets/api-key` (файл **читается**, не создаётся — создаёт сервер
 * при старте). Значение ключа нигде не печатается (инвариант 13).
 *
 * Доверие TLS/CA применяется здесь же (ADR-099) — **до** первого исходящего
 * запроса к инстансу; транспорт запросов — `egressFetch` (единый egress-слой),
 * его подставляет вызывающая сторона.
 */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import {
  loadConfig,
  resolveDataDir,
  resolveHome,
  resolvePort,
  type SynthConfig,
} from '@itphx/synth-shared';

import { localApiKeyFilePath } from '../auth/local-key.js';
import { initTlsTrust } from '../security/tls.js';

/** Опции подключения (общие для всех подкоманд `synth memory`). */
export interface MemoryConnectionOptions {
  /** Базовый URL инстанса (`--url`). */
  url?: string;
  /** Bearer-токен (`--token`). */
  token?: string;
  /** Путь к config.yaml (`--config`). */
  config?: string;
  /** Каталог данных (`--data-dir`). */
  dataDir?: string;
}

/** Резолвнутое подключение: базовый URL (без `/api/v2`) и токен. */
export interface MemoryCliConnection {
  baseUrl: string;
  token: string;
}

/**
 * Фабрика резолвера подключения.
 *
 * `initTls` — необязательная подмена инициализации доверия TLS/CA (тесты);
 * по умолчанию — `initTlsTrust` из egress-слоя (ADR-099).
 */
export function createMemoryConnectionResolver(overrides?: {
  initTls?: (synth: SynthConfig, opts: { home?: string | null; dataDir?: string }) => Promise<void>;
}): (options: MemoryConnectionOptions) => Promise<MemoryCliConnection> {
  const initTls =
    overrides?.initTls ??
    (async (synth, opts) => {
      try {
        const dataDir = opts.dataDir
          ? resolve(opts.dataDir)
          : resolveDataDir(synth, undefined, opts.home ?? null);
        await initTlsTrust({ security: synth.security, proxy: synth.proxy }, process.env, { dataDir });
      } catch (err) {
        console.error(
          `Ошибка инициализации доверия TLS/CA: ${err instanceof Error ? err.message : String(err)}`,
        );
        process.exit(1);
      }
    });

  return async (options) => {
    const home = resolveHome(undefined);
    const synth = await loadConfig({ configPath: options.config, home: home ?? undefined });
    const dataDir = resolve(options.dataDir || resolveDataDir(synth, undefined, home));
    await initTls(synth, { home, dataDir });

    let baseUrl = (options.url ?? '').trim();
    if (!baseUrl && synth.remote.enabled) baseUrl = synth.remote.backendUrl.trim();
    if (!baseUrl) {
      const port = resolvePort(synth, 'SYNTH_PORT', synth.core.port || 5000);
      baseUrl = `http://127.0.0.1:${port}`;
    }

    let token = (options.token ?? '').trim();
    if (!token) token = (process.env.SYNTH_API_KEY ?? '').trim();
    if (!token) token = (synth.core.apiKey ?? '').trim();
    if (!token) {
      token = (await readFile(localApiKeyFilePath(dataDir), 'utf-8').catch(() => '')).trim();
    }

    return { baseUrl, token };
  };
}
