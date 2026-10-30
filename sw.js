/**
 * sw.js - Service Worker para la PWA de Gestión de Datos OBD
 * Permite instalación en dispositivos móviles / escritorio y funcionamiento offline.
 */

const CACHE_NAME = 'obd-pwa-cache-v5';

const STATIC_ASSETS = [
  './',
  './index.html',
  './style.css',
  './script.js',
  './firebase-config.js',
  './manifest.json',
  './icon.svg',
  './icon-192.png',
  './icon-512.png',
  'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js',
  'https://www.gstatic.com/firebasejs/10.12.0/firebase-app-compat.js',
  'https://www.gstatic.com/firebasejs/10.12.0/firebase-database-compat.js',
  'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore-compat.js'
];

// Instalación: forzar activación inmediata
self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(STATIC_ASSETS).catch((err) => {
        console.warn('Precache completado parcialmente:', err);
      });
    })
  );
});

// Activación: limpiar todas las versiones anteriores de caché de inmediato
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) {
            console.log('Eliminando caché obsoleta:', key);
            return caches.delete(key);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

// Escuchar mensajes para forzar purga total de caché a petición del cliente
self.addEventListener('message', (event) => {
  if (event.data && (event.data.action === 'clean-cache' || event.data.action === 'skipWaiting')) {
    if (event.data.action === 'skipWaiting') {
      self.skipWaiting();
    }
    if (event.data.action === 'clean-cache') {
      event.waitUntil(
        caches.keys().then((keys) => {
          return Promise.all(keys.map((key) => caches.delete(key)));
        }).then(() => {
          if (event.ports && event.ports[0]) {
            event.ports[0].postMessage({ success: true });
          }
        })
      );
    }
  }
});

// Intercepción de peticiones con estrategia Network First para estáticos,
// y Network-Only para datos dinámicos (Firebase, Excel, Google Sheets, peticiones con timestamp ?t=)
self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // Comprobar si es petición de datos dinámicos que NUNCA debe ser cacheada con datos obsoletos
  const isDynamicData = 
    url.hostname.includes('firebaseio.com') ||
    url.hostname.includes('googleapis.com') ||
    url.hostname.includes('docs.google.com') ||
    url.pathname.endsWith('.xlsx') ||
    url.searchParams.has('t');

  if (isDynamicData) {
    // Para datos dinámicos: siempre ir directamente a la red sin almacenar copia estática
    event.respondWith(
      fetch(req).catch(() => {
        // En caso de corte total de conexión offline, intenta responder con caché si existe
        return caches.match(req);
      })
    );
    return;
  }

  // Para assets estáticos: Network First con fallback a caché
  event.respondWith(
    fetch(req)
      .then((networkRes) => {
        if (networkRes && networkRes.status === 200 && req.method === 'GET') {
          const resClone = networkRes.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, resClone));
        }
        return networkRes;
      })
      .catch(() => {
        return caches.match(req).then((cachedRes) => {
          if (cachedRes) return cachedRes;
          if (req.mode === 'navigate') {
            return caches.match('./index.html');
          }
        });
      })
  );
});
