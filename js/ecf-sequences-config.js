// ══════════════════════════════════════════════════════════════
//  Secuencias e-NCF de producción — Tecno Caja
//  Configuración → Ventas y Facturación → Secuencias de Comprobantes
//  Electrónicos (e-NCF). Aquí van los rangos reales que autorizó la
//  DGII; e-CF · DGII → Secuencias queda solo para la certificación
//  (pruebas). Misma tabla ecf_sequences, ambiente 'ecf' (ver
//  sequenceEnvironment en modules/ecf/models/ecf.repository.js).
//  Prefijo ecfProdSeq/ecf-prod-seq- para no pisar a js/fiscal-ecf.js
//  ni a js/fiscal-sequences-config.js.
// ══════════════════════════════════════════════════════════════

const ECF_PROD_SEQ_GROUPS = [
  ['facturas', 'Facturas'],
  ['notas', 'Notas de débito y crédito'],
  ['especiales', 'Comprobantes especiales'],
];

let ecfProdSeqTypes = [];
let ecfProdSeqExpandedHistoryId = null;
const ecfProdSeqHistoryCache = {};
// Rangos aprobados leídos del archivo de la DGII, a la espera de "Registrar".
let ecfProdSeqDgiiRanges = [];
// Secuencias de producción en pantalla: para marcar un rango del archivo que ya está registrado.
let ecfProdSeqRows = [];
// Multisucursal: esta PC enlazada como sucursal de una empresa recibe sus
// rangos e-NCF de la central (server/multisucursal/ncf-central.js), igual que
// los B. Aquí no se cargan a mano para que dos sucursales no repitan números.
let ecfProdSeqCentral = { vinculado: false, rangos: [] };

async function ecfProdSeqLoadCentral() {
  const [estado, sync] = await Promise.all([
    fetchJsonWithAuth('/api/multisucursal/estado').catch(() => null),
    fetchJsonWithAuth('/api/multisucursal/sincronizacion').catch(() => null),
  ]);
  return {
    vinculado: Boolean(estado?.enlace?.vinculado),
    sucursal: estado?.enlace?.sucursal?.nombre || '',
    empresa: estado?.enlace?.empresa?.nombre || '',
    rangos: (sync?.sincronizacion?.ncf || []).filter((r) => String(r.tipo || '').startsWith('E')),
  };
}

function ecfProdSeqFromCentral(seq) {
  return ecfProdSeqCentral.rangos.some((r) => r.tipo === seq.tipoComprobante
    && Number(r.desde) === Number(seq.desde) && Number(r.hasta) === Number(seq.hasta));
}

function ecfProdSeqFormatNumber(n) {
  return Number(n || 0).toLocaleString('es-DO');
}

function ecfProdSeqFormatDate(iso) {
  if (!iso) return '—';
  try { return new Date(String(iso).slice(0, 10) + 'T00:00:00').toLocaleDateString('es-DO'); } catch (_) { return iso; }
}

function ecfProdSeqEncf(tipo, numero) {
  return `${tipo}${String(numero || 0).padStart(10, '0')}`;
}

// Íconos de línea (js/iconos.js). Sin emojis: js/modulos.js los quita.
function ecfProdSeqIcon(name, size = 18) {
  return window.TcIconos ? window.TcIconos.svg(name, size) : '';
}

async function ecfProdSeqLoadTypes() {
  if (ecfProdSeqTypes.length) return ecfProdSeqTypes;
  try {
    ecfProdSeqTypes = await fiscalApi('GET', '/sequences/types');
  } catch (_) {
    ecfProdSeqTypes = [];
  }
  return ecfProdSeqTypes;
}

