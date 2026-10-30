/*
 * script.js
 *
 * Gestión de datos OBD con sincronización en Firebase.
 * Prioridad de carga:
 *   1) Firebase (Realtime Database o Firestore) -> datos persistentes actualizados por los usuarios.
 *   2) Google Sheets (API gviz).
 *   3) Archivo Excel local (OBD.xlsx).
 *
 * Modos de actualización de datos:
 *   - Pegar directamente desde Excel (Ctrl+C en Excel -> Ctrl+V en la web).
 *   - Subir archivo Excel (.xlsx, .xls, .csv).
 *   - Al guardar en Firebase, se elimina el lote de datos anterior y se guarda el nuevo.
 */

// -------------------- Estado Global --------------------
let dataset = [];
let pendingUploadRecords = [];
let currentFilteredData = [];
let currentSortColumn = null;
let currentSortDirection = 'asc';
let activeSearchTerms = [];

// ID del documento y GID de Google Sheets (usado como respaldo si Firebase no está activo)
const GOOGLE_SHEET_ID  = '1rfE4dFe5cHtQMIc4mt-Lx-QmdVjMsKcR';
const GOOGLE_SHEET_GID = '0';

// -------------------- Utilidades de Formato, Texto y Búsqueda --------------------
function escapeHtml(str) {
  return String(str)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/**
 * Normaliza un texto para búsqueda:
 * - Insensible a acentos/diacríticos (Café -> cafe, Azúcar -> azucar)
 * - En minúsculas y sin espacios residuales
 */
function normalizeSearchText(str) {
  if (str == null) return '';
  return String(str)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

/**
 * Parsea un valor numérico tolerando separadores de miles y decimales comunes:
 * ejemplos: "1,500", "1,500.00", "1.500,00", "1500", "-250.50"
 */
function parseNumericValue(val) {
  if (val == null || val === '') return null;
  const s = String(val).trim().replace(/\s+/g, '');
  let clean = s;
  if (/^[\-\+]?[\d,]+(\.\d+)?$/.test(clean) && clean.includes(',')) {
    clean = clean.replace(/,/g, '');
  } else if (/^[\-\+]?[\d\.]+(,\d+)?$/.test(clean) && clean.includes('.')) {
    clean = clean.replace(/\./g, '').replace(',', '.');
  } else if (/^[\-\+]?\d+(,\d+)?$/.test(clean)) {
    clean = clean.replace(',', '.');
  }
  const n = parseFloat(clean);
  return isNaN(n) ? null : n;
}

/**
 * Genera variantes alternativas para permitir que una cantidad pueda encontrarse
 * escribiendo con comas ("1,500"), con puntos ("1.500"), entero directo ("1500"), etc.
 */
function getNumericSearchAliases(val) {
  const aliases = new Set();
  if (val == null || val === '') return [];
  const rawStr = String(val).trim();
  const num = parseNumericValue(rawStr);
  if (num !== null) {
    const absNum = Math.abs(num);
    const intPart = Math.floor(absNum).toString();
    const fixed2 = absNum.toFixed(2);
    
    aliases.add(String(absNum));
    aliases.add(intPart);
    aliases.add(fixed2);
    aliases.add(fixed2.replace('.', ','));

    const enThousands = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    const esThousands = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
    aliases.add(enThousands);
    aliases.add(esThousands);

    const decPart = fixed2.split('.')[1];
    aliases.add(enThousands + '.' + decPart);
    aliases.add(esThousands + ',' + decPart);
  }
  return Array.from(aliases);
}

/**
 * Construye una expresión regular tolerante a acentos para resaltar coincidencias
 */
function makeDiacriticRegexPattern(term) {
  const norm = normalizeSearchText(term);
  const escaped = norm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return escaped
    .replace(/a/g, '[aáàäâAÁÀÄÂ]')
    .replace(/e/g, '[eéèëêEÉÈËÊ]')
    .replace(/i/g, '[iíìïîIÍÌÏÎ]')
    .replace(/o/g, '[oóòöôOÓÒÖÔ]')
    .replace(/u/g, '[uúùüûUÚÙÜÛ]')
    .replace(/n/g, '[nñNÑ]');
}

/**
 * Resalta en amarillo las coincidencias encontradas dentro de una celda
 */
function highlightMatches(text, terms) {
  if (!text) return '';
  const str = String(text);
  if (!terms || terms.length === 0) return escapeHtml(str);

  const patterns = [];
  for (const t of terms) {
    if (!t || t.length < 1) continue;
    patterns.push(makeDiacriticRegexPattern(t));
    const stripped = t.replace(/[,\.]/g, '');
    if (stripped && stripped !== t && stripped.length >= 2) {
      patterns.push(makeDiacriticRegexPattern(stripped));
    }
  }

  if (patterns.length === 0) return escapeHtml(str);

  try {
    const regex = new RegExp(`(${patterns.join('|')})`, 'gi');
    return escapeHtml(str).replace(regex, '<mark class="search-match">$1</mark>');
  } catch (e) {
    return escapeHtml(str);
  }
}

/**
 * Normaliza múltiples formatos de fecha a ISO "YYYY-MM-DD".
 */
function toISODate(val) {
  if (val == null || val === '') return '';

  // gviz Date(YYYY,MM,DD[,hh,mm,ss])
  if (typeof val === 'string' && /^Date\(/.test(val)) {
    const m = val.match(/^Date\((\d+),(\d+),(\d+)(?:,(\d+),(\d+),(\d+))?\)$/);
    if (m) {
      const [, y, mo, d, hh='0', mi='0', ss='0'] = m;
      const dt = new Date(Date.UTC(+y, +mo, +d, +hh, +mi, +ss));
      return dt.toISOString().slice(0, 10);
    }
  }

  // "DD/MM/YYYY" o "DD-MM-YYYY"
  if (typeof val === 'string') {
    const cleanStr = val.trim();
    let m = cleanStr.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
    if (m) {
      const [, dd, mm, yyyy] = m;
      const d2 = String(dd).padStart(2, '0');
      const m2 = String(mm).padStart(2, '0');
      return `${yyyy}-${m2}-${d2}`;
    }
    // "YYYY-MM-DD"
    if (/^\d{4}-\d{2}-\d{2}$/.test(cleanStr)) return cleanStr;
  }

  // Serial numérico de Excel
  if (typeof val === 'number') {
    const ms = Math.round((val - 25569) * 86400 * 1000);
    const dt = new Date(ms);
    if (!isNaN(dt)) return dt.toISOString().slice(0, 10);
  }

  // Si es un objeto Date
  if (val instanceof Date && !isNaN(val)) {
    return val.toISOString().slice(0, 10);
  }

  // Intento de parseo estándar
  const dt = new Date(val);
  if (!isNaN(dt) && dt.getFullYear() > 1990) {
    return dt.toISOString().slice(0, 10);
  }

  return '';
}

/**
 * Visualización amigable "DD/MM/YYYY".
 */
function formatDateDisplay(val) {
  const iso = toISODate(val);
  if (!iso) return String(val || '');
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
}

function debounce(fn, wait = 150) {
  let t; 
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), wait); };
}

