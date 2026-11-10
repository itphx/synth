// ADR-133: HTTP-контур обновлений (`/api/v2/updates`).
//
// - `GET /check?channel=auto|stable|beta&force=1` — проверка версии по каналу.
//   `force=1` игнорирует кэш (ADR-133: явная проверка работает всегда).
//   Сетевая ошибка → 502 `UPDATE_CHECK_FAILED`.
// - `POST /apply` body `{version?, channel?: 'stable'|'beta', restart?}` —
//   SSE-поток установки `npm install -g @itphx/synth@<version> --registry <reg>`.
//   Admission-гейт `getSelfUpdateSupport()`: Docker/Helm/managed и системный
//   npm-prefix → 409 `UPDATE_UNSUPPORTED` (контейнер «обновил» бы себя до
//   перезапуска пода и потерял версию образа).
//   Если `restart: true` и рестарт поддержан — после `done` запрашивается
//   graceful restart (exit 75, ADR-092 п. 7).
import { spawn } from 'node:child_process';
import { Hono } from 'hono';
import type { createMiddleware } from 'hono/factory';
import { SYNTH_VERSION, type UpdatesConfig } from '@itphx/synth-shared';
import type { MaintenanceAuditRepository } from '../../storage/ports/maintenance-audit-repository.js';
import { recordMaintenanceAudit } from '../../maintenance/audit.js';
import { getSelfUpdateSupport, type SelfUpdateSupport } from '../../maintenance/self-update.js';
import { getRestartStatus, requestRestart } from '../restart.js';
import {
  checkForUpdates,
  fetchAvailableVersions,
  fetchLatestVersion,
  isSemver,
  resolveUpdateChannel,
  resolveUpdatesRegistry,
  type UpdateChannel,
  type UpdateChannelChoice,
} from '../../update-checker.js';

/** Имя пакета CLI. */
const PACKAGE_NAME = '@itphx/synth';

/** Значения `?channel=` (для проверки запроса). */
const CHANNEL_VALUES: readonly UpdateChannelChoice[] = ['auto', 'stable', 'beta'];

/** Тело `POST /apply`. */
export interface UpdateApplyBody {
  version?: string;
  channel?: UpdateChannel;
  restart?: boolean;
}

type Middleware = ReturnType<typeof createMiddleware>;

/** RBAC-граница контура обновлений (инвариант 16: доступ — на границе). */
export interface UpdateRoutesOptions {
  /** Guard проверки; по умолчанию — `auth.requireAuth`. */
  readGuard?: Middleware;
  /** Guard установки; по умолчанию — `auth.requireAuth`. */
  writeGuard?: Middleware;
}

/** Инъекция операций (тесты): без spawn/npm и без реального рестарта. */
export interface UpdateRoutesDeps {
  /** Эффективная секция `updates` (реестры каналов). */
  updates?: Partial<UpdatesConfig>;
  /** Аудит обслуживания (`update.applied`/`update.failed`). */
  audit?: MaintenanceAuditRepository;
  /** Admission-гейт self-update (тесты). */
  selfUpdateSupport?: () => Promise<SelfUpdateSupport> | SelfUpdateSupport;
  /** Установка (тесты): код возврата; при задании spawn не используется. */
  npmInstall?: (version: string, registry: string) => Promise<number>;
  /** Запрос рестарта (тесты). */
  requestRestart?: () => Promise<unknown>;
  /** Статус рестарта (тесты). */
  getRestartStatus?: () => { supported: boolean };
  /** Env (тесты). */
  env?: NodeJS.ProcessEnv;
}

function _parseChannel(raw: string | undefined): UpdateChannelChoice | undefined {
  if (raw === undefined || raw === '') return undefined;
  return (CHANNEL_VALUES as readonly string[]).includes(raw)
    ? (raw as UpdateChannelChoice)
    : undefined;
}

