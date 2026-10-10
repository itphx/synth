/**
 * Тесты единого decision-каскада (AD-084): успех primary, low → escalation,
 * оба промаха, отсутствие escalation-конфига, no_provider. Проверяем также
 * суммарную latency, статусы попыток и запись метрик.
 */
import { describe, it, expect, vi } from 'vitest';
import { decideChoiceCascade } from './decision-cascade.js';
import { DecisionMetrics } from './decision-metrics.js';
import type {
  DecisionConfigLike,
  DecisionProviderLike,
  DecisionProviderResolver,
} from './micro/models/decision-model.js';
import type { DecisionQuestion, DecisionResponse } from '@itphx/synth-shared';

const QUESTIONS: Record<string, DecisionQuestion> = {
  label: { type: 'choice', instructions: 'выбери', criteria: { a: null, b: null } },
};
const QUESTION_ID = 'label';

function baseConfig(overrides: Partial<DecisionConfigLike> = {}): DecisionConfigLike {
  return {
    enabled: true,
    provider: 'primary-p',
    model: 'primary-m',
    confidenceThreshold: 0.6,
    ...overrides,
  };
}

function choiceResponse(label: string, confidence: number): DecisionResponse {
  return {
    answers: {
      [QUESTION_ID]: {
        type: 'choice',
        choice: label,
        confidence,
        probabilities: { [label]: confidence },
      },
    },
  };
}

/** Резолвер по карте `<provider>/<model>` → провайдер (нет записи → null). */
function makeResolver(
  providers: Record<string, DecisionProviderLike>,
): DecisionProviderResolver {
  return {
    getDecisionProvider: (providerName, modelName) =>
      providers[`${providerName}/${modelName}`] ?? null,
  };
}

function makeCascade(opts: {
  providers: Record<string, DecisionProviderLike>;
  config: DecisionConfigLike;
  validate?: (label: string) => boolean;
  metrics?: DecisionMetrics;
}) {
  return decideChoiceCascade({
    resolver: makeResolver(opts.providers),
    config: opts.config,
    state: 'текст запроса',
    questions: QUESTIONS,
    questionId: QUESTION_ID,
    validate: opts.validate ?? ((label) => label === 'a'),
    ...(opts.metrics ? { metrics: opts.metrics } : {}),
  });
}

