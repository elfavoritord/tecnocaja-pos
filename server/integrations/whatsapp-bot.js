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

// ── Datos del negocio (lee de MariaDB, igual que sync-pos-stats) ───────────────
async function getBusinessData(msg = '') {
  if (!_db) return null;
  const q = (sql) => _db(sql);

  try {
    const [[stats]] = await Promise.all([q(`
      SELECT
        COALESCE((SELECT SUM(total) FROM sales WHERE sale_status='pagada' AND COALESCE(fiscal_status,'emitida')<>'cancelada' AND DATE(created_at)=CURDATE()), 0)                                  AS ventas_hoy,
        COALESCE((SELECT SUM(total) FROM sales WHERE sale_status='pagada' AND COALESCE(fiscal_status,'emitida')<>'cancelada' AND DATE(created_at)>=DATE_FORMAT(CURDATE(),'%Y-%m-01')), 0)         AS ventas_mes,
        COALESCE((SELECT COUNT(*) FROM sales WHERE sale_status='pagada' AND COALESCE(fiscal_status,'emitida')<>'cancelada' AND DATE(created_at)>=DATE_FORMAT(CURDATE(),'%Y-%m-01')), 0)           AS facturas_mes,
        COALESCE((SELECT SUM(tax) FROM sales WHERE sale_status='pagada' AND COALESCE(fiscal_status,'emitida')<>'cancelada' AND DATE(created_at)>=DATE_FORMAT(CURDATE(),'%Y-%m-01')), 0)           AS itbis_mes,
        (SELECT COUNT(*) FROM products WHERE LOWER(estado)='activo')                                                                                                                               AS productos_activos,
        (SELECT COUNT(*) FROM products WHERE LOWER(estado)='activo' AND stock_min>0 AND stock<=stock_min)                                                                                          AS bajo_stock,
        COALESCE((SELECT SUM(total) FROM sales WHERE payment_method='credito' AND sale_status='pagada' AND delivery_cash_status IN ('pendiente','na')), 0)                                         AS cxc_pendiente
    `)]);

    const fmt = (n) => `RD$ ${Number(n||0).toLocaleString('es-DO',{minimumFractionDigits:2})}`;
    let extra = '';

    const t = msg.toLowerCase();
    if (t.match(/stock|inventario|producto|falt|agot|queda/)) {
      const bajos = await q(`
        SELECT nombre, stock, stock_min AS minimo,
          CASE WHEN stock<=0 THEN 'Sin stock' ELSE 'Bajo' END AS estado
        FROM products WHERE LOWER(estado)='activo' AND stock_min>0 AND stock<=stock_min
        ORDER BY stock ASC LIMIT 10
      `);
      if (bajos.length) {
        extra += '\nPRODUCTOS CON BAJO STOCK:\n';
        extra += bajos.map(p => `- ${p.nombre}: ${p.stock} uds (mín: ${p.minimo})`).join('\n');
      }
    }

    if (t.match(/top|popular|vend|mejor/)) {
      const top = await q(`
        SELECT p.nombre, COALESCE(SUM(si.qty),0) AS vendidos
        FROM products p
        LEFT JOIN sale_items si ON si.product_id=p.id
        LEFT JOIN sales s ON si.sale_id=s.id AND s.sale_status='pagada' AND DATE(s.created_at)>=DATE_SUB(CURDATE(),INTERVAL 30 DAY)
        WHERE LOWER(p.estado)='activo'
        GROUP BY p.id ORDER BY vendidos DESC LIMIT 5
      `);
      if (top.length) {
        extra += '\nTOP PRODUCTOS (30 días):\n';
        extra += top.map((p,i) => `${i+1}. ${p.nombre}: ${p.vendidos} vendidos`).join('\n');
      }
    }

    if (t.match(/cxc|deu|cobr|crédit|credito/)) {
      const cxc = await q(`
        SELECT COALESCE(s.client_name_snapshot, c.nombre, '—') AS cliente,
               COALESCE(s.client_phone_snapshot, c.telefono, '—') AS telefono,
               SUM(s.total) AS deuda
        FROM sales s LEFT JOIN clients c ON s.client_id=c.id
        WHERE s.payment_method='credito' AND s.sale_status='pagada'
          AND s.delivery_cash_status IN ('pendiente','na')
        GROUP BY s.client_id ORDER BY deuda DESC LIMIT 5
      `);
      if (cxc.length) {
        extra += '\nCUENTAS POR COBRAR:\n';
        extra += cxc.map(r => `- ${r.cliente}: ${fmt(r.deuda)} (tel: ${r.telefono})`).join('\n');
      }
    }

    return `DATOS DEL NEGOCIO (tiempo real):
- Ventas hoy: ${fmt(stats.ventas_hoy)}
- Ventas este mes: ${fmt(stats.ventas_mes)}
- Facturas emitidas este mes: ${stats.facturas_mes}
- ITBIS generado este mes: ${fmt(stats.itbis_mes)}
- Productos activos: ${stats.productos_activos}
- Productos con bajo stock: ${stats.bajo_stock}
- Cuentas por cobrar: ${fmt(stats.cxc_pendiente)}${extra}`;
  } catch (e) {
    console.error('[wa-bot] Error leyendo datos:', e.message);
    return null;
  }
}

