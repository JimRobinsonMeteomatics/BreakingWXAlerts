import { isUnitSystem, PARAMS } from './params.ts';
import type { Agg, ChannelId, Condition, Location, NewRule, Op, Recipient, Sector, Severity } from './types.ts';

type Result<T> = { ok: true; value: T } | { ok: false; error: string };
const fail = (error: string): { ok: false; error: string } => ({ ok: false, error });

const SECTORS: Sector[] = ['retail', 'insurance', 'energy', 'aviation'];
const SEVERITIES: Severity[] = ['info', 'warning', 'critical'];
const OPS: Op[] = ['>', '>=', '<', '<='];
const AGGS: Agg[] = ['max', 'min', 'sum', 'avg', 'first'];
export const CHANNEL_IDS: ChannelId[] = ['console', 'webhook', 'imessage_mac', 'imessage_business', 'push'];

type Obj = Record<string, unknown>;
const isObj = (x: unknown): x is Obj => typeof x === 'object' && x !== null && !Array.isArray(x);
const str = (x: unknown, max = 500): string | null => (typeof x === 'string' && x.trim() !== '' && x.length <= max ? x.trim() : null);
const num = (x: unknown): number | null => (typeof x === 'number' && Number.isFinite(x) ? x : null);
const intList = (x: unknown): number[] | null =>
  Array.isArray(x) && x.every((n) => Number.isInteger(n)) ? (x as number[]) : null;

export function validTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function validateLocation(input: unknown): Result<Omit<Location, 'id'>> {
  if (!isObj(input)) return fail('body must be an object');
  const name = str(input.name, 120);
  const lat = num(input.lat);
  const lon = num(input.lon);
  if (!name) return fail('name is required');
  if (lat === null || lat < -90 || lat > 90) return fail('lat must be between -90 and 90');
  if (lon === null || lon < -180 || lon > 180) return fail('lon must be between -180 and 180');
  const tz = input.tz === undefined ? 'UTC' : str(input.tz, 64);
  if (!tz || !validTimeZone(tz)) return fail('tz must be a valid IANA time zone, e.g. America/Chicago');
  const icao = input.icao ? str(input.icao, 4)?.toUpperCase() ?? null : null;
  return { ok: true, value: { name, lat, lon, kind: str(input.kind, 40) ?? 'site', tz, icao } };
}

export function validateRecipient(input: unknown): Result<Omit<Recipient, 'id'>> {
  if (!isObj(input)) return fail('body must be an object');
  const name = str(input.name, 120);
  const address = str(input.address, 500);
  if (!name) return fail('name is required');
  if (!address) return fail('address is required');
  if (!CHANNEL_IDS.includes(input.channel as ChannelId)) return fail(`channel must be one of ${CHANNEL_IDS.join(', ')}`);
  const channel = input.channel as ChannelId;
  if (channel === 'webhook' && !/^https?:\/\//i.test(address)) return fail('webhook address must be an http(s) URL');
  // Business Chat is customer-initiated: the user must text first, so default to not opted in.
  const optedIn = typeof input.optedIn === 'boolean' ? input.optedIn : channel !== 'imessage_business';
  const units = isUnitSystem(input.units) ? input.units : 'imperial';
  return { ok: true, value: { name, channel, address, optedIn, units } };
}

function validateCondition(x: unknown): Result<Condition> {
  if (!isObj(x)) return fail('condition must be an object');
  if (typeof x.param !== 'string' || !(x.param in PARAMS)) return fail(`param must be one of ${Object.keys(PARAMS).join(', ')}`);
  if (!AGGS.includes(x.agg as Agg)) return fail(`agg must be one of ${AGGS.join(', ')}`);
  if (!OPS.includes(x.op as Op)) return fail(`op must be one of ${OPS.join(', ')}`);
  const value = num(x.value);
  if (value === null) return fail('condition value must be a number');
  return { ok: true, value: { param: x.param, agg: x.agg as Agg, op: x.op as Op, value } };
}

export function validateRule(input: unknown): Result<NewRule> {
  if (!isObj(input)) return fail('body must be an object');
  const name = str(input.name, 160);
  if (!name) return fail('name is required');
  if (!SECTORS.includes(input.sector as Sector)) return fail(`sector must be one of ${SECTORS.join(', ')}`);
  if (!SEVERITIES.includes(input.severity as Severity)) return fail(`severity must be one of ${SEVERITIES.join(', ')}`);
  const locationIds = intList(input.locationIds);
  const recipientIds = intList(input.recipientIds);
  if (!locationIds || locationIds.length === 0) return fail('locationIds must be a non-empty list of ids');
  if (!recipientIds) return fail('recipientIds must be a list of ids');
  if (!Array.isArray(input.conditions) || input.conditions.length === 0 || input.conditions.length > 6) {
    return fail('conditions must be a list of 1 to 6 entries');
  }
  const conditions: Condition[] = [];
  for (const raw of input.conditions) {
    const r = validateCondition(raw);
    if (!r.ok) return r;
    conditions.push(r.value);
  }
  const lookaheadHours = num(input.lookaheadHours) ?? 12;
  const cooldownMin = num(input.cooldownMin) ?? 360;
  if (lookaheadHours < 1 || lookaheadHours > 240) return fail('lookaheadHours must be 1 to 240');
  if (cooldownMin < 0 || cooldownMin > 10_080) return fail('cooldownMin must be 0 to 10080');
  const message = typeof input.message === 'string' ? input.message.slice(0, 600) : '';
  const escalateAfterMin = num(input.escalateAfterMin) ?? 0;
  if (escalateAfterMin < 0 || escalateAfterMin > 1440) return fail('escalateAfterMin must be 0 to 1440');
  const escalateRecipientIds = input.escalateRecipientIds === undefined ? [] : intList(input.escalateRecipientIds);
  if (!escalateRecipientIds) return fail('escalateRecipientIds must be a list of ids');
  if (escalateAfterMin > 0 && escalateRecipientIds.length === 0) return fail('pick who to escalate to, or set escalateAfterMin to 0');
  return {
    ok: true,
    value: {
      name,
      sector: input.sector as Sector,
      severity: input.severity as Severity,
      locationIds,
      recipientIds,
      conditions,
      lookaheadHours,
      cooldownMin,
      notifyOnClear: input.notifyOnClear !== false,
      message,
      enabled: input.enabled !== false,
      escalateAfterMin,
      escalateRecipientIds,
    },
  };
}
