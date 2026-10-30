import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { timingSafeEqual } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync } from 'node:fs';
import { createChannels } from './channels/index.ts';
import { pushChannel } from './channels/push.ts';
import { visibleAlerts } from './feed.ts';
import { reachability } from './reachability.ts';
import { generatePassword, hashPassword, hashToken, LoginLimiter, newSessionToken, parseCookies, verifyPassword } from './auth.ts';
import { deliver, dryRun, runCycle, startEscalationTimer, startScheduler, type EngineDeps } from './engine.ts';
import { isUnitSystem, PARAMS } from './params.ts';
import { MeteomaticsProvider } from './providers/meteomatics.ts';
import { MockProvider } from './providers/mock.ts';
import { seedDemo } from './seed.ts';
import { Store } from './store.ts';
import { TEMPLATES, templateToRule } from './templates.ts';
import { CHANNEL_IDS, validateLocation, validateRecipient, validateRule } from './validate.ts';
import type { WeatherProvider } from './types.ts';

const env = process.env;
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const PORT = Number(env.PORT ?? 8787);
const HOST = env.HOST ?? '127.0.0.1';
const API_KEY = env.API_KEY ?? '';
const WEBHOOK_SECRET = env.WEBHOOK_SECRET ?? '';
const MOCK = env.MOCK === '1';
const ALERT_TTL_MIN = Number.isFinite(Number(env.ALERT_TTL_MIN ?? 30)) ? Number(env.ALERT_TTL_MIN ?? 30) : 30; // 0 = never expire

let provider: WeatherProvider;
if (MOCK) provider = new MockProvider();
else if (env.METEOMATICS_USER && env.METEOMATICS_PASS) provider = new MeteomaticsProvider(env.METEOMATICS_USER, env.METEOMATICS_PASS);
else {
  console.error('Set METEOMATICS_USER and METEOMATICS_PASS, or run with MOCK=1 for synthetic data.');
  process.exit(1);
}

const dbPath = MOCK ? ':memory:' : (env.DB_PATH ?? join(root, 'data', 'alerts.db'));
if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
const store = new Store(dbPath);
if (MOCK) seedDemo(store);

const channels = createChannels(env);
channels.set('push', pushChannel(store, env));
const POLL_MIN = Number(env.POLL_MINUTES ?? 10);
const health = { lastCycleAt: null as string | null, checked: 0, errors: 0 };
const deps: EngineDeps = {
  store, provider, channels,
  log: (m) => console.log(`[${new Date().toISOString()}] ${m}`),
  onCycle: (s) => { health.lastCycleAt = new Date().toISOString(); health.checked = s.checked; health.errors = s.errors.length; },
};

/** Is monitoring actually running? People see this in the app, so silence is never mistaken for "all clear". */
function monitoring(): { state: 'starting' | 'ok' | 'delayed' | 'degraded'; lastCheckAt: string | null; intervalMin: number } {
  const base = { lastCheckAt: health.lastCycleAt, intervalMin: POLL_MIN };
  if (!health.lastCycleAt) return { ...base, state: 'starting' };
  if (Date.now() - Date.parse(health.lastCycleAt) > POLL_MIN * 2.5 * 60_000) return { ...base, state: 'delayed' };
  if (health.checked > 0 && health.errors > 0) return { ...base, state: 'degraded' };
  return { ...base, state: 'ok' };
}

// ---------- helpers ----------
class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 1_000_000) throw new HttpError(413, 'body too large');
    chunks.push(c as Buffer);
  }
  if (size === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'invalid JSON');
  }
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

const idOf = (s: string): number => {
  const n = Number(s);
  if (!Number.isInteger(n)) throw new HttpError(400, 'invalid id');
  return n;
};

function checkRefs(locationIds: number[], recipientIds: number[]): void {
  for (const id of locationIds) if (!store.getLocation(id)) throw new HttpError(400, `unknown location ${id}`);
  for (const id of recipientIds) if (!store.getRecipient(id)) throw new HttpError(400, `unknown recipient ${id}`);
}

