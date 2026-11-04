const CACHE_NAME = 'pantau-treasury-v26.11.04.2';
const ASSETS_TO_CACHE = [
  './',
  './index.html',
  './style.css',
  './script.js',
  './tailwind.css',
  './icon.png',
  './manifest.json',
  'https://cdn.jsdelivr.net/npm/pusher-js@8.3.0/dist/web/pusher.min.js',
  'https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap'
];

// Install Event - Pre-cache core assets
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      console.log('[Service Worker] Pre-caching core assets');
      return cache.addAll(ASSETS_TO_CACHE);
    }).then(() => self.skipWaiting())
  );
});

// Activate Event - Clean up old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cache) => {
          if (cache !== CACHE_NAME) {
            console.log('[Service Worker] Clearing old cache:', cache);
            return caches.delete(cache);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

// Fetch Event - Stale-While-Revalidate for Assets, Network-First for APIs
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') {
    return;
  }

  const requestUrl = new URL(event.request.url);

  // Bypass Service Worker untuk panggilan API eksternal agar ditangani langsung oleh network stack browser
  if (requestUrl.hostname.includes('vercel.app') ||
      requestUrl.hostname.includes('treasury.id') ||
      requestUrl.pathname.includes('/api/')) {
    return;
  }

  // Stale-While-Revalidate for static assets & fonts (instant load + background update)
  event.respondWith(
    caches.match(event.request, { ignoreSearch: true }).then((cachedResponse) => {
      const fetchPromise = fetch(event.request)
        .then((networkResponse) => {
          const isCachable = networkResponse && networkResponse.status === 200 && (
            networkResponse.type === 'basic' || 
            (networkResponse.type === 'cors' && (
              requestUrl.hostname.includes('fonts.gstatic.com') ||
              requestUrl.hostname.includes('fonts.googleapis.com') ||
              requestUrl.hostname.includes('cdn.jsdelivr.net')
            ))
          );

          if (isCachable) {
            const responseToCache = networkResponse.clone();
            caches.open(CACHE_NAME).then((cache) => {
              cache.put(event.request, responseToCache);
            });
          }
          return networkResponse;
        })
        .catch(() => {
          // Fallback saat network offline dan aset belum tersimpan di cache
          if (!cachedResponse) {
            return new Response('Offline', {
              status: 503,
              statusText: 'Service Unavailable',
              headers: { 'Content-Type': 'text/plain' }
            });
          }
        });

      return cachedResponse || fetchPromise;
    })
  );
});

// ==========================================
// PWA Web Push Notification Listeners
// ==========================================
self.addEventListener('push', (event) => {
  event.waitUntil((async () => {
    let title = '🔥 PROMO TREASURY AKTIF (ON)!';
    let body = 'Promo Treasury sedang aktif! Segera buka aplikasi untuk eksekusi.';
    let url = './';

    if (event.data) {
      try {
        const parsed = event.data.json();
        if (parsed.title) title = parsed.title;
        if (parsed.body) body = parsed.body;
        if (parsed.url) url = parsed.url;
      } catch (e) {
        const txt = event.data.text();
        if (txt) body = txt;
      }
    } else {
      // Fallback: Jika push diterima tanpa payload, fetch data harga live dari Firebase
      try {
        const res = await fetch('https://monitor-treasury-default-rtdb.firebaseio.com/admin_settings.json');
        if (res.ok) {
          const d = await res.json();
          if (d && d.promo_price) {
            body = `Batas beli promo: Rp ${Number(d.promo_price).toLocaleString('id-ID')} | Buka aplikasi sekarang!`;
          }
        }
      } catch (e) { }
    }

    const options = {
      body: body,
      icon: './icon.png',
      badge: './icon.png',
      vibrate: [200, 100, 200, 100, 200],
      tag: 'treasury-promo-push',
      renotify: true,
      data: { url: url },
      actions: [
        { action: 'open', title: 'Buka Dashboard' }
      ]
    };

    return self.registration.showNotification(title, options);
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = event.notification.data?.url || './';

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
      // Jika tab sudah terbuka, bawa ke depan
      for (let client of windowClients) {
        if ('focus' in client) {
          return client.focus();
        }
      }
      // Jika belum terbuka, buka window baru
      if (clients.openWindow) {
        return clients.openWindow(targetUrl);
      }
    })
  );
});