/**
 * Prepara campos auxiliares en el dataset para agilizar los filtros y búsquedas inteligentes.
 */
function prepareDataset() {
  dataset = dataset.map(row => {
    const rawFecha = row['Fe.contabilización'] || row['Fe_contabilización'] || row['Fe_contabilizacion'] || '';
    const fechaISO = toISODate(rawFecha);
    const loteRaw  = row['Lote'] ?? '';
    const cantVal  = parseNumericValue(row['Cantidad']);

    // Construcción del corpus de búsqueda enriquecido:
    // Incluye campos base, variantes numéricas (con y sin comas/puntos) y sin tildes.
    const baseFields = [
      row['Centro'],
      row['Nombre 1'],
      rawFecha,
      loteRaw,
      row['Referencia'],
      row['Cantidad'],
      row['Texto breve de material']
    ];
    const numAliases = getNumericSearchAliases(row['Cantidad']);
    const corpusText = [...baseFields, ...numAliases].filter(Boolean).join(' ');
    const searchCorpus = normalizeSearchText(corpusText);

    return {
      ...row,
      'Fe.contabilización': rawFecha,
      __fechaISO: fechaISO,
      __loteUC: normalizeSearchText(loteRaw).toUpperCase(),
      __searchCorpus: searchCorpus,
      __numericCantidad: cantVal
    };
  });
}

// -------------------- Carga de Datos Principal y Gestión de Caché --------------------
let currentDatasetUpdatedAt = null;

/**
 * Notificación emergente flotante en pantalla
 */
function showToast(message, duration = 3200) {
  const toast = document.getElementById('toast-notification');
  if (!toast) return;
  toast.textContent = message;
  toast.style.display = 'flex';
  void toast.offsetWidth; // Forzar reflujo para transición CSS
  toast.classList.add('show');

  if (toast.__timer) clearTimeout(toast.__timer);
  toast.__timer = setTimeout(() => {
    toast.classList.remove('show');
    setTimeout(() => {
      if (!toast.classList.contains('show')) toast.style.display = 'none';
    }, 300);
  }, duration);
}

/**
 * Limpia totalmente la caché del navegador / Service Worker y recarga los datos frescos
 */
async function purgeAppCacheAndRefresh(userInitiated = true) {
  const btnRefresh = document.getElementById('btn-refresh-data');
  if (btnRefresh) {
    btnRefresh.classList.add('spinning');
    btnRefresh.disabled = true;
  }
  if (userInitiated) {
    setSourceBadge('🔄 Limpiando caché y recargando...', 'loading');
  }

  try {
    // 1. Limpiar toda la CacheStorage de la PWA
    if ('caches' in window) {
      try {
        const cacheKeys = await caches.keys();
        await Promise.all(cacheKeys.map(k => caches.delete(k)));
      } catch (e) {
        console.warn('Aviso limpiando CacheStorage:', e);
      }
    }

    // 2. Notificar al Service Worker para purga forzada y actualización
    if ('serviceWorker' in navigator) {
      try {
        const registrations = await navigator.serviceWorker.getRegistrations();
        for (const reg of registrations) {
          await reg.update();
          if (reg.active) {
            reg.active.postMessage({ action: 'clean-cache' });
          }
        }
      } catch (e) {
        console.warn('Aviso actualizando Service Worker:', e);
      }
    }

    // 3. Recargar datos con bypass total de caché de red
    await loadDataset(true);

    if (userInitiated) {
      showToast('✅ Caché eliminada. Datos actualizados con éxito.');
    }
  } catch (err) {
    console.error('Error al actualizar datos y caché:', err);
    if (userInitiated) {
      showToast('⚠️ Actualizado con avisos: ' + (err.message || err));
    }
  } finally {
    if (btnRefresh) {
      setTimeout(() => {
        btnRefresh.classList.remove('spinning');
        btnRefresh.disabled = false;
      }, 500);
    }
  }
}

/**
 * Comprobación ultraligera en segundo plano para actualizar si se detectan datos nuevos
 */
async function checkBackgroundUpdates() {
  if (typeof checkRemoteFirebaseMetadata !== 'function') return;
  try {
    const meta = await checkRemoteFirebaseMetadata();
    if (meta && meta.updatedAt && currentDatasetUpdatedAt) {
      if (meta.updatedAt !== currentDatasetUpdatedAt) {
        console.log('Detectada nueva versión remota:', meta.updatedAt);
        await purgeAppCacheAndRefresh(false);
        showToast('🔄 Se han sincronizado los datos más recientes automáticamente');
      }
    }
  } catch (e) {
    // Silencioso en background
  }
}

async function loadDataset(forceFresh = false) {
  setSourceBadge('Cargando...', 'loading');

  // 1) Intentar leer desde Firebase (primera prioridad)
  if (typeof loadFromFirebase === 'function' && isFirebaseConfigured()) {
    try {
      const fbResult = await loadFromFirebase();
      if (fbResult && Array.isArray(fbResult.records) && fbResult.records.length > 0) {
        dataset = fbResult.records;
        currentDatasetUpdatedAt = fbResult.meta?.updatedAt || null;
        prepareDataset();
        initPage();
        
        let dateStr = '';
        if (fbResult.meta && fbResult.meta.updatedAt) {
          const d = new Date(fbResult.meta.updatedAt);
          dateStr = ` (Actualizado: ${d.toLocaleDateString()} ${d.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})})`;
        }
        setSourceBadge(`🟢 Firebase: ${dataset.length} registros${dateStr}`, 'firebase');
        updateSyncTime(fbResult.meta?.updatedAt);
        return;
      }
    } catch (err) {
      console.warn('No se pudo cargar desde Firebase, usando fallback:', err);
    }
  }

  // 2) Intentar Google Sheets (gviz JSON con cache-busting)
  if (GOOGLE_SHEET_ID) {
    try {
      const gvizUrl = `https://docs.google.com/spreadsheets/d/${GOOGLE_SHEET_ID}/gviz/tq?gid=${GOOGLE_SHEET_GID}&tqx=out:json&t=${Date.now()}`;
      const res = await fetch(gvizUrl, { cache: 'no-store' });
      if (res.ok) {
        const text = await res.text();
        const jsonStr = text.substring(text.indexOf('{'), text.lastIndexOf('}') + 1);
        const gvizData = JSON.parse(jsonStr);

        const cols = gvizData.table.cols.map(c => c.label || c.id || '');
        const rows = gvizData.table.rows || [];

        dataset = rows.map(r => {
          const obj = {};
          cols.forEach((label, i) => {
            const cell = r.c?.[i];
            let v = cell ? (cell.f ?? cell.v) : '';
            obj[label] = v ?? '';
          });
          return obj;
        });

        if (dataset.length > 0) {
          currentDatasetUpdatedAt = new Date().toISOString();
          prepareDataset();
          initPage();
          setSourceBadge(`🟡 Google Sheets: ${dataset.length} registros`, 'sheets');
          return;
        }
      }
    } catch (err) {
      console.warn('Fallo al cargar Google Sheets, usando Excel local:', err);
    }
  }

  // 3) Fallback: archivo Excel local (OBD.xlsx) con bypass estricto de caché
  try {
    const res = await fetch(`OBD.xlsx?t=${Date.now()}`, {
      cache: 'no-store',
      headers: { 'Cache-Control': 'no-cache, no-store, must-revalidate', 'Pragma': 'no-cache' }
    });
    if (res.ok) {
      const ab  = await res.arrayBuffer();
      const wb  = XLSX.read(ab, { type: 'array' });
      const sh  = wb.SheetNames[0];
      dataset   = XLSX.utils.sheet_to_json(wb.Sheets[sh], { defval: '' });

      currentDatasetUpdatedAt = new Date().toISOString();
      prepareDataset();
      initPage();
      setSourceBadge(`⚪ Excel Local: ${dataset.length} registros`, 'local');
      return;
    }
  } catch (err) {
    console.error('Error al cargar el Excel local:', err);
  }

  // Si no hay datos disponibles
  setSourceBadge('⚠️ Sin datos cargados (Usa "Cargar / Pegar Excel")', 'empty');
  initPage();
}

