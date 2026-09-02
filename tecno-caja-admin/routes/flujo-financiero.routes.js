'use strict';

/**
 * flujo-financiero.routes.js — Cruce de Facturación vs. Compras/Gastos
 * Solo lectura: agrega en memoria sobre `facturas`, `compras` y `gastos`.
 *
 * GET /api/flujo-financiero            ?mes=YYYY-MM | ?desde=YYYY-MM-DD&hasta=YYYY-MM-DD
 * GET /api/flujo-financiero/reporte    (mismo filtro) [?print=1]  → HTML A4
 * GET /api/flujo-financiero/reporte.pdf(mismo filtro)             → PDF A4
 */

const express = require('express');
const {
  htmlToPdf, getEmisorConfig, escapeHtml, fmtMoney, formatDateOnly,
} = require('./facturacion.routes');

const COL_FACTURAS = 'facturas';
const COL_COMPRAS  = 'compras';
const COL_GASTOS   = 'gastos';
const MESES_SERIE  = 6;
const MESES_LABEL  = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];
const MESES_LARGO  = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const ESTADOS_PENDIENTES = ['pendiente', 'parcial'];

const day10   = v => String(v || '').slice(0, 10);
const monthKey = v => String(v || '').slice(0, 7);
const pad2 = n => String(n).padStart(2, '0');

function monthLabel(key) {
  const [y, m] = key.split('-').map(Number);
  return `${MESES_LABEL[m - 1] || key} ${y}`;
}

function lastNMonthKeysEndingAt(endKey, n) {
  const [y, m] = endKey.split('-').map(Number);
  const keys = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(y, m - 1 - i, 1);
    keys.push(`${d.getFullYear()}-${pad2(d.getMonth() + 1)}`);
  }
  return keys;
}

// Resuelve el período a partir de mes / desde / hasta.
function resolvePeriodo({ mes, desde, hasta }) {
  const d = /^\d{4}-\d{2}-\d{2}$/.test(desde || '') ? desde : null;
  const h = /^\d{4}-\d{2}-\d{2}$/.test(hasta || '') ? hasta : null;
  if (d || h) {
    const dd = d || '1900-01-01';
    const hh = h || '9999-12-31';
    return {
      desde: dd, hasta: hh, tipo: 'rango',
      label: `${d ? formatDateOnly(d) : 'inicio'} — ${h ? formatDateOnly(h) : 'hoy'}`,
      endMonth: monthKey(hh === '9999-12-31' ? new Date().toISOString() : hh),
    };
  }
  const base = /^\d{4}-\d{2}$/.test(mes || '')
    ? mes
    : (() => { const n = new Date(); return `${n.getFullYear()}-${pad2(n.getMonth() + 1)}`; })();
  const [y, mo] = base.split('-').map(Number);
  const lastDay = new Date(y, mo, 0).getDate();
  return {
    desde: `${base}-01`, hasta: `${base}-${pad2(lastDay)}`, tipo: 'mes',
    label: `${MESES_LARGO[mo - 1]} ${y}`, endMonth: base,
  };
}

