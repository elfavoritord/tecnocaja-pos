'use strict';
const { parseQrResult } = require('../modules/ecf/utils/dgii-live-check.util');

test.each(['Rechazado', 'Anulado', 'En proceso'])('un QR que muestra %s no se considera válido', (estado) => {
  expect(parseQrResult(`<th>Estado</th><td>${estado}</td>`)).toEqual({ indexed: true, valid: false, estado });
});
test.each(['Aceptado', 'Aceptado Condicional'])('un QR que muestra %s se considera válido', (estado) => {
  expect(parseQrResult(`<th class="label">Estado</th><td class="value">${estado}</td>`)).toEqual({ indexed: true, valid: true, estado });
});
test('una página sin resultado no certifica la validez del QR', () => {
  expect(parseQrResult('Servicio no disponible').valid).toBe(false);
});
test.each(['No fue encontrada la factura', 'Comprobante no encontrado'])('distingue %s de un rechazo y de un fallo de conexión', (message) => {
  expect(parseQrResult(message)).toMatchObject({ indexed: false, valid: false, estado: null, reason: 'not_found' });
});