async function loadEcfProdSequences() {
  const container = document.getElementById('ecf-prod-seq-list');
  if (!container) return;
  container.innerHTML = '<div class="loading-text">Cargando…</div>';
  try {
    const [rows, status, central] = await Promise.all([
      fiscalApi('GET', '/sequences?environment=ecf'),
      fiscalApi('GET', '/status').catch(() => null),
      ecfProdSeqLoadCentral(),
      ecfProdSeqLoadTypes(),
    ]);
    ecfProdSeqRows = rows;
    ecfProdSeqCentral = central;
    ecfProdSeqRenderCentral();
    ecfProdSeqRenderEnvironment(status, rows);
    ecfProdSeqDecorateDrop();
    const inUse = ecfProdSeqInUseIds(rows);
    container.innerHTML = rows.length
      ? rows.map((seq) => ecfProdSeqRenderCard(seq, inUse)).join('')
      : `<div class="ecfs-empty">${central.vinculado
        ? 'Todavía no le han asignado rangos e-NCF a esta sucursal desde la central.'
        : 'Todavía no hay secuencias e-NCF. Sube arriba la autorización de la DGII.'}</div>`;
  } catch (e) {
    container.innerHTML = `<div class="error-text">Error al cargar: ${escapeHtml(e.message)}</div>`;
  }
}

// Sucursal de una empresa: la carga del archivo de la DGII se cambia por un
// aviso. El rango se reparte en el panel de sucursales (Tecno Caja o el
// contador) y llega solo al sincronizar.
function ecfProdSeqRenderCentral() {
  const upload = document.getElementById('ecf-prod-seq-upload');
  const aviso = document.getElementById('ecf-prod-seq-central');
  if (!upload || !aviso) return;
  const { vinculado, sucursal, empresa } = ecfProdSeqCentral;
  upload.hidden = vinculado;
  aviso.innerHTML = vinculado
    ? `<div class="ecfs-status ecfs-status--info">${ecfProdSeqIcon('link', 20)}<div>
        Esta PC es la sucursal <strong>${escapeHtml(sucursal || '—')}</strong> de <strong>${escapeHtml(empresa || 'la empresa')}</strong>.
        Los rangos e-NCF de cada sucursal los reparte la central (Tecno Caja o tu contador, en el panel de sucursales),
        igual que los comprobantes B, y llegan solos al sincronizar. Así dos sucursales nunca usan el mismo número.
      </div></div>`
    : '';
}

function ecfProdSeqRenderEnvironment(status, rows) {
  const box = document.getElementById('ecf-prod-seq-env');
  if (!box) return;
  if (!status) { box.innerHTML = ''; return; }
  const production = String(status.environment || '').toLowerCase() === 'ecf';
  const usable = rows.some((seq) => seq.activo && !seq.isExpired && !seq.isExhausted);
  let variant;
  let icon;
  let message;
  if (!production) {
    [variant, icon] = ['info', 'info'];
    message = 'La facturación electrónica todavía está en <strong>pruebas</strong> (certificación). Estas secuencias se usan cuando actives producción en e-CF · DGII.';
  } else if (!usable) {
    [variant, icon] = ['warn', 'triangle-alert'];
    message = '<strong>Estás en producción y no hay ninguna secuencia disponible.</strong> Sube la autorización de la DGII para poder emitir facturas electrónicas.';
  } else {
    [variant, icon] = ['ok', 'circle-check'];
    message = '<strong>Producción activa.</strong> La factura electrónica usa estas secuencias.';
  }
  box.innerHTML = `<div class="ecfs-status ecfs-status--${variant}">${ecfProdSeqIcon(icon, 20)}<div>${message}</div></div>`;
}

// La que usa la factura ahora por cada tipo (y sucursal/caja): la de rango
// más bajo que todavía tiene números, igual que getNextAvailableSequence en
// modules/ecf/models/ecf.repository.js. Las demás activas quedan en espera.
function ecfProdSeqInUseIds(rows) {
  const firstByGroup = new Map();
  rows
    .filter((seq) => seq.activo && !seq.isExpired && !seq.isExhausted)
    .sort((a, b) => Number(a.desde) - Number(b.desde) || Number(a.id) - Number(b.id))
    .forEach((seq) => {
      const key = `${seq.tipoComprobante}|${seq.branchId || ''}|${seq.cashRegisterId || ''}`;
      if (!firstByGroup.has(key)) firstByGroup.set(key, seq.id);
    });
  return new Set(firstByGroup.values());
}

