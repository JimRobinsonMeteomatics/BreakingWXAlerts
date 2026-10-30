import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword } from '../src/auth.ts';
import { runEscalations, type EngineDeps } from '../src/engine.ts';
import { reachability } from '../src/reachability.ts';
import { Store } from '../src/store.ts';
import { validateRule } from '../src/validate.ts';
import type { AlertMessage, Channel, ChannelId, DeliveryResult, PushSub, WeatherProvider } from '../src/types.ts';

const T0 = new Date('2026-10-30T18:00:00Z');
const minsAgo = (m: number, from = T0) => new Date(from.getTime() - m * 60_000).toISOString();

function setup(opts: { escalateAfterMin?: number } = {}) {
  const store = new Store();
  const loc = store.addLocation({ name: 'Site', lat: 1, lon: 1, kind: 'site', tz: 'UTC', icao: null });
  const user = store.addUser('alice', hashPassword('x'), 'user', null);
  const rec = store.addRecipient({ name: 'alice', channel: 'push', address: String(user.id), optedIn: true });
  store.setUserRecipient(user.id, rec.id);
  const boss = store.addRecipient({ name: 'boss', channel: 'console', address: 'x', optedIn: true });
  const rule = store.addRule({
    name: 'Wind', sector: 'retail', severity: 'warning', locationIds: [loc.id], recipientIds: [rec.id],
    conditions: [{ param: 'wind_gusts_10m_1h:mph', agg: 'max', op: '>=', value: 45 }],
    lookaheadHours: 3, cooldownMin: 0, notifyOnClear: false, message: '', enabled: true,
    escalateAfterMin: opts.escalateAfterMin ?? 5, escalateRecipientIds: [boss.id],
  });
  store.setState(rule.id, loc.id, { active: true, lastTriggerAt: minsAgo(10) });
  const pushOk: DeliveryResult = { recipientId: rec.id, recipient: 'alice', channel: 'push', ok: true, detail: '' };
  const alert = (deliveries: DeliveryResult[], age = 10) => store.addAlert({
    ts: minsAgo(age), ruleId: rule.id, ruleName: 'Wind', locationId: loc.id, locationName: 'Site', kind: 'trigger',
    severity: 'warning', message: 'Gusts 55 mph', messageMetric: 'Gusts 88 km/h', observed: [], deliveries,
  });
  const sent: AlertMessage[] = [];
  const ch: Channel = { id: 'console', async send(_r, m) { sent.push(m); return { ok: true, detail: 'ok' }; } };
  const deps: EngineDeps = { store, provider: {} as WeatherProvider, channels: new Map<ChannelId, Channel>([['console', ch]]), now: () => T0 };
  return { store, loc, user, rec, boss, rule, alert, pushOk, sent, deps };
}

test('an unacknowledged alert escalates once, after the time is up', async () => {
  const { alert, pushOk, sent, deps, store } = setup();
  const a = alert([pushOk], 10);
  assert.equal(await runEscalations(deps), 1);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].kind, 'escalation');
  assert.match(sent[0].text, /^ESCALATED: no one acknowledged this in 5 min\. Gusts 55 mph/);
  assert.ok(store.getAlert(a.id)?.escalatedAt);
  assert.equal(await runEscalations(deps), 0); // never twice
  assert.equal(sent.length, 1);
  assert.equal(store.listAlerts().filter((x) => x.kind === 'escalation').length, 1);
});

test('not due yet: nothing happens, and it is picked up later', async () => {
  const { alert, pushOk, sent, deps } = setup();
  alert([pushOk], 2);
  assert.equal(await runEscalations(deps), 0);
  assert.equal(sent.length, 0);
  const later = { ...deps, now: () => new Date(T0.getTime() + 4 * 60_000) };
  assert.equal(await runEscalations(later), 1);
});

test('an acknowledged alert does not escalate', async () => {
  const { alert, pushOk, user, sent, deps, store } = setup();
  const a = alert([pushOk], 10);
  store.addAck(a.id, user.id, minsAgo(7));
  assert.equal(await runEscalations(deps), 0);
  assert.equal(sent.length, 0);
});

test('no escalation when nobody could acknowledge, or the conditions already ended', async () => {
  const s1 = setup();
  s1.alert([{ recipientId: 99, recipient: 'text', channel: 'imessage_mac', ok: true, detail: '' }], 10); // no push delivery
  assert.equal(await runEscalations(s1.deps), 0);
  const s2 = setup();
  s2.alert([s2.pushOk], 10);
  s2.store.setState(s2.rule.id, s2.loc.id, { active: false, lastTriggerAt: minsAgo(10) }); // already cleared
  assert.equal(await runEscalations(s2.deps), 0);
  assert.equal(s2.sent.length, 0);
});

test('a rule without escalation is ignored', async () => {
  const { alert, pushOk, deps, sent } = setup({ escalateAfterMin: 0 });
  alert([pushOk], 60);
  assert.equal(await runEscalations(deps), 0);
  assert.equal(sent.length, 0);
});

test('receipts and acknowledgements are recorded once per person', () => {
  const { alert, pushOk, user, store } = setup();
  const a = alert([pushOk]);
  store.addReceipt(a.id, user.id, minsAgo(9));
  store.addReceipt(a.id, user.id, minsAgo(1)); // ignored: first receipt wins
  assert.equal(store.listReceipts([a.id])[0].at, minsAgo(9));
  assert.equal(store.addAck(a.id, user.id, minsAgo(5)), true);
  assert.equal(store.addAck(a.id, user.id, minsAgo(1)), false);
  assert.equal(store.ackCount(a.id), 1);
  assert.deepEqual(store.listAcks([a.id]).map((x) => x.username), ['alice']);
});

test('escalation settings are validated', () => {
  const base = { name: 'x', sector: 'retail', severity: 'info', locationIds: [1], recipientIds: [], conditions: [{ param: 't_2m:F', agg: 'max', op: '>', value: 1 }] };
  assert.equal(validateRule({ ...base, escalateAfterMin: 5, escalateRecipientIds: [] }).ok, false); // nobody to escalate to
  assert.equal(validateRule({ ...base, escalateAfterMin: 5000, escalateRecipientIds: [1] }).ok, false);
  const ok = validateRule({ ...base, escalateAfterMin: 5, escalateRecipientIds: [2] });
  assert.ok(ok.ok && ok.value.escalateAfterMin === 5);
});

const sub = (over: Partial<PushSub> = {}): PushSub => ({ id: 1, userId: 1, endpoint: 'e', p256dh: 'k', auth: 'a', userAgent: '', permission: 'granted', standalone: true, checkedAt: minsAgo(60), lastReceiptAt: null, ...over });

test('reachability: ready, stale, blocked, and not registered', () => {
  assert.equal(reachability([], T0).status, 'unreachable');
  assert.equal(reachability([sub()], T0).status, 'ready');
  assert.equal(reachability([sub({ checkedAt: minsAgo(60 * 24 * 9) })], T0).status, 'check'); // 9 days old
  assert.equal(reachability([sub({ checkedAt: minsAgo(60 * 24 * 9), lastReceiptAt: minsAgo(30) })], T0).status, 'ready'); // a recent receipt counts
  assert.equal(reachability([sub({ permission: 'denied' })], T0).status, 'unreachable');
  assert.equal(reachability([sub({ permission: null, checkedAt: null })], T0).status, 'check');
  assert.equal(reachability([sub({ permission: 'denied' }), sub({ id: 2, endpoint: 'e2' })], T0).status, 'ready'); // one good device is enough
});
