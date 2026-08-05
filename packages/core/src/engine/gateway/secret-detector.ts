/**
 * Детекция секретов по регулярным выражениям (AD-036).
 * Чистая функция: text → уникальные значения секретов.
 */

/** Минимальная длина для «ключевых» секретов. */
const MIN_KEY_LENGTH = 12;

const PATTERNS: Array<{ type: string; regex: RegExp }> = [
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
 */
export function detectSecrets(text: string): string[] {
  if (!text) return [];

  const found = new Set<string>();

  for (const { type, regex } of PATTERNS) {
    regex.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(text)) !== null) {
      const raw = match[0].trim();
      if (!raw) continue;

      if (type === 'card') {
        if (!_isValidLuhn(raw)) continue;
      } else if (type !== 'email' && type !== 'base64') {
        if (raw.length < MIN_KEY_LENGTH) continue;
      }

      found.add(raw);
      if (regex.lastIndex === match.index) regex.lastIndex++;
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
