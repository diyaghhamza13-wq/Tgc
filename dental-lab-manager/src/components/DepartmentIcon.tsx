import { Building2, Drill, Hammer, Monitor, ShieldCheck, Truck, User, UserRound } from 'lucide-react-native';
import React from 'react';
import { colors } from '../lib/theme';
import { ToothIcon } from './brand';

export function DepartmentIcon({ code, size = 30, color = colors.gold }: { code?: string | null; size?: number; color?: string }) {
  const p = { size, color, strokeWidth: 1.6 };
  switch (code) {
    case 'CAD': return <Monitor {...p} />;
    case 'CAM': return <Drill {...p} />;
    case 'CERAMIC': return <ToothIcon size={size} color={color} />;
    case 'FINISHING': return <Hammer {...p} />;
    case 'QC': return <ShieldCheck {...p} />;
    case 'RECEPTION': return <UserRound {...p} />;
    case 'DELIVERY': return <Truck {...p} />;
    case 'ADMIN': return <Building2 {...p} />;
    default: return <User {...p} />;
  }
}

