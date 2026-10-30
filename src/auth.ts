import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  return `scrypt$${salt.toString('hex')}$${scryptSync(password, salt, 32).toString('hex')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [scheme, saltHex, hashHex] = stored.split('$');
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

// Readable, no look-alike characters (0/O, 1/l/I). ~70 bits, shown to the admin once.
const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
export function generatePassword(groups = 3, size = 4): string {
  const bytes = randomBytes(groups * size);
  const chars = [...bytes].map((b) => ALPHABET[b % ALPHABET.length]);
  return Array.from({ length: groups }, (_, g) => chars.slice(g * size, (g + 1) * size).join('')).join('-');
}

export const newSessionToken = (): string => randomBytes(32).toString('base64url');
export const hashToken = (token: string): string => createHash('sha256').update(token).digest('hex');

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

/** Fixed-window limiter for login attempts, keyed by caller + username. */
export class LoginLimiter {
  private hits = new Map<string, { count: number; resetAt: number }>();
  private max: number;
  private windowMs: number;

  constructor(max = 8, windowMs = 15 * 60_000) {
    this.max = max;
    this.windowMs = windowMs;
  }

  allow(key: string, now = Date.now()): boolean {
    const h = this.hits.get(key);
    if (!h || h.resetAt <= now) {
      this.hits.set(key, { count: 1, resetAt: now + this.windowMs });
      return true;
    }
    h.count++;
    return h.count <= this.max;
  }

  reset(key: string): void {
    this.hits.delete(key);
  }
}