function ecfProdSeqRenderCard(seq, inUse = new Set()) {
  let estado;
  if (!seq.activo) estado = { label: 'Inactiva', cls: '' };
  else if (seq.isExpired) estado = { label: 'Vencida', cls: 'ecfs-pill--bad' };
  else if (seq.isExhausted) estado = { label: 'Agotada', cls: 'ecfs-pill--bad' };
  else if (inUse.has(seq.id)) estado = { label: 'En uso', cls: 'ecfs-pill--ok' };
  else estado = { label: 'En espera', cls: '', hint: 'Se empieza a usar cuando se agote el rango anterior.' };
  const total = Math.max(1, Number(seq.hasta) - Number(seq.desde) + 1);
  const disponibles = seq.isExhausted ? 0 : Number(seq.remaining || 0);
  const usados = total - disponibles;
  const pct = Math.min(100, Math.round((usados / total) * 100));
  const pocos = disponibles > 0 && disponibles / total < 0.1;
  const lugar = `${seq.branchName || 'Global'}${seq.cashRegisterName ? ` / ${seq.cashRegisterName}` : ''}`;
  // Un rango de la central se maneja desde el panel de sucursales: aquí no se
  // cambia el próximo número ni se desactiva o borra.
  const central = ecfProdSeqFromCentral(seq);
  const autorizacion = [
    seq.authorizationReference ? `Autorización DGII ${escapeHtml(seq.authorizationReference)}` : 'Sin Nº de autorización',
    seq.fechaAutorizacion ? ecfProdSeqFormatDate(seq.fechaAutorizacion) : '',
    central ? 'Asignado por la central' : '',
  ].filter(Boolean).join(' · ');
  const history = ecfProdSeqExpandedHistoryId === seq.id ? ecfProdSeqRenderHistory(seq) : '';
  return `
    <div class="ecfs-card ${seq.activo ? '' : 'ecfs-card--off'}">
      <div class="ecfs-card__head">
        <span class="ecfs-chip">${escapeHtml(seq.tipoComprobante)}</span>
        <div class="ecfs-card__title">
          <div class="ecfs-card__name">${escapeHtml(seq.label || seq.tipoComprobante)}</div>
          <div class="ecfs-card__meta">${autorizacion} · ${escapeHtml(lugar)}</div>
        </div>
        <span class="ecfs-pill ${estado.cls}" ${estado.hint ? `title="${escapeHtml(estado.hint)}"` : ''}>${estado.label}</span>
      </div>
      ${estado.hint ? `<div class="ecfs-card__meta">${escapeHtml(estado.hint)}</div>` : ''}
      <div class="ecfs-card__numbers">
        <div><div class="ecfs-num__label">Próximo e-NCF</div><div class="ecfs-num__value">${seq.isExhausted ? '—' : ecfProdSeqEncf(seq.tipoComprobante, seq.proximo)}</div></div>
        <div><div class="ecfs-num__label">Rango autorizado</div><div class="ecfs-num__value">${ecfProdSeqEncf(seq.tipoComprobante, seq.desde)} → ${ecfProdSeqEncf(seq.tipoComprobante, seq.hasta)}</div></div>
        <div><div class="ecfs-num__label">Vence</div><div class="ecfs-num__value">${seq.fechaVencimiento ? ecfProdSeqFormatDate(seq.fechaVencimiento) : 'Sin vencimiento'}</div></div>
      </div>
      <div class="${pocos ? 'ecfs-bar--low' : ''}">
        <div class="ecfs-bar"><div class="ecfs-bar__fill" style="width:${pct}%"></div></div>
        <div class="ecfs-bar__text"><span>${ecfProdSeqFormatNumber(usados)} ${usados === 1 ? 'usado' : 'usados'}</span><span>${ecfProdSeqFormatNumber(disponibles)} de ${ecfProdSeqFormatNumber(total)} disponibles</span></div>
      </div>
      <div class="ecfs-card__actions">
        ${seq.activo && !central ? `<button class="ecfs-btn" type="button" onclick="ecfProdSeqChangeNext(${seq.id})">${ecfProdSeqIcon('pencil', 16)}Próximo número</button>` : ''}
        <button class="ecfs-btn" type="button" onclick="ecfProdSeqToggleHistory(${seq.id})">${ecfProdSeqIcon('history', 16)}${ecfProdSeqExpandedHistoryId === seq.id ? 'Ocultar historial' : 'Historial'}</button>
        ${seq.activo && !central ? `<button class="ecfs-btn" type="button" onclick="ecfProdSeqDisable(${seq.id})">${ecfProdSeqIcon('pause', 16)}Desactivar</button>` : ''}
        ${central ? '' : `<button class="ecfs-btn ecfs-btn--danger" type="button" onclick="ecfProdSeqDelete(${seq.id})" title="Solo si nunca se emitió un e-CF con ella">${ecfProdSeqIcon('trash-2', 16)}Eliminar</button>`}
      </div>
      ${history}
    </div>`;
}

