import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { atomicWrite, AsyncLock } from '@itphx/shared';
import type { McpServerToolSettings, LLMGatewayConfig } from '@itphx/shared';

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

export interface RuntimeSettings {
  /** Рабочий каталог по умолчанию, заданный через UI (раздел «Проекты»). */
  workspace?: string;
  /** Глобальные настройки доступности MCP-серверов по режимам plan/act. */
  mcpServers?: Record<string, McpServerToolSettings>;
  /** Глобальный тумблер LLM Gateway (AD-036): включается/выключается через UI (только ADMIN). */
  llmGateway?: Partial<LlmGatewayRuntimeSettings>;
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
