import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { nowISO, ToolCapability } from '@itphx/shared';
import type { ToolDefinition } from '@itphx/shared';
import type { SessionManager } from '../../sessions/manager.js';
import type { EventBus } from '../../events/bus.js';

export interface PlanToolExtra {
  sessionManager?: SessionManager;
  eventBus?: EventBus;
  sessionId?: string;
}

const PLANS_DIR = join('.synth', 'plans');
const MAX_SLUG_LENGTH = 50;

const TRANSLIT_MAP: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i',
  й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't',
  у: 'u', ф: 'f', х: 'kh', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y',
  ь: '', э: 'e', ю: 'yu', я: 'ya',
};

/** Транслитерация кириллицы + безопасные символы (a-z0-9-), максимум 50 символов. */
export function slugifyPlan(plan: string): string {
  const firstLine = (plan.split('\n')[0] ?? '').replace(/^#+\s*/, '').trim();
  const title = (firstLine || plan).split(/\s+/).slice(0, 6).join(' ');
  const lower = title.toLowerCase();

  let result = '';
  for (const ch of lower) {
    if (/[a-z0-9]/.test(ch)) {
      result += ch;
    } else if (TRANSLIT_MAP[ch]) {
      result += TRANSLIT_MAP[ch];
    } else if (ch === ' ' || ch === '-' || ch === '_') {
      result += '-';
    }
  }
  result = result.replace(/-+/g, '-').replace(/^-|-$/g, '');
  if (!result) result = 'plan';
  return result.slice(0, MAX_SLUG_LENGTH);
}

function planTimestamp(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

async function updateSessionMode(
  sessionManager: SessionManager,
  sessionId: string,
  patch: { mode: 'plan' | 'act'; planPath?: string; planContent?: string },
): Promise<boolean> {
  try {
    await sessionManager.withLock(sessionId, async (s) => {
      s.mode = patch.mode;
      if (patch.planPath !== undefined) s.planPath = patch.planPath;
      if (patch.planContent !== undefined) s.planContent = patch.planContent;
      await sessionManager.saveSession(s);
    });
    return true;
  } catch {
    return false;
  }
}

export const planEnterTool: ToolDefinition = {
  name: 'plan_enter',
  description:
    'Enter plan mode: all file writes (write_file, edit_file, create_directory, delete_file) are blocked except .synth/plans/*.md. '
    + 'Use it for complex tasks that require investigation and a written plan before making changes. '
    + 'Call plan_exit with the plan to approve it and switch back to act mode.',
  parameters: z.object({}).describe('No parameters required'),
  capabilities: [ToolCapability.RUNTIME],
  async execute(_args, ctx) {
    const extra = ctx.extra as PlanToolExtra | undefined;
    if (!extra?.sessionManager || !extra.sessionId) {
      return {
        content: 'Ошибка: менеджер сессий недоступен для plan_enter',
        isError: true,
      };
    }
    const ok = await updateSessionMode(extra.sessionManager, extra.sessionId, { mode: 'plan' });
    if (!ok) {
      return { content: 'Ошибка: не удалось переключить сессию в режим plan', isError: true };
    }
    return {
      content:
        'Режим plan активирован: запись файлов заблокирована (кроме .synth/plans/*.md), чтение разрешено. '
        + 'Исследуй задачу, составь план и утверди его через plan_exit(plan="...") для перехода в режим act.',
      metadata: { mode: 'plan' },
    };
  },
};

export const planExitTool: ToolDefinition = {
  name: 'plan_exit',
  description:
    'Approve the current plan: writes it to .synth/plans/{timestamp}-{slug}.md in the working directory, '
    + 'stores it in the session state (it will be embedded into subsequent system prompts), '
    + 'and switches the session back to act mode (writes allowed). '
    + 'Parameters: plan — the full plan text (markdown).',
  parameters: z.object({
    plan: z.string().describe('The plan text (markdown) to approve and save'),
  }),
  capabilities: [ToolCapability.RUNTIME],
  async execute(args, ctx) {
    const parsed = this.parameters.safeParse(args);
    if (!parsed.success) {
      return {
        content: `Ошибка аргументов инструмента "${this.name}": ${parsed.error.issues.map((i) => `${i.path.join('.') || 'root'}: ${i.message}`).join('; ')}`,
        isError: true,
      };
    }
    const params = parsed.data as { plan: string };
    const extra = ctx.extra as PlanToolExtra | undefined;

    const planText = params.plan.trim();
    if (!planText) {
      return { content: 'Ошибка: план не может быть пустым', isError: true };
    }

    const slug = slugifyPlan(planText);
    const ts = planTimestamp();
    const relativePath = join(PLANS_DIR, `${ts}-${slug}.md`);
    const absolutePath = join(ctx.workingDir, relativePath);

    const now = nowISO();
    const fileContent = `# План: ${slug}\n> Создан: ${now}\n> Утверждён: ${now}\n\n${planText}\n`;

    try {
      await mkdir(join(ctx.workingDir, PLANS_DIR), { recursive: true });
      await writeFile(absolutePath, fileContent, 'utf-8');
    } catch (err) {
      return {
        content: `Ошибка записи плана: ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
        metadata: { plan_path: absolutePath },
      };
    }

    if (extra?.sessionManager && extra.sessionId) {
      const ok = await updateSessionMode(extra.sessionManager, extra.sessionId, {
        mode: 'act',
        planPath: absolutePath,
        planContent: planText,
      });
      if (!ok) {
        return {
          content: `План записан в ${relativePath}, но не удалось сохранить его в состоянии сессии`,
          isError: true,
          metadata: { plan_path: absolutePath },
        };
      }
    }

    extra?.eventBus?.publish(extra.sessionId ?? '', 'plan.approved', {
      session_id: extra.sessionId ?? '',
      plan_path: absolutePath,
      plan_content: planText,
    });

    return {
      content: `План утверждён. Сохранено: ${relativePath}`,
      metadata: {
        plan_path: absolutePath,
        plan_file: relativePath,
        plan_slug: slug,
        plan_content: planText,
      },
    };
  },
};
