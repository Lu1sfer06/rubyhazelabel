// Service worker de RHZ BRAIN — SOLO para notificaciones push.
// A propósito NO cachea nada (sin offline): así nunca sirve una versión vieja
// del panel tras un deploy de Railway. Su única misión es recibir el push y
// abrir el panel al tocar la notificación.

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; }
  catch (e) { data = { title: 'RHZ BRAIN', body: (event.data && event.data.text()) || '' }; }

  const title = data.title || 'RHZ BRAIN';
  const options = {
    body: data.body || '',
    icon: '/assets/rhz-brain-icon.png',
    badge: '/assets/rhz-brain-icon.png',
    tag: data.tag || 'rhz',
    renotify: true,
    data: { url: data.url || '/adminrubyhazelabelttp2' }
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/adminrubyhazelabelttp2';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const client of list) {
        if (client.url.includes('adminrubyhazelabelttp2') && 'focus' in client) return client.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow(url);
    })
  );
});
