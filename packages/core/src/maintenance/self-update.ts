// ADR-133: admission-гейт self-update и preflight user-level prefix.
//
// Self-update (`npm install -g @itphx/synth@<version>`) допустим только в
// standalone-поставке: в Docker/Helm/managed обновление приходит образом, и
// «обновление» внутри контейнера потерялось бы после перезапуска пода.
//
// Признаки недопустимости:
// - `SYNTH_DEPLOY_MODE` ∈ {`docker`, `k8s`, `managed`};
// - задан `KUBERNETES_SERVICE_HOST` (pod);
// - существует `/.dockerenv` (контейнер);
// - `npm prefix -g` вне `$HOME` (root/системная установка — не трогаем).
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve as resolvePath, sep } from 'node:path';

/** Таймаут `npm prefix -g`. */
const NPM_PREFIX_TIMEOUT_MS = 10_000;

/** Режимы развёртывания, в которых self-update запрещён. */
const UNSUPPORTED_DEPLOY_MODES = ['docker', 'k8s', 'managed'];

/** Инструкция user-level установки (preflight отказал). */
export const SELF_UPDATE_USER_LEVEL_HINT =
  'Переключитесь на user-level установку:\n' +
  '  npm config set prefix ~/.npm-global\n' +
  '  export PATH="$HOME/.npm-global/bin:$PATH"\n' +
  'затем повторите synth update --apply.';

/** Результат проверки поддержки self-update. */
export interface SelfUpdateSupport {
  supported: boolean;
  /** Причина отказа (короткий машинный текст + инструкция). */
  reason?: string;
  /** Фактический `npm prefix -g` (если удалось определить). */
  prefix?: string;
}

/** Инъекция окружения/проверок (тесты). */
export interface SelfUpdateSupportDeps {
  env?: NodeJS.ProcessEnv;
  /** `$HOME` (по умолчанию `env.HOME`). */
  home?: string;
  /** `npm prefix -g` (тесты). */
  npmPrefix?: () => Promise<string>;
  /** Детект контейнера (тесты): по умолчанию `/.dockerenv`. */
  isContainer?: () => boolean;
}

/** `npm prefix -g` (spawn, таймаут 10 с). */
export function npmGlobalPrefix(): Promise<string> {
  return new Promise<string>((resolvePrefix, reject) => {
    const child = spawn('npm', ['prefix', '-g'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
    });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error('таймаут npm prefix -g'));
    }, NPM_PREFIX_TIMEOUT_MS);
    child.stdout?.on('data', (chunk: Buffer) => { out += chunk.toString(); });
    child.stderr?.on('data', (chunk: Buffer) => { err += chunk.toString(); });
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolvePrefix(out.trim());
      else reject(new Error(err.trim() || `npm prefix завершился с кодом ${code}`));
    });
  });
}

/** Путь `child` внутри `parent` (или совпадает). */
export function isPathInside(child: string, parent: string): boolean {
  const resolvedChild = resolvePath(child);
  const resolvedParent = resolvePath(parent);
  if (resolvedChild === resolvedParent) return true;
  return resolvedChild.startsWith(resolvedParent.endsWith(sep) ? resolvedParent : resolvedParent + sep);
}

/**
 * Preflight user-level prefix (ADR-133): `npm prefix -g` обязан быть внутри
 * `$HOME`. Возвращает текст отказа или `null` (можно ставить).
 */
export async function checkUserLevelPrefix(
  deps: { home?: string; npmPrefix?: () => Promise<string> } = {},
): Promise<string | null> {
  const homeDir = deps.home ?? process.env.HOME ?? '';
  let prefix: string;
  try {
    prefix = await (deps.npmPrefix ?? npmGlobalPrefix)();
  } catch (err) {
    return (
      `Не удалось определить npm prefix -g: ${err instanceof Error ? err.message : String(err)}.\n` +
      SELF_UPDATE_USER_LEVEL_HINT
    );
  }
  if (!homeDir) {
    // HOME неизвестен — не блокируем (нестандартное окружение).
    return null;
  }
  if (isPathInside(prefix, homeDir)) return null;
  return (
    `npm prefix -g (${prefix}) вне $HOME (${homeDir}) — системная/root-установка не поддерживается.\n` +
    SELF_UPDATE_USER_LEVEL_HINT
  );
}

/**
 * Проверка, поддерживается ли self-update на этом инстансе (ADR-133).
 * Контейнер/кластер/managed → `supported: false` с причиной; иначе — prefix
 * внутри `$HOME`.
 */
export async function getSelfUpdateSupport(
  deps: SelfUpdateSupportDeps = {},
): Promise<SelfUpdateSupport> {
  const env = deps.env ?? process.env;
  const deployMode = (env.SYNTH_DEPLOY_MODE ?? '').trim().toLowerCase();
  if (UNSUPPORTED_DEPLOY_MODES.includes(deployMode)) {
    return {
      supported: false,
      reason:
        `SYNTH_DEPLOY_MODE=${deployMode}: self-update запрещён — ` +
        'обновление выполняется образом/выпуском (Docker/Helm/managed).',
    };
  }
  if (env.KUBERNETES_SERVICE_HOST) {
    return {
      supported: false,
      reason: 'KUBERNETES_SERVICE_HOST задан: self-update в поде запрещён — обновляйте образ/релиз.',
    };
  }
  const isContainer = deps.isContainer ?? (() => existsSync('/.dockerenv'));
  if (isContainer()) {
    return {
      supported: false,
      reason: 'Обнаружен контейнер (/.dockerenv): self-update запрещён — обновляйте образ.',
    };
  }

  const homeDir = deps.home ?? env.HOME ?? '';
  let prefix: string | undefined;
  try {
    prefix = await (deps.npmPrefix ?? npmGlobalPrefix)();
  } catch (err) {
    return {
      supported: false,
      reason:
        `Не удалось определить npm prefix -g: ${err instanceof Error ? err.message : String(err)}. ` +
        SELF_UPDATE_USER_LEVEL_HINT,
    };
  }
  if (homeDir && !isPathInside(prefix, homeDir)) {
    return {
      supported: false,
      prefix,
      reason:
        `npm prefix -g (${prefix}) вне $HOME (${homeDir}) — системная/root-установка не поддерживается. ` +
        SELF_UPDATE_USER_LEVEL_HINT,
    };
  }
  return { supported: true, ...(prefix ? { prefix } : {}) };
}