function ecfProdSeqRenderHistory(seq) {
  const entries = ecfProdSeqHistoryCache[seq.id] || [];
  const body = entries.length
    ? entries.map((h) => `<div class="ecfs-history__item">
        <strong>${escapeHtml(h.detail || h.action)}</strong>
        <span>${escapeHtml(h.userName || 'Sistema')} · ${new Date(h.createdAt).toLocaleString('es-DO')}</span>
      </div>`).join('')
    : '<div>Sin historial todavía.</div>';
  return `<div class="ecfs-history">${body}</div>`;
}

// Zona de arrastrar y soltar: ícono y eventos (una sola vez).
function ecfProdSeqDecorateDrop() {
  const drop = document.getElementById('ecf-prod-seq-drop');
  if (!drop || drop.dataset.ready) return;
  drop.dataset.ready = '1';
  const icon = drop.querySelector('[data-icon]');
  if (icon) icon.innerHTML = ecfProdSeqIcon(icon.dataset.icon, 24);
  const input = document.getElementById('ecf-prod-seq-dgii-file');
  ['dragenter', 'dragover'].forEach((type) => drop.addEventListener(type, (event) => {
    event.preventDefault();
    drop.classList.add('ecfs-drop--over');
  }));
  ['dragleave', 'drop'].forEach((type) => drop.addEventListener(type, () => drop.classList.remove('ecfs-drop--over')));
  drop.addEventListener('drop', (event) => {
    event.preventDefault();
    const files = Array.from(event.dataTransfer?.files || []);
    if (files.length) ecfProdSeqReadDgiiFile({ files, value: '' });
    if (input) input.value = '';
  });
}

// ── Ventana de análisis ───────────────────────────────────────────────────────
// La de todo el POS (js/ventana-analisis.js): pasos uno a uno mientras corre
// `work` (leer el archivo, registrar en el servidor) y el resumen al final.
function ecfProdSeqAiRun({ title, subtitle, steps, work, summary }) {
  return window.TcVentanaAnalisis.correr({ titulo: title, subtitulo: subtitle, pasos: steps, trabajo: work, resumen: summary });
}

async function ecfProdSeqToggleHistory(id) {
  if (ecfProdSeqExpandedHistoryId === id) {
    ecfProdSeqExpandedHistoryId = null;
    loadEcfProdSequences();
    return;
  }
  try {
    ecfProdSeqHistoryCache[id] = await fiscalApi('GET', `/sequences/${id}/history`);
    ecfProdSeqExpandedHistoryId = id;
    loadEcfProdSequences();
  } catch (e) {
    showToast('Error al cargar historial: ' + e.message, 'error');
  }
}

async function ecfProdSeqChangeNext(id) {
  const value = await showPromptModal('Nuevo próximo número (debe estar dentro del rango autorizado):', { inputType: 'number' });
  if (!value) return;
  try {
    await fiscalApi('POST', `/sequences/${id}/next`, { proximoNumero: Number(value) });
    showToast('Próximo número actualizado y registrado en el historial.', 'success');
    loadEcfProdSequences();
  } catch (e) {
    showToast('Error: ' + e.message, 'error');
  }
}

