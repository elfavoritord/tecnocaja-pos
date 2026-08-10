'use strict';
/**
 * Módulo de integración WhatsApp Bot para Tecno Caja POS.
 * Se inicializa desde server.js y expone estado/control vía API.
 */

const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const QRCode    = require('qrcode');
const Anthropic = require('@anthropic-ai/sdk');
const productsCache = require('../cache/products-cache');
const { resolveActivePromotions, computePromotionStatus } = require('../services/promotion-engine');
const { generateWhatsAppReport, resolveDateRange } = require('../services/whatsapp-report.service');

const fs   = require('fs');
const path = require('path');

let _db             = null;
let _io             = null;
let _client         = null;
let _aiConfig       = null;
let _googleTokens   = null;
let _instructions   = '';
let _businessHours  = '';
let _taxRate        = 18; // ITBIS por defecto (RD) — se recarga desde config en start()
let _businessName   = ''; // config.business_name real — se recarga desde config en start()
let _businessType   = ''; // config.business_type (rubro, ej. "farmacia") — se recarga en start()
let _customerInstructions = ''; // reglas/tono libres para el flujo de clientes (wabot_customer_instructions)
let _customerAiEnabled    = false; // toggle propio, independiente de la IA del dueño (wabot_customer_ai_enabled)
let _chromePid      = null;
let _startTimeoutId = null;
let _readyTimeoutId = null;

// Inyectadas desde server.js vía setDependencies() — insertQuotationRow y
// writeAuditLog viven ahí y este módulo no puede hacer require() de vuelta
// (server.js es quien hace require() de este archivo, sería circular).
let _insertQuotationRow = null;
let _writeAuditLog      = null;
let _mapQuotationRow    = null;
let _insertClientRow    = null;
let _findClientByPhone  = null;
let _findClientByJid    = null;
let _updateClientAddress = null;
let _updateClientLocation = null;
let _updateClientPhone   = null;
let _updateClientJid     = null;
let _getClientById       = null;

const SESSION_DIR = path.join(process.cwd(), '.wwebjs_auth_pos', 'session-tecno-caja-pos-bot');
const PID_FILE    = path.join(process.cwd(), '.wwebjs_auth_pos', 'chrome.pid');
const LOCK_FILE   = path.join(SESSION_DIR, 'lockfile');
const SINGLETON   = path.join(SESSION_DIR, 'SingletonLock');

function killStaleBrowser() {
  // Matar PID guardado del Chromium anterior
  try {
    if (fs.existsSync(PID_FILE)) {
      const pid = parseInt(fs.readFileSync(PID_FILE, 'utf8').trim(), 10);
      if (pid) { try { process.kill(pid, 'SIGKILL'); } catch {} }
      fs.unlinkSync(PID_FILE);
    }
  } catch {}
  // Matar PID actual si lo tenemos en memoria
  if (_chromePid) {
    try { process.kill(_chromePid, 'SIGKILL'); } catch {}
    _chromePid = null;
  }
  // Limpiar archivos de bloqueo
  [LOCK_FILE, SINGLETON].forEach(f => { try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch {} });
}

// Forzar exit_type=Normal en el perfil de Chrome antes de lanzarlo. El SIGKILL
// de killStaleBrowser()/stop() deja el perfil marcado como "Crashed", y Chrome
// hace un escaneo de recuperación de sesión en el próximo arranque que puede
// sumar varios segundos — justo el síntoma de "tarda mucho para iniciar ya
// estando conectado". Como este bot siempre corre headless y sin pestañas que
// valga la pena restaurar, es seguro decirle a Chrome que el cierre anterior
// fue limpio y saltarse ese escaneo.
function markProfileCleanExit() {
  try {
    const prefsPath = path.join(SESSION_DIR, 'Default', 'Preferences');
    if (!fs.existsSync(prefsPath)) return;
    const prefs = JSON.parse(fs.readFileSync(prefsPath, 'utf8'));
    if (prefs.profile) {
      prefs.profile.exit_type = 'Normal';
      prefs.profile.exited_cleanly = true;
      fs.writeFileSync(prefsPath, JSON.stringify(prefs));
    }
  } catch {}
}

async function setGoogleTokens(tokens) {
  _googleTokens = tokens;
  // Persistir en DB para sobrevivir reinicios
  if (_db && tokens) {
    try {
      const enc = Buffer.from(JSON.stringify(tokens)).toString('base64');
      await _db(`INSERT INTO offline_cache_config (config_key,config_value) VALUES ('wabot_google_tokens',?) ON DUPLICATE KEY UPDATE config_value=?`, [enc, enc]);
    } catch {}
  }
}

// ── Estado central ─────────────────────────────────────────────────────────────
const state = {
  status:      'stopped',   // stopped | starting | qr | ready | disconnected
  qrDataUrl:   null,
  connectedAs: null,
  ownerJids:   [],          // JIDs autorizados (principal + secundario)
  ownerPhone:  null,
  ownerPhone2: null,
  messages:    [],          // últimos 30 mensajes {dir, text, ts}
};
const historial = [];       // historial de conversacion del dueno
const pendingOwnerAttachments = new Map(); // jid -> archivos generados localmente pendientes de envio

// ── Sesiones de clientes (flujo de menú fijo, sin IA) ─────────────────────────
const customerSessions = new Map(); // jid -> { step, cart, customerName, orderType, address, lastResults, lastActivityAt }
const SESSION_TIMEOUT_MS = 15 * 60 * 1000;

// ── Comprobantes de transferencia pendientes de confirmar por el dueño ────────
// code -> jid del cliente. Vive aparte de customerSessions porque el dueño
// puede tardar más de SESSION_TIMEOUT_MS en revisar el comprobante — la sesión
// del cliente en ese paso usa un timeout más largo (ver getOrCreateSession/barrido
// más abajo) para no perder el carrito mientras espera.
const pendingVouchers = new Map();
let voucherCounter = 0;
const VOUCHER_CONFIRMATION_TIMEOUT_MS = 6 * 60 * 60 * 1000; // 6h de margen para que el dueño confirme

function generateVoucherCode() {
  voucherCounter += 1;
  return `V${voucherCounter}`;
}

function getOrCreateSession(jid) {
  const existing = customerSessions.get(jid);
  const now = Date.now();
  const limit = existing?.step === 'awaiting_voucher_confirmation' ? VOUCHER_CONFIRMATION_TIMEOUT_MS : SESSION_TIMEOUT_MS;
  if (existing && (now - existing.lastActivityAt) <= limit) {
    existing.lastActivityAt = now;
    return existing;
  }
  const fresh = {
    step: 'menu', cart: [], customerName: '', customerPhone: '', orderType: '', address: '',
    lastResults: [], ordering: false, lastActivityAt: now,
    clientId: null, knownAddress: '', knownPhone: '',
    locationLink: '', locationLat: null, locationLng: null, knownLocationLink: '',
    paymentMethodPreference: '', paymentMethodLabel: '', knownCreditLimit: 0,
    voucherCode: '', customerNote: ''
  };
  customerSessions.set(jid, fresh);
  return fresh;
}

function resetSession(jid) {
  const session = customerSessions.get(jid);
  if (session?.voucherCode) pendingVouchers.delete(session.voucherCode);
  customerSessions.delete(jid);
}

// Barrido periódico para que el Map nunca crezca sin límite aunque alguien
// abandone el flujo a medias sin enviar más mensajes.
const _sessionSweepInterval = setInterval(() => {
  const now = Date.now();
  for (const [jid, session] of customerSessions.entries()) {
    const limit = session.step === 'awaiting_voucher_confirmation' ? VOUCHER_CONFIRMATION_TIMEOUT_MS : SESSION_TIMEOUT_MS;
    if (now - session.lastActivityAt > limit) {
      if (session.voucherCode) pendingVouchers.delete(session.voucherCode);
      customerSessions.delete(jid);
    }
  }
}, 5 * 60 * 1000);
_sessionSweepInterval.unref?.();

function pushState() {
  if (_io) _io.emit('wa_bot_state', getSafeState());
  // Bajo Electron, lanzar Chrome via Puppeteer puede dejar la ventana pintada
  // en blanco de forma permanente (ver electron/main.js). global.__forceRepaint
  // es un no-op fuera de Electron (ej. `npm start` standalone).
  global.__forceRepaint?.();
}

function addMessage(dir, text) {
  state.messages.unshift({ dir, text: text?.substring(0, 200), ts: new Date().toISOString() });
  if (state.messages.length > 30) state.messages.pop();
  pushState();
}

function getSafeState() {
  return {
    status:      state.status,
    connectedAs: state.connectedAs,
    ownerPhone:  state.ownerPhone,
    ownerPhone2: state.ownerPhone2,
    qrDataUrl:   state.status === 'qr' ? state.qrDataUrl : null,
    messages:    state.messages,
  };
}

// ── Utilidad de formato monetario (RD$) ───────────────────────────────────────
const fmt = (n) => `RD$ ${Number(n || 0).toLocaleString('es-DO', { minimumFractionDigits: 2 })}`;

// ── Centro de Promociones — mismo motor que usa el POS (server/services/
// promotion-engine.js) y el checkout (POST /api/sales), para que el cliente
// vea en el chat exactamente el mismo precio que después le van a cobrar.
// Sin caché propia: es una sola consulta liviana, y el bot ya se toma su
// tiempo por cada mensaje (Claude de por medio), así que no vale la pena la
// complejidad de invalidar una caché aparte.
async function getActivePromotionsMap() {
  if (!_db) return {};
  try {
    return await resolveActivePromotions({ query: _db });
  } catch (_e) {
    return {};
  }
}

// ── Datos del negocio (lee de MariaDB — fuente de verdad) ─────────────────────
async function getBusinessData(msg = '') {
  if (!_db) return null;
  const q = (sql, p) => _db(sql, p);

  try {
    const [[stats]] = await Promise.all([q(`
      SELECT
        /* ── Hoy ── */
        COALESCE((SELECT SUM(total) FROM sales WHERE sale_status='pagada' AND COALESCE(fiscal_status,'emitida')<>'cancelada' AND DATE(created_at)=CURDATE()),0)                               AS ventas_hoy,
        COALESCE((SELECT COUNT(*) FROM sales WHERE sale_status='pagada' AND COALESCE(fiscal_status,'emitida')<>'cancelada' AND DATE(created_at)=CURDATE()),0)                                AS facturas_hoy,
        COALESCE((SELECT SUM(tax) FROM sales WHERE sale_status='pagada' AND COALESCE(fiscal_status,'emitida')<>'cancelada' AND DATE(created_at)=CURDATE()),0)                               AS itbis_hoy,
        COALESCE((SELECT SUM(total) FROM sales WHERE sale_status='pagada' AND COALESCE(fiscal_status,'emitida')<>'cancelada' AND DATE(created_at)=CURDATE() AND payment_method='efectivo'),0)     AS efectivo_hoy,
        COALESCE((SELECT SUM(total) FROM sales WHERE sale_status='pagada' AND COALESCE(fiscal_status,'emitida')<>'cancelada' AND DATE(created_at)=CURDATE() AND payment_method='tarjeta'),0)      AS tarjeta_hoy,
        COALESCE((SELECT SUM(total) FROM sales WHERE sale_status='pagada' AND COALESCE(fiscal_status,'emitida')<>'cancelada' AND DATE(created_at)=CURDATE() AND payment_method='transferencia'),0) AS transferencia_hoy,
        COALESCE((SELECT SUM(total) FROM sales WHERE sale_status='pagada' AND COALESCE(fiscal_status,'emitida')<>'cancelada' AND DATE(created_at)=CURDATE() AND payment_method='credito'),0)      AS credito_hoy,
        COALESCE((SELECT COUNT(*) FROM sales WHERE DATE(created_at)=CURDATE() AND (sale_status='cancelada' OR fiscal_status='cancelada')),0)                                                 AS canceladas_hoy,
        TIMESTAMPDIFF(MINUTE,(SELECT MAX(created_at) FROM sales WHERE sale_status='pagada' AND COALESCE(fiscal_status,'emitida')<>'cancelada' AND DATE(created_at)=CURDATE()),NOW())         AS mins_ultima_venta,
        /* ── Ayer ── */
        COALESCE((SELECT SUM(total) FROM sales WHERE sale_status='pagada' AND COALESCE(fiscal_status,'emitida')<>'cancelada' AND DATE(created_at)=DATE_SUB(CURDATE(),INTERVAL 1 DAY)),0)    AS ventas_ayer,
        COALESCE((SELECT COUNT(*) FROM sales WHERE sale_status='pagada' AND COALESCE(fiscal_status,'emitida')<>'cancelada' AND DATE(created_at)=DATE_SUB(CURDATE(),INTERVAL 1 DAY)),0)      AS facturas_ayer,
        /* ── Mes ── */
        COALESCE((SELECT SUM(total) FROM sales WHERE sale_status='pagada' AND COALESCE(fiscal_status,'emitida')<>'cancelada' AND DATE(created_at)>=DATE_FORMAT(CURDATE(),'%Y-%m-01')),0)    AS ventas_mes,
        COALESCE((SELECT COUNT(*) FROM sales WHERE sale_status='pagada' AND COALESCE(fiscal_status,'emitida')<>'cancelada' AND DATE(created_at)>=DATE_FORMAT(CURDATE(),'%Y-%m-01')),0)      AS facturas_mes,
        COALESCE((SELECT SUM(tax) FROM sales WHERE sale_status='pagada' AND COALESCE(fiscal_status,'emitida')<>'cancelada' AND DATE(created_at)>=DATE_FORMAT(CURDATE(),'%Y-%m-01')),0)      AS itbis_mes,
        /* ── Mes anterior ── */
        COALESCE((SELECT SUM(total) FROM sales WHERE sale_status='pagada' AND COALESCE(fiscal_status,'emitida')<>'cancelada' AND DATE(created_at)>=DATE_FORMAT(DATE_SUB(CURDATE(),INTERVAL 1 MONTH),'%Y-%m-01') AND DATE(created_at)<DATE_FORMAT(CURDATE(),'%Y-%m-01')),0) AS ventas_mes_anterior,
        /* ── Inventario ── */
        (SELECT COUNT(*) FROM products WHERE LOWER(estado)='activo')                                                                                                                         AS productos_activos,
        (SELECT COUNT(*) FROM products WHERE LOWER(estado)='activo' AND stock_min>0 AND stock<=stock_min)                                                                                    AS bajo_stock,
        (SELECT COUNT(*) FROM products WHERE LOWER(estado)='activo' AND stock<=0)                                                                                                            AS sin_stock,
        COALESCE((SELECT SUM(stock*precio_compra) FROM products WHERE LOWER(estado)='activo' AND stock>0),0)                                                                                 AS valor_inventario,
        /* ── Clientes ── */
        (SELECT COUNT(*) FROM clients)                                                                                                                                                        AS clientes_total,
        /* ── CxC ── */
        COALESCE((SELECT SUM(COALESCE(total,0)-COALESCE(received_amount,0)) FROM sales WHERE payment_method='credito' AND sale_status='pagada' AND COALESCE(fiscal_status,'emitida')<>'cancelada' AND COALESCE(total,0) > COALESCE(received_amount,0)),0) AS cxc_pendiente,
        /* ── Cajas ── */
        (SELECT COUNT(*) FROM cash_sessions WHERE status='open')                                                                                                                              AS cajas_abiertas
    `)]);

    // ── Métricas calculadas ────────────────────────────────────────────────
    const ultimaVenta = stats.mins_ultima_venta !== null
      ? (stats.mins_ultima_venta < 1 ? 'hace menos de 1 min'
        : stats.mins_ultima_venta < 60 ? `hace ${stats.mins_ultima_venta} min`
        : `hace ${Math.round(stats.mins_ultima_venta / 60)}h`)
      : 'sin ventas hoy';

    const pctVsAyer = stats.ventas_ayer > 0
      ? ((stats.ventas_hoy - stats.ventas_ayer) / stats.ventas_ayer * 100) : null;
    const cambioAyer = pctVsAyer !== null
      ? (pctVsAyer >= 0 ? `📈 +${pctVsAyer.toFixed(1)}% vs ayer` : `📉 ${pctVsAyer.toFixed(1)}% vs ayer`) : '';

    const pctVsMesAnterior = stats.ventas_mes_anterior > 0
      ? ((stats.ventas_mes - stats.ventas_mes_anterior) / stats.ventas_mes_anterior * 100) : null;
    const cambioMes = pctVsMesAnterior !== null
      ? (pctVsMesAnterior >= 0 ? `📈 +${pctVsMesAnterior.toFixed(1)}% vs mes ant.` : `📉 ${pctVsMesAnterior.toFixed(1)}% vs mes ant.`) : '';

    // ── Datos condicionales según pregunta ────────────────────────────────
    const t = msg.toLowerCase();
    const extras = {};

    if (t.match(/stock|inventario|producto|falt|agot|queda|precio/)) {
      extras.bajosStock = await q(`
        SELECT nombre, stock, stock_min AS minimo, precio_venta,
          CASE WHEN stock<=0 THEN 'SIN STOCK' ELSE 'BAJO' END AS alerta
        FROM products WHERE LOWER(estado)='activo' AND stock_min>0 AND stock<=stock_min
        ORDER BY stock ASC LIMIT 10`);
    }
    if (t.match(/top|popular|vend|mejor|más|mas/)) {
      extras.topProductos = await q(`
        SELECT p.nombre, COALESCE(SUM(si.qty),0) AS vendidos, COALESCE(SUM(si.line_total),0) AS total_vendido
        FROM products p
        LEFT JOIN sale_items si ON si.product_id=p.id
        LEFT JOIN sales s ON si.sale_id=s.id AND s.sale_status='pagada' AND DATE(s.created_at)>=DATE_SUB(CURDATE(),INTERVAL 30 DAY)
        WHERE LOWER(p.estado)='activo'
        GROUP BY p.id ORDER BY vendidos DESC LIMIT 5`);
    }
    if (t.match(/hoy.*top|top.*hoy|vendido.*hoy|hoy.*vend/)) {
      extras.topProductosHoy = await q(`
        SELECT p.nombre, COALESCE(SUM(si.qty),0) AS vendidos, COALESCE(SUM(si.line_total),0) AS total_vendido
        FROM products p
        LEFT JOIN sale_items si ON si.product_id=p.id
        LEFT JOIN sales s ON si.sale_id=s.id AND s.sale_status='pagada' AND DATE(s.created_at)=CURDATE()
        WHERE LOWER(p.estado)='activo'
        GROUP BY p.id HAVING vendidos>0 ORDER BY vendidos DESC LIMIT 5`);
    }
    if (t.match(/cxc|deu|cobr|crédit|credito/)) {
      extras.cxc = await q(`
        SELECT COALESCE(s.client_name_snapshot, c.nombre, '—') AS cliente,
               COALESCE(s.client_phone_snapshot, c.telefono, '—') AS telefono,
               SUM(COALESCE(s.total,0)-COALESCE(s.received_amount,0)) AS deuda
        FROM sales s LEFT JOIN clients c ON s.client_id=c.id
        WHERE s.payment_method='credito' AND s.sale_status='pagada'
          AND COALESCE(s.fiscal_status,'emitida')<>'cancelada'
          AND COALESCE(s.total,0) > COALESCE(s.received_amount,0)
        GROUP BY s.client_id ORDER BY deuda DESC LIMIT 7`);
    }
    if (t.match(/proveedor|suplidor/)) {
      extras.proveedores = await q(`
        SELECT s.nombre, s.telefono, s.visit_days,
               COALESCE(SUM(CASE WHEN si.pending_amount > 0 THEN si.pending_amount ELSE 0 END), 0) AS deuda,
               COUNT(CASE WHEN si.pending_amount > 0 THEN 1 END) AS facturas_pendientes
        FROM suppliers s
        LEFT JOIN supplier_invoices si ON si.supplier_id = s.id
        WHERE LOWER(s.estado) = 'activo'
        GROUP BY s.id
        ORDER BY deuda DESC
        LIMIT 10`);
    }
    if (t.match(/cajero|empleado|vendedor|quien|quién/)) {
      extras.cajeros = await q(`
        SELECT COALESCE(u.nombre,'Desconocido') AS cajero,
               COUNT(*) AS facturas, SUM(s.total) AS ventas
        FROM sales s LEFT JOIN users u ON s.user_id=u.id
        WHERE s.sale_status='pagada' AND COALESCE(s.fiscal_status,'emitida')<>'cancelada'
          AND DATE(s.created_at)=CURDATE()
        GROUP BY s.user_id ORDER BY ventas DESC LIMIT 6`);
    }
    if (t.match(/gasto|egreso|retiro|salida|movimiento|caja.*gasto|cuanto.*retir/)) {
      extras.movimientos = await q(`
        SELECT movement_type AS tipo, SUM(amount) AS total, COUNT(*) AS cant
        FROM cash_movements
        WHERE LOWER(movement_type) NOT IN ('ingreso','apertura','venta','cobro')
          AND DATE(happened_at)=CURDATE() AND amount>0
        GROUP BY movement_type ORDER BY total DESC LIMIT 8`);
    }
    if (t.match(/hora|tendencia|tráfico|trafico|momento|pico|cuando más|cuando mas/)) {
      extras.horas = await q(`
        SELECT HOUR(created_at) AS hora, COUNT(*) AS facturas, SUM(total) AS total
        FROM sales WHERE sale_status='pagada' AND COALESCE(fiscal_status,'emitida')<>'cancelada'
          AND DATE(created_at)=CURDATE()
        GROUP BY HOUR(created_at) ORDER BY hora`);
    }
    if (t.match(/cliente|comprador|frecuente/)) {
      extras.topClientes = await q(`
        SELECT COALESCE(s.client_name_snapshot, c.nombre, 'Sin nombre') AS cliente,
               c.cedula AS cedula, c.telefono AS telefono,
               COUNT(*) AS compras, SUM(s.total) AS gastado
        FROM sales s LEFT JOIN clients c ON s.client_id=c.id
        WHERE s.sale_status='pagada' AND COALESCE(s.fiscal_status,'emitida')<>'cancelada'
          AND DATE(s.created_at)>=DATE_FORMAT(CURDATE(),'%Y-%m-01')
          AND s.client_id IS NOT NULL
        GROUP BY s.client_id ORDER BY gastado DESC LIMIT 5`);
    }
    if (t.match(/caja|turno|apertura|cierre|abiert/)) {
      extras.cajas = await q(`
        SELECT cs.opened_by_user_name, cs.opened_at, cs.expected_amount,
               cr.nombre AS caja_nombre, b.nombre AS sucursal
        FROM cash_sessions cs
        LEFT JOIN cash_registers cr ON cs.cash_register_id=cr.id
        LEFT JOIN branches b ON cs.branch_id=b.id
        WHERE cs.status='open' LIMIT 5`);
    }
    if (t.match(/semana|semanal/)) {
      extras.semana = await q(`
        SELECT DATE(created_at) AS dia, SUM(total) AS total, COUNT(*) AS facturas
        FROM sales WHERE sale_status='pagada' AND COALESCE(fiscal_status,'emitida')<>'cancelada'
          AND created_at>=DATE_SUB(CURDATE(), INTERVAL DAYOFWEEK(CURDATE())-2 DAY)
        GROUP BY DATE(created_at) ORDER BY dia`);
    }
    if (t.match(/ultima|último|última|reciente/)) {
      extras.ultimas = await q(`
        SELECT s.invoice_number, s.total, s.payment_method, s.created_at,
               COALESCE(s.client_name_snapshot, c.nombre, 'Sin cliente') AS cliente
        FROM sales s LEFT JOIN clients c ON s.client_id=c.id
        WHERE s.sale_status='pagada' AND COALESCE(s.fiscal_status,'emitida')<>'cancelada'
          AND DATE(s.created_at)=CURDATE()
        ORDER BY s.created_at DESC LIMIT 5`);
    }

    // ── Objeto estructurado (para mensajes de comandos) ────────────────────
    const d = {
      ventasHoy: stats.ventas_hoy, facturasHoy: stats.facturas_hoy,
      ultimaVenta, cambioAyer, pctVsAyer,
      ventasAyer: stats.ventas_ayer, facturasAyer: stats.facturas_ayer,
      efectivoHoy: stats.efectivo_hoy, tarjetaHoy: stats.tarjeta_hoy,
      transferenciaHoy: stats.transferencia_hoy, creditoHoy: stats.credito_hoy,
      itbisHoy: stats.itbis_hoy, canceladasHoy: stats.canceladas_hoy,
      ventasMes: stats.ventas_mes, facturasMes: stats.facturas_mes,
      itbisMes: stats.itbis_mes, cambioMes, pctVsMesAnterior,
      ventasMesAnterior: stats.ventas_mes_anterior,
      productosActivos: stats.productos_activos, bajoStock: stats.bajo_stock,
      sinStock: stats.sin_stock, valorInventario: stats.valor_inventario,
      clientesTotal: stats.clientes_total, cxcPendiente: stats.cxc_pendiente,
      cajasAbiertas: stats.cajas_abiertas,
      ...extras,
    };

    // ── Texto para IA (contexto enriquecido) ──────────────────────────────
    let extraText = '';
    if (extras.bajosStock?.length) extraText += `\nALERTAS STOCK:\n${extras.bajosStock.map(p=>`- ${p.nombre}: ${p.stock} uds [${p.alerta}]`).join('\n')}`;
    if (extras.topProductos?.length) extraText += `\nTOP PRODUCTOS (30d):\n${extras.topProductos.map((p,i)=>`${i+1}. ${p.nombre}: ${Number(p.vendidos).toFixed(0)} uds (${fmt(p.total_vendido)})`).join('\n')}`;
    if (extras.topProductosHoy?.length) extraText += `\nTOP HOY:\n${extras.topProductosHoy.map((p,i)=>`${i+1}. ${p.nombre}: ${Number(p.vendidos).toFixed(0)} uds (${fmt(p.total_vendido)})`).join('\n')}`;
    if (extras.cxc?.length) extraText += `\nCXC DEUDORES:\n${extras.cxc.map(r=>`- ${r.cliente}: ${fmt(r.deuda)} (${r.telefono})`).join('\n')}`;
    if (extras.proveedores?.length) extraText += `\nPROVEEDORES:\n${extras.proveedores.map(p=>`- ${p.nombre}${p.telefono ? ` (${p.telefono})` : ''}${p.visit_days ? ` — visita: ${p.visit_days}` : ''}: ${p.deuda > 0 ? `debe ${fmt(p.deuda)} (${p.facturas_pendientes} fact. pend.)` : 'sin deuda pendiente'}`).join('\n')}`;
    if (extras.cajeros?.length) extraText += `\nCAJEROS HOY:\n${extras.cajeros.map(r=>`- ${r.cajero}: ${r.facturas} fact. ${fmt(r.ventas)}`).join('\n')}`;
    if (extras.movimientos?.length) extraText += `\nEGRESOS HOY:\n${extras.movimientos.map(g=>`- ${g.tipo}: ${fmt(g.total)} (${g.cant} mov.)`).join('\n')}`;
    if (extras.horas?.length) { const pk=extras.horas.reduce((a,b)=>b.total>a.total?b:a,extras.horas[0]); extraText += `\nHORAS HOY:\n${extras.horas.map(h=>`- ${String(h.hora).padStart(2,'0')}:00 → ${h.facturas} fact. ${fmt(h.total)}`).join('\n')}\nPico: ${String(pk.hora).padStart(2,'0')}:00`; }
    if (extras.topClientes?.length) extraText += `\nTOP CLIENTES MES:\n${extras.topClientes.map(c=>`- ${c.cliente} (cedula/RNC: ${c.cedula || 'no registrada'}, tel: ${c.telefono || '-'}): ${c.compras} compras ${fmt(c.gastado)}`).join('\n')}`;
    if (extras.cajas?.length) extraText += `\nCAJAS ABIERTAS:\n${extras.cajas.map(c=>`- ${c.caja_nombre||'Caja'}: ${c.opened_by_user_name} (${fmt(c.expected_amount)})`).join('\n')}`;
    if (extras.semana?.length) { const dias=['Dom','Lun','Mar','Mié','Jue','Vie','Sáb']; extraText += `\nSEMANA:\n${extras.semana.map(d=>{const dt=new Date(d.dia);return `- ${dias[dt.getDay()]} ${dt.getDate()}: ${fmt(d.total)} (${d.facturas} fact.)`;}).join('\n')}`; }
    if (extras.ultimas?.length) extraText += `\nÚLTIMAS VENTAS:\n${extras.ultimas.map(v=>`- ${v.invoice_number}: ${fmt(v.total)} (${v.payment_method}) ${new Date(v.created_at).toLocaleTimeString('es-DO',{hour:'2-digit',minute:'2-digit'})}`).join('\n')}`;

    const text = `DATOS DEL NEGOCIO (tiempo real):
VENTAS HOY: ${fmt(stats.ventas_hoy)} (${stats.facturas_hoy} fact.) — ${ultimaVenta} | vs ayer: ${fmt(stats.ventas_ayer)} (${cambioAyer})
MÉTODOS: Efectivo ${fmt(stats.efectivo_hoy)} | Tarjeta ${fmt(stats.tarjeta_hoy)} | Transfer. ${fmt(stats.transferencia_hoy)} | Crédito ${fmt(stats.credito_hoy)}
ITBIS hoy: ${fmt(stats.itbis_hoy)} | Canceladas: ${stats.canceladas_hoy}
MES: ${fmt(stats.ventas_mes)} (${stats.facturas_mes} fact.) ${cambioMes} | ITBIS: ${fmt(stats.itbis_mes)}
INVENTARIO: ${stats.productos_activos} productos activos | Bajo stock: ${stats.bajo_stock} | Sin stock: ${stats.sin_stock} | Valor: ${fmt(stats.valor_inventario)}
FINANZAS: ${stats.clientes_total} clientes | CxC: ${fmt(stats.cxc_pendiente)} | Cajas abiertas: ${stats.cajas_abiertas}${extraText}`;

    return { d, text };
  } catch (e) {
    console.error('[wa-bot] Error leyendo datos:', e.message);
    return null;
  }
}

