import { buildMessage, evaluateRule, paramsForConditions } from './rules.ts';
import type { Store } from './store.ts';
import type { AlertMessage, AlertRecord, Channel, ChannelId, DeliveryResult, Evaluation, Location, Rule, Series, UnitSystem, WeatherProvider } from './types.ts';

const HOUR = 3_600_000;

export interface EngineDeps {
  store: Store;
  provider: WeatherProvider;
  channels: Map<ChannelId, Channel>;
  now?: () => Date;
  log?: (msg: string) => void;
  onCycle?: (summary: CycleSummary) => void; // lets the server report monitoring health
}

export interface CycleSummary {
  checked: number;
  triggered: number;
  cleared: number;
  errors: string[];
}

export async function deliver(deps: EngineDeps, recipientIds: number[], msg: AlertMessage): Promise<DeliveryResult[]> {
  const out: DeliveryResult[] = [];
  for (const id of recipientIds) {
    const r = deps.store.getRecipient(id);
    if (!r) continue;
    const base = { recipientId: r.id, recipient: r.name, channel: r.channel };
    if (!r.optedIn) {
      out.push({ ...base, ok: false, detail: 'skipped: not opted in' });
      continue;
    }
    const ch = deps.channels.get(r.channel);
    if (!ch) {
      out.push({ ...base, ok: false, detail: 'unknown channel' });
      continue;
    }
    try {
      out.push({ ...base, ...(await ch.send(r, msg)) });
    } catch (e) {
      out.push({ ...base, ok: false, detail: e instanceof Error ? e.message : String(e) });
    }
  }
  return out;
}

/**
 * Who gets an alert for (rule, location):
 *  - recipients attached to the rule, except subscribers whose assigned locations exclude this one;
 *  - plus every subscriber assigned to this location, even if not attached to the rule.
 * A subscriber with no assigned locations only receives rules they are attached to, at any location.
 */
export function resolveRecipients(store: Store, rule: Rule, locationId: number): number[] {
  const assigned = store.userLocationMap();
  const users = store.listUsers();
  const userByRecipient = new Map(users.filter((u) => u.recipientId !== null).map((u) => [u.recipientId as number, u.id]));
  const out = rule.recipientIds.filter((rid) => {
    const uid = userByRecipient.get(rid);
    const locs = uid === undefined ? undefined : assigned.get(uid);
    return !locs || locs.includes(locationId);
  });
  for (const u of users) {
    if (u.recipientId !== null && assigned.get(u.id)?.includes(locationId) && !out.includes(u.recipientId)) out.push(u.recipientId);
  }
  return out;
}

/** Send each recipient the wording in their own unit system. */
export async function deliverByUnits(deps: EngineDeps, recipientIds: number[], imperial: AlertMessage, metricText: string, alertId: number): Promise<DeliveryResult[]> {
  const bySystem: Record<UnitSystem, number[]> = { imperial: [], metric: [] };
  for (const id of recipientIds) bySystem[deps.store.getRecipient(id)?.units ?? 'imperial'].push(id);
  return [
    ...(await deliver(deps, bySystem.imperial, { ...imperial, alertId })),
    ...(await deliver(deps, bySystem.metric, { ...imperial, text: metricText, alertId })),
  ];
}

/**
 * Escalation: if a rule has escalateAfterMin set and nobody who received the alert on the phone app has
 * pressed "Got it" in time, notify the rule's escalation recipients. Runs on its own short timer.
 * An alert is only escalated if it can be acknowledged at all (someone got it by push), is still active,
 * and has not already been escalated.
 */
export async function runEscalations(deps: EngineDeps): Promise<number> {
  const now = (deps.now ?? (() => new Date()))();
  const rules = new Map(deps.store.listRules().map((r) => [r.id, r]));
  let escalated = 0;
  for (const a of deps.store.listAlerts(500)) {
    if (a.kind !== 'trigger' || a.escalatedAt) continue;
    const rule = rules.get(a.ruleId);
    const mins = rule?.escalateAfterMin ?? 0;
    if (!rule || mins <= 0 || !rule.escalateRecipientIds?.length) continue;
    if (now.getTime() - Date.parse(a.ts) < mins * 60_000) continue; // not due yet
    const done = (): void => deps.store.markEscalated(a.id, now.toISOString());
    const ackable = a.deliveries.some((d) => d.channel === 'push' && d.ok);
    if (!ackable || deps.store.ackCount(a.id) > 0 || !deps.store.getState(a.ruleId, a.locationId).active) {
      done(); // nothing to wait for, already acknowledged, or the conditions have ended
      continue;
    }
    const lead = `ESCALATED: no one acknowledged this in ${mins} min.`;
    const record = deps.store.addAlert({
      ts: now.toISOString(), ruleId: a.ruleId, ruleName: `Escalated: ${a.ruleName}`, locationId: a.locationId, locationName: a.locationName,
      kind: 'escalation', severity: 'critical', message: `${lead} ${a.message}`, messageMetric: `${lead} ${a.messageMetric ?? a.message}`, observed: a.observed, deliveries: [],
    });
    const base: AlertMessage = { text: record.message, title: `ESCALATED: ${a.ruleName} · ${a.locationName}`, severity: 'critical', kind: 'escalation', ruleId: a.ruleId, locationId: a.locationId };
    const deliveries = await deliverByUnits(deps, rule.escalateRecipientIds, base, record.messageMetric ?? record.message, record.id);
    deps.store.setAlertDeliveries(record.id, deliveries);
    done();
    escalated++;
    deps.log?.(`escalated: ${a.ruleName} at ${a.locationName}`);
  }
  return escalated;
}

