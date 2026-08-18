/**
 * Output Guard (AD-036): детекция секретов в ответе модели.
 * Галлюцинированные/украденные ключи фиксируются, но не модифицируют ответ.
 */

import { detectSecrets } from './secret-detector.js';
import type { SecretPattern } from './secret-pattern-store.js';

const SUSPICIOUS_URL_REGEX = /https?:\/\/[^\s]+/gi;

export interface OutputGuardResult {
  found: string[];
  /** Есть ли что-то подозрительное: секреты или http-ссылки внутри контента. */
  suspicious: boolean;
}

export function runOutputGuard(text: string, patterns?: SecretPattern[]): OutputGuardResult {
  const found = detectSecrets(text, patterns);
  const hasHttpLinks = SUSPICIOUS_URL_REGEX.test(text);
  return { found, suspicious: found.length > 0 || hasHttpLinks };
}