// ── System Prompt enriquecido ─────────────────────────────────────────────────
const SYSTEM_PROMPT = (ctx) => {
  const base = `Eres el asistente oficial de *Tecno Caja POS*, con acceso en tiempo real a los datos del negocio. Respondes al dueño a través de WhatsApp con información precisa y profesional.

FORMATO DE RESPUESTA (obligatorio):
- Responde en español formal pero claro
- Máximo 15 líneas por respuesta
- Usa *negrita* para cifras importantes, totales y títulos de sección
- Usa RD$ para todos los valores monetarios
- Separa las secciones con una línea en blanco para mejor legibilidad
- Emojis solo donde aporten claridad (no en exceso)
- Si hay datos comparativos, incluye siempre el porcentaje de variación
- Si detectas alertas críticas (stock agotado, CxC elevada, caída de ventas), menciónalas al inicio
- NUNCA inventes cifras — solo usa los datos del contexto proporcionado
- Si un dato no está disponible, indícalo claramente

CONTEXTO DEL NEGOCIO:
- Sistema: Tecno Caja POS | Moneda: Peso Dominicano (RD$)
- Mercado: República Dominicana`;

  const custom = _instructions ? `\n\nINSTRUCCIONES DEL NEGOCIO:\n${_instructions}` : '';
  const data = `\n\nDATOS EN TIEMPO REAL:\n${ctx || '⚠️ Sin conexión a datos del POS.'}`;
  return base + custom + data;
};

// ══════════════════════════════════════════════════════════════════════════
// Herramientas de promociones (tool use) — solo se ofrecen cuando el
// proveedor de IA es Claude (único que soporta tool use en este bot). Dejan
// que el dueño cree/active/desactive promociones de precio por WhatsApp con
// las mismas reglas que el Centro de Promociones de la PC
// (server/routes/promotions.routes.js), pero llamando la base de datos
// directamente — el bot corre en el mismo proceso que el servidor, así que
// no hace falta un viaje HTTP de ida y vuelta ni un token de sesión.
// ══════════════════════════════════════════════════════════════════════════

const PROMOTIONS_TOOL_GUIDANCE = `

HERRAMIENTAS DE PROMOCIONES:
Puedes crear, activar y desactivar promociones de precio directamente desde este chat — el dueño puede pedírtelo en lenguaje natural (ej: "desactiva la oferta de la Coca Cola", "pon el arroz a 150 hasta el viernes", "qué promociones hay activas").
- Antes de crear una promoción, usa buscar_productos para confirmar el producto exacto y su precio normal. NUNCA inventes un productoId.
- Antes de activar/desactivar una promoción, usa listar_promociones para encontrar el promotionId correcto. NUNCA inventes un promotionId.
- Si hay varios productos o promociones que coinciden con lo que pidió el dueño, pregúntale cuál es antes de ejecutar nada — no adivines.
- Si falta el precio de oferta, o la fecha de fin cuando la promoción no es permanente, pregúntale al dueño antes de crear la promoción.
- Después de ejecutar una herramienta, confirma en una frase clara qué se hizo (producto, precio anterior, precio nuevo, o si quedó activada/desactivada).
- Si una herramienta devuelve un error, explícaselo al dueño en lenguaje simple y sugiere cómo corregirlo — no repitas la misma llamada sin corregir el dato que falló.
- Usa evaluar_promociones cuando el dueño pregunte si una promoción vale la pena, si está funcionando, o si conviene cambiarla/quitarla. Si el resultado marca datosInsuficientes en true para algún producto, dilo claramente en vez de forzar una conclusión — no hay suficiente historial de ventas antes de la promoción para comparar con confianza.`;

const PROMOTION_TOOLS = [
  {
    name: 'buscar_productos',
    description: 'Busca productos activos del catálogo por nombre o código para encontrar el producto exacto antes de crear una promoción. Úsalo SIEMPRE antes de crear_promocion si no tienes ya el productoId exacto — nunca lo inventes.',
    input_schema: {
      type: 'object',
      properties: {
        busqueda: { type: 'string', description: 'Nombre o parte del nombre/código del producto a buscar, ej: "coca cola" o "arroz".' },
      },
      required: ['busqueda'],
    },
  },
  {
    name: 'listar_promociones',
    description: 'Lista las promociones existentes con su estado (activa, programada, vencida, deshabilitada), producto y precios. Úsalo para encontrar el promotionId de una promoción por nombre de producto, o cuando el dueño pregunta qué promociones hay.',
    input_schema: {
      type: 'object',
      properties: {
        estado: {
          type: 'string',
          enum: ['activa', 'programada', 'vencida', 'deshabilitada', 'todas'],
          description: 'Filtrar por estado. Usa "todas" si el dueño no pidió un estado específico.',
        },
      },
    },
  },
  {
    name: 'crear_promocion',
    description: 'Crea una nueva promoción de "oferta de precio" para UN producto ya existente. El productoId debe venir de una llamada previa a buscar_productos. El precio de oferta debe ser menor al precio normal del producto.',
    input_schema: {
      type: 'object',
      properties: {
        productoId: { type: 'integer', description: 'ID del producto, obtenido de buscar_productos.' },
        precioPromocion: { type: 'number', description: 'Precio de oferta en RD$, debe ser menor al precio normal del producto.' },
        nombre: { type: 'string', description: 'Nombre corto de la promoción, ej: "Oferta Coca Cola". Si se omite, se genera uno automático.' },
        permanente: { type: 'boolean', description: 'true si la promoción no tiene fecha de fin. Por defecto false.' },
        fechaInicio: { type: 'string', description: 'Fecha de inicio en formato YYYY-MM-DD. Si se omite, inicia hoy mismo.' },
        fechaFin: { type: 'string', description: 'Fecha de fin en formato YYYY-MM-DD. Pregúntale al dueño si no es permanente y no la dio.' },
        textoPromocion: { type: 'string', description: 'Texto corto para el badge visible en el POS, ej: "OFERTA" o "2x1". Opcional.' },
      },
      required: ['productoId', 'precioPromocion'],
    },
  },
  {
    name: 'cambiar_estado_promocion',
    description: 'Activa o desactiva una promoción existente por su ID. El promotionId debe venir de una llamada previa a listar_promociones — nunca lo inventes.',
    input_schema: {
      type: 'object',
      properties: {
        promotionId: { type: 'integer', description: 'ID de la promoción, obtenido de listar_promociones.' },
        activar: { type: 'boolean', description: 'true para activar la promoción, false para desactivarla.' },
      },
      required: ['promotionId', 'activar'],
    },
  },
  {
    name: 'evaluar_promociones',
    description: 'Compara, para una promocion de precio activa (o todas las activas si no se especifica), las unidades vendidas y el margen bruto durante la promocion contra un periodo equivalente inmediatamente anterior, para ayudar a decidir si vale la pena mantenerla. Usala cuando el dueno pregunte si una promocion vale la pena, esta funcionando, o si hay que cambiarla/quitarla.',
    input_schema: {
      type: 'object',
      properties: {
        promotionId: { type: 'integer', description: 'ID de una promocion especifica (de listar_promociones). Si se omite, evalua todas las promociones activas de tipo oferta_precio.' },
        dias: { type: 'integer', description: 'Tamano de la ventana de comparacion en dias. Por defecto 30, tope 90.' },
      },
    },
  },
];

const REPORT_TOOL_GUIDANCE = `

HERRAMIENTAS DE REPORTES:
- Cuando el dueno pida crear, preparar o enviar un reporte, usa generar_reporte.
- Puedes generar reportes de ventas, inventario, clientes, cuentas por cobrar, caja o un reporte completo.
- Respeta el formato solicitado: PDF, Excel o CSV. Si no indica formato, usa PDF.
- Respeta el periodo solicitado. Para fechas exactas usa periodo "personalizado" y fechas YYYY-MM-DD.
- Los reportes se crean dentro de Tecno Caja y se adjuntan al WhatsApp autorizado. No afirmes que se envio hasta que la herramienta confirme que fue preparado.
- No uses esta herramienta para una pregunta simple que se pueda responder directamente en el chat.`;

const REPORT_TOOLS = [
  {
    name: 'generar_reporte',
    description: 'Genera y adjunta al WhatsApp del dueno un reporte del POS. Usala cuando pidan un archivo PDF, Excel/XLSX o CSV.',
    input_schema: {
      type: 'object',
      properties: {
        tipo: {
          type: 'string',
          enum: ['ventas', 'inventario', 'clientes', 'cuentas_cobrar', 'caja', 'completo'],
          description: 'Contenido principal del reporte.',
        },
        formato: {
          type: 'string',
          enum: ['pdf', 'xlsx', 'csv'],
          description: 'Formato del archivo. Convierte la palabra Excel a xlsx.',
        },
        periodo: {
          type: 'string',
          enum: ['hoy', 'ayer', 'semana', 'mes', 'mes_anterior', 'personalizado'],
          description: 'Periodo del reporte. Semana significa la semana actual desde el lunes.',
        },
        desde: { type: 'string', description: 'Fecha inicial YYYY-MM-DD, requerida solo para periodo personalizado.' },
        hasta: { type: 'string', description: 'Fecha final YYYY-MM-DD, requerida solo para periodo personalizado.' },
      },
      required: ['tipo', 'formato', 'periodo'],
    },
  },
];

const LOOKUP_TOOL_GUIDANCE = `

HERRAMIENTAS DE CONSULTA:
- Usa buscar_cliente_facturas cuando el dueno de una cedula/RNC y pregunte por ese cliente o sus facturas.
- Si hay varios clientes que coinciden o ninguno coincide exacto, dilo claramente y pide confirmar el numero — no adivines cual es.
- Usa historial_caja cuando pregunten por errores, descuadres, sobrantes o faltantes de caja. Un difference_amount positivo es sobrante, negativo es faltante.
- Usa auditoria_descuentos cuando pregunten por descuentos grandes, sospechosos o si los descuentos estuvieron justos. El sistema NO tiene un limite de descuento configurado — nunca digas que un descuento "excedio el limite autorizado" ni inventes un porcentaje maximo. Solo presenta el ranking y las estadisticas, y deja que el dueno juzgue.
- No inventes facturas, montos, vendedores o cajeros que no vengan en el resultado de la herramienta.`;

