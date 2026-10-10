/**
 * Тесты DecisionModel (AD-084) — decision-уровень микро-каскада AD-035.
 * Провайдер/пул замоканы: проверяем уверенный выбор, низкую уверенность,
 * отключённый конфиг и fail-safe при исключении.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  DecisionModel,
  type DecisionConfigLike,
  type DecisionProviderLike,
  type DecisionProviderResolver,
} from './decision-model.js';
import { MicroPipeline } from '../index.js';
import type { MicroModel } from './base.js';
import type { TaskClassifier } from '../task-classifier.js';
import type { MicroInput, MicroResult, MicroTaskClass } from '../types.js';
import type { DecisionAnswer, DecisionQuestion, DecisionResponse } from '@itphx/synth-shared';

const BASE_CONFIG: DecisionConfigLike = {
  enabled: true,
  provider: 'routerai-decision',
  model: 'clef-flash',
  confidenceThreshold: 0.6,
};

function makeInput(msg: string, decisionFirst?: boolean): MicroInput {
  return {
    userMessage: msg,
    language: 'ru',
    sessionSettings: {
      temperature: 0.7, maxTokens: 4096, debugEnabled: true, streamEnabled: true,
      contextOptimization: 'none', slidingWindowMode: 'messages', slidingWindowMessageLimit: 10,
      slidingWindowTokenThreshold: 80, summarizationEnabled: false, summarizationTriggerMode: 'messages',
      summarizeAfterN: 10, summarizeTokenThreshold: 50, summarizationHeadMessages: 2,
      summarizationTailMessages: 3, showInterview: true, websocketEnabled: true,
      routingEnabled: true, routingStrategy: 'auto',
      routingContent: { coding: { provider: '', model: '' }, chat: { provider: '', model: '' }, research: { provider: '', model: '' } },
      routingEscalation: { enabled: true, fallbackProvider: '', fallbackModel: '', checks: ['min_length', 'constraint'], minLength: 10 },
      routingCost: { enabled: false, cheapProvider: '', cheapModel: '', maxCheapTokens: 500 },
      subagentRouting: { enabled: true },
      microFirst: true, microConfidenceThreshold: 0.8,
      embeddingEnabled: false,
      ...(decisionFirst === undefined ? {} : { decisionFirst }),
    },
  };
}

function choiceResponse(label: string, confidence: number): DecisionResponse {
  const answer: DecisionAnswer = {
    type: 'choice',
    choice: label,
    confidence,
    probabilities: { [label]: confidence },
  };
  return { answers: { label: answer } };
}

interface Fixture {
  model: DecisionModel;
  getDecisionProvider: ReturnType<typeof vi.fn>;
  decide: ReturnType<typeof vi.fn>;
}

/** Собирает модель с mock-резолвером и mock-провайдером decision. */
function makeFixture(
  impl: (state: unknown, questions: Record<string, DecisionQuestion>) => Promise<DecisionResponse>,
  config: DecisionConfigLike = BASE_CONFIG,
): Fixture {
  const decide = vi.fn(impl);
  const provider: DecisionProviderLike = { decide };
  const getDecisionProvider = vi.fn(() => provider);
  const resolver: DecisionProviderResolver = { getDecisionProvider };
  const model = new DecisionModel(resolver, () => config);
  return { model, getDecisionProvider, decide };
}

/** Модель без провайдера (резолвер всегда null). */
function makeNullFixture(config: DecisionConfigLike = BASE_CONFIG): Fixture {
  const getDecisionProvider = vi.fn(() => null);
  const resolver: DecisionProviderResolver = { getDecisionProvider };
  const model = new DecisionModel(resolver, () => config);
  return { model, getDecisionProvider, decide: vi.fn() };
}

