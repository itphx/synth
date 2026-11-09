/**
 * Исключения по умолчанию для поиска (содержимое и перечисление файлов).
 *
 * Зачем: инцидент 2026-11-08 — поиск из корня workspace нашёл совпадение в
 * минифицированном source map (`node_modules/…/dist/assets/*.js.map`, строка
 * в 236 487 символов) и унёс в контекст модели 243 КБ. Кап строки (P0,
 * `line-limits.ts`) ограничила одну строку, но не убрала источник мусора:
 * зависимости и артефакты сборки не относятся к исходникам проекта.
 *
 * Правила (по аналогии с `ignoredDirectories` в opencode, но шире — плюс
 * артефакты сборки и lock-файлы):
 * - каталоги мусора — по имени сегмента пути на любой глубине;
 * - файлы мусора — по имени файла (`.map`, `.min.js`, lock-файлы).
 *
 * Явный путь важнее исключения: если пользователь/агент сам указал путь
 * внутрь исключаемой области (`path: "node_modules/pkg"`), поиск идёт по этому
 * каталогу целиком — исключения внутри него не применяются
 * (см. `searchRootInsideExcludedDir`).
 */

import { relative } from 'node:path';

/**
 * Каталоги, исключаемые из поиска по умолчанию: зависимости и артефакты
 * сборки. Совпадают по имени сегмента пути на любой глубине.
 */
export const EXCLUDED_SEARCH_DIRECTORIES: readonly string[] = [
  'node_modules',
  'dist',
  'build',
  'out',
  'coverage',
  '.venv',
  'venv',
  '__pycache__',
  '.next',
  '.turbo',
  '.cache',
];

/**
 * Файлы, исключаемые из поиска по умолчанию: сгенерированные (source map,
 * минифицированные бандлы) и lock-файлы менеджеров пакетов.
 */
export const EXCLUDED_SEARCH_FILE_PATTERNS: readonly string[] = [
  '*.map',
  '*.min.js',
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  '*.lock',
];

/**
 * Категория исключения: имя каталога либо шаблон имени файла.
 *
 * Категория попадает в маркер исключений — по ней агент понимает, ГДЕ искать
 * дальше (например «node_modules» или «*.map»).
 */
export interface SearchExclusionCategory {
  /** Что именно исключено: каталог или файл. */
  kind: 'directory' | 'file';
  /** Человекочитаемое имя категории. */
  label: string;
}

/**
 * Сегменты пути без служебных (`.`, `..`) и пустых.
 *
 * Разделители — оба вида (`/` и `\`): пути приходят и из POSIX, и из Windows.
 */
function pathSegments(path: string): string[] {
  return path
    .split(/[\\/]+/)
    .filter((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

/**
 * Совпадение имени файла с шаблоном (поддерживается только `*`).
 *
 * Шаблон без `*` — точное совпадение; `*` — любая последовательность
 * символов без разделителя пути (имя файла не содержит `/`).
 */
function matchesFilePattern(name: string, pattern: string): boolean {
  if (!pattern.includes('*')) return name === pattern;
  const escaped = pattern
    .split('*')
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('[^/]*');
  return new RegExp(`^${escaped}$`).test(name);
}

/**
 * Категория исключения для пути **относительно корня поиска**.
 *
 * @param relPath путь относительно каталога поиска (`/` или `\` — разделитель).
 * @returns категория исключения либо `null`, если путь не исключён.
 */
export function matchSearchExclusion(relPath: string): SearchExclusionCategory | null {
  const segments = pathSegments(relPath);
  if (segments.length === 0) return null;

  // Каталоги: все сегменты, кроме последнего (последний — имя файла).
  for (const segment of segments.slice(0, -1)) {
    if (EXCLUDED_SEARCH_DIRECTORIES.includes(segment)) {
      return { kind: 'directory', label: segment };
    }
  }

  // Файлы: последний сегмент (имя файла) — по шаблону.
  const fileName = segments[segments.length - 1]!;
  for (const pattern of EXCLUDED_SEARCH_FILE_PATTERNS) {
    if (matchesFilePattern(fileName, pattern)) {
      return { kind: 'file', label: pattern };
    }
  }

  return null;
}

/**
 * Корневой каталог поиска лежит внутри исключаемой области — правила
 * исключений внутри него не применяются (явный opt-in пользователя).
 *
 * Проверка идёт по пути корня **относительно рабочего каталога** сессии.
 * Такой путь содержит только часть после общей с рабочим каталогом основы,
 * поэтому имя каталога в абсолютном пути (например `/home/user/build/project`,
 * где `build` — общий предок рабочего каталога) не выдаёт ложного opt-in:
 * важно, ведь сам корень может называться как исключаемый каталог.
 *
 * Если корень указан **вне** рабочего каталога, его собственные исключаемые
 * сегменты (например `/opt/build/pkg`) opt-in дают — это и есть «явный путь
 * важнее исключения».
 *
 * @param searchRoot каталог поиска (абсолютный).
 * @param workingDir рабочий каталог сессии (абсолютный).
 */
export function searchRootInsideExcludedDir(searchRoot: string, workingDir: string): boolean {
  const rel = relative(workingDir, searchRoot);
  if (rel === '') return false;
  return pathSegments(rel).some((segment) => EXCLUDED_SEARCH_DIRECTORIES.includes(segment));
}
