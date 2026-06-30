'use strict';
const express = require('express');
const crypto  = require('crypto');
const { google } = require('googleapis');
const bot     = require('../integrations/whatsapp-bot');

const router = express.Router();

// ── Google OAuth para Gemini ───────────────────────────────────────────────────
const GEMINI_SCOPE   = 'https://www.googleapis.com/auth/generative-language';
const CALLBACK_URL   = 'http://localhost:3399/api/wa-bot/google-callback';

let _pendingState    = null;
let _googleTokens    = null; // { access_token, refresh_token, expiry_date }

function getOAuth2() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    CALLBACK_URL
  );
}

// GET /api/wa-bot/google-auth-url  — genera URL de Google OAuth
router.get('/google-auth-url', (req, res) => {
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
    return res.status(400).json({ error: 'GOOGLE_CLIENT_ID y GOOGLE_CLIENT_SECRET no configurados en .env' });
  }
  _pendingState = crypto.randomBytes(16).toString('hex');
  const url = getOAuth2().generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: [GEMINI_SCOPE],
    state: _pendingState,
  });
  res.json({ url });
});

// GET /api/wa-bot/google-callback  — Google redirige aquí después del login
router.get('/google-callback', async (req, res) => {
  const { code, state, error } = req.query;
  if (error) return res.send(`<h3>❌ Error: ${error}</h3><script>window.close()</script>`);
  if (!code || state !== _pendingState) return res.status(400).send('Estado inválido.');

  try {
    const oauth2 = getOAuth2();
    const { tokens } = await oauth2.getToken(code);
    _googleTokens = tokens;
    _pendingState = null;
    // setGoogleTokens persiste en BD si hay _db disponible (se conecta tras el primer start)
    await bot.setGoogleTokens(tokens);
    // También guardar directamente desde la ruta por si el bot no arrancó aún
    try {
      const db = req.app.locals.queryFn;
      if (db) {
        const enc = Buffer.from(JSON.stringify(tokens)).toString('base64');
        await db(`INSERT INTO offline_cache_config (config_key,config_value) VALUES ('wabot_google_tokens',?) ON DUPLICATE KEY UPDATE config_value=?`, [enc, enc]);
      }
    } catch {}
    res.send(`
      <html><head><style>body{font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#0f172a;color:#e2e8f0}</style></head>
      <body><div style="text-align:center"><div style="font-size:3rem">✅</div><h2>¡Conectado con Google!</h2><p>Puedes cerrar esta ventana.</p></div>
      <script>setTimeout(()=>window.close(),2000)</script></body></html>
    `);
  } catch (e) {
    res.send(`<h3>Error obteniendo tokens: ${e.message}</h3>`);
  }
});

// GET /api/wa-bot/google-status  — estado de la conexión con Google
router.get('/google-status', (req, res) => {
  res.json({ connected: !!_googleTokens?.refresh_token });
});

// POST /api/wa-bot/google-disconnect
router.post('/google-disconnect', async (req, res) => {
  _googleTokens = null;
  await bot.setGoogleTokens(null);
  try {
    const db = req.app.locals.queryFn;
    await db(`DELETE FROM offline_cache_config WHERE config_key='wabot_google_tokens'`);
  } catch {}
  res.json({ ok: true });
});

// ── API Keys guardadas en DB ──────────────────────────────────────────────────
const crypto2 = require('crypto');
const KEY_SECRET = () => (process.env.TECNO_CAJA_SECRET || 'tecnocaja2026').padEnd(32, '0').slice(0, 32);

function encryptKey(text) {
  const iv  = crypto2.randomBytes(16);
  const c   = crypto2.createCipheriv('aes-256-cbc', KEY_SECRET(), iv);
  return iv.toString('hex') + ':' + Buffer.concat([c.update(text), c.final()]).toString('hex');
}
function decryptKey(enc) {
  try {
    const [ivHex, data] = enc.split(':');
    const d = crypto2.createDecipheriv('aes-256-cbc', KEY_SECRET(), Buffer.from(ivHex, 'hex'));
    return Buffer.concat([d.update(Buffer.from(data, 'hex')), d.final()]).toString();
  } catch { return null; }
}

