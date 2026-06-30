'use strict';
/**
 * Módulo de integración WhatsApp Bot para Tecno Caja POS.
 * Se inicializa desde server.js y expone estado/control vía API.
 */

const { Client, LocalAuth } = require('whatsapp-web.js');
const QRCode    = require('qrcode');
const Anthropic = require('@anthropic-ai/sdk');

const fs   = require('fs');
const path = require('path');

let _db             = null;
let _io             = null;
let _client         = null;
let _aiConfig       = null;
let _googleTokens   = null;
let _instructions   = '';
let _chromePid      = null;
let _startTimeoutId = null;

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
const historial = [];       // historial de conversación para Claude

function pushState() {
  if (_io) _io.emit('wa_bot_state', getSafeState());
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
        COALESCE((SELECT SUM(total) FROM sales WHERE payment_method='credito' AND sale_status='pagada' AND delivery_cash_status IN ('pendiente','na')),0)                                    AS cxc_pendiente,
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
               SUM(s.total) AS deuda
        FROM sales s LEFT JOIN clients c ON s.client_id=c.id
        WHERE s.payment_method='credito' AND s.sale_status='pagada'
          AND s.delivery_cash_status IN ('pendiente','na')
        GROUP BY s.client_id ORDER BY deuda DESC LIMIT 7`);
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
    if (extras.cajeros?.length) extraText += `\nCAJEROS HOY:\n${extras.cajeros.map(r=>`- ${r.cajero}: ${r.facturas} fact. ${fmt(r.ventas)}`).join('\n')}`;
    if (extras.movimientos?.length) extraText += `\nEGRESOS HOY:\n${extras.movimientos.map(g=>`- ${g.tipo}: ${fmt(g.total)} (${g.cant} mov.)`).join('\n')}`;
    if (extras.horas?.length) { const pk=extras.horas.reduce((a,b)=>b.total>a.total?b:a,extras.horas[0]); extraText += `\nHORAS HOY:\n${extras.horas.map(h=>`- ${String(h.hora).padStart(2,'0')}:00 → ${h.facturas} fact. ${fmt(h.total)}`).join('\n')}\nPico: ${String(pk.hora).padStart(2,'0')}:00`; }
    if (extras.topClientes?.length) extraText += `\nTOP CLIENTES MES:\n${extras.topClientes.map(c=>`- ${c.cliente}: ${c.compras} compras ${fmt(c.gastado)}`).join('\n')}`;
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

async function responder(mensaje) {
  const datosBot = await getBusinessData(mensaje);
  const contextoTexto = datosBot?.text || null;
  const d = datosBot?.d || null;
  const { provider, apiKey } = _aiConfig || {};

  historial.push({ role: 'user', content: mensaje });
  if (historial.length > 20) historial.splice(0, 2);

  let respuesta = null;
  let _lastAiError = null;

  try {
    if (provider === 'claude' && apiKey) {
      const client = new Anthropic({ apiKey });
      const res = await client.messages.create({
        model: 'claude-haiku-4-5-20251001', max_tokens: 600,
        system: SYSTEM_PROMPT(contextoTexto), messages: historial,
      });
      respuesta = res.content[0].text;

    } else if (provider === 'chatgpt' && apiKey) {
      const { OpenAI } = require('openai');
      const openai = new OpenAI({ apiKey });
      const res = await openai.chat.completions.create({
        model: 'gpt-4o-mini', max_tokens: 600,
        messages: [{ role: 'system', content: SYSTEM_PROMPT(contextoTexto) }, ...historial],
      });
      respuesta = res.choices[0].message.content;

    } else if (provider === 'gemini') {
      // Refrescar token OAuth si está por vencer
      if (_googleTokens?.access_token && _googleTokens.expiry_date && Date.now() > _googleTokens.expiry_date - 60000) {
        try {
          const { google } = require('googleapis');
          const oauth2 = new google.auth.OAuth2(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET);
          oauth2.setCredentials(_googleTokens);
          const { credentials } = await oauth2.refreshAccessToken();
          _googleTokens = { ..._googleTokens, ...credentials };
        } catch (e) { console.warn('[wa-bot] Token refresh failed:', e.message); }
      }

      const contents = [
        ...historial.slice(0, -1).map(m => ({
          role: m.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: m.content }],
        })),
        { role: 'user', parts: [{ text: mensaje }] },
      ];
      const body = {
        contents,
        systemInstruction: { parts: [{ text: SYSTEM_PROMPT(contextoTexto) }] },
        generationConfig: { maxOutputTokens: 600 },
      };

      let geminiRes;
      if (_googleTokens?.access_token) {
        // OAuth — Bearer token via REST API
        const http = await fetch(
          'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent',
          {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${_googleTokens.access_token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          }
        );
        geminiRes = await http.json();
        if (!http.ok) throw new Error(geminiRes?.error?.message || `HTTP ${http.status}`);
      } else if (apiKey) {
        // API Key — query param
        const http = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`,
          { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
        );
        geminiRes = await http.json();
        if (!http.ok) throw new Error(geminiRes?.error?.message || `HTTP ${http.status}`);
      }

      if (geminiRes) {
        respuesta = geminiRes.candidates?.[0]?.content?.parts?.[0]?.text || null;
        if (!respuesta) console.error('[wa-bot] Gemini respuesta vacía:', JSON.stringify(geminiRes).substring(0, 300));
      }
    }
  } catch (e) {
    _lastAiError = e.message;
    console.error('[wa-bot] Error IA:', e.message);
  }

  if (respuesta) {
    historial.push({ role: 'assistant', content: respuesta });
    return respuesta;
  }

  // Modo Solo Comandos — respuesta formateada cuando no hay IA configurada
  if (!d) return '⚠️ Sin datos disponibles. Verifique que el sistema POS esté encendido y conectado.';

  const t = mensaje.toLowerCase();
  const hoy = new Date().toLocaleDateString('es-DO', { day: '2-digit', month: 'short', year: 'numeric' });

  // ── Menú / Ayuda ─────────────────────────────────────────────────────────────
  if (t.match(/^(hola|buenas|buenos|hey|ey|hi|inicio|ayuda|menu|menú|start|help|\?)$/)) {
    return [
      `👋 *Asistente Tecno Caja POS*`,
      `Conectado en tiempo real — ${hoy}`,
      ``,
      `📊 *Ventas:* hoy, mes, semana, vs ayer`,
      `💳 *Pagos:* efectivo, tarjeta, transferencia`,
      `📦 *Inventario:* stock, alertas, valor`,
      `🏆 *Top productos:* 30 días o solo hoy`,
      `👥 *Clientes y CxC:* deudores, top compradores`,
      `👤 *Cajeros:* quién vendió más hoy`,
      `🏦 *Caja:* turnos abiertos, egresos`,
      `📈 *Tendencias:* tráfico por hora, pico del día`,
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
      ],
    },
  });
}

