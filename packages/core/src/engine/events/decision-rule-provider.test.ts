import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  DecisionQuestion,
  DecisionResponse,
  RouteDecision,
  SynthEvent,
} from '@itphx/synth-shared';
import { EventBindingStore } from '../../storage/event-binding-store.js';
import { EventJournalStore } from '../../storage/event-journal-store.js';
import { EventRouter } from './event-router.js';
import { DecisionRuleProvider, DECISION_ROUTING_QUESTION_ID } from './decision-rule-provider.js';
import type { DecisionAgentCandidate } from './decision-rule-provider.js';
import type {
  DecisionConfigLike,
  DecisionProviderLike,
} from '../router/micro/models/decision-model.js';
import type { RouteRuleInput, RouteRuleProvider } from './types.js';

const event = (overrides: Partial<SynthEvent> = {}): SynthEvent => ({
  id: 'evt_1',
  source: 'telegram',
  type: 'message',
  payload: { text: 'Prod is down, deploy failed!' },
  identity: {},
  dedupKey: 'd1',
  ts: '2026-01-01T00:00:00.000Z',
  ...overrides,
});

const AGENTS: DecisionAgentCandidate[] = [
  { id: 'triage', displayName: 'Triage', description: 'Разбор инцидентов' },
  { id: 'assistant', displayName: 'Assistant', description: 'Общие задачи' },
];

const BASE_CONFIG: DecisionConfigLike = {
  enabled: true,
  provider: 'clef',
  model: 'clef-flash',
  confidenceThreshold: 0.6,
};

/** Строит выбор decision-модели (`choice`) с заданными шаблоном и уверенностью. */
function choiceResponse(choice: string, confidence: number): DecisionResponse {
  return {
    answers: {
      [DECISION_ROUTING_QUESTION_ID]: {
        type: 'choice',
        choice,
        confidence,
        probabilities: { [choice]: confidence },
      },
    },
  };
}

interface Fixture {
  provider: DecisionRuleProvider;
  decide: ReturnType<typeof vi.fn>;
  getDecisionProvider: ReturnType<typeof vi.fn>;
}

function makeFixture(options: {
  decisionRouting?: boolean;
  config?: DecisionConfigLike | null;
  agents?: DecisionAgentCandidate[];
  decideImpl?: (
    state: unknown,
    questions: Record<string, DecisionQuestion>,
  ) => Promise<DecisionResponse>;
  providerMissing?: boolean;
} = {}): Fixture {
  const {
    decisionRouting = true,
    config = BASE_CONFIG,
    agents = AGENTS,
    decideImpl = async () => choiceResponse('triage', 0.9),
    providerMissing = false,
  } = options;

  const decide = vi.fn(decideImpl);
  const decisionProvider: DecisionProviderLike = { decide };
  const getDecisionProvider = vi.fn(() => (providerMissing ? null : decisionProvider));

  const provider = new DecisionRuleProvider({
    resolver: { getDecisionProvider },
    getEventsConfig: () => ({ decisionRouting, defaultEphemeralTtl: '24h' }),
    getDecisionConfig: () => config ?? undefined,
    getAgentCandidates: () => agents,
  });

  return { provider, decide, getDecisionProvider };
}