const LOOKUP_TOOLS = [
  {
    name: 'buscar_cliente_facturas',
    description: 'Busca un cliente por su cedula o RNC y devuelve su informacion y el historial de sus facturas (fecha, hora, vendedor, metodo de pago, total, pendiente). Usala cuando el dueno pregunte por un cliente usando su numero de cedula/RNC.',
    input_schema: {
      type: 'object',
      properties: {
        cedula: { type: 'string', description: 'Numero de cedula o RNC del cliente, con o sin guiones.' },
        limite: { type: 'integer', description: 'Cuantas facturas recientes devolver como maximo. Por defecto 15, tope 30.' },
      },
      required: ['cedula'],
    },
  },
  {
    name: 'historial_caja',
    description: 'Devuelve el historial de cierres de caja, marcando los que tuvieron diferencia entre lo esperado y lo contado (sobrante o faltante). Usala cuando el dueno pregunte por errores de caja, descuadres, sobrantes o faltantes.',
    input_schema: {
      type: 'object',
      properties: {
        periodo: { type: 'string', enum: ['hoy', 'semana', 'mes', 'todos'], description: 'Periodo a revisar. Por defecto "mes".' },
        soloConDiferencia: { type: 'boolean', description: 'Si es true (por defecto), solo devuelve cierres con diferencia distinta de cero.' },
      },
    },
  },
  {
    name: 'auditoria_descuentos',
    description: 'Muestra el ranking de las ventas con mayor descuento en un periodo, con su porcentaje de descuento, cliente y vendedor, mas estadisticas generales. No aplica ningun limite fijo — el sistema no tiene un limite de descuento configurado, el dueno decide que es razonable.',
    input_schema: {
      type: 'object',
      properties: {
        periodo: { type: 'string', enum: ['hoy', 'semana', 'mes', 'todos'], description: 'Periodo a revisar. Por defecto "mes".' },
        limite: { type: 'integer', description: 'Cuantas ventas devolver en el ranking. Por defecto 10, tope 30.' },
      },
    },
  },
];

const OWNER_TOOLS = [...PROMOTION_TOOLS, ...REPORT_TOOLS, ...LOOKUP_TOOLS];

const SYSTEM_KNOWLEDGE = `

CONOCIMIENTO DEL SISTEMA:
Tecno Caja incluye ventas y cotizaciones, venta rapida sin inventario, catalogo e inventario, clientes y credito, proveedores y compras, caja y tesoreria, promociones, reportes, usuarios, sucursales, delivery, facturacion fiscal NCF/e-CF DGII, respaldos y sincronizacion, y pedidos por WhatsApp.
El bot de clientes solo puede consultar catalogo, armar su pedido, indicar entrega o recogida y elegir pago. Nunca puede consultar cifras internas ni datos de otros clientes.
El bot del dueno puede consultar informacion administrativa en tiempo real, generar reportes, buscar un cliente por cedula/RNC con su historial completo de facturas (vendedor, fecha, hora), revisar el historial de cierres de caja para detectar sobrantes o faltantes, auditar los descuentos mas grandes de un periodo, y evaluar si una promocion activa esta funcionando (margen bruto antes vs. durante). No inventes pantallas, botones, permisos o datos que no aparezcan en este contexto o en el resultado de una herramienta.`;

async function promoAssertConfig({ permanente, fechaInicio }) {
  const rows = await _db(
    'SELECT promotions_enabled, promotions_allow_permanent, promotions_allow_future FROM config WHERE id = 1 LIMIT 1',
    [],
  );
  const cfg = rows?.[0] || {};
  if (Number(cfg.promotions_enabled) === 0) {
    throw new Error('Las promociones están desactivadas globalmente en Configuración. Actívalas desde la PC primero.');
  }
  if (permanente && Number(cfg.promotions_allow_permanent) === 0) {
    throw new Error('Las promociones permanentes están desactivadas en Configuración.');
  }
  if (fechaInicio && Number(cfg.promotions_allow_future) === 0) {
    const todayKey = new Date().toISOString().slice(0, 10);
    if (String(fechaInicio).slice(0, 10) > todayKey) {
      throw new Error('Las promociones programadas a futuro están desactivadas en Configuración.');
    }
  }
}

async function promoNextCodigoInterno() {
  const rows = await _db('SELECT COUNT(*) AS total FROM promotions', []);
  const next = Number(rows?.[0]?.total || 0) + 1;
  return `PROMO-${String(next).padStart(6, '0')}`;
}

async function promoWriteAuditLog({ promotionId, nombre, accion, detalle }) {
  await _db(
    `INSERT INTO promotion_audit_log (promotion_id, promotion_nombre_snapshot, accion, usuario_id, detalle)
     VALUES (?, ?, ?, NULL, ?)`,
    [promotionId, nombre, accion, detalle ? JSON.stringify(detalle) : null],
  );
}

async function promoToolBuscarProductos({ busqueda } = {}) {
  if (!_db) return { error: 'Sin conexión a la base de datos.' };
  const term = String(busqueda || '').trim();
  if (!term) return { error: 'Especifica un nombre o código de producto para buscar.' };
  const like = `%${term}%`;
  const rows = await _db(
    `SELECT id, codigo, nombre, precio_venta, precio_compra
     FROM products
     WHERE estado = 'Activo' AND (nombre LIKE ? OR codigo LIKE ?)
     ORDER BY nombre LIMIT 8`,
    [like, like],
  );
  if (!rows.length) return { productos: [], mensaje: `No se encontraron productos activos que coincidan con "${term}".` };
  return {
    productos: rows.map((r) => ({
      productoId: r.id,
      codigo: r.codigo,
      nombre: r.nombre,
      precioVenta: Number(r.precio_venta),
      precioCompra: Number(r.precio_compra || 0),
    })),
  };
}

async function promoToolListarPromociones({ estado } = {}) {
  if (!_db) return { error: 'Sin conexión a la base de datos.' };
  const rows = await _db(
    `SELECT p.*, pp.producto_id, pp.precio_original, pp.precio_promocion,
            pr.nombre AS producto_nombre
     FROM promotions p
     LEFT JOIN promotion_products pp ON pp.promotion_id = p.id
     LEFT JOIN products pr ON pr.id = pp.producto_id
     ORDER BY p.created_at DESC LIMIT 30`,
    [],
  );
  let promociones = rows.map((r) => ({
    promotionId: r.id,
    codigoInterno: r.codigo_interno,
    nombre: r.nombre,
    producto: r.producto_nombre || '(producto eliminado)',
    estado: computePromotionStatus(r),
    precioOriginal: r.precio_original !== undefined ? Number(r.precio_original) : null,
    precioPromocion: r.precio_promocion !== undefined ? Number(r.precio_promocion) : null,
    permanente: Number(r.permanente) === 1,
    fechaFin: r.fecha_fin,
  }));
  if (estado && estado !== 'todas') {
    promociones = promociones.filter((p) => p.estado === estado);
  }
  return { promociones };
}

async function promoToolCrearPromocion(input = {}, origen) {
  if (!_db) return { error: 'Sin conexión a la base de datos.' };
  const productoId = Number(input.productoId || 0);
  const precioPromocion = Number(input.precioPromocion);
  if (!productoId) return { error: 'Falta productoId. Usa buscar_productos primero para obtenerlo.' };
  if (!Number.isFinite(precioPromocion) || precioPromocion <= 0) {
    return { error: 'precioPromocion debe ser un número mayor a 0.' };
  }

  const productRows = await _db('SELECT id, nombre, precio_venta FROM products WHERE id = ? LIMIT 1', [productoId]);
  if (!productRows.length) return { error: 'El producto no existe. Vuelve a buscarlo con buscar_productos.' };
  const product = productRows[0];

  if (precioPromocion >= Number(product.precio_venta)) {
    return { error: `El precio de oferta (RD$ ${precioPromocion.toFixed(2)}) debe ser menor al precio normal (RD$ ${Number(product.precio_venta).toFixed(2)}).` };
  }

  const permanente = Boolean(input.permanente);
  try {
    await promoAssertConfig({ permanente, fechaInicio: input.fechaInicio });
  } catch (e) {
    return { error: e.message };
  }

  const nombre = String(input.nombre || '').trim() || `Oferta ${product.nombre}`;
  const codigoInterno = await promoNextCodigoInterno();

  const result = await _db(
    `INSERT INTO promotions
      (codigo_interno, nombre, tipo, deshabilitada, prioridad, permanente,
       fecha_inicio, fecha_fin, texto_promocion, creado_por, actualizado_por)
     VALUES (?, ?, 'oferta_precio', 0, 0, ?, ?, ?, ?, NULL, NULL)`,
    [
      codigoInterno,
      nombre,
      permanente ? 1 : 0,
      permanente ? null : (input.fechaInicio || null),
      permanente ? null : (input.fechaFin || null),
      String(input.textoPromocion || '').trim() || null,
    ],
  );
  const promotionId = Number(result.insertId);

  await _db(
    `INSERT INTO promotion_products (promotion_id, producto_id, precio_original, precio_promocion)
     VALUES (?, ?, ?, ?)`,
    [promotionId, productoId, Number(product.precio_venta), precioPromocion],
  );

  await promoWriteAuditLog({
    promotionId,
    nombre,
    accion: 'creada',
    detalle: { productoId, precioOriginal: Number(product.precio_venta), precioPromocion, origen: origen || 'whatsapp' },
  });

  return {
    ok: true,
    promotionId,
    codigoInterno,
    nombre,
    producto: product.nombre,
    precioOriginal: Number(product.precio_venta),
    precioPromocion,
  };
}

async function promoToolCambiarEstadoPromocion(input = {}) {
  if (!_db) return { error: 'Sin conexión a la base de datos.' };
  const id = Number(input.promotionId || 0);
  if (!id) return { error: 'Falta promotionId. Usa listar_promociones primero para obtenerlo.' };
  const rows = await _db('SELECT id, nombre, deshabilitada FROM promotions WHERE id = ? LIMIT 1', [id]);
  if (!rows.length) return { error: 'No existe una promoción con ese ID.' };
  const nextDisabled = input.activar ? 0 : 1;
  await _db('UPDATE promotions SET deshabilitada = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [nextDisabled, id]);
  await promoWriteAuditLog({
    promotionId: id,
    nombre: rows[0].nombre,
    accion: nextDisabled ? 'desactivada' : 'activada',
  });
  return { ok: true, promotionId: id, nombre: rows[0].nombre, deshabilitada: Boolean(nextDisabled) };
}

function dateKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function addDays(date, days) {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
}

// Evita new Date('YYYY-MM-DD'), que MySQL/sqlite a veces devuelven como texto
// y JS interpreta como medianoche UTC — desfasa un día en zonas horarias
// negativas (RD es UTC-4). Si ya viene como Date (driver normal), se respeta tal cual.
function parseDbDate(value) {
  if (value instanceof Date) return value;
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value || ''));
  if (match) return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return new Date(value);
}

async function promoToolEvaluarUnaPromocion(promotion, dias) {
  const productos = await _db(
    'SELECT producto_id, precio_original, precio_promocion FROM promotion_products WHERE promotion_id = ?',
    [promotion.id],
  );
  if (!productos.length) return [];

  const hoy = new Date();
  const inicioPromoRaw = parseDbDate(promotion.fecha_inicio || promotion.created_at);
  const ventanaMaxDesde = addDays(hoy, -(dias - 1));
  const conPromoDesde = inicioPromoRaw > ventanaMaxDesde ? inicioPromoRaw : ventanaMaxDesde;
  const longitud = Math.round((hoy - conPromoDesde) / 86400000) + 1;
  const antesHasta = addDays(conPromoDesde, -1);
  const antesDesde = addDays(antesHasta, -(longitud - 1));

  const resultados = [];
  for (const pp of productos) {
    const productoRows = await _db('SELECT nombre FROM products WHERE id = ? LIMIT 1', [pp.producto_id]);
    const productoNombre = productoRows[0]?.nombre || `Producto #${pp.producto_id}`;

    const rows = await _db(
      `SELECT
         CASE WHEN si.promotion_id = ? THEN 'con_promo' ELSE 'antes' END AS periodo,
         COALESCE(SUM(si.qty), 0) AS unidades,
         COALESCE(SUM(si.line_total), 0) AS ingresos,
         COALESCE(SUM(si.line_total - si.qty * p.precio_compra), 0) AS margen
       FROM sale_items si
       JOIN sales s ON s.id = si.sale_id
       JOIN products p ON p.id = si.product_id
       WHERE si.product_id = ?
         AND COALESCE(s.fiscal_status,'emitida') <> 'cancelada'
         AND (
           (si.promotion_id = ? AND s.operative_date BETWEEN ? AND ?)
           OR (si.promotion_id IS NULL AND s.operative_date BETWEEN ? AND ?)
         )
       GROUP BY periodo`,
      [promotion.id, pp.producto_id, promotion.id, dateKey(conPromoDesde), dateKey(hoy), dateKey(antesDesde), dateKey(antesHasta)],
    );

    const conPromoRow = rows.find((r) => r.periodo === 'con_promo');
    const antesRow = rows.find((r) => r.periodo === 'antes');
    const datosInsuficientes = !antesRow;

    const conPromo = {
      unidades: Number(conPromoRow?.unidades || 0),
      ingresos: Number(conPromoRow?.ingresos || 0),
      margen: Number(conPromoRow?.margen || 0),
    };
    const antes = {
      unidades: Number(antesRow?.unidades || 0),
      ingresos: Number(antesRow?.ingresos || 0),
      margen: Number(antesRow?.margen || 0),
    };
    const deltaMargen = Number((conPromo.margen - antes.margen).toFixed(2));
    const deltaUnidades = conPromo.unidades - antes.unidades;

    resultados.push({
      promocionId: promotion.id,
      promocionNombre: promotion.nombre,
      producto: productoNombre,
      ventana: { desde: dateKey(conPromoDesde), hasta: dateKey(hoy), dias: longitud },
      antes,
      conPromo,
      deltaMargen,
      deltaUnidades,
      datosInsuficientes,
      veredicto: datosInsuficientes ? 'datos_insuficientes' : (deltaMargen >= 0 ? 'vale_la_pena' : 'revisar'),
    });
  }
  return resultados;
}

async function promoToolEvaluarPromociones(input = {}) {
  if (!_db) return { error: 'Sin conexion a la base de datos.' };
  const dias = Math.min(Number(input.dias) || 30, 90);

  let promociones;
  if (input.promotionId) {
    const rows = await _db('SELECT * FROM promotions WHERE id = ? LIMIT 1', [Number(input.promotionId)]);
    if (!rows.length) return { error: 'No existe una promoción con ese ID.' };
    promociones = rows;
  } else {
    const rows = await _db(
      `SELECT * FROM promotions WHERE deshabilitada = 0 AND tipo = 'oferta_precio' ORDER BY created_at DESC LIMIT 10`,
      [],
    );
    promociones = rows.filter((p) => computePromotionStatus(p) === 'activa');
    if (!promociones.length) return { evaluaciones: [], mensaje: 'No hay promociones de precio activas ahora mismo.' };
  }

  const evaluaciones = [];
  for (const promotion of promociones) {
    evaluaciones.push(...(await promoToolEvaluarUnaPromocion(promotion, dias)));
  }
  return { evaluaciones };
}

async function ejecutarHerramientaPromocion(name, input, origen) {
  switch (name) {
    case 'buscar_productos': return await promoToolBuscarProductos(input);
    case 'listar_promociones': return await promoToolListarPromociones(input);
    case 'crear_promocion': return await promoToolCrearPromocion(input, origen);
    case 'cambiar_estado_promocion': return await promoToolCambiarEstadoPromocion(input);
    case 'evaluar_promociones': return await promoToolEvaluarPromociones(input);
    default: return { error: `Herramienta desconocida: ${name}` };
  }
}

function queueOwnerAttachment(jid, attachment) {
  if (!jid || !attachment?.buffer) return;
  const queued = pendingOwnerAttachments.get(jid) || [];
  queued.push(attachment);
  pendingOwnerAttachments.set(jid, queued.slice(-5));
}

async function reportToolGenerate(input = {}, origin) {
  if (!_db) return { error: 'Sin conexion a la base de datos.' };
  const report = await generateWhatsAppReport({
    query: _db,
    reportType: input.tipo,
    format: input.formato,
    period: input.periodo,
    from: input.desde,
    to: input.hasta,
  });
  queueOwnerAttachment(origin, report);
  return {
    ok: true,
    archivo: report.filename,
    formato: String(input.formato || '').toUpperCase(),
    desde: report.range.from,
    hasta: report.range.to,
    secciones: report.sections.map((item) => ({
      nombre: item.title,
      filas: item.rows.length,
      resumen: item.summary,
    })),
    mensaje: 'El archivo fue preparado y se enviara como adjunto al terminar esta respuesta.',
  };
}

async function lookupToolBuscarClienteFacturas(input = {}) {
  if (!_db) return { error: 'Sin conexion a la base de datos.' };
  const norm = String(input.cedula || '').replace(/\D/g, '');
  if (!norm) return { error: 'Especifica un numero de cedula o RNC valido.' };

  let cliente = (await _db(
    `SELECT id, nombre, telefono, email, limite_credito, balance
     FROM clients
     WHERE REPLACE(REPLACE(cedula, '-', ''), ' ', '') = ?
     LIMIT 1`,
    [norm],
  ))[0];

  if (!cliente) {
    const candidatos = await _db(
      `SELECT id, nombre, telefono, cedula
       FROM clients
       WHERE REPLACE(REPLACE(cedula, '-', ''), ' ', '') LIKE ?
       LIMIT 5`,
      [`%${norm}%`],
    );
    if (candidatos.length > 1) {
      return {
        multiples: candidatos.map((c) => ({ nombre: c.nombre, telefono: c.telefono, cedula: c.cedula })),
        mensaje: 'Hay varios clientes que coinciden con ese numero. Pide al dueño la cedula completa para precisar.',
      };
    }
    if (candidatos.length === 1) {
      cliente = (await _db(
        'SELECT id, nombre, telefono, email, limite_credito, balance FROM clients WHERE id = ? LIMIT 1',
        [candidatos[0].id],
      ))[0];
    }
  }

  if (!cliente) {
    const huerfanas = await _db(
      `SELECT s.invoice_number, s.created_at, s.payment_method, s.total,
              COALESCE(s.client_name_snapshot, 'Sin nombre') AS cliente,
              COALESCE(u.nombre, 'Desconocido') AS vendedor
       FROM sales s
       LEFT JOIN users u ON u.id = s.user_id
       WHERE REPLACE(REPLACE(s.client_tax_id_snapshot, '-', ''), ' ', '') = ?
       ORDER BY s.created_at DESC
       LIMIT 15`,
      [norm],
    );
    if (!huerfanas.length) {
      return { encontrado: false, mensaje: `No se encontro ningun cliente ni factura con la cedula/RNC "${input.cedula}".` };
    }
    return {
      encontrado: true,
      clienteActivo: false,
      mensaje: 'No hay un cliente activo con esa cedula, pero se encontraron facturas historicas con ese numero (cliente probablemente eliminado).',
      facturas: huerfanas.map((f) => ({
        factura: f.invoice_number, fecha: f.created_at, cliente: f.cliente,
        vendedor: f.vendedor, metodoPago: f.payment_method, total: Number(f.total),
      })),
    };
  }

  const limite = Math.min(Number(input.limite) || 15, 30);
  const facturas = await _db(
    `SELECT s.invoice_number, s.created_at, s.payment_method, s.total, s.received_amount,
            s.sale_status, s.fiscal_status,
            COALESCE(u.nombre, 'Desconocido') AS vendedor
     FROM sales s
     LEFT JOIN users u ON u.id = s.user_id
     WHERE s.client_id = ?
     ORDER BY s.created_at DESC
     LIMIT ?`,
    [cliente.id, limite],
  );

  const resumenRows = await _db(
    `SELECT
       COALESCE(SUM(CASE WHEN sale_status='pagada' AND COALESCE(fiscal_status,'emitida')<>'cancelada' THEN total ELSE 0 END), 0) AS total_historico,
       COALESCE(SUM(CASE WHEN payment_method='credito' AND COALESCE(fiscal_status,'emitida')<>'cancelada' AND COALESCE(total,0) > COALESCE(received_amount,0)
                          THEN COALESCE(total,0) - COALESCE(received_amount,0) ELSE 0 END), 0) AS pendiente_actual,
       COUNT(*) AS total_facturas
     FROM sales WHERE client_id = ?`,
    [cliente.id],
  );
  const resumen = resumenRows[0] || {};

  return {
    encontrado: true,
    clienteActivo: true,
    cliente: {
      nombre: cliente.nombre, telefono: cliente.telefono, email: cliente.email,
      limiteCredito: Number(cliente.limite_credito || 0), balance: Number(cliente.balance || 0),
    },
    resumen: {
      totalFacturas: Number(resumen.total_facturas || 0),
      totalHistorico: Number(resumen.total_historico || 0),
      pendienteActual: Number(resumen.pendiente_actual || 0),
    },
    facturas: facturas.map((f) => ({
      factura: f.invoice_number,
      fecha: f.created_at,
      vendedor: f.vendedor,
      metodoPago: f.payment_method,
      total: Number(f.total),
      pendiente: f.payment_method === 'credito' ? Math.max(0, Number(f.total) - Number(f.received_amount || 0)) : 0,
      estado: f.fiscal_status === 'cancelada' ? 'cancelada' : f.sale_status,
    })),
  };
}

