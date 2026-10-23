import { describe, it, expect } from 'vitest';
import {
  PACK_KINDS,
  PACK_TYPES,
  packManifestSchema,
  packProvidesSchema,
  normalizePackProvides,
  validatePackManifest,
  diffPackProvides,
} from './pack.js';

/**
 * Фикстуры — копии **реально выпущенных** манифестов `synth.pack`:
 * - `synth-media` (эталонный Add-on, ADR-086);
 * - `@itphx/synth-gateway-telegram` (эталонный Gateway, ADR-087).
 *
 * Копии вшиты намеренно: тесты пакета `shared` герметичны и не зависят от
 * соседних репозиториев. При изменении формата манифеста фикстуры нужно
 * обновить здесь же.
 */
const SYNTH_MEDIA_MANIFEST = {
  name: 'synth-media',
  version: '0.1.0',
  kind: 'addon',
  host: '^0.9.0',
  contracts: {
    apiV2: '^2',
    events: '^1',
    mcp: '^1',
  },
  description:
    'synth-media — внешнее приложение в пайплайне внешних событий Synth (AD-089): приём запросов, реестр источников контекста, хранение и версионирование черновиков, рендер, ревью и инбокс идей; MCP-сервер receiver (stdio) и skill media-hub',
  provides: {
    mcp: {
      name: 'synth-media-receiver',
      transport: 'http',
      port: 7000,
      path: '/mcp',
      description: 'Receiver synth-media: черновики, ревью, каналы, публикации (тулы synth-media-receiver_*)',
    },
    skills: [
      {
        name: 'media-hub',
        path: 'skills/media-hub',
        metadata: {
          synth: {
            agents: ['publisher'],
            requires_capabilities: ['mcp'],
            scope: 'instance',
            trigger: 'auto',
          },
        },
      },
    ],
  },
} as const;

const GATEWAY_TELEGRAM_MANIFEST = {
  name: '@itphx/synth-gateway-telegram',
  version: '0.3.2',
  kind: 'gateway',
  host: '^0.9.0',
  contracts: {
    apiV2: '^2',
    events: '^1',
    mcp: '^1',
  },
  description: 'Telegram-шлюз: мост между Telegram-ботом и платформой внешних событий Synth',
  provides: {
    mcp: {
      name: 'synth-gateway-telegram',
      transport: 'http',
      port: 7101,
      path: '/mcp/{tenant}',
      description: 'Telegram-шлюз: тулы tg_*',
    },
    skills: [
      {
        name: 'gateway-telegram',
        path: 'skills/gateway-telegram',
      },
    ],
  },
} as const;

