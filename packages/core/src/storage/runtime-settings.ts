import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { atomicWrite, AsyncLock } from '@itphx/synth-shared';
import type { McpServerToolSettings, LLMGatewayConfig, McpNetworkPolicy, SecurityConfig, ToolsPolicy } from '@itphx/synth-shared';
import { DEFAULT_ASK_TIMEOUT_MS } from '../engine/permission/derive.js';

/** Runtime-настройки LLM Gateway, сохраняемые через UI (раздел «Шлюз безопасности»). */
export interface LlmGatewayRuntimeSettings {
  enabled: boolean;
  inputMode: 'obfuscate' | 'block';
  /** Полное логирование запросов/ответов LLM (после обфускации) в JSONL. */
  logPayloads?: boolean;
  rateLimit: {
    userPerMinute: number;
    providerPerMinute: number;
  };
}

/** Runtime-настройки секции «Безопасность», сохраняемые через UI. */
export interface SecurityRuntimeSettings {
  protectedPaths?: {
    enabled: boolean;
  };
  /** Глобальный дефолт таймаута подтверждения ask (мс). Переживает рестарт. */
  askTimeoutMs?: number;
}

export interface RuntimeSettings {
  /** Рабочий каталог по умолчанию, заданный через UI (раздел «Проекты»). */
  workspace?: string;
  /** Глобальные настройки доступности MCP-серверов по режимам plan/act. */
  mcpServers?: Record<string, McpServerToolSettings>;
  /** Глобальный тумблер LLM Gateway (AD-036): включается/выключается через UI (только ADMIN). */
  llmGateway?: Partial<LlmGatewayRuntimeSettings>;
  /** Глобальные настройки секции «Безопасность» (защищённые пути). */
  security?: Partial<SecurityRuntimeSettings>;
  /** AD-071 §2.3: глобальная политика включения инструментов (админка). */
  toolsPolicy?: ToolsPolicy;
  /** AD-071 §2.3.1: runtime-политика сетевого доступа пользовательских HTTP MCP. */
  mcpNetworkPolicy?: McpNetworkPolicy;
}

/**
 * Мёржит runtime-настройки LLM Gateway (из {dataDir}/settings.json) поверх
 * конфига из config.yaml. Runtime приоритетнее: включается/выключается шлюз
 * через UI без правки конфига. Возвращает undefined, если ни конфига, ни
 * runtime-настроек нет (шлюз не применяется — обратная совместимость).
 */
export function mergeLlmGatewayConfig(
  base: LLMGatewayConfig | undefined,
  runtime: Partial<LlmGatewayRuntimeSettings>,
): LLMGatewayConfig | undefined {
  const hasRuntime = !!runtime && Object.keys(runtime).length > 0;
  if (!base && !hasRuntime) return undefined;
  return {
    enabled: runtime.enabled ?? base?.enabled ?? false,
    inputMode: runtime.inputMode ?? base?.inputMode ?? 'obfuscate',
    logPayloads: runtime.logPayloads ?? base?.logPayloads ?? false,
    payloadLogPath: base?.payloadLogPath ?? '',
    rateLimit: {
      userPerMinute: runtime.rateLimit?.userPerMinute ?? base?.rateLimit?.userPerMinute ?? 60,
      providerPerMinute: runtime.rateLimit?.providerPerMinute ?? base?.rateLimit?.providerPerMinute ?? 120,
    },
    audit: base?.audit ?? { enabled: true, logPath: '' },
  };
}

/**
 * Мёржит runtime-настройки секции «Безопасность» (protectedPaths.enabled,
 * askTimeoutMs) поверх конфига из config.yaml. Runtime приоритетнее. Возвращает
 * undefined, если ни конфига, ни runtime-настроек нет.
 *
 * askTimeoutMs не входит в SecurityConfig (это permission-настройка), поэтому
 * возвращается как доп. поле — потребитель (onSecurityChange) пробрасывает его
 * в дефолтный permission-конфиг оркестратора.
 */
export function mergeSecurityConfig(
  base: SecurityConfig | undefined,
  runtime: Partial<SecurityRuntimeSettings>,
): (SecurityConfig & { askTimeoutMs?: number }) | undefined {
  const hasRuntime = !!runtime && Object.keys(runtime).length > 0;
  if (!base && !hasRuntime) return undefined;
  return {
    promptInjection: base?.promptInjection ?? { enabled: true, wrapContent: true, mode: 'flag' },
    protectedPaths: {
      enabled: runtime.protectedPaths?.enabled ?? base?.protectedPaths?.enabled ?? true,
    },
    askTimeoutMs: runtime.askTimeoutMs
      ?? (base as SecurityConfig & { askTimeoutMs?: number })?.askTimeoutMs
      ?? DEFAULT_ASK_TIMEOUT_MS,
  };
}

