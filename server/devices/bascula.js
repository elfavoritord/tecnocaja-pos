'use strict';
/**
 * Módulo de báscula TCP — Tecno Caja
 *
 * Soporta básulas conectadas por red (RJ45/WiFi) que exponen un puerto TCP raw.
 * Parsea los formatos más comunes de báscula (CAS, Toledo/Mettler, genérico ASCII).
 * Emite eventos Socket.IO:
 *   bascula:status  { connected, ip, port }
 *   bascula:peso    { kg, g, raw, unit, ts }
 *   bascula:raw     { raw, ts }  — líneas que no se pudieron parsear (para debug)
 */

const net = require('net');

let _io = null;
let _client = null;
let _config = { ip: null, port: null };
let _connected = false;
let _reconnectTimer = null;
let _buffer = '';
let _lastWeight = null;
let _reconnect = true; // si debe intentar reconectar automáticamente

// ─── Parser de peso ────────────────────────────────────────────────────────────
// Formatos soportados:
//   CAS:      "ST,GS,    1.500,kg"   o   "US,GS,    0.000,kg"
//   Toledo:   "S S      1.500 kg"   /    "S D     1.500 kg"
//   Genérico: "+001.500\r\n"        /    "  1.500 kg S\r\n"
//   Enmarcado: "\x02  1.500kg\x03"

function parseWeight(raw) {
  // Limpiar bytes no imprimibles (excepto espacio)
  const clean = raw.replace(/[^\x20-\x7E]/g, ' ').trim();
  if (!clean) return null;

  // Detectar lecturas inestables (CAS "US" = unstable, Toledo "D" = dynamic)
  const unstable = /\bUS\b|\bD\s+\d|\bUNSTABLE\b/i.test(clean);

  // Buscar número flotante con unidad opcional
  const match = clean.match(/([+-]?\d{1,5}[.,]\d{1,4})\s*(kg|g|lb)?/i);
  if (!match) return null;

  const value = parseFloat(match[1].replace(',', '.'));
  const unit = (match[2] || 'kg').toLowerCase();
  if (isNaN(value) || value < 0) return null;

  const kg = unit === 'g' ? value / 1000 : unit === 'lb' ? value * 0.453592 : value;
  const g = Math.round(kg * 1000);

  return { kg, g, raw: clean, unit, stable: !unstable };
}

// ─── Conexión TCP ──────────────────────────────────────────────────────────────

function _doConnect() {
  if (!_config.ip || !_config.port) return;

  _client = new net.Socket();
  _buffer = '';

  _client.connect(Number(_config.port), _config.ip, () => {
    _connected = true;
    console.log(`[báscula] Conectado a ${_config.ip}:${_config.port}`);
    _emitStatus();
  });

  _client.on('data', (chunk) => {
    _buffer += chunk.toString('latin1');
    // Procesar por líneas (CR, LF, o CRLF como separador)
    const lines = _buffer.split(/\r?\n|\r/);
    _buffer = lines.pop(); // retener fragmento incompleto
    for (const line of lines) {
      if (!line.trim()) continue;
      const w = parseWeight(line);
      if (w) {
        _lastWeight = { ...w, ts: Date.now() };
        if (w.stable && w.kg > 0) {
          _io?.emit('bascula:peso', { kg: w.kg, g: w.g, raw: w.raw, unit: w.unit, ts: _lastWeight.ts });
        }
      } else {
        _io?.emit('bascula:raw', { raw: line.trim(), ts: Date.now() });
      }
    }
  });

  _client.on('close', () => {
    _connected = false;
    _client = null;
    console.log('[báscula] Conexión cerrada');
    _emitStatus();
    if (_reconnect && _config.ip) {
      _reconnectTimer = setTimeout(_doConnect, 5000);
    }
  });

  _client.on('error', (err) => {
    console.warn('[báscula] Error TCP:', err.message);
    if (_client) { _client.destroy(); _client = null; }
  });
}

function _emitStatus() {
  _io?.emit('bascula:status', {
    connected: _connected,
    ip: _config.ip,
    port: _config.port,
    lastWeight: _lastWeight
  });
}

// ─── API pública ───────────────────────────────────────────────────────────────

function setIo(io) { _io = io; }

function connect(ip, port) {
  disconnect();
  _config = { ip, port: Number(port) };
  _reconnect = true;
  _doConnect();
}

function disconnect() {
  _reconnect = false;
  clearTimeout(_reconnectTimer);
  if (_client) {
    _client.removeAllListeners();
    _client.destroy();
    _client = null;
  }
  _connected = false;
  _config = { ip: null, port: null };
  _lastWeight = null;
}

function getStatus() {
  return {
    connected: _connected,
    ip: _config.ip,
    port: _config.port,
    lastWeight: _lastWeight
  };
}

module.exports = { setIo, connect, disconnect, getStatus, parseWeight };