describe('Манифест расширения synth.pack — схема (ADR-086 §5 / ADR-090)', () => {
  it('принимает корректный манифест', () => {
    const parsed = packManifestSchema.safeParse({
      name: 'acme-pack',
      version: '1.0.0',
      kind: 'pack',
      packType: 'skills',
      host: '^0.9.0',
      contracts: { apiV2: '^2' },
      description: 'Пак скиллов',
      provides: {
        skills: [{ name: 'demo', path: 'skills/demo' }],
      },
    });
    expect(parsed.success).toBe(true);
  });

  it('нормализует provides.mcp-объект в массив', () => {
    const parsed = packManifestSchema.parse({
      name: 'acme-addon',
      version: '1.0.0',
      kind: 'addon',
      description: 'Аддон',
      provides: {
        mcp: { name: 'acme-mcp', transport: 'http', port: 7101 },
      },
    });
    expect(parsed.provides.mcp).toHaveLength(1);
    expect(parsed.provides.mcp[0]?.name).toBe('acme-mcp');
  });

  it('оставляет provides.mcp-массив массивом', () => {
    const parsed = packManifestSchema.parse({
      name: 'acme-addon',
      version: '1.0.0',
      kind: 'addon',
      description: 'Аддон',
      provides: {
        mcp: [
          { name: 'first', transport: 'http' },
          { name: 'second', transport: 'stdio' },
        ],
      },
    });
    expect(parsed.provides.mcp.map((mcp) => mcp.name)).toEqual(['first', 'second']);
  });

  it('отклоняет неизвестный kind', () => {
    const parsed = packManifestSchema.safeParse({
      name: 'acme',
      version: '1.0.0',
      kind: 'unknown',
      description: 'x',
      provides: { skills: [] },
    });
    expect(parsed.success).toBe(false);
  });

  it('требует packType для kind «pack»', () => {
    const parsed = packManifestSchema.safeParse({
      name: 'acme-pack',
      version: '1.0.0',
      kind: 'pack',
      description: 'x',
      provides: { skills: [{ name: 'demo', path: 'skills/demo' }] },
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.some((issue) => issue.path.join('.') === 'packType')).toBe(true);
    }
  });

  it('запрещает packType у другого kind', () => {
    const parsed = packManifestSchema.safeParse({
      name: 'acme-addon',
      version: '1.0.0',
      kind: 'addon',
      packType: 'skills',
      description: 'x',
      provides: { skills: [{ name: 'demo', path: 'skills/demo' }] },
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.some((issue) => issue.path.join('.') === 'packType')).toBe(true);
    }
  });

  it('отклоняет некорректное имя и некорректную версию', () => {
    expect(
      packManifestSchema.safeParse({
        name: 'Пак с пробелами',
        version: '1.0.0',
        kind: 'addon',
        description: 'x',
        provides: { skills: [{ name: 'demo', path: 'skills/demo' }] },
      }).success,
    ).toBe(false);
    expect(
      packManifestSchema.safeParse({
        name: 'acme',
        version: '1.0',
        kind: 'addon',
        description: 'x',
        provides: { skills: [{ name: 'demo', path: 'skills/demo' }] },
      }).success,
    ).toBe(false);
  });

  it('отклоняет некорректный диапазон версий host', () => {
    expect(
      packManifestSchema.safeParse({
        name: 'acme',
        version: '1.0.0',
        kind: 'addon',
        host: 'не-диапазон',
        description: 'x',
        provides: { skills: [{ name: 'demo', path: 'skills/demo' }] },
      }).success,
    ).toBe(false);
  });
});

describe('Манифест расширения synth.pack — реальные манифесты (ADR-086/ADR-087)', () => {
  it('валидирует манифест synth-media без ошибок', () => {
    const parsed = packManifestSchema.safeParse(SYNTH_MEDIA_MANIFEST);
    expect(parsed.success).toBe(true);
    expect(validatePackManifest(SYNTH_MEDIA_MANIFEST)).toEqual([]);
  });

  it('валидирует манифест synth-gateway-telegram без ошибок', () => {
    const parsed = packManifestSchema.safeParse(GATEWAY_TELEGRAM_MANIFEST);
    expect(parsed.success).toBe(true);
    expect(validatePackManifest(GATEWAY_TELEGRAM_MANIFEST)).toEqual([]);
  });

  it('нормализует provides.mcp обоих манифестов в массив', () => {
    const media = normalizePackProvides(SYNTH_MEDIA_MANIFEST.provides);
    expect(media.mcp).toHaveLength(1);
    expect(media.mcp[0]?.name).toBe('synth-media-receiver');

    const gateway = normalizePackProvides(GATEWAY_TELEGRAM_MANIFEST.provides);
    expect(gateway.mcp).toHaveLength(1);
    expect(gateway.mcp[0]?.name).toBe('synth-gateway-telegram');
  });

  it('сохраняет skills и их метаданные при нормализации', () => {
    const media = normalizePackProvides(SYNTH_MEDIA_MANIFEST.provides);
    expect(media.skills).toHaveLength(1);
    expect(media.skills[0]?.name).toBe('media-hub');
    expect(media.skills[0]?.metadata?.synth).toEqual({
      agents: ['publisher'],
      requires_capabilities: ['mcp'],
      scope: 'instance',
      trigger: 'auto',
    });
  });
});

