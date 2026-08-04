import { Command } from 'commander';
import { loadConfig, resolveDataDir, resolvePort, resolveDefaultWorkspace, resolveWorkspacesRoot, ensureDataDir, defaultConfig, SYNTH_VERSION } from '@synth/shared';
import { spawn } from 'node:child_process';
import { checkForUpdatesBackground } from './update-checker.js';

const program = new Command();

program
  .name('synth')
  .description('Synth Core — автономный AI-движок')
  .version(SYNTH_VERSION);

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
        storage: options.dataDir ? { dataDir: options.dataDir, workspacesRoot: '', defaultWorkspace: '' } : undefined,
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
      workspacesRoot: resolveWorkspacesRoot(synth),
      defaultWorkingDir: resolveDefaultWorkspace(synth),
      uiDistPath: uiPath,
      permissionConfig: synth.permission,
      defaultPlanMode: synth.session?.planMode,
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

    const host = process.env.SYNTH_HOST || '0.0.0.0';

    server.listen(port, host, () => {
      console.log(`\n  Откройте http://${host}:${port} в браузере`);
      console.log(`  API-ключ: ${apiKey.slice(0, 8)}...`);

      checkForUpdatesBackground(dataDir, (info) => {
        console.log(`\n  Доступна новая версия ${info.latestVersion} (текущая: ${info.currentVersion})`);
        console.log(`  Выполните synth update --apply для обновления.`);
      });
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

program
  .command('update')
  .description('Проверить наличие обновлений и установить')
  .option('--apply', 'установить обновление')
  .option('-y, --yes', 'пропустить подтверждение')
  .option('--data-dir <path>', 'каталог данных')
  .action(async (options) => {
    const { checkForUpdates } = await import('./update-checker.js');
    const synth = await loadConfig({});
    const dataDir = options.dataDir || resolveDataDir(synth);
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
        const dataDir = options.dataDir || resolveDataDir(synth);
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
          const title = (s.title || 'Новая сессия').substring(0, 38).padEnd(38);
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
        const dataDir = options.dataDir || resolveDataDir(synth);
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
        const dataDir = options.dataDir || resolveDataDir(synth);
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
        const dataDir = options.dataDir || resolveDataDir(synth);
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
          const title = (c.title || 'Новая сессия').substring(0, 38).padEnd(38);
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
        const dataDir = options.dataDir || resolveDataDir(synth);
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
        const dataDir = options.dataDir || resolveDataDir(synth);
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

program.parse();
