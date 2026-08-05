import { resolve, isAbsolute, normalize } from 'node:path';

export function resolvePath(input: string | undefined, workingDir: string): string {
  if (input === undefined) return resolve(workingDir);
  const trimmed = input.trim();
  if (trimmed === '') return resolve(workingDir);
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
