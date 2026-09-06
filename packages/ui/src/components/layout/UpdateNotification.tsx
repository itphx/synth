import { useEffect, useRef } from 'react';
import { toast } from 'react-toastify';
import { synthApi } from '../../lib/api/synthApi';

const UPDATE_CHECK_ENABLED = (import.meta.env.VITE_ENABLE_UPDATE_CHECK as string) === 'true';

export function UpdateNotification() {
  const checked = useRef(false);

  useEffect(() => {
    if (!UPDATE_CHECK_ENABLED) return;
    if (checked.current) return;
    checked.current = true;

    let cancelled = false;

    const check = async () => {
      try {
        const info = await synthApi.checkUpdate();
        if (cancelled) return;
        if (info.hasUpdate) {
          toast.info(
            `Доступна новая версия ${info.latestVersion} (текущая: ${info.currentVersion}). Выполните synth update --apply.`,
            { autoClose: false, toastId: 'update-notification', closeOnClick: true },
          );
        }
      } catch {
        // failed silently
      }
    };

    // отложенная проверка чтобы не мешать загрузке
    const timer = setTimeout(check, 10_000);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, []);

  return null;
}
