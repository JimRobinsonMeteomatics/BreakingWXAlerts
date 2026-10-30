import type { Condition, NewRule, Sector, Severity } from './types.ts';

export interface RuleTemplate {
  key: string;
  sector: Sector;
  name: string;
  description: string;
  severity: Severity;
  lookaheadHours: number;
  cooldownMin: number;
  conditions: Condition[];
  message: string;
}

const c = (param: string, agg: Condition['agg'], op: Condition['op'], value: number): Condition => ({ param, agg, op, value });

// Thresholds are sensible starting points, not operational standards. Tune them to your own SOPs.
export const TEMPLATES: RuleTemplate[] = [
  // ---- Retail ----
  {
    key: 'retail-wind', sector: 'retail', name: 'High wind: lot, curbside, garden center',
    description: 'Gusts strong enough to move carts, displays, and canopies.',
    severity: 'warning', lookaheadHours: 12, cooldownMin: 360,
    conditions: [c('wind_gusts_10m_1h:mph', 'max', '>=', 45)],
    message: '{{severity}} {{location}}: gusts to {{v0}} around {{t0}}. Secure carts, signage, and outdoor displays.',
  },
  {
    key: 'retail-snow', sector: 'retail', name: 'Snow: staffing and deliveries',
    description: 'Accumulating snow that affects store hours, deliveries, and lot clearing.',
    severity: 'warning', lookaheadHours: 24, cooldownMin: 720,
    conditions: [c('fresh_snow_1h:cm', 'sum', '>=', 5)],
    message: '{{severity}} {{location}}: {{v0}} of snow expected in the next 24 h. Review staffing, deliveries, and lot clearing.',
  },
  {
    key: 'retail-heat', sector: 'retail', name: 'Extreme heat: cold chain and traffic',
    description: 'High heat index stresses refrigeration and shifts foot traffic.',
    severity: 'warning', lookaheadHours: 24, cooldownMin: 720,
    conditions: [c('heat_index:F', 'max', '>=', 100)],
    message: '{{severity}} {{location}}: heat index up to {{v0}} around {{t0}}. Check refrigeration and cold-chain receiving.',
  },
  {
    key: 'retail-rain', sector: 'retail', name: 'Heavy rain: flooding and traffic',
    description: 'Heavy short-term rainfall.',
    severity: 'info', lookaheadHours: 6, cooldownMin: 360,
    conditions: [c('precip_1h:mm', 'sum', '>=', 25)],
    message: '{{severity}} {{location}}: {{v0}} of rain in the next 6 h. Watch entrances, loading docks, and drains.',
  },

  // ---- Insurance ----
  {
    key: 'ins-hail', sector: 'insurance', name: 'Hail risk over insured locations',
    description: 'Forecast hail large enough to damage roofs and vehicles. Pre-position adjusters and send policyholder guidance.',
    severity: 'critical', lookaheadHours: 12, cooldownMin: 360,
    conditions: [c('hail_1h:cm', 'max', '>=', 2)],
    message: '{{severity}} {{location}}: hail up to {{v0}} forecast around {{t0}}. Expect a claims surge.',
  },
  {
    key: 'ins-severe-storm', sector: 'insurance', name: 'Severe thunderstorm wind',
    description: 'High storm probability with damaging gusts (58 mph / 50 kt is the NWS severe threshold).',
    severity: 'warning', lookaheadHours: 12, cooldownMin: 360,
    conditions: [c('prob_tstorm_1h:p', 'max', '>=', 60), c('wind_gusts_10m_1h:mph', 'max', '>=', 58)],
    message: '{{severity}} {{location}}: severe storm wind risk. Storm probability {{v0}}, gusts {{v1}} around {{t1}}.',
  },
  {
    key: 'ins-flood', sector: 'insurance', name: 'Flood-producing rainfall',
    description: '24 h rainfall totals associated with flash and river flooding.',
    severity: 'critical', lookaheadHours: 24, cooldownMin: 720,
    conditions: [c('precip_1h:mm', 'sum', '>=', 75)],
    message: '{{severity}} {{location}}: {{v0}} of rain in 24 h. Flood claims likely.',
  },
  {
    key: 'ins-freeze', sector: 'insurance', name: 'Hard freeze: burst pipes',
    description: 'Sustained sub-freezing temperatures where pipes are unprepared.',
    severity: 'warning', lookaheadHours: 36, cooldownMin: 720,
    conditions: [c('t_2m:F', 'min', '<=', 20)],
    message: '{{severity}} {{location}}: low of {{v0}} around {{t0}}. Send freeze-protection guidance to policyholders.',
  },

  // ---- Energy traders and operators ----
  {
    key: 'energy-cold-snap', sector: 'energy', name: 'Cold snap: demand spike',
    description: 'Deep cold drives heating load and gas demand.',
    severity: 'critical', lookaheadHours: 48, cooldownMin: 720,
    conditions: [c('t_2m:F', 'min', '<=', 10)],
    message: '{{severity}} {{location}}: low of {{v0}} around {{t0}}. Expect a heating-load and gas-demand spike.',
  },
  {
    key: 'energy-heat-demand', sector: 'energy', name: 'Heat wave: cooling load',
    description: 'Extreme heat drives peak cooling load and stresses thermal derates.',
    severity: 'warning', lookaheadHours: 48, cooldownMin: 720,
    conditions: [c('t_2m:F', 'max', '>=', 100)],
    message: '{{severity}} {{location}}: high of {{v0}} around {{t0}}. Expect peak cooling load.',
  },
  {
    key: 'energy-wind-high', sector: 'energy', name: 'Wind farm: high-wind cut-out risk',
    description: 'Hub-height wind near turbine cut-out (typically 25 m/s).',
    severity: 'warning', lookaheadHours: 24, cooldownMin: 360,
    conditions: [c('wind_speed_100m:ms', 'max', '>=', 22)],
    message: '{{severity}} {{location}}: 100 m wind up to {{v0}} around {{t0}}. Cut-out and curtailment risk.',
  },
  {
    key: 'energy-wind-drought', sector: 'energy', name: 'Wind farm: low-output lull',
    description: 'Hub-height wind stays below useful speeds. Expect a low-output window.',
    severity: 'info', lookaheadHours: 24, cooldownMin: 720,
    conditions: [c('wind_speed_100m:ms', 'max', '<', 3.5)],
    message: '{{severity}} {{location}}: 100 m wind stays too light for good output (peak only {{v0}}) for 24 h.',
  },
  {
    key: 'energy-solar-dim', sector: 'energy', name: 'Solar: low-irradiance day',
    description: 'Peak irradiance stays low across the next day. Expect weak PV output.',
    severity: 'info', lookaheadHours: 24, cooldownMin: 720,
    conditions: [c('global_rad:W', 'max', '<', 250)],
    message: '{{severity}} {{location}}: peak irradiance only {{v0}}. Expect weak solar output.',
  },
  {
    key: 'energy-line-gusts', sector: 'energy', name: 'Grid: damaging gusts on lines',
    description: 'Gusts that cause line faults and outages.',
    severity: 'warning', lookaheadHours: 24, cooldownMin: 360,
    conditions: [c('wind_gusts_10m_1h:mph', 'max', '>=', 60)],
    message: '{{severity}} {{location}}: gusts to {{v0}} around {{t0}}. Line-fault and outage risk.',
  },

  // ---- Aviation ground / airport ops ----
  {
    key: 'avn-lightning', sector: 'aviation', name: 'Lightning risk: ramp operations',
    description: 'Thunderstorm probability high enough to prepare ramp hold procedures.',
    severity: 'critical', lookaheadHours: 3, cooldownMin: 90,
    conditions: [c('prob_tstorm_1h:p', 'max', '>=', 50)],
    message: '{{severity}} {{location}}: thunderstorm probability {{v0}} around {{t0}}. Prepare ramp lightning-hold procedures.',
  },
  {
    key: 'avn-ramp-wind', sector: 'aviation', name: 'Ramp wind limits',
    description: 'Gusts approaching ground-handling limits (about 35 mph / 30 kt).',
    severity: 'warning', lookaheadHours: 6, cooldownMin: 120,
    conditions: [c('wind_gusts_10m_1h:mph', 'max', '>=', 35)],
    message: '{{severity}} {{location}}: gusts to {{v0}} around {{t0}}. Review bridge, stairs, and baggage-tug limits.',
  },
  {
    key: 'avn-low-vis', sector: 'aviation', name: 'Low visibility',
    description: 'Visibility below 1 mile. Expect LVP procedures and ground movement delays.',
    severity: 'warning', lookaheadHours: 6, cooldownMin: 120,
    conditions: [c('vis:km', 'min', '<', 1.6)],
    message: '{{severity}} {{location}}: visibility down to {{v0}} around {{t0}}. Low-visibility procedures likely.',
  },
  {
    key: 'avn-low-ceiling', sector: 'aviation', name: 'Low ceiling',
    description: 'Cloud ceiling below 1,000 ft.',
    severity: 'warning', lookaheadHours: 6, cooldownMin: 120,
    conditions: [c('ceiling_height_agl:ft', 'min', '<', 1000)],
    message: '{{severity}} {{location}}: ceiling down to {{v0}} around {{t0}}. Expect arrival delays.',
  },
  {
    key: 'avn-deice', sector: 'aviation', name: 'De-icing demand',
    description: 'Near-freezing temperatures with precipitation.',
    severity: 'warning', lookaheadHours: 12, cooldownMin: 240,
    conditions: [c('t_2m:F', 'min', '<=', 34), c('precip_1h:mm', 'sum', '>=', 0.5)],
    message: '{{severity}} {{location}}: {{v0}} with {{v1}} precipitation. Stage de-icing crews and fluid.',
  },
  {
    key: 'avn-snow', sector: 'aviation', name: 'Snow: airfield clearing',
    description: 'Accumulating snow that needs airfield clearing and gate-area plowing.',
    severity: 'warning', lookaheadHours: 12, cooldownMin: 240,
    conditions: [c('fresh_snow_1h:cm', 'sum', '>=', 2)],
    message: '{{severity}} {{location}}: {{v0}} of snow in 12 h. Activate snow removal.',
  },
];

export function templateToRule(t: RuleTemplate, locationIds: number[], recipientIds: number[]): NewRule {
  return {
    name: t.name,
    sector: t.sector,
    severity: t.severity,
    locationIds,
    recipientIds,
    conditions: t.conditions.map((x) => ({ ...x })),
    lookaheadHours: t.lookaheadHours,
    cooldownMin: t.cooldownMin,
    notifyOnClear: true,
    message: t.message,
    enabled: true,
  };
}
