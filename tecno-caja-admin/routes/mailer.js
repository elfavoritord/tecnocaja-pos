'use strict';

/**
 * mailer.js — Envío de correos por Gmail (SMTP con contraseña de aplicación).
 *
 * Requiere en tecno-caja-admin/.env:
 *   GMAIL_USER=tucorreo@gmail.com
 *   GMAIL_APP_PASSWORD=xxxxxxxxxxxxxxxx   (contraseña de aplicación de 16 caracteres, sin espacios)
 *   GMAIL_FROM_NAME=Tecno Caja            (opcional)
 *
 * Cómo obtener la contraseña de aplicación:
 *   Cuenta de Google → Seguridad → Verificación en 2 pasos (activarla) →
 *   Contraseñas de aplicaciones → generar una para "Correo".
 */

const nodemailer = require('nodemailer');

let _transport = null;

function isConfigured() {
  return Boolean(process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD);
}

function fromAddress() {
  const name = process.env.GMAIL_FROM_NAME || process.env.ADMIN_COMPANY_NAME || 'Tecno Caja';
  return `"${name}" <${process.env.GMAIL_USER}>`;
}

function getTransport() {
  if (!isConfigured()) {
    const err = new Error('El envío por correo no está configurado. Agrega GMAIL_USER y GMAIL_APP_PASSWORD en tecno-caja-admin/.env');
    err.status = 503;
    throw err;
  }
  if (_transport) return _transport;
  _transport = nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 465,
    secure: true,
    auth: {
      user: process.env.GMAIL_USER,
      // Gmail acepta la contraseña de aplicación con o sin espacios; los quitamos por si acaso.
      pass: String(process.env.GMAIL_APP_PASSWORD).replace(/\s+/g, ''),
    },
  });
  return _transport;
}

/**
 * Envía un correo con (opcionalmente) un PDF adjunto.
 * @returns {Promise<{messageId:string, accepted:string[]}>}
 */
async function sendMail({ to, subject, text, html, attachmentBuffer, attachmentName }) {
  const transport = getTransport();
  const msg = {
    from: fromAddress(),
    to,
    subject,
    text,
    html,
  };
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

module.exports = { isConfigured, fromAddress, sendMail };
