// Интеграционный тест гибридного режима (Часть 11): «локальный core + реальный backend».
// Сквозной сценарий в одном процессе:
//   - backend поднимается in-process через фабрику createBackendApp (debug auth);
//   - локальный core поднимается через createStandaloneApp с runtime-подключением
//     (applyConnected зеркалит серверного провайдера itphx как remote-зеркало)
//     и запретом локальных провайдеров;
//   - мост событий RemoteEventBridge транслирует SSE backend в локальный EventBus.
//
// Сценарии:
//   1. GET /api/v2/hybrid/status → { enabled, connected, backendUrl };
//   2. агрегация: remote-проект/сессия на backend видны на core как remote:<id>,
//      локальный проект — как origin:'local';
//   3. LLM через прокси: локальная сессия (provider=itphx — зеркало серверного
//      провайдера) → backend /api/v2/llm → FakeProvider (spy на ProviderFactory.create);
//   4. события: session.created на backend доходит до локального eventBus с remote:<id>;
//   5. publish/fork e2e: локальный проект (сессия + файл) → syncProjectToRemote →
//      проверка на backend → forkProjectToLocal в третий каталог.

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  createStandaloneApp,
  RemoteSession,
  ProviderFactory,
  BaseProvider,
  ProjectStore,
  SessionManager,
  FileStore,
} from '@itphx/synth-core';
import type { ProviderConfig, LLMMessage, CancellationToken } from '@itphx/synth-core';
import type { BusEvent, LLMChunk, LLMResponse } from '@itphx/synth-shared';
import { MessageRole } from '@itphx/synth-shared';
import { syncProjectToRemote, forkProjectToLocal, REMOTE_PREFIX } from '@itphx/synth-core/remote';
import { createBackendApp } from '../app.js';
import { closeTestServer } from '../test-helpers/close-server.js';
import type { BackendAppHandle } from '../app.js';

const LOCAL_API_KEY = 'local-key';
const ADMIN_API_KEY = 'admin-key-123';

/** Минимальный fake-провайдер с фиксированным ответом (аналог llm.test.ts). */
class FakeProvider extends BaseProvider {
  lastMessages: LLMMessage[] = [];

  constructor(model = 'fake-model') {
    super({ url: 'http://fake.local/v1', apiKey: 'test-key', model, name: 'fake' });
  }

  getProviderName(): string {
    return 'fake';
  }

  async chat(messages: LLMMessage[]): Promise<LLMResponse> {
    this.lastMessages = messages;
    return {
      content: 'Ответ fake-провайдера',
      model: this.model,
      usage: { inputTokens: 11, outputTokens: 7, totalTokens: 18 },
    };
  }

  async *chatAsync(
    messages: LLMMessage[],
    _systemPrompt?: string,
    _tools?: Record<string, unknown>[],
    _debugCollector?: unknown,
    _cancellationToken?: CancellationToken,
  ): AsyncGenerator<LLMChunk> {
    this.lastMessages = messages;
    yield { content: 'Ответ fake-провайдера', isFinal: false, usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } };
    yield { content: '', isFinal: true, usage: { inputTokens: 11, outputTokens: 7, totalTokens: 18 } };
  }
}

function closeServer(server: Server): Promise<void> {
  return closeTestServer(server);
}

