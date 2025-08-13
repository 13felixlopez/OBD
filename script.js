/*
 * script.js
 *
 * Fuente principal: Google Sheets (API gviz). Fallback: OBD.xlsx local.
 * Filtros: Acopio (Nombre 1), Lote (texto en mayúsculas), Tipo de material y Fecha.
 * Mejora: botón 📋 junto a cada “Referencia” para copiarla al portapapeles.
 * Rendimiento/UI: debounce en filtros, normalización previa y render por lotes.
 */

// -------------------- Configuración --------------------
let dataset = [];

// ID del documento y GID de la pestaña (0 = primera hoja)
const GOOGLE_SHEET_ID  = '1rfE4dFe5cHtQMIc4mt-Lx-QmdVjMsKcR';
const GOOGLE_SHEET_GID = '0';

// -------------------- Utilidades --------------------
function escapeHtml(str) {
  return String(str)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

// Normaliza múltiples formatos a ISO "YYYY-MM-DD".
function toISODate(val) {
  if (val == null || val === '') return '';

  // gviz Date(YYYY,MM,DD[,hh,mm,ss])
  if (typeof val === 'string' && /^Date\(/.test(val)) {
    const m = val.match(/^Date\((\d+),(\d+),(\d+)(?:,(\d+),(\d+),(\d+))?\)$/);
    if (m) {
      const [, y, mo, d, hh='0', mi='0', ss='0'] = m;
      const dt = new Date(Date.UTC(+y, +mo, +d, +hh, +mi, +ss)); // mes 0-based
      return dt.toISOString().slice(0, 10);
    }
  }

  // "DD/MM/YYYY" o "DD-MM-YYYY"
  if (typeof val === 'string') {
    let m = val.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
    if (m) {
      const [, dd, mm, yyyy] = m;
      const d2 = String(dd).padStart(2, '0');
      const m2 = String(mm).padStart(2, '0');
      return `${yyyy}-${m2}-${d2}`;
    }
    // Ya ISO "YYYY-MM-DD"
    if (/^\d{4}-\d{2}-\d{2}$/.test(val)) return val;
  }

  // Serial de Excel
  if (typeof val === 'number') {
    // Excel epoch 1899-12-30
    const ms = Math.round((val - 25569) * 86400 * 1000);
    return new Date(ms).toISOString().slice(0, 10);
  }

  // Objeto Date o parseable
  const dt = new Date(val);
  if (!isNaN(dt)) return dt.toISOString().slice(0, 10);

  return '';
}

// Visualización "DD/MM/YYYY"
function formatDateDisplay(val) {
  const iso = toISODate(val);
  if (!iso) return '';
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
}

// Debounce para no recalcular en cada tecla
function debounce(fn, wait = 150) {
  let t; 
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), wait); };
}

// Enriquecer dataset una sola vez (para filtros rápidos)
function prepareDataset() {
  dataset = dataset.map(row => {
    const fechaISO = toISODate(row['Fe.contabilización']);
    const loteRaw  = row['Lote'] ?? '';
    return {
      ...row,
      __fechaISO: fechaISO,                    // comparación directa contra input date
      __loteUC: String(loteRaw).toUpperCase()  // búsqueda por lote en mayúsculas
    };
  });
}

// -------------------- Carga de datos --------------------
async function loadDataset() {
  // 1) Intentar Google Sheets (gviz JSON)
  if (GOOGLE_SHEET_ID) {
    try {
      const gvizUrl = `https://docs.google.com/spreadsheets/d/${GOOGLE_SHEET_ID}/gviz/tq?gid=${GOOGLE_SHEET_GID}&tqx=out:json&t=${Date.now()}`;
      const res = await fetch(gvizUrl);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();

      // Extraer JSON de google.visualization.Query.setResponse(...)
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

      prepareDataset();
      initPage();
      return;
    } catch (err) {
      console.warn('Fallo al cargar Google Sheets, uso Excel local:', err);
      // continuar al fallback
    }
  }

  // 2) Fallback: archivo Excel local (OBD.xlsx)
  try {
    const res = await fetch('OBD.xlsx');
    const ab  = await res.arrayBuffer();
    const wb  = XLSX.read(ab, { type: 'array' });
    const sh  = wb.SheetNames[0];
    dataset   = XLSX.utils.sheet_to_json(wb.Sheets[sh], { defval: '' });

    prepareDataset();
    initPage();
  } catch (err) {
    console.error('Error al cargar el Excel local:', err);
  }
}

