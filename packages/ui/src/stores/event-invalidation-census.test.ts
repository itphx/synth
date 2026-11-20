/**
 * Перепись UI-обработки событий: «мутация видна клиенту ⇒ есть событие **и**
 * обработчик» (инвариант 27 корневого `AGENTS.md`, вторая половина).
 *
 * ## Зачем
 *
 * Серверная часть инварианта (write-путь публикует событие) проверяется
 * переписью `packages/core/src/events/publish-census.test.ts`. Но событие,
 * которое клиент не разбирает, бесполезно: лента/панель «залипает» до
 * перезагрузки страницы. За сессию так потеряли пять реестров (агенты, MCP,
 * скиллы, пайплайны, модели) — у каждого дыра была ровно в одной из половин.
 *
 * ## Что проверяем (статически, по исходникам)
 *
 * 1. **Ветка диспетчера.** В `stores/transportStore.ts` есть ветка на каждый
 *    объявленный тип события и она вызывает **свой** метод стора
 *    (`agents.updated` → `agentsStore.applyEvent`). Проверяется вызов в теле
 *    ветки, а не наличие строки в файле.
 * 2. **Инстансные события — до `if (!sid) return`.** У них нет сессии в кадре:
 *    ветка ниже раннего `return` не выполнится никогда, и реестр останется
 *    устаревшим при живом коде «наличие ветки есть».
 * 3. **Метод стора существует и инвалидирует.** В сторе есть сам метод и
 *    объявленный якорь инвалидации (`revision: s.revision + 1`,
 *    `catalogLoaded: false`, `next.delete(projectId)`): вызов несуществующего
 *    или ничего не сбрасывающего метода — та же дыра, только тише.
 * 4. **Guard-кэши.** Стор с guard-кэшем обязан иметь путь инвалидации по
 *    событию (или объяснимый TTL). Перечень собирается из исходников: новый
 *    кэш (`*Loaded`/`loadedProjects`/`*LoadedAt`) без записи в перечень роняет
 *    тест — иначе ленивая загрузка «один раз» навсегда остаётся снимком.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Корень пакета ui: тест лежит в `src/stores`. */
const UI_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const STORES_DIR = join(UI_ROOT, 'src/stores');

/**
 * Исходник стора без комментариев (строки сохраняются — номера не съезжают).
 *
 * Иначе закомментированная ветка/вызов проходили бы проверку: маркер
 * находится в тексте комментария, а не в коде — ровно та тихая дыра, ради
 * которой тест написан.
 */
function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (chunk) => chunk.replace(/[^\n]/g, ''))
    .replace(/^[ \t]*\/\/.*$/gm, '');
}

const readStore = (file: string): string =>
  stripComments(readFileSync(join(STORES_DIR, file), 'utf8'));

/** Ранний выход диспетчера: события без `session_id` отбрасываются ниже него. */
const SESSION_GUARD = 'if (!sid) return';

// ---------------------------------------------------------------------------
// Перепись обработчиков событий
// ---------------------------------------------------------------------------

interface EventHandler {
  /** Тип события шины. */
  readonly type: string;
  /** Стор-получатель (файл без `.ts`). */
  readonly store: string;
  /** Метод стора, который обязан появиться в ветке. */
  readonly call: string;
  /** Канал события: инстансный (нет `sid`) или сессионный/проектный. */
  readonly channel: 'instance' | 'session';
  /** Якорь инвалидации в сторе: чем именно метод сбрасывает состояние. */
  readonly evidence: string;
}

/**
 * Перепись «тип события → стор → метод инвалидации». Источник истины по
 * серверной стороне — `packages/core/src/events/publish-census.test.ts`.
 */
const EVENT_HANDLERS: readonly EventHandler[] = [
  {
    type: 'agents.updated',
    store: 'agentsStore',
    call: 'useAgentsStore.getState().applyEvent()',
    channel: 'instance',
    evidence: 'revision: s.revision + 1',
  },
  {
    type: 'mcp.updated',
    store: 'mcpStore',
    call: 'useMcpStore.getState().applyEvent(',
    channel: 'instance',
    evidence: 'void get().fetchRegistry()',
  },
  {
    type: 'skills.updated',
    store: 'skillsStore',
    call: 'useSkillsStore.getState().applyEvent(',
    channel: 'instance',
    evidence: 'void get().fetchSkills()',
  },
  {
    type: 'models.updated',
    store: 'providersStore',
    call: 'useProvidersStore.getState().applyEvent()',
    channel: 'instance',
    evidence: 'catalogLoaded: false',
  },
  {
    type: 'execution.updated',
    store: 'executionProfilesStore',
    call: 'useExecutionProfilesStore.getState().applyEvent()',
    channel: 'instance',
    evidence: 'revision: s.revision + 1',
  },
  {
    type: 'memory.updated',
    store: 'memoryStore',
    call: 'useMemoryStore.getState().applyEvent()',
    channel: 'instance',
    evidence: 'revision: s.revision + 1',
  },
  {
    type: 'users.updated',
    store: 'usersStore',
    call: 'useUsersStore.getState().applyEvent()',
    channel: 'instance',
    evidence: 'revision: s.revision + 1',
  },
  {
    type: 'webhooks.updated',
    store: 'webhooksStore',
    call: 'useWebhooksStore.getState().applyEvent()',
    channel: 'instance',
    evidence: 'revision: s.revision + 1',
  },
  {
    type: 'dictionaries.updated',
    store: 'dictionariesStore',
    call: 'useDictionariesStore.getState().applyEvent()',
    channel: 'instance',
    evidence: 'revision: s.revision + 1',
  },
  {
    type: 'pipeline.updated',
    store: 'pipelinesStore',
    call: 'usePipelinesStore.getState().invalidateProject(',
    channel: 'session',
    evidence: 'next.delete(projectId)',
  },
];

