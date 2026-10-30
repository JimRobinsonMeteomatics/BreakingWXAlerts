/**
 * Which alerts a person still sees: nothing older than `ttlMin` minutes (0 = never expire),
 * and nothing at or before the moment they last pressed Clear.
 */
export function visibleAlerts<T extends { ts: string }>(alerts: T[], now: Date, ttlMin: number, clearedAt: string | null): T[] {
  const oldest = ttlMin > 0 ? now.getTime() - ttlMin * 60_000 : -Infinity;
  const cleared = clearedAt ? Date.parse(clearedAt) : -Infinity;
  return alerts.filter((a) => {
    const t = Date.parse(a.ts);
    return t >= oldest && t > cleared;
  });
}
