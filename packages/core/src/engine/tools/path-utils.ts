import { resolve, isAbsolute, normalize } from 'node:path';
import { homedir } from 'node:os';

const HOME = homedir();

export function resolvePath(input: string | undefined, workingDir: string): string {
  if (input === undefined) return resolve(workingDir);
  const trimmed = input.trim();
  if (trimmed === '') return resolve(workingDir);

  let base = '';
  let rest = trimmed;
  const homeMatch = /^~(?:\/|$)/.exec(trimmed);
  if (homeMatch) {
    base = HOME;
    rest = trimmed.slice(1);
    if (rest.startsWith('/')) rest = rest.slice(1);
  } else {
    const dollar = /^(\$(?:HOME|PWD)|\$\{(?:HOME|PWD)\})(?:\/|$)/.exec(trimmed);
    if (dollar) {
      const varName = dollar[1]!.includes('PWD') ? 'PWD' : 'HOME';
      base = varName === 'HOME' ? HOME : workingDir;
      rest = trimmed.slice(dollar[1]!.length);
      if (rest.startsWith('/')) rest = rest.slice(1);
    }
  }
  if (base !== '') {
    return rest === '' ? normalize(base) : resolve(base, rest);
  }
  if (isAbsolute(trimmed)) return normalize(trimmed);
  return resolve(workingDir, trimmed);
}

export function validateInputPath(input: string, paramName: string): void {
  if (input.trim() === '') {
    throw new Error(`Параметр "${paramName}" не может быть пустым`);
  }
  if (input.includes('\0')) {
    throw new Error(`Параметр "${paramName}" содержит недопустимые символы`);
  }
}
