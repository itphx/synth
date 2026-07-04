import { spawn } from 'node:child_process';
import { Hono } from 'hono';
import type { AuthKit } from '../../auth/local.js';
import { checkForUpdates } from '../../update-checker.js';

export function createUpdateRoutes(auth: AuthKit, dataDir: string): Hono {
  const app = new Hono();

  app.get('/check', auth.requireAuth, async (c) => {
    try {
      const info = await checkForUpdates(dataDir);
      return c.json(info);
    } catch (err) {
      return c.json({
        error: { code: 'UPDATE_CHECK_FAILED', message: err instanceof Error ? err.message : 'Ошибка проверки обновлений' },
      }, 502);
    }
  });

  app.post('/apply', auth.requireAuth, async (c) => {
    const signal = c.req.raw.signal;

    const stream = new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();

        const send = (data: Record<string, unknown>) => {
          try {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
          } catch {
            // disconnected
          }
        };

        send({ type: 'start', message: 'Установка @itphx/synth@latest...' });

        const child = spawn('npm', ['install', '-g', '@itphx/synth@latest'], {
          stdio: ['ignore', 'pipe', 'pipe'],
          env: { ...process.env },
        });

        if (child.stdout) {
          child.stdout.on('data', (chunk: Buffer) => {
            send({ type: 'progress', data: chunk.toString().trim() });
          });
        }

        if (child.stderr) {
          child.stderr.on('data', (chunk: Buffer) => {
            send({ type: 'stderr', data: chunk.toString().trim() });
          });
        }

        child.on('close', (code) => {
          if (code === 0) {
            send({ type: 'done', message: 'Обновление установлено. Перезапустите synth serve.' });
          } else {
            send({ type: 'error', message: `npm завершился с кодом ${code}` });
          }
          try { controller.close(); } catch { /* already closed */ }
        });

        child.on('error', (err) => {
          send({ type: 'error', message: err.message });
          try { controller.close(); } catch { /* already closed */ }
        });

        signal.addEventListener('abort', () => {
          child.kill('SIGTERM');
          try { controller.close(); } catch { /* already closed */ }
        }, { once: true });
      },
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
      },
    });
  });

  return app;
}
