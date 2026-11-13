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
import {
  buildUpdateInstallArgs,
  describeNpmFailure,
  formatNpmCommand,
  resolveNpmInstallEnvironment,
  resolveNpmVersion,
} from '../../maintenance/update.js';
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
  /**
   * Установка (тесты): код возврата либо `{code, stderr}` (stderr — для
   * диагностики TLS/ETARGET); при задании spawn не используется.
   */
  npmInstall?: (
    version: string,
    registry: string,
    context: NpmInstallContext,
  ) => Promise<number | NpmInstallOutcome>;
  /**
   * Env дочернего npm (ADR-099): CA инстанса (`security.tls`) и прокси-маршрут
   * реестра. По умолчанию — `resolveNpmInstallEnvironment`; монтирование
   * передаёт его явно.
   */
  npmEnvironment?: (registryUrl: string) => Promise<Record<string, string>>;
  /** Версия npm для события `start` (тесты). По умолчанию — `npm --version`. */
  npmVersion?: () => Promise<string | undefined>;
  /** Запрос рестарта (тесты). */
  requestRestart?: () => Promise<unknown>;
  /** Статус рестарта (тесты). */
  getRestartStatus?: () => { supported: boolean };
  /** Env (тесты). */
  env?: NodeJS.ProcessEnv;
}

/** Что реально уходит дочернему npm (без секретов: креды прокси — только в `env`). */
export interface NpmInstallContext {
  /** argv (`npm install -g … --@itphx:registry=… --prefer-online`). */
  args: string[];
  /** Дополнительный env: `NODE_EXTRA_CA_CERTS`, `HTTPS_PROXY`/`HTTP_PROXY`/`NO_PROXY`. */
  env: Record<string, string>;
}

/** Исход установки (инъекция): код возврата и stderr для диагностики. */
export interface NpmInstallOutcome {
  code: number;
  stderr?: string;
}

/** Хвост stderr для диагностики (не раздуваем память длинным выводом npm). */
const STDERR_TAIL_LIMIT = 16_384;

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

    // ADR-099: дочерний npm не наследует доверие TLS/прокси процесса — env
    // собирается из `security.tls` (CA) и маршрута прокси реестра.
    const resolveNpmEnv = deps.npmEnvironment ?? resolveNpmInstallEnvironment;
    // Инъекция установки (тесты) — реальный npm не запускается вовсе.
    const detectNpmVersion = deps.npmVersion ?? (deps.npmInstall ? undefined : resolveNpmVersion);
    // Scoped-ключ, не `--registry`: публичные зависимости должны ставиться
    // из реестра по умолчанию (в Gitea их нет — иначе 404).
    const installArgs = buildUpdateInstallArgs(target, registry, true);
    const installCommand = formatNpmCommand(installArgs);

    const stream = new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();
        let closed = false;
        let child: ReturnType<typeof spawn> | null = null;
        let stderrTail = '';

        const send = (data: Record<string, unknown>) => {
          try {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
          } catch {
            // disconnected
          }
        };
        const close = () => {
          if (closed) return;
          closed = true;
          try { controller.close(); } catch { /* already closed */ }
        };

        const finish = async (code: number, stderr = ''): Promise<void> => {
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
          // Сырое «код 1» бесполезно: TLS-недоверие/ETARGET объясняем по stderr.
          const failure = describeNpmFailure({ code, stderr, registry });
          console.warn(`[updates] установка ${PACKAGE_NAME}@${target} не удалась: ${failure.message}`);
          send({ type: 'error', message: failure.message });
          close();
          await recordMaintenanceAudit(deps.audit, {
            op: 'update.failed',
            status: 'failed',
            actor: 'api',
            details: { from: SYNTH_VERSION, to: target, channel, registry, version: target },
            error: failure.message,
          });
        };

        const run = async (): Promise<void> => {
          let npmVersion: string | undefined;
          if (detectNpmVersion) {
            try {
              npmVersion = (await detectNpmVersion()) || undefined;
            } catch {
              npmVersion = undefined;
            }
          }

          // Диагностика: фактический argv и версия npm (в `~/.npm/_logs` лезть не нужно).
          send({
            type: 'start',
            message: `Установка ${PACKAGE_NAME}@${target} (канал ${channel}, реестр ${registry})...`,
            version: target,
            channel,
            registry,
            command: installCommand,
            ...(npmVersion !== undefined ? { npmVersion } : {}),
          });

          let extraEnv: Record<string, string> = {};
          try {
            extraEnv = await resolveNpmEnv(registry);
          } catch (err) {
            // Политика доверия не собралась — установка всё равно пробуется;
            // причина провала всплывёт диагностикой TLS.
            console.warn(
              `[updates] env дочернего npm не собран: ${
                err instanceof Error ? err.message : String(err)
              }`,
            );
          }
          if (signal.aborted) {
            close();
            return;
          }

          // Тесты: инъектированная установка без spawn.
          if (deps.npmInstall) {
            const outcome = await deps.npmInstall(target, registry, {
              args: installArgs,
              env: extraEnv,
            });
            const code = typeof outcome === 'number' ? outcome : outcome.code;
            const stderr = typeof outcome === 'number' ? '' : outcome.stderr ?? '';
            await finish(code, stderr);
            return;
          }

          const spawned = spawn('npm', installArgs, {
            stdio: ['ignore', 'pipe', 'pipe'],
            env: { ...env, ...extraEnv },
          });
          child = spawned;

          spawned.stdout?.on('data', (chunk: Buffer) => {
            send({ type: 'progress', data: chunk.toString().trim() });
          });
          spawned.stderr?.on('data', (chunk: Buffer) => {
            const text = chunk.toString();
            stderrTail = (stderrTail + text).slice(-STDERR_TAIL_LIMIT);
            send({ type: 'stderr', data: text.trim() });
          });

          spawned.on('close', (code) => {
            void finish(code ?? 1, stderrTail);
          });

          spawned.on('error', (err) => {
            send({ type: 'error', message: err.message });
            close();
          });
        };

        signal.addEventListener('abort', () => {
          child?.kill('SIGTERM');
          close();
        }, { once: true });

        void run().catch((err: unknown) => {
          send({ type: 'error', message: err instanceof Error ? err.message : String(err) });
          close();
        });
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