async function ecfProdSeqDisable(id) {
  if (!await showDeleteConfirm('¿Desactivar esta secuencia? No se usará más al facturar; el historial se conserva.', { confirmText: 'Desactivar' })) return;
  try {
    await fiscalApi('DELETE', `/sequences/${id}`);
    showToast('Secuencia desactivada.', 'success');
    loadEcfProdSequences();
  } catch (e) {
    showToast('Error: ' + e.message, 'error');
  }
}

async function ecfProdSeqDelete(id) {
  if (!await showDeleteConfirm('¿Eliminar esta secuencia? Solo se puede si nunca se emitió un e-CF con ella.')) return;
  try {
    const result = await fiscalApi('DELETE', `/sequences/${id}/permanent`);
    if (result.ok === false) throw new Error(result.message || 'No se pudo eliminar.');
    showToast('Secuencia eliminada.', 'success');
    loadEcfProdSequences();
  } catch (e) {
    showToast('Error: ' + e.message, 'error');
  }
}

// ── Formulario ────────────────────────────────────────────────────────────────

async function initEcfProdSeqForm() {
  const typeSel = document.getElementById('ecf-prod-seq-type');
  if (typeSel && !typeSel.dataset.loaded) {
    const types = await ecfProdSeqLoadTypes();
    typeSel.innerHTML = ECF_PROD_SEQ_GROUPS.map(([key, title]) => {
      const items = types.filter((type) => (type.group || 'especiales') === key);
      if (!items.length) return '';
      return `<optgroup label="${escapeHtml(title)}">${items.map((type) =>
        `<option value="${type.code}" ${type.code === 'E32' ? 'selected' : ''}>${type.code} · ${escapeHtml(type.label)}</option>`).join('')}</optgroup>`;
    }).join('');
    typeSel.dataset.loaded = '1';
  }

  const branchSel = document.getElementById('ecf-prod-seq-branch');
  const cajaSel = document.getElementById('ecf-prod-seq-caja');
  if (branchSel && !branchSel.dataset.loaded) {
    const [branches, registers] = await Promise.all([
      fetchJsonWithAuth('/api/branches').catch(() => []),
      fetchJsonWithAuth('/api/cash-registers').catch(() => []),
    ]);
    branchSel.innerHTML = '<option value="">Global (todas las sucursales)</option>' +
      (branches || []).map((b) => `<option value="${b.id}">${escapeHtml(b.nombre)}</option>`).join('');
    const fillCajas = () => {
      const branchId = Number(branchSel.value || 0) || null;
      const list = (registers || []).filter((r) => !branchId || Number(r.sucursalId || r.branch_id || 0) === branchId);
      cajaSel.innerHTML = '<option value="">Global / todas las cajas</option>' +
        list.map((r) => `<option value="${r.id}">${escapeHtml(r.nombre)}</option>`).join('');
    };
    branchSel.onchange = fillCajas;
    fillCajas();
    branchSel.dataset.loaded = '1';
  }
}

// La lectura del archivo de la DGII (XML, Excel o CSV) está en
// js/dgii-autorizacion.js: la comparte con el panel de sucursales.
function ecfProdSeqApproved(ranges) {
  return window.TcDgiiAutorizacion.aprobados(ranges, 'E');
}

// Un rango del archivo que se cruza con una secuencia de producción ya
// registrada (el servidor no deja duplicarlo).
function ecfProdSeqAlreadyRegistered(item) {
  return ecfProdSeqRows.some((seq) => seq.tipoComprobante === item.tipo
    && Number(seq.desde) <= item.hasta && Number(seq.hasta) >= item.desde);
}

function ecfProdSeqDescribe(ranges) {
  const aprobados = ecfProdSeqApproved(ranges);
  if (!aprobados.length) return 'No encontré rangos e-NCF aprobados en este archivo.';
  const partes = aprobados.map((item) => `${item.tipo} · ${ecfProdSeqFormatNumber(item.hasta - item.desde + 1)} números`
    + (ecfProdSeqAlreadyRegistered(item) ? ' (ya está registrado)' : ''));
  return `Encontré ${aprobados.length === 1 ? '1 rango aprobado' : `${aprobados.length} rangos aprobados`}: ${partes.join(', ')}.`;
}

