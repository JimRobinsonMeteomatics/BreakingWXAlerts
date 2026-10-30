import type { Location, Series, WeatherProvider } from '../types.ts';

const HOUR = 3_600_000;

// A synthetic storm that peaks ~5 h from now, so demos and tests produce alerts without API credentials.
// Intensity varies by location so some sites trigger and others do not.
const PEAKS: Record<string, { base: number; storm: number }> = {
  't_2m:F': { base: 62, storm: -34 },
  'heat_index:F': { base: 64, storm: 38 },
  'wind_gusts_10m_1h:mph': { base: 12, storm: 55 },
  'wind_speed_100m:ms': { base: 7, storm: 17 },
  'precip_1h:mm': { base: 0, storm: 14 },
  'fresh_snow_1h:cm': { base: 0, storm: 1.5 },
  'hail_1h:cm': { base: 0, storm: 3.2 },
  'prob_tstorm_1h:p': { base: 5, storm: 85 },
  'vis:km': { base: 20, storm: -19 },
  'ceiling_height_agl:ft': { base: 6000, storm: -5400 },
  'global_rad:W': { base: 500, storm: -380 },
};

export class MockProvider implements WeatherProvider {
  private now: () => Date;

  constructor(now: () => Date = () => new Date()) {
    this.now = now;
  }

  async fetchSeries(loc: Location, params: string[], from: Date, to: Date): Promise<Series> {
    const out: Series = {};
    const start = Math.floor(from.getTime() / HOUR) * HOUR;
    const peakAt = Math.floor(this.now().getTime() / HOUR) * HOUR + 5 * HOUR;
    const intensity = 0.4 + ((Math.abs(Math.round(loc.lat * 100 + loc.lon * 10)) % 7) / 7) * 0.9;
    for (const param of params) {
      const spec = PEAKS[param] ?? { base: 0, storm: 0 };
      out[param] = [];
      for (let t = start; t <= to.getTime(); t += HOUR) {
        const bump = Math.exp(-(((t - peakAt) / HOUR) ** 2) / 8);
        out[param].push({ t: new Date(t).toISOString().replace(/\.\d{3}Z$/, 'Z'), v: Math.round(Math.min(param.endsWith(':p') ? 100 : Infinity, Math.max(param.endsWith(':p') ? 0 : -Infinity, spec.base + spec.storm * bump * intensity)) * 10) / 10 });
      }
    }
    return out;
  }
}
