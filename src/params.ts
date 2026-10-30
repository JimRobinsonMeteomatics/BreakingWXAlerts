// Meteomatics parameters this platform supports. Names verified against the live API (model "mix").
// Rules store thresholds in each parameter's own (canonical) unit. People see values in their chosen system:
//   shown = value * scale + offset
export type UnitSystem = 'imperial' | 'metric';

export interface Display {
  unit: string;
  scale: number;
  offset: number;
  decimals: number;
}

export interface ParamInfo {
  label: string;
  unit: string; // canonical unit, the one the Meteomatics parameter name carries
  decimals: number;
  display: Record<UnitSystem, Display>;
}

const same = (unit: string, decimals: number): Display => ({ unit, scale: 1, offset: 0, decimals });
const both = (unit: string, decimals: number): Record<UnitSystem, Display> => ({ imperial: same(unit, decimals), metric: same(unit, decimals) });

export const PARAMS: Record<string, ParamInfo> = {
  't_2m:F': { label: 'Temperature', unit: '°F', decimals: 0, display: { imperial: same('°F', 0), metric: { unit: '°C', scale: 5 / 9, offset: -160 / 9, decimals: 0 } } },
  'heat_index:F': { label: 'Heat index', unit: '°F', decimals: 0, display: { imperial: same('°F', 0), metric: { unit: '°C', scale: 5 / 9, offset: -160 / 9, decimals: 0 } } },
  'wind_gusts_10m_1h:mph': { label: 'Wind gusts', unit: 'mph', decimals: 0, display: { imperial: same('mph', 0), metric: { unit: 'km/h', scale: 1.609344, offset: 0, decimals: 0 } } },
  'wind_speed_100m:ms': { label: 'Wind speed @100 m', unit: 'm/s', decimals: 1, display: { imperial: { unit: 'mph', scale: 2.236936, offset: 0, decimals: 0 }, metric: same('m/s', 1) } },
  'precip_1h:mm': { label: 'Precipitation', unit: 'mm', decimals: 1, display: { imperial: { unit: 'in', scale: 1 / 25.4, offset: 0, decimals: 2 }, metric: same('mm', 1) } },
  'fresh_snow_1h:cm': { label: 'Snowfall', unit: 'cm', decimals: 1, display: { imperial: { unit: 'in', scale: 1 / 2.54, offset: 0, decimals: 1 }, metric: same('cm', 1) } },
  'hail_1h:cm': { label: 'Hail size', unit: 'cm', decimals: 1, display: { imperial: { unit: 'in', scale: 1 / 2.54, offset: 0, decimals: 1 }, metric: same('cm', 1) } },
  'prob_tstorm_1h:p': { label: 'Thunderstorm probability', unit: '%', decimals: 0, display: both('%', 0) },
  'vis:km': { label: 'Visibility', unit: 'km', decimals: 1, display: { imperial: { unit: 'mi', scale: 0.621371, offset: 0, decimals: 1 }, metric: same('km', 1) } },
  'ceiling_height_agl:ft': { label: 'Cloud ceiling', unit: 'ft', decimals: 0, display: { imperial: same('ft', 0), metric: { unit: 'm', scale: 0.3048, offset: 0, decimals: 0 } } },
  'global_rad:W': { label: 'Solar irradiance', unit: 'W/m²', decimals: 0, display: both('W/m²', 0) },
};

export function paramInfo(param: string): ParamInfo {
  return PARAMS[param] ?? { label: param, unit: '', decimals: 1, display: both('', 1) };
}

export function isUnitSystem(x: unknown): x is UnitSystem {
  return x === 'imperial' || x === 'metric';
}

/** A canonical value as shown to someone using `system`. */
export function toDisplay(param: string, value: number, system: UnitSystem): { value: number; unit: string; decimals: number } {
  const d = paramInfo(param).display[system];
  return { value: value * d.scale + d.offset, unit: d.unit, decimals: d.decimals };
}

/** A value typed in `system` back to the canonical unit rules are stored in. */
export function fromDisplay(param: string, shown: number, system: UnitSystem): number {
  const d = paramInfo(param).display[system];
  return (shown - d.offset) / d.scale;
}