// Quita el resultado leído de la pantalla (no toca lo ya registrado).
function ecfProdSeqDiscardPreview() {
  ecfProdSeqDgiiRanges = [];
  const box = document.getElementById('ecf-prod-seq-dgii-preview');
  if (box) box.innerHTML = '';
  const xml = document.getElementById('ecf-prod-seq-dgii-xml');
  if (xml) xml.value = '';
}

// Uno o varios archivos a la vez (la DGII da uno por solicitud).
async function ecfProdSeqReadDgiiFile(input) {
  const files = Array.from(input?.files || []);
  if (!files.length) return;
  if (input.value !== undefined) input.value = '';
  const varios = files.length > 1;
  const origen = varios ? `${files.length} archivos` : files[0].name;
  let errores = [];
  try {
    const ranges = await ecfProdSeqAiRun({
      title: 'Analizando la autorización de la DGII',
      subtitle: origen,
      steps: [
        varios ? `Leyendo los ${files.length} archivos` : 'Leyendo el archivo',
        'Reconociendo el formato de la DGII',
        'Extrayendo tipo, rango y Nº de autorización',
        'Revisando que el rango esté aprobado',
      ],
      work: async () => {
        const leido = await window.TcDgiiAutorizacion.leerArchivos(files);
        errores = leido.errores;
        if (!leido.rangos.length) {
          throw new Error(errores.map((e) => (varios ? `${e.archivo}: ${e.mensaje}` : e.mensaje)).join(' | ') || 'No encontré rangos en el archivo.');
        }
        return leido.rangos;
      },
      summary: ecfProdSeqDescribe,
    });
    ecfProdSeqShowDgiiPreview(ranges, origen, errores);
  } catch (_) {
    // El error ya se mostró en la ventana de análisis.
  }
}

async function ecfProdSeqPreviewFromText() {
  const text = document.getElementById('ecf-prod-seq-dgii-xml')?.value || '';
  try {
    const ranges = await ecfProdSeqAiRun({
      title: 'Analizando la respuesta de la DGII',
      subtitle: 'Texto pegado',
      steps: ['Leyendo el texto', 'Extrayendo tipo, rango y Nº de autorización', 'Revisando que el rango esté aprobado'],
      work: () => window.TcDgiiAutorizacion.leerXml(text),
      summary: ecfProdSeqDescribe,
    });
    ecfProdSeqShowDgiiPreview(ranges, 'el texto pegado');
  } catch (_) {
    // El error ya se mostró en la ventana de análisis.
  }
}

