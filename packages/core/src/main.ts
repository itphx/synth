import { Command } from 'commander';
import { loadConfig, resolveDataDir, resolvePort, resolveDefaultWorkspace, resolveWorkspacesRoot, resolveWorkspaceOutsideRootPolicy, resolveSecretKey, resolveStorageBackend, resolvePostgresConfig, resolvePostgresPassword, resolveDegradedMode, resolveStorageFallbackDir, resolveHome, resolveProfilesPath, resolveCredentialsPath, resolveIgnoreRules, resolveMaxUploadBytes, resolveExecutionConfig, ensureDataDir, defaultConfig, SYNTH_VERSION } from '@itphx/synth-shared';
import type { SynthConfig, ResolvedExecutionConfig } from '@itphx/synth-shared';
import { join, resolve } from 'node:path';
import { checkForUpdatesBackground } from './update-checker.js';
import { t as sm } from './engine/system-messages.js';
import { initTlsTrust } from './security/tls.js';
import { configureRestart, resolveRestartMode, RESTART_EXIT_CODE } from './server/restart.js';
import { checkExecutionMode } from './execution/startup.js';
import { setSynthReady } from './metrics/collectors/ready.js';
import { createPluginCliContext, createPluginCommand } from './cli/plugin-commands.js';

const program = new Command();

/**
 * ADR-099: применить единое доверие TLS/CA перед исходящими запросами команды.
 * Fail-closed: битый/отсутствующий CA или недоступный `undici` (при заданном
 * доверии) → внятная ошибка и ненулевой выход (не тихий фоллбэк на недоверенный
 * транспорт). Пустой конфиг — no-op (системное доверие).
 */