describe('normalizePackProvides (обратная совместимость манифестов)', () => {
  it('превращает одиночный объект mcp в массив', () => {
    const normalized = normalizePackProvides({
      mcp: { name: 'solo', transport: 'http' },
    });
    expect(Array.isArray(normalized.mcp)).toBe(true);
    expect(normalized.mcp).toHaveLength(1);
    expect(normalized.mcp[0]?.name).toBe('solo');
  });

  it('оставляет массив mcp без изменений', () => {
    const normalized = normalizePackProvides({
      mcp: [{ name: 'a', transport: 'http' }],
    });
    expect(normalized.mcp).toHaveLength(1);
    expect(normalized.mcp[0]?.name).toBe('a');
  });

  it('подставляет пустые списки для отсутствующих вкладов', () => {
    const normalized = normalizePackProvides({});
    expect(normalized.mcp).toEqual([]);
    expect(normalized.skills).toEqual([]);
    expect(normalized.agents).toEqual([]);
    expect(normalized.pipelines).toEqual([]);
  });

  it('не теряет неизвестные виды вкладов', () => {
    const normalized = normalizePackProvides({ themes: ['dark'] });
    expect(normalized.themes).toEqual(['dark']);
  });

  it('корректно разбирает provides через схему', () => {
    const parsed = packProvidesSchema.parse({ mcp: { name: 'solo', transport: 'stdio' } });
    expect(parsed.mcp).toHaveLength(1);
  });
});

describe('validatePackManifest — правила целостности', () => {
  const base = {
    name: 'acme',
    version: '1.0.0',
    kind: 'addon',
    description: 'Тестовый манифест',
    provides: {
      skills: [{ name: 'demo', path: 'skills/demo' }],
    },
  };

  it('не сообщает проблем для корректного манифеста', () => {
    expect(packManifestSchema.safeParse(base).success).toBe(true);
    expect(validatePackManifest(base)).toEqual([]);
  });

  it('сообщает о неизвестном kind', () => {
    const problems = validatePackManifest({ ...base, kind: 'unknown' });
    expect(problems.some((problem) => problem.startsWith('kind:'))).toBe(true);
  });

  it('сообщает о неизвестном packType', () => {
    const problems = validatePackManifest({
      ...base,
      kind: 'pack',
      packType: 'unknown',
    });
    expect(problems.some((problem) => problem.startsWith('packType:'))).toBe(true);
  });

  it('сообщает о пустом provides', () => {
    const problems = validatePackManifest({ ...base, provides: {} });
    expect(problems).toContain(
      'provides: не заявлен ни один вклад (mcp/skills/agents/pipelines/tools/promptBlocks/llmFilters/authority)',
    );
  });

  it('сообщает об отсутствии packType у kind «pack»', () => {
    const problems = validatePackManifest({ ...base, kind: 'pack' });
    expect(problems).toContain('packType: обязателен для kind «pack»');
  });

  it('сообщает о packType у другого kind', () => {
    const problems = validatePackManifest({ ...base, kind: 'addon', packType: 'skills' });
    expect(problems.some((problem) => problem.startsWith('packType: допустим только'))).toBe(true);
  });

  it('сообщает о дубликате имени MCP', () => {
    const problems = validatePackManifest({
      ...base,
      provides: {
        mcp: [
          { name: 'dup', transport: 'http' },
          { name: 'dup', transport: 'http' },
        ],
      },
    });
    expect(problems.some((problem) => problem.includes('дубликат имени MCP'))).toBe(true);
  });

  it('сообщает о дубликате имени скилла', () => {
    const problems = validatePackManifest({
      ...base,
      provides: {
        skills: [
          { name: 'dup', path: 'skills/a' },
          { name: 'dup', path: 'skills/b' },
        ],
      },
    });
    expect(problems.some((problem) => problem.includes('дубликат имени скилла'))).toBe(true);
  });

  it('сообщает о дубликате id агента', () => {
    const problems = validatePackManifest({
      ...base,
      provides: {
        agents: [{ id: 'dup' }, { id: 'dup' }],
      },
    });
    expect(problems.some((problem) => problem.includes('дубликат id агента'))).toBe(true);
  });

  it('сообщает о дубликате id пайплайна', () => {
    const problems = validatePackManifest({
      ...base,
      provides: {
        pipelines: [{ id: 'dup' }, { id: 'dup' }],
      },
    });
    expect(problems.some((problem) => problem.includes('дубликат id пайплайна'))).toBe(true);
  });

  it('сообщает об агенте без id', () => {
    const problems = validatePackManifest({
      ...base,
      provides: { agents: [{ displayName: 'Без id' }] },
    });
    expect(problems).toContain('provides.agents[0]: агент без поля «id»');
  });

  it('сообщает о MCP без name', () => {
    const problems = validatePackManifest({
      ...base,
      provides: { mcp: [{ transport: 'http' }] },
    });
    expect(problems).toContain('provides.mcp[0]: MCP без поля «name»');
  });

  it('сообщает о MCP без transport', () => {
    const problems = validatePackManifest({
      ...base,
      provides: { mcp: [{ name: 'no-transport' }] },
    });
    expect(problems).toContain('provides.mcp[0]: MCP без поля «transport»');
  });

  it('сообщает о неизвестном транспорте MCP', () => {
    const problems = validatePackManifest({
      ...base,
      provides: { mcp: [{ name: 'ws', transport: 'websocket' }] },
    });
    expect(problems.some((problem) => problem.includes('неизвестный транспорт MCP'))).toBe(true);
  });

  it('сообщает о скилле без name', () => {
    const problems = validatePackManifest({
      ...base,
      provides: { skills: [{ path: 'skills/demo' }] },
    });
    expect(problems).toContain('provides.skills[0]: скилл без поля «name»');
  });

  it('сообщает о скилле без path', () => {
    const problems = validatePackManifest({
      ...base,
      provides: { skills: [{ name: 'demo' }] },
    });
    expect(problems).toContain('provides.skills[0]: скилл без поля «path»');
  });

  it('сообщает о пайплайне без id', () => {
    const problems = validatePackManifest({
      ...base,
      provides: { pipelines: [{ path: 'pipelines/demo.json' }] },
    });
    expect(problems).toContain('provides.pipelines[0]: пайплайн без поля «id»');
  });

  it('сообщает о неизвестной capability агента', () => {
    const problems = validatePackManifest({
      ...base,
      provides: { agents: [{ id: 'a1', capabilities: ['file_read', 'unknown_cap'] }] },
    });
    expect(problems.some((problem) => problem.includes('неизвестная capability'))).toBe(true);
  });

  it('принимает известные capability агента', () => {
    const problems = validatePackManifest({
      ...base,
      provides: { agents: [{ id: 'a1', capabilities: ['file_read', 'mcp', 'user'] }] },
    });
    expect(problems).toEqual([]);
  });

  it('сообщает, что манифест — не объект', () => {
    expect(validatePackManifest('не манифест')).toEqual(['манифест: ожидается объект']);
  });

  it('сообщает, что provides — не объект', () => {
    const problems = validatePackManifest({ ...base, provides: [] });
    expect(problems).toContain('provides: ожидается объект с объявлениями вкладов');
  });

  it('сообщает, что provides.mcp — не объект и не массив', () => {
    const problems = validatePackManifest({ ...base, provides: { mcp: 'oops' } });
    expect(problems).toContain('provides.mcp: ожидается объект или массив объектов');
  });

  it('сообщает, что provides.skills — не массив', () => {
    const problems = validatePackManifest({ ...base, provides: { skills: { name: 'demo' } } });
    expect(problems).toContain('provides.skills: ожидается массив');
  });
});

