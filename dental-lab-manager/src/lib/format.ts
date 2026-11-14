export function fmtDate(d: string | Date | null | undefined, locale: string, withTime = false): string {
  if (!d) return '—';
  const date = typeof d === 'string' ? new Date(d.length === 10 ? `${d}T00:00:00` : d) : d;
  if (isNaN(date.getTime())) return '—';
  return date.toLocaleString(locale, {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    ...(withTime ? { hour: '2-digit', minute: '2-digit' } : {}),
  });
}

export function fmtDuration(seconds: number | null | undefined, t: { h: string; m: string }): string {
  if (seconds == null || seconds < 0) return '—';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h >= 48) return `${Math.floor(h / 24)}d ${h % 24} ${t.h}`;
  if (h > 0) return `${h} ${t.h} ${m} ${t.m}`;
  return `${m} ${t.m}`;
}

export function secondsSince(iso: string | null | undefined): number | null {
  if (!iso) return null;
  return Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
}

export function todayISO(offsetDays = 0): string {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function isDelayed(c: { due_date: string; status: string }): boolean {
  return c.due_date < todayISO() && c.status !== 'delivered' && c.status !== 'cancelled';
}

export function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function initials(name: string | null | undefined): string {
  if (!name) return '?';
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? '')).toUpperCase() || '?';
}

/** Compact the tooth list into human ranges per jaw, e.g. "14–16, 36". */
export function teethLabel(nums: number[]): string {
  return [...nums].sort((a, b) => a - b).join(', ');
}
