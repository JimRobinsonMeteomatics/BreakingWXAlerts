import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fromDisplay, PARAMS, toDisplay } from '../src/params.ts';
import { runCycle, type EngineDeps } from '../src/engine.ts';
import { buildMessage, evaluateRule } from '../src/rules.ts';
import { Store } from '../src/store.ts';
import type { AlertMessage, Channel, ChannelId, Location, Point, Rule, Series, WeatherProvider } from '../src/types.ts';

test('conversions match known values', () => {
  const t = (p: string, v: number, s: 'imperial' | 'metric') => toDisplay(p, v, s).value;
  assert.ok(Math.abs(t('t_2m:F', 32, 'metric') - 0) < 1e-9);
  assert.ok(Math.abs(t('t_2m:F', 212, 'metric') - 100) < 1e-9);
  assert.ok(Math.abs(t('wind_gusts_10m_1h:mph', 50, 'metric') - 80.4672) < 1e-4);
  assert.ok(Math.abs(t('precip_1h:mm', 25.4, 'imperial') - 1) < 1e-9);
  assert.ok(Math.abs(t('wind_speed_100m:ms', 10, 'imperial') - 22.36936) < 1e-5);
  assert.ok(Math.abs(t('ceiling_height_agl:ft', 1000, 'metric') - 304.8) < 1e-9);
  assert.equal(t('prob_tstorm_1h:p', 70, 'metric'), 70);
});

test('display and input conversions round-trip for every parameter and system', () => {
  for (const p of Object.keys(PARAMS)) for (const s of ['imperial', 'metric'] as const) {
    const back = fromDisplay(p, toDisplay(p, 37.5, s).value, s);
    assert.ok(Math.abs(back - 37.5) < 1e-9, `${p} ${s}`);
  }
});

const loc: Location = { id: 1, name: 'St. Gallen', lat: 0, lon: 0, kind: 'site', tz: 'Europe/Zurich', icao: null };
const rule: Rule = {
  id: 1, name: 'Wind', sector: 'retail', severity: 'warning', locationIds: [1], recipientIds: [],
  conditions: [{ param: 'wind_gusts_10m_1h:mph', agg: 'max', op: '>=', value: 45 }],
  lookaheadHours: 3, cooldownMin: 0, notifyOnClear: false, message: '{{severity}} {{location}}: gusts {{v0}}', enabled: true,
};

test('the same alert reads in mph or km/h', () => {
  const now = new Date('2026-10-30T18:20:00Z');
  const pts: Point[] = [{ t: '2026-10-30T19:00:00Z', v: 50 }];
  const ev = evaluateRule(rule, { 'wind_gusts_10m_1h:mph': pts }, now);
  assert.equal(buildMessage(rule, loc, ev, 'trigger', 'imperial').text, 'WARNING St. Gallen: gusts 50 mph');
  assert.equal(buildMessage(rule, loc, ev, 'trigger', 'metric').text, 'WARNING St. Gallen: gusts 80 km/h');
});

test('each recipient is sent their own units, and both wordings are stored', async () => {
  const store = new Store();
  store.addLocation(loc);
  const us = store.addRecipient({ name: 'us', channel: 'console', address: 'x', optedIn: true, units: 'imperial' });
  const eu = store.addRecipient({ name: 'eu', channel: 'push', address: 'y', optedIn: true, units: 'metric' });
  store.addRule({ ...rule, recipientIds: [us.id, eu.id] });
  const sent: Record<string, string> = {};
  const mk = (id: ChannelId): Channel => ({ id, async send(r, m: AlertMessage) { sent[r.name] = m.text; return { ok: true, detail: 'ok' }; } });
  const HOUR = 3_600_000;
  const provider: WeatherProvider = {
    async fetchSeries(_l, params, from, to): Promise<Series> {
      const pts: Point[] = [];
      for (let t = Math.floor(from.getTime() / HOUR) * HOUR; t <= to.getTime(); t += HOUR) pts.push({ t: new Date(t).toISOString(), v: 50 });
      return Object.fromEntries(params.map((p) => [p, pts]));
    },
  };
  const deps: EngineDeps = { store, provider, channels: new Map([['console', mk('console')], ['push', mk('push')]]), now: () => new Date('2026-10-30T18:00:00Z') };
  await runCycle(deps);
  assert.equal(sent.us, 'WARNING St. Gallen: gusts 50 mph');
  assert.equal(sent.eu, 'WARNING St. Gallen: gusts 80 km/h');
  const a = store.listAlerts()[0];
  assert.match(a.message, /50 mph/);
  assert.match(a.messageMetric ?? '', /80 km\/h/);
});

test('an existing database gains the new columns', () => {
  const s = new Store(':memory:');
  assert.equal(s.addRecipient({ name: 'n', channel: 'console', address: 'a', optedIn: true }).units, 'imperial');
  s.setRecipientUnits(1, 'metric');
  assert.equal(s.getRecipient(1)?.units, 'metric');
});
