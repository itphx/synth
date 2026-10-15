/**
 * Тесты DecisionContentClassifier (ADR-084 × ADR-034) — decision-классификатор
 * категории запроса. Пул/провайдер замоканы: проверяем уверенный выбор,
 * fail-safe (выключено/нет провайдера/низкая уверенность/ошибка/невалидная
 * метка) и построение вопроса по языку.
 */
import { describe, it, expect, vi } from 'vitest';
import { DecisionContentClassifier, DECISION_CATEGORY_QUESTION_ID } from './decision-content-classifier.js';
import type {
  DecisionConfigLike,
  DecisionProviderLike,
  DecisionProviderResolver,
} from './micro/models/decision-model.js';
import type { ClassifyRequest } from './content-classifier.js';
import type { DecisionAnswer, DecisionQuestion, DecisionResponse } from '@itphx/synth-shared';

const BASE_CONFIG: DecisionConfigLike = {
  enabled: true,
  provider: 'routerai-decision',
  model: 'clef-flash',
  confidenceThreshold: 0.6,
};

function choiceResponse(label: string, confidence: number): DecisionResponse {
  const answer: DecisionAnswer = {
    type: 'choice',
    choice: label,
    confidence,
    probabilities: { [label]: confidence },
  };
  return { answers: { [DECISION_CATEGORY_QUESTION_ID]: answer } };
}

function makeRequest(overrides: Partial<ClassifyRequest> = {}): ClassifyRequest {
  return { userMessage: 'что-то непонятное', language: 'ru', ...overrides };
}

interface Fixture {
  classifier: DecisionContentClassifier;
  getDecisionProvider: ReturnType<typeof vi.fn>;
  decide: ReturnType<typeof vi.fn>;
}

function makeFixture(
  impl: (state: unknown, questions: Record<string, DecisionQuestion>) => Promise<DecisionResponse>,
  config: DecisionConfigLike | undefined = BASE_CONFIG,
): Fixture {
  const decide = vi.fn(impl);
  const provider: DecisionProviderLike = { decide };
  const getDecisionProvider = vi.fn(() => provider);
  const resolver: DecisionProviderResolver = { getDecisionProvider };
  const classifier = new DecisionContentClassifier(resolver, () => config);
  return { classifier, getDecisionProvider, decide };
}