// ---------- routing ----------
type Handler = (m: RegExpMatchArray, req: IncomingMessage, res: ServerResponse) => Promise<unknown> | unknown;
const routes: { method: string; re: RegExp; h: Handler; status?: number }[] = [];
const route = (method: string, path: string, h: Handler, status = 200) =>
  routes.push({ method, re: new RegExp(`^${path}$`), h, status });

route('GET', '/api/meta', () => ({
  params: PARAMS,
  templates: TEMPLATES,
  sectors: ['retail', 'insurance', 'energy', 'aviation'],
  channels: CHANNEL_IDS,
  provider: MOCK ? 'mock' : 'meteomatics',
  alertTtlMin: ALERT_TTL_MIN,
  publicUrl: (env.PUBLIC_URL ?? '').replace(/\/+$/, '') || null,
}));

route('GET', '/api/locations', () => store.listLocations());
route('POST', '/api/locations', async (_m, req) => {
  const v = validateLocation(await readJson(req));
  if (!v.ok) throw new HttpError(400, v.error);
  return store.addLocation(v.value);
}, 201);
route('DELETE', '/api/locations/(\\d+)', (m) => {
  if (!store.deleteLocation(idOf(m[1]))) throw new HttpError(404, 'not found');
  return { ok: true };
});

route('GET', '/api/recipients', () => store.listRecipients());
route('POST', '/api/recipients', async (_m, req) => {
  const v = validateRecipient(await readJson(req));
  if (!v.ok) throw new HttpError(400, v.error);
  return store.addRecipient(v.value);
}, 201);
route('POST', '/api/recipients/(\\d+)/test', async (m) => {
  const r = store.getRecipient(idOf(m[1]));
  if (!r) throw new HttpError(404, 'not found');
  const msg = { text: 'Test message from Meteomatics. Delivery is working.', title: 'Test', severity: 'info' as const, kind: 'test' as const, ruleId: null, locationId: null };
  return deliver(deps, [r.id], msg);
});
route('DELETE', '/api/recipients/(\\d+)', (m) => {
  if (!store.deleteRecipient(idOf(m[1]))) throw new HttpError(404, 'not found');
  return { ok: true };
});

route('GET', '/api/rules', () => store.listRules());
route('POST', '/api/rules', async (_m, req) => {
  const v = validateRule(await readJson(req));
  if (!v.ok) throw new HttpError(400, v.error);
  checkRefs(v.value.locationIds, [...v.value.recipientIds, ...(v.value.escalateRecipientIds ?? [])]);
  return store.addRule(v.value);
}, 201);
route('PUT', '/api/rules/(\\d+)', async (m, req) => {
  const v = validateRule(await readJson(req));
  if (!v.ok) throw new HttpError(400, v.error);
  checkRefs(v.value.locationIds, [...v.value.recipientIds, ...(v.value.escalateRecipientIds ?? [])]);
  const id = idOf(m[1]);
  const before = store.getRule(id);
  const r = store.updateRule(id, v.value);
  if (!r) throw new HttpError(404, 'not found');
  // If what the rule watches changed, old "already alerted" state no longer means anything: start fresh.
  const sig = (x: { conditions: unknown; locationIds: unknown; lookaheadHours: unknown }) => JSON.stringify([x.conditions, x.locationIds, x.lookaheadHours]);
  if (before && sig(before) !== sig(r)) store.clearRuleState(id);
  return r;
});
route('DELETE', '/api/rules/(\\d+)', (m) => {
  if (!store.deleteRule(idOf(m[1]))) throw new HttpError(404, 'not found');
  return { ok: true };
});
route('POST', '/api/rules/(\\d+)/rearm', (m) => {
  const id = idOf(m[1]);
  if (!store.getRule(id)) throw new HttpError(404, 'not found');
  store.clearRuleState(id);
  return { ok: true };
});
route('POST', '/api/rules/(\\d+)/dry-run', async (m) => {
  const rule = store.getRule(idOf(m[1]));
  if (!rule) throw new HttpError(404, 'not found');
  return dryRun(deps, rule);
});

