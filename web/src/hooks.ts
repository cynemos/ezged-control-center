import { useCallback, useEffect, useState } from 'react';
import { api } from './api';

/** Charge une ressource et la rafraîchit périodiquement (30 s par défaut). */
export function usePoll<T>(path: string | null, intervalMs = 30_000) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    if (!path) return;
    try {
      setData(await api<T>(path));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [path]);

  useEffect(() => {
    setLoading(true);
    void reload();
    const t = setInterval(() => {
      if (document.visibilityState === 'visible') void reload();
    }, intervalMs);
    return () => clearInterval(t);
  }, [reload, intervalMs]);

  return { data, error, loading, reload };
}
