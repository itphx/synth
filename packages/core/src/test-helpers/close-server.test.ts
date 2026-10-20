import { describe, it, expect } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Agent, request } from 'undici';
import { closeTestServer } from './close-server.js';

/**
 * Регрессия: первый живой прогон CI на релизе 0.11.3 упал с
 * «Hook timed out in 10000ms» в прокси-тестах. Причина оказалась не в
 * keep-alive, а в утечке CONNECT-туннелей: фейковый прокси не рвал
 * upstream-сокеты, undici набивал их сотнями, у цели накапливались сотни
 * соединений в состоянии «active» (idle — единицы), а `server.close()`
 * завершает работу только когда НЕТ живых соединений (и закрывает лишь
 * idle) — колбэк не вызывался, и хук висел до таймаута vitest.
 *
 * Тест фиксирует контракт: закрытие тестового сервера не имеет права
 * зависеть от состояния соединений — ни активных, ни keep-alive.
 */

/** Поднимает сервер на случайном порту и отдаёт его. */
async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  return (server.address() as AddressInfo).port;
}

describe('closeTestServer (тестовый сервер не должен висеть)', () => {
  it('не зависает, когда соединение осталось активным (ответ не отправлен)', async () => {
    // Сервер принимает запрос и НЕ отвечает: соединение остаётся активным,
    // и такой сокет `closeIdleConnections()` не трогает — `server.close()`
    // без разрыва соединений не завершается.
    let onRequest: (() => void) | undefined;
    const received = new Promise<void>((resolve) => {
      onRequest = resolve;
    });
    const server = createServer((_req, _res) => {
      onRequest?.();
    });
    const port = await listen(server);

    const agent = new Agent();
    const pending = request(`http://127.0.0.1:${port}/`, { dispatcher: agent }).catch(
      () => undefined,
    );
    await received;

    const startedAt = Date.now();
    await closeTestServer(server);
    const elapsed = Date.now() - startedAt;

    // Таймаут хука vitest — 10 с; здесь ждать недолго: закрытие обязано быть
    // быстрым, а не «успеть за 10 секунд».
    expect(elapsed).toBeLessThan(1_000);

    await pending;
    await agent.close();
  });

  it('не зависает на соединении, оставшемся в keep-alive-пуле', async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('ok');
    });
    const port = await listen(server);

    const agent = new Agent();
    const { body } = await request(`http://127.0.0.1:${port}/`, { dispatcher: agent });
    await body.text(); // ответ прочитан — сокет возвращён в пул и живёт дальше

    const startedAt = Date.now();
    await closeTestServer(server);
    expect(Date.now() - startedAt).toBeLessThan(1_000);

    await agent.close();
  });

  it('рвёт переданные сокеты до закрытия', async () => {
    let destroyed = false;
    const socket = {
      destroy: () => {
        destroyed = true;
      },
    };
    await closeTestServer({ close: (cb: () => void) => cb() }, { sockets: [socket] });
    expect(destroyed).toBe(true);
  });

  it('завершается, даже если close() не вызывает колбэк (ограничение по времени)', async () => {
    let closeCalled = false;
    const server = {
      close: (_cb: () => void) => {
        closeCalled = true; // колбэк намеренно НЕ вызываем — имитируем зависший сервер
      },
    };
    const startedAt = Date.now();
    await closeTestServer(server, { timeoutMs: 50 });
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(closeCalled).toBe(true);
  });

  it('не бросает исключение, если close() сам бросает', async () => {
    const server = {
      close: (): void => {
        throw new Error('close failed');
      },
    };
    await expect(closeTestServer(server)).resolves.toBeUndefined();
  });
});
