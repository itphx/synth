/**
 * Лёгкий лексер shell-команд (без исполнения и без tree-sitter).
 *
 * Вынесен из `shell-guard.ts`, чтобы им могли пользоваться и сам guard, и
 * разбор присваиваний/циклов (`shell-variables.ts`) без циклических импортов.
 * Публичный API (`tokenizeCommand`/`splitShellSegments`) реэкспортируется из
 * `shell-guard.ts` — обратная совместимость для тестов и потребителей.
 */

/**
 * Лёгкий shlex-токенизатор (POSIX-подобный).
 * - одинарные кавычки `'...'` — всё литерально;
 * - двойные кавычки `"..."` — кавычки снимаются, `\` экранирует следующий символ;
 * - `\` вне кавычек экранирует следующий символ;
 * - незакрытые кавычки дочитываются до конца строки (не бросаем ошибку).
 * Кавычки из токенов удаляются (как shlex.split).
 */
export function tokenizeCommand(command: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let inSingle = false;
  let inDouble = false;
  let escaped = false;

  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (ch === '\\' && !inSingle) {
      escaped = true;
      continue;
    }
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      continue;
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      continue;
    }
    if ((ch === ' ' || ch === '\t' || ch === '\n') && !inSingle && !inDouble) {
      if (current !== '') {
        tokens.push(current);
        current = '';
      }
      continue;
    }
    current += ch;
  }
  if (escaped) current += '\\';
  if (current !== '') tokens.push(current);
  return tokens;
}

/**
 * Односимвольные разделители команд POSIX-шелла. Двухсимвольные `&&`/`||`
 * обрабатываются отдельно (до односимвольных), чтобы не разбить на `&`/`|`.
 */
const SHELL_SEPARATORS = new Set([';', '&', '|', '\n']);

/**
 * Разбивает команду на сегменты по разделителям: `;`, `&&`, `||`, `&`, `|`
 * и переводу строки. Разделители ВНУТРИ кавычек (`'...'`, `"..."`) и внутри
 * подстановок `$(...)` НЕ разбивают команду — shell не выполняет их как
 * операторы. Каждый сегмент возвращается без ведущих/хвостовых пробелов.
 */
export function splitShellSegments(command: string): string[] {
  const segments: string[] = [];
  let current = '';
  let inSingle = false;
  let inDouble = false;
  let escaped = false;
  let substitutionDepth = 0;

  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (ch === '\\' && !inSingle) {
      current += ch;
      escaped = true;
      continue;
    }
    if (ch === "'" && !inDouble && substitutionDepth === 0) {
      inSingle = !inSingle;
      current += ch;
      continue;
    }
    if (ch === '"' && !inSingle && substitutionDepth === 0) {
      inDouble = !inDouble;
      current += ch;
      continue;
    }
    if (!inSingle && !inDouble) {
      // Подстановка $(...) — содержимое не анализируем (динамика), но и не
      // разбиваем по разделителям внутри.
      if (ch === '$' && command[i + 1] === '(') {
        substitutionDepth++;
        current += '$(';
        i++;
        continue;
      }
      if (ch === ')' && substitutionDepth > 0) {
        substitutionDepth--;
        current += ch;
        continue;
      }
    }
    if (substitutionDepth === 0 && !inSingle && !inDouble) {
      if ((ch === '&' && command[i + 1] === '&') || (ch === '|' && command[i + 1] === '|')) {
        if (current.trim() !== '') segments.push(current.trim());
        current = '';
        i++;
        continue;
      }
      if (SHELL_SEPARATORS.has(ch)) {
        // `&` внутри оператора перенаправления (`>&`, `<&`, `&>`, `&>>`) —
        // не разделитель команд: цель должна попасть в тот же сегмент.
        if (ch === '&' || ch === '|') {
          const prev = command[i - 1];
          const next = command[i + 1];
          if ((ch === '&' && (prev === '>' || prev === '<' || next === '>'))
            || (ch === '|' && prev === '>')) {
            current += ch;
            continue;
          }
        }
        if (current.trim() !== '') segments.push(current.trim());
        current = '';
        continue;
      }
    }
    current += ch;
  }
  if (current.trim() !== '') segments.push(current.trim());
  return segments;
}
