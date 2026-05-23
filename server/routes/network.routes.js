// ══════════════════════════════════════════════════════════════════════════════
//  network.routes.js  —  Tecno Caja
//  Gestión de terminales (cajas) en red LAN y sucursales remotas.
//  Montado en /api/network por server.js.
//  Factory pattern con DI igual que fiscal.routes.js.
// ══════════════════════════════════════════════════════════════════════════════

'use strict';

const express = require('express');
const os      = require('os');
const {
  ensureNetworkExtensions,
  registerTerminal,
  markOnline,
  markOffline,
  markOfflineBySocket,
  listTerminals,
  assignBranch,
  removeTerminal,
  getLocalIPs
} = require('../network/terminalRegistry');

// ── helpers de permisos ───────────────────────────────────────────────────────
function _normRole(u) { return String(u?.role_code || u?.rol || '').trim().toLowerCase(); }
function _isAdmin(u)  { return _normRole(u) === 'administrador_general' || _normRole(u) === 'administrador_sucursal'; }
function _isGlobal(u) { return _normRole(u) === 'administrador_general'; }

// ── factory ───────────────────────────────────────────────────────────────────
function createNetworkRouter({ query, resolveRequestActorUser }) {
  const router = express.Router();

  // Memoize init
  let _ready = false;
  async function ensureReady() {
    if (_ready) return;
    await ensureNetworkExtensions(query);
    _ready = true;
  }

  // Helper: obtener business_id del contexto
  async function getBusinessId() {
    const rows = await query('SELECT business_id FROM config WHERE id = 1 LIMIT 1');
    return Number(rows[0]?.business_id || 1);
  }

  // ── GET /api/network/status ─────────────────────────────────────────────────
  // Estado completo de la red: IPs locales, puerto, modo, terminales
  router.get('/status', async (req, res) => {
    try {
      await ensureReady();
      const actor = await resolveRequestActorUser(req, { required: true });
      if (!_isAdmin(actor)) return res.status(403).json({ error: 'Sin permiso.' });

      const businessId  = await getBusinessId();
      const terminals   = await listTerminals(query, businessId);
      const localIPs    = getLocalIPs();
      const port        = Number(process.env.PORT || 3399);
      const lanEnabled  = String(process.env.POS_ALLOW_LAN || 'false').toLowerCase() === 'true';
      const dbClient    = String(process.env.DB_CLIENT || 'sqlite').toLowerCase();
      const mysqlLan    = String(process.env.TECNO_CAJA_MYSQL_ALLOW_LAN || 'false').toLowerCase() === 'true';

      // Leer config del terminal actual
      let terminalConfig = null;
      try {
        const fs   = require('fs');
        const path = require('path');
        const tcPath = path.join(
          process.env.TECNO_CAJA_USER_DATA || require('os').homedir(),
          '.tecnocaja', 'terminal.json'
        );
        if (fs.existsSync(tcPath)) terminalConfig = JSON.parse(fs.readFileSync(tcPath, 'utf8'));
      } catch (_) {}

      const isMain = !terminalConfig || terminalConfig.isMain !== false;

      // Ramas de branches y cajas disponibles
      const branches   = await query(`SELECT id, nombre, codigo, estado FROM branches WHERE estado = 'Activa' ORDER BY nombre`);
      const registers  = await query(`SELECT id, branch_id, nombre, codigo, estado FROM cash_registers WHERE estado = 'Activa' ORDER BY nombre`);

      res.json({
        isMain,
        lanEnabled,
        mysqlLanEnabled: mysqlLan,
        dbClient,
        localIPs,
        port,
        accessUrls: localIPs.map(ip => `http://${ip}:${port}`),
        primaryUrl:  localIPs[0] ? `http://${localIPs[0]}:${port}` : null,
        terminals,
        totalOnline:  terminals.filter(t => t.status === 'online').length,
        totalOffline: terminals.filter(t => t.status !== 'online').length,
        branches,
        cashRegisters: registers,
        terminalConfig,
        env: {
          DB_HOST: process.env.DB_HOST || null,
          TECNO_CAJA_MYSQL_BIND_HOST: process.env.TECNO_CAJA_MYSQL_BIND_HOST || '127.0.0.1'
        }
      });
    } catch (e) {
      res.status(e.statusCode || 500).json({ error: e.message });
    }
  });

  // ── GET /api/network/terminals ──────────────────────────────────────────────
  // Lista de todos los terminales registrados
  router.get('/terminals', async (req, res) => {
    try {
      await ensureReady();
      const actor = await resolveRequestActorUser(req, { required: true });
      if (!_isAdmin(actor)) return res.status(403).json({ error: 'Sin permiso.' });
      const businessId = await getBusinessId();
      const terminals  = await listTerminals(query, businessId);
      res.json(terminals);
    } catch (e) {
      res.status(e.statusCode || 500).json({ error: e.message });
    }
  });

  // ── POST /api/network/terminals/register ────────────────────────────────────
  // Un terminal se registra / actualiza su presencia (llamado al arrancar)
  router.post('/terminals/register', async (req, res) => {
    try {
      await ensureReady();
      // No requiere auth — el terminal puede no tener sesión al arrancar
      // Pero sí validamos que traiga un terminalId válido
      const {
        terminalId, terminalName, branchId, cashRegisterId,
        connectionType, isMain
      } = req.body || {};

      if (!terminalId) return res.status(400).json({ error: 'terminalId requerido.' });

      const businessId = await getBusinessId();
      const ipAddress  = req.ip?.replace('::ffff:', '') || req.connection?.remoteAddress || null;

      await registerTerminal(query, {
        terminalId,
        terminalName:  terminalName  || terminalId,
        branchId:      branchId      || null,
        cashRegisterId: cashRegisterId || null,
        businessId,
        ipAddress,
        connectionType: connectionType || (ipAddress === '127.0.0.1' ? 'local' : 'lan'),
        isMain:         !!isMain,
        registeredBy:   'auto'
      });

      res.json({ ok: true });
    } catch (e) {
      res.status(e.statusCode || 500).json({ error: e.message });
    }
  });

  // ── PUT /api/network/terminals/:terminalId/assign ───────────────────────────
  // Reasignar terminal a otra sucursal/caja
  router.put('/terminals/:terminalId/assign', async (req, res) => {
    try {
      await ensureReady();
      const actor = await resolveRequestActorUser(req, { required: true });
      if (!_isGlobal(actor)) return res.status(403).json({ error: 'Solo el administrador general puede reasignar terminales.' });

      const { branchId, cashRegisterId } = req.body || {};
      await assignBranch(query, req.params.terminalId, { branchId, cashRegisterId });
      res.json({ ok: true });
    } catch (e) {
      res.status(e.statusCode || 500).json({ error: e.message });
    }
  });

  // ── DELETE /api/network/terminals/:terminalId ───────────────────────────────
  // Eliminar registro de terminal
  router.delete('/terminals/:terminalId', async (req, res) => {
    try {
      await ensureReady();
      const actor = await resolveRequestActorUser(req, { required: true });
      if (!_isGlobal(actor)) return res.status(403).json({ error: 'Solo el administrador general puede eliminar terminales.' });

      await removeTerminal(query, req.params.terminalId);
      res.json({ ok: true });
    } catch (e) {
      res.status(e.statusCode || 500).json({ error: e.message });
    }
  });

  // ── POST /api/network/terminals/:terminalId/ping ────────────────────────────
  // Un terminal señaliza que sigue activo (heartbeat cada 30s)
  router.post('/terminals/:terminalId/ping', async (req, res) => {
    try {
      await ensureReady();
      const ipAddress = req.ip?.replace('::ffff:', '') || null;
      await markOnline(query, req.params.terminalId, { ipAddress });
      res.json({ ok: true, ts: new Date().toISOString() });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── GET /api/network/lan-setup-guide ───────────────────────────────────────
  // Instrucciones para configurar una nueva caja en LAN
  router.get('/lan-setup-guide', async (req, res) => {
    try {
      const actor = await resolveRequestActorUser(req, { required: true });
      if (!_isAdmin(actor)) return res.status(403).json({ error: 'Sin permiso.' });

      const port    = Number(process.env.PORT || 3399);
      const localIPs = getLocalIPs();
      const lanEnabled = String(process.env.POS_ALLOW_LAN || 'false').toLowerCase() === 'true';

      res.json({
        lanEnabled,
        port,
        localIPs,
        accessUrls: localIPs.map(ip => `http://${ip}:${port}`),
        steps: [
          {
            step: 1,
            title: 'Habilitar acceso LAN en este servidor',
            description: `En el archivo .env de este equipo, asegúrate de tener:\nPOS_ALLOW_LAN=true\nTECNO_CAJA_MYSQL_ALLOW_LAN=true\nLuego reinicia Tecno Caja.`,
            done: lanEnabled
          },
          {
            step: 2,
            title: 'Permitir el puerto en el firewall de Windows',
            description: `Abre el puerto TCP ${port} en el Firewall de Windows:\n1. Panel de control → Firewall → Reglas de entrada\n2. Nueva regla → Puerto TCP ${port}\n3. Permite la conexión en red privada`,
            done: null
          },
          {
            step: 3,
            title: 'Conectar la nueva caja',
            description: `En la PC de la caja secundaria:\n1. Instala Tecno Caja\n2. Al abrir, el asistente detectará el servidor principal\n3. O ingresa manualmente la URL: ${localIPs[0] ? `http://${localIPs[0]}:${port}` : `http://[IP-DE-ESTE-EQUIPO]:${port}`}`,
            done: null
          },
          {
            step: 4,
            title: 'Autenticarse y vincular',
            description: 'En el asistente de la nueva caja, ingresa usuario y contraseña de administrador, elige la sucursal y caja asignadas.',
            done: null
          }
        ]
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── GET /api/network/remote-setup-guide ────────────────────────────────────
  // Instrucciones para sucursales remotas (nube / VPS)
  router.get('/remote-setup-guide', async (req, res) => {
    try {
      const actor = await resolveRequestActorUser(req, { required: true });
      if (!_isAdmin(actor)) return res.status(403).json({ error: 'Sin permiso.' });

      const port = Number(process.env.PORT || 3399);
      res.json({
        steps: [
          {
            step: 1,
            title: 'Opción A — Servidor en la nube (VPS)',
            description: `Instala Tecno Caja en un servidor con IP pública (AWS, DigitalOcean, Contabo, etc.).\nRequiere: Ubuntu 22+, Node.js 20+, MariaDB 10.6+.\nEste servidor actúa como el "Principal" al que todas las sucursales se conectan.`
          },
          {
            step: 2,
            title: 'Opción B — Túnel seguro (sin VPS)',
            description: `Si no tienes servidor en la nube, usa Cloudflare Tunnel:\n1. Instala cloudflared en el servidor principal\n2. Ejecuta: cloudflared tunnel --url http://localhost:${port}\n3. Obtendrás una URL pública tipo: https://xxx.trycloudflare.com\n4. Esa URL la usarán las sucursales remotas para conectarse`
          },
          {
            step: 3,
            title: 'Configurar cada sucursal remota',
            description: `En la PC de la sucursal remota:\n1. Instala Tecno Caja\n2. En el asistente, elige "Conectar a servidor remoto"\n3. Ingresa la URL del servidor principal (IP pública o URL del túnel)\n4. Autentícate con admin y elige la sucursal/caja asignada\n5. Tecno Caja guardará la conexión MySQL remota y reiniciará`
          },
          {
            step: 4,
            title: 'Firewall y seguridad',
            description: `En el servidor principal:\n- Puerto ${port} (Tecno Caja HTTP): abierto para las IPs de sucursales\n- Puerto 3306 (MySQL): abierto SOLO para IPs de las sucursales (nunca público)\n- Usa credenciales MySQL dedicadas por sucursal\n- Activa SSL en MySQL para conexiones remotas`
          },
          {
            step: 5,
            title: 'Variables de entorno del servidor principal',
            description: `En el .env del servidor:\nPOS_ALLOW_LAN=true\nPOS_BIND_HOST=0.0.0.0\nTECNO_CAJA_MYSQL_ALLOW_LAN=true\nTECNO_CAJA_MYSQL_BIND_HOST=0.0.0.0\nCORS_ALLOWED_ORIGINS=https://sucursal2.tudominio.com`
          }
        ],
        cloudflareCmd: `cloudflared tunnel --url http://localhost:${port}`,
        envExample: `POS_ALLOW_LAN=true\nPOS_BIND_HOST=0.0.0.0\nTECNO_CAJA_MYSQL_ALLOW_LAN=true\nTECNO_CAJA_MYSQL_BIND_HOST=0.0.0.0`
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  return router;
}

module.exports = createNetworkRouter;
