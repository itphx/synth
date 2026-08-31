import { Command } from 'commander';
import { createRequire } from 'node:module';
import { join, dirname } from 'node:path';
import { loadConfig, resolveDataDir, resolvePort, resolveDefaultWorkspace, resolveWorkspacesRoot, defaultConfig, ensureFirstRun, ensureDataDir, SYNTH_VERSION } from '@itphx/synth-shared';
import type { SynthConfig } from '@itphx/synth-shared';
import { createStandaloneApp } from '@itphx/synth-core/server/app.js';
import { runSingleChat } from '@itphx/synth-core/server/chat.js';
import { JsonStore } from '@itphx/synth-core/storage/json-store.js';

const require = createRequire(import.meta.url);

/**
 * Резолвинг корня npm-зависимости по её package.json (через node-резолвер).
 * Возвращает null, если пакет не установлен.
 */
function resolvePackageRoot(pkgName: string): string | null {
  try {
    return dirname(require.resolve(`${pkgName}/package.json`));
  } catch {
    return null;
  }
}

const program = new Command();

program
  .name('synth')
  .description('AI-агентная платформа для командной разработки')
  .version(SYNTH_VERSION);

program
  .command('serve')
  .description('Запустить HTTP API сервер')
  .option('--port <number>', 'порт сервера', String(defaultConfig.core.port))
  .option('--host <host>', 'адрес для прослушивания', '0.0.0.0')
  .option('--api-key <key>', 'API-ключ для аутентификации')
  .option('--data-dir <path>', 'каталог данных')
  .option('--config <path>', 'путь к config.yaml')
  .option('--connect <url>', 'URL удалённого backend (гибридный режим)')
  .option('--oidc-issuer <url>', 'OIDC issuer для device flow (гибридный режим)')
  .option('--oidc-client-id <id>', 'OIDC client_id для device flow (гибридный режим)')
  .option('--token <key>', 'API-ключ для аутентификации на удалённом backend (гибридный режим)')
  .action(async (options) => {
    const { dataDir } = await ensureFirstRun(
      options.dataDir || undefined,
      options.config || undefined,
    );

    const overrides: Partial<SynthConfig> = {
      core: {
        port: parseInt(options.port, 10),
        apiKey: options.apiKey,
      },
      storage: { dataDir, workspacesRoot: '', defaultWorkspace: '' },
    };
    if (options.connect) {
      // deepMerge на рантайме сольёт частичную секцию remote с defaultConfig; тип требует полный RemoteConfig.
      overrides.remote = {
        enabled: true,
        backendUrl: options.connect,
        auth: {
          type: options.token ? 'api_key' : 'device',
          apiKey: options.token ?? '',
          issuer: options.oidcIssuer ?? '',
          clientId: options.oidcClientId ?? '',
        },
      } as SynthConfig['remote'];
    }

    const synth = await loadConfig({
      configPath: options.config,
      overrides,
    });

    const port = resolvePort(synth, 'SYNTH_CORE_PORT', synth.core.port);
    const apiKey = synth.core.apiKey || process.env.SYNTH_API_KEY || '';

    // UI поставляется как отдельный npm-пакет @itphx/synth-ui → резолвим его dist/.
    // systemPromptsDir не передаём: @itphx/synth-core резолвит свои prompts сам (рядом с package.json).
    const uiRoot = resolvePackageRoot('@itphx/synth-ui');
    const uiDistPath = uiRoot ? join(uiRoot, 'dist') : undefined;

    // Гибридный режим: аутентификация к удалённому backend перед стартом сервера.
    let remoteClient;
    let remoteProvider;
    let remoteBlockLocalProviders;
    let remoteGetToken;
    if (synth.remote.enabled && synth.remote.backendUrl) {
      const { RemoteSession } = await import('@itphx/synth-core/remote');
      const session = await RemoteSession.ensureAuthenticated(
        {
          backendUrl: synth.remote.backendUrl,
          authType: synth.remote.auth.type,
          apiKey: synth.remote.auth.apiKey,
          issuer: synth.remote.auth.issuer,
          clientId: synth.remote.auth.clientId,
          credentialsPath: synth.remote.credentialsPath || undefined,
          timeoutMs: synth.remote.timeoutMs,
        },
        async (info) => {
          console.log('\n  Гибридный режим: требуется авторизация на удалённом backend.');
          console.log(`  1. Откройте в браузере: ${info.verificationUri}`);
          console.log(`  2. Введите код: ${info.userCode}`);
          console.log('  Ожидание подтверждения...');
        },
      );
      remoteClient = session.getClient();
      remoteGetToken = () => session.getToken();
      const status = await session.getAuthStatus().catch(() => null);
      console.log(`  Подключено к удалённому backend: ${synth.remote.backendUrl}${status?.user ? ` (user: ${status.user.username})` : ''}`);
      if (status && !status.connected) {
        console.log('  Внимание: не удалось подтвердить статус (сервер недоступен), credentials сохранены.');
      }

      // Часть 6: централизация LLM — виртуальный remote-провайдер (все LLM
      // локальных сессий идут через серверный /api/v2/llm/chat/completions).
      const remoteModelsRaw = await remoteClient.listModels({ timeoutMs: 5000 }).catch(() => []);
      const remoteModels = (remoteModelsRaw ?? []).map((m) => ({
        id: String(m.id ?? ''),
        name: String(m.name ?? m.id ?? ''),
        provider: 'synth-remote',
        description: String(m.description ?? ''),
        enabled: m.enabled !== false,
      })).filter((m) => m.id);
      remoteProvider = {
        provider: { name: 'synth-remote', type: 'remote', baseUrl: session.backendUrl, apiKey: '', enabled: true },
        models: remoteModels,
        getToken: () => session.getToken(),
      };
      // Политика: по умолчанию (remote.llm=server) локальные провайдеры запрещены.
      remoteBlockLocalProviders = synth.remote.llm !== 'local';
      console.log(`  LLM: ${remoteBlockLocalProviders ? 'централизация (локальные провайдеры запрещены)' : 'гибрид (локальные + remote)'}`);
    }

    const { server, wss, remoteEventBridge } = await createStandaloneApp({
      port,
      dataDir,
      apiKey,
      workspacesRoot: resolveWorkspacesRoot(synth),
      defaultWorkingDir: resolveDefaultWorkspace(synth),
      uiDistPath,
      remoteClient,
      remoteProvider,
      remoteBlockLocalProviders,
      remoteGetToken,
    });

    let shuttingDown = false;

    async function gracefulShutdown(signal: string): Promise<void> {
      if (shuttingDown) return;
      shuttingDown = true;
      console.log(`\n[Shutdown] Получен сигнал ${signal}, завершаю...`);

      // Гибрид: закрыть SSE-стрим к удалённому backend, отменить реконнект.
      remoteEventBridge?.stop();

      server.close((err: Error | undefined) => {
        if (err) console.error('[Shutdown] Server close error:', err);
      });

      wss.close((err: Error | undefined) => {
        if (err) console.error('[Shutdown] WSS close error:', err);
      });

      process.exit(0);
    }

    process.on('SIGTERM', () => { void gracefulShutdown('SIGTERM'); });
    process.on('SIGINT', () => { void gracefulShutdown('SIGINT'); });

    const host = options.host || process.env.SYNTH_HOST || '0.0.0.0';

    server.listen(port, host, () => {
      console.log(`\n  Откройте http://${host}:${port} в браузере`);
      console.log(`  API-ключ: ${apiKey ? apiKey.slice(0, 8) + '...' : '(не задан)'}`);

      // Гибрид: после старта сервера подключаем мост событий удалённого backend.
      remoteEventBridge?.start();
    });
  });

