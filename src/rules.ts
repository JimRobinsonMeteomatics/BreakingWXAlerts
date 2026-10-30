import { paramInfo, toDisplay, type UnitSystem } from './params.ts';
import type { Agg, AlertMessage, Condition, ConditionResult, Evaluation, Location, Op, Point, Rule, Series } from './types.ts';

const HOUR = 3_600_000;

export function compare(v: number, op: Op, threshold: number): boolean {
  switch (op) {
    case '>': return v > threshold;
    case '>=': return v >= threshold;
    case '<': return v < threshold;
    case '<=': return v <= threshold;
  }
}

/** Points from the start of the current hour through `lookaheadHours` ahead. */
export function windowPoints(points: Point[], now: Date, lookaheadHours: number): Point[] {
  const from = Math.floor(now.getTime() / HOUR) * HOUR;
  const to = now.getTime() + lookaheadHours * HOUR;
  return points
    .filter((p) => Number.isFinite(p.v) && Date.parse(p.t) >= from && Date.parse(p.t) <= to)
    .sort((a, b) => Date.parse(a.t) - Date.parse(b.t));
}

export function aggregate(points: Point[], agg: Agg): { value: number; at: string | null } | null {
  if (points.length === 0) return null;
  switch (agg) {
    case 'first': return { value: points[0].v, at: points[0].t };
    case 'sum': return { value: points.reduce((s, p) => s + p.v, 0), at: null };
    case 'avg': return { value: points.reduce((s, p) => s + p.v, 0) / points.length, at: null };
    case 'max': {
      const p = points.reduce((a, b) => (b.v > a.v ? b : a));
      return { value: p.v, at: p.t };
    }
    case 'min': {
      const p = points.reduce((a, b) => (b.v < a.v ? b : a));
      return { value: p.v, at: p.t };
    }
  }
}

export function evaluateRule(rule: Pick<Rule, 'conditions' | 'lookaheadHours'>, series: Series, now: Date): Evaluation {
  const results: ConditionResult[] = rule.conditions.map((condition) => {
    const agg = aggregate(windowPoints(series[condition.param] ?? [], now, rule.lookaheadHours), condition.agg);
    if (!agg) return { condition, observed: null, at: null, matched: false, missing: true };
    return {
      condition,
      observed: agg.value,
      at: agg.at,
      matched: compare(agg.value, condition.op, condition.value),
      missing: false,
    };
  });
  return {
    matched: results.every((r) => r.matched),
    incomplete: results.some((r) => r.missing),
    results,
  };
}

function fmtValue(param: string, v: number, system: UnitSystem = 'imperial'): string {
  const { value, decimals, unit } = toDisplay(param, v, system);
  const n = value.toFixed(decimals);
  return unit === '%' || unit.startsWith('°') ? `${n}${unit}` : `${n} ${unit}`;
}

export function fmtTime(iso: string, tz: string): string {
  try {
    return new Intl.DateTimeFormat('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit', timeZone: tz, timeZoneName: 'short' }).format(new Date(iso));
  } catch {
    return iso;
  }
}

const AGG_WORD: Record<Agg, string> = { max: 'peak', min: 'low', sum: 'total', avg: 'avg', first: 'now' };

export function describeCondition(r: ConditionResult, tz: string, system: UnitSystem = 'imperial'): string {
  const { label } = paramInfo(r.condition.param);
  if (r.observed === null) return `${label}: no data`;
  const when = r.at ? ` (${fmtTime(r.at, tz)})` : '';
  return `${label} ${AGG_WORD[r.condition.agg]} ${fmtValue(r.condition.param, r.observed, system)}${when}`;
}

const DEFAULT_TEMPLATE = '{{severity}}: {{rule}} at {{location}}. {{summary}}';

export function render(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, k: string) => vars[k] ?? '');
}

export function buildMessage(rule: Rule, loc: Location, ev: Evaluation, kind: 'trigger' | 'clear', system: UnitSystem = 'imperial'): AlertMessage {
  const summary = ev.results.map((r) => describeCondition(r, loc.tz, system)).join('; ');
  const vars: Record<string, string> = {
    severity: rule.severity.toUpperCase(),
    rule: rule.name,
    location: loc.name,
    summary,
  };
  ev.results.forEach((r, i) => {
    vars[`v${i}`] = r.observed === null ? 'n/a' : fmtValue(r.condition.param, r.observed, system);
    vars[`t${i}`] = r.at ? fmtTime(r.at, loc.tz) : '';
  });
  const text =
    kind === 'clear'
      ? `CLEARED: ${rule.name} at ${loc.name}. Conditions no longer met. ${summary}`
      : render(rule.message || DEFAULT_TEMPLATE, vars);
  return {
    text,
    title: `${kind === 'clear' ? 'CLEARED' : rule.severity.toUpperCase()}: ${rule.name} · ${loc.name}`,
    severity: rule.severity,
    kind,
    ruleId: rule.id,
    locationId: loc.id,
  };
}

export function paramsForConditions(conditions: Condition[]): string[] {
  return [...new Set(conditions.map((c) => c.param))];
}