describe('Гибридный режим: локальный core + реальный backend (интеграция)', () => {
  let tmpRoot: string;
  let backend: BackendAppHandle;
  let backendServer: { server: Server; port: number };
  let backendUrl: string;
  let remoteClient: ReturnType<RemoteSession['getClient']>;
  let core: Awaited<ReturnType<typeof createStandaloneApp>>;
  let coreUrl: string;
  let fakeProvider: FakeProvider;

  const coreApi = (path: string, init: RequestInit = {}): Promise<Response> =>
    fetch(`${coreUrl}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${LOCAL_API_KEY}`, ...(init.headers ?? {}) },
    });

  beforeAll(async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), 'synth-hybrid-e2e-'));
    const backendDir = join(tmpRoot, 'backend');
    const coreDir = join(tmpRoot, 'core');

    // Backend: debug auth + фейковый провайдер `itphx` (модель itphx/fake-model)
    // регистрируется через env SYNTH_PROVIDER_* (аналог core/backend).
    backend = await createBackendApp({
      dataDir: backendDir,
      authDebug: true,
      apiKey: ADMIN_API_KEY,
      env: {
        SYNTH_PROVIDER_ITPHX_URL: 'http://fake.local/v1',
        SYNTH_PROVIDER_ITPHX_TYPE: 'openai',
        SYNTH_PROVIDER_ITPHX_MODEL: 'fake-model',
      },
    });
    backendServer = await backend.listen(0, '127.0.0.1');
    backendUrl = `http://127.0.0.1:${backendServer.port}`;

    // Remote-сессия: api_key — токен для всех вызовов remoteClient и RemoteProvider.
    const remoteSession = await RemoteSession.ensureAuthenticated({
      backendUrl,
      authType: 'api_key',
      apiKey: ADMIN_API_KEY,
    });
    remoteClient = remoteSession.getClient();

    // Локальный core в гибриде: стартует «холодным», подключается в рантайме
    // по API-ключу (defaultBackendUrl + defaultToken). applyConnected зеркалит
    // серверных провайдеров (itphx) и запускает RemoteEventBridge.
    core = await createStandaloneApp({
      port: 0,
      dataDir: coreDir,
      apiKey: LOCAL_API_KEY,
      defaultBackendUrl: backendUrl,
      defaultToken: ADMIN_API_KEY,
      remoteLlm: 'server',
    });

    await new Promise<void>((resolve) => core.server.listen(0, '127.0.0.1', resolve));
    const coreAddr = core.server.address() as AddressInfo;
    coreUrl = `http://127.0.0.1:${coreAddr.port}`;

    // Runtime-подключение к backend (как делает CLI после listen).
    await core.connectRemoteWithApiKey(backendUrl, ADMIN_API_KEY);

    // Fake-провайдер для LLM Proxy backend: ProviderFactory.create('itphx', ...)
    // возвращает FakeProvider, остальные вызовы (в т.ч. создание зеркала на core —
    // там тип 'remote') делегируются оригинальной фабрике.
    fakeProvider = new FakeProvider();
    const originalCreate = ProviderFactory.create.bind(ProviderFactory);
    vi.spyOn(ProviderFactory, 'create').mockImplementation(((
      name: string, config: ProviderConfig, temperature?: number, topP?: number, topK?: number,
    ) => {
      if (name === 'itphx') return fakeProvider as never;
      return originalCreate(name, config, temperature, topP, topK);
    }) as typeof ProviderFactory.create);
  });

  afterAll(async () => {
    core.remoteEventBridge?.stop();
    await closeServer(core.server).catch(() => {});
    await closeServer(backendServer.server).catch(() => {});
    vi.restoreAllMocks();
    await rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
  });

  it('1. статус гибрида: enabled + connected + backendUrl', async () => {
    const res = await fetch(`${coreUrl}/api/v2/hybrid/status`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      enabled: true,
      connected: true,
      backendUrl,
    });
  });

  it('2. агрегация: remote-сущности видны как remote:<id>, локальные — origin local', async () => {
    // Проект и сессия создаются на backend напрямую (через remoteClient).
    const remoteProj = (await remoteClient.createProject({ name: 'Удалённый проект', description: 'создан на backend' })) as { id: string };
    const remoteSes = (await remoteClient.createSession({ title: 'Удалённая сессия', project_id: remoteProj.id })) as { id: string };

    const projects = (await (await coreApi('/api/v2/projects')).json()) as Array<Record<string, unknown>>;
    const rp = projects.find((p) => p.id === `remote:${remoteProj.id}`);
    expect(rp).toBeDefined();
    expect(rp!.origin).toBe('remote');
    expect(rp!.name).toBe('Удалённый проект');

    const sessions = (await (await coreApi('/api/v2/sessions')).json()) as Array<Record<string, unknown>>;
    const rs = sessions.find((s) => s.id === `remote:${remoteSes.id}`);
    expect(rs).toBeDefined();
    expect(rs!.origin).toBe('remote');
    expect(rs!.project_id).toBe(`remote:${remoteProj.id}`);

    // Локальный проект на core — в списке оба мира.
    const createRes = await coreApi('/api/v2/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Локальный проект' }),
    });
    expect(createRes.status).toBe(201);
    const localProj = (await createRes.json()) as { id: string; origin: string };
    expect(localProj.origin).toBe('local');

    const projects2 = (await (await coreApi('/api/v2/projects')).json()) as Array<Record<string, unknown>>;
    expect(projects2).toHaveLength(2);
    expect(projects2.find((p) => p.id === localProj.id)?.origin).toBe('local');
    expect(projects2.find((p) => p.id === `remote:${remoteProj.id}`)?.origin).toBe('remote');
  });

  it('3. LLM через прокси: локальная сессия → зеркало itphx → backend → FakeProvider', { timeout: 20_000 }, async () => {
    // Локальная сессия на core с зеркалом серверного провайдера и его моделью.
    const createRes = await coreApi('/api/v2/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'LLM через прокси',
        settings: { provider: 'itphx', model: 'itphx/fake-model' },
      }),
    });
    expect(createRes.status).toBe(201);
    const ses = (await createRes.json()) as { id: string; origin: string };
    expect(ses.origin).toBe('local');

    fakeProvider.lastMessages = [];
    const promptRes = await coreApi(`/api/v2/sessions/${ses.id}/prompt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'привет из локального core' }),
    });
    expect(promptRes.status).toBe(200);
    const text = await promptRes.text();

    const events = text.split('\n')
      .filter((l) => l.startsWith('data: '))
      .map((l) => JSON.parse(l.slice(6))) as Array<{ type: string; data: Record<string, unknown> }>;

    const done = events.find((e) => e.type === 'stream.done');
    expect(done).toBeDefined();
    expect(done!.data.content).toContain('Ответ fake-провайдера');

    // FakeProvider реально вызван — контент прошёл через backend LLM Proxy.
    // lastMessages может быть перезаписан фоновым auto-title (второй вызов),
    // поэтому ищем сообщение по содержимому, а не по индексу.
    expect(fakeProvider.lastMessages.length).toBeGreaterThan(0);
    expect(fakeProvider.lastMessages.some((m) => m.content.includes('привет из локального core'))).toBe(true);
  });

  it('4. события: session.created с backend доходит до локального eventBus с remote:<id>', { timeout: 20_000 }, async () => {
    // Ждём подключения моста к SSE backend /api/v2/events.
    await vi.waitFor(() => expect(core.remoteEventBridge?.connected).toBe(true), { timeout: 8_000, interval: 100 });

    const received: BusEvent[] = [];
    const unsub = core.eventBus.subscribeAll((ev) => received.push(ev));
    try {
      // Регистрация SSE-клиента на backend асинхронна, а событие приходит по
      // SSE чуть позже HTTP-ответа createSession — создаём сессии, пока событие
      // хотя бы одной из них не будет доставлено (самовосстанавливающийся waitFor).
      const createdIds: string[] = [];
      await vi.waitFor(async () => {
        const created = (await remoteClient.createSession({ title: `evt-${Math.random().toString(36).slice(2, 8)}` })) as { id: string };
        createdIds.push(created.id);
        expect(received.some(
          (e) => e.type === 'session.created' && createdIds.includes(e.sessionId.slice(REMOTE_PREFIX.length)),
        )).toBe(true);
      }, { timeout: 8_000, interval: 150 });
    } finally {
      unsub();
    }
  });

  it('5. publish/fork e2e: локальный проект (сессия+файл) → backend → fork в третий каталог', { timeout: 20_000 }, async () => {
    const coreDir = join(tmpRoot, 'core');
    const forkDir = join(tmpRoot, 'fork');

    // Локальный проект пишем напрямую в хранилище core (тот же dataDir) —
    // через API сообщение без запуска LLM не добавить (см. transfer.test.ts).
    const localProjectStore = new ProjectStore({ dataDir: coreDir });
    const localSessionManager = new SessionManager(new FileStore({ dataDir: coreDir }));

    const project = localProjectStore.create('Publish E2E', 'local', {
      description: 'интеграционный тест',
      workspace: 'publish-e2e',
    });
    await localProjectStore.save(project);

    const session = await localSessionManager.createSession({ title: 'Сессия publish', projectId: project.id });
    await localSessionManager.addMessage(session.id, {
      id: 'pub-msg-1', role: MessageRole.USER, seq: 1, origin: 'local' as const,
      parts: [{ id: 'pub-part-1', type: 'text' as const, data: 'сообщение для переноса' }],
      content: 'сообщение для переноса', createdAt: new Date().toISOString(),
      disabled: false, pinned: false, hidden: false,
    });
    // addMessage не мутирует in-memory объект — берём свежую копию из store
    // (паттерн transfer.test.ts), иначе в publish уйдёт сессия без сообщений.
    const freshSession = (await localSessionManager.getSession(session.id))!;

    const localProjectDir = join(coreDir, 'workspaces', 'publish-e2e');
    await mkdir(localProjectDir, { recursive: true });
    await writeFile(join(localProjectDir, 'notes.txt'), 'содержимое файла');

    // Publish: локальный проект → backend.
    const stats = await syncProjectToRemote({
      localProject: project,
      remoteClient,
      includeFiles: true,
      includeSessions: true,
      localProjectDir,
      localSessions: [freshSession],
    });
    expect(stats.created).toBe(true);
    expect(stats.sessionsImported).toBe(1);
    expect(stats.filesUploaded).toBe(1);

    // Проверка на backend: проект, сессия с сообщением, файл.
    const remoteProj = (await remoteClient.getProject(stats.projectId)) as { name: string; workspace: string };
    expect(remoteProj.name).toBe('Publish E2E');

    const remoteSessions = (await remoteClient.listSessions(stats.projectId)) as Array<{ id: string; project_id: string }>;
    expect(remoteSessions.length).toBeGreaterThan(0);

    const exportData = (await remoteClient.exportSession(remoteSessions[0]!.id)) as { messages?: Array<{ content: string }> };
    expect(exportData.messages?.some((m) => m.content === 'сообщение для переноса')).toBe(true);

    const fsData = (await remoteClient.fsRead({ projectId: stats.projectId, path: 'notes.txt' })) as { content?: string };
    expect(fsData.content).toBe('содержимое файла');

    // Fork: удалённый проект → третий каталог.
    const forkStore = new ProjectStore({ dataDir: forkDir });
    const forkSessions = new SessionManager(new FileStore({ dataDir: forkDir }));
    const forkStats = await forkProjectToLocal({
      remoteProjectId: stats.projectId,
      remoteClient,
      localProjectStore: forkStore,
      localSessionManager: forkSessions,
      includeFiles: true,
      includeSessions: true,
      localWorkspacesRoot: join(forkDir, 'workspaces'),
      localName: 'Fork E2E',
    });
    expect(forkStats.sessionsImported).toBe(1);
    expect(forkStats.filesDownloaded).toBe(1);

    const localFork = await forkStore.load(forkStats.projectId);
    expect(localFork?.name).toBe('Fork E2E');
    const forkSessionsList = await forkSessions.listSessions({ projectId: forkStats.projectId });
    expect(forkSessionsList[0]?.messages.some((m) => m.content === 'сообщение для переноса')).toBe(true);

    const forkFile = await readFile(join(forkDir, 'workspaces', 'fork-e2e', 'notes.txt'), 'utf-8');
    expect(forkFile).toBe('содержимое файла');
  });
});
