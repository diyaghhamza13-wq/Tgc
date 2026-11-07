import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { errorCode } from './supabase';

/**
 * Load data and reload it whenever the screen regains focus.
 * Errors are exposed as translatable codes, never swallowed.
 */
export function useAsync<T>(loader: () => Promise<T>, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const mounted = useRef(true);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const load = useCallback(loader, deps);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const d = await load();
      if (mounted.current) {
        setData(d);
        setError(null);
      }
    } catch (e) {
      if (mounted.current) setError(errorCode(e));
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, [load]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useFocusEffect(
    useCallback(() => {
      reload();
    }, [reload]),
  );

  return { data, error, loading, reload, setData };
}
