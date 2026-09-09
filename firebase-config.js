/**
 * firebase-config.js
 * Módulo de gestión y conexión con Firebase Realtime Database / Firestore.
 * Con soporte dual: SDK oficial de Firebase y REST API nativa HTTPS (ideal para Zscaler y GitHub Pages).
 */

// Configuración por defecto vinculada a tu proyecto:
const DEFAULT_FIREBASE_CONFIG = {
  apiKey: "", // Opcional si usas REST API con reglas de base de datos activas
  authDomain: "ofiobd.firebaseapp.com",
  databaseURL: "https://ofiobd-default-rtdb.firebaseio.com",
  projectId: "ofiobd",
  storageBucket: "ofiobd.appspot.com",
  messagingSenderId: "",
  appId: "",
  dbType: "rtdb" // "rtdb" para Realtime Database (recomendado) o "firestore"
};

const STORAGE_KEY = 'obd_firebase_config';

/**
 * Obtiene la configuración activa (prioriza localStorage sobre el valor por defecto).
 */
function getActiveFirebaseConfig() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
      const parsed = JSON.parse(saved);
      return { ...DEFAULT_FIREBASE_CONFIG, ...parsed };
    }
  } catch (e) {
    console.warn('No se pudo leer localStorage:', e);
  }
  return { ...DEFAULT_FIREBASE_CONFIG };
}

/**
 * Guarda la configuración en localStorage.
 */
function saveActiveFirebaseConfig(cfg) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg));
    return true;
  } catch (e) {
    console.error('Error al guardar en localStorage:', e);
    return false;
  }
}

/**
 * Determina si la configuración actual tiene los datos mínimos para operar.
 */
function isFirebaseConfigured() {
  const cfg = getActiveFirebaseConfig();
  return Boolean(cfg.databaseURL || (cfg.apiKey && cfg.projectId));
}

let firebaseInitialized = false;

/**
 * Inicializa la app de Firebase mediante SDK si se dispone de apiKey.
 */
function initFirebase() {
  const cfg = getActiveFirebaseConfig();
  if (!cfg.apiKey || !cfg.projectId) {
    return null;
  }

  if (!cfg.databaseURL && cfg.projectId) {
    cfg.databaseURL = `https://${cfg.projectId}-default-rtdb.firebaseio.com`;
  }

  try {
    if (!firebase.apps.length) {
      firebase.initializeApp(cfg);
    }
    firebaseInitialized = true;
    return firebase;
  } catch (err) {
    console.warn('Advertencia al inicializar SDK Firebase:', err);
    return null;
  }
}

/**
 * Reinicia la conexión a Firebase cuando se cambian credenciales.
 */
async function reinitFirebase(newConfig) {
  saveActiveFirebaseConfig(newConfig);
  if (typeof firebase !== 'undefined' && firebase.apps && firebase.apps.length) {
    await Promise.all(firebase.apps.map(app => app.delete()));
  }
  firebaseInitialized = false;
  return initFirebase();
}

/**
 * Limpia la URL de Realtime Database (elimina barras finales).
 */
function getNormalizedRtdbUrl(url) {
  return (url || 'https://ofiobd-default-rtdb.firebaseio.com').trim().replace(/\/+$/, '');
}

/**
 * Sanitiza las claves de un objeto para Firebase Realtime Database.
 * Firebase prohíbe explícitamente los caracteres: . $ # [ ] / en las claves.
 * Por ejemplo: "Fe.contabilización" se transforma en "Fe_contabilización".
 */
function sanitizeRecordForFirebase(record) {
  const clean = {};
  for (const key in record) {
    if (!key.startsWith('__')) {
      const safeKey = key.replace(/[.#$\[\]\/]/g, '_');
      clean[safeKey] = record[key] !== undefined && record[key] !== null ? String(record[key]) : '';
    }
  }
  return clean;
}

/**
 * Restaura las claves originales provenientes de Firebase para mantener
 * compatibilidad total con los filtros y nombres de columnas de la web.
 */
function desanitizeRecordFromFirebase(record) {
  if (!record || typeof record !== 'object') return record;
  const original = {};
  for (const key in record) {
    if (key === 'Fe_contabilización' || key === 'Fe_contabilizacion') {
      original['Fe.contabilización'] = record[key];
    } else {
      original[key] = record[key];
    }
  }
  // Garantizar que la propiedad canónica exista siempre
  if (!original['Fe.contabilización'] && (record['Fe_contabilización'] || record['Fe_contabilizacion'])) {
    original['Fe.contabilización'] = record['Fe_contabilización'] || record['Fe_contabilizacion'];
  }
  return original;
}

/**
 * Guarda datos en Firebase reemplazando TODO lo anterior.
 * Funciona mediante SDK si hay apiKey o mediante REST API HTTPS directa de Firebase.
 * @param {Array} records - Lista de objetos de filas
 */
async function saveToFirebase(records) {
  if (!records || !Array.isArray(records) || records.length === 0) {
    throw new Error('No hay registros válidos para guardar.');
  }

  const cfg = getActiveFirebaseConfig();
  
  // Sanitizar claves prohibidas por Firebase (como el punto en "Fe.contabilización")
  const cleanRecords = records.map(sanitizeRecordForFirebase);

  const metadata = {
    updatedAt: new Date().toISOString(),
    count: cleanRecords.length,
    updatedFrom: window.location.hostname || 'local'
  };

  // 1) Si está en modo Firestore y hay SDK configurado:
  if (cfg.dbType === 'firestore' && cfg.apiKey) {
    const app = initFirebase();
    if (!app) throw new Error('Se requiere apiKey y projectId para Firestore.');
    const db = firebase.firestore();
    const docRef = db.collection('obd_data').doc('current');
    await docRef.set({ meta: metadata, records: cleanRecords });
    return { success: true, count: cleanRecords.length, type: 'firestore' };
  }

  // 2) Si hay SDK disponible para Realtime Database con apiKey:
  if (cfg.apiKey && typeof firebase !== 'undefined') {
    try {
      const app = initFirebase();
      if (app) {
        const db = firebase.database();
        await db.ref('obd_data').set(cleanRecords);
        await db.ref('obd_meta').set(metadata);
        return { success: true, count: cleanRecords.length, type: 'rtdb-sdk' };
      }
    } catch (e) {
      console.warn('Fallo guardado por SDK, intentando REST API de respaldo:', e);
    }
  }

  // 3) REST API Nativa de Firebase Realtime Database (100% HTTPS por puerto 443 - Sin bloqueos de Zscaler)
  const baseUrl = getNormalizedRtdbUrl(cfg.databaseURL);
  
  // Guardar datos (PUT reemplaza completamente el nodo obd_data)
  const dataRes = await fetch(`${baseUrl}/obd_data.json`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(cleanRecords)
  });

  if (!dataRes.ok) {
    const errText = await dataRes.text();
    throw new Error(`Error en Realtime Database (${dataRes.status}): ${errText || 'Revisa las reglas de seguridad (.write) en tu consola de Firebase'}`);
  }

  // Guardar metadatos
  await fetch(`${baseUrl}/obd_meta.json`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(metadata)
  }).catch(e => console.warn('No se pudo guardar obd_meta:', e));

  return { success: true, count: cleanRecords.length, type: 'rtdb-rest' };
}

