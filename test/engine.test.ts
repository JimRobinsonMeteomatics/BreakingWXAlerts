import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runCycle, type EngineDeps } from '../src/engine.ts';
import { Store } from '../src/store.ts';
import { validateRecipient, validateRule } from '../src/validate.ts';
import type { AlertMessage, Channel, ChannelId, Point, Series, WeatherProvider } from '../src/types.ts';

const HOUR = 3_600_000;
let clock = new Date('2026-10-30T18:00:00Z');
let gust = 20;
let failFetch = false;

const provider: WeatherProvider = {
  async fetchSeries(_loc, params, from, to): Promise<Series> {
    if (failFetch) throw new Error('provider down');
    const out: Series = {};
    for (const p of params) {
      const pts: Point[] = [];
      for (let t = Math.floor(from.getTime() / HOUR) * HOUR; t <= to.getTime(); t += HOUR) pts.push({ t: new Date(t).toISOString(), v: gust });
      out[p] = pts;
    }
    return out;
  },
};

function setup() {
  const sent: AlertMessage[] = [];
  const channel: Channel = { id: 'console', async send(_r, msg) { sent.push(msg); return { ok: true, detail: 'ok' }; } };
  const store = new Store();
  const loc = store.addLocation({ name: 'Site', lat: 1, lon: 2, kind: 'store', tz: 'UTC', icao: null });
  const rec = store.addRecipient({ name: 'Ops', channel: 'console', address: 'x', optedIn: true });
  const optedOut = store.addRecipient({ name: 'Nope', channel: 'imessage_business', address: '+1555', optedIn: false });
  store.addRule({
    name: 'Wind', sector: 'retail', severity: 'warning', locationIds: [loc.id], recipientIds: [rec.id, optedOut.id],
    conditions: [{ param: 'wind_gusts_10m_1h:mph', agg: 'max', op: '>=', value: 45 }],
    lookaheadHours: 3, cooldownMin: 120, notifyOnClear: true, message: '', enabled: true,
  });
  const deps: EngineDeps = { store, provider, channels: new Map<ChannelId, Channel>([['console', channel]]), now: () => clock };
  return { deps, store, sent };
}

test('trigger once, stay quiet while active, send clear when conditions end', async () => {
  const { deps, sent, store } = setup();
  gust = 20; clock = new Date('2026-10-30T18:00:00Z');
  assert.equal((await runCycle(deps)).triggered, 0);

  gust = 60;
  assert.equal((await runCycle(deps)).triggered, 1);
  assert.equal((await runCycle(deps)).triggered, 0); // still active: no repeat
  assert.equal(sent.length, 1);

  gust = 20;
  assert.equal((await runCycle(deps)).cleared, 1);
  assert.equal(sent.length, 2);
  assert.equal(sent[1].kind, 'clear');

  const alerts = store.listAlerts();
  assert.equal(alerts.length, 2);
  // the opted-out recipient is recorded as skipped, never sent to
  assert.ok(alerts[1].deliveries.some((d) => d.detail.startsWith('skipped')));
});

test('cooldown suppresses a flapping re-trigger', async () => {
  const { deps, sent } = setup();
  clock = new Date('2026-10-30T18:00:00Z');
  gust = 60; await runCycle(deps);
  gust = 20; await runCycle(deps);
  clock = new Date('2026-10-30T18:30:00Z'); // 30 min later, cooldown is 120
  gust = 60;
  assert.equal((await runCycle(deps)).triggered, 0);
  assert.equal(sent.filter((m) => m.kind === 'trigger').length, 1);
});

test('a provider outage neither alerts nor clears an active alert', async () => {
  const { deps, store, sent } = setup();
  clock = new Date('2026-10-30T18:00:00Z');
  gust = 60; await runCycle(deps);
  failFetch = true;
  const s = await runCycle(deps);
  failFetch = false;
  assert.equal(s.errors.length, 1);
  assert.equal(sent.length, 1);
  assert.equal(store.getState(1, 1).active, true);
});

test('validation rejects bad rules and defaults business-chat recipients to not opted in', () => {
  assert.equal(validateRule({ name: 'x' }).ok, false);
  assert.equal(validateRule({ name: 'x', sector: 'retail', severity: 'info', locationIds: [1], recipientIds: [], conditions: [{ param: 'bogus', agg: 'max', op: '>', value: 1 }] }).ok, false);
  const r = validateRecipient({ name: 'A', channel: 'imessage_business', address: '+15551234567' });
  assert.ok(r.ok && r.value.optedIn === false);
  assert.equal(validateRecipient({ name: 'A', channel: 'webhook', address: 'javascript:alert(1)' }).ok, false);
});
