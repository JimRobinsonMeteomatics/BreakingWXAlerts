import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MeteomaticsProvider } from '../src/providers/meteomatics.ts';

const loc = { id: 1, name: 'DFW', lat: 32.9, lon: -97.04, kind: 'airport', tz: 'UTC', icao: 'KDFW' };

test('builds the REST URL, sends basic auth, and parses the response', async () => {
  let seenUrl = '';
  let seenAuth = '';
  const fake = (async (url: string, init: RequestInit) => {
    seenUrl = url;
    seenAuth = (init.headers as Record<string, string>).Authorization;
    return new Response(JSON.stringify({
      status: 'OK',
      data: [{ parameter: 't_2m:F', coordinates: [{ dates: [{ date: '2026-10-30T18:00:00Z', value: 68.2 }, { date: '2026-10-30T19:00:00Z', value: null }] }] }],
    }));
  }) as unknown as typeof fetch;

  const p = new MeteomaticsProvider('u', 'p', 'https://example.test', fake);
  const out = await p.fetchSeries(loc, ['t_2m:F', 'vis:km'], new Date('2026-10-30T18:20:00Z'), new Date('2026-10-30T21:00:00Z'));
  assert.equal(seenUrl, 'https://example.test/2026-10-30T18:00:00Z--2026-10-30T21:00:00Z:PT1H/t_2m:F,vis:km/32.9,-97.04/json');
  assert.equal(seenAuth, 'Basic ' + Buffer.from('u:p').toString('base64'));
  assert.deepEqual(out['t_2m:F'], [{ t: '2026-10-30T18:00:00Z', v: 68.2 }]); // null values dropped
});

test('surfaces API errors', async () => {
  const fake = (async () => new Response('nope', { status: 401 })) as unknown as typeof fetch;
  await assert.rejects(new MeteomaticsProvider('u', 'p', 'https://example.test', fake).fetchSeries(loc, ['t_2m:F'], new Date(), new Date()), /HTTP 401/);
});