// ── Respuesta con IA (multi-proveedor) ────────────────────────────────────────
const SYSTEM_PROMPT = (ctx) => {
  const base = `Eres el asistente personal de negocio del dueño de Tecno Caja POS. Responde en español, de forma natural y conversacional, como un asistente inteligente. Usa *negrita* para cifras importantes. No inventes datos que no estén en el contexto.`;
  const custom = _instructions ? `\n\nINSTRUCCIONES DEL DUEÑO:\n${_instructions}` : '';
  const data = `\n\n${ctx || 'Sin datos disponibles en este momento.'}`;
  return base + custom + data;
};

async function responder(mensaje) {
  const contexto = await getBusinessData(mensaje);
  const { provider, apiKey } = _aiConfig || {};

  historial.push({ role: 'user', content: mensaje });
  if (historial.length > 20) historial.splice(0, 2);

  let respuesta = null;
  let _lastAiError = null;

  try {
    if (provider === 'claude' && apiKey) {
      const client = new Anthropic({ apiKey });
      const res = await client.messages.create({
        model: 'claude-haiku-4-5-20251001', max_tokens: 500,
        system: SYSTEM_PROMPT(contexto), messages: historial,
      });
      respuesta = res.content[0].text;

    } else if (provider === 'chatgpt' && apiKey) {
      const { OpenAI } = require('openai');
      const openai = new OpenAI({ apiKey });
      const res = await openai.chat.completions.create({
        model: 'gpt-4o-mini', max_tokens: 500,
        messages: [{ role: 'system', content: SYSTEM_PROMPT(contexto) }, ...historial],
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
        systemInstruction: { parts: [{ text: SYSTEM_PROMPT(contexto) }] },
        generationConfig: { maxOutputTokens: 500 },
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

  // Modo Solo Comandos — respuesta formateada según lo que preguntó
  if (!contexto) return '⚠️ Sin datos disponibles en este momento.';

  const t = mensaje.toLowerCase();
  const lines = contexto.split('\n');
  const get = (key) => (lines.find(l => l.includes(key)) || '').replace(/^.*?:/, '').trim();

  // Nota de instrucciones si hay alguna definida
  const instrNota = _instructions ? `\n\n_📌 ${_instructions.split('\n')[0].substring(0, 80)}_` : '';

  if (t.match(/^(hola|buenas|hey|ey|hi|inicio|ayuda|menu|menú|start|help)$/)) {
    return `👋 ¡Hola! Soy el asistente inteligente de *Tecno Caja POS*.\n\n🤖 Estoy conectado a tu sistema y puedo ayudarte a consultar información y analizar datos en tiempo real.\n\n━━━━━━━━━━━━━━━━━━━━━━\n📊 *VENTAS*\n━━━━━━━━━━━━━━━━━━━━━━\n• ¿Cuánto vendí hoy?\n• ¿Cuánto vendí este mes?\n• ¿Cuánto vendí el mes pasado?\n• ¿Cuántas facturas se realizaron hoy?\n• *ventas* — resumen rápido\n\n━━━━━━━━━━━━━━━━━━━━━━\n💰 *CAJA Y PAGOS*\n━━━━━━━━━━━━━━━━━━━━━━\n• ¿Cuánto vendí en efectivo?\n• ¿Cuánto vendí con tarjeta?\n• ¿Cuánto vendí por transferencia?\n\n━━━━━━━━━━━━━━━━━━━━━━\n📦 *INVENTARIO*\n━━━━━━━━━━━━━━━━━━━━━━\n• ¿Qué productos tienen bajo stock?\n• ¿Qué productos están agotados?\n• ¿Cuánto vale mi inventario?\n• *stock* — resumen rápido\n\n━━━━━━━━━━━━━━━━━━━━━━\n👥 *CLIENTES*\n━━━━━━━━━━━━━━━━━━━━━━\n• ¿Cuántos clientes tengo?\n• ¿Quién es mi mejor cliente?\n• ¿Qué clientes no han comprado recientemente?\n\n━━━━━━━━━━━━━━━━━━━━━━\n💳 *CUENTAS POR COBRAR*\n━━━━━━━━━━━━━━━━━━━━━━\n• ¿Quiénes me deben dinero?\n• ¿Cuánto me deben en total?\n• ¿Cuál es el cliente con mayor deuda?\n• *cxc* — resumen rápido\n\n━━━━━━━━━━━━━━━━━━━━━━\n📈 *REPORTES*\n━━━━━━━━━━━━━━━━━━━━━━\n• *resumen* — resumen completo de hoy\n• *top* — productos más vendidos\n• ¿Cómo va el negocio este mes?\n• ¿Estoy vendiendo más que el mes pasado?\n\n💡 Escribe tu pregunta de forma natural y te respondo al instante.\n\n🚀 *Bienvenido a Tecno Caja POS Inteligente.*`;
  }

  if (t.match(/venta|factura|ingreso/)) {
    return `💰 *Ventas*\n\n• Hoy: *${get('Ventas hoy')}*\n• Este mes: *${get('Ventas este mes')}*\n• Facturas emitidas: *${get('Facturas emitidas')}*\n• ITBIS generado: *${get('ITBIS')}*`;
  }

  if (t.match(/stock|inventario|producto|falt|agot|queda/)) {
    const bajoStock = get('Productos con bajo stock');
    const activos   = get('Productos activos');
    let resp = `📦 *Inventario*\n\n• Productos activos: *${activos}*\n• Con bajo stock: *${bajoStock}*`;
    const extra = lines.filter(l => l.startsWith('- ') && (l.includes('uds') || l.includes('Sin stock'))).slice(0,8);
    if (extra.length) resp += '\n\n*Productos bajos:*\n' + extra.map(l => l.replace('-','•')).join('\n');
    return resp;
  }

  if (t.match(/cxc|deu|cobr|crédit|credito|cobra/)) {
    let resp = `💳 *Cuentas por Cobrar*\n\n• Total pendiente: *${get('Cuentas por cobrar')}*`;
    const clientes = lines.filter(l => l.startsWith('- ') && l.includes('tel:')).slice(0,5);
    if (clientes.length) resp += '\n\n*Clientes con deuda:*\n' + clientes.map(l => l.replace('-','•')).join('\n');
    return resp;
  }

  if (t.match(/top|popular|vend|mejor/)) {
    let resp = `🏆 *Top Productos (30 días)*\n`;
    const top = lines.filter(l => /^\d\./.test(l.trim())).slice(0,5);
    if (top.length) resp += '\n' + top.join('\n');
    else resp += '\nNo hay datos suficientes aún.';
    return resp;
  }

  if (t.match(/resumen|todo|reporte|general/)) {
    return `📊 *Resumen del Negocio*\n\n💰 Ventas hoy: *${get('Ventas hoy')}*\n💰 Ventas mes: *${get('Ventas este mes')}*\n🧾 Facturas mes: *${get('Facturas emitidas')}*\n📦 Productos activos: *${get('Productos activos')}*\n⚠️ Bajo stock: *${get('Productos con bajo stock')}*\n💳 CxC pendiente: *${get('Cuentas por cobrar')}*`;
  }

  // Respuesta por defecto
  return `📊 *Resumen del Negocio*\n\n💰 Ventas hoy: *${get('Ventas hoy')}*\n💰 Ventas mes: *${get('Ventas este mes')}*\n📦 Bajo stock: *${get('Productos con bajo stock')}*\n💳 CxC: *${get('Cuentas por cobrar')}*\n\nEscribe *hola* para ver todo lo que puedo hacer por ti.`;
}

// ── Cliente WhatsApp ───────────────────────────────────────────────────────────
function buildClient() {
  return new Client({
    authStrategy: new LocalAuth({ clientId: 'tecno-caja-pos-bot', dataPath: '.wwebjs_auth_pos' }),
    puppeteer: {
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--disable-gpu',
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
    state.status = 'disconnected';
    state.connectedAs = null;
    console.warn('[wa-bot] Desconectado:', reason);
    pushState();
  });

  await _client.initialize();
}

async function stop() {
  if (_client) {
    try { await _client.destroy(); } catch {}
    _client = null;
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
