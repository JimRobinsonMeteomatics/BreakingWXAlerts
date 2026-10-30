import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aggregate, buildMessage, compare, evaluateRule, windowPoints } from '../src/rules.ts';
import type { Location, Rule, Series } from '../src/types.ts';

const now = new Date('2026-10-30T18:20:00Z');
const hourly = (vals: number[], start = '2026-10-30T18:00:00Z'): { t: string; v: number }[] =>
  vals.map((v, i) => ({ t: new Date(Date.parse(start) + i * 3_600_000).toISOString().replace('.000Z', 'Z'), v }));

const loc: Location = { id: 1, name: 'Test Site', lat: 0, lon: 0, kind: 'store', tz: 'UTC', icao: null };
const rule = (over: Partial<Rule> = {}): Rule => ({
  id: 1, name: 'Wind', sector: 'retail', severity: 'warning', locationIds: [1], recipientIds: [],
  conditions: [{ param: 'wind_gusts_10m_1h:mph', agg: 'max', op: '>=', value: 45 }],
  lookaheadHours: 6, cooldownMin: 60, notifyOnClear: true, message: '', enabled: true, ...over,
});

test('compare handles all operators', () => {
  assert.equal(compare(5, '>', 5), false);
  assert.equal(compare(5, '>=', 5), true);
  assert.equal(compare(5, '<', 5), false);
  assert.equal(compare(5, '<=', 5), true);
});

test('windowPoints includes the current hour and excludes past and beyond lookahead', () => {
  const pts = hourly([1, 2, 3, 4], '2026-10-30T16:00:00Z'); // 16,17,18,19
  const w = windowPoints(pts, now, 1); // 18:00 .. 19:20
  assert.deepEqual(w.map((p) => p.v), [3, 4]);
});

test('aggregate max/min report the time of the extremum', () => {
  const pts = hourly([3, 9, 2]);
  assert.deepEqual(aggregate(pts, 'max'), { value: 9, at: pts[1].t });
  assert.deepEqual(aggregate(pts, 'min'), { value: 2, at: pts[2].t });
  assert.equal(aggregate(pts, 'sum')?.value, 14);
  assert.equal(aggregate([], 'max'), null);
});

test('evaluateRule matches when the peak crosses the threshold', () => {
  const series: Series = { 'wind_gusts_10m_1h:mph': hourly([10, 30, 52, 20]) };
  const ev = evaluateRule(rule(), series, now);
  assert.equal(ev.matched, true);
  assert.equal(ev.results[0].observed, 52);
});

test('multiple conditions are ANDed', () => {
  const r = rule({
    conditions: [
      { param: 't_2m:F', agg: 'min', op: '<=', value: 34 },
      { param: 'precip_1h:mm', agg: 'sum', op: '>=', value: 0.5 },
    ],
  });
  const dry: Series = { 't_2m:F': hourly([30, 31]), 'precip_1h:mm': hourly([0, 0]) };
  const wet: Series = { 't_2m:F': hourly([30, 31]), 'precip_1h:mm': hourly([0.3, 0.4]) };
  assert.equal(evaluateRule(r, dry, now).matched, false);
  assert.equal(evaluateRule(r, wet, now).matched, true);
});

test('missing data is flagged incomplete and never matches', () => {
  const ev = evaluateRule(rule(), {}, now);
  assert.equal(ev.matched, false);
  assert.equal(ev.incomplete, true);
});

test('buildMessage renders template variables with units and local time', () => {
  const r = rule({ message: '{{severity}} {{location}}: gusts {{v0}} around {{t0}}' });
  const series: Series = { 'wind_gusts_10m_1h:mph': hourly([10, 52]) };
  const ev = evaluateRule(r, series, now);
  const msg = buildMessage(r, { ...loc, tz: 'America/Chicago' }, ev, 'trigger');
  assert.match(msg.text, /^WARNING Test Site: gusts 52 mph around Fri, 2:00 PM CDT$/);
  assert.match(buildMessage(r, loc, ev, 'clear').text, /^CLEARED:/);
});
