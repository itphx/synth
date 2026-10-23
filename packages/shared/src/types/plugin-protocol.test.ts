/**
 * ADR-090: тесты контракта wire-протокола плагина.
 *
 * Проверяется только **контракт** (`shared`): форма `/capabilities`, коды
 * причин отказа и их HTTP-статусы. Клиент и загрузчик — в core
 * (`engine/plugins/remote/*`).
 */
import { describe, expect, it } from 'vitest';

import {
  PLUGIN_PROTOCOL_ERROR_REASONS,
  PLUGIN_PROTOCOL_ERROR_STATUS,
  PLUGIN_PROTOCOL_PATHS,
  PLUGIN_PROTOCOL_POINTS,
  PLUGIN_PROTOCOL_VERSION,
  checkPluginCapabilities,
  isPluginPromptBlockStatus,
  isPluginProtocolErrorReason,
  isPluginProtocolPoint,
} from './plugin-protocol.js';

const EXPECTED = { name: 'demo-plugin', version: '1.0.0' };

/** Валидный ответ `/capabilities` с обеими точками. */
function validCapabilities(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    protocol: PLUGIN_PROTOCOL_VERSION,
    name: EXPECTED.name,
    version: EXPECTED.version,
    points: {
      promptBlocks: [{ key: 'plugin.demo.memory', tier: 'context', order: 100, title: 'Memory' }],
      llmFilters: [{ id: 'plugin:demo-plugin:dlp', phase: 'pre_request', failMode: 'closed', timeoutMs: 200 }],
    },
    ...over,
  };
}

describe('константы протокола', () => {
  it('версия 1 и три эндпоинта', () => {
    expect(PLUGIN_PROTOCOL_VERSION).toBe(1);
    expect(PLUGIN_PROTOCOL_PATHS).toEqual({
      invoke: '/invoke',
      capabilities: '/capabilities',
      health: '/health',
    });
  });

  it('по протоколу передаются promptBlocks, llmFilters и tools', () => {
    expect(PLUGIN_PROTOCOL_POINTS).toEqual(['promptBlocks', 'llmFilters', 'tools']);
    expect(isPluginProtocolPoint('promptBlocks')).toBe(true);
    expect(isPluginProtocolPoint('llmFilters')).toBe(true);
    expect(isPluginProtocolPoint('tools')).toBe(true);
    expect(isPluginProtocolPoint('hooks')).toBe(false);
  });

  it('таблица HTTP-статусов покрывает все причины отказа', () => {
    for (const reason of PLUGIN_PROTOCOL_ERROR_REASONS) {
      const status = PLUGIN_PROTOCOL_ERROR_STATUS[reason];
      expect(Number.isInteger(status), `нет статуса для «${reason}»`).toBe(true);
      expect(status).toBeGreaterThanOrEqual(400);
    }
    expect(Object.keys(PLUGIN_PROTOCOL_ERROR_STATUS).sort()).toEqual(
      [...PLUGIN_PROTOCOL_ERROR_REASONS].sort(),
    );
    expect(PLUGIN_PROTOCOL_ERROR_STATUS.unauthorized).toBe(401);
    expect(PLUGIN_PROTOCOL_ERROR_STATUS.unknown_id).toBe(404);
    expect(PLUGIN_PROTOCOL_ERROR_STATUS.invalid_request).toBe(400);
  });

  it('причина отказа — известное значение перечня', () => {
    expect(isPluginProtocolErrorReason('timeout')).toBe(true);
    expect(isPluginProtocolErrorReason('nope')).toBe(false);
  });

  it('статус блока промпта — из известного перечня', () => {
    expect(isPluginPromptBlockStatus('truncated')).toBe(true);
    expect(isPluginPromptBlockStatus('stable')).toBe(false);
  });
});

