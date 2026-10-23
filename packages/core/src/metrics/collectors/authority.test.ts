/**
 * PROP-108 Ф1: тесты коллектора метрик Authority-слоя (ADR-094).
 *
 * Проверяется контракт:
 * - метрика `synth_authority_decisions_total` — счётчик с лейблами **только**
 *   `action`/`effect`/`source`;
 * - значения лейблов приводятся к конечным наборам: неизвестное → `other`
 *   (кардинальность серий ограничена, доменные действия поимённо не пишутся);
 * - лейблов-идентификаторов нет: ни `user_id`, ни `session_id`, ни `turn_id`,
 *   ни имён принципалов, ни путей.
 */
import { describe, expect, it } from 'vitest';

import type { AuthorityDecisionEntry } from '@itphx/synth-shared';

import { MetricsRegistry } from '../registry.js';
import {
  createAuthorityMetrics,
  normalizeAuthorityAction,
  normalizeAuthorityEffect,
  normalizeAuthoritySource,
} from './authority.js';

/** Запись журнала решений — минимальная валидная. */
function entry(overrides: Partial<AuthorityDecisionEntry> = {}): AuthorityDecisionEntry {
  return {
    id: 'ad_1',
    ts: '2026-10-23T10:00:00.000Z',
    principal: 'user:alice',
    action: 'read',
    target: 'path:src/a.ts',
    effect: 'allow',
    source: 'user',
    reason: null,
    mode: 'shadow',
    ...overrides,
  };
}

describe('Authority-метрики: нормализация лейблов', () => {
  it('известные значения сохраняются', () => {
    expect(normalizeAuthorityAction('read')).toBe('read');
    expect(normalizeAuthorityAction('delegate')).toBe('delegate');
    expect(normalizeAuthorityEffect('allow')).toBe('allow');
    expect(normalizeAuthorityEffect('ask')).toBe('ask');
    expect(normalizeAuthorityEffect('deny')).toBe('deny');
    expect(normalizeAuthoritySource('user')).toBe('user');
    expect(normalizeAuthoritySource('instance')).toBe('instance');
  });

  it('неизвестное значение → other', () => {
    // Доменное действие из контента пакета (`invoice`, `sign_medical`) —
    // намеренно не попадает в метрику поимённо (кардинальность иначе не
    // ограничена). Базовые глаголы ядра (`sign`, `approve`, `delegate`) —
    // часть конечного набора и остаются как есть.
    expect(normalizeAuthorityAction('invoice')).toBe('other');
    expect(normalizeAuthorityAction('sign_medical')).toBe('other');
    expect(normalizeAuthorityAction('unknown')).toBe('other');
    expect(normalizeAuthorityEffect('maybe')).toBe('other');
    expect(normalizeAuthoritySource('scheduler')).toBe('other');
  });

  it('пустое/отсутствующее значение → other', () => {
    expect(normalizeAuthorityAction(undefined)).toBe('other');
    expect(normalizeAuthorityAction('')).toBe('other');
    expect(normalizeAuthorityEffect(undefined)).toBe('other');
    expect(normalizeAuthoritySource(undefined)).toBe('other');
  });
});

describe('Authority-метрики: счётчик решений', () => {
  it('метрика зарегистрирована с лейблами action/effect/source', () => {
    const registry = new MetricsRegistry();
    createAuthorityMetrics(registry);

    const snapshot = registry.snapshot().find((m) => m.name === 'synth_authority_decisions_total');
    expect(snapshot).toBeDefined();
    expect(snapshot!.type).toBe('counter');
    expect(snapshot!.labelNames).toEqual(['action', 'effect', 'source']);
    expect(snapshot!.series).toHaveLength(0);
  });

  it('решение инкрементирует счётчик с нормализованными лейблами', () => {
    const registry = new MetricsRegistry();
    const hooks = createAuthorityMetrics(registry);

    hooks.onDecision(entry({ action: 'write', effect: 'deny', source: 'session' }));

    const snapshot = registry.snapshot().find((m) => m.name === 'synth_authority_decisions_total');
    expect(snapshot!.series).toHaveLength(1);
    expect(snapshot!.series[0]!.labels).toEqual({
      action: 'write',
      effect: 'deny',
      source: 'session',
    });
    expect(snapshot!.series[0]!.value).toBe(1);
  });

  it('доменное действие и неизвестный источник сводятся к other', () => {
    const registry = new MetricsRegistry();
    const hooks = createAuthorityMetrics(registry);

    hooks.onDecision(entry({ action: 'invoice', effect: 'ask', source: 'scheduler' }));

    const snapshot = registry.snapshot().find((m) => m.name === 'synth_authority_decisions_total');
    expect(snapshot!.series[0]!.labels).toEqual({
      action: 'other',
      effect: 'ask',
      source: 'other',
    });
  });

  it('разные решения дают разные серии (счётчик накапливает)', () => {
    const registry = new MetricsRegistry();
    const hooks = createAuthorityMetrics(registry);

    hooks.onDecision(entry({ action: 'read', effect: 'allow', source: 'user' }));
    hooks.onDecision(entry({ action: 'read', effect: 'allow', source: 'user' }));
    hooks.onDecision(entry({ action: 'write', effect: 'allow', source: 'user' }));

    const snapshot = registry.snapshot().find((m) => m.name === 'synth_authority_decisions_total');
    expect(snapshot!.series).toHaveLength(2);
    const read = snapshot!.series.find((s) => s.labels.action === 'read');
    const write = snapshot!.series.find((s) => s.labels.action === 'write');
    expect(read!.value).toBe(2);
    expect(write!.value).toBe(1);
  });

  it('в экспозиции нет идентификаторов (user_id/session_id/путей/имён принципалов)', () => {
    const registry = new MetricsRegistry();
    const hooks = createAuthorityMetrics(registry);

    hooks.onDecision(
      entry({
        principal: 'user:alice',
        action: 'read',
        target: 'path:src/secret-file.ts',
        effect: 'allow',
        source: 'user',
      }),
    );

    const rendered = registry.render().text;
    expect(rendered).toContain('synth_authority_decisions_total');
    expect(rendered).not.toContain('alice');
    expect(rendered).not.toContain('secret-file.ts');
    expect(rendered).not.toContain('session_id');
    expect(rendered).not.toContain('user_id');
    expect(rendered).not.toContain('turn_id');
  });

  it('ошибка метрик не пробрасывается (best-effort)', () => {
    const registry = new MetricsRegistry();
    const hooks = createAuthorityMetrics(registry);

    // Запись с невалидным набором лейблов не должна бросать: коллектор
    // приводит значения к конечным наборам сам.
    expect(() =>
      hooks.onDecision(
        entry({ action: '', effect: 'allow', source: '' }),
      ),
    ).not.toThrow();
  });
});
