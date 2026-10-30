import { DatabaseSync } from 'node:sqlite';
import type { NewRecipient, PushSub, UnitSystem, User, AlertRecord, ChannelId, ConditionResult, DeliveryResult, Location, NewRule, Recipient, Rule, Sector, Severity } from './types.ts';

type Row = Record<string, unknown>;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS locations (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, lat REAL NOT NULL, lon REAL NOT NULL,
  kind TEXT NOT NULL, tz TEXT NOT NULL, icao TEXT
);
CREATE TABLE IF NOT EXISTS recipients (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, channel TEXT NOT NULL,
  address TEXT NOT NULL, opted_in INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, sector TEXT NOT NULL, severity TEXT NOT NULL,
  location_ids TEXT NOT NULL, recipient_ids TEXT NOT NULL, conditions TEXT NOT NULL,
  lookahead_hours REAL NOT NULL, cooldown_min REAL NOT NULL, notify_on_clear INTEGER NOT NULL,
  message TEXT NOT NULL, enabled INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS state (
  rule_id INTEGER NOT NULL, location_id INTEGER NOT NULL, active INTEGER NOT NULL,
  last_trigger_at TEXT, PRIMARY KEY (rule_id, location_id)
);
CREATE TABLE IF NOT EXISTS alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, rule_id INTEGER NOT NULL, rule_name TEXT NOT NULL,
  location_id INTEGER NOT NULL, location_name TEXT NOT NULL, kind TEXT NOT NULL, severity TEXT NOT NULL,
  message TEXT NOT NULL, observed TEXT NOT NULL, deliveries TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS alerts_ts ON alerts (id DESC);
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE COLLATE NOCASE, password_hash TEXT NOT NULL,
  role TEXT NOT NULL, created_at TEXT NOT NULL, recipient_id INTEGER
);
CREATE TABLE IF NOT EXISTS user_locations (
  user_id INTEGER NOT NULL, location_id INTEGER NOT NULL, PRIMARY KEY (user_id, location_id)
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL, expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS receipts (
  alert_id INTEGER NOT NULL, user_id INTEGER NOT NULL, at TEXT NOT NULL, PRIMARY KEY (alert_id, user_id)
);
CREATE TABLE IF NOT EXISTS acks (
  alert_id INTEGER NOT NULL, user_id INTEGER NOT NULL, at TEXT NOT NULL, PRIMARY KEY (alert_id, user_id)
);
CREATE TABLE IF NOT EXISTS push_subs (
  id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL, auth TEXT NOT NULL, user_agent TEXT NOT NULL
);
`;

const toLocation = (r: Row): Location => ({
  id: r.id as number, name: r.name as string, lat: r.lat as number, lon: r.lon as number,
  kind: r.kind as string, tz: r.tz as string, icao: (r.icao as string | null) ?? null,
});
const toRecipient = (r: Row): Recipient => ({
  id: r.id as number, name: r.name as string, channel: r.channel as ChannelId,
  address: r.address as string, optedIn: r.opted_in === 1, units: r.units === 'metric' ? 'metric' : 'imperial',
});
const toRule = (r: Row): Rule => ({
  id: r.id as number, name: r.name as string, sector: r.sector as Sector, severity: r.severity as Severity,
  locationIds: JSON.parse(r.location_ids as string), recipientIds: JSON.parse(r.recipient_ids as string),
  conditions: JSON.parse(r.conditions as string), lookaheadHours: r.lookahead_hours as number,
  cooldownMin: r.cooldown_min as number, notifyOnClear: r.notify_on_clear === 1,
  message: r.message as string, enabled: r.enabled === 1,
  escalateAfterMin: (r.escalate_after_min as number) ?? 0, escalateRecipientIds: JSON.parse((r.escalate_recipient_ids as string) ?? '[]'),
});
const toAlert = (r: Row): AlertRecord => ({
  id: r.id as number, ts: r.ts as string, ruleId: r.rule_id as number, ruleName: r.rule_name as string,
  locationId: r.location_id as number, locationName: r.location_name as string,
  kind: r.kind as 'trigger' | 'clear', severity: r.severity as Severity, message: r.message as string,
  messageMetric: (r.message_metric as string | null) ?? undefined, escalatedAt: (r.escalated_at as string | null) ?? null,
  observed: JSON.parse(r.observed as string), deliveries: JSON.parse(r.deliveries as string),
});

const toUser = (r: Row): User => ({
  id: r.id as number, username: r.username as string, role: r.role as 'admin' | 'user',
  createdAt: r.created_at as string, recipientId: (r.recipient_id as number | null) ?? null,
  clearedAt: (r.cleared_at as string | null) ?? null,
});
const toSub = (r: Row): PushSub => ({
  id: r.id as number, userId: r.user_id as number, endpoint: r.endpoint as string,
  p256dh: r.p256dh as string, auth: r.auth as string, userAgent: r.user_agent as string,
  permission: (r.permission as string | null) ?? null, standalone: r.standalone === null || r.standalone === undefined ? null : r.standalone === 1,
  checkedAt: (r.checked_at as string | null) ?? null, lastReceiptAt: (r.last_receipt_at as string | null) ?? null,
});

export interface AlertState {
  active: boolean;
  lastTriggerAt: string | null;
}

export class Store {
  private db: DatabaseSync;

  constructor(path = ':memory:') {
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
    this.db.exec(SCHEMA);
    this.addColumn('recipients', 'units', "TEXT NOT NULL DEFAULT 'imperial'");
    this.addColumn('alerts', 'message_metric', 'TEXT');
    this.addColumn('users', 'cleared_at', 'TEXT');
    this.addColumn('push_subs', 'permission', 'TEXT');
    this.addColumn('push_subs', 'standalone', 'INTEGER');
    this.addColumn('push_subs', 'checked_at', 'TEXT');
    this.addColumn('push_subs', 'last_receipt_at', 'TEXT');
    this.addColumn('rules', 'escalate_after_min', 'REAL NOT NULL DEFAULT 0');
    this.addColumn('rules', 'escalate_recipient_ids', "TEXT NOT NULL DEFAULT '[]'");
    this.addColumn('alerts', 'escalated_at', 'TEXT');
  }

  /** Lightweight migration for databases created before a column existed. */
  private addColumn(table: string, column: string, ddl: string): void {
    const have = this.db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
    if (!have) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
  }

  // ---- locations ----
  listLocations(): Location[] {
    return this.db.prepare('SELECT * FROM locations ORDER BY name').all().map(toLocation);
  }
  getLocation(id: number): Location | null {
    const r = this.db.prepare('SELECT * FROM locations WHERE id = ?').get(id);
    return r ? toLocation(r) : null;
  }
  addLocation(l: Omit<Location, 'id'>): Location {
    const res = this.db
      .prepare('INSERT INTO locations (name, lat, lon, kind, tz, icao) VALUES (?, ?, ?, ?, ?, ?)')
      .run(l.name, l.lat, l.lon, l.kind, l.tz, l.icao);
    return { ...l, id: Number(res.lastInsertRowid) };
  }
  deleteLocation(id: number): boolean {
    this.db.prepare('DELETE FROM state WHERE location_id = ?').run(id);
    this.db.prepare('DELETE FROM user_locations WHERE location_id = ?').run(id);
    return this.db.prepare('DELETE FROM locations WHERE id = ?').run(id).changes > 0;
  }

  // ---- recipients ----
  listRecipients(): Recipient[] {
    return this.db.prepare('SELECT * FROM recipients ORDER BY name').all().map(toRecipient);
  }
  getRecipient(id: number): Recipient | null {
    const r = this.db.prepare('SELECT * FROM recipients WHERE id = ?').get(id);
    return r ? toRecipient(r) : null;
  }
  findRecipient(channel: ChannelId, address: string): Recipient | null {
    const r = this.db.prepare('SELECT * FROM recipients WHERE channel = ? AND address = ?').get(channel, address);
    return r ? toRecipient(r) : null;
  }
  addRecipient(x: NewRecipient): Recipient {
    const units: UnitSystem = x.units ?? 'imperial';
    const res = this.db
      .prepare('INSERT INTO recipients (name, channel, address, opted_in, units) VALUES (?, ?, ?, ?, ?)')
      .run(x.name, x.channel, x.address, x.optedIn ? 1 : 0, units);
    return { ...x, units, id: Number(res.lastInsertRowid) };
  }
  setRecipientUnits(id: number, units: UnitSystem): void {
    this.db.prepare('UPDATE recipients SET units = ? WHERE id = ?').run(units, id);
  }
  setOptIn(id: number, optedIn: boolean): void {
    this.db.prepare('UPDATE recipients SET opted_in = ? WHERE id = ?').run(optedIn ? 1 : 0, id);
  }
  deleteRecipient(id: number): boolean {
    return this.db.prepare('DELETE FROM recipients WHERE id = ?').run(id).changes > 0;
  }

  // ---- rules ----
  listRules(): Rule[] {
    return this.db.prepare('SELECT * FROM rules ORDER BY id').all().map(toRule);
  }
  getRule(id: number): Rule | null {
    const r = this.db.prepare('SELECT * FROM rules WHERE id = ?').get(id);
    return r ? toRule(r) : null;
  }
  private ruleArgs(r: NewRule): (string | number)[] {
    return [
      r.name, r.sector, r.severity, JSON.stringify(r.locationIds), JSON.stringify(r.recipientIds),
      JSON.stringify(r.conditions), r.lookaheadHours, r.cooldownMin, r.notifyOnClear ? 1 : 0, r.message, r.enabled ? 1 : 0,
      r.escalateAfterMin ?? 0, JSON.stringify(r.escalateRecipientIds ?? []),
    ];
  }
  addRule(r: NewRule): Rule {
    const res = this.db
      .prepare(
        `INSERT INTO rules (name, sector, severity, location_ids, recipient_ids, conditions, lookahead_hours,
         cooldown_min, notify_on_clear, message, enabled, escalate_after_min, escalate_recipient_ids) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(...this.ruleArgs(r));
    return { ...r, id: Number(res.lastInsertRowid) };
  }
  updateRule(id: number, r: NewRule): Rule | null {
    const res = this.db
      .prepare(
        `UPDATE rules SET name=?, sector=?, severity=?, location_ids=?, recipient_ids=?, conditions=?,
         lookahead_hours=?, cooldown_min=?, notify_on_clear=?, message=?, enabled=?, escalate_after_min=?, escalate_recipient_ids=? WHERE id=?`,
      )
      .run(...this.ruleArgs(r), id);
    return res.changes > 0 ? { ...r, id } : null;
  }
  /** Forget active/cooldown state so the rule evaluates from scratch on the next cycle. */
  clearRuleState(ruleId: number): void {
    this.db.prepare('DELETE FROM state WHERE rule_id = ?').run(ruleId);
  }
  deleteRule(id: number): boolean {
    this.db.prepare('DELETE FROM state WHERE rule_id = ?').run(id);
    return this.db.prepare('DELETE FROM rules WHERE id = ?').run(id).changes > 0;
  }

  // ---- alert state (per rule x location) ----
  getState(ruleId: number, locationId: number): AlertState {
    const r = this.db.prepare('SELECT * FROM state WHERE rule_id = ? AND location_id = ?').get(ruleId, locationId);
    return r ? { active: r.active === 1, lastTriggerAt: (r.last_trigger_at as string | null) ?? null } : { active: false, lastTriggerAt: null };
  }
  setState(ruleId: number, locationId: number, s: AlertState): void {
    this.db
      .prepare(
        `INSERT INTO state (rule_id, location_id, active, last_trigger_at) VALUES (?,?,?,?)
         ON CONFLICT (rule_id, location_id) DO UPDATE SET active = excluded.active, last_trigger_at = excluded.last_trigger_at`,
      )
      .run(ruleId, locationId, s.active ? 1 : 0, s.lastTriggerAt);
  }

  // ---- users, sessions, push subscriptions ----
  listUsers(): User[] {
    return this.db.prepare('SELECT * FROM users ORDER BY username').all().map(toUser);
  }
  getUser(id: number): User | null {
    const r = this.db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    return r ? toUser(r) : null;
  }
  /** Returns the user and password hash, for login. */
  getUserForLogin(username: string): { user: User; passwordHash: string } | null {
    const r = this.db.prepare('SELECT * FROM users WHERE username = ?').get(username);
    return r ? { user: toUser(r), passwordHash: r.password_hash as string } : null;
  }
  addUser(username: string, passwordHash: string, role: 'admin' | 'user', recipientId: number | null): User {
    const createdAt = new Date().toISOString();
    const res = this.db
      .prepare('INSERT INTO users (username, password_hash, role, created_at, recipient_id) VALUES (?,?,?,?,?)')
      .run(username, passwordHash, role, createdAt, recipientId);
    return { id: Number(res.lastInsertRowid), username, role, createdAt, recipientId, clearedAt: null };
  }
  /** Replace the set of locations a user is assigned to. */
  setUserLocations(userId: number, locationIds: number[]): void {
    this.db.prepare('DELETE FROM user_locations WHERE user_id = ?').run(userId);
    const ins = this.db.prepare('INSERT OR IGNORE INTO user_locations (user_id, location_id) VALUES (?, ?)');
    for (const id of new Set(locationIds)) ins.run(userId, id);
  }
  getUserLocations(userId: number): number[] {
    return this.db.prepare('SELECT location_id FROM user_locations WHERE user_id = ? ORDER BY location_id').all(userId).map((r) => r.location_id as number);
  }
  /** userId -> assigned location ids, for users that have any. */
  userLocationMap(): Map<number, number[]> {
    const m = new Map<number, number[]>();
    for (const r of this.db.prepare('SELECT user_id, location_id FROM user_locations').all()) {
      const u = r.user_id as number;
      m.set(u, [...(m.get(u) ?? []), r.location_id as number]);
    }
    return m;
  }
  setUserClearedAt(id: number, iso: string): void {
    this.db.prepare('UPDATE users SET cleared_at = ? WHERE id = ?').run(iso, id);
  }
  setUserRecipient(id: number, recipientId: number): void {
    this.db.prepare('UPDATE users SET recipient_id = ? WHERE id = ?').run(recipientId, id);
  }
  setPassword(id: number, passwordHash: string): void {
    this.db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(passwordHash, id);
    this.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
  }
  deleteUser(id: number): boolean {
    this.db.prepare('DELETE FROM user_locations WHERE user_id = ?').run(id);
    this.db.prepare('DELETE FROM receipts WHERE user_id = ?').run(id);
    this.db.prepare('DELETE FROM acks WHERE user_id = ?').run(id);
    this.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
    this.db.prepare('DELETE FROM push_subs WHERE user_id = ?').run(id);
    return this.db.prepare('DELETE FROM users WHERE id = ?').run(id).changes > 0;
  }
  createSession(tokenHash: string, userId: number, expiresAt: Date): void {
    this.db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(new Date().toISOString());
    this.db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?,?,?)').run(tokenHash, userId, expiresAt.toISOString());
  }
  getSessionUser(tokenHash: string, now = new Date()): User | null {
    const r = this.db
      .prepare('SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ?')
      .get(tokenHash, now.toISOString());
    return r ? toUser(r) : null;
  }
  deleteSession(tokenHash: string): void {
    this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash);
  }
  savePushSub(s: Pick<PushSub, 'userId' | 'endpoint' | 'p256dh' | 'auth' | 'userAgent'>): void {
    this.db
      .prepare(
        `INSERT INTO push_subs (user_id, endpoint, p256dh, auth, user_agent) VALUES (?,?,?,?,?)
         ON CONFLICT (endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth, user_agent = excluded.user_agent`,
      )
      .run(s.userId, s.endpoint, s.p256dh, s.auth, s.userAgent);
  }
  getPushSubByEndpoint(endpoint: string): PushSub | null {
    const r = this.db.prepare('SELECT * FROM push_subs WHERE endpoint = ?').get(endpoint);
    return r ? toSub(r) : null;
  }
  /** The app reports its own readiness each time it opens. */
  updateDeviceStatus(endpoint: string, permission: string, standalone: boolean, at: string): void {
    this.db.prepare('UPDATE push_subs SET permission = ?, standalone = ?, checked_at = ? WHERE endpoint = ?').run(permission, standalone ? 1 : 0, at, endpoint);
  }
  touchReceipt(endpoint: string, at: string): void {
    this.db.prepare('UPDATE push_subs SET last_receipt_at = ? WHERE endpoint = ?').run(at, endpoint);
  }
  listPushSubs(userId: number): PushSub[] {
    return this.db.prepare('SELECT * FROM push_subs WHERE user_id = ?').all(userId).map(toSub);
  }
  deletePushSub(endpoint: string): void {
    this.db.prepare('DELETE FROM push_subs WHERE endpoint = ?').run(endpoint);
  }
  /** Recent alerts that were delivered to (or attempted for) a recipient. */
  listAlertsForRecipient(recipientId: number, limit = 100): AlertRecord[] {
    return this.listAlerts(500).filter((a) => a.deliveries.some((d) => d.recipientId === recipientId)).slice(0, limit);
  }

  // ---- alert log ----
  addAlert(a: Omit<AlertRecord, 'id'>): AlertRecord {
    const res = this.db
      .prepare(
        `INSERT INTO alerts (ts, rule_id, rule_name, location_id, location_name, kind, severity, message, message_metric, observed, deliveries)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(a.ts, a.ruleId, a.ruleName, a.locationId, a.locationName, a.kind, a.severity, a.message, a.messageMetric ?? null, JSON.stringify(a.observed), JSON.stringify(a.deliveries));
    return { ...a, id: Number(res.lastInsertRowid) };
  }
  getAlert(id: number): AlertRecord | null {
    const r = this.db.prepare('SELECT * FROM alerts WHERE id = ?').get(id);
    return r ? toAlert(r) : null;
  }
  setAlertDeliveries(id: number, deliveries: DeliveryResult[]): void {
    this.db.prepare('UPDATE alerts SET deliveries = ? WHERE id = ?').run(JSON.stringify(deliveries), id);
  }
  markEscalated(id: number, at: string): void {
    this.db.prepare('UPDATE alerts SET escalated_at = ? WHERE id = ?').run(at, id);
  }
  /** First receipt per (alert, person) wins. */
  addReceipt(alertId: number, userId: number, at: string): void {
    this.db.prepare('INSERT OR IGNORE INTO receipts (alert_id, user_id, at) VALUES (?,?,?)').run(alertId, userId, at);
  }
  /** Returns true if this was the person's first acknowledgement of the alert. */
  addAck(alertId: number, userId: number, at: string): boolean {
    return Number(this.db.prepare('INSERT OR IGNORE INTO acks (alert_id, user_id, at) VALUES (?,?,?)').run(alertId, userId, at).changes) > 0;
  }
  ackCount(alertId: number): number {
    return Number(this.db.prepare('SELECT COUNT(*) AS n FROM acks WHERE alert_id = ?').get(alertId)?.n ?? 0);
  }
  private joined(table: 'receipts' | 'acks', alertIds: number[]): { alertId: number; userId: number; username: string; at: string }[] {
    if (alertIds.length === 0) return [];
    const q = `SELECT t.alert_id, t.user_id, u.username, t.at FROM ${table} t JOIN users u ON u.id = t.user_id WHERE t.alert_id IN (${alertIds.map(() => '?').join(',')}) ORDER BY t.at`;
    return this.db.prepare(q).all(...alertIds).map((r) => ({ alertId: r.alert_id as number, userId: r.user_id as number, username: r.username as string, at: r.at as string }));
  }
  listReceipts(alertIds: number[]) { return this.joined('receipts', alertIds); }
  listAcks(alertIds: number[]) { return this.joined('acks', alertIds); }

  /** Permanently deletes the alert log. Returns how many records were removed. */
  clearAlerts(): number {
    this.db.prepare('DELETE FROM receipts').run();
    this.db.prepare('DELETE FROM acks').run();
    return Number(this.db.prepare('DELETE FROM alerts').run().changes);
  }
  listAlerts(limit = 100): AlertRecord[] {
    return this.db.prepare('SELECT * FROM alerts ORDER BY id DESC LIMIT ?').all(Math.min(Math.max(limit, 1), 500)).map(toAlert);
  }
}

export type { ConditionResult, DeliveryResult };
