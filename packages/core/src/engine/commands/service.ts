import type {
  CommandDiagnostic,
  CommandResolveResult,
  CommandResolveStatus,
  CommandRuntime,
  CommandSummary,
  PermissionConfig,
  SkillBundle,
  SkillSummary,
} from '@itphx/synth-shared';
import type { DiscoveredSkill, LoadedSkill, SkillRuntime } from '../skills/types.js';
import { isDisabledBySession, matchesBinding, missingCapabilities } from '../skills/scope.js';
import { buildSkillContentBlock } from '../skills/loader.js';
import { resolveCommandRule } from '../permission/evaluator.js';
import { t as sm } from '../system-messages.js';
import { CommandRegistry } from './registry.js';
import { buildCommandSources } from './discovery.js';
import { isBuiltinCommand, renderCommandsList, renderHelp, renderInitPrompt, renderSkillsList } from './builtin.js';
import { loadBundle, parseBundleFile } from './bundles.js';
import { renderTemplate } from './template.js';
import { parseCommandInput, resolveCatalog } from './resolver.js';
import type {
  CommandCatalog,
  CommandContext,
  CommandRuntimeConfig,
  CommandSkillEntry,
} from './types.js';
import type { SkillBundleStore } from '../../storage/skill-bundle-store.js';

/** Источник скиллов для каталога команд (структурно — `SkillService`). */
export interface CommandSkillSource {
  listSummaries(opts?: { projectWorkspace?: string; capabilities?: readonly string[] }):
    Promise<{ skills: SkillSummary[]; diagnostics: unknown[] }>;
  get(name: string, opts?: { projectWorkspace?: string }): Promise<DiscoveredSkill | undefined>;
  load(name: string, opts?: { projectWorkspace?: string; capabilities?: readonly string[] }): Promise<LoadedSkill | undefined>;
}

export interface CommandServiceOptions {
  config: CommandRuntimeConfig;
  skillRuntime: SkillRuntime;
  skillSource: CommandSkillSource;
  registry?: CommandRegistry;
  bundleStore?: SkillBundleStore;
}

/**
 * AD-046 §7: фасад резолвинга `/`-команд — discovery шаблонов, встроенные
 * команды, скиллы-как-команды и bundles. Единый путь для UI/CLI/гибрида;
 * оркестратор получает объект через `OrchestratorOptions.commandRuntime`.
 */
export class CommandService implements CommandRuntime {
  private readonly _config: CommandRuntimeConfig;
  private readonly _skillRuntime: SkillRuntime;
  private readonly _skillSource: CommandSkillSource;
  private readonly _registry: CommandRegistry;
  private readonly _bundleStore: SkillBundleStore | null;

  constructor(opts: CommandServiceOptions) {
    this._config = opts.config;
    this._skillRuntime = opts.skillRuntime;
    this._skillSource = opts.skillSource;
    this._registry = opts.registry ?? new CommandRegistry({
      sources: (o) => buildCommandSources({
        dataDir: this._config.dataDir,
        projectWorkspace: o?.projectWorkspace,
        configPaths: this._config.commandsPaths,
        trustedProjectDirs: this._config.trustedProjectDirs,
        home: this._config.home,
      }),
    });
    this._bundleStore = opts.bundleStore ?? null;
  }

  /** Принудительный ре-скан шаблонных команд. */
  reload(): void {
    this._registry.reload();
  }

  async list(opts?: {
    projectWorkspace?: string;
    capabilities?: readonly string[];
    agent?: { id?: string; groups?: string[] };
    sessionEnabled?: string[];
    sessionDisabled?: string[];
    permissionConfig?: PermissionConfig;
  }): Promise<{ commands: CommandSummary[]; diagnostics: CommandDiagnostic[] }> {
    const catalog = await this._buildCatalog({
      projectWorkspace: opts?.projectWorkspace,
      capabilities: opts?.capabilities,
      agent: opts?.agent,
      sessionEnabled: opts?.sessionEnabled,
      sessionDisabled: opts?.sessionDisabled,
      permissionConfig: opts?.permissionConfig,
    });
    const visible = catalog.entries.filter(
      (e) => resolveCommandRule(opts?.permissionConfig, e.summary.name)?.action !== 'deny',
    );
    return {
      commands: visible.map((e) => e.summary),
      diagnostics: catalog.diagnostics,
    };
  }

