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
  .action(async (options) => {
    const synth = await loadConfig({
      configPath: options.config,
      overrides: {
        core: {
          port: parseInt(options.port, 10),
          apiKey: options.apiKey,
        },
        storage: options.dataDir ? { dataDir: options.dataDir } : undefined,
      },
    });

    const dataDir = resolveDataDir(synth);
    const port = resolvePort(synth, 'SYNTH_CORE_PORT', synth.core.port);

    await ensureDataDir(dataDir);

    console.log(`synth-core starting on http://localhost:${port}`);
    console.log(`  data dir: ${dataDir}`);
    if (synth.core.apiKey) {
      console.log(`  api key: ${synth.core.apiKey.slice(0, 8)}...`);
    }
    if (options.backend) {
      console.log(`  backend: ${options.backend}`);
    }
    if (options.runner) {
      console.log('  runner: in-process');
    }

    // TODO: запуск Hono HTTP API сервера
  });

program
  .command('chat')
  .description('Одноразовый чат-запрос')
  .argument('[message]', 'сообщение')
  .option('--model <model>', 'модель')
  .option('--provider <provider>', 'провайдер')
  .option('--agent <agent>', 'агент')
  .option('--config <path>', 'путь к config.yaml')
  .action(async (message, options) => {
    const synth = await loadConfig({ configPath: options.config });

    console.log(`synth chat:`);
    console.log(`  model: ${options.model || synth.llm.defaultModel || '(не задана)'}`);
    console.log(`  provider: ${options.provider || synth.llm.defaultProvider || '(не задан)'}`);
    console.log(`  agent: ${options.agent || 'developer'}`);
    if (message) {
      console.log(`  message: "${message}"`);
    }

    // TODO: одноразовый чат-запрос
  });

program
  .command('config')
  .description('Показать конфигурацию')
  .option('--config <path>', 'путь к config.yaml')
  .action(async (options) => {
    const synth = await loadConfig({ configPath: options.config });
    console.log(JSON.stringify(synth, null, 2));
  });

program.parse();
