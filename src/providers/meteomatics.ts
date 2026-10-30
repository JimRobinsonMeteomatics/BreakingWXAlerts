import type { Location, Point, Series, WeatherProvider } from '../types.ts';

const HOUR = 3_600_000;
const iso = (d: Date): string => d.toISOString().replace(/\.\d{3}Z$/, 'Z');

interface MeteomaticsResponse {
  status?: string;
  message?: string;
  data?: { parameter: string; coordinates: { dates: { date: string; value: number | null }[] }[] }[];
}

/** Meteomatics REST API provider (https://api.meteomatics.com). One request per location per cycle. */
export class MeteomaticsProvider implements WeatherProvider {
  private user: string;
  private pass: string;
  private baseUrl: string;
  private fetchImpl: typeof fetch;

  constructor(user: string, pass: string, baseUrl = 'https://api.meteomatics.com', fetchImpl: typeof fetch = fetch) {
    this.user = user;
    this.pass = pass;
    this.baseUrl = baseUrl;
    this.fetchImpl = fetchImpl;
  }

  async fetchSeries(loc: Location, params: string[], from: Date, to: Date): Promise<Series> {
    const start = new Date(Math.floor(from.getTime() / HOUR) * HOUR);
    const path = `${iso(start)}--${iso(to)}:PT1H/${params.join(',')}/${loc.lat},${loc.lon}/json`;
    const res = await this.fetchImpl(`${this.baseUrl}/${path}`, {
      headers: { Authorization: 'Basic ' + Buffer.from(`${this.user}:${this.pass}`).toString('base64') },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`Meteomatics HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const body = (await res.json()) as MeteomaticsResponse;
    if (body.status && body.status !== 'OK') throw new Error(`Meteomatics: ${body.message ?? body.status}`);
    const out: Series = {};
    for (const p of body.data ?? []) {
      out[p.parameter] = (p.coordinates[0]?.dates ?? [])
        .filter((d): d is { date: string; value: number } => typeof d.value === 'number')
        .map((d): Point => ({ t: d.date, v: d.value }));
    }
    return out;
  }
}