  async resolve(
    input: string,
    opts?: {
      projectWorkspace?: string;
      capabilities?: readonly string[];
      agent?: { id?: string; groups?: string[] };
      sessionEnabled?: string[];
      sessionDisabled?: string[];
      permissionConfig?: PermissionConfig;
      /** AD-046 §7.4: раннер inline shell (готовое замыкание от оркестратора). */
      runShell?: (cmd: string) => Promise<{ output: string; isError: boolean }>;
    },
  ): Promise<CommandResolveResult | undefined> {
    const parsed = parseCommandInput(input);
    if (!parsed) return undefined;
    const { name, args } = parsed;
    const ctx: CommandContext = {
      projectWorkspace: opts?.projectWorkspace,
      capabilities: opts?.capabilities,
      agent: opts?.agent,
      sessionEnabled: opts?.sessionEnabled,
      sessionDisabled: opts?.sessionDisabled,
      permissionConfig: opts?.permissionConfig,
      runShell: opts?.runShell,
    };
    const catalog = await this._buildCatalog(ctx);
    const entry = catalog.entries.find((e) => e.summary.name === name);

    const decision = resolveCommandRule(ctx.permissionConfig, name);
    if (decision?.action === 'deny') {
      return { status: 'denied', name, args, output: sm('command.denied', { name }), message: decision.reason };
    }
    if (!entry) {
      return { status: 'unknown', name, args, output: sm('command.unknown', { name }) };
    }

    switch (entry.kind) {
      case 'builtin':
        return this._resolveBuiltin(name, args, catalog, ctx);
      case 'template': {
        const rendered = await renderTemplate(entry.template, {
          workingDir: ctx.projectWorkspace ?? this._config.dataDir,
          args,
          maxArgumentsLength: this._config.maxArgumentsLength,
          maxRenderedBytes: this._config.maxRenderedBytes,
          inlineShell: this._config.inlineShell,
          runShell: ctx.runShell,
        });
        catalog.diagnostics.push(...rendered.diagnostics);
        return { status: 'template', name, args, kind: 'template', prompt: rendered.content, message: rendered.diagnostics.length > 0 ? rendered.diagnostics[0]!.message : undefined };
      }
      case 'skill': {
        const missing = missingCapabilities(
          await this._skillMeta(entry.skill.skillName, ctx),
          ctx.capabilities,
          this._config.toolsets,
        );
        if (missing.length > 0) {
          return {
            status: 'unavailable', name, args, kind: 'skill',
            output: sm('command.unavailable', { name, capabilities: missing.join(', ') }),
            message: missing.join(', '),
          };
        }
        const loaded = await this._skillSource.load(entry.skill.skillName, {
          projectWorkspace: ctx.projectWorkspace,
          capabilities: ctx.capabilities,
        });
        if (!loaded) {
          return { status: 'unknown', name, args, output: sm('command.unknown', { name }) };
        }
        const content = buildSkillContentBlock(loaded.summary, loaded.body, loaded.dir, loaded.files);
        return {
          status: 'skill', name, args, kind: 'skill',
          prompt: args.length > 0 ? `${content}\n\n${args}` : content,
          skills: [entry.skill.skillName],
        };
      }
      case 'bundle':
        return this._resolveBundle(entry.bundle, name, args, ctx);
    }
  }

  private async _resolveBuiltin(
    name: string,
    args: string,
    catalog: CommandCatalog,
    ctx: CommandContext,
  ): Promise<CommandResolveResult> {
    if (!isBuiltinCommand(name)) {
      return { status: 'unknown', name, args, output: sm('command.unknown', { name }) };
    }
    if (name === 'help') {
      return { status: 'builtin', name, args, kind: 'builtin', output: renderHelp() };
    }
    if (name === 'skills') {
      const skills = await this._skillEntries(ctx);
      return { status: 'builtin', name, args, kind: 'builtin', output: renderSkillsList(skills) };
    }
    if (name === 'commands') {
      const visible = catalog.entries
        .filter((e) => resolveCommandRule(ctx.permissionConfig, e.summary.name)?.action !== 'deny')
        .map((e) => e.summary);
      return { status: 'builtin', name, args, kind: 'builtin', output: renderCommandsList(visible) };
    }
    if (name === 'init') {
      // AD-069 §8.1: `/init` генерирует prompt для LLM (status `prompt`), а не
      // локальный ответ. `isLocalCommandStatus` его не покрывает — CLI не
      // короткозамыкает, оркестратор инжектит prompt в user-сообщение.
      return { status: 'prompt', name, args, kind: 'builtin', prompt: renderInitPrompt(args) };
    }
    // summary
    return { status: 'summarization', name, args, kind: 'builtin' };
  }