/**
 * AD-071 §2.3.1: мёржит runtime-политику сетевого доступа MCP поверх config.yaml.
 * Runtime приоритетнее; при отсутствии обоих возвращает undefined (вызывающий
 * подставляет дефолт `DEFAULT_MCP_NETWORK_POLICY`).
 */
export function mergeMcpNetworkPolicy(
  base: McpNetworkPolicy | undefined,
  runtime: McpNetworkPolicy | undefined,
): McpNetworkPolicy | undefined {
  if (!runtime && !base) return undefined;
  return {
    mode: runtime?.mode ?? base?.mode ?? 'deny',
    list: runtime?.list ?? base?.list ?? [],
  };
}

/**
 * Runtime-настройки приложения (AD-005).
 *
 * Хранятся одним JSON-файлом `{dataDir}/settings.json`. Запись атомарная:
 * временный файл `.tmp.{uuid}` → `rename()`. Значения переживают рестарт
 * сервера: при старте `createStandaloneApp` читает workspace отсюда и
 * применяет в приоритете над config.yaml.
 */
export class RuntimeSettingsStore {
  private _locks = new Map<string, AsyncLock>();

  constructor(private _opts: { dataDir: string }) {}

  private _filePath(): string {
    return join(this._opts.dataDir, 'settings.json');
  }

  private _getLock(key: string): AsyncLock {
    if (!this._locks.has(key)) {
      this._locks.set(key, new AsyncLock());
    }
    return this._locks.get(key)!;
  }

  async load(): Promise<RuntimeSettings> {
    try {
      const data = await readFile(this._filePath(), 'utf-8');
      return JSON.parse(data) as RuntimeSettings;
    } catch {
      return {};
    }
  }

  async getWorkspace(): Promise<string | undefined> {
    const settings = await this.load();
    return settings.workspace;
  }

  async setWorkspace(workspace: string): Promise<void> {
    await this._update((current) => ({ ...current, workspace }));
  }

  async getMcpSettings(): Promise<Record<string, McpServerToolSettings>> {
    const settings = await this.load();
    return settings.mcpServers ?? {};
  }

  async setMcpSettings(servers: Record<string, McpServerToolSettings>): Promise<void> {
    await this._update((current) => ({ ...current, mcpServers: servers }));
  }

  async getLlmGatewaySettings(): Promise<Partial<LlmGatewayRuntimeSettings>> {
    const settings = await this.load();
    return settings.llmGateway ?? {};
  }

  async setLlmGatewaySettings(config: Partial<LlmGatewayRuntimeSettings>): Promise<void> {
    await this._update((current) => ({ ...current, llmGateway: config }));
  }

  async getSecuritySettings(): Promise<Partial<SecurityRuntimeSettings>> {
    const settings = await this.load();
    return settings.security ?? {};
  }

  async setSecuritySettings(config: Partial<SecurityRuntimeSettings>): Promise<void> {
    await this._update((current) => ({ ...current, security: config }));
  }

  /** AD-071 §2.3: runtime-политика инструментов (админка), undefined — не задана. */
  async getToolsPolicy(): Promise<ToolsPolicy | undefined> {
    const settings = await this.load();
    return settings.toolsPolicy;
  }

  async setToolsPolicy(policy: ToolsPolicy): Promise<void> {
    await this._update((current) => ({ ...current, toolsPolicy: policy }));
  }

  /** AD-071 §2.3.1: runtime-политика сетевого доступа MCP (админка). */
  async getMcpNetworkPolicy(): Promise<McpNetworkPolicy | undefined> {
    const settings = await this.load();
    return settings.mcpNetworkPolicy;
  }

  async setMcpNetworkPolicy(policy: McpNetworkPolicy): Promise<void> {
    await this._update((current) => ({ ...current, mcpNetworkPolicy: policy }));
  }

  private async _update(mutate: (current: RuntimeSettings) => RuntimeSettings): Promise<void> {
    const path = this._filePath();
    const lock = this._getLock('settings');

    await lock.acquire();
    try {
      const current = await this.load();
      const next = mutate(current);
      await mkdir(dirname(path), { recursive: true });
      const data = JSON.stringify(next, null, 2);
      await atomicWrite(
        (p, d) => writeFile(p, d, 'utf-8'),
        (o, n) => rename(o, n),
        path,
        data,
      );
    } finally {
      lock.release();
    }
  }
}