function setSourceBadge(text, type) {
  const badge = document.getElementById('data-source-badge');
  if (!badge) return;
  badge.textContent = text;
  badge.className = `badge-source badge-${type}`;
}

function updateSyncTime(isoDateStr) {
  const el = document.getElementById('last-sync-time');
  if (!el) return;
  if (!isoDateStr) {
    el.textContent = '';
    return;
  }
  try {
    const dt = new Date(isoDateStr);
    el.textContent = `Última sincronización: ${dt.toLocaleDateString()} ${dt.toLocaleTimeString()}`;
  } catch (e) {
    el.textContent = '';
  }
}

// -------------------- Normalización y Parseo de Columnas --------------------
const CANONICAL_COLUMNS = [
  'Centro',
  'Nombre 1',
  'Fe.contabilización',
  'Lote',
  'Referencia',
  'Cantidad',
  'Texto breve de material'
];

const KNOWN_HEADERS = {
  'Centro': ['centro', 'planta', 'ce', 'almacen'],
  'Nombre 1': ['nombre 1', 'nombre1', 'acopio', 'nombre de acopio', 'nombre'],
  'Fe.contabilización': [
    'fe.contabilizacion', 'fe.contabilización', 'fe.contab', 'fe.contab.',
    'fecha', 'fecha contabilizacion', 'fecha de contabilizacion', 'fechacontabilizacion', 'fe. contabilizacion'
  ],
  'Lote': ['lote', 'batch', 'lote sap'],
  'Referencia': ['referencia', 'ref', 'ref.', 'referencia sap', 'nro referencia'],
  'Cantidad': ['cantidad', 'cant', 'cant.', 'ctd', 'cantidad base'],
  'Texto breve de material': [
    'texto breve de material', 'texto breve material', 'material',
    'descripcion', 'descripcion material', 'texto breve'
  ]
};

/**
 * Normaliza nombres de encabezados para reconocer variaciones comunes
 */
function normalizeHeaderName(rawHeader) {
  if (!rawHeader) return '';
  const s = String(rawHeader).trim().toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[._\-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // Si tiene formato de fecha o es numérico, es un dato
  if (/^\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}$/.test(s) || /^\d+$/.test(s)) {
    return '';
  }

  for (const [canonical, aliases] of Object.entries(KNOWN_HEADERS)) {
    for (const alias of aliases) {
      if (s === alias) {
        return canonical;
      }
    }
  }

  return '';
}

/**
 * Parsea texto pegado desde Excel (delimitado por tabulador \t o punto y coma/coma).
 */