function ecfProdSeqShowDgiiPreview(ranges, origen, errores = []) {
  const box = document.getElementById('ecf-prod-seq-dgii-preview');
  if (!box) return;
  const serieB = ranges.filter((item) => item.tipo.startsWith('B'));
  const rechazados = ranges.filter((item) => item.tipo.startsWith('E') && item.estatus && item.estatus !== 'APROBADA');
  const aprobados = ecfProdSeqApproved(ranges);
  // Con varios archivos, cada rango dice de cuál salió.
  const varios = new Set(ranges.map((item) => item.archivo).filter(Boolean)).size > 1;
  // Solo se ofrece registrar lo que todavía no está en el sistema.
  ecfProdSeqDgiiRanges = aprobados.filter((item) => !ecfProdSeqAlreadyRegistered(item));

  const avisos = [];
  if (serieB.length) avisos.push(`Trae ${serieB.length} rango(s) B: esos se registran en Secuencias de Comprobantes Fiscales (NCF).`);
  if (rechazados.length) avisos.push(`${rechazados.length} solicitud(es) no aprobada(s) no se registran.`);
  errores.forEach((e) => avisos.push(`No se pudo leer ${e.archivo}: ${e.mensaje}`));
  const notas = avisos.map((a) => `<div class="ecfs-found__notes">${escapeHtml(a)}</div>`).join('');
  const quitar = `<button class="ecfs-btn ecfs-found__close" type="button" onclick="ecfProdSeqDiscardPreview()">${ecfProdSeqIcon('x', 16)}Quitar</button>`;
  if (!aprobados.length) {
    box.innerHTML = `<div class="ecfs-status ecfs-status--warn" style="margin-top:var(--tc-space-4)">${ecfProdSeqIcon('triangle-alert', 20)}
      <div style="flex:1">No se encontró ningún rango e-NCF aprobado en ${escapeHtml(origen)}. Usa el XML, Excel o CSV de la consulta de solicitudes de la DGII.${notas}</div>${quitar}</div>`;
    return;
  }
  const nombre = (tipo) => (ecfProdSeqTypes.find((type) => type.code === tipo) || {}).label || '';
  const pendientes = ecfProdSeqDgiiRanges.length;
  const acciones = pendientes
    ? `<label class="checkbox-label" style="margin:0"><input type="checkbox" id="ecf-prod-seq-dgii-rnc-confirm"> Confirmo que esta autorización corresponde al RNC de mi empresa</label>
       <button class="btn-primary" type="button" id="ecf-prod-seq-dgii-btn" onclick="ecfProdSeqRegisterDgiiRanges()">Registrar ${pendientes === 1 ? 'secuencia' : `${pendientes} secuencias`}</button>`
    : `<div class="ecfs-found__notes" style="margin:0">${aprobados.length === 1 ? 'Este rango ya está registrado' : 'Estos rangos ya están registrados'} en el sistema: no hay nada nuevo que registrar.</div>`;
  box.innerHTML = `
    <div class="ecfs-found">
      <div class="ecfs-found__title">${ecfProdSeqIcon('file-text', 20)}<span style="flex:1">La DGII autorizó (${escapeHtml(origen)})</span>${quitar}</div>
      ${aprobados.map((item) => `
        <div class="ecfs-found__item">
          <span class="ecfs-chip">${escapeHtml(item.tipo)}</span>
          <div>
            <div class="ecfs-card__name">${escapeHtml(nombre(item.tipo) || item.comprobante)}
              ${ecfProdSeqAlreadyRegistered(item) ? '<span class="ecfs-pill ecfs-pill--ok" style="margin-left:var(--tc-space-2)">Ya registrado</span>' : ''}</div>
            ${varios && item.archivo ? `<div class="ecfs-card__meta">Archivo: ${escapeHtml(item.archivo)}</div>` : ''}
            <div class="ecfs-card__numbers" style="margin-top:var(--tc-space-2)">
              <div><div class="ecfs-num__label">Rango</div><div class="ecfs-num__value">${ecfProdSeqEncf(item.tipo, item.desde)} → ${ecfProdSeqEncf(item.tipo, item.hasta)}</div></div>
              <div><div class="ecfs-num__label">Cantidad</div><div class="ecfs-num__value">${ecfProdSeqFormatNumber(item.hasta - item.desde + 1)}</div></div>
              <div><div class="ecfs-num__label">Nº de autorización</div><div class="ecfs-num__value">${escapeHtml(item.referencia || '—')}</div></div>
              <div><div class="ecfs-num__label">Fecha</div><div class="ecfs-num__value">${ecfProdSeqFormatDate(item.fechaAutorizacion)}</div></div>
            </div>
          </div>
        </div>`).join('')}
      ${notas}
      <div class="ecfs-found__actions">${acciones}</div>
    </div>`;
}

