'use strict';

/**
 * mailer.js — Envío de correos por Gmail (SMTP con contraseña de aplicación).
 *
 * La configuración es POR CONTADOR: cada firma guarda su propio Gmail y
 * contraseña de aplicación en su documento de Firestore. El servidor arma el
 * transporte con esos datos al momento de enviar.
 *
 * Fallback opcional: si un contador no tiene config propia pero existen
 * GMAIL_USER / GMAIL_APP_PASSWORD en el .env, se usan esos.
 */

const nodemailer = require('nodemailer');

// Config global opcional desde .env (normalmente vacío).
function envConfig() {
  if (process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD) {
    return {
      user: process.env.GMAIL_USER,
      pass: process.env.GMAIL_APP_PASSWORD,
      fromName: process.env.GMAIL_FROM_NAME || 'Tecno Caja Contadores',
    };
  }
  return null;
}

// Normaliza y valida una config { user, pass, fromName }.
function normalizeConfig(cfg) {
  if (!cfg) return null;
  const user = String(cfg.user || '').trim();
  const pass = String(cfg.pass || '').replace(/\s+/g, '');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(user) || pass.length < 8) return null;
  return { user, pass, fromName: String(cfg.fromName || '').trim() || user };
}

function makeTransport(cfg) {
  const c = normalizeConfig(cfg);
  if (!c) {
    const err = new Error('El envío por correo no está configurado.');
    err.status = 503;
    throw err;
  }
  return {
    transport: nodemailer.createTransport({
      host: 'smtp.gmail.com', port: 465, secure: true,
      auth: { user: c.user, pass: c.pass },
    }),
    from: `"${c.fromName}" <${c.user}>`,
  };
}

// Verifica que las credenciales sirvan (login SMTP) sin enviar nada.
async function verifyConfig(cfg) {
  const { transport } = makeTransport(cfg);
  await transport.verify();
  return true;
}

async function sendMail(cfg, { to, subject, text, html, replyTo, attachmentBuffer, attachmentName }) {
  const { transport, from } = makeTransport(cfg);
  const msg = { from, to, subject, text, html };
  if (replyTo) msg.replyTo = replyTo;
  if (attachmentBuffer) {
    msg.attachments = [{
      filename: attachmentName || 'documento.pdf',
      content: attachmentBuffer,
      contentType: 'application/pdf',
    }];
  }
  const info = await transport.sendMail(msg);
  return { messageId: info.messageId, accepted: info.accepted || [] };
}

module.exports = { envConfig, normalizeConfig, makeTransport, verifyConfig, sendMail };