function computeFlujo({ facturas, compras, gastos, periodo }) {
  const inRange = v => { const x = day10(v); return x >= periodo.desde && x <= periodo.hasta; };

  let facturado = 0, cobrado = 0, comprasP = 0, gastosP = 0;
  let itbisFacturado = 0, itbisCompras = 0;

  facturas.forEach(f => {
    if (f.estado === 'anulada') return;
    if (inRange(f.fechaEmision)) {
      facturado += Number(f.total || 0);
      itbisFacturado += Number(f.itbis || 0);
    }
    (f.pagos || []).forEach(p => { if (inRange(p.fecha)) cobrado += Number(p.monto || 0); });
  });
  compras.forEach(c => {
    if (inRange(c.fechaCompra)) {
      comprasP += Number(c.total || 0);
      itbisCompras += Number(c.itbis || 0);
    }
  });
  gastos.forEach(g => { if (inRange(g.fecha)) gastosP += Number(g.monto || 0); });

  const cuentasPorCobrar = facturas
    .filter(f => ESTADOS_PENDIENTES.includes(f.estado))
    .map(f => ({ id: f.id, numero: f.numero, clienteNombre: f.clienteNombre, ncf: f.ncf || null,
      saldo: Number(f.total || 0) - Number(f.montoPagado || 0), fechaVencimiento: f.fechaVencimiento || null }))
    .sort((a, b) => String(a.fechaVencimiento || '9999').localeCompare(String(b.fechaVencimiento || '9999')));

  const cuentasPorPagar = compras
    .filter(c => ESTADOS_PENDIENTES.includes(c.estado))
    .map(c => ({ id: c.id, suplidorNombre: c.suplidorNombre,
      saldo: Number(c.total || 0) - Number(c.montoPagado || 0), fechaVencimiento: c.fechaVencimiento || null }))
    .sort((a, b) => String(a.fechaVencimiento || '9999').localeCompare(String(b.fechaVencimiento || '9999')));

  const resumen = {
    facturado, cobrado, compras: comprasP, gastos: gastosP,
    gananciaEstimada: facturado - comprasP - gastosP,
    itbisFacturado, itbisCompras, itbisNeto: itbisFacturado - itbisCompras,
    cuentasPorCobrar: cuentasPorCobrar.reduce((s, x) => s + x.saldo, 0),
    cuentasPorPagar: cuentasPorPagar.reduce((s, x) => s + x.saldo, 0),
  };

  const serieMensual = lastNMonthKeysEndingAt(periodo.endMonth, MESES_SERIE).map(key => {
    const ingresos = facturas
      .filter(f => f.estado !== 'anulada' && monthKey(f.fechaEmision) === key)
      .reduce((s, f) => s + Number(f.total || 0), 0);
    const eC = compras.filter(c => monthKey(c.fechaCompra) === key).reduce((s, c) => s + Number(c.total || 0), 0);
    const eG = gastos.filter(g => monthKey(g.fecha) === key).reduce((s, g) => s + Number(g.monto || 0), 0);
    return { mes: key, label: monthLabel(key), ingresos, egresos: eC + eG };
  });

  return { periodo, resumen, serieMensual, cuentasPorCobrar, cuentasPorPagar };
}