  private async _resolveBundle(
    bundle: SkillBundle,
    name: string,
    args: string,
    ctx: CommandContext,
  ): Promise<CommandResolveResult> {
    const loaded = await loadBundle(
      bundle,
      (skillName, o) => this._loadSkillContent(skillName, o?.projectWorkspace, ctx.capabilities),
      { projectWorkspace: ctx.projectWorkspace, maxRenderedBytes: this._config.maxRenderedBytes },
    );
    const prompt = args.length > 0 ? `${loaded.prompt}\n\n${args}` : loaded.prompt;
    return {
      status: 'bundle', name, args, kind: 'bundle',
      prompt,
      skills: loaded.skills,
      message: loaded.diagnostics.length > 0 ? loaded.diagnostics.map((d) => d.message).join('; ') : undefined,
    };
  }

  private async _loadSkillContent(
    skillName: string,
    projectWorkspace?: string,
    capabilities?: readonly string[],
  ): Promise<{ content: string; name: string } | undefined> {
    const loaded = await this._skillSource.load(skillName, { projectWorkspace, capabilities });
    if (!loaded) return undefined;
    return {
      content: buildSkillContentBlock(loaded.summary, loaded.body, loaded.dir, loaded.files),
      name: loaded.summary.name,
    };
  }

  private async _skillMeta(skillName: string, ctx: CommandContext) {
    const discovered = await this._skillSource.get(skillName, { projectWorkspace: ctx.projectWorkspace });
    return discovered?.meta ?? { requiresCapabilities: [], requiresToolsets: [] };
  }

  /** Проекция доступных скиллов в записи команд (trust/invocation/binding/deny). */
  private async _skillEntries(ctx: CommandContext): Promise<CommandSkillEntry[]> {
    const { skills } = await this._skillSource.listSummaries({
      projectWorkspace: ctx.projectWorkspace,
      capabilities: ctx.capabilities,
    });
    const out: CommandSkillEntry[] = [];
    for (const summary of skills) {
      if (!summary.trusted || !summary.userInvocable) continue;
      if (summary.invocation === 'none' || summary.invocation === 'model') continue;
      const discovered = await this._skillSource.get(summary.name, { projectWorkspace: ctx.projectWorkspace });
      const meta = discovered?.meta;
      if (!meta) continue;
      if (!matchesBinding(meta, ctx.agent)) continue;
      if (isDisabledBySession({ name: summary.name, category: summary.category, groups: summary.groups }, ctx.sessionDisabled)) continue;
      const commandName = meta.command ?? summary.name;
      if (resolveCommandRule(ctx.permissionConfig, commandName)?.action === 'deny') continue;
      const missing = missingCapabilities(meta, ctx.capabilities, this._config.toolsets);
      out.push({
        commandName,
        skillName: summary.name,
        description: summary.description,
        userInvocable: summary.userInvocable,
        modelInvocable: summary.modelInvocable,
        trusted: summary.trusted,
        requiresCapabilities: meta.requiresCapabilities ?? [],
        requiresToolsets: meta.requiresToolsets ?? [],
        available: missing.length === 0,
        argumentHint: meta.argumentHint,
      });
    }
    return out;
  }

  private async _buildCatalog(ctx: CommandContext): Promise<CommandCatalog> {
    const { commands: templates, diagnostics: templateDiags } = await this._registry.list({
      projectWorkspace: ctx.projectWorkspace,
    });
    // AD-046 §4.4/§7.1: недоверенные проектные template-команды не входят в
    // каталог — не резолвятся и не видны в `/`-автокомплите и GET /commands;
    // диагностика `untrusted` сохраняется (эмитится в discovery/merge).
    const trustedTemplates = templates.filter((t) => t.trusted);
    const skills = await this._skillEntries(ctx);
    const bundles = this._bundleStore ? await this._bundleStore.list() : [];
    const resolved = resolveCatalog({
      templates: trustedTemplates,
      skills,
      bundles,
      conflict: this._config.conflict,
    });
    return {
      builtins: [],
      templates: trustedTemplates,
      skills,
      bundles,
      diagnostics: [...templateDiags, ...resolved.diagnostics],
      entries: resolved.entries,
    };
  }
}

export { parseBundleFile };

/**
 * AD-046 §7.1: статусы, которые завершаются локальным ответом без LLM.
 * `summarization` сюда НЕ входит — `/summary` должен пройти через оркестратор
 * и запустить реальную суммаризацию (единое поведение CLI/SSE). `prompt`
 * (AD-069 §8.1, `/init`) тоже НЕ локальный: prompt уходит в LLM.
 */
export function isLocalCommandStatus(status: CommandResolveStatus): boolean {
  return status === 'builtin' || status === 'unknown' || status === 'denied' || status === 'unavailable';
}
