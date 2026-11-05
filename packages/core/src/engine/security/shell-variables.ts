/**
 * Разбор присваиваний и `for`-циклов shell-команды для shell-guard.
 *
 * Цель — снять ложные `ask` на переменных, значение которых видно в той же
 * команде (`for r in a b; do git -C "$r" status; done`, `TLS=../../tls; cat
 * $TLS/client-ca.crt`). Значение, которое раскрыть нельзя (`while read`,
 * `for x in $(...)`, неизвестная переменная), остаётся `null` — guard по-прежнему
 * fail-closed.
 *
 * Модуль намеренно не знает про политику путей: он только собирает биндинги и
 * раскрывает токены, а проверку denied/approval выполняет shell-guard.
 */
import { splitShellSegments, tokenizeCommand } from './shell-lexer.js';

/** Значение переменной: список литеральных вариантов либо `null` (неизвестно). */
export type ShellBinding = string[] | null;

/** Максимум комбинаций при раскрытии (fail-closed при превышении). */
const MAX_EXPANSIONS = 256;

/** Есть ли в тексте динамика, которую нельзя раскрыть как литерал. */
function hasDynamic(text: string): boolean {
  return /[$`]|[*?[\]]/.test(text);
}

/** Ссылка на переменную в позиции `pos` (строка начинается с `$`/`${`). */
interface VariableRef {
  name: string;
  /** Модификатор `${VAR%pat}` / `${VAR#pat}` / `%%` / `##` (без модификатора — undefined). */
  op?: '%' | '%%' | '#' | '##';
  pattern?: string;
  /** Длина разобранного фрагмента (включая `$`/`${...}`). */
  length: number;
}

/** Разбирает ссылку на переменную в начале строки. */
function parseVariableRef(text: string): VariableRef | null {
  if (!text.startsWith('$')) return null;
  if (text.startsWith('${')) {
    const close = text.indexOf('}');
    if (close === -1) return null;
    const body = text.slice(2, close);
    const m = /^([A-Za-z_][A-Za-z0-9_]*)(%%|##|%|#)?(.*)$/.exec(body);
    if (!m) return null;
    const op = m[2] as VariableRef['op'];
    // Неподдерживаемый модификатор (`:-`, `:?`, `//`, `:offset` …) — fail-closed.
    if (!op && (m[3] ?? '') !== '') return null;
    return {
      name: m[1]!,
      ...(op ? { op, pattern: m[3] ?? '' } : {}),
      length: close + 1,
    };
  }
  const m = /^\$([A-Za-z_][A-Za-z0-9_]*)/.exec(text);
  if (!m) return null;
  return { name: m[1]!, length: m[0].length };
}

/** Удаление суффикса `%`/`%%` с поддержкой простого литерала и `*lit`/`lit*`. */
function removeSuffix(value: string, pattern: string, longest: boolean): string | null {
  if (pattern === '') return value;
  if (/[*?[\]]/.test(pattern.replace('*', ''))) return null; // сложный glob — fail-closed
  const star = pattern.indexOf('*');
  if (star === -1) {
    return value.endsWith(pattern) ? value.slice(0, value.length - pattern.length) : value;
  }
  if (pattern.indexOf('*', star + 1) !== -1) return null;
  const lit = pattern.slice(0, star) + pattern.slice(star + 1);
  if (lit === '') return longest ? '' : value;
  if (pattern.startsWith('*')) {
    // Суффикс, заканчивающийся на литерал.
    if (!value.endsWith(lit)) return value;
    const idx = longest ? value.indexOf(lit) : value.lastIndexOf(lit);
    return idx <= 0 ? '' : value.slice(0, idx);
  }
  // Суффикс, начинающийся с литерала.
  const idx = longest ? value.indexOf(lit) : value.lastIndexOf(lit);
  return idx === -1 ? value : value.slice(0, idx);
}

/** Удаление префикса `#`/`##` с поддержкой простого литерала и `*lit`/`lit*`. */
function removePrefix(value: string, pattern: string, longest: boolean): string | null {
  if (pattern === '') return value;
  if (/[*?[\]]/.test(pattern.replace('*', ''))) return null;
  const star = pattern.indexOf('*');
  if (star === -1) {
    return value.startsWith(pattern) ? value.slice(pattern.length) : value;
  }
  if (pattern.indexOf('*', star + 1) !== -1) return null;
  const lit = pattern.slice(0, star) + pattern.slice(star + 1);
  if (lit === '') return longest ? '' : value;
  if (pattern.endsWith('*')) {
    // Префикс, начинающийся с литерала.
    if (!value.startsWith(lit)) return value;
    return longest ? '' : value.slice(lit.length);
  }
  // Префикс, заканчивающийся литералом: `#*/` — до первого `/`.
  const idx = longest ? value.lastIndexOf(lit) : value.indexOf(lit);
  return idx === -1 ? value : value.slice(idx + lit.length);
}

/** Применяет модификатор `${VAR%pat}` и т.п. к значению. */
function applyTransform(value: string, ref: VariableRef): string | null {
  if (!ref.op) return value;
  const pattern = ref.pattern ?? '';
  if (ref.op === '%' || ref.op === '%%') return removeSuffix(value, pattern, ref.op === '%%');
  return removePrefix(value, pattern, ref.op === '##');
}

/** Раскрывает строку с переменными; `null` — раскрыть нельзя (fail-closed). */
function expandString(input: string, bindings: ReadonlyMap<string, ShellBinding>): string[] | null {
  const dollar = input.indexOf('$');
  if (dollar === -1) return [input];
  const prefix = input.slice(0, dollar);
  const ref = parseVariableRef(input.slice(dollar));
  if (!ref) return null;
  const values = bindings.get(ref.name);
  if (!values) return null;

  const transformed: string[] = [];
  for (const value of values) {
    const next = applyTransform(value, ref);
    if (next === null) return null;
    transformed.push(next);
  }

  const tails = expandString(input.slice(dollar + ref.length), bindings);
  if (tails === null) return null;
  const result: string[] = [];
  for (const value of transformed) {
    for (const tail of tails) {
      result.push(prefix + value + tail);
      if (result.length > MAX_EXPANSIONS) return null;
    }
  }
  return result;
}

/**
 * Раскрывает токен по известным биндингам. Возвращает варианты значений или
 * `null`, если токен содержит неизвестную динамику (переменная без значения,
 * backtick, `$(...)`, неподдерживаемый модификатор).
 */
export function expandToken(token: string, bindings: ReadonlyMap<string, ShellBinding>): string[] | null {
  if (token === '') return [''];
  if (token.includes('`') || token.includes('$(')) return null;
  if (!token.includes('$')) return /[*?[\]]/.test(token) ? null : [token];
  return expandString(token, bindings);
}

/** Записывает биндинг, объединяя варианты: повторное присваивание не сужает набор. */
function setBinding(bindings: Map<string, ShellBinding>, name: string, values: ShellBinding): void {
  const existing = bindings.get(name);
  if (existing === undefined) {
    bindings.set(name, values);
    return;
  }
  // Неизвестность хотя бы в одном месте — неизвестность целиком (fail-closed).
  if (existing === null || values === null) {
    bindings.set(name, null);
    return;
  }
  const merged = [...existing];
  for (const value of values) {
    if (!merged.includes(value)) merged.push(value);
  }
  bindings.set(name, merged.length > MAX_EXPANSIONS ? null : merged);
}

/** Имена после `read [-r] NAME …` — значения приходят из потока, неизвестны. */
function collectReadNames(tokens: string[], bindings: Map<string, ShellBinding>): void {
  const readAt = tokens[0] === 'read' ? 0 : tokens[1] === 'read' ? 1 : -1;
  if (readAt === -1) return;
  for (let i = readAt + 1; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token === '<') break;
    if (token.startsWith('-') && token.length > 1) continue;
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(token)) setBinding(bindings, token, null);
  }
}

/**
 * Собирает биндинги команды: `NAME=value`, `export NAME=value`, `for NAME in …`,
 * `read NAME …`. Значение `null` — «неизвестно» (guard остаётся fail-closed).
 */
export function collectBindings(command: string): Map<string, ShellBinding> {
  const bindings = new Map<string, ShellBinding>();

  for (const segment of splitShellSegments(command)) {
    const tokens = tokenizeCommand(segment);
    if (tokens.length === 0) continue;

    // for NAME in w1 w2 ...: только литеральные слова, иначе null.
    const forAt = tokens[0] === 'for' ? 0 : -1;
    if (forAt !== -1) {
      const name = tokens[forAt + 1];
      if (name && /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && tokens[forAt + 2] === 'in') {
        const words = tokens.slice(forAt + 3).filter((t) => t !== '' && t !== 'do');
        let values: string[] | null = [];
        for (const word of words) {
          // Хвостовая `;`/`;do` уже срезана splitShellSegments, но на всякий случай.
          const clean = word.replace(/;$/, '');
          if (clean === '' || clean === 'do') continue;
          if (hasDynamic(clean)) {
            values = null;
            break;
          }
          values.push(clean);
        }
        setBinding(bindings, name, values && values.length > 0 ? values : null);
        continue;
      }
    }

    collectReadNames(tokens, bindings);

    for (const token of tokens) {
      // `NAME+=value`: прибавляем к известным значениям. Неизвестное текущее
      // значение или нераскрываемое приращение — fail-closed `null`.
      const append = /^([A-Za-z_][A-Za-z0-9_]*)\+=(.*)$/.exec(token);
      if (append) {
        const name = append[1]!;
        const raw = append[2]!;
        const existing = bindings.get(name);
        if (existing === undefined || existing === null) {
          setBinding(bindings, name, null);
          continue;
        }
        if (raw === '') continue;
        let suffixes: string[] | null;
        if (!hasDynamic(raw)) {
          suffixes = [raw];
        } else {
          suffixes = expandToken(raw, bindings);
        }
        if (suffixes === null || suffixes.length === 0) {
          setBinding(bindings, name, null);
          continue;
        }
        const combined: string[] = [];
        for (const value of existing) {
          for (const suffix of suffixes) combined.push(value + suffix);
        }
        setBinding(bindings, name, combined.length > MAX_EXPANSIONS ? null : combined);
        continue;
      }
      const assign = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(token);
      if (!assign) continue;
      const name = assign[1]!;
      const raw = assign[2]!;
      if (raw === '') {
        setBinding(bindings, name, ['']);
        continue;
      }
      if (!hasDynamic(raw)) {
        setBinding(bindings, name, [raw]);
        continue;
      }
      const expanded = expandToken(raw, bindings);
      setBinding(bindings, name, expanded && expanded.length > 0 ? expanded : null);
    }
  }

  return bindings;
}
