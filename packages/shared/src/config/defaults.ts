import type { SynthConfig } from './types.js';

export const defaultConfig: SynthConfig = {
  server: {
    host: '0.0.0.0',
    port: 5000,
    corsOrigin: 'http://localhost:5002',
    allowedOrigins: [],
  },
  storage: {
    dataDir: '/var/synth/data',
    workspacesRoot: '',
  },
  auth: {
    debugMode: false,
    sessionMaxAgeMinutes: 1440,
  },
  llm: {
    defaultProvider: '',
    defaultModel: '',
    maxRetries: 3,
    timeout: 60,
  },
  core: {
    port: 4300,
    apiKey: '',
  },
  runner: {
    port: 5200,
    backendUrl: 'http://localhost:5000',
    enginePorts: {
      opencode: 4100,
      cline: 4200,
      synth: 4300,
    },
    proxyPort: 9090,
  },
  ui: {
    port: 5002,
    backendUrl: 'http://localhost:5000',
    theme: 'flexoki',
    themeMode: 'system',
    locale: 'ru',
  },
  i18n: {
    defaultLanguage: 'ru',
    supportedLanguages: ['ru', 'en'],
  },
  logging: {
    groups: {
      OPENAI: 'INFO',
      ANTHROPIC: 'INFO',
      OLLAMA: 'INFO',
      ROUTES: 'WARNING',
      ORCHESTRATOR: 'INFO',
      CHAT_STREAM: 'WARNING',
      TSM: 'INFO',
      STORAGE: 'WARNING',
      DEBUG: 'DEBUG',
      WEBSOCKET: 'INFO',
      MCP: 'INFO',
    },
  },
  tsm: {
    maxIterations: 50,
    validationTimeout: 30,
  },
  context: {
    enabledFiles: ['SOUL.md', 'COMPANY.md', 'ABOUT.md'],
  },
  summarization: {
    provider: '',
    model: '',
    temperature: 0.3,
    promptFile: 'SUMMARIZER',
  },
};