describe('DecisionModel', () => {
  it('canHandle: classify и enum_decision', () => {
    const { model } = makeNullFixture();
    expect(model.canHandle('classify')).toBe(true);
    expect(model.canHandle('enum_decision')).toBe(true);
    expect(model.canHandle('small_talk')).toBe(false);
    expect(model.canHandle('llm_task')).toBe(false);
  });

  it('уверенный choice → OK с меткой и уверенностью', async () => {
    const { model, decide } = makeFixture(async () => choiceResponse('command', 0.9));

    const result = await model.handle(makeInput('сделай X'), 'classify');

    expect(result.status).toBe('OK');
    expect(result.label).toBe('command');
    expect(result.confidence).toBe(0.9);
    expect(result.taskClass).toBe('classify');
    expect(result.signals).toContain('decision:command');
    expect(decide).toHaveBeenCalledOnce();
  });

  it('enum_decision: валидная метка → OK', async () => {
    const { model } = makeFixture(async () => choiceResponse('yes', 0.95));

    const result = await model.handle(makeInput('да, продолжай'), 'enum_decision');
    expect(result.status).toBe('OK');
    expect(result.label).toBe('yes');
    expect(result.signals).toContain('decision:yes');
  });

  it('низкая уверенность → UNSURE с сигналом decision_low_confidence', async () => {
    const { model } = makeFixture(async () => choiceResponse('question', 0.4));

    const result = await model.handle(makeInput('что-то'), 'classify');
    expect(result.status).toBe('UNSURE');
    expect(result.label).toBeUndefined();
    expect(result.signals).toContain('decision_low_confidence');
  });

  it('невалидная метка → UNSURE (decision_invalid_label)', async () => {
    const { model } = makeFixture(async () => choiceResponse('banana', 0.99));

    const result = await model.handle(makeInput('что-то'), 'classify');
    expect(result.status).toBe('UNSURE');
    expect(result.signals.some((s) => s.startsWith('decision_invalid_label:'))).toBe(true);
  });

  it('enabled=false → UNSURE (decision_disabled), провайдер не вызывается', async () => {
    const { model, decide } = makeFixture(
      async () => choiceResponse('command', 1),
      { ...BASE_CONFIG, enabled: false },
    );

    const result = await model.handle(makeInput('сделай'), 'classify');
    expect(result.status).toBe('UNSURE');
    expect(result.signals).toContain('decision_disabled');
    expect(decide).not.toHaveBeenCalled();
  });

  it('session decisionFirst=false → UNSURE (decision_disabled)', async () => {
    const { model } = makeFixture(async () => choiceResponse('command', 1));

    const result = await model.handle(makeInput('сделай', false), 'classify');
    expect(result.status).toBe('UNSURE');
    expect(result.signals).toContain('decision_disabled');
  });

  it('нет provider/model → UNSURE (decision_no_provider)', async () => {
    const { model, getDecisionProvider } = makeNullFixture({ ...BASE_CONFIG, provider: '', model: '' });

    const result = await model.handle(makeInput('сделай'), 'classify');
    expect(result.status).toBe('UNSURE');
    expect(result.signals).toContain('decision_no_provider');
    expect(getDecisionProvider).not.toHaveBeenCalled();
  });

  it('резолвер вернул null → UNSURE (decision_provider_not_found)', async () => {
    const { model } = makeNullFixture();

    const result = await model.handle(makeInput('сделай'), 'classify');
    expect(result.status).toBe('UNSURE');
    expect(result.signals.some((s) => s.startsWith('decision_provider_not_found:'))).toBe(true);
  });

  it('исключение провайдера → UNSURE (fail-safe, decision_error)', async () => {
    const { model } = makeFixture(async () => {
      throw new Error('network down');
    });

    const result = await model.handle(makeInput('сделай'), 'classify');
    expect(result.status).toBe('UNSURE');
    expect(result.signals.some((s) => s.startsWith('decision_error:'))).toBe(true);
  });

  it('нет ответа на вопрос → UNSURE (decision_no_answer)', async () => {
    const { model } = makeFixture(async () => ({ answers: {} }));

    const result = await model.handle(makeInput('сделай'), 'classify');
    expect(result.status).toBe('UNSURE');
    expect(result.signals).toContain('decision_no_answer');
  });

  it('маппинг classify/enum в choice-вопросы с критериями', async () => {
    const captured: Array<Record<string, DecisionQuestion>> = [];
    const { model } = makeFixture(async (_state, questions) => {
      captured.push(questions);
      return choiceResponse('command', 0.9);
    });

    await model.handle(makeInput('сделай'), 'classify');
    const classifyQ = captured[0]?.label;
    expect(classifyQ?.type).toBe('choice');
    if (classifyQ?.type === 'choice') {
      expect(Object.keys(classifyQ.criteria)).toEqual(
        expect.arrayContaining(['question', 'command', 'review', 'explain', 'debug', 'fix', 'test']),
      );
    }

    await model.handle(makeInput('да'), 'enum_decision');
    const enumQ = captured[1]?.label;
    expect(enumQ?.type).toBe('choice');
    if (enumQ?.type === 'choice') {
      expect(Object.keys(enumQ.criteria)).toEqual(
        expect.arrayContaining(['yes', 'no', 'approve', 'reject', 'mode_plan', 'mode_act']),
      );
    }
  });

  it('primary low → эскалация принята: OK с decision_escalated', async () => {
    const primaryDecide = vi.fn(async () => choiceResponse('question', 0.4));
    const escDecide = vi.fn(async () => choiceResponse('command', 0.9));
    const getDecisionProvider = vi.fn((providerName: string) =>
      providerName === 'esc-p' ? { decide: escDecide } : { decide: primaryDecide });
    const model = new DecisionModel(
      { getDecisionProvider },
      () => ({ ...BASE_CONFIG, escalationProvider: 'esc-p', escalationModel: 'esc-m' }),
    );

    const result = await model.handle(makeInput('сделай'), 'classify');

    expect(result.status).toBe('OK');
    expect(result.label).toBe('command');
    expect(result.signals).toContain('decision:command');
    expect(result.signals).toContain('decision_escalated');
    expect(primaryDecide).toHaveBeenCalledOnce();
    expect(escDecide).toHaveBeenCalledOnce();
    expect((escDecide.mock.calls[0] as unknown[])[2]).toEqual({ model: 'esc-m' });
  });

  it('images/videos из MicroInput прокидываются в провайдер', async () => {
    const decide = vi.fn(async () => choiceResponse('command', 0.9));
    const model = new DecisionModel(
      { getDecisionProvider: vi.fn(() => ({ decide })) },
      () => BASE_CONFIG,
    );
    const input: MicroInput = { ...makeInput('сделай'), images: ['i1'], videos: ['v1'] };

    const result = await model.handle(input, 'classify');

    expect(result.status).toBe('OK');
    expect((decide.mock.calls[0] as unknown[])[2]).toEqual({
      model: 'clef-flash',
      images: ['i1'],
      videos: ['v1'],
    });
  });
});