program
  .command('connect')
  .description('Подключиться к удалённому backend (гибридный режим)')
  .requiredOption('--backend <url>', 'URL удалённого backend')
  .option('--oidc-issuer <url>', 'OIDC issuer для device flow')
  .option('--oidc-client-id <id>', 'OIDC client_id для device flow')
  .option('--token <key>', 'API-ключ для аутентификации')
  .option('--config <path>', 'путь к config.yaml')
  .action(async (options) => {
    const synth = await loadConfig({ configPath: options.config });
    const { RemoteSession } = await import('@itphx/synth-core/remote');

    const session = await RemoteSession.ensureAuthenticated(
      {
        backendUrl: options.backend,
        authType: options.token ? 'api_key' : 'device',
        apiKey: options.token ?? '',
        issuer: options.oidcIssuer ?? synth.remote.auth.issuer,
        clientId: options.oidcClientId ?? synth.remote.auth.clientId,
        credentialsPath: synth.remote.credentialsPath || undefined,
        timeoutMs: synth.remote.timeoutMs,
      },
      async (info) => {
        console.log('\nТребуется авторизация на удалённом backend.');
        console.log(`  1. Откройте в браузере: ${info.verificationUri}`);
        console.log(`  2. Введите код: ${info.userCode}`);
        console.log('  Ожидание подтверждения...');
      },
    );

    const status = await session.getAuthStatus().catch(() => null);
    console.log(`Подключено: ${options.backend}${status?.user ? ` (user: ${status.user.username})` : ''}`);
    if (status && !status.connected) {
      console.log('Внимание: не удалось подтвердить статус (сервер недоступен), credentials сохранены.');
    }
  });