describe('Реестры классов и типов расширений', () => {
  it('содержит классы из ADR-086 §5', () => {
    expect([...PACK_KINDS]).toEqual(['plugin', 'gateway', 'addon', 'pack', 'storage']);
  });

  it('содержит типы контент-пака из ADR-086 §5', () => {
    expect([...PACK_TYPES]).toEqual([
      'skills',
      'agents',
      'mcp',
      'themes',
      'i18n',
      'providers',
      'prompts',
      'automation',
      'policies',
      'memory',
      'ui',
    ]);
  });
});

// --- ADR-090: поля плагина и явные схемы вкладов ---

/** Валидный манифест плагина (все поля ADR-090). */
const PLUGIN_MANIFEST = {
  name: 'demo-plugin',
  version: '1.0.0',
  kind: 'plugin',
  host: '^1.0.0',
  contracts: { extensionApi: '^1' },
  description: 'Демонстрационный плагин',
  mode: 'inline',
  permissions: {
    network: ['api.example.com'],
    secrets: ['demo-token'],
    tools: ['read_file'],
    hooks: ['message_received'],
  },
  trust: { level: 'trusted', source: 'local' },
  provides: {
    tools: ['memory_search'],
    promptBlocks: [
      { key: 'plugin.demo.memory', tier: 'context', order: 100, title: 'Память', provenance: 'plugin:demo-plugin' },
    ],
    llmFilters: [
      { id: 'plugin:demo-plugin:pii', phase: 'pre_request', failMode: 'closed', timeoutMs: 500 },
    ],
  },
} as const;

