import type { Store } from './store.ts';
import { TEMPLATES, templateToRule } from './templates.ts';

/** Demo data covering all four sectors. Used with MOCK=1. */
export function seedDemo(store: Store): void {
  const dal = store.addLocation({ name: 'Dallas Flagship Store', lat: 32.78, lon: -96.8, kind: 'store', tz: 'America/Chicago', icao: null });
  const dfw = store.addLocation({ name: 'DFW Airport Ramp', lat: 32.9, lon: -97.04, kind: 'airport', tz: 'America/Chicago', icao: 'KDFW' });
  const hou = store.addLocation({ name: 'Houston Policy Cluster', lat: 29.76, lon: -95.37, kind: 'portfolio', tz: 'America/Chicago', icao: null });
  const wtx = store.addLocation({ name: 'West Texas Wind Farm', lat: 32.45, lon: -100.4, kind: 'plant', tz: 'America/Chicago', icao: null });
  const desk = store.addRecipient({ name: 'Ops console', channel: 'console', address: 'console', optedIn: true });

  const pick = (key: string, locs: number[]) => {
    const t = TEMPLATES.find((x) => x.key === key);
    if (t) store.addRule(templateToRule(t, locs, [desk.id]));
  };
  pick('retail-wind', [dal.id]);
  pick('avn-lightning', [dfw.id]);
  pick('avn-ramp-wind', [dfw.id]);
  pick('ins-hail', [hou.id]);
  pick('ins-severe-storm', [hou.id]);
  pick('energy-wind-high', [wtx.id]);
  pick('energy-line-gusts', [wtx.id]);
}
