import type { PushSub } from './types.ts';

export interface Reach {
  status: 'ready' | 'check' | 'unreachable';
  reason: string;
  lastConfirmedAt: string | null; // latest proof the device is alive: an on-device receipt or an app check-in
  devices: number;
}

const DAY = 86_400_000;
const newest = (s: PushSub): number => Math.max(s.checkedAt ? Date.parse(s.checkedAt) : 0, s.lastReceiptAt ? Date.parse(s.lastReceiptAt) : 0);

/** Can this person actually be reached by push right now, and how recently was that confirmed? */
export function reachability(subs: PushSub[], now: Date, staleDays = 7): Reach {
  const last = subs.reduce((m, s) => Math.max(m, newest(s)), 0);
  const lastConfirmedAt = last > 0 ? new Date(last).toISOString() : null;
  const base = { lastConfirmedAt, devices: subs.length };

  if (subs.length === 0) return { ...base, status: 'unreachable', reason: 'No device registered. They need to install the app and turn on alerts.' };
  const usable = subs.filter((s) => s.permission !== 'denied');
  if (usable.length === 0) return { ...base, status: 'unreachable', reason: 'Notifications are blocked on every device.' };

  const granted = usable.filter((s) => s.permission === 'granted');
  if (granted.some((s) => now.getTime() - newest(s) <= staleDays * DAY)) return { ...base, status: 'ready', reason: 'Ready' };
  if (granted.length > 0) return { ...base, status: 'check', reason: `Not confirmed in ${staleDays} days. Ask them to open the app.` };
  return { ...base, status: 'check', reason: 'Registered but not yet verified. Ask them to open the app.' };
}