describe('Манифест плагина — поля ADR-090 сохраняются (регрессия z.object)', () => {
  it('mode/permissions/trust не выбрасываются при safeParse', () => {
    const parsed = packManifestSchema.safeParse(PLUGIN_MANIFEST);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.mode).toBe('inline');
    expect(parsed.data.permissions).toEqual(PLUGIN_MANIFEST.permissions);
    expect(parsed.data.trust).toEqual(PLUGIN_MANIFEST.trust);
  });

  it('provides.tools/promptBlocks/llmFilters сохраняются и валидируются', () => {
    const parsed = packManifestSchema.safeParse(PLUGIN_MANIFEST);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.provides.tools).toEqual(['memory_search']);
    expect(parsed.data.provides.promptBlocks).toEqual(PLUGIN_MANIFEST.provides.promptBlocks);
    expect(parsed.data.provides.llmFilters).toEqual(PLUGIN_MANIFEST.provides.llmFilters);
  });

  it('неизвестный режим исполнения отклоняется', () => {
    const parsed = packManifestSchema.safeParse({ ...PLUGIN_MANIFEST, mode: 'sandbox' });
    expect(parsed.success).toBe(false);
  });

  it('неизвестный уровень доверия отклоняется схемой', () => {
    const parsed = packManifestSchema.safeParse({
      ...PLUGIN_MANIFEST,
      trust: { level: 'root' },
    });
    expect(parsed.success).toBe(false);
  });
});

describe('provides плагина — явные схемы (ADR-090)', () => {
  it('отклоняет пустое имя тула', () => {
    const parsed = packManifestSchema.safeParse({
      ...PLUGIN_MANIFEST,
      provides: { tools: [''] },
    });
    expect(parsed.success).toBe(false);
  });

  it('отклоняет дубли имён тулов', () => {
    const parsed = packManifestSchema.safeParse({
      ...PLUGIN_MANIFEST,
      provides: { tools: ['memory_search', 'memory_search'] },
    });
    expect(parsed.success).toBe(false);
  });

  it('отклоняет тир stable в promptBlocks (граница prompt-cache, ADR-070)', () => {
    const parsed = packManifestSchema.safeParse({
      ...PLUGIN_MANIFEST,
      provides: {
        promptBlocks: [{ key: 'plugin.demo.stable', tier: 'stable', order: 1 }],
      },
    });
    expect(parsed.success).toBe(false);
  });

  it('отклоняет неизвестное поле в promptBlocks (.strict())', () => {
    const parsed = packManifestSchema.safeParse({
      ...PLUGIN_MANIFEST,
      provides: {
        promptBlocks: [{ key: 'plugin.demo.block', tier: 'volatile', order: 1, tierr: 'x' }],
      },
    });
    expect(parsed.success).toBe(false);
  });

  it('отклоняет неизвестную фазу llmFilters', () => {
    const parsed = packManifestSchema.safeParse({
      ...PLUGIN_MANIFEST,
      provides: {
        llmFilters: [{ id: 'plugin:demo:x', phase: 'post_tool' }],
      },
    });
    expect(parsed.success).toBe(false);
  });

  it('отклоняет неизвестное поле в llmFilters (.strict())', () => {
    const parsed = packManifestSchema.safeParse({
      ...PLUGIN_MANIFEST,
      provides: {
        llmFilters: [{ id: 'plugin:demo:x', phase: 'pre_request', failmode: 'open' }],
      },
    });
    expect(parsed.success).toBe(false);
  });
});