describe('MicroPipeline: порядок decision перед micro_llm', () => {
  function stub(kind: 'decision' | 'micro_llm', calls: string[]): MicroModel {
    return {
      kind,
      name: kind === 'decision' ? 'decision-classifier' : 'micro-llm-classifier',
      canHandle: (t: MicroTaskClass) => t === 'classify',
      async handle(_input: MicroInput, taskClass: MicroTaskClass): Promise<MicroResult> {
        calls.push(kind);
        return {
          status: 'OK',
          taskClass,
          label: kind === 'decision' ? 'command' : 'question',
          confidence: 0.9,
          latencyMs: 1,
          signals: [`${kind}:x`],
        };
      },
    };
  }

  it('decision отвечает первым, micro_llm не вызывается', async () => {
    const calls: string[] = [];
    const fakeClassifier = {
      classify: () => ({ taskClass: 'classify' as MicroTaskClass, signals: [] }),
    } as unknown as TaskClassifier;
    const pipeline = new MicroPipeline(fakeClassifier, [
      stub('decision', calls),
      stub('micro_llm', calls),
    ]);

    const result = await pipeline.handle(makeInput('сделай X'));

    expect(calls).toEqual(['decision']);
    expect(result.handled).toBe(true);
    expect(result.microResult?.label).toBe('command');
    expect(result.microResult?.taskClass).toBe('classify');
  });
});
