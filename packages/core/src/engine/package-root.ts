import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Резолвинг корня пакета `@itphx/synth-core` по `package.json` — поиск вверх от
 * `startDir`.
 *
 * Работает одинаково при src-запуске (tsx), dist-запуске и в установленном пакете
 * `node_modules/@itphx/synth-core` (включая Docker-образ, где копируется только
 * `dist/`). Не нашли `package.json` до корня ФС — возвращаем `startDir`
 * (вызывающий сам решает, что делать: обычно `join(root, …)` + проверка
 * существования).
 *
 * Вынесено из `engine/context/config.ts`, чтобы ассеты пакета
 * (`prompts/`, `definitions/`) резолвились одним способом (ADR-038/ADR-126 §15).
 */
export function findPackageRoot(startDir: string): string {
  let dir = startDir;
  for (;;) {
    if (existsSync(join(dir, 'package.json'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return startDir;
}
