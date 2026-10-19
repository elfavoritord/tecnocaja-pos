'use strict';

/**
 * Respaldo .tcbak antes de aplicar migraciones de esquema. Se escribe en la
 * carpeta normal de respaldos (Documentos\TecnoCaja\Backups) y se relee y
 * descifra para confirmar que sirve antes de tocar la base.
 *
 * backup-core se carga aquí adentro (no arriba) porque importa db.js, que al
 * cargarse prepara el entorno de ejecución; así este módulo se puede probar
 * sin una base real.
 */

const fs = require('fs');
const path = require('path');

async function crearRespaldoPrevio({ query, migraciones = [], prefijo = 'PRE-MIGRACION', logger = console }) {
  const usuarios = await query('SELECT COUNT(*) AS n FROM users').catch(() => [{ n: 0 }]);
  if (!Number(usuarios[0]?.n || 0)) {
    // Instalación sin configurar: no hay nada que proteger.
    return { ok: true, omitido: 'sin datos' };
  }

  const core = require('../services/backup-core');
  const clave = process.env.TECNO_CAJA_SECURITY_PASSWORD || 'Seguridad2026';
  const payload = await core.buildFullPayload(query);
  const buffer = await core.createTcbakBuffer(payload, clave);
  const carpeta = core.ensureDir(core.getDefaultBackupDir());
  const archivo = core.generateFilename(`${prefijo}_${payload.businessName}`, payload.systemVersion);
  const ruta = path.join(carpeta, archivo);
  core.writeFileAtomic(ruta, buffer);

  // Verificable: si no se puede leer de vuelta, no se migra.
  await core.parseTcbakBuffer(fs.readFileSync(ruta), clave);
  logger.log?.(`[migraciones] Respaldo previo ${archivo} (${migraciones.join(', ')})`);
  return { ok: true, archivo, ruta };
}

module.exports = { crearRespaldoPrevio };
