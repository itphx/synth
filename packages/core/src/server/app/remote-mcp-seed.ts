/**
 * PROP-125 §2: сид серверных MCP-серверов в проекты локального core.
 *
 * Серверные MCP-серверы гибрида становятся доступны локальным сессиям по
 * тому же правилу, что и локальные (PROP-125, решение 1 владельца):
 * системный мастер → проектный hard-gate (`project.mcp.enabled`) →
 * сессионный снимок (`mcpDefaultOn`/`mcpDisabledServers`). Поэтому серверные
 * дефолты надо положить в **проектный** скоуп:
 *
 * - **новый проект** — сид из локальных `config.mcpServers` (`enabledByDefault`)
 *   и серверных дефолтов (`mergeMcpSeedDefaults`);
 * - **существующий проект** — авто-сид при подключении гибрида
 *   (`seedRemoteMcpProjects`): серверные `enabledByDefault` добавляются в
 *   `project.mcp.enabled`/`project.mcp.defaultOn`, чтобы серверы попали в
 *   новые сессии проекта.
 *
 * Идемпотентность — маркер `project.mcp.remoteSeeded`: имена серверных
 * дефолтов, уже применённых к проекту. Повторный коннект **не** возвращает
 * сервер, который пользователь затем выключил (PROP-125, решение 7).
 *
 * Сессионные снимки существующих сессий не переписываются (паритет с
 * удалённым миром, где снимок создаётся при создании сессии).
 *
 * Модуль — чистые функции: никакого I/O (запись идёт через порт
 * `ProjectRepository.mutate`, ADR-096).
 */

import type { Project } from '@itphx/synth-shared';

/**
 * PROP-125: объединить локальные и серверные дефолты MCP для сида нового
 * проекта (уникальные имена).
 *
 * Порядок: сначала локальные, затем серверные — порядок влияет только на
 * порядок имён в `project.mcp.enabled`/`defaultOn`.
 */
export function mergeMcpSeedDefaults(local: readonly string[], remote: readonly string[]): string[] {
  const merged: string[] = [];
  const seen = new Set<string>();
  for (const name of [...local, ...remote]) {
    if (!name) continue;
    if (seen.has(name)) continue;
    seen.add(name);
    merged.push(name);
  }
  return merged;
}

/**
 * PROP-125 §2: добавить серверные дефолты в `project.mcp` существующих
 * проектов.
 *
 * Идемпотентно: имена из `remoteSeeded` повторно не добавляются (пользователь
 * мог выключить сервер). `mutate` — синхронный мутатор
 * `ProjectRepository.mutate` (атомарный read-modify-write под локом
 * хранилища, ADR-096).
 *
 * `knownServers` — список серверов, известных инстансу сейчас (локальные +
 * серверные). Нужен для **legacy-проектов без `project.mcp`**: отсутствие
 * `project.mcp` по ADR-071 означает «проектный гейт не задан» (доступны все
 * серверы), а появление `enabled` — hard-gate allow-list. Если такой проект
 * получил бы только серверные дефолты, локальные серверы стали бы для него
 * `project_disabled` — регрессия. Поэтому стартовый `enabled` legacy-проекта
 * = все известные серверы, а `toAdd` добавляется к нему.
 *
 * `defaultOn` — только `toAdd` (сид новых сессий проекта): локальные серверы
 * пользователю проекта включать не нужно.
 *
 * Возвращает число обновлённых проектов.
 */
export async function seedRemoteMcpProjects(opts: {
  projects: Project[];
  defaults: readonly string[];
  /**
   * Известные серверы инстанса (локальные + серверные) — стартовая база
   * `enabled` для проектов без `project.mcp`. Не передан — база = только
   * `toAdd` (прежнее поведение).
   */
  knownServers?: readonly string[];
  mutate: (id: string, mutator: (project: Project) => void) => Promise<Project | null>;
  onUpdated?: (project: Project) => Promise<void> | void;
}): Promise<number> {
  const defaults: string[] = [];
  const seenDefaults = new Set<string>();
  for (const name of opts.defaults) {
    if (!name || seenDefaults.has(name)) continue;
    seenDefaults.add(name);
    defaults.push(name);
  }
  if (defaults.length === 0) return 0;

  const knownServers = opts.knownServers
    ? [...new Set(opts.knownServers.filter((name) => !!name))]
    : undefined;

  let updated = 0;
  for (const project of opts.projects) {
    const seeded = new Set(project.mcp?.remoteSeeded ?? []);
    const toAdd = defaults.filter((name) => !seeded.has(name));
    if (toAdd.length === 0) continue;

    const saved = await opts.mutate(project.id, (p) => {
      // Legacy-проект (`project.mcp` отсутствует) — гейт не задан: сохраняем
      // доступность всех известных серверов, иначе локальные MCP-серверы
      // станут для проекта `project_disabled` (ADR-071).
      const base = p.mcp
        ? new Set(p.mcp.enabled ?? [])
        : new Set(knownServers ?? []);
      const enabled = new Set(base);
      const defaultOn = new Set(p.mcp?.defaultOn ?? []);
      for (const name of toAdd) {
        enabled.add(name);
        defaultOn.add(name);
      }
      p.mcp = {
        enabled: [...enabled],
        defaultOn: [...defaultOn],
        remoteSeeded: [...(p.mcp?.remoteSeeded ?? []), ...toAdd],
      };
    });
    if (!saved) continue;
    updated += 1;
    if (opts.onUpdated) await opts.onUpdated(saved);
  }
  return updated;
}
