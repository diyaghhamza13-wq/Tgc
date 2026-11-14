import { useEffect, useRef } from 'react';
import { supabase } from './supabase';

/**
 * Re-run `onChange` (debounced) when rows of the given tables change.
 * postgres_changes honours RLS, so only visible rows trigger updates.
 */
export function useRealtimeRefresh(key: string, tables: string[], onChange: () => void) {
  const cb = useRef(onChange);
  cb.current = onChange;
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const fire = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => cb.current(), 400);
    };
    let ch = supabase.channel(`rt-${key}-${Math.random().toString(36).slice(2)}`);
    for (const table of tables) ch = ch.on('postgres_changes', { event: '*', schema: 'public', table }, fire);
    ch.subscribe();
    return () => {
      if (timer) clearTimeout(timer);
      supabase.removeChannel(ch);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, tables.join(',')]);
}