export function createUpdateRoutes(
  auth: { requireAuth: Middleware },
  dataDir: string,
  deps: UpdateRoutesDeps = {},
  opts: UpdateRoutesOptions = {},
): Hono {
  const app = new Hono();
  const env = deps.env ?? process.env;
  const readGuard = opts.readGuard ?? auth.requireAuth;
  const writeGuard = opts.writeGuard ?? auth.requireAuth;

  app.get('/check', readGuard, async (c) => {
    const channelRaw = c.req.query('channel');
    const channel = _parseChannel(channelRaw);
    if (channelRaw !== undefined && channelRaw !== '' && channel === undefined) {
      return c.json({
        error: {
          code: 'VALIDATION_ERROR',
          message: `channel: ожидается ${CHANNEL_VALUES.join('|')}`,
        },
      }, 400);
    }
    const forceRaw = c.req.query('force');
    const force = forceRaw === '1' || forceRaw === 'true';

    try {
      const info = await checkForUpdates(dataDir, {
        ...(channel ? { channel } : {}),
        ...(deps.updates ? { updates: deps.updates } : {}),
        force,
      });
      return c.json(info);
    } catch (err) {
      return c.json({
        error: {
          code: 'UPDATE_CHECK_FAILED',
          message: err instanceof Error ? err.message : 'Ошибка проверки обновлений',
        },
      }, 502);
    }
  });

  app.post('/apply', writeGuard, async (c) => {
    const signal = c.req.raw.signal;
    const body = (await c.req.json().catch(() => ({}))) as UpdateApplyBody;

    if (body.channel !== undefined && body.channel !== 'stable' && body.channel !== 'beta') {
      return c.json({
        error: { code: 'VALIDATION_ERROR', message: "channel: ожидается 'stable'|'beta'" },
      }, 400);
    }

    // Версия: явная (валидируется) или dist-tag канала.
    let requestedVersion: string | undefined;
    if (body.version !== undefined) {
      const normalized = String(body.version).trim().replace(/^v/, '');
      if (!isSemver(normalized)) {
        return c.json({
          error: {
            code: 'VALIDATION_ERROR',
            message: `version: ожидается точная версия X.Y.Z (получено «${body.version}»); dist-tag не принимается`,
          },
        }, 400);
      }
      requestedVersion = normalized;
    }

    // ADR-133: admission-гейт — self-update только в standalone-поставке.
    const support = await (deps.selfUpdateSupport
      ? deps.selfUpdateSupport()
      : getSelfUpdateSupport({ env }));
    if (!support.supported) {
      return c.json({
        error: {
          code: 'UPDATE_UNSUPPORTED',
          message: 'Self-update на этом инстансе недоступен',
          reason: support.reason ?? 'обновление выполняется образом/выпуском',
        },
      }, 409);
    }

    const channel = body.channel ?? resolveUpdateChannel(SYNTH_VERSION);
    const registry = resolveUpdatesRegistry(channel, deps.updates);

    // Целевая версия проверяется **до** стрима: ошибки — обычным HTTP-ответом.
    let target: string;
    try {
      if (requestedVersion) {
        const versions = await fetchAvailableVersions(registry);
        if (!versions.includes(requestedVersion)) {
          return c.json({
            error: {
              code: 'VALIDATION_ERROR',
              message: `версия ${requestedVersion} не найдена в реестре канала ${channel}`,
            },
          }, 400);
        }
        target = requestedVersion;
      } else {
        target = await fetchLatestVersion(channel, registry);
      }
    } catch (err) {
      return c.json({
        error: {
          code: 'UPDATE_CHECK_FAILED',
          message: err instanceof Error ? err.message : 'Ошибка проверки версии',
        },
      }, 502);
    }

    const restartStatus = (deps.getRestartStatus ?? getRestartStatus)();
    const willRestart = body.restart === true && restartStatus.supported;

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
        const close = () => {
          try { controller.close(); } catch { /* already closed */ }
        };

        send({
          type: 'start',
          message: `Установка ${PACKAGE_NAME}@${target} (канал ${channel}, реестр ${registry})...`,
          version: target,
          channel,
          registry,
        });

        const finish = async (code: number): Promise<void> => {
          if (code === 0) {
            send({
              type: 'done',
              version: target,
              channel,
              registry,
              restartScheduled: willRestart,
              message: willRestart
                ? 'Обновление установлено — инстанс перезапускается'
                : 'Обновление установлено. Перезапустите инстанс вручную.',
            });
            close();
            await recordMaintenanceAudit(deps.audit, {
              op: 'update.applied',
              status: 'ok',
              actor: 'api',
              details: { from: SYNTH_VERSION, to: target, channel, registry, version: target },
            });
            if (willRestart) {
              try {
                await (deps.requestRestart ?? requestRestart)();
              } catch (err) {
                console.warn(
                  `[updates] рестарт после обновления не запрошен: ${
                    err instanceof Error ? err.message : String(err)
                  }`,
                );
              }
            }
            return;
          }
          send({ type: 'error', message: `npm завершился с кодом ${code}` });
          close();
          await recordMaintenanceAudit(deps.audit, {
            op: 'update.failed',
            status: 'failed',
            actor: 'api',
            details: { from: SYNTH_VERSION, to: target, channel, registry, version: target },
            error: `npm завершился с кодом ${code}`,
          });
        };

        // Тесты: инъектированная установка без spawn.
        if (deps.npmInstall) {
          const abort = () => { close(); };
          signal.addEventListener('abort', abort, { once: true });
          void deps.npmInstall(target, registry)
            .then((code) => finish(code))
            .catch((err: unknown) => {
              send({ type: 'error', message: err instanceof Error ? err.message : String(err) });
              close();
            });
          return;
        }

        const child = spawn(
          'npm',
          // Scoped-ключ, не `--registry`: публичные зависимости должны ставиться
          // из реестра по умолчанию (в Gitea их нет — иначе 404).
          ['install', '-g', `${PACKAGE_NAME}@${target}`, `--@itphx:registry=${registry}`],
          { stdio: ['ignore', 'pipe', 'pipe'], env: { ...env } },
        );

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
          void finish(code ?? 1);
        });

        child.on('error', (err) => {
          send({ type: 'error', message: err.message });
          close();
        });

        signal.addEventListener('abort', () => {
          child.kill('SIGTERM');
          close();
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
