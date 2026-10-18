import type {
  EgressPolicy,
  EgressPolicyScope,
  WebhooksEgressPolicy,
  McpNetworkPolicy,
  McpServerToolSettings,
  SkillsDisabledRequest,
  ToolsDisabledConfig,
  ToolsPolicy,
  WorkspaceOutsideRootPolicy,
  ProxyConfig,
} from '@itphx/synth-shared';
import type {
  DecisionRuntimeSettings,
  DefaultModelPair,
  EventsRuntimeSettings,
  LlmGatewayRuntimeSettings,
  MetricsRuntimeSettings,
  RuntimeSettings,
  SecurityRuntimeSettings,
} from '../runtime-settings.js';

/**
 * Порт runtime-настроек инстанса (реализация — `RuntimeSettingsStore`).
 *
 * Хранится один JSON-файл `{dataDir}/settings.json`; наружу — доменные
 * геттеры/сеттеры по разделам, а не generic-KV. Для будущего SQL-бэкенда
 * (`@future-backend`) секции ложатся в один ключ-значение стор с типизацией,
 * но домен продолжает работать через те же методы.
 */
export interface SettingsRepository {
  load(): Promise<RuntimeSettings>;

  getWorkspace(): Promise<string | undefined>;
  setWorkspace(workspace: string): Promise<void>;
  clearWorkspace(): Promise<void>;

  getMcpSettings(): Promise<Record<string, McpServerToolSettings>>;
  setMcpSettings(servers: Record<string, McpServerToolSettings>): Promise<void>;
  clearMcpSettings(): Promise<void>;

  getLlmGatewaySettings(): Promise<Partial<LlmGatewayRuntimeSettings>>;
  setLlmGatewaySettings(config: Partial<LlmGatewayRuntimeSettings>): Promise<void>;
  clearLlmGatewaySettings(): Promise<void>;

  getSecuritySettings(): Promise<Partial<SecurityRuntimeSettings>>;
  setSecuritySettings(config: Partial<SecurityRuntimeSettings>): Promise<void>;
  clearSecuritySettings(): Promise<void>;

  getToolsPolicy(): Promise<ToolsPolicy | undefined>;
  setToolsPolicy(policy: ToolsPolicy): Promise<void>;
  clearToolsPolicy(): Promise<void>;

  getMcpPolicy(): Promise<ToolsPolicy | undefined>;
  setMcpPolicy(policy: ToolsPolicy): Promise<void>;
  clearMcpPolicy(): Promise<void>;

  getToolsDisabled(): Promise<ToolsDisabledConfig | undefined>;
  setToolsDisabled(config: ToolsDisabledConfig): Promise<void>;
  clearToolsDisabled(): Promise<void>;

  getSkillsDisabled(): Promise<SkillsDisabledRequest | undefined>;
  setSkillsDisabled(config: SkillsDisabledRequest): Promise<void>;
  clearSkillsDisabled(): Promise<void>;

  getSkillsDisabledForNewProjects(): Promise<SkillsDisabledRequest | undefined>;
  setSkillsDisabledForNewProjects(config: SkillsDisabledRequest): Promise<void>;
  clearSkillsDisabledForNewProjects(): Promise<void>;

  getMigrationMarker(name: string): Promise<boolean>;
  setMigrationMarker(name: string): Promise<void>;

  getSkillsPolicy(): Promise<ToolsPolicy | undefined>;
  setSkillsPolicy(policy: ToolsPolicy): Promise<void>;
  clearSkillsPolicy(): Promise<void>;

  getTokenRatio(model: string): Promise<number | undefined>;
  getTokenRatios(): Promise<Record<string, number>>;
  setTokenRatio(model: string, ratio: number): Promise<void>;

  getMcpNetworkPolicy(): Promise<McpNetworkPolicy | undefined>;
  setMcpNetworkPolicy(policy: McpNetworkPolicy): Promise<void>;
  clearMcpNetworkPolicy(): Promise<void>;

  /** Egress-политика встроенных инструментов / webhooks (runtime override). */
  getEgressPolicy(scope: EgressPolicyScope): Promise<EgressPolicy | WebhooksEgressPolicy | undefined>;
  setEgressPolicy(scope: EgressPolicyScope, policy: EgressPolicy | WebhooksEgressPolicy): Promise<void>;
  clearEgressPolicy(scope: EgressPolicyScope): Promise<void>;

  getDefaultAgent(): Promise<string | undefined>;
  setDefaultAgent(id: string): Promise<void>;
  clearDefaultAgent(): Promise<void>;

  /** Модель по умолчанию инстанса — явная пара provider+model (runtime override). */
  getDefaultModel(): Promise<DefaultModelPair | undefined>;
  setDefaultModel(pair: DefaultModelPair): Promise<void>;
  clearDefaultModel(): Promise<void>;

  getWorkspacePolicy(): Promise<WorkspaceOutsideRootPolicy | undefined>;
  setWorkspacePolicy(policy: WorkspaceOutsideRootPolicy): Promise<void>;
  clearWorkspacePolicy(): Promise<void>;

  getEvents(): Promise<Partial<EventsRuntimeSettings>>;
  setEvents(config: Partial<EventsRuntimeSettings>): Promise<void>;
  clearEvents(): Promise<void>;

  getDecision(): Promise<Partial<DecisionRuntimeSettings>>;
  setDecision(config: Partial<DecisionRuntimeSettings>): Promise<void>;
  clearDecision(): Promise<void>;

  /** ADR-094: runtime-настройки наблюдаемости (`metrics.enabled`). */
  getMetrics(): Promise<Partial<MetricsRuntimeSettings>>;
  setMetrics(config: Partial<MetricsRuntimeSettings>): Promise<void>;
  clearMetrics(): Promise<void>;

  /** ADR-099: runtime-override секции `proxy` (без секретов). */
  getProxySettings(): Promise<Partial<ProxyConfig> | undefined>;
  setProxySettings(config: Partial<ProxyConfig>): Promise<void>;
  clearProxySettings(): Promise<void>;
}