async function lookupToolHistorialCaja(input = {}) {
  if (!_db) return { error: 'Sin conexion a la base de datos.' };
  const periodo = ['hoy', 'semana', 'mes', 'todos'].includes(input.periodo) ? input.periodo : 'mes';
  const soloConDiferencia = input.soloConDiferencia !== false;

  const conditions = [];
  const params = [];
  if (periodo !== 'todos') {
    const range = resolveDateRange(periodo);
    conditions.push('cc.closed_at BETWEEN ? AND ?');
    params.push(range.fromDatetime, range.toDatetime);
  }
  if (soloConDiferencia) {
    conditions.push('cc.difference_amount <> 0');
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  const rows = await _db(
    `SELECT cc.closed_at, cc.expected_amount, cc.counted_amount, cc.difference_amount,
            cc.closed_by_user_name, cr.nombre AS caja, b.nombre AS sucursal, cc.notes
     FROM cash_closings cc
     LEFT JOIN cash_registers cr ON cc.cash_register_id = cr.id
     LEFT JOIN branches b ON cc.branch_id = b.id
     ${where}
     ORDER BY cc.closed_at DESC
     LIMIT 30`,
    params,
  );

  const sumaDiferencias = rows.reduce((sum, r) => sum + Number(r.difference_amount || 0), 0);

  return {
    periodo,
    cierresRevisados: rows.length,
    cierresConDiferencia: rows.filter((r) => Number(r.difference_amount || 0) !== 0).length,
    sumaDiferencias: Number(sumaDiferencias.toFixed(2)),
    detalle: rows.map((r) => ({
      fecha: r.closed_at,
      caja: r.caja || '-',
      sucursal: r.sucursal || '-',
      esperado: Number(r.expected_amount),
      contado: Number(r.counted_amount),
      diferencia: Number(r.difference_amount),
      cerradoPor: r.closed_by_user_name || 'Desconocido',
      notas: r.notes || null,
    })),
  };
}

async function lookupToolAuditoriaDescuentos(input = {}) {
  if (!_db) return { error: 'Sin conexion a la base de datos.' };
  const periodo = ['hoy', 'semana', 'mes', 'todos'].includes(input.periodo) ? input.periodo : 'mes';
  const limite = Math.min(Number(input.limite) || 10, 30);

  const conditions = [`s.discount > 0`, `s.sale_status = 'pagada'`, `COALESCE(s.fiscal_status,'emitida') <> 'cancelada'`];
  const params = [];
  if (periodo !== 'todos') {
    const range = resolveDateRange(periodo);
    conditions.push('s.created_at BETWEEN ? AND ?');
    params.push(range.fromDatetime, range.toDatetime);
  }
  const where = `WHERE ${conditions.join(' AND ')}`;

  const top = await _db(
    `SELECT s.invoice_number, s.created_at,
            COALESCE(s.client_name_snapshot, c.nombre, 'Consumidor final') AS cliente,
            COALESCE(u.nombre, 'Desconocido') AS vendedor,
            s.subtotal, s.discount, s.total,
            CASE WHEN s.subtotal > 0 THEN ROUND(s.discount / s.subtotal * 100, 2) ELSE 0 END AS descuento_pct
     FROM sales s
     LEFT JOIN clients c ON c.id = s.client_id
     LEFT JOIN users u ON u.id = s.user_id
     ${where}
     ORDER BY descuento_pct DESC
     LIMIT ?`,
    [...params, limite],
  );

  const statsRows = await _db(
    `SELECT COUNT(*) AS ventas_con_descuento,
            AVG(CASE WHEN s.subtotal > 0 THEN s.discount/s.subtotal*100 ELSE 0 END) AS promedio_pct,
            MAX(CASE WHEN s.subtotal > 0 THEN s.discount/s.subtotal*100 ELSE 0 END) AS maximo_pct,
            SUM(s.discount) AS total_descontado
     FROM sales s
     ${where}`,
    params,
  );
  const stats = statsRows[0] || {};

  return {
    periodo,
    resumen: {
      ventasConDescuento: Number(stats.ventas_con_descuento || 0),
      promedioPct: Number(Number(stats.promedio_pct || 0).toFixed(2)),
      maximoPct: Number(Number(stats.maximo_pct || 0).toFixed(2)),
      totalDescontado: Number(stats.total_descontado || 0),
    },
    top: top.map((r) => ({
      factura: r.invoice_number,
      fecha: r.created_at,
      cliente: r.cliente,
      vendedor: r.vendedor,
      subtotal: Number(r.subtotal),
      descuento: Number(r.discount),
      descuentoPct: Number(r.descuento_pct),
      total: Number(r.total),
    })),
  };
}

async function executeOwnerTool(name, input, origin) {
  if (name === 'generar_reporte') return reportToolGenerate(input, origin);
  if (name === 'buscar_cliente_facturas') return lookupToolBuscarClienteFacturas(input);
  if (name === 'historial_caja') return lookupToolHistorialCaja(input);
  if (name === 'auditoria_descuentos') return lookupToolAuditoriaDescuentos(input);
  return ejecutarHerramientaPromocion(name, input, origin);
}

async function sendPendingOwnerAttachments(jid) {
  const queued = pendingOwnerAttachments.get(jid) || [];
  pendingOwnerAttachments.delete(jid);
  if (!_client || !queued.length) return [];

  const sent = [];
  for (const attachment of queued) {
    const media = new MessageMedia(
      attachment.mimeType,
      attachment.buffer.toString('base64'),
      attachment.filename,
    );
    await _client.sendMessage(jid, media, {
      caption: `Reporte Tecno Caja: ${attachment.filename}`,
    });
    sent.push(attachment.filename);
  }
  return sent;
}

// Refresca el token OAuth de Google si está por vencer — compartido por toda
// llamada a Gemini (chat de texto, transcripción de audio, visión de imagen).
async function ensureGeminiTokenFresh() {
  if (_googleTokens?.access_token && _googleTokens.expiry_date && Date.now() > _googleTokens.expiry_date - 60000) {
    try {
      const { google } = require('googleapis');
      const oauth2 = new google.auth.OAuth2(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET);
      oauth2.setCredentials(_googleTokens);
      const { credentials } = await oauth2.refreshAccessToken();
      _googleTokens = { ..._googleTokens, ...credentials };
    } catch (e) { console.warn('[wa-bot] Token refresh failed:', e.message); }
  }
}

const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite';

// Llamada HTTP cruda a generateContent. La variante de respuesta completa se
// usa para function calling; callGeminiRaw conserva la API de texto usada por
// chat, audio e imagen.
async function callGeminiResponse(body) {
  const { apiKey } = _aiConfig || {};
  await ensureGeminiTokenFresh();

  let geminiRes;
  if (_googleTokens?.access_token) {
    // OAuth — Bearer token via REST API
    const http = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
      {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${_googleTokens.access_token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }
    );
    geminiRes = await http.json();
    if (!http.ok) throw new Error(geminiRes?.error?.message || `HTTP ${http.status}`);
  } else if (apiKey) {
    // API Key en header para que no quede expuesta en URLs o logs intermedios.
    const http = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify(body),
      }
    );
    geminiRes = await http.json();
    if (!http.ok) throw new Error(geminiRes?.error?.message || `HTTP ${http.status}`);
  } else {
    return null;
  }

  return geminiRes;
}

async function callGeminiRaw(body) {
  const geminiRes = await callGeminiResponse(body);
  if (!geminiRes) return null;
  const respuesta = geminiRes?.candidates?.[0]?.content?.parts?.[0]?.text || null;
  if (!respuesta) console.error('[wa-bot] Gemini respuesta vacía:', JSON.stringify(geminiRes).substring(0, 300));
  return respuesta;
}

// Llamada de bajo nivel al proveedor de IA configurado (Claude/ChatGPT/Gemini) —
// compartida entre el flujo del dueño (responder(), con historial multi-turno) y
// el clasificador de intención de clientes (interpretCustomerIntent(), un solo
// turno). Devuelve el texto crudo de respuesta, o null si no hay proveedor
// configurado o la llamada falla (el caller decide el fallback determinístico).
async function callAi(system, messages) {
  const { provider, apiKey } = _aiConfig || {};
  if (!provider || provider === 'none') return null;

  try {
    if (provider === 'claude' && apiKey) {
      const client = new Anthropic({ apiKey });
      const res = await client.messages.create({
        model: 'claude-haiku-4-5-20251001', max_tokens: 600,
        system, messages,
      });
      return res.content[0].text;

    } else if (provider === 'chatgpt' && apiKey) {
      const { OpenAI } = require('openai');
      const openai = new OpenAI({ apiKey });
      const res = await openai.chat.completions.create({
        model: 'gpt-4o-mini', max_tokens: 600,
        messages: [{ role: 'system', content: system }, ...messages],
      });
      return res.choices[0].message.content;

    } else if (provider === 'gemini') {
      const contents = [
        ...messages.slice(0, -1).map(m => ({
          role: m.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: m.content }],
        })),
        { role: 'user', parts: [{ text: messages[messages.length - 1]?.content || '' }] },
      ];
      return await callGeminiRaw({
        contents,
        systemInstruction: { parts: [{ text: system }] },
        generationConfig: { maxOutputTokens: 600, thinkingConfig: { thinkingLevel: 'MINIMAL' } },
      });
    }
  } catch (e) {
    console.error('[wa-bot] Error IA:', e.message);
  }
  return null;
}

function toGeminiFunctionDeclaration(tool) {
  return {
    name: tool.name,
    description: tool.description,
    parameters: tool.input_schema,
  };
}

function ownerMessagesToGeminiContents(messages) {
  return messages
    .filter((message) => typeof message?.content === 'string')
    .map((message) => ({
      role: message.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: message.content }],
    }));
}

async function callGeminiOwnerTurn(system, messages, origin) {
  const contents = ownerMessagesToGeminiContents(messages);
  const MAX_TOOL_ITERATIONS = 5;

  for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
    const response = await callGeminiResponse({
      contents,
      systemInstruction: { parts: [{ text: system }] },
      tools: [{ functionDeclarations: OWNER_TOOLS.map(toGeminiFunctionDeclaration) }],
      toolConfig: { functionCallingConfig: { mode: 'AUTO' } },
      generationConfig: { maxOutputTokens: 1024, thinkingConfig: { thinkingLevel: 'MEDIUM' } },
    });
    const candidateContent = response?.candidates?.[0]?.content;
    const parts = candidateContent?.parts || [];
    const functionCalls = parts.filter((part) => part.functionCall).map((part) => part.functionCall);

    if (!functionCalls.length) {
      const text = parts.map((part) => part.text || '').join('').trim();
      return text || 'No pude preparar una respuesta con los datos disponibles.';
    }

    contents.push(candidateContent);
    const responseParts = [];
    for (const functionCall of functionCalls) {
      let result;
      try {
        result = await executeOwnerTool(functionCall.name, functionCall.args || {}, origin);
      } catch (error) {
        result = { error: error.message };
      }
      responseParts.push({
        functionResponse: {
          name: functionCall.name,
          response: { result },
          id: functionCall.id,
        },
      });
    }
    contents.push({ role: 'user', parts: responseParts });
  }

  return 'No pude completar la operacion en los pasos disponibles. Intenta de nuevo indicando tipo de reporte, formato y periodo.';
}

// Turno del dueño con tool use para Claude. Gemini usa el loop equivalente
// de arriba sobre generateContent.
// Claude responde con stop_reason 'tool_use' → ejecutamos las herramientas
// pedidas → le devolvemos los resultados como tool_result → repetimos hasta
// que responda con texto normal (stop_reason distinto de 'tool_use') o se
// agote el límite de pasos. `messages` de entrada es el historial completo
// (ya incluye el mensaje del dueño); se devuelve una COPIA con los mensajes
// intermedios (tool_use/tool_result) para que el caller decida si los
// conserva en el historial de la conversación.
async function callClaudeOwnerTurn(system, messages, origen) {
  const { apiKey } = _aiConfig || {};
  const client = new Anthropic({ apiKey });
  const workingMessages = [...messages];
  const MAX_TOOL_ITERATIONS = 5;

  for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
    const res = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      system,
      tools: OWNER_TOOLS,
      messages: workingMessages,
    });

    workingMessages.push({ role: 'assistant', content: res.content });

    if (res.stop_reason !== 'tool_use') {
      const textBlock = res.content.find((b) => b.type === 'text');
      return { text: textBlock?.text || '', messages: workingMessages };
    }

    const toolUseBlocks = res.content.filter((b) => b.type === 'tool_use');
    const toolResults = [];
    for (const block of toolUseBlocks) {
      let result;
      try {
        result = await executeOwnerTool(block.name, block.input, origen);
      } catch (e) {
        result = { error: e.message };
      }
      toolResults.push({
        type: 'tool_result',
        tool_use_id: block.id,
        content: JSON.stringify(result),
      });
    }
    workingMessages.push({ role: 'user', content: toolResults });
  }

  return {
    text: '⚠️ No pude completar la operación en los pasos disponibles. Intenta de nuevo dando más detalle (producto, precio, fechas).',
    messages: workingMessages,
  };
}

// ── Notas de voz e imágenes (solo flujo de clientes, detrás de _customerAiEnabled) ─
// Claude no tiene endpoint de audio en su API — sin proveedor con soporte, se
// devuelve null y el caller le pide texto al cliente en vez de romper el flujo.
async function transcribeAudio(media) {
  const { provider, apiKey } = _aiConfig || {};
  const mimetype = String(media?.mimetype || 'audio/ogg').split(';')[0].trim();
  try {
    if (provider === 'chatgpt' && apiKey) {
      const { OpenAI, toFile } = require('openai');
      const openai = new OpenAI({ apiKey });
      const file = await toFile(Buffer.from(media.data, 'base64'), 'nota-voz.ogg', { type: mimetype });
      const res = await openai.audio.transcriptions.create({ file, model: 'whisper-1' });
      return res.text?.trim() || null;

    } else if (provider === 'gemini') {
      const text = await callGeminiRaw({
        contents: [{ role: 'user', parts: [
          { text: 'Transcribe exactamente lo que dice este audio. Responde SOLO con la transcripción en texto plano, sin comentarios ni comillas.' },
          { inlineData: { mimeType: mimetype, data: media.data } },
        ] }],
        generationConfig: { maxOutputTokens: 200, thinkingConfig: { thinkingLevel: 'MINIMAL' } },
      });
      return text?.trim() || null;
    }
  } catch (e) {
    console.error('[wa-bot] Error transcribiendo audio:', e.message);
  }
  return null; // Claude no soporta audio; sin proveedor configurado tampoco
}

const IMAGE_IDENTIFY_PROMPT = 'Identifica en 2 a 5 palabras qué producto aparece en esta foto, para buscarlo en el catálogo de una tienda. Responde SOLO con el nombre corto del producto (ej. "detergente en polvo"), sin explicaciones ni cortesías. Si no reconoces ningún producto claro en la imagen, responde exactamente: NO_RECONOCIDO';

async function identifyProductFromImage(media) {
  const { provider, apiKey } = _aiConfig || {};
  const mimetype = String(media?.mimetype || 'image/jpeg').split(';')[0].trim();
  try {
    let raw = null;
    if (provider === 'claude' && apiKey) {
      const client = new Anthropic({ apiKey });
      const res = await client.messages.create({
        model: 'claude-haiku-4-5-20251001', max_tokens: 60,
        messages: [{ role: 'user', content: [
          { type: 'image', source: { type: 'base64', media_type: mimetype, data: media.data } },
          { type: 'text', text: IMAGE_IDENTIFY_PROMPT },
        ] }],
      });
      raw = res.content[0].text;

    } else if (provider === 'chatgpt' && apiKey) {
      const { OpenAI } = require('openai');
      const openai = new OpenAI({ apiKey });
      const res = await openai.chat.completions.create({
        model: 'gpt-4o-mini', max_tokens: 60,
        messages: [{ role: 'user', content: [
          { type: 'text', text: IMAGE_IDENTIFY_PROMPT },
          { type: 'image_url', image_url: { url: `data:${mimetype};base64,${media.data}` } },
        ] }],
      });
      raw = res.choices[0].message.content;

    } else if (provider === 'gemini') {
      raw = await callGeminiRaw({
        contents: [{ role: 'user', parts: [
          { text: IMAGE_IDENTIFY_PROMPT },
          { inlineData: { mimeType: mimetype, data: media.data } },
        ] }],
        generationConfig: { maxOutputTokens: 60, thinkingConfig: { thinkingLevel: 'MINIMAL' } },
      });
    }

    const text = raw?.trim();
    if (!text || /^NO_RECONOCIDO$/i.test(text)) return null;
    return text;
  } catch (e) {
    console.error('[wa-bot] Error identificando imagen:', e.message);
    return null;
  }
}

// Igual que identifyProductFromImage pero para el dueño: describe la foto en
// vez de limitarse a un nombre corto de producto — el dueño puede mandar
// cualquier cosa (etiqueta, factura, anaquel) y luego responder() decide qué
// hacer con la descripción (ej. buscarlo en el catálogo si es un producto).
const OWNER_IMAGE_DESCRIBE_PROMPT = 'Describe en una oración breve y concreta qué aparece en esta foto (producto, etiqueta, factura, anaquel, etc.), pensando en que la ve el dueño de una tienda. Si reconoces un producto, menciona su nombre y marca si son visibles.';

async function describeImageForOwner(media) {
  const { provider, apiKey } = _aiConfig || {};
  const mimetype = String(media?.mimetype || 'image/jpeg').split(';')[0].trim();
  try {
    if (provider === 'claude' && apiKey) {
      const client = new Anthropic({ apiKey });
      const res = await client.messages.create({
        model: 'claude-haiku-4-5-20251001', max_tokens: 200,
        messages: [{ role: 'user', content: [
          { type: 'image', source: { type: 'base64', media_type: mimetype, data: media.data } },
          { type: 'text', text: OWNER_IMAGE_DESCRIBE_PROMPT },
        ] }],
      });
      return res.content[0].text?.trim() || null;

    } else if (provider === 'chatgpt' && apiKey) {
      const { OpenAI } = require('openai');
      const openai = new OpenAI({ apiKey });
      const res = await openai.chat.completions.create({
        model: 'gpt-4o-mini', max_tokens: 200,
        messages: [{ role: 'user', content: [
          { type: 'text', text: OWNER_IMAGE_DESCRIBE_PROMPT },
          { type: 'image_url', image_url: { url: `data:${mimetype};base64,${media.data}` } },
        ] }],
      });
      return res.choices[0].message.content?.trim() || null;

    } else if (provider === 'gemini') {
      const text = await callGeminiRaw({
        contents: [{ role: 'user', parts: [
          { text: OWNER_IMAGE_DESCRIBE_PROMPT },
          { inlineData: { mimeType: mimetype, data: media.data } },
        ] }],
        generationConfig: { maxOutputTokens: 200, thinkingConfig: { thinkingLevel: 'MINIMAL' } },
      });
      return text?.trim() || null;
    }
  } catch (e) {
    console.error('[wa-bot] Error describiendo imagen (dueño):', e.message);
  }
  return null;
}

// Un "turno" del historial empieza en un mensaje de usuario en texto plano.
// Con tool use, un solo turno del dueño puede generar varios mensajes
// intermedios (assistant tool_use / user tool_result) — recortar con un
// splice fijo como antes podría dejar un tool_result huérfano al inicio del
// array, y la API rechaza esa forma. Se recorta por turno completo en su lugar.
function esInicioDeTurno(msg) {
  return msg?.role === 'user' && typeof msg?.content === 'string';
}
function trimHistorial(maxMensajes) {
  while (historial.length > maxMensajes) {
    let corte = 1;
    while (corte < historial.length && !esInicioDeTurno(historial[corte])) corte++;
    if (corte >= historial.length) break; // solo queda un turno — no cortar más
    historial.splice(0, corte);
  }
}

