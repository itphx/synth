import { ScriptError } from './types.js';

/**
 * ADR-126 §5: разбор аргументов скрипта (`!name [args]`).
 *
 * Разбор — **лексический**, без shell: ни подстановок переменных, ни glob, ни
 * командных подстановок. Аргументы уходят в процесс отдельными элементами
 * (argv-форма) или через `SYNTH_ARGS`/`SYNTH_ARG_<n>` (shell-форма) — в
 * строку запуска они не подставляются (ADR-126 §5 «Исполнение — единственный
 * путь»).
 *
 * Поддерживаются: пробелы/табы как разделители, двойные и одинарные
 * кавычки, экранирование `\"`/`\'` внутри соответствующих кавычек и `\\`.
 */

/**
 * Разобрать строку аргументов в список аргументов.
 *
 * @throws ScriptError `script_args_invalid` — незакрытая кавычка или висячий
 *   escape в конце строки.
 */
export function splitScriptArguments(input: string): string[] {
  const args: string[] = [];
  if (!input) return args;

  let current = '';
  let hasCurrent = false;
  let i = 0;

  while (i < input.length) {
    const ch = input[i]!;

    // Escape вне кавычек: следующий символ попадает в аргумент буквально.
    if (ch === '\\') {
      const next = input[i + 1];
      if (next === undefined) {
        throw new ScriptError('script_args_invalid', 'незакрытый escape в аргументах скрипта');
      }
      current += next;
      hasCurrent = true;
      i += 2;
      continue;
    }

    // Кавычки: содержимое до закрывающей кавычки — один аргумент.
    if (ch === '"' || ch === "'") {
      const quote = ch;
      i += 1;
      let closed = false;
      while (i < input.length) {
        const q = input[i]!;
        if (q === '\\') {
          const next = input[i + 1];
          if (next === undefined) break;
          // Внутри кавычек escape работает только для самой кавычки и для
          // обратного слэша; иначе обратный слэш — обычный символ.
          if (next === quote || next === '\\') {
            current += next;
            i += 2;
            continue;
          }
          current += q;
          i += 1;
          continue;
        }
        if (q === quote) {
          closed = true;
          i += 1;
          break;
        }
        current += q;
        i += 1;
      }
      if (!closed) {
        throw new ScriptError('script_args_invalid', `незакрытая кавычка ${quote} в аргументах скрипта`);
      }
      // Кавычки могут быть пустыми (`""`) — аргумент существует, но пуст.
      hasCurrent = true;
      continue;
    }

    // Разделитель аргументов.
    if (ch === ' ' || ch === '\t') {
      if (hasCurrent) {
        args.push(current);
        current = '';
        hasCurrent = false;
      }
      i += 1;
      continue;
    }

    current += ch;
    hasCurrent = true;
    i += 1;
  }

  if (hasCurrent) args.push(current);
  return args;
}
