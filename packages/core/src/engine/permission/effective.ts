/**
 * ADR-029 (chain-no-copy): **живое** наследование правил прав по цепочке
 * `parentId`.
 *
 * Правила родителя больше не копируются в `settings.permission` дочерней
 * сессии при её создании: они читаются по цепочке `parentId` **в момент
 * проверки**. Поэтому грант, выданный или отозванный у родителя, виден
 * дочерним сессиям со следующей проверки — без пересоздания ребёнка и без
 * «догоняющих» правок.
 *
 * В `settings.permission` ребёнка остаются только `deny`-дополнения роли
 * (`deriveSubagentPermission`) и гранты, выданные **ему самому**.
 *
 * Резолвер чистый по вводу-выводу: в хранилище ничего не пишет, кеша между
 * вызовами не держит (иначе отзыв гранта у родителя не был бы виден).
 */
import type { PermissionConfig, PermissionRule } from '@itphx/synth-shared';
import { warning } from '../../logger.js';
import { DEFAULT_ASK_TIMEOUT_MS } from './derive.js';

/**
 * ADR-029: потолок глубины подъёма по цепочке `parentId`. Саб-агенты вкладываются
 * ограниченно (`agents.subagentDepth`), но цепочка может быть испорчена
 * (висячие/циклические `parentId`) — резолв обязан завершиться.
 */
export const MAX_PERMISSION_PARENT_DEPTH = 16;

/** Минимум, который нужен резолверу от сессии (без истории и прочего). */
export interface PermissionChainSession {
  id: string;
  parentId?: string;
  settings: { permission?: PermissionConfig };
}

export interface ResolveEffectivePermissionParams {
  /** Сессия, чей конфиг резолвим (или её id). */
  session: PermissionChainSession;
  /** Загрузчик сессии по id (для подъёма по цепочке `parentId`). */
  getSession: (id: string) => Promise<PermissionChainSession | null | undefined>;
  /** База, если ни у кого в цепочке нет своих правил (инстанс-дефолт). */
  fallback?: PermissionConfig;
}

/**
 * Эффективные правила прав сессии (ADR-029, chain-no-copy).
 *
 * Поднимается от сессии вверх по `parentId` и сливает правила **root → leaf**:
 * правило ребёнка по тому же ключу перекрывает родительское, ключи родителей,
 * которых у ребёнка нет, наследуются. `askTimeoutMs` — свой у сессии, иначе
 * ближайшего предка, у которого задан, иначе `fallback.askTimeoutMs`, иначе
 * `DEFAULT_ASK_TIMEOUT_MS`.
 *
 * Отказы резолва (цикл, превышение глубины, отсутствующий или не загрузившийся
 * родитель) — **fail-open** ради проверки прав: подъём прекращается, ошибка
 * вызывающему не пробрасывается (иначе одна битая ссылка `parentId` гасила бы
 * весь ход), в журнал уходит `warning`.
 */
export async function resolveEffectivePermission(
  params: ResolveEffectivePermissionParams,
): Promise<PermissionConfig> {
  const { session, getSession, fallback } = params;

  // Цепочка от листа к корню: [сессия, родитель, …, корень].
  const chain: PermissionChainSession[] = [session];
  const visited = new Set<string>([session.id]);
  let current = session;

  while (current.parentId) {
    if (chain.length >= MAX_PERMISSION_PARENT_DEPTH) {
      warning(
        'PERMISSION',
        `ADR-029: цепочка наследования прав обрезана на ${MAX_PERMISSION_PARENT_DEPTH} узлах (сессия ${session.id})`,
      );
      break;
    }
    const parentId = current.parentId;
    if (visited.has(parentId)) {
      warning(
        'PERMISSION',
        `ADR-029: цикл в цепочке наследования прав (сессия ${session.id}, повтор ${parentId}) — подъём прекращён`,
      );
      break;
    }
    let parent: PermissionChainSession | null | undefined;
    try {
      parent = await getSession(parentId);
    } catch (err) {
      warning(
        'PERMISSION',
        `ADR-029: родитель ${parentId} в цепочке прав сессии ${session.id} не загрузился: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      break;
    }
    // Висячий `parentId` — работаем с тем, что собрали (без шума в журнале:
    // это может быть штатное удаление родителя).
    if (!parent) break;
    visited.add(parent.id);
    chain.push(parent);
    current = parent;
  }

  const rules: Record<string, PermissionRule> = { ...(fallback?.rules ?? {}) };
  let askTimeoutMs: number | undefined;
  // root → leaf: правило ребёнка перекрывает родительское. `askTimeoutMs`
  // перезаписывается на каждом уровне, поэтому побеждает ближайший к листу.
  for (const node of [...chain].reverse()) {
    const config = node.settings?.permission;
    if (!config) continue;
    Object.assign(rules, config.rules ?? {});
    if (typeof config.askTimeoutMs === 'number') askTimeoutMs = config.askTimeoutMs;
  }

  return {
    rules,
    askTimeoutMs: askTimeoutMs ?? fallback?.askTimeoutMs ?? DEFAULT_ASK_TIMEOUT_MS,
  };
}