async function responder(mensaje, fromJid) {
  const datosBot = await getBusinessData(mensaje);
  const contextoTexto = datosBot?.text || null;
  const d = datosBot?.d || null;

  historial.push({ role: 'user', content: mensaje });
  trimHistorial(20);

  const { provider, apiKey } = _aiConfig || {};
  const ownerSystem = SYSTEM_PROMPT(contextoTexto)
    + SYSTEM_KNOWLEDGE
    + PROMOTIONS_TOOL_GUIDANCE
    + REPORT_TOOL_GUIDANCE
    + LOOKUP_TOOL_GUIDANCE;

  if (provider === 'claude' && apiKey) {
    try {
      const resultado = await callClaudeOwnerTurn(
        ownerSystem,
        historial,
        fromJid,
      );
      historial.length = 0;
      historial.push(...resultado.messages);
      trimHistorial(20);
      if (resultado.text) return resultado.text;
    } catch (e) {
      console.error('[wa-bot] Error IA (tools):', e.message);
    }
  } else if (provider === 'gemini') {
    try {
      const respuesta = await callGeminiOwnerTurn(ownerSystem, historial, fromJid);
      if (respuesta) {
        historial.push({ role: 'assistant', content: respuesta });
        trimHistorial(20);
        return respuesta;
      }
    } catch (e) {
      console.error('[wa-bot] Error Gemini (tools):', e.message);
    }
  } else {
    const respuesta = await callAi(ownerSystem, historial);
    if (respuesta) {
      historial.push({ role: 'assistant', content: respuesta });
      trimHistorial(20);
      return respuesta;
    }
  }

  // Modo Solo Comandos — respuesta formateada cuando no hay IA configurada
  if (!d) return '⚠️ Sin datos disponibles. Verifique que el sistema POS esté encendido y conectado.';

  const t = mensaje.toLowerCase();
  const hoy = new Date().toLocaleDateString('es-DO', { day: '2-digit', month: 'short', year: 'numeric' });

  // ── Menú / Ayuda ─────────────────────────────────────────────────────────────
  if (t.match(/^(hola|buenas|buenos|hey|ey|hi|inicio|ayuda|menu|menú|start|help|\?)$/)) {
    const hasOwnerTools = (provider === 'claude' && apiKey) || provider === 'gemini';
    return [
      `👋 *Asistente Tecno Caja POS*`,
      `Conectado en tiempo real — ${hoy}`,
      ``,
      `📊 *Ventas:* hoy, mes, semana, vs ayer`,
      `💳 *Pagos:* efectivo, tarjeta, transferencia`,
      `📦 *Inventario:* stock, alertas, valor`,
      `🏆 *Top productos:* 30 días o solo hoy`,
      `👥 *Clientes y CxC:* deudores, top compradores`,
      `🚚 *Proveedores:* balance pendiente por proveedor`,
      `👤 *Cajeros:* quién vendió más hoy`,
      `🏦 *Caja:* turnos abiertos, egresos`,
      `📈 *Tendencias:* tráfico por hora, pico del día`,
      hasOwnerTools
        ? `📢 *Promociones:* crear, activar o desactivar ofertas`
        : `📢 *Promociones:* consulta desde el Centro de Promociones`,
      hasOwnerTools
        ? `📄 *Reportes:* PDF, Excel o CSV enviados por este chat`
        : `📄 *Reportes:* activa Google Gemini o Claude para generarlos`,
      ``,
      `Escriba lo que necesita de forma natural.`,
      `Ej: _"¿Cuánto vendí hoy?"_ o _"¿qué está agotado?"_`,
    ].join('\n');
  }

  // ── Ventas ───────────────────────────────────────────────────────────────────
  if (t.match(/venta|factura|ingreso|cuanto vend|cuánto vend/)) {
    const lines = [
      `📊 *Reporte de Ventas — ${hoy}*`,
      ``,
      `*Hoy:*`,
      `  • Total: *${fmt(d.ventasHoy)}* (${d.facturasHoy} facturas)`,
      `  • Última venta: ${d.ultimaVenta}`,
      d.cambioAyer ? `  • ${d.cambioAyer}` : null,
      ``,
      `*Métodos de pago:*`,
      `  • Efectivo:       ${fmt(d.efectivoHoy)}`,
      `  • Tarjeta:        ${fmt(d.tarjetaHoy)}`,
      `  • Transferencia:  ${fmt(d.transferenciaHoy)}`,
      `  • Crédito:        ${fmt(d.creditoHoy)}`,
      ``,
      `*Este mes:*`,
      `  • Total: *${fmt(d.ventasMes)}* (${d.facturasMes} facturas)`,
      d.cambioMes ? `  • ${d.cambioMes}` : null,
      d.itbisMes > 0 ? `  • ITBIS generado: ${fmt(d.itbisMes)}` : null,
    ];
    return lines.filter(l => l !== null).join('\n');
  }

  // ── Inventario / Stock ───────────────────────────────────────────────────────
  if (t.match(/stock|inventario|producto|falt|agot|queda/)) {
    const lines = [
      `📦 *Inventario — ${hoy}*`,
      ``,
      `  • Productos activos: *${d.productosActivos}*`,
      `  • Valor del inventario: *${fmt(d.valorInventario)}*`,
      `  • Con bajo stock: *${d.bajoStock}*`,
      `  • Sin stock: *${d.sinStock}*`,
    ];
    if (d.bajosStock?.length) {
      lines.push(``, `*Alertas de stock:*`);
      d.bajosStock.forEach(p => {
        lines.push(`  ${p.alerta === 'SIN STOCK' ? '🔴' : '🟡'} ${p.nombre}: *${p.stock} uds* (mín: ${p.minimo})`);
      });
    } else if (d.bajoStock === 0 && d.sinStock === 0) {
      lines.push(``, `✅ Todos los productos con stock suficiente.`);
    }
    return lines.join('\n');
  }

  // ── Cuentas por cobrar ───────────────────────────────────────────────────────
  if (t.match(/cxc|deu|cobr|crédit|credito|cobra/)) {
    const lines = [
      `💳 *Cuentas por Cobrar*`,
      ``,
      `  • Total pendiente: *${fmt(d.cxcPendiente)}*`,
    ];
    if (d.cxc?.length) {
      lines.push(``, `*Principales deudores:*`);
      d.cxc.forEach(r => {
        lines.push(`  • ${r.cliente}: *${fmt(r.deuda)}*`);
        if (r.telefono && r.telefono !== '—') lines.push(`    Tel: ${r.telefono}`);
      });
    }
    return lines.join('\n');
  }

  // ── Proveedores ──────────────────────────────────────────────────────────────
  if (t.match(/proveedor|suplidor/)) {
    const lista = d.proveedores || [];
    const deudaTotal = lista.reduce((sum, p) => sum + Number(p.deuda || 0), 0);
    const lines = [
      `🚚 *Proveedores*`,
      ``,
      `  • Proveedores activos: *${lista.length}*`,
      `  • Total que les debes: *${fmt(deudaTotal)}*`,
    ];
    const conDeuda = lista.filter((p) => Number(p.deuda || 0) > 0);
    if (conDeuda.length) {
      lines.push(``, `*Con balance pendiente:*`);
      conDeuda.forEach((p) => {
        lines.push(`  • ${p.nombre}: *${fmt(p.deuda)}* (${p.facturas_pendientes} fact.)`);
        if (p.telefono) lines.push(`    Tel: ${p.telefono}`);
      });
    } else if (lista.length) {
      lines.push(``, `✅ Ningún proveedor con balance pendiente.`);
    }
    const conVisita = lista.filter((p) => p.visit_days);
    if (conVisita.length) {
      lines.push(``, `*Días de visita:*`);
      conVisita.forEach((p) => {
        lines.push(`  • ${p.nombre}: ${p.visit_days}`);
      });
    }
    return lines.join('\n');
  }

  // ── Top productos ────────────────────────────────────────────────────────────
  if (t.match(/top|popular|mejor producto|más vendido|mas vendido/)) {
    const lista = d.topProductosHoy?.length ? d.topProductosHoy : d.topProductos;
    const periodo = d.topProductosHoy?.length ? 'hoy' : 'últimos 30 días';
    const lines = [`🏆 *Top Productos (${periodo})*`, ``];
    if (lista?.length) {
      lista.forEach((p, i) => {
        lines.push(`  ${i + 1}. ${p.nombre}`);
        lines.push(`     ${Number(p.vendidos).toFixed(0)} unidades — ${fmt(p.total_vendido)}`);
      });
    } else {
      lines.push(`  Sin datos de ventas aún.`);
    }
    return lines.join('\n');
  }

  // ── Cajeros / Empleados ──────────────────────────────────────────────────────
  if (t.match(/cajero|empleado|vendedor|quien vendió|quién vendió/)) {
    const lines = [`👤 *Ventas por Cajero — Hoy*`, ``];
    if (d.cajeros?.length) {
      d.cajeros.forEach(r => {
        lines.push(`  • ${r.cajero}`);
        lines.push(`    ${r.facturas} facturas — *${fmt(r.ventas)}*`);
      });
    } else {
      lines.push(`  Sin registros de ventas por cajero hoy.`);
    }
    return lines.join('\n');
  }

  // ── Tendencia por hora ───────────────────────────────────────────────────────
  if (t.match(/hora|tendencia|tráfico|trafico|pico|momento/)) {
    const lines = [`📈 *Tráfico de Ventas por Hora — Hoy*`, ``];
    if (d.horas?.length) {
      const pico = d.horas.reduce((a, b) => b.total > a.total ? b : a, d.horas[0]);
      d.horas.forEach(h => {
        const esPico = h.hora === pico.hora;
        lines.push(`  ${esPico ? '⭐' : '  '} ${String(h.hora).padStart(2, '0')}:00 — ${h.facturas} fact. — ${fmt(h.total)}`);
      });
      lines.push(``, `Hora pico: *${String(pico.hora).padStart(2, '0')}:00* (${fmt(pico.total)})`);
    } else {
      lines.push(`  Sin ventas registradas por hora hoy.`);
    }
    return lines.join('\n');
  }

  // ── Movimientos de caja / Gastos ─────────────────────────────────────────────
  if (t.match(/gasto|egreso|retiro|movimiento/)) {
    const lines = [`💸 *Egresos de Caja — Hoy*`, ``];
    if (d.movimientos?.length) {
      d.movimientos.forEach(g => {
        lines.push(`  • ${g.tipo}: *${fmt(g.total)}* (${g.cant} movimiento${g.cant > 1 ? 's' : ''})`);
      });
    } else {
      lines.push(`  Ningún egreso registrado hoy.`);
    }
    return lines.join('\n');
  }

  // ── Cajas abiertas ────────────────────────────────────────────────────────────
  if (t.match(/caja|turno|abiert/)) {
    const lines = [
      `🏦 *Estado de Cajas — ${hoy}*`,
      ``,
      `  • Cajas abiertas: *${d.cajasAbiertas}*`,
    ];
    if (d.cajas?.length) {
      lines.push(``, `*Detalle:*`);
      d.cajas.forEach(c => {
        const hora = new Date(c.opened_at).toLocaleTimeString('es-DO', { hour: '2-digit', minute: '2-digit' });
        lines.push(`  • ${c.caja_nombre || 'Caja'} (${c.sucursal || 'Principal'})`);
        lines.push(`    ${c.opened_by_user_name} — desde ${hora} — Fondo: ${fmt(c.expected_amount)}`);
      });
    }
    return lines.join('\n');
  }

  // ── Semana ───────────────────────────────────────────────────────────────────
  if (t.match(/semana/)) {
    const diasNombres = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];
    const lines = [`📅 *Ventas Esta Semana*`, ``];
    if (d.semana?.length) {
      let totalSem = 0;
      d.semana.forEach(row => {
        const dt = new Date(row.dia);
        totalSem += Number(row.total);
        lines.push(`  • ${diasNombres[dt.getDay()]} ${dt.getDate()}: *${fmt(row.total)}* (${row.facturas} fact.)`);
      });
      lines.push(``, `  *Total acumulado:* ${fmt(totalSem)}`);
    } else {
      lines.push(`  Sin ventas esta semana aún.`);
    }
    return lines.join('\n');
  }

  // ── Últimas ventas ────────────────────────────────────────────────────────────
  if (t.match(/ultima|último|última|reciente/)) {
    const lines = [`🧾 *Últimas Ventas — Hoy*`, ``];
    if (d.ultimas?.length) {
      d.ultimas.forEach(v => {
        const hora = new Date(v.created_at).toLocaleTimeString('es-DO', { hour: '2-digit', minute: '2-digit' });
        lines.push(`  • ${v.invoice_number} — *${fmt(v.total)}*`);
        lines.push(`    ${hora} | ${v.payment_method} | ${v.cliente}`);
      });
    } else {
      lines.push(`  Sin ventas registradas hoy.`);
    }
    return lines.join('\n');
  }

  // ── Resumen completo ──────────────────────────────────────────────────────────
  if (t.match(/resumen|todo|reporte|general|como va|cómo va/)) {
    const alertas = [];
    if (d.sinStock > 0) alertas.push(`🔴 ${d.sinStock} productos sin stock`);
    if (d.bajoStock > 0) alertas.push(`🟡 ${d.bajoStock} productos con stock bajo`);
    if (d.cxcPendiente > 0) alertas.push(`💳 CxC pendiente: ${fmt(d.cxcPendiente)}`);

    const lines = [
      `📋 *Resumen General — ${hoy}*`,
      ``,
      `*Ventas de hoy:*`,
      `  • Total: *${fmt(d.ventasHoy)}* (${d.facturasHoy} facturas)`,
      `  • Última: ${d.ultimaVenta}`,
      d.cambioAyer ? `  • ${d.cambioAyer}` : null,
      ``,
      `*Mes actual:*`,
      `  • Total: *${fmt(d.ventasMes)}* (${d.facturasMes} facturas)`,
      d.cambioMes ? `  • ${d.cambioMes}` : null,
      ``,
      `*Inventario:*`,
      `  • ${d.productosActivos} productos activos — Valor: ${fmt(d.valorInventario)}`,
      `  • Bajo stock: ${d.bajoStock} | Sin stock: ${d.sinStock}`,
      ``,
      `*Operaciones:*`,
      `  • Cajas abiertas: ${d.cajasAbiertas}`,
      `  • Clientes registrados: ${d.clientesTotal}`,
      alertas.length ? `` : null, alertas.length ? `⚠️ *Alertas:*` : null,
      ...(alertas.length ? alertas.map(a => `  ${a}`) : []),
    ];
    return lines.filter(l => l !== null).join('\n');
  }

  // ── Clientes ──────────────────────────────────────────────────────────────────
  if (t.match(/cliente|comprador|frecuente/)) {
    const lines = [
      `👥 *Clientes — Mes Actual*`,
      ``,
      `  • Clientes registrados: *${d.clientesTotal}*`,
      `  • CxC pendiente: *${fmt(d.cxcPendiente)}*`,
    ];
    if (d.topClientes?.length) {
      lines.push(``, `*Mejores compradores:*`);
      d.topClientes.forEach((c, i) => {
        lines.push(`  ${i + 1}. ${c.cliente}`);
        lines.push(`     ${c.compras} compra${c.compras > 1 ? 's' : ''} — ${fmt(c.gastado)}`);
      });
    }
    return lines.join('\n');
  }

  // ── Promociones ───────────────────────────────────────────────────────────────
  // Crear/activar/desactivar promociones solo funciona vía tool use de Claude
  // (ver callClaudeOwnerTurn) — si llegamos aquí es porque la IA está apagada
  // o falló, así que se explica en vez de caer en el resumen genérico.
  if (t.match(/promo/)) {
    return [
      `📢 *Promociones*`,
      ``,
      `Para crear, activar o desactivar promociones por WhatsApp necesitas activar la IA Claude:`,
      ``,
      `1. Ve a *Bot WhatsApp → Configuración*`,
      `2. En "Motor de respuestas" elige *Claude* y pega tu API Key`,
      `3. Guarda y reinicia el bot`,
      ``,
      `Mientras tanto, puedes crear y administrar promociones desde el módulo *📢 Centro de Promociones* en la PC.`,
    ].join('\n');
  }

  // ── Respuesta por defecto ─────────────────────────────────────────────────────
  return [
    `📊 *Resumen Rápido — ${hoy}*`,
    ``,
    `  • Ventas hoy:  *${fmt(d.ventasHoy)}* (${d.facturasHoy} fact.)`,
    `  • Ventas mes:  *${fmt(d.ventasMes)}*`,
    d.bajoStock > 0 || d.sinStock > 0
      ? `  • Inventario:  🟡 ${d.bajoStock} bajo stock | 🔴 ${d.sinStock} sin stock`
      : `  • Inventario:  ✅ Stock en orden`,
    `  • CxC:         ${fmt(d.cxcPendiente)}`,
    `  • Cajas:       ${d.cajasAbiertas} abiertas`,
    ``,
    `Escriba *menú* para ver todas las opciones.`,
  ].join('\n');
}

// ── Flujo de clientes (menú fijo, sin IA) ─────────────────────────────────────
// Atiende a cualquier número que NO esté en state.ownerJids. Deliberadamente
// nunca llama getBusinessData()/responder() — solo toca productsCache,
// _businessHours y las funciones inyectadas, para no filtrarle a un cliente
// analítica interna del negocio (stock bajo, CxC, rendimiento de cajeros...).

function phoneFromJid(jid) {
  return String(jid || '').replace(/@c\.us$/, '').replace(/@lid$/, '');
}

// WhatsApp entrega el número con código de país (ej. "18092223333"), pero en
// el resto del sistema (proveedores, clientes cargados a mano) los teléfonos
// dominicanos se guardan en formato local de 10 dígitos, sin el "1" — se
// normaliza aquí para que un cliente creado desde el bot combine bien con el
// resto de la data.
function normalizePhoneForStorage(rawPhone) {
  const digits = String(rawPhone || '').replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('1')) return digits.slice(1);
  return digits;
}

// Filtra teléfonos guardados por error como el ID interno @lid de WhatsApp
// (que puede tener 13-15+ dígitos, nada que ver con un teléfono real) — un
// registro con esto no debe tratarse como "ya tengo su número".
function looksLikeValidPhone(value) {
  const digits = String(value || '').replace(/\D/g, '');
  return digits.length >= 7 && digits.length <= 11;
}

// Acepta cualquier link pegado como texto (Google Maps, Waze, goo.gl, etc.) —
// no se valida el dominio, solo que sea una URL, igual de permisivo que el
// campo "Mapa" del formulario de cliente online.
function extractMapsLinkFromText(text) {
  const match = String(text || '').trim().match(/https?:\/\/\S+/i);
  return match ? match[0] : null;
}

// Envía la imagen de una factura ya cobrada al cliente. `phone` puede venir
// en formato local (10 dígitos, como se guarda en cotizaciones/clientes) o ya
// con código de país — getNumberId() resuelve el JID real contra WhatsApp.
async function sendReceiptImage(phone, dataUrl, caption = '') {
  if (!_client || state.status !== 'ready') {
    return { ok: false, error: 'El bot de WhatsApp no está conectado.' };
  }

  const digits = String(phone || '').replace(/\D/g, '');
  if (!digits) {
    return { ok: false, error: 'Teléfono de cliente inválido.' };
  }
  const candidatePhone = digits.length === 10 ? `1${digits}` : digits;

  const match = /^data:([^;]+);base64,(.+)$/.exec(String(dataUrl || ''));
  if (!match) {
    return { ok: false, error: 'Imagen de factura inválida.' };
  }
  const [, mimeType, base64Data] = match;

  try {
    const numberId = await _client.getNumberId(candidatePhone);
    if (!numberId) {
      return { ok: false, error: 'Ese número no tiene WhatsApp.' };
    }
    const media = new MessageMedia(mimeType, base64Data, 'factura.png');
    await _client.sendMessage(numberId._serialized, media, { caption });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message || 'No se pudo enviar la factura por WhatsApp.' };
  }
}

function renderMainMenu() {
  return [
    `¡Hola! Bienvenido a *${_businessName || 'Tecno Caja'}*. 🛒`,
    '',
    '1️⃣ Ver precios',
    '2️⃣ Horario de atención',
    '3️⃣ Hacer un pedido',
    '',
    'Escribe *cancelar* en cualquier momento para salir.'
  ].join('\n');
}

