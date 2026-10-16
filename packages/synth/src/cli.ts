import { Command } from 'commander';
import { createRequire } from 'node:module';
import { join, dirname, resolve } from 'node:path';
import { loadConfig, resolveDataDir, resolvePort, resolveDefaultWorkspace, resolveWorkspacesRoot, resolveSecretKey, resolveHome, resolveProfilesPath, resolveCredentialsPath, resolveIgnoreRules, resolveMaxUploadBytes, defaultConfig, ensureFirstRun, ensureDataDir, SYNTH_VERSION } from '@itphx/synth-shared';
import type { SynthConfig } from '@itphx/synth-shared';
import { createStandaloneApp } from '@itphx/synth-core/server/app.js';
import { runSingleChat } from '@itphx/synth-core/server/chat.js';
import { JsonStore } from '@itphx/synth-core/storage/json-store.js';
import { getLastProfile, ensureProfile, resolveOrCreateLocalApiKey } from '@itphx/synth-core';

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
  .description('AI-платформа для командной работы')
  .version(SYNTH_VERSION);

program
  .command('serve')
  .description('Запустить HTTP API сервер')
  .option('--port <number>', 'порт сервера', String(defaultConfig.core.port))
  .option('--host <host>', 'адрес для прослушивания', process.env.SYNTH_HOST || '127.0.0.1')
  .option('--api-key <key>', 'API-ключ для аутентификации')
  .option('--data-dir <path>', 'каталог данных')
  .option('--config <path>', 'путь к config.yaml')
  .option('--home <path>', 'локальный home-каталог (config/data/profiles/credentials)')
  .option('--profiles <path>', 'путь к реестру профилей серверов (переопределяет home)')
  .option('--credentials <path>', 'путь к файлу credentials (переопределяет home)')
  .option('--connect <url>', 'URL удалённого backend (гибридный режим)')
  .option('--no-auto-profile', 'не подключаться автоматически к последнему профилю (нейтральный запуск)')
  .option('--oidc-issuer <url>', 'OIDC issuer — fallback дискавери для входа в UI (гибридный режим)')
  .option('--oidc-client-id <id>', 'OIDC client_id — fallback дискавери для входа в UI (гибридный режим)')
  .option('--token <key>', 'API-ключ для аутентификации на удалённом backend (гибридный режим)')
  .option('--ignore-rules', 'не грузить проектные инструкции (AGENTS.md) — нейтральная сессия')
  .option('--safe-mode', 'безопасный режим: проектные инструкции не грузятся')
  .action(async (options) => {
    // Единый каталог данных локального мира — НЕ зависит от удалённого сервера.
    // Профили серверов (profiles.json) остаются мета-реестром для UX (известные
    // серверы/lastServer), все runtime-данные лежат в одном dataDir.
    // ADR-079: `--home`/`SYNTH_HOME` задаёт плоскую раскладку (config/data/profiles/credentials),
    // изолируя инстанс от общих XDG-путей.
    const home = resolveHome(options.home);
    const firstRun = await ensureFirstRun(
      options.dataDir || undefined,
      options.config || undefined,
      home,
    );
    const dataDir = firstRun.dataDir;

    // ADR-079: реестр профилей — home-относительный, с точечным --profiles.
    const profilesPath = options.profiles || resolveProfilesPath(home);

    // Источник адреса для тихого авто-входа (defaultBackendUrl):
    //   1. явный --connect url;
    //   2. иначе последний использованный профиль из реестра (если не --no-auto-profile);
    //   3. иначе — нейтральный запуск: адрес вводится в форме входа UI.
    let startupBackendUrl: string | null = options.connect ?? null;
    if (!startupBackendUrl && options.autoProfile) {
      startupBackendUrl = (await getLastProfile(profilesPath))?.url ?? null;
    }
    // При явном --connect согласуем реестр (lastUsedAt/lastProfileId) — best-effort.
    if (options.connect) {
      await ensureProfile(options.connect, {}, profilesPath).catch(() => {});
    }

    const overrides: Partial<SynthConfig> = {
      core: {
        port: parseInt(options.port, 10),
        apiKey: options.apiKey,
      },
      storage: { dataDir, workspacesRoot: '', defaultWorkspace: '', workspaceOutsideRoot: '' },
    };
    if (startupBackendUrl) {
      // deepMerge на рантайме сольёт частичную секцию remote с defaultConfig; тип требует полный RemoteConfig.
      overrides.remote = {
        enabled: true,
        backendUrl: startupBackendUrl,
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

    const port = resolvePort(synth, 'SYNTH_CORE_PORT', synth.core.port);

    // ADR-069 §9.2: `--ignore-rules`/`--safe-mode` (или env SYNTH_IGNORE_RULES) —
    // проектные инструкции не грузятся (конфиг не мутируем).
    const ignoreRules = resolveIgnoreRules(!!(options.ignoreRules || options.safeMode), process.env);

    // Приоритет API-ключа: --api-key/synth.core.apiKey > SYNTH_API_KEY >
    // сохранённый локальный ключ > сгенерировать и сохранить. Пустой ключ в
    // standalone-режиме означает невозможность входа в UI (401), поэтому
    // «npm-пакет + запуск бинарника» обязан получить устойчивый ключ.
    let apiKey = synth.core.apiKey || process.env.SYNTH_API_KEY || '';
    let apiKeyPath: string | null = null;
    let apiKeyCreated = false;
    if (!apiKey) {
      const local = await resolveOrCreateLocalApiKey({ dataDir });
      apiKey = local.key;
      apiKeyPath = local.path;
      apiKeyCreated = local.created;
    }

    // UI поставляется как отдельный npm-пакет @itphx/synth-ui → резолвим его dist/.
    // systemPromptsDir не передаём: @itphx/synth-core резолвит свои prompts сам (рядом с package.json).
    const uiRoot = resolvePackageRoot('@itphx/synth-ui');
    const uiDistPath = uiRoot ? join(uiRoot, 'dist') : undefined;

    // Гибридный режим: сервер стартует «холодным» (без блокирующего device flow).
    // Подключение к удалённому backend происходит в рантайме:
    //   - тихое connectFromSaved после listen (если credentials сохранены);
    //   - иначе пользователь логинится в UI (POST /auth/login) или используется
    //     API-ключ (--token), когда он задан.
    // Источник адреса — --connect или lastProfile (мета-реестр). При нейтральном
    // запуске сохраняем прежнее поведение: remote-секция из config.yaml (если
    // задана) по-прежнему включает авто-подключение к synth.remote.backendUrl.
    // Локальные данные процесса — всегда в едином dataDir (не зависят от сервера).
    const remoteEnabled = !!startupBackendUrl || (synth.remote.enabled && !!synth.remote.backendUrl);
    const remoteBackendUrl = startupBackendUrl ?? synth.remote.backendUrl.replace(/\/+$/, '');
    // OIDC-fallback (issuer/client_id) передаём и без --connect: сервер стартует
    // без известного адреса, пользователь вводит адрес в UI (POST /auth/login),
    // а дискавери при недоступности /auth/oidc-meta падает на эти параметры.
    // Флаги приоритетнее config.yaml (в секцию remote они не мержатся без --connect).
    const remoteIssuer = options.oidcIssuer || synth.remote.auth.issuer;
    const remoteClientId = options.oidcClientId || synth.remote.auth.clientId;
    const oidcFallbackGiven = !!(remoteIssuer || remoteClientId);
    // Гибрид «включён»: remote.enabled в config.yaml (с адресом или без) ИЛИ
    // задан OIDC-fallback (--oidc-issuer/--oidc-client-id). Даже без известного
    // адреса это гибрид — адрес вводится в UI (поле «Адрес сервера»).
    const hybridEnabled = synth.remote.enabled || oidcFallbackGiven;

    // ADR-079: путь credentials — явный --credentials > config (remote.credentialsPath) >
    // home-относительный (<home>/credentials.json); без home — XDG-дефолт.
    const credentialsPath =
      options.credentials || synth.remote.credentialsPath || (home ? resolveCredentialsPath(home) : undefined);

    const appHandle = await createStandaloneApp({
      port,
      dataDir,
      apiKey,
      workspacesRoot: resolveWorkspacesRoot(synth, undefined, home),
      defaultWorkingDir: resolveDefaultWorkspace(synth, undefined, home),
      maxUploadBytes: resolveMaxUploadBytes(synth),
      uiDistPath,
      // ADR-069: конфигурация проектных инструкций (AGENTS.md); при
      // --ignore-rules/--safe-mode — выключена.
      instructionsConfig: ignoreRules ? { ...synth.instructions, enabled: false } : synth.instructions,
      defaultBackendUrl: remoteEnabled ? remoteBackendUrl : undefined,
      defaultToken: remoteEnabled && synth.remote.auth.type === 'api_key'
        ? (synth.remote.auth.apiKey || undefined)
        : undefined,
      hybridEnabled,
      remoteAuth: remoteEnabled || oidcFallbackGiven
        ? {
            issuer: remoteIssuer || undefined,
            clientId: remoteClientId || undefined,
            // credentials — единый мульти-серверный файл (--credentials /
            // synth.remote.credentialsPath / home-относительный), не профильный.
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

      // Гибрид: остановить фоновый watcher живости (иначе успеет переподключиться
      // во время shutdown), закрыть SSE-стрим к удалённому backend.
      appHandle.stopConnectionWatcher?.();
      await appHandle.disconnectRemote?.().catch(() => {});
      appHandle.remoteEventBridge?.stop();

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

    const host = options.host;

    server.listen(port, host, () => {
      console.log(`\n  Откройте http://${host}:${port} в браузере`);
      console.log(`  API-ключ: ${apiKey}`);
      if (apiKeyCreated && apiKeyPath) {
        console.log(`  (сохранён: ${apiKeyPath})`);
      }
      if (remoteEnabled) {
        console.log(`  Удалённый backend: ${remoteBackendUrl}. Если сервер не подключён — войдите в UI (адрес сервера + логин/пароль).`);
      }

      // Фоновый watcher живости гибридного подключения: если backend недоступен
      // на старте или лёг позже — периодически (15 с) проверяет доступность и
      // переподключается по сохранённым credentials; обновляет hybrid/status.
      // Стартует ПОСЛЕ попытки авто-подключения: первый тик watcher немедленный,
      // и если запустить его сразу — он будет гоняться с авто-входом ниже и
      // дублировать HTTP-запросы к backend.
      if (remoteEnabled) {
        // Гибрид: тихое подключение после старта (best-effort, без интерактива).
        // При --token (api_key) предпочитаем сохранённые credentials, иначе — API-ключ.
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
          appHandle.startConnectionWatcher?.();
        })();
      } else {
        // Нейтральный запуск (адрес remote неизвестен): первый тик watcher — no-op
        // (target null), но адрес может появиться в рантайме (config/вход в UI) —
        // держим watcher включённым, чтобы он подхватил его без рестарта.
        appHandle.startConnectionWatcher?.();
      }
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
    const { RemoteSession } = await import('@itphx/synth-core/remote');

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
    const { clearCredentials } = await import('@itphx/synth-core/remote');
    await clearCredentials(options.backend, credentialsPath);
    console.log(`Отключено: ${options.backend} (credentials удалены)`);
  });

/** Общая аутентификация к удалённому backend для команд publish/fork. */
async function ensureRemoteSession(options: Record<string, unknown>, synth: SynthConfig, home?: string | null) {
  const { RemoteSession } = await import('@itphx/synth-core/remote');
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

    const { FileStore, SessionManager, ProjectStore } = await import('@itphx/synth-core');
    const { forkProjectToLocal } = await import('@itphx/synth-core/remote');

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
  .option('--agent <agent>', 'агент (developer, assistant)')
  .option('--data-dir <path>', 'каталог данных')
  .option('--api-key <key>', 'API-ключ провайдера')
  .option('--ignore-rules', 'не грузить проектные инструкции (AGENTS.md) — нейтральная сессия')
  .option('--safe-mode', 'безопасный режим: проектные инструкции не грузятся')
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
      // ADR-069 §9.2: ignore-rules/safe-mode → instructions.enabled=false.
      instructionsConfig: resolveIgnoreRules(!!(options.ignoreRules || options.safeMode), process.env)
        ? { ...synth.instructions, enabled: false }
        : synth.instructions,
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
    const dataDir = resolve(options.dataDir || resolveDataDir(synth));
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
    const dataDir = resolve(options.dataDir || resolveDataDir(synth));
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
    const dataDir = resolve(options.dataDir || resolveDataDir(synth));
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
          const { rotateSecretsMasterKey } = await import('@itphx/synth-core');
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
  .description('Применить миграции схемы данных инстанса (ADR-092)')
  .option('--data-dir <path>', 'каталог данных')
  .option('--config <path>', 'путь к config.yaml')
  .option('--home <path>', 'локальный home-каталог (config/data/profiles/credentials)')
  .option('--dry-run', 'показать план миграций без записи')
  .option('--yes', 'подтвердить необратимую миграцию (обязательно без --dry-run)')
  .action(async (options) => {
    const home = resolveHome(options.home);
    const synth = await loadConfig({ configPath: options.config, home: home ?? undefined });
    const dataDir = resolve((options.dataDir as string | undefined) || resolveDataDir(synth, undefined, home));

    const { runMigrateCommand, createFileStorage } = await import('@itphx/synth-core');
    const code = await runMigrateCommand({
      dataDir,
      dryRun: !!options.dryRun,
      yes: !!options.yes,
      audit: createFileStorage({ dataDir }).maintenanceAudit,
    });
    if (code !== 0) process.exit(code);
  });

program
  .command('update')
  .description('Проверить обновления, установить или откатить пакет (ADR-092)')
  .option('--data-dir <path>', 'каталог данных')
  .option('--config <path>', 'путь к config.yaml')
  .option('--home <path>', 'локальный home-каталог (config/data/profiles/credentials)')
  .option('--apply', 'установить целевую версию (без него — только проверка)')
  .option('--to <version>', 'целевая версия X.Y.Z — обновление или откат')
  .option('--dry-run', 'показать план без установки')
  .option('--yes', 'пропустить подтверждение')
  .option('--json', 'вывод в JSON')
  .action(async (options) => {
    const home = resolveHome(options.home);
    const synth = await loadConfig({ configPath: options.config, home: home ?? undefined });
    const dataDir = resolve((options.dataDir as string | undefined) || resolveDataDir(synth, undefined, home));

    const { runUpdateCommand, createFileStorage } = await import('@itphx/synth-core');
    const code = await runUpdateCommand({
      dataDir,
      to: options.to as string | undefined,
      apply: !!options.apply,
      dryRun: !!options.dryRun,
      yes: !!options.yes,
      json: !!options.json,
      audit: createFileStorage({ dataDir }).maintenanceAudit,
    });
    if (code !== 0) process.exit(code);
  });

program
  .command('doctor')
  .description('Проверить состояние инстанса (health, данные, ключи, провайдеры) — ADR-091')
  .option('--data-dir <path>', 'каталог данных')
  .option('--config <path>', 'путь к config.yaml')
  .option('--home <path>', 'локальный home-каталог (config/data/profiles/credentials)')
  .option('--json', 'вывод в JSON')
  .action(async (options) => {
    const home = resolveHome(options.home);
    const synth = await loadConfig({ configPath: options.config, home: home ?? undefined });
    const dataDir = resolve((options.dataDir as string | undefined) || resolveDataDir(synth, undefined, home));

    const { runDoctorCommand } = await import('@itphx/synth-core');
    const code = await runDoctorCommand({
      dataDir,
      secretKey: resolveSecretKey(synth, process.env),
      configSecretKey: synth.security.secretKey,
      env: process.env,
      json: !!options.json,
    });
    if (code !== 0) process.exit(code);
  });

program
  .command('backup')
  .description('Создать архив каталога данных с манифестом (ADR-091)')
  .option('--out <path>', 'путь к архиву или каталогу (по умолчанию — текущий каталог)')
  .option('--with-secrets', 'включить секреты (secrets/) — архив становится секретом')
  .option('--with-workspace', 'включить рабочие каталоги (workspaces/)')
  .option('--live', 'снять с работающего сервиса (срез не транзакционный)')
  .option('--data-dir <path>', 'каталог данных')
  .option('--config <path>', 'путь к config.yaml')
  .option('--home <path>', 'локальный home-каталог (config/data/profiles/credentials)')
  .action(async (options) => {
    const home = resolveHome(options.home);
    const synth = await loadConfig({ configPath: options.config, home: home ?? undefined });
    const dataDir = resolve(options.dataDir || resolveDataDir(synth, undefined, home));

    const { runBackupCommand, createFileStorage } = await import('@itphx/synth-core');
    const code = await runBackupCommand({
      dataDir,
      out: options.out,
      withSecrets: !!options.withSecrets,
      withWorkspace: !!options.withWorkspace,
      live: !!options.live,
      audit: createFileStorage({ dataDir }).maintenanceAudit,
    });
    if (code !== 0) process.exit(code);
  });

program
  .command('restore')
  .description(
    'Восстановить каталог данных из архива backup — возврат к снимку; workspaces/ сохраняется, если нет в архиве (ADR-091)',
  )
  .argument('<archive>', 'путь к архиву backup')
  .option('--data-dir <path>', 'каталог данных')
  .option('--config <path>', 'путь к config.yaml')
  .option('--home <path>', 'локальный home-каталог (config/data/profiles/credentials)')
  .option('--dry-run', 'проверить архив и показать план без записи')
  .option('--yes', 'подтвердить восстановление (перезапись данных)')
  .option(
    '--no-safety-copy',
    'не создавать страховочную копию данных (откат восстановления станет невозможен)',
  )
  .action(async (archive, options) => {
    const home = resolveHome(options.home);
    const synth = await loadConfig({ configPath: options.config, home: home ?? undefined });
    const dataDir = resolve(options.dataDir || resolveDataDir(synth, undefined, home));

    const { runRestoreCommand, createFileStorage } = await import('@itphx/synth-core');
    const code = await runRestoreCommand({
      archive,
      dataDir,
      dryRun: !!options.dryRun,
      yes: !!options.yes,
      noSafetyCopy: options.safetyCopy === false,
      audit: createFileStorage({ dataDir }).maintenanceAudit,
    });
    if (code !== 0) process.exit(code);
  });

program
  .command('uninstall')
  .description('Удалить инстанс: по умолчанию данные сохраняются, --purge удаляет (ADR-092)')
  .option('--data-dir <path>', 'каталог данных')
  .option('--config <path>', 'путь к config.yaml')
  .option('--home <path>', 'локальный home-каталог (config/data/profiles/credentials)')
  .option('--purge', 'удалить каталог данных (необратимо; требует --yes)')
  .option('--dry-run', 'показать, что будет удалено, без удаления')
  .option('--yes', 'подтвердить необратимое удаление (обязательно без --dry-run)')
  .action(async (options) => {
    const home = resolveHome(options.home);
    const synth = await loadConfig({ configPath: options.config, home: home ?? undefined });
    const dataDir = resolve(options.dataDir || resolveDataDir(synth, undefined, home));

    const { runUninstallCommand, createFileStorage } = await import('@itphx/synth-core');
    const code = await runUninstallCommand({
      dataDir,
      home: home ?? undefined,
      purge: !!options.purge,
      dryRun: !!options.dryRun,
      yes: !!options.yes,
      audit: createFileStorage({ dataDir }).maintenanceAudit,
    });
    if (code !== 0) process.exit(code);
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
