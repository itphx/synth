import { useEffect } from 'react'
import { useAuthStore } from '@/stores/authStore'
import { useI18n } from '@/lib/i18n'
import { LoginForm } from './LoginForm'
import { UnreachableScreen } from './UnreachableScreen'

interface AuthGateProps {
  children: React.ReactNode
}

export const AuthGate = ({ children }: AuthGateProps) => {
  const { t } = useI18n()
  const authPhase = useAuthStore((s) => s.authPhase)
  const initialize = useAuthStore((s) => s.initialize)

  useEffect(() => {
    void initialize()
  }, [initialize])

  // `checking` — идёт первая проверка (как раньше спиннер).
  if (authPhase === 'checking') {
    return (
      <div className="viewport-min-h flex items-center justify-center bg-background">
        <div className="flex flex-col items-center gap-4">
          <div className="size-8 rounded-full border-2 border-foreground/20 border-t-foreground animate-spin" />
          <p className="text-sm text-muted-foreground">{t('common.loading')}</p>
        </div>
      </div>
    )
  }

  // Сервер/сеть недоступны — это не гость: форму входа не показываем.
  if (authPhase === 'unreachable') {
    return <UnreachableScreen />
  }

  if (authPhase === 'guest') {
    return <LoginForm />
  }

  return <>{children}</>
}