// ── IA conversacional del flujo de clientes (opt-in, wabot_customer_ai_enabled) ─
// Solo interviene en el paso 'menu' cuando el texto no matchea 1/2/3 — nunca
// dentro del armado del carrito (browsing/selecting/awaiting_qty/...), que sigue
// siendo 100% determinístico. Nunca llama getBusinessData()/responder() ni
// expone analítica interna, igual que el resto de este flujo.
function CUSTOMER_SYSTEM_PROMPT() {
  const nombre = _businessName || 'este negocio';
  const rubro = _businessType ? `\nRubro del negocio: ${_businessType}.` : '';
  const horario = _businessHours ? `\nHorario de atención real: ${_businessHours}.` : '\nHorario de atención: no configurado todavía.';
  const custom = _customerInstructions ? `\n\nREGLAS ESPECÍFICAS DE ESTE NEGOCIO:\n${_customerInstructions}` : '';

  return `Eres el asistente de atención al cliente de *${nombre}* por WhatsApp.${rubro}${horario}

REGLAS ESTRICTAS (nunca las rompas):
- NUNCA reveles cifras de ventas, inventario interno, cuentas por cobrar, ni datos de otros clientes o empleados — eso es solo para el dueño.
- NUNCA inventes precios, stock ni promociones — el catálogo real se muestra en un paso aparte del sistema; tú solo conversas y orientas.
- NUNCA confirmes un pedido tú mismo ni prometas tiempos de entrega — eso lo maneja el flujo del sistema después de tu respuesta.
- NUNCA inventes el horario de atención — usa exactamente el que se te dio arriba.
- Responde siempre en español, tono amable y breve (máximo 3-4 líneas).${custom}

Debes responder SIEMPRE con un JSON válido, sin texto adicional ni markdown, exactamente con esta forma:
{"intent": "menu"|"precios"|"pedido"|"horario"|"chat", "reply": "<mensaje breve para el cliente>"}

- "precios": el cliente quiere ver precios o busca un producto puntual.
- "pedido": el cliente quiere hacer o iniciar un pedido/compra.
- "horario": el cliente pregunta por el horario de atención.
- "chat": saludo, agradecimiento, o pregunta general que no encaja en las anteriores.
- "menu": el cliente parece perdido o pide ver las opciones disponibles.`;
}

// Extrae el primer objeto {...} de un texto — tolera que el modelo envuelva el
// JSON en \`\`\`json ... \`\`\` a pesar de que se le pidió no hacerlo.
function parseIntentJson(raw) {
  if (!raw) return null;
  try { return JSON.parse(raw); } catch {}
  const match = String(raw).match(/\{[\s\S]*\}/);
  if (match) {
    try { return JSON.parse(match[0]); } catch {}
  }
  return null;
}

async function interpretCustomerIntent(text) {
  const raw = await callAi(CUSTOMER_SYSTEM_PROMPT(), [{ role: 'user', content: text }]);
  const parsed = parseIntentJson(raw);
  if (!parsed || typeof parsed.reply !== 'string') return null;
  const validIntents = ['menu', 'precios', 'pedido', 'horario', 'chat'];
  return {
    intent: validIntents.includes(parsed.intent) ? parsed.intent : 'chat',
    reply: parsed.reply,
  };
}

// Precio real a cobrar — igual al que ya usa calculateSaleItemDiscount() en
// js/ventas.js para el % de descuento por producto, para que el cliente vea
// (y pague) exactamente lo mismo que refleja la factura. Una Oferta de Precio
// activa (Centro de Promociones) tiene prioridad sobre el % de descuento del
// producto — mismo orden que aplica buildSaleItem() en js/ventas.js.
function getEffectiveProductPrice(product, promo) {
  if (promo) return Number(promo.precioPromocion);
  const base = Number(product?.precioVenta || 0);
  const pct = Math.max(0, Number(product?.descuentoPct || 0));
  if (!pct) return base;
  return Math.max(0, base - (base * pct / 100));
}

function renderSearchResultsList(results, promoMap = {}) {
  return results.map((p, i) => {
    const promo = promoMap[p.id];
    if (promo) {
      return `${i + 1}. ${p.nombre} — ~${fmt(promo.precioOriginal)}~ *${fmt(promo.precioPromocion)}* 🏷️${promo.texto ? ` ${promo.texto}` : ' OFERTA'}`;
    }
    const pct = Math.max(0, Number(p?.descuentoPct || 0));
    if (!pct) return `${i + 1}. ${p.nombre} — ${fmt(p.precioVenta)}`;
    const finalPrice = getEffectiveProductPrice(p);
    return `${i + 1}. ${p.nombre} — ~${fmt(p.precioVenta)}~ *${fmt(finalPrice)}* 🏷️ (-${pct}%)`;
  }).join('\n');
}

// Mismo cálculo que calculateSaleItemDiscount()/calcItemTotal() en
// js/ventas.js — el % de descuento se aplica sobre precio×cantidad. Se repite
// aquí (en vez de importar) porque este módulo no puede requerir código del
// frontend; si alguno de los dos cambia, hay que actualizar el otro también.
function getCartLineNet(item) {
  const base = Number(item.precio || 0) * Number(item.qty || 0);
  const pct = Math.max(0, Number(item.descuento || 0));
  return pct ? base - (base * pct / 100) : base;
}

function renderCartSummary(session) {
  const lines = session.cart.map((item) => {
    const net = getCartLineNet(item);
    if (item.promoAplicada) {
      const originalTotal = item.promoAplicada.precioOriginal * item.qty;
      return `• ${item.qty} x ${item.nombre} — ~${fmt(originalTotal)}~ *${fmt(net)}* 🏷️${item.promoAplicada.texto ? ` ${item.promoAplicada.texto}` : ' OFERTA'}`;
    }
    const hasDiscount = Number(item.descuento || 0) > 0;
    return `• ${item.qty} x ${item.nombre} — ${hasDiscount ? `~${fmt(item.precio * item.qty)}~ *${fmt(net)}* 🏷️` : fmt(net)}`;
  });
  const subtotal = session.cart.reduce((sum, item) => sum + getCartLineNet(item), 0);
  // Aproximado solo para que el cliente vea que el ITBIS ya está incluido en
  // el precio — el cálculo fiscal real (el que cuenta) lo hace el sistema
  // cuando el cajero factura de verdad, esto es solo informativo.
  const itbisIncluido = session.cart.reduce((sum, item) => {
    if (!item.itbis) return sum;
    const lineTotal = getCartLineNet(item);
    return sum + (lineTotal - lineTotal / (1 + item.itbis / 100));
  }, 0);
  const tipoTexto = session.orderType === 'delivery' ? 'Delivery' : 'Recoger en tienda';
  const partes = [
    '📋 *Resumen de tu pedido:*',
    '',
    ...lines,
    '',
    `Subtotal: ${fmt(subtotal)}`,
  ];
  if (itbisIncluido > 0.01) partes.push(`(ITBIS incluido: ${fmt(itbisIncluido)})`);
  partes.push(
    `*Total a pagar: ${fmt(subtotal)}*`,
    '',
    `Cliente: ${session.customerName}`,
    `Entrega: ${tipoTexto}`,
  );
  if (session.orderType === 'delivery') {
    partes.push(`Dirección: ${session.address}`);
    if (session.locationLink) partes.push(`Ubicación: ${session.locationLink}`);
  }
  partes.push('', 'Responde *confirmar* para continuar, *agregar* para sumar otro producto, o *cancelar* para descartarlo.');
  return partes.join('\n');
}

function getPaymentMethodOptions(session) {
  const options = [
    { key: '1', value: 'efectivo', label: 'Efectivo' },
    { key: '2', value: 'tarjeta', label: 'Tarjeta (débito o crédito)' },
    { key: '3', value: 'transferencia', label: 'Transferencia / Pago móvil' },
    { key: '4', value: 'usd', label: 'Dólares (efectivo USD)' },
  ];
  // Crédito (fiado, a la cuenta del cliente) solo se ofrece si de verdad
  // tiene cupo disponible — nunca a un cliente nuevo o sin línea aprobada.
  if (session.knownCreditLimit > 0) {
    options.push({ key: '5', value: 'credito', label: 'Crédito (a mi cuenta)' });
  }
  return options;
}

function renderPaymentMethodMenu(session) {
  const options = getPaymentMethodOptions(session);
  const lines = ['💳 *¿Cómo prefieres pagar?*', ''];
  options.forEach((opt) => lines.push(`${opt.key}️⃣ ${opt.label}`));
  lines.push('', 'El pago se confirma al recibir tu pedido — esto solo nos ayuda a tenerlo listo.');
  return lines.join('\n');
}

// Mensaje directo por JID — a diferencia de msg.reply(), sirve tanto dentro del
// flujo normal del cliente como fuera de él (ej. cuando quien confirma el
// depósito por transferencia es el DUEÑO, y hay que avisarle al cliente en
// otra conversación).
async function notifyCustomer(jid, text) {
  if (!_client) return;
  await _client.sendMessage(jid, text).catch(() => {});
}

async function notifyOwnerOfCancellation(msg, session, reason) {
  const phone = session.customerPhone || phoneFromJid(msg.from);
  const total = session.cart.reduce((sum, item) => sum + item.precio * item.qty, 0);
  const itemCount = session.cart.reduce((sum, item) => sum + item.qty, 0);

  // Aviso al dueño por WhatsApp — nunca debe romper la confirmación al cliente.
  try {
    const resumen = [
      '❌ *Pedido cancelado por el cliente*',
      '',
      `Cliente: ${session.customerName || phone}`,
      `Tel: ${phone}`,
      reason ? `Motivo: ${reason}` : 'Motivo: no indicó',
      '',
      'Tenía en el carrito:',
      ...session.cart.map((item) => `• ${item.qty} x ${item.nombre} — ${fmt(item.precio * item.qty)}`),
      '',
      `Total: ${fmt(total)}`
    ].join('\n');
    for (const ownerJid of state.ownerJids) {
      await _client.sendMessage(ownerJid, resumen).catch(() => {});
    }
  } catch (_e) {}

  // Toast en el POS — a diferencia del aviso de pedido nuevo, no usa la caja
  // verde dedicada (eso es solo para pedidos confirmados); un toast normal
  // basta para algo informativo que no requiere acción inmediata.
  if (_io) {
    _io.emit('wa_bot:order_cancelled', {
      customerName: session.customerName || phone,
      reason,
      total,
      itemCount
    });
  }
}

// jid en vez de msg: se llama tanto desde el flujo normal del cliente (con un
// msg real disponible) como desde la confirmación del dueño por transferencia
// (donde el único mensaje disponible es el del DUEÑO, no el del cliente) — usar
// _client.sendMessage(jid, ...) en vez de msg.reply() funciona en ambos casos.
async function finalizeCustomerOrder(jid, session, opts = {}) {
  // El número confirmado por el cliente (preguntado en 'awaiting_phone', o
  // heredado de su ficha si ya era conocido) — NUNCA el JID crudo del chat:
  // WhatsApp puede entregar el remitente como un ID interno (@lid) en vez del
  // número real, sobre todo hablándole a un número de negocio.
  const phone = session.customerPhone || phoneFromJid(jid);
  const total = session.cart.reduce((sum, item) => sum + item.precio * item.qty, 0);
  const itemCount = session.cart.reduce((sum, item) => sum + item.qty, 0);
  const deliveryAddress = session.orderType === 'delivery' ? session.address : '';
  const locationLink = session.orderType === 'delivery' ? session.locationLink : '';

  // Normalmente ya existe session.clientId a esta altura (se crea antes, en
  // 'awaiting_phone', en cuanto se tiene nombre + teléfono) — este bloque
  // solo crea de cero si por algún motivo eso no ocurrió (p.ej. pedido viejo
  // recuperado de una sesión previa a este cambio). Si ya existe, actualiza
  // dirección/ubicación/teléfono si cambiaron — así la próxima vez que
  // escriba, el bot lo reconoce por whatsapp_jid (o por teléfono como
  // respaldo) y no le vuelve a pedir sus datos (ver búsqueda en
  // handleCustomerMessage, paso 'building_order'). Nunca debe romper la
  // confirmación del pedido si falla.
  try {
    if (!session.clientId && typeof _insertClientRow === 'function') {
      const created = await _insertClientRow({ query: _db }, {
        nombre: session.customerName,
        telefono: phone,
        direccion: deliveryAddress,
        linkUbicacion: locationLink,
        latitud: session.locationLat,
        longitud: session.locationLng,
        whatsappJid: jid
      });
      if (created?.id) session.clientId = created.id;
    } else if (session.clientId) {
      if (deliveryAddress && deliveryAddress !== session.knownAddress && typeof _updateClientAddress === 'function') {
        await _updateClientAddress(session.clientId, deliveryAddress);
      }
      if (locationLink && locationLink !== session.knownLocationLink && typeof _updateClientLocation === 'function') {
        await _updateClientLocation(session.clientId, locationLink, session.locationLat, session.locationLng);
      }
      if (phone && phone !== session.knownPhone && typeof _updateClientPhone === 'function') {
        await _updateClientPhone(session.clientId, phone);
      }
    }

    // DB.clientes se cachea en el navegador desde el login — un cliente
    // creado/actualizado 100% en el servidor (como este) no le llega solo;
    // sin este push por socket, el módulo Clientes sigue mostrando el dato
    // viejo hasta que alguien recargue la página (mismo problema que ya se
    // resolvió para las cotizaciones con 'wa_bot:new_order').
    if (_io && session.clientId && typeof _getClientById === 'function') {
      const client = await _getClientById(session.clientId).catch(() => null);
      if (client) _io.emit('wa_bot:client_saved', { client });
    }
  } catch (e) {
    console.error('[wa-bot] Error guardando cliente:', e.message);
  }

  const payMethod = session.paymentMethodPreference || 'efectivo';
  const depositoConfirmado = !!opts.paymentConfirmedMessage;
  const payload = {
    nombre: `Pedido WhatsApp — ${session.customerName}`,
    clientId: session.clientId || null,
    clientName: session.customerName,
    orderType: session.orderType,
    // Preferencia declarada por el cliente en el chat — precarga el método de
    // pago en "Cobrar y Facturar" para que el cajero no tenga que preguntarlo
    // de nuevo, pero el cobro real (y poder cambiarlo) lo sigue haciendo él.
    payMethod,
    deliveryPhone: phone,
    deliveryAddress,
    deliveryLink: locationLink,
    orderNotes: `Pedido recibido por WhatsApp Bot. Cliente: ${session.customerName}, Tel: ${phone}. Pago preferido: ${session.paymentMethodLabel || 'Efectivo'}.`
      + (depositoConfirmado ? ' Depósito por transferencia ya confirmado por el dueño — solo falta facturar.' : ' Pendiente de confirmar por un cajero.')
      + (session.customerNote ? `\n\n📌 Nota del cliente: ${session.customerNote}` : ''),
    // El carrito ya tiene exactamente la forma que espera la pantalla de
    // Ventas al cargar una cotización (buildSaleItem() en js/ventas.js) — se
    // pasa tal cual, sin remapear a otro shape.
    items: session.cart,
    total,
    itemCount,
  };

  if (typeof _insertQuotationRow !== 'function') {
    await notifyCustomer(jid, '⚠️ No se pudo registrar el pedido en este momento. Por favor contacta al negocio directamente.');
    resetSession(jid);
    return;
  }

  try {
    const quotationId = await _insertQuotationRow({ query: _db }, payload);
    if (typeof _writeAuditLog === 'function') {
      await _writeAuditLog({
        userId: null,
        userName: 'Bot WhatsApp',
        userRole: 'Sistema',
        moduleName: 'Ventas',
        actionName: 'Pedido WhatsApp recibido',
        detail: `${session.customerName} · ${itemCount} item(s) · ${fmt(total)}`
      }).catch(() => {});
    }

    const introExito = depositoConfirmado
      ? '✅ *Tu depósito fue confirmado.*'
      : '✅ ¡Pedido recibido! Un encargado lo confirmará en breve.';
    await notifyCustomer(jid, `${introExito}\n\n*Total: ${fmt(total)}*\nPago: ${session.paymentMethodLabel || 'Efectivo'}\n\nTe llegará tu factura por este mismo chat en cuanto se confirme.`);
    addMessage('out', `Pedido WhatsApp — ${session.customerName} — ${fmt(total)}`);

    // Aviso al dueño — nunca debe romper la confirmación al cliente (ya enviada).
    try {
      const esCredito = payMethod === 'credito';
      const resumenDueno = [
        esCredito ? '🆕⚠️ *Nuevo pedido por WhatsApp — PIDIÓ CRÉDITO*' : '🆕 *Nuevo pedido por WhatsApp*',
        '',
        `Cliente: ${session.customerName}`,
        `Tel: ${phone}`,
        `Pago: ${session.paymentMethodLabel || 'Efectivo'}`,
        esCredito ? `Cupo disponible: ${fmt(session.knownCreditLimit || 0)}` : null,
        `Entrega: ${session.orderType === 'delivery' ? 'Delivery' : 'Recoger en tienda'}`,
        session.orderType === 'delivery' ? `Dirección: ${session.address}` : null,
        session.orderType === 'delivery' && locationLink ? `Ubicación: ${locationLink}` : null,
        session.customerNote ? `📌 Nota del cliente: ${session.customerNote}` : null,
        '',
        ...session.cart.map((item) => `• ${item.qty} x ${item.nombre} — ${fmt(item.precio * item.qty)}`),
        '',
        `*Total: ${fmt(total)}*`,
        '',
        depositoConfirmado
          ? '✅ Depósito por transferencia ya confirmado — solo falta facturarlo.'
          : (esCredito
              ? 'Revísalo y apruébalo tú mismo en Cotizaciones antes de facturarlo a crédito.'
              : 'Revísalo en Cotizaciones para confirmarlo.')
      ].filter((l) => l !== null).join('\n');
      for (const ownerJid of state.ownerJids) {
        await _client.sendMessage(ownerJid, resumenDueno).catch(() => {});
      }
    } catch (_e) {}

    // Notificación en vivo dentro del POS (barra de notificación de 15s en pantalla),
    // independiente del mensaje de WhatsApp de arriba — llega aunque el dueño no
    // esté mirando el celular en ese momento. Se manda la cotización completa
    // (no solo un aviso) porque el navegador tiene DB.cotizaciones cacheado en
    // memoria desde el login — sin esto, la cotización nueva no aparece en
    // "Recuperar venta o cotización" hasta que alguien recargue la página.
    if (_io) {
      let quotation = null;
      if (typeof _mapQuotationRow === 'function') {
        try {
          const rows = await _db(`SELECT * FROM quotations WHERE id = ? LIMIT 1`, [quotationId]);
          if (rows[0]) quotation = _mapQuotationRow(rows[0]);
        } catch (_e) {}
      }
      _io.emit('wa_bot:new_order', {
        customerName: session.customerName,
        total,
        itemCount,
        quotation
      });
    }
  } catch (e) {
    console.error('[wa-bot] Error creando pedido de cliente:', e.message);
    await notifyCustomer(jid, '⚠️ No se pudo registrar el pedido. Por favor contacta al negocio directamente.');
  }

  resetSession(jid);
}

// Busca en el catálogo real (productsCache) y avanza la sesión — compartida por
// el texto tipeado en el paso 'browsing' y por la identificación de imágenes
// (ambos casos deben mostrar exactamente el mismo precio/stock real, la IA
// nunca inventa esos datos).
async function runProductSearch(msg, session, query) {
  const [results, promoMap] = await Promise.all([
    productsCache.search(query, { limit: 8 }),
    getActivePromotionsMap(),
  ]);
  session.lastResults = results;
  // Se guarda junto con los resultados para que 'awaiting_qty' agregue al
  // carrito EXACTAMENTE la misma promoción que el cliente vio en este listado
  // (en vez de volver a consultar y arriesgar que cambie a mitad de la conversación).
  session.lastPromoMap = promoMap;
  if (!session.ordering) {
    await msg.reply(results.length
      ? `${renderSearchResultsList(results, promoMap)}\n\nEscribe *menu* para volver.`
      : 'No encontré productos con ese nombre. Escribe *menu* para volver.');
    session.step = 'menu';
  } else if (!results.length) {
    await msg.reply('No encontré productos con ese nombre. Intenta con otra palabra, o escribe *cancelar* para salir.');
  } else {
    await msg.reply(`${renderSearchResultsList(results, promoMap)}\n\nResponde con el número del producto que quieres agregar.`);
    session.step = 'selecting';
  }
}