program
  .command('disconnect')
  .description('Отключиться от удалённого backend (удалить сохранённые credentials)')
  .requiredOption('--backend <url>', 'URL удалённого backend')
  .option('--config <path>', 'путь к config.yaml')
  .action(async (options) => {
    const synth = await loadConfig({ configPath: options.config });
    const { clearCredentials } = await import('@itphx/synth-core/remote');
    await clearCredentials(options.backend, synth.remote.credentialsPath || undefined);
    console.log(`Отключено: ${options.backend} (credentials удалены)`);
  });

/** Общая аутентификация к удалённому backend для команд publish/fork. */
async function ensureRemoteSession(options: Record<string, unknown>, synth: SynthConfig) {
  const { RemoteSession } = await import('@itphx/synth-core/remote');
  const backendUrl = (options.remote as string | undefined) || synth.remote.backendUrl;
  if (!backendUrl) {
    console.error('Ошибка: не указан URL удалённого backend. Используйте --remote <url> или remote.backendUrl в config.yaml.');
    process.exit(1);
  }
  const session = await RemoteSession.ensureAuthenticated(
    {
      backendUrl,
      authType: (options.token as string | undefined) ? 'api_key' : (synth.remote.auth.type || 'device'),
      apiKey: (options.token as string | undefined) || synth.remote.auth.apiKey || '',
      issuer: (options.oidcIssuer as string | undefined) || synth.remote.auth.issuer,
      clientId: (options.oidcClientId as string | undefined) || synth.remote.auth.clientId,
      credentialsPath: synth.remote.credentialsPath || undefined,
      timeoutMs: synth.remote.timeoutMs,
    },
    async (info) => {
      console.log('\nТребуется авторизация на удалённом backend.');
      console.log(`  1. Откройте в браузере: ${info.verificationUri}`);
      console.log(`  2. Введите код: ${info.userCode}`);
      console.log('  Ожидание подтверждения...');
    },
  );
  return session;
}

const projectCmd = new Command('project')
  .description('Операции переноса проектов между мирами (гибридный режим)');

