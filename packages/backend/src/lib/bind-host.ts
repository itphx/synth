/**
 * Адрес прослушивания backend (аудит F5, безопасный дефолт).
 *
 * Вне контейнера backend по умолчанию слушает **loopback** (`127.0.0.1`):
 * публикация порта наружу — только явным `SYNTH_HOST`. В контейнере/K8s
 * (образ, Helm-чарт, docker-compose) — `0.0.0.0`, иначе порт не был бы доступен
 * снаружи контейнера.
 *
 * `SYNTH_HOST` приоритетен всегда (явная настройка оператора).
 */
import { existsSync } from 'node:fs';

/**
 * Признак контейнера: маркер Docker (`/.dockerenv`), окружение Kubernetes
 * (`KUBERNETES_SERVICE_HOST`) либо явный `SYNTH_IN_CONTAINER` (образ/split-режим).
 */
export function detectContainer(
  env: NodeJS.ProcessEnv = process.env,
  dockerEnvFileExists: (path: string) => boolean = existsSync,
): boolean {
  if (dockerEnvFileExists('/.dockerenv')) return true;
  if (env.KUBERNETES_SERVICE_HOST) return true;
  return env.SYNTH_IN_CONTAINER === 'true' || env.SYNTH_IN_CONTAINER === '1';
}

/**
 * Итоговый bind-host: `SYNTH_HOST` > контейнер (`0.0.0.0`) > loopback.
 * Пустой `SYNTH_HOST` трактуется как «не задан».
 */
export function resolveBindHost(env: NodeJS.ProcessEnv, isContainer: boolean): string {
  const explicit = env.SYNTH_HOST?.trim();
  if (explicit) return explicit;
  return isContainer ? '0.0.0.0' : '127.0.0.1';
}
