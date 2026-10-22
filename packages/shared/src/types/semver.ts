/**
 * ADR-023 / PROP-090 §10: минимальный semver-рандж-матчер без внешних
 * зависимостей (инвариант 12 — новые npm-пакеты только с разрешения).
 *
 * Модуль browser-safe (только строки и числа). Канонический источник истины
 * для диапазонов версий host'а и контрактов расширений: и `host`, и
 * `contracts` манифеста `synth.pack` используют один и тот же синтаксис
 * (как `engines` в package.json).
 *
 * Поддерживаемая грамматика (ровно та, что объявляет
 * {@link SEMVER_RANGE_REGEX} — тот же набор, что принимает `packHostSchema`):
 * - оператор: `^`, `~`, `>=`, `<=`, `>`, `<`, `=` — либо отсутствует;
 * - версия: 1–3 компонента (`major`, `major.minor`, `major.minor.patch`),
 *   компонент может быть `x`/`X`/`*` (wildcard); версия целиком — `*`/`x`
 *   (любая версия);
 * - необязательные пре-релиз/сборка (`-alpha`, `+build`) — **не участвуют** в
 *   сравнении (сравниваются только major/minor/patch).
 *
 * Конъюнкция: пробел — «все условия должны выполняться» (`>=1.0.0 <2.0.0`).
 * Дизъюнкция (`||`) **не поддерживается** — её нет и в `PACK_HOST_RANGE_REGEX`,
 * поэтому такой диапазон невалиден (fail-closed).
 */

/** Разобранная версия (сравниваются только major/minor/patch). */
export interface SemverParts {
  major: number;
  minor: number;
  patch: number;
}

/**
 * Грамматика semver-диапазона. Единый источник истины для проверки формы
 * диапазона (`host` манифеста расширения, значения `contracts`).
 */
