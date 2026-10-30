import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generatePassword, hashPassword, hashToken, LoginLimiter, newSessionToken, parseCookies, verifyPassword } from '../src/auth.ts';
import { pushChannel } from '../src/channels/push.ts';
import { Store } from '../src/store.ts';
import type { AlertMessage } from '../src/types.ts';

const msg: AlertMessage = { text: 'Gusts to 55 mph', title: 'WARNING: Wind', severity: 'warning', kind: 'trigger', ruleId: 1, locationId: 1 };

test('passwords hash, verify, and are unique per hash', () => {
  const pw = generatePassword();
  assert.match(pw, /^[a-z2-9]{4}-[a-z2-9]{4}-[a-z2-9]{4}$/);
  const h = hashPassword(pw);
  assert.equal(verifyPassword(pw, h), true);
  assert.equal(verifyPassword('wrong', h), false);
  assert.notEqual(hashPassword(pw), h); // salted
  assert.equal(verifyPassword(pw, 'garbage'), false);
});

test('sessions: valid until expiry, gone after logout or password reset', () => {
  const store = new Store();
  const user = store.addUser('alice', hashPassword('x'), 'user', null);
  const token = newSessionToken();
  store.createSession(hashToken(token), user.id, new Date(Date.now() + 60_000));
  assert.equal(store.getSessionUser(hashToken(token))?.username, 'alice');
  assert.equal(store.getSessionUser(hashToken(token), new Date(Date.now() + 120_000)), null); // expired
  store.setPassword(user.id, hashPassword('y'));
  assert.equal(store.getSessionUser(hashToken(token)), null); // reset signs everyone out
});

test('usernames are unique case-insensitively', () => {
  const store = new Store();
  store.addUser('Bob', hashPassword('x'), 'user', null);
  assert.throws(() => store.addUser('bob', hashPassword('x'), 'user', null));
  assert.equal(store.getUserForLogin('BOB')?.user.username, 'Bob');
});

test('login limiter blocks after too many attempts and resets', () => {
  const l = new LoginLimiter(3, 1000);
  assert.deepEqual([1, 2, 3, 4].map(() => l.allow('k', 0)), [true, true, true, false]);
  assert.equal(l.allow('k', 2000), true); // new window
  l.reset('k');
});

test('cookie parsing', () => {
  assert.deepEqual(parseCookies('a=1; bw_session=abc%20d; junk'), { a: '1', bw_session: 'abc d' });
});

test('push channel: no devices, delivery, and dead-subscription cleanup', async () => {
  const store = new Store();
  const user = store.addUser('carol', hashPassword('x'), 'user', null);
  const rec = store.addRecipient({ name: 'carol', channel: 'push', address: String(user.id), optedIn: true });
  const sent: string[] = [];
  const ch = pushChannel(store, {}, async (sub, payload) => {
    if (sub.endpoint.includes('dead')) throw Object.assign(new Error('gone'), { statusCode: 410 });
    sent.push(payload);
  });

  assert.match((await ch.send(rec, msg)).detail, /no devices/);

  store.savePushSub({ userId: user.id, endpoint: 'https://fcm.googleapis.com/ok', p256dh: 'k', auth: 'a', userAgent: 'x' });
  store.savePushSub({ userId: user.id, endpoint: 'https://fcm.googleapis.com/dead', p256dh: 'k', auth: 'a', userAgent: 'x' });
  const res = await ch.send(rec, msg);
  assert.equal(res.ok, true);
  assert.equal(res.detail, 'pushed to 1/2 device(s)');
  assert.equal(JSON.parse(sent[0]).body, 'Gusts to 55 mph');
  assert.equal(store.listPushSubs(user.id).length, 1); // dead one pruned
});

test('a user only sees alerts delivered to their own recipient', () => {
  const store = new Store();
  const base = { ts: new Date().toISOString(), ruleId: 1, ruleName: 'r', locationId: 1, locationName: 'l', kind: 'trigger' as const, severity: 'info' as const, message: 'm', observed: [] };
  const d = (id: number) => ({ recipientId: id, recipient: 'x', channel: 'push' as const, ok: true, detail: '' });
  store.addAlert({ ...base, deliveries: [d(1)] });
  store.addAlert({ ...base, deliveries: [d(2)] });
  assert.equal(store.listAlertsForRecipient(1).length, 1);
  assert.equal(store.listAlertsForRecipient(3).length, 0);
});