describe('DecisionContentClassifier', () => {
  it('уверенный выбор → ClassifyResult с сигналом decision:<category>', async () => {
    const { classifier, decide } = makeFixture(async () => choiceResponse('coding', 0.9));

    const result = await classifier.classify(makeRequest({ userMessage: 'напиши функцию' }));

    expect(result).toEqual({ category: 'coding', confidence: 0.9, signals: ['decision:coding'] });
    expect(decide).toHaveBeenCalledTimes(1);
    // state = userMessage
    expect(decide.mock.calls[0]![0]).toBe('напиши функцию');
  });

  it('строит choice-вопрос {coding|research|chat} и учитывает язык (ru/en)', async () => {
    const { classifier, decide } = makeFixture(async () => choiceResponse('chat', 0.8));

    await classifier.classify(makeRequest({ language: 'en' }));
    const enQuestion = decide.mock.calls[0]![1][DECISION_CATEGORY_QUESTION_ID]!;
    expect(enQuestion.type).toBe('choice');
    if (enQuestion.type === 'choice') {
      expect(Object.keys(enQuestion.criteria).sort()).toEqual(['chat', 'coding', 'research']);
      expect((enQuestion.criteria.coding ?? '').toLowerCase()).toContain('code');
    }

    await classifier.classify(makeRequest({ language: 'ru' }));
    const ruQuestion = decide.mock.calls[1]![1][DECISION_CATEGORY_QUESTION_ID]!;
    if (ruQuestion.type === 'choice') {
      expect((ruQuestion.criteria.coding ?? '').toLowerCase()).toContain('код');
    }
  });

  it('decision выключен → null, провайдер не дёргается', async () => {
    const { classifier, decide } = makeFixture(async () => choiceResponse('coding', 0.9), {
      ...BASE_CONFIG,
      enabled: false,
    });
    expect(await classifier.classify(makeRequest())).toBeNull();
    expect(decide).not.toHaveBeenCalled();
  });

  it('нет provider/model → null', async () => {
    const noProvider = makeFixture(async () => choiceResponse('coding', 0.9), { ...BASE_CONFIG, provider: '' });
    expect(await noProvider.classifier.classify(makeRequest())).toBeNull();
    expect(noProvider.decide).not.toHaveBeenCalled();

    const noModel = makeFixture(async () => choiceResponse('coding', 0.9), { ...BASE_CONFIG, model: '' });
    expect(await noModel.classifier.classify(makeRequest())).toBeNull();
    expect(noModel.decide).not.toHaveBeenCalled();
  });

  it('конфиг не задан → null', async () => {
    const decide = vi.fn(async () => choiceResponse('coding', 0.9));
    const resolver: DecisionProviderResolver = { getDecisionProvider: vi.fn(() => ({ decide })) };
    const classifier = new DecisionContentClassifier(resolver, () => undefined);
    expect(await classifier.classify(makeRequest())).toBeNull();
    expect(decide).not.toHaveBeenCalled();
  });

  it('резолвер не нашёл провайдера → null', async () => {
    const getDecisionProvider = vi.fn(() => null);
    const resolver: DecisionProviderResolver = { getDecisionProvider };
    const classifier = new DecisionContentClassifier(resolver, () => BASE_CONFIG);
    expect(await classifier.classify(makeRequest())).toBeNull();
  });

  it('низкая уверенность (< порога) → null', async () => {
    const { classifier } = makeFixture(async () => choiceResponse('research', 0.4));
    expect(await classifier.classify(makeRequest())).toBeNull();
  });

  it('невалидная метка → null', async () => {
    const { classifier } = makeFixture(async () => choiceResponse('unknown-label', 0.99));
    expect(await classifier.classify(makeRequest())).toBeNull();
  });

  it('не-choice ответ → null', async () => {
    const { classifier } = makeFixture(async () => ({
      answers: { [DECISION_CATEGORY_QUESTION_ID]: { type: 'noul', noul: 0.9 } },
    }));
    expect(await classifier.classify(makeRequest())).toBeNull();
  });

  it('ошибка провайдера → null (fail-safe, без проброса)', async () => {
    const { classifier } = makeFixture(async () => {
      throw new Error('boom');
    });
    await expect(classifier.classify(makeRequest())).resolves.toBeNull();
  });

  it('primary low → эскалация принята: decision_escalated в signals', async () => {
    const primaryDecide = vi.fn(async () => choiceResponse('chat', 0.3));
    const escDecide = vi.fn(async () => choiceResponse('coding', 0.9));
    const getDecisionProvider = vi.fn((providerName: string) =>
      providerName === 'esc-p' ? { decide: escDecide } : { decide: primaryDecide });
    const classifier = new DecisionContentClassifier(
      { getDecisionProvider },
      () => ({ ...BASE_CONFIG, escalationProvider: 'esc-p', escalationModel: 'esc-m' }),
    );

    const result = await classifier.classify(makeRequest({ userMessage: 'напиши функцию' }));

    expect(result).toEqual({
      category: 'coding',
      confidence: 0.9,
      signals: ['decision:coding', 'decision_escalated'],
    });
    expect(primaryDecide).toHaveBeenCalledOnce();
    expect(escDecide).toHaveBeenCalledOnce();
  });

  it('images/videos из запроса прокидываются в провайдер', async () => {
    const decide = vi.fn(async () => choiceResponse('coding', 0.9));
    const classifier = new DecisionContentClassifier(
      { getDecisionProvider: vi.fn(() => ({ decide })) },
      () => BASE_CONFIG,
    );

    await classifier.classify(makeRequest({ images: ['i1'], videos: ['v1'] }));

    expect((decide.mock.calls[0] as unknown[])[2]).toEqual({
      model: 'clef-flash',
      images: ['i1'],
      videos: ['v1'],
    });
  });
});