/**
 * Lee los datos guardados en Firebase.
 */
async function loadFromFirebase() {
  if (!isFirebaseConfigured()) {
    return null;
  }

  const cfg = getActiveFirebaseConfig();

  // 1) Si está en modo Firestore:
  if (cfg.dbType === 'firestore' && cfg.apiKey) {
    const app = initFirebase();
    if (app) {
      const db = firebase.firestore();
      const snap = await db.collection('obd_data').doc('current').get();
      if (snap.exists) {
        const data = snap.data();
        const rawRecords = Array.isArray(data.records) ? data.records : [];
        return {
          records: rawRecords.map(desanitizeRecordFromFirebase),
          meta: data.meta || {}
        };
      }
    }
  }

  // 2) Si hay SDK disponible con apiKey:
  if (cfg.apiKey && typeof firebase !== 'undefined') {
    try {
      const app = initFirebase();
      if (app) {
        const db = firebase.database();
        const snap = await db.ref('obd_data').once('value');
        const val = snap.val();
        if (val) {
          const metaSnap = await db.ref('obd_meta').once('value');
          const meta = metaSnap.val() || {};
          let rawList = [];
          if (Array.isArray(val)) {
            rawList = val.filter(Boolean);
          } else if (typeof val === 'object') {
            rawList = Object.values(val);
          }
          return { records: rawList.map(desanitizeRecordFromFirebase), meta };
        }
      }
    } catch (e) {
      console.warn('Fallo lectura por SDK, intentando REST API:', e);
    }
  }

  // 3) REST API Nativa de Firebase Realtime Database (HTTPS simple)
  try {
    const baseUrl = getNormalizedRtdbUrl(cfg.databaseURL);
    const res = await fetch(`${baseUrl}/obd_data.json?t=${Date.now()}`);
    if (!res.ok) return null;

    const val = await res.json();
    if (!val) return null;

    let meta = {};
    try {
      const metaRes = await fetch(`${baseUrl}/obd_meta.json?t=${Date.now()}`);
      if (metaRes.ok) {
        meta = (await metaRes.json()) || {};
      }
    } catch (e) {}

    let rawList = [];
    if (Array.isArray(val)) {
      rawList = val.filter(Boolean);
    } else if (typeof val === 'object') {
      rawList = Object.values(val);
    }

    return { records: rawList.map(desanitizeRecordFromFirebase), meta };
  } catch (err) {
    console.warn('Error al leer desde REST API de Firebase:', err);
    return null;
  }
}

/**
 * Prueba la conexión con Firebase.
 */
async function testFirebaseConnection(configToTest) {
  const currentCfg = getActiveFirebaseConfig();
  const testCfg = configToTest || currentCfg;

  const baseUrl = getNormalizedRtdbUrl(testCfg.databaseURL);

  try {
    if (testCfg.apiKey && typeof firebase !== 'undefined') {
      let testApp;
      try {
        testApp = firebase.app('testConnectionApp');
        await testApp.delete();
      } catch (e) {}

      testApp = firebase.initializeApp(testCfg, 'testConnectionApp');
      if (testCfg.dbType === 'firestore') {
        const db = testApp.firestore();
        await db.collection('obd_data').doc('connection_test').get();
      } else {
        const db = testApp.database();
        await db.ref('obd_meta').once('value');
      }
      await testApp.delete();
      return { success: true, message: '¡Conexión exitosa a Firebase por SDK!' };
    }

    const res = await fetch(`${baseUrl}/obd_meta.json?t=${Date.now()}`);
    if (res.ok) {
      return { success: true, message: `¡Conexión exitosa a Realtime Database (${baseUrl})!` };
    } else {
      const msg = await res.text();
      return { success: false, message: `Error HTTP ${res.status}: ${msg || 'Verifica las reglas de seguridad (.read/.write) en Firebase'}` };
    }
  } catch (err) {
    return {
      success: false,
      message: `Error al conectar: ${err.message || 'Verifica tu conexión a internet o la URL de Firebase'}`
    };
  }
}
