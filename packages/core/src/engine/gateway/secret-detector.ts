/**
 * Детекция секретов по регулярным выражениям (AD-036).
 * Чистая функция: text → уникальные значения секретов.
 * Паттерны можно передавать извне (SecretPatternStore), по умолчанию — встроенный список.
 */

/** Минимальная длина для «ключевых» секретов. */
const MIN_KEY_LENGTH = 12;

/** Паттерн детекции: тип секрета + regex (готовый RegExp или сериализуемая строка-source). */
export interface SecretDetectorPattern {
  type: string;
  regex: RegExp | string;
}

/** Встроенный список паттернов по умолчанию (полностью заменяется пользовательским override). */
export const DEFAULT_PATTERNS: SecretDetectorPattern[] = [
  { type: 'openai', regex: /\bsk-[A-Za-z0-9_-]{20,}/g },
  { type: 'github', regex: /\bghp_[A-Za-z0-9]{36}\b/g },
  { type: 'github_pat', regex: /\bgithub_pat_[A-Za-z0-9_]{50,}/g },
  { type: 'aws', regex: /\bAKIA[0-9A-Z]{16}\b/g },
  { type: 'google', regex: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { type: 'stripe', regex: /\bsk_live_[0-9a-zA-Z]{24,}/g },
  { type: 'bearer', regex: /\bBearer\s+[A-Za-z0-9\-._~+/]{20,}/g },
  { type: 'email', regex: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g },
  { type: 'card', regex: /\b\d{13,16}\b/g },
  { type: 'base64', regex: /[A-Za-z0-9+/]{40,}={0,2}/g },
];

/**
 * Компилирует паттерн в глобальный RegExp (детектор использует regex.exec в цикле,
 * поэтому без флага 'g' exec зациклится на первом совпадении).
 */
function _toRegExp(regex: RegExp | string): RegExp {
  if (typeof regex === 'string') return new RegExp(regex, 'g');
  return regex.global ? regex : new RegExp(regex.source, 'g');
}

/** base64-подобная строка — только если без пробелов (regex уже исключает пробелы). */
function _isValidLuhn(candidate: string): boolean {
  if (!/^\d+$/.test(candidate)) return false;

  let sum = 0;
  let double = false;
  for (let i = candidate.length - 1; i >= 0; i--) {
    let digit = candidate.charCodeAt(i) - 48;
    if (double) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    double = !double;
  }
  return sum % 10 === 0;
}

/**
 * Находит подстроки-секреты в тексте.
 * Возвращает уникальные значения. Для ключей применяется порог длины MIN_KEY_LENGTH,
 * для номеров карт — проверка Luhn.
 * @param patterns паттерны детекции; по умолчанию — DEFAULT_PATTERNS.
 */
export function detectSecrets(
  text: string,
  patterns: SecretDetectorPattern[] = DEFAULT_PATTERNS,
): string[] {
  if (!text) return [];

  const found = new Set<string>();

  for (const { type, regex } of patterns) {
    const re = _toRegExp(regex);
    re.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = re.exec(text)) !== null) {
      const raw = match[0].trim();
      if (!raw) continue;

      if (type === 'card') {
        if (!_isValidLuhn(raw)) continue;
      } else if (type !== 'email' && type !== 'base64') {
        if (raw.length < MIN_KEY_LENGTH) continue;
      }

      found.add(raw);
      if (re.lastIndex === match.index) re.lastIndex++;
    }
  }

  return [...found];
}

/**
 * Маскирует секрет для логов и warning: только узнаваемый префикс, без полного значения.
 * Примеры: sk-***, ghp_***, Bearer ***, email***, card***.
 */
export function maskSecret(secret: string): string {
  const trimmed = secret.trim();
  if (!trimmed) return '';

  if (/^sk_live_/i.test(trimmed)) return 'sk_live_***';
  if (/^sk-/i.test(trimmed)) return 'sk-***';
  if (/^ghp_/i.test(trimmed)) return 'ghp_***';
  if (/^github_pat_/i.test(trimmed)) return 'github_pat_***';
  if (/^AKIA/.test(trimmed)) return 'AKIA***';
  if (/^AIza/.test(trimmed)) return 'AIza***';
  if (/^Bearer\s+/i.test(trimmed)) return 'Bearer ***';
  if (/^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(trimmed)) return 'email***';
  if (/^\d{13,16}$/.test(trimmed)) return 'card***';

  return `${trimmed.slice(0, 6)}***`;
}
