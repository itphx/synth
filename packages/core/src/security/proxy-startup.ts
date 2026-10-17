/**
 * ADR-099: стартовое применение runtime-override прокси.
 *
 * Порядок инициализации процесса:
 * 1. `initTlsTrust` — TLS/CA и **первичный** прокси из config/env (нужен для
 *    подключения к PostgreSQL и других стартовых запросов);
 * 2. сборка слоя хранения — появляется `settingsStore`;
 * 3. `applyStartupProxyConfig` — дочитывает `RuntimeSettings.proxy` (UI) и
 *    пересобирает `EgressDispatcher` **до** создания deps/провайдеров.
 *
 * Живого переключения нет: `PUT /settings/proxy` только сохраняет, изменения
 * вступают в силу при следующем старте.
 */
import type { ProxyConfig, ProxyConfigSource } from '@itphx/synth-shared';
import {
  applyEgressProxyConfig,
  type ApplyEgressProxyDeps,
} from './tls.js';

/** Минимальный срез порта настроек, нужный старту (без цикла security → storage). */
export interface ProxySettingsSource {
  getProxySettings(): Promise<Partial<ProxyConfig> | undefined>;
}

/**
 * Прочитать runtime-override прокси из хранилища и применить эффективную
 * конфигурацию (config ← runtime ← явные `SYNTH_PROXY_*`).
 */
export async function applyStartupProxyConfig(
  settings: ProxySettingsSource,
  config: ProxyConfigSource | undefined,
  env: NodeJS.ProcessEnv = process.env,
  deps: ApplyEgressProxyDeps = {},
): Promise<void> {
  const runtime = await settings.getProxySettings();
  await applyEgressProxyConfig(config, env, { ...deps, runtime });
}
