/**
 * Порт `settings` (runtime-настройки инстанса) PostgreSQL-драйвера
 * (PROP-032, волна 3b).
 *
 * Эталон семантики — `RuntimeSettingsStore`/`MemorySettingsRepository`:
 *   - `load()` на пустом сторе — `{}` (не заданные секции в результат не попадают);
 *   - геттеры отдают `undefined`/`{}`/`false` для не заданных значений;
 *   - `clear*` убирает секцию (ключ удаляется, а не пишется `null`).
 *
 * Хранение разложено по таблицам `001_init`:
 *   - `settings(key PK, value jsonb)` — секции `RuntimeSettings` (по ключу на секцию);
 *   - `token_ratios(model PK, ratio)` — chars-per-token по модели;
 *   - `migration_markers(name PK)` — маркеры разовых миграций.
 *
 * Запись секции — upsert одного ключа. Read-modify-write файловой реализации для
 * `migrations`/`tokenRatios` здесь отсутствует by design: они нормализованы в
 * отдельные таблицы (строку за раз), поэтому гонки между обновлениями разных
 * моделей/маркеров нет.
 */

import type { RuntimeSettings, StorageContext } from '@itphx/synth-core';
import type { PostgresConnection } from '../pool.js';
import { deleteSetting, readSetting, writeSetting } from './principals-shared.js';

type SettingsPort = StorageContext['settings'];

/** Значение секции `RuntimeSettings` без `undefined`. */
type RuntimeSettingsValue<K extends keyof RuntimeSettings> = NonNullable<RuntimeSettings[K]>;

/** Ключи секций, которые порт хранит в таблице `settings` (порядок стабилен). */
const SECTION_KEYS = [
  'workspace',
  'mcpServers',
  'llmGateway',
  'security',
  'toolsPolicy',
  'mcpPolicy',
  'toolsDisabled',
  'skillsDisabled',
  'skillsDisabledForNewProjects',
  'skillsPolicy',
  'mcpNetworkPolicy',
  'egress',
  'defaultAgent',
  'defaultModel',
  'workspacePolicy',
  'events',
  'decision',
  'proxy',
] as const satisfies readonly (keyof RuntimeSettings)[];

const SECTION_KEY_SET: ReadonlySet<string> = new Set<string>(SECTION_KEYS);

