import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

interface PackageManifest {
  version: string;
}

/** Корень пакета (`packages/synth`) — от файла теста на один уровень вверх. */
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const manifest = JSON.parse(
  readFileSync(join(packageRoot, 'package.json'), 'utf8'),
) as PackageManifest;

/**
 * Smoke-тест тонкой CLI-обёртки `@itphx/synth` (ADR-038).
 *
 * Запускаем CLI из исходников (`src/cli.ts` через `tsx`), поэтому сборка
 * `dist/` не требуется — тест обязан проходить на чистом дереве.
 * Требуются только собранные `dist/` воркспейс-зависимостей
 * (`@itphx/synth-shared`, `@itphx/synth-core`): CLI импортирует их через
 * `exports`-карту пакетов, которая указывает на `dist/`.
 */
describe('@itphx/synth — CLI', () => {
  it('печатает версию пакета и завершается с кодом 0', () => {
    // `execFileSync` бросает исключение при ненулевом коде выхода —
    // этим подтверждается exit 0.
    const stdout = execFileSync(
      process.execPath,
      ['--import', 'tsx', 'src/cli.ts', '--version'],
      { cwd: packageRoot, timeout: 15_000, encoding: 'utf8' },
    );

    expect(stdout).toContain(manifest.version);
    expect(stdout.trim()).toBe(manifest.version);
  });
});
