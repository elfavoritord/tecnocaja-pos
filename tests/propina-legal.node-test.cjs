const test = require('node:test');
const assert = require('node:assert/strict');
const { calculate } = require('../js/propina-legal');
const { generateEcfXml, generateRfceXml } = require('../modules/ecf/services/ecf-generator');
test('propina solo en consumo local, productos habilitados y después de descuentos', () => {
  const input = { enabled: true, orderType: 'mesa', discount: 30, lines: [{net:100,eligible:true},{net:200,eligible:false}] };
  assert.equal(calculate(input).amount,9);
  for (const orderType of ['delivery','recoger','mostrador']) assert.equal(calculate({...input,orderType}).amount,0);
  assert.equal(calculate({...input,orderType:'mostrador',consumedHere:true}).amount,9);
  assert.equal(calculate({...input,enabled:false}).amount,0);
});
test('e-CF y RFCE identifican 001 y separan propina del ITBIS', () => {
  const payload = { emitter: {rnc:'40211932609',razonSocial:'Laboratorio',direccion:'Calle 1'}, customer:{nombre:'Consumidor Final'},
    document: {eNCF:'E320000000001',tipoeCF:'E32',tipoPago:'1'}, items:[{name:'Comida',quantity:1,unitPrice:100,discount:10,taxRate:18,legalTipAmount:9}], issueDate:'2026-11-07 10:00:00' };
  const {xml,totals} = generateEcfXml(payload);
  assert.equal(totals.totalTax,16.2); assert.equal(totals.legalTipAmount,9); assert.equal(totals.total,115.2);
  assert.match(xml,/<TipoImpuesto>001<\/TipoImpuesto>/); assert.match(xml,/<TasaImpuestoAdicional>10.00<\/TasaImpuestoAdicional>/);
  assert.match(xml,/<TablaImpuestoAdicional>/); assert.match(xml,/<MontoTotal>115.20<\/MontoTotal>/);
  const rfce = generateRfceXml({...payload,document:{...payload.document,codigoSeguridad:'ABC123'},totals});
  assert.match(rfce,/<OtrosImpuestosAdicionales>9.00<\/OtrosImpuestosAdicionales>/);
  assert.doesNotMatch(rfce, /TasaImpuestoAdicional/);
});