async function handleCustomerMessage(msg) {
  const jid = msg.from;
  let text = String(msg.body || '').trim();
  const session = getOrCreateSession(jid);

  // Pin de ubicación nativo de WhatsApp — solo tiene sentido en el paso que lo
  // espera; en cualquier otro paso se ignora (el mensaje llega con body vacío,
  // así que no debe caer en la lógica de texto de abajo).
  if (msg.type === 'location' && msg.location) {
    if (session.step === 'awaiting_location') {
      const { latitude, longitude } = msg.location;
      if (typeof latitude === 'number' && typeof longitude === 'number') {
        session.locationLink = `https://maps.google.com/?q=${latitude},${longitude}`;
        session.locationLat = latitude;
        session.locationLng = longitude;
        session.step = 'confirm';
        await msg.reply(renderCartSummary(session));
      } else {
        await msg.reply('No pude leer esa ubicación. Intenta de nuevo, pega el link de Google Maps, o escribe *omitir*.');
      }
    }
    return;
  }

  // Comprobante de transferencia — se acepta tanto en 'awaiting_voucher' (primer
  // envío) como en 'awaiting_voucher_confirmation' (el cliente reenvía una foto
  // más clara mientras espera; reemplaza el código pendiente anterior en vez de
  // dejarlo huérfano). No depende de _customerAiEnabled: es solo reenvío de la
  // imagen tal cual al dueño, no interpretación por IA.
  if (msg.type === 'image' && msg.hasMedia &&
      (session.step === 'awaiting_voucher' || session.step === 'awaiting_voucher_confirmation')) {
    const media = await msg.downloadMedia().catch(() => null);
    if (!media) {
      await msg.reply('No pude leer esa imagen. ¿Puedes reenviar el comprobante? 📸');
      return;
    }
    if (session.voucherCode) pendingVouchers.delete(session.voucherCode);
    const code = generateVoucherCode();
    pendingVouchers.set(code, jid);
    session.voucherCode = code;
    session.step = 'awaiting_voucher_confirmation';

    const total = session.cart.reduce((sum, item) => sum + item.precio * item.qty, 0);
    const caption = [
      `🧾 *Comprobante de transferencia — pedido ${code}*`,
      '',
      `Cliente: ${session.customerName || phoneFromJid(jid)}`,
      `Tel: ${session.customerPhone || phoneFromJid(jid)}`,
      `Total del pedido: ${fmt(total)}`,
      '',
      `Responde *confirmar ${code}* si el depósito es correcto, o *rechazar ${code}* si no.`
    ].join('\n');
    try {
      const voucherMedia = new MessageMedia(media.mimetype, media.data, media.filename || 'comprobante.jpg');
      for (const ownerJid of state.ownerJids) {
        await _client.sendMessage(ownerJid, voucherMedia, { caption }).catch(() => {});
      }
    } catch (e) {
      console.error('[wa-bot] Error reenviando comprobante al dueño:', e.message);
    }

    await msg.reply('🕓 Recibimos tu comprobante. En cuanto el negocio confirme tu depósito, te avisamos por este mismo chat.');
    return;
  }

  // Foto de un producto — solo tiene sentido en 'menu'/'browsing' (los demás
  // pasos esperan un dato puntual: nombre, teléfono, dirección, confirmación).
  // La IA solo identifica QUÉ es (2-5 palabras); el precio/stock que se muestra
  // siempre sale de runProductSearch() contra el catálogo real.
  if (msg.type === 'image' && msg.hasMedia) {
    if (session.step !== 'menu' && session.step !== 'browsing') {
      await msg.reply('No puedo leer fotos en este paso. ¿Puedes escribirlo, por favor? 🙏');
      return;
    }
    if (!_customerAiEnabled || !_aiConfig?.provider || _aiConfig.provider === 'none') {
      await msg.reply('Por ahora no puedo leer fotos. ¿Puedes escribir el nombre del producto? 🙏');
      return;
    }
    const media = await msg.downloadMedia().catch(() => null);
    const description = media ? await identifyProductFromImage(media).catch(() => null) : null;
    if (!description) {
      await msg.reply('No pude identificar el producto en la foto. ¿Puedes escribir su nombre? 🙏');
      return;
    }
    if (session.step === 'menu') session.ordering = false;
    await runProductSearch(msg, session, description);
    return;
  }

  // Nota de voz — se transcribe y se trata exactamente como si el cliente lo
  // hubiera escrito, en cualquier paso (sin `return`: sigue la ejecución normal
  // de abajo con `text` ya reasignado). Claude no soporta audio — sin proveedor
  // que lo soporte, se pide texto en su lugar.
  if ((msg.type === 'ptt' || msg.type === 'audio') && msg.hasMedia) {
    if (!_customerAiEnabled || !_aiConfig?.provider || _aiConfig.provider === 'none') {
      await msg.reply('Por ahora no puedo escuchar notas de voz. ¿Me lo escribes, por favor? 🙏');
      return;
    }
    const media = await msg.downloadMedia().catch(() => null);
    const transcribed = media ? await transcribeAudio(media).catch(() => null) : null;
    if (!transcribed) {
      await msg.reply('No pude entender la nota de voz. ¿Me lo escribes, por favor? 🙏');
      return;
    }
    text = transcribed.trim();
  }

  // Override global — corre antes de la lógica de cualquier paso.
  // Si ya hay algo en el carrito, se pregunta el motivo antes de cancelar del
  // todo (para poder avisarle al dueño); si el carrito está vacío (cancelar
  // desde el menú, por ejemplo) no hay nada que reportar — se resetea directo.
  if (/^(cancelar|salir|0)$/i.test(text) && session.step !== 'awaiting_cancel_reason') {
    if (session.cart.length > 0) {
      session.step = 'awaiting_cancel_reason';
      await msg.reply('Entendido, tu pedido no se enviará. ¿Nos cuentas por qué cancelas? (opcional — escribe tu motivo, o *ninguno*)');
    } else {
      resetSession(jid);
      await msg.reply('Pedido cancelado. Escribe *menu* cuando quieras empezar de nuevo. 👋');
    }
    return;
  }
  if (/^men[uú]$/i.test(text) && session.step !== 'menu') {
    session.step = 'menu';
    session.ordering = false;
    await msg.reply(renderMainMenu());
    return;
  }

  switch (session.step) {
    case 'menu': {
      if (text === '1') {
        session.step = 'browsing';
        session.ordering = false;
        await msg.reply('¿Qué producto o categoría buscas?');
      } else if (text === '2') {
        await msg.reply(_businessHours
          ? `🕒 *Horario de atención:*\n${_businessHours}`
          : 'Horario no configurado todavía. Contacta al negocio directamente.');
        await msg.reply(renderMainMenu());
      } else if (text === '3') {
        session.step = 'browsing';
        session.ordering = true;
        await msg.reply('¿Qué producto quieres pedir?');
      } else if (_customerAiEnabled && _aiConfig?.provider && _aiConfig.provider !== 'none') {
        const interpreted = await interpretCustomerIntent(text).catch(() => null);
        if (!interpreted) {
          await msg.reply(renderMainMenu());
          break;
        }
        if (interpreted.intent === 'pedido') {
          session.step = 'browsing';
          session.ordering = true;
          await msg.reply(interpreted.reply);
        } else if (interpreted.intent === 'precios') {
          session.step = 'browsing';
          session.ordering = false;
          await msg.reply(interpreted.reply);
        } else if (interpreted.intent === 'horario') {
          // El horario real, nunca el que la IA haya podido inventar.
          await msg.reply(_businessHours
            ? `🕒 *Horario de atención:*\n${_businessHours}`
            : 'Horario no configurado todavía. Contacta al negocio directamente.');
        } else {
          await msg.reply(interpreted.reply);
        }
      } else {
        await msg.reply(renderMainMenu());
      }
      break;
    }

    case 'browsing': {
      await runProductSearch(msg, session, text);
      break;
    }

    case 'selecting': {
      const idx = parseInt(text, 10);
      if (!Number.isInteger(idx) || idx < 1 || idx > session.lastResults.length) {
        await msg.reply('No entendí esa opción. Responde con el número de la lista, o escribe *cancelar*.');
        break;
      }
      session._pendingProduct = session.lastResults[idx - 1];
      session.step = 'awaiting_qty';
      await msg.reply(`¿Cuántas unidades de *${session._pendingProduct.nombre}* quieres?`);
      break;
    }

    case 'awaiting_qty': {
      const qty = Number(text.replace(',', '.'));
      if (!Number.isFinite(qty) || qty <= 0) {
        await msg.reply('No entendí esa cantidad. Escribe un número, por ejemplo 2.');
        break;
      }
      const product = session._pendingProduct;
      const promo = (session.lastPromoMap || {})[product.id];
      const precio = getEffectiveProductPrice(product, promo);
      // Misma forma que buildSaleItem() en js/ventas.js — es la que espera la
      // pantalla de Ventas al cargar una cotización (código, itbis, saleMode,
      // etc.); con menos campos que estos se veía "undefined" y total en $0.00.
      session.cart.push({
        id: product.id,
        codigo: product.codigo || '',
        nombre: product.nombre,
        precio,
        qty,
        // El % de descuento del producto viaja igual que en buildSaleItem()
        // (js/ventas.js) — así el cajero ve el mismo descuento cuando cargue
        // esta cotización, en vez de que el bot cobre distinto que el POS.
        // Si hay una Oferta de Precio activa, ya está incluida en `precio`
        // arriba (tiene prioridad, igual que en buildSaleItem()), así que no
        // se aplica también el % de descuento del producto — evita cobrar doble.
        descuento: promo ? 0 : Math.max(0, Number(product.descuentoPct || 0)),
        // Mismo campo/forma que usa js/ventas.js (buildSaleItem) para pintar
        // el tache + badge 🏷 en el carrito del POS si el cajero abre esta
        // cotización — así el descuento se ve igual en el chat y en la caja.
        promoAplicada: promo ? {
          promotionId: promo.promotionId,
          nombre: promo.nombre,
          precioOriginal: Number(promo.precioOriginal),
          ahorro: Number(promo.ahorro),
          texto: promo.texto || '',
          color: promo.color || '',
        } : null,
        itbis: product.aplicaItbis ? _taxRate : 0,
        saleMode: 'unidad',
        unitLabel: product.unidad || 'Unidad',
        weightUnit: '',
        scaleWeight: null,
        scaleMeasuredValue: null,
        scaleMeasuredUnit: '',
        scaleSource: '',
        scaleRawReading: '',
        total: precio * qty
      });
      session._pendingProduct = null;
      session.step = 'building_order';
      await msg.reply('Agregado. ✅\n\nEscribe *otro* para agregar más productos, o *listo* para continuar.');
      break;
    }

    case 'building_order': {
      if (/^otro$/i.test(text)) {
        session.step = 'browsing';
        session.ordering = true;
        await msg.reply('¿Qué otro producto quieres agregar?');
      } else if (/^listo$/i.test(text)) {
        if (!session.cart.length) {
          await msg.reply('Aún no has agregado ningún producto. Escribe *otro* para buscar uno, o *cancelar* para salir.');
          break;
        }
        let known = null;
        // El JID se busca primero — es estable por conversación aunque
        // WhatsApp entregue un ID interno "@lid" en vez del teléfono real
        // (pasa seguido hablándole a un número de negocio), caso en el que
        // el teléfono derivado del JID nunca coincide con nada guardado y
        // antes obligaba a preguntar nombre y teléfono en cada pedido. El
        // teléfono queda como respaldo para clientes que Emilio ya tenía
        // cargados a mano y que todavía no le han escrito al bot.
        if (typeof _findClientByJid === 'function') {
          try { known = await _findClientByJid(jid); } catch (_e) {}
        }
        if (!known && typeof _findClientByPhone === 'function') {
          try { known = await _findClientByPhone(phoneFromJid(jid)); } catch (_e) {}
        }
        if (known) {
          // Cliente ya registrado (pidió antes o lo cargó Emilio a mano) — no
          // se le vuelve a preguntar el nombre, se usa el que ya está guardado.
          session.customerName = known.nombre;
          session.clientId = known.id;
          session.knownAddress = known.direccion || '';
          session.knownLocationLink = known.linkUbicacion || '';
          session.knownPhone = known.telefono || '';
          // Solo se le ofrece "Crédito" en el menú de pago si de verdad tiene
          // cupo disponible — nunca se aprueba nada aquí, solo decide si la
          // opción tiene sentido mostrarla; Emilio revisa y aprueba a mano
          // cualquier pedido a crédito antes de facturarlo.
          session.knownCreditLimit = Math.max(0, Number(known.limiteCredito || 0) - Number(known.balance || 0));
          if (typeof _updateClientJid === 'function') _updateClientJid(known.id, jid).catch(() => {});
          if (looksLikeValidPhone(known.telefono)) {
            session.customerPhone = known.telefono;
            session.step = 'awaiting_delivery_type';
            await msg.reply(`¡Hola de nuevo, ${known.nombre}! 👋\n¿Cómo prefieres recibirlo?\n1️⃣ Recoger en tienda\n2️⃣ Delivery`);
          } else {
            // El teléfono guardado no es válido (dato viejo/corrupto, ej. un
            // ID interno de WhatsApp guardado antes de este fix) — se le pide
            // que lo confirme una vez, sin volver a preguntar el nombre.
            session.step = 'awaiting_phone';
            await msg.reply(`¡Hola de nuevo, ${known.nombre}! 👋\n¿Me confirmas tu número de teléfono?`);
          }
        } else {
          session.step = 'awaiting_name';
          await msg.reply('¿A nombre de quién es el pedido?');
        }
      } else {
        await msg.reply('Escribe *otro* para agregar más productos, o *listo* para continuar.');
      }
      break;
    }

    case 'awaiting_name': {
      if (!text) {
        await msg.reply('Por favor indica un nombre.');
        break;
      }
      session.customerName = text.slice(0, 120);
      session.step = 'awaiting_phone';
      await msg.reply('¿A qué número de teléfono te podemos contactar (para confirmar el pedido y el delivery)?');
      break;
    }

    case 'awaiting_phone': {
      // Se pide en vez de usar el número del chat de WhatsApp directamente:
      // WhatsApp puede entregar el remitente como un ID interno (@lid) en vez
      // del número real, especialmente hablándole a un número de negocio —
      // guardarlo sin preguntar dejaría clientes con un "teléfono" que no es
      // marcable de verdad.
      const digits = String(text || '').replace(/\D/g, '');
      if (digits.length < 7) {
        await msg.reply('Ese número no parece válido. Escríbelo solo con números, por ejemplo 8091234567.');
        break;
      }
      session.customerPhone = normalizePhoneForStorage(text);

      // Guardarlo como cliente en cuanto tenemos nombre + teléfono, sin
      // esperar a que confirme el pedido completo (finalizeCustomerOrder) —
      // así queda registrado aunque abandone la conversación a mitad de
      // camino, y la próxima vez se le reconoce por whatsapp_jid sin volver
      // a preguntarle nada. Solo aplica a clientes nuevos: si ya viene de la
      // rama "known" (arriba), session.clientId ya está puesto.
      if (!session.clientId && typeof _insertClientRow === 'function') {
        try {
          const created = await _insertClientRow({ query: _db }, {
            nombre: session.customerName,
            telefono: session.customerPhone,
            whatsappJid: jid
          });
          if (created?.id) {
            session.clientId = created.id;
            if (_io && typeof _getClientById === 'function') {
              const client = await _getClientById(created.id).catch(() => null);
              if (client) _io.emit('wa_bot:client_saved', { client });
            }
          }
        } catch (e) {
          console.error('[wa-bot] Error guardando cliente nuevo:', e.message);
        }
      }

      session.step = 'awaiting_delivery_type';
      await msg.reply('¿Cómo lo prefieres?\n1️⃣ Recoger en tienda\n2️⃣ Delivery');
      break;
    }

    case 'awaiting_delivery_type': {
      if (text === '1') {
        session.orderType = 'recoger';
        session.step = 'confirm';
        await msg.reply(renderCartSummary(session));
      } else if (text === '2') {
        session.orderType = 'delivery';
        if (session.knownAddress) {
          session.step = 'confirm_saved_address';
          await msg.reply(`¿Enviamos tu pedido a la misma dirección de siempre?\n📍 ${session.knownAddress}\n\nResponde *sí* para confirmar, o *cambiar* para indicar otra.`);
        } else {
          session.step = 'awaiting_address';
          await msg.reply('¿Cuál es la dirección de entrega?');
        }
      } else {
        await msg.reply('No entendí esa opción. Responde 1 para recoger en tienda, o 2 para delivery.');
      }
      break;
    }

    case 'confirm_saved_address': {
      if (/^(s[ií]|confirmar)$/i.test(text)) {
        // Misma dirección de siempre — la ubicación guardada sigue siendo válida, se reusa sin preguntar.
        session.address = session.knownAddress;
        session.locationLink = session.knownLocationLink || '';
        session.step = 'confirm';
        await msg.reply(renderCartSummary(session));
      } else if (/^cambiar$/i.test(text)) {
        session.step = 'awaiting_address';
        await msg.reply('¿Cuál es la nueva dirección de entrega?');
      } else {
        await msg.reply('Responde *sí* para usar la dirección guardada, o *cambiar* para indicar otra.');
      }
      break;
    }

    case 'awaiting_address': {
      if (!text) {
        await msg.reply('Por favor indica la dirección de entrega.');
        break;
      }
      session.address = text.slice(0, 255);
      // Dirección nueva o distinta a la guardada — la ubicación anterior (si había) ya no aplica, se pide de nuevo.
      session.locationLink = '';
      session.step = 'awaiting_location';
      await msg.reply('Para que el delivery llegue más preciso a tu casa, ¿puedes compartir tu ubicación? 📍\n\nUsa el clip 📎 de WhatsApp y elige *Ubicación*, o pega el link de Google Maps.\n\nSi prefieres, escribe *omitir*.');
      break;
    }

    case 'awaiting_location': {
      if (/^omitir$/i.test(text)) {
        session.step = 'confirm';
        await msg.reply(renderCartSummary(session));
        break;
      }
      const link = extractMapsLinkFromText(text);
      if (link) {
        session.locationLink = link;
        session.step = 'confirm';
        await msg.reply(renderCartSummary(session));
      } else {
        await msg.reply('No reconocí un link de ubicación válido. Comparte tu ubicación con el clip 📎 de WhatsApp, pega un link de Google Maps, o escribe *omitir*.');
      }
      break;
    }

    case 'confirm': {
      if (/^confirmar$/i.test(text)) {
        session.step = 'awaiting_customer_note';
        await msg.reply('¿Algo que debamos saber sobre tu pedido? Por ejemplo: cambio a traer, instrucciones para el delivery, alguna referencia, etc.\n\nSi no hay nada, escribe *ninguna*.');
      } else if (/^(agregar|otro|a[ñn]adir|modificar)$/i.test(text)) {
        session.step = 'browsing';
        session.ordering = true;
        await msg.reply('¿Qué otro producto quieres agregar?');
      } else {
        await msg.reply('Responde *confirmar* para continuar, *agregar* para sumar otro producto, o *cancelar* para descartarlo.');
      }
      break;
    }

    case 'awaiting_customer_note': {
      session.customerNote = /^(ninguna|ninguno|no|nada)$/i.test(text) ? '' : text.slice(0, 300);
      session.step = 'awaiting_payment_method';
      await msg.reply(renderPaymentMethodMenu(session));
      break;
    }

    case 'awaiting_payment_method': {
      const choice = getPaymentMethodOptions(session).find(
        (opt) => text === opt.key || text.toLowerCase() === opt.value
      );
      if (!choice) {
        await msg.reply('No reconocí esa opción.\n\n' + renderPaymentMethodMenu(session));
        break;
      }
      session.paymentMethodPreference = choice.value;
      session.paymentMethodLabel = choice.label;
      if (choice.value === 'transferencia') {
        session.step = 'awaiting_voucher';
        await msg.reply('📸 Perfecto. Para confirmar tu pago, envía una *foto o captura de pantalla* del comprobante/voucher de la transferencia.');
      } else {
        await finalizeCustomerOrder(jid, session);
      }
      break;
    }

    case 'awaiting_voucher': {
      if (/^cambiar$/i.test(text)) {
        session.step = 'awaiting_payment_method';
        await msg.reply(renderPaymentMethodMenu(session));
        break;
      }
      await msg.reply('Todavía no recibo tu comprobante. Envía la foto o captura de pantalla de la transferencia. 📸\n\nSi prefieres pagar de otra forma, escribe *cambiar*.');
      break;
    }

    case 'awaiting_voucher_confirmation': {
      await msg.reply('⏳ Ya recibimos tu comprobante — estamos esperando que el negocio confirme el depósito. Te avisamos por aquí en cuanto esté listo.');
      break;
    }

    case 'awaiting_cancel_reason': {
      const reason = /^ninguno$/i.test(text) ? '' : text;
      await notifyOwnerOfCancellation(msg, session, reason);
      resetSession(jid);
      await msg.reply('Pedido cancelado. Gracias por avisarnos. Escribe *menu* cuando quieras empezar de nuevo. 👋');
      break;
    }

    default: {
      session.step = 'menu';
      await msg.reply(renderMainMenu());
    }
  }
}

