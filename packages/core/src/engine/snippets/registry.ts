import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { scanSnippetSource } from './discovery.js';
import type {
  Snippet,
  SnippetDiagnostic,
  SnippetScanResult,
  SnippetSource,
} from './types.js';

/**
 * ADR-141 §4: реестр сниппетов — слияние трёх уровней с приоритетом
 * `user > project > instance`, каноническое имя важнее алиаса, кэш с ленивой
 * инвалидацией по mtime/size (как `CommandRegistry`, ADR-046 §8.3).
 */

/**
 * Индекс раскрытия: канонические имена и алиасы → сниппет.
 *
 * В индекс попадают только **доверенные** сниппеты: недоверенный проектный
 * сниппет виден в списке (`trusted: false`), но не перекрывает доверенные
 * сниппеты и не раскрывается.
 */
export interface SnippetIndex {
  /** Все видимые сниппеты (включая недоверенные — они видны в списке). */
  snippets: Snippet[];
  /** Каноническое имя → сниппет (только доверенные). */
  byName: Map<string, Snippet>;
  /** Алиас → сниппет (только доверенные; канон важнее алиаса). */
  byAlias: Map<string, Snippet>;
  /**
   * Недоверенные сниппеты (недоверенный проект) — по именам и алиасам.
   * В разрешении (`byName`/`byAlias`) их нет, но по ним можно объяснить
   * пользователю, почему `#token` не раскрылся.
   */
  untrustedByName: Map<string, Snippet>;
  untrustedByAlias: Map<string, Snippet>;
  /** Диагностика (shadowed/untrusted/read-error/invalid-frontmatter). */
  diagnostics: SnippetDiagnostic[];
}

/**
 * Слияние результатов сканирования: first-wins по каноническому имени.
 *
 * Порядок `entries` — приоритет уровней (`user > project > instance`).
 * Проигравший не исчезает молча: о нём пишется диагностика `shadowed`.
 * Алиасы регистрируются **после** канонических имён, поэтому алиас никогда
 * не перекрывает каноническое имя (тот же приоритет, что «канон важнее алиаса»).
 */
export function mergeSnippetScans(
  entries: ReadonlyArray<{ source: SnippetSource; result: SnippetScanResult }>,
): SnippetIndex {
  const snippets: Snippet[] = [];
  const diagnostics: SnippetDiagnostic[] = [];
  const byName = new Map<string, Snippet>();
  const byAlias = new Map<string, Snippet>();
  const untrustedByName = new Map<string, Snippet>();
  const untrustedByAlias = new Map<string, Snippet>();

  for (const { source, result } of entries) {
    diagnostics.push(...result.diagnostics);
    for (const snippet of result.snippets) {
      if (!snippet.trusted) {
        // Недоверенный проектный сниппет виден, но не участвует в разрешении.
        snippets.push(snippet);
        if (!untrustedByName.has(snippet.name)) untrustedByName.set(snippet.name, snippet);
        for (const alias of snippet.aliases) {
          if (!untrustedByAlias.has(alias)) untrustedByAlias.set(alias, snippet);
        }
        diagnostics.push({
          level: 'warning',
          code: 'untrusted',
          snippet: snippet.name,
          path: snippet.file,
          message: `каталог "${source.dir}" недоверенный: сниппет "${snippet.name}" виден, но не раскрывается`,
        });
        continue;
      }
      const existing = byName.get(snippet.name);
      if (existing) {
        diagnostics.push({
          level: 'warning',
          code: 'shadowed',
          snippet: snippet.name,
          path: snippet.file,
          message:
            `сниппет "${snippet.name}" перекрыт источником ${existing.scope} (${existing.file})`,
        });
        continue;
      }
      byName.set(snippet.name, snippet);
      snippets.push(snippet);
    }
  }

  // Алиасы — вторым проходом: канонические имена уже заняты, alias их не отменяет.
  for (const snippet of snippets) {
    if (!snippet.trusted) continue;
    for (const alias of snippet.aliases) {
      if (alias === snippet.name) continue;
      if (byName.has(alias)) {
        diagnostics.push({
          level: 'warning',
          code: 'shadowed',
          snippet: alias,
          path: snippet.file,
          message: `алиас "${alias}" сниппета "${snippet.name}" перекрыт каноническим именем`,
        });
        continue;
      }
      const existing = byAlias.get(alias);
      if (existing) {
        diagnostics.push({
          level: 'warning',
          code: 'shadowed',
          snippet: alias,
          path: snippet.file,
          message: `алиас "${alias}" перекрыт сниппетом "${existing.name}" (${existing.file})`,
        });
        continue;
      }
      byAlias.set(alias, snippet);
    }
  }

  return { snippets, byName, byAlias, untrustedByName, untrustedByAlias, diagnostics };
}

/**
 * Разрешение токена `#name`: каноническое имя важнее алиаса.
 */
export function resolveSnippet(index: SnippetIndex, token: string): Snippet | undefined {
  return index.byName.get(token) ?? index.byAlias.get(token);
}

/**
 * Недоверенный сниппет по имени/алиасу — для объяснения «почему не раскрылось».
 */
export function resolveUntrustedSnippet(index: SnippetIndex, token: string): Snippet | undefined {
  return index.untrustedByName.get(token) ?? index.untrustedByAlias.get(token);
}

interface CacheEntry {
  signature: string;
  trusted: boolean;
  result: SnippetScanResult;
}

/** Подпись каталога: `file:mtime:size` по каждому `*.md` (отсортировано). */
async function snapshotDir(dir: string): Promise<string> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return '';
  }
  const parts: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.md')) continue;
    try {
      const info = await stat(join(dir, entry.name));
      parts.push(`${entry.name}:${Math.floor(info.mtimeMs)}:${info.size}`);
    } catch {
      // пропускаем
    }
  }
  parts.sort();
  return parts.join('|');
}

/**
 * Реестр сниппетов: discovery + слияние + кэш с ленивой инвалидацией
 * по mtime/size. Кэш ключуется каталогом источника (в каталог входит и
 * `userId`, и workspace проекта), доверие источника — часть записи кэша.
 */
export class SnippetRegistry {
  private readonly _cache = new Map<string, CacheEntry>();
  private readonly _sources: (
    opts?: { userId?: string; projectWorkspace?: string },
  ) => SnippetSource[] | Promise<SnippetSource[]>;

  constructor(opts: {
    sources: (
      opts?: { userId?: string; projectWorkspace?: string },
    ) => SnippetSource[] | Promise<SnippetSource[]>;
  }) {
    this._sources = opts.sources;
  }

  /** Индекс раскрытия для пользователя/проекта. */
  async index(opts?: {
    userId?: string;
    projectWorkspace?: string;
  }): Promise<SnippetIndex> {
    const sources = await this._sources(opts);
    const entries: Array<{ source: SnippetSource; result: SnippetScanResult }> = [];
    for (const source of sources) {
      entries.push({ source, result: await this._loadSource(source) });
    }
    return mergeSnippetScans(entries);
  }

  /** Принудительный сброс кэша (после записи сниппета). */
  reload(): void {
    this._cache.clear();
  }

  private async _loadSource(source: SnippetSource): Promise<SnippetScanResult> {
    const signature = await snapshotDir(source.dir);
    const cached = this._cache.get(source.dir);
    if (cached && cached.signature === signature && cached.trusted === source.trusted) {
      return cached.result;
    }
    const result = await scanSnippetSource(source);
    this._cache.set(source.dir, { signature, trusted: source.trusted, result });
    return result;
  }
}
