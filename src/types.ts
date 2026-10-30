export type Op = '>' | '>=' | '<' | '<=';
export type Agg = 'max' | 'min' | 'sum' | 'avg' | 'first';
export type Severity = 'info' | 'warning' | 'critical';
export type Sector = 'retail' | 'insurance' | 'energy' | 'aviation';
import type { UnitSystem } from './params.ts';
export type { UnitSystem };
export type ChannelId = 'console' | 'webhook' | 'imessage_mac' | 'imessage_business' | 'push';

export interface Condition {
  param: string; // Meteomatics parameter, e.g. "wind_gusts_10m_1h:mph"
  agg: Agg; // how the lookahead window is reduced to one number
  op: Op;
  value: number;
}

export interface Location {
  id: number;
  name: string;
  lat: number;
  lon: number;
  kind: string; // store, airport, plant, portfolio, region...
  tz: string; // IANA zone used when formatting times for people
  icao: string | null;
}

export interface User {
  id: number;
  username: string;
  role: 'admin' | 'user';
  createdAt: string;
  recipientId: number | null; // the user's push recipient
  clearedAt: string | null; // last time they pressed Clear in the app
}

export interface PushSub {
  id: number;
  userId: number;
  endpoint: string;
  p256dh: string;
  auth: string;
  userAgent: string;
  permission: string | null; // Notification.permission as last reported by the device
  standalone: boolean | null; // running as an installed app
  checkedAt: string | null; // last time the app opened and checked in
  lastReceiptAt: string | null; // last time the device confirmed receiving a push
}

export interface Recipient {
  id: number;
  name: string;
  channel: ChannelId;
  address: string; // phone/Apple ID, webhook URL, or MSP conversation id
  optedIn: boolean;
  units: UnitSystem; // how values appear in this recipient's alerts
}

export type NewRecipient = Omit<Recipient, 'id' | 'units'> & { units?: UnitSystem };

export interface Rule {
  id: number;
  name: string;
  sector: Sector;
  severity: Severity;
  locationIds: number[];
  recipientIds: number[];
  conditions: Condition[]; // all must hold (AND)
  lookaheadHours: number;
  cooldownMin: number; // suppress re-triggers sooner than this after the last one
  notifyOnClear: boolean;
  message: string; // may use {{severity}} {{rule}} {{location}} {{summary}} {{v0}} {{t0}}
  enabled: boolean;
  escalateAfterMin?: number; // 0/undefined = off: if nobody acknowledges within this time...
  escalateRecipientIds?: number[]; // ...notify these recipients too
}

export type NewRule = Omit<Rule, 'id'>;

export interface Point {
  t: string; // ISO UTC
  v: number;
}
export type Series = Record<string, Point[]>;

export interface WeatherProvider {
  fetchSeries(loc: Location, params: string[], from: Date, to: Date): Promise<Series>;
}

export interface ConditionResult {
  condition: Condition;
  observed: number | null;
  at: string | null; // time of the extremum, when meaningful
  matched: boolean;
  missing: boolean;
}

export interface Evaluation {
  matched: boolean;
  incomplete: boolean; // data was missing; do not clear active alerts on this basis
  results: ConditionResult[];
}

export interface AlertMessage {
  text: string;
  title: string;
  severity: Severity;
  kind: 'trigger' | 'clear' | 'test' | 'escalation';
  alertId?: number;
  ruleId: number | null;
  locationId: number | null;
}

export interface DeliveryResult {
  recipientId: number;
  recipient: string;
  channel: ChannelId;
  ok: boolean;
  detail: string;
}

export interface Channel {
  id: ChannelId;
  send(recipient: Recipient, msg: AlertMessage): Promise<{ ok: boolean; detail: string }>;
}

export interface AlertRecord {
  id: number;
  ts: string;
  ruleId: number;
  ruleName: string;
  locationId: number;
  locationName: string;
  kind: 'trigger' | 'clear' | 'escalation';
  escalatedAt?: string | null;
  severity: Severity;
  message: string; // imperial wording
  messageMetric?: string; // same alert in metric units
  observed: ConditionResult[];
  deliveries: DeliveryResult[];
}
