import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDefaultTitle } from '@itphx/synth-shared';
import type { Session } from '@itphx/synth-shared';
import type { SessionManager } from './manager.js';
import type { BaseProvider, LLMMessage, CancellationToken } from '../providers/base.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadTitlePrompt(): string {
  const paths = [
    join(__dirname, '..', 'engine', 'context', 'prompts', 'roles', 'TITLE.ru.md'),
    join(__dirname, '..', 'engine', 'agents', 'definitions', 'title.txt'),
    join(__dirname, '..', '..', 'prompts', 'roles', 'TITLE.ru.md'),
  ];
  for (const p of paths) {
    if (existsSync(p)) {
      return readFileSync(p, 'utf-8');
    }
  }
  return 'Сгенерируй краткий заголовок (3-7 слов) для этого диалога. Верни только заголовок, без пояснений.';
}

const TITLE_SYSTEM_PROMPT = loadTitlePrompt();

export async function autoTitleSession(
  session: Session,
  manager: SessionManager,
  provider: BaseProvider,
): Promise<void> {
  try {
    if (session.parentId) return;
    if (!isDefaultTitle(session.title)) return;

    const userMsgs = session.messages.filter(
      (m) => m.role === 'user' && !m.metadata?.synthetic,
    );
    if (userMsgs.length === 0) return;
    if (userMsgs.length > 1) return;

    const firstUser = userMsgs[0]!;
    const firstAssistant = session.messages.find(
      (m) => m.role === 'assistant' && m.origin === 'local',
    );

    const promptParts: string[] = [];
    promptParts.push(firstUser.content.substring(0, 500));
    if (firstAssistant) {
      promptParts.push(firstAssistant.content.substring(0, 500));
    }
    const userContent = `Сгенерируй краткий заголовок для этого диалога:\n\n${promptParts.join('\n\n')}`;

    const messages: LLMMessage[] = [
      {
        id: '',
        role: 'user',
        content: userContent,
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        disabled: false,
        pinned: false,
        branchId: '',
      },
    ];

    const cancelToken: CancellationToken = {
      cancelled: false,
      cancel: () => { cancelToken.cancelled = true; },
    };

    const response = await provider.chat(
      messages,
      TITLE_SYSTEM_PROMPT,
      undefined,
      false,
      undefined,
    );

    let text = (response.content || '').trim();
    text = text
      .replace(/<think>[\s\S]*?<\/think>\s*/g, '')
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line.length > 0)
      || '';

    text = text.replace(/^["']|["']$/g, '').trim();
    if (!text) return;

    const title = text.length > 100 ? text.substring(0, 97) + '...' : text;

    const current = await manager.getSession(session.id);
    if (!current || !isDefaultTitle(current.title)) return;

    await manager.renameSession(session.id, title);
  } catch {
    // daemon — ошибки не всплывают
  }
}
