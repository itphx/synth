import { useState } from 'react';

import { synthApi, type ProxyRouteTestResult } from '@/lib/api/synthApi';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { Icon } from '../icon/Icon';
import { Button } from '../ui/button';
import { FieldTooltip, TextField } from '../ui/settings';

const BADGE = 'rounded px-1.5 py-0.5 text-[0.625rem] font-medium';

/**
 * ADR-099: проверка target URL по **saved**-конфигурации (HEAD, без редиректов).
 * Показывает сработавшее правило/профиль/прокси, HTTP-статус/ошибку и то, что
 * проверка идёт по сохранённым настройкам (применятся после рестарта).
 */
export function ProxyRouteCheck({ disabled = false }: { disabled?: boolean }) {
  const { t } = useI18n();
  const [url, setUrl] = useState('');
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<ProxyRouteTestResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [urlError, setUrlError] = useState<string | null>(null);

  const check = async () => {
    if (!url.trim()) {
      setUrlError(t('proxy.target.urlRequired'));
      return;
    }
    setPending(true);
    setError(null);
    setUrlError(null);
    setResult(null);
    try {
      setResult(await synthApi.testProxyRoute(url));
    } catch (e) {
      setError(e instanceof Error && e.message ? e.message : 'HTTP');
    } finally {
      setPending(false);
    }
  };

  const route = result?.route;
  const reasonKey = route ? `proxy.reason.${route.reason}` : '';
  const ruleText = route?.ruleLabel ?? route?.ruleId;

  return (
    <div className="space-y-2 min-w-0 border-t border-border/60 pt-3" data-testid="proxy-target">
      <div className="flex items-center gap-1.5 min-w-0">
        <div className="text-sm font-medium text-foreground">{t('proxy.target.title')}</div>
        <FieldTooltip text={t('settings.help.network.target')} />
      </div>
      <p className="text-xs text-muted-foreground">{t('proxy.target.description')}</p>

      <div className="flex flex-wrap items-end gap-2 min-w-0">
        <TextField
          label={t('proxy.target.url')}
          value={url}
          onChange={(e) => {
            setUrl(e.target.value);
            if (urlError) setUrlError(null);
          }}
          placeholder="https://api.openai.com/v1/models"
          mono
          error={urlError ?? undefined}
          disabled={disabled || pending}
          tooltip={t('settings.help.network.targetUrl')}
          containerClassName="flex-1 min-w-48"
          data-testid="proxy-target-url"
        />
        <Button
          variant="outline"
          size="sm"
          className="shrink-0"
          onClick={() => void check()}
          disabled={disabled || pending}
          data-testid="proxy-target-check"
        >
          <Icon name="link" className="size-3.5" />
          {pending ? t('proxy.target.checking') : t('proxy.target.check')}
        </Button>
      </div>

      {error && (
        <div
          role="alert"
          data-testid="proxy-target-error"
          className="rounded-lg bg-destructive/10 p-2 text-xs text-destructive"
        >
          {t('proxy.target.checkError', { error })}
        </div>
      )}

      {result && route && (
        <div
          role="status"
          data-testid="proxy-target-result"
          className={cn(
            'space-y-1 rounded-lg p-2 text-xs',
            result.ok
              ? 'bg-status-success/10 text-status-success'
              : 'bg-destructive/10 text-destructive',
          )}
        >
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="font-medium">
              {result.ok ? t('proxy.target.ok') : t('proxy.target.failed')}
            </span>
            <span className={cn(BADGE, 'bg-interactive-hover text-muted-foreground')}>
              {t(`proxy.target.action.${route.action}`)}
            </span>
            <span className={cn(BADGE, 'bg-interactive-hover text-muted-foreground')}>
              {t(`proxy.target.via.${route.via}`)}
            </span>
          </div>
          <div className="text-muted-foreground">
            {t('proxy.target.rule')}: {ruleText ?? t('proxy.target.ruleNone')}
            {' · '}
            {t(reasonKey)}
          </div>
          {route.profile && (
            <div className="text-muted-foreground">
              {t('proxy.target.profile')}:{' '}
              {route.profileLabel ? `${route.profileLabel} (${route.profile})` : route.profile}
            </div>
          )}
          {route.proxyUrl && (
            <div className="min-w-0 break-all font-mono text-muted-foreground">
              {t('proxy.target.proxyUrl')}: {route.proxyUrl}
            </div>
          )}
          {result.httpStatus !== undefined && (
            <div className="tabular-nums">
              {t('proxy.target.httpStatus', { status: result.httpStatus })}
            </div>
          )}
          <div className="tabular-nums">
            {t('proxy.target.latency', { latency: Math.max(0, Math.round(result.latencyMs)) })}
          </div>
          {result.authChallenge !== 'none' && (
            <div>{t('proxy.authChallenge', { challenge: result.authChallenge })}</div>
          )}
          {result.error && <div className="min-w-0 break-words">{result.error}</div>}
          {result.usingSaved && (
            <div className="text-muted-foreground">{t('proxy.target.usingSaved')}</div>
          )}
          {result.restartRequired && (
            <div className="text-muted-foreground">{t('proxy.target.restartRequired')}</div>
          )}
        </div>
      )}
    </div>
  );
}