router.get('/saved-keys', async (req, res) => {
  try {
    const db = req.app.locals.queryFn;
    const rows = await db(`SELECT config_key, config_value FROM offline_cache_config WHERE config_key IN ('wabot_claude_key','wabot_chatgpt_key','wabot_provider','wabot_owner_phone','wabot_owner_phone2')`);
    const map = {};
    rows.forEach(r => { map[r.config_key] = r.config_value; });
    res.json({
      provider:      map.wabot_provider    || 'none',
      ownerPhone:    map.wabot_owner_phone  || '',
      ownerPhone2:   map.wabot_owner_phone2 || '',
      hasClaudeKey:  !!(map.wabot_claude_key),
      hasChatgptKey: !!(map.wabot_chatgpt_key),
    });
  } catch (e) { res.json({ provider: 'none', ownerPhone: '', ownerPhone2: '', hasClaudeKey: false, hasChatgptKey: false }); }
});

router.post('/save-key', async (req, res) => {
  try {
    const { provider, apiKey } = req.body;
    const db = req.app.locals.queryFn;
    const colKey = provider === 'claude' ? 'wabot_claude_key' : 'wabot_chatgpt_key';
    const encrypted = encryptKey(apiKey);
    await db(`INSERT INTO offline_cache_config (config_key, config_value) VALUES (?,?) ON DUPLICATE KEY UPDATE config_value=?`, [colKey, encrypted, encrypted]);
    await db(`INSERT INTO offline_cache_config (config_key, config_value) VALUES ('wabot_provider',?) ON DUPLICATE KEY UPDATE config_value=?`, [provider, provider]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Instrucciones personalizadas ──────────────────────────────────────────────
router.get('/instructions', async (req, res) => {
  try {
    const db = req.app.locals.queryFn;
    const rows = await db(`SELECT config_value FROM offline_cache_config WHERE config_key='wabot_instructions'`);
    res.json({ instructions: rows[0]?.config_value || '' });
  } catch { res.json({ instructions: '' }); }
});

router.post('/instructions', async (req, res) => {
  try {
    const { instructions } = req.body;
    const db = req.app.locals.queryFn;
    await db(`INSERT INTO offline_cache_config (config_key,config_value) VALUES ('wabot_instructions',?) ON DUPLICATE KEY UPDATE config_value=?`, [instructions, instructions]);
    bot.setInstructions(instructions);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Bot ───────────────────────────────────────────────────────────────────────
router.get('/status', (req, res) => res.json(bot.getSafeState()));

router.post('/start', async (req, res) => {
  try {
    const { ownerPhone, ownerPhone2, provider } = req.body;
    let { apiKey } = req.body;
    if (!ownerPhone) return res.status(400).json({ error: 'ownerPhone requerido' });
    const db = req.app.locals.queryFn;
    const io = req.app.locals.io;

    // Si no vino key, leer la guardada en DB
    if (!apiKey && provider && provider !== 'none' && provider !== 'gemini') {
      const colKey = provider === 'claude' ? 'wabot_claude_key' : 'wabot_chatgpt_key';
      const rows = await db(`SELECT config_value FROM offline_cache_config WHERE config_key=?`, [colKey]);
      if (rows[0]?.config_value) apiKey = decryptKey(rows[0].config_value);
    }

    // Fire-and-forget — Chrome arranca en background; estado llega vía Socket.IO
    bot.start({ db, io, ownerPhone, ownerPhone2: ownerPhone2 || null, provider, apiKey })
      .catch(e => console.error('[wa-bot route] start error:', e.message));

    // Guardar config para auto-arranque
    await db(`INSERT INTO offline_cache_config (config_key,config_value) VALUES ('wabot_autostart','1') ON DUPLICATE KEY UPDATE config_value='1'`);
    await db(`INSERT INTO offline_cache_config (config_key,config_value) VALUES ('wabot_owner_phone',?) ON DUPLICATE KEY UPDATE config_value=?`, [ownerPhone, ownerPhone]);
    if (ownerPhone2) {
      await db(`INSERT INTO offline_cache_config (config_key,config_value) VALUES ('wabot_owner_phone2',?) ON DUPLICATE KEY UPDATE config_value=?`, [ownerPhone2, ownerPhone2]);
    } else {
      await db(`DELETE FROM offline_cache_config WHERE config_key='wabot_owner_phone2'`);
    }
    await db(`INSERT INTO offline_cache_config (config_key,config_value) VALUES ('wabot_provider',?) ON DUPLICATE KEY UPDATE config_value=?`, [provider || 'none', provider || 'none']);

    res.json({ ok: true });
  } catch (e) {
    console.error('[wa-bot route] start error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

router.post('/stop', async (req, res) => {
  try {
    await bot.stop();
    // Limpiar auto-arranque cuando el usuario detiene manualmente
    try {
      const db = req.app.locals.queryFn;
      await db(`INSERT INTO offline_cache_config (config_key,config_value) VALUES ('wabot_autostart','0') ON DUPLICATE KEY UPDATE config_value='0'`);
    } catch {}
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
