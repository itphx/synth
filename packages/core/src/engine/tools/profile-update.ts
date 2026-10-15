import { z } from 'zod';
import { nowISO, ToolCapability } from '@itphx/synth-shared';
import type { ToolDefinition, ProfileStore } from '@itphx/synth-shared';
import type { SessionManager } from '../../sessions/manager.js';
import { isAborted, abortedResult } from './abort.js';
import { t as sm, i18n as i18nMeta } from '../system-messages.js';

/**
 * Онбординг-интервью (PROP-083): агент сохраняет ответы пользователя в профиль
 * через этот тул. Резолв профиля повторяет `ContextBuilder._resolveProfile`
 * (id → username → создание), завершение помечается полем
 * `ProfileData.interviewCompleted` (см. `context/builder.ts`).
 */
export interface ProfileUpdateToolExtra {
  sessionManager?: SessionManager;
  profilesStore?: ProfileStore;
  sessionId?: string;
}

const profileUpdateSchema = z
  .object({
    display_name: z.string().optional().describe('Display name of the user'),
    email: z.string().optional().describe('Email address of the user'),
    phone: z.string().optional().describe('Phone number of the user'),
    notes: z.string().optional().describe('Free-form notes about the user (preferences, context)'),
    interview_completed: z
      .boolean()
      .optional()
      .describe('Mark the onboarding interview as completed (true) or not completed (false)'),
  })
  .refine(
    (v) =>
      v.display_name !== undefined
      || v.email !== undefined
      || v.phone !== undefined
      || v.notes !== undefined
      || v.interview_completed !== undefined,
    { message: 'at least one field must be provided' },
  );

function argError(toolName: string, issues: z.ZodIssue[]): string {
  return sm('tool.args_error', { tool: toolName, issues: issues
    .map((i) => `${i.path.join('.') || 'root'}: ${i.message}`)
    .join('; ') });
}

export const profileUpdateTool: ToolDefinition = {
  name: 'profile_update',
  description:
    'Update the current user profile (display name, email, phone, notes) and/or mark the onboarding interview as completed. '
    + 'Use it during onboarding to save the answers to the interview questions, then set interview_completed to true. '
    + 'Only the provided fields are changed. Returns the list of updated fields.',
  parameters: profileUpdateSchema,
  capabilities: [ToolCapability.USER],
  async execute(args, ctx) {
    // «Стоп» пришёл до запуска — операция не выполняется (см. tools/abort.ts)
    if (isAborted(ctx)) return abortedResult(this.name);

    const extra = ctx.extra as ProfileUpdateToolExtra | undefined;
    if (!extra?.sessionManager || !extra.profilesStore) {
      return {
        content: sm('profile.deps_unavailable', { tool: this.name }),
        isError: true,
        metadata: { i18n: i18nMeta('profile.deps_unavailable', { tool: this.name }) },
      };
    }

    const parsed = this.parameters.safeParse(args);
    if (!parsed.success) {
      return { content: argError(this.name, parsed.error.issues), isError: true };
    }
    const params = parsed.data as {
      display_name?: string;
      email?: string;
      phone?: string;
      notes?: string;
      interview_completed?: boolean;
    };

    const sessionId = ctx.sessionId || extra.sessionId;
    if (!sessionId) {
      return {
        content: sm('profile.session_not_found'),
        isError: true,
        metadata: { i18n: i18nMeta('profile.session_not_found') },
      };
    }

    let session;
    try {
      session = await extra.sessionManager.getSession(sessionId);
    } catch {
      return {
        content: sm('profile.session_read_error'),
        isError: true,
        metadata: { i18n: i18nMeta('profile.session_read_error') },
      };
    }
    if (!session) {
      return {
        content: sm('profile.session_not_found'),
        isError: true,
        metadata: { i18n: i18nMeta('profile.session_not_found') },
      };
    }

    // Владелец профиля: `userId` сессии может быть как id-профиля (UUID), так и
    // username. Без владельца (ephemeral/системные события) сохранять некуда.
    const userId = session.userId;
    if (!userId) {
      return {
        content: sm('profile.user_unavailable'),
        isError: true,
        metadata: { i18n: i18nMeta('profile.user_unavailable') },
      };
    }

    // Резолв как в `ContextBuilder._resolveProfile`: id → username → создание.
    let profile = await extra.profilesStore.loadProfile(userId);
    if (!profile) profile = await extra.profilesStore.getProfileByUsername(userId);
    if (!profile) profile = await extra.profilesStore.getOrCreateProfile({ username: userId });

    const fields: string[] = [];
    if (params.display_name !== undefined) {
      profile.displayName = params.display_name;
      fields.push('display_name');
    }
    if (params.email !== undefined) {
      profile.email = params.email;
      fields.push('email');
    }
    if (params.phone !== undefined) {
      profile.phone = params.phone;
      fields.push('phone');
    }
    if (params.notes !== undefined) {
      profile.notes = params.notes;
      fields.push('notes');
    }
    if (params.interview_completed !== undefined) {
      profile.interviewCompleted = params.interview_completed;
      profile.interviewCompletedAt = params.interview_completed ? nowISO() : undefined;
      fields.push('interview_completed');
    }
    profile.updatedAt = nowISO();

    try {
      await extra.profilesStore.saveProfile(profile);
    } catch (err) {
      return {
        content: sm('profile.save_error', { error: err instanceof Error ? err.message : String(err) }),
        isError: true,
      };
    }

    const summary = fields.join(', ');
    return {
      content: sm('profile.updated', { fields: summary }),
      metadata: {
        profile_id: profile.id,
        username: profile.username,
        fields,
        interview_completed: profile.interviewCompleted,
        i18n: i18nMeta('profile.updated', { fields: summary }),
      },
    };
  },
};
