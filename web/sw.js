// Receives pushes even when the app is closed, shows them, and tells the server the phone really got them.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

// Identified to the server by this device's push endpoint (a secret only this device and the server hold).
async function report(path, alertId) {
  try {
    const sub = await self.registration.pushManager.getSubscription();
    if (!sub) return;
    await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ endpoint: sub.endpoint, alertId: alertId ?? null }), keepalive: true });
  } catch { /* best effort: the notification is already on screen */ }
}

self.addEventListener('push', (event) => {
  let d = {};
  try { d = event.data ? event.data.json() : {}; } catch { d = { body: event.data ? event.data.text() : '' }; }
  // Android/desktop honor vibrate; iOS ignores it. Critical alerts also stay on screen until dismissed.
  const VIBRATE = { info: [200], warning: [250, 120, 250], critical: [500, 150, 500, 150, 500, 150, 500] };
  const sev = d.kind === 'clear' ? 'info' : d.severity;
  event.waitUntil((async () => {
    await self.registration.showNotification(d.title || 'Meteomatics', {
      body: d.body || '',
      icon: '/icons/192.png?v=3',
      badge: '/icons/192.png?v=3',
      data: { url: d.url || '/app', alertId: d.alertId ?? null },
      requireInteraction: d.severity === 'critical' && d.kind !== 'clear',
      vibrate: VIBRATE[sev] || VIBRATE.info,
      actions: d.ack && d.alertId ? [{ action: 'ack', title: 'Got it' }] : [],
    });
    // If the app is open, it plays its own severity sound.
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const w of wins) w.postMessage({ type: 'alert', severity: d.severity, kind: d.kind });
    await report('/push/receipt', d.alertId);
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  if (event.action === 'ack') {            // "Got it" tapped on the notification itself (Android/desktop)
    event.waitUntil(report('/push/ack', data.alertId));
    return;
  }
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const w of wins) { if ('focus' in w) { await w.focus(); return; } }
    await self.clients.openWindow(data.url || '/app');
  })());
});