describe('checkPluginCapabilities: успех', () => {
  it('валидный ответ нормализуется (только известные поля)', () => {
    const result = checkPluginCapabilities(
      validCapabilities({ extra: 'ignore-me' }),
      EXPECTED,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.capabilities).toEqual({
      protocol: 1,
      name: 'demo-plugin',
      version: '1.0.0',
      points: {
        promptBlocks: [{ key: 'plugin.demo.memory', tier: 'context', order: 100, title: 'Memory' }],
        llmFilters: [
          { id: 'plugin:demo-plugin:dlp', phase: 'pre_request', failMode: 'closed', timeoutMs: 200 },
        ],
      },
    });
    expect('extra' in result.capabilities).toBe(false);
  });

  it('плагин без точек принимается (пустые points)', () => {
    const result = checkPluginCapabilities(
      { protocol: 1, name: 'demo-plugin', version: '1.0.0' },
      EXPECTED,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.capabilities.points).toEqual({});
  });
});

describe('checkPluginCapabilities: отказы', () => {
  it('чужая версия протокола → protocol_mismatch', () => {
    const result = checkPluginCapabilities(validCapabilities({ protocol: 2 }), EXPECTED);
    expect(result).toMatchObject({ ok: false, reason: 'protocol_mismatch' });
  });

  it('другое имя плагина → protocol_mismatch', () => {
    const result = checkPluginCapabilities(validCapabilities({ name: 'other-plugin' }), EXPECTED);
    expect(result).toMatchObject({ ok: false, reason: 'protocol_mismatch' });
    if (result.ok) return;
    expect(result.message).toContain('other-plugin');
  });

  it('другая версия плагина → protocol_mismatch', () => {
    const result = checkPluginCapabilities(validCapabilities({ version: '2.0.0' }), EXPECTED);
    expect(result).toMatchObject({ ok: false, reason: 'protocol_mismatch' });
  });

  it('мусор в ответе → invalid_request', () => {
    for (const payload of [null, [], 'ok', 42]) {
      const result = checkPluginCapabilities(payload, EXPECTED);
      expect(result).toMatchObject({ ok: false, reason: 'invalid_request' });
    }
    expect(checkPluginCapabilities({ name: 'demo-plugin', version: '1.0.0' }, EXPECTED)).toMatchObject({
      ok: false,
      reason: 'invalid_request',
    });
    expect(checkPluginCapabilities(validCapabilities({ protocol: '1' }), EXPECTED)).toMatchObject({
      ok: false,
      reason: 'invalid_request',
    });
  });

  it('неизвестная точка в points → unknown_point', () => {
    const result = checkPluginCapabilities(
      validCapabilities({ points: { hooks: [] } }),
      EXPECTED,
    );
    expect(result).toMatchObject({ ok: false, reason: 'unknown_point' });
  });

  it('тир stable у блока запрещён (граница prompt-cache) → invalid_request', () => {
    const result = checkPluginCapabilities(
      validCapabilities({
        points: { promptBlocks: [{ key: 'plugin.demo.x', tier: 'stable', order: 1 }] },
      }),
      EXPECTED,
    );
    expect(result).toMatchObject({ ok: false, reason: 'invalid_request' });
  });

  it('неизвестная фаза фильтра → invalid_request', () => {
    const result = checkPluginCapabilities(
      validCapabilities({
        points: { llmFilters: [{ id: 'plugin:demo-plugin:x', phase: 'before_all' }] },
      }),
      EXPECTED,
    );
    expect(result).toMatchObject({ ok: false, reason: 'invalid_request' });
  });

  it('неверные типы полей точек → invalid_request', () => {
    const cases: unknown[] = [
      { promptBlocks: 'not-array' },
      { promptBlocks: [{ key: '', tier: 'context', order: 1 }] },
      { promptBlocks: [{ key: 'k', tier: 'context', order: '1' }] },
      { promptBlocks: [{ key: 'k', tier: 'context', order: 1, title: 5 }] },
      { llmFilters: [{ id: 'k', phase: 'pre_request', failMode: 'maybe' }] },
      { llmFilters: [{ id: 'k', phase: 'pre_request', timeoutMs: 0 }] },
      { llmFilters: [{ id: '', phase: 'pre_request' }] },
    ];
    for (const points of cases) {
      const result = checkPluginCapabilities(validCapabilities({ points }), EXPECTED);
      expect(result, JSON.stringify(points)).toMatchObject({ ok: false, reason: 'invalid_request' });
    }
  });

  it('дубли ключей блока и идентификаторов фильтра → invalid_request', () => {
    expect(
      checkPluginCapabilities(
        validCapabilities({
          points: {
            promptBlocks: [
              { key: 'plugin.demo.x', tier: 'context', order: 1 },
              { key: 'plugin.demo.x', tier: 'volatile', order: 2 },
            ],
          },
        }),
        EXPECTED,
      ),
    ).toMatchObject({ ok: false, reason: 'invalid_request' });

    expect(
      checkPluginCapabilities(
        validCapabilities({
          points: {
            llmFilters: [
              { id: 'plugin:demo-plugin:x', phase: 'pre_request' },
              { id: 'plugin:demo-plugin:x', phase: 'post_response' },
            ],
          },
        }),
        EXPECTED,
      ),
    ).toMatchObject({ ok: false, reason: 'invalid_request' });
  });

  it('points не объект → invalid_request', () => {
    expect(checkPluginCapabilities(validCapabilities({ points: [] }), EXPECTED)).toMatchObject({
      ok: false,
      reason: 'invalid_request',
    });
  });
});

