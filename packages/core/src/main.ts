import { Command } from 'commander';
import { loadConfig, resolveDataDir, resolvePort, ensureDataDir, defaultConfig } from '@synth/shared';

const program = new Command();

program
  .name('synth')
  .description('Synth Core — автономный AI-движок')
  .version('0.1.0');

program
  .command('serve')
  .description('Запустить HTTP API сервер')
  .option('--port <number>', 'порт сервера', String(defaultConfig.core.port))
  .option('--api-key <key>', 'API-ключ для аутентификации')
  .option('--data-dir <path>', 'каталог данных')
  .option('--config <path>', 'путь к config.yaml')
  .option('--backend <url>', 'URL бэкенда (managed mode)')
  .option('--runner', 'запустить in-process раннер')
  .option('--ui <path>', 'путь к собранному UI (dist)')
  .action(async (options) => {
    const synth = await loadConfig({
      configPath: options.config,
      overrides: {
        core: {
          port: parseInt(options.port, 10),
          apiKey: options.apiKey,
        },
        storage: options.dataDir ? { dataDir: options.dataDir, workspacesRoot: '' } : undefined,
      },
    });

    const dataDir = resolveDataDir(synth);
    const port = resolvePort(synth, 'SYNTH_CORE_PORT', synth.core.port);
    const apiKey = synth.core.apiKey || process.env.SYNTH_API_KEY || '';

    await ensureDataDir(dataDir);

    const { createStandaloneApp } = await import('./server/app.js');

    const uiPath = options.ui || undefined;

    const { server, wss } = await createStandaloneApp({
      port,
      dataDir,
      apiKey,
      workspacesRoot: process.cwd(),
      uiDistPath: uiPath,
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

    server.listen(port, () => {
      console.log(`\n  Откройте http://localhost:${port} в браузере`);
      console.log(`  API-ключ: ${apiKey.slice(0, 8)}...`);
    });
  });

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
  .action(async (message, options) => {
    // Если нет сообщения — интерактивный режим
    if (!message) {
      console.log('Интерактивный режим (введите "exit" для выхода)');
      await startRepl(options);
      return;
    }

    const synth = await loadConfig({ configPath: options.config });
    const dataDir = options.dataDir || resolveDataDir(synth);
    await ensureDataDir(dataDir);

    const { runSingleChat } = await import('./server/chat.js');
    await runSingleChat({
      message,
      model: options.model,
      provider: options.provider,
      agent: options.agent,
      dataDir,
      config: synth,
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
          .requiredOption('--type <type>', 'тип (openai, anthropic, ollama)')
          .option('--api-key <key>', 'API-ключ')
          .option('--url <url>', 'базовый URL')
          .option('--model <model>', 'модель по умолчанию')
          .option('--data-dir <path>', 'каталог данных')
          .action(async (options) => {
            const synth = await loadConfig({});
            const dataDir = options.dataDir || resolveDataDir(synth);
            await ensureDataDir(dataDir);

            const { JsonStore } = await import('./storage/json-store.js');
            const store = new JsonStore<{ name: string; type: string; baseUrl?: string; apiKey?: string; defaultModel?: string; timeout?: number; enabled?: boolean; icon?: string }>({ dataDir, subdir: 'providers' });

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
          }),
      )
      .addCommand(
        new Command('list')
          .description('Список провайдеров')
          .option('--data-dir <path>', 'каталог данных')
          .action(async (options) => {
            const synth = await loadConfig({});
            const dataDir = options.dataDir || resolveDataDir(synth);
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
            const dataDir = options.dataDir || resolveDataDir(synth);
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
  const dataDir = (options['data-dir'] as string) || resolveDataDir(synth);
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
    });

    rl.prompt();
  }

  rl.close();
  console.log('До свидания!');
}

program.parse();
