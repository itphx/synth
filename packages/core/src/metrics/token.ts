/**
 * ADR-094: разрешение bearer-токена `/metrics`.
 *
 * Источники (инвариант 13 — секреты не в config.yaml):
 * 1) env `SYNTH_METRICS_TOKEN` (trim, пустое — «не задано»);
 * 2) файл `{dataDir}/secrets/metrics-token` (trim).
 *
 * Файл **не создаётся** и содержимое **не логируется**.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Путь к файлу токена: `{dataDir}/secrets/metrics-token`. */
export function metricsTokenPath(dataDir: string): string {
  return join(dataDir, 'secrets', 'metrics-token');
}

/** Токен `/metrics` или `undefined`, если не задан ни в env, ни в файле. */
export function resolveMetricsToken(dataDir: string): string | undefined {
  const fromEnv = process.env.SYNTH_METRICS_TOKEN?.trim();
  if (fromEnv) return fromEnv;
  try {
    const fromFile = readFileSync(metricsTokenPath(dataDir), 'utf-8').trim();
    return fromFile || undefined;
  } catch {
    return undefined;
  }
}