export const SEMVER_RANGE_REGEX =
  /^(?:(?:\^|~|>=|<=|>|<|=)?(?:\d+(?:\.(?:\d+|[xX*])){0,2}|[xX*]))(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/** Полный semver (`major.minor.patch` + необязательные пре-релиз/сборка). */
const SEMVER_VERSION_REGEX =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/** Компонент диапазона: число либо wildcard (`x`/`X`/`*`). */
type RangeComponent = number | 'x';

interface RangeVersion {
  major: number;
  minor?: RangeComponent;
  patch?: RangeComponent;
}

/**
 * Проверяет, что значение — корректный semver-диапазон (набор условий,
 * разделённых пробелом). Каждая часть должна соответствовать
 * {@link SEMVER_RANGE_REGEX}.
 */
export function isSemverRange(value: string): boolean {
  const parts = value.trim().split(/\s+/).filter(Boolean);
  return parts.length > 0 && parts.every((part) => SEMVER_RANGE_REGEX.test(part));
}

/** Разбирает полную semver-версию; `null` — не semver. */
export function parseSemver(version: string): SemverParts | null {
  const match = SEMVER_VERSION_REGEX.exec(version.trim());
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

function parseRangeVersion(raw: string): RangeVersion | null {
  const match = SEMVER_RANGE_REGEX.exec(raw.trim());
  if (!match) return null;
  // Отрезаем оператор и пре-релиз/сборку — остаются только компоненты.
  const body = raw.trim().replace(/^(?:\^|~|>=|<=|>|<|=)/, '').split(/[-+]/, 1)[0] ?? '';
  const parts = body.split('.');
  const major = Number(parts[0]);
  if (!Number.isFinite(major)) return null;
  const toComponent = (part: string | undefined): RangeComponent | undefined => {
    if (part === undefined) return undefined;
    if (part === 'x' || part === 'X' || part === '*') return 'x';
    const value = Number(part);
    return Number.isFinite(value) ? value : 'x';
  };
  return {
    major,
    ...(parts.length > 1 ? { minor: toComponent(parts[1]) } : {}),
    ...(parts.length > 2 ? { patch: toComponent(parts[2]) } : {}),
  };
}

/** Границы одного условия диапазона. */
interface Bounds {
  lower?: SemverParts;
  lowerInclusive?: boolean;
  upper?: SemverParts;
  upperInclusive?: boolean;
}

function compare(a: SemverParts, b: SemverParts): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  return a.patch - b.patch;
}

/** Заполняет отсутствующие компоненты нулями (для нижней границы). */
function fill(parts: RangeVersion): SemverParts {
  return {
    major: parts.major,
    minor: typeof parts.minor === 'number' ? parts.minor : 0,
    patch: typeof parts.patch === 'number' ? parts.patch : 0,
  };
}

/**
 * Верхняя граница для wildcard-условий: `1.x` → `<2.0.0`, `1.2.x` → `<1.3.0`.
 */
function wildcardUpper(parts: RangeVersion): SemverParts {
  if (typeof parts.minor !== 'number') return { major: parts.major + 1, minor: 0, patch: 0 };
  if (typeof parts.patch !== 'number') return { major: parts.major, minor: parts.minor + 1, patch: 0 };
  // patch задан — wildcard только в patch не трактуется (верхняя граница = сама версия).
  return fill(parts);
}

function boundsFor(raw: string): Bounds | null {
  const trimmed = raw.trim();
  const opMatch = /^(\^|~|>=|<=|>|<|=)/.exec(trimmed);
  const op = opMatch?.[1] ?? '=';
  // Wildcard-only (`*`/`x`): диапазон не ограничивает версию (любой оператор).
  const body = trimmed.replace(/^(?:\^|~|>=|<=|>|<|=)/, '').split(/[-+]/, 1)[0] ?? '';
  if (body === '*' || body === 'x' || body === 'X') return {};
  const version = parseRangeVersion(trimmed);
  if (!version) return null;

  const lower = fill(version);
  const hasWildcardMinor = version.minor === 'x' || version.minor === undefined;
  const hasWildcardPatch = version.patch === 'x' || version.patch === undefined;

  switch (op) {
    case '^': {
      // Caret: мажор фиксирован, минор/патч — только если мажор 0.
      if (version.major > 0) {
        return { lower, lowerInclusive: true, upper: { major: version.major + 1, minor: 0, patch: 0 }, upperInclusive: false };
      }
      if (typeof version.minor === 'number' && version.minor > 0) {
        return { lower, lowerInclusive: true, upper: { major: 0, minor: version.minor + 1, patch: 0 }, upperInclusive: false };
      }
      if (typeof version.minor === 'number' && typeof version.patch === 'number') {
        return { lower, lowerInclusive: true, upper: { major: 0, minor: 0, patch: version.patch + 1 }, upperInclusive: false };
      }
      // `^0` / `^0.x` — весь нулевой мажор.
      return { lower, lowerInclusive: true, upper: { major: 1, minor: 0, patch: 0 }, upperInclusive: false };
    }
    case '~': {
      if (typeof version.minor === 'number') {
        return { lower, lowerInclusive: true, upper: { major: version.major, minor: version.minor + 1, patch: 0 }, upperInclusive: false };
      }
      return { lower, lowerInclusive: true, upper: { major: version.major + 1, minor: 0, patch: 0 }, upperInclusive: false };
    }
    case '>=': {
      if (hasWildcardMinor) return { lower: { major: version.major, minor: 0, patch: 0 }, lowerInclusive: true };
      return { lower, lowerInclusive: true };
    }
    case '>': {
      if (hasWildcardMinor) {
        return { lower: { major: version.major + 1, minor: 0, patch: 0 }, lowerInclusive: true };
      }
      if (hasWildcardPatch) {
        return { lower: { major: version.major, minor: (version.minor as number) + 1, patch: 0 }, lowerInclusive: true };
      }
      return { lower, lowerInclusive: false };
    }
    case '<=': {
      if (hasWildcardMinor) {
        return { upper: { major: version.major + 1, minor: 0, patch: 0 }, upperInclusive: false };
      }
      if (hasWildcardPatch) {
        return { upper: { major: version.major, minor: (version.minor as number) + 1, patch: 0 }, upperInclusive: false };
      }
      return { upper: lower, upperInclusive: true };
    }
    case '<': {
      if (hasWildcardMinor) {
        return { upper: { major: version.major, minor: 0, patch: 0 }, upperInclusive: false };
      }
      if (hasWildcardPatch) {
        return { upper: { major: version.major, minor: (version.minor as number), patch: 0 }, upperInclusive: false };
      }
      return { upper: lower, upperInclusive: false };
    }
    case '=':
    default: {
      // Точное совпадение; wildcard-компоненты не ограничивают.
      if (hasWildcardMinor) {
        return { lower: { major: version.major, minor: 0, patch: 0 }, lowerInclusive: true, upper: wildcardUpper(version), upperInclusive: false };
      }
      if (hasWildcardPatch) {
        return { lower: { major: version.major, minor: version.minor as number, patch: 0 }, lowerInclusive: true, upper: wildcardUpper(version), upperInclusive: false };
      }
      return { lower, lowerInclusive: true, upper: lower, upperInclusive: true };
    }
  }
}

function withinBounds(version: SemverParts, bounds: Bounds): boolean {
  if (bounds.lower) {
    const cmp = compare(version, bounds.lower);
    if (cmp < 0) return false;
    if (cmp === 0 && !bounds.lowerInclusive) return false;
  }
  if (bounds.upper) {
    const cmp = compare(version, bounds.upper);
    if (cmp > 0) return false;
    if (cmp === 0 && !bounds.upperInclusive) return false;
  }
  return true;
}

/**
 * Проверяет, что версия удовлетворяет semver-диапазону.
 *
 * Все условия диапазона (пробел — конъюнкция) должны выполняться. Невалидный
 * диапазон или не-semver версия → `false` (fail-closed).
 */
export function satisfiesSemverRange(version: string, range: string): boolean {
  const parsed = parseSemver(version);
  if (!parsed) return false;
  const conditions = range.trim().split(/\s+/).filter(Boolean);
  if (conditions.length === 0) return false;
  for (const condition of conditions) {
    const bounds = boundsFor(condition);
    if (!bounds) return false;
    if (!withinBounds(parsed, bounds)) return false;
  }
  return true;
}