projectCmd
  .command('publish')
  .description('Опубликовать локальный проект на удалённый backend (проект + сессии + файлы)')
  .argument('<projectId>', 'ID локального проекта')
  .option('--remote <url>', 'URL удалённого backend (или remote.backendUrl из config.yaml)')
  .option('--remote-project <id>', 'ID существующего проекта на сервере (обновление вместо создания)')
  .option('--no-files', 'не переносить workspace-файлы')
  .option('--no-sessions', 'не переносить сессии')
  .option('--config <path>', 'путь к config.yaml')
  .option('--data-dir <path>', 'каталог данных')
  .option('--oidc-issuer <url>', 'OIDC issuer для device flow')
  .option('--oidc-client-id <id>', 'OIDC client_id для device flow')
  .option('--token <key>', 'API-ключ для аутентификации')
  .action(async (projectId, options) => {
    const synth = await loadConfig({ configPath: options.config });
    const dataDir = (options.dataDir as string | undefined) || resolveDataDir(synth);
    await ensureDataDir(dataDir);

    const { FileStore, SessionManager, ProjectStore } = await import('@itphx/synth-core');
    const { syncProjectToRemote, resolveLocalWorkspace } = await import('@itphx/synth-core/remote');

    const projectStore = new ProjectStore({ dataDir });
    const project = await projectStore.load(projectId);
    if (!project) {
      console.error(`Ошибка: локальный проект ${projectId} не найден`);
      process.exit(1);
    }

    const includeFiles = !options.noFiles;
    const includeSessions = !options.noSessions;
    // При явном --data-dir workspaces лежат рядом ({dataDir}/workspaces),
    // иначе — из конфига (resolveWorkspacesRoot/resolveDefaultWorkspace).
    const workspacesRoot = options.dataDir ? join(dataDir, 'workspaces') : resolveWorkspacesRoot(synth);
    const defaultWorkingDir = options.dataDir ? join(dataDir, 'workspaces', 'default') : resolveDefaultWorkspace(synth);
    const localProjectDir = resolveLocalWorkspace(
      project,
      workspacesRoot,
      defaultWorkingDir,
    );

    const session = await ensureRemoteSession(options, synth);
    const remoteClient = session.getClient();

    const localSessions = includeSessions
      ? await new SessionManager(new FileStore({ dataDir })).listSessions({ projectId: project.id })
      : [];

    console.log(`Publish проекта «${project.name}» → ${session.backendUrl}`);
    const stats = await syncProjectToRemote({
      localProject: project,
      remoteClient,
      remoteProjectId: (options.remoteProject as string | undefined) || undefined,
      includeFiles,
      includeSessions,
      localProjectDir,
      localSessions,
      log: (msg) => console.log(msg),
    });

    console.log('─'.repeat(60));
    console.log(`Готово: проект ${stats.projectId} (${stats.created ? 'создан' : 'обновлён'})`);
    console.log(`  сессий импортировано: ${stats.sessionsImported}`);
    if (includeFiles) console.log(`  файлов загружено: ${stats.filesUploaded}`);
  });

projectCmd
  .command('fork')
  .description('Склонировать удалённый проект локально (проект + сессии + файлы)')
  .argument('<remoteProjectId>', 'ID удалённого проекта')
  .option('--remote <url>', 'URL удалённого backend (или remote.backendUrl из config.yaml)')
  .option('--local-name <name>', 'имя локального проекта (по умолчанию — имя удалённого)')
  .option('--no-files', 'не скачивать workspace-файлы')
  .option('--no-sessions', 'не переносить сессии')
  .option('--config <path>', 'путь к config.yaml')
  .option('--data-dir <path>', 'каталог данных')
  .option('--oidc-issuer <url>', 'OIDC issuer для device flow')
  .option('--oidc-client-id <id>', 'OIDC client_id для device flow')
  .option('--token <key>', 'API-ключ для аутентификации')
  .action(async (remoteProjectId, options) => {
    const synth = await loadConfig({ configPath: options.config });
    const dataDir = (options.dataDir as string | undefined) || resolveDataDir(synth);
    await ensureDataDir(dataDir);

    const { FileStore, SessionManager, ProjectStore } = await import('@itphx/synth-core');
    const { forkProjectToLocal } = await import('@itphx/synth-core/remote');

    const session = await ensureRemoteSession(options, synth);
    const remoteClient = session.getClient();

    console.log(`Fork проекта ${remoteProjectId} ← ${session.backendUrl}`);
    const stats = await forkProjectToLocal({
      remoteProjectId,
      remoteClient,
      localProjectStore: new ProjectStore({ dataDir }),
      localSessionManager: new SessionManager(new FileStore({ dataDir })),
      includeFiles: !options.noFiles,
      includeSessions: !options.noSessions,
      localWorkspacesRoot: options.dataDir ? join(dataDir, 'workspaces') : resolveWorkspacesRoot(synth),
      localName: (options.localName as string | undefined) || undefined,
      log: (msg) => console.log(msg),
    });

    console.log('─'.repeat(60));
    console.log(`Готово: локальный проект ${stats.projectId}`);
    console.log(`  сессий импортировано: ${stats.sessionsImported}`);
    if (!options.noFiles) console.log(`  файлов скачано: ${stats.filesDownloaded}`);
  });

