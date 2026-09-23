import { z } from 'zod';
import { ToolCapability } from '@itphx/synth-shared';
import type { ToolDefinition } from '@itphx/synth-shared';
import { isAborted, abortedResult } from './abort.js';
import { t as sm, i18n as i18nMeta } from '../system-messages.js';
import { buildSkillContentBlock, truncateSkillOutput } from '../skills/loader.js';
import { missingCapabilities } from '../skills/scope.js';
import type { SkillRuntime } from '../skills/types.js';

/** `ctx.extra` для тула `skill` (пробрасывается оркестратором/саб-агентом). */
interface SkillToolExtra {
  skillRuntime?: SkillRuntime;
  agentRegistry?: { get(id: string): { capabilities?: readonly string[] } | undefined };
}

/**
 * AD-046 §5/§2.2: единственный core-тул скиллов. Возвращает тело `SKILL.md`
 * (`<skill_content>` + base directory + ≤10 supporting-файлов) либо точечный
 * supporting-файл (`file_path`). Скиллы **не регистрируют** тулы.
 */
export const skillTool: ToolDefinition = {
  name: 'skill',
  description:
    'Load the full instructions of a skill by name (progressive disclosure). '
    + 'The system prompt lists available skills; call this tool to read the body. '
    + 'Optionally pass file_path to read a supporting file of the skill.',
  parameters: z.object({
    name: z.string().describe('Skill name (from the skills catalog)'),
    file_path: z.string().optional().describe('Relative path of a supporting file inside the skill directory'),
  }),
  capabilities: [ToolCapability.FILE_READ],
  async execute(args, ctx) {
    if (isAborted(ctx)) return abortedResult(this.name);
    const parsed = this.parameters.safeParse(args);
    if (!parsed.success) {
      return {
        content: sm('skill.args_error', {
          issues: parsed.error.issues.map((i) => `${i.path.join('.') || 'root'}: ${i.message}`).join('; '),
        }),
        isError: true,
        metadata: { i18n: i18nMeta('skill.args_error') },
      };
    }
    const params = parsed.data as { name: string; file_path?: string };
    const extra = ctx.extra as SkillToolExtra | undefined;

    if (!extra?.skillRuntime) {
      return { content: sm('task.deps_unavailable'), isError: true };
    }
    const runtime = extra.skillRuntime;
    const projectWorkspace = ctx.workingDir;

    const skill = await runtime.get(params.name, { projectWorkspace });
    if (!skill) {
      return {
        content: sm('skill.not_found', { name: params.name }),
        isError: true,
        metadata: { i18n: i18nMeta('skill.not_found', { name: params.name }) },
      };
    }
    // AD-046 §4.4: недоверенный проектный скилл виден, но не грузится.
    if (!skill.trusted) {
      return {
        content: sm('skill.untrusted', { name: params.name }),
        isError: true,
        metadata: { i18n: i18nMeta('skill.untrusted', { name: params.name }) },
      };
    }

    // AD-046 §6.3: capability-aware — делегирование через `task`.
    const agentCapabilities = ctx.agentRole
      ? extra.agentRegistry?.get(ctx.agentRole)?.capabilities
      : undefined;
    const missing = missingCapabilities(skill.meta, agentCapabilities);
    if (missing.length > 0) {
      return {
        content: sm('skill.delegation', {
          name: params.name,
          capabilities: missing.join(', '),
          agent: ctx.agentRole || 'unknown',
        }),
        isError: true,
        metadata: {
          i18n: i18nMeta('skill.delegation', { name: params.name, capabilities: missing.join(', ') }),
          unavailable: 'capabilities',
        },
      };
    }

    // Уровень 3: точечное чтение supporting-файла (без повторной загрузки тела).
    if (params.file_path) {
      const content = await runtime.readSupportingFile(params.name, params.file_path, { projectWorkspace });
      if (content === undefined) {
        return {
          content: sm('skill.file_not_found', { path: params.file_path }),
          isError: true,
          metadata: { i18n: i18nMeta('skill.file_not_found', { path: params.file_path }) },
        };
      }
      return {
        content: truncateSkillOutput(content),
        metadata: { skill: params.name, path: params.file_path },
      };
    }

    const loaded = await runtime.load(params.name, { projectWorkspace, capabilities: agentCapabilities });
    if (!loaded) {
      return {
        content: sm('skill.not_found', { name: params.name }),
        isError: true,
        metadata: { i18n: i18nMeta('skill.not_found', { name: params.name }) },
      };
    }

    return {
      content: buildSkillContentBlock(loaded.summary, loaded.body, loaded.dir, loaded.files),
      metadata: { skill: loaded.summary.name, scope: loaded.summary.scope, files: loaded.files.length },
    };
  },
};