/** Собрать порт runtime-настроек поверх SQL. */
export function createPrincipalSettingsPort(conn: PostgresConnection): SettingsPort {
  return {
    async load(): Promise<RuntimeSettings> {
      const settings: RuntimeSettings = {};

      const rows = await conn.query<{ key: string; value: unknown }>(
        'SELECT key, value FROM settings WHERE key = ANY($1::text[])',
        [[...SECTION_KEYS]],
      );
      for (const row of rows) {
        if (!SECTION_KEY_SET.has(row.key)) continue;
        (settings as Record<string, unknown>)[row.key] = row.value;
      }

      const ratios = await conn.query<{ model: string; ratio: number }>(
        'SELECT model, ratio FROM token_ratios',
      );
      if (ratios.length > 0) {
        const tokenRatios: Record<string, number> = {};
        for (const row of ratios) tokenRatios[row.model] = row.ratio;
        settings.tokenRatios = tokenRatios;
      }

      const markers = await conn.query<{ name: string }>('SELECT name FROM migration_markers');
      if (markers.length > 0) {
        const migrations: Record<string, boolean> = {};
        for (const row of markers) migrations[row.name] = true;
        settings.migrations = migrations;
      }

      return settings;
    },

    async getWorkspace(): Promise<string | undefined> {
      return readSetting<string>(conn, 'workspace');
    },
    async setWorkspace(workspace: string): Promise<void> {
      await writeSetting(conn, 'workspace', workspace);
    },
    async clearWorkspace(): Promise<void> {
      await deleteSetting(conn, 'workspace');
    },

    async getMcpSettings(): Promise<RuntimeSettingsValue<'mcpServers'>> {
      return (await readSetting<RuntimeSettingsValue<'mcpServers'>>(conn, 'mcpServers')) ?? {};
    },
    async setMcpSettings(servers: RuntimeSettingsValue<'mcpServers'>): Promise<void> {
      await writeSetting(conn, 'mcpServers', servers);
    },
    async clearMcpSettings(): Promise<void> {
      await deleteSetting(conn, 'mcpServers');
    },

    async getLlmGatewaySettings(): Promise<RuntimeSettingsValue<'llmGateway'>> {
      return (await readSetting<RuntimeSettingsValue<'llmGateway'>>(conn, 'llmGateway')) ?? {};
    },
    async setLlmGatewaySettings(config: RuntimeSettingsValue<'llmGateway'>): Promise<void> {
      await writeSetting(conn, 'llmGateway', config);
    },
    async clearLlmGatewaySettings(): Promise<void> {
      await deleteSetting(conn, 'llmGateway');
    },

    async getSecuritySettings(): Promise<RuntimeSettingsValue<'security'>> {
      return (await readSetting<RuntimeSettingsValue<'security'>>(conn, 'security')) ?? {};
    },
    async setSecuritySettings(config: RuntimeSettingsValue<'security'>): Promise<void> {
      await writeSetting(conn, 'security', config);
    },
    async clearSecuritySettings(): Promise<void> {
      await deleteSetting(conn, 'security');
    },

    async getToolsPolicy(): Promise<RuntimeSettingsValue<'toolsPolicy'> | undefined> {
      return readSetting<RuntimeSettingsValue<'toolsPolicy'>>(conn, 'toolsPolicy');
    },
    async setToolsPolicy(policy: RuntimeSettingsValue<'toolsPolicy'>): Promise<void> {
      await writeSetting(conn, 'toolsPolicy', policy);
    },
    async clearToolsPolicy(): Promise<void> {
      await deleteSetting(conn, 'toolsPolicy');
    },

    async getMcpPolicy(): Promise<RuntimeSettingsValue<'mcpPolicy'> | undefined> {
      return readSetting<RuntimeSettingsValue<'mcpPolicy'>>(conn, 'mcpPolicy');
    },
    async setMcpPolicy(policy: RuntimeSettingsValue<'mcpPolicy'>): Promise<void> {
      await writeSetting(conn, 'mcpPolicy', policy);
    },
    async clearMcpPolicy(): Promise<void> {
      await deleteSetting(conn, 'mcpPolicy');
    },

    async getToolsDisabled(): Promise<RuntimeSettingsValue<'toolsDisabled'> | undefined> {
      return readSetting<RuntimeSettingsValue<'toolsDisabled'>>(conn, 'toolsDisabled');
    },
    async setToolsDisabled(config: RuntimeSettingsValue<'toolsDisabled'>): Promise<void> {
      await writeSetting(conn, 'toolsDisabled', config);
    },
    async clearToolsDisabled(): Promise<void> {
      await deleteSetting(conn, 'toolsDisabled');
    },

    async getSkillsDisabled(): Promise<RuntimeSettingsValue<'skillsDisabled'> | undefined> {
      return readSetting<RuntimeSettingsValue<'skillsDisabled'>>(conn, 'skillsDisabled');
    },
    async setSkillsDisabled(config: RuntimeSettingsValue<'skillsDisabled'>): Promise<void> {
      await writeSetting(conn, 'skillsDisabled', config);
    },
    async clearSkillsDisabled(): Promise<void> {
      await deleteSetting(conn, 'skillsDisabled');
    },

    async getSkillsDisabledForNewProjects(): Promise<
      RuntimeSettingsValue<'skillsDisabledForNewProjects'> | undefined
    > {
      return readSetting<RuntimeSettingsValue<'skillsDisabledForNewProjects'>>(
        conn,
        'skillsDisabledForNewProjects',
      );
    },
    async setSkillsDisabledForNewProjects(
      config: RuntimeSettingsValue<'skillsDisabledForNewProjects'>,
    ): Promise<void> {
      await writeSetting(conn, 'skillsDisabledForNewProjects', config);
    },
    async clearSkillsDisabledForNewProjects(): Promise<void> {
      await deleteSetting(conn, 'skillsDisabledForNewProjects');
    },

    async getMigrationMarker(name: string): Promise<boolean> {
      const rows = await conn.query<{ name: string }>(
        'SELECT name FROM migration_markers WHERE name = $1',
        [name],
      );
      return rows.length > 0;
    },
    async setMigrationMarker(name: string): Promise<void> {
      await conn.query(
        `INSERT INTO migration_markers (name) VALUES ($1)
         ON CONFLICT (name) DO UPDATE SET applied_at = now()`,
        [name],
      );
    },

    async getSkillsPolicy(): Promise<RuntimeSettingsValue<'skillsPolicy'> | undefined> {
      return readSetting<RuntimeSettingsValue<'skillsPolicy'>>(conn, 'skillsPolicy');
    },
    async setSkillsPolicy(policy: RuntimeSettingsValue<'skillsPolicy'>): Promise<void> {
      await writeSetting(conn, 'skillsPolicy', policy);
    },
    async clearSkillsPolicy(): Promise<void> {
      await deleteSetting(conn, 'skillsPolicy');
    },

    async getTokenRatio(model: string): Promise<number | undefined> {
      const rows = await conn.query<{ ratio: number }>(
        'SELECT ratio FROM token_ratios WHERE model = $1',
        [model],
      );
      return rows[0]?.ratio;
    },
    async getTokenRatios(): Promise<Record<string, number>> {
      const rows = await conn.query<{ model: string; ratio: number }>(
        'SELECT model, ratio FROM token_ratios',
      );
      const ratios: Record<string, number> = {};
      for (const row of rows) ratios[row.model] = row.ratio;
      return ratios;
    },
    async setTokenRatio(model: string, ratio: number): Promise<void> {
      await conn.query(
        `INSERT INTO token_ratios (model, ratio, updated_at) VALUES ($1, $2, now())
         ON CONFLICT (model) DO UPDATE SET ratio = EXCLUDED.ratio, updated_at = now()`,
        [model, ratio],
      );
    },

    async getMcpNetworkPolicy(): Promise<RuntimeSettingsValue<'mcpNetworkPolicy'> | undefined> {
      return readSetting<RuntimeSettingsValue<'mcpNetworkPolicy'>>(conn, 'mcpNetworkPolicy');
    },
    async setMcpNetworkPolicy(policy: RuntimeSettingsValue<'mcpNetworkPolicy'>): Promise<void> {
      await writeSetting(conn, 'mcpNetworkPolicy', policy);
    },
    async getEgressPolicy(scope: Parameters<SettingsPort['getEgressPolicy']>[0]) {
      const all = await readSetting<RuntimeSettings['egress']>(conn, 'egress');
      return all?.[scope];
    },
    async setEgressPolicy(
      scope: Parameters<SettingsPort['setEgressPolicy']>[0],
      policy: Parameters<SettingsPort['setEgressPolicy']>[1],
    ): Promise<void> {
      const all = (await readSetting<RuntimeSettings['egress']>(conn, 'egress')) ?? {};
      await writeSetting(conn, 'egress', { ...all, [scope]: policy });
    },
    async clearEgressPolicy(scope: Parameters<SettingsPort['clearEgressPolicy']>[0]): Promise<void> {
      const all = await readSetting<RuntimeSettings['egress']>(conn, 'egress');
      if (!all) return;
      const next = { ...all };
      delete next[scope];
      if (Object.keys(next).length > 0) await writeSetting(conn, 'egress', next);
      else await deleteSetting(conn, 'egress');
    },

    async clearMcpNetworkPolicy(): Promise<void> {
      await deleteSetting(conn, 'mcpNetworkPolicy');
    },

    async getDefaultAgent(): Promise<string | undefined> {
      return readSetting<string>(conn, 'defaultAgent');
    },
    async setDefaultAgent(id: string): Promise<void> {
      await writeSetting(conn, 'defaultAgent', id);
    },
    async clearDefaultAgent(): Promise<void> {
      await deleteSetting(conn, 'defaultAgent');
    },

    async getDefaultModel(): Promise<RuntimeSettingsValue<'defaultModel'> | undefined> {
      return readSetting<RuntimeSettingsValue<'defaultModel'>>(conn, 'defaultModel');
    },
    async setDefaultModel(pair: RuntimeSettingsValue<'defaultModel'>): Promise<void> {
      await writeSetting(conn, 'defaultModel', pair);
    },
    async clearDefaultModel(): Promise<void> {
      await deleteSetting(conn, 'defaultModel');
    },

    async getWorkspacePolicy(): Promise<RuntimeSettingsValue<'workspacePolicy'> | undefined> {
      return readSetting<RuntimeSettingsValue<'workspacePolicy'>>(conn, 'workspacePolicy');
    },
    async setWorkspacePolicy(policy: RuntimeSettingsValue<'workspacePolicy'>): Promise<void> {
      await writeSetting(conn, 'workspacePolicy', policy);
    },
    async clearWorkspacePolicy(): Promise<void> {
      await deleteSetting(conn, 'workspacePolicy');
    },

    async getEvents(): Promise<RuntimeSettingsValue<'events'>> {
      return (await readSetting<RuntimeSettingsValue<'events'>>(conn, 'events')) ?? {};
    },
    async setEvents(config: RuntimeSettingsValue<'events'>): Promise<void> {
      await writeSetting(conn, 'events', config);
    },
    async clearEvents(): Promise<void> {
      await deleteSetting(conn, 'events');
    },

    async getDecision(): Promise<RuntimeSettingsValue<'decision'>> {
      return (await readSetting<RuntimeSettingsValue<'decision'>>(conn, 'decision')) ?? {};
    },
    async setDecision(config: RuntimeSettingsValue<'decision'>): Promise<void> {
      await writeSetting(conn, 'decision', config);
    },
    async clearDecision(): Promise<void> {
      await deleteSetting(conn, 'decision');
    },

    async getMetrics(): Promise<RuntimeSettingsValue<'metrics'>> {
      return (await readSetting<RuntimeSettingsValue<'metrics'>>(conn, 'metrics')) ?? {};
    },
    async setMetrics(config: RuntimeSettingsValue<'metrics'>): Promise<void> {
      await writeSetting(conn, 'metrics', config);
    },
    async clearMetrics(): Promise<void> {
      await deleteSetting(conn, 'metrics');
    },

    async getProxySettings(): Promise<RuntimeSettingsValue<'proxy'> | undefined> {
      return readSetting<RuntimeSettingsValue<'proxy'>>(conn, 'proxy');
    },
    async setProxySettings(config: RuntimeSettingsValue<'proxy'>): Promise<void> {
      await writeSetting(conn, 'proxy', config);
    },
    async clearProxySettings(): Promise<void> {
      await deleteSetting(conn, 'proxy');
    },
  };
}
