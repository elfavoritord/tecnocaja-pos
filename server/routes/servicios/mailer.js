'use strict';

/**
 * mailer.js — Envío de facturas de servicios por correo (Gmail SMTP).
 *
 * Config por instalación: columnas service_mail_user / service_mail_pass /
 * service_mail_from en `config` (las agrega ensureServiciosSchema). Fallback a
 * GMAIL_USER / GMAIL_APP_PASSWORD del .env. El adjunto es SIEMPRE el PDF A4
 * generado por el renderer (Electron printToPDF) y enviado en base64.
 */

const nodemailer = require('nodemailer');

function normalize(cfg) {
  if (!cfg) return null;
  const user = String(cfg.user || '').trim();
  const pass = String(cfg.pass || '').replace(/\s+/g, '');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(user) || pass.length < 8) return null;
  return { user, pass, fromName: String(cfg.fromName || '').trim() || user };
}

async function resolveMailConfig(query) {
  try {
    const [row] = await query(
      'SELECT service_mail_user, service_mail_pass, service_mail_from, business_name FROM config WHERE id = 1 LIMIT 1'
    );
    const fromRow = normalize({
      user: row?.service_mail_user, pass: row?.service_mail_pass,
      fromName: row?.service_mail_from || row?.business_name,
    });
    if (fromRow) return fromRow;
  } catch (_) { /* columnas aún no migradas */ }
  if (process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD) {
    return normalize({
      user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD,
      fromName: process.env.GMAIL_FROM_NAME || 'Tecno Caja',
    });
  }
  return null;
}

async function sendInvoiceEmail(query, { to, subject, text, html, pdfBase64, filename }) {
  const cfg = await resolveMailConfig(query);
  if (!cfg) {
    const err = new Error('El envío por correo no está configurado. Agrega el Gmail y la contraseña de aplicación en Configuración.');
    err.statusCode = 503;
    throw err;
  }
  const transport = nodemailer.createTransport({
    host: 'smtp.gmail.com', port: 465, secure: true,
    auth: { user: cfg.user, pass: cfg.pass },
  });
  const attachments = [];
  if (pdfBase64) {
    attachments.push({
      filename: filename || 'factura.pdf',
      content: Buffer.from(String(pdfBase64).replace(/^data:.*;base64,/, ''), 'base64'),
      contentType: 'application/pdf',
    });
  }
  const info = await transport.sendMail({
    from: `"${cfg.fromName}" <${cfg.user}>`,
    to, subject, text, html, attachments,
  });
  return { ok: true, messageId: info.messageId };
}

module.exports = { sendInvoiceEmail, resolveMailConfig };