async function ecfProdSeqRegisterDgiiRanges() {
  if (!document.getElementById('ecf-prod-seq-dgii-rnc-confirm')?.checked) {
    showToast('Confirma que la autorización corresponde al RNC de tu empresa.', 'warning');
    return;
  }
  const faltan = ecfProdSeqDgiiRanges.filter((item) => !item.referencia || !item.fechaAutorizacion);
  if (faltan.length) {
    showToast(`Al archivo le falta el Nº o la fecha de autorización de ${faltan.map((item) => item.tipo).join(', ')}. Regístralo a mano abajo.`, 'warning');
    return;
  }
  const ranges = ecfProdSeqDgiiRanges;
  const tipos = ranges.map((item) => item.tipo).join(', ');
  try {
    await ecfProdSeqAiRun({
      title: 'Registrando en Tecno Caja',
      subtitle: `Autorización ${ranges.map((item) => item.referencia).join(', ')}`,
      steps: [
        'Comprobando que no se cruce con tus secuencias',
        'Guardando el rango y la autorización',
        'Dejando la numeración lista para facturar',
      ],
      work: async () => {
        const errores = [];
        for (const item of ranges) {
          try {
            await fiscalApi('POST', '/sequences', {
              environment: 'ecf',
              tipoComprobante: item.tipo,
              desde: item.desde,
              hasta: item.hasta,
              authorizationReference: item.referencia,
              fechaAutorizacion: item.fechaAutorizacion,
            });
          } catch (e) {
            errores.push(`${item.tipo}: ${e.message}`);
          }
        }
        if (errores.length === ranges.length) throw new Error(errores.join(' | '));
        return errores;
      },
      summary: (errores) => (errores.length
        ? `Registré una parte. No se pudo: ${errores.join(' | ')}`
        : `${tipos} ya está${ranges.length > 1 ? 'n' : ''} disponible${ranges.length > 1 ? 's' : ''} para facturar.`),
    });
    ecfProdSeqDiscardPreview();
  } catch (_) {
    // El error ya se mostró en la ventana de análisis; el resultado leído
    // sigue en pantalla y se puede quitar con "Quitar".
  }
  loadEcfProdSequences();
}

async function saveEcfProdSequence() {
  const tipoComprobante = document.getElementById('ecf-prod-seq-type')?.value;
  const branchId = document.getElementById('ecf-prod-seq-branch')?.value || null;
  const cashRegisterId = document.getElementById('ecf-prod-seq-caja')?.value || null;
  const desde = parseInt(document.getElementById('ecf-prod-seq-desde')?.value, 10) || 0;
  const hasta = parseInt(document.getElementById('ecf-prod-seq-hasta')?.value, 10) || 0;
  const authorizationReference = String(document.getElementById('ecf-prod-seq-referencia')?.value || '').trim();
  const fechaAutorizacion = document.getElementById('ecf-prod-seq-fecha-autorizacion')?.value || null;
  const fechaVencimiento = document.getElementById('ecf-prod-seq-vencimiento')?.value || null;
  const rncConfirmed = document.getElementById('ecf-prod-seq-rnc-confirm')?.checked;

  if (!tipoComprobante) { showToast('Selecciona el tipo de comprobante.', 'warning'); return; }
  if (!desde || !hasta || hasta < desde) { showToast('Escribe el número inicial y final exactos del rango.', 'warning'); return; }
  if (!authorizationReference) { showToast('Escribe el Nº de autorización de la DGII.', 'warning'); return; }
  if (!fechaAutorizacion) { showToast('Indica la fecha de autorización de la DGII.', 'warning'); return; }
  if (!rncConfirmed) { showToast('Confirma que la autorización corresponde al RNC de tu empresa.', 'warning'); return; }

  try {
    await fiscalApi('POST', '/sequences', {
      environment: 'ecf',
      tipoComprobante,
      branchId: branchId || null,
      cashRegisterId: cashRegisterId || null,
      desde,
      hasta,
      authorizationReference,
      fechaAutorizacion,
      fechaVencimiento,
    });
    showToast(`Secuencia ${tipoComprobante} registrada.`, 'success');
    const details = document.getElementById('ecf-prod-seq-add');
    if (details) details.open = false;
    loadEcfProdSequences();
  } catch (e) {
    showToast('Error: ' + e.message, 'error');
  }
}

document.addEventListener('DOMContentLoaded', () => {
  const details = document.getElementById('ecf-prod-seq-add');
  if (details) {
    details.addEventListener('toggle', () => {
      if (details.open) initEcfProdSeqForm();
    });
  }
});
