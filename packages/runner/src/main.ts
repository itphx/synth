import { loadConfig, resolvePort } from '@itphx/synth-shared';
import { Command } from 'commander';

const program = new Command();

program
  .name('synth-runner')
  .description('Synth Runner — Gateway, Engine Manager, LLM Proxy')
  .version('0.1.0');

program
  .option('--port <number>', 'порт раннера')
  .option('--backend <url>', 'URL бэкенда', process.env.SYNTH_BACKEND_URL)
  .option('--config <path>', 'путь к config.yaml')
  .action(async (options) => {
    const overrides: Record<string, unknown> = {};
    if (options.port) overrides.port = parseInt(options.port, 10);
    if (options.backend) overrides.backendUrl = options.backend;

    const synth = await loadConfig({
      configPath: options.config,
      overrides: { runner: overrides } as Record<string, unknown>,
    });

    const port = resolvePort(synth, 'SYNTH_RUNNER_PORT', synth.runner.port);
    const backendUrl = process.env.SYNTH_BACKEND_URL || synth.runner.backendUrl;

    console.log('synth-runner starting...');
    console.log(`  port: ${port}`);
    console.log(`  backend: ${backendUrl}`);
    console.log(`  engine ports: opencode=${synth.runner.enginePorts.opencode}, cline=${synth.runner.enginePorts.cline}, synth=${synth.runner.enginePorts.synth}`);
    console.log(`  llm proxy: ${synth.runner.proxyPort}`);

    // TODO: реализация раннера — Gateway, Engine Manager, LLM Proxy
  });

program.parse();