route('POST', '/api/templates/([\\w-]+)/apply', async (m, req) => {
  const t = TEMPLATES.find((x) => x.key === m[1]);
  if (!t) throw new HttpError(404, 'unknown template');
  const body = (await readJson(req)) as { locationIds?: number[]; recipientIds?: number[] };
  const v = validateRule(templateToRule(t, body.locationIds ?? [], body.recipientIds ?? []));
  if (!v.ok) throw new HttpError(400, v.error);
  checkRefs(v.value.locationIds, [...v.value.recipientIds, ...(v.value.escalateRecipientIds ?? [])]);
  return store.addRule(v.value);
}, 201);

route('GET', '/api/alerts', (_m, req) => {
  const limit = Number(new URL(req.url ?? '', 'http://x').searchParams.get('limit') ?? 100);
  const alerts = store.listAlerts(Number.isFinite(limit) ? limit : 100);
  const ids = alerts.map((a) => a.id);
  const receipts = store.listReceipts(ids);
  const acks = store.listAcks(ids);
  return alerts.map((a) => ({
    ...a,
    receipts: receipts.filter((r) => r.alertId === a.id).map((r) => ({ user: r.username, at: r.at })),
    acks: acks.filter((r) => r.alertId === a.id).map((r) => ({ user: r.username, at: r.at })),
  }));
});
route('POST', '/api/run', () => runCycle(deps));
route('DELETE', '/api/alerts', () => ({ ok: true, removed: store.clearAlerts() }));

// ---------- accounts and the phone app ----------
const SESSION_COOKIE = 'bw_session';
const SESSION_DAYS = 30;
const limiter = new LoginLimiter();
const TRUST_PROXY = env.TRUST_PROXY === '1';
const PUSH_HOSTS = ['googleapis.com', 'mozilla.com', 'push.apple.com', 'windows.com']; // known push services only

function clientIp(req: IncomingMessage): string {
  const fwd = String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim();
  return (TRUST_PROXY && fwd) || req.socket.remoteAddress || 'unknown';
}

const isSecure = (req: IncomingMessage): boolean => env.COOKIE_SECURE === '1' || (TRUST_PROXY && req.headers['x-forwarded-proto'] === 'https');

function requireUser(req: IncomingMessage) {
  const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  const user = token ? store.getSessionUser(hashToken(token)) : null;
  if (!user) throw new HttpError(401, 'not signed in');
  return user;
}

const DUMMY_HASH = hashPassword('not-a-real-password'); // equalizes timing for unknown usernames

route('POST', '/auth/login', async (_m, req, res) => {
  const body = (await readJson(req)) as { username?: unknown; password?: unknown };
  const username = typeof body.username === 'string' ? body.username.trim().toLowerCase() : '';
  const password = typeof body.password === 'string' ? body.password.trim() : '';
  const key = `${clientIp(req)}|${username}`;
  if (!limiter.allow(key)) throw new HttpError(429, 'too many attempts, try again later');
  const found = username ? store.getUserForLogin(username) : null;
  const ok = verifyPassword(password, found?.passwordHash ?? DUMMY_HASH) && found !== null;
  if (!ok || !found) throw new HttpError(401, 'wrong username or password');
  limiter.reset(key);
  const token = newSessionToken();
  store.createSession(hashToken(token), found.user.id, new Date(Date.now() + SESSION_DAYS * 86_400_000));
  res.setHeader('set-cookie', `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_DAYS * 86_400}${isSecure(req) ? '; Secure' : ''}`);
  return { ok: true, username: found.user.username };
});

