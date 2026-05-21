import { useEffect, useState } from 'react'
import { api } from '@/lib/api/client'
import { Icon } from '@/components/icon/Icon'
import { cn } from '@/lib/utils'

interface SimpleUser {
  id: string
  username: string
}

const ROLE_COLORS: Record<string, string> = {
  ADMIN: 'bg-purple-100 text-purple-700 dark:bg-purple-900 dark:text-purple-300',
  USER: 'bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300',
  LEAD: 'bg-amber-100 text-amber-700 dark:bg-amber-900 dark:text-amber-300',
  AUDITOR: 'bg-teal-100 text-teal-700 dark:bg-teal-900 dark:text-teal-300',
}

export const UsersPanel = () => {
  const [users, setUsers] = useState<SimpleUser[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    const load = async () => {
      try {
        const data = await api.getUsers()
        setUsers(data.users || [])
      } catch {
        setError('Список пользователей доступен только в debug-режиме')
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [])

  return (
    <div className="space-y-4">
      <h3 className="text-lg font-semibold">Пользователи</h3>

      {error && (
        <div className="bg-amber-50 dark:bg-amber-950 border border-amber-200 dark:border-amber-800 rounded-lg p-4 text-sm text-amber-700 dark:text-amber-300">
          {error}
        </div>
      )}

      {loading ? (
        <div className="space-y-2">
          {[1, 2, 3].map((i) => (
            <div key={i} className="bg-background rounded-lg border p-4 animate-pulse">
              <div className="h-4 bg-muted rounded w-24" />
            </div>
          ))}
        </div>
      ) : users.length === 0 ? (
        <div className="bg-background rounded-xl border p-8 text-center text-muted-foreground">
          Нет пользователей
        </div>
      ) : (
        <div className="space-y-2">
          {users.map((u) => (
            <div key={u.id} className="bg-background rounded-lg border px-4 py-3">
              <div className="flex items-center gap-3">
                <div className="size-8 rounded-full bg-slate-200 dark:bg-slate-700 flex items-center justify-center text-sm font-medium">
                  {u.username.charAt(0).toUpperCase()}
                </div>
                <span className="text-sm font-medium">{u.username}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
