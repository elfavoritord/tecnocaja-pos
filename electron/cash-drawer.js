'use strict';

/**
 * Tecno Caja — Controlador de Gaveta Registradora
 *
 * Métodos de apertura soportados:
 *   1. 'escpos'  — Pulso ESC/POS via impresora térmica (recomendado)
 *   2. 'serial'  — Puerto serial directo (COM1, COM2, etc.)
 *   3. 'network' — Impresora de red TCP (IP:puerto)
 *
 * La gaveta normalmente está conectada al puerto RJ-11 de la impresora térmica.
 * El comando ESC p envía un pulso eléctrico al pin 2 o pin 5 del conector.
 */

const net     = require('net');
const fs      = require('fs');
const path    = require('path');
const os      = require('os');
const { openCashDrawer, sendRawToPrinter, ESCPOSBuilder } = require('./thermal-printer');

// ─── Configuración por defecto ────────────────────────────────────────────────

const DEFAULT_CONFIG = {
  method: 'escpos',   // 'escpos' | 'serial' | 'network'
  printerName: '',    // Para method='escpos'
  serialPort: 'COM1', // Para method='serial'
  networkHost: '',    // Para method='network' (ej: '192.168.1.100')
  networkPort: 9100,  // Puerto raw TCP de la impresora de red
  pin: 0,             // 0=pin2 (más común), 1=pin5
};

function isGenericTextOnlyPrinterName(value) {
  return /generic\s*\/?\s*text\s*only/i.test(String(value || '').trim());
}

// ─────────────────────────────────────────────────────────────────────────────
// APERTURA VÍA ESC/POS (impresora térmica USB/red)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Abre la gaveta enviando pulso ESC/POS a la impresora térmica de Windows
 */
async function openViaESCPOS(printerName, pin = 0) {
  if (!printerName || !printerName.trim()) {
    return { ok: false, error: 'Nombre de impresora no configurado para apertura de gaveta.' };
  }
  const normalizedPrinterName = printerName.trim();
  const result = await openCashDrawer(normalizedPrinterName, pin);
  if (!result?.ok && isGenericTextOnlyPrinterName(normalizedPrinterName)) {
    return {
      ok: false,
      error: `${result.error || 'La impresora rechazó el pulso.'} Selecciona la impresora térmica real del recibo, no "Generic / Text Only".`
    };
  }
  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// APERTURA VÍA RED TCP (impresoras de red)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Abre la gaveta enviando pulso ESC/POS directamente por TCP (puerto 9100)
 * Funciona con impresoras de red como Epson TM-T88 conectadas por Ethernet/WiFi
 */
async function openViaNetwork(host, port = 9100, pin = 0) {
  if (!host || !host.trim()) {
    return { ok: false, error: 'IP de impresora de red no configurada.' };
  }

  const pulseBuffer = new ESCPOSBuilder()
    .init()
    .openDrawer(pin)
    .build();

  return new Promise((resolve) => {
    const client = new net.Socket();
    const timeout = setTimeout(() => {
      client.destroy();
      resolve({ ok: false, error: `Timeout conectando a ${host}:${port}` });
    }, 5000);

    client.connect(port, host.trim(), () => {
      client.write(pulseBuffer, (err) => {
        clearTimeout(timeout);
        client.destroy();
        if (err) {
          resolve({ ok: false, error: err.message });
        } else {
          resolve({ ok: true });
        }
      });
    });

    client.on('error', (err) => {
      clearTimeout(timeout);
      client.destroy();
      resolve({ ok: false, error: `Error de red: ${err.message}` });
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// APERTURA VÍA PUERTO SERIAL
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Abre la gaveta por puerto serial (COM1, COM2, etc.)
 * Usado cuando la gaveta está conectada directamente al PC por serial
 */
async function openViaSerial(portName, pin = 0) {
  if (!portName || !portName.trim()) {
    return { ok: false, error: 'Puerto serial no configurado.' };
  }

  const pulseBuffer = new ESCPOSBuilder()
    .init()
    .openDrawer(pin)
    .build();

  // En Windows, se puede escribir directamente al puerto COM
  const portPath = `\\\\.\\${portName.trim()}`;

  return new Promise((resolve) => {
    let handle;
    try {
      handle = fs.openSync(portPath, 'w');
      fs.writeSync(handle, pulseBuffer, 0, pulseBuffer.length);
      fs.closeSync(handle);
      resolve({ ok: true });
    } catch (err) {
      if (handle !== undefined) {
        try { fs.closeSync(handle); } catch {}
      }
      resolve({ ok: false, error: `Error en puerto serial ${portName}: ${err.message}` });
    }
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// FUNCIÓN PRINCIPAL
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Abre la gaveta registradora según la configuración
 *
 * @param {object} config
 * @param {string} config.method       — 'escpos' | 'serial' | 'network'
 * @param {string} config.printerName  — nombre impresora Windows (para method='escpos')
 * @param {string} config.serialPort   — puerto COM (para method='serial')
 * @param {string} config.networkHost  — IP impresora (para method='network')
 * @param {number} config.networkPort  — puerto TCP (default 9100)
 * @param {0|1}    config.pin          — pin 0 o pin 1
 *
 * @returns {Promise<{ok:boolean, error?:string, method:string}>}
 */
async function openDrawer(config = {}) {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const method = String(cfg.method || 'escpos').toLowerCase();
  const pin = cfg.pin === 1 ? 1 : 0;

  let result;

  switch (method) {
    case 'escpos':
      result = await openViaESCPOS(cfg.printerName, pin);
      break;

    case 'network':
      result = await openViaNetwork(cfg.networkHost, cfg.networkPort || 9100, pin);
      break;

    case 'serial':
      result = await openViaSerial(cfg.serialPort, pin);
      break;

    default:
      result = { ok: false, error: `Método de apertura desconocido: ${method}` };
  }

  return { ...result, method };
}

/**
 * Prueba de apertura de gaveta (para configuración/diagnóstico)
 * Igual que openDrawer pero devuelve información detallada
 */
async function testDrawer(config = {}) {
  const start = Date.now();
  const result = await openDrawer(config);
  return {
    ...result,
    elapsed: Date.now() - start,
    config: {
      method: config.method || DEFAULT_CONFIG.method,
      printerName: config.printerName || '',
      pin: config.pin || 0,
    }
  };
}

module.exports = {
  openDrawer,
  testDrawer,
  openViaESCPOS,
  openViaNetwork,
  openViaSerial,
  DEFAULT_CONFIG,
};
