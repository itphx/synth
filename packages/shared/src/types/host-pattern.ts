/**
 * Единая семантика правил хоста (ADR-099 — TLS/proxy; PROP-124 — политика
 * SSH-ключей).
 *
 * Модуль **browser-safe** (без `node:*`): его читают и роуты ядра, и UI
 * (`@itphx/synth-shared/types`). Поэтому реализация `normalizeTlsHost` /
 * `matchTlsHostPattern` живёт здесь, а `config/tls.ts` её переиспользует —
 * второй матчер шаблонов хоста в кодовой базе не заводим (ADR-099: семантика
 * шаблона хоста общая для TLS, egress-политики и SSH).
 *
 * Грамматика правила:
 * - **точный hostname** (`git.example.com`);
 * - **`*.suffix`** — только поддомены (сам `suffix` требует отдельного правила);
 * - **IP-литерал** (`10.0.0.5`) и **CIDR** (`10.0.0.0/8`) — адресные правила,
 *   которые матчатся **только по IP-литералу** хоста (никогда по hostname);
 * - одиночный **`*`** («любой хост») — **недопустим** в правилах политики
 *   (fail-closed): иначе исключение разрешило бы любой адрес. В TLS-профилях
 *   `*` допустим (см. `matchTlsHostPattern`) — там это явный выбор админа.
 */

/** Допустимый hostname (в т.ч. `*.suffix`): буквы/цифры/дефис/подчёркивание и точки. */
const HOSTNAME_RULE_RE =
  /^(\*\.)?[a-z0-9_](?:[a-z0-9_-]*[a-z0-9_])?(?:\.[a-z0-9_](?:[a-z0-9_-]*[a-z0-9_])?)*\.?$/i;

/** Нормализует host (нижний регистр, без точки в конце и скобок IPv6). */
export function normalizeTlsHost(rawHost: string | undefined): string | undefined {
  if (typeof rawHost !== 'string') return undefined;
  let host = rawHost.trim().toLowerCase().replace(/\.$/, '');
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  return host === '' ? undefined : host;
}

/**
 * Матчинг одного шаблона (`host` | `*.suffix` | `*`); регистронезависимо.
 *
 * `*` («любой хост») здесь допустим — им пользуются TLS-профили per-host
 * (ADR-099). Для **политик** (`allowHosts` SSH-ключа) `*` недопустим —
 * это проверяет `isValidHostRule`.
 */
export function matchTlsHostPattern(pattern: string, rawHost: string): boolean {
  const host = normalizeTlsHost(rawHost);
  if (host === undefined) return false;
  const value = pattern.trim().toLowerCase().replace(/\.$/, '');
  if (value === '*') return true;
  if (value.startsWith('*.')) {
    const suffix = value.slice(2);
    return suffix !== '' && host.endsWith(`.${suffix}`);
  }
  return host === value;
}

/** IPv4-литерал (`10.0.0.5`); ведущие нули не допускаются (как в `net.isIP`). */
function isIpv4Literal(value: string): boolean {
  const parts = value.split('.');
  if (parts.length !== 4) return false;
  return parts.every(
    (part) =>
      /^\d{1,3}$/.test(part) &&
      Number(part) <= 255 &&
      (part === '0' || !part.startsWith('0')),
  );
}

/**
 * IPv6-литерал: восемь групп, сжатие `::` (хотя бы одну группу) и встроенный
 * IPv4 в последней группе.
 */
function isIpv6Literal(value: string): boolean {
  if (!value.includes(':')) return false;
  const halves = value.split('::');
  if (halves.length > 2) return false;

  const countGroups = (part: string): number | null => {
    if (part === '') return 0;
    const groups = part.split(':');
    let count = 0;
    for (let i = 0; i < groups.length; i++) {
      const group = groups[i]!;
      if (group.includes('.')) {
        // Встроенный IPv4 допустим только в последней группе и занимает 2 группы.
        if (i !== groups.length - 1) return null;
        if (!isIpv4Literal(group)) return null;
        count += 2;
        continue;
      }
      if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return null;
      count += 1;
    }
    return count;
  };

  const head = countGroups(halves[0]!);
  if (head === null) return false;
  if (halves.length === 1) return head === 8;
  const tail = countGroups(halves[1]!);
  if (tail === null) return false;
  // `::` обязан сжимать хотя бы одну группу из восьми.
  return head + tail <= 7;
}

/** IP-литерал любого семейства. */
export function isIpLiteral(value: string): boolean {
  return isIpv4Literal(value) || isIpv6Literal(value);
}

/** CIDR-правило: адресная часть — IP-литерал, префикс — в границах семейства. */
function isCidrRule(value: string): boolean {
  const slash = value.lastIndexOf('/');
  if (slash <= 0) return false;
  const address = value.slice(0, slash);
  const prefixRaw = value.slice(slash + 1);
  if (!/^\d{1,3}$/.test(prefixRaw)) return false;
  const prefix = Number(prefixRaw);
  if (isIpv4Literal(address)) return prefix <= 32;
  if (isIpv6Literal(address)) return prefix <= 128;
  return false;
}

/**
 * Валидна ли одна запись правила хоста: точный hostname, `*.suffix`, IP-литерал
 * или CIDR. Пустые строки, regex-подобные записи и одиночный `*` — невалидны.
 *
 * Семантика — та же, что у egress-политики (`isValidEgressRule` в ядре), но
 * реализация browser-safe: правило проверяется и в роутах ядра, и в UI.
 */
export function isValidHostRule(raw: string): boolean {
  if (typeof raw !== 'string') return false;
  const rule = raw.trim();
  if (!rule) return false;
  if (rule.includes('/')) return isCidrRule(rule);
  if (isIpLiteral(rule)) return true;
  return HOSTNAME_RULE_RE.test(rule);
}

/** Подсказка по допустимому виду правила — для сообщений об ошибке. */
export const HOST_RULE_FORMAT_HINT =
  'ожидается hostname (git.example.com), поддомены (*.corp.example), IP-литерал или CIDR (10.0.0.0/8)';