// ---------------------------------------------------------------------------
// Перепись guard-кэшей (ленивая загрузка «один раз»)
// ---------------------------------------------------------------------------

interface GuardCache {
  /** Файл стора. */
  readonly store: string;
  /** Поле-кэш. */
  readonly field: string;
  /** Чем инвалидируется: событие / таймер / TTL. */
  readonly invalidatedBy: string;
  /** Якоря в исходниках, доказывающие путь инвалидации. */
  readonly anchors: readonly { readonly file: string; readonly snippet: string }[];
}

/**
 * Перепись guard-кэшей: каждый ленивый флаг обязан иметь путь инвалидации.
 * Порядок записи = порядок в отчёте, не важен для проверки.
 */
const GUARD_CACHES: readonly GuardCache[] = [
  {
    store: 'pipelinesStore',
    field: 'loadedProjects',
    invalidatedBy: 'событие `pipeline.updated` → `invalidateProject(projectId)`',
    anchors: [
      { file: 'pipelinesStore', snippet: 'next.delete(projectId)' },
      { file: 'transportStore', snippet: 'usePipelinesStore.getState().invalidateProject(' },
    ],
  },
  {
    store: 'providersStore',
    field: 'catalogLoaded',
    invalidatedBy: 'событие `models.updated` → `applyEvent()` (сброс `catalogLoaded: false`)',
    anchors: [
      { file: 'providersStore', snippet: 'catalogLoaded: false' },
      { file: 'transportStore', snippet: 'useProvidersStore.getState().applyEvent()' },
    ],
  },
  {
    store: 'processesStore',
    field: 'listLoaded',
    invalidatedBy: 'события `process.*`/`child.*` → `applyEvent` + `refreshListSnapshot()`',
    anchors: [
      { file: 'processesStore', snippet: 'if (!state.listLoaded) return' },
      { file: 'transportStore', snippet: 'refreshListSnapshot()' },
    ],
  },
  {
    store: 'processesStore',
    field: 'blockingLoaded',
    invalidatedBy: 'события `process.*`/`child.*` → `applyEvent` + `refreshBlockingSnapshot()`',
    anchors: [
      { file: 'transportStore', snippet: 'if (!store.blockingLoaded) return' },
      { file: 'transportStore', snippet: 'refreshBlockingSnapshot()' },
    ],
  },
  {
    store: 'gitStore',
    field: 'statusLoadedAt',
    invalidatedBy: 'TTL `STATUS_TTL_MS` (+ `force`) и `scheduleGitRefresh` на `fs.changed`',
    anchors: [
      { file: 'gitStore', snippet: 'Date.now() - loadedAt < STATUS_TTL_MS' },
      { file: 'transportStore', snippet: 'scheduleGitRefresh(projectId)' },
    ],
  },
];

/** Объявленный guard-кэш: `store:field`. */
const declaredCaches = new Set(GUARD_CACHES.map((entry) => `${entry.store}:${entry.field}`));

/**
 * Обнаружение guard-кэшей по исходникам: поле состояния с формой
 * `…Loaded`/`loadedProjects`/`…LoadedAt` и типом `boolean`/`Set<string>`/
 * `Record<string, number>` (методы вроде `ensureModelLoaded: (…) => …` под
 * шаблон не попадают — это не кэш).
 */
const GUARD_FIELD_RE =
  /^ {2}([A-Za-z_]\w*(?:Loaded|LoadedAt)|loadedProjects)\??: (boolean|Set<string>|Record<string, number>)$/gm;

function discoverGuardCaches(): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(STORES_DIR, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.ts')) continue;
    if (entry.name.endsWith('.test.ts')) continue;
    const store = entry.name.replace(/\.ts$/, '');
    const text = readStore(entry.name);
    for (const match of text.matchAll(GUARD_FIELD_RE)) {
      found.push(`${store}:${match[1]}`);
    }
  }
  return [...new Set(found)].sort();
}