describe('decideChoiceCascade (AD-084)', () => {
  it('успех primary: accepted, tier=primary, статус ok', async () => {
    const decide = vi.fn(async () => choiceResponse('a', 0.9));
    const outcome = await makeCascade({
      providers: { 'primary-p/primary-m': { decide } },
      config: baseConfig(),
    });

    expect(outcome.accepted).toBe(true);
    expect(outcome.label).toBe('a');
    expect(outcome.confidence).toBe(0.9);
    expect(outcome.tier).toBe('primary');
    expect(outcome.providerName).toBe('primary-p');
    expect(outcome.modelName).toBe('primary-m');
    expect(outcome.lastStatus).toBe('ok');
    expect(outcome.attempts).toHaveLength(1);
    expect(outcome.attempts[0]).toMatchObject({ tier: 'primary', status: 'ok' });
    expect(decide).toHaveBeenCalledOnce();
    // Медиа-опции не задавались — decide без images/videos.
    expect((decide.mock.calls[0] as unknown[])[2]).toEqual({ model: 'primary-m' });
  });

  it('primary low → escalation ok: accepted на тире escalation', async () => {
    const primary = vi.fn(async () => choiceResponse('a', 0.45));
    const escalation = vi.fn(async () => choiceResponse('a', 0.95));
    const outcome = await makeCascade({
      providers: {
        'primary-p/primary-m': { decide: primary },
        'esc-p/esc-m': { decide: escalation },
      },
      config: baseConfig({ escalationProvider: 'esc-p', escalationModel: 'esc-m' }),
    });

    expect(outcome.accepted).toBe(true);
    expect(outcome.tier).toBe('escalation');
    expect(outcome.providerName).toBe('esc-p');
    expect(outcome.modelName).toBe('esc-m');
    expect(outcome.attempts.map((a) => a.status)).toEqual(['low_confidence', 'ok']);
    expect(primary).toHaveBeenCalledOnce();
    expect(escalation).toHaveBeenCalledOnce();
    // Суммарная latency по тирам.
    expect(outcome.latencyMs).toBe(
      outcome.attempts.reduce((sum, a) => sum + a.latencyMs, 0),
    );
  });

  it('оба тира промахнулись → accepted=false, lastStatus последнего', async () => {
    const outcome = await makeCascade({
      providers: {
        'primary-p/primary-m': { decide: vi.fn(async () => choiceResponse('a', 0.2)) },
        'esc-p/esc-m': { decide: vi.fn(async () => choiceResponse('b', 0.99)) },
      },
      config: baseConfig({ escalationProvider: 'esc-p', escalationModel: 'esc-m' }),
    });

    expect(outcome.accepted).toBe(false);
    expect(outcome.attempts.map((a) => a.status)).toEqual(['low_confidence', 'invalid']);
    expect(outcome.lastStatus).toBe('invalid');
    expect(outcome.lastLabel).toBe('b');
  });

  it('нет escalation-конфига → только primary (одна попытка)', async () => {
    const escalate = vi.fn(async () => choiceResponse('a', 0.99));
    const outcome = await makeCascade({
      providers: {
        'primary-p/primary-m': { decide: vi.fn(async () => choiceResponse('a', 0.2)) },
        'esc-p/esc-m': { decide: escalate },
      },
      config: baseConfig(),
    });

    expect(outcome.accepted).toBe(false);
    expect(outcome.attempts).toHaveLength(1);
    expect(outcome.attempts[0]!.tier).toBe('primary');
    expect(escalate).not.toHaveBeenCalled();
  });

  it('escalation совпадает с primary → тир не добавляется', async () => {
    const decide = vi.fn(async () => choiceResponse('a', 0.9));
    const outcome = await makeCascade({
      providers: { 'primary-p/primary-m': { decide } },
      config: baseConfig({ escalationProvider: 'primary-p', escalationModel: 'primary-m' }),
    });
    expect(outcome.attempts).toHaveLength(1);
    expect(decide).toHaveBeenCalledOnce();
  });

  it('no_provider: резолвер вернул null → статус no_provider, fail-safe', async () => {
    const outcome = await makeCascade({
      providers: {},
      config: baseConfig(),
    });
    expect(outcome.accepted).toBe(false);
    expect(outcome.lastStatus).toBe('no_provider');
    expect(outcome.attempts[0]).toMatchObject({ status: 'no_provider', latencyMs: 0 });
  });

  it('ошибка провайдера → attempt error и переход на escalation', async () => {
    const primary = vi.fn(async () => {
      throw new Error('network down');
    });
    const escalation = vi.fn(async () => choiceResponse('a', 0.9));
    const outcome = await makeCascade({
      providers: {
        'primary-p/primary-m': { decide: primary },
        'esc-p/esc-m': { decide: escalation },
      },
      config: baseConfig({ escalationProvider: 'esc-p', escalationModel: 'esc-m' }),
    });

    expect(outcome.accepted).toBe(true);
    expect(outcome.tier).toBe('escalation');
    expect(outcome.attempts[0]).toMatchObject({ status: 'error' });
    expect(outcome.attempts[0]!.error).toContain('network down');
  });

  it('метрики пишутся в переданный инстанс', async () => {
    const metrics = new DecisionMetrics();
    await makeCascade({
      providers: { 'primary-p/primary-m': { decide: vi.fn(async () => choiceResponse('a', 0.9)) } },
      config: baseConfig(),
      metrics,
    });
    await makeCascade({
      providers: {},
      config: baseConfig(),
      metrics,
    });

    const snap = metrics.snapshot();
    expect(snap.calls).toBe(2);
    expect(snap.handled).toBe(1);
    expect(snap.fallback).toBe(1);
    expect(snap.attempts).toEqual({ primary: 2, escalation: 0 });
    expect(snap.rejected.ok).toBe(1);
    expect(snap.rejected.no_provider).toBe(1);
  });

  it('images/videos прокидываются в decide только при наличии', async () => {
    const decide = vi.fn(async () => choiceResponse('a', 0.9));
    await decideChoiceCascade({
      resolver: makeResolver({ 'primary-p/primary-m': { decide } }),
      config: baseConfig(),
      state: 's',
      questions: QUESTIONS,
      questionId: QUESTION_ID,
      validate: () => true,
      images: ['img1'],
      videos: ['vid1'],
    });
    expect((decide.mock.calls[0] as unknown[])[2]).toEqual({
      model: 'primary-m',
      images: ['img1'],
      videos: ['vid1'],
    });
  });
});