async function initTls(
  synth: SynthConfig,
  opts: { home?: string | null; dataDir?: string } = {},
): Promise<void> {
  try {
    const dataDir = opts.dataDir ? resolve(opts.dataDir) : resolveDataDir(synth, undefined, opts.home ?? null);
    await initTlsTrust({ security: synth.security, proxy: synth.proxy }, process.env, { dataDir });
  } catch (err) {
    console.error(
      `Ошибка инициализации доверия TLS/CA: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(1);
  }
}

/**
 * ADR-096: единый контекст хранения для CLI-команд — resolved backend
 * (`file`/`memory`/`postgres`) из конфига инстанса. Хелпер, чтобы не дублировать
 * резолвинг по всем командам (у CLI нет `StandaloneConfig`).
 *
 * `postgresSchemaMode: 'skip'` — не применять миграции схемы при сборке
 * (команды обслуживания управляют схемой сами / работают read-only).
 */
async function buildCliStorage(
  synth: SynthConfig,
  dataDir: string,
  home?: string | null,
  opts?: { postgresSchemaMode?: 'apply' | 'assert' | 'skip' },
) {
  const { buildStorageContext } = await import('./storage/storage-context.js');
  return buildStorageContext({
    dataDir,
    config: synth,
    env: process.env,
    home: home ?? null,
    ...(opts?.postgresSchemaMode ? { postgresSchemaMode: opts.postgresSchemaMode } : {}),
  });
}

/**
 * ADR-077: режим исполнения — **параметр запуска** (инвариант 24: смена режима
 * — только рестартом). Fail-closed:
 * - неизвестное значение `mode`/`failMode` (env/CLI/config) — ошибка с текстом;
 * - `remote` без адресов исполнителей — «требуется хотя бы один адрес»;
 * - `remote` без пакета исполнителя / без читаемого токена — «удалённый режим
 *   недоступен» (старт прерывается, а не «молча уходит в inline»).
 *
 * `inline` (дефолт) — прежнее поведение, ничего не меняется.
 *
 * @returns эффективная секция `execution` — её же получает сборка приложения
 *          (порт исполнения собирается по этому режиму).
 */
async function resolveExecutionStartup(
  synth: SynthConfig,
  cliMode?: string,
): Promise<ResolvedExecutionConfig> {
  let execution: ResolvedExecutionConfig;
  try {
    execution = resolveExecutionConfig(synth, process.env, { mode: cliMode });
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
  const check = await checkExecutionMode(execution);
  if (!check.ok) {
    console.error(check.message);
    process.exit(1);
  }
  return execution;
}

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
  .option(
    '--restart-mode <mode>',
    'graceful restart: disabled (по умолчанию) | process (внешний супервизор) | supervisor (dev.sh)',
  )
  .option(
    '--execution-mode <mode>',
    'топология исполнения: inline (по умолчанию) | remote (ADR-077; удалённый исполнитель ещё не реализован)',
  )
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
      // ADR-096: частичный override — `deepMerge` на рантайме дошлёт дефолты
      // `storage` (`postgres`/`degradedMode`/`fallbackDir`/…); тип требует
      // полную `StorageConfig`, поэтому сужаем кастом (как для `remote` ниже).
      storage: options.dataDir ? ({ dataDir: options.dataDir } as SynthConfig['storage']) : undefined,
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

    // ADR-077: топология исполнения (параметр запуска) — fail-closed на
    // неверном `mode` и на недоступном удалённом исполнителе.
    const execution = await resolveExecutionStartup(synth, options.executionMode);

    const dataDir = resolveDataDir(synth, undefined, home);
    // ADR-099: доверие TLS/CA — до первого исходящего запроса (гибрид/обновления).
    await initTls(synth, { home, dataDir });
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
      // ADR-096: физический backend хранения (env > config.yaml > file).
      storageBackend: resolveStorageBackend(synth, process.env),
      postgresConfig: resolvePostgresConfig(synth, process.env),
      postgresPassword: resolvePostgresPassword({ dataDir }, process.env),
      degradedMode: resolveDegradedMode(synth),
      fallbackDir: resolveStorageFallbackDir(synth, process.env, home),
      workspacesRoot: resolveWorkspacesRoot(synth, undefined, home),
      defaultWorkingDir: resolveDefaultWorkspace(synth, undefined, home),
      // ADR-077: режим исполнения и параметры удалённого исполнителя —
      // порт собирается по ним (параметр запуска, инвариант 24).
      executionConfig: execution,
      maxUploadBytes: resolveMaxUploadBytes(synth),
      uiDistPath: uiPath,
      permissionConfig: synth.permission,
      defaultPlanMode: synth.session?.planMode,
      securityConfig: synth.security,
      // ADR-099 (D1): HTTP/HTTPS-прокси единого egress-слоя.
      proxyConfig: synth.proxy,
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
      // ADR-102: конфигурация аналитики (retention суточных роллапов).
      analyticsConfig: synth.analytics,
      // ADR-094: конфигурация метрик (`metrics.enabled`, env SYNTH_METRICS_ENABLED).
      metricsConfig: synth.metrics,
      // PROP-108 Ф1: Authority-слой (по умолчанию выключен).
      authorityConfig: synth.authority,
      // PROP-090 §10: конфигурация слоя плагинов (политики + бюджеты).
      pluginsConfig: synth.plugins,
      // ADR-052 (этап II): конфигурация исходящих webhooks (enabled/retry).
      webhooksConfig: synth.webhooks,
      // ADR-071 §2.3.1 / egress: политика сетевого доступа (config-фоллбек).
      mcpNetworkPolicy: synth.mcp.networkPolicy,
      // Egress: настраиваемая политика tools/webhooks + журнал внешних запросов.
      egressConfig: synth.egress,
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

    // PROP-090 §5/§10 (Ф5б-1): старт-активация установленных плагинов.
    // `plugins.lock.json` — источник истины; `executionEnabled=false` (дефолт) →
    // no-op. Ошибка плагина (или самого рантайма) **не роняет старт** — только
    // предупреждение; тексты плагинов в лог не попадают (инвариант 13), только
    // счётчики исходов.
    //
    // Ф5в: **сначала** установка deploy-плагинов (образ/PVC, `plugins.deployDir`),
    // затем активация. Каталог не задан (или пуст) → no-op: поведение standalone
    // не расходится с managed.
    if (appHandle.pluginRuntime) {
      try {
        const deploy = await appHandle.pluginRuntime.installDeployPlugins({ actor: 'startup' });
        if (deploy.installed.length > 0 || deploy.failed.length > 0) {
          console.log(
            `[plugins] deploy: установлено ${deploy.installed.length}, ` +
              `пропущено ${deploy.skipped.length}, ошибок ${deploy.failed.length}`,
          );
        }
      } catch (err) {
        console.warn(
          `[plugins] установка deploy-плагинов не выполнена: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
      try {
        const results = await appHandle.pluginRuntime.activateInstalled({ actor: 'startup' });
        if (results.length > 0) {
          const activated = results.filter((item) => item.outcome === 'activated').length;
          console.log(`[plugins] активировано: ${activated}, отклонено: ${results.length - activated}`);
        }
      } catch (err) {
        console.warn(
          `[plugins] старт-активация не выполнена: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    let shuttingDown = false;

    async function gracefulShutdown(signal: string, exitCode = 0): Promise<void> {
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

      // ADR-102: остановить retention-очистку роллапов аналитики.
      appHandle.stopAnalyticsRollupPruner?.();

      // ADR-094: снять readiness до остановки коллекторов — скрейп в момент
      // shutdown видит `synth_ready 0`.
      setSynthReady(appHandle.metrics, 0);

      // ADR-094: остановить процессные метрики и фоновые доменные коллекторы
      // (таймеры сессий/хранилища, подписка шины, decision/hybrid).
      appHandle.stopMetrics?.();

      // ADR-052 (этап II): остановить движок webhooks и retention-очистку доставок.
      appHandle.stopWebhookService?.();
      appHandle.stopWebhookDeliveryPruner?.();

      // ADR-051 (срез): остановить планировщик расписаний.
      appHandle.stopScheduler?.();

      // ADR-077 (шаг B2): остановить источник MCP-серверов исполнителя.
      appHandle.stopExecutorMcpSource?.();

      // PROP-090 §5 (Ф5б-1): снять вклады плагинов (обратный порядок) — до
      // закрытия хранилища; ошибка деактивации не мешает остановке.
      if (appHandle.pluginRuntime) {
        try {
          await appHandle.pluginRuntime.dispose();
        } catch {
          // Деактивация плагинов не должна ломать shutdown.
        }
      }

      // ADR-097: закрыть backend хранения (пул соединений PG); `file`/`memory`
      // ресурсов не держат — вызов no-op (см. `StorageContext.close?`).
      if (appHandle.closeStorage) {
        await appHandle.closeStorage().catch(() => {});
      }

      server.close((err: Error | undefined) => {
        if (err) console.error('[Shutdown] Server close error:', err);
      });

      wss.close((err: Error | undefined) => {
        if (err) console.error('[Shutdown] WSS close error:', err);
      });

      process.exit(exitCode);
    }

    process.on('SIGTERM', () => { void gracefulShutdown('SIGTERM'); });
    process.on('SIGINT', () => { void gracefulShutdown('SIGINT'); });

    // Restart из UI: режим — CLI-флаг > SYNTH_RESTART_MODE (bare `serve` —
    // `disabled`); фактический рестарт — graceful shutdown с кодом 75.
    configureRestart({
      mode: resolveRestartMode(process.env, options.restartMode),
      request: () => gracefulShutdown('API', RESTART_EXIT_CODE),
    });

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
    // ADR-099: доверие TLS/CA — до запросов к удалённому backend (device flow).
    await initTls(synth, { home });
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
    // ADR-099: доверие TLS/CA — до запросов к удалённому backend.
    await initTls(synth, { home, dataDir });
    await ensureDataDir(dataDir);

    const { SessionManager } = await import('./sessions/manager.js');
    const { syncProjectToRemote, resolveLocalWorkspace } = await import('./remote/transfer.js');

    // ADR-096: хранилища — из единого контекста (resolved backend).
    const storage = await buildCliStorage(synth, dataDir, home);
    const project = await storage.projects.load(projectId);
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
      ? await new SessionManager(storage.sessions).listSessions({ projectId: project.id })
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
    // ADR-099: доверие TLS/CA — до запросов к удалённому backend.
    await initTls(synth, { home, dataDir });
    await ensureDataDir(dataDir);

    const { SessionManager } = await import('./sessions/manager.js');
    const { forkProjectToLocal } = await import('./remote/transfer.js');

    // ADR-096: хранилища — из единого контекста (resolved backend).
    const storage = await buildCliStorage(synth, dataDir, home);
    const session = await ensureRemoteSession(options, synth, home);
    const remoteClient = session.getClient();

    console.log(`Fork проекта ${remoteProjectId} ← ${session.backendUrl}`);
    const stats = await forkProjectToLocal({
      remoteProjectId,
      remoteClient,
      localProjectStore: storage.projects,
      localSessionManager: new SessionManager(storage.sessions),
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

projectCmd
  .command('export')
  .description('Экспортировать проект в портативный архив (ADR-091)')
  .argument('<projectId>', 'ID локального проекта')
  .option('--out <path>', 'путь к архиву или каталогу (по умолчанию — текущий каталог)')
  .option('--with-workspace', 'включить рабочий каталог проекта (workspace/)')
  .option(
    '--with-secrets',
    'включить секреты сессий (карта обфускации LLM Gateway) — архив становится секретом',
  )
  .option('--config <path>', 'путь к config.yaml')
  .option('--data-dir <path>', 'каталог данных')
  .option('--home <path>', 'локальный home-каталог (config/data/profiles/credentials)')
  .action(async (projectId, options) => {
    const home = resolveHome(options.home);
    const synth = await loadConfig({ configPath: options.config, home: home ?? undefined });
    const dataDir = resolve((options.dataDir as string | undefined) || resolveDataDir(synth, undefined, home));
    await ensureDataDir(dataDir);

    const { exportProject } = await import('./projects/portable.js');
    const storage = await buildCliStorage(synth, dataDir, home);
    try {
      const result = await exportProject({
        dataDir,
        projectId,
        out: options.out as string | undefined,
        withWorkspace: !!options.withWorkspace,
        // security-фикс 0.11.3: секреты сессий (карта обфускации) — только явным
        // opt-in; факт фиксируется в аудите `export.created`.
        withSecrets: !!options.withSecrets,
        workspacesRoot: options.dataDir ? join(dataDir, 'workspaces') : resolveWorkspacesRoot(synth, undefined, home),
        audit: storage.maintenanceAudit,
        storage,
        actor: 'cli',
        log: (msg) => console.log(msg),
      });
      console.log('─'.repeat(60));
      console.log(`Готово: архив ${result.path}`);
      console.log(`  сессий: ${result.sessions}`);
      console.log(`  записей: ${result.entries}`);
      console.log(`  размер: ${result.bytes} Б`);
      console.log(`  workspace: ${result.withWorkspace ? 'да' : 'нет'}`);
      console.log(`  секреты сессий: ${options.withSecrets ? 'да' : 'нет'}`);
    } catch (err) {
      console.error(`Ошибка экспорта: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  });

projectCmd
  .command('import')
  .description('Импортировать проект из портативного архива (ADR-091)')
  .argument('<archive>', 'путь к архиву *.synth-project.tar.gz')
  .option('--name <name>', 'имя нового проекта (по умолчанию — из архива)')
  .option('--merge-into <projectId>', 'импортировать сессии в существующий проект')
  .option('--with-workspace', 'распаковать workspace в каталог проекта')
  .option('--dry-run', 'проверить архив и показать план без записи')
  .option('--yes', 'подтвердить создание проекта и сессий')
  .option('--config <path>', 'путь к config.yaml')
  .option('--data-dir <path>', 'каталог данных')
  .option('--home <path>', 'локальный home-каталог (config/data/profiles/credentials)')
  .action(async (archive, options) => {
    const home = resolveHome(options.home);
    const synth = await loadConfig({ configPath: options.config, home: home ?? undefined });
    const dataDir = resolve((options.dataDir as string | undefined) || resolveDataDir(synth, undefined, home));
    await ensureDataDir(dataDir);

    const { importProject } = await import('./projects/portable.js');
    const storage = await buildCliStorage(synth, dataDir, home);
    try {
      const result = await importProject({
        dataDir,
        archive,
        name: options.name as string | undefined,
        mergeInto: options.mergeInto as string | undefined,
        withWorkspace: !!options.withWorkspace,
        dryRun: !!options.dryRun,
        yes: !!options.yes,
        workspacesRoot: options.dataDir ? join(dataDir, 'workspaces') : resolveWorkspacesRoot(synth, undefined, home),
        audit: storage.maintenanceAudit,
        storage,
        actor: 'cli',
        log: (msg) => console.log(msg),
      });
      console.log('─'.repeat(60));
      console.log(`${options.dryRun ? '[dry-run] ' : ''}Готово: проект ${result.projectId}`);
      console.log(`  сессий импортировано: ${result.sessionsImported}`);
      console.log(`  сообщений импортировано: ${result.messagesImported}`);
      console.log(`  workspace: ${result.workspaceRestored ? 'восстановлен' : 'нет'}`);
      const ids = Object.entries(result.idMap);
      if (ids.length > 0) {
        console.log('  маппинг id:');
        for (const [from, to] of ids) console.log(`    ${from} → ${to}`);
      }
    } catch (err) {
      console.error(`Ошибка импорта: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  });

program.addCommand(projectCmd);

// PROP-090 §«CLI (`synth plugin *`)» (Ф5б-3): группа объявляется и здесь, и в
// `packages/synth/src/cli.ts` — обе обёртки используют один модуль команд.
program.addCommand(createPluginCommand({ createContext: createPluginCliContext }));

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
    // ADR-099: доверие TLS/CA — до запроса к LLM-провайдеру.
    await initTls(synth, { dataDir });
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
  // ADR-099: доверие TLS/CA — до запроса к LLM-провайдеру.
  await initTls(synth, { dataDir });
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
  .description('Проверить обновления, установить или откатить пакет (ADR-092)')
  .option('--apply', 'установить целевую версию (без него — только проверка)')
  .option('--to <version>', 'целевая версия X.Y.Z — обновление или откат')
  .option('--dry-run', 'показать план без установки')
  .option('--json', 'вывод в JSON')
  .option('-y, --yes', 'пропустить подтверждение')
  .option('--data-dir <path>', 'каталог данных')
  .action(async (options) => {
    const synth = await loadConfig({});
    const dataDir = resolve(options.dataDir || resolveDataDir(synth));
    // ADR-099: доверие TLS/CA — до проверки обновлений (npm-реестр).
    await initTls(synth, { dataDir });
    await ensureDataDir(dataDir);

    const { runUpdateCommand } = await import('./maintenance/update.js');
    const storage = await buildCliStorage(synth, dataDir);

    const code = await runUpdateCommand({
      dataDir,
      to: options.to as string | undefined,
      apply: !!options.apply,
      dryRun: !!options.dryRun,
      yes: !!options.yes,
      json: !!options.json,
      audit: storage.maintenanceAudit,
    });
    if (code !== 0) process.exit(code);
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

        const { SessionManager } = await import('./sessions/manager.js');

        const store = (await buildCliStorage(synth, dataDir)).sessions;
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

        const { SessionManager } = await import('./sessions/manager.js');

        const store = (await buildCliStorage(synth, dataDir)).sessions;
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

        const { SessionManager } = await import('./sessions/manager.js');

        const store = (await buildCliStorage(synth, dataDir)).sessions;
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

        const { SessionManager } = await import('./sessions/manager.js');

        const store = (await buildCliStorage(synth, dataDir)).sessions;
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

        const store = (await buildCliStorage(synth, dataDir)).sessions;
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

        const store = (await buildCliStorage(synth, dataDir)).sessions;
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
  .description('Применить миграции схемы данных инстанса (ADR-092)')
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
    const storage = await buildCliStorage(synth, dataDir, home, { postgresSchemaMode: 'skip' });
    const code = await runMigrateCommand({
      dataDir,
      dryRun: !!options.dryRun,
      yes: !!options.yes,
      audit: storage.maintenanceAudit,
      storage,
    });
    if (code !== 0) process.exit(code);
  });

program
  .command('storage')
  .description('Управление физическим слоем хранения (ADR-096)')
  .addCommand(
    new Command('migrate')
      .description('Перенести данные инстанса между backend\'ами хранения (file ↔ postgres), идемпотентно')
      .requiredOption('--to <backend>', 'целевой backend: file | postgres')
      .option('--target-data-dir <path>', 'каталог данных файловой цели (--to file; по умолчанию — --data-dir)')
      .option('--data-dir <path>', 'каталог данных источника (и файловой цели по умолчанию)')
      .option('--config <path>', 'путь к config.yaml')
      .option('--home <path>', 'локальный home-каталог (config/data/profiles/credentials)')
      .option('--dry-run', 'показать счётчики по сущностям без записи')
      .option('--yes', 'подтвердить перенос (обязательно без --dry-run)')
      .action(async (options) => {
        const to = options.to as string;
        if (to !== 'file' && to !== 'postgres') {
          console.error(`Ошибка: неизвестный целевой backend "${to}" (ожидается file | postgres).`);
          process.exit(1);
        }
        const home = resolveHome(options.home);
        const synth = await loadConfig({ configPath: options.config, home: home ?? undefined });
        const dataDir = resolve(options.dataDir || resolveDataDir(synth, undefined, home));

        const { runStorageMigrateCommand } = await import('./maintenance/storage-migrate.js');
        const code = await runStorageMigrateCommand({
          dataDir,
          config: synth,
          to,
          targetDataDir: options.targetDataDir,
          dryRun: !!options.dryRun,
          yes: !!options.yes,
          env: process.env,
          home,
        });
        if (code !== 0) process.exit(code);
      }),
  );

program
  .command('analytics')
  .description('Аналитика и отчётность инстанса (ADR-102)')
  .addCommand(
    new Command('rebuild')
      .description('Идемпотентно пересобрать суточные роллапы аналитики из истории (usage/activity)')
      .option('--from <date>', 'начало окна включительно (YYYY-MM-DD, UTC; по умолчанию — вся история)')
      .option('--dry-run', 'рассчитать и показать сводку без записи')
      .option('--yes', 'подтвердить перезапись агрегатов (обязательно без --dry-run)')
      .option('--json', 'вывод сводки в JSON (включая пересчитанные бакеты)')
      .option('--data-dir <path>', 'каталог данных')
      .option('--config <path>', 'путь к config.yaml')
      .option('--home <path>', 'локальный home-каталог (config/data/profiles/credentials)')
      .action(async (options) => {
        const home = resolveHome(options.home);
        const synth = await loadConfig({ configPath: options.config, home: home ?? undefined });
        const dataDir = resolve(options.dataDir || resolveDataDir(synth, undefined, home));
        const auditPath = synth.llmGateway.audit.logPath || join(dataDir, 'audit', 'llm-gateway.jsonl');

        const { runAnalyticsRebuildCommand } = await import('./analytics/rebuild-command.js');
        // ADR-096: контекст собирается под выбранный backend и закрывается в `finally`
        // (pool PG); схема не мигрируется — это контур `synth migrate`.
        const storage = await buildCliStorage(synth, dataDir, home, { postgresSchemaMode: 'skip' });
        let code = 1;
        try {
          code = await runAnalyticsRebuildCommand({
            dataDir,
            storage,
            from: options.from,
            dryRun: !!options.dryRun,
            yes: !!options.yes,
            json: !!options.json,
            auditLogPath: auditPath,
          });
        } finally {
          await storage.close?.().catch(() => {});
        }
        if (code !== 0) process.exit(code);
      }),
  );

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
    const dataDir = resolve(options.dataDir || resolveDataDir(synth, undefined, home));

    const { runDoctorCommand } = await import('./maintenance/doctor.js');
    const backend = resolveStorageBackend(synth, process.env);
    // ADR-097: при backend=postgres — read-only проба БД (контекст в режиме
    // `skip`, миграции не применяются); ошибка сборки → fail `db-connection`.
    let dbHealth: (() => Promise<import('./storage/storage-context.js').StorageHealth>) | undefined;
    if (backend === 'postgres') {
      dbHealth = async () => {
        try {
          const storage = await buildCliStorage(synth, dataDir, home, { postgresSchemaMode: 'skip' });
          try {
            return storage.health
              ? await storage.health()
              : { ok: false, error: 'драйвер postgres не предоставляет health()' };
          } finally {
            await storage.close?.();
          }
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
      };
    }
    const code = await runDoctorCommand({
      dataDir,
      secretKey: resolveSecretKey(synth, process.env),
      configSecretKey: synth.security.secretKey,
      env: process.env,
      json: !!options.json,
      storageBackend: backend,
      ...(dbHealth ? { dbHealth } : {}),
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
  .option('--encrypt', 'зашифровать архив (AES-256-GCM; ключ — --key-file/SYNTH_BACKUP_KEY_FILE/SYNTH_BACKUP_KEY)')
  .option('--key-file <path>', 'файл с ключом шифрования (32 байта base64/hex)')
  .option('--data-dir <path>', 'каталог данных')
  .option('--config <path>', 'путь к config.yaml')
  .option('--home <path>', 'локальный home-каталог (config/data/profiles/credentials)')
  .action(async (options) => {
    const home = resolveHome(options.home);
    const synth = await loadConfig({ configPath: options.config, home: home ?? undefined });
    const dataDir = resolve(options.dataDir || resolveDataDir(synth, undefined, home));

    const { runBackupCommand } = await import('./maintenance/backup.js');
    const storage = await buildCliStorage(synth, dataDir, home, { postgresSchemaMode: 'skip' });
    const code = await runBackupCommand({
      dataDir,
      out: options.out,
      withSecrets: !!options.withSecrets,
      withWorkspace: !!options.withWorkspace,
      live: !!options.live,
      encrypt: !!options.encrypt,
      keyFile: options.keyFile,
      env: process.env,
      storageBackend: resolveStorageBackend(synth, process.env),
      audit: storage.maintenanceAudit,
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
  .option('--key-file <path>', 'файл с ключом шифрования (для архива .tar.gz.enc)')
  .action(async (archive, options) => {
    const home = resolveHome(options.home);
    const synth = await loadConfig({ configPath: options.config, home: home ?? undefined });
    const dataDir = resolve(options.dataDir || resolveDataDir(synth, undefined, home));

    const { runRestoreCommand } = await import('./maintenance/restore.js');
    const storage = await buildCliStorage(synth, dataDir, home, { postgresSchemaMode: 'skip' });
    const code = await runRestoreCommand({
      archive,
      dataDir,
      dryRun: !!options.dryRun,
      yes: !!options.yes,
      noSafetyCopy: options.safetyCopy === false,
      keyFile: options.keyFile,
      env: process.env,
      audit: storage.maintenanceAudit,
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
  .option('--purge-db', 'удалить схему БД при backend=postgres (DROP SCHEMA; требует --purge и --yes)')
  .option('--dry-run', 'показать, что будет удалено, без удаления')
  .option('--yes', 'подтвердить необратимое удаление (обязательно без --dry-run)')
  .action(async (options) => {
    const home = resolveHome(options.home);
    const synth = await loadConfig({ configPath: options.config, home: home ?? undefined });
    const dataDir = resolve(options.dataDir || resolveDataDir(synth, undefined, home));

    const { runUninstallCommand } = await import('./maintenance/uninstall.js');
    const storage = await buildCliStorage(synth, dataDir, home, { postgresSchemaMode: 'skip' });
    const code = await runUninstallCommand({
      dataDir,
      home: home ?? undefined,
      purge: !!options.purge,
      purgeDb: !!options.purgeDb,
      dryRun: !!options.dryRun,
      yes: !!options.yes,
      storageBackend: resolveStorageBackend(synth, process.env),
      ...(storage.purgeSchema ? { purgeSchema: () => storage.purgeSchema!() } : {}),
      audit: storage.maintenanceAudit,
    });
    if (code !== 0) process.exit(code);
  });

program.parse();