// -------------------- Inicialización UI --------------------
function initPage() {
  if (document.getElementById('data-table')) {
    populateFilters();
    renderTable(dataset);

    const nombreSelect   = document.getElementById('filter-nombre');
    const fechaInput     = document.getElementById('filter-fecha');
    const materialSelect = document.getElementById('filter-material');
    const loteInput      = document.getElementById('filter-lote');
    const clearBtn       = document.getElementById('clear-filters');

    const debouncedApply = debounce(applyFilters, 150);

    if (nombreSelect)   nombreSelect.addEventListener('change', debouncedApply);
    if (fechaInput)     fechaInput.addEventListener('change', debouncedApply);
    if (materialSelect) materialSelect.addEventListener('change', debouncedApply);
    if (loteInput) {
      loteInput.addEventListener('input', function () {
        this.value = this.value.toUpperCase();
        debouncedApply();
      });
    }
    if (clearBtn) {
      clearBtn.addEventListener('click', function () {
        if (nombreSelect)   nombreSelect.value = '';
        if (fechaInput)     fechaInput.value = '';
        if (materialSelect) materialSelect.value = '';
        if (loteInput)      loteInput.value = '';
        renderTable(dataset);
      });
    }

    // Delegación de evento para los botones "copiar referencia"
    const tbody = document.getElementById('table-body');
    if (tbody) {
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
}

function populateFilters() {
  const nombreSelect   = document.getElementById('filter-nombre');
  const materialSelect = document.getElementById('filter-material');
  if (!nombreSelect || !materialSelect) return;

  const nombres = Array.from(
    new Set(dataset.map(r => r['Nombre 1']).filter(v => v != null && v !== ''))
  ).sort();

  const materiales = Array.from(
    new Set(dataset.map(r => r['Texto breve de material']).filter(v => v != null && v !== ''))
  ).sort();

  nombres.forEach(name => {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = name;
    nombreSelect.appendChild(opt);
  });

  materiales.forEach(mat => {
    const opt = document.createElement('option');
    opt.value = mat;
    opt.textContent = mat;
    materialSelect.appendChild(opt);
  });
}

// -------------------- Renderizado (por lotes) --------------------
// -------------------- Renderizado (por lotes + data-label para móvil) --------------------
function renderTable(data) {
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

  const BATCH = 200; // pinta de 200 en 200 para no bloquear la UI
  let i = 0;

  function makeTd(label, text) {
    const td = document.createElement('td');
    td.setAttribute('data-label', label);
    td.textContent = text ?? '';
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

      // Referencia + botón copiar
      const tdRef = document.createElement('td');
      tdRef.setAttribute('data-label', LABELS['Referencia']);
      const refVal = row['Referencia'] ?? '';
      const span   = document.createElement('span');
      span.textContent = refVal;
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

      const tdCant = makeTd(LABELS['Cantidad'], row['Cantidad']);
      const tdMat  = makeTd(LABELS['Texto breve de material'], row['Texto breve de material']);

      tr.append(tdCentro, tdNombre, tdFecha, tdLote, tdRef, tdCant, tdMat);
      frag.appendChild(tr);
    }

    tbody.appendChild(frag);
    if (i < data.length) requestAnimationFrame(paintChunk);
  }

  requestAnimationFrame(paintChunk);
  updateRowCount(data.length);
}


// -------------------- Filtros --------------------
function applyFilters() {
  const nombre   = document.getElementById('filter-nombre')?.value || '';
  const fechaISO = document.getElementById('filter-fecha')?.value || ''; // input date -> ISO
  const material = document.getElementById('filter-material')?.value || '';
  const loteQ    = (document.getElementById('filter-lote')?.value || '').trim().toUpperCase();

  let filtered = dataset;

  if (nombre) {
    filtered = filtered.filter(r => (r['Nombre 1'] || '') === nombre);
  }
  if (loteQ) {
    filtered = filtered.filter(r => (r.__loteUC || '').includes(loteQ));
  }
  if (material) {
    filtered = filtered.filter(r => (r['Texto breve de material'] || '') === material);
  }
  if (fechaISO) {
    filtered = filtered.filter(r => r.__fechaISO === fechaISO);
  }

  renderTable(filtered);
}

function updateRowCount(count) {
  const el = document.getElementById('row-count');
  if (!el) return;
  el.textContent = `Mostrando ${count} ${count === 1 ? 'registro' : 'registros'}.`;
}

// -------------------- Arranque --------------------
document.addEventListener('DOMContentLoaded', loadDataset);
