import { execFile } from 'node:child_process';
import type { AlertMessage, Channel, ChannelId, Recipient } from '../types.ts';

export interface ChannelEnv {
  IMESSAGE_MAC_ENABLED?: string;
  IMESSAGE_MAC_MIN_GAP_MS?: string;
  IMESSAGE_BUSINESS_URL?: string;
  IMESSAGE_BUSINESS_TOKEN?: string;
  IMESSAGE_BUSINESS_ID?: string;
}

export const consoleChannel: Channel = {
  id: 'console',
  async send(r, msg) {
    console.log(`[alert -> ${r.name}] ${msg.text}`);
    return { ok: true, detail: 'logged' };
  },
};

/** Generic JSON webhook: drop alerts into Slack/Teams relays, ops consoles, trading desks, dispatch systems. */
export const webhookChannel: Channel = {
  id: 'webhook',
  async send(r, msg) {
    const res = await fetch(r.address, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        text: msg.text, title: msg.title, severity: msg.severity, kind: msg.kind,
        ruleId: msg.ruleId, locationId: msg.locationId,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    return { ok: res.ok, detail: `HTTP ${res.status}` };
  },
};

const SERVICE_LOOKUP = [
  'set svc to missing value',
  'repeat with a in every account',
  'try',
  'if service type of a is iMessage then',
  'set svc to a',
  'exit repeat',
  'end if',
  'end try',
  'end repeat',
  'if svc is missing value then error "No iMessage account signed in"',
];
const script = (sendLine: string): string[] => ['on run {target, body}', 'tell application "Messages"', ...SERVICE_LOOKUP, sendLine, 'end tell', 'end run'];
const TEXT_SCRIPT = script('send body to participant target of svc');

/**
 * iMessage through a Mac that is signed into Messages. Personal and small-beta use only:
 * it is a workaround, not an Apple-supported API, and Apple can rate-limit or lock the account.
 * Sends are serialized with a minimum gap.
 */
export function imessageMacChannel(env: ChannelEnv): Channel {
  const enabled = env.IMESSAGE_MAC_ENABLED === '1' && process.platform === 'darwin';
  const gap = Number(env.IMESSAGE_MAC_MIN_GAP_MS ?? 3000);
  let chain: Promise<unknown> = Promise.resolve();

  const osa = (lines: string[], target: string, body: string): Promise<{ ok: boolean; detail: string }> =>
    new Promise((resolve) => {
      const args = lines.flatMap((l) => ['-e', l]).concat([target, body]);
      execFile('osascript', args, { timeout: 30_000 }, (err, _out, stderr) =>
        resolve(err ? { ok: false, detail: (stderr || err.message).trim().slice(0, 300) } : { ok: true, detail: 'sent via Messages.app' }),
      );
    });

  // Run `job` after everything queued before it, then hold the queue for `gap` ms.
  const enqueue = <T,>(job: () => Promise<T>): Promise<T> => {
    const run = chain.then(job).then(async (res) => {
      await new Promise((r) => setTimeout(r, gap));
      return res;
    });
    chain = run.catch(() => undefined);
    return run;
  };

  return {
    id: 'imessage_mac',
    send(r, msg) {
      if (!enabled) return Promise.resolve({ ok: false, detail: 'imessage_mac disabled (set IMESSAGE_MAC_ENABLED=1 on a Mac signed into Messages)' });
      return enqueue(() => osa(TEXT_SCRIPT, r.address, msg.text));
    },
  };
}

/**
 * Apple Messages for Business through a Messaging Service Provider. MSP APIs differ, so this adapter is
 * deliberately thin: it POSTs a normalized payload to IMESSAGE_BUSINESS_URL. Adjust `body` to your MSP's schema.
 * Apple requires the customer to start the conversation, so only opted-in recipients are sent to.
 */
export function imessageBusinessChannel(env: ChannelEnv): Channel {
  return {
    id: 'imessage_business',
    async send(r, msg) {
      if (!env.IMESSAGE_BUSINESS_URL) return { ok: false, detail: 'IMESSAGE_BUSINESS_URL not configured' };
      if (!r.optedIn) return { ok: false, detail: 'recipient has not opted in (customer must text first)' };
      const res = await fetch(env.IMESSAGE_BUSINESS_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${env.IMESSAGE_BUSINESS_TOKEN ?? ''}` },
        body: JSON.stringify({ businessId: env.IMESSAGE_BUSINESS_ID, to: r.address, type: 'text', body: msg.text }),
        signal: AbortSignal.timeout(15_000),
      });
      return { ok: res.ok, detail: `MSP HTTP ${res.status}` };
    },
  };
}

export function createChannels(env: ChannelEnv): Map<ChannelId, Channel> {
  const list = [consoleChannel, webhookChannel, imessageMacChannel(env), imessageBusinessChannel(env)];
  return new Map(list.map((c) => [c.id, c]));
}

export type { AlertMessage, Recipient };