async function buildReporteHtml(data, col, { print = false } = {}) {
  const emisor = await getEmisorConfig(col);
  const { periodo, resumen, serieMensual, cuentasPorCobrar, cuentasPorPagar } = data;
  const logo = emisor.logoDataUrl
    ? `<img src="${emisor.logoDataUrl}" class="logo" alt="${escapeHtml(emisor.nombre)}" />`
    : `<div class="brand">${escapeHtml(emisor.nombre)}</div>`;

  const kpi = (label, val, cls = '') => `
    <div class="kpi ${cls}"><div class="kpi-val">RD$ ${fmtMoney(val)}</div><div class="kpi-lbl">${label}</div></div>`;

  const serieRows = serieMensual.map(m => `
    <tr><td>${escapeHtml(m.label)}</td>
      <td class="n">RD$ ${fmtMoney(m.ingresos)}</td>
      <td class="n">RD$ ${fmtMoney(m.egresos)}</td>
      <td class="n ${m.ingresos - m.egresos < 0 ? 'neg' : 'pos'}">RD$ ${fmtMoney(m.ingresos - m.egresos)}</td></tr>`).join('');

  const cxcRows = cuentasPorCobrar.length ? cuentasPorCobrar.map(f => `
    <tr><td>${escapeHtml(f.numero || '—')}</td><td>${escapeHtml(f.clienteNombre || '—')}</td>
      <td>${f.fechaVencimiento ? escapeHtml(formatDateOnly(f.fechaVencimiento)) : '—'}</td>
      <td class="n">RD$ ${fmtMoney(f.saldo)}</td></tr>`).join('')
    : '<tr><td colspan="4" class="empty">Sin cuentas por cobrar</td></tr>';

  const cxpRows = cuentasPorPagar.length ? cuentasPorPagar.map(c => `
    <tr><td colspan="2">${escapeHtml(c.suplidorNombre || '—')}</td>
      <td>${c.fechaVencimiento ? escapeHtml(formatDateOnly(c.fechaVencimiento)) : '—'}</td>
      <td class="n">RD$ ${fmtMoney(c.saldo)}</td></tr>`).join('')
    : '<tr><td colspan="4" class="empty">Sin cuentas por pagar</td></tr>';

  const printScript = print ? '<script>window.addEventListener("load",function(){setTimeout(function(){window.print()},250)});</scr' + 'ipt>' : '';

  return `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"><title>Reporte de flujo financiero — ${escapeHtml(periodo.label)}</title>
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  html,body{background:#eef1f4}
  body{font-family:"Segoe UI","Helvetica Neue",Arial,sans-serif;font-size:10.5px;color:#1f2937;-webkit-print-color-adjust:exact;print-color-adjust:exact}
  .page{width:210mm;min-height:297mm;margin:0 auto;padding:16mm 18mm;background:#fff}
  .head{display:flex;justify-content:space-between;align-items:flex-start;gap:14mm;padding-bottom:6mm;border-bottom:2.5px solid #15803d;margin-bottom:7mm}
  .logo{max-height:26mm;max-width:80mm;display:block}
  .brand{font-size:22px;font-weight:800;color:#15803d}
  .doc{text-align:right}
  .doc h1{font-size:19px;font-weight:800;letter-spacing:1px;color:#15803d;line-height:1.15}
  .doc .per{margin-top:3mm;font-size:11px;font-weight:700;color:#111827}
  .doc .gen{font-size:9px;color:#6b7280;margin-top:1mm}
  .emitter{font-size:9px;color:#6b7280;margin-top:2mm;line-height:1.5}
  .kpis{display:grid;grid-template-columns:repeat(3,1fr);gap:4mm;margin-bottom:7mm}
  .kpi{border:1px solid #e5e7eb;border-top:3px solid #9ca3af;border-radius:3px;padding:3.5mm 3mm}
  .kpi-val{font-size:15px;font-weight:800;color:#111827}
  .kpi-lbl{font-size:8.5px;text-transform:uppercase;letter-spacing:.6px;color:#6b7280;margin-top:1.5mm}
  .kpi.in{border-top-color:#15803d}.kpi.in .kpi-val{color:#15803d}
  .kpi.out{border-top-color:#b45309}.kpi.out .kpi-val{color:#b45309}
  .kpi.gan{border-top-color:#0f172a}
  h2{font-size:9px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#6b7280;margin:6mm 0 2.5mm;padding-bottom:1.5mm;border-bottom:1px solid #e5e7eb}
  table{width:100%;border-collapse:collapse;font-size:9.5px}
  th{background:#f4f7f5;text-align:left;padding:2.4mm 2.5mm;font-size:8.5px;text-transform:uppercase;letter-spacing:.5px;color:#374151;border-top:1.2px solid #15803d;border-bottom:1.2px solid #15803d}
  td{padding:2.2mm 2.5mm;border-bottom:1px solid #edf0f2}
  td.n,th.n{text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums}
  td.pos{color:#15803d}td.neg{color:#b91c1c}
  td.empty{text-align:center;color:#9ca3af}
  tfoot td{font-weight:800;border-top:1.5px solid #111827;border-bottom:0}
  .foot{margin-top:12mm;padding-top:4mm;border-top:1px solid #e5e7eb;font-size:8.5px;color:#9ca3af}
  @page{size:A4;margin:0}
  @media print{html,body{background:#fff}}
</style></head><body>
<div class="page">
  <div class="head">
    <div>${logo}
      <div class="emitter">${emisor.rnc ? 'RNC: ' + escapeHtml(emisor.rnc) + '<br>' : ''}${emisor.telefono ? 'Tel: ' + escapeHtml(emisor.telefono) + '<br>' : ''}${emisor.correo ? escapeHtml(emisor.correo) : ''}</div>
    </div>
    <div class="doc">
      <h1>REPORTE DE<br>FLUJO FINANCIERO</h1>
      <div class="per">Período: ${escapeHtml(periodo.label)}</div>
      <div class="gen">Generado: ${escapeHtml(formatDateOnly(new Date().toISOString()))}</div>
    </div>
  </div>

  <div class="kpis">
    ${kpi('Facturado', resumen.facturado, 'in')}
    ${kpi('Cobrado', resumen.cobrado, 'in')}
    ${kpi('Ganancia estimada', resumen.gananciaEstimada, 'gan')}
    ${kpi('ITBIS facturado', resumen.itbisFacturado)}
    ${kpi('ITBIS en compras', resumen.itbisCompras)}
    ${kpi('ITBIS neto a pagar', resumen.itbisNeto, resumen.itbisNeto >= 0 ? 'out' : 'in')}
    ${kpi('Compras', resumen.compras, 'out')}
    ${kpi('Gastos', resumen.gastos, 'out')}
    ${kpi('Cuentas por cobrar (hoy)', resumen.cuentasPorCobrar)}
  </div>

  <h2>ITBIS del período</h2>
  <table>
    <tbody>
      <tr><td>ITBIS facturado a clientes (débito fiscal)</td><td class="n">RD$ ${fmtMoney(resumen.itbisFacturado)}</td></tr>
      <tr><td>ITBIS pagado en compras (crédito fiscal)</td><td class="n">RD$ ${fmtMoney(resumen.itbisCompras)}</td></tr>
    </tbody>
    <tfoot><tr><td>ITBIS neto ${resumen.itbisNeto >= 0 ? 'a pagar' : 'a favor'}</td><td class="n">RD$ ${fmtMoney(Math.abs(resumen.itbisNeto))}</td></tr></tfoot>
  </table>

  <h2>Ingresos vs. egresos por mes</h2>
  <table>
    <thead><tr><th>Mes</th><th class="n">Ingresos</th><th class="n">Compras + Gastos</th><th class="n">Diferencia</th></tr></thead>
    <tbody>${serieRows}</tbody>
  </table>

  <h2>Cuentas por cobrar &mdash; pendientes al día de hoy</h2>
  <table>
    <thead><tr><th>Factura</th><th>Cliente</th><th>Vence</th><th class="n">Saldo</th></tr></thead>
    <tbody>${cxcRows}</tbody>
    <tfoot><tr><td colspan="3">Total por cobrar</td><td class="n">RD$ ${fmtMoney(resumen.cuentasPorCobrar)}</td></tr></tfoot>
  </table>

  <h2>Cuentas por pagar &mdash; pendientes al día de hoy</h2>
  <table>
    <thead><tr><th colspan="2">Suplidor</th><th>Vence</th><th class="n">Saldo</th></tr></thead>
    <tbody>${cxpRows}</tbody>
    <tfoot><tr><td colspan="3">Total por pagar</td><td class="n">RD$ ${fmtMoney(resumen.cuentasPorPagar)}</td></tr></tfoot>
  </table>

  <div class="foot">${escapeHtml(emisor.nombre)} — Reporte interno generado electrónicamente. Las cuentas por cobrar/pagar reflejan el saldo pendiente al momento de generar el reporte, no el período seleccionado.</div>
</div>
${printScript}
</body></html>`;
}