describe('DecisionRuleProvider (ADR-084 × ADR-089)', () => {
  it('decisionRouting=false → null, decision-провайдер не вызывается', async () => {
    const { provider, decide, getDecisionProvider } = makeFixture({ decisionRouting: false });
    expect(await provider.resolve({ event: event(), bindings: [] })).toBeNull();
    expect(getDecisionProvider).not.toHaveBeenCalled();
    expect(decide).not.toHaveBeenCalled();
  });

  it('decisionRouting=true, но decision-слой выключен → null', async () => {
    const { provider, decide } = makeFixture({ config: { ...BASE_CONFIG, enabled: false } });
    expect(await provider.resolve({ event: event(), bindings: [] })).toBeNull();
    expect(decide).not.toHaveBeenCalled();
  });

  it('нет provider/model → null', async () => {
    const { provider, decide } = makeFixture({ config: { ...BASE_CONFIG, provider: '', model: '' } });
    expect(await provider.resolve({ event: event(), bindings: [] })).toBeNull();
    expect(decide).not.toHaveBeenCalled();
  });

  it('нет enabled-агентов (< 2) → null', async () => {
    const { provider, decide } = makeFixture({ agents: [] });
    expect(await provider.resolve({ event: event(), bindings: [] })).toBeNull();
    expect(decide).not.toHaveBeenCalled();

    const single = makeFixture({ agents: [AGENTS[0]!] });
    expect(await single.provider.resolve({ event: event(), bindings: [] })).toBeNull();
    expect(single.decide).not.toHaveBeenCalled();
  });

  it('decision-провайдер не найден → null (fail-safe)', async () => {
    const { provider, decide } = makeFixture({ providerMissing: true });
    expect(await provider.resolve({ event: event(), bindings: [] })).toBeNull();
    expect(decide).not.toHaveBeenCalled();
  });

  it('уверенный choice шаблона → ephemeral с выбранным agentTemplate и метой', async () => {
    const { provider } = makeFixture();
    const decision = await provider.resolve({ event: event(), bindings: [] });
    expect(decision).toMatchObject({
      kind: 'ephemeral',
      agentTemplate: 'triage',
      ttl: '24h',
      confidence: 0.9,
    });
    // Мета решения (ADR-084 × ADR-089): сигналы агента/модели + latency.
    expect(decision?.signals).toEqual(
      expect.arrayContaining(['decision-rules', 'agent:triage', 'model:clef/clef-flash']),
    );
    expect(decision?.signals?.some((s) => /^latency:\d+ms$/.test(s))).toBe(true);
  });

  it('эскалация: primary low → escalation ok, decision_escalated в signals/мете', async () => {
    const primaryDecide = vi.fn(async () => choiceResponse('assistant', 0.3));
    const escDecide = vi.fn(async () => choiceResponse('triage', 0.9));
    const getDecisionProvider = vi.fn((providerName: string) =>
      providerName === 'clef-esc' ? { decide: escDecide } : { decide: primaryDecide });
    const provider = new DecisionRuleProvider({
      resolver: { getDecisionProvider },
      getEventsConfig: () => ({ decisionRouting: true, defaultEphemeralTtl: '24h' }),
      getDecisionConfig: () => ({
        ...BASE_CONFIG,
        escalationProvider: 'clef-esc',
        escalationModel: 'clef',
      }),
      getAgentCandidates: () => AGENTS,
    });

    const decision = await provider.resolve({ event: event(), bindings: [] });

    expect(decision).toMatchObject({
      kind: 'ephemeral',
      agentTemplate: 'triage',
      ttl: '24h',
      confidence: 0.9,
    });
    expect(decision?.signals).toContain('decision_escalated');
    expect(decision?.signals).toContain('model:clef-esc/clef');
    expect(primaryDecide).toHaveBeenCalledOnce();
    expect(escDecide).toHaveBeenCalledOnce();
  });

  it('вопрос — choice по enabled-агентам, state содержит текст события', async () => {
    const calls: Array<{ state: unknown; questions: Record<string, DecisionQuestion> }> = [];
    const { provider } = makeFixture({
      decideImpl: async (state, questions) => {
        calls.push({ state, questions });
        return choiceResponse('assistant', 0.8);
      },
    });

    await provider.resolve({ event: event(), bindings: [] });

    expect(calls).toHaveLength(1);
    const question = calls[0]!.questions[DECISION_ROUTING_QUESTION_ID];
    expect(question?.type).toBe('choice');
    if (question?.type === 'choice') {
      expect(Object.keys(question.criteria).sort()).toEqual(['assistant', 'triage']);
    }
    expect(String(calls[0]!.state)).toContain('deploy failed');
    expect(String(calls[0]!.state)).toContain('source: telegram');
  });

  it('низкая уверенность (< порога) → null', async () => {
    const { provider } = makeFixture({ decideImpl: async () => choiceResponse('triage', 0.4) });
    expect(await provider.resolve({ event: event(), bindings: [] })).toBeNull();
  });

  it('невалидный шаблон (не из списка) → null', async () => {
    const { provider } = makeFixture({ decideImpl: async () => choiceResponse('ghost', 0.99) });
    expect(await provider.resolve({ event: event(), bindings: [] })).toBeNull();
  });

  it('ответ не choice → null', async () => {
    const { provider } = makeFixture({
      decideImpl: async () => ({
        answers: { [DECISION_ROUTING_QUESTION_ID]: { type: 'noul', noul: 0.9 } },
      }),
    });
    expect(await provider.resolve({ event: event(), bindings: [] })).toBeNull();
  });

  it('ошибка decision-провайдера → null (исключение не пробрасывается)', async () => {
    const { provider } = makeFixture({
      decideImpl: async () => {
        throw new Error('boom');
      },
    });
    await expect(provider.resolve({ event: event(), bindings: [] })).resolves.toBeNull();
  });

  it('getDecisionConfig читается на каждый resolve (live runtime-обновление, ADR-084 Ф5)', async () => {
    let config: DecisionConfigLike | null = { ...BASE_CONFIG, enabled: false };
    const decide = vi.fn(async () => choiceResponse('triage', 0.9));
    const provider = new DecisionRuleProvider({
      resolver: { getDecisionProvider: () => ({ decide }) },
      getEventsConfig: () => ({ decisionRouting: true, defaultEphemeralTtl: '24h' }),
      getDecisionConfig: () => config ?? undefined,
      getAgentCandidates: () => AGENTS,
    });

    // Выключенный конфиг → null, decision-провайдер не вызывается.
    expect(await provider.resolve({ event: event(), bindings: [] })).toBeNull();
    expect(decide).not.toHaveBeenCalled();

    // Runtime-обновление (onDecisionChange): геттер отдаёт новое значение.
    config = { ...BASE_CONFIG };
    const decision = await provider.resolve({ event: event(), bindings: [] });
    expect(decision).toMatchObject({
      kind: 'ephemeral',
      agentTemplate: 'triage',
      ttl: '24h',
      confidence: 0.9,
    });
    expect(decision?.signals).toContain('agent:triage');
  });
});