program.addCommand(projectCmd);

program
  .command('chat')
  .description('Одноразовый чат-запрос')
  .argument('[message]', 'сообщение')
  .option('--model <model>', 'модель')
  .option('--provider <provider>', 'провайдер')
  .option('--agent <agent>', 'агент (developer, assistant)')
  .option('--data-dir <path>', 'каталог данных')
  .option('--api-key <key>', 'API-ключ провайдера')
  .action(async (message, options) => {
    if (!message) {
      console.log('Интерактивный режим (введите "exit" для выхода)');
      await startRepl(options);
      return;
    }

    const synth = await loadConfig({});
    const { dataDir } = await ensureFirstRun(options['data-dir'] as string | undefined);

    await runSingleChat({
      message,
      model: options.model,
      provider: options.provider,
      agent: options.agent,
      dataDir,
      config: synth,
    });
  });

const configCmd = new Command('config')
  .description('Управление конфигурацией');

configCmd
  .command('show')
  .description('Показать текущую конфигурацию')
  .option('--config <path>', 'путь к config.yaml')
  .action(async (options) => {
    const synth = await loadConfig({ configPath: options.config });
    console.log(JSON.stringify(synth, null, 2));
  });

const providerCmd = new Command('provider')
  .description('Управление провайдерами');

providerCmd
  .command('add')
  .description('Добавить провайдера')
  .requiredOption('--name <name>', 'имя провайдера')
  .requiredOption('--type <type>', 'тип (openai, anthropic, ollama)')
  .option('--api-key <key>', 'API-ключ')
  .option('--url <url>', 'базовый URL')
  .option('--model <model>', 'модель по умолчанию')
  .option('--data-dir <path>', 'каталог данных')
  .action(async (options) => {
    const synth = await loadConfig({});
    const dataDir = options.dataDir || resolveDataDir(synth);
    await ensureDataDir(dataDir);

    const store = new JsonStore<{
      name: string; type: string; baseUrl?: string; apiKey?: string;
      defaultModel?: string; timeout?: number; enabled?: boolean; icon?: string;
    }>({ dataDir, subdir: 'providers' });

    const existing = await store.load(options.name);
    const provider = {
      name: options.name,
      type: options.type,
      baseUrl: options.url || existing?.baseUrl,
      apiKey: options.apiKey || existing?.apiKey,
      defaultModel: options.model || existing?.defaultModel,
      timeout: existing?.timeout ?? 120,
      enabled: existing?.enabled ?? true,
      icon: existing?.icon ?? '',
    };
    await store.save(options.name, provider);
    console.log(`Провайдер "${options.name}" сохранён (${existing ? 'обновлён' : 'создан'})`);
  });

providerCmd
  .command('list')
  .description('Список провайдеров')
  .option('--data-dir <path>', 'каталог данных')
  .action(async (options) => {
    const synth = await loadConfig({});
    const dataDir = options.dataDir || resolveDataDir(synth);
    await ensureDataDir(dataDir);

    const store = new JsonStore<{
      name: string; type: string; enabled?: boolean; defaultModel?: string; baseUrl?: string;
    }>({ dataDir, subdir: 'providers' });
    const providers = await store.list();
    if (providers.length === 0) {
      console.log('  (нет провайдеров)');
      return;
    }
    for (const p of providers) {
      console.log(`  ${p.name} (${p.type})${p.enabled === false ? ' [отключён]' : ''}${p.defaultModel ? ` → ${p.defaultModel}` : ''}${p.baseUrl ? ` | ${p.baseUrl}` : ''}`);
    }
  });

