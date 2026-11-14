export const colors = {
  bg: '#050B15',
  bg2: '#0B1726',
  card: '#101E30',
  cardHi: '#14263C',
  border: '#1E3149',
  borderHi: '#2A4363',
  gold: '#D6AD55',
  goldHi: '#FFD36B',
  goldDim: 'rgba(214,173,85,0.14)',
  white: '#F5F7FA',
  text: '#F5F7FA',
  muted: '#9BA8B8',
  faint: '#5F7088',
  success: '#22C55E',
  warning: '#F59E0B',
  error: '#EF4444',
  info: '#3B82F6',
  purple: '#8B5CF6',
};

export const radius = { sm: 10, md: 14, lg: 18, xl: 24, pill: 999 };
export const space = (n: number) => n * 4;

export const goldGradient = ['#FFE29A', '#D6AD55', '#B8862E'] as const;
export const bgGradient = ['#0B1726', '#050B15'] as const;

export const glow = {
  shadowColor: '#FFD36B',
  shadowOpacity: 0.45,
  shadowRadius: 14,
  shadowOffset: { width: 0, height: 0 },
  elevation: 8,
};

export const statusColor: Record<string, string> = {
  new: colors.info,
  in_progress: colors.gold,
  waiting: colors.warning,
  ready_for_qc: colors.purple,
  completed: colors.success,
  delivered: colors.success,
  cancelled: colors.faint,
  pending: colors.faint,
  rejected: colors.error,
  needs_revision: colors.error,
  skipped: colors.faint,
};

export const priorityColor: Record<string, string> = {
  normal: colors.muted,
  urgent: colors.warning,
  very_urgent: colors.error,
};