describe('DecisionRuleProvider в EventRouter (ADR-089, порядок и fail-safe)', () => {
  let tmpDir: string;
  let bindingStore: EventBindingStore;
  let journal: EventJournalStore;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-decision-rules-'));
    bindingStore = new EventBindingStore({ dataDir: tmpDir });
    journal = new EventJournalStore({ dataDir: tmpDir });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('промах декларативных правил → срабатывает decision-провайдер', async () => {
    const miss: RouteRuleProvider = { name: 'miss', resolve: () => null };
    const { provider } = makeFixture();
    const router = new EventRouter({
      bindingStore,
      journal,
      config: { defaultMode: 'bound', defaultEphemeralTtl: '24h' },
      ruleProviders: [miss, provider],
    });
    const decision = await router.decide(event({ dedupKey: 'k1' }));
    expect(decision).toMatchObject({
      kind: 'ephemeral',
      agentTemplate: 'triage',
      ttl: '24h',
      confidence: 0.9,
    });
    expect(decision.signals).toContain('agent:triage');
  });

  it('decision-провайдер + record → confidence сохраняется в журнале', async () => {
    const miss: RouteRuleProvider = { name: 'miss', resolve: () => null };
    const { provider } = makeFixture();
    const router = new EventRouter({
      bindingStore,
      journal,
      config: { defaultMode: 'bound', defaultEphemeralTtl: '24h' },
      ruleProviders: [miss, provider],
    });
    const evt = event({ dedupKey: 'k-journal' });
    const decision = await router.decide(evt);
    await router.record(evt, decision);

    const entries = await journal.list();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.decision).toMatchObject({
      kind: 'ephemeral',
      agentTemplate: 'triage',
      confidence: 0.9,
    });
    expect(entries[0]?.decision?.signals).toContain('agent:triage');
  });

  it('низкая уверенность decision → null, фоллбек defaultMode', async () => {
    const miss: RouteRuleProvider = { name: 'miss', resolve: () => null };
    const { provider } = makeFixture({ decideImpl: async () => choiceResponse('triage', 0.2) });
    const router = new EventRouter({
      bindingStore,
      journal,
      config: { defaultMode: 'bound', defaultEphemeralTtl: '24h' },
      ruleProviders: [miss, provider],
    });
    expect(await router.decide(event({ dedupKey: 'k-low' }))).toEqual({
      kind: 'drop',
      reason: 'no_route',
      audited: true,
    });
  });

  it('декларативное правило выигрывает — decision не вызывается', async () => {
    const winner: RouteDecision = { kind: 'bound', sessionId: 's-bound' };
    const rule: RouteRuleProvider = { name: 'winner', resolve: () => winner };
    const { provider, decide } = makeFixture();
    const router = new EventRouter({
      bindingStore,
      journal,
      config: { defaultMode: 'bound', defaultEphemeralTtl: '24h' },
      ruleProviders: [rule, provider],
    });
    expect(await router.decide(event({ dedupKey: 'k2' }))).toEqual(winner);
    expect(decide).not.toHaveBeenCalled();
  });

  it('ошибка decision → фоллбек defaultMode (drop no_route)', async () => {
    const miss: RouteRuleProvider = { name: 'miss', resolve: () => null };
    const { provider } = makeFixture({
      decideImpl: async () => {
        throw new Error('decision down');
      },
    });
    const router = new EventRouter({
      bindingStore,
      journal,
      config: { defaultMode: 'bound', defaultEphemeralTtl: '24h' },
      ruleProviders: [miss, provider],
    });
    expect(await router.decide(event({ dedupKey: 'k3' }))).toEqual({
      kind: 'drop',
      reason: 'no_route',
      audited: true,
    });
  });

  it('пустой input не мешает: провайдер реализует RouteRuleProvider', async () => {
    const { provider } = makeFixture();
    const input: RouteRuleInput = { event: event(), bindings: [] };
    expect(await provider.resolve(input)).not.toBeNull();
  });
});
