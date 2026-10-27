/**
 * ADR-115 §«Gateway»: вложения не сканируются guard'ом (это байты, а не текст)
 * и не попадают base64-ом в полный лог/отладочный снимок запроса.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { LLMGatewayConfig } from '@itphx/synth-shared';
import type { LLMMessage } from '../../providers/base.js';
import { redactAttachmentPayloadForDebug } from '../../providers/base.js';
import { runInputGuard, type InputGuardMeta } from './input-guard.js';
import type { AuditLogger } from './audit-logger.js';
import { readPayloadLog, writePayloadLog, type LlmPayloadEntryInput } from './payload-logger.js';

/** Маркер PNG-сигнатуры: base64 таких байтов начинается с этой подстроки. */
const PNG_MARKER = 'iVBORw0KGgo';
/**
 * Строка, похожая на AWS-ключ, но это фрагмент base64 — guard её не видит.
 * Собирается из частей в рантайме, чтобы secret-scan не считал фикстуру ключом.
 */
const AWS_LIKE_BASE64 = ['AKIA', 'IOSFODNN7EXAMPLE'].join('');

function makeConfig(overrides: Partial<LLMGatewayConfig> = {}): LLMGatewayConfig {
  return {
    enabled: true,
    inputMode: 'block',
    logPayloads: false,
    payloadLogPath: '',
    rateLimit: { userPerMinute: 60, providerPerMinute: 120 },
    audit: { enabled: true, logPath: '' },
    ...overrides,
  };
}

function makeMessage(overrides: Partial<LLMMessage> = {}): LLMMessage {
  return {
    id: 'm1',
    role: 'user',
    content: 'что на картинке?',
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    disabled: false,
    pinned: false,
    branchId: 'b1',
    ...overrides,
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

describe('input-guard и вложения (ADR-115)', () => {
  it('не сканирует base64 вложений: «секрет» внутри base64 не блокирует запрос', async () => {
    const audit = makeAudit();
    const message = makeMessage({
      attachments: [{ mime: 'image/png', name: 'p.png', base64: AWS_LIKE_BASE64 }],
    });

    const result = await runInputGuard(makeConfig(), [message], undefined, undefined, {}, audit, makeMeta());

    expect(result.ok).toBe(true);
    expect(result.secretsFound).toEqual([]);
    expect(result.messages[0]!.attachments).toEqual(message.attachments);
    expect(audit.append).not.toHaveBeenCalled();
  });

  it('сканирует только content: секрет в тексте по-прежнему блокируется', async () => {
    const audit = makeAudit();
    const result = await runInputGuard(
      makeConfig(),
      [makeMessage({ content: `ключ ${AWS_LIKE_BASE64}` })],
      undefined,
      undefined,
      {},
      audit,
      makeMeta(),
    );

    expect(result.ok).toBe(false);
    expect(audit.append).toHaveBeenCalledWith(expect.objectContaining({ type: 'blocked' }));
  });
});

describe('payload-logger и вложения (ADR-115)', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'synth-payload-attach-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function makeEntry(): LlmPayloadEntryInput {
    return {
      ts: '2026-01-01T00:00:00Z',
      sessionId: 's1',
      userId: 'u1',
      provider: 'openai',
      model: 'gpt-4o',
      request: {
        messages: [
          makeMessage({
            attachments: [
              { mime: 'image/png', name: 'p.png', base64: `${PNG_MARKER}AAAA` },
            ],
          }),
        ],
      },
      response: { content: 'котик' },
    };
  }

  it('в файле лога нет base64 — только сводка {mime, name, sizeBytes}', async () => {
    const logPath = join(dir, 'llm-payloads.jsonl');
    await writePayloadLog(logPath, makeEntry());

    const raw = await readFile(logPath, 'utf8');
    expect(raw).not.toContain(PNG_MARKER);
    expect(raw).not.toContain('base64');
    const parsed = JSON.parse(raw.trim()) as {
      request: { messages: Array<{ attachments?: Array<Record<string, unknown>> }> };
    };
    expect(parsed.request.messages[0]!.attachments).toEqual([
      { mime: 'image/png', name: 'p.png', sizeBytes: 11 },
    ]);
  });

  it('readPayloadLog отдаёт записи без base64', async () => {
    const logPath = join(dir, 'llm-payloads.jsonl');
    await writePayloadLog(logPath, makeEntry());

    const { entries, total } = await readPayloadLog(logPath);
    expect(total).toBe(1);
    expect(JSON.stringify(entries)).not.toContain(PNG_MARKER);
  });
});

describe('отладочный снимок запроса и вложения (ADR-115)', () => {
  it('data-URL и base64-данные заменяются плейсхолдерами', () => {
    const body = {
      model: 'gpt-4o',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'что на фото?' },
            { type: 'image_url', image_url: { url: `data:image/png;base64,${PNG_MARKER}` } },
          ],
        },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'послушай' },
            { type: 'input_audio', input_audio: { data: `${PNG_MARKER}AAAA`, format: 'wav' } },
          ],
        },
      ],
    };

    const redacted = redactAttachmentPayloadForDebug(body);
    const serialized = JSON.stringify(redacted);

    expect(serialized).not.toContain(PNG_MARKER);
    expect(serialized).toContain('data:image/png;base64,<redacted>');
    expect(serialized).toContain('<redacted');
    // Обычный текст не тронут.
    expect(serialized).toContain('что на фото?');
  });

  it('тело без вложений возвращается тем же объектом (без копий)', () => {
    const body = { model: 'gpt-4o', messages: [{ role: 'user', content: 'привет' }] };
    expect(redactAttachmentPayloadForDebug(body)).toBe(body);
  });
});