/** Fetch the data the given rules need for one location (one provider call: union of params, longest lookahead). */
async function fetchFor(deps: EngineDeps, loc: Location, rules: Rule[], now: Date): Promise<Series> {
  const params = [...new Set(rules.flatMap((r) => paramsForConditions(r.conditions)))];
  const hours = Math.max(...rules.map((r) => r.lookaheadHours));
  return deps.provider.fetchSeries(loc, params, now, new Date(now.getTime() + hours * HOUR));
}

/** Evaluate a rule against live data without sending anything or touching state. */
export async function dryRun(deps: EngineDeps, rule: Rule): Promise<{ location: Location; evaluation: Evaluation | null; error?: string }[]> {
  const now = (deps.now ?? (() => new Date()))();
  const out = [];
  for (const id of rule.locationIds) {
    const location = deps.store.getLocation(id);
    if (!location) continue;
    try {
      out.push({ location, evaluation: evaluateRule(rule, await fetchFor(deps, location, [rule], now), now) });
    } catch (e) {
      out.push({ location, evaluation: null, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return out;
}

/**
 * One polling cycle. Per (rule, location) the state machine is:
 *   clear -> active   when conditions match (alert sent unless inside the rule's cooldown)
 *   active -> clear   when conditions stop matching with complete data (optional "cleared" notice)
 * Fetch failures or missing data never change state, so a provider outage cannot fake an all-clear.
 */
export async function runCycle(deps: EngineDeps): Promise<CycleSummary> {
  const now = (deps.now ?? (() => new Date()))();
  const log = deps.log ?? (() => {});
  const summary: CycleSummary = { checked: 0, triggered: 0, cleared: 0, errors: [] };

  const rulesByLocation = new Map<number, Rule[]>();
  for (const rule of deps.store.listRules().filter((r) => r.enabled)) {
    for (const lid of rule.locationIds) rulesByLocation.set(lid, [...(rulesByLocation.get(lid) ?? []), rule]);
  }

  for (const [lid, rules] of rulesByLocation) {
    const loc = deps.store.getLocation(lid);
    if (!loc) continue;
    let series: Series;
    try {
      series = await fetchFor(deps, loc, rules, now);
    } catch (e) {
      const m = `${loc.name}: ${e instanceof Error ? e.message : String(e)}`;
      summary.errors.push(m);
      log(`fetch failed: ${m}`);
      continue;
    }

    for (const rule of rules) {
      summary.checked++;
      const ev = evaluateRule(rule, series, now);
      const st = deps.store.getState(rule.id, loc.id);
      const recipients = resolveRecipients(deps.store, rule, loc.id);
      let kind: 'trigger' | 'clear' | null = null;

      if (ev.matched && !st.active) {
        if (recipients.length === 0) {
          log(`held: ${rule.name} at ${loc.name} is met but has no recipients; will alert once someone is attached or assigned`);
          continue; // leave state untouched so the alert fires as soon as there is someone to tell
        }
        const inCooldown = st.lastTriggerAt !== null && now.getTime() - Date.parse(st.lastTriggerAt) < rule.cooldownMin * 60_000;
        deps.store.setState(rule.id, loc.id, { active: true, lastTriggerAt: inCooldown ? st.lastTriggerAt : now.toISOString() });
        if (!inCooldown) kind = 'trigger';
      } else if (!ev.matched && !ev.incomplete && st.active) {
        deps.store.setState(rule.id, loc.id, { active: false, lastTriggerAt: st.lastTriggerAt });
        if (rule.notifyOnClear && recipients.length > 0) kind = 'clear';
      }
      if (!kind) continue;

      // One wording per unit system; each recipient gets the one they chose.
      const msgs = { imperial: buildMessage(rule, loc, ev, kind, 'imperial'), metric: buildMessage(rule, loc, ev, kind, 'metric') };
      // Record first so delivery can carry the alert id (needed for on-device receipts and acknowledgements).
      const saved = deps.store.addAlert({
        ts: now.toISOString(), ruleId: rule.id, ruleName: rule.name, locationId: loc.id, locationName: loc.name,
        kind, severity: rule.severity, message: msgs.imperial.text, messageMetric: msgs.metric.text, observed: ev.results, deliveries: [],
      });
      const deliveries = await deliverByUnits(deps, recipients, msgs.imperial, msgs.metric.text, saved.id);
      deps.store.setAlertDeliveries(saved.id, deliveries);
      const msg = msgs.imperial;
      kind === 'trigger' ? summary.triggered++ : summary.cleared++;
      log(`${kind}: ${msg.text}`);
    }
  }
  return summary;
}

export function startScheduler(deps: EngineDeps, everyMinutes: number): () => void {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const s = await runCycle(deps);
      deps.onCycle?.(s);
      deps.log?.(`cycle: checked=${s.checked} triggered=${s.triggered} cleared=${s.cleared} errors=${s.errors.length}`);
    } catch (e) {
      deps.log?.(`cycle crashed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      running = false;
    }
  };
  void tick();
  const h = setInterval(tick, everyMinutes * 60_000);
  return () => clearInterval(h);
}

/** Checks for unacknowledged alerts every minute, independent of how often the weather is polled. */
export function startEscalationTimer(deps: EngineDeps, everySeconds = 60): () => void {
  let running = false;
  const h = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await runEscalations(deps);
    } catch (e) {
      deps.log?.(`escalation check failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      running = false;
    }
  }, everySeconds * 1000);
  return () => clearInterval(h);
}
