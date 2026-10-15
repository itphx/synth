/**
 * Юнит-тесты Input Guard (ADR-036): обфускация/блокировка секретов
 * в messages + systemPrompt + tools перед отправкой в LLM.
 */

import { describe, it, expect, vi } from 'vitest';

import type { LLMGatewayConfig } from '@itphx/synth-shared';

import type { LLMMessage } from '../../providers/base.js';
import type { AuditLogger } from './audit-logger.js';
import { runInputGuard, type InputGuardMeta } from './input-guard.js';

const SK_KEY = 'sk-abcdefghijklmnopqrst';

function makeConfig(overrides: Partial<LLMGatewayConfig> = {}): LLMGatewayConfig {
  return {
    enabled: true,
    inputMode: 'obfuscate',
    logPayloads: false,
    payloadLogPath: '',
    rateLimit: { userPerMinute: 60, providerPerMinute: 120 },
    audit: { enabled: true, logPath: '' },
    ...overrides,
  };
}

function makeMessage(content: string): LLMMessage {
  return {
    id: 'm1',
    role: 'user',
    content,
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    disabled: false,
    pinned: false,
    branchId: 'b1',
  };
}

function makeMeta(): InputGuardMeta {
  return { sessionId: 's1', userId: 'u1', provider: 'p1', model: 'm1' };
}

function makeAudit(): AuditLogger & { append: ReturnType<typeof vi.fn> } {
  return { append: vi.fn().mockResolvedValue(undefined) } as unknown as AuditLogger & {
    append: ReturnType<typeof vi.fn>;
  };
}

describe('runInputGuard', () => {
  it('obfuscate: сообщение с секретом → ok:true, messages обфусцированы, map содержит', async () => {
    const audit = makeAudit();
    const result = await runInputGuard(
      makeConfig(),
      [makeMessage(`мой ключ ${SK_KEY}`)],
      undefined,
      undefined,
      {},
      audit,
      makeMeta(),
    );

    expect(result.ok).toBe(true);
    expect(result.messages[0]?.content).toContain('⟦SYNTH_SECRET_1⟧');
    expect(result.messages[0]?.content).not.toContain('sk-');
    expect(result.map['⟦SYNTH_SECRET_1⟧']).toBe(SK_KEY);
    expect(result.secretsFound).toEqual([SK_KEY]);
    expect(audit.append).toHaveBeenCalledWith(expect.objectContaining({ type: 'obfuscated' }));
  });

  it('obfuscate: повторный вызов с сохранённой картой не создаёт новый плейсхолдер', async () => {
    const audit = makeAudit();
    const first = await runInputGuard(
      makeConfig(),
      [makeMessage(SK_KEY)],
      undefined,
      undefined,
      {},
      audit,
      makeMeta(),
    );
    const second = await runInputGuard(
      makeConfig(),
      [makeMessage(`снова ${SK_KEY}`)],
      undefined,
      undefined,
      first.map,
      audit,
      makeMeta(),
    );

    expect(second.messages[0]?.content).toBe('снова ⟦SYNTH_SECRET_1⟧');
    expect(second.map).toEqual(first.map);
  });

  it('block: секрет найден → ok:false, reason замаскирован, message без полного секрета', async () => {
    const audit = makeAudit();
    const result = await runInputGuard(
      makeConfig({ inputMode: 'block' }),
      [makeMessage(`мой ключ ${SK_KEY}`)],
      undefined,
      undefined,
      {},
      audit,
      makeMeta(),
    );

    expect(result.ok).toBe(false);
    expect(result.blocked?.reason).toBe('sk-***');
    expect(result.blocked?.message).toContain('sk-***');
    expect(result.blocked?.message).not.toContain(SK_KEY);
    expect(audit.append).toHaveBeenCalledWith(expect.objectContaining({ type: 'blocked' }));
  });

  it('block: секреты не покидают guard (в LLM уходят только при ok:true)', async () => {
    // Фактическое поведение реализации: messages возвращаются без изменений,
    // но ok:false запрещает вызывающему коду отправлять их в LLM
    // (GatewayProvider не вызывает inner при blocked — см. gateway-provider.test.ts).
    const audit = makeAudit();
    const result = await runInputGuard(
      makeConfig({ inputMode: 'block' }),
      [makeMessage(SK_KEY)],
      undefined,
      undefined,
      {},
      audit,
      makeMeta(),
    );

    expect(result.ok).toBe(false);
    expect(result.secretsFound).toContain(SK_KEY);
  });

  it('systemPrompt обфусцируется', async () => {
    const audit = makeAudit();
    const result = await runInputGuard(
      makeConfig(),
      [],
      `системный промпт с ${SK_KEY}`,
      undefined,
      {},
      audit,
      makeMeta(),
    );

    expect(result.ok).toBe(true);
    expect(result.systemPrompt).toContain('⟦SYNTH_SECRET_1⟧');
    expect(result.systemPrompt).not.toContain('sk-');
  });

  it('tools (JSON) обфусцируются', async () => {
    const audit = makeAudit();
    const tools = [
      { type: 'function', function: { name: 'web_fetch', parameters: { url: `https://x.example/?key=${SK_KEY}` } } },
    ];
    const result = await runInputGuard(makeConfig(), [], undefined, tools, {}, audit, makeMeta());

    expect(result.ok).toBe(true);
    const json = JSON.stringify(result.tools);
    expect(json).not.toContain('sk-');
    expect(json).toContain('⟦SYNTH_SECRET_1⟧');
  });

  it('чистый промпт → ok:true, карта пустая, аудит не пишется', async () => {
    const audit = makeAudit();
    const result = await runInputGuard(
      makeConfig(),
      [makeMessage('привет')],
      'system',
      undefined,
      {},
      audit,
      makeMeta(),
    );

    expect(result.ok).toBe(true);
    expect(result.messages[0]?.content).toBe('привет');
    expect(result.map).toEqual({});
    expect(result.secretsFound).toEqual([]);
    expect(audit.append).not.toHaveBeenCalled();
  });

  it('enabled:false → passthrough без изменений', async () => {
    const audit = makeAudit();
    const messages = [makeMessage(`ключ ${SK_KEY}`)];
    const result = await runInputGuard(
      makeConfig({ enabled: false }),
      messages,
      'system',
      undefined,
      {},
      audit,
      makeMeta(),
    );

    expect(result.ok).toBe(true);
    expect(result.messages).toEqual(messages); // секрет не тронут
    expect(result.map).toEqual({});
    expect(audit.append).not.toHaveBeenCalled();
  });
});