route('POST', '/auth/logout', (_m, req, res) => {
  const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  if (token) store.deleteSession(hashToken(token));
  res.setHeader('set-cookie', `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
  return { ok: true };
});

route('GET', '/me', (_m, req) => {
  const u = requireUser(req);
  const locations = store.getUserLocations(u.id).map((id) => store.getLocation(id)?.name).filter((n): n is string => !!n);
  const units = (u.recipientId !== null ? store.getRecipient(u.recipientId)?.units : undefined) ?? 'imperial';
  return { username: u.username, units, alertTtlMin: ALERT_TTL_MIN, monitoring: monitoring(), locations, devices: store.listPushSubs(u.id).length, pushConfigured: !!env.VAPID_PUBLIC_KEY, vapidPublicKey: env.VAPID_PUBLIC_KEY ?? null };
});

route('GET', '/me/alerts', (_m, req) => {
  const u = requireUser(req);
  if (u.recipientId === null) return [];
  // Only what a subscriber needs. Delivery details of other recipients stay private.
  const metric = store.getRecipient(u.recipientId)?.units === 'metric';
  const list = visibleAlerts(store.listAlertsForRecipient(u.recipientId, 100), new Date(), ALERT_TTL_MIN, u.clearedAt);
  const mine = new Set(store.listAcks(list.map((a) => a.id)).filter((x) => x.userId === u.id).map((x) => x.alertId));
  return list.map((a) => ({
    id: a.id, ts: a.ts, kind: a.kind, severity: a.severity, ruleName: a.ruleName, locationName: a.locationName,
    message: metric && a.messageMetric ? a.messageMetric : a.message,
    ackable: a.kind === 'trigger' || a.kind === 'escalation', acked: mine.has(a.id),
  }));
});

route('POST', '/me/alerts/(\\d+)/ack', (m, req) => {
  const u = requireUser(req);
  const a = store.getAlert(idOf(m[1]));
  if (!a || u.recipientId === null || !a.deliveries.some((d) => d.recipientId === u.recipientId)) throw new HttpError(404, 'not found');
  store.addAck(a.id, u.id, new Date().toISOString());
  return { ok: true };
});

route('POST', '/me/device-status', async (_m, req) => {
  const u = requireUser(req);
  const b = (await readJson(req)) as { endpoint?: unknown; permission?: unknown; standalone?: unknown };
  const sub = typeof b.endpoint === 'string' ? store.getPushSubByEndpoint(b.endpoint) : null;
  if (!sub || sub.userId !== u.id) return { ok: false }; // no registration on this device yet
  if (b.permission !== 'granted' && b.permission !== 'denied' && b.permission !== 'default') throw new HttpError(400, 'bad permission');
  store.updateDeviceStatus(sub.endpoint, b.permission, b.standalone === true, new Date().toISOString());
  return { ok: true };
});

// Called by the phone's background worker the moment a push arrives or "Got it" is tapped on the notification.
// Identified by the device's push endpoint, which is an unguessable secret only that device and this server hold.
route('POST', '/push/receipt', async (_m, req) => {
  const b = (await readJson(req)) as { endpoint?: unknown; alertId?: unknown };
  const sub = typeof b.endpoint === 'string' ? store.getPushSubByEndpoint(b.endpoint) : null;
  if (!sub) throw new HttpError(404, 'unknown device');
  const now = new Date().toISOString();
  store.touchReceipt(sub.endpoint, now);
  if (Number.isInteger(b.alertId) && store.getAlert(b.alertId as number)) store.addReceipt(b.alertId as number, sub.userId, now);
  return { ok: true };
});
route('POST', '/push/ack', async (_m, req) => {
  const b = (await readJson(req)) as { endpoint?: unknown; alertId?: unknown };
  const sub = typeof b.endpoint === 'string' ? store.getPushSubByEndpoint(b.endpoint) : null;
  if (!sub || !Number.isInteger(b.alertId) || !store.getAlert(b.alertId as number)) throw new HttpError(404, 'not found');
  store.addAck(b.alertId as number, sub.userId, new Date().toISOString());
  return { ok: true };
});

route('POST', '/me/alerts/clear', (_m, req) => {
  const u = requireUser(req);
  store.setUserClearedAt(u.id, new Date().toISOString()); // hides what they have seen; the admin log is untouched
  return { ok: true };
});

route('PUT', '/me/units', async (_m, req) => {
  const u = requireUser(req);
  const b = (await readJson(req)) as { units?: unknown };
  if (!isUnitSystem(b.units) || u.recipientId === null) throw new HttpError(400, 'units must be "imperial" or "metric"');
  store.setRecipientUnits(u.recipientId, b.units);
  return { ok: true, units: b.units };
});

route('POST', '/me/push/subscribe', async (_m, req) => {
  const u = requireUser(req);
  const b = (await readJson(req)) as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } };
  const endpoint = typeof b.endpoint === 'string' ? b.endpoint : '';
  let host = '';
  try {
    const url = new URL(endpoint);
    if (url.protocol !== 'https:') throw new Error('not https');
    host = url.hostname;
  } catch {
    throw new HttpError(400, 'invalid push endpoint');
  }
  if (!PUSH_HOSTS.some((h) => host === h || host.endsWith('.' + h))) throw new HttpError(400, 'unsupported push service');
  if (typeof b.keys?.p256dh !== 'string' || typeof b.keys?.auth !== 'string') throw new HttpError(400, 'missing keys');
  store.savePushSub({ userId: u.id, endpoint, p256dh: b.keys.p256dh, auth: b.keys.auth, userAgent: String(req.headers['user-agent'] ?? '').slice(0, 200) });
  return { ok: true, devices: store.listPushSubs(u.id).length };
});

route('POST', '/me/push/unsubscribe', async (_m, req) => {
  const u = requireUser(req);
  const b = (await readJson(req)) as { endpoint?: unknown };
  if (typeof b.endpoint === 'string' && store.listPushSubs(u.id).some((s) => s.endpoint === b.endpoint)) store.deletePushSub(b.endpoint);
  return { ok: true };
});

route('POST', '/me/push/test', async (_m, req) => {
  const u = requireUser(req);
  if (u.recipientId === null) throw new HttpError(400, 'no push recipient');
  const msg = { text: 'Delivery is working. You will get weather alerts like this.', title: 'Meteomatics', severity: 'info' as const, kind: 'test' as const, ruleId: null, locationId: null };
  return deliver(deps, [u.recipientId], msg);
});

// Admin: create the credentials you hand to people. Requires the API key.
route('GET', '/api/users', () => store.listUsers().map((u) => ({ ...u, devices: store.listPushSubs(u.id).length, locationIds: store.getUserLocations(u.id), reach: reachability(store.listPushSubs(u.id), new Date()) })));
route('PUT', '/api/users/(\\d+)/locations', async (m, req) => {
  const u = store.getUser(idOf(m[1]));
  if (!u) throw new HttpError(404, 'not found');
  const b = (await readJson(req)) as { locationIds?: unknown };
  if (!Array.isArray(b.locationIds) || !b.locationIds.every((n) => Number.isInteger(n))) throw new HttpError(400, 'locationIds must be a list of ids');
  for (const id of b.locationIds as number[]) if (!store.getLocation(id)) throw new HttpError(400, `unknown location ${id}`);
  store.setUserLocations(u.id, b.locationIds as number[]);
  return { ok: true, locationIds: store.getUserLocations(u.id) };
});
route('POST', '/api/users', async (_m, req) => {
  const b = (await readJson(req)) as { username?: unknown };
  const username = typeof b.username === 'string' ? b.username.trim().toLowerCase() : '';
  if (!/^[a-z0-9._-]{3,32}$/.test(username)) throw new HttpError(400, 'username must be 3-32 chars: letters, digits, . _ -');
  if (store.getUserForLogin(username)) throw new HttpError(409, 'username already exists');
  const password = generatePassword();
  const user = store.addUser(username, hashPassword(password), 'user', null);
  const rec = store.addRecipient({ name: username, channel: 'push', address: String(user.id), optedIn: true });
  store.setUserRecipient(user.id, rec.id);
  return { user: { ...user, recipientId: rec.id }, password, note: 'Shown once. Give these credentials to the user.' };
}, 201);
route('POST', '/api/users/(\\d+)/reset-password', (m) => {
  const u = store.getUser(idOf(m[1]));
  if (!u) throw new HttpError(404, 'not found');
  const password = generatePassword();
  store.setPassword(u.id, hashPassword(password));
  return { username: u.username, password, note: 'Shown once. All existing sessions were signed out.' };
});
route('DELETE', '/api/users/(\\d+)', (m) => {
  const u = store.getUser(idOf(m[1]));
  if (!u) throw new HttpError(404, 'not found');
  store.deleteUser(u.id);
  if (u.recipientId !== null) store.deleteRecipient(u.recipientId);
  return { ok: true };
});

/**
 * Inbound events from an Apple Messages for Business MSP. Shape is normalized: { from, text }.
 * The customer texting START is the opt-in Apple requires; STOP opts them out.
 */
route('POST', '/webhooks/imessage-business', async (_m, req) => {
  if (!WEBHOOK_SECRET || !safeEqual(String(req.headers['x-webhook-secret'] ?? ''), WEBHOOK_SECRET)) throw new HttpError(401, 'bad webhook secret');
  const body = (await readJson(req)) as { from?: unknown; text?: unknown };
  const from = typeof body.from === 'string' ? body.from.trim() : '';
  const word = typeof body.text === 'string' ? body.text.trim().toUpperCase() : '';
  if (!from) throw new HttpError(400, 'from is required');
  const existing = store.findRecipient('imessage_business', from);
  if (word === 'START' || word === 'YES') {
    if (existing) store.setOptIn(existing.id, true);
    else store.addRecipient({ name: from, channel: 'imessage_business', address: from, optedIn: true });
    return { ok: true, optedIn: true };
  }
  if (word === 'STOP' || word === 'UNSUBSCRIBE') {
    if (existing) store.setOptIn(existing.id, false);
    return { ok: true, optedIn: false };
  }
  return { ok: true };
});

const WEB_FILE = join(root, 'web', 'index.html');
const STATIC: Record<string, { file: string; type: string; cache: string }> = {
  '/app': { file: 'app.html', type: 'text/html; charset=utf-8', cache: 'no-cache' },
  '/sw.js': { file: 'sw.js', type: 'text/javascript; charset=utf-8', cache: 'no-cache' },
  '/manifest.webmanifest': { file: 'manifest.webmanifest', type: 'application/manifest+json', cache: 'no-cache' },
  '/brand/logo.png': { file: 'brand/logo.png', type: 'image/png', cache: 'public, max-age=3600' },
  '/icons/180.png': { file: 'icons/180.png', type: 'image/png', cache: 'public, max-age=3600' },
  '/icons/192.png': { file: 'icons/192.png', type: 'image/png', cache: 'public, max-age=3600' },
  '/icons/512.png': { file: 'icons/512.png', type: 'image/png', cache: 'public, max-age=3600' },
};

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', 'http://x');
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'x-content-type-options': 'nosniff' });
      res.end(await readFile(WEB_FILE));
      return;
    }
    const asset = STATIC[url.pathname];
    if (req.method === 'GET' && asset) {
      res.writeHead(200, { 'content-type': asset.type, 'cache-control': asset.cache, 'x-content-type-options': 'nosniff' });
      res.end(await readFile(join(root, 'web', asset.file)));
      return;
    }
    // Browsers cannot send cross-site JSON without a preflight, so requiring it blocks CSRF on cookie-authenticated routes.
    if (req.method !== 'GET' && (url.pathname.startsWith('/me/') || url.pathname.startsWith('/auth/') || url.pathname.startsWith('/push/')) && !String(req.headers['content-type'] ?? '').includes('application/json')) {
      throw new HttpError(415, 'content-type must be application/json');
    }
    if (url.pathname.startsWith('/api/') && API_KEY) {
      const supplied = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
      if (!safeEqual(supplied, API_KEY)) throw new HttpError(401, 'unauthorized');
    }
    for (const r of routes) {
      const m = url.pathname.match(r.re);
      if (m && r.method === req.method) return send(res, r.status ?? 200, await r.h(m, req, res));
    }
    throw new HttpError(404, 'not found');
  } catch (e) {
    if (e instanceof HttpError) return send(res, e.status, { error: e.message });
    console.error(e);
    send(res, 500, { error: 'internal error' });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`BreaWX Alerts on http://${HOST}:${PORT}  (provider: ${MOCK ? 'mock' : 'meteomatics'}${API_KEY ? '' : ', API OPEN: set API_KEY'})`);
  startScheduler(deps, POLL_MIN);
  startEscalationTimer(deps);
});