// ── Cliente WhatsApp ───────────────────────────────────────────────────────────
function resolveChromePath() {
  // 1. Respeta variable de entorno explícita
  if (process.env.WHATSAPP_CHROME_PATH) return process.env.WHATSAPP_CHROME_PATH;

  // 2. Busca Chrome del sistema en rutas comunes de Windows
  const candidates = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    process.env.LOCALAPPDATA ? `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe` : '',
  ].filter(Boolean);

  for (const c of candidates) {
    if (require('fs').existsSync(c)) {
      console.log('[wa-bot] Usando Chrome del sistema:', c);
      return c;
    }
  }

  // 3. Usa el Chromium de puppeteer (puede requerir descarga en primera ejecución)
  try {
    const puppeteer = require('puppeteer');
    const chromePath = puppeteer.executablePath();
    if (require('fs').existsSync(chromePath)) return chromePath;
    console.warn('[wa-bot] Chromium de puppeteer no encontrado en:', chromePath);
    console.warn('[wa-bot] En PC nueva, puppeteer descarga ~170MB de Chromium en primer uso.');
  } catch (_e) {}

  return undefined;
}

function buildClient() {
  const executablePath = resolveChromePath();
  return new Client({
    authStrategy: new LocalAuth({ clientId: 'tecno-caja-pos-bot', dataPath: '.wwebjs_auth_pos' }),
    puppeteer: {
      headless: true,
      executablePath,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--disable-gpu',
        '--no-zygote',
        '--disable-extensions',
        '--disable-background-networking',
        '--disable-sync',
        '--mute-audio',
        '--disable-translate',
        '--disable-client-side-phishing-detection',
        '--disable-default-apps',
        '--no-default-browser-check',
        '--safebrowsing-disable-auto-update',
        // Sin esto, Chrome headless puede tratar la pestaña como "en segundo
        // plano" y limitar/retrasar los timers y scripts que whatsapp-web.js
        // necesita ejecutar para detectar el QR y las cargas iniciales.
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
      ],
    },
  });
}

// ── API pública ────────────────────────────────────────────────────────────────
async function start({ db, io, ownerPhone, ownerPhone2, provider, apiKey }) {
  if (state.status === 'starting') return;
  // Marcar 'starting' de inmediato, antes de cualquier await — el resto de esta
  // función tiene varias lecturas async (lecturas de config + destroy() del
  // cliente viejo) antes de llegar a arrancar Chrome. Si el guard de arriba
  // fuera lo único que protege contra llamadas duplicadas pero el estado no
  // cambia hasta más abajo, una segunda llamada a start() que entre en esa
  // ventana (p.ej. el auto-arranque del boot solapándose con un clic manual
  // en "Iniciar") pasa el guard igual, y las dos terminan matando el Chrome
  // de la otra a mitad de arranque — visto por el dueño como "arrancó y se
  // apagó solo".
  state.status = 'starting';
  pushState();
  // Si hay un cliente viejo, destruirlo primero
  if (_client) { try { await _client.destroy(); } catch {} _client = null; }

  _db       = db;
  _io       = io;
  _aiConfig = { provider: provider || 'none', apiKey: apiKey || null };
  state.ownerPhone  = ownerPhone;
  state.ownerPhone2 = ownerPhone2 || null;
  state.ownerJids   = [];

  // Estas 4 lecturas son independientes entre sí — se disparan en paralelo
  // (en vez de en cadena) para no sumar 4 round-trips a la BD antes de poder
  // arrancar Chrome, que es la parte realmente lenta de todo el arranque.
  await Promise.all([
    (async () => {
      if (!_googleTokens && provider === 'gemini') {
        try {
          const rows = await db(`SELECT config_value FROM offline_cache_config WHERE config_key='wabot_google_tokens'`);
          if (rows[0]?.config_value) {
            _googleTokens = JSON.parse(Buffer.from(rows[0].config_value, 'base64').toString());
            console.log('[wa-bot] Tokens de Google cargados desde BD ✅');
          }
        } catch (e) { console.warn('[wa-bot] No se pudieron cargar tokens:', e.message); }
      }
    })(),
    // Cargar instrucciones personalizadas
    db(`SELECT config_value FROM offline_cache_config WHERE config_key='wabot_instructions'`)
      .then((rows) => { if (rows[0]?.config_value) _instructions = rows[0].config_value; })
      .catch(() => {}),
    // Cargar horario de atención (para el flujo de clientes)
    db(`SELECT config_value FROM offline_cache_config WHERE config_key='wabot_business_hours'`)
      .then((rows) => { if (rows[0]?.config_value) _businessHours = rows[0].config_value; })
      .catch(() => {}),
    // Cargar instrucciones + toggle de IA del flujo de clientes
    db(`SELECT config_value FROM offline_cache_config WHERE config_key='wabot_customer_instructions'`)
      .then((rows) => { if (rows[0]?.config_value) _customerInstructions = rows[0].config_value; })
      .catch(() => {}),
    db(`SELECT config_value FROM offline_cache_config WHERE config_key='wabot_customer_ai_enabled'`)
      .then((rows) => { _customerAiEnabled = rows[0]?.config_value === '1'; })
      .catch(() => {}),
    // Tasa de ITBIS (para armar ítems de pedido con la misma forma que usa la
    // pantalla de Ventas — ver buildSaleItem() en js/ventas.js) + nombre/rubro
    // real del negocio (para que el bot de clientes no salude como "Tecno Caja").
    db(`SELECT business_name, business_type, tax_rate FROM config WHERE id = 1 LIMIT 1`)
      .then((rows) => {
        const row = rows[0];
        if (!row) return;
        if (row.tax_rate !== undefined && row.tax_rate !== null) _taxRate = Number(row.tax_rate);
        if (row.business_name) _businessName = row.business_name;
        if (row.business_type) _businessType = row.business_type;
      })
      .catch(() => {})
  ]);

  // Matar Chromium anterior y limpiar lockfiles
  killStaleBrowser();
  markProfileCleanExit();

  console.log(`[wa-bot] IA: ${_aiConfig.provider}${_aiConfig.apiKey ? ' ✓' : ''}${_googleTokens ? ' (Google OAuth ✓)' : ''}`);

  _client = buildClient();

  _client.on('qr', async (qr) => {
    // Al generar QR ya no necesitamos el timeout de "sin QR"
    if (_startTimeoutId) { clearTimeout(_startTimeoutId); _startTimeoutId = null; }
    state.status    = 'qr';
    state.qrDataUrl = await QRCode.toDataURL(qr, { width: 300 });
    console.log('[wa-bot] QR generado — escanea desde el panel del POS');
    pushState();
  });

  _client.on('authenticated', () => {
    // Con sesión guardada (LocalAuth), WhatsApp nunca emite 'qr' — sin este
    // listener el timeout de 90s de abajo seguía corriendo y podía apagar el
    // bot (llamando a stop(), que fuerza otro SIGKILL) mientras Chrome aún
    // estaba sincronizando, justo cuando el teléfono ya estaba conectado.
    if (_startTimeoutId) { clearTimeout(_startTimeoutId); _startTimeoutId = null; }
    console.log('[wa-bot] Sesión autenticada — sincronizando...');

    // Timeout de respaldo: si la sincronización post-autenticación se cuelga
    // (pasa con caché vieja de Chrome o cortes de red) y 'ready' nunca llega,
    // sin esto el bot se queda en "starting" para siempre sin ningún timeout
    // activo que lo rescate — el de arriba ya se canceló en esta misma línea.
    if (_readyTimeoutId) clearTimeout(_readyTimeoutId);
    _readyTimeoutId = setTimeout(() => {
      _readyTimeoutId = null;
      if (state.status === 'starting') {
        console.warn('[wa-bot] Timeout (120s) autenticado pero sin sincronizar — deteniendo bot');
        state.status = 'disconnected';
        pushState();
        stop().catch(() => {});
      }
    }, 120000);
  });

  _client.on('ready', async () => {
    if (_readyTimeoutId) { clearTimeout(_readyTimeoutId); _readyTimeoutId = null; }
    // Guardar PID del Chromium para poder matarlo al detener
    try {
      const browserProc = _client.pupBrowser?.process();
      if (browserProc?.pid) {
        _chromePid = browserProc.pid;
        fs.writeFileSync(PID_FILE, String(_chromePid));
      }
    } catch {}

    const info = _client.info;
    state.status     = 'ready';
    state.connectedAs = `${info.pushname} (${info.wid.user})`;
    state.qrDataUrl  = null;

    // Resolver JIDs reales (maneja @lid) para todos los números autorizados
    state.ownerJids = [];
    const phones = [ownerPhone, ownerPhone2].filter(Boolean);
    for (const phone of phones) {
      try {
        const info = await _client.getNumberId(phone);
        state.ownerJids.push(info?._serialized ?? `${phone}@c.us`);
      } catch {
        state.ownerJids.push(`${phone}@c.us`);
      }
    }

    console.log(`[wa-bot] ✅ Conectado como: ${state.connectedAs}`);
    console.log(`[wa-bot] Números autorizados: ${state.ownerJids.join(', ')}`);
    pushState();

    try {
      // Enviar bienvenida al número principal
      if (state.ownerJids[0]) {
        await _client.sendMessage(state.ownerJids[0],
          `🤖 *Tecno Caja Bot activo*\n\nPuedes preguntarme cualquier cosa sobre tu negocio.`);
      }
    } catch (e) {
      console.warn('[wa-bot] No se pudo enviar bienvenida:', e.message);
    }
  });

  _client.on('message', async (msg) => {
    if (msg.from.endsWith('@g.us')) return;
    if (msg.from === 'status@broadcast') return;
    if (!state.ownerJids.length) return; // Bot sin números configurados — nada que hacer

    // Log para diagnóstico (muestra de dónde viene y si está autorizado)
    const isAuth = state.ownerJids.includes(msg.from);
    const isLocationMsg = msg.type === 'location' && !!msg.location;
    const isVoiceMsg = (msg.type === 'ptt' || msg.type === 'audio') && msg.hasMedia;
    const isImageMsg = msg.type === 'image' && msg.hasMedia;
    console.log(`[wa-bot] 📩 from=${msg.from} | auth=${isAuth} | body="${msg.body?.substring(0,40)}"`);

    // Un pin de ubicación, nota de voz o imagen llegan con body vacío — sin este
    // permiso, el guard de abajo los descartaría junto con stickers/reacciones
    // antes de que handleCustomerMessage() pueda procesarlos.
    if (!msg.body?.trim() && !isLocationMsg && !isVoiceMsg && !isImageMsg) return;

    if (isAuth) {
      // Ubicación: sin caso de uso para el dueño (a diferencia de audio/imagen,
      // no hay nada sensato que hacer con un pin de GPS aquí).
      if (isLocationMsg) return;

      // Nota de voz o foto del dueño — se convierten a texto (transcripción o
      // descripción por IA) y de ahí en adelante se procesan exactamente igual
      // que si las hubiera escrito, igual que ya hace el flujo de clientes.
      let mensajeEntrante = msg.body;
      if (isVoiceMsg || isImageMsg) {
        if (!_aiConfig?.provider || _aiConfig.provider === 'none') {
          await msg.reply(`Activa una IA en Configuración → Bot WhatsApp para que pueda ${isVoiceMsg ? 'escuchar notas de voz' : 'leer fotos'}. 🙏`);
          return;
        }
        const media = await msg.downloadMedia().catch((e) => {
          console.error('[wa-bot] No se pudo descargar el media del dueño:', e.message);
          return null;
        });
        if (!media) console.warn('[wa-bot] downloadMedia() devolvió vacío (mensaje del dueño)');
        if (isVoiceMsg) {
          mensajeEntrante = media ? await transcribeAudio(media).catch((e) => {
            console.error('[wa-bot] transcribeAudio lanzó excepción:', e.message);
            return null;
          }) : null;
          if (!mensajeEntrante) {
            await msg.reply('No pude entender la nota de voz. ¿Me lo escribes, por favor? 🙏');
            return;
          }
        } else {
          const description = media ? await describeImageForOwner(media).catch(() => null) : null;
          if (!description) {
            await msg.reply('No pude leer esa imagen. ¿Puedes describir lo que necesitas? 🙏');
            return;
          }
          mensajeEntrante = msg.body?.trim()
            ? `${msg.body.trim()} (adjunté una foto: ${description})`
            : `Envié esta foto: ${description}. ¿Qué me puedes decir sobre esto?`;
        }
      }

      // ── Confirmar/rechazar comprobante de transferencia ─────────────────────
      // Se revisa ANTES de la IA/Modo Comandos porque "confirmar"/"rechazar" no
      // son palabras que ese flujo use — interceptarlas aquí no le quita nada.
      const voucherCmd = /^(confirmar|rechazar)(?:\s+(\S+))?$/i.exec(mensajeEntrante.trim());
      if (voucherCmd) {
        const action = voucherCmd[1].toLowerCase();
        let code = voucherCmd[2] ? voucherCmd[2].toUpperCase() : null;
        if (!code) {
          if (pendingVouchers.size === 1) {
            code = [...pendingVouchers.keys()][0];
          } else if (pendingVouchers.size === 0) {
            await msg.reply('No hay comprobantes pendientes de confirmar.');
            return;
          } else {
            await msg.reply(`Hay ${pendingVouchers.size} comprobantes pendientes. Especifica el código, ej: *${action} ${[...pendingVouchers.keys()][0]}*.`);
            return;
          }
        }
        const custJid = pendingVouchers.get(code);
        const custSession = custJid ? customerSessions.get(custJid) : null;
        if (!custJid || !custSession || custSession.step !== 'awaiting_voucher_confirmation') {
          pendingVouchers.delete(code);
          await msg.reply(`No encontré un comprobante pendiente con el código ${code}. Puede que ya se haya procesado o que el cliente lo haya cancelado.`);
          return;
        }
        pendingVouchers.delete(code);
        if (action === 'confirmar') {
          await msg.reply(`✅ Depósito ${code} confirmado. Procesando el pedido...`);
          await finalizeCustomerOrder(custJid, custSession, { paymentConfirmedMessage: true });
        } else {
          custSession.step = 'awaiting_voucher';
          custSession.voucherCode = '';
          await notifyCustomer(custJid, '❌ No pudimos confirmar tu comprobante. Verifica el monto/cuenta y envía la foto de nuevo, o escribe *cambiar* para elegir otro método de pago.');
          await msg.reply(`Comprobante ${code} rechazado. Le avisamos al cliente para que reenvíe o cambie de método de pago.`);
        }
        return;
      }

      // ── Flujo del dueño (IA / Modo Solo Comandos) — sin cambios ──────────────
      console.log(`[wa-bot] 📨 "${mensajeEntrante?.substring(0, 60)}"`);
      addMessage('in', mensajeEntrante);

      try {
        const respuesta = await responder(mensajeEntrante, msg.from);
        await msg.reply(respuesta);
        const sentFiles = await sendPendingOwnerAttachments(msg.from);
        addMessage('out', respuesta);
        for (const filename of sentFiles) addMessage('out', `[Archivo] ${filename}`);
      } catch (e) {
        console.error('[wa-bot] Error:', e.message);
        pendingOwnerAttachments.delete(msg.from);
        await msg.reply('⚠️ Error procesando tu consulta. Intenta de nuevo.');
      }
      return;
    }

    // ── Flujo de clientes (menú fijo, sin IA) ───────────────────────────────
    console.log(`[wa-bot] 📨 (cliente) "${msg.body?.substring(0, 60)}"`);
    try {
      await handleCustomerMessage(msg);
    } catch (e) {
      console.error('[wa-bot] Error en flujo de cliente:', e.message);
      await msg.reply('⚠️ Ocurrió un error. Escribe *menu* para volver a empezar.').catch(() => {});
    }
  });

  _client.on('disconnected', (reason) => {
    if (_startTimeoutId) { clearTimeout(_startTimeoutId); _startTimeoutId = null; }
    if (_readyTimeoutId) { clearTimeout(_readyTimeoutId); _readyTimeoutId = null; }
    state.status = 'disconnected';
    state.connectedAs = null;
    console.warn('[wa-bot] Desconectado:', reason);
    pushState();
  });

  // Timeout de 90s: si Chrome no genera QR, parar automáticamente
  if (_startTimeoutId) clearTimeout(_startTimeoutId);
  _startTimeoutId = setTimeout(async () => {
    _startTimeoutId = null;
    if (state.status === 'starting') {
      console.warn('[wa-bot] Timeout (90s) sin QR — deteniendo bot');
      state.status = 'disconnected';
      pushState();
      stop().catch(() => {});
    }
  }, 90000);

  // Arrancar Chrome en background — no bloquear al caller
  _client.initialize().catch(e => {
    if (_startTimeoutId) { clearTimeout(_startTimeoutId); _startTimeoutId = null; }
    console.error('[wa-bot] Error en initialize:', e.message);
    state.status = 'stopped';
    pushState();
  });
}

async function stop() {
  if (_startTimeoutId) { clearTimeout(_startTimeoutId); _startTimeoutId = null; }
  if (_readyTimeoutId) { clearTimeout(_readyTimeoutId); _readyTimeoutId = null; }
  if (_client) {
    const c = _client;
    _client = null;
    // destroy() con timeout de 8s — si Chrome no responde, matarlo directamente.
    // 3s no le alcanzaba a Chrome para cerrar limpio con este perfil (~150MB),
    // así que casi siempre terminaba en SIGKILL y el próximo arranque pagaba
    // el costo de la recuperación de sesión (ver markProfileCleanExit()).
    await Promise.race([
      c.destroy().catch(() => {}),
      new Promise(r => setTimeout(r, 8000)),
    ]);
  }
  killStaleBrowser();
  state.status      = 'stopped';
  state.connectedAs = null;
  state.qrDataUrl   = null;
  state.ownerJids   = [];
  pushState();
}

function setInstructions(text) { _instructions = text || ''; }
function setBusinessHours(text) { _businessHours = text || ''; }
function setCustomerInstructions(text) { _customerInstructions = text || ''; }
function setCustomerAiEnabled(enabled) { _customerAiEnabled = !!enabled; }
function setDependencies({
  insertQuotationRow, writeAuditLog, mapQuotationRow,
  insertClientRow, findClientByPhone, updateClientAddress, updateClientLocation, updateClientPhone,
  getClientById, findClientByJid, updateClientJid
} = {}) {
  if (insertQuotationRow) _insertQuotationRow = insertQuotationRow;
  if (writeAuditLog) _writeAuditLog = writeAuditLog;
  if (mapQuotationRow) _mapQuotationRow = mapQuotationRow;
  if (insertClientRow) _insertClientRow = insertClientRow;
  if (findClientByPhone) _findClientByPhone = findClientByPhone;
  if (updateClientAddress) _updateClientAddress = updateClientAddress;
  if (updateClientLocation) _updateClientLocation = updateClientLocation;
  if (updateClientPhone) _updateClientPhone = updateClientPhone;
  if (getClientById) _getClientById = getClientById;
  if (findClientByJid) _findClientByJid = findClientByJid;
  if (updateClientJid) _updateClientJid = updateClientJid;
}

module.exports = {
  start, stop, getSafeState, setGoogleTokens, setInstructions,
  setBusinessHours, setCustomerInstructions, setCustomerAiEnabled,
  setDependencies, sendReceiptImage
};
