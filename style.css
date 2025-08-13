/* ========== Base ========== */
* { box-sizing: border-box; }
:root {
  --brand: #007BFF;
  --bg: #f5f5f5;
  --text: #333;
  --muted: #6b7280;
  --border: #e5e7eb;
  --row-alt: #f9f9f9;
}

html, body {
  margin: 0;
  padding: 0;
  background: var(--bg);
  color: var(--text);
  font-family: system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, "Apple Color Emoji", "Segoe UI Emoji";
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
}

header {
  background: var(--brand);
  color: #fff;
  padding: 12px 16px;
  display: flex; align-items: center; justify-content: space-between;
}
header h1 { margin: 0; font-size: 18px; font-weight: 700; letter-spacing: .2px; }
header nav a { color:#fff; text-decoration: none; font-weight: 600; }
header nav a:hover { text-decoration: underline; }

/* ========== Filtros ========== */
#filters {
  padding: 12px 16px;
  background: #fff;
  display: grid;
  grid-template-columns: repeat(12, 1fr);
  gap: 12px 14px;
  border-bottom: 1px solid var(--border);
}
.filter { display: flex; flex-direction: column; gap: 6px; grid-column: span 3; min-width: 160px; }
#filters label { font-weight: 700; font-size: 12px; color: var(--muted); }
#filters select, #filters input[type="date"], #filters input[type="text"] {
  padding: 10px 12px; border: 1px solid var(--border); border-radius: 10px; font-size: 14px; background: #fff;
}
#filters button {
  padding: 10px 14px; border: 0; border-radius: 10px; background: var(--brand); color: #fff;
  font-weight: 700; cursor: pointer; grid-column: span 2; align-self: end;
}
#filters button:hover { filter: brightness(0.95); }

/* ========== Contenedor de tabla ========== */
#table-section { padding: 12px 16px; overflow: auto; background:#fff; }

/* Contador */
#row-count { margin: 0 0 10px 0; font-size: 12px; color: var(--muted); }

/* ========== Tabla (vista de escritorio) ========== */
#data-table {
  width: 100%;
  border-collapse: separate; border-spacing: 0;
  font-size: 14px;
}
#data-table thead th {
  background: var(--brand); color:#fff; text-align: left; padding: 10px 12px;
  border: 1px solid var(--brand);
}
#data-table td {
  padding: 10px 12px; border: 1px solid var(--border); background: #fff;
}
#data-table tbody tr:nth-child(even) td { background: var(--row-alt); }

/* Botón copiar referencia */
.copy-ref {
  border: 1px solid var(--border);
  background: #fff;
  border-radius: 8px;
  padding: 6px 8px;
  font-size: 14px;
  cursor: pointer;
  margin-left: 6px;
}
.copy-ref:hover { background: #f3f4f6; }

/* ——— Vista móvil: tabla -> tarjetas legibles, sin scroll horizontal ——— */
@media (max-width: 768px) {
  /* oculta cabecera de tabla y usa 'data-label' como etiqueta de cada campo */
  #data-table thead { display: none; }

  #data-table, #data-table tbody, #data-table tr, #data-table td {
    display: block;
    width: 100%;
  }

  #data-table tr {
    border: 1px solid #e5e7eb;
    border-radius: 12px;
    padding: 10px 10px 6px 10px;
    margin-bottom: 10px;
    background: #fff;
  }

  #data-table td {
    border: 0;
    border-bottom: 1px dashed #e5e7eb;
    padding: 8px 0;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
  }

  #data-table td:last-child { border-bottom: 0; }

  /* etiqueta del campo, viene de data-label que pone el JS */
  #data-table td::before {
    content: attr(data-label);
    font-weight: 700;
    color: #6b7280;
    font-size: 12px;
    flex: 0 0 auto;
    min-width: 44%;
  }

  /* Botón copiar cómodo en táctil */
  .copy-ref { padding: 8px 10px; font-size: 15px; border-radius: 10px; }
}
/* ===== Fix filtros en móvil: apilar sin scroll lateral ===== */
@media (max-width: 768px) {
  /* apila los filtros uno debajo del otro */
  #filters {
    display: flex;
    flex-direction: column;     /* <-- fuerza columna */
    align-items: stretch;
    gap: 10px;
    padding: 12px;
  }

  /* anula el min-width que causa desbordes */
  #filters .filter {
    min-width: 0;               /* <-- clave */
    width: 100%;
  }

  /* inputs y selects ocupan el ancho completo */
  #filters select,
  #filters input[type="date"],
  #filters input[type="text"] {
    width: 100%;
    max-width: 100%;
  }

  /* botón 'Limpiar' también a lo ancho */
  #filters button {
    width: 100%;
    margin-top: 0;
  }

  /* por si hay algún desborde residual */
  html, body { overflow-x: hidden; }
}