describe('checkPluginCapabilities: точка tools (Ф4б-3)', () => {
  /** Валидное описание тула. */
  function tool(over: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      name: 'memory_search',
      description: 'Поиск по памяти плагина',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string' } },
        required: ['query'],
      },
      capabilities: ['search'],
      ...over,
    };
  }

  it('валидный тул нормализуется (JSON-Schema и capabilities сохраняются)', () => {
    const result = checkPluginCapabilities(
      validCapabilities({ points: { tools: [tool()] } }),
      EXPECTED,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.capabilities.points.tools).toEqual([
      {
        name: 'memory_search',
        description: 'Поиск по памяти плагина',
        parameters: {
          type: 'object',
          properties: { query: { type: 'string' } },
          required: ['query'],
        },
        capabilities: ['search'],
      },
    ]);
  });

  it('тул без parameters принимается (схему не выдумываем)', () => {
    const raw = tool();
    delete raw.parameters;
    const result = checkPluginCapabilities(
      validCapabilities({ points: { tools: [raw] } }),
      EXPECTED,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.capabilities.points.tools).toEqual([
      {
        name: 'memory_search',
        description: 'Поиск по памяти плагина',
        capabilities: ['search'],
      },
    ]);
  });

  it('без capabilities тул отклоняется (был бы невидим permission-слою)', () => {
    for (const over of [{ capabilities: [] }, { capabilities: undefined }, { capabilities: 'search' }]) {
      const result = checkPluginCapabilities(
        validCapabilities({ points: { tools: [tool(over)] } }),
        EXPECTED,
      );
      expect(result, JSON.stringify(over)).toMatchObject({ ok: false, reason: 'invalid_request' });
    }
  });

  it('неизвестная capability тула → invalid_request', () => {
    const result = checkPluginCapabilities(
      validCapabilities({ points: { tools: [tool({ capabilities: ['root'] })] } }),
      EXPECTED,
    );
    expect(result).toMatchObject({ ok: false, reason: 'invalid_request' });
    if (result.ok) return;
    expect(result.message).toContain('capability');
  });

  it('пустые имя/описание и нечисловая схема → invalid_request', () => {
    for (const over of [
      { name: '   ' },
      { name: undefined },
      { description: '' },
      { description: undefined },
      { parameters: 'object' },
      { parameters: [] },
    ]) {
      const result = checkPluginCapabilities(
        validCapabilities({ points: { tools: [tool(over)] } }),
        EXPECTED,
      );
      expect(result, JSON.stringify(over)).toMatchObject({ ok: false, reason: 'invalid_request' });
    }
  });

  it('дубли локальных имён тулов → invalid_request', () => {
    const result = checkPluginCapabilities(
      validCapabilities({ points: { tools: [tool(), tool()] } }),
      EXPECTED,
    );
    expect(result).toMatchObject({ ok: false, reason: 'invalid_request' });
    if (result.ok) return;
    expect(result.message).toContain('дважды');
  });

  it('points.tools не массив → invalid_request', () => {
    expect(
      checkPluginCapabilities(validCapabilities({ points: { tools: {} } }), EXPECTED),
    ).toMatchObject({ ok: false, reason: 'invalid_request' });
  });
});
