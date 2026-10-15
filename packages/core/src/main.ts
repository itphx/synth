import { Command } from 'commander';
import { loadConfig, resolveDataDir, resolvePort, resolveDefaultWorkspace, resolveWorkspacesRoot, resolveWorkspaceOutsideRootPolicy, resolveSecretKey, resolveHome, resolveProfilesPath, resolveCredentialsPath, resolveIgnoreRules, resolveMaxUploadBytes, ensureDataDir, defaultConfig, SYNTH_VERSION } from '@itphx/synth-shared';
import type { SynthConfig } from '@itphx/synth-shared';
import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import { checkForUpdatesBackground } from './update-checker.js';
import { t as sm } from './engine/system-messages.js';

const program = new Command();

program
  .name('synth')
  .description('Synth Core — автономный AI-движок')
  .version(SYNTH_VERSION);

program
  .command('serve')
  .description('Запустить HTTP API сервер')
  .option('--port <number>', 'порт сервера', String(defaultConfig.core.port))
  .option('--host <host>', 'адрес для прослушивания', '0.0.0.0')
  .option('--api-key <key>', 'API-ключ для аутентификации')
  .option('--data-dir <path>', 'каталог данных')
  .option('--config <path>', 'путь к config.yaml')
  .option('--home <path>', 'локальный home-каталог (config/data/profiles/credentials)')
  .option('--profiles <path>', 'путь к реестру профилей серверов (переопределяет home)')
  .option('--credentials <path>', 'путь к файлу credentials (переопределяет home)')
  .option('--backend <url>', 'URL бэкенда (managed mode)')
  .option('--connect <url>', 'URL удалённого backend (гибридный режим)')
  .option('--oidc-issuer <url>', 'OIDC issuer — fallback дискавери для входа в UI (гибридный режим)')
  .option('--oidc-client-id <id>', 'OIDC client_id — fallback дискавери для входа в UI (гибридный режим)')
  .option('--token <key>', 'API-ключ для аутентификации на удалённом backend (гибридный режим)')
  .option('--runner', 'запустить in-process раннер')
  .option('--ui <path>', 'путь к собранному UI (dist)')
  .option('--ignore-rules', 'не грузить проектные инструкции (AGENTS.md) — нейтральная сессия')
  .option('--safe-mode', 'безопасный режим: проектные инструкции не грузятся')
  .action(async (options) => {
    // ADR-079: единый home-каталог локального инстанса (config/data/profiles/credentials).
    const home = resolveHome(options.home);
    const overrides: Partial<SynthConfig> = {
      core: {
        port: parseInt(options.port, 10),
        apiKey: options.apiKey,
      },
      storage: options.dataDir ? { dataDir: options.dataDir, workspacesRoot: '', defaultWorkspace: '', workspaceOutsideRoot: '' } : undefined,
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
      home: home ?? undefined,
      overrides,
    });

    const dataDir = resolveDataDir(synth, undefined, home);
    const port = resolvePort(synth, 'SYNTH_CORE_PORT', synth.core.port);
    const apiKey = synth.core.apiKey || process.env.SYNTH_API_KEY || '';

    await ensureDataDir(dataDir);

    const { createStandaloneApp } = await import('./server/app.js');

    // Гибридный режим: сервер стартует «холодным» (без блокирующего device flow).
    // Подключение к удалённому backend происходит в рантайме:
    //   - тихое connectFromSaved после listen (если credentials сохранены);
    //   - иначе пользователь логинится в UI (POST /auth/login) или используется
    //     API-ключ (--token), когда он задан.
    const remoteEnabled = synth.remote.enabled && !!synth.remote.backendUrl;
    const remoteBackendUrl = synth.remote.backendUrl.replace(/\/+$/, '');
    // OIDC-fallback (issuer/client_id) передаём и без --connect: сервер стартует
    // без известного адреса, пользователь вводит адрес в UI (POST /auth/login),
    // а дискавери при недоступности /auth/oidc-meta падает на эти параметры.
    // Флаги приоритетнее config.yaml (в секцию remote они не мержатся без --connect).
    const remoteIssuer = options.oidcIssuer || synth.remote.auth.issuer;
    const remoteClientId = options.oidcClientId || synth.remote.auth.clientId;
    const oidcFallbackGiven = !!(remoteIssuer || remoteClientId);
    // Гибрид «включён»: remote.enabled в config.yaml (с адресом или без) ИЛИ
    // задан OIDC-fallback (--oidc-issuer/--oidc-client-id). Даже без известного
    // адреса серверной части это гибрид — адрес вводится в UI (поле «Адрес сервера»).
    const hybridEnabled = synth.remote.enabled || oidcFallbackGiven;

    const uiPath = options.ui || undefined;

    // ADR-069 §9.2: `--ignore-rules`/`--safe-mode` (или env SYNTH_IGNORE_RULES) —
    // нейтральная сессия без проектных инструкций. Конфиг не мутируем.
    const ignoreRules = resolveIgnoreRules(!!(options.ignoreRules || options.safeMode), process.env);

    // ADR-079: credentials — явный --credentials > config > home-относительный;
    // profiles — явный --profiles > home-относительный (иначе XDG-дефолт).
    const credentialsPath =
      options.credentials || synth.remote.credentialsPath || (home ? resolveCredentialsPath(home) : undefined);
    const profilesPath = options.profiles || resolveProfilesPath(home);

    const appHandle = await createStandaloneApp({
      port,
      dataDir,
      apiKey,
      workspacesRoot: resolveWorkspacesRoot(synth, undefined, home),
      defaultWorkingDir: resolveDefaultWorkspace(synth, undefined, home),
      maxUploadBytes: resolveMaxUploadBytes(synth),
      uiDistPath: uiPath,
      permissionConfig: synth.permission,
      defaultPlanMode: synth.session?.planMode,
      securityConfig: synth.security,
      // ADR-076: мастер-ключ шифрования SSH-ключей (env > config > file в dataDir).
      secretKey: resolveSecretKey(synth, process.env),
      gatewayConfig: synth.llmGateway,
      llmCachePolicy: synth.llm.cache,
      // ADR-089: дефолтные provider/model инстанса — для сессий из внешних событий
      // (materialize ephemeral/bind), когда явная модель не задана.
      llmDefaults: { provider: synth.llm.defaultProvider, model: synth.llm.defaultModel },
      toolsPolicy: synth.tools.policy,
      mcpPolicy: synth.mcp?.policy,
      toolsDisabled: synth.tools.disabled,
      // ADR-075: политика для абсолютного workspace вне root (env > config > 'confirm').
      workspaceOutsideRootPolicy: resolveWorkspaceOutsideRootPolicy(synth) || 'confirm',
      mcpServers: synth.mcp?.servers ?? {},
      // ADR-046: конфигурация скиллов (paths/trustedProjectDirs/inlineShell).
      skillsConfig: synth.skills,
      // ADR-046 §7: конфигурация slash-команд (paths/bundlesPath/conflict/лимиты).
      commandsConfig: synth.commands,
      // ADR-069 Фаза 1: конфигурация проектных инструкций (AGENTS.md).
      // ADR-069 §9.2: ignore-rules/safe-mode → enabled=false (без мутации конфига).
      instructionsConfig: ignoreRules ? { ...synth.instructions, enabled: false } : synth.instructions,
      // ADR-089: конфигурация приёма внешних событий (allowedSources/ephemeralTtl).
      eventsConfig: synth.events,
      // ADR-051 (срез) / ADR-089: конфигурация планировщика (enabled/tickSec).
      schedulerConfig: synth.scheduler,
      // ADR-084: конфигурация decision-слоя микро-каскада.
      decisionConfig: synth.decision,
      // ADR-052 (этап II): конфигурация исходящих webhooks (enabled/retry/SSRF).
      webhooksConfig: synth.webhooks,
      defaultBackendUrl: remoteEnabled ? remoteBackendUrl : undefined,
      defaultToken: remoteEnabled && synth.remote.auth.type === 'api_key'
        ? (synth.remote.auth.apiKey || undefined)
        : undefined,
      hybridEnabled,
      remoteAuth: remoteEnabled || oidcFallbackGiven
        ? {
            issuer: remoteIssuer || undefined,
            clientId: remoteClientId || undefined,
            credentialsPath,
          }
        : undefined,
      remoteLlm: synth.remote.llm,
      remoteTimeoutMs: synth.remote.timeoutMs,
      remoteCredentialsPath: credentialsPath,
      profilesPath,
    });
    const { server, wss } = appHandle;

    let shuttingDown = false;

    async function gracefulShutdown(signal: string): Promise<void> {
      if (shuttingDown) return;
      shuttingDown = true;
      console.log(`\n[Shutdown] Получен сигнал ${signal}, завершаю...`);

      // Гибрид: закрыть SSE-стрим к удалённому backend, отменить реконнект.
      await appHandle.disconnectRemote?.().catch(() => {});
      appHandle.remoteEventBridge?.stop();

      // ADR-089: остановить авто-архивацию ephemeral-сессий.
      appHandle.stopEphemeralSweeper?.();

      // ADR-089: остановить retention-очистку журнала событий.
      appHandle.stopEventJournalPruner?.();

      // ADR-052 (этап II): остановить движок webhooks и retention-очистку доставок.
      appHandle.stopWebhookService?.();
      appHandle.stopWebhookDeliveryPruner?.();

      // ADR-051 (срез): остановить планировщик расписаний.
      appHandle.stopScheduler?.();

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
      console.log(`  API-ключ: ${apiKey.slice(0, 8)}...`);
      if (remoteEnabled) {
        console.log(`  Удалённый backend: ${remoteBackendUrl}. Если сервер не подключён — войдите в UI (адрес сервера + логин/пароль).`);
      }

      // Гибрид: тихое подключение после старта (best-effort, без интерактива).
      // При --token (api_key) предпочитаем сохранённые credentials, иначе — API-ключ.
      if (remoteEnabled) {
        void (async () => {
          try {
            if (synth.remote.auth.type === 'api_key' && synth.remote.auth.apiKey) {
              const saved = await appHandle.connectRemoteFromSaved?.(remoteBackendUrl).catch(() => null);
              if (!saved) {
                await appHandle.connectRemoteWithApiKey?.(remoteBackendUrl, synth.remote.auth.apiKey);
              }
            } else {
              await appHandle.connectRemoteFromSaved?.(remoteBackendUrl);
            }
          } catch {
            // тихо: сервер недоступен / credentials не подошли — пользователь войдёт в UI
          }
        })();
      }

      checkForUpdatesBackground(dataDir, (info) => {
        console.log(`\n  Доступна новая версия ${info.latestVersion} (текущая: ${info.currentVersion})`);
        console.log(`  Выполните synth update --apply для обновления.`);
      });
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
  .option('--home <path>', 'локальный home-каталог (config/data/profiles/credentials)')
  .option('--credentials <path>', 'путь к файлу credentials (переопределяет home)')
  .action(async (options) => {
    const home = resolveHome(options.home);
    const synth = await loadConfig({ configPath: options.config, home: home ?? undefined });
    const credentialsPath =
      options.credentials || synth.remote.credentialsPath || (home ? resolveCredentialsPath(home) : undefined);
    const { RemoteSession } = await import('./remote/session.js');

    const session = await RemoteSession.ensureAuthenticated(
      {
        backendUrl: options.backend,
        authType: options.token ? 'api_key' : 'device',
        apiKey: options.token ?? '',
        issuer: options.oidcIssuer ?? synth.remote.auth.issuer,
        clientId: options.oidcClientId ?? synth.remote.auth.clientId,
        credentialsPath,
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
  .option('--home <path>', 'локальный home-каталог (config/data/profiles/credentials)')
  .option('--credentials <path>', 'путь к файлу credentials (переопределяет home)')
  .action(async (options) => {
    const home = resolveHome(options.home);
    const synth = await loadConfig({ configPath: options.config, home: home ?? undefined });
    const credentialsPath =
      options.credentials || synth.remote.credentialsPath || (home ? resolveCredentialsPath(home) : undefined);
    const { clearCredentials } = await import('./remote/credentials.js');
    await clearCredentials(options.backend, credentialsPath);
    console.log(`Отключено: ${options.backend} (credentials удалены)`);
  });

/** Общая аутентификация к удалённому backend для команд publish/fork. */
async function ensureRemoteSession(options: Record<string, unknown>, synth: SynthConfig, home?: string | null) {
  const { RemoteSession } = await import('./remote/session.js');
  const backendUrl = (options.remote as string | undefined) || synth.remote.backendUrl;
  if (!backendUrl) {
    console.error('Ошибка: не указан URL удалённого backend. Используйте --remote <url> или remote.backendUrl в config.yaml.');
    process.exit(1);
  }
  const credentialsPath =
    (options.credentials as string | undefined) || synth.remote.credentialsPath || (home ? resolveCredentialsPath(home) : undefined);
  const session = await RemoteSession.ensureAuthenticated(
    {
      backendUrl,
      authType: (options.token as string | undefined) ? 'api_key' : (synth.remote.auth.type || 'device'),
      apiKey: (options.token as string | undefined) || synth.remote.auth.apiKey || '',
      issuer: (options.oidcIssuer as string | undefined) || synth.remote.auth.issuer,
      clientId: (options.oidcClientId as string | undefined) || synth.remote.auth.clientId,
      credentialsPath,
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
  .option('--home <path>', 'локальный home-каталог (config/data/profiles/credentials)')
  .option('--credentials <path>', 'путь к файлу credentials (переопределяет home)')
  .option('--oidc-issuer <url>', 'OIDC issuer для device flow')
  .option('--oidc-client-id <id>', 'OIDC client_id для device flow')
  .option('--token <key>', 'API-ключ для аутентификации')
  .action(async (projectId, options) => {
    const home = resolveHome(options.home);
    const synth = await loadConfig({ configPath: options.config, home: home ?? undefined });
    const dataDir = resolve((options.dataDir as string | undefined) || resolveDataDir(synth, undefined, home));
    await ensureDataDir(dataDir);

    const { ProjectStore } = await import('./storage/project-store.js');
    const { FileStore } = await import('./storage/file-store.js');
    const { SessionManager } = await import('./sessions/manager.js');
    const { syncProjectToRemote, resolveLocalWorkspace } = await import('./remote/transfer.js');

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
    const workspacesRoot = options.dataDir ? join(dataDir, 'workspaces') : resolveWorkspacesRoot(synth, undefined, home);
    const defaultWorkingDir = options.dataDir ? join(dataDir, 'workspaces', 'default') : resolveDefaultWorkspace(synth, undefined, home);
    const localProjectDir = resolveLocalWorkspace(
      project,
      workspacesRoot,
      defaultWorkingDir,
    );

    const session = await ensureRemoteSession(options, synth, home);
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
  .option('--home <path>', 'локальный home-каталог (config/data/profiles/credentials)')
  .option('--credentials <path>', 'путь к файлу credentials (переопределяет home)')
  .option('--oidc-issuer <url>', 'OIDC issuer для device flow')
  .option('--oidc-client-id <id>', 'OIDC client_id для device flow')
  .option('--token <key>', 'API-ключ для аутентификации')
  .action(async (remoteProjectId, options) => {
    const home = resolveHome(options.home);
    const synth = await loadConfig({ configPath: options.config, home: home ?? undefined });
    const dataDir = resolve((options.dataDir as string | undefined) || resolveDataDir(synth, undefined, home));
    await ensureDataDir(dataDir);

    const { ProjectStore } = await import('./storage/project-store.js');
    const { FileStore } = await import('./storage/file-store.js');
    const { SessionManager } = await import('./sessions/manager.js');
    const { forkProjectToLocal } = await import('./remote/transfer.js');

    const session = await ensureRemoteSession(options, synth, home);
    const remoteClient = session.getClient();

    console.log(`Fork проекта ${remoteProjectId} ← ${session.backendUrl}`);
    const stats = await forkProjectToLocal({
      remoteProjectId,
      remoteClient,
      localProjectStore: new ProjectStore({ dataDir }),
      localSessionManager: new SessionManager(new FileStore({ dataDir })),
      includeFiles: !options.noFiles,
      includeSessions: !options.noSessions,
      localWorkspacesRoot: options.dataDir ? join(dataDir, 'workspaces') : resolveWorkspacesRoot(synth, undefined, home),
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
  .option('--agent <agent>', 'агент')
  .option('--config <path>', 'путь к config.yaml')
  .option('--data-dir <path>', 'каталог данных')
  .option('--api-key <key>', 'API-ключ провайдера')
  .option('--ignore-rules', 'не грузить проектные инструкции (AGENTS.md) — нейтральная сессия')
  .option('--safe-mode', 'безопасный режим: проектные инструкции не грузятся')
  .action(async (message, options) => {
    // Если нет сообщения — интерактивный режим
    if (!message) {
      console.log('Интерактивный режим (введите "exit" для выхода)');
      await startRepl(options);
      return;
    }

    const synth = await loadConfig({ configPath: options.config });
    const dataDir = resolve(options.dataDir || resolveDataDir(synth));
    await ensureDataDir(dataDir);

    checkForUpdatesBackground(dataDir, (info) => {
      console.log(`\n  Доступна новая версия ${info.latestVersion} (текущая: ${info.currentVersion})`);
      console.log(`  Выполните synth update --apply для обновления.\n`);
    });

    const { runSingleChat } = await import('./server/chat.js');
    await runSingleChat({
      message,
      model: options.model,
      provider: options.provider,
      agent: options.agent,
      dataDir,
      config: synth,
      // ADR-069 §9.2: ignore-rules/safe-mode → instructions.enabled=false.
      instructionsConfig: resolveIgnoreRules(!!(options.ignoreRules || options.safeMode), process.env)
        ? { ...synth.instructions, enabled: false }
        : synth.instructions,
    });
  });

program
  .command('config')
  .description('Управление конфигурацией')
  .addCommand(
    new Command('show')
      .description('Показать текущую конфигурацию')
      .option('--config <path>', 'путь к config.yaml')
      .action(async (options) => {
        const synth = await loadConfig({ configPath: options.config });
        console.log(JSON.stringify(synth, null, 2));
      }),
  )
  .addCommand(
    new Command('provider')
      .description('Управление провайдерами')
      .addCommand(
        new Command('add')
          .description('Добавить провайдера')
          .requiredOption('--name <name>', 'имя провайдера')
          .requiredOption('--type <type>', 'тип (openai, anthropic, ollama, decision, systemone)')
          .option('--api-key <key>', 'API-ключ')
          .option('--url <url>', 'базовый URL')
          .option('--model <model>', 'модель по умолчанию')
          .option('--num-ctx <n>', 'размер контекста (num_ctx Ollama), целое > 0')
          .option('--data-dir <path>', 'каталог данных')
          .action(async (options) => {
            const synth = await loadConfig({});
            const dataDir = resolve(options.dataDir || resolveDataDir(synth));
            await ensureDataDir(dataDir);

            const { JsonStore } = await import('./storage/json-store.js');
            const store = new JsonStore<{ name: string; type: string; baseUrl?: string; apiKey?: string; defaultModel?: string; timeout?: number; enabled?: boolean; icon?: string; numCtx?: number }>({ dataDir, subdir: 'providers' });

            const parsedNumCtx = options.numCtx === undefined ? undefined : Number(options.numCtx);
            if (parsedNumCtx !== undefined && (!Number.isInteger(parsedNumCtx) || parsedNumCtx <= 0)) {
              console.error('--num-ctx должен быть целым числом > 0');
              process.exit(1);
            }

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
              numCtx: parsedNumCtx ?? existing?.numCtx,
            };
            await store.save(options.name, provider);
            console.log(`Провайдер "${options.name}" сохранён (${existing ? 'обновлён' : 'создан'})`);
          }),
      )
      .addCommand(
        new Command('list')
          .description('Список провайдеров')
          .option('--data-dir <path>', 'каталог данных')
          .action(async (options) => {
            const synth = await loadConfig({});
            const dataDir = resolve(options.dataDir || resolveDataDir(synth));
            await ensureDataDir(dataDir);

            const { JsonStore } = await import('./storage/json-store.js');
            const store = new JsonStore<{ name: string; type: string; enabled?: boolean; defaultModel?: string }>({ dataDir, subdir: 'providers' });
            const providers = await store.list();
            for (const p of providers) {
              console.log(`  ${p.name} (${p.type})${p.enabled === false ? ' [отключён]' : ''}${p.defaultModel ? ` → ${p.defaultModel}` : ''}`);
            }
            if (providers.length === 0) {
              console.log('  (нет провайдеров)');
            }
          }),
      )
      .addCommand(
        new Command('delete')
          .description('Удалить провайдера')
          .argument('<name>', 'имя провайдера')
          .option('--data-dir <path>', 'каталог данных')
          .action(async (name, options) => {
            const synth = await loadConfig({});
            const dataDir = resolve(options.dataDir || resolveDataDir(synth));
            await ensureDataDir(dataDir);

            const { JsonStore } = await import('./storage/json-store.js');
            const store = new JsonStore<unknown>({ dataDir, subdir: 'providers' });
            if (!(await store.exists(name))) {
              console.log(`Провайдер "${name}" не найден`);
              process.exit(1);
            }
            await store.delete(name);
            console.log(`Провайдер "${name}" удалён`);
          }),
      ),
  );

async function startRepl(options: Record<string, unknown>) {
  const readline = await import('node:readline');
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: '> ',
  });

  const synth = await loadConfig({ configPath: options.config as string });
  const dataDir = resolve((options['data-dir'] as string) || resolveDataDir(synth));
  await ensureDataDir(dataDir);

  const { runSingleChat } = await import('./server/chat.js');

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
      // ADR-069 §9.2: флаги chat пробрасываются и в интерактивный REPL.
      instructionsConfig: resolveIgnoreRules(
        !!(options.ignoreRules ?? options['ignore-rules'] ?? options.safeMode ?? options['safe-mode']),
        process.env,
      )
        ? { ...synth.instructions, enabled: false }
        : synth.instructions,
    });

    rl.prompt();
  }

  rl.close();
  console.log('До свидания!');
}

program
  .command('update')
  .description('Проверить наличие обновлений и установить')
  .option('--apply', 'установить обновление')
  .option('-y, --yes', 'пропустить подтверждение')
  .option('--data-dir <path>', 'каталог данных')
  .action(async (options) => {
    const { checkForUpdates } = await import('./update-checker.js');
    const synth = await loadConfig({});
    const dataDir = resolve(options.dataDir || resolveDataDir(synth));
    await ensureDataDir(dataDir);

    const info = await checkForUpdates(dataDir);

    console.log(`Текущая версия: ${info.currentVersion}`);
    console.log(`Последняя версия: ${info.latestVersion}`);

    if (!info.hasUpdate) {
      console.log('Обновления не найдены.');
      return;
    }

    console.log(`\nДоступна новая версия ${info.latestVersion}!\n`);

    if (!options.apply) {
      console.log('Для установки выполните: synth update --apply');
      return;
    }

    if (!options.yes) {
      const readline = await import('node:readline');
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      const answer = await new Promise<string>((resolve) => {
        rl.question(`Установить @itphx/synth@${info.latestVersion}? [y/N] `, resolve);
      });
      rl.close();
      if (answer.toLowerCase() !== 'y' && answer.toLowerCase() !== 'yes' && answer.toLowerCase() !== 'д' && answer.toLowerCase() !== 'да') {
        console.log('Отменено.');
        return;
      }
    }

    console.log(`Установка @itphx/synth@${info.latestVersion}...\n`);

    const child = spawn('npm', ['install', '-g', `@itphx/synth@${info.latestVersion}`], {
      stdio: 'inherit',
      env: { ...process.env },
    });

    child.on('close', (code) => {
      if (code === 0) {
        console.log('\nОбновление установлено. Перезапустите synth serve.');
      } else {
        console.log(`\nОшибка установки (код ${code})`);
        process.exit(1);
      }
    });
  });

program
  .command('session')
  .description('Управление сессиями')
  .addCommand(
    new Command('list')
      .description('Список сессий')
      .option('--config <path>', 'путь к config.yaml')
      .option('--data-dir <path>', 'каталог данных')
      .action(async (options) => {
        const synth = await loadConfig({ configPath: options.config });
        const dataDir = resolve(options.dataDir || resolveDataDir(synth));
        await ensureDataDir(dataDir);

        const { FileStore } = await import('./storage/file-store.js');
        const { SessionManager } = await import('./sessions/manager.js');

        const store = new FileStore({ dataDir });
        const manager = new SessionManager(store);
        const sessions = await manager.listSessions();

        if (sessions.length === 0) {
          console.log('Нет сессий.');
          return;
        }

        console.log(`ID                                    Название                              Сообщений  Последняя активность`);
        console.log('─'.repeat(120));
        for (const s of sessions) {
          const title = (s.title || sm('session.default_title')).substring(0, 38).padEnd(38);
          const msgCount = String(s.messages.length).padStart(9);
          const updated = s.updatedAt?.substring(0, 19) || '-';
          const parent = s.parentId ? ` [fork от ${s.parentId.substring(0, 12)}...]` : '';
          console.log(`${s.id.padEnd(38)} ${title} ${msgCount}  ${updated}${parent}`);
        }
      }),
  )
  .addCommand(
    new Command('rename')
      .description('Переименовать сессию')
      .argument('<sessionId>', 'ID сессии')
      .argument('<title>', 'новый заголовок')
      .option('--config <path>', 'путь к config.yaml')
      .option('--data-dir <path>', 'каталог данных')
      .action(async (sessionId, title, options) => {
        const synth = await loadConfig({ configPath: options.config });
        const dataDir = resolve(options.dataDir || resolveDataDir(synth));
        await ensureDataDir(dataDir);

        const { FileStore } = await import('./storage/file-store.js');
        const { SessionManager } = await import('./sessions/manager.js');

        const store = new FileStore({ dataDir });
        const manager = new SessionManager(store);
        await manager.renameSession(sessionId, title);
        console.log(`Сессия ${sessionId} переименована в "${title}"`);
      }),
  )
  .addCommand(
    new Command('fork')
      .description('Создать ответвление (fork) сессии')
      .argument('<sessionId>', 'ID исходной сессии')
      .option('--index <n>', 'позиция сообщения в массиве — точка развилки')
      .option('--message <id>', 'ID сообщения — точка развилки')
      .option('--title <title>', 'заголовок новой сессии')
      .option('--config <path>', 'путь к config.yaml')
      .option('--data-dir <path>', 'каталог данных')
      .action(async (sessionId, options) => {
        const synth = await loadConfig({ configPath: options.config });
        const dataDir = resolve(options.dataDir || resolveDataDir(synth));
        await ensureDataDir(dataDir);

        const { FileStore } = await import('./storage/file-store.js');
        const { SessionManager } = await import('./sessions/manager.js');

        const store = new FileStore({ dataDir });
        const manager = new SessionManager(store);
        const fork = await manager.forkSession(sessionId, {
          messageId: options.message,
          messageIndex: options.index != null ? Number(options.index) : undefined,
          title: options.title,
        });
        console.log(`Создана сессия-форк: ${fork.id} "${fork.title}"`);
      }),
  )
  .addCommand(
    new Command('children')
      .description('Показать дочерние сессии')
      .argument('<sessionId>', 'ID родительской сессии')
      .option('--config <path>', 'путь к config.yaml')
      .option('--data-dir <path>', 'каталог данных')
      .action(async (sessionId, options) => {
        const synth = await loadConfig({ configPath: options.config });
        const dataDir = resolve(options.dataDir || resolveDataDir(synth));
        await ensureDataDir(dataDir);

        const { FileStore } = await import('./storage/file-store.js');
        const { SessionManager } = await import('./sessions/manager.js');

        const store = new FileStore({ dataDir });
        const manager = new SessionManager(store);
        const children = await manager.getChildren(sessionId);

        if (children.length === 0) {
          console.log('Нет дочерних сессий.');
          return;
        }

        console.log(`ID                                    Название                              Сообщений`);
        console.log('─'.repeat(90));
        for (const c of children) {
          const title = (c.title || sm('session.default_title')).substring(0, 38).padEnd(38);
          const msgCount = String(c.messages.length).padStart(9);
          console.log(`${c.id.padEnd(38)} ${title} ${msgCount}`);
        }
      }),
  )
  .addCommand(
    new Command('ref')
      .description('Добавить ссылку на сессию в другую сессию')
      .argument('<sourceSessionId>', 'ID исходной сессии (может включать :seqRange)')
      .option('--to <targetId>', 'ID целевой сессии (куда добавить ссылку)')
      .option('--label <label>', 'метка для ссылки')
      .option('--range <from>,<to>', 'диапазон сообщений (seq from,to)')
      .option('--summarize', 'сгенерировать авто-саммари')
      .option('--config <path>', 'путь к config.yaml')
      .option('--data-dir <path>', 'каталог данных')
      .action(async (arg, options) => {
        const synth = await loadConfig({ configPath: options.config });
        const dataDir = resolve(options.dataDir || resolveDataDir(synth));
        await ensureDataDir(dataDir);

        const { FileStore } = await import('./storage/file-store.js');
        const { SessionManager } = await import('./sessions/manager.js');

        let sourceSessionId = arg;
        let seqRange: [number, number] | undefined;

        const colonIdx = sourceSessionId.indexOf(':');
        if (colonIdx >= 0) {
          const rangeStr = sourceSessionId.slice(colonIdx + 1);
          sourceSessionId = sourceSessionId.slice(0, colonIdx);
          const parts = rangeStr.split('..');
          if (parts.length === 2) {
            seqRange = [parseInt(parts[0]!), parseInt(parts[1]!)];
          }
        }

        if (options.range) {
          const parts = String(options.range).split(',');
          if (parts.length === 2) {
            seqRange = [parseInt(parts[0]!), parseInt(parts[1]!)];
          }
        }

        const targetId = options.to;
        if (!targetId) {
          console.error('Ошибка: укажите --to <targetSessionId>');
          process.exit(1);
        }

        const store = new FileStore({ dataDir });
        const manager = new SessionManager(store);
        const ref = await manager.addReference(targetId, sourceSessionId, {
          label: options.label,
          messageRange: seqRange,
          autoSummarize: !!options.summarize,
        });
        console.log(`Ссылка добавлена: session_id=${ref.sessionId}, range=[${ref.messageRange[0]}, ${ref.messageRange[1]}]`);
      }),
  )
  .addCommand(
    new Command('merge')
      .description('Скопировать сообщения из одной сессии в другую')
      .argument('<sourceSessionId>', 'ID исходной сессии (может включать :seqRange)')
      .option('--to <targetId>', 'ID целевой сессии (куда копировать)')
      .option('--position <pos>', 'позиция вставки: after (по умолчанию) или before', 'after')
      .option('--anchor <messageId>', 'ID сообщения-якоря (после/перед которым вставить)')
      .option('--range <from>,<to>', 'диапазон сообщений (seq from,to)')
      .option('--summarize', 'сжать сообщения перед вставкой')
      .option('--config <path>', 'путь к config.yaml')
      .option('--data-dir <path>', 'каталог данных')
      .action(async (arg, options) => {
        const synth = await loadConfig({ configPath: options.config });
        const dataDir = resolve(options.dataDir || resolveDataDir(synth));
        await ensureDataDir(dataDir);

        const { FileStore } = await import('./storage/file-store.js');
        const { SessionManager } = await import('./sessions/manager.js');

        let sourceSessionId = arg;
        let seqRange: [number, number] | undefined;

        const colonIdx = sourceSessionId.indexOf(':');
        if (colonIdx >= 0) {
          const rangeStr = sourceSessionId.slice(colonIdx + 1);
          sourceSessionId = sourceSessionId.slice(0, colonIdx);
          const parts = rangeStr.split('..');
          if (parts.length === 2) {
            seqRange = [parseInt(parts[0]!), parseInt(parts[1]!)];
          }
        }

        if (options.range) {
          const parts = String(options.range).split(',');
          if (parts.length === 2) {
            seqRange = [parseInt(parts[0]!), parseInt(parts[1]!)];
          }
        }

        const targetId = options.to;
        if (!targetId) {
          console.error('Ошибка: укажите --to <targetSessionId>');
          process.exit(1);
        }

        const store = new FileStore({ dataDir });
        const manager = new SessionManager(store);

        const sourceSession = await manager.getSession(sourceSessionId);
        if (!sourceSession) {
          console.error(`Ошибка: исходная сессия ${sourceSessionId} не найдена`);
          process.exit(1);
        }

        const finalRange: [number, number] = seqRange || [1, sourceSession.messages.length];

        const merged = await manager.mergeMessages(targetId, sourceSessionId, {
          sourceRange: finalRange,
          position: options.position === 'before' ? 'before' : 'after',
          anchorMessageId: options.anchor,
          summarize: !!options.summarize,
        });
        console.log(`Скопировано ${merged.length} сообщений из сессии ${sourceSessionId} в ${targetId}`);
      }),
  );

program
  .command('audit')
  .description('Просмотр аудита LLM Gateway (ADR-036)')
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
    const dataDir = resolve(options.dataDir || resolveDataDir(synth));
    await ensureDataDir(dataDir);

    const logPath = synth.llmGateway.audit.logPath || join(dataDir, 'audit', 'llm-gateway.jsonl');

    const tail = options.tail != null ? parseInt(options.tail, 10) : NaN;
    const limitOpt = options.limit != null ? parseInt(options.limit, 10) : NaN;
    const limit = Number.isFinite(tail) ? tail : (Number.isFinite(limitOpt) ? limitOpt : 20);

    const { readAuditLog } = await import('./engine/gateway/index.js');
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

program
  .command('secrets')
  .description('Управление секретами шифрования (ADR-076)')
  .addCommand(
    new Command('rotate')
      .description('Перешифровать SSH-ключи новым мастер-ключом (one-shot)')
      .option('--data-dir <path>', 'каталог данных')
      .option('--config <path>', 'путь к config.yaml')
      .option('--home <path>', 'локальный home-каталог (config/data/profiles/credentials)')
      .option('--old-key <key>', 'явный старый мастер-ключ (base64 32Б / hex 64)')
      .option('--old-key-file <path>', 'файл со старым мастер-ключом')
      .option('--new-key <key>', 'явный новый мастер-ключ (по умолчанию — сгенерировать)')
      .option('--new-key-file <path>', 'файл с новым мастер-ключом')
      .option('--dry-run', 'предпросмотр без записи')
      .option('--yes', 'подтвердить необратимую операцию (обязательно без --dry-run)')
      .action(async (options) => {
        const home = resolveHome(options.home);
        const synth = await loadConfig({ configPath: options.config, home: home ?? undefined });
        const dataDir = resolve(options.dataDir || resolveDataDir(synth, undefined, home));
        const dryRun = !!options.dryRun;

        if (!dryRun && !options.yes) {
          console.error(
            'Ошибка: ротация мастер-ключа необратима. Повторите с --yes либо используйте --dry-run для предпросмотра.',
          );
          process.exit(1);
        }

        try {
          const { rotateSecretsMasterKey } = await import('./security/rotate.js');
          const result = await rotateSecretsMasterKey({
            dataDir,
            oldKey: options.oldKey,
            oldKeyFile: options.oldKeyFile,
            newKey: options.newKey,
            newKeyFile: options.newKeyFile,
            secretKey: resolveSecretKey(synth, process.env),
            env: process.env,
            dryRun,
          });

          console.log(`${dryRun ? '[dry-run] ' : ''}Ротация мастер-ключа SSH-ключей (${dataDir})`);
          console.log(`  всего записей: ${result.total}`);
          console.log(`  перешифровано: ${result.rotated}`);
          console.log(`  апгрейд plaintext: ${result.upgraded}`);
          console.log(`  пропущено (уже новый ключ): ${result.skipped}`);
          if (result.ids.length > 0) console.log(`  id: ${result.ids.join(', ')}`);
          for (const warning of result.warnings) console.warn(`  Предупреждение: ${warning}`);
          if (dryRun) console.log('  (dry-run: изменения не записаны)');
        } catch (err) {
          console.error(`Ошибка ротации: ${err instanceof Error ? err.message : String(err)}`);
          process.exit(1);
        }
      }),
  );

program
  .command('migrate')
  .description('Применить миграции схемы данных инстанса (PROP-092)')
  .option('--data-dir <path>', 'каталог данных')
  .option('--config <path>', 'путь к config.yaml')
  .option('--home <path>', 'локальный home-каталог (config/data/profiles/credentials)')
  .option('--dry-run', 'показать план миграций без записи')
  .option('--yes', 'подтвердить необратимую миграцию (обязательно без --dry-run)')
  .action(async (options) => {
    const home = resolveHome(options.home);
    const synth = await loadConfig({ configPath: options.config, home: home ?? undefined });
    const dataDir = resolve(options.dataDir || resolveDataDir(synth, undefined, home));

    const { runMigrateCommand } = await import('./maintenance/migrate.js');
    const code = await runMigrateCommand({
      dataDir,
      dryRun: !!options.dryRun,
      yes: !!options.yes,
    });
    if (code !== 0) process.exit(code);
  });

program
  .command('doctor')
  .description('Проверить состояние инстанса (health, данные, ключи, провайдеры) — PROP-091')
  .option('--data-dir <path>', 'каталог данных')
  .option('--config <path>', 'путь к config.yaml')
  .option('--home <path>', 'локальный home-каталог (config/data/profiles/credentials)')
  .option('--json', 'вывод в JSON')
  .action(async (options) => {
    const home = resolveHome(options.home);
    const synth = await loadConfig({ configPath: options.config, home: home ?? undefined });
    const dataDir = resolve(options.dataDir || resolveDataDir(synth, undefined, home));

    const { runDoctorCommand } = await import('./maintenance/doctor.js');
    const code = await runDoctorCommand({
      dataDir,
      secretKey: resolveSecretKey(synth, process.env),
      configSecretKey: synth.security.secretKey,
      env: process.env,
      json: !!options.json,
    });
    if (code !== 0) process.exit(code);
  });

program.parse();
