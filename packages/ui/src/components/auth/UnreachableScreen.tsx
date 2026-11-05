import { useAuthStore } from '@/stores/authStore'
import { useI18n } from '@/lib/i18n'
import { SynthLogo } from '@/components/ui'
import { Icon } from '@/components/icon/Icon'

/**
 * Экран «Сервер недоступен» вместо формы входа.
 *
 * Сетевой сбой/таймаут не означает «гость»: на managed/OIDC-инстансе форма
 * входа выбрала бы ветку «API ключ» и разлогинила пользователя визуально.
 * Карточка — тот же кит, что у `LoginForm` (концентричные радиусы, ring,
 * лого), поэтому переход между экранами не «прыгает».
 */
export const UnreachableScreen = () => {
  const { t } = useI18n()
  const retry = useAuthStore((s) => s.retry)
  const isLoading = useAuthStore((s) => s.isLoading)

  return (
    <div
      className="login-screen viewport-min-h flex items-center justify-center bg-background"
      data-testid="auth-unreachable"
    >
      <div className="relative my-auto w-full max-w-md rounded-xl bg-card p-8 ring-1 ring-foreground/10 shadow-xl">
        <div className="pointer-events-none absolute inset-x-0 top-0 h-0.5 rounded-t-xl bg-gradient-to-r from-transparent via-primary/70 via-30% to-transparent" />
        <div className="flex flex-col items-center gap-4 mb-8">
          <div className="relative isolate">
            <div
              className="pointer-events-none absolute inset-0 -z-10 rounded-full bg-primary/20 blur-2xl"
              aria-hidden="true"
            />
            <SynthLogo variant="brand" width={88} height={88} />
          </div>
          <h1 className="text-2xl font-bold text-foreground">{t('auth.unreachable.title')}</h1>
          <p className="text-sm text-muted-foreground text-center">{t('auth.unreachable.message')}</p>
        </div>

        <div className="flex items-center gap-2 p-3 rounded-lg bg-status-warning/10 text-status-warning text-sm">
          <Icon name="error-warning" className="size-4 shrink-0" />
          <span className="min-w-0 break-words">{t('connection.banner.message')}</span>
        </div>

        <button
          type="button"
          onClick={() => void retry()}
          disabled={isLoading}
          className="mt-4 w-full px-4 py-2.5 rounded-lg font-medium text-primary-foreground bg-primary hover:bg-primary/90 shadow-lg shadow-primary/25 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {isLoading ? t('common.loading') : t('auth.unreachable.retry')}
        </button>
      </div>
    </div>
  )
}