function createFlujoFinancieroRouter({ col, docData, requireAuth }) {
  const router = express.Router();

  async function fetchAndCompute(query) {
    const [fSnap, cSnap, gSnap] = await Promise.all([
      col(COL_FACTURAS).get(), col(COL_COMPRAS).get(), col(COL_GASTOS).get(),
    ]);
    const periodo = resolvePeriodo(query);
    return computeFlujo({
      facturas: fSnap.docs.map(docData),
      compras: cSnap.docs.map(docData),
      gastos: gSnap.docs.map(docData),
      periodo,
    });
  }

  router.get('/', requireAuth, async (req, res) => {
    try {
      const data = await fetchAndCompute(req.query);
      // Compatibilidad con el front actual: expone también `resumenMes`.
      res.json({ ...data, resumenMes: data.resumen });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.get('/reporte', requireAuth, async (req, res) => {
    try {
      const data = await fetchAndCompute(req.query);
      const html = await buildReporteHtml(data, col, { print: req.query.print === '1' });
      res.type('text/html').send(html);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.get('/reporte.pdf', requireAuth, async (req, res) => {
    try {
      const data = await fetchAndCompute(req.query);
      const html = await buildReporteHtml(data, col);
      const pdf = await htmlToPdf(html);
      const nombre = `flujo-${data.periodo.tipo === 'mes' ? data.periodo.endMonth : data.periodo.desde + '_a_' + data.periodo.hasta}.pdf`;
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${nombre}"`);
      res.send(pdf);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  return router;
}

module.exports = { createFlujoFinancieroRouter, computeFlujo, resolvePeriodo, buildReporteHtml };
