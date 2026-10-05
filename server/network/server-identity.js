'use strict';

/**
 * server/network/server-identity.js
 *
 * Identificador fijo de este servidor Tecno Caja (TECNO_CAJA_SERVER_ID en
 * config/app.env). Lo anuncia GET /api/network/identify y lo guardan las cajas
 * al vincularse: así, si la IP de la PC principal cambia (DHCP), la caja la
 * vuelve a encontrar en la red sin confundirla con la principal de otro
 * negocio. Es aleatorio y no revela nada del negocio ni de la licencia.
 */

const crypto = require('crypto');
const os = require('os');

const SERVER_ID_PATTERN = /^srv_[a-f0-9]{16}$/;

function createServerIdentity({ persistRuntimeEnvValues = () => {}, env = process.env } = {}) {
  function getServerId() {
    let serverId = String(env.TECNO_CAJA_SERVER_ID || '').trim();
    if (!SERVER_ID_PATTERN.test(serverId)) {
      serverId = `srv_${crypto.randomBytes(8).toString('hex')}`;
      env.TECNO_CAJA_SERVER_ID = serverId;
      try {
        persistRuntimeEnvValues({ TECNO_CAJA_SERVER_ID: serverId });
      } catch (_error) {
        // Si no se pudo guardar, igual sirve en esta sesión.
      }
    }
    return serverId;
  }

  function getHostname() {
    return String(os.hostname() || '').trim();
  }

  return { getServerId, getHostname };
}

module.exports = { createServerIdentity, SERVER_ID_PATTERN };