providerCmd
  .command('delete')
  .description('Удалить провайдера')
  .argument('<name>', 'имя провайдера')
  .option('--data-dir <path>', 'каталог данных')
  .action(async (name, options) => {
    const synth = await loadConfig({});
    const dataDir = options.dataDir || resolveDataDir(synth);
    await ensureDataDir(dataDir);

    const store = new JsonStore<unknown>({ dataDir, subdir: 'providers' });
    if (!(await store.exists(name))) {
      console.log(`Провайдер "${name}" не найден`);
      process.exit(1);
    }
    await store.delete(name);
    console.log(`Провайдер "${name}" удалён`);
  });

configCmd.addCommand(providerCmd);

program.addCommand(configCmd);

program
  .command('audit')
  .description('Просмотр аудита LLM Gateway (AD-036)')
  .option('--tail <n>', 'количество последних записей (по умолчанию 20)')
  .option('--userId <id>', 'фильтр по пользователю')
  .option('--sessionId <id>', 'фильтр по сессии')
  .option('--since <iso>', 'фильтр: записи не раньше ISO-метки времени')
  .option('--until <iso>', 'фильтр: записи не позже ISO-метки времени')
  .option('--limit <n>', 'максимальное число записей (если не задан --tail)')
  .option('--config <path>', 'путь к config.yaml')
  .option('--data-dir <path>', 'каталог данных')
  .action(async (options) => {
    const synth = await loadConfig({ configPath: options.config });
    const dataDir = options.dataDir || resolveDataDir(synth);
    await ensureDataDir(dataDir);

    const logPath = synth.llmGateway.audit.logPath || join(dataDir, 'audit', 'llm-gateway.jsonl');

    const tail = options.tail != null ? parseInt(options.tail, 10) : NaN;
    const limitOpt = options.limit != null ? parseInt(options.limit, 10) : NaN;
    const limit = Number.isFinite(tail) ? tail : (Number.isFinite(limitOpt) ? limitOpt : 20);

    const { readAuditLog } = await import('@itphx/synth-core/engine/gateway/index.js');
    const { entries, total } = await readAuditLog(logPath, {
      userId: options.userId,
      sessionId: options.sessionId,
      since: options.since,
      until: options.until,
      limit,
    });

    if (entries.length === 0) {
      console.log('Нет записей аудита.');
      return;
    }

    console.log(`Аудит: ${total} записей по фильтру, показано ${entries.length} (${logPath})`);
    console.log('─'.repeat(140));
    for (const e of entries) {
      const ts = (e.ts || '').substring(0, 19);
      const placeholders = (e.placeholders || []).join(',');
      const secrets = (e.secretsFound || []).join(',');
      console.log(
        [
          ts.padEnd(20),
          (e.type || '').padEnd(14),
          (e.provider || '').padEnd(12),
          (e.model || '').padEnd(22),
          (e.sessionId || '').padEnd(20),
          (e.userId || '').padEnd(12),
          placeholders.padEnd(10),
          secrets,
          e.reason || '',
        ].join(' ').trimEnd(),
      );
    }
  });

program.action(async () => {
  await startRepl({});
});

async function startRepl(options: Record<string, unknown>) {
  const readline = await import('node:readline');
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: '> ',
  });

  const synth = await loadConfig({});
  const { dataDir } = await ensureFirstRun((options['data-dir'] as string) || undefined);

  console.log(`Провайдер: ${options.provider || synth.llm.defaultProvider || '(не задан)'}`);
  console.log(`Модель: ${options.model || synth.llm.defaultModel || '(не задана)'}`);
  console.log();

  rl.prompt();

  for await (const line of rl) {
    if (line.toLowerCase() === 'exit' || line.toLowerCase() === 'quit') break;
    if (!line.trim()) {
      rl.prompt();
      continue;
    }

    await runSingleChat({
      message: line,
      model: options.model as string,
      provider: options.provider as string,
      agent: options.agent as string,
      dataDir,
      config: synth,
    });

    rl.prompt();
  }

  rl.close();
  console.log('До свидания!');
}

program.parse();
