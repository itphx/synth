import { z } from 'zod';
import { ToolCapability } from '@synth/shared';
import type { ToolDefinition } from '@synth/shared';

const MAX_RESPONSE_SIZE = 50_000;

export const webFetchTool: ToolDefinition = {
  name: 'web_fetch',
  description:
    'Fetch content from a URL and convert to markdown. Use this to retrieve and analyze web content.',
  parameters: z.object({
    url: z.string().describe('The URL to fetch content from'),
    format: z.enum(['text', 'markdown', 'html']).optional().default('markdown')
      .describe('The format to return the content in (default: markdown)'),
    timeout: z.number().int().min(1).max(120).optional().describe('Timeout in seconds (max 120)'),
  }),
  capabilities: [ToolCapability.WEB],
  async execute(args, _ctx) {
    const params = args as { url: string; format?: 'text' | 'markdown' | 'html'; timeout?: number };

    try {
      const controller = new AbortController();
      const timeout = (params.timeout ?? 30) * 1000;
      const timer = setTimeout(() => controller.abort(), timeout);

      const response = await fetch(params.url, {
        signal: controller.signal,
        headers: {
          'User-Agent': 'Synth/1.0',
          'Accept': 'text/html, text/plain, application/json',
        },
      });
      clearTimeout(timer);

      if (!response.ok) {
        return {
          content: `Ошибка HTTP ${response.status}: ${response.statusText}`,
          isError: true,
          metadata: { url: params.url, status: response.status },
        };
      }

      const contentType = response.headers.get('content-type') || '';
      let content: string;

      if (contentType.includes('application/json')) {
        const json = await response.json();
        content = JSON.stringify(json, null, 2);
      } else {
        content = await response.text();
      }

      if (content.length > MAX_RESPONSE_SIZE) {
        content = content.slice(0, MAX_RESPONSE_SIZE) + '\n... (содержимое обрезано)';
      }

      return {
        content,
        metadata: { url: params.url, status: response.status, contentType, size: content.length },
      };
    } catch (err: unknown) {
      const error = err as Error;
      return {
        content: `Ошибка загрузки URL: ${error.message || String(err)}`,
        isError: true,
        metadata: { url: params.url },
      };
    }
  },
};

export const webSearchTool: ToolDefinition = {
  name: 'web_search',
  description:
    'Search the web for information. Returns search results. This is a placeholder — configure a search provider to enable.',
  parameters: z.object({
    query: z.string().describe('Search query'),
    max_results: z.number().int().min(1).max(20).optional().default(5)
      .describe('Maximum number of results (default: 5)'),
  }),
  capabilities: [ToolCapability.WEB],
  async execute(args, _ctx) {
    const params = args as { query: string; max_results?: number };

    return {
      content: `Веб-поиск не настроен. Провайдер поиска отсутствует.\nЗапрос: "${params.query}"\nДля настройки поиска обратитесь к администратору.`,
      isError: true,
      metadata: { query: params.query },
    };
  },
};
