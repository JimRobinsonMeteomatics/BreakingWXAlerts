import { test } from 'node:test';
import assert from 'node:assert/strict';
import { visibleAlerts } from '../src/feed.ts';
import { hashPassword } from '../src/auth.ts';
import { Store } from '../src/store.ts';

const now = new Date('2026-10-30T18:00:00Z');
const at = (min: number) => ({ ts: new Date(now.getTime() - min * 60_000).toISOString(), id: min });

test('alerts expire after the TTL', () => {
  const out = visibleAlerts([at(5), at(29), at(31), at(120)], now, 30, null);
  assert.deepEqual(out.map((a) => a.id), [5, 29]);
});

test('a TTL of 0 never expires', () => {
  assert.equal(visibleAlerts([at(5), at(9999)], now, 0, null).length, 2);
});

test('Clear hides everything up to that moment, but later alerts still show', () => {
  const clearedAt = new Date(now.getTime() - 10 * 60_000).toISOString();
  assert.deepEqual(visibleAlerts([at(5), at(12), at(20)], now, 30, clearedAt).map((a) => a.id), [5]);
});

test('clearing is per user and leaves the admin log intact; Clear log deletes it', () => {
  const store = new Store();
  const a = store.addUser('a', hashPassword('x'), 'user', null);
  const b = store.addUser('b', hashPassword('x'), 'user', null);
  store.addAlert({ ts: now.toISOString(), ruleId: 1, ruleName: 'r', locationId: 1, locationName: 'l', kind: 'trigger', severity: 'info', message: 'm', observed: [], deliveries: [] });
  store.setUserClearedAt(a.id, new Date().toISOString());
  assert.ok(store.getUser(a.id)?.clearedAt);
  assert.equal(store.getUser(b.id)?.clearedAt, null);
  assert.equal(store.listAlerts().length, 1); // still in the admin log
  assert.equal(store.clearAlerts(), 1);
  assert.equal(store.listAlerts().length, 0);
});
