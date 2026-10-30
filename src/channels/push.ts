import webpush from 'web-push';
import type { Store } from '../store.ts';
import type { Channel } from '../types.ts';

export interface PushEnv {
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
  VAPID_SUBJECT?: string;
}

type Sender = (sub: { endpoint: string; keys: { p256dh: string; auth: string } }, payload: string) => Promise<unknown>;

/**
 * Web Push to every device a user has registered (installed phone app, desktop browser).
 * Recipient.address is the user id. Dead subscriptions (404/410) are removed automatically.
 */
export function pushChannel(store: Store, env: PushEnv, sender?: Sender): Channel {
  const configured = !!(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY);
  if (configured && !sender) webpush.setVapidDetails(env.VAPID_SUBJECT ?? 'mailto:alerts@example.com', env.VAPID_PUBLIC_KEY!, env.VAPID_PRIVATE_KEY!);
  const send: Sender = sender ?? ((sub, payload) => webpush.sendNotification(sub, payload, { TTL: 6 * 3600, urgency: 'high' }));

  return {
    id: 'push',
    async send(recipient, msg) {
      if (!configured && !sender) return { ok: false, detail: 'push not configured (set VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY)' };
      const subs = store.listPushSubs(Number(recipient.address));
      if (subs.length === 0) return { ok: false, detail: 'no devices registered. Open the app, sign in, and enable notifications' };
      const payload = JSON.stringify({ title: msg.title, body: msg.text, severity: msg.severity, kind: msg.kind, alertId: msg.alertId ?? null, ack: msg.kind === 'trigger' || msg.kind === 'escalation', url: '/app' });
      let delivered = 0;
      let lastError = '';
      for (const s of subs) {
        try {
          await send({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload);
          delivered++;
        } catch (e) {
          const status = (e as { statusCode?: number }).statusCode;
          if (status === 404 || status === 410) store.deletePushSub(s.endpoint);
          lastError = status ? `push service HTTP ${status}` : e instanceof Error ? e.message : String(e);
        }
      }
      return delivered > 0
        ? { ok: true, detail: `pushed to ${delivered}/${subs.length} device(s)` }
        : { ok: false, detail: lastError || 'delivery failed' };
    },
  };
}
