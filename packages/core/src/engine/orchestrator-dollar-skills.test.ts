/**
 * ADR-141 §3: пользовательский вызов скиллов через `$name` в оркестраторе —
 * тело скилла добавляется к user-сообщению, публикуется `skill.invoked`.
 *
 * Отдельно проверяется, что `$` **не** разбирается в `/`-командах: в шаблонах
 * `$ARGUMENTS`/`$1` — не токен скилла.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChatOrchestrator } from './orchestrator.js';
import { SessionManager } from '../sessions/manager.js';
import { FileStore } from '../storage/file-store.js';
import { EventBus } from '../events/bus.js';
import type { BusEvent, CommandRuntime } from '@itphx/synth-shared';
import type { ContextBuilder } from './context/builder.js';
import { generateId, MessageRole, nowISO, makeTextPart, type Message } from '@itphx/synth-shared';
import { toSkillSummary } from './skills/catalog.js';
import type { DiscoveredSkill, LoadedSkill, SkillRuntime } from './skills/types.js';
import { stubContextFiles } from '../test-helpers/storage-stubs.js';

function makeCtxBuilder(): ContextBuilder {
  return {
    buildSystemPrompt: async () => 'system prompt',
    buildBaseBlocks: async () => [],
  } as unknown as ContextBuilder;
}

function makeUserMessage(content: string): Message {
  return {
    id: generateId(), role: MessageRole.USER, seq: 0, origin: 'local',
    parts: [makeTextPart(content)], content, createdAt: nowISO(),
    disabled: false, pinned: false, hidden: false, author: 'user',
    metadata: { stream_id: generateId() },
  };
}

function discovered(name: string): DiscoveredSkill {
  return {
    name,
    meta: {
      name,
      description: `${name} desc`,
      userInvocable: true,
      disableModelInvocation: false,
      invocation: 'both',
    },
    body: `Body of ${name}`,
    dir: `/skills/${name}`,
    file: `/skills/${name}/SKILL.md`,
    source: { scope: 'instance', level: 'system', origin: 'instance', dir: '/skills', trusted: true },
    trusted: true,
    mtimeMs: 0,
  };
}

function makeRuntime(skills: DiscoveredSkill[]): SkillRuntime {
  const byName = new Map(skills.map((s) => [s.name, s]));
  const load = (skill: DiscoveredSkill): LoadedSkill => ({
    summary: toSkillSummary(skill), meta: skill.meta, body: skill.body, dir: skill.dir, files: [],
  });
  return {
    buildCatalog: async () => ({ stable: [], session: [] }),
    get: async (name) => byName.get(name),
    load: async (name) => {
      const skill = byName.get(name);
      return skill ? load(skill) : undefined;
    },
    readSupportingFile: async () => undefined,
  };
}

let tmpDir: string;

async function run(
  content: string,
  opts?: {
    skillRuntime?: SkillRuntime;
    commandRuntime?: CommandRuntime;
  },
) {
  tmpDir = await mkdtemp(join(tmpdir(), 'synth-orch-dollar-'));
  const sessionManager = new SessionManager(new FileStore({ dataDir: tmpDir }));
  const eventBus = new EventBus();
  const events: BusEvent[] = [];
  eventBus.subscribeAll((e) => events.push(e));

  const commandRuntime: CommandRuntime = opts?.commandRuntime ?? {
    list: async () => ({ commands: [], diagnostics: [] }),
    resolve: async () => undefined,
  };

  const orchestrator = new ChatOrchestrator({
    sessionManager,
    eventBus,
    contextBuilder: makeCtxBuilder(),
    contextConfig: stubContextFiles(),
    providerLoader: () => null,
    defaultWorkingDir: tmpDir,
    commandRuntime,
    ...(opts?.skillRuntime ? { skillRuntime: opts.skillRuntime } : {}),
  });

  const session = await sessionManager.createSession({
    settings: { provider: 'mock', model: 'mock-model' } as never,
  });
  const msg = makeUserMessage(content);
  await sessionManager.addMessage(session.id, msg);
  const fresh = (await sessionManager.getSession(session.id))!;
  const chunks: Array<{ event: string; data: Record<string, unknown> }> = [];
  await orchestrator.createProcessMessage()(
    fresh, msg, new AbortController().signal,
    (event, data) => chunks.push({ event, data }),
  );
  const after = (await sessionManager.getSession(session.id))!;
  return { after, events, msg, chunks };
}

afterEach(async () => {
  if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
});

describe('ChatOrchestrator — $ скиллы (ADR-141 §3)', () => {
  it('$skill → <skill_content> в user-сообщении + skill.invoked(source=user)', async () => {
    const { after, events, msg } = await run('сделай ревью $api-review', {
      skillRuntime: makeRuntime([discovered('api-review')]),
    });

    const stored = after.messages.find((m) => m.id === msg.id)!;
    expect(stored.content).toContain('<skill_content name="api-review">');
    expect(stored.content).toContain('Body of api-review');
    // Исходный текст пользователя сохранён.
    expect(stored.content).toContain('сделай ревью $api-review');

    const invoked = events.filter((e) => e.type === 'skill.invoked');
    expect(invoked).toHaveLength(1);
    expect(invoked[0]!.data.name).toBe('api-review');
    expect(invoked[0]!.data.source).toBe('user');
  });

  it('несколько $ — все тела в сообщении, порядок сохранён, событие на каждый', async () => {
    const { after, events, msg } = await run('$zeta $alpha', {
      skillRuntime: makeRuntime([discovered('zeta'), discovered('alpha')]),
    });
    const stored = after.messages.find((m) => m.id === msg.id)!;
    expect(stored.content.indexOf('name="zeta"')).toBeLessThan(stored.content.indexOf('name="alpha"'));
    const invoked = events.filter((e) => e.type === 'skill.invoked');
    expect(invoked.map((e) => e.data.name)).toEqual(['zeta', 'alpha']);
  });

  it('неизвестный скилл → сообщение не меняется, skill.invoked нет', async () => {
    const { after, events, msg } = await run('сделай ревью $ghost', {
      skillRuntime: makeRuntime([discovered('api-review')]),
    });
    const stored = after.messages.find((m) => m.id === msg.id)!;
    expect(stored.content).toBe('сделай ревью $ghost');
    expect(events.some((e) => e.type === 'skill.invoked')).toBe(false);
  });

  it('текст без $ — сообщение не меняется', async () => {
    const { after, events, msg } = await run('обычный текст', {
      skillRuntime: makeRuntime([discovered('api-review')]),
    });
    const stored = after.messages.find((m) => m.id === msg.id)!;
    expect(stored.content).toBe('обычный текст');
    expect(events.some((e) => e.type === 'skill.invoked')).toBe(false);
  });

  it('/-команда: $ARGUMENTS не считается скиллом (ADR-141 §3)', async () => {
    const { after, events, msg } = await run('/plan $ARGUMENTS', {
      skillRuntime: makeRuntime([discovered('ARGUMENTS'), discovered('api-review')]),
      commandRuntime: {
        list: async () => ({ commands: [], diagnostics: [] }),
        resolve: async (input) =>
          input.startsWith('/plan')
            ? { status: 'template', name: 'plan', args: '', kind: 'template', prompt: 'RENDERED $ARGUMENTS' }
            : undefined,
      },
    });
    const stored = after.messages.find((m) => m.id === msg.id)!;
    // Контент подменён шаблоном команды — скилл не подгружен.
    expect(stored.content).toBe('RENDERED $ARGUMENTS');
    expect(stored.content).not.toContain('<skill_content');
    expect(events.some((e) => e.type === 'skill.invoked')).toBe(false);
  });

  it('без skillRuntime $ игнорируется (сообщение без изменений)', async () => {
    const { after, events, msg } = await run('сделай ревью $api-review');
    const stored = after.messages.find((m) => m.id === msg.id)!;
    expect(stored.content).toBe('сделай ревью $api-review');
    expect(events.some((e) => e.type === 'skill.invoked')).toBe(false);
  });
});