function parsePastedExcelText(rawText) {
  if (!rawText || !rawText.trim()) return [];

  const lines = rawText.split(/\r?\n/).map(l => l.trimEnd()).filter(l => l.length > 0);
  if (lines.length === 0) return [];

  // Detectar delimitador preferente (tabulador por defecto al copiar celdas de Excel)
  const firstLine = lines[0];
  let delimiter = '\t';
  if (!firstLine.includes('\t')) {
    if (firstLine.includes(';') && (firstLine.match(/;/g) || []).length >= 4) {
      delimiter = ';';
    } else if (firstLine.includes(',') && (firstLine.match(/,/g) || []).length >= 4) {
      delimiter = ',';
    }
  }

  const firstTokens = firstLine.split(delimiter).map(t => t.trim());
  const matchedHeaders = firstTokens.map(normalizeHeaderName);
  const recognizedCount = matchedHeaders.filter(h => CANONICAL_COLUMNS.includes(h)).length;
  const hasHeaderRow = recognizedCount >= 3;

  let headers = [];
  let dataLines = [];

  if (hasHeaderRow) {
    headers = matchedHeaders;
    dataLines = lines.slice(1);
  } else {
    // Si no trae encabezados, mapear posicionalmente a las 7 columnas canónicas
    headers = CANONICAL_COLUMNS;
    dataLines = lines;
  }

  const records = [];
  for (const line of dataLines) {
    const tokens = line.split(delimiter).map(t => t.trim().replace(/^["']|["']$/g, ''));
    if (tokens.every(t => t === '')) continue; // línea vacía

    const rowObj = {
      'Centro': '',
      'Nombre 1': '',
      'Fe.contabilización': '',
      'Lote': '',
      'Referencia': '',
      'Cantidad': '',
      'Texto breve de material': ''
    };

    tokens.forEach((val, idx) => {
      const colName = headers[idx] || CANONICAL_COLUMNS[idx];
      if (colName && CANONICAL_COLUMNS.includes(colName)) {
        rowObj[colName] = val;
      }
    });

    // Formatear/normalizar fecha si es necesario
    if (rowObj['Fe.contabilización']) {
      const iso = toISODate(rowObj['Fe.contabilización']);
      if (iso) {
        rowObj['Fe.contabilización'] = formatDateDisplay(iso);
      }
    }

    records.push(rowObj);
  }

  return records;
}

/**
 * Parsea un archivo Excel (.xlsx / .xls) o CSV usando SheetJS.
 */
function parseExcelWorkbook(workbook) {
  const firstSheetName = workbook.SheetNames[0];
  const worksheet = workbook.Sheets[firstSheetName];
  
  const rawRows = XLSX.utils.sheet_to_json(worksheet, { header: 1, defval: '', raw: false });
  if (!rawRows || rawRows.length === 0) return [];

  let headerRowIndex = 0;
  let headers = [];

  for (let r = 0; r < Math.min(rawRows.length, 5); r++) {
    const candidateHeaders = rawRows[r].map(c => normalizeHeaderName(String(c)));
    const matchCount = candidateHeaders.filter(h => CANONICAL_COLUMNS.includes(h)).length;
    if (matchCount >= 3) {
      headerRowIndex = r;
      headers = candidateHeaders;
      break;
    }
  }

  if (headers.length === 0) {
    headerRowIndex = -1;
    headers = CANONICAL_COLUMNS;
  }

  const records = [];
  const startRow = headerRowIndex + 1;

  for (let r = startRow; r < rawRows.length; r++) {
    const row = rawRows[r];
    if (!row || row.every(c => c === '' || c == null)) continue;

    const rowObj = {
      'Centro': '',
      'Nombre 1': '',
      'Fe.contabilización': '',
      'Lote': '',
      'Referencia': '',
      'Cantidad': '',
      'Texto breve de material': ''
    };

    row.forEach((cellVal, colIdx) => {
      const colName = headers[colIdx] || CANONICAL_COLUMNS[colIdx];
      if (colName && CANONICAL_COLUMNS.includes(colName)) {
        rowObj[colName] = String(cellVal ?? '').trim();
      }
    });

    if (rowObj['Fe.contabilización']) {
      const iso = toISODate(rowObj['Fe.contabilización']);
      if (iso) {
        rowObj['Fe.contabilización'] = formatDateDisplay(iso);
      }
    }

    records.push(rowObj);
  }

  return records;
}

// -------------------- Previsualización y Guardado en Firebase --------------------
function showPreview(records) {
  pendingUploadRecords = records;
  const container = document.getElementById('preview-container');
  const countBadge = document.getElementById('preview-count');
  const tbody = document.getElementById('preview-table-body');
  const note = document.getElementById('preview-note');
  const alertBox = document.getElementById('preview-alert');

  if (!container || !countBadge || !tbody) return;

  if (!records || records.length === 0) {
    alert('No se detectaron registros válidos en los datos proporcionados.');
    container.style.display = 'none';
    return;
  }

  countBadge.textContent = `${records.length} registros listos`;
  tbody.innerHTML = '';

  const sampleRows = records.slice(0, 8);
  sampleRows.forEach((row, idx) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${idx + 1}</td>
      <td>${escapeHtml(row['Centro'] || '')}</td>
      <td>${escapeHtml(row['Nombre 1'] || '')}</td>
      <td>${escapeHtml(row['Fe.contabilización'] || '')}</td>
      <td><strong>${escapeHtml(row['Lote'] || '')}</strong></td>
      <td><code>${escapeHtml(row['Referencia'] || '')}</code></td>
      <td>${escapeHtml(row['Cantidad'] || '')}</td>
      <td>${escapeHtml(row['Texto breve de material'] || '')}</td>
    `;
    tbody.appendChild(tr);
  });

  if (records.length > 8) {
    note.textContent = `Mostrando 8 de ${records.length} registros. Al guardar se sincronizarán todos los registros.`;
  } else {
    note.textContent = `Mostrando la totalidad de los ${records.length} registros a guardar.`;
  }

  if (!isFirebaseConfigured()) {
    alertBox.style.display = 'block';
    alertBox.className = 'alert-box alert-warning';
    alertBox.innerHTML = `⚠️ <strong>Firebase aún no está configurado.</strong> Haz clic en <a href="#" id="link-open-config-alert">⚙️ Config Firebase</a> para ingresar tus credenciales antes de guardar.`;
    
    document.getElementById('link-open-config-alert')?.addEventListener('click', (e) => {
      e.preventDefault();
      openAuthModal();
    });
  } else {
    alertBox.style.display = 'none';
  }

  container.style.display = 'block';
  container.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function handleSaveToFirebase() {
  if (!pendingUploadRecords || pendingUploadRecords.length === 0) {
    alert('No hay registros preparados para guardar.');
    return;
  }

  if (!isFirebaseConfigured()) {
    openAuthModal();
    alert('Por favor ingresa tus credenciales de Firebase para poder guardar.');
    return;
  }

  const count = pendingUploadRecords.length;
  const confirmed = confirm(
    `¿Confirmas el guardado en Firebase?\n\nEsta acción BORRARÁ los registros anteriores en la base de datos y guardará los ${count} nuevos registros.`
  );
  if (!confirmed) return;

  const btnSave = document.getElementById('btn-save-firebase');
  const statusDiv = document.getElementById('save-status');

  if (btnSave) {
    btnSave.disabled = true;
    btnSave.textContent = '⏳ Guardando en Firebase...';
  }
  if (statusDiv) {
    statusDiv.style.display = 'block';
    statusDiv.className = 'save-status-msg status-loading';
    statusDiv.textContent = 'Reemplazando datos en Firebase, por favor espera...';
  }

  try {
    const result = await saveToFirebase(pendingUploadRecords);
    
    dataset = [...pendingUploadRecords];
    prepareDataset();
    initPage();

    setSourceBadge(`🟢 Firebase: ${dataset.length} registros (Actualizado)`, 'firebase');
    updateSyncTime(new Date().toISOString());

    if (statusDiv) {
      statusDiv.className = 'save-status-msg status-success';
      statusDiv.textContent = `✅ ¡Guardado exitoso! Se guardaron ${result.count} registros en Firebase. Se eliminaron los datos anteriores.`;
    }

    const pasteInput = document.getElementById('paste-input');
    if (pasteInput) pasteInput.value = '';
    const fileTag = document.getElementById('selected-file-name');
    if (fileTag) fileTag.textContent = '';

    setTimeout(() => {
      switchView('table');
      if (btnSave) {
        btnSave.disabled = false;
        btnSave.textContent = '🗑️ Borrar anteriores y Guardar en Firebase';
      }
      document.getElementById('preview-container').style.display = 'none';
      if (statusDiv) statusDiv.style.display = 'none';
    }, 1800);

  } catch (err) {
    console.error('Error al guardar en Firebase:', err);
    if (statusDiv) {
      statusDiv.className = 'save-status-msg status-error';
      statusDiv.textContent = `❌ Error al guardar en Firebase: ${err.message || err}`;
    }
    if (btnSave) {
      btnSave.disabled = false;
      btnSave.textContent = '🗑️ Borrar anteriores y Guardar en Firebase';
    }
  }
}

// -------------------- Inicialización UI de Filtros y Tabla --------------------
function initPage() {
  populateFilters();
  applyFilters();

  const centroSelect   = document.getElementById('filter-centro');
  const nombreSelect   = document.getElementById('filter-nombre');
  const fechaInput     = document.getElementById('filter-fecha');
  const materialSelect = document.getElementById('filter-material');
  const loteInput      = document.getElementById('filter-lote');
  const clearBtn       = document.getElementById('clear-filters');
  const btnExport      = document.getElementById('btn-export-excel');

  const debouncedApply = debounce(applyFilters, 150);

  if (centroSelect)   centroSelect.onchange = debouncedApply;
  if (nombreSelect)   nombreSelect.onchange = debouncedApply;
  if (fechaInput)     fechaInput.onchange = debouncedApply;
  if (materialSelect) materialSelect.onchange = debouncedApply;
  if (loteInput) {
    loteInput.oninput = function () {
      this.value = this.value.toUpperCase();
      debouncedApply();
    };
  }

  // Ordenamiento interactivo por columnas
  const headers = document.querySelectorAll('#data-table thead th.sortable');
  headers.forEach(th => {
    th.onclick = function () {
      const col = this.dataset.col;
      if (!col) return;
      if (currentSortColumn === col) {
        currentSortDirection = currentSortDirection === 'asc' ? 'desc' : 'asc';
      } else {
        currentSortColumn = col;
        currentSortDirection = 'asc';
      }
      updateSortHeaderIcons();
      applyFilters();
    };
  });

  // Exportar registros filtrados a Excel
  if (btnExport) {
    btnExport.onclick = exportToExcel;
  }

  if (clearBtn) {
    clearBtn.onclick = function () {
      if (centroSelect)   centroSelect.value = '';
      if (nombreSelect)   nombreSelect.value = '';
      if (fechaInput)     fechaInput.value = '';
      if (materialSelect) materialSelect.value = '';
      if (loteInput)      loteInput.value = '';
      const globalSearch = document.getElementById('global-search');
      if (globalSearch) globalSearch.value = '';
      
      currentSortColumn = null;
      currentSortDirection = 'asc';
      updateSortHeaderIcons();
      applyFilters();
    };
  }

  const tbody = document.getElementById('table-body');
  if (tbody && !tbody.__hasCopyListener) {
    tbody.__hasCopyListener = true;
    tbody.addEventListener('click', async (e) => {
      const btn = e.target.closest('button.copy-ref');
      if (!btn) return;
      const refVal = btn.dataset.ref || '';
      try {
        if (navigator.clipboard && window.isSecureContext) {
          await navigator.clipboard.writeText(refVal);
        } else {
          const ta = document.createElement('textarea');
          ta.value = refVal;
          ta.style.position = 'fixed';
          ta.style.left = '-9999px';
          document.body.appendChild(ta);
          ta.focus();
          ta.select();
          document.execCommand('copy');
          ta.remove();
        }
        const original = btn.textContent;
        btn.textContent = 'Copiado!';
        btn.disabled = true;
        setTimeout(() => { btn.textContent = original; btn.disabled = false; }, 1200);
      } catch (err) {
        alert('No se pudo copiar. Copia manual: ' + refVal);
      }
    });
  }
}

/**
 * Actualiza los iconos indicadores de ordenamiento (▲, ▼, ⇅) en los encabezados
 */
function updateSortHeaderIcons() {
  const headers = document.querySelectorAll('#data-table thead th.sortable');
  headers.forEach(th => {
    const col = th.dataset.col;
    const icon = th.querySelector('.sort-icon');
    th.classList.remove('sort-asc', 'sort-desc');
    if (col === currentSortColumn) {
      th.classList.add(currentSortDirection === 'asc' ? 'sort-asc' : 'sort-desc');
      if (icon) icon.textContent = currentSortDirection === 'asc' ? '▲' : '▼';
    } else {
      if (icon) icon.textContent = '⇅';
    }
  });
}

function populateFilters() {
  const centroSelect   = document.getElementById('filter-centro');
  const nombreSelect   = document.getElementById('filter-nombre');
  const materialSelect = document.getElementById('filter-material');

  const currentCentro   = centroSelect?.value || '';
  const currentNombre   = nombreSelect?.value || '';
  const currentMaterial = materialSelect?.value || '';

  if (centroSelect) {
    centroSelect.innerHTML = '<option value="">Todos</option>';
    const centros = Array.from(
      new Set(dataset.map(r => r['Centro']).filter(v => v != null && v !== ''))
    ).sort((a, b) => String(a).localeCompare(String(b), undefined, { numeric: true }));
    centros.forEach(c => {
      const opt = document.createElement('option');
      opt.value = c;
      opt.textContent = c;
      if (c === currentCentro) opt.selected = true;
      centroSelect.appendChild(opt);
    });
  }

  if (nombreSelect) {
    nombreSelect.innerHTML = '<option value="">Todos</option>';
    const nombres = Array.from(
      new Set(dataset.map(r => r['Nombre 1']).filter(v => v != null && v !== ''))
    ).sort((a, b) => String(a).localeCompare(String(b), 'es'));
    nombres.forEach(name => {
      const opt = document.createElement('option');
      opt.value = name;
      opt.textContent = name;
      if (name === currentNombre) opt.selected = true;
      nombreSelect.appendChild(opt);
    });
  }

  if (materialSelect) {
    materialSelect.innerHTML = '<option value="">Todos</option>';
    const materiales = Array.from(
      new Set(dataset.map(r => r['Texto breve de material']).filter(v => v != null && v !== ''))
    ).sort((a, b) => String(a).localeCompare(String(b), 'es'));
    materiales.forEach(mat => {
      const opt = document.createElement('option');
      opt.value = mat;
      opt.textContent = mat;
      if (mat === currentMaterial) opt.selected = true;
      materialSelect.appendChild(opt);
    });
  }
}

/**
 * Calcula y muestra el total de la columna Cantidad para los registros filtrados
 */
function updateTotalMetrics(data) {
  const badge = document.getElementById('total-cantidad-badge');
  if (!badge) return;
  if (!data || data.length === 0) {
    badge.style.display = 'none';
    return;
  }
  let sum = 0;
  let countWithNum = 0;
  for (const r of data) {
    if (r.__numericCantidad != null && !isNaN(r.__numericCantidad)) {
      sum += r.__numericCantidad;
      countWithNum++;
    }
  }
  if (countWithNum > 0) {
    badge.style.display = 'inline-flex';
    badge.textContent = `∑ Total Cantidad: ${sum.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  } else {
    badge.style.display = 'none';
  }
}

/**
 * Exporta los registros actualmente visibles/filtrados a un archivo Excel (.xlsx)
 */
function exportToExcel() {
  if (!currentFilteredData || currentFilteredData.length === 0) {
    alert('No hay registros para exportar con los filtros aplicados.');
    return;
  }
  if (typeof XLSX === 'undefined') {
    alert('La librería SheetJS (XLSX) no está disponible en este momento.');
    return;
  }

  const exportRows = currentFilteredData.map(r => ({
    'Centro': r['Centro'] || '',
    'Nombre 1': r['Nombre 1'] || '',
    'Fe.contabilización': formatDateDisplay(r.__fechaISO || r['Fe.contabilización']),
    'Lote': r['Lote'] || '',
    'Referencia': r['Referencia'] || '',
    'Cantidad': r['Cantidad'] || '',
    'Texto breve de material': r['Texto breve de material'] || ''
  }));

  const ws = XLSX.utils.json_to_sheet(exportRows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Registros OBD');

  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10);
  XLSX.writeFile(wb, `OBD_Registros_${dateStr}.xlsx`);
}

// -------------------- Renderizado (por lotes + data-label móvil) --------------------
function renderTable(data, searchTerms = []) {
  const tbody = document.getElementById('table-body');
  if (!tbody) return;

  tbody.innerHTML = '';

  const LABELS = {
    'Centro': 'Centro',
    'Nombre 1': 'Nombre 1',
    'Fe.contabilización': 'Fe.contabilización',
    'Lote': 'Lote',
    'Referencia': 'Referencia',
    'Cantidad': 'Cantidad',
    'Texto breve de material': 'Texto breve de material'
  };

  const BATCH = 200;
  let i = 0;

  function makeTd(label, text, isColNum = false) {
    const td = document.createElement('td');
    td.setAttribute('data-label', label);
    if (isColNum) td.classList.add('col-num');
    td.innerHTML = highlightMatches(text, searchTerms);
    return td;
  }

  function paintChunk() {
    const frag = document.createDocumentFragment();
    const end = Math.min(i + BATCH, data.length);

    for (; i < end; i++) {
      const row = data[i];
      const tr = document.createElement('tr');

      const tdCentro = makeTd(LABELS['Centro'], row['Centro']);
      const tdNombre = makeTd(LABELS['Nombre 1'], row['Nombre 1']);
      const tdFecha  = makeTd(LABELS['Fe.contabilización'], formatDateDisplay(row.__fechaISO || row['Fe.contabilización']));
      const tdLote   = makeTd(LABELS['Lote'], row['Lote']);

      const tdRef = document.createElement('td');
      tdRef.setAttribute('data-label', LABELS['Referencia']);
      const refVal = row['Referencia'] ?? '';
      const span   = document.createElement('span');
      span.innerHTML = highlightMatches(refVal, searchTerms);
      tdRef.appendChild(span);
      if (refVal) {
        const btn = document.createElement('button');
        btn.className = 'copy-ref';
        btn.dataset.ref = refVal;
        btn.title = 'Copiar referencia';
        btn.textContent = '📋';
        btn.style.marginLeft = '6px';
        tdRef.appendChild(btn);
      }

      const tdCant = makeTd(LABELS['Cantidad'], row['Cantidad'], true);
      const tdMat  = makeTd(LABELS['Texto breve de material'], row['Texto breve de material']);

      tr.append(tdCentro, tdNombre, tdFecha, tdLote, tdRef, tdCant, tdMat);
      frag.appendChild(tr);
    }

    tbody.appendChild(frag);
    if (i < data.length) requestAnimationFrame(paintChunk);
  }

  requestAnimationFrame(paintChunk);
  updateRowCount(data.length);
  updateTotalMetrics(data);
}

// -------------------- Filtros y Búsqueda Inteligente --------------------
function applyFilters() {
  const rawGlobalQ = document.getElementById('global-search')?.value || '';
  const centro     = document.getElementById('filter-centro')?.value || '';
  const nombre     = document.getElementById('filter-nombre')?.value || '';
  const fechaISO   = document.getElementById('filter-fecha')?.value || '';
  const material   = document.getElementById('filter-material')?.value || '';
  const rawLoteQ   = (document.getElementById('filter-lote')?.value || '').trim();

  // Controlar botón para limpiar búsqueda rápida
  const clearSearchBtn = document.getElementById('clear-search');
  if (clearSearchBtn) {
    clearSearchBtn.style.display = rawGlobalQ.trim() ? 'block' : 'none';
  }

  let filtered = [...dataset];

  // 1) Búsqueda Global: multi-término, tolerante a tildes y a separadores numéricos (1,500 vs 1500 vs 1.500)
  const normGlobalQ = normalizeSearchText(rawGlobalQ);
  if (normGlobalQ) {
    const rawTerms = rawGlobalQ.trim().split(/\s+/).filter(Boolean);
    activeSearchTerms = rawTerms;
    const terms = normGlobalQ.split(/\s+/).filter(Boolean);

    filtered = filtered.filter(r => {
      const corpus = r.__searchCorpus || '';
      return terms.every(term => {
        // Coincidencia directa en corpus
        if (corpus.includes(term)) return true;

        // Coincidencia eliminando separadores de miles/decimales (ej: usuario escribe 1,500 o 1.500)
        const strippedTerm = term.replace(/[,\.]/g, '');
        if (strippedTerm && corpus.includes(strippedTerm)) return true;

        // Coincidencia eliminando ceros decimales (.00 o ,00)
        const noZeroDec = term.replace(/\.00?$|,00?$/, '');
        if (noZeroDec && corpus.includes(noZeroDec)) return true;
        const noZeroDecStripped = noZeroDec.replace(/[,\.]/g, '');
        if (noZeroDecStripped && corpus.includes(noZeroDecStripped)) return true;

        return false;
      });
    });
  } else {
    activeSearchTerms = [];
  }

  // 2) Filtros específicos por columna
  if (centro) {
    filtered = filtered.filter(r => String(r['Centro'] || '') === centro);
  }
  if (nombre) {
    filtered = filtered.filter(r => (r['Nombre 1'] || '') === nombre);
  }
  if (rawLoteQ) {
    const loteNorm = normalizeSearchText(rawLoteQ).toUpperCase();
    filtered = filtered.filter(r => (r.__loteUC || '').includes(loteNorm));
  }
  if (material) {
    filtered = filtered.filter(r => (r['Texto breve de material'] || '') === material);
  }
  if (fechaISO) {
    filtered = filtered.filter(r => r.__fechaISO === fechaISO);
  }

  // 3) Ordenamiento por columna si está seleccionado
  if (currentSortColumn) {
    filtered.sort((a, b) => {
      let cmp = 0;
      if (currentSortColumn === 'Cantidad') {
        const valA = a.__numericCantidad ?? -Infinity;
        const valB = b.__numericCantidad ?? -Infinity;
        cmp = valA - valB;
      } else if (currentSortColumn === 'Fe.contabilización') {
        const valA = a.__fechaISO || '';
        const valB = b.__fechaISO || '';
        cmp = valA.localeCompare(valB);
      } else {
        const valA = String(a[currentSortColumn] ?? '');
        const valB = String(b[currentSortColumn] ?? '');
        cmp = valA.localeCompare(valB, 'es', { numeric: true, sensitivity: 'base' });
      }
      return currentSortDirection === 'asc' ? cmp : -cmp;
    });
  }

  currentFilteredData = filtered;
  renderTable(filtered, activeSearchTerms);
}

function updateRowCount(count) {
  const el = document.getElementById('row-count');
  if (!el) return;
  el.textContent = `Mostrando ${count} ${count === 1 ? 'registro' : 'registros'}.`;
}

// -------------------- Vistas y Navegación --------------------
function switchView(viewName) {
  const uploadSec   = document.getElementById('upload-section');
  const searchSec   = document.getElementById('search-section');
  const filtersSec  = document.getElementById('filters');
  const tableSec    = document.getElementById('table-section');
  const btnTable    = document.getElementById('btn-view-table');
  const btnUpload   = document.getElementById('btn-view-upload');

  if (viewName === 'upload') {
    uploadSec.style.display = 'block';
    if (searchSec) searchSec.style.display = 'none';
    if (filtersSec) filtersSec.style.display = 'none';
    if (tableSec) tableSec.style.display = 'none';
    btnUpload.classList.add('active');
    btnTable.classList.remove('active');
  } else {
    uploadSec.style.display = 'none';
    if (searchSec) searchSec.style.display = 'block';
    if (filtersSec) {
      const isCollapsed = filtersSec.classList.contains('filters-collapsed');
      filtersSec.style.display = isCollapsed ? 'none' : 'grid';
    }
    if (tableSec) tableSec.style.display = 'block';
    btnTable.classList.add('active');
    btnUpload.classList.remove('active');
  }
}

// -------------------- Modal de Autenticación (Contraseña Administrador) --------------------
const ADMIN_PASSWORD = '161097';

function openAuthModal() {
  const authModal = document.getElementById('auth-modal');
  const input = document.getElementById('admin-password-input');
  const errorMsg = document.getElementById('auth-error-msg');
  if (!authModal) return;

  if (input) input.value = '';
  if (errorMsg) errorMsg.style.display = 'none';

  authModal.style.display = 'flex';
  setTimeout(() => input?.focus(), 80);
}

function closeAuthModal() {
  const authModal = document.getElementById('auth-modal');
  if (authModal) authModal.style.display = 'none';
}

function verifyAdminPassword() {
  const input = document.getElementById('admin-password-input');
  const errorMsg = document.getElementById('auth-error-msg');
  const entered = (input?.value || '').trim();

  if (entered === ADMIN_PASSWORD) {
    closeAuthModal();
    openFirebaseModal();
  } else {
    if (errorMsg) {
      errorMsg.style.display = 'block';
    }
    if (input) {
      input.value = '';
      input.focus();
    }
  }
}

// -------------------- Modal de Firebase --------------------
function openFirebaseModal() {
  const modal = document.getElementById('firebase-modal');
  if (!modal) return;

  const cfg = getActiveFirebaseConfig();
  document.getElementById('cfg-db-type').value = cfg.dbType || 'rtdb';
  document.getElementById('cfg-api-key').value = cfg.apiKey || '';
  document.getElementById('cfg-project-id').value = cfg.projectId || '';
  document.getElementById('cfg-database-url').value = cfg.databaseURL || '';
  document.getElementById('cfg-auth-domain').value = cfg.authDomain || '';
  document.getElementById('cfg-app-id').value = cfg.appId || '';

  const resDiv = document.getElementById('test-connection-result');
  if (resDiv) resDiv.style.display = 'none';

  modal.style.display = 'flex';
}

function closeFirebaseModal() {
  const modal = document.getElementById('firebase-modal');
  if (modal) modal.style.display = 'none';
}

// -------------------- Listeners de la Interfaz --------------------
document.addEventListener('DOMContentLoaded', () => {
  // 1) Carga inicial de datos
  loadDataset();

  // 2) Cambio de vistas en cabecera
  document.getElementById('btn-view-table')?.addEventListener('click', () => switchView('table'));
  document.getElementById('btn-view-upload')?.addEventListener('click', () => switchView('upload'));
  
  // Botón de configuración protegido por contraseña
  document.getElementById('btn-open-config')?.addEventListener('click', openAuthModal);
  document.getElementById('btn-close-modal')?.addEventListener('click', closeFirebaseModal);

  // Listeners del modal de contraseña
  document.getElementById('btn-close-auth-modal')?.addEventListener('click', closeAuthModal);
  document.getElementById('btn-cancel-auth')?.addEventListener('click', closeAuthModal);
  document.getElementById('btn-submit-auth')?.addEventListener('click', verifyAdminPassword);
  document.getElementById('admin-password-input')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      verifyAdminPassword();
    }
  });

  // Cerrar modales al hacer clic en el fondo oscuro
  document.getElementById('auth-modal')?.addEventListener('click', (e) => {
    if (e.target.id === 'auth-modal') closeAuthModal();
  });
  document.getElementById('firebase-modal')?.addEventListener('click', (e) => {
    if (e.target.id === 'firebase-modal') closeFirebaseModal();
  });

  // 3) Pestañas del panel de carga (Pegar vs Archivo)
  const tabPaste = document.getElementById('tab-btn-paste');
  const tabFile = document.getElementById('tab-btn-file');
  const boxPaste = document.getElementById('method-paste-box');
  const boxFile = document.getElementById('method-file-box');

  tabPaste?.addEventListener('click', () => {
    tabPaste.classList.add('active');
    tabFile.classList.remove('active');
    boxPaste.classList.add('active');
    boxFile.classList.remove('active');
  });

  tabFile?.addEventListener('click', () => {
    tabFile.classList.add('active');
    tabPaste.classList.remove('active');
    boxFile.classList.add('active');
    boxPaste.classList.remove('active');
  });

  // 4) Analizar texto pegado
  document.getElementById('btn-parse-paste')?.addEventListener('click', () => {
    const raw = document.getElementById('paste-input')?.value || '';
    if (!raw.trim()) {
      alert('Por favor pega primero las celdas de Excel en el recuadro de texto.');
      return;
    }
    const parsed = parsePastedExcelText(raw);
    showPreview(parsed);
  });

  document.getElementById('btn-clear-paste')?.addEventListener('click', () => {
    const input = document.getElementById('paste-input');
    if (input) input.value = '';
    document.getElementById('preview-container').style.display = 'none';
  });

  // 5) Subida de archivo Excel
  const dropZone = document.getElementById('drop-zone');
  const fileInput = document.getElementById('excel-file-input');
  const fileNameTag = document.getElementById('selected-file-name');

  dropZone?.addEventListener('click', () => fileInput?.click());

  dropZone?.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropZone.classList.add('drag-active');
  });

  dropZone?.addEventListener('dragleave', () => {
    dropZone.classList.remove('drag-active');
  });

  dropZone?.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.classList.remove('drag-active');
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      handleFileSelected(e.dataTransfer.files[0]);
    }
  });

  fileInput?.addEventListener('change', (e) => {
    if (e.target.files && e.target.files.length > 0) {
      handleFileSelected(e.target.files[0]);
    }
  });

  function handleFileSelected(file) {
    if (!file) return;
    fileNameTag.textContent = `Archivo seleccionado: ${file.name} (${Math.round(file.size / 1024)} KB)`;

    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const ab = e.target.result;
        const wb = XLSX.read(ab, { type: 'array' });
        const parsed = parseExcelWorkbook(wb);
        showPreview(parsed);
      } catch (err) {
        console.error('Error al procesar archivo Excel:', err);
        alert('Error al leer el archivo Excel: ' + err.message);
      }
    };
    reader.readAsArrayBuffer(file);
  }

  // 6) Botón Guardar en Firebase
  document.getElementById('btn-save-firebase')?.addEventListener('click', handleSaveToFirebase);
  document.getElementById('btn-cancel-preview')?.addEventListener('click', () => {
    document.getElementById('preview-container').style.display = 'none';
  });

  // 7) Acciones del Modal Firebase
  document.getElementById('btn-test-firebase')?.addEventListener('click', async () => {
    const resDiv = document.getElementById('test-connection-result');
    resDiv.style.display = 'block';
    resDiv.className = 'test-result test-loading';
    resDiv.textContent = 'Probando conexión con Firebase...';

    const tempConfig = {
      dbType: document.getElementById('cfg-db-type').value,
      apiKey: document.getElementById('cfg-api-key').value.trim(),
      projectId: document.getElementById('cfg-project-id').value.trim(),
      databaseURL: document.getElementById('cfg-database-url').value.trim(),
      authDomain: document.getElementById('cfg-auth-domain').value.trim(),
      appId: document.getElementById('cfg-app-id').value.trim()
    };

    const res = await testFirebaseConnection(tempConfig);
    if (res.success) {
      resDiv.className = 'test-result test-success';
      resDiv.textContent = `✅ ${res.message}`;
    } else {
      resDiv.className = 'test-result test-error';
      resDiv.textContent = `❌ ${res.message}`;
    }
  });

  document.getElementById('btn-save-firebase-config')?.addEventListener('click', async () => {
    const newConfig = {
      dbType: document.getElementById('cfg-db-type').value,
      apiKey: document.getElementById('cfg-api-key').value.trim(),
      projectId: document.getElementById('cfg-project-id').value.trim(),
      databaseURL: document.getElementById('cfg-database-url').value.trim(),
      authDomain: document.getElementById('cfg-auth-domain').value.trim(),
      appId: document.getElementById('cfg-app-id').value.trim()
    };

    if (!newConfig.apiKey || !newConfig.projectId) {
      alert('API Key y Project ID son obligatorios.');
      return;
    }

    if (newConfig.dbType === 'rtdb' && !newConfig.databaseURL) {
      newConfig.databaseURL = `https://${newConfig.projectId}-default-rtdb.firebaseio.com`;
    }

    await reinitFirebase(newConfig);
    alert('¡Configuración de Firebase guardada correctamente!');
    closeFirebaseModal();

    loadDataset();
  });

  // 8) Buscador Global Rápido
  const globalSearchInput = document.getElementById('global-search');
  const clearSearchBtn    = document.getElementById('clear-search');
  const debouncedSearch   = debounce(applyFilters, 150);

  globalSearchInput?.addEventListener('input', debouncedSearch);
  clearSearchBtn?.addEventListener('click', () => {
    if (globalSearchInput) globalSearchInput.value = '';
    debouncedSearch();
    globalSearchInput?.focus();
  });

  // 9) Alternar visibilidad de filtros específicos
  const toggleFiltersBtn = document.getElementById('btn-toggle-filters');
  const filtersSec       = document.getElementById('filters');
  const toggleIcon       = document.getElementById('filters-toggle-icon');

  toggleFiltersBtn?.addEventListener('click', () => {
    const isCurrentlyCollapsed = filtersSec.classList.contains('filters-collapsed');
    if (isCurrentlyCollapsed) {
      filtersSec.classList.remove('filters-collapsed');
      filtersSec.style.display = 'grid';
      toggleFiltersBtn.classList.add('active');
      if (toggleIcon) toggleIcon.textContent = '▲';
    } else {
      filtersSec.classList.add('filters-collapsed');
      filtersSec.style.display = 'none';
      toggleFiltersBtn.classList.remove('active');
      if (toggleIcon) toggleIcon.textContent = '▼';
    }
  });

  // 10) Botón para limpiar caché y forzar actualización manual
  const btnRefresh = document.getElementById('btn-refresh-data');
  if (btnRefresh) {
    btnRefresh.addEventListener('click', () => purgeAppCacheAndRefresh(true));
  }

  // Clic en el badge de origen para recargar rápidamente
  const badgeSource = document.getElementById('data-source-badge');
  if (badgeSource) {
    badgeSource.addEventListener('click', () => purgeAppCacheAndRefresh(true));
  }

  // 11) Detección automática al reanudar la app en móviles / cambiar de pestaña
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      checkBackgroundUpdates();
    }
  });
  window.addEventListener('focus', () => {
    checkBackgroundUpdates();
  });

  // Comprobación periódica cada 3 minutos si la ventana se mantiene abierta
  setInterval(() => {
    if (document.visibilityState === 'visible') {
      checkBackgroundUpdates();
    }
  }, 180000);

  // 12) PWA: Registro de Service Worker para funcionamiento offline e instalación
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('./sw.js')
        .then(reg => {
          console.log('Service Worker PWA activo:', reg.scope);
          // Forzar comprobación de versión actualizada
          reg.update();
        })
        .catch(err => console.warn('Aviso PWA SW:', err));
    });
  }

  // 13) PWA: Botón de instalación en pantalla de inicio
  let deferredPrompt;
  const btnInstall = document.getElementById('btn-install-pwa');

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    if (btnInstall) {
      btnInstall.style.display = 'inline-flex';
    }
  });

  btnInstall?.addEventListener('click', async () => {
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    const { outcome } = await deferredPrompt.userChoice;
    console.log('Resultado de instalación PWA:', outcome);
    deferredPrompt = null;
    btnInstall.style.display = 'none';
  });

  window.addEventListener('appinstalled', () => {
    console.log('¡Aplicación OBD instalada como PWA!');
    if (btnInstall) btnInstall.style.display = 'none';
  });
});

/* --- Protección UI: permite interactuar y copiar/pegar normalmente en inputs y textareas --- */
(function hardenUI() {
  const blockContext = (e) => {
    const targetTag = (e.target.tagName || '').toLowerCase();
    if (targetTag === 'textarea' || targetTag === 'input') {
      return; // permitir menú contextual para pegar/copiar en inputs y textareas
    }
    e.preventDefault();
  };
  document.addEventListener('contextmenu', blockContext, { capture: true });

  const blockKeys = (e) => {
    const k = (e.key || '').toLowerCase();
    const isMac = navigator.platform.toUpperCase().includes('MAC');
    const ctrlOrCmd = isMac ? e.metaKey : e.ctrlKey;

    if (e.keyCode === 123) { // F12
      e.preventDefault(); e.stopPropagation(); return;
    }
    if (ctrlOrCmd && e.shiftKey && ['i','j','c'].includes(k)) {
      e.preventDefault(); e.stopPropagation(); return;
    }
    if (ctrlOrCmd && k === 'u') {
      e.preventDefault(); e.stopPropagation(); return;
    }
  };
  document.addEventListener('keydown', blockKeys, { capture: true });
})();