describe('validatePackManifest — правила 12–14 (ADR-090)', () => {
  it('валидный плагин не даёт проблем', () => {
    expect(packManifestSchema.safeParse(PLUGIN_MANIFEST).success).toBe(true);
    expect(validatePackManifest(PLUGIN_MANIFEST)).toEqual([]);
  });

  it('provides.tools снимает срабатывание правила «ни один вклад»', () => {
    const problems = validatePackManifest({
      ...PLUGIN_MANIFEST,
      provides: { tools: ['memory_search'] },
    });
    expect(problems).toEqual([]);
  });

  it('сообщает о дубликате имени тула (правило 12)', () => {
    const problems = validatePackManifest({
      ...PLUGIN_MANIFEST,
      provides: { tools: ['dup', 'dup'] },
    });
    expect(problems.some((problem) => problem.includes('дубликат имени тула'))).toBe(true);
  });

  it('сообщает о тире stable в promptBlocks', () => {
    const problems = validatePackManifest({
      ...PLUGIN_MANIFEST,
      provides: { promptBlocks: [{ key: 'plugin.demo.x', tier: 'stable', order: 1 }] },
    });
    expect(problems.some((problem) => problem.startsWith('provides.promptBlocks[0]:'))).toBe(true);
  });

  it('сообщает о неизвестной фазе llmFilters', () => {
    const problems = validatePackManifest({
      ...PLUGIN_MANIFEST,
      provides: { llmFilters: [{ id: 'plugin:demo:x', phase: 'nope' }] },
    });
    expect(problems.some((problem) => problem.startsWith('provides.llmFilters[0]:'))).toBe(true);
  });

  it('сообщает о дубликате id фильтра', () => {
    const problems = validatePackManifest({
      ...PLUGIN_MANIFEST,
      provides: {
        llmFilters: [
          { id: 'plugin:demo:x', phase: 'pre_request' },
          { id: 'plugin:demo:x', phase: 'post_response' },
        ],
      },
    });
    expect(problems.some((problem) => problem.includes('дубликат id фильтра'))).toBe(true);
  });

  it('mode допустим только у kind «plugin» (правило 13)', () => {
    const problems = validatePackManifest({
      ...PLUGIN_MANIFEST,
      kind: 'addon',
      provides: { skills: [{ name: 'demo', path: 'skills/demo' }] },
    });
    expect(problems.some((problem) => problem.startsWith('mode: допустим только'))).toBe(true);
  });

  it('trust.level плагина не выше trusted (правило 14)', () => {
    for (const level of ['builtin', 'verified']) {
      const problems = validatePackManifest({
        ...PLUGIN_MANIFEST,
        trust: { level },
      });
      expect(problems.some((problem) => problem.includes('выше trust-floor'))).toBe(true);
    }
  });

  it('trust.level trusted/community допустим для плагина', () => {
    for (const level of ['trusted', 'community']) {
      const problems = validatePackManifest({
        ...PLUGIN_MANIFEST,
        trust: { level },
      });
      expect(problems).toEqual([]);
    }
  });

  it('trust.level выше trusted у не-плагина допустим', () => {
    const problems = validatePackManifest({
      ...SYNTH_MEDIA_MANIFEST,
      trust: { level: 'verified' },
    });
    expect(problems).toEqual([]);
  });
});

describe('diffPackProvides — сверка объявленного и зарегистрированного', () => {
  it('совпадение — пустой список', () => {
    expect(
      diffPackProvides(
        { tools: ['a'], promptBlocks: [{ key: 'k' }], llmFilters: [{ id: 'f' }] },
        { tools: ['a'], promptBlocks: ['k'], llmFilters: ['f'] },
      ),
    ).toEqual([]);
  });

  it('объявлено, но не зарегистрировано → missing; наоборот → unexpected', () => {
    expect(
      diffPackProvides(
        { tools: ['declared-only'], promptBlocks: [{ key: 'k' }], llmFilters: [{ id: 'f' }] },
        { tools: ['registered-only'], promptBlocks: ['k2'], llmFilters: ['f2'] },
      ),
    ).toEqual([
      { kind: 'tool', name: 'declared-only', issue: 'missing' },
      { kind: 'tool', name: 'registered-only', issue: 'unexpected' },
      { kind: 'promptBlock', name: 'k', issue: 'missing' },
      { kind: 'promptBlock', name: 'k2', issue: 'unexpected' },
      { kind: 'llmFilter', name: 'f', issue: 'missing' },
      { kind: 'llmFilter', name: 'f2', issue: 'unexpected' },
    ]);
  });
});