// ---------------------------------------------------------------------------
// Разбор ветки диспетчера
// ---------------------------------------------------------------------------

/** Тело ветки `type === '<type>'` или `case '<type>':` в `transportStore`. */
function branchOf(dispatch: string, type: string): { text: string; line: number } | null {
  const checks = [`type === '${type}'`, `case '${type}':`];
  for (const check of checks) {
    const index = dispatch.indexOf(check);
    if (index < 0) continue;
    const isCase = check.startsWith('case');
    // Границы ветки: следующий `if (`/`case`/`default:` того же уровня или
    // конец файла. Тело обработчика всегда содержит вызов — режем по маркеру.
    const stopMarkers = isCase ? ['\n      case ', '\n      default:'] : ['\n    if (', '\n    const '];
    let end = dispatch.length;
    for (const marker of stopMarkers) {
      const next = dispatch.indexOf(marker, index + check.length);
      if (next >= 0 && next < end) end = next;
    }
    return { text: dispatch.slice(index, end), line: dispatch.slice(0, index).split('\n').length };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Прогон
// ---------------------------------------------------------------------------

describe('перепись UI-обработки событий: событие доходит до стора', () => {
  const dispatch = readStore('transportStore.ts');

  it('на каждый объявленный тип события есть ветка диспетчера с вызовом стора', () => {
    const problems: string[] = [];
    for (const handler of EVENT_HANDLERS) {
      const branch = branchOf(dispatch, handler.type);
      if (!branch) {
        problems.push(`${handler.type}: нет ветки в stores/transportStore.ts`);
        continue;
      }
      if (!branch.text.includes(handler.call)) {
        problems.push(
          `stores/transportStore.ts:${branch.line} ${handler.type}: ветка не вызывает `
          + `«${handler.call}» — событие публикуется, но UI не инвалидируется`,
        );
      }
    }
    expect(problems, 'ветка диспетчера без вызова стора').toEqual([]);
  });

  it('инстансные события разбираются до `if (!sid) return`', () => {
    const guardIndex = dispatch.indexOf(SESSION_GUARD);
    expect(guardIndex, `в stores/transportStore.ts нет «${SESSION_GUARD}»`).toBeGreaterThan(0);
    const late: string[] = [];
    for (const handler of EVENT_HANDLERS) {
      if (handler.channel !== 'instance') continue;
      const index = dispatch.indexOf(`type === '${handler.type}'`);
      if (index < 0) {
        late.push(`${handler.type}: нет ветки (см. предыдущий тест)`);
        continue;
      }
      if (index > guardIndex) {
        late.push(
          `${handler.type}: ветка стоит после «${SESSION_GUARD}» — `
          + 'инстансное событие без sid не обработается',
        );
      }
    }
    expect(late, 'инстансное событие после раннего возврата').toEqual([]);
  });

  it('метод стора существует и инвалидирует заявленным якорем', () => {
    const problems: string[] = [];
    for (const handler of EVENT_HANDLERS) {
      const text = readStore(`${handler.store}.ts`);
      const method = handler.call
        .replace(/^use\w+Store\.getState\(\)\./, '')
        .replace(/\(.*$/, '');
      if (!new RegExp(`^ {2}${method}[:(]`, 'm').test(text)) {
        problems.push(`${handler.store}.ts: нет метода ${method}`);
        continue;
      }
      if (!text.includes(handler.evidence)) {
        problems.push(
          `${handler.store}.ts: ${method} не содержит якоря инвалидации `
          + `«${handler.evidence}» — вызов есть, сброса нет`,
        );
      }
    }
    expect(problems, 'метод стора не инвалидирует').toEqual([]);
  });

  it('каждый guard-кэш из исходников объявлен в переписи', () => {
    const discovered = discoverGuardCaches();
    // Защита от «пустого» перечня при поломке разбора.
    expect(discovered.length).toBeGreaterThanOrEqual(5);
    expect(
      discovered.filter((key) => !declaredCaches.has(key)),
      'guard-кэш без пути инвалидации: добавь запись в GUARD_CACHES',
    ).toEqual([]);
    expect(
      [...declaredCaches].filter((key) => !discovered.includes(key)),
      'запись переписи без реального кэша',
    ).toEqual([]);
  });

  it('объявленный путь инвалидации guard-кэшей существует в исходниках', () => {
    const problems: string[] = [];
    for (const cache of GUARD_CACHES) {
      for (const anchor of cache.anchors) {
        const text = readStore(`${anchor.file}.ts`);
        if (!text.includes(anchor.snippet)) {
          problems.push(
            `${cache.store}.${cache.field} (${cache.invalidatedBy}): в `
            + `stores/${anchor.file}.ts нет якоря «${anchor.snippet}»`,
          );
        }
      }
    }
    expect(problems, 'guard-кэш без инвалидации').toEqual([]);
  });
});
