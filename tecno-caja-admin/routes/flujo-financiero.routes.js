'use strict';

/**
 * flujo-financiero.routes.js — Cruce de Facturación vs. Compras/Gastos
 * Solo lectura: agrega en memoria sobre las colecciones `facturas`, `compras`
 * y `gastos` (Firestore no soporta GROUP BY), mismo estilo que /api/dashboard.
 *
 * GET /api/flujo-financiero
 */

const express = require('express');

const COL_FACTURAS = 'facturas';
const COL_COMPRAS  = 'compras';
const COL_GASTOS   = 'gastos';
const MESES_SERIE  = 6;
const MESES_LABEL  = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];
const ESTADOS_PENDIENTES = ['pendiente', 'parcial'];

function monthKey(dateStr) {
  return String(dateStr || '').slice(0, 7); // "YYYY-MM"
}

function lastNMonthKeys(n) {
  const keys = [];
  const now = new Date();
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    keys.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
  }
  return keys;
}

function monthLabel(key) {
  const [y, m] = key.split('-').map(Number);
  return `${MESES_LABEL[m - 1] || key} ${y}`;
}

function createFlujoFinancieroRouter({ col, docData, requireAuth }) {
  const router = express.Router();

  router.get('/', requireAuth, async (_req, res) => {
    try {
      const [facturasSnap, comprasSnap, gastosSnap] = await Promise.all([
        col(COL_FACTURAS).get(),
        col(COL_COMPRAS).get(),
        col(COL_GASTOS).get(),
      ]);

      const facturas = facturasSnap.docs.map(docData);
      const compras  = comprasSnap.docs.map(docData);
      const gastos   = gastosSnap.docs.map(docData);

      const now = new Date();
      const mesActual = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

      // ── Resumen del mes actual ──────────────────────────────────────────
      let facturado = 0, cobrado = 0, comprasMes = 0, gastosMes = 0;

      facturas.forEach(f => {
        if (f.estado === 'anulada') return;
        if (monthKey(f.fechaEmision) === mesActual) facturado += Number(f.total || 0);
        (f.pagos || []).forEach(p => {
          if (monthKey(p.fecha) === mesActual) cobrado += Number(p.monto || 0);
        });
      });

      compras.forEach(c => {
        if (monthKey(c.fechaCompra) === mesActual) comprasMes += Number(c.total || 0);
      });

      gastos.forEach(g => {
        if (monthKey(g.fecha) === mesActual) gastosMes += Number(g.monto || 0);
      });

      const cuentasPorCobrarTotal = facturas
        .filter(f => ESTADOS_PENDIENTES.includes(f.estado))
        .reduce((sum, f) => sum + (Number(f.total || 0) - Number(f.montoPagado || 0)), 0);

      const cuentasPorPagarTotal = compras
        .filter(c => ESTADOS_PENDIENTES.includes(c.estado))
        .reduce((sum, c) => sum + (Number(c.total || 0) - Number(c.montoPagado || 0)), 0);

      const resumenMes = {
        facturado, cobrado, compras: comprasMes, gastos: gastosMes,
        gananciaEstimada: facturado - comprasMes - gastosMes,
        cuentasPorCobrar: cuentasPorCobrarTotal,
        cuentasPorPagar: cuentasPorPagarTotal,
      };

      // ── Serie mensual (últimos 6 meses) — base "facturado/comprado" ─────
      const serieMensual = lastNMonthKeys(MESES_SERIE).map(key => {
        const ingresos = facturas
          .filter(f => f.estado !== 'anulada' && monthKey(f.fechaEmision) === key)
          .reduce((sum, f) => sum + Number(f.total || 0), 0);
        const egresosCompras = compras
          .filter(c => monthKey(c.fechaCompra) === key)
          .reduce((sum, c) => sum + Number(c.total || 0), 0);
        const egresosGastos = gastos
          .filter(g => monthKey(g.fecha) === key)
          .reduce((sum, g) => sum + Number(g.monto || 0), 0);
        return { mes: key, label: monthLabel(key), ingresos, egresos: egresosCompras + egresosGastos };
      });

      // ── Detalle de cuentas por cobrar / pagar ───────────────────────────
      const cuentasPorCobrar = facturas
        .filter(f => ESTADOS_PENDIENTES.includes(f.estado))
        .map(f => ({
          id: f.id, numero: f.numero, clienteNombre: f.clienteNombre,
          saldo: Number(f.total || 0) - Number(f.montoPagado || 0),
          fechaVencimiento: f.fechaVencimiento || null,
        }))
        .sort((a, b) => String(a.fechaVencimiento || '9999').localeCompare(String(b.fechaVencimiento || '9999')));

      const cuentasPorPagar = compras
        .filter(c => ESTADOS_PENDIENTES.includes(c.estado))
        .map(c => ({
          id: c.id, suplidorNombre: c.suplidorNombre,
          saldo: Number(c.total || 0) - Number(c.montoPagado || 0),
          fechaVencimiento: c.fechaVencimiento || null,
        }))
        .sort((a, b) => String(a.fechaVencimiento || '9999').localeCompare(String(b.fechaVencimiento || '9999')));

      res.json({ resumenMes, serieMensual, cuentasPorCobrar, cuentasPorPagar });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  return router;
}

module.exports = { createFlujoFinancieroRouter };
