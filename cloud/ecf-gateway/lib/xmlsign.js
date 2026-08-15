'use strict';

// El gateway firma el ARECF con el mismo servicio compartido que usa el modulo
// e-CF del POS para e-CF/RFCE. Mantener una sola ruta de XMLDSig evita
// diferencias sutiles de canonicalizacion/KeyInfo entre el POS y Cloud Run.

const { signXML } = require('../vendor/modules/ecf/signature/signature.service');

function signXmlDocument(xml, certificateContext) {
  return signXML(xml, certificateContext);
}

module.exports = { signXmlDocument };
