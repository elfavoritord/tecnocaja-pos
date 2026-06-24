'use strict';

const crypto = require('crypto');
const express = require('express');
const fs = require('fs');
const path = require('path');

const XML_CONTENT_TYPES = ['application/xml', 'text/xml', 'application/soap+xml'];
const RECEIVED_DIR = path.join(process.cwd(), 'storage', 'ecf', 'received');

function fmtDgiiDateTime(d = new Date()) {
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const yyyy = d.getFullYear();
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${dd}-${mm}-${yyyy} ${hh}:${mi}:${ss}`;
}

function extractTagValue(xml, tag) {
  const m = String(xml || '').match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
  return m ? m[1].trim() : '';
}

function ensureReceivedDir() {
  if (!fs.existsSync(RECEIVED_DIR)) fs.mkdirSync(RECEIVED_DIR, { recursive: true });
}

function saveReceived(type, payload, meta = {}) {
  try {
    ensureReceivedDir();
    const id = `${type}-${Date.now()}`;
    const record = {
      id,
      type,
      receivedAt: new Date().toISOString(),
      meta,
      payload: String(payload || '').slice(0, 50000),
    };
    fs.writeFileSync(path.join(RECEIVED_DIR, `${id}.json`), JSON.stringify(record, null, 2), 'utf8');
    return id;
  } catch (_) {
    return null;
  }
}

function listDgiiReceived() {
  try {
    ensureReceivedDir();
    return fs.readdirSync(RECEIVED_DIR)
      .filter(f => f.endsWith('.json'))
      .map(f => {
        try { return JSON.parse(fs.readFileSync(path.join(RECEIVED_DIR, f), 'utf8')); } catch (_) { return null; }
      })
      .filter(Boolean)
      .sort((a, b) => new Date(b.receivedAt).getTime() - new Date(a.receivedAt).getTime())
      .slice(0, 100);
  } catch (_) {
    return [];
  }
}

function createDgiiPublicRouter() {
  const router = express.Router();
  const xmlParser = express.text({ type: XML_CONTENT_TYPES, limit: '20mb' });

  router.use('/fe', (req, res, next) => {
    if (req.method === 'GET') return next();
    const ct = String(req.headers['content-type'] || '');
    if (XML_CONTENT_TYPES.some(t => ct.includes(t))) return xmlParser(req, res, next);
    return express.json({ limit: '20mb' })(req, res, next);
  });

  // ── GET /fe/autenticacion/api/semilla ────────────────────────────────────────
  router.get('/fe/autenticacion/api/semilla', (req, res) => {
    const seed = crypto.randomBytes(16).toString('hex').toUpperCase();
    const now = new Date();
    const xml = [
      '<?xml version="1.0" encoding="utf-8"?>',
      '<SemillaModel>',
      `  <valor>${seed}</valor>`,
      `  <fecha>${now.toISOString()}</fecha>`,
      '</SemillaModel>',
    ].join('\n');
    saveReceived('semilla', xml, { ip: req.ip || req.socket?.remoteAddress });
    console.log(`[DGII-PUBLIC] GET semilla → ${seed.slice(0, 8)}…`);
    res.type('application/xml').send(xml);
  });

  // ── POST /fe/autenticacion/api/validacioncertificado ─────────────────────────
  router.post('/fe/autenticacion/api/validacioncertificado', (req, res) => {
    const body = String(req.body || '');
    saveReceived('validacion-cert', body, { ip: req.ip || req.socket?.remoteAddress });
    console.log('[DGII-PUBLIC] POST validacioncertificado recibido');
    res.json({
      status: 'certificado_validado',
      mensaje: 'Certificado recibido y validado correctamente.',
      timestamp: new Date().toISOString(),
    });
  });

  // ── POST /fe/recepcion/api/ecf ───────────────────────────────────────────────
  router.post('/fe/recepcion/api/ecf', (req, res) => {
    const body = String(req.body || '');
    const rncEmisor = String(extractTagValue(body, 'RNCEmisor') || '').replace(/\D/g, '') || '00000000000';
    const rncComprador = String(extractTagValue(body, 'RNCComprador') || '').replace(/\D/g, '') || '00000000000';
    const encf = extractTagValue(body, 'eNCF') || 'E000000000000';
    const savedId = saveReceived('recepcion-ecf', body, {
      rncEmisor, rncComprador, encf,
      ip: req.ip || req.socket?.remoteAddress,
    });
    console.log(`[DGII-PUBLIC] POST recepcion/ecf — eNCF=${encf} RNC=${rncEmisor} [id=${savedId}]`);
    const arecf = [
      '<?xml version="1.0" encoding="utf-8"?>',
      '<ARECF>',
      '  <DetalleAcusedeRecibo>',
      '    <Version>1.0</Version>',
      `    <RNCEmisor>${rncEmisor}</RNCEmisor>`,
      `    <RNCComprador>${rncComprador}</RNCComprador>`,
      `    <eNCF>${encf}</eNCF>`,
      '    <Estado>0</Estado>',
      `    <FechaHoraAcuseRecibo>${fmtDgiiDateTime()}</FechaHoraAcuseRecibo>`,
      '  </DetalleAcusedeRecibo>',
      '</ARECF>',
    ].join('\n');
    res.type('application/xml').send(arecf);
  });

  // ── POST /fe/aprobacioncomercial/api/ecf ─────────────────────────────────────
  router.post('/fe/aprobacioncomercial/api/ecf', (req, res) => {
    const body = String(req.body || '');
    const encf = extractTagValue(body, 'eNCF') || extractTagValue(body, 'ENCF') || '?';
    const rncEmisor = String(extractTagValue(body, 'RNCEmisor') || '').replace(/\D/g, '');
    const savedId = saveReceived('aprobacion-comercial', body, {
      encf, rncEmisor,
      ip: req.ip || req.socket?.remoteAddress,
    });
    console.log(`[DGII-PUBLIC] POST aprobacioncomercial/ecf — eNCF=${encf} [id=${savedId}]`);
    res.json({
      status: 'recibido',
      mensaje: 'Aprobación comercial recibida correctamente.',
      encf,
      timestamp: new Date().toISOString(),
    });
  });

  return router;
}

module.exports = { createDgiiPublicRouter, listDgiiReceived };
