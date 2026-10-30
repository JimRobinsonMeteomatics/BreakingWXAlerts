import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword } from '../src/auth.ts';
import { resolveRecipients, runCycle, type EngineDeps } from '../src/engine.ts';
import { Store } from '../src/store.ts';
import type { AlertMessage, Channel, ChannelId, NewRule, Point, Series, WeatherProvider } from '../src/types.ts';

function world() {
  const store = new Store();
  const a = store.addLocation({ name: 'A', lat: 1, lon: 1, kind: 'site', tz: 'UTC', icao: null });
  const b = store.addLocation({ name: 'B', lat: 2, lon: 2, kind: 'site', tz: 'UTC', icao: null });
  const ops = store.addRecipient({ name: 'Ops', channel: 'console', address: 'x', optedIn: true });
  const mkUser = (name: string) => {
    const u = store.addUser(name, hashPassword('x'), 'user', null);
    const r = store.addRecipient({ name, channel: 'push', address: String(u.id), optedIn: true });
    store.setUserRecipient(u.id, r.id);
    return { user: u, rid: r.id };
  };
  const rule: NewRule = {
    name: 'Wind', sector: 'retail', severity: 'warning', locationIds: [a.id, b.id], recipientIds: [ops.id],
    conditions: [{ param: 'wind_gusts_10m_1h:mph', agg: 'max', op: '>=', value: 45 }],
    lookaheadHours: 3, cooldownMin: 0, notifyOnClear: false, message: '', enabled: true,
  };
  return { store, a, b, ops, mkUser, rule };
}

test('assigned users get alerts at their locations without being attached to the rule', () => {
  const { store, a, b, ops, mkUser, rule } = world();
  const alice = mkUser('alice');
  store.setUserLocations(alice.user.id, [a.id]);
  const saved = store.addRule(rule);
  assert.deepEqual(resolveRecipients(store, saved, a.id), [ops.id, alice.rid]);
  assert.deepEqual(resolveRecipients(store, saved, b.id), [ops.id]);
});

test('an attached user with assignments is limited to those locations; with none, gets everything attached', () => {
  const { store, a, b, ops, mkUser, rule } = world();
  const bob = mkUser('bob');
  const carol = mkUser('carol');
  store.setUserLocations(bob.user.id, [a.id]);
  const saved = store.addRule({ ...rule, recipientIds: [ops.id, bob.rid, carol.rid] });
  assert.deepEqual(resolveRecipients(store, saved, a.id), [ops.id, bob.rid, carol.rid]);
  assert.deepEqual(resolveRecipients(store, saved, b.id), [ops.id, carol.rid]); // bob excluded at B
});

test('assignments are replaced, and removed with the user or location', () => {
  const { store, a, b, mkUser } = world();
  const u = mkUser('dan');
  store.setUserLocations(u.user.id, [a.id, b.id, a.id]);
  assert.deepEqual(store.getUserLocations(u.user.id), [a.id, b.id]);
  store.setUserLocations(u.user.id, [b.id]);
  assert.deepEqual(store.getUserLocations(u.user.id), [b.id]);
  store.deleteLocation(b.id);
  assert.deepEqual(store.getUserLocations(u.user.id), []);
});

test('end to end: an assigned user is notified only for their location', async () => {
  const { store, a, b, mkUser, rule } = world();
  const erin = mkUser('erin');
  store.setUserLocations(erin.user.id, [b.id]);
  store.addRule(rule);
  const sent: { to: string; text: string }[] = [];
  const mk = (id: ChannelId): Channel => ({ id, async send(r, m: AlertMessage) { sent.push({ to: r.name, text: m.text }); return { ok: true, detail: 'ok' }; } });
  const HOUR = 3_600_000;
  const provider: WeatherProvider = {
    async fetchSeries(_l, params, from, to): Promise<Series> {
      const pts: Point[] = [];
      for (let t = Math.floor(from.getTime() / HOUR) * HOUR; t <= to.getTime(); t += HOUR) pts.push({ t: new Date(t).toISOString(), v: 60 });
      return Object.fromEntries(params.map((p) => [p, pts]));
    },
  };
  const deps: EngineDeps = { store, provider, channels: new Map([['console', mk('console')], ['push', mk('push')]]), now: () => new Date('2026-10-30T18:00:00Z') };
  await runCycle(deps);
  assert.deepEqual(sent.filter((s) => s.to === 'erin').map((s) => s.text.includes('B')), [true]); // erin: exactly one alert, for B
  assert.equal(sent.filter((s) => s.to === 'Ops').length, 2); // ops attached: both locations
  assert.ok(a.id);
});

test('an alert with nobody to notify is held, then fires once someone is assigned', async () => {
  const { store, a, mkUser, rule } = world();
  const frank = mkUser('frank');
  store.addRule({ ...rule, locationIds: [a.id], recipientIds: [] });
  const sent: string[] = [];
  const ch: Channel = { id: 'push', async send(r) { sent.push(r.name); return { ok: true, detail: 'ok' }; } };
  const HOUR = 3_600_000;
  const provider: WeatherProvider = {
    async fetchSeries(_l, params, from, to): Promise<Series> {
      const pts: Point[] = [];
      for (let t = Math.floor(from.getTime() / HOUR) * HOUR; t <= to.getTime(); t += HOUR) pts.push({ t: new Date(t).toISOString(), v: 60 });
      return Object.fromEntries(params.map((p) => [p, pts]));
    },
  };
  const deps: EngineDeps = { store, provider, channels: new Map<ChannelId, Channel>([['push', ch]]), now: () => new Date('2026-10-30T18:00:00Z') };
  assert.equal((await runCycle(deps)).triggered, 0); // nobody to tell: held, not consumed
  assert.equal(store.listAlerts().length, 0);
  store.setUserLocations(frank.user.id, [a.id]);
  assert.equal((await runCycle(deps)).triggered, 1); // now it fires
  assert.deepEqual(sent, ['frank']);
});
