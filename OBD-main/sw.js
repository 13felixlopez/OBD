/**
 * sw.js - Service Worker para la PWA de Gestión de Datos OBD
 * Permite instalación en dispositivos móviles / escritorio y funcionamiento offline.
 */

const CACHE_NAME = 'obd-pwa-cache-v2';

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

// Intercepción de peticiones con estrategia Network First (red primero, fallback a caché si no hay internet)
self.addEventListener('fetch', (event) => {
  const req = event.request;

  event.respondWith(
    fetch(req)
      .then((networkRes) => {
        // Si responde la red correctamente y es GET, actualizamos la copia en caché
        if (networkRes && networkRes.status === 200 && req.method === 'GET') {
          const resClone = networkRes.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, resClone));
        }
        return networkRes;
      })
      .catch(() => {
        // Si no hay red (offline), responder con lo que haya en caché
        return caches.match(req).then((cachedRes) => {
          if (cachedRes) return cachedRes;
          if (req.mode === 'navigate') {
            return caches.match('./index.html');
          }
        });
      })
  );
});