// ── API pública ────────────────────────────────────────────────────────────────
async function start({ db, io, ownerPhone, ownerPhone2, provider, apiKey }) {
  if (state.status === 'starting') return;
  // Si hay un cliente viejo, destruirlo primero
  if (_client) { try { await _client.destroy(); } catch {} _client = null; }

  _db       = db;
  _io       = io;
  _aiConfig = { provider: provider || 'none', apiKey: apiKey || null };
  state.ownerPhone  = ownerPhone;
  state.ownerPhone2 = ownerPhone2 || null;
  state.ownerJids   = [];

  // Cargar tokens de Google guardados si no hay ninguno en memoria
  if (!_googleTokens && provider === 'gemini') {
    try {
      const rows = await db(`SELECT config_value FROM offline_cache_config WHERE config_key='wabot_google_tokens'`);
      if (rows[0]?.config_value) {
        _googleTokens = JSON.parse(Buffer.from(rows[0].config_value, 'base64').toString());
        console.log('[wa-bot] Tokens de Google cargados desde BD ✅');
      }
    } catch (e) { console.warn('[wa-bot] No se pudieron cargar tokens:', e.message); }
  }

  // Cargar instrucciones personalizadas
  try {
    const instrRows = await db(`SELECT config_value FROM offline_cache_config WHERE config_key='wabot_instructions'`);
    if (instrRows[0]?.config_value) _instructions = instrRows[0].config_value;
  } catch {}

  // Matar Chromium anterior y limpiar lockfiles
  killStaleBrowser();

  console.log(`[wa-bot] IA: ${_aiConfig.provider}${_aiConfig.apiKey ? ' ✓' : ''}${_googleTokens ? ' (Google OAuth ✓)' : ''}`);
  state.status = 'starting';
  pushState();

  _client = buildClient();

  _client.on('qr', async (qr) => {
    // Al generar QR ya no necesitamos el timeout de "sin QR"
    if (_startTimeoutId) { clearTimeout(_startTimeoutId); _startTimeoutId = null; }
    state.status    = 'qr';
    state.qrDataUrl = await QRCode.toDataURL(qr, { width: 300 });
    console.log('[wa-bot] QR generado — escanea desde el panel del POS');
    pushState();
  });

  _client.on('ready', async () => {
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

    // Log para diagnóstico (muestra de dónde viene y si está autorizado)
    const isAuth = state.ownerJids.includes(msg.from);
    console.log(`[wa-bot] 📩 from=${msg.from} | auth=${isAuth} | body="${msg.body?.substring(0,40)}"`);

    if (!state.ownerJids.length || !isAuth) return;
    if (!msg.body?.trim()) return; // Ignorar mensajes vacíos (stickers, reacciones, etc.)

    console.log(`[wa-bot] 📨 "${msg.body?.substring(0, 60)}"`);
    addMessage('in', msg.body);

    try {
      const respuesta = await responder(msg.body);
      await msg.reply(respuesta);
      addMessage('out', respuesta);
    } catch (e) {
      console.error('[wa-bot] Error:', e.message);
      await msg.reply('⚠️ Error procesando tu consulta. Intenta de nuevo.');
    }
  });

  _client.on('disconnected', (reason) => {
    if (_startTimeoutId) { clearTimeout(_startTimeoutId); _startTimeoutId = null; }
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
  if (_client) {
    const c = _client;
    _client = null;
    // destroy() con timeout de 3s — si Chrome no responde, matarlo directamente
    await Promise.race([
      c.destroy().catch(() => {}),
      new Promise(r => setTimeout(r, 3000)),
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

module.exports = { start, stop, getSafeState, setGoogleTokens, setInstructions };
