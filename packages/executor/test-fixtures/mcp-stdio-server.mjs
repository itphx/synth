#!/usr/bin/env node
/**
 * Тестовый MCP-сервер (stdio) для юнит-тестов пакета `@itphx/synth-executor`.
 *
 * Настоящий MCP-сервер на том же SDK, что и в production-коде: тесты
 * проверяют **реальный** handshake (`initialize` → `tools/list` → `tools/call`),
 * а не мок. Внешние пакеты не тянутся — используется уже подключённый
 * `@modelcontextprotocol/sdk`.
 *
 * Режимы (`--mode=`):
 *
 * | Режим | Поведение |
 * |---|---|
 * | `normal` (по умолчанию) | обычный сервер с инструментами |
 * | `crash` | процесс сразу завершается с кодом 3 (сервер не поднимается) |
 * | `hang` | процесс жив, но не отвечает на `initialize` (таймаут подключения) |
 *
 * Инструменты в режиме `normal`:
 *
 * - `echo` — возвращает переданный текст;
 * - `boom` — возвращает ошибку инструмента (`isError`);
 * - `huge` — возвращает большой текст (проверка усечения);
 * - `slow` — спит `sleepMs` (по умолчанию 5000) мс (проверка таймаута вызова);
 * - `suicide` — завершает процесс сервера (проверка падения на лету).
 *
 * Запуск: `node test-fixtures/mcp-stdio-server.mjs [--mode=normal]`
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { writeFileSync } from 'node:fs';

const modeArg = process.argv.find((arg) => arg.startsWith('--mode='));
const mode = modeArg ? modeArg.slice('--mode='.length) : 'normal';

// Pid-файл — для проверки, что после остановки исполнителя дочерний процесс
// сервера не остаётся жив (тест «close() завершает дочерний процесс»).
if (process.env.MCP_TEST_PID_FILE) {
  writeFileSync(process.env.MCP_TEST_PID_FILE, String(process.pid), 'utf8');
}

if (mode === 'crash') {
  // Сервер не поднимается: клиент должен получить ошибку подключения.
  process.exit(3);
}

if (mode === 'hang') {
  // Процесс жив, но handshake не проходит — клиент упадёт по таймауту.
  setInterval(() => {}, 1_000);
} else {
  const server = new Server(
    { name: 'synth-test-mcp', version: '1.0.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'echo',
        description: 'Возвращает переданный текст',
        inputSchema: {
          type: 'object',
          properties: { text: { type: 'string' } },
          required: ['text'],
        },
      },
      {
        name: 'boom',
        description: 'Возвращает ошибку инструмента',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'huge',
        description: 'Возвращает большой текст',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'slow',
        description: 'Спит заданное число миллисекунд',
        inputSchema: {
          type: 'object',
          properties: { sleepMs: { type: 'number' } },
        },
      },
      {
        name: 'suicide',
        description: 'Завершает процесс сервера',
        inputSchema: { type: 'object', properties: {} },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name;
    const args = request.params.arguments ?? {};
    switch (name) {
      case 'echo':
        return { content: [{ type: 'text', text: String(args.text ?? '') }] };
      case 'boom':
        return {
          isError: true,
          content: [
            {
              type: 'text',
              // Значение из env — чтобы тест проверил, что секрет не утекает
              // в текст ошибки наружу.
              text: `инструмент упал: ${process.env.TEST_SECRET ?? 'секрета нет'}`,
            },
          ],
        };
      case 'huge':
        return { content: [{ type: 'text', text: 'x'.repeat(50_000) }] };
      case 'slow': {
        const sleepMs = typeof args.sleepMs === 'number' ? args.sleepMs : 5_000;
        await new Promise((resolve) => setTimeout(resolve, sleepMs));
        return { content: [{ type: 'text', text: 'дождался' }] };
      }
      case 'suicide':
        setTimeout(() => process.exit(0), 10);
        return { content: [{ type: 'text', text: 'сервер уходит' }] };
      default:
        return {
          isError: true,
          content: [{ type: 'text', text: `неизвестный инструмент: ${name}` }],
        };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
