import { Command } from 'commander';
import { createRequire } from 'node:module';
import { join, dirname } from 'node:path';
import { loadConfig, resolveDataDir, resolvePort, resolveDefaultWorkspace, resolveWorkspacesRoot, defaultConfig, ensureFirstRun, ensureDataDir, SYNTH_VERSION } from '@itphx/shared';
import { createStandaloneApp } from '@itphx/core/server/app.js';
import { runSingleChat } from '@itphx/core/server/chat.js';
import { JsonStore } from '@itphx/core/storage/json-store.js';

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
  .action(async (options) => {
    const { dataDir } = await ensureFirstRun(
      options.dataDir || undefined,
      options.config || undefined,
    );

    const synth = await loadConfig({
      configPath: options.config,
      overrides: {
        core: {
          port: parseInt(options.port, 10),
          apiKey: options.apiKey,
        },
        storage: { dataDir, workspacesRoot: '', defaultWorkspace: '' },
      },
    });

    const port = resolvePort(synth, 'SYNTH_CORE_PORT', synth.core.port);
    const apiKey = synth.core.apiKey || process.env.SYNTH_API_KEY || '';

    // UI поставляется как отдельный npm-пакет @itphx/ui → резолвим его dist/.
    // systemPromptsDir не передаём: @itphx/core резолвит свои prompts сам (рядом с package.json).
    const uiRoot = resolvePackageRoot('@itphx/ui');
    const uiDistPath = uiRoot ? join(uiRoot, 'dist') : undefined;

    const { server, wss } = await createStandaloneApp({
      port,
      dataDir,
      apiKey,
      workspacesRoot: resolveWorkspacesRoot(synth),
      defaultWorkingDir: resolveDefaultWorkspace(synth),
      uiDistPath,
    });

    let shuttingDown = false;

    async function gracefulShutdown(signal: string): Promise<void> {
      if (shuttingDown) return;
      shuttingDown = true;
      console.log(`\n[Shutdown] Получен сигнал ${signal}, завершаю...`);

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
    });
  });

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

    const { readAuditLog } = await import('@itphx/core/engine/gateway/index.js');
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
